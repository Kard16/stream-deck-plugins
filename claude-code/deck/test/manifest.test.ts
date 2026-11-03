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
		assert.equal(manifest.Version, "0.3.0.0");
		assert.equal(manifest.Version, `${String(pkg.version)}.0`);
		assert.deepEqual([lock.version, lock.packages?.[""]?.version], [pkg.version, pkg.version]);
	});
});
