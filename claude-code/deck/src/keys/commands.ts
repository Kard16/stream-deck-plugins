import { type Command, type CommandSpec, FINAL_STATES } from "../bridge/commands.js";
import { modeName } from "../model/format.js";
import type { QueueResult, SessionView } from "../model/sessions.js";
import { isMode, type Mode } from "../protocol/wire.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { type Log, nullLog, quote } from "../util/log.js";
import { KeyPainter, PAINT_INTERVAL_MS } from "../util/painter.js";
import { type ModeKeyLook, modeKeySvg, type PromptLook, promptKeySvg } from "./art.js";
import type { KeySurface } from "./decision.js";

/** What the Saved Prompt and Mode keys need from the session model. */
export interface CommandModel {
	readonly online: boolean;
	readonly commands: { get(id: string): Command | null };
	target(): SessionView | null;
	queue(key: string, spec: CommandSpec): QueueResult;
	onChange(listener: () => void): () => void;
}

/** Settings from the Saved Prompt key's Property Inspector. */
export type PromptSettings = { text?: string; label?: string };

/** Settings from the Mode key's Property Inspector: one of PROTOCOL.md's modes. */
export type ModeKeySettings = { mode?: string };

/** How long a Saved Prompt key shows sent, and refused, before it goes back to its label. */
export const SENT_SHOW_MS = 3000;
export const REFUSED_SHOW_MS = 8000;

/** The target as a key names it: its title, marked when it has ended. */
export function targetName(target: SessionView | null): string | null {
	if (!target) return null;
	return target.listed ? target.title : `${target.title} (ended)`;
}

/** Checks a press can queue a command for the target, and queues it; null, with the reason logged, when it can't. */
function queueForTarget(model: CommandModel, log: Log, what: string, spec: CommandSpec): Command | null {
	if (!model.online) {
		log.info(`${what}: the bridge isn't listening`);
		return null;
	}
	const target = model.target();
	if (!target) {
		log.info(`${what}: no target session: pick one on the Sessions dial, or open one in the app`);
		return null;
	}
	const result = model.queue(target.key, spec);
	if (!result.ok) {
		log.info(`${what}: ${result.why}`);
		return null;
	}
	log.info(`${what}: ${result.cmd.id} for ${quote(target.title, 60)} (${target.key})`);
	return result.cmd;
}

type PromptKey = {
	surface: KeySurface;
	painter: KeyPainter<null>;
	settings: PromptSettings;
	/** The last press's command, until it has shown its outcome. */
	cmd: string | null;
	/** When that command was first seen final. */
	finalAt: number | null;
	timer: TimerHandle | null;
};

/**
 * The Saved Prompt keys, without the SDK. Each holds text set in its Property Inspector. A press queues it
 * as a prompt for the target session (PROTOCOL.md, Commands), and the key shows waiting until the command is
 * final, then sent (done) or refused (refused or failed) for a few seconds (kickoff answer 6).
 */
export class PromptKeys {
	readonly #model: CommandModel;
	readonly #log: Log;
	readonly #clock: Clock;
	readonly #paintIntervalMs: number;
	readonly #keys = new Map<string, PromptKey>();

	constructor(model: CommandModel, opts: { log?: Log; clock?: Clock; paintIntervalMs?: number } = {}) {
		this.#model = model;
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		model.onChange(() => this.repaintAll());
	}

	add(id: string, surface: KeySurface, settings: PromptSettings): void {
		this.remove(id);
		const painter = new KeyPainter<null>((svg) => surface.setImage(svg), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs });
		const key: PromptKey = { surface, painter, settings, cmd: null, finalAt: null, timer: null };
		this.#keys.set(id, key);
		this.#paint(key);
	}

	/** The Property Inspector changed the key's text or label. */
	setSettings(id: string, settings: PromptSettings): void {
		const key = this.#keys.get(id);
		if (!key) return;
		key.settings = settings;
		this.#paint(key);
	}

	remove(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		key.painter.dispose();
		if (key.timer !== null) this.#clock.clearTimeout(key.timer);
		this.#keys.delete(id);
	}

	/** `settings` from the press's own payload, which SDK 3 sends with every key event. */
	press(id: string, settings?: PromptSettings): void {
		const key = this.#keys.get(id);
		if (!key) return;
		if (settings) key.settings = settings;
		const text = typeof key.settings.text === "string" ? key.settings.text.trim() : "";
		if (text === "") {
			this.#log.info("Saved Prompt: no text set; set it in the key's settings");
			key.surface.showAlert();
			return;
		}
		const cmd = queueForTarget(this.#model, this.#log, "Saved Prompt", { t: "prompt", text });
		if (!cmd) {
			key.surface.showAlert();
			return;
		}
		if (key.timer !== null) this.#clock.clearTimeout(key.timer);
		key.timer = null;
		key.cmd = cmd.id;
		key.finalAt = null;
		this.#paint(key);
	}

	repaintAll(): void {
		for (const key of this.#keys.values()) this.#paint(key);
	}

	/** What a key shows now, for tests. */
	painted(id: string): string | null {
		return this.#keys.get(id)?.painter.svg ?? null;
	}

	/** The look of a key now, for tests. */
	look(id: string): PromptLook | null {
		const key = this.#keys.get(id);
		return key ? this.#look(key) : null;
	}

	#look(key: PromptKey): PromptLook {
		const label = (typeof key.settings.label === "string" && key.settings.label.trim()) || (typeof key.settings.text === "string" && key.settings.text.trim()) || null;
		const cmd = key.cmd === null ? null : this.#model.commands.get(key.cmd);
		let state: PromptLook["state"] = "idle";
		if (cmd) state = !FINAL_STATES.has(cmd.state) ? "waiting" : cmd.state === "done" ? "sent" : "refused";
		return { label, target: targetName(this.#model.target()), state, online: this.#model.online };
	}

	#paint(key: PromptKey): void {
		const cmd = key.cmd === null ? null : this.#model.commands.get(key.cmd);
		if (key.cmd !== null && !cmd) key.cmd = null;
		if (cmd && FINAL_STATES.has(cmd.state) && key.finalAt === null) {
			// Shown for a few seconds, then the key goes back to its label.
			key.finalAt = this.#clock.now();
			this.#log.info(`Saved Prompt ${cmd.id}: ${cmd.state}${cmd.error ? `: ${quote(cmd.error, 120)}` : ""}`);
			key.timer = this.#clock.setTimeout(
				() => {
					key.timer = null;
					if (key.cmd !== cmd.id) return;
					key.cmd = null;
					key.finalAt = null;
					this.#paint(key);
				},
				cmd.state === "done" ? SENT_SHOW_MS : REFUSED_SHOW_MS,
			);
		}
		key.painter.update(promptKeySvg(this.#look(key)), null);
	}
}

type ModeKey = {
	surface: KeySurface;
	painter: KeyPainter<null>;
	settings: ModeKeySettings;
	/** The last press's command, until its outcome has been shown. */
	cmd: string | null;
};

/**
 * The Mode keys, without the SDK. Each holds one mode, set in its Property Inspector, and shows it, blue
 * while it's the target's mode. A press asks the target to change to it; the key shows ok when the change
 * is done, and alerts when it's refused or fails.
 */
export class ModeKeys {
	readonly #model: CommandModel;
	readonly #log: Log;
	readonly #clock: Clock | undefined;
	readonly #paintIntervalMs: number;
	readonly #keys = new Map<string, ModeKey>();

	constructor(model: CommandModel, opts: { log?: Log; clock?: Clock; paintIntervalMs?: number } = {}) {
		this.#model = model;
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		model.onChange(() => this.repaintAll());
	}

	add(id: string, surface: KeySurface, settings: ModeKeySettings): void {
		this.remove(id);
		const painter = new KeyPainter<null>((svg) => surface.setImage(svg), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs });
		const key: ModeKey = { surface, painter, settings, cmd: null };
		this.#keys.set(id, key);
		this.#paint(key);
	}

	setSettings(id: string, settings: ModeKeySettings): void {
		const key = this.#keys.get(id);
		if (!key) return;
		key.settings = settings;
		this.#paint(key);
	}

	remove(id: string): void {
		this.#keys.get(id)?.painter.dispose();
		this.#keys.delete(id);
	}

	press(id: string, settings?: ModeKeySettings): void {
		const key = this.#keys.get(id);
		if (!key) return;
		if (settings) key.settings = settings;
		const mode = key.settings.mode;
		if (!isMode(mode)) {
			this.#log.info("Mode key: no mode set; set it in the key's settings");
			key.surface.showAlert();
			return;
		}
		const cmd = queueForTarget(this.#model, this.#log, `Mode key ${mode}`, { t: "mode", mode });
		if (!cmd) {
			key.surface.showAlert();
			return;
		}
		key.cmd = cmd.id;
		this.#paint(key);
	}

	repaintAll(): void {
		for (const key of this.#keys.values()) this.#paint(key);
	}

	painted(id: string): string | null {
		return this.#keys.get(id)?.painter.svg ?? null;
	}

	look(id: string): ModeKeyLook | null {
		const key = this.#keys.get(id);
		return key ? this.#look(key) : null;
	}

	#look(key: ModeKey): ModeKeyLook {
		const mode: Mode | null = isMode(key.settings.mode) ? key.settings.mode : null;
		const target = this.#model.target();
		const cmd = key.cmd === null ? null : this.#model.commands.get(key.cmd);
		return {
			mode: mode === null ? null : modeName(mode),
			active: mode !== null && target?.listed === true && target.mode === mode,
			pending: cmd !== null && !FINAL_STATES.has(cmd.state),
			target: targetName(target),
			online: this.#model.online,
		};
	}

	#paint(key: ModeKey): void {
		const cmd = key.cmd === null ? null : this.#model.commands.get(key.cmd);
		if (key.cmd !== null && (!cmd || FINAL_STATES.has(cmd.state))) {
			key.cmd = null;
			if (cmd?.state === "done") key.surface.showOk();
			else {
				this.#log.info(`Mode key ${cmd?.id ?? "?"}: ${cmd?.state ?? "forgotten"}${cmd?.error ? `: ${quote(cmd.error, 120)}` : ""}`);
				key.surface.showAlert();
			}
		}
		key.painter.update(modeKeySvg(this.#look(key)), null);
	}
}
