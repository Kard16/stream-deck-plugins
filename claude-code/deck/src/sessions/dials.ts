import type { RegistrySession } from "../registry/registry.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { type Log, nullLog, quote } from "../util/log.js";
import { type Feedback, PAINT_INTERVAL_MS, StripPainter } from "../util/painter.js";
import { displayName, sessionsStrip } from "./strip.js";

/** Ticks that arrive within this window are summed and applied together. */
export const COALESCE_MS = 40;

/**
 * What a dial follows a session by: the app's `local_…` id, fixed for the session's life (the jump route
 * takes it too), or the registry file's pid when the file has none.
 */
export function identity(s: RegistrySession): string {
	return s.hostSessionId ?? `pid:${s.key}`;
}

/** What the SDK adapter gives for one dial. */
export type DialSurface = {
	setFeedback(payload: Feedback): void;
	showAlert(): void;
};

type Dial = {
	id: string;
	surface: DialSurface;
	painter: StripPainter;
	/** The selected session's identity ({@link identity}), so the selection follows it when the list changes. */
	selected: string | null;
	index: number;
	pendingTicks: number;
	timer: TimerHandle | null;
	pressed: boolean;
	turnedWhilePressed: boolean;
};

/**
 * The Sessions dial, without the SDK. Each placed dial scrolls the registry's sessions on its own strip, one
 * session per tick, stopping at either end. Press (without turning) and tap jump to the session in the app
 * through the `open` callback, and log `jump <hostSessionId>`. Long-touch only logs.
 */
export class SessionsDials {
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #paintIntervalMs: number;
	readonly #open: (hostSessionId: string) => void;
	readonly #dials = new Map<string, Dial>();
	#sessions: RegistrySession[] = [];

	constructor(
		opts: { clock?: Clock; log?: Log; paintIntervalMs?: number; open?: (hostSessionId: string) => void } = {},
	) {
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#open = opts.open ?? (() => {});
	}

	/** A new list from the registry: each dial stays on its session, or on the same position if it ended. */
	setSessions(sessions: RegistrySession[]): void {
		this.#sessions = sessions;
		for (const dial of this.#dials.values()) {
			const found = dial.selected === null ? -1 : sessions.findIndex((s) => identity(s) === dial.selected);
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
		this.#log.info(s ? `long-touch ${s.hostSessionId ?? `(no hostSessionId; pid ${s.key})`}: nothing assigned yet` : "long-touch: no sessions");
	}

	/** What a dial's strip shows now, for tests. */
	painted(id: string): Feedback | null {
		return this.#dials.get(id)?.painter.painted ?? null;
	}

	/** The selected session of a dial, for tests. */
	selected(id: string): RegistrySession | null {
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
		if (s.hostSessionId === null) {
			this.#log.info(`jump via ${via}: pid ${s.key} (${quote(displayName(s))}) has no hostSessionId`);
			dial.surface.showAlert();
			return;
		}
		// S5's route, claude://code/continue?session=<local_id>, is opened by the plugin (see plugin.ts).
		this.#log.info(`jump ${s.hostSessionId} via ${via}: ${quote(displayName(s))}`);
		this.#open(s.hostSessionId);
	}

	#select(dial: Dial, index: number): void {
		const last = this.#sessions.length - 1;
		dial.index = last < 0 ? 0 : Math.max(0, Math.min(last, index));
		const s = this.#sessions[dial.index];
		dial.selected = s ? identity(s) : null;
	}

	#repaint(dial: Dial): void {
		dial.painter.update(sessionsStrip(this.#sessions, dial.index));
	}
}
