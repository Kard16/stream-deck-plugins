import type { Clock, TimerHandle } from "../../src/util/clock.js";

/** A clock the test moves by hand. Timers fire in time order, ties in the order they were set. */
export class FakeClock implements Clock {
	#now = 1_000_000;
	#seq = 0;
	readonly #timers = new Map<number, { at: number; fn: () => void }>();

	now(): number {
		return this.#now;
	}

	setTimeout(fn: () => void, ms: number): TimerHandle {
		const id = ++this.#seq;
		this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
		return { id };
	}

	clearTimeout(handle: TimerHandle): void {
		this.#timers.delete((handle as { id: number }).id);
	}

	/** Moves time forward, firing every timer that falls due on the way, including ones those timers set. */
	advance(ms: number): void {
		const end = this.#now + ms;
		for (;;) {
			let nextId = -1;
			let next: { at: number; fn: () => void } | undefined;
			for (const [id, timer] of this.#timers) {
				if (timer.at > end) continue;
				if (!next || timer.at < next.at || (timer.at === next.at && id < nextId)) {
					next = timer;
					nextId = id;
				}
			}
			if (!next) break;
			this.#timers.delete(nextId);
			this.#now = next.at;
			next.fn();
		}
		this.#now = end;
	}

	get pendingTimers(): number {
		return this.#timers.size;
	}
}
