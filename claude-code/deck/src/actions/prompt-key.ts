import {
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	action,
} from "@elgato/streamdeck";

import type { PromptKeys, PromptSettings } from "../keys/commands.js";
import { keySurface } from "./shared.js";

/** Set in pi/prompt.html: the prompt, and an optional short label for the key. */
export type PromptKeySettings = PromptSettings;

/** The Saved Prompt key. All behaviour lives in {@link PromptKeys}; this only maps SDK events onto it. */
@action({ UUID: "com.karimdhanji.claude.prompt" })
export class PromptKeyAction extends SingletonAction<PromptKeySettings> {
	readonly #keys: PromptKeys;

	constructor(keys: PromptKeys) {
		super();
		this.#keys = keys;
	}

	override onWillAppear(ev: WillAppearEvent<PromptKeySettings>): void {
		if (!ev.action.isKey()) return;
		this.#keys.add(ev.action.id, keySurface(ev.action), ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<PromptKeySettings>): void {
		this.#keys.remove(ev.action.id);
	}

	/** SDK 3 sends this only when the user edits the Property Inspector. */
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PromptKeySettings>): void {
		this.#keys.setSettings(ev.action.id, ev.payload.settings);
	}

	/** The press carries the key's settings, so the text sent is the one saved now. */
	override onKeyDown(ev: KeyDownEvent<PromptKeySettings>): void {
		this.#keys.press(ev.action.id, ev.payload.settings);
	}
}
