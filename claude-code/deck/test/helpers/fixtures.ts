import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ALLOW_DECISION, DENY_DECISION, NO_DECISION, PRETOOL_ALLOW, ROUTES } from "../../src/protocol/wire.js";
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

/**
 * The answers Claude Code reads, by route, from the deck's own wire module: PROTOCOL.md's three to a
 * PermissionRequest, and its two to a mode check.
 */
const HOOK_ANSWERS: Readonly<Record<string, { bodies: readonly unknown[]; names: string }>> = {
	[ROUTES.permission]: { bodies: [ALLOW_DECISION, DENY_DECISION, NO_DECISION], names: "Allow, Deny or {}" },
	[ROUTES.pretool]: { bodies: [PRETOOL_ALLOW, NO_DECISION], names: "the mode check's allow or {}" },
};

/**
 * What a `reply` line finds wrong with an answer, or an empty list; `want` is undefined when the line gives no
 * body. A 2xx from a hook's route, `/v1/permission` or `/v1/pretool`, is held to more than PROTOCOL.md's general
 * matching, whatever the line expects: it must be exactly one of the bodies its route allows (Allow, Deny or `{}`
 * for a PermissionRequest; the allow or `{}` for a mode check), and an expected `{}` means no decision, so no
 * `hookSpecificOutput`. By the general rule alone, `{}` matches any answer, an Allow included, and extra fields
 * such as `updatedPermissions` pass. Any other status, from any route, must carry `{"error": "<reason>"}`
 * (Transport).
 */
export function replyMismatches(route: string, status: number, want: unknown, got: unknown): string[] {
	const problems: string[] = [];
	const ok = status >= 200 && status < 300;
	const hook = Object.hasOwn(HOOK_ANSWERS, route) ? HOOK_ANSWERS[route] : undefined;
	if (hook && ok) {
		if (!hook.bodies.some((d) => isDeepStrictEqual(d, got))) problems.push(`$: expected exactly ${hook.names}, got ${JSON.stringify(got)}`);
		const none = typeof want === "object" && want !== null && Object.keys(want).length === 0;
		if (none && typeof got === "object" && got !== null && "hookSpecificOutput" in got) problems.push(`$: expected no decision ({}), got ${JSON.stringify(got)}`);
	}
	if (!ok && !(typeof got === "object" && got !== null && typeof (got as Obj).error === "string")) problems.push(`$: expected {"error": "<reason>"} with ${status}, got ${JSON.stringify(got)}`);
	if (want !== undefined) problems.push(...mismatches(want, got));
	return problems;
}

/** Which labels a later `reply` line checks. */
export function repliedLabels(lines: FixtureLine[]): Set<string> {
	return new Set(lines.flatMap((l) => ("reply" in l ? [l.reply.to] : [])));
}
