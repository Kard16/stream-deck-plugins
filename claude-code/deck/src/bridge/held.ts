import { ALLOW_DECISION, DENY_DECISION, NO_DECISION } from "../protocol/wire.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";

/** How the bridge answers one held HTTP request. The server makes one per request it holds. */
export interface Responder {
	/** False once the client has gone or an answer was sent. */
	readonly open: boolean;
	send(status: number, body: string): void;
}

/**
 * `tool`: Approve and Deny answer it. `ask` (AskUserQuestion, ExitPlanMode): shown, never answered; a press
 * jumps to its session. The third kind, `mode`, is allowed at once and never held (PROTOCOL.md, Permission
 * requests).
 */
export type HeldKind = "tool" | "ask";

/** A PermissionRequest the bridge holds until a press answers it or a release rule lets it go. */
export type Held = {
	/** 1, 2, 3… in arrival order: for the log, and for knowing which request a key showed. */
	readonly id: number;
	/** Wall-clock ms when it arrived, compared with the registry's `statusUpdatedAt` (release rules 2 and 3). */
	readonly at: number;
	/** The app's `local_…` id, from `X-Deck-Host` or the registry; null until the registry knows the sid. */
	host: string | null;
	readonly sid: string | null;
	readonly tool: string;
	readonly kind: HeldKind;
	readonly summary: string;
	/** Null for a `tool_input` nested too deeply to fingerprint: rule 1 can't release it, but rules 2–5 still do. */
	readonly fp: string | null;
};

export type Decision = "allow" | "deny";

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
	readonly #log: Log;
	#nextId = 1;

	constructor(opts: { log?: Log } = {}) {
		this.#log = opts.log ?? nullLog;
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

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	hold(req: Omit<Held, "id">, responder: Responder): Held {
		const held: Held = { ...req, id: this.#nextId++ };
		this.#entries.push({ held, responder });
		// The fp is logged so ladder step 4 can compare it with the mod's for the same call (PROTOCOL.md).
		this.#log.info(`HELD #${held.id} ${held.kind} ${quote(held.tool, 60)} ${quote(held.summary, 40)} fp ${held.fp ?? "none"} from ${held.host ?? `sid ${quote(held.sid, 40)}`}; ${this.size} held`);
		this.#emit();
		return held;
	}

	/** The registry now knows the session of a request that came without a usable host. */
	setHost(id: number, host: string): void {
		const entry = this.#entries.find((e) => e.held.id === id);
		if (!entry || entry.held.host === host) return;
		entry.held.host = host;
		this.#emit();
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
		this.#emit();
		return { ok: true, did: "answered", held: entry.held, decision, remaining: this.size };
	}

	#take(id: number): Entry | null {
		const i = this.#entries.findIndex((e) => e.held.id === id);
		if (i < 0) return null;
		const [entry] = this.#entries.splice(i, 1);
		return entry ?? null;
	}

	#send(entry: Entry, body: unknown): void {
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
