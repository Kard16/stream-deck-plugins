import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { checkBearer, loadOrCreateToken } from "../src/bridge/token.js";

const mode = (p: string): number => statSync(p).mode & 0o777;

describe("bridge token (run/token in the .sdPlugin folder)", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "claude-deck-token-"));
	after(() => rmSync(root, { recursive: true, force: true }));

	test("the first start creates it: 64 hex characters, the file 0600, the folder 0700", () => {
		const runDir = path.join(root, "a", "run");
		const loaded = loadOrCreateToken(runDir);
		assert.equal(loaded.created, true);
		assert.match(loaded.token, /^[0-9a-f]{64}$/);
		assert.equal(readFileSync(loaded.file, "utf8"), `${loaded.token}\n`);
		assert.equal(mode(loaded.file), 0o600);
		assert.equal(mode(runDir), 0o700);
		assert.deepEqual(readdirSync(runDir), ["token"], "no temp file left behind");
		assert.deepEqual(loaded.notes, []);
	});

	test("later starts reuse it, tightening loose modes", () => {
		const runDir = path.join(root, "b", "run");
		const first = loadOrCreateToken(runDir);
		chmodSync(first.file, 0o644);
		chmodSync(runDir, 0o755);
		const again = loadOrCreateToken(runDir);
		assert.equal(again.created, false);
		assert.equal(again.token, first.token);
		assert.equal(mode(again.file), 0o600);
		assert.equal(mode(runDir), 0o700);
		assert.equal(again.notes.length, 2);
		for (const note of again.notes) assert.ok(!note.includes(first.token));
	});

	test("a file that doesn't hold a token is replaced", () => {
		const runDir = path.join(root, "c", "run");
		loadOrCreateToken(runDir);
		writeFileSync(path.join(runDir, "token"), "\n");
		const loaded = loadOrCreateToken(runDir);
		assert.equal(loaded.created, true);
		assert.match(loaded.token, /^[0-9a-f]{64}$/);
		assert.match(loaded.notes[0] ?? "", /replaced/);
	});

	test("two plugins never share a token", () => {
		assert.notEqual(loadOrCreateToken(path.join(root, "d", "run")).token, loadOrCreateToken(path.join(root, "e", "run")).token);
	});

	test("checkBearer: Bearer <token>, the scheme in any case", () => {
		const token = "ab".repeat(32);
		assert.equal(checkBearer(`Bearer ${token}`, token), "ok");
		assert.equal(checkBearer(`bearer  ${token} `, token), "ok");
		assert.equal(checkBearer(undefined, token), "missing");
		assert.equal(checkBearer("  ", token), "missing");
		assert.equal(checkBearer(`Bearer ${token}x`, token), "wrong");
		assert.equal(checkBearer(`Basic ${token}`, token), "wrong");
		assert.equal(checkBearer("Bearer", token), "wrong");
		assert.equal(checkBearer(`Bearer ${token} extra`, token), "wrong");
	});
});
