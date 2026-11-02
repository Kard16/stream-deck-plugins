import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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
 * dropped. A file that doesn't parse, because it was caught half-written, keeps its last good record; a new
 * file that doesn't parse yet is left out until it does. A missing folder is an empty list.
 */
export class RegistryReader {
	readonly #dir: string;
	readonly #fs: RegistryFs;
	readonly #log: Log;
	readonly #cache = new Map<string, Cached>();
	#folderProblem: string | null = null;

	constructor(dir: string, opts: { fs?: RegistryFs; log?: Log } = {}) {
		this.#dir = dir;
		this.#fs = opts.fs ?? nodeRegistryFs;
		this.#log = opts.log ?? nullLog;
	}

	get dir(): string {
		return this.#dir;
	}

	async scan(): Promise<RegistrySession[]> {
		let names: string[];
		try {
			names = await this.#fs.readdir(this.#dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? describeError(err);
			// Logged once per kind of problem, not every second.
			if (this.#folderProblem !== code) this.#log.warn(`can't list ${this.#dir} (${code}): no sessions`);
			this.#folderProblem = code;
			this.#cache.clear();
			return [];
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
		return sessions.sort(compareSessions);
	}

	async #readOne(key: string, file: string): Promise<RegistrySession | null> {
		const cached = this.#cache.get(key);
		let sig: string;
		let text: string;
		try {
			const st = await this.#fs.stat(file);
			if (!st.isFile()) return null;
			sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
			if (cached && cached.sig === sig) return cached.good;
			text = await this.#fs.readFile(file);
		} catch (err) {
			// Gone between the listing and the read: the session ended. The next scan drops it.
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") this.#log.warn(`can't read ${file}: ${code ?? describeError(err)}`);
			return cached?.good ?? null;
		}
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
