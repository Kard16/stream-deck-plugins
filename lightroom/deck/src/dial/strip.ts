import { type Slot, variantFor } from "../banks.js";
import type { ConnState } from "../lr/client.js";
import { formatValue } from "../model/format.js";
import type { ParamView } from "../model/model.js";
import { clampToRange } from "../model/steps.js";

/** Colours for layouts/dial.json's keys. The live ones match the layout's own defaults. */
export const STRIP_COLORS = {
	label: "#E6E6E6",
	bank: "#8A8F99",
	value: "#FFFFFF",
	fill: "#4A9EFF",
	groove: "#33383F",
	dimLabel: "#6A707A",
	dimBank: "#4C5159",
	dimValue: "#6A707A",
	dimFill: "#4C5159",
	dimGroove: "#24272D",
	empty: "#5A5F69",
	status: "#E0A43A",
} as const;

export const VALUE_FONT = { size: 30, weight: 700 } as const;
export const STATUS_FONT = { size: 22, weight: 700 } as const;

/** The full state of each layout key; the painter sends only the keys that changed. */
export type StripItem = Record<string, unknown>;
export type StripFeedback = { label: StripItem; bank: StripItem; value: StripItem; bar: StripItem };

export type StripInput = {
	slot: Slot | null;
	/** 0-based. */
	bank: number;
	bankCount: number;
	view: ParamView | null;
	conn: ConnState;
	writable: boolean | null;
	inDevelop: boolean;
};

const STATUS: Partial<Record<ConnState, string>> = { offline: "Offline", busy: "Busy", mismatch: "Mismatch" };

/** Dimmed when Lightroom is offline, busy, mismatched, read-only (hello.writable false) or not in Develop. */
export function isDimmed(i: Pick<StripInput, "conn" | "writable" | "inDevelop">): boolean {
	return i.conn !== "online" || i.writable === false || !i.inDevelop;
}

/**
 * One dial's strip: the slot's label, the bank as "n/4", the value, and a bar over the param's range.
 * Without a connection the value area says why ("Offline", "Busy", "Mismatch"). Empty slots show "—".
 */
export function stripFor(i: StripInput): StripFeedback {
	const dim = isDimmed(i);
	const bank = { value: `${i.bank + 1}/${i.bankCount}`, color: dim ? STRIP_COLORS.dimBank : STRIP_COLORS.bank };
	if (!i.slot) {
		return {
			label: { value: "—", color: STRIP_COLORS.empty },
			bank,
			value: { value: "", color: STRIP_COLORS.dimValue, font: VALUE_FONT },
			bar: { value: 0, range: { min: -100, max: 100 }, subtype: 1, bar_fill_c: STRIP_COLORS.dimFill, bar_bg_c: STRIP_COLORS.dimGroove, opacity: 0 },
		};
	}
	const range = i.view?.range ?? null;
	const value = i.view?.value ?? null;
	const status = STATUS[i.conn] ?? null;
	let valueItem: StripItem;
	if (status) valueItem = { value: status, color: STRIP_COLORS.status, font: STATUS_FONT };
	else if (value === null) valueItem = { value: "—", color: dim ? STRIP_COLORS.dimValue : STRIP_COLORS.value, font: VALUE_FONT };
	else valueItem = { value: formatValue(value, variantFor(i.slot, range)), color: dim ? STRIP_COLORS.dimValue : STRIP_COLORS.value, font: VALUE_FONT };
	const [min, max] = range ?? [-100, 100];
	// A range centred on 0 fills outwards from the centre (DoubleRectangle); anything else, Kelvin for one, fills from the left.
	const centred = min < 0 && max > 0 && Math.abs(min + max) <= 1e-9 * (max - min);
	const rest = centred ? 0 : min;
	return {
		label: { value: i.slot.label, color: dim ? STRIP_COLORS.dimLabel : STRIP_COLORS.label },
		bank,
		value: valueItem,
		bar: {
			value: value === null ? rest : clampToRange(value, [min, max]),
			range: { min, max },
			subtype: centred ? 1 : 0,
			bar_fill_c: dim ? STRIP_COLORS.dimFill : STRIP_COLORS.fill,
			bar_bg_c: dim ? STRIP_COLORS.dimGroove : STRIP_COLORS.groove,
			opacity: 1,
		},
	};
}
