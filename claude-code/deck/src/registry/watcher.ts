import { describeError, type Log, nullLog } from "../util/log.js";
import type { RegistryReader, RegistrySession } from "./registry.js";

/** The registry is re-read every second. Unchanged files are only stat'ed. */
export const REGISTRY_POLL_MS = 1000;

/**
 * Re-reads the registry every second and tells listeners when the list of sessions or any of their fields
 * changed. Polling rather than fs.watch: it's simpler, and a second is quick enough for the deck.
 */
export class RegistryWatcher {
	readonly #reader: RegistryReader;
	readonly #log: Log;
	readonly #pollMs: number;
	readonly #listeners = new Set<(sessions: RegistrySession[]) => void>();
	#sessions: RegistrySession[] = [];
	#json = "";
	#timer: ReturnType<typeof setInterval> | null = null;
	#running: Promise<void> | null = null;
	#again = false;

	constructor(reader: RegistryReader, opts: { log?: Log; pollMs?: number } = {}) {
		this.#reader = reader;
		this.#log = opts.log ?? nullLog;
		this.#pollMs = opts.pollMs ?? REGISTRY_POLL_MS;
	}

	get sessions(): RegistrySession[] {
		return this.#sessions;
	}

	onChange(listener: (sessions: RegistrySession[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(): void {
		if (this.#timer !== null) return;
		this.#timer = setInterval(() => void this.scanNow(), this.#pollMs);
		void this.scanNow();
	}

	stop(): void {
		if (this.#timer !== null) clearInterval(this.#timer);
		this.#timer = null;
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
			const before = this.#sessions.length;
			this.#sessions = sessions;
			this.#json = json;
			if (first || sessions.length !== before) this.#log.info(`${sessions.length} session(s) running`);
			else this.#log.debug("a session changed");
			for (const listener of [...this.#listeners]) {
				try {
					listener(sessions);
				} catch (err) {
					this.#log.error(`a listener threw: ${describeError(err)}`);
				}
			}
		} while (this.#again);
	}
}
