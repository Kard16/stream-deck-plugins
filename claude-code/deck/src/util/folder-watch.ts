import { watch as fsWatch } from "node:fs";

import { type Clock, realClock, type TimerHandle } from "./clock.js";
import { countIdle } from "./idle.js";
import { describeError, type Log, nullLog } from "./log.js";

/**
 * How long a burst of watch events is gathered before the one scan it sets off. FSEvents delivers an event about 12 ms
 * after the write (2026-11-06, Node 24 on macOS 26), and an atomic write is two or three, so a change reaches the deck
 * in about 65 ms with the scan.
 */
export const WATCH_DEBOUNCE_MS = 50;

/**
 * The safety scan, whatever the watch says: it catches what the watch missed (libuv drops FSEvents' own "events were
 * dropped" notices), and it's when a folder that wasn't there, or a watch that failed, is watched again.
 */
export const SAFETY_SCAN_MS = 30_000;

/** What fs.watch hands back, as FolderWatch uses it. Node's FSWatcher closes only when told to, so only its errors matter. */
export interface WatchHandle {
	on(event: "error", listener: (err: Error) => void): unknown;
	close(): void;
}

/** fs.watch's shape as FolderWatch calls it, so tests can stand in for it. It throws when the folder can't be watched. */
export type WatchFn = (dir: string, opts: { recursive: boolean }, onEvent: (name: string | null) => void) => WatchHandle;

/** fs.watch: FSEvents on macOS, for folders, recursive or not. A name is relative to the folder watched. */
export const nodeWatch: WatchFn = (dir, opts, onEvent) => fsWatch(dir, { recursive: opts.recursive, encoding: "utf8" }, (_type, name) => onEvent(name ?? null));

/** Why the watch set off a scan: a burst of its events, or the safety scan. */
export type ScanReason = "event" | "safety";

export type FolderWatchOptions = {
	/** Watch the folders under it too (the app's records tree). */
	recursive?: boolean;
	/** Whether an event for this name (relative to the folder; null when the system gives none) sets off a scan. */
	accept?: (name: string | null) => boolean;
	/**
	 * Runs the scan. `quiet`, for a safety scan: no event it accepted came since the scan before, so a change the scan
	 * finds is one the watch missed, which the owner says with `missed`.
	 */
	onScan: (why: ScanReason, quiet: boolean) => void;
	/** The idle counts' prefix: `<prefix>.event` for each event, `<prefix>.safety` for each safety scan, `<prefix>.missed`. */
	count: string;
	clock?: Clock;
	log?: Log;
	watch?: WatchFn;
	debounceMs?: number;
	safetyMs?: number;
};

/**
 * Tells its owner when to scan a folder (hardening.md, B4): WATCH_DEBOUNCE_MS after the first event of a burst the
 * owner accepts, so a burst, as an atomic write's events or FSEvents' coalesced ones, is one scan; and every
 * SAFETY_SCAN_MS whatever the watch says. A folder that isn't there when it starts, or a watch that errors, leaves the
 * safety scans to do the work: each first tries to watch again, so a folder that appears later is watched from the next
 * one on. A watch that goes quiet without an error is watched afresh once a safety scan finds a change it didn't
 * announce (`missed`). FSEvents watches the path, so a folder deleted and made again stays watched. Nothing here reads
 * a file: the owner's scan does.
 */
export class FolderWatch {
	readonly #dir: string;
	readonly #recursive: boolean;
	readonly #accept: (name: string | null) => boolean;
	readonly #onScan: (why: ScanReason, quiet: boolean) => void;
	readonly #count: string;
	readonly #clock: Clock;
	readonly #log: Log;
	readonly #watch: WatchFn;
	readonly #debounceMs: number;
	readonly #safetyMs: number;
	#running = false;
	#watcher: WatchHandle | null = null;
	#debounce: TimerHandle | null = null;
	#safety: TimerHandle | null = null;
	/** An accepted event came since the last scan this set off. */
	#heard = false;
	/** Why the folder can't be watched now, for one line until it can; null while it's watched, or before the first try. */
	#problem: string | null = null;
	/** A missed change has been logged at info: the rest go at debug. */
	#saidMissed = false;

	constructor(dir: string, opts: FolderWatchOptions) {
		this.#dir = dir;
		this.#recursive = opts.recursive ?? false;
		this.#accept = opts.accept ?? (() => true);
		this.#onScan = opts.onScan;
		this.#count = opts.count;
		this.#clock = opts.clock ?? realClock;
		this.#log = opts.log ?? nullLog;
		this.#watch = opts.watch ?? nodeWatch;
		this.#debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
		this.#safetyMs = opts.safetyMs ?? SAFETY_SCAN_MS;
	}

	/** Whether a watch is up now. */
	get watching(): boolean {
		return this.#watcher !== null;
	}

	/** Watches the folder, if it can, and starts the safety scans. The owner scans once itself. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#arm();
		this.#armSafety();
	}

	stop(): void {
		this.#running = false;
		if (this.#debounce !== null) this.#clock.clearTimeout(this.#debounce);
		if (this.#safety !== null) this.#clock.clearTimeout(this.#safety);
		this.#debounce = null;
		this.#safety = null;
		this.#close(this.#watcher);
		this.#watcher = null;
	}

	/**
	 * The owner's safety scan, quiet (no accepted event since the scan before), found a change: the watch may have gone
	 * quiet without an error. Counted, said at info the first time and at debug after, and the folder watched afresh.
	 */
	missed(): void {
		countIdle(`${this.#count}.missed`);
		const line = `the safety scan found a change in ${this.#dir} that no watch event announced: watching it afresh`;
		if (this.#saidMissed) this.#log.debug(line);
		else this.#log.info(line);
		this.#saidMissed = true;
		this.#close(this.#watcher);
		this.#watcher = null;
		this.#arm();
	}

	#arm(): void {
		if (!this.#running || this.#watcher !== null) return;
		let watcher: WatchHandle;
		try {
			watcher = this.#watch(this.#dir, { recursive: this.#recursive }, (name) => this.#event(watcher, name));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? describeError(err).split("\n")[0] ?? "unknown";
			if (this.#problem !== code) this.#log.info(`can't watch ${this.#dir} (${code}): the safety scan reads it every ${this.#safetyMs / 1000} s, and tries to watch it again`);
			this.#problem = code;
			return;
		}
		watcher.on("error", (err) => this.#lost(watcher, `its watch failed: ${describeError(err).split("\n")[0] ?? "error"}`));
		this.#watcher = watcher;
		if (this.#problem !== null) this.#log.info(`watching ${this.#dir} again`);
		this.#problem = null;
	}

	#event(watcher: WatchHandle, name: string | null): void {
		countIdle(`${this.#count}.event`);
		if (!this.#running || watcher !== this.#watcher || !this.#accept(name)) return;
		this.#heard = true;
		if (this.#debounce !== null) return;
		this.#debounce = this.#clock.setTimeout(() => {
			this.#debounce = null;
			if (this.#running) this.#scan("event");
		}, this.#debounceMs);
	}

	/** A watch that failed: the safety scans take over, and the next watches again. A scan now catches what it missed. */
	#lost(watcher: WatchHandle, why: string): void {
		if (watcher !== this.#watcher) return;
		this.#watcher = null;
		this.#close(watcher);
		if (!this.#running) return;
		this.#problem = why;
		this.#log.warn(`${this.#dir}: ${why}; the safety scan reads it every ${this.#safetyMs / 1000} s, and tries to watch it again`);
		this.#scan("event");
	}

	#armSafety(): void {
		this.#safety = this.#clock.setTimeout(() => {
			this.#safety = null;
			if (!this.#running) return;
			countIdle(`${this.#count}.safety`);
			// Watch again first, so nothing that changes during the scan goes unseen. With no watch up until now, what the
			// scan finds was no watch's to announce.
			const watched = this.#watcher !== null;
			this.#arm();
			this.#scan("safety", watched);
			this.#armSafety();
		}, this.#safetyMs);
	}

	#scan(why: ScanReason, watched = true): void {
		const quiet = watched && !this.#heard;
		this.#heard = false;
		try {
			this.#onScan(why, quiet);
		} catch (err) {
			this.#log.error(`a scan of ${this.#dir} threw: ${describeError(err)}`);
		}
	}

	#close(watcher: WatchHandle | null): void {
		if (watcher === null) return;
		try {
			watcher.close();
		} catch {
			// Closed already.
		}
	}
}
