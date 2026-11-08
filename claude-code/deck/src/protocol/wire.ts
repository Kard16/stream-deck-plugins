import { cutSummary } from "./fingerprint.js";

/**
 * The bridge protocol's wire shapes (claude-code/protocol/PROTOCOL.md, version 1): routes, the hook's answers,
 * and tolerant readers for what the plugin sends. Unknown fields are ignored, and a field of the wrong type
 * reads as missing, so either side can add fields without a version bump.
 */

export const PROTOCOL_VERSION = 1;

export const ROUTES = {
	permission: "/v1/permission",
	hello: "/v1/hello",
	events: "/v1/events",
	next: "/v1/next",
	result: "/v1/result",
} as const;

/**
 * The hook's answers (PROTOCOL.md, Permission requests): Allow, Deny and no decision. Every answer is exactly one of
 * these three: the deck never sends `updatedInput` or `updatedPermissions` (Phase 9).
 */
export const ALLOW_DECISION = {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
} as const;
export const DENY_MESSAGE = "Denied from the Stream Deck.";
/** Like the app's own No: the turn stops (S2). Claude gets the standard rejection text, not the message. */
export const DENY_DECISION = {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: DENY_MESSAGE, interrupt: true } },
} as const;
/** No decision: the app's own dialog decides. Typed so that no object with a field fits it. */
export const NO_DECISION: Readonly<Record<string, never>> = {};
/** The only bodies a held request is ever answered with: a body with any other field doesn't type-check. */
export type HookAnswer = typeof ALLOW_DECISION | typeof DENY_DECISION | typeof NO_DECISION;

/** The two tools that need the person: Claude Code ignores a plain Allow for them (the engine check, 2026-11-04). */
export const ASK_QUESTION = "AskUserQuestion";
export const EXIT_PLAN = "ExitPlanMode";

/**
 * Kind `ask`: the deck never answers these (Phase 9, at the user's word). The Approve and Deny keys and the session's
 * Session Slot dial read "Answer in app", and a press on any of them jumps to the session (PROTOCOL.md, Permission
 * requests).
 */
export const ASK_TOOLS: ReadonlySet<string> = new Set([ASK_QUESTION, EXIT_PLAN]);

/**
 * The app's `local_…` ids, as its own `claude://code/continue` route accepts them (S5). Anything else, an
 * uninterpolated `$CLAUDE_CODE_HOST_SESSION_ID` in the hook's header say, counts as no host.
 */
export const HOST_PATTERN = /^local_[A-Za-z0-9-]{1,64}$/;

export function asHost(v: unknown): string | null {
	return typeof v === "string" && HOST_PATTERN.test(v) ? v : null;
}

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string, cut to `max` characters; anything else is null. */
export function text(v: unknown, max = 200): string | null {
	if (typeof v !== "string" || v === "") return null;
	return v.length > max ? `${v.slice(0, max)}…` : v;
}

function finite(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** How a mod request names its session: in the body, or in the query for `GET /v1/next`. */
export type ModRef = { sid: string | null; host: string | null; inst: string | null };

export function modRef(o: Obj): ModRef {
	return { sid: text(o.sid), host: asHost(o.host), inst: text(o.inst) };
}

/** What the bridge reads from a PermissionRequest hook's body: a hook's request, and the session's settings. */
export type PermissionRequest = HookRequest & {
	/** `permission_mode` and `effort.level`, the session's settings when the request was made. */
	mode: string | null;
	effort: string | null;
	/**
	 * `agent_id`, there only for another loop's request than the main one's, the same id as that loop's events' `agent`;
	 * null for anything but a non-empty string, as for an event's `agent` (PROTOCOL.md, Permission requests).
	 */
	agent: string | null;
};

/** Null when the body isn't an object with a `tool_name`. */
export function parsePermission(body: unknown): PermissionRequest | null {
	const hook = parseHook(body);
	if (!hook || !isObj(body)) return null;
	// `effort` is `{level}` in 2.1.309's hook input; a plain string is read too.
	const effort = isObj(body.effort) ? text(body.effort.level, 40) : text(body.effort, 40);
	return { ...hook, mode: text(body.permission_mode, 40), effort, agent: text(body.agent_id) };
}

/** What the bridge reads from the hook's body: the session it says it's from, the tool and its input. */
export type HookRequest = {
	/** `session_id`: Claude Code's id for the session the request comes from. */
	sid: string | null;
	tool: string;
	/** `tool_input`; a request without one fingerprints as `{}`. */
	input: unknown;
};

/** Null when the body isn't an object with a `tool_name`. */
export function parseHook(body: unknown): HookRequest | null {
	if (!isObj(body)) return null;
	const tool = typeof body.tool_name === "string" && body.tool_name !== "" ? body.tool_name : null;
	if (tool === null) return null;
	return { sid: text(body.session_id), tool, input: body.tool_input ?? {} };
}

export type Hello = ModRef & {
	v: unknown;
	cwd: string | null;
	model: string | null;
	mode: string | null;
	effort: string | null;
	plugin: string | null;
	cc: string | null;
};

export function parseHello(o: Obj): Hello {
	return {
		...modRef(o),
		v: o.v,
		cwd: text(o.cwd, 1000),
		model: text(o.model, 80),
		mode: text(o.mode, 40),
		effort: text(o.effort, 40),
		plugin: text(o.plugin, 40),
		cc: text(o.cc, 40),
	};
}

/** The events the deck reads (PROTOCOL.md, Events). Others are ignored. */
export type ModEvent =
	| { t: "turn.start"; turn: string | null; agent: string | null }
	| { t: "turn.end"; turn: string | null; agent: string | null; reason: string | null }
	| { t: "failed"; agent: string | null; error: string | null }
	| { t: "tool.start"; tool: string; use: string | null; agent: string | null; summary: string; fp: string | null }
	| { t: "tool.end"; tool: string | null; use: string | null; agent: string | null; fp: string | null; ok: boolean | null }
	/** `context: {percent?, tokens?, window}` and `cost?: {usd}`; a figure that's missing or not a number is null. */
	| { t: "measure"; percent: number | null; tokens: number | null; window: number | null; usd: number | null }
	| { t: "settings"; model: string | null; mode: string | null; effort: string | null }
	| { t: "attach" | "detach"; surface: string | null }
	| { t: "end"; reason: string | null }
	| { t: "threads"; threads: Threads };

/** The kinds of loop a session runs beside its main one (PROTOCOL.md, Events: threads). */
export const AGENT_KINDS = ["workflow", "teammate", "fork", "background", "subagent", "other"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** One of the session's other loops in a turn: its kind, description and latest tool call. A workflow agent's `run` isn't kept. */
export type ThreadAgent = { kind: AgentKind; desc: string; doing: string };
/** A workflow run: its agents started, ended, ended failing, and in a turn now. */
export type ThreadRun = { run: string; name: string; started: number; finished: number; failed: number; open: number };
/** A `threads` snapshot: how many other loops are in a turn, some of them, the most recent first, and some runs. */
export type Threads = { running: number; agents: ThreadAgent[]; runs: ThreadRun[] };

/** What a snapshot keeps at most (PROTOCOL.md, Events: threads). */
export const MAX_THREAD_AGENTS = 8;
export const MAX_THREAD_RUNS = 3;
const MAX_THREAD_TEXT = 60;

/** A whole number from 0, else 0: `running` and a run's counts. */
function count(v: unknown): number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** A string cut to MAX_THREAD_TEXT, its last character an ellipsis; anything else is "". */
function threadText(v: unknown): string {
	if (typeof v !== "string") return "";
	return v.length > MAX_THREAD_TEXT ? `${v.slice(0, MAX_THREAD_TEXT - 1)}…` : v;
}

/** The objects of an array, at most `max` of them; anything that isn't an array has none (PROTOCOL.md: "taken with care"). */
function objects(v: unknown, max: number): Obj[] {
	return (Array.isArray(v) ? v : []).filter(isObj).slice(0, max);
}

function parseThreads(e: Obj): Threads {
	const kinds: readonly string[] = AGENT_KINDS;
	return {
		running: count(e.running),
		agents: objects(e.agents, MAX_THREAD_AGENTS).map((a) => ({
			kind: typeof a.kind === "string" && kinds.includes(a.kind) ? (a.kind as AgentKind) : "other",
			desc: threadText(a.desc),
			doing: threadText(a.doing),
		})),
		runs: objects(e.runs, MAX_THREAD_RUNS).map((r) => ({
			run: threadText(r.run),
			// On one line, as the log's THREADS lines name it; else the mod's own name for a run no Workflow result named
			// (PROTOCOL.md, Events: threads).
			name: threadText(r.name).replace(/\s+/g, " ").trim() || "workflow",
			started: count(r.started),
			finished: count(r.finished),
			failed: count(r.failed),
			open: count(r.open),
		})),
	};
}

export function parseEvent(e: unknown): ModEvent | null {
	if (!isObj(e) || typeof e.t !== "string") return null;
	const agent = text(e.agent);
	switch (e.t) {
		case "turn.start":
			return { t: "turn.start", turn: text(e.turn), agent };
		case "turn.end":
			return { t: "turn.end", turn: text(e.turn), agent, reason: text(e.reason, 40) };
		case "failed":
			return { t: "failed", agent, error: text(e.error) };
		case "tool.start": {
			const tool = text(e.tool, 200);
			if (tool === null) return null;
			// The mod computes the summary; a longer one than the protocol allows is cut here too.
			const s = text(e.summary, 1000);
			return { t: "tool.start", tool, use: text(e.use), agent, summary: cutSummary(s ?? tool), fp: text(e.fp, 16) };
		}
		case "tool.end":
			return { t: "tool.end", tool: text(e.tool, 200), use: text(e.use), agent, fp: text(e.fp, 16), ok: typeof e.ok === "boolean" ? e.ok : null };
		case "measure": {
			const context = isObj(e.context) ? e.context : {};
			return { t: "measure", percent: finite(context.percent), tokens: finite(context.tokens), window: finite(context.window), usd: isObj(e.cost) ? finite(e.cost.usd) : null };
		}
		case "settings":
			return { t: "settings", model: text(e.model, 80), mode: text(e.mode, 40), effort: text(e.effort, 40) };
		case "attach":
		case "detach":
			return { t: e.t, surface: text(e.surface, 40) };
		case "end":
			return { t: "end", reason: text(e.reason, 80) };
		case "threads":
			return { t: "threads", threads: parseThreads(e) };
		default:
			return null;
	}
}

export type Result = ModRef & { id: string | null; state: string | null; error: string | null };

export function parseResult(o: Obj): Result {
	return { ...modRef(o), id: text(o.id, 40), state: text(o.state, 20), error: text(o.error, 300) };
}

/** The long poll's longest and default wait, in seconds. */
export const MAX_WAIT_S = 20;

export type Poll = ModRef & { wait: number };

/** `GET /v1/next?sid=&host=&inst=&wait=`: wait is 0–20 s, 20 when missing or not a number. */
export function parsePoll(params: URLSearchParams): Poll {
	const raw = params.get("wait");
	const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
	const wait = Number.isFinite(n) ? Math.min(MAX_WAIT_S, Math.max(0, n)) : MAX_WAIT_S;
	return { sid: text(params.get("sid")), host: asHost(params.get("host")), inst: text(params.get("inst")), wait };
}

/** A command as `GET /v1/next` sends it. */
export type CommandWire = { id: string; t: "prompt"; text: string };
