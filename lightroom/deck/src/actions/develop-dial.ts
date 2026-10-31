import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type FeedbackPayload,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import type { DialDeck } from "../dial/deck.js";
import { feedback } from "./shared.js";

/** A dial takes its slider from its column and the shared bank, so it has no settings. */
export type DialSettings = Record<string, never>;

const logger = streamDeck.logger.createScope("DevelopDial");

/** Input instrumentation in the format spikes/s4-ticks/analyze.mjs reads (at debug level). */
function record(kind: "TICK" | "INPUT", data: Record<string, unknown>): void {
	logger.debug(`${kind} ${JSON.stringify({ t: Date.now(), hr: Math.round(performance.now() * 1000) / 1000, ...data })}`);
}

/**
 * The Develop Dial action (UUID kept from spike S4, so placed dials keep working). All behaviour lives in
 * {@link DialDeck}; this class only maps SDK events onto it.
 */
@action({ UUID: "com.karimdhanji.lightroom.dial" })
export class DevelopDial extends SingletonAction<DialSettings> {
	readonly #deck: DialDeck;

	constructor(deck: DialDeck) {
		super();
		this.#deck = deck;
	}

	override onWillAppear(ev: WillAppearEvent<DialSettings>): void {
		if (!ev.action.isDial()) return;
		const dial: DialAction<DialSettings> = ev.action;
		this.#deck.add(dial.id, dial.coordinates.column, {
			setFeedback: (payload) => feedback(logger, "setFeedback", () => dial.setFeedback(payload as FeedbackPayload)),
			showAlert: () => feedback(logger, "showAlert", () => dial.showAlert()),
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<DialSettings>): void {
		this.#deck.remove(ev.action.id);
	}

	override onDialRotate(ev: DialRotateEvent<DialSettings>): void {
		const { ticks, pressed } = ev.payload;
		const result = this.#deck.rotate(ev.action.id, ticks, pressed);
		record("TICK", { col: ev.payload.coordinates.column, ticks, pressed, result });
	}

	override onDialDown(ev: DialDownEvent<DialSettings>): void {
		record("INPUT", { ev: "dialDown", col: ev.payload.coordinates.column });
		this.#deck.down(ev.action.id);
	}

	override onDialUp(ev: DialUpEvent<DialSettings>): void {
		record("INPUT", { ev: "dialUp", col: ev.payload.coordinates.column });
		this.#deck.up(ev.action.id);
	}

	override onTouchTap(ev: TouchTapEvent<DialSettings>): void {
		const { hold, tapPos } = ev.payload;
		record("INPUT", { ev: "touchTap", col: ev.payload.coordinates.column, hold, tapPos });
		this.#deck.tap(ev.action.id, hold);
	}
}
