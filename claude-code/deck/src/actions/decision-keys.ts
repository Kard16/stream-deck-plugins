import { type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, action } from "@elgato/streamdeck";

import type { DecisionKeys } from "../keys/decision.js";
import { keySurface } from "./shared.js";

/** Approve and Deny take no settings. Never put the bridge token in action settings: profiles export them. */
export type DecisionSettings = Record<string, never>;

/** The SDK side of Approve and Deny. All behaviour lives in {@link DecisionKeys}; this only maps SDK events onto it. */
abstract class DecisionKeyAction extends SingletonAction<DecisionSettings> {
	readonly #keys: DecisionKeys;

	constructor(keys: DecisionKeys) {
		super();
		this.#keys = keys;
	}

	override onWillAppear(ev: WillAppearEvent<DecisionSettings>): void {
		if (!ev.action.isKey()) return;
		const key: KeyAction<DecisionSettings> = ev.action;
		this.#keys.add(key.id, keySurface(key));
	}

	override onWillDisappear(ev: WillDisappearEvent<DecisionSettings>): void {
		this.#keys.remove(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<DecisionSettings>): void {
		this.#keys.press(ev.action.id);
	}
}

/** The Approve key, on the deck since spike S6: its UUID stays. */
@action({ UUID: "com.karimdhanji.claude.approve" })
export class ApproveKeyAction extends DecisionKeyAction {}

@action({ UUID: "com.karimdhanji.claude.deny" })
export class DenyKeyAction extends DecisionKeyAction {}
