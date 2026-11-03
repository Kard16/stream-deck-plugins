import { type Clock, realClock } from "./clock.js";
import type { Log } from "./log.js";

/** How often a line of one kind may reach info after its first: once in 10 minutes. */
export const QUIET_MS = 10 * 60_000;

/**
 * A log for a kind of line that can repeat without end, such as a request refused for a stale token, which once
 * made 211 info lines in a row. Lines are grouped by a key, a route and a reason say; the caller keeps the keys
 * few. The first line of a key goes at info. After that, a line goes at info only when the last at info was
 * QUIET_MS ago or more, and it then says how many came in between; the rest go at debug, whole.
 */
export class QuietLog {
	readonly #log: Log;
	readonly #clock: Clock;
	readonly #everyMs: number;
	/** By key: when its last line went at info, by the clock, and how many have gone at debug since. */
	readonly #keys = new Map<string, { infoAt: number; since: number }>();

	constructor(log: Log, opts: { clock?: Clock; everyMs?: number } = {}) {
		this.#log = log;
		this.#clock = opts.clock ?? realClock;
		this.#everyMs = opts.everyMs ?? QUIET_MS;
	}

	note(key: string, message: string): void {
		const now = this.#clock.now();
		const last = this.#keys.get(key);
		if (last && now - last.infoAt < this.#everyMs) {
			last.since++;
			this.#log.debug(message);
			return;
		}
		this.#keys.set(key, { infoAt: now, since: 0 });
		const more = last && last.since > 0 ? `; ${last.since} more like it, at debug, in the ${Math.round((now - last.infoAt) / 60_000)} min since the last at info` : "";
		this.#log.info(`${message}${more}`);
	}

	/** Starts a key afresh, once what it logs is over: its next line goes at info, as a first. */
	forget(key: string): void {
		this.#keys.delete(key);
	}
}
