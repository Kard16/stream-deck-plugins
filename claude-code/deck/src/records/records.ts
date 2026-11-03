import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { HOST_PATTERN, isObj, type Obj } from "../protocol/wire.js";
import { describeError, type Log, nullLog } from "../util/log.js";

/**
 * What the deck reads from the Claude app's own record of a session,
 * `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/<host>.json` (S5). It's
 * undocumented and read only: a missing field, or one of the wrong type, is null.
 */
export type AppRecord = {
	host: string;
	title: string | null;
	model: string | null;
	effort: string | null;
	/** The app's name for the mode: `default`, `acceptEdits`, `plan`, `auto`… */
	permissionMode: string | null;
	/** When the session was last on screen in the app, wall-clock ms. */
	lastFocusedAt: number | null;
	/**
	 * The category of the last turn, as the app's needs-input indicator reads it (see turnCategory): `blocked` and
	 * `need_input` show it. Null when the indicator ignores the record.
	 */
	turnCategory: string | null;
};

/** The file-system calls the reader makes, so tests can watch them. */
export interface RecordsFs {
	readdir(dir: string): Promise<string[]>;
	stat(file: string): Promise<{ mtimeMs: number; size: number; ino: number; isFile(): boolean; isDirectory(): boolean }>;
	readFile(file: string): Promise<string>;
}

export const nodeRecordsFs: RecordsFs = {
	readdir: (dir) => readdir(dir),
	stat: (file) => stat(file),
	readFile: (file) => readFile(file, "utf8"),
};

/**
 * A turn wrap-up as the app's record loader keeps it (its `jM`): an object with a string `description`, empty
 * included, and a `needsUser` that's missing or a string. The loader drops any other, so it's null here.
 */
function wrapUp(v: unknown): { needsUser: string | null } | null {
	if (!isObj(v) || typeof v.description !== "string") return null;
	if (v.needsUser === undefined) return { needsUser: null };
	return typeof v.needsUser === "string" ? { needsUser: v.needsUser } : null;
}

/** The post-turn summary's fields that the app's record loader keeps only when each is missing or a string. */
export const SUMMARY_STRING_FIELDS = ["title", "description", "status_category", "status_detail", "recent_action", "needs_action", "summarizes_uuid"] as const;

/**
 * A post-turn summary as the app's record loader keeps it (its `OM`): an object, not an array, whose
 * SUMMARY_STRING_FIELDS are each missing or a string, and whose `is_noteworthy` is missing or a boolean; `null` is
 * neither. The loader drops any other, so it's null here, as if the record had none (PROTOCOL.md, status rule 6).
 * Other fields don't matter.
 */
export function validSummary(v: unknown): Obj | null {
	if (!isObj(v)) return null;
	for (const field of SUMMARY_STRING_FIELDS) if (v[field] !== undefined && typeof v[field] !== "string") return null;
	if (v.is_noteworthy !== undefined && typeof v.is_noteworthy !== "boolean") return null;
	return v;
}

/**
 * The category of the record's last turn as the app's needs-input indicator reads it (app 4.4212.0's `_D`, with its
 * `Dw`, and the record loader's `OM` and `jM`; PROTOCOL.md, status rule 6). The indicator ignores a record with
 * neither a valid wrap-up nor a summary written for its last assistant message (`postTurnSummaryFor` equal to
 * `lastAssistantUuid`, both strings): null. The category is the valid summary's `status_category`, or none, which a
 * valid wrap-up changes: a failed summary stays failed; otherwise a wrap-up with `needsUser`, even an empty one, makes
 * it blocked, and one without turns blocked or need_input into review_ready.
 */
function turnCategory(o: Obj): string | null {
	const w = wrapUp(o.turnWrapUp);
	const forLast = typeof o.postTurnSummaryFor === "string" && typeof o.lastAssistantUuid === "string" && o.postTurnSummaryFor === o.lastAssistantUuid;
	if (w === null && !forLast) return null;
	const summary = validSummary(o.postTurnSummary);
	const category = typeof summary?.status_category === "string" ? summary.status_category : null;
	if (w === null || category === "failed") return category;
	if (w.needsUser !== null) return "blocked";
	return category === "blocked" || category === "need_input" ? "review_ready" : category;
}

/** A record from one file's text; null when it isn't a complete JSON object (say, caught mid-write). */
export function parseRecord(host: string, text: string): AppRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v !== "" ? v.slice(0, max) : null);
	return {
		host,
		title: str(o.title),
		model: str(o.model, 80),
		effort: str(o.effort, 40),
		permissionMode: str(o.permissionMode, 40),
		lastFocusedAt: typeof o.lastFocusedAt === "number" && Number.isFinite(o.lastFocusedAt) ? o.lastFocusedAt : null,
		// Cut short like the rest: one that's cut keeps 40 characters, so it can't turn into one the indicator shows.
		turnCategory: str(turnCategory(o), 40),
	};
}

type Known = { file: string; sig: string; record: AppRecord | null };

/**
 * Reads the app's records for the sessions the registry lists. A session's file is found once, by looking in
 * every `<account>/<org>/` folder, then only stat'ed each scan and read again when it changed. A file that
 * doesn't parse keeps the last good record; one that disappears is looked for again. Only `<host>.json`
 * files of hosts that match the app's own id pattern are ever opened.
 */
export class RecordsReader {
	readonly #root: string;
	readonly #fs: RecordsFs;
	readonly #log: Log;
	readonly #known = new Map<string, Known>();
	#problem: string | null = null;

	constructor(root: string, opts: { fs?: RecordsFs; log?: Log } = {}) {
		this.#root = root;
		this.#fs = opts.fs ?? nodeRecordsFs;
		this.#log = opts.log ?? nullLog;
	}

	get root(): string {
		return this.#root;
	}

	/** The records of `hosts` that exist now. */
	async scan(hosts: readonly string[]): Promise<Map<string, AppRecord>> {
		const wanted = new Set(hosts.filter((h) => HOST_PATTERN.test(h)));
		for (const host of [...this.#known.keys()]) if (!wanted.has(host)) this.#known.delete(host);

		const out = new Map<string, AppRecord>();
		let folders: string[] | null = null;
		for (const host of wanted) {
			let known = this.#known.get(host) ?? null;
			if (known && !(await this.#refresh(host, known))) {
				this.#known.delete(host);
				known = null;
			}
			if (!known) {
				folders ??= await this.#folders();
				known = await this.#find(host, folders);
				if (known) this.#known.set(host, known);
			}
			if (known?.record) out.set(host, known.record);
		}
		return out;
	}

	/** The `<account>/<org>` folders. A missing root means no records, logged once. */
	async #folders(): Promise<string[]> {
		let accounts: string[];
		try {
			accounts = await this.#fs.readdir(this.#root);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? describeError(err);
			if (this.#problem !== code) this.#log.warn(`can't list ${this.#root} (${code}): no app records`);
			this.#problem = code;
			return [];
		}
		if (this.#problem !== null) this.#log.info(`${this.#root} is readable again`);
		this.#problem = null;
		const out: string[] = [];
		for (const account of accounts) {
			if (account.startsWith(".")) continue;
			const dir = path.join(this.#root, account);
			let orgs: string[];
			try {
				if (!(await this.#fs.stat(dir)).isDirectory()) continue;
				orgs = await this.#fs.readdir(dir);
			} catch {
				continue;
			}
			for (const org of orgs) if (!org.startsWith(".")) out.push(path.join(dir, org));
		}
		return out;
	}

	async #find(host: string, folders: string[]): Promise<Known | null> {
		for (const folder of folders) {
			const file = path.join(folder, `${host}.json`);
			const known: Known = { file, sig: "", record: null };
			if (await this.#refresh(host, known)) return known;
		}
		return null;
	}

	/** Re-reads `known.file` if it changed. False when it's gone. */
	async #refresh(host: string, known: Known): Promise<boolean> {
		let text: string;
		try {
			const st = await this.#fs.stat(known.file);
			if (!st.isFile()) return false;
			const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
			if (sig === known.sig) return true;
			text = await this.#fs.readFile(known.file);
			known.sig = sig;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") this.#log.warn(`can't read ${known.file}: ${code ?? describeError(err)}`);
			return false;
		}
		const record = parseRecord(host, text);
		if (record) known.record = record;
		else this.#log.debug(`${host}.json doesn't parse (${text.length} bytes; half-written?): ${known.record ? "keeping the last good record" : "no record yet"}`);
		return true;
	}
}

/** The records are checked every second, like the registry. Unchanged files are only stat'ed. */
export const RECORDS_POLL_MS = 1000;

/**
 * Re-reads the records of the sessions the registry lists, at once when the list changes and every second
 * after, and tells listeners when any record changed.
 */
export class RecordsWatcher {
	readonly #reader: RecordsReader;
	readonly #log: Log;
	readonly #pollMs: number;
	readonly #listeners = new Set<(records: Map<string, AppRecord>) => void>();
	#hosts: string[] = [];
	#records = new Map<string, AppRecord>();
	#json = "";
	#timer: ReturnType<typeof setInterval> | null = null;
	#running: Promise<void> | null = null;
	#again = false;

	constructor(reader: RecordsReader, opts: { log?: Log; pollMs?: number } = {}) {
		this.#reader = reader;
		this.#log = opts.log ?? nullLog;
		this.#pollMs = opts.pollMs ?? RECORDS_POLL_MS;
	}

	get records(): Map<string, AppRecord> {
		return this.#records;
	}

	onChange(listener: (records: Map<string, AppRecord>) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The hosts the registry lists now. New ones are read at once. */
	setHosts(hosts: readonly string[]): void {
		const next = [...hosts].sort();
		if (next.join("\n") === this.#hosts.join("\n")) return;
		this.#hosts = next;
		void this.scanNow();
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
			let records: Map<string, AppRecord>;
			try {
				records = await this.#reader.scan(this.#hosts);
			} catch (err) {
				this.#log.warn(`records scan failed: ${describeError(err)}`);
				continue;
			}
			const json = JSON.stringify([...records.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
			if (json === this.#json) continue;
			this.#json = json;
			this.#records = records;
			this.#log.debug(`${records.size} app record(s) read`);
			for (const listener of [...this.#listeners]) {
				try {
					listener(records);
				} catch (err) {
					this.#log.error(`a listener threw: ${describeError(err)}`);
				}
			}
		} while (this.#again);
	}
}
