import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { connectSources } from "../src/model/sources.js";

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
});
