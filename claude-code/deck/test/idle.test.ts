import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { SessionModel } from "../src/model/sessions.js";
import { RecordsReader } from "../src/records/records.js";
import { RegistryReader, type RegistrySession } from "../src/registry/registry.js";
import { type Clock, realClock } from "../src/util/clock.js";
import { countIdle, IDLE_LOG_MS, idleCounts, resetIdleCounts, startIdleLog } from "../src/util/idle.js";
import { nullLog } from "../src/util/log.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** An HTTP answer the test can read: only its status. */
class FakeReply implements PollReply {
	open = true;
	answers: number[] = [];
	send(status: number): void {
		this.open = false;
		this.answers.push(status);
	}
	onClose(): void {}
}

/** An IDLE line's JSON, checked to be a debug line that starts `IDLE `. */
function idleLine(line: { level: string; message: string } | undefined): Record<string, unknown> & { counts: Record<string, number> } {
	assert.ok(line, "a line");
	assert.equal(line.level, "debug");
	assert.match(line.message, /^IDLE \{/);
	return JSON.parse(line.message.slice("IDLE ".length));
}

/** The counts of one family, `reg.` say. */
const countsOf = (prefix: string): Record<string, number> => Object.fromEntries(Object.entries(idleCounts()).filter(([k]) => k.startsWith(prefix)));

describe("the idle count (docs/claude-code/hardening.md, A1)", () => {
	beforeEach(() => resetIdleCounts());

	test("at debug, one IDLE line a minute: the seconds it covers, CPU, the event loop, memory, and the counts since the last, sorted; then they start afresh", () => {
		const clock = new FakeClock();
		const log = new RecordingLog();
		countIdle("before");
		const stop = startIdleLog(log, { level: "debug", clock });
		assert.ok(stop);
		countIdle("reg.stat", 3);
		countIdle("emit");
		countIdle("reg.scan");
		clock.advance(IDLE_LOG_MS - 1);
		assert.deepEqual(log.lines, []);
		clock.advance(1);
		assert.equal(log.lines.length, 1);
		const first = idleLine(log.lines[0]);
		assert.deepEqual(Object.keys(first), ["s", "userMs", "sysMs", "elu", "rssMB", "counts"]);
		assert.equal(first.s, 60);
		for (const k of ["userMs", "sysMs", "elu", "rssMB"] as const) assert.ok(typeof first[k] === "number" && first[k] >= 0, `${k}: ${String(first[k])}`);
		assert.ok((first.elu as number) <= 1);
		assert.ok((first.rssMB as number) > 0);
		// Counted before the start: not in the first line. Sorted by kind.
		assert.deepEqual(Object.entries(first.counts), [
			["emit", 1],
			["reg.scan", 1],
			["reg.stat", 3],
		]);
		assert.deepEqual(idleCounts(), {}, "reset after the line");
		countIdle("tick", 2);
		clock.advance(IDLE_LOG_MS);
		assert.deepEqual(idleLine(log.lines[1]).counts, { tick: 2 });
		clock.advance(IDLE_LOG_MS);
		assert.deepEqual(idleLine(log.lines[2]).counts, {}, "a minute with nothing counted");
		stop();
		clock.advance(10 * IDLE_LOG_MS);
		assert.equal(log.lines.length, 3);
		assert.equal(clock.pendingTimers, 0);
	});

	test("below debug it starts nothing and logs nothing; at trace it logs as at debug", () => {
		for (const level of ["error", "warn", "info"] as const) {
			const clock = new FakeClock();
			const log = new RecordingLog();
			countIdle("reg.scan");
			assert.equal(startIdleLog(log, { level, clock }), null, level);
			assert.equal(clock.pendingTimers, 0, level);
			clock.advance(10 * IDLE_LOG_MS);
			assert.deepEqual(log.lines, [], level);
		}
		const clock = new FakeClock();
		const log = new RecordingLog();
		const stop = startIdleLog(log, { level: "trace", clock });
		clock.advance(IDLE_LOG_MS);
		assert.equal(log.lines.length, 1);
		idleLine(log.lines[0]);
		stop?.();
	});

	test("its timer is unref'd, so it never keeps the process up", () => {
		const handles: ReturnType<typeof setTimeout>[] = [];
		const clock: Clock = {
			...realClock,
			setTimeout: (fn, ms) => {
				const handle = setTimeout(fn, ms);
				handles.push(handle);
				return handle;
			},
		};
		const stop = startIdleLog(nullLog, { level: "debug", clock });
		try {
			assert.equal(handles.length, 1);
			assert.equal(handles[0]?.hasRef(), false);
		} finally {
			stop?.();
		}
	});
});

describe("what the idle count counts", () => {
	const top = mkdtempSync(path.join(os.tmpdir(), "claude-deck-idle-"));
	after(() => rmSync(top, { recursive: true, force: true }));
	beforeEach(() => resetIdleCounts());

	test("a registry scan: reg.scan and reg.readdir, a reg.stat per session file, and a reg.read per new or changed one", async () => {
		const dir = mkdtempSync(path.join(top, "registry-"));
		const write = (name: string, body: Record<string, unknown>): void => writeFileSync(path.join(dir, name), JSON.stringify(body));
		write("1701.json", { pid: 1701, hostSessionId: "local_1701", status: "idle" });
		write("1805.json", { pid: 1805, hostSessionId: "local_1805", status: "busy" });
		writeFileSync(path.join(dir, "1701.0f3a.key"), "never read");
		const reader = new RegistryReader(dir);
		assert.equal((await reader.scan()).length, 2);
		assert.deepEqual(countsOf("reg."), { "reg.read": 2, "reg.readdir": 1, "reg.scan": 1, "reg.stat": 2 });
		resetIdleCounts();
		await reader.scan();
		assert.deepEqual(countsOf("reg."), { "reg.readdir": 1, "reg.scan": 1, "reg.stat": 2 }, "unchanged files are only stat'ed");
		resetIdleCounts();
		write("1805.json", { pid: 1805, hostSessionId: "local_1805", status: "waiting" });
		await reader.scan();
		assert.deepEqual(countsOf("reg."), { "reg.read": 1, "reg.readdir": 1, "reg.scan": 1, "reg.stat": 2 });
	});

	test("a records scan: rec.scan, rec.readdir and rec.stat for the folders it lists, a rec.stat per record it checks and a rec.read per changed one, and a rec.walk per wanted host with no known file, every scan", async () => {
		const root = mkdtempSync(path.join(top, "records-"));
		const org = path.join(root, "account-1", "org-1");
		mkdirSync(org, { recursive: true });
		const A = "local_a";
		const B = "local_b";
		writeFileSync(path.join(org, `${A}.json`), JSON.stringify({ title: "A" }));
		const reader = new RecordsReader(root);
		// A is found by a walk, and read; B, with no file anywhere, is walked for too.
		assert.deepEqual([...(await reader.scan([A, B])).keys()], [A]);
		assert.deepEqual(countsOf("rec."), { "rec.read": 1, "rec.readdir": 2, "rec.scan": 1, "rec.stat": 3, "rec.walk": 2 });
		resetIdleCounts();
		// A is only stat'ed now. B sets off a walk again: the root and the account listed, the account stat'ed, B's file
		// looked for in the one folder.
		await reader.scan([A, B]);
		assert.deepEqual(countsOf("rec."), { "rec.readdir": 2, "rec.scan": 1, "rec.stat": 3, "rec.walk": 1 });
	});

	test("a poll by its answer: poll.hello for a 409, poll.held for the current instance's, poll.stray for another instance's, poll.now after a turn while the registry says busy", () => {
		const A = "local_a";
		const reg: RegistrySession = { key: "1", name: "Session 1", status: "busy", cwd: "/p/1", hostSessionId: A, sessionId: "sid-1", statusUpdatedAt: 1000, startedAt: 1 };
		const model = new SessionModel({ clock: new FakeClock(), wallNow: () => 10_000 });
		model.setRegistry([reg]);
		model.setBridgeState("listening");
		/** A poll from `inst`, with the poll counts it made. */
		const poll = (inst: string): { answers: number[]; counts: Record<string, number> } => {
			resetIdleCounts();
			const reply = new FakeReply();
			model.next(new URLSearchParams({ host: A, inst, wait: "20" }), reply);
			return { answers: reply.answers, counts: countsOf("poll.") };
		};
		assert.deepEqual(poll("icur"), { answers: [409], counts: { "poll.hello": 1 } });
		assert.deepEqual(model.hello({ v: 1, sid: "sid-1", host: A, inst: "icur" }), { status: 200, body: { v: 1, ok: true } });
		assert.deepEqual(poll("icur"), { answers: [], counts: { "poll.held": 1 } });
		assert.deepEqual(poll("istray"), { answers: [200], counts: { "poll.stray": 1 } });
		model.events({ sid: null, host: A, inst: "icur", seq: 1, events: [{ t: "turn.start", turn: "t1", at: 1 }, { t: "turn.end", turn: "t1", reason: "answer", at: 1 }] });
		assert.deepEqual(poll("icur"), { answers: [200], counts: { "poll.now": 1 } });
	});
});
