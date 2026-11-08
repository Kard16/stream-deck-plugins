import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IN_FLIGHT_MS, type PollReply } from "../src/bridge/commands.js";
import type { RouteAnswer } from "../src/bridge/server.js";
import { HELLOS_KEPT, SessionModel } from "../src/model/sessions.js";
import { sessionStatus } from "../src/model/status.js";
import { fingerprint } from "../src/protocol/fingerprint.js";
import { AGENT_KINDS, parseEvent, type ThreadRun, type Threads } from "../src/protocol/wire.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { idleCounts, resetIdleCounts } from "../src/util/idle.js";
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
const C = "local_c";

function reg(pid: number, host: string | null, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "idle", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

function record(host: string, fields: Partial<AppRecord> = {}): AppRecord {
	return { host, title: null, model: "claude-haiku-5-5", effort: "low", permissionMode: "default", lastFocusedAt: null, turnCategory: null, isArchived: false, lastActivityAt: null, cwd: null, summary: null, needs: null, ...fields };
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
/** A poll's answer for a session no instance has said hello for (PROTOCOL.md, Identity). */
const HELLO_FIRST = { status: 409, body: { error: "hello first" } };
/** A poll's answer with no commands. */
const NO_CMDS = { status: 200, body: { cmds: [] } };

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
	return { model, clock, log, at, events, permission, hello, poll, view: (host: string) => model.session(host) };
}

describe("session status (PROTOCOL.md's order)", () => {
	const base = { heldTool: 0, heldAsk: 0, registry: "idle", statusUpdatedAt: 1000, firstReadingAt: 1000, turn: null, recordCategory: null, running: 0 };
	/** The main loop's last turn, whose `turn.start` the deck got at 3000, and its `turn.end` at 5000. */
	const ended = (reason: string, failed = false) => ({ ended: true, reason, failed, startedAt: 3000, endedAt: 5000 });
	/** An unfinished turn with no start time: rule 3's clause for a turn.start has nothing to compare. */
	const unfinished = { ended: false, reason: null, failed: false, startedAt: null, endedAt: null };
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

	test("rule 3 from the main loop's turn.start: working while it has no turn.end and the registry's idle began at or before the deck got it", () => {
		/** The main loop's turn, whose turn.start the deck got at 5000, and nothing since. */
		const running = { ended: false, reason: null, failed: false, startedAt: 5000, endedAt: null };
		const idle = { ...base, registry: "idle", turn: running };
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000 }), "working");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 5000 }), "working", "at the same moment counts");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 5001 }), "idle", "an idle that began after the turn.start: the turn ended unseen");
		// Without statusUpdatedAt, the deck's first reading of the idle stands in for it.
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: null, firstReadingAt: 4000 }), "working");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: null, firstReadingAt: 5000 }), "working");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: null, firstReadingAt: 5001 }), "idle");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: null, firstReadingAt: null }), "idle", "nothing to go by");
		// With the field there, it decides, whenever the deck first read the idle.
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, firstReadingAt: 6000 }), "working");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 6000, firstReadingAt: 4000 }), "idle");
		// A turn whose start the deck has no time for: nothing to compare.
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, turn: { ...running, startedAt: null } }), "idle");
		// Once the turn has ended, by a turn.end or a failed, rules 4–8 as before.
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, turn: { ...running, ended: true, reason: "answer", endedAt: 6000 } }), "done");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, turn: { ...running, ended: true, reason: "aborted", endedAt: 6000 } }), "interrupted");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, turn: { ...running, ended: true, failed: true } }), "failed");
		// After rules 1 and 2, before the app's indicator; and only for an idle.
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, heldTool: 1 }), "approval");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, heldAsk: 1 }), "needs-you");
		assert.equal(sessionStatus({ ...idle, statusUpdatedAt: 4000, recordCategory: "blocked" }), "working");
		assert.equal(sessionStatus({ ...idle, registry: "waiting", statusUpdatedAt: 4000 }), "needs-you");
		assert.equal(sessionStatus({ ...idle, registry: null, statusUpdatedAt: 4000 }), "idle");
	});

	test("rule 3's background: other loops in a turn while the main loop isn't, whatever the registry says; after approval and needs-you, before failed, interrupted, the app's indicator, done and idle (Phase 9)", () => {
		const bg = { ...base, running: 2 };
		assert.equal(sessionStatus({ ...bg, turn: ended("error", true) }), "background", "before failed");
		assert.equal(sessionStatus({ ...bg, turn: ended("aborted") }), "background", "before interrupted");
		assert.equal(sessionStatus({ ...bg, turn: ended("answer"), recordCategory: "blocked" }), "background", "before the app's needs-input indicator");
		assert.equal(sessionStatus({ ...bg, turn: ended("answer") }), "background", "before done");
		assert.equal(sessionStatus(bg), "background", "the deck has seen no turn: the main loop isn't in one");
		// Whatever the registry says: a busy from before the turn's end or after it, an idle that trails, or none.
		for (const registry of ["busy", "idle", null]) {
			for (const statusUpdatedAt of [4000, 6000]) assert.equal(sessionStatus({ ...bg, registry, statusUpdatedAt, turn: ended("answer") }), "background", `${registry} from ${statusUpdatedAt}`);
		}
		assert.equal(sessionStatus({ ...bg, heldTool: 1, turn: ended("answer") }), "approval");
		assert.equal(sessionStatus({ ...bg, heldAsk: 1, turn: ended("answer") }), "needs-you");
		assert.equal(sessionStatus({ ...bg, registry: "waiting", turn: ended("answer") }), "needs-you");
		// While the main loop's turn runs, it's working.
		const turnRuns = { ended: false, reason: null, failed: false, startedAt: 5000, endedAt: null };
		assert.equal(sessionStatus({ ...bg, registry: "busy", turn: turnRuns }), "working");
		assert.equal(sessionStatus({ ...bg, registry: "idle", statusUpdatedAt: 4000, turn: turnRuns }), "working");
		assert.equal(sessionStatus({ ...base, turn: ended("answer") }), "done", "with no other loop, as before");
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

	test("status rule 3 from the main loop's turn.start, timed on the deck's wall clock: working before the registry says busy; a subagent's turn.start doesn't count, nor does an idle that began after it", () => {
		const { model, at, events, view } = setup([reg(1, A, { status: "idle", statusUpdatedAt: 9000 })]);
		at(10_000);
		events(A, { t: "turn.start", turn: "s1", agent: "a1b2" });
		assert.equal(view(A)?.status, "idle", "a subagent's turn.start");
		// The main loop's: its `at` is the mod's clock (1 here), and the deck times it on its own, at 10000.
		events(A, { t: "turn.start", turn: "t1" });
		assert.deepEqual([view(A)?.status, view(A)?.doing], ["working", null]);
		at(10_500);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 10_400 })]);
		assert.equal(view(A)?.status, "working");
		at(11_000);
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 11_200 })]);
		assert.equal(view(A)?.status, "done");
		// The next turn starts, and ends unseen: the deck never gets its turn.end, and between two readings the
		// registry went busy and back to idle. That idle began after the turn.start, so the turn no longer counts.
		at(20_000);
		events(A, { t: "turn.start", turn: "t2" });
		assert.equal(view(A)?.status, "working");
		at(30_000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 25_000 })]);
		assert.equal(view(A)?.status, "idle");
	});

	test("status rule 3 from the main loop's turn.start without statusUpdatedAt: the deck's first reading of the idle", () => {
		const { model, at, events, view } = setup([]);
		at(5000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null })]);
		at(6000);
		events(A, { t: "turn.start", turn: "t1" });
		assert.equal(view(A)?.status, "working", "first read at 5000, before the turn.start at 6000");
		at(7000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null, name: "Renamed" })]);
		assert.equal(view(A)?.status, "working", "another reading of the same idle");
		at(8000);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: null })]);
		assert.equal(view(A)?.status, "working");
		at(9000);
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: null })]);
		assert.equal(view(A)?.status, "idle", "idle again since a reading showed it busy, first read after the turn.start");
	});

	test("status rule 3 from the main loop's latest turn.start: one that comes while the last turn has no turn.end, its turn.end lost, is timed on its own arrival", () => {
		// With statusUpdatedAt, and without it, when the deck's first reading of the idle stands in for it.
		for (const stamped of [true, false]) {
			const what = stamped ? "with statusUpdatedAt" : "by the first reading";
			const { model, at, events, view } = setup([reg(1, A, { status: "idle", statusUpdatedAt: stamped ? 9000 : null })]);
			at(10_000);
			events(A, { t: "turn.start", turn: "t1" });
			assert.equal(view(A)?.status, "working", what);
			// t1's turn.end never reaches the deck. Between two readings, the registry went busy and back to idle at 12000.
			at(10_500);
			model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: stamped ? 10_400 : null })]);
			at(12_500);
			model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: stamped ? 12_000 : null })]);
			assert.equal(view(A)?.status, "idle", `${what}: an idle that began after t1's turn.start, so t1 ended unseen`);
			// The next turn starts, with t1 still unended as far as the deck knows. The latest turn.start is t2's, which the
			// deck got at 20000, after that idle began, so it shows working until the registry says busy.
			at(20_000);
			events(A, { t: "turn.start", turn: "t2" }, { t: "turn.start", turn: "s1", agent: "a1b2" });
			assert.equal(view(A)?.status, "working", `${what}: t2 timed at 20000, not at t1's 10000`);
			at(21_000);
			events(A, { t: "turn.end", turn: "t2", reason: "answer" });
			assert.equal(view(A)?.status, "done", what);
		}
	});

	test("two files for one host, as for a moment when a session's process restarts: the one with the later startedAt shows, whichever is read first", () => {
		const older = reg(1, A, { startedAt: 100, status: "idle", name: "Old" });
		const newer = reg(5, A, { startedAt: 500, status: "busy", name: "New", sessionId: "sid-new" });
		for (const files of [
			[older, newer],
			[newer, older],
		]) {
			const { view } = setup(files);
			assert.deepEqual([view(A)?.pid, view(A)?.title, view(A)?.status], ["5", "New", "working"], files.map((f) => f.key).join(", "));
		}
	});

	test("release rule 4 fires only once no file lists the host: either of two files going first ends nothing", () => {
		const older = reg(1, A, { startedAt: 100, status: "busy" });
		const newer = reg(5, A, { startedAt: 500, status: "busy", sessionId: "sid-new" });
		for (const [first, last] of [
			[older, newer],
			[newer, older],
		] as const) {
			const what = `${first.key} goes first`;
			const { model, log, view } = setup([older, newer, reg(2, B)]);
			assert.deepEqual(now(model.hello({ v: 1, sid: "sid-new", host: A, inst: "ia", model: "m" })), OK);
			const queued = model.queue(A, { t: "prompt", text: "hi" });
			assert.ok(queued.ok);
			const poll = (): FakeReply => {
				const reply = new FakeReply();
				model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), reply);
				return reply;
			};
			assert.equal(poll().answers.length, 1, "the command is delivered");
			const open = poll();
			const request = new FakeReply();
			model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "make" } }, A, request);
			assert.equal(model.held.size, 1);
			// One file goes: the other still lists A, and the deck shows it.
			model.setRegistry([last, reg(2, B)]);
			assert.deepEqual([request.answers, open.answers, queued.cmd.state, view(A)?.plugin, view(A)?.pid], [[], [], "delivered", true, last.key], what);
			assert.ok(!log.lines.some((l) => l.message.startsWith("ENDED")), what);
			// Then the other goes too: no file lists A, and rule 4 fires.
			model.setRegistry([reg(2, B)]);
			assert.deepEqual([request.answers, open.answers], [[NONE], [NO_CMDS]], what);
			assert.deepEqual([queued.cmd.state, queued.cmd.error], ["failed", "the session ended"], what);
			assert.deepEqual(
				log.at("info").filter((l) => l.includes("ENDED") || l.includes("RELEASED")),
				[`info RELEASED #1 "Bash": no registry file lists the session any more (rule 4); 0 held`, `info ENDED ${A}: no registry file lists it any more`],
				what,
			);
		}
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

	test("a request is a tool or an ask", () => {
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

	test("rule 1: the session's tool.end with the same fp releases the oldest match; another session's doesn't", () => {
		const { model, events, permission } = setup([reg(1, A, { status: "busy" }), reg(2, B, { status: "busy" })]);
		const write = { file_path: "/x/s5.txt", content: "five" };
		const first = permission(A, "Write", write);
		const second = permission(A, "Write", write);
		const fp = fingerprint("Write", write);
		events(B, { t: "tool.end", tool: "Write", use: "u1", fp, ok: true });
		assert.equal(model.held.size, 2);
		events(A, { t: "tool.end", tool: "Write", use: "u1", fp, ok: true });
		assert.deepEqual(first.answers, [{ status: 200, body: {} }]);
		assert.deepEqual(second.answers, []);
	});

	test("rule 1 matches the loop (Phase 9): an agent's tool.end releases only that agent's request, and the main loop's only one with no agent_id", () => {
		const { model, log, events, permission } = setup([reg(1, A, { status: "busy" })]);
		const npm = { command: "npm test" };
		const fp = fingerprint("Bash", npm);
		const s1 = permission(A, "Bash", npm, { agent_id: "s1" });
		const main = permission(A, "Bash", npm);
		// agent_id is kept only as a non-empty string: anything else is the main loop's.
		const empty = permission(A, "Bash", npm, { agent_id: "" });
		assert.deepEqual(model.held.list().map((h) => h.agent), ["s1", null, null]);
		assert.ok(log.at("info").includes(`info HELD #1 tool "Bash" "npm test" fp ${fp} from ${A} agent "s1"; 1 held`), log.at("info").join("\n"));
		assert.ok(log.at("info").includes(`info HELD #2 tool "Bash" "npm test" fp ${fp} from ${A}; 2 held`), "no agent part for the main loop's");
		// Another agent's identical call: nothing.
		events(A, { t: "tool.end", tool: "Bash", use: "u1", agent: "s2", fp, ok: true });
		assert.equal(model.held.size, 3);
		// The main loop's: the oldest with no agent, though s1's is older.
		events(A, { t: "tool.end", tool: "Bash", use: "u2", fp, ok: true });
		assert.deepEqual([s1.answers, main.answers, empty.answers], [[], [NONE], []]);
		// s1's own: its request, never a main-loop one.
		events(A, { t: "tool.end", tool: "Bash", use: "u3", agent: "s1", fp, ok: true });
		assert.deepEqual([s1.answers, empty.answers], [[NONE], []]);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("RELEASED")),
			[
				`info RELEASED #2 "Bash": the session reported the call's end (rule 1, fp ${fp}); 2 held`,
				`info RELEASED #1 "Bash": the session reported the call's end (rule 1, fp ${fp}, agent "s1"); 1 held`,
			],
		);
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
		const delivered = model.commands.queue(A, { t: "prompt", text: "two" });
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
		}
		assert.equal(model.held.size, 0);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("UNCONFIRMED")),
			[`info UNCONFIRMED /v1/permission from no host sid "sid-1": no X-Deck-Host that's an app id, so no decision`],
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
		assert.equal(model.commands.result(A, `i-${A}`, cmd.id, "waiting", null), true);
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
		// The mod keeps a poll open, as a live mod does, polling again as each runs out after its 20 s.
		let n3 = poll(A);
		for (let i = 0; i < 3; i++) {
			clock.advance(20_000);
			assert.deepEqual(n3.answers, [NO_CMDS]);
			n3 = poll(A);
		}
		// A busy with no turn.start, 60 s after that turn ended, by the monotonic clock.
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
		// The mod polls about once a second, as after every early empty answer, each answered at once.
		for (let i = 1; i < 60; i++) {
			clock.advance(1000);
			assert.deepEqual(poll(A).answers, [NO_CMDS], `${i} s after the failed`);
		}
		clock.advance(1000);
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

	test("the target: the session last jumped to; until then the one last on screen", () => {
		const { model, events } = setup([reg(1, A), reg(2, B), reg(3, "local_c")]);
		assert.equal(model.target(), null, "nothing has been on screen");
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 9000 })], [B, record(B, { lastFocusedAt: 8000 })]]));
		assert.equal(model.target()?.key, A);
		events(B, { t: "attach", surface: "desktop" });
		assert.equal(model.target()?.key, B, "B came on screen at 10000, after A's 9000");
		model.pick("local_c", "slot key dev:1:0");
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
		const { model } = setup([reg(2, B)], {
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
		// A client that goes away while the registry is read gets nothing, and nothing is held.
		next = [...next, reg(4, "local_d", { status: "busy" })];
		const gone = new FakeReply();
		const going = model.permission({ session_id: "sid-4", tool_name: "Bash", tool_input: { command: "ls" } }, "local_d", gone);
		gone.close();
		await going;
		assert.deepEqual([reads, gone.answers, model.held.size], [3, [], 2]);
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

	test("a confirmation doesn't outlive the reading that gave it: a session id the registry no longer lists stops confirming", async () => {
		let next: RegistrySession[] = [reg(1, A, { status: "busy" })];
		let reads = 0;
		const { model } = setup(next, {
			rescan: async () => {
				reads++;
				model.setRegistry(next);
			},
		});
		const request = (sid: string, command: string): FakeReply => {
			const reply = new FakeReply();
			void model.permission({ session_id: sid, tool_name: "Bash", tool_input: { command } }, A, reply);
			return reply;
		};
		assert.deepEqual([request("sid-1", "a").answers, model.held.size, reads], [[], 1, 0], "confirmed by the latest reading");
		// After /clear, the registry lists A under its new session id.
		next = [reg(1, A, { status: "busy", sessionId: "sid-1b" })];
		model.setRegistry(next);
		const stale = new FakeReply();
		await model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "b" } }, A, stale);
		assert.deepEqual([stale.answers, model.held.size, reads], [[NONE], 1, 1], "the old id, read once more: no decision");
		assert.deepEqual(await model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" }), NOT_THIS_SESSION);
		assert.deepEqual([request("sid-1b", "c").answers, model.held.size, reads], [[], 2, 2], "the new id confirms at once");
	});

	test("a hook's request is timed when it arrives, before any second reading of the registry, so release rules 2 and 3 compare that time", async () => {
		const { model, at } = setup([reg(2, B)], {
			rescan: async () => {
				// The second reading comes later, and finds the session gone idle after the request arrived.
				at(6000);
				model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 5500 }), reg(2, B)]);
			},
		});
		at(5000);
		const r = new FakeReply();
		const taking = model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "a" } }, A, r);
		assert.ok(taking instanceof Promise, "it waits for the reading");
		await taking;
		assert.deepEqual(
			model.held.list().map((h) => [h.host, h.at]),
			[[A, 5000]],
		);
		// The next reading still says idle since 5500, after the request arrived: rule 3 lets it go.
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 5500 }), reg(2, B)]);
		assert.deepEqual([r.answers, model.held.size], [[NONE], 0]);
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
		assert.equal(model.result({ host: A, id: delivered.id, state: "done" }).status, 204, "one with no inst is answered as ignored");
		assert.deepEqual([view(A)?.doing, delivered.state], ["a.md", "delivered"], "a result counts only from the instance its command went to");
		const next = model.commands.queue(A, { t: "prompt", text: "two" });
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: next.id, t: "prompt", text: "two" }] } }], "the current instance gets the command");
		const again = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "istale", wait: "20" }), again);
		assert.deepEqual(again.answers, [{ status: 200, body: { cmds: [] } }]);
	});

	test("before any hello, no instance is current: every poll gets 409 hello first at once, and the session has no plugin to take presses", () => {
		const { model, view, log } = setup();
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan" }] }).status, 204);
		assert.equal(view(A)?.mode, "plan", "its events are taken");
		const early = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "ia", wait: "20" }), early);
		assert.deepEqual(early.answers, [HELLO_FIRST]);
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

	test("a late hello from a replaced instance leaves the new one current: its fresh poll is held and takes the next command, the late one's gets none at once, and the late hello's settings are dropped", () => {
		const { model, view, log } = setup([reg(1, A, { status: "idle" })]);
		const hello = (inst: string, settings: { model: string; mode: string; effort: string }) => now(model.hello({ v: 1, sid: "sid-1", host: A, inst, ...settings }));
		assert.deepEqual(hello("i0", { model: "claude-haiku-5-5", mode: "default", effort: "low" }), OK);
		// The mod reloads: i1 says hello, a restart.
		assert.deepEqual(hello("i1", { model: "claude-haiku-5-5", mode: "acceptEdits", effort: "low" }), OK);
		// i0's hello comes late, from its line still running after the reload, with what it had seen: ok, and nothing else.
		assert.deepEqual(hello("i0", { model: "claude-opus-5-5", mode: "plan", effort: "max" }), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.model, view(A)?.mode, view(A)?.effort], [true, "claude-haiku-5-5", "acceptEdits", "low"]);
		const fresh = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i1", wait: "20" }), fresh);
		assert.deepEqual(fresh.answers, [], "i1's poll is held");
		const late = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i0", wait: "20" }), late);
		assert.deepEqual([late.answers, fresh.answers], [[NO_CMDS], []], "i0's is answered at once, and doesn't displace i1's");
		const cmd = model.commands.queue(A, { t: "prompt", text: "hi" });
		assert.deepEqual(fresh.answers, [{ status: 200, body: { cmds: [{ id: cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.deepEqual([cmd.state, cmd.inst], ["delivered", "i1"]);
		assert.deepEqual(
			log.lines.filter((l) => l.message.startsWith("RESTART")).map((l) => l.message),
			[`RESTART ${A}: mod instance "i1" replaces "i0"; its current tool and in-flight commands are forgotten, and any poll the old one left open is answered`],
		);
	});

	test("hello first: with no instance current, every poll for the session gets 409 at once, whatever its inst, none included; once one is, another instance's poll gets none at once", () => {
		const { model } = setup();
		const poll = (params: Record<string, string>): FakeReply => {
			const reply = new FakeReply();
			model.next(new URLSearchParams({ wait: "20", ...params }), reply);
			return reply;
		};
		const before: Record<string, string>[] = [{ host: A, inst: "ia" }, { host: A, inst: "istale" }, { host: A }, { host: "", sid: "sid-1", inst: "ia" }];
		for (const params of before) assert.deepEqual(poll(params).answers, [HELLO_FIRST], JSON.stringify(params));
		assert.equal(model.commands.polling(A), false, "none is held");
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		const strays: Record<string, string>[] = [{ host: A, inst: "istale" }, { host: A }];
		for (const params of strays) assert.deepEqual(poll(params).answers, [NO_CMDS], JSON.stringify(params));
		assert.deepEqual(poll({ host: A, inst: "ia" }).answers, [], "the current instance's is held");
		// Another session, which no instance has said hello for, still gets 409.
		assert.deepEqual(poll({ host: B, inst: "ib" }).answers, [HELLO_FIRST]);
	});

	test("after the 409, the mod's hello makes its instance current: its poll is held and takes commands; so again after release rule 4 forgot the session", () => {
		const { model, view } = setup([reg(1, A, { status: "idle" }), reg(2, B)]);
		const poll = (): FakeReply => {
			const reply = new FakeReply();
			model.next(new URLSearchParams({ sid: "sid-1", host: A, inst: "ia", wait: "20" }), reply);
			return reply;
		};
		const prompt = (text: string): { reply: FakeReply; id: string } => {
			const reply = poll();
			assert.deepEqual(reply.answers, [], "held");
			const queued = model.queue(A, { t: "prompt", text });
			assert.ok(queued.ok, JSON.stringify(queued));
			return { reply, id: queued.cmd.id };
		};
		assert.deepEqual(poll().answers, [HELLO_FIRST]);
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		const one = prompt("one");
		assert.deepEqual(one.reply.answers, [{ status: 200, body: { cmds: [{ id: one.id, t: "prompt", text: "one" }] } }]);
		// A registry reading that misses A: the deck forgets it and answers its open poll (release rule 4).
		const open = poll();
		model.setRegistry([reg(2, B)]);
		assert.deepEqual(open.answers, [NO_CMDS]);
		model.setRegistry([reg(1, A, { status: "idle" }), reg(2, B)]);
		assert.equal(view(A)?.plugin, false);
		// The mod's next poll asks for a hello, and the same instance's hello is a first one to the deck that forgot it.
		assert.deepEqual(poll().answers, [HELLO_FIRST]);
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		assert.equal(view(A)?.plugin, true);
		const two = prompt("two");
		assert.deepEqual(two.reply.answers, [{ status: 200, body: { cmds: [{ id: two.id, t: "prompt", text: "two" }] } }]);
	});

	test("a host the registry doesn't list gets 409 too, logged only at debug; its hello is taken, and its next poll held", () => {
		const { model, log } = setup();
		const spare = "local_spare";
		const poll = (): FakeReply => {
			const reply = new FakeReply();
			model.next(new URLSearchParams({ sid: "sid-9", host: spare, inst: "ispare", wait: "20" }), reply);
			return reply;
		};
		assert.deepEqual(poll().answers, [HELLO_FIRST]);
		assert.deepEqual(
			log.lines.filter((l) => l.message.includes("HELLO FIRST")).map((l) => `${l.level} ${l.message}`),
			[`debug HELLO FIRST ${spare}: mod instance "ispare" polls, but no instance has said hello to this deck for the session, so the deck answers 409 to ask for one; the registry doesn't list it`],
		);
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-9", host: spare, inst: "ispare", model: "m" })), OK);
		const held = poll();
		assert.deepEqual([held.answers, model.commands.polling(spare)], [[], true]);
	});

	test("a hello that makes an instance current repaints the deck, a restart's included", () => {
		const { model } = setup();
		const seen: unknown[] = [];
		model.onChange(() => seen.push([model.session(A)?.plugin, model.session(A)?.model]));
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "claude-haiku-5-5" })), OK);
		assert.deepEqual(seen, [[true, "claude-haiku-5-5"]]);
		// A new instance, with nothing in flight to fail: only its hello repaints.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib", model: "claude-opus-5-5" })), OK);
		assert.deepEqual(seen.slice(1), [[true, "claude-opus-5-5"]]);
	});
});

/** A poll for A from `inst`, as the mod sends it. */
function pollAs(model: SessionModel, inst: string, wait = "20"): FakeReply {
	const reply = new FakeReply();
	model.next(new URLSearchParams({ sid: "sid-1", host: A, inst, wait }), reply);
	return reply;
}

/** A hello for A from `inst`, with the given settings. */
function helloAs(model: SessionModel, inst: string, fields: Record<string, unknown> = {}): RouteAnswer {
	return now(model.hello({ v: 1, sid: "sid-1", host: A, inst, model: "claude-haiku-5-5", ...fields }));
}

/** The line that says A's current instance `inst` has stopped counting (PROTOCOL.md, Identity). */
const UNPOLLED = (inst: string): string =>
	`UNPOLLED ${A}: mod instance "${inst}" has had no poll open for 60 s, so it's no longer the current one; the mod's next poll gets 409 to ask for a hello, and the first instance to say one is made current`;

/** The RESTART lines logged so far. */
const restartsIn = (log: RecordingLog): string[] => log.lines.filter((l) => l.message.startsWith("RESTART")).map((l) => l.message);

describe("a current instance that stops polling stops counting (PROTOCOL.md, Identity; Phase 6)", () => {
	test("two live mods for one host after a deck restart: the predecessor's hello lands last, and it's current until it has gone 60 s with no poll; then the live mod's next poll gets 409, its hello makes it current, not as a restart, and its poll is held and takes the next command", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "idle" })]);
		const restarts = (): number => log.lines.filter((l) => l.message.startsWith("RESTART")).length;
		// The deck has just restarted: each mod's next poll asks for a hello, and each says one. The predecessor's, from a
		// process about to exit, lands last, so it replaces the live one's.
		assert.deepEqual(pollAs(model, "inew").answers, [HELLO_FIRST]);
		assert.deepEqual(pollAs(model, "iold").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual(helloAs(model, "iold"), OK);
		assert.equal(restarts(), 1);
		// iold never polls again. inew polls about once a second, each a stray's poll now, answered at once with none.
		for (let i = 1; i < 60; i++) {
			clock.advance(1000);
			assert.deepEqual(pollAs(model, "inew").answers, [NO_CMDS], `${i} s after iold's hello`);
		}
		clock.advance(999);
		assert.equal(view(A)?.plugin, true, "iold is current 1 ms before its 60 s");
		clock.advance(1);
		assert.equal(view(A)?.plugin, false, "60 s after iold's hello, with no poll of its since");
		assert.deepEqual(log.at("info").filter((l) => l.includes("UNPOLLED")), [`info ${UNPOLLED("iold")}`], "one line at info");
		// inew's next poll asks for a hello, and its hello makes it current: no restart, since none was current.
		assert.deepEqual(pollAs(model, "inew").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual([view(A)?.plugin, restarts()], [true, 1]);
		const held = pollAs(model, "inew");
		assert.deepEqual(held.answers, [], "inew's poll is held");
		const queued = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(queued.ok, JSON.stringify(queued));
		assert.deepEqual(held.answers, [{ status: 200, body: { cmds: [{ id: queued.cmd.id, t: "prompt", text: "hi" }] } }]);
		assert.deepEqual([queued.cmd.state, queued.cmd.inst], ["delivered", "inew"]);
		// Should iold live on and poll, it's a stray: none at once.
		assert.deepEqual(pollAs(model, "iold").answers, [NO_CMDS]);
	});

	test("a current instance whose polls are held, or answered at once, stays current however long; once they stop, it stops counting 60 s after its last poll ended", () => {
		const { model, clock, events, view } = setup([reg(1, A, { status: "busy" })]);
		const inst = `i-${A}`;
		assert.deepEqual(helloAs(model, inst), OK);
		// Held polls: each runs out after its 20 s, and the mod polls again at once, for 10 minutes.
		let held = pollAs(model, inst);
		for (let i = 0; i < 30; i++) {
			clock.advance(20_000);
			assert.deepEqual(held.answers, [NO_CMDS]);
			held = pollAs(model, inst);
		}
		assert.equal(view(A)?.plugin, true, "after 10 minutes of held polls");
		// A turn ends while the registry says busy: its polls are answered at once, the mod's about once a second.
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(held.answers, [NO_CMDS], "answered at the turn's end");
		for (let i = 0; i < 59; i++) {
			assert.deepEqual(pollAs(model, inst).answers, [NO_CMDS]);
			clock.advance(1000);
		}
		// Polls with wait=0, answered at once, 50 s apart, for 10 minutes more: none is ever open, and none is 60 s late.
		for (let i = 0; i < 12; i++) {
			assert.deepEqual(pollAs(model, inst, "0").answers, [NO_CMDS]);
			clock.advance(50_000);
		}
		assert.equal(view(A)?.plugin, true, "after polls answered at once");
		// Then they stop. The last ended 50 s ago.
		clock.advance(9999);
		assert.equal(view(A)?.plugin, true, "1 ms before");
		clock.advance(1);
		assert.equal(view(A)?.plugin, false, "60 s after its last poll ended");
	});

	test("an instance made current has the full 60 s from its hello, whatever its predecessor's time without a poll: after a restart, and after it had stopped counting", () => {
		const { model, clock, view } = setup([reg(1, A, { status: "idle" })]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		clock.advance(59_000);
		assert.deepEqual(helloAs(model, "ib"), OK, "a restart, 59 s into ia's time without a poll");
		clock.advance(59_999);
		assert.equal(view(A)?.plugin, true, "ib's 60 s count from its hello");
		clock.advance(1);
		assert.equal(view(A)?.plugin, false);
		clock.advance(30_000);
		assert.deepEqual(helloAs(model, "ib"), OK, "current again");
		clock.advance(59_999);
		assert.equal(view(A)?.plugin, true, "the full 60 s again");
		clock.advance(1);
		assert.equal(view(A)?.plugin, false);
	});

	test("a stray's polls don't keep the current instance current: neither a replaced instance's, nor one's that never said hello", () => {
		const { model, clock, view } = setup([reg(1, A, { status: "idle" })]);
		assert.deepEqual(helloAs(model, "iold"), OK);
		assert.deepEqual(helloAs(model, "icur"), OK);
		const open = pollAs(model, "icur");
		clock.advance(5000);
		// The poll's client goes, and icur never polls again.
		open.close();
		assert.equal(model.commands.polling(A), false);
		// Strays poll every second all the while: the replaced instance, and one that never said hello to this deck.
		for (let i = 0; i < 59; i++) {
			assert.deepEqual(pollAs(model, i % 2 === 0 ? "iold" : "istray").answers, [NO_CMDS]);
			clock.advance(1000);
		}
		clock.advance(999);
		assert.equal(view(A)?.plugin, true);
		clock.advance(1);
		assert.equal(view(A)?.plugin, false, "60 s after icur's poll closed");
	});

	test("a hello said again isn't a poll: an instance that says hello again and again but polls no more stops counting 60 s after its last poll ended", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		const open = pollAs(model, "ia");
		clock.advance(5000);
		// The poll's client goes, and the mod says hello again every 10 s, as after a rejected fetch, but never polls.
		open.close();
		assert.equal(model.commands.polling(A), false);
		for (let s = 15; s <= 55; s += 10) {
			clock.advance(10_000);
			assert.deepEqual(helloAs(model, "ia"), OK, `the hello said again at ${s} s`);
			assert.equal(view(A)?.plugin, true, `${s} s`);
		}
		// The poll closed at 5 s, and the last hello said again was at 55 s: only the poll counts.
		clock.advance(9999);
		assert.equal(view(A)?.plugin, true, "1 ms before 60 s after the poll closed");
		clock.advance(1);
		assert.equal(view(A)?.plugin, false, "60 s after the poll closed, whatever hellos were said again since");
		assert.deepEqual(log.at("info").filter((l) => l.includes("UNPOLLED")), [`info ${UNPOLLED("ia")}`]);
		assert.deepEqual(pollAs(model, "ia").answers, [HELLO_FIRST], "its next poll asks for a hello");
	});

	test("once it has stopped counting, a press alerts, saying why; the deck keeps the session's settings, held requests, queued commands and seqs; the instance's hello makes it current again, not as a restart, with its cwd and model but not the mode and effort a PermissionRequest gave, and its poll takes the queued command", () => {
		const { model, clock, log, view, permission } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia", { mode: "default", effort: "low" }), OK);
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan", at: 1 }] }).status, 204);
		const request = permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		const n1 = pollAs(model, "ia");
		clock.advance(20_000);
		assert.deepEqual(n1.answers, [NO_CMDS], "the mod's last poll runs out, and it polls no more");
		clock.advance(30_000);
		const later = model.queue(A, { t: "prompt", text: "later" });
		assert.ok(later.ok, "queued while ia is still current");
		clock.advance(29_999);
		assert.equal(view(A)?.plugin, true);
		clock.advance(1);
		assert.equal(view(A)?.plugin, false, "60 s after its last poll ended");
		// Kept: the held request, the queued command, the settings, the seqs.
		assert.deepEqual([request.answers, model.held.size, view(A)?.status], [[], 1, "approval"]);
		assert.equal(later.cmd.state, "queued");
		assert.deepEqual([view(A)?.mode, view(A)?.effort], ["acceptEdits", "high"]);
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "auto", at: 1 }] }).status, 204);
		assert.equal(view(A)?.mode, "acceptEdits", "a retry of seq 1 is still dropped");
		// A press alerts, saying why, and queues nothing.
		assert.deepEqual(model.queue(A, { t: "prompt", text: "now" }), { ok: false, why: `"Session 1"'s mod has had no poll open for 60 s, so it can't take commands until it says hello again` });
		assert.equal(model.commands.list().length, 1);
		// The mod's next poll asks for a hello, and its hello makes it current again: not a restart. It gives its model,
		// but not its mode and effort, since the deck's came from a PermissionRequest (PROTOCOL.md, The deck's session
		// model).
		assert.deepEqual(pollAs(model, "ia").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "ia", { cwd: "/p/back", model: "claude-opus-5-5", mode: "auto", effort: "max" }), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.model, view(A)?.mode, view(A)?.effort], [true, "claude-opus-5-5", "acceptEdits", "high"]);
		assert.ok(!log.lines.some((l) => l.message.startsWith("RESTART")));
		const n2 = pollAs(model, "ia");
		assert.deepEqual(n2.answers, [{ status: 200, body: { cmds: [{ id: later.cmd.id, t: "prompt", text: "later" }] } }]);
		assert.deepEqual([later.cmd.state, later.cmd.inst], ["delivered", "ia"]);
		assert.deepEqual(request.answers, [], "still held");
	});

	test("the session shows without the plugin from the moment its instance stops counting until a hello makes one current; its status stays what the registry and the bridge say", () => {
		const { model, clock, view } = setup([reg(1, A, { status: "busy" }), reg(2, B)]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.status], [true, "working"]);
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual([view(A)?.plugin, view(A)?.status], [false, "working"]);
		// Its mod's events are still taken, and a poll isn't a hello.
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "measure", context: { percent: 40, window: 1 }, at: 1 }] }).status, 204);
		assert.deepEqual(pollAs(model, "ia").answers, [HELLO_FIRST]);
		assert.deepEqual([view(A)?.plugin, view(A)?.context], [false, 40]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.status, view(A)?.context], [true, "working", 40]);
		assert.equal(view(B)?.plugin, false, "B never had a mod");
	});

	test("the session's waiting prompts fail with 'no result' at the very moment its instance stops counting: one timer does both", () => {
		const { model, clock, view } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		const queued = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(queued.ok);
		assert.equal(pollAs(model, "ia").answers.length, 1, "taken by a poll answered at once");
		assert.equal(model.result({ host: A, inst: "ia", id: queued.cmd.id, state: "waiting" }).status, 204);
		// The mod polls no more.
		const seen: string[] = [];
		model.onChange(() => seen.push(`${queued.cmd.state} ${String(view(A)?.plugin)}`));
		clock.advance(IN_FLIGHT_MS - 1);
		assert.deepEqual([queued.cmd.state, view(A)?.plugin, seen], ["waiting", true, []]);
		clock.advance(1);
		assert.deepEqual([queued.cmd.state, queued.cmd.error, view(A)?.plugin], ["failed", "no result", false]);
		assert.equal(seen[0], "failed false", "the first repaint after it already shows both");
	});

	test("one UNPOLLED line at info for the moment, when a waiting prompt fails at it too: the queue's goes at debug, and the prompt's failure at info", () => {
		const { model, clock, log } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		const queued = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(queued.ok);
		assert.equal(pollAs(model, "ia").answers.length, 1, "taken by a poll answered at once");
		assert.equal(model.result({ host: A, inst: "ia", id: queued.cmd.id, state: "waiting" }).status, 204);
		const from = log.lines.length;
		clock.advance(IN_FLIGHT_MS);
		const lines = log.lines.slice(from).map((l) => `${l.level} ${l.message}`);
		assert.deepEqual(
			lines.filter((l) => l.includes("UNPOLLED")),
			[`debug UNPOLLED ${A}: no open poll for 60 s, so its waiting prompts fail`, `info ${UNPOLLED("ia")}`],
		);
		assert.deepEqual(
			lines.filter((l) => l.startsWith("info ")),
			[`info FAILED ${queued.cmd.id} for ${A}: no result`, `info ${UNPOLLED("ia")}`],
		);
	});

	test("the moment keeps the session's current tool: what it's doing stays, through the hello that makes its instance current again", () => {
		const { model, clock, view } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		const events = [
			{ t: "turn.start", turn: "t1", at: 1 },
			{ t: "tool.start", tool: "Bash", use: "u1", summary: "make", fp: "11111111", at: 1 },
		];
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events }).status, 204);
		assert.deepEqual([view(A)?.status, view(A)?.doing], ["working", "make"]);
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual([view(A)?.plugin, view(A)?.status, view(A)?.doing], [false, "working", "make"]);
		assert.deepEqual(pollAs(model, "ia").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.status, view(A)?.doing], [true, "working", "make"]);
	});

	test("the limit is the model's inFlightMs, which tests can shorten", () => {
		const clock = new FakeClock();
		const model = new SessionModel({ clock, wallNow: () => 10_000, inFlightMs: 5000 });
		model.setRegistry([reg(1, A)]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		clock.advance(4999);
		assert.equal(model.session(A)?.plugin, true);
		clock.advance(1);
		assert.equal(model.session(A)?.plugin, false);
		assert.deepEqual(model.queue(A, { t: "prompt", text: "x" }), { ok: false, why: `"Session 1"'s mod has had no poll open for 5 s, so it can't take commands until it says hello again` });
		model.dispose();
	});

	test("a spare that went before it was claimed stops counting just the same, logged at debug, since the registry doesn't list it", () => {
		const { model, clock, log } = setup([reg(1, A)]);
		const spare = "local_spare";
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-9", host: spare, inst: "ispare", model: "m" })), OK);
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual(
			log.lines.filter((l) => l.message.startsWith(`UNPOLLED ${spare}`)).map((l) => l.level),
			["debug"],
		);
		const poll = new FakeReply();
		model.next(new URLSearchParams({ sid: "sid-9", host: spare, inst: "ispare", wait: "20" }), poll);
		assert.deepEqual(poll.answers, [HELLO_FIRST]);
	});
});

describe("the current instance's hello, said again (PROTOCOL.md, Identity; Phase 6)", () => {
	test("takes its cwd and model, never its mode or effort, which can be older than a PermissionRequest's the deck took since; logged at debug", () => {
		const { model, view, permission, log } = setup([reg(1, A, { status: "busy", name: null, cwd: null })]);
		const hello = (fields: Record<string, unknown>): RouteAnswer => now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", ...fields }));
		const shown = (): unknown[] => [view(A)?.title, view(A)?.model, view(A)?.mode, view(A)?.effort];
		assert.deepEqual(hello({ cwd: "/p/first", model: "claude-haiku-5-5", mode: "default", effort: "low" }), OK);
		assert.deepEqual(shown(), ["first", "claude-haiku-5-5", "default", "low"], "the hello that makes it current takes all four");
		// A PermissionRequest brings the session's newer mode and effort, and the Deny that answers it rejects a fetch of
		// the mod's, which then says hello again with the mode and effort it had sent before, and a new model and cwd.
		permission(A, "Bash", { command: "rm -rf build" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		assert.deepEqual([view(A)?.mode, view(A)?.effort], ["acceptEdits", "high"]);
		assert.equal(model.held.press(model.held.oldest?.id ?? null, "deny").ok, true);
		assert.deepEqual(hello({ cwd: "/p/second", model: "claude-opus-5-5", mode: "default", effort: "low" }), OK);
		assert.deepEqual(shown(), ["second", "claude-opus-5-5", "acceptEdits", "high"]);
		// One without a model or cwd changes nothing.
		assert.deepEqual(hello({ mode: "plan" }), OK);
		assert.deepEqual(shown(), ["second", "claude-opus-5-5", "acceptEdits", "high"]);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("HELLO")),
			[`info HELLO ${A} inst "ia" plugin none cc none`],
		);
		assert.equal(log.lines.filter((l) => l.level === "debug" && l.message === `HELLO ${A} inst "ia" again: its cwd and model taken, its mode and effort not`).length, 2);
	});

	test("gives neither its mode nor its effort when the deck took them from a settings event, or has taken none yet, even newer ones its mod has queued as settings: the settings event gives them when it lands", () => {
		const { model, view } = setup([reg(1, A, { status: "busy", name: null, cwd: null })]);
		model.setRecords(new Map([[A, record(A, { permissionMode: "default", effort: "low" })]]));
		const hello = (fields: Record<string, unknown>): RouteAnswer => now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", ...fields }));
		const shown = (): unknown[] => [view(A)?.title, view(A)?.model, view(A)?.mode, view(A)?.effort];
		let seq = 0;
		const settings = (fields: Record<string, unknown>): void => {
			assert.equal(model.events({ host: A, inst: "ia", seq: ++seq, events: [{ t: "settings", at: 1, ...fields }] }).status, 204);
		};
		// A mod that hasn't seen a mode or effort leaves them out of its hello: the deck shows the app's record's.
		assert.deepEqual(hello({ cwd: "/p/first", model: "claude-haiku-5-5" }), OK);
		assert.deepEqual(shown(), ["first", "claude-haiku-5-5", "default", "low"]);
		// It sees plan and max and queues them as settings; a fetch rejects, and its hello said again, with them, comes
		// first. The deck has taken no mode or effort yet, and takes neither from this hello.
		assert.deepEqual(hello({ cwd: "/p/second", model: "claude-opus-5-5", mode: "plan", effort: "max" }), OK);
		assert.deepEqual(shown(), ["second", "claude-opus-5-5", "default", "low"], "none taken yet: the record's stay");
		settings({ mode: "plan", effort: "max" });
		assert.deepEqual(shown(), ["second", "claude-opus-5-5", "plan", "max"], "the settings event's");
		// The same once the deck's came from a settings event.
		assert.deepEqual(hello({ model: "claude-haiku-5-5", mode: "acceptEdits", effort: "high" }), OK);
		assert.deepEqual(shown(), ["second", "claude-haiku-5-5", "plan", "max"], "a settings event's stay");
		settings({ mode: "acceptEdits", effort: "high" });
		assert.deepEqual(shown(), ["second", "claude-haiku-5-5", "acceptEdits", "high"]);
	});

	test("with nothing from a PermissionRequest, a hello that makes an instance current takes all four, in place of a settings event's too: a first one, a restart's, and one after the current instance stopped counting", () => {
		const { model, clock, view } = setup([reg(1, A, { status: "busy", name: null, cwd: null })]);
		const hello = (inst: string, fields: Record<string, unknown>): RouteAnswer => now(model.hello({ v: 1, sid: "sid-1", host: A, inst, ...fields }));
		const shown = (): unknown[] => [view(A)?.title, view(A)?.model, view(A)?.mode, view(A)?.effort];
		assert.deepEqual(hello("ia", { cwd: "/p/one", model: "claude-haiku-5-5", mode: "default", effort: "low" }), OK);
		assert.deepEqual(shown(), ["one", "claude-haiku-5-5", "default", "low"]);
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "acceptEdits", effort: "medium", at: 1 }] }).status, 204);
		assert.deepEqual(shown(), ["one", "claude-haiku-5-5", "acceptEdits", "medium"]);
		assert.deepEqual(hello("ib", { cwd: "/p/two", model: "claude-opus-5-5", mode: "plan", effort: "max" }), OK);
		assert.deepEqual(shown(), ["two", "claude-opus-5-5", "plan", "max"], "a restart's");
		clock.advance(IN_FLIGHT_MS);
		assert.equal(view(A)?.plugin, false);
		assert.deepEqual(hello("ib", { cwd: "/p/three", model: "claude-haiku-5-5", mode: "auto", effort: "medium" }), OK);
		assert.deepEqual(shown(), ["three", "claude-haiku-5-5", "auto", "medium"], "after it stopped counting, ib's hello makes it current again");
	});
});

describe("while no instance is current, any instance's hello makes it current (PROTOCOL.md, Identity; Phase 6, round 4)", () => {
	test("the flip-flop: two live mods after a deck restart; once the live one's hello has made it current again, its predecessor's later hello changes nothing: no restart, its prompt isn't failed, and its held poll stays open and takes the next command", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "idle" })]);
		// The deck has just restarted. Each mod's next poll asks for a hello, and the predecessor's lands last: a restart.
		assert.deepEqual(pollAs(model, "inew").answers, [HELLO_FIRST]);
		assert.deepEqual(pollAs(model, "iold").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual(helloAs(model, "iold"), OK);
		assert.equal(restartsIn(log).length, 1);
		// iold polls no more. 60 s on it's no longer current, inew's next poll asks for a hello, and inew's hello makes it
		// current: not a restart, since none was.
		clock.advance(IN_FLIGHT_MS);
		assert.equal(view(A)?.plugin, false);
		assert.deepEqual(pollAs(model, "inew").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual([view(A)?.plugin, restartsIn(log).length], [true, 1]);
		// A prompt is delivered to inew, which waits with it, and inew's next poll is held.
		const first = model.queue(A, { t: "prompt", text: "one" });
		assert.ok(first.ok, JSON.stringify(first));
		assert.deepEqual(pollAs(model, "inew").answers, [{ status: 200, body: { cmds: [{ id: first.cmd.id, t: "prompt", text: "one" }] } }]);
		assert.equal(model.result({ host: A, inst: "inew", id: first.cmd.id, state: "waiting" }).status, 204);
		const held = pollAs(model, "inew");
		assert.deepEqual(held.answers, []);
		// iold says hello once more, as after one of its fetches rejects: it said hello before, so it changes nothing.
		assert.deepEqual(helloAs(model, "iold", { mode: "plan", effort: "max" }), OK);
		assert.equal(restartsIn(log).length, 1, "no RESTART line");
		assert.deepEqual([first.cmd.state, first.cmd.error], ["waiting", null], "inew's prompt isn't failed");
		assert.deepEqual([held.answers, model.commands.polling(A)], [[], true], "inew's held poll stays open");
		assert.deepEqual([view(A)?.plugin, view(A)?.mode, view(A)?.effort], [true, null, null], "nor are iold's settings taken");
		assert.ok(log.at("info").includes(`info HELLO ${A} inst "iold", which said hello before: taken, but not the current instance, which stays "inew"`));
		// inew's held poll takes the next command, and iold's polls get none at once.
		const second = model.queue(A, { t: "prompt", text: "two" });
		assert.ok(second.ok, JSON.stringify(second));
		assert.deepEqual(held.answers, [{ status: 200, body: { cmds: [{ id: second.cmd.id, t: "prompt", text: "two" }] } }]);
		assert.deepEqual([second.cmd.state, second.cmd.inst], ["delivered", "inew"]);
		assert.deepEqual(pollAs(model, "iold").answers, [NO_CMDS]);
	});

	test("a lone mod that goes 60 s without a poll, its process suspended, say, is made current again by its own hello: not a restart, and the session's current tool, queued command and settings stay", () => {
		const { model, clock, log, view, permission } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia", { mode: "default", effort: "low" }), OK);
		const events = [
			{ t: "turn.start", turn: "t1", at: 1 },
			{ t: "tool.start", tool: "Bash", use: "u1", summary: "make", fp: "11111111", at: 1 },
		];
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events }).status, 204);
		const request = permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		// Its poll is held, until the process is suspended 5 s on: the poll's client goes, and the mod polls no more.
		const open = pollAs(model, "ia");
		clock.advance(5000);
		open.close();
		clock.advance(25_000);
		const later = model.queue(A, { t: "prompt", text: "later" });
		assert.ok(later.ok, "queued while ia is still current");
		clock.advance(35_000);
		assert.deepEqual([view(A)?.plugin, view(A)?.doing, later.cmd.state, request.answers], [false, "make", "queued", []]);
		// The process resumes 10 s later: its poll gets 409, and its hello makes it current again.
		clock.advance(10_000);
		assert.deepEqual(pollAs(model, "ia").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "ia", { model: "claude-opus-5-5", mode: "default", effort: "low" }), OK);
		assert.deepEqual(restartsIn(log), []);
		assert.deepEqual([view(A)?.plugin, view(A)?.doing, view(A)?.model, view(A)?.mode, view(A)?.effort], [true, "make", "claude-opus-5-5", "acceptEdits", "high"]);
		// Its poll takes the queued command, and the PermissionRequest is still held.
		assert.deepEqual(pollAs(model, "ia").answers, [{ status: 200, body: { cmds: [{ id: later.cmd.id, t: "prompt", text: "later" }] } }]);
		assert.deepEqual([later.cmd.state, later.cmd.inst, request.answers, model.held.size], ["delivered", "ia", [], 1]);
	});

	test("while none is current, the predecessor's hello landing first makes it current, not as a restart; the live mod is then a stray, whose polls get none at once and whose hello changes nothing, until the predecessor has gone 60 s without a poll again", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "idle" })]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual(helloAs(model, "iold"), OK);
		clock.advance(IN_FLIGHT_MS);
		assert.equal(view(A)?.plugin, false);
		// iold's hello lands first, as after one of its fetches rejects: it's current again, and that isn't a restart.
		assert.deepEqual(helloAs(model, "iold"), OK);
		assert.deepEqual([view(A)?.plugin, restartsIn(log).length], [true, 1]);
		// inew is a stray: its poll gets none at once, and its hello, from an instance that said hello before, changes nothing.
		assert.deepEqual(pollAs(model, "inew").answers, [NO_CMDS]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.equal(restartsIn(log).length, 1);
		assert.ok(log.at("info").includes(`info HELLO ${A} inst "inew", which said hello before: taken, but not the current instance, which stays "iold"`));
		// Its polls don't keep iold current: 60 s after iold's hello, inew's next poll asks for a hello, which makes it current.
		clock.advance(IN_FLIGHT_MS - 1);
		assert.deepEqual(pollAs(model, "inew").answers, [NO_CMDS], "1 ms before iold's 60 s");
		clock.advance(1);
		assert.deepEqual(pollAs(model, "inew").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual([view(A)?.plugin, restartsIn(log).length], [true, 1]);
		assert.deepEqual(pollAs(model, "inew").answers, [], "inew's poll is held");
	});

	test("the moment keeps which instances said hello: once a hello makes one current again, every other listed one's changes nothing, and only an unlisted one's is a restart; the 409 meanwhile says no instance has said hello since", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "idle" })]);
		for (const inst of ["i0", "i1", "i2"]) assert.deepEqual(helloAs(model, inst), OK, inst);
		assert.equal(restartsIn(log).length, 2);
		clock.advance(IN_FLIGHT_MS);
		assert.equal(view(A)?.plugin, false);
		assert.ok(log.at("info").includes(`info ${UNPOLLED("i2")}`));
		assert.deepEqual(pollAs(model, "i1").answers, [HELLO_FIRST]);
		assert.deepEqual(
			log.at("info").filter((l) => l.includes("HELLO FIRST")),
			[`info HELLO FIRST ${A}: mod instance "i1" polls, but no instance has said hello since "i2", which was current, stopped polling, so the deck answers 409 to ask for one`],
		);
		assert.deepEqual(helloAs(model, "i1"), OK);
		assert.equal(restartsIn(log).length, 2, "i1 is current again: not a restart");
		const held = pollAs(model, "i1");
		for (const inst of ["i0", "i2"]) assert.deepEqual(helloAs(model, inst), OK, inst);
		assert.deepEqual([restartsIn(log).length, held.answers], [2, []], "i0's and i2's hellos change nothing: i1 stays current");
		assert.deepEqual(helloAs(model, "i3"), OK);
		assert.deepEqual(restartsIn(log).slice(2), [`RESTART ${A}: mod instance "i3" replaces "i1"; its current tool and in-flight commands are forgotten, and any poll the old one left open is answered`]);
		assert.deepEqual(held.answers, [NO_CMDS], "i1's poll, answered at the restart");
	});

	test("an unlisted instance's hello while none is current isn't a restart either: the current tool and a queued command stay; from then on a listed one's hello changes nothing", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia"), OK);
		const events = [
			{ t: "turn.start", turn: "t1", at: 1 },
			{ t: "tool.start", tool: "Bash", use: "u1", summary: "make", fp: "11111111", at: 1 },
		];
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events }).status, 204);
		clock.advance(30_000);
		const queued = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(queued.ok);
		clock.advance(30_000);
		assert.deepEqual([view(A)?.plugin, view(A)?.doing, queued.cmd.state], [false, "make", "queued"]);
		// A new instance that never said hello, as after a hot reload while none was current: current, and no restart.
		assert.deepEqual(helloAs(model, "ib"), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.doing, queued.cmd.state, restartsIn(log)], [true, "make", "queued", []]);
		assert.deepEqual(pollAs(model, "ib").answers, [{ status: 200, body: { cmds: [{ id: queued.cmd.id, t: "prompt", text: "hi" }] } }]);
		// ia, listed, doesn't count now that ib is current.
		assert.deepEqual(helloAs(model, "ia"), OK);
		assert.deepEqual([restartsIn(log), queued.cmd.state, pollAs(model, "ia").answers], [[], "delivered", [NO_CMDS]]);
	});

	test("an instance made current again moves to the newest place among those that said hello: the list forgets its oldest first, and not it", () => {
		const { model, clock, log } = setup([reg(1, A, { status: "idle" })]);
		for (let i = 0; i < HELLOS_KEPT; i++) assert.deepEqual(helloAs(model, `i${i}`), OK);
		// i0 is the oldest of the HELLOS_KEPT listed, and the last is current until it stops counting. Then i0's hello
		// makes i0 current again, which moves it to the newest place.
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual(helloAs(model, "i0"), OK);
		const restarts = restartsIn(log).length;
		// A new instance's hello: a restart, after which the list, one over, forgets its oldest, i1.
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.equal(restartsIn(log).length, restarts + 1);
		assert.deepEqual(helloAs(model, "i0"), OK);
		assert.deepEqual(helloAs(model, "i2"), OK);
		assert.equal(restartsIn(log).length, restarts + 1, "i0 and i2 are still listed: their hellos change nothing");
		assert.deepEqual(helloAs(model, "i1"), OK);
		assert.deepEqual(restartsIn(log).slice(restarts + 1), [`RESTART ${A}: mod instance "i1" replaces "inew"; its current tool and in-flight commands are forgotten, and any poll the old one left open is answered`], "i1 was forgotten");
	});
});

describe("no hello replaces a mode or effort the deck took from a PermissionRequest (PROTOCOL.md, The deck's session model; Phase 6, round 4)", () => {
	const shown = (model: SessionModel): unknown[] => [model.session(A)?.mode, model.session(A)?.effort];

	test("after the 60 s: a PermissionRequest 1 s before the current instance stops counting brings acceptEdits and high, and the hello that then makes the live mod current, with default and low, leaves them", () => {
		const { model, clock, log, view, permission } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "inew", { mode: "default", effort: "low" }), OK);
		assert.deepEqual(helloAs(model, "iold", { mode: "default", effort: "low" }), OK);
		clock.advance(IN_FLIGHT_MS - 1000);
		permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		assert.deepEqual(shown(model), ["acceptEdits", "high"]);
		clock.advance(1000);
		assert.equal(view(A)?.plugin, false);
		assert.deepEqual(pollAs(model, "inew").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "inew", { model: "claude-opus-5-5", mode: "default", effort: "low" }), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.model, ...shown(model)], [true, "claude-opus-5-5", "acceptEdits", "high"]);
		assert.ok(log.at("info").includes(`info HELLO ${A} inst "inew" plugin none cc none; its mode and effort not taken, as the deck's came from a PermissionRequest`), log.at("info").join("\n"));
	});

	test("after a deck restart: a PermissionRequest that comes before the mod's first hello keeps its mode and effort against that hello", () => {
		const { model, view, permission } = setup([reg(1, A, { status: "busy" })]);
		model.setRecords(new Map([[A, record(A, { permissionMode: "default", effort: "low" })]]));
		permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		assert.deepEqual([view(A)?.plugin, ...shown(model)], [false, "acceptEdits", "high"], "the PermissionRequest's, over the app's record");
		assert.deepEqual(pollAs(model, "ia").answers, [HELLO_FIRST]);
		assert.deepEqual(helloAs(model, "ia", { model: "claude-opus-5-5", mode: "default", effort: "low" }), OK);
		assert.deepEqual([view(A)?.plugin, view(A)?.model, ...shown(model)], [true, "claude-opus-5-5", "acceptEdits", "high"]);
	});

	test("each field goes by where the deck last took it from: with the mode from a PermissionRequest and the effort from a settings event, a hello that makes an instance current gives the effort and not the mode; and the other way round", () => {
		const { model, clock, log, permission } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia", { mode: "default", effort: "low" }), OK);
		permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", effort: "max", at: 1 }] }).status, 204);
		assert.deepEqual(shown(model), ["acceptEdits", "max"]);
		// A restart's hello.
		assert.deepEqual(helloAs(model, "ib", { mode: "plan", effort: "medium" }), OK);
		assert.deepEqual(shown(model), ["acceptEdits", "medium"]);
		assert.ok(log.at("info").includes(`info HELLO ${A} inst "ib" plugin none cc none; its mode not taken, as the deck's came from a PermissionRequest`), log.at("info").join("\n"));
		// The other way round: the effort from a PermissionRequest, the mode from a settings event; and the hello that makes
		// ib current again once it has stopped counting.
		permission(A, "Bash", { command: "make test" }, { permission_mode: "default", effort: { level: "high" } });
		assert.equal(model.events({ host: A, inst: "ib", seq: 1, events: [{ t: "settings", mode: "auto", at: 1 }] }).status, 204);
		assert.deepEqual(shown(model), ["auto", "high"]);
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual(helloAs(model, "ib", { mode: "plan", effort: "low" }), OK);
		assert.deepEqual(shown(model), ["plan", "high"]);
		assert.ok(log.at("info").includes(`info HELLO ${A} inst "ib" plugin none cc none; its effort not taken, as the deck's came from a PermissionRequest`), log.at("info").join("\n"));
	});

	test("a settings event after the PermissionRequest replaces its mode and effort, which a hello may then replace; a later PermissionRequest replaces them too, and holds against a hello in turn", () => {
		const { model, clock, permission } = setup([reg(1, A, { status: "busy" })]);
		assert.deepEqual(helloAs(model, "ia", { mode: "default", effort: "low" }), OK);
		permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		assert.equal(model.events({ host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan", effort: "max", at: 1 }] }).status, 204);
		assert.deepEqual(shown(model), ["plan", "max"], "the settings event's");
		assert.deepEqual(helloAs(model, "ib", { mode: "auto", effort: "medium" }), OK);
		assert.deepEqual(shown(model), ["auto", "medium"], "a restart's hello, in place of the settings event's");
		permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		permission(A, "Bash", { command: "make test" }, { permission_mode: "plan", effort: { level: "low" } });
		assert.deepEqual(shown(model), ["plan", "low"], "the later PermissionRequest's");
		clock.advance(IN_FLIGHT_MS);
		assert.deepEqual(helloAs(model, "ib", { mode: "auto", effort: "medium" }), OK);
		assert.deepEqual(shown(model), ["plan", "low"], "kept against the hello that makes ib current again");
	});

	test("a PermissionRequest whose mode and effort equal those shown is still where the deck took them from: after the 60 s, the predecessor's hello that makes it current again, with the older default and low, leaves them", () => {
		const { model, clock, log, view, permission } = setup([reg(1, A, { status: "busy" })]);
		// After a deck restart, two live mods: the live one's hello, then the predecessor's, a restart, with the default
		// and low it had seen.
		assert.deepEqual(helloAs(model, "inew"), OK);
		assert.deepEqual(helloAs(model, "iold", { mode: "default", effort: "low" }), OK);
		assert.equal(restartsIn(log).length, 1);
		// The live mod's settings event, taken though it's a stray, and then a PermissionRequest, the engine's own, with
		// the same mode and effort.
		assert.equal(model.events({ host: A, inst: "inew", seq: 1, events: [{ t: "settings", mode: "acceptEdits", effort: "high", at: 1 }] }).status, 204);
		assert.deepEqual(shown(model), ["acceptEdits", "high"]);
		permission(A, "Bash", { command: "make" }, { permission_mode: "acceptEdits", effort: { level: "high" } });
		assert.deepEqual(shown(model), ["acceptEdits", "high"]);
		// The predecessor polls no more, and 60 s on it's no longer current. Its hello lands first, as after one of its
		// fetches rejects, and makes it current again with its older mode and effort, which aren't taken.
		clock.advance(IN_FLIGHT_MS);
		assert.equal(view(A)?.plugin, false);
		assert.deepEqual(helloAs(model, "iold", { mode: "default", effort: "low" }), OK);
		assert.deepEqual([view(A)?.plugin, ...shown(model)], [true, "acceptEdits", "high"]);
		assert.ok(log.at("info").includes(`info HELLO ${A} inst "iold" plugin none cc none; its mode and effort not taken, as the deck's came from a PermissionRequest`), log.at("info").join("\n"));
	});
});

describe("quiet logs (Phase 6)", () => {
	test("refused hellos and unconfirmed hook requests: the first per route and reason at info, then at most one line in 10 minutes, with the count since; the rest at debug", () => {
		const { model, clock, log } = setup();
		const child = (i: number) => {
			model.permission({ session_id: "sid-child", tool_name: "Bash", tool_input: { command: `echo ${i}` } }, A, new FakeReply());
			model.hello({ v: 1, sid: "sid-child", host: A, inst: `ichild${i}` });
		};
		for (let i = 0; i < 50; i++) child(i);
		const info = (): string[] => log.at("info").filter((l) => l.includes("UNCONFIRMED") || l.includes("409"));
		assert.deepEqual(info(), [
			`info UNCONFIRMED /v1/permission from ${A} sid "sid-child": the registry lists that host under another session id, so no decision`,
			`info HELLO refused with 409 for ${A} inst "ichild0" sid "sid-child": the registry lists that host under another session id`,
		]);
		assert.equal(log.lines.filter((l) => l.level === "debug" && (l.message.includes("UNCONFIRMED") || l.message.includes("409"))).length, 2 * 49);
		clock.advance(QUIET_MS - 1);
		child(50);
		assert.equal(info().length, 2);
		clock.advance(1);
		child(51);
		child(52);
		assert.deepEqual(info().slice(2), [
			`info UNCONFIRMED /v1/permission from ${A} sid "sid-child": the registry lists that host under another session id, so no decision; 50 more like it, at debug, in the 10 min since the last at info`,
			`info HELLO refused with 409 for ${A} inst "ichild51" sid "sid-child": the registry lists that host under another session id; 50 more like it, at debug, in the 10 min since the last at info`,
		]);
	});

	test("the deck asks a mod it has no hello from for one, as after a restart in the mod's second between polls, or a registry reading without the session: each poll's 409 at info, then quietly, afresh after a hello or the session's end; events and results only at debug; a press says why it's refused", () => {
		const { model, clock, log, view } = setup([reg(1, A, { status: "busy" }), reg(2, B)]);
		const ASKED = `HELLO FIRST ${A}: mod instance "ia" polls, but no instance has said hello to this deck for the session, so the deck answers 409 to ask for one`;
		const asked = (): string[] => log.at("info").filter((l) => l.includes("HELLO FIRST") || l.includes("NO HELLO"));
		const poll = (inst = "ia"): FakeReply => {
			const reply = new FakeReply();
			model.next(new URLSearchParams({ sid: "sid-1", host: A, inst, wait: "20" }), reply);
			return reply;
		};
		// A deck that started while A's mod waited out its second between polls: nothing of the mod's failed, so its
		// next poll is the first the deck hears, and the deck asks for a hello.
		assert.deepEqual(poll().answers, [HELLO_FIRST]);
		assert.deepEqual(asked(), [`info ${ASKED}`]);
		// Should no hello come, as from a mod that only retries its poll: the rest at debug, whichever instance polls,
		// since the quiet key is the session's.
		for (let i = 0; i < 59; i++) assert.deepEqual(poll(i % 2 === 0 ? "ia" : "ib").answers, [HELLO_FIRST]);
		assert.equal(log.lines.filter((l) => l.level === "debug" && l.message.startsWith(`HELLO FIRST ${A}: mod instance `)).length, 59);
		// Its events and results are taken, logged only at debug, and counted with none of that.
		assert.equal(model.events({ sid: "sid-1", host: A, inst: "ia", seq: 1, events: [{ t: "settings", mode: "plan", at: 1 }] }).status, 204);
		assert.equal(model.result({ sid: "sid-1", host: A, inst: "ia", id: "c9", state: "done" }).status, 204);
		assert.deepEqual(
			log.lines.filter((l) => l.message.startsWith("NO HELLO")).map((l) => `${l.level} ${l.message}`),
			[
				`debug NO HELLO ${A}: mod instance "ia" sends events, but no instance has said hello to this deck for the session; taken all the same`,
				`debug NO HELLO ${A}: mod instance "ia" sends a result, but no instance has said hello to this deck for the session; taken all the same`,
			],
		);
		assert.deepEqual([asked().length, view(A)?.plugin, view(A)?.mode], [1, false, "plan"]);
		// A press names the missing hello. B's mod has never talked: no plugin.
		assert.deepEqual(model.queue(A, { t: "prompt", text: "hi" }), { ok: false, why: `"Session 1"'s mod hasn't said hello to this deck, so it can't take commands until it does` });
		assert.deepEqual(model.queue(B, { t: "prompt", text: "hi" }), { ok: false, why: '"Session 2" doesn\'t have the plugin' });
		// Still so 10 minutes on: one line at info, with the count of polls since.
		clock.advance(QUIET_MS);
		poll();
		assert.deepEqual(asked().slice(1), [`info ${ASKED}; 59 more like it, at debug, in the 10 min since the last at info`]);
		// Its hello, when it comes: current, its poll held, a press delivered, and its requests no longer logged so.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia", model: "m" })), OK);
		assert.equal(model.events({ sid: "sid-1", host: A, inst: "ia", seq: 2, events: [{ t: "settings", mode: "default", at: 1 }] }).status, 204);
		assert.equal(model.result({ sid: "sid-1", host: A, inst: "ia", id: "c9", state: "done" }).status, 204);
		assert.equal(log.lines.filter((l) => l.message.startsWith("NO HELLO") || l.message.startsWith("HELLO FIRST")).length, 63);
		const held = poll();
		const cmd = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(cmd.ok);
		assert.deepEqual(held.answers, [{ status: 200, body: { cmds: [{ id: cmd.cmd.id, t: "prompt", text: "hi" }] } }]);
		const open = poll();
		// One registry reading without A: the deck forgets it and answers its poll (release rule 4). Its next poll asks
		// for a hello again, at info at once: the hello started the quiet count afresh.
		model.setRegistry([reg(2, B)]);
		model.setRegistry([reg(1, A, { status: "busy" }), reg(2, B)]);
		assert.deepEqual(open.answers, [NO_CMDS]);
		assert.deepEqual(poll().answers, [HELLO_FIRST]);
		assert.deepEqual(asked().slice(2), [`info ${ASKED}`]);
		assert.equal(view(A)?.plugin, false);
		// So does a session that ends while its mod is asked: with no hello since, its next 409 is at info too.
		model.setRegistry([reg(2, B)]);
		model.setRegistry([reg(1, A, { status: "busy" }), reg(2, B)]);
		assert.deepEqual(poll().answers, [HELLO_FIRST]);
		assert.deepEqual(asked().slice(3), [`info ${ASKED}`]);
		// A stray poll while an instance is current isn't this: none at once, and only at debug.
		assert.deepEqual(now(model.hello({ v: 1, sid: "sid-1", host: A, inst: "ia2", model: "m" })), OK);
		assert.deepEqual([poll("istale").answers, asked().length], [[NO_CMDS], 4]);
		// Nor is a session the registry doesn't list, which takes no presses: one ending, say, whose mod polled once more.
		const ending = new FakeReply();
		model.next(new URLSearchParams({ sid: "sid-5", host: "local_e", inst: "ie", wait: "20" }), ending);
		assert.deepEqual([ending.answers, asked().length], [[HELLO_FIRST], 4]);
		assert.ok(log.lines.some((l) => l.level === "debug" && l.message === `HELLO FIRST local_e: mod instance "ie" polls, but no instance has said hello to this deck for the session, so the deck answers 409 to ask for one; the registry doesn't list it`));
	});

	test("a command's delivery and its waiting go at debug, as each poll and event does; its being queued, and how it ended, at info", () => {
		const { model, log, poll } = setup([reg(1, A, { status: "busy" })]);
		const n1 = poll(A);
		const queued = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(queued.ok);
		assert.equal(n1.answers.length, 1);
		const id = queued.cmd.id;
		assert.equal(model.result({ host: A, inst: `i-${A}`, id, state: "waiting" }).status, 204);
		assert.equal(model.result({ host: A, inst: `i-${A}`, id, state: "done" }).status, 204);
		assert.deepEqual(
			log.lines.filter((l) => /^(QUEUED|DELIVERED|RESULT) /.test(l.message)).map((l) => `${l.level} ${l.message}`),
			[`info QUEUED ${id} prompt (2 characters) for ${A}`, `debug DELIVERED ${id} to ${A}`, `debug RESULT ${id} waiting`, `info RESULT ${id} done`],
		);
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

describe("what a change costs (hardening.md, B2)", () => {
	test("a poll changes nothing a view or a key reads, so it emits nothing: a held one, one that replaces it, a stray's, a 409, or one answered at once after a turn; the command a poll takes repaints through the queue", () => {
		const { model, events, poll } = setup([reg(1, A, { status: "busy" }), reg(2, B)]);
		const first = poll(A);
		let changes = 0;
		model.onChange(() => changes++);
		resetIdleCounts();
		const second = poll(A);
		assert.deepEqual(first.answers, [NO_CMDS], "the older poll, answered with none");
		const stray = new FakeReply();
		model.next(new URLSearchParams({ host: A, inst: "i-old", wait: "20" }), stray);
		assert.deepEqual(stray.answers, [NO_CMDS]);
		const unknown = new FakeReply();
		model.next(new URLSearchParams({ host: B, inst: "i-b", wait: "20" }), unknown);
		assert.deepEqual(unknown.answers, [HELLO_FIRST]);
		assert.deepEqual([changes, idleCounts().emit ?? 0, idleCounts().view ?? 0], [0, 0, 0]);
		// The main loop's turn ends while the registry still says busy: the next poll is answered at once, quietly too.
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual(second.answers, [NO_CMDS], "the turn's end answered it");
		changes = 0;
		resetIdleCounts();
		assert.deepEqual(poll(A).answers, [NO_CMDS]);
		assert.deepEqual([changes, idleCounts()["poll.now"], idleCounts().emit ?? 0], [0, 1, 0]);
		// A held poll takes a command: the queue's change repaints the keys.
		model.setRegistry([reg(1, A), reg(2, B)]);
		const open = poll(A);
		changes = 0;
		const queued = model.queue(A, { t: "prompt", text: "hi" });
		assert.ok(queued.ok);
		assert.deepEqual([open.answers.length, queued.cmd.state], [1, "delivered"]);
		assert.ok(changes >= 1, "QUEUED and DELIVERED each repaint");
	});

	test("the views are built once per change, however many listeners and keys read them, frozen since they're shared; reading again without a change builds none", () => {
		const { model, permission, at, events, view } = setup();
		for (let i = 0; i < 5; i++)
			model.onChange(() => {
				model.sessions();
				model.session(A);
				model.slotView(B);
				model.onScreen();
				model.target();
			});
		resetIdleCounts();
		permission(A, "Bash", { command: "ls" });
		assert.deepEqual([idleCounts().emit, idleCounts().view], [1, 2], "one change, two sessions: two views");
		assert.equal(view(A)?.status, "approval");
		assert.ok(Object.isFrozen(view(A)));
		assert.throws(() => {
			(view(A) as { title: string }).title = "changed";
		}, TypeError);
		resetIdleCounts();
		model.sessions();
		view(A);
		model.slotView(A);
		assert.equal(idleCounts().view ?? 0, 0);
		// Each change shows in the next reading: an event, a record, the registry, a release, a hello.
		at(20_000);
		events(B, { t: "attach", surface: "desktop" });
		assert.equal(model.onScreen()?.key, B);
		model.setRecords(new Map([[B, record(B, { title: "From the record", model: "claude-opus-5-5" })]]));
		assert.equal(view(B)?.model, "claude-opus-5-5");
		model.setRegistry([reg(1, A), reg(2, B, { name: "Renamed" })]);
		assert.equal(view(B)?.title, "Renamed");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 30_000 }), reg(2, B, { name: "Renamed" })]);
		assert.equal(view(A)?.status, "idle", "the held request, released by rule 3");
		model.hello({ v: 1, sid: "sid-2", host: B, inst: "ib", model: "claude-haiku-5-5" });
		assert.deepEqual([view(B)?.plugin, model.sessions()[1]?.plugin], [true, true]);
		// A slotted session the registry doesn't list: its view comes from its record, as it stands.
		model.keepHosts([C]);
		assert.equal(model.slotView(C)?.title, "Unknown session");
		model.setRecords(new Map([[C, record(C, { title: "Asleep" })]]));
		assert.equal(model.slotView(C)?.title, "Asleep");
	});
});

// ---- the session's other loops (PROTOCOL.md, Events: threads; agents-and-wake.md, B2) ----

/** A run as a `threads` event lists it: `review`, 5 of 9 ended, one loop in a turn, unless the test says otherwise. */
function run(fields: Partial<ThreadRun> = {}): ThreadRun {
	return { run: "wf_1", name: "review", started: 9, finished: 5, failed: 0, open: 1, ...fields };
}

/** A `threads` event: `running` loops in a turn, with the runs given and no agents unless given. */
function threadsEvent(running: number, runs: ThreadRun[] = [], agents: Threads["agents"] = []): Record<string, unknown> {
	return { t: "threads", running, agents, runs };
}

describe("a threads event, read with care (PROTOCOL.md, Events: threads)", () => {
	const parse = (fields: Record<string, unknown>): Threads => {
		const e = parseEvent({ t: "threads", at: 1, ...fields });
		assert.ok(e?.t === "threads");
		return e.threads;
	};

	test("running and a run's counts are whole numbers from 0, anything else 0", () => {
		assert.equal(parse({ running: 4 }).running, 4);
		for (const running of [-1, 1.5, "3", Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, [2]]) assert.equal(parse({ running }).running, 0, String(running));
		const [r] = parse({ runs: [{ run: "wf_2", name: "deck", started: -2, finished: 2.5, failed: "1", open: null }] }).runs;
		assert.deepEqual(r, { run: "wf_2", name: "deck", started: 0, finished: 0, failed: 0, open: 0 });
	});

	test("agents and runs are arrays of objects: anything else is none, and an entry that isn't an object is skipped before the 8 and the 3 are counted", () => {
		assert.deepEqual(parse({ running: 1, agents: "x", runs: { run: "wf_1" } }), { running: 1, agents: [], runs: [] });
		assert.deepEqual(parse({}), { running: 0, agents: [], runs: [] });
		const agents = Array.from({ length: 10 }, (_, i) => ({ kind: "subagent", desc: `a${i}`, doing: "" }));
		assert.deepEqual(parse({ agents: [null, 7, "a", [], ...agents] }).agents.map((a) => a.desc), ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
		const runs = parse({ runs: ["wf_0", run({ run: "wf_1" }), run({ run: "wf_2" }), [], run({ run: "wf_3" }), run({ run: "wf_4" })] }).runs;
		assert.deepEqual(runs.map((r) => r.run), ["wf_1", "wf_2", "wf_3"]);
	});

	test("a kind it doesn't know reads as other; desc and doing are cut to 60, a run's missing name is workflow, and a workflow agent's run isn't kept", () => {
		for (const kind of AGENT_KINDS) assert.equal(parse({ agents: [{ kind }] }).agents[0]?.kind, kind);
		const long = "x".repeat(61);
		const cut = `${"x".repeat(59)}…`;
		assert.deepEqual(parse({ agents: [{ kind: "spirit", desc: long, doing: long, run: "wf_1" }, { desc: 5 }, { kind: "fork", desc: "y".repeat(60) }] }).agents, [
			{ kind: "other", desc: cut, doing: cut },
			{ kind: "other", desc: "", doing: "" },
			{ kind: "fork", desc: "y".repeat(60), doing: "" },
		]);
		assert.equal(cut.length, 60);
		assert.deepEqual(parse({ runs: [{ run: "wf_1", started: 2 }, { name: "" }, { name: " \n " }] }).runs.map((r) => r.name), ["workflow", "workflow", "workflow"]);
		// A run's name goes into the log's THREADS lines: on one line.
		assert.equal(parse({ runs: [{ name: "review\nINFO forged line" }] }).runs[0]?.name, "review INFO forged line");
	});
});

describe("the session's other loops in the model (PROTOCOL.md, Events: threads; status rule 3; Phase 9)", () => {
	test("kept only from the session's current instance; forgotten at another instance's hello and at the session's end; kept through its own hello after it stopped polling", () => {
		const { model, clock, events, hello, view } = setup([reg(1, A, { status: "busy" })]);
		events(A, threadsEvent(1));
		assert.equal(view(A)?.threads, null, "no instance is current before a hello");
		hello(A);
		events(A, threadsEvent(2, [run()]));
		assert.deepEqual(view(A)?.threads, { running: 2, agents: [], runs: [run()] });
		assert.equal(model.events({ host: A, inst: "ib", seq: 1, events: [threadsEvent(5)] }).status, 204);
		assert.equal(view(A)?.threads?.running, 2, "another instance's is dropped");
		// Its current instance goes 60 s without a poll, then says hello again: not a new instance, so it's kept.
		clock.advance(IN_FLIGHT_MS);
		assert.equal(view(A)?.plugin, false);
		hello(A);
		assert.equal(view(A)?.threads?.running, 2);
		// A new instance starts with an empty picture.
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib" });
		assert.equal(view(A)?.threads, null);
		model.events({ host: A, inst: "ib", seq: 2, events: [threadsEvent(1)] });
		assert.equal(view(A)?.threads?.running, 1);
		model.setRegistry([]);
		model.setRegistry([reg(1, A, { status: "busy" })]);
		assert.equal(view(A)?.threads, null, "the session's end forgets it");
	});

	test("background while the main loop is out of its turn and others are in one, whatever the registry says; since is the later of the turn's end and running going above 0", () => {
		const { model, at, events, hello, view } = setup([reg(1, A, { status: "busy", statusUpdatedAt: 5000 })]);
		hello(A);
		at(20_000);
		events(A, { t: "turn.start", turn: "t1" });
		at(21_000);
		events(A, threadsEvent(2, [run()]));
		assert.equal(view(A)?.status, "working", "the main loop's turn runs");
		at(30_000);
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual([view(A)?.status, view(A)?.since], ["background", 30_000], "the turn's end, after running went above 0");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 31_000 })]);
		assert.equal(view(A)?.status, "background", "an idle while others are in a turn trails");
		at(40_000);
		events(A, threadsEvent(0, [run({ open: 0, finished: 9 })]));
		assert.equal(view(A)?.status, "done");
		at(45_000);
		events(A, threadsEvent(1));
		assert.deepEqual([view(A)?.status, view(A)?.since], ["background", 45_000], "running went above 0 after the turn's end");
		at(46_000);
		events(A, threadsEvent(3));
		assert.equal(view(A)?.since, 45_000, "it stays above 0: since stays");
		// A session the deck saw no turn for: running going above 0.
		const other = setup([reg(1, A, { status: "busy", statusUpdatedAt: 5000 })]);
		other.hello(A);
		other.at(50_000);
		other.events(A, threadsEvent(1));
		assert.deepEqual([other.view(A)?.status, other.view(A)?.since], ["background", 50_000]);
	});

	test("when the other loops' work ends after the main loop's turn, the done, failed or stopped that follows is timed from that end, and only a look after it sees it", () => {
		for (const [end, status] of [
			[{ t: "turn.end", turn: "t1", reason: "answer" }, "done"],
			[{ t: "failed", error: "overloaded" }, "failed"],
			[{ t: "turn.end", turn: "t1", reason: "aborted" }, "interrupted"],
		] as const) {
			const { model, at, events, hello, view } = setup([reg(1, A, { status: "busy", statusUpdatedAt: 5000 })]);
			hello(A);
			at(20_000);
			events(A, { t: "turn.start", turn: "t1" }, threadsEvent(3, [run()]));
			at(30_000);
			events(A, end);
			assert.deepEqual([view(A)?.status, view(A)?.since], ["background", 30_000], status);
			// The user looks at the session while its agents work.
			at(60_000);
			events(A, { t: "attach", surface: "desktop" });
			at(70_000);
			events(A, { t: "detach", surface: "desktop" });
			// Ten minutes on, the work ends, and the registry goes idle.
			at(630_000);
			events(A, threadsEvent(0, [run({ finished: 9, open: 0 })]));
			at(631_000);
			model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 631_000 })]);
			assert.deepEqual([view(A)?.status, view(A)?.since, view(A)?.seen], [status, 630_000, false], `${status}: from the work's end, which the earlier look didn't see`);
			at(640_000);
			events(A, { t: "attach", surface: "desktop" });
			assert.equal(view(A)?.seen, true, `${status}: a look after it does`);
		}
		// Work that ends before the main loop's turn does: the turn's end, as before.
		const { model, at, events, hello, view } = setup([reg(1, A, { status: "busy", statusUpdatedAt: 5000 })]);
		hello(A);
		at(20_000);
		events(A, { t: "turn.start", turn: "t1" }, threadsEvent(2));
		at(25_000);
		events(A, threadsEvent(0));
		at(30_000);
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 31_000 })]);
		assert.deepEqual([view(A)?.status, view(A)?.since, view(A)?.seen], ["done", 30_000, false]);
		at(40_000);
		events(A, { t: "attach", surface: "desktop" });
		assert.equal(view(A)?.seen, true);
	});

	test("a snapshot sent again after a hello, running still 0, isn't the work's end: the done keeps its since, and stays seen", () => {
		// The mod sends its snapshot again after each hello the deck answers (PROTOCOL.md, Events: threads), so only a fall
		// of running from above 0 times the work's end.
		for (const endsAfter of [false, true]) {
			const { model, at, events, hello, view } = setup([reg(1, A, { status: "busy", statusUpdatedAt: 5000 })]);
			const ended = threadsEvent(0, [run({ finished: 9, open: 0 })]);
			hello(A);
			at(20_000);
			events(A, { t: "turn.start", turn: "t1" }, threadsEvent(2, [run()]));
			if (!endsAfter) {
				at(25_000);
				events(A, ended);
			}
			at(30_000);
			events(A, { t: "turn.end", turn: "t1", reason: "answer" });
			if (endsAfter) {
				at(40_000);
				events(A, ended);
			}
			at(41_000);
			model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 41_000 })]);
			at(100_000);
			events(A, { t: "attach", surface: "desktop" });
			const since = endsAfter ? 40_000 : 30_000;
			const why = endsAfter ? "the work ended after the turn" : "the work ended within it";
			assert.deepEqual([view(A)?.status, view(A)?.since, view(A)?.seen], ["done", since, true], why);
			// The same instance says hello again, after a failed request say, and sends its snapshot again, unchanged.
			at(500_000);
			hello(A);
			events(A, ended);
			assert.deepEqual([view(A)?.status, view(A)?.since, view(A)?.seen], ["done", since, true], `${why}: still`);
		}
	});

	test("THREADS lines: running leaving 0 at info, with the run's label if one has a loop in a turn, and coming back to 0 at info; every snapshot at debug; another instance's dropped at debug", () => {
		const { model, log, events, hello } = setup([reg(1, A, { status: "busy" })]);
		hello(A);
		const lines = (): string[] => log.lines.filter((l) => l.message.startsWith("THREADS")).map((l) => `${l.level} ${l.message}`);
		events(A, threadsEvent(0, [run({ started: 0, finished: 0, open: 0 })]));
		events(A, threadsEvent(2, [run({ started: 2, finished: 0, open: 2 })]));
		events(A, threadsEvent(3, [run({ started: 4, finished: 1, open: 3 }), run({ run: "wf_2", name: "deck", started: 2, finished: 2, open: 0 })]));
		events(A, threadsEvent(0, [run({ started: 4, finished: 4, open: 0 })]));
		events(A, threadsEvent(1));
		model.events({ host: A, inst: "ib", seq: 1, events: [threadsEvent(1)] });
		assert.deepEqual(lines(), [
			`debug THREADS ${A}: running 0, runs review 0/0`,
			`debug THREADS ${A}: running 2, runs review 0/2`,
			`info THREADS ${A}: 2 in a turn (review 0/2)`,
			`debug THREADS ${A}: running 3, runs review 1/4, deck 2/2`,
			`debug THREADS ${A}: running 0, runs review 4/4`,
			`info THREADS ${A}: none in a turn`,
			`debug THREADS ${A}: running 1, runs none`,
			`info THREADS ${A}: 1 in a turn`,
			`debug THREADS ${A} from mod instance "ib", not the current one: dropped`,
		]);
		// A new instance forgets the picture, which counted loops in a turn: none now.
		model.hello({ v: 1, sid: "sid-1", host: A, inst: "ib" });
		assert.equal(lines().at(-1), `info THREADS ${A}: none in a turn`);
	});
});

describe("the poll burst while other loops are at work (PROTOCOL.md, Commands; Phase 9)", () => {
	test("a main-loop turn end while others are in a turn neither answers the open poll nor opens the window; nor does a reading that then turns busy", () => {
		for (const end of [{ t: "turn.end", turn: "t1", reason: "answer" }, { t: "failed", error: "overloaded" }]) {
			const { model, events, poll } = setup([reg(1, A, { status: "idle" })]);
			const n1 = poll(A);
			events(A, { t: "turn.start", turn: "t1" }, threadsEvent(2));
			events(A, end);
			assert.deepEqual(n1.answers, [], `${end.t}: held, since other loops keep the registry busy`);
			model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 2000 })]);
			assert.deepEqual(n1.answers, [], `${end.t}: the reading turning busy answers nothing`);
		}
	});

	test("a threads with running above 0 closes the window a turn's end opened: polls are held again, and a reading that turns busy answers none", () => {
		const { model, events, poll } = setup([reg(1, A, { status: "busy" })]);
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.deepEqual([n1.answers, poll(A).answers], [[NO_CMDS], [NO_CMDS]], "the window is open");
		// A background agent starts after the turn.
		events(A, threadsEvent(1));
		const n3 = poll(A);
		assert.deepEqual(n3.answers, [], "held: the window has closed");
		model.setRegistry([reg(1, A, { status: "idle", statusUpdatedAt: 2000 })]);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 3000 })]);
		assert.deepEqual(n3.answers, []);
	});

	test("running dropping to 0 while the main loop isn't in a turn answers the open poll at once and opens the window for 60 s; not while its turn runs", () => {
		const { clock, events, poll } = setup([reg(1, A, { status: "busy" })]);
		const n1 = poll(A);
		events(A, { t: "turn.start", turn: "t1" }, threadsEvent(2), { t: "turn.end", turn: "t1", reason: "answer" });
		events(A, threadsEvent(1));
		assert.deepEqual(n1.answers, [], "one is still in a turn");
		events(A, threadsEvent(0));
		assert.deepEqual(n1.answers, [NO_CMDS], "the last left its turn");
		assert.deepEqual(poll(A).answers, [NO_CMDS], "at once while the reading says busy");
		// The mod polls about once a second, each answered at once, until the 60 s are up.
		for (let i = 1; i < 60; i++) {
			clock.advance(1000);
			assert.deepEqual(poll(A).answers, [NO_CMDS], `${i} s after`);
		}
		clock.advance(1000);
		const n3 = poll(A);
		assert.deepEqual(n3.answers, [], "for 60 s");
		events(A, { t: "turn.start", turn: "t2" }, threadsEvent(1), threadsEvent(0));
		assert.deepEqual(n3.answers, [], "the main loop's turn runs");
	});
});
