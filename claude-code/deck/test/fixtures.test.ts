import assert from "node:assert/strict";
import type http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { BridgeServer } from "../src/bridge/server.js";
import { ModeKeys, PromptKeys } from "../src/keys/commands.js";
import { DecisionKeys } from "../src/keys/decision.js";
import { SessionModel } from "../src/model/sessions.js";
import { ALLOW_DECISION, DENY_DECISION, PRETOOL_ALLOW } from "../src/protocol/wire.js";
import { RecordsReader, RecordsWatcher } from "../src/records/records.js";
import { RegistryReader } from "../src/registry/registry.js";
import { RegistryWatcher } from "../src/registry/watcher.js";
import { type Fixture, loadFixtures, mismatches, type Obj, type PluginLine, repliedLabels, replyMismatches } from "./helpers/fixtures.js";
import { type Outcome, request, sleep, waitFor, within } from "./helpers/http.js";
import { RecordingLog } from "./helpers/recording-log.js";

/**
 * The deck side of every fixture (PROTOCOL.md, Fixtures), against the real bridge on an ephemeral port, with
 * a fake registry folder and records folder under a temp dir:
 * - `mod` and `engine` lines are skipped.
 * - `plugin` lines are sent in order, with the right Host and token added unless the line sets them (`$TOKEN`
 *   is the right token, `null` leaves a header out), and `*` values sent as they are. The runner waits for
 *   each answer, except for `/v1/permission` and `/v1/next`, which may be held: for those it waits until the
 *   bridge has taken the request (held or answered, after any second reading of the registry), and a later
 *   `reply` line checks the answer, waiting up to 2 s. A mode check (`/v1/pretool`) is answered at once, so
 *   the runner waits for it like any other.
 * - `press` lines go through the keys' own logic classes, with no settle time on Approve and Deny, `registry`
 *   lines to the fake folder, after which the watcher scans; `expect` lines are retried for up to 1 s.
 * - The model reads the fake folder again through the same watcher when a hook's request or a hello isn't
 *   confirmed by its latest reading, as the plugin does.
 * - Command ids: the deck's real id is bound to the fixture's name at its first appearance in a `reply`.
 * - A 2xx from a hook's route must be exactly one of the bodies the route allows, whatever its `reply` line
 *   expects: Allow, Deny or `{}` from `/v1/permission`, the allow or `{}` from `/v1/pretool`. An expected `{}`
 *   means no decision (replyMismatches).
 * - At the end, a held request or poll that no `reply` line checked must still be open.
 *
 * The deck's wall clock follows the fixture: it starts at the setup's `statusUpdatedAt` and moves to each
 * registry change's, a millisecond per reading, so release rules 2 and 3 and status rule 3 compare times as the fixture means.
 */

const DEADLINE_REPLY_MS = 2000;
const DEADLINE_EXPECT_MS = 1000;

type Sent = { line: PluginLine; req: http.ClientRequest; outcome: Promise<Outcome>; settled: Outcome | null };

async function play(fixture: Fixture): Promise<void> {
	const { setup } = fixture;
	const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-fixture-"));
	const registryDir = path.join(root, "sessions");
	const orgDir = path.join(root, "claude-code-sessions", "account", "org");
	mkdirSync(registryDir);
	mkdirSync(orgDir, { recursive: true });
	const writeAtomically = (file: string, value: unknown): void => {
		// Write and rename, as the app does, so the reader never sees half a file and every change gets a new inode.
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify(value));
		renameSync(tmp, file);
	};
	for (const entry of setup.registry) writeAtomically(path.join(registryDir, `${String(entry.pid)}.json`), entry);
	for (const [host, record] of Object.entries(setup.records)) writeAtomically(path.join(orgDir, `${host}.json`), record);

	let wall = Math.max(0, ...setup.registry.map((r) => (typeof r.statusUpdatedAt === "number" ? r.statusUpdatedAt : 0)));
	const log = new RecordingLog();
	const registry = new RegistryWatcher(new RegistryReader(registryDir));
	const model = new SessionModel({ log, wallNow: () => ++wall, rescan: () => registry.scanNow() });
	const records = new RecordsWatcher(new RecordsReader(path.join(root, "claude-code-sessions")));
	registry.onChange((sessions) => {
		model.setRegistry(sessions);
		records.setHosts(model.hosts());
	});
	records.onChange((recs) => model.setRecords(recs));
	await registry.scanNow();
	await records.scanNow();

	const token = setup.session.token;
	const server = new BridgeServer({ port: 0, token, routes: model, log });
	server.onState((state) => model.setBridgeState(state));
	const port = await server.listen();

	// The keys a press can reach, with images painted at once so they always show the current state. A fixture's
	// press is a deliberate press on what the key shows (PROTOCOL.md, Fixtures), so Approve and Deny skip the
	// moment a request must be in sight before a press counts (SETTLE_MS, tested in keys.test.ts).
	const jumps: string[] = [];
	const open = (host: string): void => {
		jumps.push(host);
	};
	let alerts = 0;
	const surface = { setImage: () => {}, showOk: () => {}, showAlert: () => alerts++ };
	const approve = new DecisionKeys(model, "allow", { paintIntervalMs: 0, settleMs: 0, open });
	const deny = new DecisionKeys(model, "deny", { paintIntervalMs: 0, settleMs: 0, open });
	const prompts = new PromptKeys(model, { paintIntervalMs: 0 });
	const modes = new ModeKeys(model, { paintIntervalMs: 0 });
	approve.add("approve", surface);
	deny.add("deny", surface);
	prompts.add("prompt", surface, {});
	modes.add("mode", surface, {});
	let last: { jumped: string | null; alert: boolean } = { jumped: null, alert: false };
	const press = (run: () => void): void => {
		const before = { jumps: jumps.length, alerts };
		run();
		last = { jumped: jumps.length > before.jumps ? (jumps.at(-1) ?? null) : null, alert: alerts > before.alerts };
	};

	const sent = new Map<string, Sent>();
	const all: Sent[] = [];
	const replied = repliedLabels(fixture.lines);
	/** The fixture's command names, bound to the deck's ids. */
	const ids = new Map<string, string>();
	const realId = (name: unknown): unknown => (typeof name === "string" ? (ids.get(name) ?? name) : name);

	const where = (n: number): string => `${fixture.name}:${n + 1}`;
	try {
		for (const [n, line] of fixture.lines.entries()) {
			if ("note" in line || "setup" in line || "mod" in line || "engine" in line) continue;

			if ("plugin" in line) {
				const p = line.plugin;
				const headers: Record<string, string> = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "content-type": "application/json" };
				for (const [name, value] of Object.entries(p.headers ?? {})) {
					if (value === null) delete headers[name.toLowerCase()];
					else headers[name.toLowerCase()] = value.replaceAll("$TOKEN", token);
				}
				let body: string | undefined;
				if (p.raw !== undefined) body = p.raw;
				else if (p.body !== undefined) {
					const b = p.body as Obj;
					body = JSON.stringify(p.path === "/v1/result" ? { ...b, id: realId(b.id) } : b);
				}
				const routedBefore = server.routed;
				const { req, outcome } = request(port, p.method, p.path, headers, body);
				const entry: Sent = { line: p, req, outcome, settled: null };
				void outcome.then((o) => {
					entry.settled = o;
				});
				all.push(entry);
				if (p.as !== undefined) sent.set(p.as, entry);
				const route = p.path.split("?")[0];
				if (route === "/v1/permission" || route === "/v1/next") {
					// Held, maybe: go on once the bridge has it, or has answered it, so later lines see it in order.
					await waitFor(() => entry.settled !== null || server.routed > routedBefore, `${where(n)} to reach the bridge`, DEADLINE_REPLY_MS);
					continue;
				}
				const o = await outcome;
				if (p.as === undefined || !replied.has(p.as)) {
					assert.ok("status" in o && (o.status === 200 || o.status === 204), `${where(n)}: ${p.method} ${p.path} got ${JSON.stringify(o)}, not 200 or 204`);
				}
				continue;
			}

			if ("reply" in line) {
				const r = line.reply;
				const entry = sent.get(r.to);
				assert.ok(entry, `${where(n)}: no request labelled ${r.to}`);
				const o = await within(entry.outcome, DEADLINE_REPLY_MS);
				assert.ok("status" in o, `${where(n)}: no answer to ${r.to}: ${JSON.stringify(o)}`);
				assert.equal(o.status, r.status, `${where(n)}: ${r.to} answered ${o.status} ${o.body}`);
				const got: unknown = o.body === "" ? undefined : JSON.parse(o.body);
				const want = r.body === undefined ? undefined : (structuredClone(r.body) as Obj);
				// Command ids: bind the fixture's name to the deck's id at its first appearance.
				if (want && Array.isArray(want.cmds) && typeof got === "object" && got !== null && Array.isArray((got as Obj).cmds)) {
					const gotCmds = (got as { cmds: Obj[] }).cmds;
					want.cmds.forEach((w: Obj, i: number) => {
						const real = gotCmds[i]?.id;
						if (typeof w.id !== "string" || typeof real !== "string") return;
						if (!ids.has(w.id)) ids.set(w.id, real);
						w.id = ids.get(w.id);
					});
				}
				const problems = replyMismatches(entry.line.path.split("?")[0] ?? "", o.status, want, got);
				assert.deepEqual(problems, [], `${where(n)}: ${r.to} answered ${o.body}`);
				continue;
			}

			if ("press" in line) {
				const what = line.press;
				if ("approve" in what) press(() => approve.press("approve"));
				else if ("deny" in what) press(() => deny.press("deny"));
				else if ("prompt" in what) {
					const { session, text } = what.prompt as { session: string; text: string };
					// The fixture names the target: the session picked on the Sessions dial.
					model.pick(session);
					press(() => prompts.press("prompt", { text }));
				} else if ("mode" in what) {
					const { session, mode } = what.mode as { session: string; mode: string };
					model.pick(session);
					press(() => modes.press("mode", { mode }));
				} else assert.fail(`${where(n)}: unknown press ${JSON.stringify(what)}`);
				continue;
			}

			if ("registry" in line) {
				const { pid, gone, ...fields } = line.registry;
				const file = path.join(registryDir, `${String(pid)}.json`);
				if (gone === true) rmSync(file, { force: true });
				else {
					const current = JSON.parse(readFileSync(file, "utf8")) as Obj;
					writeAtomically(file, { ...current, ...fields });
					if (typeof fields.statusUpdatedAt === "number") wall = Math.max(wall, fields.statusUpdatedAt);
				}
				await registry.scanNow();
				await records.scanNow();
				continue;
			}

			if ("expect" in line) {
				const want = line.expect;
				const deadline = Date.now() + DEADLINE_EXPECT_MS;
				for (;;) {
					const problems = check(want);
					if (problems.length === 0) break;
					if (Date.now() > deadline) assert.fail(`${where(n)}: ${problems.join("; ")}\n${log.at("debug").join("\n")}`);
					await sleep(10);
				}
				continue;
			}
			assert.fail(`${where(n)}: unknown line ${JSON.stringify(line)}`);
		}

		// Held requests and polls that no reply line checked are still open: nothing answered them.
		await sleep(20);
		for (const entry of all) {
			if (entry.line.as !== undefined && replied.has(entry.line.as)) continue;
			const route = entry.line.path.split("?")[0];
			if (route !== "/v1/permission" && route !== "/v1/next") continue;
			assert.equal(entry.settled, null, `${fixture.name}: ${entry.line.as ?? entry.line.path} was answered without a reply line: ${JSON.stringify(entry.settled)}`);
		}
	} finally {
		for (const entry of all) entry.req.destroy();
		await server.stop();
		// The keys' own timers (a Saved Prompt shows refused for 8 s) would keep the test process alive.
		approve.remove("approve");
		deny.remove("deny");
		prompts.remove("prompt");
		modes.remove("mode");
		model.dispose();
		rmSync(root, { recursive: true, force: true });
	}

	function check(want: Obj): string[] {
		const problems: string[] = [];
		const view = (host: string) => model.session(host);
		for (const [key, value] of Object.entries(want)) {
			switch (key) {
				case "sessions": {
					const got = model.sessions().map((s) => s.key).sort();
					const expected = [...(value as string[])].sort();
					if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`sessions: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
					break;
				}
				case "held": {
					const got = model.held.list().map((h) => ({ host: h.host, tool: h.tool, kind: h.kind, summary: h.summary }));
					problems.push(...mismatches(value, got, "held"));
					break;
				}
				case "status":
				case "doing":
				case "context": {
					for (const [host, expected] of Object.entries(value as Obj)) {
						const s = view(host);
						if (!s) problems.push(`${key}.${host}: no such session`);
						else problems.push(...mismatches(expected, s[key], `${key}.${host}`));
					}
					break;
				}
				case "settings": {
					for (const [host, expected] of Object.entries(value as Obj)) {
						const s = view(host);
						if (!s) problems.push(`settings.${host}: no such session`);
						else problems.push(...mismatches(expected, { model: s.model, effort: s.effort, mode: s.mode }, `settings.${host}`));
					}
					break;
				}
				case "cmds": {
					for (const [name, expected] of Object.entries(value as Obj)) {
						// A command no reply has named yet is the oldest the deck queued that isn't bound.
						if (!ids.has(name)) {
							const bound = new Set(ids.values());
							const free = model.commands.list().find((c) => !bound.has(c.id));
							if (free) ids.set(name, free.id);
						}
						const cmd = model.commands.get(ids.get(name) ?? "");
						problems.push(...mismatches(expected, cmd?.state ?? null, `cmds.${name}`));
					}
					break;
				}
				case "jumped":
					problems.push(...mismatches(value, last.jumped, "jumped"));
					break;
				case "alert":
					problems.push(...mismatches(value, last.alert, "alert"));
					break;
				default:
					problems.push(`unknown expectation ${key}`);
			}
		}
		return problems;
	}
}

describe("fixtures, deck side (claude-code/protocol/fixtures/*.jsonl)", () => {
	const fixtures = loadFixtures();

	test("all 17 fixtures are here", () => {
		assert.equal(fixtures.length, 17, fixtures.map((f) => f.name).join(", "));
	});

	for (const fixture of fixtures) {
		test(fixture.name, async () => {
			await play(fixture);
		});
	}
});

describe("the runner's reply checks (PROTOCOL.md, Matching)", () => {
	const PERMISSION = "/v1/permission";
	const PRETOOL = "/v1/pretool";
	/** A body as the runner gets it: parsed from the wire. */
	const wire = (body: unknown): unknown => JSON.parse(JSON.stringify(body));
	const allow = wire(ALLOW_DECISION);
	const deny = wire(DENY_DECISION);

	test("a 200 from /v1/permission is exactly Allow, Deny or {}, whatever the line expects; an expected {} is no decision", () => {
		assert.deepEqual(replyMismatches(PERMISSION, 200, allow, wire(ALLOW_DECISION)), []);
		assert.deepEqual(replyMismatches(PERMISSION, 200, deny, wire(DENY_DECISION)), []);
		assert.deepEqual(replyMismatches(PERMISSION, 200, {}, {}), []);

		// An Allow where the line expects {}: by the general rule, {} matches anything.
		assert.deepEqual(mismatches({}, allow), []);
		assert.notDeepEqual(replyMismatches(PERMISSION, 200, {}, allow), []);

		// An Allow with updatedPermissions, where the line expects Allow: the general rule lets extra fields through.
		const widened = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] } } };
		assert.deepEqual(mismatches(allow, widened), []);
		assert.notDeepEqual(replyMismatches(PERMISSION, 200, allow, widened), []);

		// A Deny without its message, where the line expects Deny, only a deny, or gives no body at all.
		const bare = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", interrupt: true } } };
		const someDeny = { hookSpecificOutput: { decision: { behavior: "deny" } } };
		assert.deepEqual(mismatches(someDeny, bare), []);
		for (const want of [deny, someDeny, undefined]) assert.notDeepEqual(replyMismatches(PERMISSION, 200, want, bare), [], JSON.stringify(want));
	});

	test("a 2xx from /v1/pretool is exactly the mode check's allow or {}, whatever the line expects; an expected {} is no decision", () => {
		const allowCheck = wire(PRETOOL_ALLOW) as Obj;
		assert.deepEqual(replyMismatches(PRETOOL, 200, allowCheck, wire(PRETOOL_ALLOW)), []);
		assert.deepEqual(replyMismatches(PRETOOL, 200, {}, {}), []);
		// The allow where the line expects {}: by the general rule, {} matches anything.
		assert.notDeepEqual(replyMismatches(PRETOOL, 200, {}, allowCheck), []);
		// A PermissionRequest's answers aren't a mode check's, even where the line expects only some decision.
		for (const got of [allow, deny]) {
			assert.notDeepEqual(replyMismatches(PRETOOL, 200, undefined, got), [], JSON.stringify(got));
			assert.notDeepEqual(replyMismatches(PRETOOL, 200, { hookSpecificOutput: {} }, got), [], JSON.stringify(got));
		}
		// Nor are a mode check's a PermissionRequest's.
		assert.notDeepEqual(replyMismatches(PERMISSION, 200, undefined, allowCheck), []);
		// A deny, an ask, extra fields, or another reason, where the line expects the allow or no body at all.
		const output = (fields: Obj): Obj => ({ hookSpecificOutput: { ...PRETOOL_ALLOW.hookSpecificOutput, ...fields } });
		const odd = [output({ permissionDecision: "deny" }), output({ permissionDecision: "ask" }), output({ updatedInput: { mode: "bypassPermissions" } }), output({ permissionDecisionReason: "Allowed." }), { ...allowCheck, systemMessage: "hi" }];
		for (const got of odd) assert.notDeepEqual(replyMismatches(PRETOOL, 200, undefined, got), [], JSON.stringify(got));
		assert.deepEqual(mismatches(allowCheck, output({ updatedInput: {} })), [], "the general rule lets the extra field through");
		assert.notDeepEqual(replyMismatches(PRETOOL, 200, allowCheck, output({ updatedInput: {} })), [], "the strict one doesn't");
		// Any other status carries {"error"}.
		assert.deepEqual(replyMismatches(PRETOOL, 401, undefined, { error: "Unauthorized" }), []);
		assert.notDeepEqual(replyMismatches(PRETOOL, 401, undefined, {}), []);
	});

	test("error answers, and other routes, keep the general rule", () => {
		assert.deepEqual(replyMismatches(PERMISSION, 405, { error: "*" }, { error: "Method Not Allowed" }), []);
		assert.deepEqual(replyMismatches("/v1/hello", 200, {}, { v: 1, ok: true }), []);
		assert.deepEqual(replyMismatches("/v1/next", 200, undefined, { cmds: [] }), []);
		assert.notDeepEqual(replyMismatches("/v1/hello", 200, { v: 1, ok: true }, { v: 1, ok: false }), []);
		// A path that's an Object.prototype name isn't a hook's route.
		assert.deepEqual(replyMismatches("__proto__", 200, undefined, { anything: 1 }), []);
	});

	test("any 2xx from /v1/permission is one of the three bodies, and any other status carries {\"error\"}, whatever the line expects", () => {
		const widened = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: {} } } };
		assert.deepEqual(replyMismatches(PERMISSION, 202, {}, {}), []);
		assert.notDeepEqual(replyMismatches(PERMISSION, 202, undefined, widened), [], "a 2xx other than 200");
		assert.notDeepEqual(replyMismatches(PERMISSION, 204, undefined, undefined), [], "no body is no decision only as {}");
		// Error answers: Node's own carry no body; one with a reason that isn't a string isn't {"error"} either.
		for (const got of [undefined, {}, { error: 401 }, "Unauthorized"]) {
			assert.notDeepEqual(replyMismatches(PERMISSION, 401, undefined, got), [], JSON.stringify(got));
			assert.notDeepEqual(replyMismatches("/v1/events", 400, undefined, got), [], `events: ${JSON.stringify(got)}`);
		}
		assert.deepEqual(replyMismatches(PERMISSION, 408, undefined, { error: "Request Timeout" }), []);
	});
});
