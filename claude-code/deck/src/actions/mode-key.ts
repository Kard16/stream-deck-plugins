import {
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	action,
} from "@elgato/streamdeck";

import type { ModeKeys, ModeKeySettings } from "../keys/commands.js";
import { keySurface } from "./shared.js";

/** Set in pi/mode.html: one of `default`, `acceptEdits`, `plan` or `auto`. */
export type ModeKeyActionSettings = ModeKeySettings;

/** The Mode key. All behaviour lives in {@link ModeKeys}; this only maps SDK events onto it. */
@action({ UUID: "com.karimdhanji.claude.set-mode" })
export class ModeKeyAction extends SingletonAction<ModeKeyActionSettings> {
	readonly #keys: ModeKeys;

	constructor(keys: ModeKeys) {
		super();
		this.#keys = keys;
	}

	override onWillAppear(ev: WillAppearEvent<ModeKeyActionSettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action.id, keySurface(ev.action), ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<ModeKeyActionSettings>): void {
		this.#keys.remove(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ModeKeyActionSettings>): void {
		this.#keys.setSettings(ev.action.id, ev.payload.settings);
	}

	override onKeyDown(ev: KeyDownEvent<ModeKeyActionSettings>): void {
		this.#keys.press(ev.action.id, ev.payload.settings);
	}
}
