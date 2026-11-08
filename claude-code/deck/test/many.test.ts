import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";

import { BridgeServer } from "../src/bridge/server.js";
import { PromptKeys } from "../src/keys/commands.js";
import { DecisionKeys } from "../src/keys/decision.js";
import { connectSources } from "../src/model/sources.js";
import { ALLOW_DECISION, DENY_DECISION } from "../src/protocol/wire.js";
import { RegistryReader } from "../src/registry/registry.js";
import { type Outcome, send, waitFor, within } from "./helpers/http.js";
import { RecordingLog } from "./helpers/recording-log.js";

/** How many sessions run at once. */
const N = 30;
const TOKEN = "many-sessions-token";
/** The fixtures' T0: 2026-11-02T06:13:20Z. */
const T0 = 1_793_600_000_000;

const pad = (i: number): string => String(i).padStart(2, "0");
const hostOf = (i: number): string => `local_many-${pad(i)}`;
const sidOf = (i: number): string => `3fa86955-0000-4000-8000-0000000000${pad(i)}`;
/** The registry's status for session i: a third each busy, idle and waiting. */
const registryStatus = (i: number): string => (i < 10 ? "busy" : i < 20 ? "idle" : "waiting");

function json(o: Outcome): unknown {
	return "status" in o && o.body !== "" ? JSON.parse(o.body) : o;
}

describe("30 sessions at once (Phase 6)", () => {
	test("through the real bridge on an ephemeral port: 30 registry files, 30 mods' hellos with 30 long polls open, held requests from several sessions answered oldest first by presses, a command reaching only its session, and each session's status", async (t) => {
		const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-many-"));
		const registryDir = path.join(root, "sessions");
		const recordsDir = path.join(root, "claude-code-sessions");
		const orgDir = path.join(recordsDir, "account", "org");
		mkdirSync(registryDir);
		mkdirSync(orgDir, { recursive: true });
		for (let i = 0; i < N; i++) {
			const entry = { pid: 2000 + i, sessionId: sidOf(i), cwd: `/Users/me/p${pad(i)}`, startedAt: T0 - 100_000 + i, version: "2.1.309", entrypoint: "claude-desktop", hostSessionId: hostOf(i), name: `Many ${pad(i)}`, status: registryStatus(i), statusUpdatedAt: T0 };
			writeFileSync(path.join(registryDir, `${2000 + i}.json`), JSON.stringify(entry));
			writeFileSync(path.join(orgDir, `${hostOf(i)}.json`), JSON.stringify({ model: "claude-haiku-5-5", effort: "low", permissionMode: "default", lastFocusedAt: T0 - 1000 + i }));
		}

		// One registry reading of the 30 files: the first, which reads each, and the later ones, which only stat each.
		const reader = new RegistryReader(registryDir);
		let started = performance.now();
		const first = await reader.scan();
		const cold = performance.now() - started;
		const warm: number[] = [];
		for (let i = 0; i < 21; i++) {
			started = performance.now();
			assert.equal((await reader.scan()).length, N);
			warm.push(performance.now() - started);
		}
		warm.sort((a, b) => a - b);
		const median = warm[10] ?? Number.NaN;
		t.diagnostic(`one registry reading of ${N} files: ${cold.toFixed(2)} ms the first time (each file read), ${median.toFixed(2)} ms after (median of 21; each file stat'ed); the deck reads it once a second`);
		assert.equal(first.length, N);
		assert.ok(cold < 1000 && median < 1000, `${cold} ms, ${median} ms`);

		let wall = T0;
		const log = new RecordingLog();
		const { registry, records, model } = connectSources({ registryDir, recordsDir, logs: { sessions: log }, model: { wallNow: () => ++wall } });
		const server = new BridgeServer({ port: 0, token: TOKEN, routes: model, log });
		server.onState((state) => model.setBridgeState(state));
		const surface = { setImage: () => {}, showOk: () => {}, showAlert: () => {} };
		const jumps: string[] = [];
		const approve = new DecisionKeys(model, "allow", { paintIntervalMs: 0, settleMs: 0, open: (h) => jumps.push(h) });
		const deny = new DecisionKeys(model, "deny", { paintIntervalMs: 0, settleMs: 0, open: (h) => jumps.push(h) });
		const prompts = new PromptKeys(model, { paintIntervalMs: 0 });
		const sent: ReturnType<typeof send>[] = [];
		try {
			await registry.scanNow();
			await records.scanNow();
			assert.deepEqual(
				model.sessions().map((s) => s.key),
				Array.from({ length: N }, (_, i) => hostOf(i)),
				"listed oldest first",
			);
			const port = await server.listen();
			approve.add("approve", surface);
			deny.add("deny", surface);
			prompts.add("prompt", surface, {});
			const request = (opts: Parameters<typeof send>[1]): Promise<Outcome> => {
				const r = send(port, { token: TOKEN, ...opts });
				sent.push(r);
				return r.outcome;
			};

			// 30 mods say hello at once.
			const hellos = await Promise.all(
				Array.from({ length: N }, (_, i) =>
					within(request({ path: "/v1/hello", body: JSON.stringify({ v: 1, sid: sidOf(i), host: hostOf(i), inst: `inst-${pad(i)}`, cwd: `/Users/me/p${pad(i)}`, model: "claude-haiku-5-5", plugin: "0.3.0", cc: "2.1.309" }) }), 2000),
				),
			);
			for (const [i, h] of hellos.entries()) assert.deepEqual(json(h), { v: 1, ok: true }, hostOf(i));
			assert.ok(model.sessions().every((s) => s.plugin));

			// 30 long polls, open at once.
			const polls = Array.from({ length: N }, (_, i) => request({ method: "GET", path: `/v1/next?sid=${sidOf(i)}&host=${hostOf(i)}&inst=inst-${pad(i)}&wait=20` }));
			const pending: (Outcome | null)[] = polls.map(() => null);
			polls.forEach((p, i) => void p.then((o) => (pending[i] = o)));
			await waitFor(() => Array.from({ length: N }, (_, i) => hostOf(i)).every((h) => model.commands.polling(h)), "30 polls to be held");

			// Held requests from four sessions, one at a time so their order is known: three tools, then a question.
			const asked: { i: number; tool: string; input: unknown }[] = [
				{ i: 3, tool: "Bash", input: { command: "make" } },
				{ i: 12, tool: "Write", input: { file_path: "/Users/me/p12/a.txt", content: "a" } },
				{ i: 25, tool: "Bash", input: { command: "npm test" } },
				{ i: 7, tool: "AskUserQuestion", input: { questions: [{ question: "Red or blue?" }] } },
			];
			const answers: Promise<Outcome>[] = [];
			for (const [k, a] of asked.entries()) {
				answers.push(request({ path: "/v1/permission", headers: { "x-deck-host": hostOf(a.i) }, body: JSON.stringify({ session_id: sidOf(a.i), hook_event_name: "PermissionRequest", tool_name: a.tool, tool_input: a.input, permission_mode: "default" }) }));
				await waitFor(() => model.held.size === k + 1, `request ${k + 1} to be held`);
			}
			assert.deepEqual(
				model.held.list().map((h) => [h.host, h.tool, h.kind]),
				asked.map((a) => [hostOf(a.i), a.tool, a.tool === "AskUserQuestion" ? "ask" : "tool"]),
			);

			// Each session's status: the registry's, and the held requests' first.
			const expected = (i: number, after: boolean): string => {
				if (!after && (i === 3 || i === 12 || i === 25)) return "approval";
				if (i === 7) return "needs-you";
				return registryStatus(i) === "busy" ? "working" : registryStatus(i) === "waiting" ? "needs-you" : "idle";
			};
			const statuses = (): string[] => Array.from({ length: N }, (_, i) => model.session(hostOf(i))?.status ?? "missing");
			assert.deepEqual(
				statuses(),
				Array.from({ length: N }, (_, i) => expected(i, false)),
			);

			// Presses answer the oldest held request first, across sessions, and only it.
			const settled = async (p: Promise<Outcome>): Promise<Outcome> => within(p, 50);
			approve.press("approve");
			assert.deepEqual(json(await within(answers[0] as Promise<Outcome>, 2000)), ALLOW_DECISION);
			assert.deepEqual([await settled(answers[1] as Promise<Outcome>), await settled(answers[2] as Promise<Outcome>)], [{ error: "pending" }, { error: "pending" }], "the younger ones wait");
			deny.press("deny");
			assert.deepEqual(json(await within(answers[1] as Promise<Outcome>, 2000)), DENY_DECISION);
			assert.deepEqual(await settled(answers[2] as Promise<Outcome>), { error: "pending" });
			approve.press("approve");
			assert.deepEqual(json(await within(answers[2] as Promise<Outcome>, 2000)), ALLOW_DECISION);
			// The question is the oldest now: a press jumps to its session and answers nothing.
			approve.press("approve");
			assert.deepEqual(jumps, [hostOf(7)]);
			assert.deepEqual(await settled(answers[3] as Promise<Outcome>), { error: "pending" });
			assert.deepEqual(
				model.held.list().map((h) => h.host),
				[hostOf(7)],
			);
			assert.deepEqual(
				statuses(),
				Array.from({ length: N }, (_, i) => expected(i, true)),
			);

			// A prompt for session 17 reaches its poll only.
			model.pick(hostOf(17), "the test");
			prompts.press("prompt", { text: "Only for 17." });
			const reached = await within(polls[17] as Promise<Outcome>, 2000);
			const cmds = (json(reached) as { cmds: { id: string; t: string; text: string }[] }).cmds;
			assert.deepEqual(
				cmds.map((c) => [c.t, c.text]),
				[["prompt", "Only for 17."]],
			);
			assert.equal(model.commands.get(cmds[0]?.id ?? "")?.host, hostOf(17));
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(
				pending.flatMap((o, i) => (o === null ? [] : [i])),
				[17],
				"every other session's poll is still open",
			);
			assert.ok(Array.from({ length: N }, (_, i) => i).every((i) => i === 17 || model.commands.polling(hostOf(i))));
		} finally {
			for (const r of sent) r.req.destroy();
			await server.stop();
			approve.remove("approve");
			deny.remove("deny");
			prompts.remove("prompt");
			registry.stop();
			records.stop();
			model.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
