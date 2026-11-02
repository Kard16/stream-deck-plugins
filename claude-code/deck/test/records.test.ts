import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { sessionStatus } from "../src/model/status.js";
import { nodeRecordsFs, parseRecord, RecordsReader, type RecordsFs, RecordsWatcher } from "../src/records/records.js";
import { RecordingLog } from "./helpers/recording-log.js";

const A = "local_5e3575bb-5693-4e5e-8e5e-47ddebcaa318";
const B = "local_b";
const C = "local_c";
/** The uuid of a record's last assistant message. */
const LAST = "9b1f0000-0000-4000-8000-0000000000aa";

/** A record's fields as the app writes them on this Mac (app 4.4212.0), values made up. */
function record(host: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sessionId: host,
		cliSessionId: "3fa86955-0000-4000-8000-00000000000a",
		cwd: "/Users/me/sandbox",
		lastFocusedAt: 1_793_573_111_660,
		model: "claude-haiku-5-5",
		effort: "low",
		isArchived: false,
		title: "Deck spike S0",
		permissionMode: "acceptEdits",
		completedTurns: 23,
		lastAssistantUuid: LAST,
		postTurnSummaryFor: LAST,
		postTurnSummary: { status_category: "completed", status_detail: "replied ok", needs_action: "", summarizes_uuid: "x" },
		...fields,
	};
}

/** The real file system, recording what it reads. */
class SpyFs implements RecordsFs {
	readonly reads: string[] = [];
	readdir(dir: string): Promise<string[]> {
		return nodeRecordsFs.readdir(dir);
	}
	stat(file: string): ReturnType<RecordsFs["stat"]> {
		return nodeRecordsFs.stat(file);
	}
	readFile(file: string): Promise<string> {
		this.reads.push(file);
		return nodeRecordsFs.readFile(file);
	}
}

describe("app records (claude-code-sessions/<account>/<org>/<host>.json), against a temp folder", () => {
	const top = mkdtempSync(path.join(os.tmpdir(), "claude-deck-records-"));
	after(() => rmSync(top, { recursive: true, force: true }));
	let root: string;
	let org: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(top, "case-"));
		org = path.join(root, "account-1", "org-1");
		mkdirSync(org, { recursive: true });
	});
	const write = (dir: string, host: string, body: unknown): void => {
		const file = path.join(dir, `${host}.json`);
		writeFileSync(`${file}.tmp`, typeof body === "string" ? body : JSON.stringify(body));
		renameSync(`${file}.tmp`, file);
	};

	test("reads the fields the deck uses, and the last turn's category as the app's needs-input indicator reads it", async () => {
		write(org, A, record(A));
		// The shape of two records on this Mac: the summary says blocked, with a sentence in needs_action, but the
		// wrap-up under it doesn't ask the user anything, so the app shows the turn as ready for review.
		write(org, B, record(B, { title: "Other", postTurnSummary: { status_category: "blocked", needs_action: "squash-merge PR #99 (go)" }, turnWrapUp: { description: "x" } }));
		// The wrap-up asks the user something: the app shows that turn as blocked.
		write(org, C, record(C, { postTurnSummary: { status_category: "blocked", needs_action: "Merge PR #12?" }, turnWrapUp: { description: "Opened PR #12.", needsUser: "Merge PR #12?" } }));
		const records = await new RecordsReader(root).scan([A, B, C]);
		assert.deepEqual(records.get(A), {
			host: A,
			title: "Deck spike S0",
			model: "claude-haiku-5-5",
			effort: "low",
			permissionMode: "acceptEdits",
			lastFocusedAt: 1_793_573_111_660,
			turnCategory: "completed",
		});
		assert.equal(records.get(B)?.turnCategory, "review_ready");
		assert.equal(records.get(C)?.turnCategory, "blocked");
	});

	test("only the listed hosts are read, each once until its file changes", async () => {
		write(org, A, record(A));
		write(org, B, record(B));
		const fs = new SpyFs();
		const reader = new RecordsReader(root, { fs });
		assert.deepEqual([...(await reader.scan([A])).keys()], [A]);
		await reader.scan([A]);
		assert.deepEqual(fs.reads, [path.join(org, `${A}.json`)]);
		write(org, A, record(A, { permissionMode: "plan" }));
		assert.equal((await reader.scan([A])).get(A)?.permissionMode, "plan");
		assert.equal(fs.reads.length, 2);
	});

	test("ids that aren't the app's never become paths", async () => {
		const fs = new SpyFs();
		const reader = new RecordsReader(root, { fs });
		const records = await reader.scan(["../../etc/passwd", "local_../x", ""]);
		assert.equal(records.size, 0);
		assert.deepEqual(fs.reads, []);
	});

	test("a half-written file keeps the last good record; a moved one is found again", async () => {
		write(org, A, record(A));
		const reader = new RecordsReader(root);
		assert.equal((await reader.scan([A])).get(A)?.model, "claude-haiku-5-5");
		write(org, A, '{"model": "claude-opus');
		assert.equal((await reader.scan([A])).get(A)?.model, "claude-haiku-5-5");
		rmSync(path.join(org, `${A}.json`));
		const other = path.join(root, "account-1", "org-2");
		mkdirSync(other);
		write(other, A, record(A, { model: "claude-opus-5-5" }));
		assert.equal((await reader.scan([A])).get(A)?.model, "claude-opus-5-5");
	});

	test("a missing folder is no records, logged once", async () => {
		const log = new RecordingLog();
		const reader = new RecordsReader(path.join(root, "nope"), { log });
		assert.equal((await reader.scan([A])).size, 0);
		assert.equal((await reader.scan([A])).size, 0);
		assert.equal(log.lines.filter((l) => l.level === "warn").length, 1);
	});

	test("the watcher reads new hosts at once and tells listeners only about changes", async () => {
		write(org, A, record(A));
		const watcher = new RecordsWatcher(new RecordsReader(root));
		const seen: string[][] = [];
		watcher.onChange((records) => seen.push([...records.values()].map((r) => `${r.host}:${r.permissionMode}`)));
		watcher.setHosts([A]);
		await watcher.scanNow();
		await watcher.scanNow();
		write(org, A, record(A, { permissionMode: "auto" }));
		await watcher.scanNow();
		assert.deepEqual(seen, [[`${A}:acceptEdits`], [`${A}:auto`]]);
	});
});

describe("status rule 6, the app's own needs-input indicator (its _D, Dw and jM), from a record's shape", () => {
	/** The record's turn category, and the status it gives an idle session the bridge knows nothing of. */
	const read = (fields: Record<string, unknown>): { category: string | null; status: string } => {
		const category = parseRecord(A, JSON.stringify(fields))?.turnCategory ?? null;
		return { category, status: sessionStatus({ heldTool: 0, heldAsk: 0, registry: "idle", statusUpdatedAt: null, firstReadingAt: null, turn: null, recordCategory: category }) };
	};
	const forLast = { postTurnSummaryFor: LAST, lastAssistantUuid: LAST };
	const blocked = { status_category: "blocked", needs_action: "Merge PR #12?" };

	test("a summary not written for the last assistant message doesn't count", () => {
		assert.deepEqual(read({ postTurnSummary: blocked, ...forLast }), { category: "blocked", status: "needs-you" });
		// The session went on after the summary was written: a newer assistant message.
		assert.deepEqual(read({ postTurnSummary: blocked, postTurnSummaryFor: "8c2e0000-0000-4000-8000-0000000000bb", lastAssistantUuid: LAST }), { category: null, status: "idle" });
		assert.deepEqual(read({ postTurnSummary: blocked, postTurnSummaryFor: LAST }), { category: null, status: "idle" });
		assert.deepEqual(read({ postTurnSummary: blocked }), { category: null, status: "idle" });
		// The app's loader keeps only string ids.
		assert.deepEqual(read({ postTurnSummary: blocked, postTurnSummaryFor: 7, lastAssistantUuid: 7 }), { category: null, status: "idle" });
	});

	test("a wrap-up whose needsUser isn't a string is ignored, as is one without a string description", () => {
		const completed = { status_category: "completed", needs_action: "" };
		// The app's loader drops it, so the summary for the last assistant message decides, or nothing does.
		assert.deepEqual(read({ turnWrapUp: { description: "Opened PR #12.", needsUser: true }, postTurnSummary: completed, ...forLast }), { category: "completed", status: "idle" });
		assert.deepEqual(read({ turnWrapUp: { description: "Opened PR #12.", needsUser: null }, postTurnSummary: completed, ...forLast }), { category: "completed", status: "idle" });
		assert.deepEqual(read({ turnWrapUp: { description: "Opened PR #12.", needsUser: ["Merge?"] }, postTurnSummary: blocked }), { category: null, status: "idle" });
		for (const wrapUp of [{ needsUser: "Merge?" }, { description: 1, needsUser: "Merge?" }, "Opened PR #12.", ["Opened PR #12."], null]) {
			assert.deepEqual(read({ turnWrapUp: wrapUp, postTurnSummary: completed, ...forLast }), { category: "completed", status: "idle" }, JSON.stringify(wrapUp));
		}
	});

	test("a failed summary stays failed, whatever its wrap-up says", () => {
		const failed = { status_category: "failed", needs_action: "Retry the push?" };
		assert.deepEqual(read({ turnWrapUp: { description: "The push failed.", needsUser: "Retry the push?" }, postTurnSummary: failed }), { category: "failed", status: "idle" });
		assert.deepEqual(read({ turnWrapUp: { description: "The push failed." }, postTurnSummary: failed }), { category: "failed", status: "idle" });
		assert.deepEqual(read({ postTurnSummary: failed, ...forLast }), { category: "failed", status: "idle" });
	});

	test("a wrap-up without needsUser turns blocked or need_input into review_ready, so not needs-you", () => {
		assert.deepEqual(read({ turnWrapUp: { description: "Opened PR #12." }, postTurnSummary: blocked, ...forLast }), { category: "review_ready", status: "idle" });
		assert.deepEqual(read({ turnWrapUp: { description: "" }, postTurnSummary: { status_category: "need_input", needs_action: "Pick one." } }), { category: "review_ready", status: "idle" });
		// Other categories stay as they are.
		assert.deepEqual(read({ turnWrapUp: { description: "Done." }, postTurnSummary: { status_category: "completed", needs_action: "" } }), { category: "completed", status: "idle" });
	});

	test("a wrap-up with needsUser is blocked, even an empty one, and counts without a summary for the last message", () => {
		const completed = { status_category: "completed", needs_action: "" };
		assert.deepEqual(read({ turnWrapUp: { description: "Opened PR #12.", needsUser: "Merge it?" } }), { category: "blocked", status: "needs-you" });
		assert.deepEqual(read({ turnWrapUp: { description: "", needsUser: "" }, postTurnSummary: completed, postTurnSummaryFor: "8c2e0000-0000-4000-8000-0000000000bb", lastAssistantUuid: LAST }), { category: "blocked", status: "needs-you" });
	});

	test("need_input counts, as blocked does; other categories don't", () => {
		assert.deepEqual(read({ postTurnSummary: { status_category: "need_input", needs_action: "" }, ...forLast }), { category: "need_input", status: "needs-you" });
		assert.deepEqual(read({ postTurnSummary: { status_category: "review_ready", needs_action: "Review it." }, ...forLast }), { category: "review_ready", status: "idle" });
		assert.deepEqual(read({ postTurnSummary: { status_category: "completed", needs_action: "Merge it?" }, ...forLast }), { category: "completed", status: "idle" });
		assert.deepEqual(read({ postTurnSummary: { needs_action: "Merge it?" }, ...forLast }), { category: null, status: "idle" });
	});
});
