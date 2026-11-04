import type { ConnState } from "../lr/client.js";
import { formatValue } from "../model/format.js";
import type { ParamView } from "../model/model.js";
import { clampToRange } from "../model/steps.js";
import { type Slider, type SliderVariant, variantFor } from "../sliders.js";

/** Colours for layouts/dial.json's keys. The live ones match the layout's own defaults. */
export const STRIP_COLORS = {
	label: "#E6E6E6",
	value: "#FFFFFF",
	fill: "#4A9EFF",
	groove: "#33383F",
	/** Big steps: the mode text and the bar fill. It stands apart from the blue fill and the amber status words. */
	macro: "#3DDC84",
	dimLabel: "#6A707A",
	dimValue: "#6A707A",
	dimFill: "#4C5159",
	dimGroove: "#24272D",
	dimMacro: "#2F7A52",
	status: "#E0A43A",
} as const;

export const VALUE_FONT = { size: 30, weight: 700 } as const;
export const STATUS_FONT = { size: 22, weight: 700 } as const;

/** The full state of each layout key; the painter sends only the keys that changed. */
export type StripItem = Record<string, unknown>;
export type StripFeedback = { label: StripItem; mode: StripItem; value: StripItem; bar: StripItem };

export type StripInput = {
	/** The dial's slider, or null when sliders.json doesn't list its param. */
	slider: Slider | null;
	/** The dial's param, from its settings. */
	param: string;
	/** Big steps are on for this dial. */
	big: boolean;
	view: ParamView | null;
	conn: ConnState;
	writable: boolean | null;
	inDevelop: boolean;
	/** `state.locked`: a background AI process holds the photo, so turns and presses do nothing (PROTOCOL.md, Locked photos). */
	locked: boolean;
};

const STATUS: Partial<Record<ConnState, string>> = { offline: "Offline", busy: "Busy", mismatch: "Mismatch" };
export const LOCKED_STATUS = "Locked";
export const UNLISTED_STATUS = "Not listed";

/** Dimmed when Lightroom is offline, busy, mismatched, read-only (hello.writable false), not in Develop, or the photo is locked. */
export function isDimmed(i: Pick<StripInput, "conn" | "writable" | "inDevelop" | "locked">): boolean {
	return i.conn !== "online" || i.writable === false || !i.inDevelop || i.locked;
}

/** The mode text with big steps on: a big step in normal steps, "×10", to at most one decimal place. */
export function macroText(v: SliderVariant): string {
	return `×${Math.round((v.macro / v.step) * 10) / 10}`;
}

/** No bar: a dial whose param sliders.json doesn't list. */
const NO_BAR: StripItem = { value: 0, range: { min: -100, max: 100 }, subtype: 1, bar_fill_c: STRIP_COLORS.dimFill, bar_bg_c: STRIP_COLORS.dimGroove, opacity: 0 };

/**
 * One dial's strip: the slider's label, the mode, the value, and a bar over the param's range. The mode is empty
 * normally; with big steps on it says "×10" and it and the bar fill turn green. Without a connection the value
 * area says why ("Offline", "Busy", "Mismatch"); online, it says "Locked" while the photo is locked. The rest is
 * dimmed then, as outside Develop, and the green dims too. A param sliders.json doesn't list shows as the label,
 * with "Not listed" and no bar.
 */
export function stripFor(i: StripInput): StripFeedback {
	const dim = isDimmed(i);
	const label = { value: i.slider?.label ?? i.param, color: dim ? STRIP_COLORS.dimLabel : STRIP_COLORS.label };
	if (!i.slider) {
		return {
			label,
			mode: { value: "", color: STRIP_COLORS.macro },
			value: { value: UNLISTED_STATUS, color: STRIP_COLORS.status, font: STATUS_FONT },
			bar: NO_BAR,
		};
	}
	const range = i.view?.range ?? null;
	const value = i.view?.value ?? null;
	const shown = variantFor(i.slider, range);
	const green = dim ? STRIP_COLORS.dimMacro : STRIP_COLORS.macro;
	const mode = i.big ? { value: macroText(shown), color: green } : { value: "", color: STRIP_COLORS.macro };
	const status = STATUS[i.conn] ?? (i.locked ? LOCKED_STATUS : null);
	let valueItem: StripItem;
	if (status) valueItem = { value: status, color: STRIP_COLORS.status, font: STATUS_FONT };
	else if (value === null) valueItem = { value: "—", color: dim ? STRIP_COLORS.dimValue : STRIP_COLORS.value, font: VALUE_FONT };
	else valueItem = { value: formatValue(value, shown), color: dim ? STRIP_COLORS.dimValue : STRIP_COLORS.value, font: VALUE_FONT };
	const [min, max] = range ?? [-100, 100];
	// A range centred on 0 fills outwards from the centre (DoubleRectangle); anything else, Kelvin or 0…150 for two, fills from the left.
	const centred = min < 0 && max > 0 && Math.abs(min + max) <= 1e-9 * (max - min);
	const rest = centred ? 0 : min;
	return {
		label,
		mode,
		value: valueItem,
		bar: {
			value: value === null ? rest : clampToRange(value, [min, max]),
			range: { min, max },
			subtype: centred ? 1 : 0,
			bar_fill_c: i.big ? green : dim ? STRIP_COLORS.dimFill : STRIP_COLORS.fill,
			bar_bg_c: dim ? STRIP_COLORS.dimGroove : STRIP_COLORS.groove,
			opacity: 1,
		},
	};
}
