import { roundHalfAway } from "../lr/protocol.js";

export type DisplaySpec = { precision: number; unit: string; signed: boolean };

/**
 * Formats a value for the strip: Exposure as "+0.35", Temperature as "5500 K" on raw files, everything else
 * as a signed whole number ("+15", "-20", "0"). Halves round away from zero, as values do before sending.
 * Zero never shows a sign, and never "-0".
 */
export function formatValue(value: number, spec: DisplaySpec): string {
	const rounded = roundHalfAway(value, spec.precision);
	const digits = Math.abs(rounded).toFixed(spec.precision);
	const sign = rounded < 0 ? "-" : spec.signed && rounded > 0 ? "+" : "";
	return `${sign}${digits}${spec.unit ? ` ${spec.unit}` : ""}`;
}
