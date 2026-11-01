import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { DEFAULT_LOG_LEVEL, loadLogLevelFile, LOG_LEVEL_FILE, parseLogLevel } from "../src/util/log-level.js";

describe("log level (an optional log-level.txt in the .sdPlugin folder, read at startup)", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "deck-log-level-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	test("info without the file: normal use logs at info", () => {
		assert.equal(DEFAULT_LOG_LEVEL, "info");
		assert.equal(LOG_LEVEL_FILE, "log-level.txt");
		assert.deepEqual(loadLogLevelFile(path.join(dir, "missing.txt")), { level: "info", warning: null });
	});

	test("the first word of the first line that isn't blank or a # comment, in any case", () => {
		assert.deepEqual(parseLogLevel("debug\n"), { level: "debug", error: null });
		assert.deepEqual(parseLogLevel("  TRACE  \r\n"), { level: "trace", error: null });
		assert.deepEqual(parseLogLevel("# debug adds the dial's TICK and INPUT lines\n\nWarn and the rest\n"), { level: "warn", error: null });
		const file = path.join(dir, LOG_LEVEL_FILE);
		writeFileSync(file, "debug\n");
		assert.deepEqual(loadLogLevelFile(file), { level: "debug", warning: null });
	});

	test("anything else means info, with a warning that says why", () => {
		assert.deepEqual(parseLogLevel("loud"), { level: "info", error: 'it says "loud", not one of error, warn, info, debug, trace' });
		assert.equal(parseLogLevel("").error, "it says nothing, not one of error, warn, info, debug, trace");
		assert.equal(parseLogLevel("# only a comment").level, "info");
		const file = path.join(dir, "bad.txt");
		writeFileSync(file, "verbose\n");
		const loaded = loadLogLevelFile(file);
		assert.equal(loaded.level, "info");
		assert.match(loaded.warning ?? "", /bad\.txt is invalid, so the log level is info: it says "verbose"/);
	});

	test("a file it can't read means info, with a warning", () => {
		const loaded = loadLogLevelFile(dir); // a directory: EISDIR
		assert.equal(loaded.level, "info");
		assert.match(loaded.warning ?? "", /couldn't read .* \(EISDIR\), so the log level is info/);
	});
});
