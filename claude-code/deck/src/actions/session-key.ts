import { type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, action } from "@elgato/streamdeck";

import type { SessionKeys } from "../keys/session.js";
import { keySurface } from "./shared.js";

/** The Session key shows the target session, so it has no settings. */
export type SessionKeySettings = Record<string, never>;

/** The Session key. All behaviour lives in {@link SessionKeys}; this only maps SDK events onto it. */
@action({ UUID: "com.karimdhanji.claude.session" })
export class SessionKeyAction extends SingletonAction<SessionKeySettings> {
	readonly #keys: SessionKeys;

	constructor(keys: SessionKeys) {
		super();
		this.#keys = keys;
	}

	override onWillAppear(ev: WillAppearEvent<SessionKeySettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action.id, keySurface(ev.action));
	}

	override onWillDisappear(ev: WillDisappearEvent<SessionKeySettings>): void {
		this.#keys.remove(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<SessionKeySettings>): void {
		this.#keys.press(ev.action.id);
	}
}
