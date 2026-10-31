/**
 * Time and timers for the value model and the strip painter. Production uses {@link realClock}; the model
 * tests drive a fake clock, so gesture timing (30 sets a second, done after 800 ms, the 300 ms echo window,
 * the 2 s hold) is tested exactly rather than with sleeps.
 */
export interface Clock {
	/** Milliseconds on a clock that only moves forward. Only differences between two readings mean anything. */
	now(): number;
	setTimeout(fn: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

/** Opaque timer handle. */
export type TimerHandle = { readonly __timer: unique symbol } | object;

/**
 * Monotonic, not the wall clock: a wall-clock step backwards (a time sync after wake, say) would otherwise
 * stall the set rate limit and the strip painter for the size of the step. Date.now() is only for log stamps.
 */
export const realClock: Clock = {
	now: () => performance.now(),
	setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
