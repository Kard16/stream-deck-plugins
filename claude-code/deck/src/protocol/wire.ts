import { cutSummary } from "./fingerprint.js";

/**
 * The bridge protocol's wire shapes (claude-code/protocol/PROTOCOL.md, version 1): routes, the hook's answers,
 * and tolerant readers for what the plugin sends. Unknown fields are ignored, and a field of the wrong type
 * reads as missing, so either side can add fields without a version bump.
 */

export const PROTOCOL_VERSION = 1;

export const ROUTES = {
	permission: "/v1/permission",
	pretool: "/v1/pretool",
	hello: "/v1/hello",
	events: "/v1/events",
	next: "/v1/next",
	result: "/v1/result",
} as const;

/** The hook's answers (PROTOCOL.md, Permission requests). The deck never sends updatedPermissions or updatedInput. */
export const ALLOW_DECISION = {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
} as const;
export const DENY_MESSAGE = "Denied from the Stream Deck.";
/** Like the app's own No: the turn stops (S2). Claude gets the standard rejection text, not the message. */
export const DENY_DECISION = {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: DENY_MESSAGE, interrupt: true } },
} as const;
/** No decision: the app's own dialog decides. For a mode check, the session's own permission check decides. */
export const NO_DECISION = {} as const;

/**
 * The mode check's allow (PROTOCOL.md, Mode checks): the PreToolUse hook's answer that lets the deck's own mode
 * change past the session's permission check, the auto-mode classifier included. The only other answer is `{}`.
 */
export const PRETOOL_ALLOW = {
	hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "The mode change pressed on the Stream Deck." },
} as const;

/**
 * The app's mode tool, as a PermissionRequest and a mode check name it. The deck's own mode commands call it: the
 * mode hook asks first, and a raise brings up a PermissionRequest for it (S4).
 */
export const MODE_TOOL = "mcp__ccd_session_mgmt__set_session_permission_mode";

/** Requests the deck shows but never answers: a press jumps to the session (kickoff answer 3). */
export const ASK_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** The modes the deck sets, in the order the Mode dial offers them. Never bypassPermissions. */
export const MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export type Mode = (typeof MODES)[number];

export function isMode(v: unknown): v is Mode {
	return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

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
};

/** Null when the body isn't an object with a `tool_name`. */
export function parsePermission(body: unknown): PermissionRequest | null {
	const hook = parseHook(body);
	if (!hook || !isObj(body)) return null;
	// `effort` is `{level}` in 2.1.309's hook input; a plain string is read too.
	const effort = isObj(body.effort) ? text(body.effort.level, 40) : text(body.effort, 40);
	return { ...hook, mode: text(body.permission_mode, 40), effort };
}

/**
 * What the bridge reads from either hook's body: the session it says it's from, the tool and its input. A mode
 * check's body is a PreToolUse's, of which the bridge reads no more (PROTOCOL.md, Mode checks).
 */
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
	| { t: "measure"; percent: number | null }
	| { t: "settings"; model: string | null; mode: string | null; effort: string | null }
	| { t: "attach" | "detach"; surface: string | null }
	| { t: "end"; reason: string | null };

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
		case "measure":
			return { t: "measure", percent: isObj(e.context) ? finite(e.context.percent) : null };
		case "settings":
			return { t: "settings", model: text(e.model, 80), mode: text(e.mode, 40), effort: text(e.effort, 40) };
		case "attach":
		case "detach":
			return { t: e.t, surface: text(e.surface, 40) };
		case "end":
			return { t: "end", reason: text(e.reason, 80) };
		default:
			return null;
	}
}

export type Result = ModRef & { id: string | null; state: string | null; error: string | null; detail: string | null };

export function parseResult(o: Obj): Result {
	return { ...modRef(o), id: text(o.id, 40), state: text(o.state, 20), error: text(o.error, 300), detail: text(o.detail, 300) };
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
export type CommandWire = { id: string; t: "prompt"; text: string } | { id: string; t: "mode"; mode: Mode };
