import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import type { RouteAnswer } from "../src/bridge/server.js";
import { HELLOS_KEPT, SessionModel } from "../src/model/sessions.js";
import { sessionStatus } from "../src/model/status.js";
import { fingerprint } from "../src/protocol/fingerprint.js";
import { ALLOW_DECISION, MODE_TOOL, PRETOOL_ALLOW } from "../src/protocol/wire.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { QUIET_MS, QuietLog } from "../src/util/quiet-log.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** An HTTP answer the test can read and close. */
class FakeReply implements PollReply {
	open = true;
	answers: { status: number; body: unknown }[] = [];
	#onClose: (() => void)[] = [];
	send(status: number, body: string): void {
		this.open = false;
		this.answers.push({ status, body: JSON.parse(body) });
	}
	onClose(fn: () => void): void {
		this.#onClose.push(fn);
	}
	close(): void {
		this.open = false;
		for (const fn of this.#onClose) fn();
	}
}

const A = "local_a";
const B = "local_b";

function reg(pid: number, host: string | null, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "idle", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

function record(host: string, fields: Partial<AppRecord> = {}): AppRecord {
	return { host, title: null, model: "claude-haiku-5-5", effort: "low", permissionMode: "default", lastFocusedAt: null, turnCategory: null, ...fields };
}

/** The session id the registry lists each test host with, as `reg` makes them: A is pid 1, B pid 2. */
const sidOf = (host: string | undefined): string => (host === A ? "sid-1" : "sid-2");

/** A hello's answer, which comes at once when no second reading of the registry is needed. */
function now(answer: RouteAnswer | Promise<RouteAnswer>): RouteAnswer {
	assert.ok(!(answer instanceof Promise), "answered at once");
	return answer;
}

const OK = { status: 200, body: { v: 1, ok: true } };
const NONE = { status: 200, body: {} };
const NOT_THIS_SESSION = { status: 409, body: { error: "not this session" }, logged: true };

function setup(registry: RegistrySession[] = [reg(1, A), reg(2, B)], opts: { rescan?: () => Promise<void> } = {}) {
	let wall = 10_000;
	const clock = new FakeClock();
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => wall, rescan: opts.rescan });
	model.setRegistry(registry);
	model.setBridgeState("listening");
	const at = (t: number): void => {
		wall = t;
	};
	let seq = 0;
	const events = (host: string, ...evs: Record<string, unknown>[]): void => {
		const answer = model.events({ sid: null, host, inst: `i-${host}`, seq: ++seq, events: evs.map((e) => ({ at: 1, ...e })) });
		assert.equal(answer.status, 204);
	};
	const permission = (host: string | undefined, tool: string, input: unknown, extra: Record<string, unknown> = {}): FakeReply => {
		const reply = new FakeReply();
		model.permission({ session_id: sidOf(host), tool_name: tool, tool_input: input, permission_mode: "default", effort: { level: "low" }, ...extra }, host, reply);
		return reply;
	};
	/** The mode hook's check of a call to the app's mode tool, from the session the registry lists for `host`. */
	const pretool = (host: string | undefined, input: unknown, extra: Record<string, unknown> = {}): FakeReply => {
		const reply = new FakeReply();
		model.pretool({ session_id: sidOf(host), hook_event_name: "PreToolUse", tool_name: MODE_TOOL, tool_input: input, tool_use_id: "toolu_plugin_0001", ...extra }, host, reply);
		return reply;
	};
	/** The mod of `host` says hello, as the instance `events` sends as. */
	const greeted = new Set<string>();
	const hello = (host: string): void => {
		assert.deepEqual(now(model.hello({ v: 1, sid: sidOf(host), host, inst: `i-${host}` })), OK);
		greeted.add(host);
	};
	/** The mod's long poll, from the instance `events` sends as, which says hello first, once. */
	const poll = (host: string): FakeReply => {
		if (!greeted.has(host)) hello(host);
		const reply = new FakeReply();
		model.next(new URLSearchParams({ host, inst: `i-${host}`, wait: "20" }), reply);
		return reply;
	};
	return { model, clock, log, at, events, permission, pretool, hello, poll, view: (host: string) => model.session(host) };
}

describe("session status (PROTOCOL.md's order)", () => {
	const base = { heldTool: 0, heldAsk: 0, registry: "idle", statusUpdatedAt: 1000, firstReadingAt: 1000, turn: null, recordCategory: null };
	/** The main loop's last turn, whose `turn.end` the deck got at 5000. */
	const ended = (reason: string, failed = false) => ({ ended: true, reason, failed, endedAt: 5000 });
	const unfinished = { ended: false, reason: null, failed: false, endedAt: null };
	test("the first that applies wins", () => {
		assert.equal(sessionStatus({ ...base, heldTool: 1, heldAsk: 1, registry: "waiting" }), "approval");
		assert.equal(sessionStatus({ ...base, heldAsk: 1, registry: "busy" }), "needs-you");
		assert.equal(sessionStatus({ ...base, registry: "waiting" }), "needs-you");
		// A busy that began after the turn ended: the next turn's.
		assert.equal(sessionStatus({ ...base, registry: "busy", statusUpdatedAt: 6000, turn: ended("aborted", true) }), "working");
		assert.equal(sessionStatus({ ...base, turn: ended("aborted", true), recordCategory: "blocked" }), "failed");
		assert.equal(sessionStatus({ ...base, turn: ended("aborted"), recordCategory: "blocked" }), "interrupted");
		assert.equal(sessionStatus({ ...base, turn: ended("answer"), recordCategory: "blocked" }), "needs-you");
		assert.equal(sessionStatus({ ...base, turn: ended("answer"), recordCategory: "need_input" }), "needs-you");
		assert.equal(sessionStatus({ ...base, registry: "busy", recordCategory: "blocked" }), "working");
		assert.equal(sessionStatus({ ...base, turn: ended("answer"), recordCategory: "review_ready" }), "done");
		assert.equal(sessionStatus({ ...base, turn: ended("answer") }), "done");
		assert.equal(sessionStatus({ ...base, turn: unfinished }), "idle");
		assert.equal(sessionStatus({ ...base, registry: null }), "idle");
	});

	test("rule 3: a busy that began before the main loop's turn ended with aborted doesn't count, and rules 4–8 take the session as idle", () => {
		const busy = { ...base, registry: "busy", statusUpdatedAt: 4000, firstReadingAt: 4000 };
		assert.equal(sessionStatus({ ...busy, turn: ended("aborted") }), "interrupted");
		assert.equal(sessionStatus({ ...busy, statusUpdatedAt: 5000, turn: ended("aborted") }), "interrupted", "at the same moment counts as before");
		assert.equal(sessionStatus({ ...busy, statusUpdatedAt: 5001, turn: ended("aborted") }), "working", "a busy that began after the turn.end");
		assert.equal(sessionStatus({ ...busy, turn: ended("aborted", true), recordCategory: "blocked" }), "failed", "failed still comes first");
		assert.equal(sessionStatus({ ...busy, turn: ended("aborted"), recordCategory: "blocked" }), "interrupted", "then interrupted, before the app's indicator");
		assert.equal(sessionStatus({ ...busy, turn: ended("answer") }), "working", "a turn that ended otherwise");
		assert.equal(sessionStatus({ ...busy, turn: ended("error", true) }), "working", "a failed turn that wasn't aborted");
		assert.equal(sessionStatus({ ...busy, turn: unfinished }), "working", "no turn.end since the turn began");
		assert.equal(sessionStatus({ ...busy, turn: null }), "working", "no turn seen");
		// Rules 1 and 2 are unchanged.
		assert.equal(sessionStatus({ ...busy, heldTool: 1, turn: ended("aborted") }), "approval");
		assert.equal(sessionStatus({ ...busy, heldAsk: 1, turn: ended("aborted") }), "needs-you");
		assert.equal(sessionStatus({ ...busy, registry: "waiting", turn: ended("aborted") }), "needs-you", "waiting is unaffected");
	});

	test("rule 3 without statusUpdatedAt: the deck's first reading of the busy stands in for it", () => {
		const busy = { ...base, registry: "busy", statusUpdatedAt: null, turn: ended("aborted") };
		assert.equal(sessionStatus({ ...busy, firstReadingAt: 4000 }), "interrupted");
		assert.equal(sessionStatus({ ...busy, firstReadingAt: 5000 }), "interrupted", "at the same moment counts as before");
		assert.equal(sessionStatus({ ...busy, firstReadingAt: 5001 }), "working", "first read after the turn.end");
		assert.equal(sessionStatus({ ...busy, firstReadingAt: null }), "working", "nothing to go by");
		// With the field there, it decides, whenever the deck first read the busy.
		assert.equal(sessionStatus({ ...busy, statusUpdatedAt: 4000, firstReadingAt: 6000 }), "interrupted");
		assert.equal(sessionStatus({ ...busy, statusUpdatedAt: 6000, firstReadingAt: 4000 }), "working");
	});
});

describe("session model", () => {
	test("lists the registry's sessions by host, oldest first, with titles, and drops a duplicate file for a host", () => {
		const { model } = setup([reg(3, B, { startedAt: 30 }), reg(1, A, { startedAt: 10, name: null }), reg(4, A, { startedAt: 5 }), reg(9, null, { startedAt: 99 })]);
		assert.deepEqual(
			model.sessions().map((s) => [s.key, s.title]),
			[
				[A, "1"],
				[B, "Session 3"],
				["pid:9", "Session 9"],
			],
		);
		assert.deepEqual(model.hosts(), [A, B]);
	});

	test("model, effort and mode: the app's record, until the plugin or a PermissionRequest says otherwise; the latest wins", () => {
		const { model, events, permission, view } = setup();
		model.setRecords(new Map([[A, record(A, { model: "claude-opus-5-5", effort: "max", permissionMode: "auto" })]]));
		assert.deepEqual([view(A)?.model, view(A)?.effort, view(A)?.mode], ["claude-opus-5-5", "max", "auto"]);
		model.hello({ v: 1, sid: "sid-1", host: A, inst: `i-${A}`, cwd: "/p/1", model: "claude-haiku-5-5", plugin: "0.1.0", cc: "2.1.309" });
		assert.deepEqual([view(A)?.model, view(A)?.effort, view(A)?.mode], ["claude-haiku-5-5", "max", "auto"], "hello had no mode or effort");
		permission(A, "Write", { file_path: "/x" }, { permission_mode: "acceptEdits", effort: { level: "medium" } });
		assert.deepEqual([view(A)?.effort, view(A)?.mode], ["medium", "acceptEdits"]);
		events(A, { t: "settings", mode: "plan" });
		assert.deepEqual([view(A)?.model, view(A)?.effort, view(A)?.mode], ["claude-haiku-5-5", "medium", "plan"]);
	});

	test("working on what, context %, done; a subagent's tools don't count as the session's", () => {
		const { model, events, view } = setup([reg(1, A, { status: "busy" })]);
		model.hello({ v: 1, sid: "sid-1", host: A, inst: `i-${A}`, model: "m" });
		events(A, { t: "turn.start", turn: "t1" });
		events(A, { t: "tool.start", tool: "Read", use: "u1", summary: "notes.md", fp: "11111111" });
		events(A, { t: "tool.start", tool: "Bash", use: "u2", agent: "sub", summary: "ls", fp: "22222222" });
		assert.deepEqual([view(A)?.status, view(A)?.doing], ["working", "notes.md"]);
		events(A, { t: "tool.end", tool: "Read", use: "u1", fp: "11111111", ok: true }, { t: "measure", context: { percent: 42, tokens: 1, window: 2 } });
		assert.deepEqual([view(A)?.doing, view(A)?.context], [null, 42]);
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 })]);
		assert.equal(view(A)?.status, "done");
		// Just compacted: the engine has no percent until its next response, so the old figure goes.
		events(A, { t: "measure", context: { window: 2 }, cost: { usd: 0.5 } });
		assert.equal(view(A)?.context, null);
	});

	test("failed and interrupted turns; a failed turn stays failed when its turn.end comes after", () => {
		const { model, events, view } = setup([reg(1, A, { status: "idle" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "aborted" });
		assert.equal(view(A)?.status, "interrupted");
		events(A, { t: "turn.start", turn: "t2" }, { t: "failed", error: "overloaded" }, { t: "turn.end", turn: "t2", reason: "error" });
		assert.equal(view(A)?.status, "failed");
		events(A, { t: "turn.start", turn: "t3" }, { t: "turn.end", turn: "t3", reason: "answer" });
		assert.equal(view(A)?.status, "done");
		model.setRecords(new Map([[A, record(A, { turnCategory: "blocked" })]]));
		assert.equal(view(A)?.status, "needs-you", "the app's needs-input indicator shows for its record");
	});

	test("rule 4 counts only the main loop's failed: a subagent's doesn't make the session failed", () => {
		const { events, view } = setup([reg(1, A, { status: "idle" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "failed", agent: "a1b2", error: "overloaded" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.equal(view(A)?.status, "done", "the main loop's turn went on after its subagent failed");
		events(A, { t: "turn.start", turn: "t2" }, { t: "failed", error: "overloaded" }, { t: "turn.end", turn: "t2", reason: "answer" });
		assert.equal(view(A)?.status, "failed");
		// A subagent's turn that fails later doesn't touch the main loop's last turn either way.
		events(A, { t: "turn.start", turn: "s1", agent: "a1b2" }, { t: "failed", agent: "a1b2" }, { t: "turn.end", turn: "s1", agent: "a1b2", reason: "answer" });
		assert.equal(view(A)?.status, "failed");
	});

	test("an agent that isn't a non-empty string counts as the main loop's", () => {
		const { model, events, view } = setup([reg(1, A, { status: "busy" })]);
		events(A, { t: "turn.start", turn: "t1", agent: "" }, { t: "tool.start", tool: "Read", use: "u1", agent: 7, summary: "a.md", fp: "11111111" });
		assert.equal(view(A)?.doing, "a.md");
		events(A, { t: "tool.end", tool: "Read", use: "u1", agent: null, fp: "11111111", ok: true }, { t: "tool.start", tool: "Grep", use: "u2", agent: { id: "x" }, summary: "TODO", fp: "22222222" });
		assert.equal(view(A)?.doing, "TODO");
		events(A, { t: "failed", agent: false, error: "overloaded" }, { t: "turn.end", turn: "t1", agent: [], reason: "answer" });
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 })]);
		assert.deepEqual([view(A)?.status, view(A)?.doing], ["failed", null]);
	});

	test("status rule 3: Esc shows interrupted from the turn.end while the registry keeps the busy that began before it", () => {
		const { model, at, events, view } = setup([reg(1, A, { status: "idle", statusUpdatedAt: 9000 })]);
		at(11_000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 11_000 })]);
		events(A, { t: "turn.start", turn: "t1" });
		assert.equal(view(A)?.status, "working");
		at(12_000);
		events(A, { t: "turn.start", turn: "s1", agent: "a1b2" }, { t: "turn.end", turn: "s1", agent: "a1b2", reason: "aborted" });
		assert.equal(view(A)?.status, "working", "a subagent's turn.end never counts");
		at(13_000);
		events(A, { t: "turn.end", turn: "t1", reason: "aborted" });
		assert.equal(view(A)?.status, "interrupted", "the registry still says busy, from 11000");
		at(19_000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 19_000 })]);
		assert.equal(view(A)?.status, "interrupted");
		// The next prompt: the registry's busy can come before the mod's turn.start.
		at(25_000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 25_000 })]);
		assert.equal(view(A)?.status, "working", "a busy that began after the turn.end");
		events(A, { t: "turn.start", turn: "t2" });
		at(26_000);
		events(A, { t: "turn.end", turn: "t2", reason: "aborted" });
		assert.equal(view(A)?.status, "interrupted");
		// A prompt typed before the registry goes idle: its turn.start clears the last turn's end.
		at(27_000);
		events(A, { t: "turn.start", turn: "t3" });
		assert.equal(view(A)?.status, "working");
	});

	test("status rule 3 without statusUpdatedAt: the deck's first reading of the busy, which a reading of another status resets", () => {
		const { model, at, events, view } = setup([]);
		at(5000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: null })]);
		events(A, { t: "turn.start", turn: "t1" });
		at(7000);
		events(A, { t: "turn.end", turn: "t1", reason: "aborted" });
		assert.equal(view(A)?.status, "interrupted", "the session's first reading, at 5000, counts");
		at(8000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: null, name: "Renamed" })]);
		assert.equal(view(A)?.status, "interrupted", "another reading of the same busy");
		at(9000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null })]);
		assert.equal(view(A)?.status, "interrupted");
		at(10_000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: null })]);
		assert.equal(view(A)?.status, "working", "busy again since a reading showed it idle, first read after the turn.end");
		// A session the deck first reads after its turn.end.
		at(11_000);
		events(B, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "aborted" });
		at(12_000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: null }), reg(2, B, { status: "busy", statusUpdatedAt: null })]);
		assert.equal(view(B)?.status, "working");
	});

	test("each listed session's status is logged at debug when it changes, and only then", () => {
		const { model, at, events, log } = setup([reg(1, A, { status: "busy", statusUpdatedAt: 9000 }), reg(2, B)]);
		const lines = (): string[] => log.lines.filter((l) => l.message.startsWith("STATUS ")).map((l) => `${l.level} ${l.message}`);
		assert.deepEqual(lines(), ["debug STATUS local_a → working", "debug STATUS local_b → idle"], "on first sight");
		events(A, { t: "turn.start", turn: "t1" });
		at(11_000);
		events(A, { t: "turn.end", turn: "t1", reason: "aborted" });
		assert.deepEqual(lines().slice(2), ["debug STATUS local_a working → interrupted"], "as the turn.end comes, with the registry still busy");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 12_000 }), reg(2, B)]);
		model.setBridgeState("stopped");
		model.setRegistry([reg(2, B, { status: "busy", statusUpdatedAt: 13_000 })]);
		assert.deepEqual(lines().slice(3), ["debug STATUS local_b idle → working"]);
	});

	test("a request is a tool, an ask, or the deck's own mode change", () => {
		const { model, permission, view } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		permission(A, "Bash", { command: "make" });
		permission(B, "AskUserQuestion", { questions: [{ question: "Red or blue?" }] });
		permission(B, "ExitPlanMode", { plan: "x" });
		assert.deepEqual(
			model.held.list().map((h) => [h.host, h.kind, h.summary, h.fp]),
			[
				[A, "tool", "make", fingerprint("Bash", { command: "make" })],
				[B, "ask", "Red or blue?", fingerprint("AskUserQuestion", { questions: [{ question: "Red or blue?" }] })],
				[B, "ask", "Plan ready", fingerprint("ExitPlanMode", { plan: "x" })],
			],
		);
		assert.deepEqual([view(A)?.status, view(B)?.status], ["approval", "needs-you"]);
	});

	test("the mode tool is allowed at once only for this session's in-flight mode command with that mode, and once", () => {
		const { model, permission } = setup();
		const MODE_TOOL = "mcp__ccd_session_mgmt__set_session_permission_mode";
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		const notYet = permission(A, MODE_TOOL, { session_id: "self", mode: "acceptEdits" });
		assert.deepEqual(notYet.answers, [], "no command in flight: held like any tool");
		notYet.close();
		const cmd = model.commands.queue(A, { t: "mode", mode: "acceptEdits" });
		const poll = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), poll);
		assert.equal(cmd.state, "delivered");
		assert.deepEqual(permission(B, MODE_TOOL, { session_id: "self", mode: "acceptEdits" }).answers, [], "another session's");
		assert.deepEqual(permission(A, MODE_TOOL, { session_id: "self", mode: "plan" }).answers, [], "another mode");
		assert.deepEqual(permission(A, MODE_TOOL, { session_id: "local_b", mode: "acceptEdits" }).answers, [], "not self");
		const ours = permission(A, MODE_TOOL, { session_id: "self", mode: "acceptEdits" });
		assert.equal(ours.answers.length, 1);
		assert.deepEqual(ours.answers[0]?.body, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
		assert.deepEqual(permission(A, MODE_TOOL, { session_id: "self", mode: "acceptEdits" }).answers, [], "a second one is held");
		assert.ok(model.held.list().every((h) => h.kind === "tool"));
	});

	test("rule 1: the session's tool.end with the same fp releases the oldest match; another session's doesn't", () => {
		const { model, events, permission } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		const write = { file_path: "/x/s5.txt", content: "five" };
		const first = permission(A, "Write", write);
		const second = permission(A, "Write", write);
		const fp = fingerprint("Write", write);
		events(B, { t: "tool.end", tool: "Write", use: "u1", fp, ok: true });
		assert.equal(model.held.size, 2);
		events(A, { t: "tool.end", tool: "Write", use: "u1", agent: "sub", fp, ok: true });
		assert.deepEqual(first.answers, [{ status: 200, body: {} }], "subagents' calls count too");
		assert.deepEqual(second.answers, []);
	});

	test("rule 2: leaving waiting releases the session's only request, if it came before the change", () => {
		const { model, at, permission } = setup([reg(1, A, { status: "busy" })]);
		at(5000);
		const r = permission(A, "Bash", { command: "npm test" });
		model.setRegistry([reg(1, A, { status: "waiting", statusUpdatedAt: 5001 })]);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 7000 })]);
		assert.deepEqual(r.answers, [{ status: 200, body: {} }]);
	});

	test("rule 2 doesn't release when two are held, or when the request came after the change", () => {
		const { model, at, permission } = setup([reg(1, A, { status: "busy" })]);
		at(5000);
		const one = permission(A, "Bash", { command: "a" });
		const two = permission(A, "Bash", { command: "b" });
		model.setRegistry([reg(1, A, { status: "waiting", statusUpdatedAt: 5001 })]);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 6000 })]);
		assert.deepEqual([one.answers, two.answers], [[], []]);
		one.close();
		two.close();
		model.setRegistry([reg(1, A, { status: "waiting", statusUpdatedAt: 6500 })]);
		at(8000);
		const late = permission(A, "Bash", { command: "c" });
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 7000 })]);
		assert.deepEqual(late.answers, [], "it arrived after the session left waiting");
	});

	test("rule 3: idle with a later statusUpdatedAt releases every request from before; an older one doesn't", () => {
		const { model, at, permission } = setup([reg(1, A, { status: "busy" })]);
		at(5000);
		const r1 = permission(A, "Bash", { command: "a" });
		const r2 = permission(A, "Bash", { command: "b" });
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 4000 })]);
		assert.deepEqual([r1.answers, r2.answers], [[], []]);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 6000 })]);
		assert.deepEqual([r1.answers.length, r2.answers.length], [1, 1]);
	});

	test("rule 3 without statusUpdatedAt: only a change to idle the deck saw counts, never a session's first reading", async () => {
		const next = [reg(1, A, { status: "idle", statusUpdatedAt: null })];
		const { model, at } = setup([], {
			rescan: async () => {
				at(6000);
				model.setRegistry(next);
			},
		});
		at(5000);
		// From a session the latest reading doesn't list yet: the second reading, its first, lists it idle.
		const r = new FakeReply();
		await model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "a" } }, A, r);
		assert.equal(model.held.size, 1, "held once that reading confirmed it");
		assert.deepEqual(r.answers, [], "its first reading");
		at(7000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null })]);
		assert.deepEqual(r.answers, [], "idle again, with no change seen");
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: null })]);
		at(8000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null })]);
		assert.deepEqual(r.answers, [{ status: 200, body: {} }], "a change to idle the deck saw, after the request came");
	});

	test("a tool_input too deep to fingerprint is held without an fp; rules 2–5 still release it", () => {
		const { model, at, events, permission } = setup([reg(1, A, { status: "busy" })]);
		let deep: unknown = [];
		for (let i = 0; i < 20_000; i++) deep = [deep];
		at(5000);
		const r = permission(A, "Custom", { a: deep });
		assert.deepEqual(model.held.list().map((h) => [h.host, h.summary, h.fp]), [[A, "Custom", null]]);
		events(A, { t: "tool.end", tool: "Custom", use: "u1", fp: "00000000", ok: true });
		assert.deepEqual(r.answers, [], "rule 1 has no fp to match");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 6000 })]);
		assert.deepEqual(r.answers, [{ status: 200, body: {} }], "rule 3");
	});

	test("rule 4: a session whose file disappears ends: its requests are released, its commands fail", () => {
		const { model, permission } = setup();
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		const r = permission(A, "Write", { file_path: "/x" });
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		model.setRegistry([reg(2, B)]);
		assert.deepEqual(r.answers, [{ status: 200, body: {} }]);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "the session ended"]);
		assert.deepEqual(
			model.sessions().map((s) => s.key),
			[B],
		);
	});

	test("rule 4 also fails the session's delivered and waiting commands, and answers its open poll with none", () => {
		const { model } = setup();
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		const poll = (): FakeReply => {
			const reply = new FakeReply();
			model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), reply);
			return reply;
		};
		const waiting = model.commands.queue(A, { t: "prompt", text: "one" });
		poll();
		model.result({ host: A, inst: "ia", id: waiting.id, state: "waiting" });
		const delivered = model.commands.queue(A, { t: "mode", mode: "plan" });
		poll();
		const open = poll();
		assert.deepEqual([waiting.state, delivered.state, open.answers], ["waiting", "delivered", []]);
		model.setRegistry([reg(2, B)]);
		assert.deepEqual(open.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(
			[waiting.state, waiting.error, delivered.state, delivered.error],
			["failed", "the session ended", "failed", "the session ended"],
		);
		assert.equal(model.commands.polling(A), false);
	});

	test("rule 5: a request whose client closes is dropped without an answer", () => {
		const { model, permission } = setup();
		const r = permission(A, "Write", { file_path: "/x" });
		r.close();
		assert.equal(model.held.size, 0);
		assert.deepEqual(r.answers, []);
	});

	test("without a usable X-Deck-Host, a hook's request gets no decision at once, though the registry knows its sid: no placing by sid any more", () => {
		const { model, log } = setup([reg(1, A, { status: "busy" })], { rescan: () => assert.fail("no reading can confirm a request without a host") });
		for (const header of [undefined, "", "$CLAUDE_CODE_HOST_SESSION_ID", "local_a\n", "LOCAL_a"]) {
			const r = new FakeReply();
			assert.equal(model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "ls" } }, header, r), undefined, "answered at once");
			assert.deepEqual(r.answers, [NONE], JSON.stringify(header));
			const q = new FakeReply();
			assert.equal(model.pretool({ session_id: "sid-1", tool_name: MODE_TOOL, tool_input: { session_id: "self", mode: "plan" } }, header, q), undefined);
			assert.deepEqual(q.answers, [NONE], JSON.stringify(header));
		}
		assert.equal(model.held.size, 0);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("UNCONFIRMED")),
			[`info UNCONFIRMED /v1/permission from no host sid "sid-1": no X-Deck-Host that's an app id, so no decision`, `info UNCONFIRMED /v1/pretool from no host sid "sid-1": no X-Deck-Host that's an app id, so no decision`],
		);
	});

	test("events: a seq that isn't above the last for that instance is dropped", () => {
		const { model, view } = setup([reg(1, A, { status: "idle" })]);
		const send = (seq: number, reason: string) => model.events({ host: A, inst: "ia", seq, events: [{ t: "turn.end", turn: "t", reason }] });
		send(2, "answer");
		send(2, "aborted");
		send(1, "aborted");
		assert.equal(view(A)?.status, "done");
		model.events({ host: A, inst: "ib", seq: 1, events: [{ t: "turn.end", turn: "t", reason: "aborted" }] });
		assert.equal(view(A)?.status, "interrupted", "a new instance starts at 1 again");
	});

	test("a new mod instance forgets the session's current tool and in-flight commands, and keeps the rest", () => {
		const { model, view } = setup([reg(1, A, { status: "busy" })]);
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "claude-haiku-5-5" });
		model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u1", summary: "a.md", fp: "1" }, { t: "measure", context: { percent: 30 } }] });
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		model.next(new URLSearchParams({ host: A, inst: "ia" }), new FakeReply());
		const queued = model.commands.queue(A, { t: "prompt", text: "later" });
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib", model: "claude-haiku-5-5" });
		assert.deepEqual([view(A)?.doing, view(A)?.context, view(A)?.model], [null, 30, "claude-haiku-5-5"]);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "the mod restarted"]);
		assert.equal(queued.state, "queued");
		// The new instance takes the queued prompt and starts a tool. A late request from the old one, an
		// instance seen before, isn't another restart, so neither is forgotten.
		model.next(new URLSearchParams({ host: A, inst: "ib" }), new FakeReply());
		model.events({ host: A, inst: "ib", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u2", summary: "b.md", fp: "2" }] });
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "claude-haiku-5-5" });
		assert.deepEqual([queued.state, view(A)?.doing], ["delivered", "b.md"]);
	});

	test("an instance seen before never counts as a restart again, however many came after it, and its requests are still taken", () => {
		const { model, view } = setup([reg(1, A, { status: "busy" })]);
		for (let i = 0; i < 12; i++) model.hello({ v: 1, sid: "sid-1", host: A, inst: `i${i}`, model: "m" });
		model.events({ host: A, inst: "i11", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u1", summary: "a.md", fp: "1" }] });
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		model.next(new URLSearchParams({ host: A, inst: "i11" }), new FakeReply());
		const open = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i11", wait: "20" }), open);
		// The first instance, eleven restarts back, sends something late, and it's taken.
		assert.equal(model.events({ host: A, inst: "i0", seq: 1, events: [{ t: "settings", mode: "plan" }] }).status, 204);
		assert.deepEqual([cmd.state, view(A)?.doing, view(A)?.mode, open.answers], ["delivered", "a.md", "plan", []]);
	});

	test("a new instance's hello answers the poll the old one left open, so a command queued after it waits for the new one", () => {
		const { model } = setup();
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		const old = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), old);
		assert.deepEqual(old.answers, []);
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib", model: "m" });
		assert.deepEqual(old.answers, [{ status: 200, body: { cmds: [] } }]);
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.equal(cmd.state, "queued", "not handed to the old instance");
		const fresh = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ib", wait: "20" }), fresh);
		assert.deepEqual(fresh.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.deepEqual([cmd.state, cmd.inst], ["delivered", "ib"]);
	});

	test("an old instance that keeps polling after a new hello gets none at once: it never takes the new one's commands, nor displaces its poll", () => {
		const { model } = setup();
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib", model: "m" });
		// Both mods poll again as soon as a poll answers, as the plugin does.
		const polls = { ia: 0, ib: 0 };
		const poll = (inst: "ia" | "ib"): FakeReply => {
			polls[inst]++;
			const reply = new FakeReply();
			model.next(new URLSearchParams({ host: A, inst, wait: "20" }), reply);
			return reply;
		};
		let ib = poll("ib");
		let ia = poll("ia");
		for (let i = 0; i < 5; i++) {
			if (!ia.open) ia = poll("ia");
			if (!ib.open) ib = poll("ib");
		}
		assert.deepEqual(ia.answers, [{ status: 200, body: { cmds: [] } }], "the old instance's poll is answered at once");
		assert.deepEqual([polls.ib, ib.answers], [1, []], "the new instance's first poll is still open");
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.deepEqual(ib.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.deepEqual([cmd.state, cmd.inst], ["delivered", "ib"]);
		// With no poll of the new instance open, a queued command waits for its next: the old one's doesn't take it.
		const next = model.commands.queue(A, { t: "prompt", text: "again" });
		ia = poll("ia");
		assert.deepEqual([ia.answers, next.state], [[{ status: 200, body: { cmds: [] } }], "queued"]);
		// Its events and results are still taken.
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan" }] }).status, 204);
		assert.equal(model.session(A)?.mode, "plan");
		ib = poll("ib");
		assert.deepEqual([ib.answers.length, next.state, next.inst], [1, "delivered", "ib"]);
	});

	test("the main loop's turn.end answers the session's open poll with none at once, and once the session is idle, the mod's next poll is held as usual", () => {
		const { model, clock, log, events, poll } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		const polls = (): string[] => log.lines.filter((l) => l.message.startsWith("POLL ")).map((l) => `${l.level} ${l.message}`);
		const n1 = poll(A);
		const other = poll(B);
		events(A, { t: "turn.start", turn: "t1" }, { t: "tool.start", tool: "Read", use: "u1", summary: "a.md", fp: "11111111" });
		clock.advance(5000);
		events(A, { t: "tool.end", tool: "Read", use: "u1", fp: "11111111", ok: true });
		assert.deepEqual(n1.answers, [], "held while the turn runs");
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(other.answers, [], "another session's poll stays open");
		assert.deepEqual(polls(), [`debug POLL ${A} wait 20 s`, `debug POLL ${B} wait 20 s`, `debug POLL ${A} answered with none: the turn ended`]);
		// The registry goes idle, and the mod polls again: that poll is held as usual, and takes a command queued later.
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 }), reg(2, B, { status: "busy" })]);
		const n2 = poll(A);
		clock.advance(15_000);
		assert.deepEqual(n2.answers, []);
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.equal(n1.answers.length, 1, "answered once");
	});

	test("the main loop's failed answers the open poll too; the turn.end after it, with no poll open, answers and logs nothing", () => {
		const { model, log, events, poll } = setup([reg(1, A, { status: "busy" })]);
		const answered = (): string[] => log.lines.filter((l) => l.message.startsWith(`POLL ${A} answered`)).map((l) => `${l.level} ${l.message}`);
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" });
		events(A, { t: "failed", error: "overloaded" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(answered(), [`debug POLL ${A} answered with none: the turn failed`]);
		// The turn.end comes before the mod polls again.
		events(A, { t: "turn.end", turn: "t1", reason: "error" });
		assert.deepEqual([n1.answers.length, answered().length, model.commands.polling(A)], [1, 1, false]);
		// Once the registry says idle, the mod's next poll is held as usual, and takes a command queued later.
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 })]);
		const n2 = poll(A);
		assert.deepEqual(n2.answers, []);
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
	});

	test("a subagent's turn.end or failed leaves the session's poll open", () => {
		const { events, poll } = setup([reg(1, A, { status: "busy" })]);
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.start", turn: "s1", agent: "a1b2" });
		events(A, { t: "failed", agent: "a1b2", error: "overloaded" });
		events(A, { t: "turn.end", turn: "s1", agent: "a1b2", reason: "answer" });
		assert.deepEqual(n1.answers, [], "the main loop's turn goes on");
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }], "until its own turn.end");
	});

	test("a turn.end in a request dropped as a retry answers no poll", () => {
		const { model, poll } = setup([reg(1, A, { status: "busy" })]);
		const send = (seq: number, e: Record<string, unknown>) => model.events({ host: A, inst: `i-${A}`, seq, events: [{ at: 1, ...e }] });
		const n1 = poll(A);
		send(1, { t: "turn.start", turn: "t1" });
		send(2, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		// After a rejected fetch, the mod sends the request again under its original seq (PROTOCOL.md, Failure and recovery).
		// By then the registry says idle, so the mod's poll is held.
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 })]);
		const n2 = poll(A);
		send(2, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n2.answers, [], "dropped, so the poll stays open");
	});

	test("after the main loop's turn.end, the session's polls are answered at once with none while the registry still says busy", () => {
		const { model, clock, log, events, poll } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		const polls = (): string[] => log.lines.filter((l) => l.message.startsWith("POLL ")).map((l) => `${l.level} ${l.message}`);
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		// The mod polls again at once. That answer came in under a second, so it waits out the rest of it before the next.
		const n2 = poll(A);
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [] } }]);
		clock.advance(1000);
		const n3 = poll(A);
		assert.deepEqual(n3.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.equal(model.commands.polling(A), false, "no request left open");
		// Another session, busy with no turn's end, has its poll held as usual.
		const other = poll(B);
		assert.deepEqual(other.answers, []);
		assert.deepEqual(polls(), [
			`debug POLL ${A} wait 20 s`,
			`debug POLL ${A} answered with none: the turn ended`,
			`debug POLL ${A} answered at once: the turn ended and the registry still says busy`,
			`debug POLL ${A} answered at once: the turn ended and the registry still says busy`,
			`debug POLL ${B} wait 20 s`,
		]);
	});

	test("a command queued while the session's polls are answered at once goes out on its next poll", () => {
		const { model, clock, events, poll } = setup([reg(1, A, { status: "busy" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }]);
		// Pressed in the second the mod waits out, with no poll open: it stays queued until the next.
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.equal(cmd.state, "queued");
		clock.advance(1000);
		const n2 = poll(A);
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.deepEqual([cmd.state, cmd.inst], ["delivered", `i-${A}`]);
	});

	test("while the session's polls are answered at once, an old instance's still get none and take no commands", () => {
		const { model, events } = setup([reg(1, A, { status: "busy" })]);
		events(A, { t: "turn.start", turn: "t1" });
		// The mod reloads: the new instance says hello, and the old one's line still brings the turn's end.
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib", model: "m" });
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		const old = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: `i-${A}`, wait: "20" }), old);
		assert.deepEqual([old.answers, cmd.state], [[{ status: 200, body: { cmds: [] } }], "queued"]);
		const fresh = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ib", wait: "20" }), fresh);
		assert.deepEqual(fresh.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.deepEqual([cmd.state, cmd.inst], ["delivered", "ib"]);
	});

	test("polls answered at once count as the mod polling: a waiting prompt doesn't fail while the mod polls every second", () => {
		const { model, clock, events, poll } = setup([reg(1, A, { status: "busy" })]);
		// A prompt pressed during the turn waits for its end (S3).
		events(A, { t: "turn.start", turn: "t1" });
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.equal(poll(A).answers.length, 1);
		assert.equal(model.commands.result(A, `i-${A}`, cmd.id, "waiting", null, null), true);
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		// The registry stays busy, say for a background subagent, so each poll for the next 60 s is answered at once.
		for (let i = 0; i < 60; i++) {
			assert.equal(poll(A).answers.length, 1, `poll ${i}`);
			clock.advance(1000);
		}
		assert.equal(cmd.state, "waiting");
		// From the 60 s on, the poll is held, and the prompt still waits.
		assert.equal(poll(A).answers.length, 0);
		clock.advance(30_000);
		assert.equal(cmd.state, "waiting");
	});

	test("once a registry reading says the session isn't busy, its polls are held as usual: idle, or still waiting after a Deny", () => {
		const { model, events, poll } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "waiting" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "at once while it's busy");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 }), reg(2, B, { status: "waiting" })]);
		const n2 = poll(A);
		assert.deepEqual(n2.answers, [], "held once it's idle");
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }], "until a command is queued");
		// A turn the deck's Deny ended, while the deck's last reading still says waiting.
		events(B, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(poll(B).answers, []);
	});

	test("after a turn shorter than a scan, a poll held while the deck's reading still said idle is answered with none once it says busy", () => {
		const { model, clock, log, events, poll, view } = setup();
		const polls = (): string[] => log.lines.filter((l) => l.message.startsWith("POLL ")).map((l) => `${l.level} ${l.message}`);
		const n1 = poll(A);
		const other = poll(B);
		// A sub-second turn between two of the deck's scans: its reading still says idle, from before the turn.
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		// The mod polls again while its measure for the turn is still on its line, so Claude Code keeps the session busy.
		const n2 = poll(A);
		assert.deepEqual(n2.answers, [], "held: the reading says idle");
		// The next scan reads that busy, and B's, which has had no turn's end.
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 10_500 }), reg(2, B, { status: "busy", statusUpdatedAt: 10_500 })]);
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [] } }], "answered as soon as the reading says busy");
		assert.deepEqual([model.commands.polling(A), view(A)?.status], [false, "working"]);
		assert.deepEqual(other.answers, [], "B's poll stays held");
		// After the second the mod waits out: answered at once while the reading says busy, and held once it says idle.
		clock.advance(1000);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }]);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 11_500 }), reg(2, B, { status: "busy", statusUpdatedAt: 10_500 })]);
		assert.equal(view(A)?.status, "done");
		const n4 = poll(A);
		clock.advance(15_000);
		assert.deepEqual(n4.answers, []);
		assert.deepEqual(polls(), [
			`debug POLL ${A} wait 20 s`,
			`debug POLL ${B} wait 20 s`,
			`debug POLL ${A} answered with none: the turn ended`,
			`debug POLL ${A} wait 20 s`,
			`debug POLL ${A} answered with none: the turn ended and the registry now says busy`,
			`debug POLL ${A} answered at once: the turn ended and the registry still says busy`,
			`debug POLL ${A} wait 20 s`,
		]);
	});

	test("after a Deny, a poll held while the reading still said waiting is answered once it says busy; one whose session goes straight to idle stays held", () => {
		const { model, clock, events, poll } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		for (const host of [A, B]) events(host, { t: "turn.start", turn: "t1" });
		model.setRegistry([reg(1, A, { status: "waiting", statusUpdatedAt: 2000 }), reg(2, B, { status: "waiting", statusUpdatedAt: 2000 })]);
		// The deck's Deny stops both turns while the reading still says waiting.
		for (const host of [A, B]) events(host, { t: "turn.end", turn: "t1", reason: "answer" });
		const a2 = poll(A);
		const b2 = poll(B);
		assert.deepEqual([a2.answers, b2.answers], [[], []], "held: the reading says waiting");
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 3000 }), reg(2, B, { status: "idle", statusUpdatedAt: 3000 })]);
		assert.deepEqual(a2.answers, [{ status: 200, body: { cmds: [] } }], "waiting, then busy");
		assert.deepEqual(b2.answers, [], "waiting, then idle, as in the deny fixture");
		clock.advance(1000);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "at once while the reading says busy");
	});

	test("a reading that turns busy answers no held poll before the main loop's turn ends, after its next turn.start, or 60 s after it ended", () => {
		const { model, clock, events, poll } = setup();
		const read = (status: string, at: number): void => model.setRegistry([reg(1, A, { status, statusUpdatedAt: at }), reg(2, B)]);
		// A turn whose busy the deck reads while it runs.
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" });
		read("busy", 2000);
		assert.deepEqual(n1.answers, [], "the turn runs");
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		read("idle", 3000);
		// The next turn: its turn.start reaches the deck before the scan that reads its busy.
		const n2 = poll(A);
		events(A, { t: "turn.start", turn: "t2" });
		read("busy", 4000);
		assert.deepEqual(n2.answers, [], "the next turn runs");
		events(A, { t: "turn.end", turn: "t2", reason: "answer" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [] } }]);
		read("idle", 5000);
		// A busy with no turn.start, 60 s after that turn ended, by the monotonic clock.
		clock.advance(60_000);
		const n3 = poll(A);
		read("busy", 6000);
		assert.deepEqual(n3.answers, [], "60 s after the turn ended");
	});

	test("the main loop's next turn.start stops the session's polls being answered at once; a subagent's doesn't", () => {
		const { events, poll } = setup([reg(1, A, { status: "busy" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "at once after the turn's end");
		// A background subagent's turn starts after the main loop's ended.
		events(A, { t: "turn.start", turn: "s1", agent: "a1b2" });
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "a subagent's turn.start doesn't stop it");
		events(A, { t: "turn.start", turn: "t2" });
		const n2 = poll(A);
		assert.deepEqual(n2.answers, [], "held while the next turn runs");
		// That turn's end starts it again.
		events(A, { t: "turn.end", turn: "t2", reason: "answer" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }]);
	});

	test("60 s after the main loop's turn ended, by the monotonic clock, its polls are held as usual though the registry still says busy", () => {
		const { clock, at, events, poll } = setup([reg(1, A, { status: "busy" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		// The wall clock jumping, as after a time sync on wake, doesn't end it.
		at(130_000);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }]);
		clock.advance(59_999);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "1 ms before");
		clock.advance(1);
		const late = poll(A);
		assert.deepEqual(late.answers, [], "held");
		clock.advance(20_000);
		assert.deepEqual(late.answers, [{ status: 200, body: { cmds: [] } }], "until its wait is up");
	});

	test("the main loop's failed starts answering the session's polls at once, as its turn.end does", () => {
		const { clock, events, poll } = setup([reg(1, A, { status: "busy" })]);
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" }, { t: "failed", error: "overloaded" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "at once, with no turn.end yet");
		clock.advance(60_000);
		assert.deepEqual(poll(A).answers, [], "for 60 s from the failed");
	});

	test("a subagent's turn.end or failed doesn't start answering the session's polls at once", () => {
		const { events, poll } = setup([reg(1, A, { status: "busy" })]);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.start", turn: "s1", agent: "a1b2" });
		events(A, { t: "failed", agent: "a1b2", error: "overloaded" }, { t: "turn.end", turn: "s1", agent: "a1b2", reason: "answer" });
		const n1 = poll(A);
		assert.deepEqual(n1.answers, [], "held while the main loop's turn goes on");
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(poll(A).answers, [{ status: 200, body: { cmds: [] } }], "at once after the main loop's own turn.end");
	});

	test("without a usable host, the registry's sid places a mod request, and then the sid and host pairs the mods sent", () => {
		const { model, view } = setup([reg(1, A)]);
		// The registry's sid: a hello with its host unset is placed by it, and confirmed by it.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: "", inst: "ia", model: "m" })), OK);
		assert.equal(view(A)?.plugin, true);
		// A session the registry doesn't list: its mod said hello with both.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-x", host: "local_x", inst: "ix", model: "m" })), OK);
		// The variable unset: the mod sends its host as "".
		assert.equal(model.events({ sid: "sid-x", host: "", inst: "ix", seq: 1, events: [{ t: "turn.start", turn: "t1" }] }).status, 204);
		const poll = new FakeReply();
		model.next(new URLSearchParams({ sid: "sid-x", host: "", inst: "ix", wait: "0" }), poll);
		assert.deepEqual(poll.answers, [{ status: 200, body: { cmds: [] } }]);
		// The session's id changes, as after /clear: its mod comes with the new one and its host, and either places it.
		assert.equal(model.events({ sid: "sid-x2", host: "local_x", inst: "ix", seq: 2, events: [{ t: "end", reason: "clear" }] }).status, 204);
		assert.equal(model.events({ sid: "sid-x2", host: "", inst: "ix", seq: 3, events: [{ t: "settings", mode: "plan" }] }).status, 204);
		assert.equal(model.events({ sid: "sid-x", host: "", inst: "ix", seq: 4, events: [{ t: "settings", effort: "max" }] }).status, 204);
		// The registry comes first: a pair a mod sent can't move a sid the registry places.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: "local_y", inst: "iy", model: "m" })), OK);
		assert.equal(model.events({ sid: "sid-1", host: "", inst: "ia", seq: 1, events: [{ t: "settings", mode: "acceptEdits" }] }).status, 204);
		assert.equal(view(A)?.mode, "acceptEdits");
		assert.equal(model.events({ sid: "sid-unknown", host: "", inst: "iz", seq: 1, events: [] }).status, 400);
		// Once the registry lists local_x, the deck shows what its mod said.
		model.setRegistry([reg(1, A), reg(3, "local_x", { sessionId: "sid-x2" })]);
		assert.deepEqual([view("local_x")?.mode, view("local_x")?.effort, view("local_x")?.plugin], ["plan", "max", true]);
	});

	test("a hook's request never places a session or adds a pair: a mod without a host isn't placed by a hook's session_id", () => {
		const { model } = setup([reg(1, A)]);
		// A process with an unlisted host: no decision, and nothing of it is kept.
		const r = new FakeReply();
		model.permission({ session_id: "sid-x", tool_name: "Bash", tool_input: { command: "ls" } }, "local_x", r);
		assert.deepEqual([r.answers, model.held.size], [[NONE], 0]);
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-x", host: "", inst: "ix", model: "m" })), { status: 400, body: { error: "unknown session: no host, and the registry doesn't know the sid" } });
		assert.equal(model.events({ sid: "sid-x", host: "", inst: "ix", seq: 1, events: [] }).status, 400);
	});

	test("the target: the session picked on the dial; until then the one last on screen", () => {
		const { model, events } = setup([reg(1, A), reg(2, B), reg(3, "local_c")]);
		assert.equal(model.target(), null, "nothing has been on screen");
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 9000 })], [B, record(B, { lastFocusedAt: 8000 })]]));
		assert.equal(model.target()?.key, A);
		events(B, { t: "attach", surface: "desktop" });
		assert.equal(model.target()?.key, B, "B came on screen at 10000, after A's 9000");
		model.pick("local_c");
		assert.equal(model.target()?.key, "local_c");
		model.setRegistry([reg(1, A), reg(2, B)]);
		const gone = model.target();
		assert.deepEqual([gone?.key, gone?.listed, gone?.title], ["local_c", false, "Session 3"], "an ended pick stays the target, so presses alert");
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		assert.deepEqual(model.queue("local_c", { t: "prompt", text: "x" }), { ok: false, why: '"Session 3" has ended' });
	});

	test("commands go only to listed sessions with the plugin", () => {
		const { model } = setup([reg(1, A), reg(2, B), reg(9, null)]);
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" });
		assert.equal(model.queue(A, { t: "prompt", text: "x" }).ok, true);
		assert.deepEqual(model.queue(B, { t: "prompt", text: "x" }), { ok: false, why: '"Session 2" doesn\'t have the plugin' });
		assert.deepEqual(model.queue("pid:9", { t: "prompt", text: "x" }), { ok: false, why: '"Session 9" has no app id' });
		assert.equal(model.queue("local_zzz", { t: "prompt", text: "x" }).ok, false);
	});

	test("a mod request the bridge can't place gets 400; hello in another version is refused", () => {
		const { model } = setup();
		assert.equal(model.events({ sid: "nobody", inst: "i", seq: 1, events: [] }).status, 400);
		const reply = new FakeReply();
		model.next(new URLSearchParams({ inst: "i" }), reply);
		assert.equal(reply.answers[0]?.status, 400);
		assert.deepEqual(model.hello({ v: 2, host: A, inst: "i" }), { status: 200, body: { v: 1, ok: false, error: "version" } });
		assert.equal(model.session(A)?.plugin, false, "a refused hello isn't the plugin talking");
	});
});

describe("mode checks (PROTOCOL.md, Mode checks)", () => {
	const self = (mode: string) => ({ session_id: "self", mode });
	const ALLOW_CHECK = { status: 200, body: PRETOOL_ALLOW };

	test("the allow goes only to a check of this session's own mode command in flight, for that mode; anything else gets {} at once", () => {
		const { model, pretool, poll, log } = setup();
		assert.deepEqual(pretool(A, self("acceptEdits")).answers, [NONE], "no command in flight");
		const n1 = poll(A);
		const queued = model.commands.queue(B, { t: "mode", mode: "acceptEdits" });
		assert.deepEqual(pretool(B, self("acceptEdits")).answers, [NONE], "a command queued, not yet delivered");
		const cmd = model.commands.queue(A, { t: "mode", mode: "acceptEdits" });
		assert.deepEqual([cmd.state, n1.answers.length, queued.state], ["delivered", 1, "queued"]);
		assert.deepEqual(pretool(B, self("acceptEdits")).answers, [NONE], "another session's");
		assert.deepEqual(pretool(A, self("plan")).answers, [NONE], "another mode");
		assert.deepEqual(pretool(A, { session_id: "local_b", mode: "acceptEdits" }).answers, [NONE], "not self");
		assert.deepEqual(pretool(A, { mode: "acceptEdits" }).answers, [NONE], "no session_id in the input");
		assert.deepEqual(pretool(A, self("acceptEdits"), { tool_name: "Bash" }).answers, [NONE], "another tool");
		assert.deepEqual(pretool(A, self("acceptEdits"), { session_id: "sid-child" }).answers, [NONE], "a claude started inside the session");
		assert.deepEqual(pretool(A, self("acceptEdits")).answers, [ALLOW_CHECK]);
		assert.deepEqual(pretool(A, self("acceptEdits")).answers, [NONE], "only the first check per command");
		assert.equal(model.held.size, 0, "never held");
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("ALLOWED")),
			[`info ALLOWED the mode check for the change to "acceptEdits" for ${A}: the deck's own command ${cmd.id}`],
		);
		assert.ok(log.at("debug").some((l) => l === `debug PRETOOL ${A}: no decision: "Bash" isn't the app's mode tool for the session itself`));
		// Once the command is final, nothing is in flight.
		const second = model.commands.queue(A, { t: "mode", mode: "acceptEdits" });
		poll(A);
		assert.equal(model.commands.result(A, `i-${A}`, second.id, "done", null, ""), true);
		assert.deepEqual(pretool(A, self("acceptEdits")).answers, [NONE], "a finished command");
	});

	test("the mode check's allow and kind mode's PermissionRequest allow are counted apart, either way round", () => {
		const { model, pretool, permission, poll } = setup();
		const ALLOW = { status: 200, body: ALLOW_DECISION };
		poll(A);
		const first = model.commands.queue(A, { t: "mode", mode: "plan" });
		// The raise: the mode check, then the app's approval.
		assert.deepEqual(pretool(A, self("plan")).answers, [ALLOW_CHECK]);
		assert.deepEqual(permission(A, MODE_TOOL, self("plan")).answers, [ALLOW]);
		assert.deepEqual(pretool(A, self("plan")).answers, [NONE]);
		assert.deepEqual(permission(A, MODE_TOOL, self("plan")).answers, [], "a second PermissionRequest is an ordinary tool request");
		assert.deepEqual(
			model.held.list().map((h) => [h.host, h.kind]),
			[[A, "tool"]],
		);
		assert.equal(first.state, "delivered");
		// A PermissionRequest first, as from a session started before its plugin had the mode hook, leaves the check its own.
		model.commands.result(A, `i-${A}`, first.id, "done", null, "");
		poll(A);
		model.commands.queue(A, { t: "mode", mode: "auto" });
		assert.deepEqual(permission(A, MODE_TOOL, self("auto")).answers, [ALLOW]);
		assert.deepEqual(pretool(A, self("auto")).answers, [ALLOW_CHECK]);
		assert.deepEqual(pretool(A, self("auto")).answers, [NONE]);
	});

	test("every answer is exactly the allow or {}, whatever the body", () => {
		const { model, poll } = setup();
		poll(A);
		model.commands.queue(A, { t: "mode", mode: "plan" });
		const bodies: unknown[] = [null, 7, "x", [1], {}, { tool_name: "" }, { session_id: "sid-1", tool_name: MODE_TOOL }, { session_id: "sid-1", tool_name: MODE_TOOL, tool_input: [1] }];
		for (const body of bodies) {
			const reply = new FakeReply();
			model.pretool(body, A, reply);
			assert.deepEqual(reply.answers, [NONE], JSON.stringify(body));
		}
		const reply = new FakeReply();
		model.pretool({ session_id: "sid-1", tool_name: MODE_TOOL, tool_input: self("plan"), extra: { anything: true } }, A, reply);
		assert.deepEqual(reply.answers, [ALLOW_CHECK]);
		assert.equal(JSON.stringify(reply.answers[0]?.body), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"The mode change pressed on the Stream Deck."}}');
	});
});

describe("desktop sessions only (PROTOCOL.md, Desktop sessions only)", () => {
	const write = { file_path: "/p/1/s9.txt", content: "nine" };

	test("a PermissionRequest from a process the registry doesn't confirm gets {} at once: nothing held, none of its settings taken", () => {
		const { model, view, log } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		model.setRecords(new Map([[A, record(A)]]));
		const cases: [string | undefined, string | null, string][] = [
			[undefined, "sid-term", "a terminal session: no host"],
			[A, "sid-child", "a claude started inside A: A's host, its own session id"],
			[A, "sid-2", "B's session id under A's host"],
			[A, null, "no session_id"],
			["local_spare", "sid-spare", "a host the registry doesn't list"],
		];
		for (const [host, sid, what] of cases) {
			const reply = new FakeReply();
			const body = { tool_name: "Write", tool_input: write, permission_mode: "bypassPermissions", effort: { level: "max" }, ...(sid === null ? {} : { session_id: sid }) };
			assert.equal(model.permission(body, host, reply), undefined, `${what}: answered at once`);
			assert.deepEqual(reply.answers, [NONE], what);
		}
		assert.equal(model.held.size, 0);
		assert.deepEqual([view(A)?.mode, view(A)?.effort, view(A)?.status], ["default", "low", "working"], "its settings aren't the session's");
		assert.deepEqual(model.sessions().map((s) => s.key), [A, B], "nor does it list a session");
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("UNCONFIRMED")),
			[
				'info UNCONFIRMED /v1/permission from no host sid "sid-term": no X-Deck-Host that\'s an app id, so no decision',
				`info UNCONFIRMED /v1/permission from ${A} sid "sid-child": the registry lists that host under another session id, so no decision`,
				`info UNCONFIRMED /v1/permission from ${A} sid none: no session_id, so no decision`,
				'info UNCONFIRMED /v1/permission from local_spare sid "sid-spare": the registry doesn\'t list that host, so no decision',
			],
			"one line at info per reason; B's id under A's host is the same reason as the child's",
		);
		// From the confirmed session itself, held, with its settings.
		const ours = new FakeReply();
		model.permission({ session_id: "sid-1", tool_name: "Write", tool_input: write, permission_mode: "acceptEdits", effort: { level: "max" } }, A, ours);
		assert.deepEqual([model.held.size, ours.answers, view(A)?.mode, view(A)?.effort, view(A)?.status], [1, [], "acceptEdits", "max", "approval"]);
	});

	test("a lingering file of a restarted process lists its host too: either session id confirms it", () => {
		const { model } = setup([reg(1, A, { startedAt: 1 }), reg(5, A, { startedAt: 5, sessionId: "sid-new" })]);
		for (const sid of ["sid-1", "sid-new"]) {
			const reply = new FakeReply();
			model.permission({ session_id: sid, tool_name: "Bash", tool_input: { command: sid } }, A, reply);
			assert.deepEqual(reply.answers, [], sid);
		}
		assert.equal(model.held.size, 2);
	});

	test("one the latest reading doesn't confirm has the registry read once more, at once: confirmed then, it's taken; else {} after it", async () => {
		let next: RegistrySession[] = [reg(2, B)];
		let reads = 0;
		const { model, log } = setup([reg(2, B)], {
			rescan: async () => {
				reads++;
				model.setRegistry(next);
			},
		});
		// A session that started since the last scan: the registry lists it now, though the deck hasn't read it.
		next = [reg(1, A, { status: "busy" }), reg(2, B)];
		const r = new FakeReply();
		const taking = model.permission({ session_id: "sid-1", tool_name: "Write", tool_input: write }, A, r);
		assert.ok(taking instanceof Promise, "it waits for the reading");
		assert.deepEqual([model.held.size, r.answers], [0, []], "nothing before the reading");
		await taking;
		assert.equal(reads, 1);
		assert.deepEqual(
			model.held.list().map((h) => [h.host, h.tool]),
			[[A, "Write"]],
		);
		assert.deepEqual(model.sessions().map((s) => s.key), [A, B]);
		// Confirmed by the latest reading: no other reading.
		assert.equal(model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "ls" } }, A, new FakeReply()), undefined);
		assert.equal(reads, 1);
		// A claude started inside A: one more reading, which doesn't confirm it either, then no decision.
		const child = new FakeReply();
		await model.permission({ session_id: "sid-child", tool_name: "Write", tool_input: write }, A, child);
		assert.deepEqual([reads, child.answers, model.held.size], [2, [NONE], 2]);
		// A mode check the same way: one more reading, confirmed, and then the check itself, here with nothing in flight.
		next = [reg(1, A, { status: "busy" }), reg(2, B), reg(3, "local_c", { status: "busy" })];
		const check = new FakeReply();
		await model.pretool({ session_id: "sid-3", tool_name: MODE_TOOL, tool_input: { session_id: "self", mode: "plan" } }, "local_c", check);
		assert.deepEqual([reads, check.answers], [3, [NONE]]);
		assert.ok(log.at("debug").some((l) => l.startsWith("debug PRETOOL local_c: no decision: no mode command in flight")), "it was confirmed");
		// A client that goes away while the registry is read gets nothing, and nothing is held.
		next = [...next, reg(4, "local_d", { status: "busy" })];
		const gone = new FakeReply();
		const going = model.permission({ session_id: "sid-4", tool_name: "Bash", tool_input: { command: "ls" } }, "local_d", gone);
		gone.close();
		await going;
		assert.deepEqual([reads, gone.answers, model.held.size], [4, [], 2]);
	});

	test("a second reading that fails leaves the latest: the request gets {}, and the failure is logged", async () => {
		const { model, log } = setup([reg(2, B)], { rescan: () => Promise.reject(new Error("EACCES")) });
		const r = new FakeReply();
		await model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "ls" } }, A, r);
		assert.deepEqual([r.answers, model.held.size], [[NONE], 0]);
		assert.ok(log.at("warn").some((l) => l.includes("reading the registry again failed") && l.includes("EACCES")), log.at("warn").join("\n"));
	});

	test("a hello from a host the registry lists under another session id gets 409, and counts for nothing", () => {
		const { model, view, log } = setup();
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "claude-haiku-5-5", mode: "default" })), OK);
		const n1 = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), n1);
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		const n2 = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), n2);
		// A claude started inside A, with its own session id and A's host; and a hello without a session id.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-child", host: A, inst: "ichild", model: "claude-opus-5-5", mode: "plan" })), NOT_THIS_SESSION);
		assert.deepEqual(now(model.hello({ v: 1, host: A, inst: "inone", model: "claude-opus-5-5" })), NOT_THIS_SESSION);
		// Nothing changed: A's instance keeps its poll and its command, and A its settings.
		assert.deepEqual([n2.answers, cmd.state, view(A)?.model, view(A)?.mode], [[], "delivered", "claude-haiku-5-5", "default"]);
		// The refused instance's polls get none: it never became current.
		const stray = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ichild", wait: "20" }), stray);
		assert.deepEqual([stray.answers, n2.answers], [[{ status: 200, body: { cmds: [] } }], []]);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("409")),
			[`info HELLO refused with 409 for ${A} inst "ichild" sid "sid-child": the registry lists that host under another session id`],
			"the second is the same reason, at debug",
		);
		assert.ok(!log.lines.some((l) => l.message.startsWith("RESTART")));
	});

	test("a hello from a host the registry doesn't list, as from a spare, is taken; the session is listed only once the registry lists it", () => {
		const { model, log } = setup();
		const spare = "local_spare";
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-9", host: spare, inst: "ispare", model: "m" })), OK);
		assert.ok(log.at("info").some((l) => l === `info HELLO ${spare} inst "ispare" plugin none cc none; the registry doesn't list it yet`));
		assert.deepEqual(model.sessions().map((s) => s.key), [A, B], "the overview is the registry's");
		assert.equal(model.session(spare), null);
		assert.equal(model.queue(spare, { t: "prompt", text: "hi" }).ok, false, "a session the deck doesn't list takes no presses");
		// Its mod is the current instance: its poll is held.
		const n1 = new FakeReply();
		model.next(new URLSearchParams({ host: spare, inst: "ispare", wait: "20" }), n1);
		assert.equal(model.commands.polling(spare), true);
		// Claimed: the registry lists it, with the plugin, and it takes presses.
		model.setRegistry([reg(1, A), reg(2, B), reg(9, spare)]);
		assert.deepEqual(model.sessions().map((s) => s.key), [A, B, spare]);
		assert.equal(model.session(spare)?.plugin, true);
		const result = model.queue(spare, { t: "prompt", text: "hi" });
		assert.ok(result.ok);
		assert.deepEqual(n1.answers, [{ status: 200, body: { cmds: [{ id: result.cmd.id, t: "prompt", text: "hi" }] } }]);
	});

	test("a hello the latest reading doesn't confirm reads the registry once more: a stale session id is taken, a child's refused", async () => {
		let next: RegistrySession[] = [];
		let reads = 0;
		const { model, view } = setup([reg(1, A)], {
			rescan: async () => {
				reads++;
				model.setRegistry(next);
			},
		});
		// After /clear the session's id is new, and the registry has it, though the deck's latest reading hasn't.
		next = [reg(1, A, { sessionId: "sid-1b" })];
		const taken = model.hello({ v: 1, sid: "sid-1b", host: A, inst: "ia", model: "m" });
		assert.ok(taken instanceof Promise);
		assert.deepEqual(await taken, OK);
		assert.deepEqual([reads, view(A)?.plugin], [1, true]);
		// Listed with this id now: no other reading.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1b", host: A, inst: "ia", model: "m" })), OK);
		// A host the latest reading doesn't list, which the registry lists under another id by now: 409.
		next = [reg(1, A, { sessionId: "sid-1b" }), reg(3, "local_c")];
		assert.deepEqual(await model.hello({ v: 1, sid: "sid-child", host: "local_c", inst: "ichild", model: "m" }), NOT_THIS_SESSION);
		assert.equal(reads, 2);
		// Still unlisted after it: a spare's, taken.
		assert.deepEqual(await model.hello({ v: 1, sid: "sid-9", host: "local_spare", inst: "ispare", model: "m" }), OK);
		assert.equal(reads, 3);
	});
});

describe("mod instances (PROTOCOL.md, Identity)", () => {
	test("only a hello makes an instance current: a poll from one that never said hello is answered at once, never displaces the current one's and never gets commands", () => {
		const { model, view } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		const current = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), current);
		const delivered = model.commands.queue(A, { t: "prompt", text: "one" });
		const n2 = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), n2);
		// A replaced instance's late poll, after a deck restart: it never said hello to this deck.
		const stale = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "istale", wait: "20" }), stale);
		assert.deepEqual(stale.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual([n2.answers, model.commands.polling(A), delivered.state], [[], true, "delivered"], "not a restart, and the current poll stays");
		// Its events and results are still taken, and still don't make it current.
		assert.equal(model.events({ host: A, inst: "istale", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u1", summary: "a.md", fp: "1" }] }).status, 204);
		assert.equal(model.result({ host: A, inst: "istale", id: delivered.id, state: "done" }).status, 204);
		assert.deepEqual([view(A)?.doing, delivered.state], ["a.md", "delivered"], "a result counts only from the instance its command went to");
		const next = model.commands.queue(A, { t: "prompt", text: "two" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: next.id, t: "prompt", text: "two" }] } }], "the current instance gets the command");
		const again = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "istale", wait: "20" }), again);
		assert.deepEqual(again.answers, [{ status: 200, body: { cmds: [] } }]);
	});

	test("before any hello, no instance is current: every poll is answered at once, and the session has no plugin to take presses", () => {
		const { model, view, log } = setup();
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan" }] }).status, 204);
		assert.equal(view(A)?.mode, "plan", "its events are taken");
		const early = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), early);
		assert.deepEqual(early.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.equal(view(A)?.plugin, false);
		assert.deepEqual(model.queue(A, { t: "prompt", text: "x" }), { ok: false, why: `"Session 1"'s mod hasn't said hello to this deck, so it can't take commands until it does` });
		// Its hello makes it current: no restart, as no instance was current before.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		assert.equal(view(A)?.plugin, true);
		const held = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), held);
		assert.deepEqual(held.answers, []);
		assert.ok(!log.lines.some((l) => l.message.startsWith("RESTART")));
	});

	test("a late hello from any of the last 8 instances that said hello, or more, isn't a restart; the oldest past HELLOS_KEPT counts as new again", () => {
		const { model, log } = setup();
		const hi = (inst: string) => now(model.hello({ v: 1, sid: "sid-1", host: A, inst, model: "m" }));
		for (let i = 0; i <= 8; i++) assert.deepEqual(hi(`i${i}`), OK);
		const restarts = (): number => log.lines.filter((l) => l.message.startsWith("RESTART")).length;
		assert.equal(restarts(), 8);
		const poll = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i8", wait: "20" }), poll);
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		const open = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i8", wait: "20" }), open);
		for (let i = 0; i < 8; i++) assert.deepEqual(hi(`i${i}`), OK, `i${i}`);
		assert.deepEqual([restarts(), cmd.state, open.answers], [8, "delivered", []], "none of them a restart: i8 stays current");
		const old = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i0", wait: "20" }), old);
		assert.deepEqual(old.answers, [{ status: 200, body: { cmds: [] } }]);
		// Memory is bounded: past HELLOS_KEPT newer instances, the first is forgotten, and its hello is a restart.
		assert.ok(HELLOS_KEPT >= 8);
		for (let i = 9; i < HELLOS_KEPT + 1; i++) hi(`i${i}`);
		assert.equal(restarts(), HELLOS_KEPT);
		hi("i0");
		assert.equal(restarts(), HELLOS_KEPT + 1);
	});
});

describe("quiet logs (Phase 6)", () => {
	test("refused hellos and unconfirmed hook requests: the first per route and reason at info, then at most one line in 10 minutes, with the count since; the rest at debug", () => {
		const { model, clock, log } = setup();
		const child = (i: number) => {
			model.permission({ session_id: "sid-child", tool_name: "Bash", tool_input: { command: `echo ${i}` } }, A, new FakeReply());
			model.pretool({ session_id: "sid-child", tool_name: MODE_TOOL, tool_input: { session_id: "self", mode: "plan" } }, A, new FakeReply());
			model.hello({ v: 1, sid: "sid-child", host: A, inst: `ichild${i}` });
		};
		for (let i = 0; i < 50; i++) child(i);
		const info = (): string[] => log.at("info").filter((l) => l.includes("UNCONFIRMED") || l.includes("409"));
		assert.deepEqual(info(), [
			`info UNCONFIRMED /v1/permission from ${A} sid "sid-child": the registry lists that host under another session id, so no decision`,
			`info UNCONFIRMED /v1/pretool from ${A} sid "sid-child": the registry lists that host under another session id, so no decision`,
			`info HELLO refused with 409 for ${A} inst "ichild0" sid "sid-child": the registry lists that host under another session id`,
		]);
		assert.equal(log.lines.filter((l) => l.level === "debug" && (l.message.includes("UNCONFIRMED") || l.message.includes("409"))).length, 3 * 49);
		clock.advance(QUIET_MS - 1);
		child(50);
		assert.equal(info().length, 3);
		clock.advance(1);
		child(51);
		child(52);
		assert.deepEqual(info().slice(3), [
			`info UNCONFIRMED /v1/permission from ${A} sid "sid-child": the registry lists that host under another session id, so no decision; 50 more like it, at debug, in the 10 min since the last at info`,
			`info UNCONFIRMED /v1/pretool from ${A} sid "sid-child": the registry lists that host under another session id, so no decision; 50 more like it, at debug, in the 10 min since the last at info`,
			`info HELLO refused with 409 for ${A} inst "ichild51" sid "sid-child": the registry lists that host under another session id; 50 more like it, at debug, in the 10 min since the last at info`,
		]);
	});

	test("a mod talking to a deck it hasn't said hello to, as after a restart in its second between polls, or a registry reading without the session: at info, then quietly, afresh after a hello; a press says why it's refused", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "busy" }), reg(2, B)]);
		const NO_HELLO = `NO HELLO ${A}: mod instance "ia" polls, but no instance has said hello to this deck for the session, so it takes no prompts or mode changes until one does`;
		const noHello = (): string[] => log.at("info").filter((l) => l.includes("NO HELLO"));
		const poll = (): FakeReply => {
			const reply = new FakeReply();
			model.next(new URLSearchParams({ sid: "sid-1", host: A, inst: "ia", wait: "20" }), reply);
			return reply;
		};
		// A deck that started while A's mod waited out its second between polls: no hello comes, ever, as nothing failed.
		assert.deepEqual(poll().answers, [{ status: 200, body: { cmds: [] } }], "answered at once, as Identity says");
		assert.deepEqual(noHello(), [`info ${NO_HELLO}`]);
		for (let i = 0; i < 59; i++) poll();
		assert.equal(model.events({ sid: "sid-1", host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan", at: 1 }] }).status, 204);
		assert.equal(model.result({ sid: "sid-1", host: A, inst: "ia", id: "c9", state: "done" }).status, 204);
		assert.equal(noHello().length, 1, "the rest at debug");
		assert.equal(log.lines.filter((l) => l.level === "debug" && l.message.startsWith(`NO HELLO ${A}: mod instance "ia" `)).length, 61);
		assert.deepEqual([view(A)?.plugin, view(A)?.mode], [false, "plan"]);
		// A press names the missing hello. B's mod has never talked: no plugin.
		assert.deepEqual(model.queue(A, { t: "prompt", text: "hi" }), { ok: false, why: `"Session 1"'s mod hasn't said hello to this deck, so it can't take commands until it does` });
		assert.deepEqual(model.queue(B, { t: "prompt", text: "hi" }), { ok: false, why: '"Session 2" doesn\'t have the plugin' });
		// Still so 10 minutes on: one line at info, with the count since.
		clock.advance(QUIET_MS);
		poll();
		assert.deepEqual(noHello().slice(1), [`info ${NO_HELLO}; 61 more like it, at debug, in the 10 min since the last at info`]);
		// Its hello, when it comes: current, its poll held, a press delivered, and its requests no longer logged so.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		assert.equal(model.events({ sid: "sid-1", host: A, inst: "ia", seq: 2, events: [{ t: "settings", mode: "default", at: 1 }] }).status, 204);
		assert.equal(model.result({ sid: "sid-1", host: A, inst: "ia", id: "c9", state: "done" }).status, 204);
		assert.equal(log.lines.filter((l) => l.message.startsWith("NO HELLO")).length, 63);
		const held = poll();
		const cmd = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(cmd.ok);
		assert.deepEqual(held.answers, [{ status: 200, body: { cmds: [{ id: cmd.cmd.id, t: "prompt", text: "hi" }] } }]);
		const open = poll();
		// One registry reading without A: the deck forgets it and answers its poll (release rule 4). Its next poll is a
		// mod talking without a hello again, at info at once: the hello started the quiet count afresh.
		model.setRegistry([reg(2, B)]);
		model.setRegistry([reg(1, A, { status: "busy" }), reg(2, B)]);
		assert.deepEqual(open.answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(poll().answers, [{ status: 200, body: { cmds: [] } }]);
		assert.deepEqual(noHello().slice(2), [`info ${NO_HELLO}`]);
		assert.equal(view(A)?.plugin, false);
		// A stray poll while an instance is current isn't this: it stays at debug.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia2", model: "m" })), OK);
		const stray = new FakeReply();
		model.next(new URLSearchParams({ sid: "sid-1", host: A, inst: "istale", wait: "20" }), stray);
		assert.deepEqual([stray.answers, noHello().length], [[{ status: 200, body: { cmds: [] } }], 3]);
		// Nor is a session the registry doesn't list, which takes no presses: one ending, say, whose mod polled once more.
		const ending = new FakeReply();
		model.next(new URLSearchParams({ sid: "sid-5", host: "local_e", inst: "ie", wait: "20" }), ending);
		assert.deepEqual([ending.answers, noHello().length], [[{ status: 200, body: { cmds: [] } }], 3]);
		assert.ok(log.lines.some((l) => l.level === "debug" && l.message === `NO HELLO local_e: mod instance "ie" polls, but no instance has said hello to this deck for the session, so it takes no prompts or mode changes until one does; the registry doesn't list it`));
	});

	test("QuietLog: a key's first line at info, then one per period with the count since, and keys apart", () => {
		const clock = new FakeClock();
		const log = new RecordingLog();
		const quiet = new QuietLog(log, { clock, everyMs: 1000 });
		quiet.note("a", "one");
		quiet.note("a", "two");
		quiet.note("b", "three");
		clock.advance(999);
		quiet.note("a", "four");
		clock.advance(1);
		quiet.note("a", "five");
		clock.advance(5000);
		quiet.note("a", "six");
		// Forgotten, a key starts afresh: its next line at info, with no count, and other keys keep theirs.
		quiet.note("a", "seven");
		quiet.note("b", "eight");
		quiet.forget("a");
		quiet.note("a", "nine");
		quiet.note("b", "ten");
		assert.deepEqual(log.lines.map((l) => `${l.level} ${l.message}`), [
			"info one",
			"debug two",
			"info three",
			"debug four",
			"info five; 2 more like it, at debug, in the 0 min since the last at info",
			"info six",
			"debug seven",
			"info eight",
			"info nine",
			"debug ten",
		]);
	});
});
