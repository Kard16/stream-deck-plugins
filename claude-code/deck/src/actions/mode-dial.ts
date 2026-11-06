import {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type FeedbackPayload,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	action,
} from "@elgato/streamdeck";

import type { ModeDials } from "../mode/dials.js";
import { countIdle } from "../util/idle.js";
import { fireAndForget } from "./shared.js";

/** The Mode dial acts on the target session, so it has no settings. */
export type ModeDialSettings = Record<string, never>;

/** The Mode dial. All behaviour lives in {@link ModeDials}; this only maps SDK events onto it. */
@action({ UUID: "com.karimdhanji.claude.mode" })
export class ModeDialAction extends SingletonAction<ModeDialSettings> {
	readonly #dials: ModeDials;

	constructor(dials: ModeDials) {
		super();
		this.#dials = dials;
	}

	override onWillAppear(ev: WillAppearEvent<ModeDialSettings>): void {
		if (!ev.action.isDial()) return;
		const dial: DialAction<ModeDialSettings> = ev.action;
		this.#dials.add(dial.id, {
			setFeedback: (payload) => {
				countIdle("send.feedback");
				fireAndForget("setFeedback", () => dial.setFeedback(payload as FeedbackPayload));
			},
			showAlert: () => fireAndForget("showAlert", () => dial.showAlert()),
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<ModeDialSettings>): void {
		this.#dials.remove(ev.action.id);
	}

	override onDialRotate(ev: DialRotateEvent<ModeDialSettings>): void {
		this.#dials.rotate(ev.action.id, ev.payload.ticks, ev.payload.pressed);
	}

	override onDialDown(ev: DialDownEvent<ModeDialSettings>): void {
		this.#dials.down(ev.action.id);
	}

	override onDialUp(ev: DialUpEvent<ModeDialSettings>): void {
		this.#dials.up(ev.action.id);
	}

	override onTouchTap(ev: TouchTapEvent<ModeDialSettings>): void {
		this.#dials.tap(ev.action.id, ev.payload.hold);
	}
}
