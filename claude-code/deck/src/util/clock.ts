/**
 * Time and timers for the dial and the painters. Production uses {@link realClock}; tests drive a fake clock,
 * so the 40 ms tick coalescing and the paint rate limits are tested exactly rather than with sleeps.
 */
export interface Clock {
	/** Milliseconds on a clock that only moves forward. Only differences between two readings mean anything. */
	now(): number;
	setTimeout(fn: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

/** Opaque timer handle. */
export type TimerHandle = { readonly __timer: unique symbol } | object;

/** Monotonic, not the wall clock, so a time sync after wake can't stall the rate limits. */
export const realClock: Clock = {
	now: () => performance.now(),
	setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
