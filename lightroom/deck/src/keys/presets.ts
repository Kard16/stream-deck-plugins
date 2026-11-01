import { LrError, type LrLink } from "../lr/client.js";
import type { PresetItem } from "../lr/protocol.js";
import { nullLog, type Log } from "../util/log.js";

/** What the Apply Preset Property Inspector asks for, through sendToPlugin. */
export type PresetRequest = { t: "getPresets"; refresh?: boolean };

/**
 * The plugin's answer, through sendToPropertyInspector. `error` is a connection state (offline, busy, mismatch)
 * or an err or request code (timeout, failed, ...); `stale` marks a list kept from earlier.
 */
export type PresetReply = { t: "presets"; items: PresetItem[]; error?: string; stale?: boolean };

export function isPresetRequest(payload: unknown): payload is PresetRequest {
	return typeof payload === "object" && payload !== null && (payload as { t?: unknown }).t === "getPresets";
}

/** Folders, then names, alphabetically and with numbers in order ("Preset 2" before "Preset 10"). */
export function sortPresets(items: readonly PresetItem[]): PresetItem[] {
	const cmp = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	return [...items].sort((a, b) => cmp(a.folder, b.folder) || cmp(a.name, b.name));
}

/** Fetches Lightroom's Develop presets for the Property Inspector, keeping the last good list for when Lightroom is away. */
export class PresetCatalog {
	readonly #link: LrLink;
	readonly #log: Log;
	#items: PresetItem[] | null = null;
	#inflight: Promise<PresetReply> | null = null;

	constructor(link: LrLink, log: Log = nullLog) {
		this.#link = link;
		this.#log = log;
	}

	/** Asks Lightroom unless a request is already on its way. */
	list(): Promise<PresetReply> {
		this.#inflight ??= this.#fetch().finally(() => {
			this.#inflight = null;
		});
		return this.#inflight;
	}

	async #fetch(): Promise<PresetReply> {
		const kept = (error: string): PresetReply => ({ t: "presets", items: this.#items ?? [], error, stale: this.#items !== null });
		if (this.#link.state !== "online") return kept(this.#link.state);
		try {
			const evt = await this.#link.request({ t: "presets" }, { timeoutMs: 5000 });
			if (evt.t !== "presets") return kept("failed");
			this.#items = sortPresets(evt.items);
			// Every time a Property Inspector opens: below info.
			this.#log.debug(`listed ${this.#items.length} Develop presets`);
			return { t: "presets", items: this.#items };
		} catch (err) {
			const why = err instanceof LrError ? `${err.code}: ${err.message}` : String(err);
			this.#log.warn(`couldn't list presets: ${why}`);
			return kept(err instanceof LrError ? err.code : "failed");
		}
	}
}
