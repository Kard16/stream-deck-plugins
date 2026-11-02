import { modelAndEffort, STATUS_COLORS, statusLine } from "../model/format.js";
import type { SessionView } from "../model/sessions.js";

/** Colours for layouts/sessions.json's keys. The defaults match the layout's own. */
export const STRIP_COLORS = {
	name: "#F2F2F2",
	meta: "#8A8F99",
	pos: "#8A8F99",
	ctx: "#C9CDD4",
	none: "#6A707A",
	target: "#4A9EFF",
	fill: "#4A9EFF",
	full: "#F2994A",
	groove: "#2A2F3A",
} as const;

/** Context use from which the strip's bar turns orange. */
export const CONTEXT_HIGH = 80;

export type StripItem = Record<string, unknown>;

/**
 * The layout's keys, all ours: none is the reserved `title` or `icon`, which a user's own title or icon would
 * override. `mark` flags the target session.
 */
export type SessionsStrip = { name: StripItem; mark: StripItem; status: StripItem; ctx: StripItem; meta: StripItem; pos: StripItem; bar: StripItem };

/**
 * One session on the strip: its title, whether it's the target, its status (with the tool it's on), its
 * context %, model and effort, and where it is in the list ("3/10"), with a bar for the context.
 */
export function sessionsStrip(s: SessionView | null, index: number, count: number, isTarget: boolean): SessionsStrip {
	if (!s) {
		return {
			name: { value: "No sessions", color: STRIP_COLORS.none },
			mark: { value: "" },
			status: { value: "", color: STRIP_COLORS.none },
			ctx: { value: "" },
			meta: { value: "" },
			pos: { value: "0/0", color: STRIP_COLORS.pos },
			bar: { value: 0, opacity: 0 },
		};
	}
	const ctx = s.context === null ? null : Math.max(0, Math.min(100, Math.round(s.context)));
	return {
		name: { value: s.title, color: STRIP_COLORS.name },
		mark: { value: isTarget ? "●" : "", color: STRIP_COLORS.target },
		status: { value: statusLine(s.status, s.doing), color: STATUS_COLORS[s.status] },
		ctx: { value: ctx === null ? "" : `${ctx}%`, color: STRIP_COLORS.ctx },
		meta: { value: modelAndEffort(s.model, s.effort), color: STRIP_COLORS.meta },
		pos: { value: `${index + 1}/${count}`, color: STRIP_COLORS.pos },
		bar: { value: ctx ?? 0, opacity: ctx === null ? 0 : 1, bar_fill_c: ctx !== null && ctx >= CONTEXT_HIGH ? STRIP_COLORS.full : STRIP_COLORS.fill },
	};
}
