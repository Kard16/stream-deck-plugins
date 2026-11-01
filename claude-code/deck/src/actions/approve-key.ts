import streamDeck, {
	action,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import type { ApproveKeys } from "../keys/approve.js";
import { svgDataUrl } from "../keys/art.js";
import { describeError } from "../util/log.js";

/** No settings yet. Never put the bridge token in action settings: profiles export them. */
export type ApproveSettings = Record<string, never>;

const logger = streamDeck.logger.createScope("ApproveKey");

function fireAndForget(what: string, call: () => Promise<void>): void {
	call().catch((err: unknown) => logger.warn(`${what} failed: ${describeError(err)}`));
}

/** The Approve key (spike S6). All behaviour lives in {@link ApproveKeys}; this class only maps SDK events onto it. */
@action({ UUID: "com.karimdhanji.claude.approve" })
export class ApproveKeyAction extends SingletonAction<ApproveSettings> {
	readonly #keys: ApproveKeys;

	constructor(keys: ApproveKeys) {
		super();
		this.#keys = keys;
	}

	override onWillAppear(ev: WillAppearEvent<ApproveSettings>): void {
		if (!ev.action.isKey()) return;
		const key: KeyAction<ApproveSettings> = ev.action;
		this.#keys.add(key.id, {
			setImage: (svg) => fireAndForget("setImage", () => key.setImage(svgDataUrl(svg))),
			showOk: () => fireAndForget("showOk", () => key.showOk()),
			showAlert: () => fireAndForget("showAlert", () => key.showAlert()),
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<ApproveSettings>): void {
		this.#keys.remove(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<ApproveSettings>): void {
		this.#keys.press(ev.action.id);
	}
}
