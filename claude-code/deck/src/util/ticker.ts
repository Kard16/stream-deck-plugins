import type { Clock, TimerHandle } from "./clock.js";
import { countIdle } from "./idle.js";
import { describeError, type Log, nullLog } from "./log.js";

/**
 * How long after the moment asked for a tick runs. A timer can fire a little early by the wall clock (Node's timers
 * count from the event loop's time, which can lag a few ms), and a repaint just before a label's change would find
 * nothing to change and ask again at once.
 */
export const TICK_SLACK_MS = 10;

/** The longest a tick waits, so a wall clock that jumped while the deck ran catches up within the hour. */
export const MAX_TICK_MS = 3_600_000;

/** How long after a tick that threw, without asking for the next, it runs again: the old 1 s ticker's beat. */
export const RETRY_TICK_MS = 1000;

/**
 * Runs `fn` at the wall-clock moment its owner asks for (`at`): the slots repaint their keys, dials and Others with it
 * when a `since` they show next reads differently, a `59s` becoming `1m` say, and at no other time (hardening.md, B6).
 * Each `at` replaces the moment asked for before and times it afresh from the wall clock now, so a repaint after a
 * sleep puts the next tick back on time, whether or not the timers counted it (on macOS they do). `fn`, which repaints, asks for the next; null
 * asks for none. A throw from `fn` is logged at error, and unless `fn` asked for a moment first, it runs again
 * RETRY_TICK_MS later: it runs from a timer, where a throw would be uncaught, and the SDK logs only the first uncaught
 * exception before the plugin goes down with the held requests. The timer never keeps the process up.
 */
export class Ticker {
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	readonly #fn: () => void;
	readonly #log: Log;
	readonly #what: string;
	#timer: TimerHandle | null = null;
	/** The wall-clock moment the timer is for; null for none. */
	#at: number | null = null;

	/** `wallNow` (Date.now by default) is the clock `at` takes its moments on; `what` names the ticks in the line a throw gets. */
	constructor(clock: Clock, fn: () => void, opts: { wallNow?: () => number; log?: Log; what?: string } = {}) {
		this.#clock = clock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#fn = fn;
		this.#log = opts.log ?? nullLog;
		this.#what = opts.what ?? "a repaint tick";
	}

	/** The wall-clock moment the next tick is for; null while none is asked for. */
	get next(): number | null {
		return this.#at;
	}

	/** Asks for a tick at wall-clock ms `when`, in place of the one asked for before; null, or a time that isn't finite, for none. */
	at(when: number | null): void {
		if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
		this.#timer = null;
		this.#at = when !== null && Number.isFinite(when) ? when : null;
		if (this.#at === null) return;
		const wait = Math.min(MAX_TICK_MS, Math.max(0, this.#at - this.#wallNow()) + TICK_SLACK_MS);
		this.#timer = this.#clock.setTimeout(() => this.#tick(), wait);
		(this.#timer as { unref?: () => void }).unref?.();
	}

	stop(): void {
		this.at(null);
	}

	#tick(): void {
		this.#timer = null;
		this.#at = null;
		countIdle("tick");
		try {
			this.#fn();
		} catch (err) {
			this.#log.error(`${this.#what} threw: ${describeError(err)}`);
			if (this.#at === null) this.at(this.#wallNow() + RETRY_TICK_MS);
		}
	}
}
