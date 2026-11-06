import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { countIdle } from "../util/idle.js";
import { describeError, type Log, nullLog } from "../util/log.js";

/**
 * One running Claude Code session, from its file in the live registry, `~/.claude/sessions/<pid>.json`
 * (docs/claude-code/plan.md, "What the kickoff checks found"). The registry is undocumented, so every field
 * can be missing: a field that is absent or has the wrong type is null.
 */
export type RegistrySession = {
	/** The file's name without `.json`: the session's pid. Stable for the session's life. */
	key: string;
	/** The sidebar title. */
	name: string | null;
	/** The raw value: `idle`, `busy`, or `waiting` while a permission prompt is open (S2). */
	status: string | null;
	cwd: string | null;
	/** The desktop app's `local_…` id. */
	hostSessionId: string | null;
	/** Claude Code's UUID, which names the transcript. */
	sessionId: string | null;
	statusUpdatedAt: number | null;
	/** Only for ordering the list. */
	startedAt: number | null;
};

/** The file-system calls the reader makes, so tests can watch them. Only `.json` files are ever read. */
export interface RegistryFs {
	readdir(dir: string): Promise<string[]>;
	stat(file: string): Promise<{ mtimeMs: number; size: number; ino: number; isFile(): boolean }>;
	readFile(file: string): Promise<string>;
}

export const nodeRegistryFs: RegistryFs = {
	readdir: (dir) => readdir(dir),
	stat: (file) => stat(file),
	readFile: (file) => readFile(file, "utf8"),
};

/** Registry files are `<pid>.json`. Each has a `0600` `<pid>.<hash>.key` beside it, which nothing here reads. */
export function isSessionFile(name: string): boolean {
	return name.endsWith(".json") && !name.startsWith(".");
}

/** A session from one file's text; null when the text isn't a complete JSON object (say, caught mid-write). */
export function parseSession(key: string, text: string): RegistrySession | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
	const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
	return {
		key,
		name: str(o.name),
		status: str(o.status),
		cwd: str(o.cwd),
		hostSessionId: str(o.hostSessionId),
		sessionId: str(o.sessionId),
		statusUpdatedAt: num(o.statusUpdatedAt),
		startedAt: num(o.startedAt),
	};
}

/** Oldest session first, so the list keeps its order while sessions work: by start time, then pid. */
export function compareSessions(a: RegistrySession, b: RegistrySession): number {
	const sa = a.startedAt ?? Infinity;
	const sb = b.startedAt ?? Infinity;
	if (sa !== sb) return sa < sb ? -1 : 1;
	const pa = Number(a.key);
	const pb = Number(b.key);
	if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

type Cached = {
	/** mtime, size and inode when last read: a file whose signature hasn't changed isn't read again. */
	sig: string;
	/** The last record that parsed. A later read that doesn't parse keeps it. */
	good: RegistrySession | null;
	/** The last read, at `sig`, didn't parse. */
	broken: boolean;
};

/**
 * Reads the registry folder. Each scan lists it again: new files are added, changed ones re-read, deleted ones
 * dropped. A file that doesn't parse, because it was caught half-written, or can't be read, keeps its last good
 * record; a new one is left out until it reads and parses. A missing folder is an empty list: no sessions. A
 * folder that can't be listed for any other reason changes nothing: the scan returns the last reading as it was,
 * so no session ends on its account (PROTOCOL.md, The deck's session model).
 */
export class RegistryReader {
	readonly #dir: string;
	readonly #fs: RegistryFs;
	readonly #log: Log;
	readonly #cache = new Map<string, Cached>();
	/** What the last scan found wrong with the folder: missing (ENOENT), or unreadable for another reason. */
	#folderProblem: "missing" | "unreadable" | null = null;
	/** By key, why a file couldn't be read at the last scan that tried: logged once until it reads again. */
	readonly #fileProblems = new Map<string, string>();
	/** The last reading: what a scan returns when it can't list the folder. */
	#last: RegistrySession[] = [];

	constructor(dir: string, opts: { fs?: RegistryFs; log?: Log } = {}) {
		this.#dir = dir;
		this.#fs = opts.fs ?? nodeRegistryFs;
		this.#log = opts.log ?? nullLog;
	}

	get dir(): string {
		return this.#dir;
	}

	/**
	 * The sessions the folder lists now, oldest first. A folder that doesn't exist lists none. One that can't be listed
	 * otherwise gives the last reading again. Either problem is warned of once, until a scan lists the folder again,
	 * which is logged at info.
	 */
	async scan(): Promise<RegistrySession[]> {
		countIdle("reg.scan");
		let names: string[];
		try {
			countIdle("reg.readdir");
			names = await this.#fs.readdir(this.#dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? describeError(err).split("\n")[0] ?? "unknown";
			if (code === "ENOENT") {
				// No folder, no sessions.
				if (this.#folderProblem !== "missing") this.#log.warn(`can't list ${this.#dir} (ENOENT): no sessions`);
				this.#folderProblem = "missing";
				this.#cache.clear();
				this.#fileProblems.clear();
				this.#last = [];
				return [];
			}
			// A folder that's there and can't be listed says nothing about the sessions: the last reading stands, so
			// nothing ends, nothing is released and no command fails on its account.
			if (this.#folderProblem !== "unreadable") this.#log.warn(`can't list ${this.#dir} (${code}): keeping the last reading, of ${this.#last.length} session(s), until it can`);
			this.#folderProblem = "unreadable";
			return [...this.#last];
		}
		if (this.#folderProblem !== null) this.#log.info(`${this.#dir} is readable again`);
		this.#folderProblem = null;

		const seen = new Set<string>();
		const sessions: RegistrySession[] = [];
		for (const name of names) {
			if (!isSessionFile(name)) continue;
			const key = name.slice(0, -".json".length);
			seen.add(key);
			const session = await this.#readOne(key, path.join(this.#dir, name));
			if (session) sessions.push(session);
		}
		for (const key of [...this.#cache.keys()]) if (!seen.has(key)) this.#cache.delete(key);
		for (const key of [...this.#fileProblems.keys()]) if (!seen.has(key)) this.#fileProblems.delete(key);
		this.#last = sessions.sort(compareSessions);
		return [...this.#last];
	}

	async #readOne(key: string, file: string): Promise<RegistrySession | null> {
		const cached = this.#cache.get(key);
		let isFile: boolean;
		let sig: string;
		// Null when the file is unchanged since it was last read, or isn't a file: then it isn't read again.
		let text: string | null = null;
		try {
			countIdle("reg.stat");
			const st = await this.#fs.stat(file);
			isFile = st.isFile();
			sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
			if (isFile && cached?.sig !== sig) {
				countIdle("reg.read");
				text = await this.#fs.readFile(file);
			}
		} catch (err) {
			// Gone between the listing and the read: the session ended. The next scan drops it.
			const code = (err as NodeJS.ErrnoException).code ?? describeError(err).split("\n")[0] ?? "unknown";
			if (code !== "ENOENT") {
				// Once until it reads again, not every second.
				if (this.#fileProblems.get(key) !== code) this.#log.warn(`can't read ${file} (${code}): ${cached?.good ? "keeping its last good reading" : "leaving it out"} until it can`);
				this.#fileProblems.set(key, code);
			}
			return cached?.good ?? null;
		}
		// The stat went through, and so did the read if the file had changed: it reads again, from the file or, unchanged,
		// from the cache. Whatever kept it from reading is over, so a later failure is warned of afresh, even one with the
		// same code.
		this.#fileProblems.delete(key);
		if (!isFile) return null;
		if (text === null) return cached?.good ?? null;
		const parsed = parseSession(key, text);
		if (parsed) {
			this.#cache.set(key, { sig, good: parsed, broken: false });
			return parsed;
		}
		if (!cached?.broken) this.#log.debug(`${key}.json doesn't parse (${text.length} bytes; half-written?): ${cached?.good ? "keeping its last good record" : "leaving it out for now"}`);
		this.#cache.set(key, { sig, good: cached?.good ?? null, broken: true });
		return cached?.good ?? null;
	}
}
