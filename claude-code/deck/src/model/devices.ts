import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
import { countIdle } from "../util/idle.js";
import { describeError, type Log, nullLog, quote } from "../util/log.js";

/**
 * When, after a wake, the deck repaints every key and strip while a device is connected. The Stream Deck app turns the
 * deck off at every display sleep or lock and adds it back about 5 s after the wake, once 18 s, and the plugin gets no
 * willAppear then: the app may restore the device without telling the plugin (agents-and-wake.md, C2).
 */
export const WAKE_REPAINTS_MS: readonly number[] = [10_000, 20_000];

/** A device that connects within this long of a wake says how long after it (agents-and-wake.md, C4). */
export const WAKE_WINDOW_MS = 60_000;

/**
 * How often the deck notes the time (the beat), to tell a system sleep by (agents-and-wake.md, C4). No clock a Node
 * process reads stops while macOS sleeps: performance.now and the timers run on mach_continuous_time (libuv's
 * uv_hrtime), which counts the sleep as the wall clock does. But macOS stops every process while it sleeps, so the
 * deck's own beat comes late by about as long. Display sleep stops nothing.
 */
export const BEAT_MS = 30_000;

/**
 * How late a beat is before it counts as system sleep. Awake, the deck's once-a-minute timer came at most 0.25 s late
 * in 8,658 beats over six days, the display asleep or not (the IDLE lines, 2026-11-06 to 11-11).
 */
export const SLEEP_GAP_MS = 2000;

/** How long the Mac slept, for the wake line: `38 s`, `41 min`, `2 h 5 min`. */
export function sleptText(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const min = Math.round(s / 60);
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/** The wake line, on the plugin's root logger, from what `woke` measured: 0 for no system sleep. */
export function wakeLine(sleptMs: number): string {
	return `woke up: rescanning; ${sleptMs > 0 ? `slept ${sleptText(sleptMs)}` : "no system sleep"}`;
}

/** A device as the SDK has it. */
export type KnownDevice = { readonly id: string; readonly name: string; readonly isConnected: boolean };

export type DevicesOptions = {
	/** Repaints every key and strip in full: each of the plugin's key and dial classes' repaintInFull. */
	repaint: () => void;
	/** Some device is connected now, or none is any more (`live`): the front-app check and the slots' tick follow it. */
	onLive?: (live: boolean) => void;
	log?: Log;
	/** Monotonic: the beat, the repaints after a wake, and the time since it. */
	clock?: Clock;
	/** Wall-clock ms: how late a beat came by it is how long the Mac slept. */
	wallNow?: () => number;
};

/**
 * Which Stream Deck devices are connected, the full repaints, and the wake (agents-and-wake.md, C1 to C4). The plugin
 * hands it the SDK's device events, the presses and the wakes.
 * - **Connected:** from a device's connect to its disconnect. At start the SDK lists every device the Stream Deck app
 *   knows, connected or not, and the app then sends a connect for each one that is; `start` takes the SDK's
 *   `isConnected` all the same. While none is connected, `live` is false: the painters send nothing (C3), and `onLive`
 *   stops the front-app check and the slots' repaint tick. The model keeps up meanwhile, so the repaint is current.
 * - **A full repaint** (`repaint`) at every connect, and WAKE_REPAINTS_MS after each wake while a device is connected
 *   (C2).
 * - **A press from a device it has as away** means it missed that device's connect, since the app sends a press only
 *   from a device that's there: a warn line, then the connect (C1). An action appearing shows nothing of the kind: the
 *   app sends willAppear at a plugin start for a device that's asleep or on the other Mac too.
 * - **The wake:** `woke` says how long the Mac was in system sleep, and a device that connects within WAKE_WINDOW_MS
 *   of it says how long after (C4).
 * - **System sleep** is told by the beat: every BEAT_MS, from when it's made, it notes the wall clock, and a beat or a
 *   wake that comes over SLEEP_GAP_MS later than a beat allows found the Mac asleep for that much longer. It holds
 *   whichever clock the timers run on, one that counts the sleep (macOS) or one that doesn't. What it can't tell: a
 *   sleep shorter than what was left of its beat goes unseen, each sleep reads short by up to a beat, and a wall clock
 *   set forward, or the deck itself stalled, by over a beat reads as sleep.
 * Its lines, at info: `Device "<name>" (<id>) connected[, <s> s after the wake]`, `Device "<name>" (<id>)
 * disconnected`, and `Repaint: every key and strip (<why>)`, the formats claude-code/tools/smoke-check.mjs reads.
 */
export class Devices {
	readonly #repaint: () => void;
	readonly #onLive: (live: boolean) => void;
	readonly #log: Log;
	readonly #clock: Clock;
	readonly #wallNow: () => number;
	/** The connected devices' names, by id. */
	readonly #connected = new Map<string, string>();
	/** When the last wake came, on the monotonic clock; null before one. */
	#wokeAt: number | null = null;
	/** The repaints the last wake asked for. */
	#timers: TimerHandle[] = [];
	/** The next beat's timer; null once disposed. */
	#beat: TimerHandle | null = null;
	/** The wall clock when it was last noted: at the start, a beat or a wake. */
	#beatAt: number;
	/** The system sleep the beats found since the last wake, in ms. */
	#slept = 0;

	constructor(opts: DevicesOptions) {
		this.#repaint = opts.repaint;
		this.#onLive = opts.onLive ?? (() => {});
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#beatAt = this.#wallNow();
		this.#arm();
	}

	/** Whether any device is connected: the painters hold their paints while none is. */
	get live(): boolean {
		return this.#connected.size > 0;
	}

	/** Once the plugin has connected to the Stream Deck app: the devices the SDK knows, and whether each is connected. */
	start(known: Iterable<KnownDevice>): void {
		const list = [...known];
		this.#log.info(`known at start: ${list.length === 0 ? "none" : list.map((d) => `${quote(d.name, 40)} (${d.id})${d.isConnected ? "" : ", not connected yet"}`).join("; ")}`);
		for (const d of list) if (d.isConnected) this.connected(d.id, d.name);
		this.#tell();
	}

	/** The SDK's onDeviceDidConnect. A connect for a device it has already is the app's word that it's back too. */
	connected(id: string, name: string): void {
		const was = this.live;
		this.#connected.set(id, name);
		const since = this.#wokeAt === null ? null : this.#clock.now() - this.#wokeAt;
		this.#log.info(`Device ${quote(name, 40)} (${id}) connected${since !== null && since <= WAKE_WINDOW_MS ? `, ${(since / 1000).toFixed(1)} s after the wake` : ""}`);
		if (!was) this.#tell();
		this.#repaintAll("device connected");
	}

	/** The SDK's onDeviceDidDisconnect. */
	disconnected(id: string, name: string): void {
		const was = this.live;
		this.#connected.delete(id);
		this.#log.info(`Device ${quote(name, 40)} (${id}) disconnected`);
		if (was && !this.live) this.#tell();
	}

	/** A key press, a dial's push or a touch came from the device: a connect it missed, unless it has the device already. */
	pressed(id: string, name: string): void {
		if (this.#connected.has(id)) return;
		this.#log.warn(`Device ${quote(name, 40)} (${id}): a press came from it, though the deck had it as not connected; taking it as connected`);
		this.connected(id, name);
	}

	/**
	 * The Mac woke (the SDK's onSystemDidWakeUp, which comes at a display wake or an unlock too): asks for the repaints
	 * after it, in place of the last wake's, and returns how long the Mac was in system sleep since the last wake, in
	 * ms; 0 for none. The wake can come before the beat the sleep made late, so it notes the time as a beat does, and
	 * times the next beat afresh: a beat is always due BEAT_MS after the time last noted.
	 */
	woke(): number {
		this.#note();
		this.#arm();
		const slept = this.#slept;
		this.#slept = 0;
		this.#wokeAt = this.#clock.now();
		this.#stopRepaints();
		this.#timers = WAKE_REPAINTS_MS.map((ms) => {
			const timer = this.#clock.setTimeout(() => this.#afterWake(ms), ms);
			(timer as { unref?: () => void }).unref?.();
			return timer;
		});
		return slept;
	}

	/** Stops the beat and the repaints a wake asked for. */
	dispose(): void {
		this.#stopRepaints();
		if (this.#beat !== null) this.#clock.clearTimeout(this.#beat);
		this.#beat = null;
	}

	#stopRepaints(): void {
		for (const timer of this.#timers) this.#clock.clearTimeout(timer);
		this.#timers = [];
	}

	/** Times the next beat a full BEAT_MS from now, in place of the one waiting. It never keeps the process up. */
	#arm(): void {
		if (this.#beat !== null) this.#clock.clearTimeout(this.#beat);
		this.#beat = this.#clock.setTimeout(() => {
			countIdle("beat");
			this.#note();
			this.#arm();
		}, BEAT_MS);
		(this.#beat as { unref?: () => void }).unref?.();
	}

	/** Notes the wall clock, and counts as system sleep whatever it went on by beyond a beat since it was last noted. */
	#note(): void {
		const wall = this.#wallNow();
		const late = wall - this.#beatAt - BEAT_MS;
		if (late > SLEEP_GAP_MS) this.#slept += late;
		this.#beatAt = wall;
	}

	#afterWake(ms: number): void {
		if (!this.live) {
			this.#log.debug(`no repaint ${ms / 1000} s after the wake: no device is connected`);
			return;
		}
		this.#repaintAll(`${ms / 1000} s after the wake`);
	}

	/** Tells `onLive` whether a device is connected now. Nothing here throws into the SDK's event handlers. */
	#tell(): void {
		try {
			this.#onLive(this.live);
		} catch (err) {
			this.#log.error(`following the devices threw: ${describeError(err)}`);
		}
	}

	#repaintAll(why: string): void {
		this.#log.info(`Repaint: every key and strip (${why})`);
		try {
			this.#repaint();
		} catch (err) {
			this.#log.error(`repainting every key and strip threw: ${describeError(err)}`);
		}
	}
}
