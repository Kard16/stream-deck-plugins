import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { deckRoot } from "./helpers/paths.js";

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(deckRoot(), file), "utf8")) as Record<string, unknown>;

describe("the plugin's version", () => {
	test("the manifest's Version is package.json's, with a fourth part of 0, and the lock file's matches", () => {
		const manifest = read("com.karimdhanji.claude.sdPlugin/manifest.json");
		const pkg = read("package.json");
		const lock = read("package-lock.json") as { version?: unknown; packages?: Record<string, { version?: unknown }> };
		assert.equal(manifest.Version, "0.3.2.0");
		assert.equal(manifest.Version, `${String(pkg.version)}.0`);
		assert.deepEqual([lock.version, lock.packages?.[""]?.version], [pkg.version, pkg.version]);
	});
});

describe("npm test (package.json's test script)", () => {
	test("gives every test a deadline of a minute at most, and exits once the last test has run: an answer that never comes fails its test instead of holding up the run", () => {
		const scripts = read("package.json").scripts as Record<string, unknown> | undefined;
		const script = String(scripts?.test ?? "");
		// node --test takes its flags before the files only: one after them is ignored, as `npm test -- --test-timeout=…` is.
		const run = /\bnode --test((?: --[a-z-]+(?:=\S+)?)*) build\/test\/test\/\*\.test\.js$/.exec(script);
		assert.ok(run, `the script runs node --test on the built tests, its flags first: ${script}`);
		const flags = (run[1] ?? "").trim().split(" ");
		const timeout = flags.find((f) => f.startsWith("--test-timeout="));
		const ms = Number(timeout?.slice("--test-timeout=".length));
		assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 60_000, `each test has a deadline (--test-timeout) of a minute at most: ${script}`);
		// A test that runs out of time never reaches its own clean-up, and what it left open would keep node running.
		assert.ok(flags.includes("--test-force-exit"), `the run ends with its last test (--test-force-exit): ${script}`);
	});
});
