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

import { BANKS, slotAt } from "../banks";

/** A dial takes its slider from its column and the shared bank, so it has no settings. */
type DialSettings = Record<string, never>;

// S4 spike: values are local and fake until the Lightroom client exists (Track B).
const VALUE_MIN = -100;
const VALUE_MAX = 100;
/** Push + turn moves in quarter steps. */
const FINE = 0.25;
/** At most 15 strip updates a second per dial. */
const PAINT_INTERVAL_MS = Math.ceil(1000 / 15);

type Dial = {
	action: DialAction<DialSettings>;
	column: number;
	value: number;
	/** Set when the dial turned while held, so the release isn't treated as a reset press. */
	turnedWhilePressed: boolean;
	/** Strip keys as last sent, so each update carries only what changed. */
	painted: Record<string, string | number>;
	lastPaint: number;
	timer?: NodeJS.Timeout;
};

const logger = streamDeck.logger.createScope("DevelopDial");

/** Shared bank index: all four dials page together. */
let bank = 0;

/** Spike instrumentation: one line per input event, parsed by spikes/s4-ticks/analyze.mjs. */
function record(kind: "TICK" | "INPUT", data: Record<string, unknown>): void {
	logger.info(`${kind} ${JSON.stringify({ t: Date.now(), hr: Math.round(performance.now() * 1000) / 1000, ...data })}`);
}

function clamp(v: number): number {
	return Math.min(VALUE_MAX, Math.max(VALUE_MIN, v));
}

function formatValue(v: number): string {
	const text = Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2);
	return v > 0 ? `+${text}` : text;
}

@action({ UUID: "com.karimdhanji.lightroom.dial" })
export class DevelopDial extends SingletonAction<DialSettings> {
	readonly #dials = new Map<string, Dial>();
	readonly #devicesSeen = new Set<string>();

	override onWillAppear(ev: WillAppearEvent<DialSettings>): void {
		if (!ev.action.isDial()) return;
		const device = ev.action.device;
		if (!this.#devicesSeen.has(device.id)) {
			this.#devicesSeen.add(device.id);
			logger.info(`DEVICE ${JSON.stringify({ id: device.id, name: device.name, type: device.type, size: device.size })}`);
		}
		const dial = this.#dial(ev.action);
		dial.painted = {}; // a fresh appearance needs every key
		this.#schedulePaint(dial);
	}

	override onWillDisappear(ev: WillDisappearEvent<DialSettings>): void {
		const dial = this.#dials.get(ev.action.id);
		if (dial?.timer) clearTimeout(dial.timer);
		this.#dials.delete(ev.action.id);
	}

	override onDialRotate(ev: DialRotateEvent<DialSettings>): void {
		const { ticks, pressed } = ev.payload;
		record("TICK", { col: ev.payload.coordinates.column, ticks, pressed });
		const dial = this.#dial(ev.action);
		if (pressed) dial.turnedWhilePressed = true;
		if (!slotAt(bank, dial.column)) return;
		dial.value = clamp(dial.value + ticks * (pressed ? FINE : 1));
		this.#schedulePaint(dial);
	}

	override onDialDown(ev: DialDownEvent<DialSettings>): void {
		record("INPUT", { ev: "dialDown", col: ev.payload.coordinates.column });
		this.#dial(ev.action).turnedWhilePressed = false;
	}

	override onDialUp(ev: DialUpEvent<DialSettings>): void {
		const dial = this.#dial(ev.action);
		record("INPUT", { ev: "dialUp", col: ev.payload.coordinates.column, turned: dial.turnedWhilePressed });
		if (!dial.turnedWhilePressed) this.#reset(dial);
	}

	override onTouchTap(ev: TouchTapEvent<DialSettings>): void {
		const { hold, tapPos } = ev.payload;
		record("INPUT", { ev: "touchTap", col: ev.payload.coordinates.column, hold, tapPos });
		if (hold) {
			this.#reset(this.#dial(ev.action));
			return;
		}
		bank = (bank + 1) % BANKS.length;
		for (const dial of this.#dials.values()) this.#schedulePaint(dial);
	}

	#dial(action: DialAction<DialSettings>): Dial {
		let dial = this.#dials.get(action.id);
		if (!dial) {
			dial = { action, column: action.coordinates.column, value: 0, turnedWhilePressed: false, painted: {}, lastPaint: 0 };
			this.#dials.set(action.id, dial);
		}
		dial.action = action;
		dial.column = action.coordinates.column;
		return dial;
	}

	#reset(dial: Dial): void {
		dial.value = 0;
		this.#schedulePaint(dial);
	}

	#schedulePaint(dial: Dial): void {
		if (dial.timer) return; // the pending paint will pick up the latest state
		const wait = Math.max(0, dial.lastPaint + PAINT_INTERVAL_MS - Date.now());
		dial.timer = setTimeout(() => {
			dial.timer = undefined;
			dial.lastPaint = Date.now();
			this.#paint(dial);
		}, wait);
	}

	#paint(dial: Dial): void {
		const slot = slotAt(bank, dial.column);
		const next: Record<string, string | number> = {
			label: slot ? slot.label : "—",
			bank: `${bank + 1}/${BANKS.length}`,
			value: slot ? formatValue(dial.value) : "",
			bar: slot ? dial.value : 0,
		};
		const changed: FeedbackPayload = {};
		for (const [key, v] of Object.entries(next)) {
			if (dial.painted[key] !== v) changed[key] = v;
		}
		if (Object.keys(changed).length === 0) return;
		Object.assign(dial.painted, changed);
		dial.action.setFeedback(changed).catch((err: unknown) => logger.warn(`setFeedback failed: ${String(err)}`));
	}
}
