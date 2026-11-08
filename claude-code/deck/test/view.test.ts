import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { costText, modelName, projectName, sinceChangesAt, sinceText, tokenCount, tokensText } from "../src/model/format.js";
import { SessionModel } from "../src/model/sessions.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { jumpTo } from "../src/slots/jump.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeReply implements PollReply {
	open = true;
	answers: { status: number; body: unknown }[] = [];
	send(status: number, body: string): void {
		this.open = false;
		this.answers.push({ status, body: JSON.parse(body) });
	}
	onClose(): void {}
}

const A = "local_a";
const B = "local_b";
const C = "local_c";

function reg(pid: number, host: string | null, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "idle", cwd: `/p/proj${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

function record(host: string, fields: Partial<AppRecord> = {}): AppRecord {
	return { host, title: null, model: "claude-haiku-5-5", effort: "low", permissionMode: "default", lastFocusedAt: null, turnCategory: null, isArchived: false, lastActivityAt: null, cwd: null, summary: null, needs: null, ...fields };
}

/** Lets the front check's promises settle. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** What stands for a key that shows `seen` (a slot key, an Others key), for the front-app check's gate. */
const KEY = {};

/** `shown`: a key on the deck shows `seen` from the start (default: when there's a front check). */
function setup(registry: RegistrySession[] = [reg(1, A), reg(2, B)], opts: { front?: () => Promise<boolean>; shown?: boolean } = {}) {
	let wall = 10_000;
	const clock = new FakeClock();
	const log = new RecordingLog();
	let asks = 0;
	const front = opts.front;
	const model = new SessionModel({
		clock,
		log,
		wallNow: () => wall,
		front: front
			? () => {
					asks++;
					return front();
				}
			: undefined,
	});
	model.setRegistry(registry);
	model.setBridgeState("listening");
	if (opts.shown ?? opts.front !== undefined) model.showsSeen(KEY, true);
	const at = (t: number): void => {
		wall = t;
	};
	let seq = 0;
	const events = (host: string, ...evs: Record<string, unknown>[]): void => {
		assert.equal(model.events({ sid: null, host, inst: `i-${host}`, seq: ++seq, events: evs.map((e) => ({ at: 1, ...e })) }).status, 204);
	};
	const sidOf = (host: string): string => `sid-${registry.find((r) => r.hostSessionId === host)?.key ?? "?"}`;
	const permission = (host: string, tool: string, input: unknown): FakeReply => {
		const reply = new FakeReply();
		model.permission({ session_id: sidOf(host), tool_name: tool, tool_input: input }, host, reply);
		return reply;
	};
	const hello = (host: string, fields: Record<string, unknown> = {}): void => {
		model.hello({ v: 1, sid: sidOf(host), host, inst: `i-${host}`, ...fields });
	};
	return { model, clock, log, at, events, permission, hello, view: (host: string) => model.session(host), asks: () => asks };
}

describe("what each session shows (session-keys.md)", () => {
	test("need follows the session's oldest held request: approval, question, plan; input for a waiting with nothing held or the app's sign; else none", () => {
		const { model, permission, view } = setup([reg(1, A, { status: "waiting" }), reg(2, B), reg(3, C)]);
		assert.equal(view(A)?.need, "input", "the registry's waiting, nothing held");
		assert.equal(view(B)?.need, null);
		permission(B, "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "Y" }] }] });
		assert.equal(view(B)?.need, "question");
		permission(B, "Bash", { command: "ls" });
		assert.equal(view(B)?.status, "approval", "the status puts a tool first");
		assert.equal(view(B)?.need, "question", "the need follows the oldest, which the dial shows");
		permission(C, "ExitPlanMode", {});
		assert.equal(view(C)?.need, "plan");
		model.setRecords(new Map([[A, record(A)], [C, record(C, { turnCategory: "blocked" })]]));
		model.setRegistry([reg(1, A, { status: "busy" }), reg(2, B), reg(3, C)]);
		assert.equal(view(A)?.need, null);
	});

	test("the app's needs-input sign is need input too", () => {
		const { model, view } = setup([reg(1, A)]);
		model.setRecords(new Map([[A, record(A, { turnCategory: "need_input" })]]));
		assert.equal(view(A)?.status, "needs-you");
		assert.equal(view(A)?.need, "input");
	});

	test("since: the held request's arrival, the registry's statusUpdatedAt or first reading, the turn.start, or the turn's end", () => {
		const { model, at, events, permission, view, hello } = setup([reg(1, A, { status: "busy", statusUpdatedAt: 5000 }), reg(2, B, { statusUpdatedAt: null })]);
		assert.equal(view(A)?.since, 5000, "busy: statusUpdatedAt");
		assert.equal(view(B)?.since, 10_000, "idle without statusUpdatedAt: the first reading");
		at(12_000);
		permission(A, "Bash", { command: "ls" });
		at(13_000);
		permission(A, "Edit", { file_path: "/x" });
		assert.equal(view(A)?.since, 12_000, "the oldest held request's arrival");
		hello(B);
		at(20_000);
		events(B, { t: "turn.start", turn: "t1" });
		assert.equal(view(B)?.status, "working");
		assert.equal(view(B)?.since, 20_000, "working from the turn.start the deck got");
		at(25_000);
		events(B, { t: "turn.end", turn: "t1", reason: "answer" });
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 5000 }), reg(2, B, { statusUpdatedAt: 25_001 })]);
		assert.equal(view(B)?.status, "done");
		assert.equal(view(B)?.since, 25_000, "the turn's end");
		at(30_000);
		events(B, { t: "failed", error: "overloaded" });
		assert.equal(view(B)?.status, "failed");
		assert.equal(view(B)?.since, 30_000, "a failed turn ends when the deck got the failed");
		model.setRegistry([reg(1, A, { status: "waiting", statusUpdatedAt: 31_000 }), reg(2, B, { statusUpdatedAt: 25_001 })]);
		assert.equal(view(A)?.since, 12_000, "still held: the request's time, not the waiting");
	});

	test("since for the record's needs-input sign: the turn's end, else the registry's idle", () => {
		const { model, at, events, view, hello } = setup([reg(1, A, { statusUpdatedAt: 4000 })]);
		model.setRecords(new Map([[A, record(A, { turnCategory: "blocked" })]]));
		assert.equal(view(A)?.since, 4000);
		hello(A);
		at(9000);
		events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		assert.equal(view(A)?.status, "needs-you");
		assert.equal(view(A)?.since, 9000);
	});

	test("context tokens and window beside the percent, and the cost, from the latest measure; the cost stays when one has none", () => {
		const { events, view, hello } = setup([reg(1, A)]);
		hello(A);
		assert.deepEqual([view(A)?.context, view(A)?.tokens, view(A)?.window, view(A)?.cost], [null, null, null, null]);
		events(A, { t: "measure", context: { percent: 62, tokens: 620_000, window: 1_000_000 }, cost: { usd: 1.24 } });
		assert.deepEqual([view(A)?.context, view(A)?.tokens, view(A)?.window, view(A)?.cost], [62, 620_000, 1_000_000, 1.24]);
		// After a compaction the engine has no count yet: percent and tokens go, the window and cost stay.
		events(A, { t: "measure", context: { window: 1_000_000 } });
		assert.deepEqual([view(A)?.context, view(A)?.tokens, view(A)?.window, view(A)?.cost], [null, null, 1_000_000, 1.24]);
		events(A, { t: "measure", context: { percent: 5, tokens: "many", window: 200_000 }, cost: { usd: "x" } });
		assert.deepEqual([view(A)?.context, view(A)?.tokens, view(A)?.window, view(A)?.cost], [5, null, 200_000, 1.24]);
	});

	test("the last summary and the app's needs come from the record; the project is the last segment of cwd", () => {
		const { model, view, hello } = setup([reg(1, A), reg(2, B, { cwd: null }), reg(3, C, { cwd: null })]);
		model.setRecords(new Map([[A, record(A, { summary: "Ran the tests", needs: "Merge PR #12?" })], [C, record(C, { cwd: "/Users/me/from-record/" })]]));
		assert.deepEqual([view(A)?.summary, view(A)?.needs, view(A)?.project], ["Ran the tests", "Merge PR #12?", "proj1"]);
		assert.equal(view(B)?.project, null);
		hello(B, { cwd: "/Users/me/from-hello" });
		assert.equal(view(B)?.project, "from-hello");
		assert.equal(view(C)?.project, "from-record");
	});

	test("running is the registry's; archived is the record's; startedAt is the registry's", () => {
		const { model, view } = setup([reg(1, A, { startedAt: 77 })]);
		model.setRecords(new Map([[A, record(A, { isArchived: true })]]));
		assert.deepEqual([view(A)?.running, view(A)?.listed, view(A)?.archived, view(A)?.startedAt], [true, true, true, 77]);
	});
});

describe("seen (session-keys.md, What each session shows)", () => {
	/** A with the plugin, whose turn ended at 20 000 by the deck's clock, with the registry idle. */
	function ended(opts: { front?: () => Promise<boolean>; shown?: boolean } = {}) {
		const s = setup([reg(1, A), reg(2, B)], opts);
		s.hello(A);
		s.at(19_000);
		s.events(A, { t: "turn.start", turn: "t1" });
		s.at(20_000);
		s.events(A, { t: "turn.end", turn: "t1", reason: "answer" });
		s.model.setRegistry([reg(1, A, { statusUpdatedAt: 20_001 }), reg(2, B)]);
		assert.equal(s.view(A)?.status, "done");
		return s;
	}

	test("a turn's end isn't seen until the session comes on screen after it: an attach, or a later lastFocusedAt", () => {
		const { model, at, events, view } = ended();
		assert.equal(view(A)?.seen, false);
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 19_999 })]]));
		assert.equal(view(A)?.seen, false, "focused before the end");
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 20_500 })]]));
		assert.equal(view(A)?.seen, true, "focused after it");
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 19_999 })]]));
		at(30_000);
		events(A, { t: "turn.start", turn: "t2" }, { t: "turn.end", turn: "t2", reason: "answer" });
		assert.equal(view(A)?.seen, false, "the next turn's end is unseen again");
		at(31_000);
		events(A, { t: "attach", surface: "desktop" });
		assert.equal(view(A)?.seen, true, "it came on screen");
	});

	test("seen by a press on its slot key or a jump from its dial (markSeen), for a listed session", () => {
		const { model, at, view } = ended();
		at(21_000);
		model.markSeen(A);
		assert.equal(view(A)?.seen, true);
		model.markSeen("local_not-listed");
		assert.equal(model.session("local_not-listed"), null);
	});

	test("a press for a session that isn't running counts for nothing, once it's listed again", () => {
		const { model, at, view } = setup([reg(1, A)]);
		model.keepHosts([B]);
		model.setRecords(new Map([[B, record(B, { lastActivityAt: 9000, lastFocusedAt: 8000 })]]));
		at(9500);
		// B's slot key or dial, while B isn't running: the jump opens it in the app, which starts it again.
		model.markSeen(B);
		model.setRegistry([reg(1, A), reg(2, B)]);
		assert.equal(view(B)?.status, "idle");
		assert.equal(view(B)?.seen, false, "active since it was last focused; the press before it was listed doesn't count");
		at(9600);
		model.markSeen(B);
		assert.equal(view(B)?.seen, true, "a press while it's listed does");
	});

	test("a look in the very millisecond the turn ended counts as seen", () => {
		const { model, at, events, hello, view } = setup([reg(1, A)]);
		hello(A);
		at(20_000);
		events(A, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		model.setRegistry([reg(1, A, { statusUpdatedAt: 20_001 })]);
		assert.deepEqual([view(A)?.status, view(A)?.seen], ["done", false]);
		events(A, { t: "attach", surface: "desktop" });
		assert.equal(view(A)?.seen, true, "attached at 20 000, as the turn ended");
	});

	test("only the desktop app's attach and detach count: another client's, a phone's say, is ignored", () => {
		const { model, at, events, view, hello } = setup([reg(1, A), reg(2, B)]);
		hello(B);
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 9000 })]]));
		at(9500);
		events(B, { t: "attach", surface: "mobile" });
		assert.equal(model.onScreen()?.host, A, "a phone opening B doesn't put it on screen in the app");
		events(B, { t: "attach", surface: "desktop" });
		assert.equal(model.onScreen()?.host, B);
		at(20_000);
		events(B, { t: "turn.start", turn: "t1" }, { t: "turn.end", turn: "t1", reason: "answer" });
		model.setRegistry([reg(1, A), reg(2, B, { statusUpdatedAt: 20_001 })]);
		at(21_000);
		events(B, { t: "attach", surface: "mobile" });
		events(B, { t: "attach", surface: "vscode" });
		events(B, { t: "attach" });
		assert.equal(view(B)?.seen, false, "seen only by the desktop app's attach");
		events(B, { t: "attach", surface: "desktop" });
		assert.equal(view(B)?.seen, true);
	});

	test("failed and interrupted turns are seen the same way; a status that waits on you has no seen", () => {
		const { model, at, events, view, permission } = ended();
		at(22_000);
		events(A, { t: "turn.start", turn: "t2" }, { t: "turn.end", turn: "t2", reason: "aborted" });
		assert.equal(view(A)?.status, "interrupted");
		assert.equal(view(A)?.seen, false);
		at(23_000);
		events(A, { t: "attach", surface: "desktop" });
		assert.equal(view(A)?.seen, true);
		permission(A, "Bash", { command: "ls" });
		assert.equal(view(A)?.seen, null);
		model.setRegistry([reg(1, A, { status: "busy", statusUpdatedAt: 24_000 }), reg(2, B)]);
		assert.equal(view(B)?.seen, true, "idle with nothing unseen");
	});

	test("an idle session whose turn end the deck didn't see is unseen while its record's lastActivityAt is later than its lastFocusedAt", () => {
		const { model, at, view } = setup([reg(1, A), reg(2, B)]);
		model.setRecords(new Map([[A, record(A, { lastActivityAt: 9000, lastFocusedAt: 8000 })], [B, record(B, { lastActivityAt: 8000, lastFocusedAt: 8000 })]]));
		assert.equal(view(A)?.status, "idle");
		assert.equal(view(A)?.seen, false);
		assert.equal(view(B)?.seen, true, "focused at the time of its last activity");
		at(9500);
		model.markSeen(A);
		assert.equal(view(A)?.seen, true);
	});

	test("on screen with Claude in front: seen at the next check, asked once a second only while needed; a detach stops it", async () => {
		let front = false;
		const { clock, at, events, view, asks } = ended({ front: async () => front });
		await settle();
		assert.equal(asks(), 0, "not on screen: nothing asked");
		clock.advance(5000);
		await settle();
		assert.equal(asks(), 0);
		// On screen before the turn ended (its attach came first), with Claude not in front.
		at(10_500);
		events(A, { t: "detach", surface: "desktop" });
		await settle();
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		assert.equal(view(A)?.seen, false, "the attach is older than the turn's end");
		await settle();
		assert.equal(asks(), 1, "asked at once");
		clock.advance(1000);
		await settle();
		clock.advance(1000);
		await settle();
		assert.equal(asks(), 3, "once a second");
		assert.equal(view(A)?.seen, false, "Claude isn't in front");
		front = true;
		at(25_000);
		clock.advance(1000);
		await settle();
		assert.equal(asks(), 4);
		assert.equal(view(A)?.seen, true);
		clock.advance(10_000);
		await settle();
		assert.equal(asks(), 4, "nothing left to see: no more asks");
		// The next turn ends while the session is off screen: nothing to ask.
		at(26_000);
		events(A, { t: "detach", surface: "desktop" });
		at(27_000);
		events(A, { t: "turn.start", turn: "t2" }, { t: "turn.end", turn: "t2", reason: "answer" });
		clock.advance(10_000);
		await settle();
		assert.equal(asks(), 4);
		assert.equal(view(A)?.seen, false);
	});

	test("with Claude in front, only the sessions on screen become seen, not another whose turn ended unseen off screen", async () => {
		const { model, at, events, hello, view, asks } = ended({ front: async () => true });
		hello(B);
		at(20_500);
		events(B, { t: "turn.start", turn: "t9" }, { t: "turn.end", turn: "t9", reason: "answer" });
		model.setRegistry([reg(1, A, { statusUpdatedAt: 20_001 }), reg(2, B, { statusUpdatedAt: 20_501 })]);
		// B was on screen once, and left it: one request, so the model sees only where it ended.
		at(10_000);
		events(B, { t: "attach", surface: "desktop" }, { t: "detach", surface: "desktop" });
		assert.deepEqual([view(A)?.seen, view(B)?.seen], [false, false]);
		assert.equal(asks(), 0, "neither is on screen");
		// A was on screen before its turn ended (its attach came first), and still is.
		events(A, { t: "attach", surface: "desktop" });
		assert.equal(view(A)?.seen, false);
		at(21_000);
		await settle();
		assert.equal(asks(), 1);
		assert.deepEqual([view(A)?.seen, view(B)?.seen], [true, false], "B is off screen: still unseen");
	});

	test("nothing asks while nothing on the deck shows seen; a key that does starts it, and its going stops it", async () => {
		let front = false;
		const { model, clock, at, events, view, asks } = ended({ front: async () => front, shown: false });
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		await settle();
		clock.advance(5000);
		await settle();
		assert.equal(asks(), 0, "an unseen session on screen, but no key shows seen");
		model.showsSeen(KEY, true);
		await settle();
		assert.equal(asks(), 1);
		const other = {};
		model.showsSeen(other, true);
		model.showsSeen(KEY, false);
		clock.advance(1000);
		await settle();
		assert.equal(asks(), 2, "another key still shows it");
		model.showsSeen(other, false);
		clock.advance(5000);
		await settle();
		assert.equal(asks(), 2, "none does: it stops");
		front = true;
		at(21_000);
		model.showsSeen(other, true);
		await settle();
		assert.equal(asks(), 3);
		assert.equal(view(A)?.seen, true);
	});

	test("nothing asks while no Stream Deck is connected, though a key shows seen; a connect starts it, and a disconnect stops it (agents-and-wake.md, C3)", async () => {
		const { model, clock, at, events, view, asks } = ended({ front: async () => false });
		model.setDeckConnected(false);
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		await settle();
		clock.advance(5000);
		await settle();
		assert.equal(asks(), 0, "an unseen session on screen and a key that shows seen, but no deck");
		model.setDeckConnected(true);
		await settle();
		assert.equal(asks(), 1, "asked at once");
		clock.advance(1000);
		await settle();
		assert.equal(asks(), 2);
		model.setDeckConnected(false);
		clock.advance(10_000);
		await settle();
		assert.equal(asks(), 2, "the deck went: no more asks");
		assert.equal(view(A)?.seen, false);
	});

	test("a phone's detach doesn't take the session off screen: the check goes on", async () => {
		const { at, events, clock, asks } = ended({ front: async () => false });
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		await settle();
		assert.equal(asks(), 1);
		events(A, { t: "detach", surface: "mobile" });
		clock.advance(1000);
		await settle();
		assert.equal(asks(), 2);
		events(A, { t: "detach", surface: "desktop" });
		clock.advance(5000);
		await settle();
		assert.equal(asks(), 2, "the desktop app's detach does");
	});

	test("without a check, nothing is ever asked or spawned", async () => {
		const { clock, at, events, view } = ended();
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		clock.advance(60_000);
		await settle();
		assert.equal(view(A)?.seen, false);
		assert.equal(clock.pendingTimers, 0);
	});

	test("asked every second at first, then every 5 s, then every 15 s, while it stays needed; an attach, a detach and a press on the deck or a wake (userPresent) each set it back to every second (B5)", async () => {
		const { model, clock, at, events, asks } = ended({ front: async () => false });
		const run = async (s: number): Promise<number> => {
			const from = asks();
			for (let i = 0; i < s; i++) {
				clock.advance(1000);
				await settle();
			}
			return asks() - from;
		};
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		await settle();
		assert.equal(asks(), 1, "asked at once");
		assert.deepEqual([await run(30), await run(90), await run(60)], [30, 18, 4], "1 s for 30 s, 5 s to 2 minutes, then 15 s");
		model.userPresent();
		await settle();
		assert.equal(await run(10), 10, "a press on the deck: every second again");
		assert.deepEqual([await run(20), await run(90), await run(30)], [20, 18, 2]);
		// B, on screen in the app's other window and off it again: each sets it back, while A, unseen, keeps it needed.
		at(11_000);
		events(B, { t: "attach", surface: "desktop" });
		await settle();
		assert.equal(await run(10), 10, "an attach");
		await run(150);
		events(B, { t: "detach", surface: "desktop" });
		await settle();
		assert.equal(await run(10), 10, "a detach");
		// A phone's attach isn't the desktop app's: nothing changes.
		await run(150);
		events(B, { t: "attach", surface: "mobile" });
		await settle();
		assert.equal(await run(30), 2, "still every 15 s");
	});

	test("a failing check counts as not in front", async () => {
		const { clock, at, events, view, asks } = ended({ front: () => Promise.reject(new Error("lsappinfo")) });
		at(10_000);
		events(A, { t: "attach", surface: "desktop" });
		await settle();
		clock.advance(1000);
		await settle();
		assert.equal(asks(), 2);
		assert.equal(view(A)?.seen, false);
	});
});

describe("slotted sessions the registry doesn't list, and the session on screen", () => {
	test("slotView: the registry's view while listed; from the record alone, not running, once it isn't", () => {
		const { model, view } = setup([reg(1, A)]);
		model.keepHosts([A, B]);
		assert.deepEqual(model.slotView(A), view(A));
		model.setRecords(new Map([[B, record(B, { title: "Old work", model: "claude-opus-5-5", effort: "max", permissionMode: "plan", lastActivityAt: 4000, summary: "Did a thing", needs: "Check it", cwd: "/w/thing", isArchived: false })]]));
		const b = model.slotView(B);
		assert.ok(b);
		assert.deepEqual(
			{ title: b.title, running: b.running, listed: b.listed, model: b.model, effort: b.effort, mode: b.mode, since: b.since, summary: b.summary, needs: b.needs, project: b.project, need: b.need, seen: b.seen, status: b.status, plugin: b.plugin },
			{ title: "Old work", running: false, listed: false, model: "claude-opus-5-5", effort: "max", mode: "plan", since: 4000, summary: "Did a thing", needs: "Check it", project: "thing", need: null, seen: null, status: "idle", plugin: false },
		);
		assert.equal(model.slotView(C)?.title, "Unknown session", "no record yet");
		assert.equal(model.slotView("not-a-host"), null);
	});

	test("keepHosts adds the slotted hosts to those whose records the deck reads, after the registry's", () => {
		const { model } = setup([reg(2, B), reg(1, A)]);
		let changes = 0;
		model.onChange(() => changes++);
		model.keepHosts([C, A, "nonsense"]);
		assert.deepEqual(model.hosts(), [A, B, C]);
		assert.equal(changes, 1);
		model.keepHosts([A, C]);
		assert.equal(changes, 1, "the same set changes nothing");
		model.keepHosts([]);
		assert.deepEqual(model.hosts(), [A, B]);
	});

	test("recordMissing is the records scan's; registryRead only after the first reading", () => {
		const fresh = new SessionModel();
		assert.equal(fresh.registryRead, false);
		fresh.setRegistry([]);
		assert.equal(fresh.registryRead, true);
		fresh.setRecords(new Map(), new Set([B]));
		assert.equal(fresh.recordMissing(B), true);
		assert.equal(fresh.recordMissing(A), false);
		assert.equal(fresh.isListed(A), false);
	});

	test("onScreen is the running session with the latest attach or lastFocusedAt; none without either", () => {
		const { model, at, events, hello } = setup([reg(1, A), reg(2, B)]);
		assert.equal(model.onScreen(), null);
		model.setRecords(new Map([[A, record(A, { lastFocusedAt: 9000 })], [B, record(B, { lastFocusedAt: 8000 })]]));
		assert.equal(model.onScreen()?.host, A);
		hello(B);
		at(9500);
		events(B, { t: "attach", surface: "desktop" });
		assert.equal(model.onScreen()?.host, B);
	});

	test("the target is the session last jumped to from a slot or Others, over the one on screen; the log names where, and a not-running target keeps its record's title", () => {
		const { model, log } = setup([reg(1, A), reg(2, C)]);
		model.keepHosts([B]);
		model.setRecords(new Map([[B, record(B, { title: "Asleep" })], [C, record(C, { lastFocusedAt: 9000 })]]));
		assert.equal(model.target()?.key, C, "nothing jumped to yet: the session on screen");
		const opened: string[] = [];
		jumpTo(model, B, (h) => opened.push(h), "slot key fixture:1:0", log);
		assert.ok(log.at("info").some((l) => l.includes("TARGET local_b: picked on slot key fixture:1:0")), log.at("info").join("\n"));
		assert.deepEqual([opened, model.target()?.title, model.target()?.listed, model.target()?.running], [[B], "Asleep", false, false]);
		jumpTo(model, A, () => {}, "the Others key", log);
		assert.deepEqual([model.target()?.key, model.picked], [A, A], "the newest jump, though C is on screen");
		assert.ok(log.at("info").some((l) => l.includes("TARGET local_a: picked on the Others key")));
	});
});

describe("how since, tokens and cost read (format.ts)", () => {
	test("since as 30s, 4m, 2h, 3d, rounded down; ahead of now reads 0s; unknown is none", () => {
		const now = 1_000_000_000;
		assert.equal(sinceText(now - 30_400, now), "30s");
		assert.equal(sinceText(now - 59_999, now), "59s");
		assert.equal(sinceText(now - 60_000, now), "1m");
		assert.equal(sinceText(now - 4 * 60_000 - 59_000, now), "4m");
		assert.equal(sinceText(now - 3_599_999, now), "59m");
		assert.equal(sinceText(now - 3_600_000, now), "1h");
		assert.equal(sinceText(now - 2 * 3_600_000 - 1, now), "2h");
		assert.equal(sinceText(now - 86_399_999, now), "23h");
		assert.equal(sinceText(now - 3 * 86_400_000, now), "3d");
		assert.equal(sinceText(now + 5000, now), "0s");
		assert.equal(sinceText(null, now), null);
	});

	test("sinceChangesAt is the first moment after now that the since reads differently: the next second, minute, hour or day after it; a second after a since ahead of now; none for an unknown one", () => {
		const since = 1_000_000_000;
		const cases: [number, number][] = [
			[0, 1000],
			[999, 1000],
			[1000, 2000],
			[59_999, 60_000],
			[60_000, 120_000],
			[4 * 60_000 + 59_000, 5 * 60_000],
			[3_599_999, 3_600_000],
			[3_600_000, 7_200_000],
			[86_399_999, 86_400_000],
			[3 * 86_400_000 + 5, 4 * 86_400_000],
			[-5000, 1000],
		];
		for (const [elapsed, change] of cases) {
			const now = since + elapsed;
			const at = sinceChangesAt(since, now);
			assert.equal(at, since + change, `${elapsed} ms in`);
			assert.ok(at !== null && at > now, `${elapsed}: later than now`);
			// The text holds until then, and changes then.
			assert.equal(sinceText(since, at - 1), sinceText(since, now), `${elapsed}: holds`);
			assert.notEqual(sinceText(since, at), sinceText(since, now), `${elapsed}: changes`);
		}
		assert.equal(sinceChangesAt(null, since), null);
		assert.equal(sinceChangesAt(Number.NaN, since), null);
	});

	test("tokens and cost", () => {
		assert.equal(tokensText(620_000, 1_000_000), "620k of 1M tokens");
		assert.equal(tokensText(1500, 200_000), "1.5k of 200k tokens");
		assert.equal(tokensText(950, null), "950 tokens");
		assert.equal(tokensText(null, 1_000_000), null);
		assert.deepEqual([tokenCount(9999), tokenCount(10_000), tokenCount(999_499), tokenCount(999_500), tokenCount(1_250_000)], ["10k", "10k", "999k", "1M", "1.3M"]);
		assert.equal(costText(1.236), "$1.24");
		assert.equal(costText(0), "$0.00");
		assert.equal(costText(null), null);
		assert.deepEqual([projectName("/Users/me/stream-deck-plugins"), projectName("/a/b/"), projectName("/"), projectName(null)], ["stream-deck-plugins", "b", null, null]);
	});

	test("model names as the app's menus have them", () => {
		assert.equal(modelName("claude-opus-4-7[1m]"), "Opus 4.7 1M");
		assert.equal(modelName("claude-sonnet-4-20250514"), "Sonnet 4");
		assert.equal(modelName("sonnet"), "Sonnet");
		assert.equal(modelName("gpt-x"), "gpt-x");
	});
});
