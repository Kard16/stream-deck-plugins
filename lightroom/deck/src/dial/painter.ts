import { type Clock, realClock, type TimerHandle } from "../util/clock.js";

/** At most 15 strip updates a second per dial (PROTOCOL.md, Rates). */
export const STRIP_INTERVAL_MS = Math.ceil(1000 / 15);

export type Feedback = Record<string, unknown>;

/**
 * Sends one dial's strip to the app: only the layout keys whose content changed since the last update, and at
 * most one update per {@link STRIP_INTERVAL_MS}. Updates that arrive in between are merged; the latest wins.
 */
export class StripPainter {
	readonly #send: (payload: Feedback) => void;
	readonly #clock: Clock;
	readonly #intervalMs: number;
	/** Each key's content as last sent, as JSON. */
	readonly #painted = new Map<string, string>();
	#desired: Feedback | null = null;
	#lastPaint = -Infinity;
	#timer: TimerHandle | null = null;
	#disposed = false;

	constructor(send: (payload: Feedback) => void, opts: { clock?: Clock; minIntervalMs?: number } = {}) {
		this.#send = send;
		this.#clock = opts.clock ?? realClock;
		this.#intervalMs = opts.minIntervalMs ?? STRIP_INTERVAL_MS;
	}

	update(desired: Feedback): void {
		if (this.#disposed) return;
		this.#desired = desired;
		if (this.#timer !== null) return; // the pending paint picks up the latest content
		const wait = this.#lastPaint + this.#intervalMs - this.#clock.now();
		if (wait <= 0) this.#flush();
		else {
			this.#timer = this.#clock.setTimeout(() => {
				this.#timer = null;
				this.#flush();
			}, wait);
		}
	}

	/** The app forgot the strip (the dial reappeared): the next update sends every key. */
	forget(): void {
		this.#painted.clear();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** What the strip shows now, as far as this painter knows. */
	get painted(): Feedback {
		const out: Feedback = {};
		for (const [key, json] of this.#painted) out[key] = JSON.parse(json) as unknown;
		return out;
	}

	#flush(): void {
		if (this.#disposed || !this.#desired) return;
		const changed: Feedback = {};
		let any = false;
		for (const [key, content] of Object.entries(this.#desired)) {
			const json = JSON.stringify(content);
			if (this.#painted.get(key) === json) continue;
			this.#painted.set(key, json);
			changed[key] = content;
			any = true;
		}
		if (!any) return;
		this.#lastPaint = this.#clock.now();
		this.#send(changed);
	}
}
