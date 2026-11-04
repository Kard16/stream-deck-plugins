import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	type FeedbackPayload,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import type { DialDeck, DialSettings } from "../dial/deck.js";
import { isSlidersRequest } from "../dial/inspector.js";
import { feedback } from "./shared.js";

export type { DialSettings } from "../dial/deck.js";

type SendToPluginEvent = Parameters<NonNullable<SingletonAction<DialSettings>["onSendToPlugin"]>>[0];

const logger = streamDeck.logger.createScope("DevelopDial");

/**
 * Input instrumentation in the format spikes/s4-ticks/analyze.mjs reads. It's at debug, below the default
 * info, so it's only logged when log-level.txt in the .sdPlugin folder says debug (see plugin.ts).
 */
function record(kind: "TICK" | "INPUT", data: Record<string, unknown>): void {
	logger.debug(`${kind} ${JSON.stringify({ t: Date.now(), hr: Math.round(performance.now() * 1000) / 1000, ...data })}`);
}

/**
 * The Develop Dial action (UUID kept from spike S4, so placed dials keep working). Each placed dial shows the
 * slider its settings name, chosen in the Property Inspector (pi/dial.html). All behaviour lives in
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
		this.#deck.add(
			dial.id,
			dial.coordinates.column,
			{
				setFeedback: (payload) => feedback(logger, "setFeedback", () => dial.setFeedback(payload as FeedbackPayload)),
				showAlert: () => feedback(logger, "showAlert", () => dial.showAlert()),
				setSettings: (settings) => feedback(logger, "setSettings", () => dial.setSettings(settings)),
			},
			ev.payload.settings,
		);
	}

	override onWillDisappear(ev: WillDisappearEvent<DialSettings>): void {
		this.#deck.remove(ev.action.id);
	}

	/** The Property Inspector chose another slider: the dial shows it at once. */
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialSettings>): void {
		this.#deck.settings(ev.action.id, ev.payload.settings);
	}

	/** The Property Inspector asks for the slider list. */
	override async onSendToPlugin(ev: SendToPluginEvent): Promise<void> {
		if (!isSlidersRequest(ev.payload)) return;
		await streamDeck.ui.sendToPropertyInspector(this.#deck.slidersReply(ev.action.id));
	}

	override onDialRotate(ev: DialRotateEvent<DialSettings>): void {
		const { ticks, pressed } = ev.payload;
		const mode = this.#deck.mode(ev.action.id, pressed);
		const result = this.#deck.rotate(ev.action.id, ticks, pressed);
		record("TICK", { col: ev.payload.coordinates.column, ticks, pressed, mode, result });
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
