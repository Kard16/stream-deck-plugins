import type { Clock } from "../util/clock.js";
import { FolderWatch, type WatchFn } from "../util/folder-watch.js";
import { describeError, type Log, nullLog } from "../util/log.js";
import type { RegistryReader, RegistrySession } from "./registry.js";

/** The registry's `.key` files change only with their session's `.json`, and are never read: their events set off nothing. */
export function registryEventCounts(name: string | null): boolean {
	return name === null || !name.endsWith(".key");
}

export type RegistryWatcherOptions = {
	log?: Log;
	/** The debounce's and the safety scan's timers. */
	clock?: Clock;
	/** Wall-clock ms, for how long after its `statusUpdatedAt` a change was read. */
	wallNow?: () => number;
	/** fs.watch, for tests. */
	watch?: WatchFn;
	/** WATCH_DEBOUNCE_MS and SAFETY_SCAN_MS, for tests. */
	debounceMs?: number;
	safetyMs?: number;
};

/**
 * Reads the registry when it changes and tells listeners when the list of sessions or any of their fields changed.
 * Once started, it watches the folder (FolderWatch: fs.watch, FSEvents on macOS) and reads it about 50 ms after a burst
 * of changes to it, and every 30 s whatever the watch says (hardening.md, B4). Unchanged files are only stat'ed. Each
 * change is logged at debug with how long after its `statusUpdatedAt` the deck read it, so the lag can be measured live.
 */
export class RegistryWatcher {
	readonly #reader: RegistryReader;
	readonly #log: Log;
	readonly #wallNow: () => number;
	readonly #watch: FolderWatch;
	readonly #listeners = new Set<(sessions: RegistrySession[]) => void>();
	#sessions: RegistrySession[] = [];
	#json = "";
	#running: Promise<void> | null = null;
	#again = false;
	/** A safety scan with no event before it is waiting to run: a change it finds is one the watch missed. */
	#missedCheck = false;

	constructor(reader: RegistryReader, opts: RegistryWatcherOptions = {}) {
		this.#reader = reader;
		this.#log = opts.log ?? nullLog;
		this.#wallNow = opts.wallNow ?? Date.now;
		this.#watch = new FolderWatch(reader.dir, {
			accept: registryEventCounts,
			onScan: (why, quiet) => {
				if (why === "safety" && quiet) this.#missedCheck = true;
				void this.scanNow();
			},
			count: "reg",
			clock: opts.clock,
			log: this.#log,
			watch: opts.watch,
			debounceMs: opts.debounceMs,
			safetyMs: opts.safetyMs,
		});
	}

	get sessions(): RegistrySession[] {
		return this.#sessions;
	}

	/** Whether the folder is watched now; false before start, while it doesn't exist, and after a watch failed until the next safety scan. */
	get watching(): boolean {
		return this.#watch.watching;
	}

	onChange(listener: (sessions: RegistrySession[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Watches the folder, starts the safety scans, and scans now. */
	start(): void {
		this.#watch.start();
		void this.scanNow();
	}

	stop(): void {
		this.#watch.stop();
	}

	/**
	 * Scans now. A call during a scan runs one more scan after it, never two at once, and resolves when that
	 * one is done.
	 */
	scanNow(): Promise<void> {
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		this.#running = this.#loop().finally(() => {
			this.#running = null;
		});
		return this.#running;
	}

	async #loop(): Promise<void> {
		do {
			this.#again = false;
			const missedCheck = this.#missedCheck;
			this.#missedCheck = false;
			let sessions: RegistrySession[];
			try {
				sessions = await this.#reader.scan();
			} catch (err) {
				this.#log.warn(`scan failed: ${describeError(err)}`);
				continue;
			}
			const json = JSON.stringify(sessions);
			if (json === this.#json) continue;
			const first = this.#json === "";
			const before = this.#sessions;
			this.#sessions = sessions;
			this.#json = json;
			// The watch may have gone quiet without an error: it's counted, and watched afresh.
			if (missedCheck && !first) this.#watch.missed();
			if (first || sessions.length !== before.length) this.#log.info(`${sessions.length} session(s) running`);
			const changed = this.#changes(before, sessions);
			if (!first && (changed !== "" || sessions.length === before.length)) this.#log.debug(`a session changed${changed === "" ? "" : `: ${changed}`}`);
			for (const listener of [...this.#listeners]) {
				try {
					listener(sessions);
				} catch (err) {
					this.#log.error(`a listener threw: ${describeError(err)}`);
				}
			}
		} while (this.#again);
	}

	/**
	 * The sessions in both readings that changed, for the log: each one's pid and status, and, where its `statusUpdatedAt`
	 * moved, how long after it this reading came: `56532 busy → idle, read 64 ms after its statusUpdatedAt`.
	 */
	#changes(before: readonly RegistrySession[], after: readonly RegistrySession[]): string {
		const old = new Map(before.map((s) => [s.key, s]));
		const now = this.#wallNow();
		const out: string[] = [];
		for (const s of after) {
			const was = old.get(s.key);
			if (!was || JSON.stringify(was) === JSON.stringify(s)) continue;
			const status = was.status === s.status ? `${s.status ?? "no status"}` : `${was.status ?? "no status"} → ${s.status ?? "no status"}`;
			const lag = s.statusUpdatedAt !== null && s.statusUpdatedAt !== was.statusUpdatedAt ? `, read ${Math.round(now - s.statusUpdatedAt)} ms after its statusUpdatedAt` : "";
			out.push(`${s.key} ${status}${lag}`);
		}
		return out.join("; ");
	}
}
