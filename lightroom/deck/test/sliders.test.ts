import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { DEFAULT_SLIDERS, defaultParam, loadSlidersFile, parseSliders, type Slider, sliderFor, variantFor, watchList } from "../src/sliders.js";
import { deckRoot } from "./helpers/wait.js";

const shipped = path.join(deckRoot(), "com.karimdhanji.lightroom.sdPlugin", "sliders.json");

const file = (sliders: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ sliders, ...extra });
const exposure = { param: "Exposure", label: "E", step: 1 };

const builtIn = (param: string): Slider => {
	const s = sliderFor(DEFAULT_SLIDERS, param);
	assert.ok(s, `${param} is built in`);
	return s;
};

describe("sliders", () => {
	test("the shipped sliders.json is valid and equals the built-in 17", () => {
		const { config, errors } = parseSliders(readFileSync(shipped, "utf8"));
		assert.deepEqual(errors, []);
		assert.deepEqual(config, DEFAULT_SLIDERS);
	});

	test("the built-in 17, in Lightroom's panel order, with the plan's labels", () => {
		assert.deepEqual(
			DEFAULT_SLIDERS.sliders.map((s) => [s.param, s.label]),
			[
				["Temperature", "Temp"],
				["Tint", "Tint"],
				["Exposure", "Exposure"],
				["Contrast", "Contrast"],
				["Highlights", "Highlights"],
				["Shadows", "Shadows"],
				["Whites", "Whites"],
				["Blacks", "Blacks"],
				["Texture", "Texture"],
				["Clarity", "Clarity"],
				["Dehaze", "Dehaze"],
				["Vibrance", "Vibrance"],
				["Saturation", "Saturation"],
				["Sharpness", "Sharpening"],
				["LuminanceSmoothing", "Noise"],
				["PostCropVignetteAmount", "Vignette"],
				["GrainAmount", "Grain"],
			],
		);
		assert.equal(DEFAULT_SLIDERS.acceleration, 0.5);
		assert.equal(DEFAULT_SLIDERS.macroSeconds, 2);
	});

	test("the built-in steps follow the plan: normal, fine and big, signed or not", () => {
		const steps = (v: { step: number; fine: number; macro: number }): number[] => [v.step, v.fine, v.macro];
		const exposure = builtIn("Exposure");
		assert.deepEqual(steps(exposure), [1 / 30, 1 / 120, 1 / 3]);
		assert.deepEqual([exposure.precision, exposure.signed, exposure.kelvin], [2, true, null]);
		const temp = builtIn("Temperature");
		assert.deepEqual(steps(variantFor(temp, [-100, 100])), [1, 0.25, 10], "rendered files: slider units");
		assert.deepEqual({ ...variantFor(temp, [2000, 50000]) }, { step: 50, fine: 12.5, macro: 500, precision: 0, unit: "K", signed: false }, "raw files: Kelvin");
		for (const p of ["Tint", "Contrast", "Highlights", "Shadows", "Whites", "Blacks", "Texture", "Clarity", "Dehaze", "Vibrance", "Saturation", "PostCropVignetteAmount"]) {
			const s = builtIn(p);
			assert.deepEqual([...steps(s), s.precision, s.unit, s.signed, s.kelvin], [1, 0.25, 10, 0, "", true, null], p);
		}
		for (const p of ["Sharpness", "LuminanceSmoothing", "GrainAmount"]) {
			const s = builtIn(p);
			assert.deepEqual([...steps(s), s.precision, s.unit, s.signed, s.kelvin], [1, 0.25, 10, 0, "", false, null], `${p} is unsigned`);
		}
	});

	test("the watch list is every slider's param, in list order", () => {
		assert.deepEqual(
			watchList(DEFAULT_SLIDERS),
			DEFAULT_SLIDERS.sliders.map((s) => s.param),
		);
		assert.equal(watchList(DEFAULT_SLIDERS).length, 17);
		const { config } = parseSliders(file([exposure, { param: "Dehaze", label: "D", step: 1 }]));
		assert.deepEqual(watchList(config), ["Exposure", "Dehaze"]);
	});

	test("a dial's default: Temperature, Tint, Exposure, Contrast for columns 1–4, else the first slider", () => {
		assert.deepEqual(
			[0, 1, 2, 3, 4, 7].map((c) => defaultParam(DEFAULT_SLIDERS, c)),
			["Temperature", "Tint", "Exposure", "Contrast", "Temperature", "Temperature"],
		);
		const { config } = parseSliders(file([{ param: "Dehaze", label: "D", step: 1 }, exposure]));
		assert.deepEqual(
			[0, 1, 2, 3, 4].map((c) => defaultParam(config, c)),
			["Dehaze", "Dehaze", "Exposure", "Dehaze", "Dehaze"],
			"a column whose default the file doesn't list gets the first slider",
		);
	});

	test("defaults: fine is a quarter step, macro ten steps (kelvin too), and the display fields as before", () => {
		const { config, errors } = parseSliders(file([{ param: "Temperature", label: "WB", step: 2, kelvin: { step: 100 } }, exposure], { acceleration: 0 }));
		assert.deepEqual(errors, []);
		const [wb, e] = config.sliders;
		assert.deepEqual(wb, {
			param: "Temperature",
			label: "WB",
			step: 2,
			fine: 0.5,
			macro: 20,
			precision: 0,
			unit: "",
			signed: true,
			kelvin: { step: 100, fine: 25, macro: 1000, precision: 0, unit: "K", signed: false },
		});
		assert.deepEqual(e, { param: "Exposure", label: "E", step: 1, fine: 0.25, macro: 10, precision: 0, unit: "", signed: true, kelvin: null });
		assert.equal(config.acceleration, 0);
		assert.equal(config.macroSeconds, 2, "macroSeconds defaults to 2");
	});

	test("step, fine and macro take fractions; macro needn't be ten steps", () => {
		const { config, errors } = parseSliders(
			file([
				{ param: "Exposure", label: "EV", step: "1/20", macro: "1/3" },
				{ param: "Contrast", label: "C", step: 2, fine: "1/2", macro: 5, kelvin: null },
				{ param: "Temperature", label: "T", step: 1, kelvin: { step: 50, macro: "1000/4" } },
			]),
		);
		assert.deepEqual(errors, []);
		const [ev, c, t] = config.sliders;
		assert.deepEqual([ev?.step, ev?.fine, ev?.macro], [0.05, 0.0125, 1 / 3]);
		assert.deepEqual([c?.step, c?.fine, c?.macro, c?.kelvin], [2, 0.5, 5, null]);
		assert.deepEqual([t?.kelvin?.step, t?.kelvin?.fine, t?.kelvin?.macro], [50, 12.5, 250]);
		assert.equal(t?.macro, 10, "the base macro is still 10 × its own step");
	});

	test("macroSeconds from 0.5 to 10", () => {
		for (const s of [0.5, 1.25, 2, 10]) {
			const { config, errors } = parseSliders(file([exposure], { macroSeconds: s }));
			assert.deepEqual(errors, [], String(s));
			assert.equal(config.macroSeconds, s);
		}
		for (const s of [0.4, 0, -1, 10.5, 60, "2", null, true]) {
			const { config, errors } = parseSliders(file([exposure], { macroSeconds: s }));
			assert.equal(config, DEFAULT_SLIDERS, JSON.stringify(s));
			assert.match(errors.join("; "), /macroSeconds must be a number of seconds from 0\.5 to 10/, JSON.stringify(s));
		}
	});

	test("1 to 64 sliders", () => {
		const many = (n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => ({ param: `P${i}`, label: `P${i}`, step: 1 }));
		assert.deepEqual(parseSliders(file(many(64))).errors, []);
		assert.match(parseSliders(file(many(65))).errors.join(), /sliders must be a list of 1 to 64 sliders/);
		assert.match(parseSliders(file([])).errors.join(), /sliders must be a list of 1 to 64 sliders/);
	});

	test("help text and _comment and $schema fields are allowed", () => {
		const { errors } = parseSliders(file([exposure], { help: ["one", "two"], _comment: "x", $schema: "y" }));
		assert.deepEqual(errors, []);
	});

	const invalid: [string, string, RegExp][] = [
		["not JSON", "{ sliders: [", /not valid JSON/],
		["not an object", "[1, 2]", /JSON object with a sliders list/],
		["no sliders", JSON.stringify({ acceleration: 1 }), /sliders must be a list/],
		["the old banks", JSON.stringify({ banks: [[exposure]] }), /banks isn't a top-level field/],
		["a null slider", file([exposure, null]), /sliders\[1\] must be a slider object/],
		["a duplicate param", file([exposure, { param: "Contrast", label: "C", step: 1 }, { ...exposure, label: "E2" }]), /sliders\[2\]\.param Exposure is already sliders\[0\]/],
		["a bad param name", file([{ ...exposure, param: "Exposure 2012" }]), /param must be/],
		["a missing label", file([{ param: "Exposure", step: 1 }]), /label must be/],
		["a missing step", file([{ param: "Exposure", label: "E", macro: 10 }]), /step must be a positive number/],
		["a zero step", file([{ ...exposure, step: 0 }]), /step must be a positive number/],
		["a bad fraction", file([{ ...exposure, step: "1/0" }]), /step must be/],
		["a negative fine step", file([{ ...exposure, fine: -1 }]), /fine must be/],
		["a zero macro", file([{ ...exposure, macro: 0 }]), /macro must be a positive number/],
		["a bad macro fraction", file([{ ...exposure, macro: "a third" }]), /macro must be a positive number or a fraction/],
		["a bad precision", file([{ ...exposure, precision: 9 }]), /precision must be/],
		["a misspelt field", file([{ ...exposure, macor: 10 }]), /sliders\[0\]\.macor isn't a slider field/],
		["an unknown kelvin field", file([{ param: "Temperature", label: "T", step: 1, kelvin: { step: 50, label: "K" } }]), /kelvin\.label isn't a slider field/],
		["a bad kelvin macro", file([{ param: "Temperature", label: "T", step: 1, kelvin: { step: 50, macro: -500 } }]), /kelvin\.macro must be/],
		["an unknown top-level field", file([exposure], { macroSecs: 3 }), /macroSecs isn't a top-level field/],
		["a bad acceleration", file([exposure], { acceleration: -1 }), /acceleration must be/],
		["help that isn't a list of strings", file([exposure], { help: "hi" }), /help must be a list of strings/],
	];
	for (const [what, text, message] of invalid) {
		test(`an invalid file falls back to the built-in 17: ${what}`, () => {
			const { config, errors } = parseSliders(text);
			assert.equal(config, DEFAULT_SLIDERS);
			assert.ok(
				errors.some((e) => message.test(e)),
				`errors ${JSON.stringify(errors)} should match ${message}`,
			);
		});
	}

	test("loadSlidersFile warns and uses the built-in 17 when the file is missing or invalid, and is quiet when it's fine", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "deck-sliders-"));
		try {
			const missing = loadSlidersFile(path.join(dir, "nope.json"));
			assert.equal(missing.config, DEFAULT_SLIDERS);
			assert.match(missing.warnings[0] ?? "", /ENOENT/);
			assert.match(missing.warnings[0] ?? "", /using the built-in sliders/);
			const bad = path.join(dir, "bad.json");
			writeFileSync(bad, file([{ ...exposure, macro: -1 }, exposure], { macroSeconds: 20 }));
			const invalid = loadSlidersFile(bad);
			assert.equal(invalid.config, DEFAULT_SLIDERS);
			assert.equal(invalid.warnings.length, 1);
			assert.match(invalid.warnings[0] ?? "", /built-in sliders are in use: .*macroSeconds must be.*macro must be a positive number.*already sliders\[0\]/);
			const fine = loadSlidersFile(shipped);
			assert.deepEqual(fine.warnings, []);
			assert.deepEqual(fine.config, DEFAULT_SLIDERS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
