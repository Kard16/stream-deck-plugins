import type { Decision, DialAnswerResult, Held } from "../bridge/held.js";
import { SETTLE_MS } from "../keys/decision.js";
import { agentPages, MAX_AGENT_PAGES } from "../model/format.js";
import type { SessionView } from "../model/sessions.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import { type Feedback, type Live, PAINT_INTERVAL_MS, StripPainter } from "../util/painter.js";
import type { SlotId } from "./ids.js";
import { type JumpModel, jumpTo } from "./jump.js";
import type { Slots } from "./slots.js";

/**
 * Which page a dial is on, by what it shows, so it stays put while Agents pages come and go: Now, 1 to MAX_AGENT_PAGES
 * for the Agents pages, then Context and Setup (session-keys.md, The strip; agents-and-wake.md, B2). The screen counts
 * only the pages the session has now (pageList): three, and the Agents pages while other loops are in a turn.
 */
const NOW_PAGE = 0;
const CONTEXT_PAGE = MAX_AGENT_PAGES + 1;
const SETUP_PAGE = MAX_AGENT_PAGES + 2;

/** The pages the session has now, in order. */
function pageList(s: SessionView): number[] {
	return [NOW_PAGE, ...agentPages(s.threads).map((_, i) => i + 1), CONTEXT_PAGE, SETUP_PAGE];
}

/** How long a turn's repaint waits for more ticks: ticks within it are painted together. */
export const COALESCE_MS = 40;

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
 * How long the chip a press sends (an approval's Allow or Deny) must have been in sight on the strip, from its paint,
 * before a press sends it. A tick turns the chip at once, while its paint comes up to COALESCE_MS and the paint
 * interval later, and a push can turn the dial a tick on its way down: without this, a push right after a stray tick
 * would send a chip the strip never showed. Apart from the 1 s rule (SETTLE_MS), which still holds for sending. The
 * fixture runner turns it off with 0.
 */
export const PICK_SETTLE_MS = 300;

/** An approval's chips, in order: the first turn clockwise picks Allow, counter-clockwise Deny. */
export const APPROVAL_CHOICES = [
	{ t: "allow", label: "Allow" },
	{ t: "deny", label: "Deny" },
] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

/**
 * What a Session Slot dial's strip shows: the typed screen the surfaces' painter draws (SlotStripRender).
 * - `empty`: the slot holds no session.
 * - `pages`: the session has nothing held: info page `page` of `pages`, counting from 0: Now, its Agents pages if any,
 *   Context, Setup.
 * - `approval`: a held `tool` request; `choices` as chips, `pick` the one turned to, null until a turn.
 * - `inApp`: a held question or plan ("Answer in app"), which the deck never answers (PROTOCOL.md, Held requests): a
 *   press jumps to the session.
 * Every screen with a request names it (`request`, the held id), which is what a press acts on.
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
	| { readonly kind: "inApp"; readonly slot: SlotId; readonly session: SessionView; readonly request: number; readonly tool: string; readonly summary: string };

/**
 * Draws a screen: the layout to show (a file under the plugin's layouts/, switched with setFeedbackLayout) and its
 * feedback. `now` is the wall-clock time to show a `since` against. The surfaces' code supplies it.
 */
export type SlotStripRender = (screen: SlotScreen, now: number) => { layout: string; feedback: Feedback };

/** What the SDK adapter gives for one Session Slot dial. */
export type SlotDialSurface = {
	/** setFeedbackLayout; the feedback that follows fills it. */
	setLayout(layout: string): void;
	setFeedback(payload: Feedback): void;
	showAlert(): void;
};

/** What the slot dials need from the session model (SessionModel implements it). */
export interface SlotDialsModel extends JumpModel {
	readonly held: { oldestFor(host: string): Held | null; answer(host: string, shownId: number | null, decision: Decision): DialAnswerResult };
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
	/** Whether a Stream Deck is connected; the strips' painters send nothing while none is (agents-and-wake.md, C3). */
	live?: Live;
};

/**
 * What a strip's paint showed, which a press acts on: the session (null: none), the held request (null: none), and the
 * chip turned to on it (choiceOf).
 */
type Shown = { readonly host: string | null; readonly request: number | null; readonly choice: string };

type Dial = {
	id: string;
	slot: SlotId;
	surface: SlotDialSurface;
	/**
	 * Shows the session, the held request and the chip each paint is for (Shown), so a press acts on what the strip
	 * showed.
	 */
	painter: StripPainter<Shown>;
	/**
	 * What the strip showed at the push's dialDown (undefined: no paint yet), which a jump at its dialUp goes by: a
	 * repaint in between can't stand in for it. plugin.ts's press handler, which runs after the dialDown, repaints every
	 * strip when the press shows the deck a device it had as away (Devices' `pressed`).
	 */
	shownAtDown: Shown | undefined;
	/** The request the strip last painted (undefined: no paint yet), and since when on the clock: the 1 s counts from it. */
	paintedRequest: number | null | undefined;
	requestSince: number | null;
	/** The layout last asked for, and one still to send before the next feedback. */
	layout: string | null;
	layoutToSend: string | null;
	/** The session the screen is for, and its held request (null: none, the pages). */
	host: string | null;
	request: number | null;
	/** The page, by what it shows (NOW_PAGE…SETUP_PAGE). */
	page: number;
	/** An approval's chip turned to. */
	pick: number | null;
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
	| { kind: "inApp"; session: SessionView; held: Held };

/**
 * The Session Slot dials, without the SDK (session-keys.md, The strip; PROTOCOL.md, Held requests). Each dial belongs
 * to its slot's session, which the key above it shows, and its strip shows that session's oldest held request, or its
 * details while it has none.
 *
 * **Turning** moves one step per tick, in the direction turned: on the pages, a page, wrapping, through the Agents pages
 * while the session has them; when the page it's on goes, the strip goes to Now. On an approval, the
 * chip, none picked until the first turn, which picks the first clockwise or the last counter-clockwise, then one,
 * stopping at either end, so a tick past Deny never wraps round to Allow; on "Answer in app", nothing. Ticks within
 * about COALESCE_MS are painted together; nothing else is coalesced, and there's no acceleration.
 *
 * **A press or a tap:** on the pages, jumps to the session (jumpTo); on an approval, sends the chip turned to, or jumps
 * with none; on "Answer in app", a question or a plan, jumps and answers nothing, since the deck never answers one
 * (Phase 9); on an empty slot, alerts. A press that turned while held is no press. A jump goes only to the session the
 * strip showed, at a push's dialDown or at a tap; one the slot took since alerts, as on a slot key.
 *
 * **What a press sends:** a chip only once the strip has painted it, and it has been in sight there for PICK_SETTLE_MS:
 * a tick just before a press turns the chip at once, and the strip shows it only later. Earlier, the press alerts and
 * does nothing.
 *
 * **A long touch:** the pages go back to the first; a chip turned to is cleared.
 *
 * **Sending:** only for the request the strip showed when pressed, once it has been in sight there for SETTLE_MS from
 * its first paint, or from the strip's last alert or answer if later; and not within GONE_MS of a request it showed
 * leaving it unanswered here, until the strip paints a newer one. Otherwise the press alerts and sends nothing; so does
 * an answer the bridge refuses (HeldRequests' `answer`: gone, or answered elsewhere first). Nothing sends without a
 * press.
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
	readonly #live: Live | undefined;
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
		this.#live = opts.live;
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
					live: this.#live,
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
				shownAtDown: undefined,
				paintedRequest: undefined,
				requestSince: null,
				layout: null,
				layoutToSend: null,
				host: null,
				request: null,
				page: 0,
				pick: null,
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

	/**
	 * A device connected, or the Mac woke: each strip sends its layout and every key again, as when its dial reappears
	 * (agents-and-wake.md, C2). With no layout sent as far as it knows, its paint sends the layout and forgets its keys.
	 */
	repaintInFull(): void {
		for (const dial of this.#dials.values()) dial.layout = null;
		this.refresh();
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
		dial.shownAtDown = dial.painter.shown;
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

	/** A tap is a press, the touch alternative (a dial stack takes the press); a long touch goes back to the start. */
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
		if (request !== dial.request) {
			const left = dial.request;
			if (left !== null && left !== dial.sentId && dial.lastShown === left) {
				dial.goneAt = this.#clock.now();
				dial.goneId = left;
				this.#log.info(`slot dial ${dial.slot}: #${left} left the strip, unanswered here; a press within ${this.#goneMs} ms alerts, unless the strip shows a newer request first`);
			}
			this.#startOver(dial, request);
			return;
		}
		// The page it was on went, an Agents page once fewer loops are in a turn: the strip goes to Now
		// (agents-and-wake.md, B2).
		const session = host === null ? null : this.#model.slotView(host);
		if (session !== null && !pageList(session).includes(dial.page)) dial.page = NOW_PAGE;
	}

	#startOver(dial: Dial, request: number | null): void {
		dial.request = request;
		dial.page = NOW_PAGE;
		dial.pick = null;
	}

	#current(dial: Dial): Current {
		const host = dial.host;
		const session = host === null ? null : this.#model.slotView(host);
		if (host === null || session === null) return { kind: "empty" };
		const held = dial.request === null ? null : this.#model.held.oldestFor(host);
		if (held === null || held.id !== dial.request) return { kind: "pages", session };
		// A question or a plan is display-only: the deck never answers one (PROTOCOL.md, Held requests).
		return held.kind === "tool" ? { kind: "approval", session, held } : { kind: "inApp", session, held };
	}

	#screen(dial: Dial): SlotScreen {
		return this.#screenOf(dial, this.#current(dial));
	}

	#screenOf(dial: Dial, cur: Current): SlotScreen {
		const slot = dial.slot;
		switch (cur.kind) {
			case "empty":
				return { kind: "empty", slot };
			case "pages": {
				const list = pageList(cur.session);
				return { kind: "pages", slot, session: cur.session, page: Math.max(0, list.indexOf(dial.page)), pages: list.length };
			}
			case "approval":
				return { kind: "approval", slot, session: cur.session, request: cur.held.id, tool: cur.held.tool, summary: cur.held.summary, choices: APPROVAL_CHOICES, pick: dial.pick };
			case "inApp":
				return { kind: "inApp", slot, session: cur.session, request: cur.held.id, tool: cur.held.tool, summary: cur.held.summary };
		}
	}

	// ---- gestures ----

	#step(dial: Dial, dir: 1 | -1): void {
		const cur = this.#current(dial);
		switch (cur.kind) {
			case "pages": {
				const list = pageList(cur.session);
				dial.page = list[wrapIndex(list.indexOf(dial.page) + dir, list.length)] ?? NOW_PAGE;
				return;
			}
			case "approval":
				dial.pick = stepChip(dial.pick, dir, APPROVAL_CHOICES.length);
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
				// On a question or a plan too: the user answers it in the app, so the press jumps there and answers nothing.
				this.#jump(dial, cur.session, via);
				return;
			case "approval": {
				const choice = dial.pick === null ? undefined : APPROVAL_CHOICES[dial.pick];
				if (!choice) {
					this.#jump(dial, cur.session, via);
					return;
				}
				if (!this.#choiceInSight(dial, cur, via)) return;
				this.#send(dial, cur.held, choice.t, via);
				return;
			}
		}
	}

	#longTouch(dial: Dial): void {
		this.#sync(dial);
		const cur = this.#current(dial);
		switch (cur.kind) {
			case "pages":
				dial.page = NOW_PAGE;
				break;
			case "approval":
				dial.pick = null;
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
	 * Sends Allow or Deny for `held`, the session's oldest held request and the screen's: only when it's the request the
	 * strip showed, and has been in sight for SETTLE_MS since its first paint there or the strip's last alert or answer.
	 */
	#send(dial: Dial, held: Held, decision: Decision, via: "press" | "tap"): void {
		const host = dial.host;
		if (host === null) return;
		const shown = dial.painter.shown?.request ?? null;
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
			result = this.#model.held.answer(host, shown, decision);
		} catch (err) {
			dial.sentId = before;
			this.#log.error(`slot dial ${dial.slot} ${via}: answering #${held.id} threw: ${describeError(err)}`);
			this.#alert(dial);
			return;
		}
		if (result.ok) {
			dial.feedbackAt = this.#clock.now();
			this.#log.info(`slot dial ${dial.slot} ${via}: sent ${decision} for #${held.id} ${quote(held.tool, 40)} of ${host}`);
			return;
		}
		if (result.why !== "gone") dial.sentId = before;
		this.#log.info(`slot dial ${dial.slot} ${via}: nothing sent (${result.why}): ${result.detail}`);
		this.#alert(dial);
	}

	/**
	 * Jumps to the slot's session, only when the strip showed it: a push by what showed at its dialDown, a tap by what
	 * shows now. Otherwise the slot took another session since, which the strip hasn't shown yet (within a paint
	 * interval, or while no device was connected), and it alerts, as a slot key does.
	 */
	#jump(dial: Dial, session: SessionView, via: "press" | "tap"): void {
		if (dial.host === null) {
			this.#alert(dial);
			return;
		}
		const showed = via === "press" ? dial.shownAtDown : dial.painter.shown;
		if (showed?.host !== dial.host) {
			this.#log.info(`slot dial ${dial.slot} ${via}: nothing done: the strip showed ${showed === undefined ? "nothing yet" : (showed.host ?? "no session")}, but the slot holds ${dial.host} now`);
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
 * the last (Deny) and the first (Allow) are never a tick apart.
 */
function stepChip(current: number | null, dir: 1 | -1, n: number): number | null {
	if (n <= 0) return null;
	if (current === null) return dir > 0 ? 0 : n - 1;
	return Math.min(n - 1, Math.max(0, current + dir));
}

/** The chip a screen shows turned to, which a press sends (Shown); "" for a screen without chips. */
function choiceOf(screen: SlotScreen): string {
	if (screen.kind !== "approval") return "";
	return screen.pick === null ? "nothing picked" : `pick ${APPROVAL_CHOICES[screen.pick]?.label ?? screen.pick}`;
}

/** What a paint of `screen` shows: its session, its request and its choice. */
function shownOf(screen: SlotScreen): Shown {
	return { host: "session" in screen ? screen.session.host : null, request: "request" in screen ? screen.request : null, choice: choiceOf(screen) };
}

function sameShown(a: Shown | undefined, b: Shown | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.host === b.host && a.request === b.request && a.choice === b.choice);
}

/** A Shown for the log: `#12, pick Allow`. */
function describeShown(shown: Shown | undefined): string {
	if (shown === undefined) return "nothing yet";
	const request = shown.request === null ? "no request" : `#${shown.request}`;
	return shown.choice === "" ? request : `${request}, ${shown.choice}`;
}
