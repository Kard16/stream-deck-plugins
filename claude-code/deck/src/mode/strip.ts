import { modeName, modelAndEffort } from "../model/format.js";
import type { SessionView } from "../model/sessions.js";
import type { Mode } from "../protocol/wire.js";
import type { StripItem } from "../sessions/strip.js";

/** Colours for layouts/mode.json's keys. The defaults match the layout's own. */
export const MODE_COLORS = {
	target: "#C9CDD4",
	mode: "#FFFFFF",
	chosen: "#4A9EFF",
	applying: "#F2C94C",
	meta: "#8A8F99",
	none: "#6A707A",
} as const;

/**
 * The layout's keys, all ours. The target's title goes in `target`, never the reserved `title` (nor `icon`):
 * the app owns those and may rewrite them, and the painter, which sends only what changed, wouldn't put ours back.
 */
export type ModeStrip = { target: StripItem; mode: StripItem; meta: StripItem };

export type ModeStripInput = {
	target: SessionView | null;
	/** The mode the dial was turned to; null while it follows the target's own. */
	choice: Mode | null;
	/** A change the dial sent is in flight. */
	applying: boolean;
	online: boolean;
};

/**
 * The Mode dial's strip: the target's title; its mode, or the one the dial was turned to ("→ Plan", in
 * blue, until pressed; "Plan…" in amber while the change is in flight); and its model and effort.
 */
export function modeStrip(i: ModeStripInput): ModeStrip {
	const t = i.target;
	if (!t) {
		return {
			target: { value: "No target", color: MODE_COLORS.none },
			mode: { value: i.online ? "—" : "Offline", color: MODE_COLORS.none },
			meta: { value: "Pick a session on the Sessions dial", color: MODE_COLORS.none },
		};
	}
	const target = { value: t.listed ? t.title : `${t.title} (ended)`, color: t.listed ? MODE_COLORS.target : MODE_COLORS.none };
	const meta = { value: t.listed ? modelAndEffort(t.model, t.effort) : "", color: MODE_COLORS.meta };
	let mode: StripItem;
	if (!i.online) mode = { value: "Offline", color: MODE_COLORS.none };
	else if (i.applying && i.choice !== null) mode = { value: `${modeName(i.choice)}…`, color: MODE_COLORS.applying };
	else if (i.choice !== null && i.choice !== t.mode) mode = { value: `→ ${modeName(i.choice)}`, color: MODE_COLORS.chosen };
	else mode = { value: modeName(t.mode), color: t.listed ? MODE_COLORS.mode : MODE_COLORS.none };
	return { target, mode, meta };
}
