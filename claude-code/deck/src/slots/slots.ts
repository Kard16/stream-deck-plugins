import { sinceChangesAt } from "../model/format.js";
import type { SessionView } from "../model/sessions.js";
import { asHost } from "../protocol/wire.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";
import { Ticker } from "../util/ticker.js";
import { compareSlots, parseSlotId, type SlotId } from "./ids.js";
import { othersLook } from "./others.js";
import { MemorySlotStore, type SlotStore } from "./store.js";

/**
 * How long a slot that appears waits before it fills, so the slots of a page, whose willAppear events come one at a
 * time, fill together in slot order. A change to the model fills at once.
 */
export const FILL_DELAY_MS = 100;

/** What the slots need from the session model (SessionModel implements it). */
export interface SlotsModel {
	/** The running sessions: the fill takes from these. */
	sessions(): SessionView[];
	/** A slotted session's view, running or not: its `archived` frees the slot. */
	slotView(host: string): SessionView | null;
	/** The session on screen in the app, which a long press takes; null when none is known to be. */
	onScreen(): SessionView | null;
	/** Whether the registry's latest reading lists the host. */
	isListed(host: string): boolean;
	/** Whether the registry has been read at least once. */
	readonly registryRead: boolean;
	/** Whether the latest records scan looked for the host's file and found none. */
	recordMissing(host: string): boolean;
	/** The hosts whose records, and views, the model keeps while the registry doesn't list them. */
	keepHosts(hosts: Iterable<string>): void;
	/** The wall clock the views' times are on: the repaint tick reads their `since`s against it. */
	wallNow(): number;
	onChange(listener: () => void): () => void;
}

/**
 * What a long press, or `place`, did: `host` is on `slot` now; `from` is the slot it came from, which now holds the
 * session that was on `slot` (null: the session wasn't on a slot); `replaced` is the session that was on `slot` and
 * is now on none (null: there was none, or it moved to `from`).
 */
export type PlaceResult = { ok: true; host: string; from: SlotId | null; replaced: string | null } | { ok: false; why: string };

/**
 * The Session Slots (session-keys.md, Slots): which session each slot holds, shared by its key and its dial. A session
 * is on at most one slot.
 * - **Showing:** a slot is showing while one of its keys or dials appears (`appear` on willAppear, `disappear` on
 *   willDisappear). Only a showing slot fills, but every slot keeps its session while hidden.
 * - **Fill:** a showing slot with no session takes a running session (in the registry, with a host, not archived) on no
 *   slot: one that needs you first, the one waiting longest (its `since`); otherwise the newest by `startedAt`. Empty
 *   slots fill bottom row first, left to right (compareSlots). A slot that appears fills FILL_DELAY_MS later, with any
 *   others that appeared meanwhile, or at the next change to the model if that comes first.
 * - **Stay put:** a slot keeps its session until its app record says `isArchived`; or until no record file exists for
 *   it and the registry doesn't list it (both known: the registry read, and a records scan that looked); or until a
 *   long press puts another session there. A session that isn't running stays, as "not running".
 * - **Long press** (`takeOnScreen`): the slot takes the session on screen in the app; if that one is on another slot,
 *   the two swap.
 * - **Saved** through the store on every change, and loaded at start.
 *
 * `onChange` fires after every change to the slots and after every change to the model, once the slots have caught
 * up with it, so a listener always sees the slots and the sessions agree. It also fires on the slots' one repaint tick
 * (hardening.md, B6), when a `since` the slot keys, the slot dials or Others show next reads differently: the earliest
 * such moment over the running sessions on a showing slot and, while an Others key shows (`showsOthers`), the one
 * waiting longest off the slots. Nothing else they show changes with the time, so they repaint then and at no other
 * time. The tick runs only while a Stream Deck is connected (`setDeckConnected`).
 */
export class Slots {
	readonly #model: SlotsModel;
	readonly #store: SlotStore;
	readonly #log: Log;
	readonly #listeners = new Set<() => void>();
	/** Slot → host. */
	readonly #hosts: Map<SlotId, string>;
	/** Slot → the keys and dials showing it, by their action ids. */
	readonly #showing = new Map<SlotId, Set<string>>();
	readonly #clock: Clock;
	readonly #fillDelayMs: number;
	#fillTimer: TimerHandle | null = null;
	#refreshing = false;
	/** The Others keys that show now (`showsOthers`). */
	readonly #othersShown = new Set<object>();
	/** The repaint tick, at the next moment a `since` the slots' keys, dials or Others show reads differently. */
	readonly #ticker: Ticker;
	/** Whether a Stream Deck is connected: the tick runs only while one is (agents-and-wake.md, C3). */
	#deckConnected = true;

	/** `fillDelayMs`: FILL_DELAY_MS; 0 fills a slot as it appears. */
	constructor(model: SlotsModel, opts: { store?: SlotStore; log?: Log; clock?: Clock; fillDelayMs?: number } = {}) {
		this.#model = model;
		this.#store = opts.store ?? new MemorySlotStore();
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#fillDelayMs = opts.fillDelayMs ?? FILL_DELAY_MS;
		this.#ticker = new Ticker(this.#clock, () => this.#emit(), { wallNow: () => this.#model.wallNow(), log: this.#log, what: "the slots' repaint tick" });
		this.#hosts = this.#store.load();
		if (this.#hosts.size > 0) this.#log.info(`SLOTS loaded: ${[...this.#hosts].map(([slot, host]) => `${slot} ${host}`).join(", ")}`);
		this.#model.keepHosts(this.#hosts.values());
		model.onChange(() => this.refresh());
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** A key or dial (`who`, its action id) shows `slot` now. An id that isn't a slot's does nothing. */
	appear(slot: SlotId, who: string): void {
		if (parseSlotId(slot) === null) {
			this.#log.warn(`appear: ${quote(slot, 80)} isn't a slot id`);
			return;
		}
		const set = this.#showing.get(slot) ?? new Set<string>();
		set.add(who);
		this.#showing.set(slot, set);
		if (this.host(slot) !== null || !(this.#fillDelayMs > 0)) {
			this.refresh();
			return;
		}
		// Empty: it fills with the others that appear meanwhile, in slot order.
		this.#emit();
		if (this.#fillTimer !== null) return;
		this.#fillTimer = this.#clock.setTimeout(() => {
			this.#fillTimer = null;
			this.refresh();
		}, this.#fillDelayMs);
	}

	/** Stops the fill's timer and the repaint tick. */
	dispose(): void {
		if (this.#fillTimer !== null) this.#clock.clearTimeout(this.#fillTimer);
		this.#fillTimer = null;
		this.#ticker.stop();
	}

	/** Whether `who` (the Others keys) shows the sessions on no slot now: their longest waiting's `since` times the tick. */
	showsOthers(who: object, shows: boolean): void {
		const before = this.#othersShown.size > 0;
		if (shows) this.#othersShown.add(who);
		else this.#othersShown.delete(who);
		if ((this.#othersShown.size > 0) !== before) this.#schedule();
	}

	/** When the repaint tick is due, wall-clock ms; null for none: nothing the slots show changes with the time. For tests. */
	get nextTick(): number | null {
		return this.#ticker.next;
	}

	/**
	 * Whether a Stream Deck is connected (agents-and-wake.md, C3). While none is, the repaint tick doesn't run: nothing
	 * would show its labels. When one connects, the tick is timed afresh. True until told otherwise.
	 */
	setDeckConnected(connected: boolean): void {
		if (connected === this.#deckConnected) return;
		this.#deckConnected = connected;
		this.#schedule();
	}

	/** That key or dial doesn't show `slot` any more. The slot keeps its session. */
	disappear(slot: SlotId, who: string): void {
		const set = this.#showing.get(slot);
		if (!set?.delete(who)) return;
		if (set.size === 0) this.#showing.delete(slot);
		this.#emit();
	}

	/** Whether a key or dial shows the slot now. */
	showing(slot: SlotId): boolean {
		return (this.#showing.get(slot)?.size ?? 0) > 0;
	}

	/** The session on the slot, showing or not; null for none. */
	host(slot: SlotId): string | null {
		return this.#hosts.get(slot) ?? null;
	}

	/** The slot a session is on, showing or not; null for none. */
	slotOf(host: string): SlotId | null {
		for (const [slot, h] of this.#hosts) if (h === host) return slot;
		return null;
	}

	/** Every slot that holds a session, in slot order. */
	entries(): [SlotId, string][] {
		return [...this.#hosts.entries()].sort(([a], [b]) => compareSlots(a, b));
	}

	/** The sessions on a slot, showing or not. Others counts the sessions on none. */
	slotted(): ReadonlySet<string> {
		return new Set(this.#hosts.values());
	}

	/**
	 * A long press on `slot`'s key: the slot takes the session on screen in the app (SlotsModel's `onScreen`), swapping
	 * with the slot that one is on, if any. Fails, changing nothing, when no session is known to be on screen, or when
	 * that one is archived, which a slot would let go of at once (stay put).
	 */
	takeOnScreen(slot: SlotId): PlaceResult {
		const s = this.#model.onScreen();
		if (!s || s.host === null) {
			this.#log.info(`SLOT ${slot}: long press: no session is known to be on screen in the app`);
			return { ok: false, why: "no session is known to be on screen in the app" };
		}
		if (s.archived) {
			this.#log.info(`SLOT ${slot}: long press: the session last on screen in the app, ${s.host}, is archived: nothing changes`);
			return { ok: false, why: "the session on screen in the app is archived" };
		}
		return this.place(slot, s.host, "long press");
	}

	/**
	 * Puts `host` on `slot`. If it's on another slot, the two slots swap; otherwise the session that was on `slot`, if
	 * any, is on none now. What a long press does with the session it takes; the fixture runner gives a session a slot
	 * with it too.
	 */
	place(slot: SlotId, host: string, why = "placed"): PlaceResult {
		if (parseSlotId(slot) === null) return { ok: false, why: `${quote(slot, 80)} isn't a slot id` };
		const h = asHost(host);
		if (h === null) return { ok: false, why: `${quote(host, 80)} isn't an app id` };
		const from = this.slotOf(h);
		const was = this.host(slot);
		if (from === slot) {
			this.#log.info(`SLOT ${slot}: ${why}: ${h} is already here`);
			return { ok: true, host: h, from: null, replaced: null };
		}
		this.#hosts.set(slot, h);
		if (from !== null) {
			if (was !== null) this.#hosts.set(from, was);
			else this.#hosts.delete(from);
		}
		this.#log.info(`SLOT ${slot} ← ${h} (${why})${from !== null ? `, from ${from}, which ${was === null ? "is empty now" : `takes ${was}`}` : was !== null ? `, in place of ${was}` : ""}`);
		this.#changed();
		this.refresh();
		return { ok: true, host: h, from, replaced: from === null ? was : null };
	}

	/**
	 * Catches up with the model: lets go of the sessions that are archived or gone (stay put), fills the showing empty
	 * slots, saves if anything changed, then tells the listeners. The model calls it on every change.
	 */
	refresh(): void {
		// keepHosts below changes the model, which calls this again: once is enough.
		if (this.#refreshing) return;
		this.#refreshing = true;
		// This fills every showing slot, the ones waiting to included.
		if (this.#fillTimer !== null) this.#clock.clearTimeout(this.#fillTimer);
		this.#fillTimer = null;
		try {
			let changed = false;
			for (const [slot, host] of [...this.#hosts]) {
				const why = this.#letGo(host);
				if (why === null) continue;
				this.#hosts.delete(slot);
				changed = true;
				this.#log.info(`SLOT ${slot}: lets ${host} go: ${why}`);
			}
			const empty = [...this.#showing.keys()].filter((slot) => this.showing(slot) && !this.#hosts.has(slot)).sort(compareSlots);
			if (empty.length > 0) {
				const taken = new Set(this.#hosts.values());
				const candidates = fillOrder(this.#model.sessions().filter((s) => s.host !== null && s.running && !s.archived && !taken.has(s.host)));
				for (const slot of empty) {
					const next = candidates.shift();
					if (!next || next.host === null) break;
					this.#hosts.set(slot, next.host);
					changed = true;
					this.#log.info(`SLOT ${slot} ← ${next.host} (fill: ${next.need !== null ? `needs you (${next.need})` : "the newest"}): ${quote(next.title, 60)}`);
				}
			}
			if (changed) this.#changed();
		} catch (err) {
			this.#log.error(`slots refresh failed: ${describeError(err)}`);
		} finally {
			this.#refreshing = false;
		}
		this.#emit();
	}

	/** Why a slot lets its session go now (stay put), or null while it keeps it. */
	#letGo(host: string): string | null {
		if (this.#model.slotView(host)?.archived) return "the app archived it";
		if (this.#model.registryRead && !this.#model.isListed(host) && this.#model.recordMissing(host)) return "its record file is gone, and the registry doesn't list it";
		return null;
	}

	/** The slots changed: saved, and the model keeps their sessions' records and views. */
	#changed(): void {
		try {
			this.#store.save(new Map(this.#hosts));
		} catch (err) {
			this.#log.warn(`saving the slots threw: ${describeError(err)}`);
		}
		this.#model.keepHosts(this.#hosts.values());
	}

	#emit(): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch (err) {
				this.#log.error(`a slots listener threw: ${describeError(err)}`);
			}
		}
		this.#schedule();
	}

	/**
	 * Times the repaint tick afresh: at the first moment a `since` shown next reads differently (format.ts's
	 * sinceChangesAt), that of each running session on a showing slot, which its key and its dial show, and, while an
	 * Others key shows, that of the one waiting longest off the slots. None while no Stream Deck is connected.
	 */
	#schedule(): void {
		if (!this.#deckConnected) {
			this.#ticker.stop();
			return;
		}
		try {
			const now = this.#model.wallNow();
			const sinces: (number | null)[] = [];
			for (const [slot, host] of this.#hosts) {
				const view = this.showing(slot) ? this.#model.slotView(host) : null;
				if (view?.running) sinces.push(view.since);
			}
			if (this.#othersShown.size > 0) sinces.push(othersLook(this.#model.sessions(), this.slotted(), now).oldest?.since ?? null);
			let first: number | null = null;
			for (const since of sinces) {
				const at = sinceChangesAt(since, now);
				if (at !== null && (first === null || at < first)) first = at;
			}
			this.#ticker.at(first);
		} catch (err) {
			this.#ticker.stop();
			this.#log.error(`timing the slots' repaint tick threw: ${describeError(err)}`);
		}
	}
}

/**
 * The order the fill takes sessions in: those that need you first, the one waiting longest first (an unknown `since`
 * last); then the rest, the newest by `startedAt` first (an unknown one last). Ties keep the registry's order.
 */
export function fillOrder(sessions: readonly SessionView[]): SessionView[] {
	const needing = sessions.filter((s) => s.need !== null);
	const rest = sessions.filter((s) => s.need === null);
	needing.sort((a, b) => ascending(a.since, b.since));
	rest.sort((a, b) => ascending(b.startedAt, a.startedAt, true));
	return [...needing, ...rest];
}

/** Compares two times, earlier first; a null goes last, or with `nullFirst`, first (which a descending sort puts last). */
function ascending(a: number | null, b: number | null, nullFirst = false): number {
	if (a === b) return 0;
	if (a === null) return nullFirst ? -1 : 1;
	if (b === null) return nullFirst ? 1 : -1;
	return a - b;
}
