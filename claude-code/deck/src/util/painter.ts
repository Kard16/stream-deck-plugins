import { type Clock, realClock, type TimerHandle } from "./clock.js";

/** At most 10 updates a second per dial strip or key. */
export const PAINT_INTERVAL_MS = 100;

export type Feedback = Record<string, unknown>;

/**
 * Whether a Stream Deck is connected to take paints (agents-and-wake.md, C3). While it says no, a painter sends
 * nothing and changes nothing: the latest update waits, and what the key or strip showed, and since when, stays what
 * last reached it. Always yes by default.
 */
export type Live = () => boolean;

const always: Live = () => true;

/**
 * Sends one dial's strip to the app: only the layout keys whose content changed since the last update, and at
 * most one update per interval. Updates that arrive in between are merged; the latest wins.
 * (The same painter as lightroom/deck/src/dial/painter.ts, at 10 a second.)
 *
 * Like KeyPainter, it can also remember what the strip last showed (`shown`, given with each update) and since when,
 * so a press acts on what the strip displayed, once it has been there long enough to be seen (a Session Slot dial's
 * held request and the choice on it, src/slots/dials.ts).
 */
export class StripPainter<T = undefined> {
	readonly #send: (payload: Feedback) => void;
	readonly #clock: Clock;
	readonly #throttle: Throttle;
	/** Each key's content as last sent, as JSON. */
	readonly #painted = new Map<string, string>();
	#desired: Feedback | null = null;
	#desiredShown: T | undefined = undefined;
	#shown: { value: T | undefined } | null = null;
	#shownSince: number | null = null;
	readonly #onShown: ((shown: T | undefined) => void) | null;
	readonly #equals: (a: T | undefined, b: T | undefined) => boolean;
	readonly #live: Live;

	/**
	 * `onShown` runs at the paint that changes what the strip shows, with the new value. `equals` says whether two
	 * shown values are the same thing (Object.is by default, so an object value needs one).
	 */
	constructor(
		send: (payload: Feedback) => void,
		opts: { clock?: Clock; minIntervalMs?: number; onShown?: (shown: T | undefined) => void; equals?: (a: T | undefined, b: T | undefined) => boolean; live?: Live } = {},
	) {
		this.#send = send;
		this.#clock = opts.clock ?? realClock;
		this.#onShown = opts.onShown ?? null;
		this.#equals = opts.equals ?? Object.is;
		this.#live = opts.live ?? always;
		this.#throttle = new Throttle(() => this.#flush(), { clock: this.#clock, minIntervalMs: opts.minIntervalMs });
	}

	update(desired: Feedback, shown?: T): void {
		this.#desired = desired;
		this.#desiredShown = shown;
		this.#throttle.request();
	}

	/** What the strip last sent showed; undefined before the first paint, or when updates give none. */
	get shown(): T | undefined {
		return this.#shown?.value;
	}

	/**
	 * When `shown` took its current value, on the painter's clock; null before the first paint. A new paint of the same
	 * thing leaves it; a different thing resets it, even when the strip's keys come out the same.
	 */
	get shownSince(): number | null {
		return this.#shownSince;
	}

	/** The app forgot the strip (the dial reappeared, or a device connected): the next update sends every key. */
	forget(): void {
		this.#painted.clear();
	}

	dispose(): void {
		this.#throttle.dispose();
	}

	/** What the strip shows now, as far as this painter knows. */
	get painted(): Feedback {
		const out: Feedback = {};
		for (const [key, json] of this.#painted) out[key] = JSON.parse(json) as unknown;
		return out;
	}

	/** Returns whether anything was sent, so the throttle only counts real paints. */
	#flush(): boolean {
		if (!this.#desired || !this.#live()) return false;
		const showsNew = this.#shown === null || !this.#equals(this.#shown.value, this.#desiredShown);
		if (showsNew) this.#shownSince = this.#clock.now();
		this.#shown = { value: this.#desiredShown };
		if (showsNew) this.#onShown?.(this.#desiredShown);
		const changed: Feedback = {};
		let any = false;
		for (const [key, content] of Object.entries(this.#desired)) {
			const json = JSON.stringify(content);
			if (this.#painted.get(key) === json) continue;
			this.#painted.set(key, json);
			changed[key] = content;
			any = true;
		}
		if (any) this.#send(changed);
		return any;
	}
}

/**
 * Sends one key's image: only when it differs from the last one sent, and at most one per interval. It also
 * remembers what that image showed (`shown`), and since when, so a press acts on what the key last displayed,
 * and only once it has been there long enough to be seen.
 */
export class KeyPainter<T> {
	readonly #send: (svg: string) => void;
	readonly #clock: Clock;
	readonly #throttle: Throttle;
	readonly #live: Live;
	#desired: { svg: string; shown: T } | null = null;
	#painted: { svg: string; shown: T } | null = null;
	#shownSince: number | null = null;
	/** The app may have lost the last image: the next flush sends, even the same one. */
	#forgotten = false;

	constructor(send: (svg: string) => void, opts: { clock?: Clock; minIntervalMs?: number; live?: Live } = {}) {
		this.#send = send;
		this.#clock = opts.clock ?? realClock;
		this.#live = opts.live ?? always;
		this.#throttle = new Throttle(() => this.#flush(), { clock: this.#clock, minIntervalMs: opts.minIntervalMs });
	}

	update(svg: string, shown: T): void {
		this.#desired = { svg, shown };
		this.#throttle.request();
	}

	/** What the image last sent showed; undefined before the first paint. */
	get shown(): T | undefined {
		return this.#painted?.shown;
	}

	/**
	 * When `shown` took its current value, on the painter's clock; null before the first paint. A new image
	 * of the same thing (a count going up, say) leaves it; a different thing resets it, even in an identical image.
	 */
	get shownSince(): number | null {
		return this.#shownSince;
	}

	get svg(): string | null {
		return this.#painted?.svg ?? null;
	}

	/**
	 * The app may have lost the image (a device connected; agents-and-wake.md, C2): the next update sends it, even
	 * unchanged. What the key showed, and since when, stay.
	 */
	forget(): void {
		this.#forgotten = true;
	}

	dispose(): void {
		this.#throttle.dispose();
	}

	#flush(): boolean {
		const desired = this.#desired;
		if (!desired || !this.#live()) return false;
		const same = !this.#forgotten && this.#painted?.svg === desired.svg;
		if (this.#painted === null || !Object.is(this.#painted.shown, desired.shown)) this.#shownSince = this.#clock.now();
		this.#painted = desired;
		if (same) return false;
		this.#forgotten = false;
		this.#send(desired.svg);
		return true;
	}
}

/**
 * Runs `flush` at most once per interval: straight away when the last flush that sent something was long
 * enough ago, otherwise once at the end of the interval, however many requests arrived in between.
 */
class Throttle {
	readonly #flush: () => boolean;
	readonly #clock: Clock;
	readonly #intervalMs: number;
	#last = -Infinity;
	#timer: TimerHandle | null = null;
	#disposed = false;

	constructor(flush: () => boolean, opts: { clock?: Clock; minIntervalMs?: number }) {
		this.#flush = flush;
		this.#clock = opts.clock ?? realClock;
		this.#intervalMs = opts.minIntervalMs ?? PAINT_INTERVAL_MS;
	}

	request(): void {
		if (this.#disposed || this.#timer !== null) return; // the pending flush picks up the latest content
		const wait = this.#last + this.#intervalMs - this.#clock.now();
		if (wait <= 0) this.#run();
		else {
			this.#timer = this.#clock.setTimeout(() => {
				this.#timer = null;
				this.#run();
			}, wait);
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
		this.#timer = null;
	}

	#run(): void {
		if (this.#disposed) return;
		if (this.#flush()) this.#last = this.#clock.now();
	}
}
