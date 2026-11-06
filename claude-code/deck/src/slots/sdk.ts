import { svgDataUrl } from "../keys/art.js";
import type { KeySurface } from "../keys/decision.js";
import { countIdle } from "../util/idle.js";
import { describeError, type Log, nullLog } from "../util/log.js";
import type { Feedback } from "../util/painter.js";
import type { SlotDials, SlotDialSurface } from "./dials.js";
import { dialSlotId, type SlotId, slotId } from "./ids.js";
import type { SlotKeys } from "./keys.js";
import type { OthersKeys } from "./others.js";

/**
 * What the Session Slot and Other Sessions actions do with the SDK's events (src/actions/slot.ts and others.ts), without
 * the SDK, so the tests can drive them with a fake: which slot a key or a dial has, what its surface calls, and which
 * event goes to which logic call. All the behaviour is SlotKeys', SlotDials' and OthersKeys'.
 */

/** What the wiring reads and calls on a key: the SDK's KeyAction fits it. */
export interface SdkKey {
	readonly id: string;
	readonly device: { readonly id: string };
	/** Undefined in a multi-action. */
	readonly coordinates: { readonly row: number; readonly column: number } | undefined;
	isInMultiAction(): boolean;
	setImage(image?: string): Promise<void>;
	showOk(): Promise<void>;
	showAlert(): Promise<void>;
}

/** What the wiring reads and calls on a dial: the SDK's DialAction fits it. */
export interface SdkDial {
	readonly id: string;
	readonly device: { readonly id: string; readonly size: { readonly rows: number } };
	readonly coordinates: { readonly row: number; readonly column: number };
	setFeedback(feedback: Feedback): Promise<void>;
	setFeedbackLayout(layout: string): Promise<void>;
	showAlert(): Promise<void>;
}

/** Runs one of the SDK's calls to the app without waiting for it: a failure is only logged. */
export type Fire = (what: string, call: () => Promise<void>) => void;

/** A Fire that logs a failed call at warn. */
export function firing(log: Log): Fire {
	return (what, call) => {
		try {
			call().catch((err: unknown) => log.warn(`${what} failed: ${describeError(err)}`));
		} catch (err) {
			log.warn(`${what} failed: ${describeError(err)}`);
		}
	};
}

/** A key's slot: its device, row and column; null in a multi-action, where a slot key has no place. */
export function keySlot(key: SdkKey): SlotId | null {
	if (key.isInMultiAction()) return null;
	const c = key.coordinates;
	return c === undefined ? null : slotId(key.device.id, c.row, c.column);
}

/** A dial's slot: the bottom row's key in its column, from the device's size (row 1 on a Stream Deck +). */
export function dialSlot(dial: SdkDial): SlotId {
	return dialSlotId(dial.device.id, dial.device.size.rows, dial.coordinates.column);
}

/** A key's surface for the logic classes: images go as SVG data URLs. */
export function keySurfaceOf(key: SdkKey, fire: Fire): KeySurface {
	return {
		setImage: (svg) => {
			countIdle("send.image");
			fire("setImage", () => key.setImage(svgDataUrl(svg)));
		},
		showOk: () => fire("showOk", () => key.showOk()),
		showAlert: () => fire("showAlert", () => key.showAlert()),
	};
}

/** A dial's surface for SlotDials: a layout goes with setFeedbackLayout, before the feedback that fills it. */
export function dialSurfaceOf(dial: SdkDial, fire: Fire): SlotDialSurface {
	return {
		setLayout: (layout) => {
			countIdle("send.layout");
			fire("setFeedbackLayout", () => dial.setFeedbackLayout(layout));
		},
		setFeedback: (payload) => {
			countIdle("send.feedback");
			fire("setFeedback", () => dial.setFeedback(payload));
		},
		showAlert: () => fire("showAlert", () => dial.showAlert()),
	};
}

/**
 * The Session Slot action, on keys and dials alike (one UUID, Controllers Keypad and Encoder):
 * - a key that appears joins its slot (keySlot; none in a multi-action, where it does nothing); its key-down and
 *   key-up go to SlotKeys, which tells a press (a jump) from a 500 ms hold (the session on screen in the app);
 * - a dial that appears joins the slot of the key above it (dialSlot); its turns, push (down and up) and touch go to
 *   SlotDials, a tap as a press and a long touch as a step back;
 * - whichever disappears leaves its slot, which keeps its session.
 */
export class SlotActions {
	readonly #keys: SlotKeys;
	readonly #dials: SlotDials;
	readonly #fire: Fire;
	readonly #log: Log;

	constructor(keys: SlotKeys, dials: SlotDials, opts: { fire?: Fire; log?: Log } = {}) {
		this.#keys = keys;
		this.#dials = dials;
		this.#log = opts.log ?? nullLog;
		this.#fire = opts.fire ?? firing(this.#log);
	}

	appearKey(key: SdkKey): void {
		const slot = keySlot(key);
		if (slot === null) this.#log.info(`Session Slot key ${key.id}: in a multi-action it has no slot, so it does nothing`);
		this.#keys.add(key.id, slot, keySurfaceOf(key, this.#fire));
	}

	appearDial(dial: SdkDial): void {
		this.#dials.add(dial.id, dialSlot(dial), dialSurfaceOf(dial, this.#fire));
	}

	/** A key or a dial went: the id is one or the other, and removing it from the other does nothing. */
	disappear(id: string): void {
		this.#keys.remove(id);
		this.#dials.remove(id);
	}

	keyDown(id: string): void {
		this.#keys.down(id);
	}

	keyUp(id: string): void {
		this.#keys.up(id);
	}

	dialRotate(id: string, ticks: number, pressed: boolean): void {
		this.#dials.rotate(id, ticks, pressed);
	}

	dialDown(id: string): void {
		this.#dials.down(id);
	}

	dialUp(id: string): void {
		this.#dials.up(id);
	}

	/** A tap is a press, the touch alternative for a dial stack that takes the press; a long touch goes back a step. */
	touchTap(id: string, hold: boolean): void {
		this.#dials.tap(id, hold);
	}
}

/** The Other Sessions action, on keys: it shows OthersKeys' look, and a press jumps or alerts. */
export class OthersActions {
	readonly #others: OthersKeys;
	readonly #fire: Fire;

	constructor(others: OthersKeys, opts: { fire?: Fire; log?: Log } = {}) {
		this.#others = others;
		this.#fire = opts.fire ?? firing(opts.log ?? nullLog);
	}

	appear(key: SdkKey): void {
		this.#others.add(key.id, keySurfaceOf(key, this.#fire));
	}

	disappear(id: string): void {
		this.#others.remove(id);
	}

	keyDown(id: string): void {
		this.#others.press(id);
	}
}
