import type { KeySurface } from "../keys/decision.js";
import type { SessionView } from "../model/sessions.js";
import { type Clock, realClock } from "../util/clock.js";
import { describeError, type Log, nullLog } from "../util/log.js";
import { KeyPainter, PAINT_INTERVAL_MS } from "../util/painter.js";
import { type JumpModel, jumpTo } from "./jump.js";
import type { Slots } from "./slots.js";

/**
 * What the Others key shows (session-keys.md, Others), over the running sessions on no slot: those with an app id,
 * not archived.
 * - `needing`: how many need you (`need` not null); `oldest`, the one that has waited longest (the earliest `since`),
 *   with its title and `since`; null with none.
 * - `unseen`: how many ended a turn the user hasn't seen (`seen` false).
 * - `running`: how many there are in all; `others`, how many of those neither need you nor are unseen.
 * - `now`: the wall-clock time to show `since` against.
 * With none needing you, the key is dim and says how many other sessions are running.
 */
export type OthersLook = {
	readonly needing: number;
	readonly oldest: SessionView | null;
	readonly unseen: number;
	readonly running: number;
	readonly others: number;
	readonly now: number;
};

/** Draws the Others key: a 144-unit SVG. The surfaces' code supplies it. */
export type OthersArt = (look: OthersLook) => string;

/** The Others key's counts, from the sessions and the hosts on a slot. */
export function othersLook(sessions: readonly SessionView[], slotted: ReadonlySet<string>, now: number): OthersLook {
	const off = sessions.filter((s) => s.host !== null && s.running && !s.archived && !slotted.has(s.host));
	const needing = off.filter((s) => s.need !== null);
	let oldest: SessionView | null = null;
	for (const s of needing) {
		if (oldest === null || (s.since ?? Infinity) < (oldest.since ?? Infinity)) oldest = s;
	}
	const unseen = off.filter((s) => s.need === null && s.seen === false).length;
	return { needing: needing.length, oldest, unseen, running: off.length, others: off.length - needing.length - unseen, now };
}

/** What Others needs from the session model (SessionModel implements it). */
export interface OthersModel extends JumpModel {
	sessions(): SessionView[];
	/** Whether `who` shows `seen` on the deck now: the front-app check runs only while something does. */
	showsSeen(who: object, shows: boolean): void;
}

type Key = { surface: KeySurface; painter: KeyPainter<string | null> };

/**
 * The Others keys, without the SDK (session-keys.md, Others): the running sessions on no slot. A press jumps to the
 * one that has waited longest and makes it the target (jumpTo); with none needing you, it alerts. A press acts only on
 * the session the key showed: when the longest waiting is another one now, or the key hasn't painted yet, it alerts
 * and does nothing. While it has keys, it tells the model that something shows `seen` (the unseen count), and the slots
 * that something shows the one waiting longest, whose `since` then times their repaint tick (hardening.md, B6). It
 * repaints whenever the slots change, that tick's included.
 */
export class OthersKeys {
	readonly #slots: Slots;
	readonly #model: OthersModel;
	readonly #art: OthersArt;
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	readonly #log: Log;
	readonly #open: (host: string) => void;
	readonly #paintIntervalMs: number;
	readonly #keys = new Map<string, Key>();

	constructor(
		slots: Slots,
		model: OthersModel,
		opts: { art: OthersArt; clock?: Clock; wallNow?: () => number; log?: Log; open?: (host: string) => void; paintIntervalMs?: number },
	) {
		this.#slots = slots;
		this.#model = model;
		this.#art = opts.art;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#log = opts.log ?? nullLog;
		this.#open = opts.open ?? (() => {});
		this.#paintIntervalMs = opts.paintIntervalMs ?? PAINT_INTERVAL_MS;
		slots.onChange(() => this.repaintAll());
	}

	add(id: string, surface: KeySurface): void {
		this.remove(id);
		const key: Key = { surface, painter: new KeyPainter<string | null>((svg) => surface.setImage(svg), { clock: this.#clock, minIntervalMs: this.#paintIntervalMs }) };
		this.#keys.set(id, key);
		this.#model.showsSeen(this, true);
		this.#slots.showsOthers(this, true);
		this.#paint(key);
	}

	remove(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		key.painter.dispose();
		this.#keys.delete(id);
		this.#model.showsSeen(this, this.#keys.size > 0);
		this.#slots.showsOthers(this, this.#keys.size > 0);
	}

	press(id: string): void {
		const key = this.#keys.get(id);
		if (!key) return;
		const { oldest } = this.look();
		const host = oldest?.host ?? null;
		// The session the key's image showed as waiting longest; undefined only before its first paint.
		const shown = key.painter.shown;
		if (shown !== host) {
			this.#log.info(`Others: press: nothing done: the key showed ${shown === undefined ? "nothing yet" : (shown ?? "none needing you")}, but the one waiting longest is ${host ?? "none"} now`);
			key.surface.showAlert();
			return;
		}
		if (oldest === null || host === null) {
			this.#log.info("Others: press: no session off the slots needs you");
			key.surface.showAlert();
			return;
		}
		jumpTo(this.#model, host, this.#open, "the Others key", this.#log, oldest.title);
	}

	look(): OthersLook {
		return othersLook(this.#model.sessions(), this.#slots.slotted(), this.#wallNow());
	}

	repaintAll(): void {
		if (this.#keys.size === 0) return;
		const drawn = this.#draw();
		if (drawn === null) return;
		for (const key of this.#keys.values()) key.painter.update(drawn.svg, drawn.shown);
	}

	painted(id: string): string | null {
		return this.#keys.get(id)?.painter.svg ?? null;
	}

	#paint(key: Key): void {
		const drawn = this.#draw();
		if (drawn !== null) key.painter.update(drawn.svg, drawn.shown);
	}

	/** The face for the sessions as they are now, and the one it shows as waiting longest; null when drawing threw. */
	#draw(): { svg: string; shown: string | null } | null {
		try {
			const look = this.look();
			return { svg: this.#art(look), shown: look.oldest?.host ?? null };
		} catch (err) {
			this.#log.error(`Others: drawing its face threw: ${describeError(err)}`);
			return null;
		}
	}
}
