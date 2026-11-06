import type { Clock, TimerHandle } from "./clock.js";
import { countIdle } from "./idle.js";
import { describeError, type Log, nullLog } from "./log.js";

/**
 * Runs `fn` every `intervalMs` on the clock while it's running: the slot keys and dials repaint with it, so a `since`
 * such as `4m` keeps up with the time. `fn` should only repaint; painters send nothing unless something changed. A
 * `stop` from inside `fn` holds. A throw from `fn` is logged at error and the ticks go on: it runs from a timer, where
 * a throw would be uncaught, and the SDK logs only the first uncaught exception before the plugin goes down with the
 * held requests.
 */
export class Ticker {
	readonly #clock: Clock;
	readonly #intervalMs: number;
	readonly #fn: () => void;
	readonly #log: Log;
	readonly #what: string;
	#running = false;
	#timer: TimerHandle | null = null;

	/** `what` names the ticks in the log line a throw gets. */
	constructor(clock: Clock, intervalMs: number, fn: () => void, opts: { log?: Log; what?: string } = {}) {
		this.#clock = clock;
		this.#intervalMs = intervalMs;
		this.#fn = fn;
		this.#log = opts.log ?? nullLog;
		this.#what = opts.what ?? "a repaint tick";
	}

	get running(): boolean {
		return this.#running;
	}

	start(): void {
		if (this.#running || !(this.#intervalMs > 0)) return;
		this.#running = true;
		this.#arm();
	}

	stop(): void {
		this.#running = false;
		if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
		this.#timer = null;
	}

	#arm(): void {
		this.#timer = this.#clock.setTimeout(() => {
			this.#timer = null;
			if (!this.#running) return;
			countIdle("tick");
			try {
				this.#fn();
			} catch (err) {
				this.#log.error(`${this.#what} threw: ${describeError(err)}`);
			} finally {
				if (this.#running && this.#timer === null) this.#arm();
			}
		}, this.#intervalMs);
	}
}
