import type { Range } from "../lr/protocol.js";

/** How far one dial tick moves a value: normally, in push + turn fine mode, and in big steps. */
export type Steps = { step: number; fine: number; macro: number };

/**
 * How a turn moves its param: normal steps with acceleration; fine steps during push + turn; big steps after a
 * tap on the strip. Fine and big steps have no acceleration.
 */
export type TurnMode = "normal" | "fine" | "macro";

/**
 * A slider's steps. `kelvin`, when set, replaces them while Lightroom reports a Kelvin range for the param:
 * Temperature is 2000..50000 K on raw and DNG files but -100..100 on JPEGs (PROTOCOL.md, Develop values).
 */
export type StepSpec = Steps & { kelvin?: Steps | null };

/** Temperature's raw range starts at 2000 K; every slider-unit range in Lightroom starts at or below 0. */
export function isKelvinRange(range: Range | null | undefined): boolean {
	return range !== null && range !== undefined && range[0] >= 1000;
}

export function stepsFor(spec: StepSpec, range: Range | null | undefined): Steps {
	return isKelvinRange(range) && spec.kelvin ? spec.kelvin : spec;
}

/** Value units one tick of `mode` moves the param, by the steps for its current range. */
export function unitsPerTick(spec: StepSpec, range: Range | null | undefined, mode: TurnMode): number {
	const steps = stepsFor(spec, range);
	if (mode === "fine") return steps.fine;
	if (mode === "macro") return steps.macro;
	return steps.step;
}

/**
 * Spike S4 found the app batches fast spins into events about 50 ms apart with up to 4 ticks each, so the
 * acceleration is per event: effective ticks = ticks × (1 + k × (|ticks| − 1)). With k = 0.5 that maps
 * 1, 2, 3, 4 ticks to 1, 3, 6, 10.
 */
export function accelerate(ticks: number, k: number): number {
	if (ticks === 0) return 0;
	return ticks * (1 + k * (Math.abs(ticks) - 1));
}

export function clampToRange(value: number, range: Range | null | undefined): number {
	if (!range) return value;
	return Math.min(range[1], Math.max(range[0], value));
}
