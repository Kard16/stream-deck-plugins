import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonical, cutSummary, fingerprint, fnv1a32, summary } from "../src/protocol/fingerprint.js";
import { loadVectors } from "./helpers/fixtures.js";

describe("fingerprints and summaries (fixtures/vectors.json)", () => {
	const vectors = loadVectors();

	test("vectors.json has the protocol's 22 cases", () => {
		assert.equal(vectors.length, 22);
	});

	for (const v of vectors) {
		test(`${v.tool} ${JSON.stringify(v.input).slice(0, 60)}`, () => {
			assert.equal(canonical(v.input), v.canonical, "canonical");
			assert.equal(fingerprint(v.tool, v.input), v.fp, "fp");
			assert.equal(summary(v.tool, v.input), v.summary, "summary");
		});
	}

	test("fnv1a32 of the empty string is the offset basis", () => {
		assert.equal(fnv1a32(""), 0x811c9dc5);
		assert.equal(fingerprint("", {}).length, 8);
	});

	test("summaries are cut to 39 code units and an ellipsis", () => {
		assert.equal(cutSummary("x".repeat(40)), "x".repeat(40));
		assert.equal(cutSummary("x".repeat(41)), `${"x".repeat(39)}…`);
		assert.equal(summary("Bash", { command: 7 }), "Bash", "a field that isn't a string reads as missing");
		assert.equal(summary("Read", null), "Read");
	});
});
