import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { isSessionFile, nodeRegistryFs, parseSession, RegistryReader, type RegistryFs } from "../src/registry/registry.js";
import { RegistryWatcher } from "../src/registry/watcher.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** A real registry file's fields, as the kickoff checks found them (values made up). */
function entry(pid: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		pid,
		sessionId: `0000000${pid}-aaaa-bbbb-cccc-dddddddddddd`,
		cwd: `/Users/me/Projects/p${pid}`,
		startedAt: 1_793_550_000_000 + pid,
		version: "2.1.309",
		entrypoint: "claude-desktop",
		hostSessionId: `local_${pid}`,
		messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
		name: `Session ${pid}`,
		status: "idle",
		statusUpdatedAt: 1_793_551_000_000,
		...fields,
	};
}

/** The real file system, recording every path it reads. */
class SpyFs implements RegistryFs {
	readonly reads: string[] = [];
	readonly stats: string[] = [];
	readdir(dir: string): Promise<string[]> {
		return nodeRegistryFs.readdir(dir);
	}
	stat(file: string): ReturnType<RegistryFs["stat"]> {
		this.stats.push(file);
		return nodeRegistryFs.stat(file);
	}
	readFile(file: string): Promise<string> {
		this.reads.push(file);
		return nodeRegistryFs.readFile(file);
	}
}

describe("registry reader (~/.claude/sessions/*.json), against a temp folder", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-registry-"));
	after(() => rmSync(root, { recursive: true, force: true }));
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(root, "case-")); // a fresh, empty folder per test
	});
	const write = (name: string, body: unknown): void => writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));

	test("adds, changes and removes sessions as their files come, change and go", async () => {
		const reader = new RegistryReader(dir);
		assert.deepEqual(await reader.scan(), []);

		write("1701.json", entry(1701));
		let list = await reader.scan();
		assert.equal(list.length, 1);
		assert.deepEqual(list[0], {
			key: "1701",
			name: "Session 1701",
			status: "idle",
			cwd: "/Users/me/Projects/p1701",
			hostSessionId: "local_1701",
			sessionId: "00000001701-aaaa-bbbb-cccc-dddddddddddd",
			statusUpdatedAt: 1_793_551_000_000,
			startedAt: 1_793_550_001_701,
		});

		write("1805.json", entry(1805, { status: "busy" }));
		list = await reader.scan();
		assert.deepEqual(
			list.map((s) => [s.key, s.status]),
			[
				["1701", "idle"],
				["1805", "busy"],
			],
		);

		write("1701.json", entry(1701, { status: "busy", name: "Renamed", statusUpdatedAt: 1_793_551_000_500 }));
		list = await reader.scan();
		assert.deepEqual(
			list.map((s) => [s.key, s.name, s.status, s.statusUpdatedAt]),
			[
				["1701", "Renamed", "busy", 1_793_551_000_500],
				["1805", "Session 1805", "busy", 1_793_551_000_000],
			],
		);

		unlinkSync(path.join(dir, "1805.json"));
		list = await reader.scan();
		assert.deepEqual(
			list.map((s) => s.key),
			["1701"],
		);
	});

	test("never reads the .key files beside the sessions, or anything else that isn't .json", async () => {
		write("1701.json", entry(1701));
		write("1701.39a9e9211cfa12b677f12122828477fd20435a479baa4a526f9fa2cf523e554a.key", "SECRET-KEY-MATERIAL");
		write("notes.txt", "not a session");
		const fs = new SpyFs();
		const list = await new RegistryReader(dir, { fs }).scan();
		assert.deepEqual(
			list.map((s) => s.key),
			["1701"],
		);
		assert.deepEqual(fs.reads, [path.join(dir, "1701.json")]);
		assert.deepEqual(fs.stats, [path.join(dir, "1701.json")]);
		assert.equal(isSessionFile("1701.abc.key"), false);
		assert.equal(isSessionFile("1701.json"), true);
	});

	test("a half-written file keeps its last good record until it parses again", async () => {
		const log = new RecordingLog();
		const reader = new RegistryReader(dir, { log });
		write("1701.json", entry(1701, { status: "busy" }));
		write("1805.json", entry(1805));
		const good = await reader.scan();
		assert.equal(good.length, 2);

		// Caught mid-write: truncated JSON, then an empty file (truncate before write).
		write("1701.json", JSON.stringify(entry(1701, { status: "idle" })).slice(0, 40));
		assert.deepEqual(await reader.scan(), good, "truncated: the last good record stays");
		write("1701.json", "");
		assert.deepEqual(await reader.scan(), good, "empty: the last good record stays");
		assert.ok(log.lines.some((l) => l.level === "debug" && /1701\.json doesn't parse .*keeping its last good record/.test(l.message)));

		write("1701.json", entry(1701, { status: "idle" }));
		const after = await reader.scan();
		assert.equal(after.find((s) => s.key === "1701")?.status, "idle", "complete again: the new record");
	});

	test("a new file that's still half-written is left out until it parses", async () => {
		const reader = new RegistryReader(dir);
		write("1701.json", entry(1701));
		write("1805.json", '{"pid":1805,"name":"Hal');
		assert.deepEqual(
			(await reader.scan()).map((s) => s.key),
			["1701"],
		);
		write("1805.json", entry(1805));
		assert.deepEqual(
			(await reader.scan()).map((s) => s.key),
			["1701", "1805"],
		);
	});

	test("an unchanged file isn't read again", async () => {
		write("1701.json", entry(1701));
		const fs = new SpyFs();
		const reader = new RegistryReader(dir, { fs });
		await reader.scan();
		await reader.scan();
		await reader.scan();
		assert.equal(fs.reads.length, 1);
		assert.equal(fs.stats.length, 3);
	});

	test("missing fields and fields of the wrong type are null; the list is ordered by start", async () => {
		write("300.json", { startedAt: 30 });
		write("200.json", { name: 5, status: ["busy"], cwd: null, hostSessionId: {}, statusUpdatedAt: "soon", startedAt: 20 });
		write("100.json", entry(100, { startedAt: 10 }));
		write("400.json", "[1, 2, 3]");
		const list = await new RegistryReader(dir).scan();
		assert.deepEqual(
			list.map((s) => s.key),
			["100", "200", "300"],
			"by startedAt; the array isn't a session",
		);
		const nulls = { name: null, status: null, cwd: null, hostSessionId: null, sessionId: null, statusUpdatedAt: null };
		assert.deepEqual(list[1], { key: "200", ...nulls, startedAt: 20 });
		assert.deepEqual(list[2], { key: "300", ...nulls, startedAt: 30 });
	});

	test("a missing folder is an empty list, logged once", async () => {
		const log = new RecordingLog();
		const reader = new RegistryReader(path.join(dir, "nope"), { log });
		assert.deepEqual(await reader.scan(), []);
		assert.deepEqual(await reader.scan(), []);
		assert.equal(log.lines.filter((l) => l.level === "warn").length, 1);
		assert.match(log.lines[0]?.message ?? "", /ENOENT/);
	});

	test("a folder that can't be listed for another reason than ENOENT gives the last reading again, warned of once, until it can; then it's readable again, at info", async () => {
		write("1701.json", entry(1701));
		write("1805.json", entry(1805, { status: "busy" }));
		let fail: string | null = null;
		const fs: RegistryFs = { ...nodeRegistryFs, readdir: (d) => (fail === null ? nodeRegistryFs.readdir(d) : Promise.reject(Object.assign(new Error(`${fail}: listing ${d}`), { code: fail }))) };
		const log = new RecordingLog();
		const reader = new RegistryReader(dir, { fs, log });
		const good = await reader.scan();
		assert.equal(good.length, 2);
		fail = "EACCES";
		for (let i = 0; i < 5; i++) assert.deepEqual(await reader.scan(), good, `scan ${i}`);
		fail = "EIO";
		assert.deepEqual(await reader.scan(), good, "another reason, the same streak");
		assert.deepEqual(log.at("warn"), [`warn can't list ${dir} (EACCES): keeping the last reading, of 2 session(s), until it can`]);
		// Listed again: the folder as it is now.
		fail = null;
		unlinkSync(path.join(dir, "1805.json"));
		assert.deepEqual(
			(await reader.scan()).map((s) => s.key),
			["1701"],
		);
		assert.deepEqual(
			log.lines.filter((l) => l.level === "info").map((l) => l.message),
			[`${dir} is readable again`],
		);
		// A folder that's gone is no sessions, warned of once too, and that's the last reading from then on.
		fail = "ENOENT";
		assert.deepEqual(await reader.scan(), []);
		assert.deepEqual(await reader.scan(), []);
		fail = "EPERM";
		assert.deepEqual(await reader.scan(), [], "the last reading, after ENOENT");
		assert.deepEqual(log.at("warn").slice(1), [`warn can't list ${dir} (ENOENT): no sessions`, `warn can't list ${dir} (EPERM): keeping the last reading, of 0 session(s), until it can`]);
	});

	test("a folder that can't be listed gives back the latest reading, not an older one: what changed, ended or started since the first stays as last read", async () => {
		write("1701.json", entry(1701));
		write("1805.json", entry(1805));
		let fail = false;
		const fs: RegistryFs = { ...nodeRegistryFs, readdir: (d) => (fail ? Promise.reject(Object.assign(new Error(`EACCES: listing ${d}`), { code: "EACCES" })) : nodeRegistryFs.readdir(d)) };
		const log = new RecordingLog();
		const reader = new RegistryReader(dir, { fs, log });
		assert.deepEqual(
			(await reader.scan()).map((s) => [s.key, s.status]),
			[
				["1701", "idle"],
				["1805", "idle"],
			],
		);
		// Since the first reading, 1701 has turned busy, 1805 has ended and 1902 has started.
		write("1701.json", entry(1701, { status: "busy", statusUpdatedAt: 1_793_551_000_500 }));
		unlinkSync(path.join(dir, "1805.json"));
		write("1902.json", entry(1902));
		const latest = await reader.scan();
		assert.deepEqual(
			latest.map((s) => [s.key, s.status]),
			[
				["1701", "busy"],
				["1902", "idle"],
			],
		);
		fail = true;
		for (let i = 0; i < 3; i++) assert.deepEqual(await reader.scan(), latest, `scan ${i}`);
		assert.deepEqual(log.at("warn"), [`warn can't list ${dir} (EACCES): keeping the last reading, of 2 session(s), until it can`]);
	});

	test("a first reading that can't list the folder has no last reading to keep: no sessions", async () => {
		write("1701.json", entry(1701));
		const fs: RegistryFs = { ...nodeRegistryFs, readdir: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) };
		const log = new RecordingLog();
		assert.deepEqual(await new RegistryReader(dir, { fs, log }).scan(), []);
		assert.deepEqual(log.at("warn"), [`warn can't list ${dir} (EACCES): keeping the last reading, of 0 session(s), until it can`]);
	});

	test("a file that can't be read keeps its last good reading, and a new one is left out, each warned of once until it reads again", async () => {
		write("1701.json", entry(1701, { status: "busy" }));
		const blocked = new Set<string>();
		const fs: RegistryFs = {
			...nodeRegistryFs,
			readFile: (f) => (blocked.has(path.basename(f)) ? Promise.reject(Object.assign(new Error(`EACCES: ${f}`), { code: "EACCES" })) : nodeRegistryFs.readFile(f)),
		};
		const log = new RecordingLog();
		const reader = new RegistryReader(dir, { fs, log });
		const good = await reader.scan();
		// It changes, so the reader reads it again, and can't; and a new file can't be read either.
		write("1701.json", entry(1701, { status: "idle", name: "Changed" }));
		write("1805.json", entry(1805));
		blocked.add("1701.json");
		blocked.add("1805.json");
		for (let i = 0; i < 4; i++) assert.deepEqual(await reader.scan(), good, `scan ${i}`);
		assert.deepEqual(log.at("warn"), [
			`warn can't read ${path.join(dir, "1701.json")} (EACCES): keeping its last good reading until it can`,
			`warn can't read ${path.join(dir, "1805.json")} (EACCES): leaving it out until it can`,
		]);
		blocked.clear();
		assert.deepEqual(
			(await reader.scan()).map((s) => [s.key, s.status]),
			[
				["1701", "idle"],
				["1805", "idle"],
			],
		);
		// A new streak warns again.
		write("1701.json", entry(1701, { status: "busy" }));
		blocked.add("1701.json");
		await reader.scan();
		await reader.scan();
		assert.equal(log.at("warn").length, 3);
	});

	test("the watcher tells listeners only when something changed", async () => {
		const watcher = new RegistryWatcher(new RegistryReader(dir));
		const seen: string[][] = [];
		watcher.onChange((list) => seen.push(list.map((s) => `${s.key}:${s.status}`)));
		await watcher.scanNow();
		write("1701.json", entry(1701));
		await watcher.scanNow();
		await watcher.scanNow();
		write("1701.json", entry(1701, { status: "busy" }));
		await watcher.scanNow();
		assert.deepEqual(seen, [[], ["1701:idle"], ["1701:busy"]]);
	});

	test("parseSession rejects anything but a JSON object", () => {
		assert.equal(parseSession("1", ""), null);
		assert.equal(parseSession("1", "null"), null);
		assert.equal(parseSession("1", '"busy"'), null);
		assert.equal(parseSession("1", "{"), null);
		assert.equal(parseSession("1", "{}")?.key, "1");
	});
});
