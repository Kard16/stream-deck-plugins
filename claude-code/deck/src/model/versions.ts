import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";

import { isObj } from "../protocol/wire.js";
import { type Log, nullLog, quote } from "../util/log.js";

/**
 * Drift, caught the day it lands (hardening.md, C1). Each session's hello says which Claude Code it runs (`cc`) and
 * which plugin (`plugin`), and the deck holds both to the repo it's linked from:
 * - **Claude Code:** the version on the first line of the vendored mods API reference, the one the repo was checked
 *   against (vendor/refresh.mjs writes it, tools/recheck.mjs reads it). A session on a newer one gets one log line per
 *   version a run, and its Session Slot's Setup page marks its version (slots/strip.ts).
 * - **The plugin:** the version in the plugin's own plugin.json. A session on an older one hasn't started since a
 *   release: one log line per session.
 *
 * Both files are read at startup, and each again when a hello brings a newer version than the one read from it, so a
 * refresh or a release mid-run is seen without a restart. A file that can't be read, or names no version, logs one
 * warn, and nothing is held to it until a read of it works again.
 */

/** A release's version: x.y.z, each a whole number, as `claude --version` prints it. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The reference's first line, as vendor/refresh.mjs writes it (its `firstLine`) and tools/recheck.mjs reads it. */
const FIRST_LINE = /^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\.$/;

/** How much of the reference is read: its first line is about 35 bytes, and the whole file about 700 kB. */
const HEAD_BYTES = 256;

/** `v` when it's a release's x.y.z, else null: the mod's `unknown` when it can't read one, a dev build's, anything else. */
export function asVersion(v: unknown): string | null {
	return typeof v === "string" && VERSION.test(v) ? v : null;
}

/** `a` against `b`, x.y.z by number (2.1.4 < 2.1.317 < 10.0.0): negative, 0 or positive; null unless both are x.y.z. */
export function compareVersions(a: string | null, b: string | null): number | null {
	const pa = a === null ? null : VERSION.exec(a);
	const pb = b === null ? null : VERSION.exec(b);
	if (!pa || !pb) return null;
	for (let i = 1; i <= 3; i++) {
		const d = Number(pa[i]) - Number(pb[i]);
		if (d !== 0) return d;
	}
	return 0;
}

/** The Claude Code version the reference's first line names, from the start of the file; null when it names none. */
export function checkedVersion(head: string): string | null {
	return FIRST_LINE.exec(firstLine(head))?.[1] ?? null;
}

/** plugin.json's `version` when it's x.y.z; null for anything else, a file that isn't JSON included. */
export function pluginVersion(json: string): string | null {
	try {
		const o: unknown = JSON.parse(json);
		return isObj(o) ? asVersion(o.version) : null;
	} catch {
		return null;
	}
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

/** The two files a VersionCheck reads. */
export type VersionFiles = {
	/** claude-code/vendor/mods-api/claude-code.d.ts: its first line names the Claude Code version the repo was checked against. */
	reference: string;
	/** claude-code/plugin/.claude-plugin/plugin.json: its `version` is the plugin's in the repo. */
	plugin: string;
};

/**
 * Where the two files are, from the deck's plugin folder, claude-code/deck/com.karimdhanji.claude.sdPlugin: both under
 * `../..`, the repo's claude-code folder. The Stream Deck app runs the plugin from the repo's own path, and Node takes
 * a script's real path anyway, so the link in the app's Plugins folder doesn't come into it.
 */
export function versionFiles(pluginDir: string): VersionFiles {
	const claudeCode = path.join(pluginDir, "..", "..");
	return {
		reference: path.join(claudeCode, "vendor", "mods-api", "claude-code.d.ts"),
		plugin: path.join(claudeCode, "plugin", ".claude-plugin", "plugin.json"),
	};
}

type Which = keyof VersionFiles;

/** What each file's version is to the log. */
const WHAT: Record<Which, { name: string; unknown: string }> = {
	reference: { name: "the Claude Code version the repo was checked against", unknown: "no session's version is marked newer" },
	plugin: { name: "the plugin's version in the repo", unknown: "no session is said to run an older plugin" },
};

/** See the top of this file. */
export class VersionCheck {
	readonly #files: VersionFiles;
	readonly #log: Log;
	readonly #versions: Record<Which, string | null> = { reference: null, plugin: null };
	/** Whether each file's latest read failed, so a failure warns once, until a read of it works again. */
	readonly #failing: Record<Which, boolean> = { reference: false, plugin: false };
	/** The newer Claude Code versions logged this run. */
	readonly #newerLogged = new Set<string>();
	/** The sessions logged for an older plugin, by host. */
	readonly #olderLogged = new Set<string>();

	constructor(files: VersionFiles, opts: { log?: Log } = {}) {
		this.#files = files;
		this.#log = opts.log ?? nullLog;
		this.#versions.reference = this.#read("reference");
		this.#versions.plugin = this.#read("plugin");
		this.#log.info(`the repo was checked against Claude Code ${this.#versions.reference ?? "(unknown)"}, and has plugin ${this.#versions.plugin ?? "(unknown)"}`);
	}

	/** The Claude Code version the repo was checked against; null while its reference can't be read or names none. */
	get checked(): string | null {
		return this.#versions.reference;
	}

	/** The plugin's version in the repo; null while its plugin.json can't be read or has none. */
	get plugin(): string | null {
		return this.#versions.plugin;
	}

	/** Whether `cc` is newer than the Claude Code version the repo was checked against: false while either is unknown. */
	newer(cc: string | null): boolean {
		return (compareVersions(cc, this.#versions.reference) ?? 0) > 0;
	}

	/**
	 * A hello that counts: from the session's current mod instance (SessionModel's #greet), before the deck's views are
	 * built afresh. A version newer than the one read from its file, or one while none could be read, has that file read
	 * again first. Then one info line for each newer Claude Code version a run, and one for each session on an older
	 * plugin. `unknown`, or anything else that isn't x.y.z, is held to nothing.
	 */
	hello(host: string, cc: string | null, plugin: string | null): void {
		const v = asVersion(cc);
		if (v !== null) {
			this.#again("reference", v);
			if (this.newer(v) && !this.#newerLogged.has(v)) {
				this.#newerLogged.add(v);
				this.#log.info(`Claude Code ${v} in ${host}: newer than ${this.#versions.reference}, which the repo was checked against; run the routine after an update (CLAUDE.md)`);
			}
		}
		const p = asVersion(plugin);
		if (p !== null) {
			this.#again("plugin", p);
			if ((compareVersions(p, this.#versions.plugin) ?? 0) < 0 && !this.#olderLogged.has(host)) {
				this.#olderLogged.add(host);
				this.#log.info(`${host} runs plugin ${p}, older than ${this.#versions.plugin} in the repo: it loads the new one when it next starts`);
			}
		}
	}

	/** Reads a file again when a hello's `seen` is newer than its version, or it has none; a version it changes to is logged. */
	#again(which: Which, seen: string): void {
		const was = this.#versions[which];
		if (was !== null && (compareVersions(seen, was) ?? 0) <= 0) return;
		const now = this.#read(which);
		this.#versions[which] = now;
		if (now !== null && now !== was) this.#log.info(`${WHAT[which].name} is now ${now}${was === null ? "" : `, not ${was}`}`);
	}

	/** One file's version, read now: null when it can't be read or names none, with one warn until a read works again. */
	#read(which: Which): string | null {
		const file = this.#files[which];
		let version: string | null = null;
		let why: string;
		try {
			if (which === "reference") {
				const line = firstLine(readHead(file));
				version = checkedVersion(line);
				why = `its first line, ${quote(line, 60)}, names no version`;
			} else {
				version = pluginVersion(readFileSync(file, "utf8"));
				why = "it has no version that reads x.y.z";
			}
		} catch (err) {
			why = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
		}
		if (version !== null) {
			this.#failing[which] = false;
			this.#log.debug(`read ${which === "reference" ? `Claude Code ${version}` : `plugin ${version}`} from ${file}`);
			return version;
		}
		if (!this.#failing[which]) {
			this.#failing[which] = true;
			this.#log.warn(`can't read ${WHAT[which].name} from ${file} (${why}), so ${WHAT[which].unknown}`);
		}
		return null;
	}
}

/** The first HEAD_BYTES of a file, as text. */
function readHead(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(HEAD_BYTES);
		return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
	} finally {
		closeSync(fd);
	}
}
