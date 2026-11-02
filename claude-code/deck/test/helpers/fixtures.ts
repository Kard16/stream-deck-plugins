import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { fixturesDir } from "./paths.js";

export type Obj = Record<string, unknown>;

export type SetupSession = { sid: string; host: string; model: string; cwd: string; token: string };
export type Setup = { session: SetupSession; registry: Obj[]; records: Record<string, Obj> };
export type PluginLine = { as?: string; method: string; path: string; headers?: Record<string, string | null>; body?: unknown; raw?: string };
export type ReplyLine = { to: string; status: number; body?: unknown };

/** One line of a fixture conversation (PROTOCOL.md, Fixtures). */
export type FixtureLine =
	| { note: string }
	| { setup: Setup }
	| { mod: Obj }
	| { engine: Obj }
	| { plugin: PluginLine }
	| { reply: ReplyLine }
	| { press: Obj }
	| { registry: Obj }
	| { expect: Obj };

export type Fixture = { name: string; lines: FixtureLine[]; setup: Setup };

export type Vector = { tool: string; input: unknown; canonical: string; fp: string; summary: string };

export function loadFixtures(): Fixture[] {
	const dir = fixturesDir();
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.map((name) => {
			const lines = readFileSync(path.join(dir, name), "utf8")
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l, i) => {
					try {
						return JSON.parse(l) as FixtureLine;
					} catch (err) {
						throw new Error(`${name}:${i + 1} isn't JSON: ${String(err)}`);
					}
				});
			// PROTOCOL.md: the setup is the first line after the notes.
			const first = lines.find((l) => !("note" in l));
			if (!first || !("setup" in first)) throw new Error(`${name}: the first line after the notes isn't a setup`);
			return { name, lines, setup: first.setup };
		});
}

export function loadVectors(): Vector[] {
	return JSON.parse(readFileSync(path.join(fixturesDir(), "vectors.json"), "utf8")) as Vector[];
}

/**
 * PROTOCOL.md's matching: every field of an expected object must be present and equal, extra fields are
 * allowed, `"*"` matches any value, and arrays match when they're the same length and match element by
 * element. Returns what didn't match, or an empty list.
 */
export function mismatches(want: unknown, got: unknown, at = "$"): string[] {
	if (want === "*") return [];
	if (Array.isArray(want)) {
		if (!Array.isArray(got)) return [`${at}: expected an array, got ${JSON.stringify(got)}`];
		if (want.length !== got.length) return [`${at}: expected ${want.length} element(s), got ${got.length}: ${JSON.stringify(got)}`];
		return want.flatMap((w: unknown, i) => mismatches(w, got[i], `${at}[${i}]`));
	}
	if (typeof want === "object" && want !== null) {
		if (typeof got !== "object" || got === null || Array.isArray(got)) return [`${at}: expected an object, got ${JSON.stringify(got)}`];
		return Object.entries(want).flatMap(([k, w]) => (k in got ? mismatches(w, (got as Obj)[k], `${at}.${k}`) : [`${at}.${k}: missing`]));
	}
	return Object.is(want, got) || want === got ? [] : [`${at}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

/** Which labels a later `reply` line checks. */
export function repliedLabels(lines: FixtureLine[]): Set<string> {
	return new Set(lines.flatMap((l) => ("reply" in l ? [l.reply.to] : [])));
}
