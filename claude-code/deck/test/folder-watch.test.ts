import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { RecordsReader, RecordsWatcher, recordsEventCounts } from "../src/records/records.js";
import { RegistryReader, type RegistrySession } from "../src/registry/registry.js";
import { RegistryWatcher, registryEventCounts } from "../src/registry/watcher.js";
import { FolderWatch, type ScanReason, SAFETY_SCAN_MS, WATCH_DEBOUNCE_MS, type WatchFn, type WatchHandle } from "../src/util/folder-watch.js";
import { idleCounts, resetIdleCounts } from "../src/util/idle.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** One watch the fake hands out: the test sends its events and errors. Like Node's FSWatcher, it closes only when told to. */
class FakeHandle implements WatchHandle {
	closed = false;
	readonly #errors: ((err: Error) => void)[] = [];
	constructor(readonly emit: (name: string | null) => void) {}
	on(_event: "error", listener: (err: Error) => void): this {
		this.#errors.push(listener);
		return this;
	}
	close(): void {
		this.closed = true;
	}
	fail(err: Error): void {
		for (const fn of this.#errors) fn(err);
	}
}

/** fs.watch's stand-in: each call hands out a FakeHandle, or throws while `failWith` is set. */
class FakeWatch {
	readonly calls: { dir: string; recursive: boolean }[] = [];
	readonly handles: FakeHandle[] = [];
	failWith: string | null = null;
	readonly fn: WatchFn = (dir, opts, onEvent) => {
		this.calls.push({ dir, recursive: opts.recursive });
		if (this.failWith !== null) throw Object.assign(new Error(`watch ${this.failWith}`), { code: this.failWith });
		const handle = new FakeHandle(onEvent);
		this.handles.push(handle);
		return handle;
	};
	get last(): FakeHandle {
		const h = this.handles.at(-1);
		assert.ok(h, "a watch");
		return h;
	}
}

function setup(opts: { accept?: (name: string | null) => boolean; failWith?: string } = {}) {
	const clock = new FakeClock();
	const log = new RecordingLog();
	const fake = new FakeWatch();
	fake.failWith = opts.failWith ?? null;
	const scans: { why: ScanReason; quiet: boolean; at: number }[] = [];
	const t0 = clock.now();
	const watch = new FolderWatch("/x/sessions", { accept: opts.accept, onScan: (why, quiet) => scans.push({ why, quiet, at: clock.now() - t0 }), count: "t", clock, log, watch: fake.fn });
	return { clock, log, fake, scans, watch };
}

describe("the folder watch (hardening.md, B4)", () => {
	beforeEach(() => resetIdleCounts());

	test("a burst of events is one scan, WATCH_DEBOUNCE_MS after its first; an event it doesn't accept sets off nothing; every event is counted", () => {
		assert.equal(WATCH_DEBOUNCE_MS, 50);
		const { clock, fake, scans, watch } = setup({ accept: (name) => name !== "skip" });
		watch.start();
		assert.deepEqual([fake.calls, watch.watching], [[{ dir: "/x/sessions", recursive: false }], true]);
		for (let i = 0; i < 5; i++) {
			fake.last.emit(`${i}.json`);
			clock.advance(5);
		}
		clock.advance(WATCH_DEBOUNCE_MS - 26);
		assert.deepEqual(scans, []);
		clock.advance(1);
		assert.deepEqual(scans, [{ why: "event", quiet: false, at: WATCH_DEBOUNCE_MS }]);
		fake.last.emit("skip");
		fake.last.emit("skip");
		clock.advance(1000);
		assert.equal(scans.length, 1, "not accepted: no scan");
		// One a burst: the next event after the scan starts another.
		fake.last.emit(null);
		clock.advance(WATCH_DEBOUNCE_MS);
		assert.equal(scans.length, 2);
		assert.deepEqual(idleCounts(), { "t.event": 8 });
		watch.stop();
	});

	test("a safety scan every SAFETY_SCAN_MS whatever the watch says, quiet when no event it accepted came since the scan before", () => {
		assert.equal(SAFETY_SCAN_MS, 30_000);
		const { clock, fake, scans, watch } = setup();
		watch.start();
		clock.advance(SAFETY_SCAN_MS);
		assert.deepEqual(scans, [{ why: "safety", quiet: true, at: 30_000 }]);
		fake.last.emit("a.json");
		clock.advance(SAFETY_SCAN_MS);
		assert.deepEqual(scans.slice(1), [
			{ why: "event", quiet: false, at: 30_000 + WATCH_DEBOUNCE_MS },
			{ why: "safety", quiet: true, at: 60_000 },
		]);
		// An event whose scan hasn't run yet when the safety scan does: that one isn't quiet.
		clock.advance(SAFETY_SCAN_MS - 10);
		fake.last.emit("b.json");
		clock.advance(10);
		assert.deepEqual(scans.at(-1), { why: "safety", quiet: false, at: 90_000 });
		clock.advance(WATCH_DEBOUNCE_MS);
		assert.equal(scans.at(-1)?.why, "event");
		assert.equal(idleCounts()["t.safety"], 3);
		assert.equal(fake.calls.length, 1, "still the one watch");
		watch.stop();
	});

	test("a folder that isn't there: no watch, logged once at info; each safety scan reads it and tries again, and watches it once it's there", () => {
		const { clock, log, fake, scans, watch } = setup({ failWith: "ENOENT" });
		watch.start();
		assert.equal(watch.watching, false);
		clock.advance(2 * SAFETY_SCAN_MS);
		assert.deepEqual(
			scans.map((s) => s.why),
			["safety", "safety"],
		);
		assert.equal(fake.calls.length, 3, "at the start and at each safety scan");
		assert.deepEqual(log.at("info"), ["info can't watch /x/sessions (ENOENT): the safety scan reads it every 30 s, and tries to watch it again"]);
		fake.failWith = null;
		clock.advance(SAFETY_SCAN_MS);
		assert.equal(watch.watching, true);
		assert.equal(log.at("info").at(-1), "info watching /x/sessions again");
		fake.last.emit("1.json");
		clock.advance(WATCH_DEBOUNCE_MS);
		assert.deepEqual(
			scans.map((s) => s.why),
			["safety", "safety", "safety", "event"],
		);
		assert.ok(
			scans.every((s) => !s.quiet),
			"with no watch up before it, a safety scan's change was no watch's to announce",
		);
		watch.stop();
	});

	test("a watch that errors is dropped: a warn line, a scan at once for what it missed, and the next safety scan watches again; a dropped watch's events count for nothing", () => {
		const { clock, log, fake, scans, watch } = setup();
		watch.start();
		const first = fake.last;
		first.fail(new Error("EMFILE: too many open files"));
		assert.deepEqual([watch.watching, first.closed, scans.map((s) => s.why)], [false, true, ["event"]]);
		assert.deepEqual(log.at("warn"), ["warn /x/sessions: its watch failed: Error: EMFILE: too many open files; the safety scan reads it every 30 s, and tries to watch it again"]);
		first.emit("late.json");
		clock.advance(WATCH_DEBOUNCE_MS);
		assert.equal(scans.length, 1, "the dropped watch's event");
		clock.advance(SAFETY_SCAN_MS - WATCH_DEBOUNCE_MS);
		assert.deepEqual([watch.watching, fake.handles.length, scans.at(-1)?.why], [true, 2, "safety"]);
		assert.equal(log.at("info").at(-1), "info watching /x/sessions again");
		watch.stop();
	});

	test("missed: a safety scan found a change no event announced, so the watch may have gone quiet; counted, said at info the first time and at debug after, and the folder watched afresh", () => {
		const { clock, log, fake, watch } = setup();
		watch.start();
		const first = fake.last;
		watch.missed();
		assert.deepEqual([first.closed, fake.handles.length, watch.watching], [true, 2, true]);
		assert.deepEqual(log.at("info"), ["info the safety scan found a change in /x/sessions that no watch event announced: watching it afresh"]);
		watch.missed();
		assert.equal(fake.handles.length, 3);
		assert.equal(log.at("info").length, 1, "once at info");
		assert.equal(log.at("debug").at(-1), "debug the safety scan found a change in /x/sessions that no watch event announced: watching it afresh");
		assert.equal(idleCounts()["t.missed"], 2);
		// The new watch works as the first did.
		const timers = clock.pendingTimers;
		fake.last.emit("a.json");
		assert.equal(clock.pendingTimers, timers + 1, "its event's debounce");
		watch.stop();
	});

	test("stop closes the watch and the timers: nothing after it", () => {
		const { clock, log, fake, scans, watch } = setup();
		watch.start();
		watch.start();
		assert.equal(fake.calls.length, 1, "started once");
		fake.last.emit("a.json");
		watch.stop();
		assert.equal(fake.last.closed, true);
		clock.advance(5 * SAFETY_SCAN_MS);
		assert.deepEqual([scans, clock.pendingTimers, log.at("warn")], [[], 0, []]);
	});
});

describe("what the registry's and the records' watches take notice of", () => {
	test("the registry: everything but the .key files", () => {
		assert.deepEqual(
			["56532.json", "56532.json.tmp", "sessions", null, "56532.ed5bdb37.key"].map(registryEventCounts),
			[true, true, true, true, false],
		);
	});

	test("the records: a wanted host's <host>.json anywhere, and the root, an account's or an org's folder; not the rest of the tree", () => {
		const wanted = new Set(["local_a", "local_b"]);
		const yes = ["acct/org/local_a.json", "acct/org2/local_b.json", "claude-code-sessions", "acct", "acct/org", null];
		const no = ["acct/org/local_c.json", "acct/org/local_a.json.tmp", "acct/org/archived-sessions.idx", "acct/org/scheduled-tasks.json", "acct/org/backlog/tasks.json", "acct/org/deleted_5ddab6dd", "acct/org/waiting-input"];
		for (const name of yes) assert.equal(recordsEventCounts(name, wanted), true, String(name));
		for (const name of no) assert.equal(recordsEventCounts(name, wanted), false, String(name));
	});
});

/** A registry file's fields, as registry.test.ts writes them. */
function entry(pid: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { pid, sessionId: `sid-${pid}`, cwd: `/p/${pid}`, startedAt: pid, hostSessionId: `local_${pid}`, name: `Session ${pid}`, status: "idle", statusUpdatedAt: 1000, ...fields };
}

/** Waits, on the real clock, until `ok` holds or `ms` has passed; returns whether it held. */
async function until(ok: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) return false;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return true;
}

describe("the registry and records watchers, on their folders", () => {
	const top = mkdtempSync(path.join(os.tmpdir(), "claude-deck-watch-"));
	after(() => rmSync(top, { recursive: true, force: true }));
	beforeEach(() => resetIdleCounts());
	const atomically = (file: string, body: unknown): void => {
		writeFileSync(`${file}.tmp`, JSON.stringify(body));
		renameSync(`${file}.tmp`, file);
	};

	test("watching a real folder with fs.watch: a session's change reaches the listeners well under a second, its debug line says how long after its statusUpdatedAt, and the .key files set off nothing", async (t) => {
		const dir = mkdtempSync(path.join(top, "sessions-"));
		atomically(path.join(dir, "1701.json"), entry(1701));
		const log = new RecordingLog();
		const watcher = new RegistryWatcher(new RegistryReader(dir), { log });
		const seen: { at: number; sessions: RegistrySession[] }[] = [];
		watcher.onChange((sessions) => seen.push({ at: performance.now(), sessions }));
		try {
			watcher.start();
			assert.ok(await until(() => seen.length === 1, 2000), "the first reading");
			assert.equal(watcher.watching, true);
			// FSEvents can report the folder's making just after the watch starts: let that settle.
			await new Promise((resolve) => setTimeout(resolve, 200));
			const wrote = performance.now();
			const updated = Date.now();
			atomically(path.join(dir, "1701.json"), entry(1701, { status: "busy", statusUpdatedAt: updated }));
			assert.ok(await until(() => seen.length === 2, 2000), "the change, through the watch");
			const lag = (seen[1]?.at ?? Infinity) - wrote;
			t.diagnostic(`a registry change reached the listeners ${lag.toFixed(1)} ms after its write (the debounce is ${WATCH_DEBOUNCE_MS} ms)`);
			assert.ok(lag < 1000, `${lag} ms`);
			assert.equal(seen[1]?.sessions[0]?.status, "busy");
			const line = log.at("debug").find((l) => l.includes("a session changed"));
			assert.match(line ?? "", /^debug a session changed: 1701 idle → busy, read \d+ ms after its statusUpdatedAt$/);
			// A .key file comes and changes: an event, and no scan.
			await new Promise((resolve) => setTimeout(resolve, 200));
			resetIdleCounts();
			writeFileSync(path.join(dir, "1702.0f3a.key"), "never read");
			writeFileSync(path.join(dir, "1702.0f3a.key"), "never read, again");
			assert.ok(await until(() => (idleCounts()["reg.event"] ?? 0) > 0, 2000), "the watch saw it");
			await new Promise((resolve) => setTimeout(resolve, 3 * WATCH_DEBOUNCE_MS));
			assert.equal(idleCounts()["reg.scan"] ?? 0, 0);
		} finally {
			watcher.stop();
		}
	});

	test("a registry folder that appears after the start is watched from the next safety scan, which reads it", async () => {
		const dir = path.join(top, "later-sessions");
		const clock = new FakeClock();
		const log = new RecordingLog();
		const watcher = new RegistryWatcher(new RegistryReader(dir), { log, clock });
		const seen: number[] = [];
		watcher.onChange((sessions) => seen.push(sessions.length));
		try {
			watcher.start();
			await watcher.scanNow();
			assert.deepEqual([watcher.watching, seen], [false, [0]]);
			mkdirSync(dir);
			atomically(path.join(dir, "1801.json"), entry(1801));
			clock.advance(SAFETY_SCAN_MS);
			await watcher.scanNow();
			assert.deepEqual([watcher.watching, seen], [true, [0, 1]]);
			assert.ok(log.at("info").includes(`info watching ${dir} again`), log.at("info").join("\n"));
			assert.equal(idleCounts()["reg.missed"] ?? 0, 0, "no watch was up to miss it");
		} finally {
			watcher.stop();
		}
	});

	test("a safety scan that finds a change no watch event announced counts reg.missed, says so, and watches the folder afresh; one an event announced doesn't", async () => {
		const dir = mkdtempSync(path.join(top, "sessions-"));
		atomically(path.join(dir, "1901.json"), entry(1901));
		const clock = new FakeClock();
		const log = new RecordingLog();
		const fake = new FakeWatch();
		const watcher = new RegistryWatcher(new RegistryReader(dir), { log, clock, watch: fake.fn });
		try {
			watcher.start();
			await watcher.scanNow();
			// Announced: an event, its scan, then a quiet safety scan that finds nothing new.
			atomically(path.join(dir, "1901.json"), entry(1901, { status: "busy" }));
			fake.last.emit("1901.json");
			clock.advance(WATCH_DEBOUNCE_MS);
			await watcher.scanNow();
			clock.advance(SAFETY_SCAN_MS - WATCH_DEBOUNCE_MS);
			await watcher.scanNow();
			assert.equal(idleCounts()["reg.missed"] ?? 0, 0);
			// Missed: the file changes with no event, and the safety scan finds it.
			atomically(path.join(dir, "1901.json"), entry(1901, { status: "idle", statusUpdatedAt: 2000 }));
			clock.advance(SAFETY_SCAN_MS);
			await watcher.scanNow();
			assert.equal(idleCounts()["reg.missed"], 1);
			assert.ok(log.at("info").includes(`info the safety scan found a change in ${dir} that no watch event announced: watching it afresh`), log.at("info").join("\n"));
			assert.deepEqual([fake.handles.length, fake.handles[0]?.closed, watcher.watching], [2, true, true]);
			assert.equal(watcher.sessions[0]?.status, "idle");
		} finally {
			watcher.stop();
		}
	});

	test("the records: a change to the hosts reads at once; an event for a wanted host's file reads, one for any other file doesn't; the safety scan finds what no event announced, and watches afresh", async () => {
		const root = mkdtempSync(path.join(top, "records-"));
		const org = path.join(root, "acct", "org");
		mkdirSync(org, { recursive: true });
		const A = "local_a";
		const B = "local_b";
		const C = "local_c";
		atomically(path.join(org, `${A}.json`), { title: "A" });
		const clock = new FakeClock();
		const fake = new FakeWatch();
		const watcher = new RecordsWatcher(new RecordsReader(root), { clock, watch: fake.fn });
		try {
			watcher.start();
			assert.deepEqual(fake.calls, [{ dir: root, recursive: true }]);
			await watcher.setHosts([A, B]);
			assert.deepEqual([[...watcher.records.keys()], [...watcher.missing]], [[A], [B]]);
			// B's file comes. An event for another host's file, or the app's own files, sets off nothing; one for B's does.
			atomically(path.join(org, `${B}.json`), { title: "B" });
			resetIdleCounts();
			fake.last.emit("acct/org/local_z.json");
			fake.last.emit("acct/org/scheduled-tasks.json");
			clock.advance(WATCH_DEBOUNCE_MS);
			assert.equal(idleCounts()["rec.scan"] ?? 0, 0);
			fake.last.emit(`acct/org/${B}.json`);
			clock.advance(WATCH_DEBOUNCE_MS);
			assert.equal(idleCounts()["rec.scan"], 1);
			await watcher.scanNow();
			assert.deepEqual([[...watcher.records.keys()].sort(), [...watcher.missing]], [[A, B], []]);
			// C, wanted again and gone missing; its file comes with no event: the safety scan finds it.
			await watcher.setHosts([A, B, C]);
			assert.deepEqual([...watcher.missing], [C]);
			atomically(path.join(org, `${C}.json`), { title: "C" });
			clock.advance(SAFETY_SCAN_MS);
			await watcher.scanNow();
			assert.deepEqual([[...watcher.records.keys()].sort(), [...watcher.missing]], [[A, B, C], []]);
			assert.equal(idleCounts()["rec.missed"], 1, "a change no event announced");
			assert.deepEqual([fake.handles.length, fake.handles[0]?.closed], [2, true], "watched afresh");
		} finally {
			watcher.stop();
		}
	});
});
