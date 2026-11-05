import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SLOTS_FILE } from "../bridge/config.js";
import { asHost, isObj } from "../protocol/wire.js";
import { describeError, type Log, nullLog } from "../util/log.js";
import { compareSlots, parseSlotId, type SlotId } from "./ids.js";

/** Where the slots keep which session each holds, so they keep them across a deck restart (session-keys.md, Slots). */
export interface SlotStore {
	/** The saved slots, slot by slot; empty for none, or for a file that can't be read. */
	load(): Map<SlotId, string>;
	/** Saves every slot that holds a session, the whole set at once. */
	save(slots: ReadonlyMap<SlotId, string>): void;
}

/** The saved file's version. */
export const SLOTS_VERSION = 1;

/** The file's text for a set of slots: `{"v": 1, "slots": {"<device>:<row>:<col>": {"host": "local_…"}}}`, in slot order. */
export function slotsText(slots: ReadonlyMap<SlotId, string>): string {
	const entries = [...slots.entries()].sort(([a], [b]) => compareSlots(a, b));
	const out: Record<string, { host: string }> = {};
	for (const [slot, host] of entries) Object.defineProperty(out, slot, { value: { host }, enumerable: true, writable: true, configurable: true });
	return `${JSON.stringify({ v: SLOTS_VERSION, slots: out }, null, 2)}\n`;
}

/**
 * The slots in a saved file's text, or why it's bad: not JSON, not an object, another version, no `slots` object, a
 * slot id that isn't one, an entry that isn't `{"host": "<app id>"}`, or one session on two slots. A bad file gives no
 * slots at all, not some of them.
 */
export function parseSlots(text: string): { ok: true; slots: Map<SlotId, string> } | { ok: false; why: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, why: "it isn't JSON" };
	}
	if (!isObj(raw)) return { ok: false, why: "it isn't a JSON object" };
	if (raw.v !== SLOTS_VERSION) return { ok: false, why: `its version isn't ${SLOTS_VERSION}` };
	if (!isObj(raw.slots)) return { ok: false, why: "it has no slots object" };
	const slots = new Map<SlotId, string>();
	const hosts = new Set<string>();
	for (const [slot, entry] of Object.entries(raw.slots)) {
		if (parseSlotId(slot) === null) return { ok: false, why: `${JSON.stringify(slot).slice(0, 80)} isn't a slot id` };
		const host = isObj(entry) ? asHost(entry.host) : null;
		if (host === null) return { ok: false, why: `slot ${slot} doesn't hold an app id` };
		if (hosts.has(host)) return { ok: false, why: `${host} is on two slots` };
		hosts.add(host);
		slots.set(slot, host);
	}
	return { ok: true, slots };
}

/** The file-system calls the store makes, so tests can make them fail. */
export interface SlotFs {
	readFile(file: string): string;
	writeFile(file: string, text: string, mode: number): void;
	/** Flushes a written file to the disk, so a rename never puts an empty file in place after a power loss. */
	sync(file: string): void;
	rename(from: string, to: string): void;
	remove(file: string): void;
	mkdir(dir: string, mode: number): void;
	/** The names in a folder; none for a folder that isn't there. */
	list(dir: string): string[];
}

export const nodeSlotFs: SlotFs = {
	readFile: (file) => readFileSync(file, "utf8"),
	writeFile: (file, text, mode) => {
		writeFileSync(file, text, { mode, flag: "w" });
		chmodSync(file, mode);
	},
	sync: (file) => {
		const fd = openSync(file, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	},
	rename: (from, to) => renameSync(from, to),
	remove: (file) => rmSync(file, { force: true }),
	mkdir: (dir, mode) => {
		mkdirSync(dir, { recursive: true, mode });
	},
	list: (dir) => {
		try {
			return readdirSync(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	},
};

/** A save's temp file, `.slots.json.<pid>.tmp`, beside the file: one a crashed run left is removed at load. */
const TEMP_PATTERN = new RegExp(`^\\.${escapeRegExp(SLOTS_FILE)}\\.\\d+\\.tmp$`);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

/** The temp file a save by this process writes, beside the file. */
function tempName(): string {
	return `.${SLOTS_FILE}.${process.pid}.tmp`;
}

/**
 * `com.karimdhanji.claude.sdPlugin/run/slots.json`, found as the token is (src/bridge/token.ts): the plugin passes the
 * run folder. Read once at start: no file means no slots; a file that can't be read or is bad (parseSlots) means no
 * slots and one warn line. Saved whole on every change, written beside it, flushed to the disk and renamed into place,
 * so a reader never sees half a file, and a power loss leaves the old file or the new one. A save that fails is warned
 * of once until one works again, and the slots carry on in memory. A temp file another run left behind (a crash
 * between its write and its rename) is removed at load.
 */
export class SlotFile implements SlotStore {
	readonly #file: string;
	readonly #dir: string;
	readonly #fs: SlotFs;
	readonly #log: Log;
	#saveProblem: string | null = null;

	constructor(runDir: string, opts: { fs?: SlotFs; log?: Log } = {}) {
		this.#dir = runDir;
		this.#file = path.join(runDir, SLOTS_FILE);
		this.#fs = opts.fs ?? nodeSlotFs;
		this.#log = opts.log ?? nullLog;
	}

	get file(): string {
		return this.#file;
	}

	load(): Map<SlotId, string> {
		this.#sweep();
		let text: string;
		try {
			text = this.#fs.readFile(this.#file);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") this.#log.warn(`can't read ${SLOTS_FILE} (${code ?? describeError(err)}): the slots start empty`);
			return new Map();
		}
		const parsed = parseSlots(text);
		if (!parsed.ok) {
			this.#log.warn(`${SLOTS_FILE} is bad (${parsed.why}): the slots start empty`);
			return new Map();
		}
		return parsed.slots;
	}

	save(slots: ReadonlyMap<SlotId, string>): void {
		const tmp = path.join(this.#dir, tempName());
		try {
			this.#fs.mkdir(this.#dir, 0o700);
			this.#fs.writeFile(tmp, slotsText(slots), 0o600);
			this.#fs.sync(tmp);
			this.#fs.rename(tmp, this.#file);
		} catch (err) {
			const why = (err as NodeJS.ErrnoException).code ?? describeError(err).split("\n")[0] ?? "error";
			if (this.#saveProblem !== why) this.#log.warn(`can't save ${SLOTS_FILE} (${why}): the slots carry on, unsaved`);
			this.#saveProblem = why;
			try {
				this.#fs.remove(tmp);
			} catch {
				// Nothing more to do: the next save writes it again.
			}
			return;
		}
		if (this.#saveProblem !== null) this.#log.info(`${SLOTS_FILE} saved again`);
		this.#saveProblem = null;
	}

	/** Removes the temp files of earlier runs, which a crash between a save's write and its rename leaves behind. */
	#sweep(): void {
		let names: string[];
		try {
			names = this.#fs.list(this.#dir);
		} catch (err) {
			this.#log.warn(`can't list ${path.basename(this.#dir)}/ for old temp files (${(err as NodeJS.ErrnoException).code ?? describeError(err)})`);
			return;
		}
		for (const name of names) {
			if (!TEMP_PATTERN.test(name) || name === tempName()) continue;
			try {
				this.#fs.remove(path.join(this.#dir, name));
				this.#log.info(`removed ${name}, a temp file an earlier run left behind`);
			} catch (err) {
				this.#log.warn(`can't remove ${name}, a temp file an earlier run left behind: ${describeError(err)}`);
			}
		}
	}
}

/** A store in memory, for tests and the fixture runner: what was saved last, and how many saves. */
export class MemorySlotStore implements SlotStore {
	saved: Map<SlotId, string>;
	saves = 0;

	constructor(initial: ReadonlyMap<SlotId, string> = new Map()) {
		this.saved = new Map(initial);
	}

	load(): Map<SlotId, string> {
		return new Map(this.saved);
	}

	save(slots: ReadonlyMap<SlotId, string>): void {
		this.saved = new Map(slots);
		this.saves++;
	}
}
