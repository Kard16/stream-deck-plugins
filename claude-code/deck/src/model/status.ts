/**
 * A session's status on the deck (PROTOCOL.md, "The deck's session model"), the first that applies:
 * approval, needs-you, working, failed, interrupted, needs-you (from the app's record), done, idle.
 */
export type SessionStatus = "approval" | "needs-you" | "working" | "failed" | "interrupted" | "done" | "idle";

/** What the status is worked out from. */
export type StatusInput = {
	/** Held requests of each kind for the session. */
	heldTool: number;
	heldAsk: number;
	/** The registry's `status`: `idle`, `busy`, `waiting`, or null when the field is missing. */
	registry: string | null;
	/** The main loop's last turn, as the mod reported it; null when the deck saw none. */
	turn: { ended: boolean; reason: string | null; failed: boolean } | null;
	/** The app's record says the last turn needs the user. */
	recordNeedsUser: boolean;
};

export function sessionStatus(i: StatusInput): SessionStatus {
	if (i.heldTool > 0) return "approval";
	if (i.heldAsk > 0) return "needs-you";
	// Nothing is held here: a session without the plugin, or a request lost when the deck restarted.
	if (i.registry === "waiting") return "needs-you";
	if (i.registry === "busy") return "working";
	if (i.registry === "idle") {
		if (i.turn?.failed) return "failed";
		if (i.turn?.ended && i.turn.reason === "aborted") return "interrupted";
		if (i.recordNeedsUser) return "needs-you";
		if (i.turn?.ended) return "done";
	}
	return "idle";
}
