import {
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type KeyDownEvent,
	type KeyUpEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	action,
} from "@elgato/streamdeck";

import type { SlotActions } from "../slots/sdk.js";

/** A Session Slot takes its session from its place on the deck, so it has no settings. */
export type SlotSettings = Record<string, never>;

/**
 * The Session Slot, on a key or a dial (session-keys.md, The layout). All behaviour lives in SlotKeys and SlotDials;
 * {@link SlotActions} maps the SDK's events onto them, and this only hands it each one.
 */
@action({ UUID: "com.karimdhanji.claude.slot" })
export class SessionSlotAction extends SingletonAction<SlotSettings> {
	readonly #slots: SlotActions;

	constructor(slots: SlotActions) {
		super();
		this.#slots = slots;
	}

	override onWillAppear(ev: WillAppearEvent<SlotSettings>): void {
		if (ev.action.isKey()) this.#slots.appearKey(ev.action);
		else if (ev.action.isDial()) this.#slots.appearDial(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
		this.#slots.disappear(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<SlotSettings>): void {
		this.#slots.keyDown(ev.action.id);
	}

	override onKeyUp(ev: KeyUpEvent<SlotSettings>): void {
		this.#slots.keyUp(ev.action.id);
	}

	override onDialRotate(ev: DialRotateEvent<SlotSettings>): void {
		this.#slots.dialRotate(ev.action.id, ev.payload.ticks, ev.payload.pressed);
	}

	override onDialDown(ev: DialDownEvent<SlotSettings>): void {
		this.#slots.dialDown(ev.action.id);
	}

	override onDialUp(ev: DialUpEvent<SlotSettings>): void {
		this.#slots.dialUp(ev.action.id);
	}

	override onTouchTap(ev: TouchTapEvent<SlotSettings>): void {
		this.#slots.touchTap(ev.action.id, ev.payload.hold);
	}
}
