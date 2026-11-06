import type { DialAnswer, DialAnswerResult, Held } from "../bridge/held.js";
import { SETTLE_MS } from "../keys/decision.js";
import type { SessionView } from "../model/sessions.js";
import type { AskQuestion, InAppWhy } from "../protocol/ask.js";
import type { PlanMode } from "../protocol/wire.js";
import { COALESCE_MS, type DialSurface } from "../sessions/dials.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import { type Feedback, PAINT_INTERVAL_MS, StripPainter } from "../util/painter.js";
import type { SlotId } from "./ids.js";
import { type JumpModel, jumpTo } from "./jump.js";
import type { Slots } from "./slots.js";

/** How many info pages the strip has while its session needs nothing: Now, Context, Setup (session-keys.md, The strip). */
export const PAGES = 3;

/**
 * How long a press on a strip does nothing but alert after the request it showed went without this strip answering it
 * (answered in the app or by Approve or Deny, or released): a press then was meant for that request, which has gone
 * (PROTOCOL.md, Held requests: "a press for a request that has gone alerts and answers nothing"). The screen starts
 * over at once all the same, and the pages' press alerts rather than jumping. It holds only while nothing newer is on
 * the strip: once the strip paints a newer request, a press is for that one, under the 1 s rule and PICK_SETTLE_MS
 * (`dial-next`). A guard of its own, beside the 1 s rule (SETTLE_MS), which the fixture runner turns off.
 */
export const GONE_MS = 1000;

/**
 * How long the choice a press acts on (an approval's or a plan's chip, a question's place) must have been in sight on
 * the strip, from its paint, before a press acts on it. A tick turns the choice at once, while its paint comes up to
 * COALESCE_MS and the paint interval later, and a push can turn the dial a tick on its way down: without this, a push
 * right after a stray tick would act on a choice the strip never showed. Apart from the 1 s rule (SETTLE_MS), which
 * still holds for sending. The fixture runner turns it off with 0.
 */
export const PICK_SETTLE_MS = 300;

/** An approval's chips, in order: the first turn clockwise picks Allow, counter-clockwise Deny. */
export const APPROVAL_CHOICES = [
	{ t: "allow", label: "Allow" },
	{ t: "deny", label: "Deny" },
] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

/** A plan's chips, in order (session-keys.md, Plans): each Approve sends an Approve plan with its mode; Reject, Deny. */
export const PLAN_CHOICES = [
	{ t: "approve", mode: "auto", label: "Approve · Auto" },
	{ t: "approve", mode: "acceptEdits", label: "Approve · Accept edits" },
	{ t: "approve", mode: "default", label: "Approve · Manual" },
	{ t: "reject", label: "Reject" },
] as const satisfies readonly ({ t: "approve"; mode: PlanMode; label: string } | { t: "reject"; label: string })[];
export type PlanChoice = (typeof PLAN_CHOICES)[number];

/**
 * One place on a question's list, in order: its options, then Other…, which a press turns into a jump (typing goes in
 * the app), then for a multi-select question Next, or Send on the last question (`send`), which needs at least one
 * tick (`ready`). `ticked`: the option is among the question's picks.
 */
export type QuestionItem =
	| { readonly t: "option"; readonly label: string; readonly description: string | null; readonly ticked: boolean }
	| { readonly t: "other" }
	| { readonly t: "next"; readonly send: boolean; readonly ready: boolean };

/**
 * What a Session Slot dial's strip shows: the typed screen the surfaces' painter draws (SlotStripRender).
 * - `empty`: the slot holds no session.
 * - `pages`: the session needs nothing the dial can answer: info page `page` (0 Now, 1 Context, 2 Setup) of `pages`.
 * - `approval`: a held `tool` request; `choices` as chips, `pick` the one turned to, null until a turn.
 * - `question`: a held AskUserQuestion, question `index` of `count`; `items` its list, `cursor` the place turned to
 *   (null until a turn on this question), `picked` the labels picked for it so far, in the order of its options.
 * - `plan`: a held ExitPlanMode, with its plan's first heading or line; `choices` and `pick` as for an approval.
 * - `inApp`: a held request the dial can't answer ("Answer in app"): its `tool_input` was over 64 KiB (`too big`), the
 *   deck can't read its form (`unreadable`), or the token scrub changed it (`scrubbed`; InAppWhy). A press jumps.
 * Every screen with a request names it (`request`, the held id), which is what a press answers.
 */
export type SlotScreen =
	| { readonly kind: "empty"; readonly slot: SlotId }
	| { readonly kind: "pages"; readonly slot: SlotId; readonly session: SessionView; readonly page: number; readonly pages: number }
	| {
			readonly kind: "approval";
			readonly slot: SlotId;
			readonly session: SessionView;
			readonly request: number;
			readonly tool: string;
			readonly summary: string;
			readonly choices: readonly ApprovalChoice[];
			readonly pick: number | null;
	  }
	| {
			readonly kind: "question";
			readonly slot: SlotId;
			readonly session: SessionView;
			readonly request: number;
			readonly index: number;
			readonly count: number;
			readonly header: string | null;
			readonly question: string;
			readonly multi: boolean;
			readonly items: readonly QuestionItem[];
			readonly cursor: number | null;
			readonly picked: readonly string[];
	  }
	| {
			readonly kind: "plan";
			readonly slot: SlotId;
			readonly session: SessionView;
			readonly request: number;
			readonly firstLine: string | null;
			readonly choices: readonly PlanChoice[];
			readonly pick: number | null;
	  }
	| {
			readonly kind: "inApp";
			readonly slot: SlotId;
			readonly session: SessionView;
			readonly request: number;
			readonly tool: string;
			readonly summary: string;
			readonly why: InAppWhy;
	  };

/**
 * Draws a screen: the layout to show (a file under the plugin's layouts/, switched with setFeedbackLayout) and its
 * feedback. `now` is the wall-clock time to show a `since` against. The surfaces' code supplies it.
 */
export type SlotStripRender = (screen: SlotScreen, now: number) => { layout: string; feedback: Feedback };

/** What the SDK adapter gives for one Session Slot dial. */
export type SlotDialSurface = DialSurface & {
	/** setFeedbackLayout; the feedback that follows fills it. */
	setLayout(layout: string): void;
};

/** What the slot dials need from the session model (SessionModel implements it). */
export interface SlotDialsModel extends JumpModel {
	readonly held: { oldestFor(host: string): Held | null; answer(host: string, shownId: number | null, answer: DialAnswer): DialAnswerResult };
	slotView(host: string): SessionView | null;
}

export type SlotDialsOptions = {
	render: SlotStripRender;
	clock?: Clock;
	/** Wall-clock ms, for `since`. */
	wallNow?: () => number;
	log?: Log;
	/** Opens `claude://code/continue?session=<host>` (plugin.ts's openSession). */
	open?: (host: string) => void;
	paintIntervalMs?: number;
	/** The 1 s rule; the fixture runner turns it off with 0. */
	settleMs?: number;
	/** PICK_SETTLE_MS; the fixture runner turns it off with 0. */
	pickSettleMs?: number;
	goneMs?: number;
	/** How long a turn's repaint waits for more ticks, COALESCE_MS; 0 repaints at once (the fixture runner). */
	coalesceMs?: number;
};

/**
 * What a strip's paint showed, which a press acts on: the held request (null: none), and the choice on it (choiceOf):
 * the chip turned to on an approval or a plan, or a question's place.
 */
type Shown = { readonly request: number | null; readonly choice: string };

type Dial = {
	id: string;
	slot: SlotId;
	surface: SlotDialSurface;
	/** Shows the held request each paint is for, and the choice on it (Shown), so a press acts on what the strip showed. */
	painter: StripPainter<Shown>;
	/** The request the strip last painted (undefined: no paint yet), and since when on the clock: the 1 s counts from it. */
	paintedRequest: number | null | undefined;
	requestSince: number | null;
	/** The layout last asked for, and one still to send before the next feedback. */
	layout: string | null;
	layoutToSend: string | null;
	/** The session the screen is for, and its held request (null: none, the pages). */
	host: string | null;
	request: number | null;
	page: number;
	/** An approval's or a plan's chip turned to. */
	pick: number | null;
	/** A question form's question, the place turned to on its list, and the picks by question text. */
	q: number;
	cursor: number | null;
	picks: Map<string, string[]>;
	/** Turned since the screen started: a question's press before any turn jumps. */
	turned: boolean;
	pressed: boolean;
	turnedWhilePressed: boolean;
	repaintTimer: TimerHandle | null;
	/** When the strip last alerted or sent an answer, on the clock: either starts the 1 s again. */
	feedbackAt: number;
	/** The last held request the strip painted a screen for, kept after the screen moves on. */
	lastShown: number | null;
	/** The request this dial last sent an answer for: its leaving isn't a request gone unanswered. */
	sentId: number | null;
	/** When a request this strip showed left it unanswered here, and which; cleared once the strip paints a newer one. */
	goneAt: number | null;
	goneId: number | null;
};

/** What the screen is, from the dial's state and the session's oldest held request. */
type Current =
	| { kind: "empty" }
	| { kind: "pages"; session: SessionView }
	| { kind: "approval"; session: SessionView; held: Held }
	| { kind: "question"; session: SessionView; held: Held; questions: readonly AskQuestion[]; question: AskQuestion; items: QuestionItem[] }
	| { kind: "plan"; session: SessionView; held: Held }
	| { kind: "inApp"; session: SessionView; held: Held; why: InAppWhy };

/**
 * The Session Slot dials, without the SDK (session-keys.md, The strip; PROTOCOL.md, Held requests). Each dial belongs
 * to its slot's session, which the key above it shows, and its strip shows that session's oldest held request, or its
 * details while it needs nothing the dial can answer.
 *
 * **Turning** moves one step per tick, in the direction turned: on the pages, a page, wrapping; on an approval or a
 * plan, the chip, none picked until the first turn, which picks the first clockwise or the last counter-clockwise,
 * then one, stopping at either end, so a tick past Deny or Reject never wraps round to Allow or an Approve; on a
 * question, the cursor over its list (QuestionItem), from none the same way, then one, wrapping. Ticks within about
 * COALESCE_MS are painted together; nothing else is coalesced, and there's no acceleration.
 *
 * **A press or a tap:** on the pages, jumps to the session (jumpTo); on an approval or a plan, sends the chip turned to,
 * or jumps with none; on a question, as the list says (a single-select option picks it and moves on, a multi-select one
 * ticks or unticks, Other… jumps, Next and Send need a tick; after the last question it sends the answers), and a press
 * before any turn jumps; on "Answer in app", jumps; on an empty slot, alerts. A press that turned while held is no
 * press.
 *
 * **What a press acts on:** a chip or a place only once the strip has painted it, and it has been in sight there for
 * PICK_SETTLE_MS: a tick just before a press turns the choice at once, and the strip shows it only later. Earlier, the
 * press alerts and does nothing.
 *
 * **A long touch:** the pages go back to the first; a chip turned to is cleared; a question goes back one, or on the
 * first its picks are cleared.
 *
 * **Sending:** only for the request the strip showed when pressed, once it has been in sight there for SETTLE_MS from
 * its first paint, or from the strip's last alert or answer if later; and not within GONE_MS of a request it showed
 * leaving it unanswered here, until the strip paints a newer one. Otherwise the press alerts and sends nothing; so does
 * an answer the bridge refuses (HeldRequests' `answer`: gone, answered elsewhere first, or not one that fits). Nothing
 * sends without a press.
 *
 * **Starting over:** when the session's oldest held request changes, or the slot's session does, the screen starts over.
 *
 * **Repainting:** whenever the slots change, which they also do when a `since` the strips show next reads differently
 * (Slots' repaint tick, hardening.md B6), and with every change to the dial's own state.
 *
 * The SDK wrapper calls `add` on willAppear with the dial's slot (dialSlotId of its device, the device's rows and its
 * column), `remove` on willDisappear, and `rotate`, `down`, `up` and `tap` on its events. `add` and `remove` tell the
 * slots the slot is showing or not.
 */
export class SlotDials {
	readonly #slots: Slots;
	readonly #model: SlotDialsModel;
	readonly #render: SlotStripRender;
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	readonly #log: Log;
	readonly #open: (host: string) => void;
	readonly #paintIntervalMs: number;
	readonly #settleMs: number;
	readonly #pickSettleMs: number;
	readonly #goneMs: number;
	readonly #coalesceMs: number;
	readonly #dials = new Map<string, Dial>();
	readonly #listeners = new Set<(id: string, screen: SlotScreen) => void>();

	constructor(slots: Slots, model: SlotDialsModel, opts: SlotDialsOptions) {
		this.#slots = slots;
		this.#model = model;
		this.#render = opts.render;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#log = opts.log ?? nullLog;
		this.#open = opts.open ?? (() => {});
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#settleMs = opts.settleMs ?? SETTLE_MS;
		this.#pickSettleMs = opts.pickSettleMs ?? PICK_SETTLE_MS;
		this.#goneMs = opts.goneMs ?? GONE_MS;
		this.#coalesceMs = opts.coalesceMs ?? COALESCE_MS;
		slots.onChange(() => this.refresh());
	}

	/** Each repaint of a dial, with the screen it painted. */
	onChange(listener: (id: string, screen: SlotScreen) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** A dial appeared on `slot`: it paints in full. */
	add(id: string, slot: SlotId, surface: SlotDialSurface): void {
		const old = this.#dials.get(id);
		if (old && old.slot !== slot) this.remove(id);
		let dial = this.#dials.get(id);
		if (!dial) {
			let made: Dial | null = null;
			const painter = new StripPainter<Shown>(
				(payload) => {
					if (made === null) return;
					if (made.layoutToSend !== null) {
						made.surface.setLayout(made.layoutToSend);
						made.layoutToSend = null;
					}
					made.surface.setFeedback(payload);
				},
				{
					clock: this.#clock,
					minIntervalMs: this.#paintIntervalMs,
					equals: sameShown,
					onShown: (shown) => {
						if (made === null || shown === undefined) return;
						// A new request on the strip: the 1 s starts; another choice on the same request doesn't restart it.
						if (shown.request !== made.paintedRequest) {
							made.paintedRequest = shown.request;
							made.requestSince = this.#clock.now();
						}
						if (shown.request === null) return;
						made.lastShown = shown.request;
						// A request newer than the one that left unanswered here (ids go up in arrival order) is on the strip
						// now, so a press is for it, under the 1 s rule and PICK_SETTLE_MS: the gone guard has done its part.
						if (made.goneId !== null && shown.request > made.goneId) {
							this.#log.debug(`slot dial ${made.slot}: #${shown.request} is on the strip, so #${made.goneId}'s leaving no longer makes a press alert`);
							made.goneAt = null;
							made.goneId = null;
						}
					},
				},
			);
			made = {
				id,
				slot,
				surface,
				painter,
				paintedRequest: undefined,
				requestSince: null,
				layout: null,
				layoutToSend: null,
				host: null,
				request: null,
				page: 0,
				pick: null,
				q: 0,
				cursor: null,
				picks: new Map(),
				turned: false,
				pressed: false,
				turnedWhilePressed: false,
				repaintTimer: null,
				feedbackAt: -Infinity,
				lastShown: null,
				sentId: null,
				goneAt: null,
				goneId: null,
			};
			dial = made;
			this.#dials.set(id, dial);
		}
		dial.surface = surface;
		// The app forgot the strip: the layout and every key go again.
		dial.layout = null;
		dial.painter.forget();
		this.#slots.appear(slot, id);
		this.#sync(dial);
		this.#paint(dial);
	}

	remove(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (dial.repaintTimer !== null) this.#clock.clearTimeout(dial.repaintTimer);
		dial.painter.dispose();
		this.#dials.delete(id);
		this.#slots.disappear(dial.slot, id);
	}

	/** The slots or their sessions changed: each dial catches up, starting over if need be, and repaints. */
	refresh(): void {
		for (const dial of this.#dials.values()) {
			this.#sync(dial);
			this.#paint(dial);
		}
	}

	rotate(id: string, ticks: number, pressed: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial || !Number.isFinite(ticks) || Math.trunc(ticks) === 0) return;
		if (pressed) {
			dial.pressed = true;
			dial.turnedWhilePressed = true;
		}
		this.#sync(dial);
		const dir = ticks > 0 ? 1 : -1;
		const steps = Math.min(Math.abs(Math.trunc(ticks)), 100);
		for (let i = 0; i < steps; i++) this.#step(dial, dir);
		if (dial.repaintTimer !== null) return;
		if (!(this.#coalesceMs > 0)) {
			this.#paint(dial);
			return;
		}
		dial.repaintTimer = this.#clock.setTimeout(() => {
			dial.repaintTimer = null;
			this.#paint(dial);
		}, this.#coalesceMs);
	}

	down(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		dial.pressed = true;
		dial.turnedWhilePressed = false;
	}

	/** A press counts only if this plugin saw it start and the dial didn't turn while held. */
	up(id: string): void {
		const dial = this.#dials.get(id);
		if (!dial || !dial.pressed) return;
		const turned = dial.turnedWhilePressed;
		dial.pressed = false;
		dial.turnedWhilePressed = false;
		if (!turned) this.#press(dial, "press");
	}

	/** A tap is a press, the touch alternative (a dial stack takes the press); a long touch goes back. */
	tap(id: string, hold: boolean): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		if (hold) this.#longTouch(dial);
		else this.#press(dial, "tap");
	}

	/** The screen a dial shows now, as its state stands; null for no such dial. */
	screen(id: string): SlotScreen | null {
		const dial = this.#dials.get(id);
		return dial ? this.#screen(dial) : null;
	}

	/** The last held request a dial's strip painted a screen for, kept after the screen moves on; null for none yet. */
	lastShown(id: string): number | null {
		return this.#dials.get(id)?.lastShown ?? null;
	}

	/** The slot a dial is on. */
	slotOf(id: string): SlotId | null {
		return this.#dials.get(id)?.slot ?? null;
	}

	/** What a dial's strip shows now, as far as its painter knows, for tests. */
	painted(id: string): Feedback | null {
		return this.#dials.get(id)?.painter.painted ?? null;
	}

	// ---- state ----

	/** Follows the slot's session and its oldest held request: either changing starts the screen over. */
	#sync(dial: Dial): void {
		const host = this.#slots.host(dial.slot);
		const request = host === null ? null : (this.#model.held.oldestFor(host)?.id ?? null);
		if (host !== dial.host) {
			if (dial.host !== null || host !== null) this.#log.debug(`slot dial ${dial.slot}: ${dial.host ?? "no session"} → ${host ?? "no session"}`);
			dial.host = host;
			dial.goneAt = null;
			dial.goneId = null;
			this.#startOver(dial, request);
			return;
		}
		if (request === dial.request) return;
		const left = dial.request;
		if (left !== null && left !== dial.sentId && dial.lastShown === left) {
			dial.goneAt = this.#clock.now();
			dial.goneId = left;
			this.#log.info(`slot dial ${dial.slot}: #${left} left the strip, unanswered here; a press within ${this.#goneMs} ms alerts, unless the strip shows a newer request first`);
		}
		this.#startOver(dial, request);
	}

	#startOver(dial: Dial, request: number | null): void {
		dial.request = request;
		dial.page = 0;
		dial.pick = null;
		dial.q = 0;
		dial.cursor = null;
		dial.picks = new Map();
		dial.turned = false;
	}

	#current(dial: Dial): Current {
		const host = dial.host;
		const session = host === null ? null : this.#model.slotView(host);
		if (host === null || session === null) return { kind: "empty" };
		const held = dial.request === null ? null : this.#model.held.oldestFor(host);
		if (held === null || held.id !== dial.request) return { kind: "pages", session };
		if (held.kind === "tool") return { kind: "approval", session, held };
		const ask = held.ask;
		if (ask === null || ask.t === "inApp") return { kind: "inApp", session, held, why: ask?.why ?? "unreadable" };
		if (ask.t === "plan") return { kind: "plan", session, held };
		const questions = ask.form.questions;
		const index = Math.min(dial.q, questions.length - 1);
		const question = questions[index] ?? questions[0];
		if (question === undefined) return { kind: "inApp", session, held, why: "unreadable" };
		return { kind: "question", session, held, questions, question, items: this.#items(dial, question, index === questions.length - 1) };
	}

	#items(dial: Dial, question: AskQuestion, last: boolean): QuestionItem[] {
		const picked = dial.picks.get(question.question) ?? [];
		const items: QuestionItem[] = question.options.map((o) => ({ t: "option", label: o.label, description: o.description, ticked: picked.includes(o.label) }));
		items.push({ t: "other" });
		if (question.multiSelect) items.push({ t: "next", send: last, ready: picked.length > 0 });
		return items;
	}

	#screen(dial: Dial): SlotScreen {
		return this.#screenOf(dial, this.#current(dial));
	}

	#screenOf(dial: Dial, cur: Current): SlotScreen {
		const slot = dial.slot;
		switch (cur.kind) {
			case "empty":
				return { kind: "empty", slot };
			case "pages":
				return { kind: "pages", slot, session: cur.session, page: dial.page, pages: PAGES };
			case "approval":
				return { kind: "approval", slot, session: cur.session, request: cur.held.id, tool: cur.held.tool, summary: cur.held.summary, choices: APPROVAL_CHOICES, pick: dial.pick };
			case "plan":
				return { kind: "plan", slot, session: cur.session, request: cur.held.id, firstLine: cur.held.ask?.t === "plan" ? cur.held.ask.firstLine : null, choices: PLAN_CHOICES, pick: dial.pick };
			case "inApp":
				return { kind: "inApp", slot, session: cur.session, request: cur.held.id, tool: cur.held.tool, summary: cur.held.summary, why: cur.why };
			case "question": {
				const picked = dial.picks.get(cur.question.question) ?? [];
				return {
					kind: "question",
					slot,
					session: cur.session,
					request: cur.held.id,
					index: Math.min(dial.q, cur.questions.length - 1),
					count: cur.questions.length,
					header: cur.question.header,
					question: cur.question.question,
					multi: cur.question.multiSelect,
					items: cur.items,
					cursor: dial.cursor,
					picked: cur.question.options.filter((o) => picked.includes(o.label)).map((o) => o.label),
				};
			}
		}
	}

	// ---- gestures ----

	#step(dial: Dial, dir: 1 | -1): void {
		const cur = this.#current(dial);
		switch (cur.kind) {
			case "pages":
				dial.page = wrapIndex(dial.page + dir, PAGES);
				return;
			case "approval":
				dial.pick = stepChip(dial.pick, dir, APPROVAL_CHOICES.length);
				dial.turned = true;
				return;
			case "plan":
				dial.pick = stepChip(dial.pick, dir, PLAN_CHOICES.length);
				dial.turned = true;
				return;
			case "question":
				dial.cursor = stepPlace(dial.cursor === null ? null : Math.min(dial.cursor, cur.items.length - 1), dir, cur.items.length);
				dial.turned = true;
				return;
			default:
				return;
		}
	}

	#press(dial: Dial, via: "press" | "tap"): void {
		this.#sync(dial);
		const now = this.#clock.now();
		if (dial.goneAt !== null && now - dial.goneAt < this.#goneMs) {
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing done: #${dial.goneId ?? "?"} left the strip ${Math.round(now - dial.goneAt)} ms ago, unanswered here`);
			this.#alert(dial);
			return;
		}
		const cur = this.#current(dial);
		switch (cur.kind) {
			case "empty":
				this.#log.info(`slot dial ${dial.slot} ${via}: no session on the slot`);
				this.#alert(dial);
				return;
			case "pages":
			case "inApp":
				this.#jump(dial, cur.session, via);
				return;
			case "approval": {
				const choice = dial.pick === null ? undefined : APPROVAL_CHOICES[dial.pick];
				if (!choice) {
					this.#jump(dial, cur.session, via);
					return;
				}
				if (!this.#choiceInSight(dial, cur, via)) return;
				this.#send(dial, cur.held, { t: choice.t }, via);
				return;
			}
			case "plan": {
				const choice = dial.pick === null ? undefined : PLAN_CHOICES[dial.pick];
				if (!choice) {
					this.#jump(dial, cur.session, via);
					return;
				}
				if (!this.#choiceInSight(dial, cur, via)) return;
				this.#send(dial, cur.held, choice.t === "approve" ? { t: "plan", mode: choice.mode } : { t: "deny" }, via);
				return;
			}
			case "question":
				this.#pressQuestion(dial, cur, via);
				return;
		}
	}

	#pressQuestion(dial: Dial, cur: Extract<Current, { kind: "question" }>, via: "press" | "tap"): void {
		const item = dial.cursor === null ? undefined : cur.items[dial.cursor];
		if (item === undefined) {
			if (!dial.turned) {
				this.#jump(dial, cur.session, via);
				return;
			}
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing under the cursor on question ${dial.q + 1}`);
			this.#alert(dial);
			return;
		}
		// Every place acts only once the strip shows it: a pick or a tick changes the answers, Next and Send go on.
		if (!this.#choiceInSight(dial, cur, via)) return;
		const q = cur.question;
		const last = dial.q >= cur.questions.length - 1;
		if (item.t === "other") {
			this.#jump(dial, cur.session, via);
			return;
		}
		if (item.t === "option") {
			if (!q.multiSelect) {
				dial.picks.set(q.question, [item.label]);
				if (last) this.#sendAnswers(dial, cur, via);
				else this.#advance(dial);
				return;
			}
			const picked = new Set(dial.picks.get(q.question) ?? []);
			if (picked.has(item.label)) picked.delete(item.label);
			else picked.add(item.label);
			dial.picks.set(
				q.question,
				q.options.filter((o) => picked.has(o.label)).map((o) => o.label),
			);
			this.#paint(dial);
			return;
		}
		// Next, or Send: at least one tick.
		if ((dial.picks.get(q.question) ?? []).length === 0) {
			this.#log.info(`slot dial ${dial.slot} ${via}: ${last ? "Send" : "Next"} needs a tick on question ${dial.q + 1}`);
			this.#alert(dial);
			return;
		}
		if (last) this.#sendAnswers(dial, cur, via);
		else this.#advance(dial);
	}

	#advance(dial: Dial): void {
		dial.q++;
		dial.cursor = null;
		this.#paint(dial);
	}

	#sendAnswers(dial: Dial, cur: Extract<Current, { kind: "question" }>, via: "press" | "tap"): void {
		const picks: Record<string, string[]> = {};
		for (const q of cur.questions) {
			const chosen = dial.picks.get(q.question);
			if (chosen !== undefined) Object.defineProperty(picks, q.question, { value: [...chosen], enumerable: true, writable: true, configurable: true });
		}
		this.#send(dial, cur.held, { t: "answers", picks }, via);
	}

	#longTouch(dial: Dial): void {
		this.#sync(dial);
		const cur = this.#current(dial);
		switch (cur.kind) {
			case "pages":
				dial.page = 0;
				break;
			case "approval":
			case "plan":
				dial.pick = null;
				break;
			case "question":
				if (dial.q > 0) dial.q--;
				else {
					dial.picks.delete(cur.question.question);
					dial.turned = false;
				}
				dial.cursor = null;
				break;
			default:
				return;
		}
		this.#paint(dial);
	}

	/**
	 * Whether the strip shows what a press would act on now, the request and the choice on it (Shown), and has for
	 * PICK_SETTLE_MS since that paint. Otherwise the press alerts and does nothing: a tick just before it turned the
	 * choice to one the strip hasn't shown yet, or has shown only for a moment.
	 */
	#choiceInSight(dial: Dial, cur: Current, via: "press" | "tap"): boolean {
		const want = shownOf(this.#screenOf(dial, cur));
		const shown = dial.painter.shown;
		if (!sameShown(shown, want)) {
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing done: the strip shows ${describeShown(shown)}, not ${describeShown(want)}, yet`);
			this.#alert(dial);
			return false;
		}
		const inSight = this.#clock.now() - (dial.painter.shownSince ?? Infinity);
		if (inSight < this.#pickSettleMs) {
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing done: ${describeShown(want)} had been in sight on the strip for ${Math.round(Math.max(0, inSight))} ms, under ${this.#pickSettleMs} ms`);
			this.#alert(dial);
			return false;
		}
		return true;
	}

	/**
	 * Sends an answer for `held`, the session's oldest held request and the screen's: only when it's the request the
	 * strip showed, and has been in sight for SETTLE_MS since its first paint there or the strip's last alert or answer.
	 */
	#send(dial: Dial, held: Held, answer: DialAnswer, via: "press" | "tap"): void {
		const host = dial.host;
		if (host === null) return;
		const shown = dial.painter.shown?.request ?? null;
		const what = answer.t === "plan" ? `plan ${answer.mode}` : answer.t;
		if (shown !== held.id) {
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing sent: the strip showed ${shown === null ? "no request" : `#${shown}`}, not #${held.id}, yet`);
			this.#alert(dial);
			return;
		}
		const now = this.#clock.now();
		const seenMs = now - Math.max(dial.requestSince ?? Infinity, dial.feedbackAt);
		if (seenMs < this.#settleMs) {
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing sent: #${held.id} had been in sight on the strip for ${Math.round(Math.max(0, seenMs))} ms, under ${this.#settleMs} ms`);
			this.#alert(dial);
			return;
		}
		// Set before the answer goes: the bridge's change comes back here (refresh) before answer returns, and the
		// request's leaving is this dial's own answer, not a request gone unanswered.
		const before = dial.sentId;
		dial.sentId = held.id;
		let result: DialAnswerResult;
		try {
			result = this.#model.held.answer(host, shown, answer);
		} catch (err) {
			dial.sentId = before;
			this.#log.error(`slot dial ${dial.slot} ${via}: answering #${held.id} threw: ${describeError(err)}`);
			this.#alert(dial);
			return;
		}
		if (result.ok) {
			dial.feedbackAt = this.#clock.now();
			this.#log.info(`slot dial ${dial.slot} ${via}: sent ${what} for #${held.id} ${quote(held.tool, 40)} of ${host}`);
			return;
		}
		if (result.why !== "gone") dial.sentId = before;
		this.#log.info(`slot dial ${dial.slot} ${via}: nothing sent (${result.why}): ${result.detail}`);
		this.#alert(dial);
	}

	#jump(dial: Dial, session: SessionView, via: "press" | "tap"): void {
		if (dial.host === null) {
			this.#alert(dial);
			return;
		}
		jumpTo(this.#model, dial.host, this.#open, `slot dial ${dial.slot} (${via})`, this.#log, session.title);
	}

	#alert(dial: Dial): void {
		dial.feedbackAt = this.#clock.now();
		dial.surface.showAlert();
	}

	// ---- paint ----

	#paint(dial: Dial): void {
		const screen = this.#screen(dial);
		let drawn: { layout: string; feedback: Feedback };
		try {
			drawn = this.#render(screen, this.#wallNow());
		} catch (err) {
			this.#log.error(`slot dial ${dial.slot}: drawing its ${screen.kind} screen threw: ${describeError(err)}`);
			return;
		}
		if (drawn.layout !== dial.layout) {
			dial.layout = drawn.layout;
			dial.layoutToSend = drawn.layout;
			dial.painter.forget();
		}
		dial.painter.update(drawn.feedback, shownOf(screen));
		for (const listener of [...this.#listeners]) {
			try {
				listener(dial.id, screen);
			} catch (err) {
				this.#log.error(`a slot dial listener threw: ${describeError(err)}`);
			}
		}
	}
}

/** `i` into 0…n−1, wrapping both ways. */
function wrapIndex(i: number, n: number): number {
	return ((i % n) + n) % n;
}

/**
 * The next chip: from none, the first clockwise or the last counter-clockwise; else one on, stopping at either end, so
 * the last (Deny, Reject) and the first (Allow, Approve · Auto) are never a tick apart.
 */
function stepChip(current: number | null, dir: 1 | -1, n: number): number | null {
	if (n <= 0) return null;
	if (current === null) return dir > 0 ? 0 : n - 1;
	return Math.min(n - 1, Math.max(0, current + dir));
}

/** The next place on a question's list: from none, the first clockwise or the last counter-clockwise; else one on, wrapping. */
function stepPlace(current: number | null, dir: 1 | -1, n: number): number | null {
	if (n <= 0) return null;
	if (current === null) return dir > 0 ? 0 : n - 1;
	return wrapIndex(current + dir, n);
}

/** The choice a screen shows, which a press acts on (Shown): the chip turned to, or a question's place; "" for none. */
function choiceOf(screen: SlotScreen): string {
	switch (screen.kind) {
		case "approval":
			return screen.pick === null ? "nothing picked" : `pick ${APPROVAL_CHOICES[screen.pick]?.label ?? screen.pick}`;
		case "plan":
			return screen.pick === null ? "nothing picked" : `pick ${PLAN_CHOICES[screen.pick]?.label ?? screen.pick}`;
		case "question":
			return `question ${screen.index + 1}, ${screen.cursor === null ? "nothing under the cursor" : `place ${screen.cursor + 1}`}`;
		default:
			return "";
	}
}

/** What a paint of `screen` shows: its request and its choice. */
function shownOf(screen: SlotScreen): Shown {
	return { request: "request" in screen ? screen.request : null, choice: choiceOf(screen) };
}

function sameShown(a: Shown | undefined, b: Shown | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.request === b.request && a.choice === b.choice);
}

/** A Shown for the log: `#12, pick Allow`. */
function describeShown(shown: Shown | undefined): string {
	if (shown === undefined) return "nothing yet";
	const request = shown.request === null ? "no request" : `#${shown.request}`;
	return shown.choice === "" ? request : `${request}, ${shown.choice}`;
}
