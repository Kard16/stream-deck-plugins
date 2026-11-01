import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { flagKeySvg, presetKeySvg, svgDataUrl, wrapName } from "../src/keys/art.js";
import { FLAG_COMMAND, flagLook, presetLook, presetOutcome, viewLook } from "../src/keys/looks.js";
import { isPresetRequest, PresetCatalog, sortPresets } from "../src/keys/presets.js";
import { LrError } from "../src/lr/client.js";
import type { LrState } from "../src/model/model.js";
import { FakeLink } from "./helpers/fake-link.js";
import { RecordingLog } from "./helpers/recording-log.js";

const state = (flag: number | null, photo: string | null = "101"): LrState => ({
	module: "library",
	photo,
	file: photo ? "DSC.ARW" : null,
	flag,
	rating: 0,
	label: "none",
	sel: photo ? 1 : 0,
	locked: false,
});

describe("flag keys", () => {
	test("send pick, reject and none", () => {
		assert.deepEqual(FLAG_COMMAND, { pick: "pick", reject: "reject", unflag: "none" });
	});

	test("light up when the current photo has their flag", () => {
		const online = { conn: "online" as const, writable: true };
		assert.deepEqual(flagLook("pick", { ...online, state: state(1) }), { active: true, dim: false });
		assert.deepEqual(flagLook("reject", { ...online, state: state(1) }), { active: false, dim: false });
		assert.deepEqual(flagLook("reject", { ...online, state: state(-1) }), { active: true, dim: false });
		assert.deepEqual(flagLook("unflag", { ...online, state: state(0) }), { active: true, dim: false });
		assert.deepEqual(flagLook("unflag", { ...online, state: state(0, null) }), { active: false, dim: false }, "no photo, no flag");
	});

	test("dim when offline or read-only", () => {
		assert.deepEqual(flagLook("pick", { conn: "offline", writable: true, state: state(1) }), { active: false, dim: true });
		assert.deepEqual(flagLook("pick", { conn: "busy", writable: true, state: state(1) }), { active: false, dim: true });
		assert.deepEqual(flagLook("pick", { conn: "online", writable: false, state: state(1) }), { active: true, dim: true });
	});

	test("images differ between idle, active and dimmed", () => {
		const looks = [
			{ active: false, dim: false },
			{ active: true, dim: false },
			{ active: false, dim: true },
		];
		const images = new Set(looks.map((l) => flagKeySvg("pick", l)));
		assert.equal(images.size, 3);
		assert.match(flagKeySvg("pick", { active: true, dim: false }), /Picked/);
		assert.match(svgDataUrl("<svg/>"), /^data:image\/svg\+xml;base64,/);
	});
});

describe("view and preset keys", () => {
	test("Next, Previous and Before/After dim only when Lightroom isn't online", () => {
		assert.deepEqual(viewLook({ conn: "online" }), { active: false, dim: false });
		assert.deepEqual(viewLook({ conn: "offline" }, true), { active: true, dim: true });
		assert.deepEqual(presetLook({ conn: "online", writable: false }), { active: false, dim: true });
	});

	test("Apply Preset shows ok when the preset reached photos and none was locked; alert otherwise", () => {
		assert.equal(presetOutcome({ n: 2, locked: 0 }), "ok");
		assert.equal(presetOutcome({ n: 1, locked: 1 }), "alert");
		assert.equal(presetOutcome({ n: 0, locked: 0 }), "alert");
	});

	test("the key shows the preset's name, escaped and wrapped", () => {
		assert.match(presetKeySvg("Classic & Chrome", { dim: false }), /Classic &amp;/);
		assert.match(presetKeySvg(null, { dim: false }), /Choose/);
		assert.deepEqual(wrapName("Classic Chrome"), { lines: ["Classic", "Chrome"], fontSize: 24 });
		const long = wrapName("A very long preset name that keeps on going and going");
		assert.ok(long.lines.length <= 3 && long.lines.every((l) => l.length <= 14), JSON.stringify(long));
	});
});

describe("preset catalog (the Property Inspector's list)", () => {
	const items = [
		{ uuid: "B", name: "Velvia", folder: "Cobalt Fuji" },
		{ uuid: "A", name: "Classic Chrome", folder: "Cobalt Fuji" },
		{ uuid: "C", name: "Preset 10", folder: "Adobe" },
		{ uuid: "D", name: "Preset 2", folder: "Adobe" },
	];

	test("recognises the PI's request", () => {
		assert.equal(isPresetRequest({ t: "getPresets", refresh: true }), true);
		assert.equal(isPresetRequest({ t: "other" }), false);
		assert.equal(isPresetRequest(null), false);
	});

	test("lists presets by folder then name, in natural order", () => {
		assert.deepEqual(
			sortPresets(items).map((i) => i.uuid),
			["D", "C", "A", "B"],
		);
	});

	test("asks Lightroom with the presets command, and keeps the last list when Lightroom can't answer", async () => {
		const link = new FakeLink();
		let calls = 0;
		link.onRequest = async (cmd) => {
			calls += 1;
			assert.equal(cmd.t, "presets");
			if (calls === 2) throw new LrError("timeout", "slow");
			return { t: "presets", id: cmd.id, items };
		};
		const log = new RecordingLog();
		const catalog = new PresetCatalog(link, log);
		const first = await catalog.list();
		assert.deepEqual(first, { t: "presets", items: sortPresets(items) });
		assert.deepEqual(log.at("debug"), ["debug listed 4 Develop presets"], "below info: a list comes every time a Property Inspector opens");
		const second = await catalog.list();
		assert.deepEqual(second, { t: "presets", items: sortPresets(items), error: "timeout", stale: true });
		link.state = "offline";
		const third = await catalog.list();
		assert.deepEqual(third, { t: "presets", items: sortPresets(items), error: "offline", stale: true });
		assert.equal(calls, 2, "offline doesn't ask");
		assert.deepEqual(link.problems, []);
	});
});
