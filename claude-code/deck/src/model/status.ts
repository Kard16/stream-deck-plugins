/**
 * A session's status on the deck (PROTOCOL.md, "The deck's session model"), the first that applies:
 * approval, needs-you, working, failed, interrupted, needs-you (the app's own needs-input indicator), done, idle.
 */
export type SessionStatus = "approval" | "needs-you" | "working" | "failed" | "interrupted" | "done" | "idle";

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
};

export function sessionStatus(i: StatusInput): SessionStatus {
	if (i.heldTool > 0) return "approval";
	if (i.heldAsk > 0) return "needs-you";
	// Nothing is held here: a session without the plugin, or a request lost when the deck restarted.
	if (i.registry === "waiting") return "needs-you";
	// A `busy` from before the main loop's turn ended with `aborted` doesn't count, and the rules below take the
	// session as idle.
	const staleBusy = i.registry === "busy" && beganBeforeAbort(i);
	if (i.registry === "busy" && !staleBusy) return "working";
	// The main loop's turn has started, and the registry's reading still shows the idle from before it.
	if (i.registry === "idle" && idleBeforeStart(i)) return "working";
	if (i.registry === "idle" || staleBusy) {
		if (i.turn?.failed) return "failed";
		if (i.turn?.ended && i.turn.reason === "aborted") return "interrupted";
		// The app's own needs-input indicator (its `_D`) shows for a turn that's blocked or needs input.
		if (i.recordCategory === "blocked" || i.recordCategory === "need_input") return "needs-you";
		if (i.turn?.ended) return "done";
	}
	return "idle";
}

/**
 * Whether the registry's status began at or before the moment the deck got the main loop's last `turn.end`, with
 * reason `aborted`: by its `statusUpdatedAt`, else by the deck's first reading of it. After a turn, Claude Code
 * keeps the session `busy` until a moment when the mod has no request open (PROTOCOL.md, Commands), and the deck
 * reads the registry once a second, while the mod's `turn.end` comes within milliseconds (Phase 4).
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
 * the deck reads the registry once a second and Claude Code writes `busy` a moment into the turn. An `idle` that
 * began later means the turn ended unseen, and doesn't count (PROTOCOL.md, status rule 3).
 */
function idleBeforeStart(i: StatusInput): boolean {
	const startedAt = i.turn !== null && !i.turn.ended ? i.turn.startedAt : null;
	const began = i.statusUpdatedAt ?? i.firstReadingAt;
	return startedAt !== null && began !== null && began <= startedAt;
}
