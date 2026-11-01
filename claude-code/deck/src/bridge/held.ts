/** The answer the Approve key gives: Claude Code's PermissionRequest hook output for "allow". */
export const ALLOW_DECISION = {
	hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
} as const;

/** A request the bridge is holding until a key press answers it or its client goes away. */
export type HeldRequest = {
	/** 1, 2, 3… in arrival order, for the log and for knowing which request a key showed. */
	id: number;
	/** Date.now() when it was held. */
	at: number;
	/** `tool_name` from the body, when the body is an object that has one. */
	toolName: string | null;
	/** `session_id` from the body, likewise. */
	sessionId: string | null;
};

/** How the queue answers one request. The HTTP server makes one per held request. */
export interface Responder {
	/** False once the client has gone or an answer was sent. */
	readonly open: boolean;
	send(status: number, body: string): void;
}

export type AnswerResult =
	| { ok: true; req: HeldRequest; remaining: number }
	/**
	 * empty: nothing is held. changed: the oldest isn't the request the key showed, so the press does nothing.
	 * gone: the oldest's client had already gone; it's removed and nothing is sent.
	 */
	| { ok: false; why: "empty" | "changed" | "gone"; req: HeldRequest | null };

type Entry = { req: HeldRequest; responder: Responder };

/** Longer `tool_name` and `session_id` values are cut to this, for the key and the log. */
const MAX_FIELD = 100;

/** Reads `tool_name` and `session_id` from a body, if it's an object with string values for them. */
export function describeBody(body: unknown): Pick<HeldRequest, "toolName" | "sessionId"> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { toolName: null, sessionId: null };
	const o = body as Record<string, unknown>;
	const field = (v: unknown): string | null => (typeof v === "string" && v !== "" ? (v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v) : null);
	return { toolName: field(o.tool_name), sessionId: field(o.session_id) };
}

/**
 * Held permission requests, oldest first. A key press answers the oldest with {@link ALLOW_DECISION}; a
 * client that closes first is removed. Nothing here answers on its own: no timeout, no default.
 */
export class HeldQueue {
	readonly #entries: Entry[] = [];
	readonly #listeners = new Set<() => void>();
	readonly #now: () => number;
	#nextId = 1;

	constructor(opts: { now?: () => number } = {}) {
		this.#now = opts.now ?? Date.now;
	}

	get size(): number {
		return this.#entries.length;
	}

	get oldest(): HeldRequest | null {
		return this.#entries[0]?.req ?? null;
	}

	list(): HeldRequest[] {
		return this.#entries.map((e) => e.req);
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	hold(body: unknown, responder: Responder): HeldRequest {
		const req: HeldRequest = { id: this.#nextId++, at: this.#now(), ...describeBody(body) };
		this.#entries.push({ req, responder });
		this.#emit();
		return req;
	}

	/** The client of request `id` went away before an answer. Returns whether it was still held. */
	close(id: number): boolean {
		const i = this.#entries.findIndex((e) => e.req.id === id);
		if (i < 0) return false;
		this.#entries.splice(i, 1);
		this.#emit();
		return true;
	}

	/**
	 * Answers the oldest request with allow. `shownId` is the request the key showed when pressed (null: it
	 * showed none); when the oldest is another one, nothing is answered, so a press never approves a request
	 * the key didn't show. Pass undefined to skip that check.
	 */
	answerOldest(shownId?: number | null): AnswerResult {
		const entry = this.#entries[0];
		if (!entry) return { ok: false, why: "empty", req: null };
		if (shownId !== undefined && entry.req.id !== shownId) return { ok: false, why: "changed", req: entry.req };
		this.#entries.shift();
		if (!entry.responder.open) {
			this.#emit();
			return { ok: false, why: "gone", req: entry.req };
		}
		entry.responder.send(200, JSON.stringify(ALLOW_DECISION));
		this.#emit();
		return { ok: true, req: entry.req, remaining: this.#entries.length };
	}

	#emit(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
