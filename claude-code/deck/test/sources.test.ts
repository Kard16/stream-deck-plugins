import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { connectSources } from "../src/model/sources.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** An HTTP answer the test can read. */
class FakeReply implements PollReply {
	open = true;
	answers: { status: number; body: unknown }[] = [];
	send(status: number, body: string): void {
		this.open = false;
		this.answers.push({ status, body: JSON.parse(body) });
	}
	onClose(): void {}
}

describe("the model's sources, wired as the plugin wires them (connectSources)", () => {
	test("a hook's request or a hello from a session the latest reading doesn't list has the registry read once more, through the same watcher; the records follow the registry's hosts", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-sources-"));
		const registryDir = path.join(root, "sessions");
		const orgDir = path.join(root, "records", "account", "org");
		mkdirSync(registryDir);
		mkdirSync(orgDir, { recursive: true });
		const { registry, records, model } = connectSources({ registryDir, recordsDir: path.join(root, "records") });
		/** A session that starts after the latest scan: its file is there, and the deck hasn't read it. */
		const starts = (pid: number, host: string, sid: string): void =>
			writeFileSync(path.join(registryDir, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, hostSessionId: host, name: `Session ${pid}`, status: "busy", statusUpdatedAt: 1, startedAt: pid }));
		try {
			await registry.scanNow();
			assert.deepEqual(model.sessions(), []);

			starts(101, "local_a", "sid-a");
			writeFileSync(path.join(orgDir, "local_a.json"), JSON.stringify({ model: "claude-opus-5-5", effort: "max", permissionMode: "plan" }));
			const reply = new FakeReply();
			const taking = model.permission({ session_id: "sid-a", tool_name: "Bash", tool_input: { command: "ls" } }, "local_a", reply);
			assert.ok(taking instanceof Promise, "it reads the registry once more");
			await taking;
			assert.deepEqual([model.held.list().map((h) => [h.host, h.summary]), reply.answers], [[["local_a", "ls"]], []], "confirmed by that reading, and held");
			assert.deepEqual(
				model.sessions().map((s) => [s.key, s.status]),
				[["local_a", "approval"]],
			);
			// The reading's hosts went to the records watcher, which reads a new host's record at once.
			await records.scanNow();
			const a = model.session("local_a");
			assert.deepEqual([a?.model, a?.effort, a?.mode], ["claude-opus-5-5", "max", "plan"]);

			// A hello the latest reading doesn't confirm: read once more the same way, and taken.
			starts(102, "local_b", "sid-b");
			const hello = model.hello({ v: 1, sid: "sid-b", host: "local_b", inst: "ib", model: "claude-haiku-5-5" });
			assert.ok(hello instanceof Promise, "it reads the registry once more");
			assert.deepEqual(await hello, { status: 200, body: { v: 1, ok: true } });
			assert.deepEqual([model.session("local_b")?.plugin, model.session("local_b")?.model], [true, "claude-haiku-5-5"]);
		} finally {
			registry.stop();
			records.stop();
			model.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a registry folder that can't be listed changes nothing: no session ends, no request is released, no command fails, and the poll stays open; once it can be listed again, a file's going ends its session", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-sources-"));
		const registryDir = path.join(root, "sessions");
		mkdirSync(registryDir);
		mkdirSync(path.join(root, "records"));
		const file = path.join(registryDir, "101.json");
		writeFileSync(file, JSON.stringify({ pid: 101, sessionId: "sid-a", hostSessionId: "local_a", name: "Session 101", status: "busy", statusUpdatedAt: 1, startedAt: 101 }));
		const log = new RecordingLog();
		const { registry, records, model } = connectSources({ registryDir, recordsDir: path.join(root, "records"), logs: { registry: log, sessions: log } });
		try {
			await registry.scanNow();
			assert.deepEqual(await model.hello({ v: 1, sid: "sid-a", host: "local_a", inst: "ia", model: "m" }), { status: 200, body: { v: 1, ok: true } });
			const poll = (): FakeReply => {
				const reply = new FakeReply();
				model.next(new URLSearchParams({ sid: "sid-a", host: "local_a", inst: "ia", wait: "20" }), reply);
				return reply;
			};
			const queued = model.queue("local_a", { t: "prompt", text: "hi" });
			assert.ok(queued.ok);
			assert.equal(poll().answers.length, 1, "delivered");
			const open = poll();
			const request = new FakeReply();
			await model.permission({ session_id: "sid-a", tool_name: "Bash", tool_input: { command: "make" } }, "local_a", request);
			assert.equal(model.held.size, 1);

			chmodSync(registryDir, 0o000);
			try {
				// The test's own check that the folder can't be listed now (it can, for root).
				await assert.rejects(readdir(registryDir), { code: "EACCES" });
				for (let i = 0; i < 3; i++) await registry.scanNow();
				assert.deepEqual(model.sessions().map((s) => [s.key, s.status, s.plugin]), [["local_a", "approval", true]]);
				assert.deepEqual([request.answers, open.answers, queued.cmd.state, model.commands.polling("local_a")], [[], [], "delivered", true]);
				assert.deepEqual(
					log.at("warn").filter((l) => l.includes("can't list")),
					[`warn can't list ${registryDir} (EACCES): keeping the last reading, of 1 session(s), until it can`],
				);
			} finally {
				chmodSync(registryDir, 0o755);
			}
			await registry.scanNow();
			assert.ok(log.at("info").includes(`info ${registryDir} is readable again`), log.at("info").join("\n"));
			assert.deepEqual([request.answers, open.answers, queued.cmd.state], [[], [], "delivered"]);
			rmSync(file);
			await registry.scanNow();
			assert.deepEqual(model.sessions(), []);
			assert.deepEqual([request.answers, open.answers.length, queued.cmd.state, queued.cmd.error], [[{ status: 200, body: {} }], 1, "failed", "the session ended"]);
		} finally {
			registry.stop();
			records.stop();
			model.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a registry folder that can't be listed keeps the latest reading, not the first: a session that started since stays, with its held request, its command and its poll", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-sources-"));
		const registryDir = path.join(root, "sessions");
		mkdirSync(registryDir);
		mkdirSync(path.join(root, "records"));
		const starts = (pid: number, host: string, sid: string): void =>
			writeFileSync(path.join(registryDir, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, hostSessionId: host, name: `Session ${pid}`, status: "busy", statusUpdatedAt: 1, startedAt: pid }));
		starts(101, "local_a", "sid-a");
		const log = new RecordingLog();
		const { registry, records, model } = connectSources({ registryDir, recordsDir: path.join(root, "records"), logs: { registry: log, sessions: log } });
		try {
			await registry.scanNow();
			// A second session starts after the first reading, and the next reading lists it.
			starts(102, "local_b", "sid-b");
			await registry.scanNow();
			assert.deepEqual(await model.hello({ v: 1, sid: "sid-b", host: "local_b", inst: "ib", model: "m" }), { status: 200, body: { v: 1, ok: true } });
			const poll = (): FakeReply => {
				const reply = new FakeReply();
				model.next(new URLSearchParams({ sid: "sid-b", host: "local_b", inst: "ib", wait: "20" }), reply);
				return reply;
			};
			const queued = model.queue("local_b", { t: "prompt", text: "hi" });
			assert.ok(queued.ok);
			assert.equal(poll().answers.length, 1, "delivered");
			const open = poll();
			const request = new FakeReply();
			await model.permission({ session_id: "sid-b", tool_name: "Bash", tool_input: { command: "make" } }, "local_b", request);
			assert.equal(model.held.size, 1);
			const shown = (): unknown[] => model.sessions().map((s) => [s.key, s.status, s.plugin]);
			assert.deepEqual(shown(), [
				["local_a", "working", false],
				["local_b", "approval", true],
			]);

			chmodSync(registryDir, 0o000);
			try {
				await assert.rejects(readdir(registryDir), { code: "EACCES" });
				for (let i = 0; i < 3; i++) await registry.scanNow();
				assert.deepEqual(shown(), [
					["local_a", "working", false],
					["local_b", "approval", true],
				]);
				assert.deepEqual([request.answers, open.answers, queued.cmd.state, model.commands.polling("local_b")], [[], [], "delivered", true]);
				assert.ok(!log.lines.some((l) => l.message.startsWith("ENDED")), log.at("info").join("\n"));
				assert.deepEqual(
					log.at("warn").filter((l) => l.includes("can't list")),
					[`warn can't list ${registryDir} (EACCES): keeping the last reading, of 2 session(s), until it can`],
				);
			} finally {
				chmodSync(registryDir, 0o755);
			}
		} finally {
			registry.stop();
			records.stop();
			model.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the slotted sessions' records are read too, while the registry doesn't list them, and a slot lets go of one whose record file is gone", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-sources-"));
		const registryDir = path.join(root, "sessions");
		const orgDir = path.join(root, "records", "account", "org");
		mkdirSync(registryDir);
		mkdirSync(orgDir, { recursive: true });
		writeFileSync(path.join(orgDir, "local_asleep.json"), JSON.stringify({ title: "Asleep", model: "claude-opus-5-5", isArchived: false }));
		const { registry, records, model } = connectSources({ registryDir, recordsDir: path.join(root, "records") });
		const slots = new Slots(model, { store: new MemorySlotStore(new Map([["dev:1:0", "local_asleep"], ["dev:1:1", "local_gone"]])), fillDelayMs: 0 });
		try {
			assert.deepEqual(model.hosts(), ["local_asleep", "local_gone"], "the saved slots' hosts, before any reading");
			await registry.scanNow();
			await records.scanNow();
			assert.deepEqual(model.hosts(), ["local_asleep"]);
			const asleep = model.slotView("local_asleep");
			assert.deepEqual([asleep?.title, asleep?.running, asleep?.model], ["Asleep", false, "claude-opus-5-5"]);
			assert.deepEqual(slots.entries(), [["dev:1:0", "local_asleep"]], "no file and not listed: let go");
			assert.equal(model.recordMissing("local_gone"), false, "and its record is no longer looked for");
			// Archived in the app: the slot lets it go at the next scan that sees the change.
			writeFileSync(path.join(orgDir, "local_asleep.json"), JSON.stringify({ title: "Asleep", isArchived: true }));
			await records.scanNow();
			assert.deepEqual(slots.entries(), []);
		} finally {
			slots.dispose();
			registry.stop();
			records.stop();
			model.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
