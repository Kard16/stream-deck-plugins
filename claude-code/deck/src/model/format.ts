import type { ThreadAgent, ThreadRun, Threads } from "../protocol/wire.js";
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

/** Status colours, for the slot strips' Now page. Background is blue like working (agents-and-wake.md, B2). */
export const STATUS_COLORS: Record<SessionStatus, string> = {
	approval: "#F2994A",
	"needs-you": "#F2C94C",
	background: "#4A9EFF",
	working: "#4A9EFF",
	failed: "#EB5757",
	interrupted: "#E0A43A",
	done: "#6FCF8E",
	idle: "#A7ADB8",
};

/** The colour for a slotted session that isn't running: its process has stopped. */
export const ENDED_COLOR = "#6A707A";

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

/**
 * When sinceText(since, ·) next reads differently after `now`, in wall-clock ms: at the next whole second after `since`
 * while it shows seconds, the next whole minute while it shows minutes, and so on; while `since` is ahead of `now`
 * (`0s`), a second after `since`. Always later than `now`. Null when `since` is unknown, whose text never changes. The
 * slot keys, slot dials and Others repaint then, and not before (hardening.md, B6).
 */
export function sinceChangesAt(since: number | null, now: number): number | null {
	if (since === null || !Number.isFinite(since) || !Number.isFinite(now)) return null;
	const elapsed = now - since;
	const unit = elapsed < 60_000 ? 1000 : elapsed < 3_600_000 ? 60_000 : elapsed < 86_400_000 ? 3_600_000 : 86_400_000;
	return since + (Math.max(0, Math.floor(elapsed / unit)) + 1) * unit;
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

/** Text whose last `keep` characters stay whole when it's cut to fit (keys/art.ts's clipKeep): a run's counts. */
export type Label = { text: string; keep: number };

/** A workflow run as the keys and the log name it: `review 5/9`, its agents ended of those started. */
export function runLabel(run: ThreadRun): string {
	return `${run.name} ${run.finished}/${run.started}`;
}

/**
 * The run the key and the strip follow: the most recent with a loop in a turn, which the mod lists before the rest,
 * the most recent first (PROTOCOL.md, Events: threads); null with none, and while no loop is in a turn at all.
 */
export function activeRun(t: Threads | null): ThreadRun | null {
	if (t === null || t.running <= 0) return null;
	return t.runs.find((r) => r.open > 0) ?? null;
}

/**
 * What a session's other loops are at, on the key's bottom line and the strip's Now page (agents-and-wake.md, B2): the
 * run they follow (activeRun) as `review 5/9`, its counts kept whole when it's cut; else `3 agents` (`1 agent`) while
 * any is in a turn; null with none.
 */
export function threadsLabel(t: Threads | null): Label | null {
	const run = activeRun(t);
	if (run !== null) return { text: runLabel(run), keep: ` ${run.finished}/${run.started}`.length };
	if (t === null || t.running <= 0) return null;
	return { text: t.running === 1 ? "1 agent" : `${t.running} agents`, keep: 0 };
}

/** How many Agents pages the strip has at most, and how many running agents each lists (agents-and-wake.md, B2). */
export const MAX_AGENT_PAGES = 3;
const AGENTS_A_PAGE = 2;

/**
 * The first line of each Agents page (agents-and-wake.md, B2): the run they follow as `review · 5/9 done`, or
 * `review · 5/9, 1 failed` when some failed, the counts kept whole and the name cut when it's too long; else
 * `3 agents running` (`1 agent running`).
 */
export function agentsHead(t: Threads): Label {
	const run = activeRun(t);
	if (run === null) return { text: `${t.running} agent${t.running === 1 ? "" : "s"} running`, keep: 0 };
	const counts = ` · ${run.finished}/${run.started}${run.failed > 0 ? `, ${run.failed} failed` : " done"}`;
	return { text: `${run.name}${counts}`, keep: counts.length };
}

/** A running agent on an Agents page: `● logs: Grep: Device`, the kind without a description, nothing after none doing. */
function agentLine(a: ThreadAgent): string {
	return `● ${a.desc || a.kind}${a.doing ? `: ${a.doing}` : ""}`;
}

/**
 * The lines of the strip's Agents pages, two running agents a page, while other loops are in a turn; none while none
 * is. At most MAX_AGENT_PAGES: when more are running than fit, the last line says `+<n> more`. `running` counts them
 * all, and only the snapshot's agents can be listed, so those it leaves out count among the more too.
 */
export function agentPages(t: Threads | null): string[][] {
	if (t === null || t.running <= 0) return [];
	const room = MAX_AGENT_PAGES * AGENTS_A_PAGE;
	const all = Math.max(t.running, t.agents.length);
	const listed = t.agents.slice(0, all > room ? room - 1 : room).map(agentLine);
	const lines = all > listed.length ? [...listed, `+${all - listed.length} more`] : listed;
	const pages: string[][] = [];
	for (let i = 0; i < lines.length; i += AGENTS_A_PAGE) pages.push(lines.slice(i, i + AGENTS_A_PAGE));
	return pages;
}

/** The project a session works in: the last segment of its `cwd`, trailing slashes aside; null without one. */
export function projectName(cwd: string | null | undefined): string | null {
	if (!cwd) return null;
	const segments = cwd.split("/").filter((s) => s !== "");
	return segments.at(-1) ?? null;
}
