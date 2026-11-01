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

import type { SessionsDials } from "../sessions/dials.js";
import { describeError } from "../util/log.js";

/** The dial lists every session from the registry, so it has no settings. */
export type SessionsSettings = Record<string, never>;

const logger = streamDeck.logger.createScope("SessionsDial");

function fireAndForget(what: string, call: () => Promise<void>): void {
	call().catch((err: unknown) => logger.warn(`${what} failed: ${describeError(err)}`));
}

/** The Sessions dial. All behaviour lives in {@link SessionsDials}; this class only maps SDK events onto it. */
@action({ UUID: "com.karimdhanji.claude.sessions" })
export class SessionsDialAction extends SingletonAction<SessionsSettings> {
	readonly #dials: SessionsDials;

	constructor(dials: SessionsDials) {
		super();
		this.#dials = dials;
	}

	override onWillAppear(ev: WillAppearEvent<SessionsSettings>): void {
		if (!ev.action.isDial()) return;
		const dial: DialAction<SessionsSettings> = ev.action;
		this.#dials.add(dial.id, {
			setFeedback: (payload) => fireAndForget("setFeedback", () => dial.setFeedback(payload as FeedbackPayload)),
			showAlert: () => fireAndForget("showAlert", () => dial.showAlert()),
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<SessionsSettings>): void {
		this.#dials.remove(ev.action.id);
	}

	override onDialRotate(ev: DialRotateEvent<SessionsSettings>): void {
		this.#dials.rotate(ev.action.id, ev.payload.ticks, ev.payload.pressed);
	}

	override onDialDown(ev: DialDownEvent<SessionsSettings>): void {
		this.#dials.down(ev.action.id);
	}

	override onDialUp(ev: DialUpEvent<SessionsSettings>): void {
		this.#dials.up(ev.action.id);
	}

	override onTouchTap(ev: TouchTapEvent<SessionsSettings>): void {
		this.#dials.tap(ev.action.id, ev.payload.hold);
	}
}
