import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { SessionModel } from "../src/model/sessions.js";
import { sessionStatus } from "../src/model/status.js";
import { fingerprint } from "../src/protocol/fingerprint.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
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

function setup(registry: RegistrySession[] = [reg(1, A), reg(2, B)]) {
	let wall = 10_000;
	const clock = new FakeClock();
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => wall });
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
		model.permission({ session_id: host === A ? "sid-1" : "sid-2", tool_name: tool, tool_input: input, permission_mode: "default", effort: { level: "low" }, ...extra }, host, reply);
		return reply;
	};
	/** The mod's long poll, from the instance `events` sends as. */
	const poll = (host: string): FakeReply => {
		const reply = new FakeReply();
		model.next(new URLSearchParams({ host, inst: `i-${host}`, wait: "20" }), reply);
		return reply;
	};
	return { model, clock, log, at, events, permission, poll, view: (host: string) => model.session(host) };
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
		model.hello({ v: 1, host: A, inst: `i-${A}`, model: "m" });
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
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
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

	test("rule 3 without statusUpdatedAt: only a change to idle the deck saw counts, never a session's first reading", () => {
		const { model, at, permission } = setup([]);
		at(5000);
		// Held for a session the registry doesn't list yet.
		const r = permission(A, "Bash", { command: "a" });
		at(6000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null })]);
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
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
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
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
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

	test("without X-Deck-Host, the registry's sid finds the session, now or once it lists it", () => {
		const { model } = setup([reg(1, A)]);
		const r = new FakeReply();
		model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "ls" } }, "$CLAUDE_CODE_HOST_SESSION_ID", r);
		assert.equal(model.held.oldest?.host, A, "an uninterpolated header is no host");
		model.permission({ session_id: "sid-7", tool_name: "Bash", tool_input: { command: "ls" } }, undefined, new FakeReply());
		assert.equal(model.held.list()[1]?.host, null);
		model.setRegistry([reg(1, A), reg(7, "local_g")]);
		assert.equal(model.held.list()[1]?.host, "local_g");
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
		model.hello({ v: 1, host: A, inst: "ia", model: "claude-haiku-5-5" });
		model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u1", summary: "a.md", fp: "1" }, { t: "measure", context: { percent: 30 } }] });
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		model.next(new URLSearchParams({ host: A, inst: "ia" }), new FakeReply());
		const queued = model.commands.queue(A, { t: "prompt", text: "later" });
		model.hello({ v: 1, host: A, inst: "ib", model: "claude-haiku-5-5" });
		assert.deepEqual([view(A)?.doing, view(A)?.context, view(A)?.model], [null, 30, "claude-haiku-5-5"]);
		assert.deepEqual([cmd.state, cmd.error], ["failed", "the mod restarted"]);
		assert.equal(queued.state, "queued");
		// The new instance takes the queued prompt and starts a tool. A late request from the old one, an
		// instance seen before, isn't another restart, so neither is forgotten.
		model.next(new URLSearchParams({ host: A, inst: "ib" }), new FakeReply());
		model.events({ host: A, inst: "ib", seq: 1, events: [{ t: "tool.start", tool: "Read", use: "u2", summary: "b.md", fp: "2" }] });
		model.hello({ v: 1, host: A, inst: "ia", model: "claude-haiku-5-5" });
		assert.deepEqual([queued.state, view(A)?.doing], ["delivered", "b.md"]);
	});

	test("an instance seen before never counts as a restart again, however many came after it, and its requests are still taken", () => {
		const { model, view } = setup([reg(1, A, { status: "busy" })]);
		for (let i = 0; i < 12; i++) model.hello({ v: 1, host: A, inst: `i${i}`, model: "m" });
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
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
		const old = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), old);
		assert.deepEqual(old.answers, []);
		model.hello({ v: 1, host: A, inst: "ib", model: "m" });
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
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
		model.hello({ v: 1, host: A, inst: "ib", model: "m" });
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
		model.hello({ v: 1, host: A, inst: "ib", model: "m" });
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
		const { model } = setup([reg(1, A)]);
		// A session the registry doesn't list: its mod said hello with both.
		model.hello({ v: 1, sid: "sid-x", host: "local_x", inst: "ix", model: "m" });
		const r = new FakeReply();
		model.permission({ session_id: "sid-x", tool_name: "Bash", tool_input: { command: "ls" } }, "", r);
		assert.equal(model.held.oldest?.host, "local_x");
		// The variable unset: the mod sends its host as "".
		assert.equal(model.events({ sid: "sid-x", host: "", inst: "ix", seq: 1, events: [{ t: "turn.start", turn: "t1" }] }).status, 204);
		const poll = new FakeReply();
		model.next(new URLSearchParams({ sid: "sid-x", host: "", inst: "ix", wait: "0" }), poll);
		assert.deepEqual(poll.answers, [{ status: 200, body: { cmds: [] } }]);
		// The registry comes first: a pair a mod sent can't move a sid the registry places.
		model.hello({ v: 1, sid: "sid-1", host: "local_y", inst: "iy", model: "m" });
		model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "pwd" } }, undefined, new FakeReply());
		assert.equal(model.held.list()[1]?.host, A);
		assert.equal(model.events({ sid: "sid-unknown", host: "", inst: "iz", seq: 1, events: [] }).status, 400);
	});

	test("the host fallback also uses the hook's sid and host pairs, and every sid a session came with", () => {
		const { model } = setup([reg(1, A)]);
		// A session the registry doesn't list: its PermissionRequest came with both.
		model.permission({ session_id: "sid-x", tool_name: "Bash", tool_input: { command: "ls" } }, "local_x", new FakeReply());
		assert.equal(model.held.oldest?.host, "local_x");
		// Its mod, without its host, is placed by the hook's pair.
		assert.equal(model.hello({ v: 1, sid: "sid-x", host: "", inst: "ix", model: "m" }).status, 200);
		assert.equal(model.session(A)?.plugin, false, "not the registry's session");
		assert.equal(model.events({ sid: "sid-x", host: "", inst: "ix", seq: 1, events: [{ t: "turn.start", turn: "t1" }] }).status, 204);
		// The session's id changes, as after /clear: its mod comes with the new one and its host.
		assert.equal(model.events({ sid: "sid-x2", host: "local_x", inst: "ix", seq: 2, events: [{ t: "end", reason: "clear" }] }).status, 204);
		// A PermissionRequest without a usable host is placed by either id.
		model.permission({ session_id: "sid-x2", tool_name: "Bash", tool_input: { command: "pwd" } }, "$CLAUDE_CODE_HOST_SESSION_ID", new FakeReply());
		model.permission({ session_id: "sid-x", tool_name: "Bash", tool_input: { command: "id" } }, undefined, new FakeReply());
		assert.deepEqual(
			model.held.list().map((h) => [h.summary, h.host]),
			[
				["ls", "local_x"],
				["pwd", "local_x"],
				["id", "local_x"],
			],
		);
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
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
		assert.deepEqual(model.queue("local_c", { t: "prompt", text: "x" }), { ok: false, why: '"Session 3" has ended' });
	});

	test("commands go only to listed sessions with the plugin", () => {
		const { model } = setup([reg(1, A), reg(2, B), reg(9, null)]);
		model.hello({ v: 1, host: A, inst: "ia", model: "m" });
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
