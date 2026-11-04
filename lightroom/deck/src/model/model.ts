import type { ConnState, LrLink } from "../lr/client.js";
import {
	type AckEvt,
	type ErrCode,
	type ErrEvt,
	type HelloEvt,
	type LrEvent,
	type Range,
	type ResetCmd,
	roundForSend,
	type SetCmd,
	type StateEvt,
	type ValsEvt,
} from "../lr/protocol.js";
import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { Emitter } from "../util/emitter.js";
import { nullLog, type Log } from "../util/log.js";
import { clampToRange, type StepSpec, type TurnMode, unitsPerTick } from "./steps.js";

export type { TurnMode } from "./steps.js";

/** Who asked for an input: the dial's action id. Alerts go back to it. */
export type Origin = string;

export type ModelTiming = {
	/** Minimum gap between two `set`s for one param: at most 30 a second. */
	setIntervalMs: number;
	/** `done` goes out this long after a gesture's last tick. */
	doneAfterMs: number;
	/** `vals` for a param are ignored this long after its `done`. */
	echoMs: number;
	/** Ticks held for Develop, or for a value, are dropped after this long. */
	holdMs: number;
	/** At most one alert per origin in this window, so a fast spin while offline doesn't flash the strip continuously. */
	alertGapMs: number;
	/**
	 * After the deck asks for a photo change (see {@link LrModel.beforePhotoChange}), or Lightroom refuses a set
	 * as stale before the deck has seen the new photo, turns wait this long for the new photo, and then apply to
	 * the photo Lightroom stayed on. Flag keys advance 150 ms after flagging.
	 */
	photoChangeMs: number;
};

/** PROTOCOL.md's Gestures numbers. */
export const DEFAULT_MODEL_TIMING: ModelTiming = {
	setIntervalMs: Math.ceil(1000 / 30),
	doneAfterMs: 800,
	echoMs: 300,
	holdMs: 2000,
	alertGapMs: 1000,
	photoChangeMs: 500,
};

export type LrState = {
	module: string | null;
	photo: string | null;
	file: string | null;
	flag: number | null;
	rating: number | null;
	label: string | null;
	sel: number | null;
	/** A background AI process holds the target photo, so the dials don't write (PROTOCOL.md, Locked photos). False until a `state` says so. */
	locked: boolean;
};

export type ParamView = {
	value: number | null;
	range: Range | null;
	/** The value belongs to the current photo, in Develop. False after a photo change until `vals` arrive, outside Develop, and offline. */
	fresh: boolean;
	/** A deck gesture owns this value right now. */
	adjusting: boolean;
};

export type TurnResult = "applied" | "held" | "offline" | "readonly" | "locked" | "noPhoto" | "ignored";

type Param = {
	value: number | null;
	range: Range | null;
	fresh: boolean;
	/**
	 * The range came after the last photo or module change. The old range stays for the strip until then, but
	 * turns wait: Lightroom sends a range it can't read yet in a later `ranges`, and ranges differ by file type.
	 */
	rangeFresh: boolean;
	echoUntil: number;
	echoTimer: TimerHandle | null;
	/** The latest `vals` value that arrived during the echo window; applied when it closes. */
	deferred: number | null;
	/** The param's latest gesture, kept for its late acks. */
	last: Gesture | null;
	/** Turns wait while a `reset` is unanswered, so they start from the reset value. */
	resetPendingUntil: number;
	/** When the last `set` for this param went out, by any gesture: PROTOCOL.md's 30 a second is per param. */
	lastSentAt: number;
};

type Gesture = {
	g: number;
	p: string;
	origin: Origin;
	/** The local value, unrounded and clamped. Fine ticks are smaller than the send rounding, so rounding happens only on the way out. */
	value: number;
	baseRaw: number;
	/** The last value sent, rounded; starts at the rounded base so an unchanged value isn't sent. */
	sent: number;
	sets: number;
	acks: number;
	ackValue: number | null;
	sendTimer: TimerHandle | null;
	doneTimer: TimerHandle | null;
	/** It had push + turn ticks, so dial-up ends it. */
	pressed: boolean;
	open: boolean;
	/** Ended, but its final `set` is waiting for the rate limit; `done` follows it. */
	ending: boolean;
	/** The photo epoch it began in (see LrModel's #photoEpoch): which photo its values were worked out from. */
	epoch: number;
	/** Lightroom refused one of its sets with err stale; the errs for its other in-flight sets change nothing. */
	stale: boolean;
};

/** Ticks waiting for Develop or for a value, by mode: each applies as the mode it was turned in. */
type Held = { ticks: Record<TurnMode, number>; spec: StepSpec; origin: Origin; origins: Set<Origin> };

/** The order held ticks apply in, fine last as before. It matters only at the ends of a range, where each mode's ticks clamp in turn. */
const HELD_ORDER: readonly TurnMode[] = ["normal", "macro", "fine"];

type ModelEvents = { change: []; alert: [origin: Origin, reason: string] };

const EMPTY_STATE: LrState = { module: null, photo: null, file: null, flag: null, rating: null, label: null, sel: null, locked: false };

/**
 * The deck's picture of Lightroom: each watched param's value and range, the photo state, and whether
 * writes go through. It also runs dial gestures as PROTOCOL.md's Gestures section describes:
 *
 * - One gesture is one burst of turning on one dial, numbered `g`. Ticks move the local value at once; `set`
 *   carries the latest absolute value, clamped and rounded, at most 30 times a second.
 * - `done` follows 800 ms after the last tick, or on dial-up after push + turn. Lightroom tracks one param at a
 *   time, so turning another param ends the open gesture first.
 * - `vals` for a param are ignored during its gesture; in the 300 ms after its `done` they're held back, and
 *   the latest one applies when that window closes. The deck owns the value until then.
 * - Outside Develop a turn sends `module develop` and holds the ticks until `vals` arrive, or drops them after 2 s.
 *   Turns also wait for a range, and for a photo change the deck itself asked for ({@link beforePhotoChange}).
 * - A gesture belongs to the photo it started on. When the user changes photo in Lightroom mid-gesture,
 *   Lightroom refuses the gesture's later sets with `err stale`. The deck ends the gesture without a final set
 *   or `done`, raises no alert, and, if it hasn't seen the new photo yet, holds turns for it as after
 *   beforePhotoChange. The next turn is a new gesture from the new photo's value.
 * - Every `set` and `reset` carries `ph`, the `photo` of the latest `state`, read as it goes out. A photo change
 *   in Lightroom reaches the deck a few ms late, so a gesture can start from the old photo's value in between;
 *   Lightroom refuses its sets as stale, as above. A reset refused as stale is dropped, without an alert.
 * - While the latest `state` names no photo there's no `ph` to send. A press sends no `reset`, and a turn that
 *   would start a gesture starts none; either alerts the dial, once per burst. Held turns stay held, as before.
 * - While `state.locked` is true a background AI process holds the photo: the open gesture ends with `done`,
 *   and turns and presses are dropped rather than held, sending nothing, not even `module develop`. Each dial
 *   alerts once per burst.
 */
export class LrModel {
	readonly #link: LrLink;
	readonly #clock: Clock;
	readonly #timing: ModelTiming;
	readonly #log: Log;
	readonly #events: Emitter<ModelEvents>;
	readonly #params = new Map<string, Param>();
	readonly #held = new Map<string, Held>();
	readonly #probes = new Map<string, number>();
	readonly #lastAlert = new Map<Origin, number>();
	/** While the photo is locked: when each dial was last turned or pressed, for one alert per burst. Cleared when the lock ends. */
	readonly #lockedInputs = new Map<Origin, number>();
	/** While the latest state names no photo: when each dial last had a press or a turn refused, for one alert per burst. Cleared when a state names one. */
	readonly #noPhotoInputs = new Map<Origin, number>();
	#holdTimer: TimerHandle | null = null;
	#moduleAsked = false;
	/** Turns wait until then: a photo change the deck asked for, or one a stale err revealed, may still be landing (see beforePhotoChange). 0 when none is. */
	#photoChangeUntil = 0;
	#photoChangeTimer: TimerHandle | null = null;
	/** Bumped whenever `state` shows another photo or module: values from an older epoch belong to another photo. */
	#photoEpoch = 0;
	#active: Gesture | null = null;
	#gseq = 0;
	#conn: ConnState;
	#hello: HelloEvt | null = null;
	#state: LrState = { ...EMPTY_STATE };

	constructor(link: LrLink, opts: { clock?: Clock; timing?: Partial<ModelTiming>; log?: Log } = {}) {
		this.#link = link;
		this.#clock = opts.clock ?? realClock;
		this.#timing = { ...DEFAULT_MODEL_TIMING, ...opts.timing };
		this.#log = opts.log ?? nullLog;
		this.#events = new Emitter<ModelEvents>(this.#log);
		this.#conn = link.state;
		link.on("event", (evt) => this.#onEvent(evt));
		link.on("state", (state) => this.#onConn(state));
		link.on("inst", () => this.#onInst());
		link.on("disconnect", () => this.#onDisconnect());
	}

	// ---- queries ----

	get conn(): ConnState {
		return this.#conn;
	}

	get hello(): HelloEvt | null {
		return this.#hello;
	}

	/** `hello.writable`: false when the guard refuses writes. Null before the first hello. */
	get writable(): boolean | null {
		return this.#hello?.writable ?? null;
	}

	get state(): Readonly<LrState> {
		return this.#state;
	}

	get inDevelop(): boolean {
		return this.#state.module === "develop";
	}

	view(p: string): ParamView {
		const param = this.#params.get(p);
		if (!param) return { value: null, range: null, fresh: false, adjusting: false };
		return { value: param.value, range: param.range, fresh: param.fresh, adjusting: this.#active?.p === p };
	}

	/** The open gesture, for tests and logs. */
	get gesture(): { g: number; p: string; value: number; origin: Origin } | null {
		const g = this.#active;
		return g && g.open ? { g: g.g, p: g.p, value: g.value, origin: g.origin } : null;
	}

	/** Params with ticks waiting for Develop or for a value. */
	get held(): string[] {
		return [...this.#held.keys()];
	}

	onChange(listener: () => void): () => void {
		return this.#events.on("change", listener);
	}

	onAlert(listener: (origin: Origin, reason: string) => void): () => void {
		return this.#events.on("alert", listener);
	}

	// ---- dial input ----

	/**
	 * Applies `ticks` to `p` in `mode`, using `spec`'s steps for the param's current range: normal ticks come
	 * already accelerated, fine and big-step (macro) ticks raw. Only fine ticks mark the gesture pressed, so only
	 * push + turn's dial-up ends a gesture early (see release).
	 */
	turn(p: string, ticks: number, mode: TurnMode, spec: StepSpec, origin: Origin): TurnResult {
		if (!Number.isFinite(ticks) || ticks === 0) return "ignored";
		if (this.#conn !== "online") {
			this.#alert(origin, `turned ${p} while Lightroom is ${this.#conn}`);
			return "offline";
		}
		if (this.#state.locked) {
			this.#lockedInput(origin, `turned ${p}`);
			return "locked";
		}
		if (this.writable === false) {
			this.#probe(p, ticks, mode, spec, origin);
			return "readonly";
		}
		const param = this.#param(p);
		if (!this.inDevelop || !this.#usable(param)) {
			this.#hold(p, ticks, mode, spec, origin);
			this.#changed();
			return "held";
		}
		// Values can reach the deck ahead of the state that names their photo: Lightroom answers watch with the
		// target photo's ranges and vals, even before that photo's state has gone out. A set now would go without
		// ph, unchecked, to whatever photo Lightroom is on.
		if (this.#state.photo === null) {
			this.#noPhotoInput(origin, `turned ${p}`);
			return "noPhoto";
		}
		this.#apply(p, ticks, mode, spec, origin);
		this.#changed();
		return "applied";
	}

	/** Dial-up after push + turn ends that dial's gesture now rather than after 800 ms. */
	release(origin: Origin): void {
		const g = this.#active;
		if (g && g.open && g.origin === origin && g.pressed) this.#end(g);
	}

	/** Resets `p` to its default. Returns false if it couldn't be sent. */
	reset(p: string, origin: Origin): boolean {
		if (this.#conn !== "online") {
			this.#alert(origin, `reset ${p} while Lightroom is ${this.#conn}`);
			return false;
		}
		if (this.#state.locked) {
			this.#lockedInput(origin, `reset ${p}`);
			return false;
		}
		// No photo to send as ph: unchecked, the reset could land on a photo Lightroom has just gained (PROTOCOL.md,
		// Gestures). Refused before anything changes, so no gesture ends and held turns stay.
		if (this.#state.photo === null) {
			this.#noPhotoInput(origin, `reset ${p}`);
			return false;
		}
		// Lightroom's reset ends any gesture; finish ours so the wire agrees with it.
		const g = this.#active;
		// A gesture of p that this reset ends without done. Lightroom still tracks it if it refuses the reset.
		let cancelled: Gesture | null = null;
		if (g && g.open) {
			if (g.p === p) {
				this.#abort(g, false);
				if (g.sets > 0) cancelled = g;
			} else this.#endNow(g);
		}
		this.#held.delete(p);
		if (this.#held.size === 0) this.#clearHold();
		const param = this.#param(p);
		const sent = this.#link.send(this.#withPhoto({ t: "reset", p }), {
			onErr: (err) => {
				param.resetPendingUntil = 0;
				if (err.code === ("stale" satisfies ErrCode)) {
					// Lightroom is on a photo the deck hasn't heard of yet, and the reset was meant for the old one.
					this.#log.debug(`Lightroom refused reset ${p} as stale: it's on another photo; dropping the reset`);
				} else {
					this.#alert(origin, `Lightroom refused reset ${p}: ${err.code}`);
					// A locked photo changed nothing, so Lightroom still tracks the gesture the reset ended.
					if (err.code === ("locked" satisfies ErrCode) && cancelled) this.#link.send({ t: "done", g: cancelled.g });
				}
				this.#applyHeld();
				this.#changed();
			},
		});
		if (!sent) {
			this.#alert(origin, `couldn't send reset ${p}`);
			return false;
		}
		param.resetPendingUntil = this.#clock.now() + this.#timing.holdMs;
		this.#changed();
		return true;
	}

	/**
	 * Call just before sending a command that changes the photo: Next, Previous, or a flag key that advances.
	 * The open gesture's final `set` and `done` go out now, ahead of that command on the same socket, so they
	 * land on the photo their absolute value was computed from. Turns then wait, for at most photoChangeMs:
	 * until Lightroom's `state` shows the new photo and its `vals` arrive, or, if the photo stays (the end of
	 * the filmstrip), until the wait ends. Otherwise a tick in between would carry on the old gesture with
	 * the old photo's value, and Lightroom would apply that to the new photo.
	 */
	beforePhotoChange(): void {
		const g = this.#active;
		if (g && g.open) this.#endNow(g);
		this.#holdForPhotoChange();
		this.#changed();
	}

	/**
	 * Turns wait for at most photoChangeMs: a `state` with another photo or module ends the wait (#onState), and
	 * turns then wait for that photo's `vals`; otherwise held turns apply when the wait ends.
	 */
	#holdForPhotoChange(): void {
		this.#clearPhotoChange();
		this.#photoChangeUntil = this.#clock.now() + this.#timing.photoChangeMs;
		this.#photoChangeTimer = this.#clock.setTimeout(() => {
			this.#photoChangeTimer = null;
			this.#photoChangeUntil = 0;
			this.#applyHeld();
			this.#changed();
		}, this.#timing.photoChangeMs);
	}

	#clearPhotoChange(): void {
		if (this.#photoChangeTimer !== null) this.#clock.clearTimeout(this.#photoChangeTimer);
		this.#photoChangeTimer = null;
		this.#photoChangeUntil = 0;
	}

	// ---- gestures ----

	/**
	 * A turn applies only to a value Lightroom reported for the current photo in Develop, with that photo's range:
	 * the range picks the steps (Kelvin or not) and bounds the clamp. Until then turns are held.
	 */
	#usable(param: Param): boolean {
		const now = this.#clock.now();
		return (
			param.fresh &&
			param.value !== null &&
			param.range !== null &&
			param.rangeFresh &&
			now >= param.resetPendingUntil &&
			now >= this.#photoChangeUntil
		);
	}

	#apply(p: string, ticks: number, mode: TurnMode, spec: StepSpec, origin: Origin): void {
		const param = this.#param(p);
		if (param.value === null) return;
		const delta = ticks * unitsPerTick(spec, param.range, mode);
		let g = this.#active;
		// Turned again before a released gesture's final set went out: carry on with the same gesture.
		if (g && g.open && g.p === p && g.ending) g.ending = false;
		if (g && g.open && g.p !== p) {
			// Lightroom tracks one param at a time: the old gesture's final set and done go out before this one's first set.
			this.#endNow(g);
			g = null;
		}
		if (!g || !g.open) g = this.#begin(p, param.value, origin);
		g.origin = origin;
		if (mode === "fine") g.pressed = true;
		g.value = clampToRange(g.value + delta, param.range);
		param.value = g.value;
		this.#scheduleSend(g);
		this.#armDone(g);
	}

	#begin(p: string, base: number, origin: Origin): Gesture {
		const param = this.#param(p);
		this.#clearEcho(param);
		const g: Gesture = {
			g: ++this.#gseq,
			p,
			origin,
			value: base,
			baseRaw: base,
			sent: roundForSend(p, base),
			sets: 0,
			acks: 0,
			ackValue: null,
			sendTimer: null,
			doneTimer: null,
			pressed: false,
			open: true,
			ending: false,
			epoch: this.#photoEpoch,
			stale: false,
		};
		this.#active = g;
		param.last = g;
		return g;
	}

	/** The rate limit counts from the param's last `set`, so a new gesture right after the last one waits too. */
	#scheduleSend(g: Gesture): void {
		if (g.sendTimer !== null) return; // the pending flush sends the latest value
		const wait = this.#param(g.p).lastSentAt + this.#timing.setIntervalMs - this.#clock.now();
		if (wait <= 0) this.#flush(g);
		else {
			g.sendTimer = this.#clock.setTimeout(() => {
				g.sendTimer = null;
				this.#flush(g);
			}, wait);
		}
	}

	#flush(g: Gesture): void {
		if (!g.open) return;
		const param = this.#param(g.p);
		const range = param.range;
		let v = roundForSend(g.p, clampToRange(g.value, range));
		v = clampToRange(v, range);
		if (v !== g.sent) {
			const sent = this.#link.send(this.#withPhoto({ t: "set", p: g.p, v, g: g.g }), { onErr: (err) => this.#onSetErr(g, err) });
			if (sent) {
				g.sent = v;
				g.sets += 1;
				param.lastSentAt = this.#clock.now();
			}
		}
		if (g.ending) this.#finishEnd(g);
	}

	#armDone(g: Gesture): void {
		if (g.doneTimer !== null) this.#clock.clearTimeout(g.doneTimer);
		g.doneTimer = this.#clock.setTimeout(() => {
			g.doneTimer = null;
			this.#end(g);
		}, this.#timing.doneAfterMs);
	}

	/** Ends a gesture: its last value goes out when the rate limit allows, then `done`. */
	#end(g: Gesture): void {
		if (!g.open || g.ending) return;
		if (g.sendTimer !== null) {
			g.ending = true; // the pending flush finishes the end
			return;
		}
		this.#finishEnd(g);
	}

	/**
	 * Ends a gesture without waiting for the rate limit, when another param takes over within one set
	 * interval (two dials at once), a reset of another param arrives, or the deck changes the photo. Its final
	 * set may then follow the previous one for that param by less than 34 ms: at most once per gesture, so the
	 * wire order stays set, done, then the next command. This is the one exception to PROTOCOL.md's 30 a
	 * second per param; waiting instead would hold the next param's set, the reset or the nav back too.
	 */
	#endNow(g: Gesture): void {
		if (!g.open) return;
		if (g.sendTimer !== null) {
			this.#clock.clearTimeout(g.sendTimer);
			g.sendTimer = null;
			g.ending = true;
			this.#flush(g); // finishes the end
			return;
		}
		this.#finishEnd(g);
	}

	#finishEnd(g: Gesture): void {
		if (!g.open) return;
		this.#closeGesture(g);
		const param = this.#param(g.p);
		if (g.sets > 0) {
			this.#link.send({ t: "done", g: g.g });
			param.value = g.sent;
			this.#openEcho(param);
		} else {
			param.value = g.baseRaw;
		}
		this.#changed();
	}

	/** Stops a gesture at once, with no final set: on reset, a photo change, a disconnect. */
	#abort(g: Gesture, sendDone: boolean): void {
		if (!g.open) return;
		this.#closeGesture(g);
		if (sendDone && g.sets > 0) this.#link.send({ t: "done", g: g.g });
	}

	#closeGesture(g: Gesture): void {
		if (g.sendTimer !== null) this.#clock.clearTimeout(g.sendTimer);
		if (g.doneTimer !== null) this.#clock.clearTimeout(g.doneTimer);
		g.sendTimer = null;
		g.doneTimer = null;
		g.open = false;
		g.ending = false;
		if (this.#active === g) this.#active = null;
	}

	#abortAll(sendDone: boolean): void {
		if (this.#active) this.#abort(this.#active, sendDone);
	}

	#onSetErr(g: Gesture, err: ErrEvt): void {
		if (err.code === ("stale" satisfies ErrCode)) {
			this.#onStale(g);
			return;
		}
		this.#alert(g.origin, `Lightroom refused set ${g.p}: ${err.code}`);
		if (g.open) this.#abort(g, true);
		// Show what Lightroom last confirmed, unless a newer gesture owns the param.
		if (this.#active?.p !== g.p) {
			const param = this.#param(g.p);
			param.value = g.ackValue ?? g.baseRaw;
			this.#clearEcho(param);
		}
		this.#changed();
	}

	/**
	 * Lightroom refused a set of `g` with err stale: the photo or module changed under the gesture, or before the
	 * deck heard of the change the gesture began from the old photo's value, which its `ph` shows. Its values,
	 * worked out from the old photo, changed nothing (PROTOCOL.md, Gestures). Each of g's sets still in flight
	 * gets its own err; only the first does anything. None raises an alert.
	 *
	 * - If a `state` with another photo or module arrived after `g` began, the deck already knows. That state
	 *   ended `g`, and the model has the new photo's values or is waiting for them, so nothing more happens. In
	 *   particular there's no extra wait: the next turn already starts from the new photo's value.
	 * - Otherwise Lightroom caught the change first. `g` ends with no final set and no `done`, since Lightroom
	 *   ended it. Any other open gesture also began on the old photo's values; Lightroom tracks it on the new
	 *   photo, so it ends too, with its `done`. `p` goes back to the value Lightroom last confirmed. Turns wait
	 *   as after beforePhotoChange: for the new photo's state and vals, or photoChangeMs if Lightroom ends up on
	 *   the same photo.
	 */
	#onStale(g: Gesture): void {
		if (g.stale) return;
		g.stale = true;
		this.#abort(g, false);
		if (g.epoch !== this.#photoEpoch) {
			this.#log.debug(`Lightroom refused gesture ${g.g} on ${g.p} as stale; the deck had already seen the new photo or module`);
			this.#changed();
			return;
		}
		this.#log.debug(`Lightroom refused gesture ${g.g} on ${g.p} as stale: the photo or module changed; holding turns for the new photo`);
		const other = this.#active;
		if (other && other.open) this.#abort(other, true);
		const param = this.#param(g.p);
		if (param.last === g) {
			param.value = g.ackValue ?? g.baseRaw;
			this.#clearEcho(param);
		}
		this.#holdForPhotoChange();
		this.#changed();
	}

	#openEcho(param: Param): void {
		this.#clearEcho(param);
		param.echoUntil = this.#clock.now() + this.#timing.echoMs;
		param.echoTimer = this.#clock.setTimeout(() => this.#closeEcho(param), this.#timing.echoMs);
	}

	#clearEcho(param: Param): void {
		if (param.echoTimer !== null) this.#clock.clearTimeout(param.echoTimer);
		param.echoTimer = null;
		param.echoUntil = 0;
		param.deferred = null;
	}

	#closeEcho(param: Param): void {
		param.echoTimer = null;
		param.echoUntil = 0;
		const g = param.last;
		if (param.deferred !== null) param.value = param.deferred;
		else if (g && g.sets > 0 && g.acks >= g.sets && g.ackValue !== null) param.value = g.ackValue;
		param.deferred = null;
		this.#changed();
	}

	// ---- read-only ----

	/**
	 * With `hello.writable` false the guard refuses every write. The value doesn't move; the first tick of each
	 * burst sends one `set`, so Lightroom shows its bezel saying why and answers `err guard`, which alerts the dial.
	 */
	#probe(p: string, ticks: number, mode: TurnMode, spec: StepSpec, origin: Origin): void {
		const now = this.#clock.now();
		const last = this.#probes.get(p);
		this.#probes.set(p, now);
		if (last !== undefined && now - last < this.#timing.doneAfterMs) return;
		const param = this.#param(p);
		if (param.value === null) {
			this.#alert(origin, `${p} is read-only and has no value yet`);
			return;
		}
		const v = clampToRange(roundForSend(p, clampToRange(param.value + ticks * unitsPerTick(spec, param.range, mode), param.range)), param.range);
		const sent = this.#link.send(this.#withPhoto({ t: "set", p, v, g: ++this.#gseq }), { onErr: (err) => this.#alert(origin, `Lightroom refused set ${p}: ${err.code}`) });
		if (sent) param.lastSentAt = now;
		else this.#alert(origin, `couldn't send set ${p}`);
	}

	// ---- locked photos ----

	/**
	 * A background AI process locked the target photo (PROTOCOL.md, Locked photos), and Lightroom refuses every
	 * set and reset until it finishes. The open gesture ends with `done` but without its pending final set, and
	 * held turns are dropped, with an alert on their dials.
	 */
	#onLock(): void {
		const g = this.#active;
		if (g && g.open) {
			this.#log.debug(`ending gesture ${g.g} on ${g.p}: the photo is locked`);
			if (g.sendTimer !== null) this.#clock.clearTimeout(g.sendTimer);
			g.sendTimer = null;
			this.#finishEnd(g);
		}
		if (this.#held.size > 0) this.#dropHeld("the photo is locked by a background process", (origin) => this.#lockedInput(origin, "held turn"));
	}

	/**
	 * A turn or press while the photo is locked: nothing goes out and nothing is held. The dial alerts once per
	 * burst, a burst being inputs on one dial less than doneAfterMs apart, like the ticks of one gesture.
	 */
	#lockedInput(origin: Origin, what: string): void {
		this.#burstAlert(this.#lockedInputs, origin, `${what}: the photo is locked by a background process`);
	}

	/**
	 * A press, or a turn that would start a gesture, while the latest `state` names no photo: there's no `ph` to
	 * send, so nothing goes out. Nothing else changes either. The dial alerts once per burst, as while locked.
	 */
	#noPhotoInput(origin: Origin, what: string): void {
		this.#burstAlert(this.#noPhotoInputs, origin, `${what}: Lightroom has no target photo`);
	}

	/** Alerts `origin` on the first input of a burst: inputs on one dial less than doneAfterMs apart. */
	#burstAlert(inputs: Map<Origin, number>, origin: Origin, reason: string): void {
		const now = this.#clock.now();
		const last = inputs.get(origin);
		inputs.set(origin, now);
		if (last === undefined || now - last >= this.#timing.doneAfterMs) this.#alert(origin, reason);
	}

	/**
	 * Adds `ph`, the `photo` of the latest `state`, as a `set` or `reset` goes out, so Lightroom can refuse one
	 * worked out for another photo (PROTOCOL.md, Gestures). While the state names no photo there's no id to send,
	 * so reset() sends nothing, turn() starts no gesture and held turns wait (#applyHeld). Only the read-only probe
	 * then goes without `ph`: the guard refuses it before Lightroom looks at any photo.
	 */
	#withPhoto<C extends SetCmd | ResetCmd>(cmd: C): C {
		const ph = this.#state.photo;
		return ph === null ? cmd : { ...cmd, ph };
	}

	// ---- held ticks ----

	#hold(p: string, ticks: number, mode: TurnMode, spec: StepSpec, origin: Origin): void {
		let h = this.#held.get(p);
		if (!h) {
			h = { ticks: { normal: 0, fine: 0, macro: 0 }, spec, origin, origins: new Set() };
			this.#held.set(p, h);
		}
		h.ticks[mode] += ticks;
		h.spec = spec;
		h.origin = origin;
		h.origins.add(origin);
		if (this.#holdTimer === null) {
			this.#holdTimer = this.#clock.setTimeout(() => {
				this.#holdTimer = null;
				this.#dropHeld(`no values from Lightroom within ${this.#timing.holdMs} ms`);
			}, this.#timing.holdMs);
		}
		if (!this.inDevelop && !this.#moduleAsked) {
			this.#moduleAsked = true;
			const sent = this.#link.send({ t: "module", v: "develop" }, { onErr: (err) => this.#dropHeld(`Lightroom couldn't switch to Develop: ${err.code}`) });
			if (!sent) this.#dropHeld("couldn't ask Lightroom for Develop");
		}
	}

	/**
	 * Applies held ticks whose param now has a value for the current photo in Develop. While the state names no
	 * photo they wait, even with values that came ahead of their photo's state: a set would go without `ph`. The
	 * state that names the photo marks those values stale, so the ticks then wait for its own.
	 */
	#applyHeld(): void {
		if (this.#held.size === 0 || this.#conn !== "online" || !this.inDevelop || this.writable === false || this.#state.locked) return;
		if (this.#state.photo === null) return;
		for (const [p, h] of [...this.#held]) {
			if (!this.#usable(this.#param(p))) continue;
			this.#held.delete(p);
			for (const mode of HELD_ORDER) if (h.ticks[mode] !== 0) this.#apply(p, h.ticks[mode], mode, h.spec, h.origin);
		}
		if (this.#held.size === 0) this.#clearHold();
	}

	#dropHeld(why: string, alert: (origin: Origin) => void = (origin) => this.#alert(origin, why)): void {
		if (this.#held.size > 0) {
			this.#log.info(`dropped held ticks for ${[...this.#held.keys()].join(", ")}: ${why}`);
			for (const h of this.#held.values()) for (const origin of h.origins) alert(origin);
		}
		this.#held.clear();
		this.#clearHold();
		this.#changed();
	}

	#clearHold(): void {
		if (this.#holdTimer !== null) this.#clock.clearTimeout(this.#holdTimer);
		this.#holdTimer = null;
		this.#moduleAsked = false;
	}

	// ---- Lightroom events ----

	#onEvent(evt: LrEvent): void {
		switch (evt.t) {
			case "hello":
				this.#hello = evt;
				this.#changed();
				break;
			case "state":
				this.#onState(evt);
				break;
			case "ranges":
				// Below info: one line per photo change. It shows the ranges the real Lightroom reports for each slider.
				this.#log.debug(`ranges from Lightroom: ${Object.entries(evt.ranges).map(([p, [min, max]]) => `${p} ${min}…${max}`).join(", ")}`);
				for (const [p, range] of Object.entries(evt.ranges)) {
					const param = this.#param(p);
					param.range = range;
					param.rangeFresh = true;
					const g = this.#active;
					if (g && g.open && g.p === p) g.value = clampToRange(g.value, range);
				}
				this.#applyHeld(); // a held turn may have had its value and been waiting only for the range
				this.#changed();
				break;
			case "vals":
				this.#onVals(evt);
				break;
			case "ack":
				this.#onAck(evt);
				break;
			default:
				break;
		}
	}

	#onState(evt: StateEvt): void {
		const prev = this.#state;
		const next: LrState = { ...prev };
		if (evt.module !== undefined) next.module = evt.module;
		if (evt.photo !== undefined) next.photo = evt.photo;
		if (evt.file !== undefined) next.file = evt.file;
		if (evt.flag !== undefined) next.flag = evt.flag;
		if (evt.rating !== undefined) next.rating = evt.rating;
		if (evt.label !== undefined) next.label = evt.label;
		if (evt.sel !== undefined) next.sel = evt.sel;
		if (evt.locked !== undefined) next.locked = evt.locked;
		this.#state = next;
		if (next.photo !== prev.photo || next.module !== prev.module) {
			// The values and ranges belong to the old photo or module now; new ones arrive as vals and ranges in
			// Develop. A photo change the deck asked for, or one a stale err revealed, has landed, so turns now wait
			// for those rather than for photoChangeMs.
			this.#photoEpoch += 1;
			const open = this.#active;
			if (open) this.#log.debug(`ending gesture ${open.g} on ${open.p}: the photo or module changed`);
			this.#abortAll(true);
			this.#clearPhotoChange();
			for (const param of this.#params.values()) {
				param.fresh = false;
				param.rangeFresh = false;
				this.#clearEcho(param);
			}
		}
		// Moving onto a locked photo does both: the photo change above ends the gesture, and the lock drops the turns held for the new photo.
		if (next.locked && !prev.locked) this.#onLock();
		else if (!next.locked && prev.locked) this.#lockedInputs.clear();
		if (next.photo !== null) this.#noPhotoInputs.clear();
		this.#applyHeld();
		this.#changed();
	}

	#onVals(evt: ValsEvt): void {
		const now = this.#clock.now();
		for (const [p, v] of Object.entries(evt.vals)) {
			const param = this.#param(p);
			const g = this.#active;
			if (g && g.open && g.p === p) continue; // the deck owns p during its gesture
			if (now < param.echoUntil) {
				param.deferred = v;
				continue;
			}
			param.value = v;
			param.fresh = true;
		}
		this.#applyHeld();
		this.#changed();
	}

	#onAck(evt: AckEvt): void {
		const param = this.#param(evt.p);
		if (evt.g === undefined) {
			// A reset: the value straight after it. Turns held for it can go now.
			param.value = evt.v;
			param.fresh = true;
			param.resetPendingUntil = 0;
			this.#clearEcho(param);
			this.#applyHeld();
			this.#changed();
			return;
		}
		const mine = [this.#active, param.last].find((g) => g !== null && g.g === evt.g && g.p === evt.p);
		if (mine) {
			mine.acks += 1;
			mine.ackValue = evt.v;
			return;
		}
		// An ack for a set this deck didn't send (another client, or before a plugin restart): it's still
		// Lightroom's value straight after a set, so take it unless the deck owns the param right now.
		const owned = this.#active !== null && this.#active.open && this.#active.p === evt.p;
		if (!owned && this.#clock.now() >= param.echoUntil) {
			param.value = evt.v;
			param.fresh = true;
			this.#changed();
		}
	}

	#onConn(state: ConnState): void {
		this.#conn = state;
		if (state !== "online" && this.#held.size > 0) this.#dropHeld(`Lightroom is ${state}`);
		this.#changed();
	}

	/** A new plugin instance doesn't know our gestures, values or ranges. The dials keep their sliders. */
	#onInst(): void {
		this.#abortAll(false);
		this.#clearPhotoChange();
		for (const param of this.#params.values()) {
			this.#clearEcho(param);
			param.value = null;
			param.range = null;
			param.fresh = false;
			param.rangeFresh = false;
			param.last = null;
			param.resetPendingUntil = 0;
		}
		this.#probes.clear();
		this.#changed();
	}

	/** Lightroom ends an open gesture itself when the client disconnects. The last values stay, dimmed. */
	#onDisconnect(): void {
		this.#abortAll(false);
		this.#clearPhotoChange();
		for (const param of this.#params.values()) {
			this.#clearEcho(param);
			param.fresh = false;
			param.resetPendingUntil = 0;
		}
		this.#probes.clear();
		if (this.#held.size > 0) this.#dropHeld("Lightroom disconnected");
		this.#changed();
	}

	// ---- helpers ----

	#param(p: string): Param {
		let param = this.#params.get(p);
		if (!param) {
			param = {
				value: null,
				range: null,
				fresh: false,
				rangeFresh: false,
				echoUntil: 0,
				echoTimer: null,
				deferred: null,
				last: null,
				resetPendingUntil: 0,
				lastSentAt: Number.NEGATIVE_INFINITY,
			};
			this.#params.set(p, param);
		}
		return param;
	}

	#alert(origin: Origin, reason: string): void {
		const now = this.#clock.now();
		const last = this.#lastAlert.get(origin);
		this.#log.debug(`alert for ${origin}: ${reason}`);
		if (last !== undefined && now - last < this.#timing.alertGapMs) return;
		this.#lastAlert.set(origin, now);
		this.#events.emit("alert", origin, reason);
	}

	#changed(): void {
		this.#events.emit("change");
	}
}
