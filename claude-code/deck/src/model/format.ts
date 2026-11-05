import type { SessionStatus } from "./status.js";

/** The app's names for the modes, as its own picker shows them. */
const MODE_NAMES: Record<string, string> = {
	default: "Manual",
	acceptEdits: "Accept edits",
	plan: "Plan",
	auto: "Auto",
	bypassPermissions: "Bypass",
	dontAsk: "Don't ask",
};

/** `acceptEdits` → "Accept edits". An unknown mode shows as it is; none shows as "—". */
export function modeName(mode: string | null | undefined): string {
	if (!mode) return "—";
	return MODE_NAMES[mode] ?? mode;
}

/**
 * A model id as the app's menus name it: `claude-haiku-5-5` → "Haiku 5.5", `claude-opus-4-7[1m]` →
 * "Opus 4.7 1M". The `/config` aliases (`opus`, `sonnet`…) are capitalised; anything else shows as it is.
 */
export function modelName(model: string | null | undefined): string {
	if (!model) return "—";
	const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(model);
	if (m) {
		const family = m[1] ?? "";
		const version = m[3] === undefined ? (m[2] ?? "") : `${m[2]}.${m[3]}`;
		return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}${m[4] ? " 1M" : ""}`;
	}
	if (/^[a-z]+$/.test(model)) return `${model.charAt(0).toUpperCase()}${model.slice(1)}`;
	return model;
}

/** Effort levels show as the app writes them (low … max); none shows as "—". */
export function effortName(effort: string | null | undefined): string {
	return effort ? effort : "—";
}

/** "Haiku 5.5 · low", for the strips. */
export function modelAndEffort(model: string | null, effort: string | null): string {
	return `${modelName(model)} · ${effortName(effort)}`;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
	approval: "approval",
	"needs-you": "needs you",
	working: "working",
	failed: "failed",
	interrupted: "interrupted",
	done: "done",
	idle: "idle",
};

export function statusLabel(status: SessionStatus): string {
	return STATUS_LABELS[status];
}

/** Status colours, shared by the strips and the keys. */
export const STATUS_COLORS: Record<SessionStatus, string> = {
	approval: "#F2994A",
	"needs-you": "#F2C94C",
	working: "#4A9EFF",
	failed: "#EB5757",
	interrupted: "#E0A43A",
	done: "#6FCF8E",
	idle: "#A7ADB8",
};

/** The colour for a session that has ended (a picked target whose registry file went). */
export const ENDED_COLOR = "#6A707A";

/** "working: notes.md" while a tool runs, else the status alone. */
export function statusLine(status: SessionStatus, doing: string | null): string {
	return status === "working" && doing ? `working: ${doing}` : statusLabel(status);
}

/**
 * How long ago `since` was, as the keys and strips show it: `30s`, `4m`, `2h`, `3d`, each rounded down
 * (session-keys.md, What each session shows). Both are wall-clock ms. Null when `since` is unknown; a `since` ahead
 * of `now`, as after the clock moved back, reads `0s`.
 */
export function sinceText(since: number | null, now: number): string | null {
	if (since === null || !Number.isFinite(since) || !Number.isFinite(now)) return null;
	const s = Math.max(0, Math.floor((now - since) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** A token count, short: 950, 1.5k, 620k, 1M, 1.2M. */
export function tokenCount(n: number): string {
	const v = Math.max(0, n);
	if (v < 1000) return String(Math.round(v));
	if (v < 10_000) return `${trimZero((v / 1000).toFixed(1))}k`;
	if (v < 999_500) return `${Math.round(v / 1000)}k`;
	return `${trimZero((v / 1_000_000).toFixed(1))}M`;
}

function trimZero(text: string): string {
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** `620k of 1M tokens`, `620k tokens` without a window; null until the engine has a count. */
export function tokensText(tokens: number | null, window: number | null): string | null {
	if (tokens === null) return null;
	return window === null || window <= 0 ? `${tokenCount(tokens)} tokens` : `${tokenCount(tokens)} of ${tokenCount(window)} tokens`;
}

/** `$1.24`; null without a cost. */
export function costText(usd: number | null): string | null {
	return usd === null || !Number.isFinite(usd) ? null : `$${Math.max(0, usd).toFixed(2)}`;
}

/** The project a session works in: the last segment of its `cwd`, trailing slashes aside; null without one. */
export function projectName(cwd: string | null | undefined): string | null {
	if (!cwd) return null;
	const segments = cwd.split("/").filter((s) => s !== "");
	return segments.at(-1) ?? null;
}
