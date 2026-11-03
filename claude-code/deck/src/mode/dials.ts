import { FINAL_STATES } from "../bridge/commands.js";
import type { CommandModel } from "../keys/commands.js";
import { isMode, type Mode, MODES } from "../protocol/wire.js";
import { COALESCE_MS, type DialSurface } from "../sessions/dials.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { type Log, nullLog, quote } from "../util/log.js";
import { type Feedback, PAINT_INTERVAL_MS, StripPainter } from "../util/painter.js";
import { modeStrip } from "./strip.js";

/** A mode the dial was turned to but that wasn't applied goes back to the target's own after this long. */
export const CHOICE_MS = 10_000;

type Dial = {
	surface: DialSurface;
	painter: StripPainter;
	/** The mode turned to; null while the dial follows the target's mode. */
	choice: Mode | null;
	/** The target the choice was made for: a choice never carries over to another session. */
	choiceFor: string | null;
	revert: TimerHandle | null;
	pendingTicks: number;
	timer: TimerHandle | null;
	pressed: boolean;
	turnedWhilePressed: boolean;
	/** The change this dial sent, until its outcome has been shown. */
	cmd: string | null;
};

/**
 * The Mode dial, without the SDK. Turning chooses among Manual, Accept edits, Plan and Auto, one per tick,
 * stopping at either end; press (without turning) or tap asks the target session to change to the mode turned to.
 * Without a turn, a press or tap does nothing (the user's choice, 2026-11-03): the dial then shows the target's
 * own mode, which can lag the engine's for a moment, and applying it could put back an older one, a raise included.
 * The strip shows the target's title, its mode, and its model and effort, which the deck shows and never
 * changes. A change that's refused or fails alerts. Long-touch drops a choice that wasn't applied.
 */
export class ModeDials {
	readonly #model: CommandModel;
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #paintIntervalMs: number;
	readonly #choiceMs: number;
	readonly #dials = new Map<string, Dial>();

	constructor(model: CommandModel, opts: { clock?: Clock; log?: Log; paintIntervalMs?: number; choiceMs?: number } = {}) {
		this.#model = model;
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#choiceMs = opts.choiceMs ?? CHOICE_MS;
		model.onChange(() => this.repaintAll());
	}

	add(id: string, surface: DialSurface): void {
		let dial = this.#dials.get(id);
		if (!dial) {
			dial = {
				surface,
				painter: new StripPainter((payload) => surface.setFeedback(payload), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs }),
				choice: null,
				choiceFor: null,
				revert: null,
				pendingTicks: 0,
				timer: null,
				pressed: false,
				turnedWhilePressed: false,
				cmd: null,
			};
			this.#dials.set(id, dial);
		}
		dial.surface = surface;
		dial.painter.forget();
		this.#repaint(dial);
	}

	remove(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (dial.timer !== null) this.#clock.clearTimeout(dial.timer);
		if (dial.revert !== null) this.#clock.clearTimeout(dial.revert);
		dial.painter.dispose();
		this.#dials.delete(id);
	}

	rotate(id: string, ticks: number, pressed: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial || ticks === 0) return;
		if (pressed) {
			dial.pressed = true;
			dial.turnedWhilePressed = true;
		}
		dial.pendingTicks += ticks;
		if (dial.timer !== null) return;
		dial.timer = this.#clock.setTimeout(() => {
			dial.timer = null;
			const net = dial.pendingTicks;
			dial.pendingTicks = 0;
			if (net === 0 || dial.cmd !== null) return;
			const target = this.#model.target();
			const from = this.#shown(dial);
			const start = from === null ? (net > 0 ? -1 : MODES.length) : MODES.indexOf(from);
			const next = MODES[Math.max(0, Math.min(MODES.length - 1, start + net))] ?? null;
			dial.choice = next;
			dial.choiceFor = target?.key ?? null;
			this.#armRevert(dial);
			this.#log.debug(`mode choice ${from ?? "none"} → ${next ?? "none"}`);
			this.#repaint(dial);
		}, COALESCE_MS);
	}

	down(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		dial.pressed = true;
		dial.turnedWhilePressed = false;
	}

	up(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial || !dial.pressed) return;
		const turned = dial.turnedWhilePressed;
		dial.pressed = false;
		dial.turnedWhilePressed = false;
		if (!turned) this.#apply(dial, "press");
	}

	/** Tap applies, the touch alternative to pressing; long-touch drops the choice. */
	tap(id: string, hold: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (!hold) {
			this.#apply(dial, "tap");
			return;
		}
		this.#clearChoice(dial);
		this.#repaint(dial);
	}

	repaintAll(): void {
		for (const dial of this.#dials.values()) this.#repaint(dial);
	}

	painted(id: string): Feedback | null {
		return this.#dials.get(id)?.painter.painted ?? null;
	}

	/** The mode a dial shows now: its choice, else the target's own if it's one the deck sets. */
	shown(id: string): Mode | null {
		const dial = this.#dials.get(id);
		return dial ? this.#shown(dial) : null;
	}

	#shown(dial: Dial): Mode | null {
		if (dial.choice !== null) return dial.choice;
		const mode = this.#model.target()?.mode;
		return isMode(mode) ? mode : null;
	}

	#apply(dial: Dial, via: "press" | "tap"): void {
		if (dial.cmd !== null) {
			this.#log.info(`Mode dial ${via}: a change is already in flight`);
			dial.surface.showAlert();
			return;
		}
		// Only a mode turned to, never the target's own as shown.
		const mode = dial.choice;
		if (mode === null) {
			this.#log.info(`Mode dial ${via}: no mode turned to, so nothing to apply`);
			return;
		}
		if (!this.#model.online) {
			this.#log.info(`Mode dial ${via}: the bridge isn't listening`);
			dial.surface.showAlert();
			return;
		}
		const target = this.#model.target();
		if (!target) {
			this.#log.info(`Mode dial ${via}: no target session`);
			dial.surface.showAlert();
			return;
		}
		const result = this.#model.queue(target.key, { t: "mode", mode });
		if (!result.ok) {
			this.#log.info(`Mode dial ${via}: ${result.why}`);
			dial.surface.showAlert();
			return;
		}
		this.#log.info(`Mode dial ${via}: ${mode} for ${quote(target.title, 60)} (${target.key}): ${result.cmd.id}`);
		dial.cmd = result.cmd.id;
		dial.choice = mode;
		dial.choiceFor = target.key;
		if (dial.revert !== null) this.#clock.clearTimeout(dial.revert);
		dial.revert = null;
		this.#repaint(dial);
	}

	#armRevert(dial: Dial): void {
		if (dial.revert !== null) this.#clock.clearTimeout(dial.revert);
		dial.revert = this.#clock.setTimeout(() => {
			dial.revert = null;
			if (dial.cmd !== null) return;
			this.#clearChoice(dial);
			this.#repaint(dial);
		}, this.#choiceMs);
	}

	#clearChoice(dial: Dial): void {
		dial.choice = null;
		dial.choiceFor = null;
		if (dial.revert !== null) this.#clock.clearTimeout(dial.revert);
		dial.revert = null;
	}

	#repaint(dial: Dial): void {
		const target = this.#model.target();
		if (dial.cmd !== null) {
			const cmd = this.#model.commands.get(dial.cmd);
			if (!cmd || FINAL_STATES.has(cmd.state)) {
				dial.cmd = null;
				if (cmd?.state !== "done") {
					this.#log.info(`Mode dial ${cmd?.id ?? "?"}: ${cmd?.state ?? "forgotten"}${cmd?.error ? `: ${quote(cmd.error, 120)}` : ""}`);
					dial.surface.showAlert();
				}
				this.#clearChoice(dial);
			}
		}
		// A choice made for another session doesn't carry over when the target changes.
		if (dial.choice !== null && dial.cmd === null && dial.choiceFor !== (target?.key ?? null)) this.#clearChoice(dial);
		dial.painter.update(modeStrip({ target, choice: dial.choice, applying: dial.cmd !== null, online: this.#model.online }));
	}
}
