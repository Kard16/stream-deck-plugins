import path from "node:path";

import type { RegistrySession } from "../registry/registry.js";

/** Colours for layouts/sessions.json's keys. The defaults match the layout's own. */
export const STRIP_COLORS = {
	name: "#F2F2F2",
	pos: "#8A8F99",
	busy: "#E0A43A",
	idle: "#6FCF8E",
	other: "#C9CDD4",
	none: "#6A707A",
} as const;

export type StripItem = { value: string; color: string };
/**
 * The layout's three keys, all ours: none is the reserved `title` or `icon`, which a user's own title or icon
 * would override.
 */
export type SessionsStrip = { name: StripItem; status: StripItem; pos: StripItem };

/** The longest name sent; the layout cuts it to fit with an ellipsis. */
const MAX_NAME = 120;

/** The sidebar title; without one, the folder's name; without that, the pid. */
export function displayName(s: RegistrySession): string {
	const name = s.name?.trim();
	if (name) return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}…` : name;
	const folder = s.cwd ? path.basename(s.cwd) : "";
	return folder !== "" ? folder : `Session ${s.key}`;
}

/** The status as the registry has it, coloured for the two values seen so far. Missing reads "unknown". */
export function statusItem(status: string | null): StripItem {
	if (status === null || status.trim() === "") return { value: "unknown", color: STRIP_COLORS.none };
	const value = status.length > 40 ? `${status.slice(0, 40)}…` : status;
	const color = status === "busy" ? STRIP_COLORS.busy : status === "idle" ? STRIP_COLORS.idle : STRIP_COLORS.other;
	return { value, color };
}

/** One session on the strip: its title, its status, and where it is in the list ("3/10"). */
export function sessionsStrip(sessions: readonly RegistrySession[], index: number): SessionsStrip {
	const s = sessions[index];
	if (!s) {
		return {
			name: { value: "No sessions", color: STRIP_COLORS.none },
			status: { value: "", color: STRIP_COLORS.none },
			pos: { value: "0/0", color: STRIP_COLORS.pos },
		};
	}
	return {
		name: { value: displayName(s), color: STRIP_COLORS.name },
		status: statusItem(s.status),
		pos: { value: `${index + 1}/${sessions.length}`, color: STRIP_COLORS.pos },
	};
}
