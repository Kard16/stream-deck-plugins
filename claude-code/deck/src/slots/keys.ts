import type { KeySurface } from "../keys/decision.js";
import type { SessionView } from "../model/sessions.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { describeError, type Log, nullLog } from "../util/log.js";
import { KeyPainter, type Live, PAINT_INTERVAL_MS } from "../util/painter.js";
import type { SlotId } from "./ids.js";
import { type JumpModel, jumpTo } from "./jump.js";
import type { Slots } from "./slots.js";

/** How long a press on a slot key must be held to put the session on screen in the app on it. */
export const HOLD_MS = 500;

/**
 * What one Session Slot key shows (session-keys.md, The key face): its slot, the session on it (null: none, an empty
 * slot), and the wall-clock time to show its `since` against (format.ts's sinceText). The face goes by the session's
 * `running`, `need`, `status` and `seen`.
 */
export type SlotKeyLook = { readonly slot: SlotId; readonly session: SessionView | null; readonly now: number };

/** Draws a key's face: a 144-unit SVG (src/keys/art.ts's style). The surfaces' code supplies it. */
export type SlotKeyArt = (look: SlotKeyLook) => string;

/** What the slot keys need from the session model (SessionModel implements it). */
export interface SlotKeysModel extends JumpModel {
	slotView(host: string): SessionView | null;
	/** Whether `who` shows `seen` on the deck now: the front-app check runs only while something does. */
	showsSeen(who: object, shows: boolean): void;
}

export type SlotKeysOptions = {
	art: SlotKeyArt;
	clock?: Clock;
	/** Wall-clock ms, for `since`. */
	wallNow?: () => number;
	log?: Log;
	/** Opens `claude://code/continue?session=<host>` (plugin.ts's openSession). */
	open?: (host: string) => void;
	paintIntervalMs?: number;
	holdMs?: number;
	/** Whether a Stream Deck is connected; the keys' painters send nothing while none is (agents-and-wake.md, C3). */
	live?: Live;
};

type Key = {
	/** Null in a multi-action, where a slot key has no place: it does nothing. */
	slot: SlotId | null;
	surface: KeySurface;
	painter: KeyPainter<string | null>;
	down: boolean;
	/**
	 * The session the key's image showed at its key-down (undefined: no paint yet), which the press at the key-up acts
	 * on. A repaint in between can't stand in for it: plugin.ts's press handler, which runs after the key-down, repaints
	 * every key when the press shows the deck a device it had as away (Devices' `pressed`).
	 */
	shownAtDown: string | null | undefined;
	holdTimer: TimerHandle | null;
	/** The hold fired: the key-up after it does nothing. */
	held: boolean;
};

/**
 * The Session Slot keys, without the SDK (session-keys.md, Slots). Each shows the session on its slot. A press jumps
 * to that session in the app and makes it the target (jumpTo); an empty slot alerts. A press acts only on the session
 * the key showed at its key-down: one that came onto the slot since, or a press before its first paint, alerts and
 * does nothing, even when a repaint before the key-up shows it. Held HOLD_MS, it puts the session on screen in the app
 * on its slot, swapping with the slot that one was on (Slots' `takeOnScreen`), and shows OK, or an alert when no
 * session is known to be on screen; the key-up after it does nothing. While it has a key with a slot, it tells the
 * model that something shows `seen` (the key face does).
 * It repaints whenever the slots change, which they also do when a `since` the keys show next reads differently (Slots'
 * repaint tick, hardening.md B6).
 *
 * The SDK wrapper calls `add` on willAppear with the key's slot (slotId of its device and coordinates; null in a
 * multi-action), `remove` on willDisappear, and `down` and `up` on keyDown and keyUp. `add` and `remove` tell the slots
 * the slot is showing or not.
 */
export class SlotKeys {
	readonly #slots: Slots;
	readonly #model: SlotKeysModel;
	readonly #art: SlotKeyArt;
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	readonly #log: Log;
	readonly #open: (host: string) => void;
	readonly #paintIntervalMs: number;
	readonly #holdMs: number;
	readonly #live: Live | undefined;
	readonly #keys = new Map<string, Key>();

	constructor(slots: Slots, model: SlotKeysModel, opts: SlotKeysOptions) {
		this.#slots = slots;
		this.#model = model;
		this.#art = opts.art;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#log = opts.log ?? nullLog;
		this.#open = opts.open ?? (() => {});
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		this.#holdMs = opts.holdMs ?? HOLD_MS;
		this.#live = opts.live;
		slots.onChange(() => this.repaintAll());
	}

	add(id: string, slot: SlotId | null, surface: KeySurface): void {
		this.remove(id);
		const key: Key = {
			slot,
			surface,
			painter: new KeyPainter<string | null>((svg) => surface.setImage(svg), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs, live: this.#live }),
			down: false,
			shownAtDown: undefined,
			holdTimer: null,
			held: false,
		};
		this.#keys.set(id, key);
		this.#showsSeen();
		if (slot !== null) this.#slots.appear(slot, id);
		this.#paint(key);
	}

	remove(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		if (key.holdTimer !== null) this.#clock.clearTimeout(key.holdTimer);
		key.painter.dispose();
		this.#keys.delete(id);
		this.#showsSeen();
		if (key.slot !== null) this.#slots.disappear(key.slot, id);
	}

	down(id: string): void {
		const key = this.#keys.get(id);
		if (!key || key.slot === null) return;
		if (key.holdTimer !== null) this.#clock.clearTimeout(key.holdTimer);
		key.down = true;
		key.shownAtDown = key.painter.shown;
		key.held = false;
		key.holdTimer = this.#clock.setTimeout(() => {
			key.holdTimer = null;
			if (!key.down) return;
			key.held = true;
			this.#hold(key);
		}, this.#holdMs);
	}

	up(id: string): void {
		const key = this.#keys.get(id);
		if (!key || !key.down) return;
		key.down = false;
		if (key.holdTimer !== null) this.#clock.clearTimeout(key.holdTimer);
		key.holdTimer = null;
		if (key.held) {
			key.held = false;
			return;
		}
		this.#press(key);
	}

	repaintAll(): void {
		for (const key of this.#keys.values()) this.#paint(key);
	}

	/** A device connected, or the Mac woke: every key sends its image again, the same one too (agents-and-wake.md, C2). */
	repaintInFull(): void {
		for (const key of this.#keys.values()) key.painter.forget();
		this.repaintAll();
	}

	/** What a key shows now, for tests and painters. */
	look(id: string): SlotKeyLook | null {
		const key = this.#keys.get(id);
		return key ? this.#look(key) : null;
	}

	/** The SVG a key last sent, for tests. */
	painted(id: string): string | null {
		return this.#keys.get(id)?.painter.svg ?? null;
	}

	#press(key: Key): void {
		if (key.slot === null) return;
		const host = this.#slots.host(key.slot);
		// The session the key's image showed when pressed down; undefined only before its first paint.
		const shown = key.shownAtDown;
		if (shown !== host) {
			this.#log.info(`slot key ${key.slot}: press: nothing done: the key showed ${shown === undefined ? "nothing yet" : (shown ?? "no session")}, but the slot holds ${host ?? "none"} now`);
			key.surface.showAlert();
			return;
		}
		if (host === null) {
			this.#log.info(`slot key ${key.slot}: press: no session on the slot`);
			key.surface.showAlert();
			return;
		}
		jumpTo(this.#model, host, this.#open, `slot key ${key.slot}`, this.#log, this.#model.slotView(host)?.title);
	}

	#hold(key: Key): void {
		if (key.slot === null) return;
		const result = this.#slots.takeOnScreen(key.slot);
		if (result.ok) key.surface.showOk();
		else key.surface.showAlert();
	}

	#look(key: Key): SlotKeyLook {
		const slot = key.slot ?? "";
		const host = key.slot === null ? null : this.#slots.host(key.slot);
		return { slot, session: host === null ? null : this.#model.slotView(host), now: this.#wallNow() };
	}

	#paint(key: Key): void {
		let look: SlotKeyLook;
		let svg: string;
		try {
			look = this.#look(key);
			svg = this.#art(look);
		} catch (err) {
			this.#log.error(`slot key ${key.slot ?? "in a multi-action"}: drawing its face threw: ${describeError(err)}`);
			return;
		}
		key.painter.update(svg, look.session?.host ?? null);
	}

	/** The key face shows `seen`, so the model's front-app check runs while there's a key with a slot. */
	#showsSeen(): void {
		let any = false;
		for (const key of this.#keys.values()) any ||= key.slot !== null;
		this.#model.showsSeen(this, any);
	}
}
