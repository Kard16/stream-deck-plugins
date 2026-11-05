import { type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, action } from "@elgato/streamdeck";

import type { OthersActions } from "../slots/sdk.js";

/** Other Sessions counts the sessions on no slot, so it has no settings. */
export type OthersSettings = Record<string, never>;

/**
 * Other Sessions, on keys (session-keys.md, Others). All behaviour lives in OthersKeys; {@link OthersActions} maps the
 * SDK's events onto it, and this only hands it each one.
 */
@action({ UUID: "com.karimdhanji.claude.others" })
export class OthersKeyAction extends SingletonAction<OthersSettings> {
	readonly #others: OthersActions;

	constructor(others: OthersActions) {
		super();
		this.#others = others;
	}

	override onWillAppear(ev: WillAppearEvent<OthersSettings>): void {
		if (ev.action.isKey()) this.#others.appear(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<OthersSettings>): void {
		this.#others.disappear(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<OthersSettings>): void {
		this.#others.keyDown(ev.action.id);
	}
}
