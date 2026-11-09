/**
 * A session's status on the deck (PROTOCOL.md, "The deck's session model"), the first that applies:
 * approval, needs-you, background or working, failed, interrupted, needs-you (the app's own needs-input indicator),
 * done, idle; and background in place of done or idle while its threads are unfinished (rule 9).
 */
export type SessionStatus = "approval" | "needs-you" | "background" | "working" | "failed" | "interrupted" | "done" | "idle";

/** What the status is worked out from. Times are this Mac's wall clock, in ms. */
export type StatusInput = {
	/** Held requests of each kind for the session. */
	heldTool: number;
	heldAsk: number;
	/** The registry's `status`: `idle`, `busy`, `waiting`, or null when the field is missing. */
	registry: string | null;
	/** The registry's `statusUpdatedAt`, when that status began; null when the field is missing. */
	statusUpdatedAt: number | null;
	/**
	 * When the deck first read that status: the first reading that showed it since one showed another, or the
	 * session's first reading. It stands in for a missing `statusUpdatedAt`.
	 */
	firstReadingAt: number | null;
	/**
	 * The main loop's last turn, as the mod reported it; null when the deck saw none. A subagent's never counts.
	 * `startedAt` is when the deck got its `turn.start`, null when it didn't; `endedAt` when it got its `turn.end`,
	 * null until then. `ended` covers a `failed` too, which ends the main loop's turn as a `turn.end` does.
	 */
	turn: { ended: boolean; reason: string | null; failed: boolean; startedAt: number | null; endedAt: number | null } | null;
	/**
	 * The category of the last turn as the app's needs-input indicator reads it from the app's record; null when the
	 * indicator ignores the record, or there's none (turnCategory, src/records/records.ts).
	 */
	recordCategory: string | null;
	/** How many loops other than the main one are in a turn, by the latest `threads` the deck keeps; 0 without one. */
	running: number;
	/** The app's record holds an offer card waiting for the user's answer (AppRecord's `offer`), which holds the turn. */
	offer?: boolean;
	/**
	 * How many of the session's threads, the sessions it started (AppRecord's `parent`), are unfinished: working, in the
	 * background, or waiting on the user (UNFINISHED). 0 without any.
	 */
	sides?: number;
};

/** A thread's statuses while it's unfinished, which keep the session that started it in the background. */
export const UNFINISHED: ReadonlySet<SessionStatus> = new Set(["approval", "needs-you", "background", "working"]);

export function sessionStatus(i: StatusInput): SessionStatus {
	return sessionState(i).status;
}

/**
 * Which rule a status came from, so the session view can say when it began (`since`) and what the session waits on:
 * - `held-tool`, `held-ask`: rules 1 and 2, a held request;
 * - `waiting`: rule 2, the registry's `waiting` with nothing held; `offer`: rule 2, an offer card waiting in the app;
 * - `background`: rule 3, other loops in a turn while the main loop isn't;
 * - `busy`: rule 3, the registry's `busy`; `started`: rule 3, the main loop's `turn.start` before the registry says so;
 * - `failed`, `interrupted`: rules 4 and 5; `record`: rule 6, the app's own needs-input indicator; `done`: rule 7;
 * - `idle`: rule 8;
 * - `sides`: rule 9, unfinished threads, in place of `done` or `idle`.
 */
export type StatusSource = "held-tool" | "held-ask" | "waiting" | "offer" | "background" | "busy" | "started" | "failed" | "interrupted" | "record" | "done" | "idle" | "sides";

export type SessionState = { status: SessionStatus; from: StatusSource };

/**
 * The status (PROTOCOL.md's order, the first that applies) and the rule it came from. Rule 9 comes last: a session
 * whose threads are unfinished reads background where it would read done or idle, so what it says of itself comes
 * first, a turn that failed or asks for the user included (PROTOCOL.md's 2026-11-08 amendment).
 */
export function sessionState(i: StatusInput): SessionState {
	const own = ownState(i);
	if ((i.sides ?? 0) > 0 && (own.status === "done" || own.status === "idle")) return { status: "background", from: "sides" };
	return own;
}

/** Rules 1 to 8: the session's status by what it does itself. */
function ownState(i: StatusInput): SessionState {
	if (i.heldTool > 0) return { status: "approval", from: "held-tool" };
	if (i.heldAsk > 0) return { status: "needs-you", from: "held-ask" };
	// Nothing is held here: a session without the plugin, or a request lost when the deck restarted.
	if (i.registry === "waiting") return { status: "needs-you", from: "waiting" };
	// The session's start_session call waits for the user to answer its card: a new session, or here. The registry still
	// says busy, since the call is still running.
	if (i.offer === true) return { status: "needs-you", from: "offer" };
	// Other loops are in a turn and the main loop isn't, whatever the registry says: they keep it busy, and an idle
	// while they're counted is a reading that trails (PROTOCOL.md, status rule 3). The main loop isn't in a turn once its
	// latest turn.start has an end, or when the deck has seen none.
	if (i.running > 0 && (i.turn === null || i.turn.ended)) return { status: "background", from: "background" };
	// A `busy` from before the main loop's turn ended with `aborted` doesn't count, and the rules below take the
	// session as idle.
	const staleBusy = i.registry === "busy" && beganBeforeAbort(i);
	if (i.registry === "busy" && !staleBusy) return { status: "working", from: "busy" };
	// The main loop's turn has started, and the registry's reading still shows the idle from before it.
	if (i.registry === "idle" && idleBeforeStart(i)) return { status: "working", from: "started" };
	if (i.registry === "idle" || staleBusy) {
		if (i.turn?.failed) return { status: "failed", from: "failed" };
		if (i.turn?.ended && i.turn.reason === "aborted") return { status: "interrupted", from: "interrupted" };
		// The app's own needs-input indicator (its `_D`) shows for a turn that's blocked or needs input.
		if (i.recordCategory === "blocked" || i.recordCategory === "need_input") return { status: "needs-you", from: "record" };
		if (i.turn?.ended) return { status: "done", from: "done" };
	}
	return { status: "idle", from: "idle" };
}

/**
 * Whether the registry's status began at or before the moment the deck got the main loop's last `turn.end`, with
 * reason `aborted`: by its `statusUpdatedAt`, else by the deck's first reading of it. After a turn, Claude Code
 * keeps the session `busy` until a moment when the mod has no request open (PROTOCOL.md, Commands), and the deck
 * reads the registry a moment after it changes, while the mod's `turn.end` comes within milliseconds (Phase 4).
 */
function beganBeforeAbort(i: StatusInput): boolean {
	const abortedAt = i.turn?.ended && i.turn.reason === "aborted" ? i.turn.endedAt : null;
	const began = i.statusUpdatedAt ?? i.firstReadingAt;
	return abortedAt !== null && began !== null && began <= abortedAt;
}

/**
 * Whether the main loop's latest `turn.start` has no `turn.end` (nor `failed`) yet, and the registry's status, an
 * `idle` here, began at or before the moment the deck got that `turn.start`: by its `statusUpdatedAt`, else by the
 * deck's first reading of it, as for the `busy` above. The plugin's `turn.start` arrives within milliseconds, while
 * the deck reads the registry a moment after it changes and Claude Code writes `busy` a moment into the turn. An
 * `idle` that began later means the turn ended unseen, and doesn't count (PROTOCOL.md, status rule 3).
 */
function idleBeforeStart(i: StatusInput): boolean {
	const startedAt = i.turn !== null && !i.turn.ended ? i.turn.startedAt : null;
	const began = i.statusUpdatedAt ?? i.firstReadingAt;
	return startedAt !== null && began !== null && began <= startedAt;
}
