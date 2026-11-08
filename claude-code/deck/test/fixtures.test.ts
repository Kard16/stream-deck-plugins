import assert from "node:assert/strict";
import type http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { type BridgeRoutes, BridgeServer, type RouteAnswer } from "../src/bridge/server.js";
import { PromptKeys } from "../src/keys/commands.js";
import { DecisionKeys } from "../src/keys/decision.js";
import type { SessionModel } from "../src/model/sessions.js";
import { connectSources } from "../src/model/sources.js";
import { ALLOW_DECISION, DENY_DECISION } from "../src/protocol/wire.js";
import { APPROVAL_CHOICES, SlotDials, type SlotScreen } from "../src/slots/dials.js";
import { dialSlotId, type SlotId } from "../src/slots/ids.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { type Fixture, loadFixtures, mismatches, type Obj, type PluginLine, repliedLabels, replyMismatches, unrepliedMismatches } from "./helpers/fixtures.js";
import { type Outcome, request, sleep, waitFor, within } from "./helpers/http.js";
import { RecordingLog } from "./helpers/recording-log.js";

/**
 * The deck side of every fixture (PROTOCOL.md, Fixtures), against the real bridge on an ephemeral port, with
 * a fake registry folder and records folder under a temp dir:
 * - `mod` and `engine` lines are skipped.
 * - `plugin` lines are sent in order, with the right Host and token added unless the line sets them (`$TOKEN`
 *   is the right token, `null` leaves a header out), and `*` values sent as they are. The runner waits for
 *   each answer, up to 2 s, except for `/v1/permission` and `/v1/next`, which may be held: for those it waits,
 *   as long, until the bridge has taken the request (held or answered, after any second reading of the
 *   registry), and a later `reply` line checks the answer, waiting up to 2 s. An answer that doesn't come in time
 *   fails the fixture, so nothing the bridge holds by mistake can hold up the run.
 * - `press` lines go through the keys' own logic classes, with no settle time on Approve and Deny, `registry`
 *   lines to the fake folder, after which the watcher scans; a line for a file that's gone writes it anew, with
 *   its pid and the line's fields. `expect` lines are retried for up to 1 s.
 * - A `dial` press line goes through the Session Slot dials' own logic (src/slots/dials.ts), with no settle time
 *   either, for the request or for the chip turned to, and each turn painted at once (playDial): four slot dials on
 *   the fake deck's bottom row, whose slots fill as the deck's do, and a session with no slot is given one first. The
 *   line acts on the request its dial's strip showed last: while the strip shows it, a line with `decision` turns to
 *   that chip and presses, and one without presses with nothing picked, which jumps; once it has gone, the line is one
 *   press, which must alert and send nothing. The dials' clock is a fake one that never moves, so no repaint waits on
 *   it, and a request gone from a strip keeps its press alerting (GONE_MS) until the strip paints a newer one
 *   (PROTOCOL.md, Fixtures; dial-next).
 * - The model and the folders are wired as the plugin wires them (connectSources), so the model reads the fake
 *   folder again through the same watcher when a hook's request or a hello isn't confirmed by its latest reading.
 * - Command ids: the deck's real id is bound to the fixture's name at its first appearance in a `reply`.
 * - A 2xx from `/v1/permission` must be exactly one of the three bodies, whatever its `reply` line expects: Allow,
 *   Deny or `{}`. An expected `{}` means no decision (replyMismatches).
 * - At the end, a held request or poll that no `reply` line checked must still be open.
 *
 * The deck's wall clock follows the fixture: it starts at the setup's `statusUpdatedAt` and moves to each
 * registry change's, a millisecond per reading, so release rules 2 and 3 and status rule 3 compare times as the fixture means.
 */

const DEADLINE_REPLY_MS = 2000;
const DEADLINE_EXPECT_MS = 1000;

type Sent = { line: PluginLine; req: http.ClientRequest; outcome: Promise<Outcome>; settled: Outcome | null };

/** How a fixture is played: by default, against the session model itself, with 2 s for each answer. */
type PlayOptions = {
	/** The bridge's routes, made from the model; the runner's own tests put a route of theirs in place of one. */
	routes?: (model: SessionModel) => BridgeRoutes;
	/** How long an answer may take: a held request's to reach the bridge, any other's to come back. */
	replyMs?: number;
};

async function play(fixture: Fixture, opts: PlayOptions = {}): Promise<void> {
	const { setup } = fixture;
	const replyMs = opts.replyMs ?? DEADLINE_REPLY_MS;
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
	const { registry, records, model } = connectSources({
		registryDir,
		recordsDir: path.join(root, "claude-code-sessions"),
		logs: { sessions: log },
		model: { wallNow: () => ++wall },
	});
	await registry.scanNow();
	await records.scanNow();

	const token = setup.session.token;
	const server = new BridgeServer({ port: 0, token, routes: opts.routes?.(model) ?? model, log });
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
	approve.add("approve", surface);
	deny.add("deny", surface);
	prompts.add("prompt", surface, {});
	// The Session Slot dials, one per column of a Stream Deck +'s bottom row (2 rows of 4), filling as the deck's do.
	const slots = new Slots(model, { store: new MemorySlotStore(), fillDelayMs: 0 });
	const dials = new SlotDials(slots, model, { render: (screen: SlotScreen) => ({ layout: screen.kind, feedback: { screen: screen.kind } }), clock: new FakeClock(), paintIntervalMs: 0, settleMs: 0, pickSettleMs: 0, coalesceMs: 0, open });
	const dialSlots: SlotId[] = [0, 1, 2, 3].map((col) => dialSlotId("fixture-deck", 2, col));
	const dialIds = dialSlots.map((_, col) => `slot-dial-${col}`);
	for (const [i, slot] of dialSlots.entries()) dials.add(dialIds[i] ?? "", slot, { setLayout: () => {}, setFeedback: () => {}, showAlert: () => alerts++ });
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
				const route = p.path.split("?")[0] ?? "";
				if (route === "/v1/permission" || route === "/v1/next") {
					// Held, maybe: go on once the bridge has it, or has answered it, so later lines see it in order.
					await waitFor(() => entry.settled !== null || server.routed > routedBefore, `${where(n)} to reach the bridge`, replyMs);
					continue;
				}
				// Never held: an answer that doesn't come in time fails the fixture rather than holding up the run.
				const o = await within(outcome, replyMs);
				if (!("status" in o)) assert.fail(`${where(n)}: ${p.method} ${p.path} got no answer${o.error === "pending" ? ` within ${replyMs} ms` : `: ${o.error}`}`);
				if (p.as === undefined || !replied.has(p.as)) {
					const problems = unrepliedMismatches(route, o.status, o.body);
					assert.deepEqual(problems, [], `${where(n)}: ${p.method} ${p.path} got ${o.status} ${o.body}: ${problems.join("; ")}`);
				}
				continue;
			}

			if ("reply" in line) {
				const r = line.reply;
				const entry = sent.get(r.to);
				assert.ok(entry, `${where(n)}: no request labelled ${r.to}`);
				const o = await within(entry.outcome, replyMs);
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
				assert.deepEqual(problems, [], `${where(n)}: ${r.to} answered ${o.status} ${o.body}: ${problems.join("; ")}`);
				continue;
			}

			if ("press" in line) {
				const what = line.press;
				if ("approve" in what) press(() => approve.press("approve"));
				else if ("deny" in what) press(() => deny.press("deny"));
				else if ("prompt" in what) {
					const { session, text } = what.prompt as { session: string; text: string };
					// The fixture names the target, as a jump to it from a Session Slot or Other Sessions sets it.
					model.pick(session, "the fixture's prompt line");
					press(() => prompts.press("prompt", { text }));
				} else if ("dial" in what) {
					press(() => playDial(what.dial as Obj, where(n)));
				} else assert.fail(`${where(n)}: unknown press ${JSON.stringify(what)}`);
				continue;
			}

			if ("registry" in line) {
				const { pid, gone, ...fields } = line.registry;
				const file = path.join(registryDir, `${String(pid)}.json`);
				if (gone === true) rmSync(file, { force: true });
				else {
					// A file that's gone is written anew, with its pid and the line's fields (PROTOCOL.md, Fixtures).
					const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Obj) : { pid };
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
		for (const id of dialIds) dials.remove(id);
		model.dispose();
		rmSync(root, { recursive: true, force: true });
	}

	/**
	 * A `dial` press line (PROTOCOL.md, Fixtures), through the slot dial of the line's session: given a slot first if
	 * it has none. It acts on the request the dial's strip showed last. While the strip still shows it, a line with
	 * `decision` turns to that chip and presses; one without presses with nothing picked, which jumps, on an approval or
	 * on "Answer in app". Once that request has gone from the strip, the line is one press, for a request that has gone.
	 */
	function playDial(line: Obj, at: string): void {
		const session = line.session;
		assert.ok(typeof session === "string", `${at}: a dial line names its session`);
		// Phase 7's `picks` and `plan` forms went in Phase 9: a line has `decision` or nothing.
		assert.deepEqual(Object.keys(line).filter((k) => k !== "session" && k !== "decision"), [], `${at}: a dial line has a decision or nothing`);
		let slot = slots.slotOf(session);
		if (slot === null || !dialSlots.includes(slot)) {
			const free = dialSlots.find((s) => slots.host(s) === null) ?? dialSlots[0] ?? "";
			const placed = slots.place(free, session, "the fixture's dial line");
			assert.ok(placed.ok, `${at}: can't give ${session} a slot: ${placed.ok ? "" : placed.why}`);
			slot = free;
		}
		const id = dialIds[dialSlots.indexOf(slot)] ?? "";
		const shown = dials.lastShown(id);
		assert.notEqual(shown, null, `${at}: ${session}'s dial has shown no request`);
		const screen = dials.screen(id);
		const pressDial = (): void => {
			dials.down(id);
			dials.up(id);
		};
		if (screen !== null && "request" in screen && screen.request === shown && "decision" in line) {
			const index = APPROVAL_CHOICES.findIndex((c) => c.t === line.decision);
			assert.ok(index >= 0, `${at}: no such choice in ${JSON.stringify(line)}`);
			assert.equal(screen.kind, "approval", `${at}: the dial shows a ${screen.kind} screen, not an approval`);
			let s: SlotScreen = screen;
			for (let i = 0; i < 10 && !("pick" in s && s.pick === index); i++) {
				dials.rotate(id, 1, false);
				const turned = dials.screen(id);
				assert.ok(turned, `${at}: no dial`);
				s = turned;
			}
			assert.ok("pick" in s && s.pick === index, `${at}: couldn't turn to choice ${index}`);
			pressDial();
			return;
		}
		// The line picks nothing, or the request the strip showed last has gone: one press, with nothing picked.
		assert.ok(screen === null || !("pick" in screen) || screen.pick === null, `${at}: the strip shows a pick, but the line presses with none`);
		pressDial();
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
				case "context":
				// The session's latest threads, partial, its runs an exact list of partial runs: mismatches' own rule.
				case "threads": {
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

	test("all 21 fixtures are here", () => {
		assert.equal(fixtures.length, 21, fixtures.map((f) => f.name).join(", "));
	});

	for (const fixture of fixtures) {
		test(fixture.name, async () => {
			await play(fixture);
		});
	}
});

describe("the runner itself", () => {
	const fixture = (name: string): Fixture => {
		const found = loadFixtures().find((f) => f.name === name);
		assert.ok(found, name);
		return found;
	};
	/** The model's routes, with some of a test's own in their place. */
	const replacing =
		(mine: Partial<BridgeRoutes>) =>
		(model: SessionModel): BridgeRoutes => ({
			permission: (body, host, reply) => model.permission(body, host, reply),
			hello: (body) => model.hello(body),
			events: (body) => model.events(body),
			next: (query, reply) => model.next(query, reply),
			result: (body) => model.result(body),
			...mine,
		});

	test("an answer that never comes fails the fixture in time, instead of holding up the run: a hello's", async () => {
		const started = Date.now();
		await assert.rejects(play(fixture("hello.jsonl"), { routes: replacing({ hello: () => new Promise<RouteAnswer>(() => {}) }), replyMs: 300 }), /hello\.jsonl:4: POST \/v1\/hello got no answer within 300 ms/);
		assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
	});

	test("a dial line has a decision or nothing: Phase 7's picks and plan forms fail the fixture (Phase 9)", async () => {
		const base = fixture("needs-you.jsonl");
		for (const extra of [{ picks: { "Red or blue?": ["Red"] } }, { plan: "auto" }]) {
			const lines = base.lines.map((l) => ("press" in l && "dial" in l.press ? { press: { dial: { ...(l.press.dial as Obj), ...extra } } } : l));
			await assert.rejects(play({ ...base, lines }), /a dial line has a decision or nothing/, JSON.stringify(extra));
		}
	});

	test("expect.threads is checked against the session's latest threads: another running, or runs of another length, fails the fixture (Phase 9)", async () => {
		const base = fixture("threads.jsonl");
		for (const wrong of [{ running: 3 }, { running: 2, runs: [] }]) {
			let first = true;
			const lines = base.lines.map((l) => {
				if (!first || !("expect" in l) || !("threads" in l.expect)) return l;
				first = false;
				return { expect: { ...l.expect, threads: { "local_test-a": wrong } } };
			});
			await assert.rejects(play({ ...base, lines }), /threads\.local_test-a\.(running|runs)/, JSON.stringify(wrong));
		}
	});

	test("an answer no reply line checks must be 200 or 204, and one of its route's bodies if it's a hook's", () => {
		assert.deepEqual(unrepliedMismatches("/v1/permission", 200, JSON.stringify(DENY_DECISION)), []);
		assert.deepEqual(unrepliedMismatches("/v1/hello", 200, '{"v":1,"ok":true}'), []);
		assert.deepEqual(unrepliedMismatches("/v1/events", 204, ""), []);
		for (const [route, status, body] of [
			["/v1/permission", 200, JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", interrupt: true } } })],
			["/v1/events", 400, '{"error":"Bad Request"}'],
			["/v1/next", 409, '{"error":"hello first"}'],
		] as const) {
			assert.notDeepEqual(unrepliedMismatches(route, status, body), [], `${route} ${status} ${body}`);
		}
	});
});

describe("the runner's reply checks (PROTOCOL.md, Matching)", () => {
	const PERMISSION = "/v1/permission";
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

	test("an Allow that carries updatedInput, Phase 7's Answer and Approve plan included, is no /v1/permission body, whatever the line expects (Phase 9)", () => {
		const decision = (fields: Obj): Obj => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", ...fields } } });
		const input = { questions: [{ question: "Red or blue?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] };
		const answer = decision({ updatedInput: { ...input, answers: { "Red or blue?": "Blue" } } });
		const plan = decision({ updatedInput: { plan: "# Plan", planFilePath: "/p.md" }, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
		for (const body of [answer, plan, decision({ updatedInput: {} })]) {
			const what = JSON.stringify(body);
			assert.notDeepEqual(replyMismatches(PERMISSION, 200, body, body), [], `expected as it came: ${what}`);
			assert.notDeepEqual(replyMismatches(PERMISSION, 200, undefined, body), [], `no body expected: ${what}`);
			assert.notDeepEqual(unrepliedMismatches(PERMISSION, 200, what), [], `no reply line: ${what}`);
			// Where the line expects a plain Allow, the general rule would let updatedInput through; the strict one doesn't.
			assert.deepEqual(mismatches(allow, body), []);
			assert.notDeepEqual(replyMismatches(PERMISSION, 200, allow, body), [], what);
		}
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
