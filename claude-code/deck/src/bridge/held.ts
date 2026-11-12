import { ALLOW_DECISION, DENY_DECISION, type HookAnswer, NO_DECISION } from "../protocol/wire.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";

/** How the bridge answers one held HTTP request. The server makes one per request it holds. */
export interface Responder {
	/** False once the client has gone or an answer was sent. */
	readonly open: boolean;
	send(status: number, body: string): void;
}

/**
 * `tool`: Approve and Deny answer it, and so does its session's Session Slot dial. `ask` (AskUserQuestion,
 * ExitPlanMode, the app's terminal tools: wire.ts's ASK_TOOLS): the keys and the dial show it, and a press on any of
 * them jumps to its session; the deck never answers one (PROTOCOL.md, Permission requests).
 */
export type HeldKind = "tool" | "ask";

/**
 * A PermissionRequest the bridge holds until a press answers it or a release rule lets it go. Only a request from
 * a session the registry confirms is held (PROTOCOL.md, Desktop sessions only), so each has its session's host.
 */
export type Held = {
	/** 1, 2, 3… in arrival order: for the log, and for knowing which request a key showed. */
	readonly id: number;
	/** Wall-clock ms when it arrived, compared with the registry's `statusUpdatedAt` (release rules 2 and 3). */
	readonly at: number;
	/** The app's `local_…` id, from `X-Deck-Host`, which the registry lists with the request's `session_id`. */
	readonly host: string;
	readonly tool: string;
	readonly kind: HeldKind;
	readonly summary: string;
	/** Null for a `tool_input` nested too deeply to fingerprint: rule 1 can't release it, but rules 2–5 still do. */
	readonly fp: string | null;
	/** The request's `agent_id`, another loop's; null for the main loop's. Rule 1 matches it (PROTOCOL.md, Held requests). */
	readonly agent: string | null;
};

export type Decision = "allow" | "deny";

/** An Allow a press sent, and the wall-clock ms it went at: see {@link HeldRequests.takeAllowed}. */
export type Allowed = { readonly held: Held; readonly at: number };

export type DialAnswerResult =
	| { ok: true; held: Held; remaining: number }
	/**
	 * empty: the session has nothing held. changed: its oldest isn't the request the strip showed. gone: the oldest's
	 * client had already gone; it's removed. ask: the oldest is an `ask`, which the deck never answers.
	 * Nothing is sent in any of these.
	 */
	| { ok: false; why: "empty" | "changed" | "gone" | "ask"; held: Held | null; detail: string };

export type PressResult =
	| { ok: true; did: "answered"; held: Held; decision: Decision; remaining: number }
	/** An ask: the press jumps to its session and answers nothing. */
	| { ok: true; did: "jump"; held: Held }
	/**
	 * empty: nothing is held. changed: the oldest isn't the request the key showed, so the press does nothing.
	 * gone: the oldest's client had already gone; it's removed and nothing is sent.
	 */
	| { ok: false; why: "empty" | "changed" | "gone"; held: Held | null };

type Entry = { held: Held; responder: Responder };

/**
 * The held PermissionRequests of every session, oldest first. Only a press answers one, and only the one
 * the key showed (S6). The release rules answer with no decision. Nothing here answers on its own: no
 * timeout, no default.
 */
export class HeldRequests {
	readonly #entries: Entry[] = [];
	readonly #listeners = new Set<() => void>();
	/** Each session's latest Allow from a press, while it's the last thing the deck knows of that session's waiting. */
	readonly #allowed = new Map<string, Allowed>();
	readonly #log: Log;
	readonly #wallNow: () => number;
	#nextId = 1;

	constructor(opts: { log?: Log; wallNow?: () => number } = {}) {
		this.#log = opts.log ?? nullLog;
		this.#wallNow = opts.wallNow ?? Date.now;
	}

	get size(): number {
		return this.#entries.length;
	}

	get oldest(): Held | null {
		return this.#entries[0]?.held ?? null;
	}

	list(): Held[] {
		return this.#entries.map((e) => e.held);
	}

	forHost(host: string): Held[] {
		return this.#entries.filter((e) => e.held.host === host).map((e) => e.held);
	}

	/** The session's oldest held request, which its Session Slot dial shows, and answers if it's a tool's; null for none. */
	oldestFor(host: string): Held | null {
		return this.#entries.find((e) => e.held.host === host)?.held ?? null;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	hold(req: Omit<Held, "id">, responder: Responder): Held {
		const held: Held = { ...req, id: this.#nextId++ };
		this.#entries.push({ held, responder });
		// Whatever the session waits on now is this request, not what became of an earlier Allow.
		this.#allowed.delete(held.host);
		// The fp is logged so ladder step 4 can compare it with the mod's for the same call (PROTOCOL.md).
		this.#log.info(`HELD #${held.id} ${held.kind} ${quote(held.tool, 60)} ${quote(held.summary, 40)} fp ${held.fp ?? "none"} from ${held.host}${held.agent === null ? "" : ` agent ${quote(held.agent, 40)}`}; ${this.size} held`);
		this.#emit();
		return held;
	}

	/** Release rule 5: the client of request `id` went away (the hook's timeout, or the session ended). */
	close(id: number): Held | null {
		const entry = this.#take(id);
		if (!entry) return null;
		this.#log.info(`CLOSED #${id}: the client closed first; ${this.size} held`);
		this.#emit();
		return entry.held;
	}

	/** Release rules 1–4: answers `{}` (no decision; the app's dialog decides) and lets the request go. */
	release(id: number, why: string): Held | null {
		const entry = this.#take(id);
		if (!entry) return null;
		this.#send(entry, NO_DECISION);
		this.#log.info(`RELEASED #${id} ${quote(entry.held.tool, 60)}: ${why}; ${this.size} held`);
		this.#emit();
		return entry.held;
	}

	/**
	 * A press on Approve or Deny. `shownId` is the request the key showed when pressed (null: it showed none).
	 * The press acts only on the oldest, and only when that's the one shown: new requests are always younger,
	 * so a shown request still held is still the oldest. A `tool` request is answered; an `ask` is left held.
	 */
	press(shownId: number | null, decision: Decision): PressResult {
		const entry = this.#entries[0];
		if (!entry) return { ok: false, why: "empty", held: null };
		if (entry.held.id !== shownId) return { ok: false, why: "changed", held: entry.held };
		if (!entry.responder.open) {
			this.#entries.shift();
			this.#emit();
			return { ok: false, why: "gone", held: entry.held };
		}
		if (entry.held.kind === "ask") return { ok: true, did: "jump", held: entry.held };
		this.#entries.shift();
		this.#send(entry, decision === "allow" ? ALLOW_DECISION : DENY_DECISION);
		this.#log.info(`ANSWER #${entry.held.id} ${quote(entry.held.tool, 60)}: ${decision}, from a key press; ${this.size} held`);
		if (decision === "allow") this.#noteAllow(entry.held);
		this.#emit();
		return { ok: true, did: "answered", held: entry.held, decision, remaining: this.size };
	}

	/**
	 * A press on a Session Slot dial (PROTOCOL.md, Held requests): Allow or Deny, the keys' bodies. `shownId` is the
	 * request the dial's strip showed when pressed (null: none). The press acts only on the session's oldest held
	 * request, and only when that's the one shown: newer requests are always younger, so a shown request still held is
	 * still the session's oldest. An `ask` is never answered: the dial's press on one jumps instead (Phase 9). The keys
	 * and the dials answer the same requests, and the first answer wins: the others find it gone.
	 */
	answer(host: string, shownId: number | null, decision: Decision): DialAnswerResult {
		const i = this.#entries.findIndex((e) => e.held.host === host);
		const entry = i < 0 ? undefined : this.#entries[i];
		if (!entry) return { ok: false, why: "empty", held: null, detail: "nothing is held for the session" };
		if (entry.held.id !== shownId) return { ok: false, why: "changed", held: entry.held, detail: `the strip showed ${shownId === null ? "no request" : `#${shownId}`}, but the session's oldest is #${entry.held.id}` };
		if (!entry.responder.open) {
			this.#entries.splice(i, 1);
			this.#emit();
			return { ok: false, why: "gone", held: entry.held, detail: `#${entry.held.id} had already closed; removed` };
		}
		if (entry.held.kind === "ask") return { ok: false, why: "ask", held: entry.held, detail: `#${entry.held.id} is an ask, which is answered in the app` };
		this.#entries.splice(i, 1);
		this.#send(entry, decision === "allow" ? ALLOW_DECISION : DENY_DECISION);
		this.#log.info(`ANSWER #${entry.held.id} ${quote(entry.held.tool, 60)}: ${decision}, from its session's dial; ${this.size} held`);
		if (decision === "allow") this.#noteAllow(entry.held);
		this.#emit();
		return { ok: true, held: entry.held, remaining: this.size };
	}

	/**
	 * The session's latest Allow from a press, once: null when it had none, when another of its requests was held as
	 * it went, or when one has come since. The model takes it when the registry shows the session no longer waiting,
	 * to tell an Allow that Claude Code didn't take (PROTOCOL.md, Permission requests).
	 */
	takeAllowed(host: string): Allowed | null {
		const allowed = this.#allowed.get(host) ?? null;
		this.#allowed.delete(host);
		return allowed;
	}

	#noteAllow(held: Held): void {
		// With another of its requests still held, the session goes on waiting whatever became of this one.
		if (this.#entries.some((e) => e.held.host === held.host)) this.#allowed.delete(held.host);
		else this.#allowed.set(held.host, { held, at: this.#wallNow() });
	}

	#take(id: number): Entry | null {
		const i = this.#entries.findIndex((e) => e.held.id === id);
		if (i < 0) return null;
		const [entry] = this.#entries.splice(i, 1);
		return entry ?? null;
	}

	#send(entry: Entry, body: HookAnswer): void {
		if (!entry.responder.open) return;
		try {
			entry.responder.send(200, JSON.stringify(body));
		} catch (err) {
			this.#log.warn(`#${entry.held.id}: the answer couldn't be sent: ${describeError(err)}`);
		}
	}

	#emit(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
