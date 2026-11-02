import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { nodeRecordsFs, parseRecord, RecordsReader, type RecordsFs, RecordsWatcher } from "../src/records/records.js";
import { RecordingLog } from "./helpers/recording-log.js";

const A = "local_5e3575bb-5693-4e5e-8e5e-47ddebcaa318";
const B = "local_b";
const C = "local_c";

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

	test("reads the fields the deck uses; a turn needs the user as the app reads it, with strings where it writes sentences", async () => {
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
			needsUser: false,
		});
		assert.equal(records.get(B)?.needsUser, false);
		assert.equal(records.get(C)?.needsUser, true);
		const needsUser = (fields: Record<string, unknown>): boolean | undefined => parseRecord(A, JSON.stringify(fields))?.needsUser;
		// With a wrap-up that has a string description, only its needsUser counts, when true or a non-empty string.
		assert.equal(needsUser({ turnWrapUp: { description: "d", needsUser: "yes" } }), true);
		assert.equal(needsUser({ turnWrapUp: { description: "", needsUser: true }, postTurnSummary: { needs_action: "" } }), true);
		assert.equal(needsUser({ turnWrapUp: { description: "d", needsUser: "" }, postTurnSummary: { needs_action: "x" } }), false);
		assert.equal(needsUser({ turnWrapUp: { description: "d" }, postTurnSummary: { needs_action: true } }), false);
		// Without one, needs_action counts, the same way.
		assert.equal(needsUser({ postTurnSummary: { needs_action: true } }), true);
		assert.equal(needsUser({ postTurnSummary: { needs_action: " " } }), true);
		assert.equal(needsUser({ postTurnSummary: { needs_action: "" } }), false);
		assert.equal(needsUser({ postTurnSummary: { needs_action: false } }), false);
		// A wrap-up without a string description isn't one: its needsUser doesn't count, and needs_action does.
		assert.equal(needsUser({ turnWrapUp: { needsUser: "yes" } }), false);
		assert.equal(needsUser({ turnWrapUp: { description: 1, needsUser: "yes" }, postTurnSummary: { needs_action: "x" } }), true);
		assert.equal(needsUser({ turnWrapUp: "d", postTurnSummary: { needs_action: "x" } }), true);
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
