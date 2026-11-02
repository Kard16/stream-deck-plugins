import type { SessionView } from "../model/sessions.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { type Log, nullLog, quote } from "../util/log.js";
import { type Feedback, PAINT_INTERVAL_MS, StripPainter } from "../util/painter.js";
import { sessionsStrip } from "./strip.js";

/** Ticks that arrive within this window are summed and applied together. */
export const COALESCE_MS = 40;

/** What the SDK adapter gives for one dial. */
export type DialSurface = {
	setFeedback(payload: Feedback): void;
	showAlert(): void;
};

/** What the Sessions dial needs from the session model. */
export interface SessionsModel {
	sessions(): SessionView[];
	target(): SessionView | null;
	pick(key: string): void;
	onChange(listener: () => void): () => void;
}

type Dial = {
	id: string;
	surface: DialSurface;
	painter: StripPainter;
	/** The selected session's key, so the selection follows it when the list changes. */
	selected: string | null;
	index: number;
	pendingTicks: number;
	timer: TimerHandle | null;
	pressed: boolean;
	turnedWhilePressed: boolean;
};

/**
 * The Sessions dial, without the SDK. Each placed dial scrolls the running sessions on its own strip, one
 * session per tick, stopping at either end, and follows its session by the app's `local_…` id while the list
 * changes. Press (without turning) and tap jump to the session in the app through the `open` callback and
 * make it the target for prompts and mode. Long-touch only logs.
 */
export class SessionsDials {
	readonly #model: SessionsModel;
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #paintIntervalMs: number;
	readonly #open: (host: string) => void;
	readonly #dials = new Map<string, Dial>();
	#sessions: SessionView[] = [];

	constructor(model: SessionsModel, opts: { clock?: Clock; log?: Log; paintIntervalMs?: number; open?: (host: string) => void } = {}) {
		this.#model = model;
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#open = opts.open ?? (() => {});
		this.#sessions = model.sessions();
		model.onChange(() => this.refresh());
	}

	/** The model changed: each dial stays on its session, or on the same position if it ended, and repaints. */
	refresh(): void {
		this.#sessions = this.#model.sessions();
		for (const dial of this.#dials.values()) {
			const found = dial.selected === null ? -1 : this.#sessions.findIndex((s) => s.key === dial.selected);
			this.#select(dial, found >= 0 ? found : dial.index);
			this.#repaint(dial);
		}
	}

	/** A dial appeared: it starts on the first session and paints in full. */
	add(id: string, surface: DialSurface): void {
		let dial = this.#dials.get(id);
		if (!dial) {
			dial = {
				id,
				surface,
				painter: new StripPainter((payload) => surface.setFeedback(payload), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs }),
				selected: null,
				index: 0,
				pendingTicks: 0,
				timer: null,
				pressed: false,
				turnedWhilePressed: false,
			};
			this.#dials.set(id, dial);
			this.#select(dial, 0);
		}
		dial.surface = surface;
		dial.painter.forget();
		this.#repaint(dial);
	}

	remove(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (dial.timer !== null) this.#clock.clearTimeout(dial.timer);
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
			if (net === 0) return;
			const from = dial.index;
			this.#select(dial, dial.index + net);
			this.#log.debug(`scroll ${net > 0 ? "+" : ""}${net}: ${from + 1} → ${dial.index + 1} of ${this.#sessions.length}`);
			this.#repaint(dial);
		}, COALESCE_MS);
	}

	down(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		dial.pressed = true;
		dial.turnedWhilePressed = false;
	}

	/** A press counts only if this plugin saw it start and the dial didn't turn while held. */
	up(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial || !dial.pressed) return;
		const turned = dial.turnedWhilePressed;
		dial.pressed = false;
		dial.turnedWhilePressed = false;
		if (!turned) this.#jump(dial, "press");
	}

	/** Tap jumps, the touch alternative to pressing (a dial stack takes the press). Long-touch only logs. */
	tap(id: string, hold: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (!hold) {
			this.#jump(dial, "tap");
			return;
		}
		const s = this.#sessions[dial.index];
		this.#log.info(s ? `long-touch ${s.host ?? `(no app id; pid ${s.pid ?? "?"})`}: nothing assigned` : "long-touch: no sessions");
	}

	/** What a dial's strip shows now, for tests. */
	painted(id: string): Feedback | null {
		return this.#dials.get(id)?.painter.painted ?? null;
	}

	/** The selected session of a dial, for tests. */
	selected(id: string): SessionView | null {
		const dial = this.#dials.get(id);
		return dial ? (this.#sessions[dial.index] ?? null) : null;
	}

	#jump(dial: Dial, via: "press" | "tap"): void {
		const s = this.#sessions[dial.index];
		if (!s) {
			this.#log.info(`jump via ${via}: no sessions`);
			dial.surface.showAlert();
			return;
		}
		if (s.host === null) {
			this.#log.info(`jump via ${via}: pid ${s.pid ?? "?"} (${quote(s.title)}) has no app id`);
			dial.surface.showAlert();
			return;
		}
		// The jump makes it the target too (PROTOCOL.md, "The target session"). S5's route,
		// claude://code/continue?session=<local_id>, is opened by the plugin (see plugin.ts).
		this.#model.pick(s.key);
		this.#log.info(`jump ${s.host} via ${via}: ${quote(s.title)}`);
		this.#open(s.host);
	}

	#select(dial: Dial, index: number): void {
		const last = this.#sessions.length - 1;
		dial.index = last < 0 ? 0 : Math.max(0, Math.min(last, index));
		const s = this.#sessions[dial.index];
		dial.selected = s ? s.key : null;
	}

	#repaint(dial: Dial): void {
		const s = this.#sessions[dial.index] ?? null;
		const target = this.#model.target();
		dial.painter.update(sessionsStrip(s, dial.index, this.#sessions.length, s !== null && target?.listed === true && target.key === s.key));
	}
}
