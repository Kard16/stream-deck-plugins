import { type Clock, realClock, type TimerHandle } from "../util/clock.js";
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
 * The least gap that counts as system sleep: how much further the wall clock went than the monotonic one, which stops
 * while macOS sleeps (performance.now). Display sleep stops neither (agents-and-wake.md, C4).
 */
export const SLEEP_GAP_MS = 2000;

/**
 * Awake, the two clocks drift apart too, the monotonic one by its crystal while the wall clock is kept to time: a gap
 * under this share of the time awake since the last look is drift, not sleep. 100 ppm is a few times a crystal's.
 */
export const DRIFT_RATIO = 1e-4;

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
	/** Monotonic: the repaints after a wake, and the time since it. */
	clock?: Clock;
	/** Wall-clock ms: how much further it went than the monotonic clock is how long the Mac slept. */
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
	/** Both clocks at the last look, the start or a wake: the next wake's sleep is measured from them. */
	#ref: { wall: number; mono: number };

	constructor(opts: DevicesOptions) {
		this.#repaint = opts.repaint;
		this.#onLive = opts.onLive ?? (() => {});
		this.#log = opts.log ?? nullLog;
		this.#clock = opts.clock ?? realClock;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#ref = this.#look();
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
	 * after it, in place of the last wake's, and returns how long the Mac was in system sleep since the last look, in
	 * ms; 0 for none.
	 */
	woke(): number {
		const now = this.#look();
		const awake = now.mono - this.#ref.mono;
		const gap = now.wall - this.#ref.wall - awake;
		this.#ref = now;
		this.#wokeAt = now.mono;
		this.dispose();
		this.#timers = WAKE_REPAINTS_MS.map((ms) => {
			const timer = this.#clock.setTimeout(() => this.#afterWake(ms), ms);
			(timer as { unref?: () => void }).unref?.();
			return timer;
		});
		return gap > Math.max(SLEEP_GAP_MS, awake * DRIFT_RATIO) ? gap : 0;
	}

	/** Stops the repaints a wake asked for. */
	dispose(): void {
		for (const timer of this.#timers) this.#clock.clearTimeout(timer);
		this.#timers = [];
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

	#look(): { wall: number; mono: number } {
		return { wall: this.#wallNow(), mono: this.#clock.now() };
	}
}
