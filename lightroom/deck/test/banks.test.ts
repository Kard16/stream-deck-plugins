import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { DEFAULT_BANKS, loadBanksFile, parseBanks, slotAt, variantFor, watchList } from "../src/banks.js";
import { deckRoot } from "./helpers/wait.js";

const shipped = path.join(deckRoot(), "com.karimdhanji.lightroom.sdPlugin", "banks.json");

const oneBank = (slots: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ banks: [slots], ...extra });

describe("banks", () => {
	test("the shipped banks.json is valid and equals the built-in defaults", () => {
		const { config, errors } = parseBanks(readFileSync(shipped, "utf8"));
		assert.deepEqual(errors, []);
		assert.deepEqual(config, DEFAULT_BANKS);
	});

	test("defaults: 4 banks of 4 in Basic-panel order; bank 4 is Vignette and 3 empty slots", () => {
		assert.deepEqual(
			DEFAULT_BANKS.banks.map((bank) => bank.map((s) => s?.param ?? null)),
			[
				["Temperature", "Tint", "Exposure", "Contrast"],
				["Highlights", "Shadows", "Whites", "Blacks"],
				["Texture", "Clarity", "Vibrance", "Saturation"],
				["PostCropVignetteAmount", null, null, null],
			],
		);
		assert.equal(slotAt(DEFAULT_BANKS, 3, 0)?.label, "Vignette");
		assert.equal(slotAt(DEFAULT_BANKS, 3, 1), null);
		assert.equal(slotAt(DEFAULT_BANKS, 9, 0), null);
	});

	test("default steps follow the plan: Exposure 1/30 EV, Temperature 50 K on raw and 1 on rendered, the rest 1; fine is a quarter", () => {
		const exposure = slotAt(DEFAULT_BANKS, 0, 2);
		const temp = slotAt(DEFAULT_BANKS, 0, 0);
		const contrast = slotAt(DEFAULT_BANKS, 0, 3);
		assert.ok(exposure && temp && contrast);
		assert.equal(exposure.step, 1 / 30);
		assert.equal(exposure.fine, 1 / 120);
		assert.equal(exposure.precision, 2);
		assert.deepEqual(
			{ ...variantFor(temp, [2000, 50000]) },
			{ step: 50, fine: 12.5, precision: 0, unit: "K", signed: false },
		);
		assert.equal(variantFor(temp, [-100, 100]).step, 1);
		assert.equal(contrast.step, 1);
		assert.equal(contrast.fine, 0.25);
		assert.equal(DEFAULT_BANKS.acceleration, 0.5);
	});

	test("the watch list is every bank param once, in bank order", () => {
		assert.deepEqual(watchList(DEFAULT_BANKS), [
			"Temperature",
			"Tint",
			"Exposure",
			"Contrast",
			"Highlights",
			"Shadows",
			"Whites",
			"Blacks",
			"Texture",
			"Clarity",
			"Vibrance",
			"Saturation",
			"PostCropVignetteAmount",
		]);
		const dup = parseBanks(JSON.stringify({ banks: [[{ param: "Exposure", label: "E", step: 1 }], [{ param: "Exposure", label: "E2", step: 2 }]] }));
		assert.deepEqual(watchList(dup.config), ["Exposure"]);
	});

	test("short banks are padded with empty slots; fractions, defaults and kelvin defaults apply", () => {
		const { config, errors } = parseBanks(
			oneBank([{ param: "Exposure", label: "EV", step: "1/20" }, { param: "Temperature", label: "WB", step: 2, kelvin: { step: 100 } }], { acceleration: 0 }),
		);
		assert.deepEqual(errors, []);
		const bank = config.banks[0];
		assert.ok(bank);
		assert.equal(bank.length, 4);
		assert.equal(bank[2], null);
		assert.deepEqual(bank[0], { param: "Exposure", label: "EV", step: 0.05, fine: 0.0125, precision: 0, unit: "", signed: true, kelvin: null });
		assert.deepEqual(bank[1]?.kelvin, { step: 100, fine: 25, precision: 0, unit: "K", signed: false });
		assert.equal(config.acceleration, 0);
	});

	const invalid: [string, string, RegExp][] = [
		["not JSON", "{ banks: [", /not valid JSON/],
		["no banks", JSON.stringify({ acceleration: 1 }), /banks must be a list/],
		["too many slots", oneBank([null, null, null, null, { param: "Exposure", label: "E", step: 1 }]), /1 to 4 slots/],
		["a bank of only empty slots", oneBank([null, null]), /has no slots/],
		["a bad param name", oneBank([{ param: "Exposure 2012", label: "E", step: 1 }]), /param must be/],
		["a missing label", oneBank([{ param: "Exposure", step: 1 }]), /label must be/],
		["a zero step", oneBank([{ param: "Exposure", label: "E", step: 0 }]), /step must be a positive number/],
		["a bad fraction", oneBank([{ param: "Exposure", label: "E", step: "1/0" }]), /step must be/],
		["a negative fine step", oneBank([{ param: "Exposure", label: "E", step: 1, fine: -1 }]), /fine must be/],
		["a bad precision", oneBank([{ param: "Exposure", label: "E", step: 1, precision: 9 }]), /precision must be/],
		["a misspelt field", oneBank([{ param: "Exposure", label: "E", stpe: 1, step: 1 }]), /stpe isn't a slot field/],
		["a bad kelvin", oneBank([{ param: "Temperature", label: "T", step: 1, kelvin: { step: -50 } }]), /kelvin\.step/],
		["an unknown top-level field", JSON.stringify({ banks: [[{ param: "Exposure", label: "E", step: 1 }]], bnaks: [] }), /bnaks isn't a top-level field/],
		["a bad acceleration", oneBank([{ param: "Exposure", label: "E", step: 1 }], { acceleration: -1 }), /acceleration must be/],
	];
	for (const [what, text, message] of invalid) {
		test(`an invalid file falls back to the built-in banks: ${what}`, () => {
			const { config, errors } = parseBanks(text);
			assert.equal(config, DEFAULT_BANKS);
			assert.ok(
				errors.some((e) => message.test(e)),
				`errors ${JSON.stringify(errors)} should match ${message}`,
			);
		});
	}

	test("help text and _comment fields are allowed", () => {
		const { errors } = parseBanks(JSON.stringify({ help: ["hi"], _comment: "x", $schema: "y", banks: [[{ param: "Exposure", label: "E", step: 1 }]] }));
		assert.deepEqual(errors, []);
	});

	test("loadBanksFile warns and uses the defaults when the file is missing or invalid, and is quiet when it's fine", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "deck-banks-"));
		try {
			const missing = loadBanksFile(path.join(dir, "nope.json"));
			assert.equal(missing.config, DEFAULT_BANKS);
			assert.match(missing.warnings[0] ?? "", /ENOENT/);
			const bad = path.join(dir, "bad.json");
			writeFileSync(bad, oneBank([{ param: "Exposure", label: "E", step: -1 }]));
			const invalid = loadBanksFile(bad);
			assert.equal(invalid.config, DEFAULT_BANKS);
			assert.match(invalid.warnings[0] ?? "", /built-in banks are in use: .*step must be a positive number/);
			const fine = loadBanksFile(shipped);
			assert.deepEqual(fine.warnings, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
