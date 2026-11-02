import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { SessionModel } from "../src/model/sessions.js";
import { sessionStatus } from "../src/model/status.js";
import { fingerprint } from "../src/protocol/fingerprint.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { FakeClock } from "./helpers/fake-clock.js";

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
	const model = new SessionModel({ clock, wallNow: () => wall });
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
	return { model, clock, at, events, permission, view: (host: string) => model.session(host) };
}

describe("session status (PROTOCOL.md's order)", () => {
	const base = { heldTool: 0, heldAsk: 0, registry: "idle", turn: null, recordCategory: null };
	test("the first that applies wins", () => {
		assert.equal(sessionStatus({ ...base, heldTool: 1, heldAsk: 1, registry: "waiting" }), "approval");
		assert.equal(sessionStatus({ ...base, heldAsk: 1, registry: "busy" }), "needs-you");
		assert.equal(sessionStatus({ ...base, registry: "waiting" }), "needs-you");
		assert.equal(sessionStatus({ ...base, registry: "busy", turn: { ended: true, reason: "aborted", failed: true } }), "working");
		assert.equal(sessionStatus({ ...base, turn: { ended: true, reason: "aborted", failed: true }, recordCategory: "blocked" }), "failed");
		assert.equal(sessionStatus({ ...base, turn: { ended: true, reason: "aborted", failed: false }, recordCategory: "blocked" }), "interrupted");
		assert.equal(sessionStatus({ ...base, turn: { ended: true, reason: "answer", failed: false }, recordCategory: "blocked" }), "needs-you");
		assert.equal(sessionStatus({ ...base, turn: { ended: true, reason: "answer", failed: false }, recordCategory: "need_input" }), "needs-you");
		assert.equal(sessionStatus({ ...base, registry: "busy", recordCategory: "blocked" }), "working");
		assert.equal(sessionStatus({ ...base, turn: { ended: true, reason: "answer", failed: false }, recordCategory: "review_ready" }), "done");
		assert.equal(sessionStatus({ ...base, turn: { ended: true, reason: "answer", failed: false } }), "done");
		assert.equal(sessionStatus({ ...base, turn: { ended: false, reason: null, failed: false } }), "idle");
		assert.equal(sessionStatus({ ...base, registry: null }), "idle");
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
