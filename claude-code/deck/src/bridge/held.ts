import { type AskPicks, askAnswers, type HeldAsk } from "../protocol/ask.js";
import { ALLOW_DECISION, answerDecision, approvePlanDecision, DENY_DECISION, NO_DECISION, type PlanMode } from "../protocol/wire.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";

/** How the bridge answers one held HTTP request. The server makes one per request it holds. */
export interface Responder {
	/** False once the client has gone or an answer was sent. */
	readonly open: boolean;
	send(status: number, body: string): void;
}

/**
 * `tool`: Approve and Deny answer it, and so does its session's Session Slot dial. `ask` (AskUserQuestion,
 * ExitPlanMode): the keys show it and a press on them jumps to its session; only its session's dial answers it
 * (PROTOCOL.md, Permission requests).
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
	/**
	 * For an `ask` request, what a dial can do with it (src/protocol/ask.ts): its form or its plan, with its `tool_input`
	 * kept as it came while that's at most 64 KiB of JSON and the token scrub left it alone, or display-only. Null for a
	 * `tool` request.
	 */
	readonly ask: HeldAsk | null;
};

export type Decision = "allow" | "deny";

/**
 * What a Session Slot dial sends for its session's oldest held request (PROTOCOL.md, Held requests): Allow or Deny for
 * a `tool` request; the picks for an AskUserQuestion, which become an Answer; for an ExitPlanMode, the mode an Approve
 * plan leaves Plan mode into, or Deny.
 */
export type DialAnswer = { t: "allow" } | { t: "deny" } | { t: "answers"; picks: AskPicks } | { t: "plan"; mode: PlanMode };

export type DialAnswerResult =
	| { ok: true; held: Held; remaining: number }
	/**
	 * empty: the session has nothing held. changed: its oldest isn't the request the strip showed. gone: the oldest's
	 * client had already gone; it's removed. invalid: the answer doesn't fit the request (a plain Allow for a question, a
	 * plan's mode for a tool, picks that don't check out, a display-only request). Nothing is sent in any of these.
	 */
	| { ok: false; why: "empty" | "changed" | "gone" | "invalid"; held: Held | null; detail: string };

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

	/** The session's oldest held request, which its Session Slot dial shows and answers; null when it has none. */
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
		// The fp is logged so ladder step 4 can compare it with the mod's for the same call (PROTOCOL.md).
		this.#log.info(`HELD #${held.id} ${held.kind} ${quote(held.tool, 60)} ${quote(held.summary, 40)} fp ${held.fp ?? "none"} from ${held.host}; ${this.size} held`);
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
		this.#emit();
		return { ok: true, did: "answered", held: entry.held, decision, remaining: this.size };
	}

	/**
	 * A press on a Session Slot dial (PROTOCOL.md, Held requests). `shownId` is the request the dial's strip showed when
	 * pressed (null: none). The press acts only on the session's oldest held request, of any kind, and only when that's
	 * the one shown: newer requests are always younger, so a shown request still held is still the session's oldest.
	 * The answer must fit the request, and is checked before anything is sent:
	 * - a `tool` request takes Allow or Deny, the keys' bodies;
	 * - a question takes picks, which must answer its form (askAnswers), and becomes an Answer: its `tool_input` as it
	 *   came, plus `answers`;
	 * - a plan takes a mode, an Approve plan with its `tool_input` unchanged and that `setMode`, or Deny;
	 * - a display-only request takes nothing.
	 * The keys and the dials answer the same requests, and the first answer wins: the others find it gone.
	 */
	answer(host: string, shownId: number | null, answer: DialAnswer): DialAnswerResult {
		const i = this.#entries.findIndex((e) => e.held.host === host);
		const entry = i < 0 ? undefined : this.#entries[i];
		if (!entry) return { ok: false, why: "empty", held: null, detail: "nothing is held for the session" };
		if (entry.held.id !== shownId) return { ok: false, why: "changed", held: entry.held, detail: `the strip showed ${shownId === null ? "no request" : `#${shownId}`}, but the session's oldest is #${entry.held.id}` };
		if (!entry.responder.open) {
			this.#entries.splice(i, 1);
			this.#emit();
			return { ok: false, why: "gone", held: entry.held, detail: `#${entry.held.id} had already closed; removed` };
		}
		const built = dialBody(entry.held, answer);
		if (!built.ok) return { ok: false, why: "invalid", held: entry.held, detail: built.why };
		this.#entries.splice(i, 1);
		this.#send(entry, built.body);
		this.#log.info(`ANSWER #${entry.held.id} ${quote(entry.held.tool, 60)}: ${built.what}, from its session's dial; ${this.size} held`);
		this.#emit();
		return { ok: true, held: entry.held, remaining: this.size };
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

/** The body a dial's answer sends for `held`, with what it is for the log; or why it doesn't fit the request. */
function dialBody(held: Held, answer: DialAnswer): { ok: true; body: unknown; what: string } | { ok: false; why: string } {
	if (held.kind === "tool") {
		if (answer.t === "allow") return { ok: true, body: ALLOW_DECISION, what: "allow" };
		if (answer.t === "deny") return { ok: true, body: DENY_DECISION, what: "deny" };
		return { ok: false, why: `a ${answer.t === "plan" ? "plan's mode" : "set of answers"} for a tool's request, which takes Allow or Deny` };
	}
	const ask = held.ask;
	if (ask === null || ask.t === "inApp") return { ok: false, why: `the request is display-only (${ask?.why ?? "nothing kept"}), so it's answered in the app` };
	if (ask.t === "question") {
		if (answer.t !== "answers") return { ok: false, why: `${answer.t === "plan" ? "a plan's mode" : `a plain ${answer.t === "allow" ? "Allow" : "Deny"}`} for a question, which takes its answers` };
		const checked = askAnswers(ask.form, answer.picks);
		if (!checked.ok) return { ok: false, why: checked.why };
		return { ok: true, body: answerDecision(ask.input, checked.answers), what: `answered ${quote(JSON.stringify(checked.answers), 200)}` };
	}
	if (answer.t === "plan") return { ok: true, body: approvePlanDecision(ask.input, answer.mode), what: `plan approved into ${answer.mode}` };
	if (answer.t === "deny") return { ok: true, body: DENY_DECISION, what: "plan rejected (deny)" };
	return { ok: false, why: `${answer.t === "allow" ? "a plain Allow" : "answers"} for a plan, which takes a mode or Deny` };
}
