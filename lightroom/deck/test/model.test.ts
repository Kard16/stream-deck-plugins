import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DialDeck } from "../src/dial/deck.js";
import { LrClient } from "../src/lr/client.js";
import type { Command, SetCmd } from "../src/lr/protocol.js";
import { LrModel } from "../src/model/model.js";
import { accelerate } from "../src/model/steps.js";
import { DEFAULT_SLIDERS, type Slider, sliderFor, watchList } from "../src/sliders.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { FakeLink } from "./helpers/fake-link.js";
import { FakeLr, standardLightroom } from "./helpers/fake-lr.js";
import { RecordingLog } from "./helpers/recording-log.js";
import { sleep, waitFor } from "./helpers/wait.js";

const slot = (p: string): Slider => {
	const s = sliderFor(DEFAULT_SLIDERS, p);
	if (!s) throw new Error(`no slider for ${p}`);
	return s;
};

const RAW_RANGES = { Temperature: [2000, 50000], Tint: [-150, 150], Exposure: [-5, 5], Contrast: [-100, 100], Shadows: [-100, 100] };
const JPG_RANGES = { Temperature: [-100, 100], Tint: [-100, 100], Exposure: [-5, 5], Contrast: [-100, 100], Shadows: [-100, 100] };
const RAW_VALUES = { Temperature: 5500, Tint: 10, Exposure: 0.35, Contrast: 0, Shadows: 15 };

const DIAL = "dial-0";

const STATE_101 = { t: "state", module: "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1, locked: false };
const STATE_102 = { t: "state", module: "develop", photo: "102", file: "DSC0102.ARW", flag: 0, rating: 2, label: "red", sel: 1, locked: false };

/** Photo 102's state, ranges and vals, in the order Lightroom sends them after a photo change. */
function arrive102(link: FakeLink, extra: Record<string, unknown> = {}): void {
	link.lr({ ...STATE_102, ...extra });
	link.lr({ t: "ranges", ranges: RAW_RANGES });
	link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
}

function setup(opts: { module?: string; writable?: boolean; values?: boolean } = {}) {
	const clock = new FakeClock();
	const link = new FakeLink(clock);
	const model = new LrModel(link, { clock });
	const alerts: string[] = [];
	model.onAlert((origin) => alerts.push(origin));
	link.lr({ t: "hello", v: 1, lr: "15.3", guard: "on", writable: opts.writable ?? true, inst: "A" });
	link.lr({ t: "state", module: opts.module ?? "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1 });
	if (opts.values !== false && (opts.module ?? "develop") === "develop") {
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: RAW_VALUES });
	}
	link.take();
	return { clock, link, model, alerts };
}

const sets = (cmds: Command[]): SetCmd[] => cmds.filter((c): c is SetCmd => c.t === "set");
const strip = (cmds: Command[]): Record<string, unknown>[] =>
	cmds.map((c) => {
		const { id: _id, ...rest } = c as Command & { id?: number };
		return rest;
	});

function noProblems(link: FakeLink): void {
	assert.deepEqual(link.problems, [], "every command matches PROTOCOL.md");
}

describe("value model: gestures", () => {
	test("a turn moves the value at once and sends set with the absolute value and a gesture number", () => {
		const { link, model } = setup();
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "applied");
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" }]);
		assert.ok(Math.abs((model.view("Exposure").value ?? 0) - (0.35 + 1 / 30)) < 1e-9);
		assert.equal(model.view("Exposure").adjusting, true);
		noProblems(link);
	});

	test("sends at most 30 sets a second per param, each with the latest value", () => {
		const { clock, link, model } = setup();
		// A tick every 5 ms for a second: 200 ticks of 50 K on a raw file.
		for (let i = 0; i < 200; i++) {
			model.turn("Temperature", 1, "normal", slot("Temperature"), DIAL);
			clock.advance(5);
		}
		const sent = link.sent.filter((s) => s.cmd.t === "set");
		assert.ok(sent.length >= 28 && sent.length <= 30, `${sent.length} sets in a second`);
		for (let i = 1; i < sent.length; i++) {
			const gap = (sent[i]?.at ?? 0) - (sent[i - 1]?.at ?? 0);
			assert.ok(gap >= 1000 / 30, `sets ${i - 1} and ${i} were ${gap} ms apart`);
		}
		// The last tick's value still goes out, once the interval allows.
		clock.advance(100);
		const all = sets(link.take());
		assert.equal(all.at(-1)?.v, 5500 + 200 * 50);
		assert.ok(all.every((c, i) => i === 0 || c.v !== all[i - 1]?.v), "no set repeats the previous value");
		noProblems(link);
	});

	test("done goes out 800 ms after the last tick, and the next burst is a new gesture", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		clock.advance(300);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		link.take();
		clock.advance(799);
		assert.deepEqual(link.take(), [], "no done before 800 ms after the last tick");
		clock.advance(1);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
		assert.equal(model.gesture, null);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.g, 2);
		noProblems(link);
	});

	test("push + turn: fine steps of a quarter step, and done on dial-up rather than after 800 ms", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 4, "fine", slot("Contrast"), DIAL); // 4 fine ticks = 1 unit
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" }]);
		clock.advance(100);
		model.release(DIAL);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
		noProblems(link);
	});

	test("dial-up right after a tick still sends that tick's value before done", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 4, "fine", slot("Contrast"), DIAL);
		clock.advance(10);
		model.turn("Contrast", 4, "fine", slot("Contrast"), DIAL); // within the 34 ms set interval
		model.release(DIAL);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" }], "the second set waits for the rate limit");
		clock.advance(40);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 2, g: 1, ph: "101" }, { t: "done", g: 1 }]);
		noProblems(link);
	});

	test("the 30 a second limit is per param: a new gesture right after the last one waits too", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 4, "fine", slot("Contrast"), DIAL); // push + turn: set Contrast 1
		clock.advance(3);
		model.release(DIAL); // done
		clock.advance(2);
		model.turn("Contrast", 4, "fine", slot("Contrast"), DIAL); // a new gesture 5 ms after the last set
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" },
			{ t: "done", g: 1 },
		]);
		clock.advance(28);
		assert.deepEqual(link.take(), [], "not before 34 ms after Contrast's last set");
		clock.advance(1);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 2, g: 2, ph: "101" }]);
		noProblems(link);
	});

	test("fine adjust is symmetric: two quarter ticks either way move a whole-number param by 1", () => {
		for (const dir of [1, -1]) {
			const { link, model } = setup();
			model.turn("Contrast", dir, "fine", slot("Contrast"), DIAL); // ±0.25: rounds to 0, nothing to send
			assert.deepEqual(link.take(), []);
			model.turn("Contrast", dir, "fine", slot("Contrast"), DIAL); // ±0.5: rounds away from zero
			assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: dir, g: 1, ph: "101" }], `direction ${dir}`);
			noProblems(link);
		}
	});

	test("turning another param ends the open gesture first: its final set and done go before the new set", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		clock.advance(5);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		clock.advance(5);
		model.turn("Contrast", 1, "normal", slot("Contrast"), "dial-3");
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "set", p: "Exposure", v: 0.42, g: 1, ph: "101" },
			{ t: "done", g: 1 },
			{ t: "set", p: "Contrast", v: 1, g: 2, ph: "101" },
		]);
		noProblems(link);
	});

	test("acceleration maps 1, 2, 3, 4 ticks an event to 1, 3, 6, 10", () => {
		assert.deepEqual(
			[1, 2, 3, 4, -1, -4, 0].map((t) => accelerate(t, 0.5)),
			[1, 3, 6, 10, -1, -10, 0],
		);
		assert.equal(accelerate(4, 0), 4, "k = 0 turns it off");
	});

	test("clamps to the range, and turning back moves at once (no overshoot to unwind)", () => {
		const { clock, link, model } = setup();
		link.lr({ t: "vals", vals: { Exposure: 4.98 } });
		model.turn("Exposure", 10, "normal", slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 5);
		assert.equal(model.view("Exposure").value, 5);
		clock.advance(50);
		model.turn("Exposure", -1, "normal", slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 4.97);
		noProblems(link);
	});

	test("rounds Exposure to 0.01 and everything else to whole numbers before sending", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 1, "fine", slot("Contrast"), DIAL); // 0.25: still rounds to 0, so nothing to send
		assert.deepEqual(link.take(), []);
		clock.advance(50);
		model.turn("Contrast", 1, "fine", slot("Contrast"), DIAL); // 0.5 rounds to 1
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" }]);
		clock.advance(1000);
		link.take();
		model.turn("Exposure", 1, "fine", slot("Exposure"), DIAL); // 0.35 + 1/120
		assert.equal(sets(link.take())[0]?.v, 0.36);
		noProblems(link);
	});

	test("Temperature steps 50 K a tick on raw files and 1 a tick on rendered files", () => {
		const { clock, link, model } = setup();
		model.turn("Temperature", 1, "normal", slot("Temperature"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 5550);
		model.turn("Temperature", 1, "fine", slot("Temperature"), DIAL); // fine: 12.5 K
		clock.advance(40);
		assert.equal(sets(link.take())[0]?.v, 5563);
		clock.advance(1000);
		link.take();
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		link.lr({ t: "ranges", ranges: JPG_RANGES });
		link.lr({ t: "vals", vals: { Temperature: 0, Tint: 0, Exposure: 0, Contrast: 5 } });
		model.turn("Temperature", 1, "normal", slot("Temperature"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 1);
		noProblems(link);
	});
});

describe("value model: big steps (turn mode macro)", () => {
	test("each tick moves the slider's macro, by the range's variant: 1/3 EV, 500 K on raw files and 10 on rendered ones, 10 points", () => {
		const { clock, link, model } = setup();
		assert.equal(model.turn("Exposure", 2, "macro", slot("Exposure"), DIAL), "applied");
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 1.02, g: 1, ph: "101" }], "0.35 + 2 × 1/3");
		clock.advance(1000);
		link.take();
		model.turn("Temperature", 1, "macro", slot("Temperature"), DIAL);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Temperature", v: 6000, g: 2, ph: "101" }]);
		model.turn("Contrast", -3, "macro", slot("Contrast"), "dial-3");
		assert.deepEqual(strip(link.take()), [
			{ t: "done", g: 2 },
			{ t: "set", p: "Contrast", v: -30, g: 3, ph: "101" },
		]);
		clock.advance(1000);
		link.take();
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		link.lr({ t: "ranges", ranges: JPG_RANGES });
		link.lr({ t: "vals", vals: { Temperature: 0, Tint: 0, Exposure: 0, Contrast: 5 } });
		model.turn("Temperature", 1, "macro", slot("Temperature"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 10);
		noProblems(link);
	});

	test("big steps clamp to the range like any turn, and go out at most 30 times a second", () => {
		const { clock, link, model } = setup();
		link.lr({ t: "vals", vals: { Exposure: 4.9 } });
		model.turn("Exposure", 1, "macro", slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 5);
		clock.advance(10);
		model.turn("Exposure", -1, "macro", slot("Exposure"), DIAL);
		assert.deepEqual(link.take(), [], "waits for the set interval");
		clock.advance(30);
		assert.deepEqual(
			sets(link.take()).map((s) => s.v),
			[4.67],
			"one big step back from the limit, not from the 5.23 the tick asked for",
		);
		noProblems(link);
	});

	test("only fine ticks mark a gesture pressed: dial-up doesn't end a big-step gesture, but does once it has push + turn ticks", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "macro", slot("Exposure"), DIAL);
		model.release(DIAL);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.68, g: 1, ph: "101" }], "no done on dial-up");
		clock.advance(799);
		assert.deepEqual(link.take(), []);
		clock.advance(1);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }], "800 ms after the last tick");
		clock.advance(1000);
		model.turn("Exposure", 1, "macro", slot("Exposure"), DIAL); // 0.68 + 1/3
		clock.advance(50);
		model.turn("Exposure", 4, "fine", slot("Exposure"), DIAL); // + 4/120, in the same gesture
		model.release(DIAL);
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 1.01, g: 2, ph: "101" },
			{ t: "set", p: "Exposure", v: 1.05, g: 2, ph: "101" },
			{ t: "done", g: 2 },
		]);
		noProblems(link);
	});

	test("big-step ticks held for Develop keep their mode: they apply as big steps, beside the normal and fine ticks held with them", () => {
		const { clock, link, model } = setup({ module: "library" });
		assert.equal(model.turn("Exposure", 2, "macro", slot("Exposure"), DIAL), "held");
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		assert.equal(model.turn("Exposure", 4, "fine", slot("Exposure"), DIAL), "held");
		assert.deepEqual(strip(link.take()), [{ t: "module", v: "develop" }]);
		link.lr({ t: "state", module: "develop" });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: RAW_VALUES });
		clock.advance(40);
		assert.equal(sets(link.take()).at(-1)?.v, 1.08, "0.35 + 2 × 1/3 + 1/30 + 4/120");
		assert.ok(Math.abs((model.view("Exposure").value ?? 0) - (0.35 + 2 / 3 + 1 / 30 + 4 / 120)) < 1e-9);
		assert.deepEqual(model.held, []);
		model.release(DIAL);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }], "the held fine ticks make it a push + turn gesture");
		noProblems(link);
	});

	test("a big-step tick held for a photo change applies to the new photo's value as a big step", () => {
		const { link, model } = setup();
		model.beforePhotoChange(); // Next
		link.send({ t: "nav", v: "next" });
		assert.equal(model.turn("Temperature", 1, "macro", slot("Temperature"), DIAL), "held");
		arrive102(link);
		assert.deepEqual(strip(link.take()), [
			{ t: "nav", v: "next" },
			{ t: "set", p: "Temperature", v: 6000, g: 1, ph: "102" },
		]);
		noProblems(link);
	});

	test("read-only: the probe's one set per burst is one tick of the turn's mode, a big step included", () => {
		const { clock, link, model } = setup({ writable: false });
		assert.equal(model.turn("Exposure", 1, "macro", slot("Exposure"), DIAL), "readonly");
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.68, g: 1, ph: "101" }]);
		clock.advance(900);
		model.turn("Exposure", 1, "fine", slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 0.36);
		clock.advance(900);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 0.38);
		assert.equal(model.view("Exposure").value, 0.35, "the value doesn't move");
		noProblems(link);
	});

	test("the ranges Lightroom reports are logged at debug, one line per ranges event", () => {
		const clock = new FakeClock();
		const link = new FakeLink(clock);
		const log = new RecordingLog();
		new LrModel(link, { clock, log });
		link.lr({ t: "ranges", ranges: { Sharpness: [0, 150], Dehaze: [-100, 100] } });
		assert.deepEqual(log.at("info"), []);
		assert.deepEqual(log.at("debug"), ["debug ranges from Lightroom: Sharpness 0…150, Dehaze -100…100"]);
	});
});

describe("value model: echoes and acks", () => {
	test("vals for the param are ignored during its gesture; other params still update", () => {
		const { link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		link.lr({ t: "vals", vals: { Exposure: 0.35, Contrast: 7 } });
		assert.ok(Math.abs((model.view("Exposure").value ?? 0) - 0.3833) < 1e-3, "the deck owns Exposure during the gesture");
		assert.equal(model.view("Contrast").value, 7);
	});

	test("vals for the param are ignored for 300 ms after done, then the latest one is applied", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		clock.advance(800); // done
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "done", g: 1 },
		]);
		link.lr({ t: "vals", vals: { Exposure: 0.35 } }); // an echo from before the gesture settled
		clock.advance(100);
		assert.equal(model.view("Exposure").value, 0.38);
		link.lr({ t: "vals", vals: { Exposure: 0.38 } }); // the observer's final value
		clock.advance(199);
		assert.equal(model.view("Exposure").value, 0.38);
		clock.advance(1);
		assert.equal(model.view("Exposure").value, 0.38, "the latest vals after done wins");
		link.lr({ t: "vals", vals: { Exposure: 0.9 } }); // a mouse edit, after the window
		assert.equal(model.view("Exposure").value, 0.9);
	});

	test("after the echo window, the final ack's value shows when no vals came (Lightroom's own rounding)", () => {
		const { clock, link, model } = setup();
		model.turn("Temperature", 1, "normal", slot("Temperature"), DIAL);
		const [set] = sets(link.take());
		assert.equal(set?.v, 5550);
		link.lr({ t: "ack", p: "Temperature", v: 5551, g: set?.g });
		clock.advance(800 + 300);
		assert.equal(model.view("Temperature").value, 5551);
	});

	test("an ack for a set this deck didn't send is taken as the value", () => {
		const { link, model } = setup();
		link.lr({ t: "ack", p: "Exposure", v: 5, g: 99 });
		assert.equal(model.view("Exposure").value, 5);
	});
});

describe("value model: outside Develop", () => {
	test("a turn asks for Develop once and holds the ticks until vals arrive", () => {
		const { link, model } = setup({ module: "library" });
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		assert.deepEqual(strip(link.take()), [{ t: "module", v: "develop" }]);
		link.lr({ t: "state", module: "develop" });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(link.take(), [], "ranges alone don't release the ticks");
		link.lr({ t: "vals", vals: RAW_VALUES });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.42, g: 1, ph: "101" }]);
		assert.deepEqual(model.held, []);
		noProblems(link);
	});

	test("held ticks are dropped after 2 s without vals, with an alert", () => {
		const { clock, link, model, alerts } = setup({ module: "library" });
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		clock.advance(1999);
		assert.deepEqual(model.held, ["Exposure"]);
		clock.advance(1);
		assert.deepEqual(model.held, []);
		assert.deepEqual(alerts, [DIAL]);
		link.take();
		link.lr({ t: "state", module: "develop" });
		link.lr({ t: "vals", vals: RAW_VALUES });
		assert.deepEqual(sets(link.take()), [], "nothing applied late");
	});

	test("Develop that couldn't be reached drops the ticks and alerts (err noDevelop)", () => {
		const { link, model, alerts } = setup({ module: "library" });
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		const [cmd] = link.take();
		assert.ok(cmd);
		link.err(cmd, "noDevelop");
		assert.deepEqual(model.held, []);
		assert.deepEqual(alerts, [DIAL]);
	});

	test("a photo change ends the gesture and holds ticks until the new photo's vals", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		link.take();
		clock.advance(100); // the user changes photo in Lightroom a moment later
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		assert.deepEqual(link.take(), [], "no module command: already in Develop");
		link.lr({ t: "ranges", ranges: JPG_RANGES });
		link.lr({ t: "vals", vals: { Temperature: 0, Tint: 0, Exposure: 0, Contrast: 5 } });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.03, g: 2, ph: "104" }]);
		noProblems(link);
	});

	test("after a photo change a turn waits for the new photo's range, which can come after its vals", () => {
		const { link, model } = setup();
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		// Develop is still loading the JPEG: Lightroom can't read Temperature's range yet and sends it later.
		link.lr({ t: "ranges", ranges: { Tint: [-100, 100], Exposure: [-5, 5], Contrast: [-100, 100] } });
		link.lr({ t: "vals", vals: { Temperature: 0, Tint: 0, Exposure: 0, Contrast: 5 } });
		assert.equal(model.turn("Temperature", 1, "normal", slot("Temperature"), DIAL), "held", "the raw file's Kelvin range would step 50 K and clamp to 2000");
		assert.deepEqual(link.take(), []);
		link.lr({ t: "ranges", ranges: { Temperature: [-100, 100] } });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Temperature", v: 1, g: 1, ph: "104" }]);
		assert.equal(model.turn("Contrast", 1, "normal", slot("Contrast"), DIAL), "applied", "Contrast had its new range all along");
		noProblems(link);
	});

	test("Next during a gesture: its final set and done go before nav, and turns wait for the new photo's values", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL); // set 0.38 goes at once
		clock.advance(10);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL); // 0.42 waits for the set interval
		// What NavKey does on key down:
		model.beforePhotoChange();
		link.send({ t: "nav", v: "next" });
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "set", p: "Exposure", v: 0.42, g: 1, ph: "101" },
			{ t: "done", g: 1 },
			{ t: "nav", v: "next" },
		]);
		assert.equal(model.gesture, null);
		// A tick before Lightroom says which photo it's on would apply the old photo's value to the new one: it waits.
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		clock.advance(5);
		link.lr({ t: "vals", vals: { Exposure: 0.42 } }); // the observer's final value, for the old photo
		clock.advance(5);
		link.lr({ t: "state", photo: "102", file: "DSC0102.ARW" });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(link.take(), [], "still waiting for the new photo's vals");
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		clock.advance(40);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 2, ph: "102" }], "the held tick applies to the new photo's value");
		noProblems(link);
	});

	test("Next at the end of the filmstrip: the photo stays, and held turns apply when the wait ends", () => {
		const { clock, link, model } = setup();
		model.beforePhotoChange();
		link.send({ t: "nav", v: "next" });
		link.take();
		assert.equal(model.turn("Contrast", 1, "normal", slot("Contrast"), DIAL), "held");
		link.lr({ t: "state", module: "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1 }); // nav's answer: same photo
		clock.advance(499);
		assert.deepEqual(link.take(), []);
		clock.advance(1);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" }]);
		assert.equal(model.turn("Contrast", 1, "normal", slot("Contrast"), DIAL), "applied", "turns apply at once again");
		noProblems(link);
	});

	test("a turn waits for the param's range, which picks the Kelvin step and bounds the clamp", () => {
		const { link, model } = setup({ module: "library" });
		assert.equal(model.turn("Temperature", 1, "normal", slot("Temperature"), DIAL), "held");
		link.take(); // module develop
		link.lr({ t: "state", module: "develop" });
		link.lr({ t: "vals", vals: RAW_VALUES });
		assert.deepEqual(link.take(), [], "a value without its range doesn't release the tick");
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Temperature", v: 5550, g: 1, ph: "101" }], "50 K a tick on a raw file, not 1");
		noProblems(link);
	});

	test("leaving Develop keeps the last values but marks them stale (shown dimmed)", () => {
		const { link, model } = setup();
		link.lr({ t: "state", module: "library" });
		assert.equal(model.view("Exposure").value, 0.35);
		assert.equal(model.view("Exposure").fresh, false);
		assert.equal(model.inDevelop, false);
	});
});

describe("value model: stale gestures (err stale, PROTOCOL.md Gestures)", () => {
	/** Three turns of Exposure 40 ms apart: gesture 1 sends 0.38, which Lightroom acks, then 0.42 and 0.45. */
	function threeSets(clock: FakeClock, link: FakeLink, model: LrModel): [SetCmd, SetCmd] {
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		link.lr({ t: "ack", p: "Exposure", v: 0.38, g: 1 });
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		const out = sets(link.take());
		assert.deepEqual(
			out.map((s) => [s.v, s.g]),
			[
				[0.38, 1],
				[0.42, 1],
				[0.45, 1],
			],
		);
		const [, second, third] = out;
		assert.ok(second && third);
		return [second, third];
	}

	test("err before the new photo's state: the gesture ends with no final set or done, turns wait, then a new g starts from the new photo", () => {
		const { clock, link, model, alerts } = setup();
		const [second, third] = threeSets(clock, link, model);
		clock.advance(10);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL); // 0.48 waits for the set interval
		// The user moved to photo 102 in Lightroom, which caught it as `second` arrived, before its poll did.
		link.err(second, "stale");
		link.err(third, "stale");
		assert.equal(model.gesture, null);
		assert.equal(model.view("Exposure").value, 0.38, "back to the value Lightroom last confirmed");
		clock.advance(100);
		assert.deepEqual(link.take(), [], "the pending 0.48 is dropped, and no done");
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held", "turns wait for the new photo");
		link.lr(STATE_102);
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(link.take(), [], "no done when the state comes either, and still waiting for 102's vals");
		assert.equal(model.view("Exposure").fresh, false);
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 2, ph: "102" }], "the held turn applies to 102's value");
		clock.advance(1000);
		assert.deepEqual(link.take(), [{ t: "done", g: 2 }]);
		assert.deepEqual(alerts, [], "a stale set raises no alert");
		noProblems(link);
	});

	test("err after the new photo's state and vals: no wait, the value stays the new photo's, and the next gesture starts from it", () => {
		const { clock, link, model, alerts } = setup();
		const [second, third] = threeSets(clock, link, model);
		// Lightroom's poll saw photo 102 before `second` arrived: the state, ranges and vals for 102 come first.
		link.lr(STATE_102);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }], "the state ends gesture 1; Lightroom ignores this late done");
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		link.err(second, "stale");
		assert.deepEqual(model.view("Exposure"), { value: -1, range: [-5, 5], fresh: true, adjusting: false });
		clock.advance(40);
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "applied", "no wait: the deck already has 102's values");
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 2, ph: "102" }]);
		// The err for gesture 1's last set can come after gesture 2 began: it leaves gesture 2 alone.
		link.err(third, "stale");
		assert.equal(model.gesture?.g, 2);
		assert.ok(Math.abs((model.view("Exposure").value ?? 0) - (-1 + 1 / 30)) < 1e-9);
		clock.advance(1000);
		assert.deepEqual(link.take(), [{ t: "done", g: 2 }]);
		assert.deepEqual(alerts, []);
		noProblems(link);
	});

	test("several stale errs act once: turns wait photoChangeMs from the first, then go on from the value Lightroom confirmed", () => {
		const { clock, link, model, alerts } = setup();
		const [second, third] = threeSets(clock, link, model);
		// The user went to another photo and straight back between two polls, so no state follows.
		link.err(second, "stale");
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		clock.advance(100);
		link.err(third, "stale");
		clock.advance(399);
		assert.deepEqual(link.take(), [], "500 ms from the first err; the second doesn't restart the wait");
		clock.advance(1);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.41, g: 2, ph: "101" }], "from the acked 0.38, not the refused 0.45");
		assert.deepEqual(alerts, []);
		noProblems(link);
	});

	test("a stale err while another dial's gesture is open ends that one too, with done: it began on the old photo's values", () => {
		const { clock, link, model, alerts } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		link.lr({ t: "ack", p: "Exposure", v: 0.38, g: 1 });
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		clock.advance(40);
		model.turn("Contrast", 1, "normal", slot("Contrast"), "dial-3"); // ends gesture 1 first
		const sent = link.take();
		assert.deepEqual(strip(sent), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "set", p: "Exposure", v: 0.42, g: 1, ph: "101" },
			{ t: "done", g: 1 },
			{ t: "set", p: "Contrast", v: 1, g: 2, ph: "101" },
		]);
		const [, second, , contrast] = sent;
		assert.ok(second && contrast);
		// Lightroom was on photo 102 when 0.42 arrived, and refused it. It refuses Contrast 1 too, since its ph is 101.
		link.err(second, "stale");
		assert.equal(model.gesture, null);
		assert.deepEqual(link.take(), [{ t: "done", g: 2 }]);
		link.err(contrast, "stale");
		assert.deepEqual(link.take(), [], "nothing more to end");
		assert.equal(model.turn("Contrast", 1, "normal", slot("Contrast"), "dial-3"), "held");
		clock.advance(40);
		link.lr(STATE_102);
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 3, ph: "102" }], "a new gesture from Lightroom's value for 102");
		assert.equal(model.view("Exposure").value, -1);
		assert.deepEqual(alerts, []);
		noProblems(link);
	});
});

describe("value model: reset, errors, guard, connection", () => {
	test("reset sends reset; turns wait for its ack and start from the reset value", () => {
		const { link, model } = setup();
		assert.equal(model.reset("Exposure", DIAL), true);
		assert.deepEqual(strip(link.take()), [{ t: "reset", p: "Exposure", ph: "101" }]);
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		link.lr({ t: "ack", p: "Exposure", v: 0 });
		assert.equal(model.view("Exposure").value, 0.03333333333333333);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.03, g: 1, ph: "101" }]);
		noProblems(link);
	});

	test("reset during a gesture cancels it without done: Lightroom's reset ends the gesture", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		model.reset("Exposure", DIAL);
		link.lr({ t: "ack", p: "Exposure", v: 0 });
		clock.advance(2000);
		assert.deepEqual(
			strip(link.take()).map((c) => c.t),
			["set", "reset"],
		);
		assert.equal(model.view("Exposure").value, 0);
	});

	test("err on a set alerts the dial that sent it, ends the gesture and shows Lightroom's last value", () => {
		const { link, model, alerts } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		const [set] = link.take();
		assert.ok(set);
		link.err(set, "noDevelop");
		assert.deepEqual(alerts, ["dial-2"]);
		assert.equal(model.gesture, null);
		assert.equal(model.view("Exposure").value, 0.35);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
	});

	test("read-only: the value doesn't move, one set per burst reaches the guard, err guard alerts", () => {
		const { clock, link, model, alerts } = setup({ writable: false });
		for (let i = 0; i < 5; i++) {
			assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "readonly");
			clock.advance(20);
		}
		const sent = link.take();
		assert.equal(sent.length, 1);
		assert.equal(model.view("Exposure").value, 0.35);
		const [probe] = sent;
		assert.ok(probe);
		link.err(probe, "guard");
		assert.deepEqual(alerts, [DIAL]);
		clock.advance(900);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.equal(link.take().length, 1, "a new burst probes again");
		noProblems(link);
	});

	test("offline or busy: turns and resets are refused with an alert, and nothing is sent", () => {
		const { clock, link, model, alerts } = setup();
		link.setState("busy");
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "offline");
		clock.advance(1500);
		link.setState("offline");
		assert.equal(model.reset("Exposure", DIAL), false);
		assert.deepEqual(link.take(), []);
		assert.deepEqual(alerts, [DIAL, DIAL]);
	});

	test("a new inst drops values and ranges", () => {
		const { link, model } = setup();
		link.newInst("B", "A");
		assert.deepEqual(model.view("Exposure"), { value: null, range: null, fresh: false, adjusting: false });
	});

	test("a disconnect ends the gesture, keeps values (stale) and drops held ticks with an alert", () => {
		const { link, model, alerts } = setup({ module: "library" });
		link.lr({ t: "vals", vals: { Contrast: 3 } }); // a value seen earlier
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		link.disconnect();
		assert.deepEqual(model.held, []);
		assert.deepEqual(alerts, [DIAL]);
		assert.equal(model.view("Contrast").value, 3);
		assert.equal(model.view("Contrast").fresh, false);
	});
});

describe("value model: ph, the photo the deck worked from (PROTOCOL.md, Gestures)", () => {
	test("every set and reset carries the photo of the latest state, read as it goes out", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		clock.advance(10);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2"); // waits for the set interval
		model.turn("Contrast", 1, "normal", slot("Contrast"), "dial-3"); // takes over: Exposure's final set goes out early
		model.reset("Contrast", "dial-3");
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "set", p: "Exposure", v: 0.42, g: 1, ph: "101" },
			{ t: "done", g: 1 },
			{ t: "set", p: "Contrast", v: 1, g: 2, ph: "101" },
			{ t: "reset", p: "Contrast", ph: "101" },
		]);
		link.lr({ t: "ack", p: "Contrast", v: 0 });
		clock.advance(1000);
		// Next: a turn before Lightroom says where it went waits, and goes out with the photo it applies to.
		model.beforePhotoChange();
		link.send({ t: "nav", v: "next" });
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2"), "held");
		link.lr(STATE_102);
		model.reset("Tint", "dial-1"); // before 102's values: it's 102's reset already
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		assert.deepEqual(strip(link.take()), [
			{ t: "nav", v: "next" },
			{ t: "reset", p: "Tint", ph: "102" },
			{ t: "set", p: "Exposure", v: -0.97, g: 3, ph: "102" },
		]);
		noProblems(link);
	});

	test("the read-only probe carries it too", () => {
		const { link, model } = setup({ writable: false });
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" }]);
		noProblems(link);
	});

	test("with no target photo there's no id to send: a press sends no reset and the dial alerts, as Lightroom's noPhoto would", () => {
		const { link, model, alerts } = setup();
		link.lr({ ...STATE_101, photo: null, file: null, sel: 0 });
		// Unchecked, a reset could land on a photo Lightroom has just gained (PROTOCOL.md, Gestures: with no photo).
		assert.equal(model.reset("Exposure", DIAL), false);
		assert.deepEqual(link.take(), [], "nothing sent");
		assert.deepEqual(alerts, [DIAL], "one alert");
		link.lr(STATE_101); // Lightroom has a photo again
		assert.equal(model.reset("Exposure", DIAL), true);
		assert.deepEqual(strip(link.take()), [{ t: "reset", p: "Exposure", ph: "101" }]);
		noProblems(link);
	});

	test("with no target photo a refused press changes nothing: held turns stay held", () => {
		const { link, model, alerts } = setup({ module: "library" });
		link.lr({ ...STATE_101, module: "library", photo: null, file: null, sel: 0 });
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held", "a turn still asks for Develop");
		assert.deepEqual(strip(link.take()), [{ t: "module", v: "develop" }]);
		assert.equal(model.reset("Exposure", "dial-3"), false);
		assert.deepEqual(link.take(), [], "no reset");
		assert.deepEqual(alerts, ["dial-3"]);
		assert.deepEqual(model.held, ["Exposure"], "the held turn is untouched");
		noProblems(link);
	});

	test("with no target photo a turn sends no set either, even when values came ahead of their photo's state: the dial alerts once per burst", () => {
		const { clock, link, model, alerts } = setup();
		link.lr({ ...STATE_101, photo: null, file: null, sel: 0 }); // Develop, with no photo
		// Lightroom gained photo 102, and its answer to watch carried 102's ranges and vals ahead of 102's state.
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		for (let i = 0; i < 5; i++) {
			assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "noPhoto");
			clock.advance(50);
		}
		assert.deepEqual(link.take(), [], "no set, which would have gone without ph");
		assert.deepEqual(alerts, [DIAL], "one alert for the burst");
		assert.equal(model.gesture, null);
		assert.equal(model.view("Exposure").value, -1, "the value didn't move");
		clock.advance(800);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.deepEqual(alerts, [DIAL, DIAL], "after a pause, a new burst");
		arrive102(link);
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "applied", "once the state names the photo");
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 1, ph: "102" }]);
		noProblems(link);
	});

	test("turns held for Develop send no set while the state names no photo, even when values come first: they go with the photo's state, with its ph", () => {
		const { link, model, alerts } = setup({ module: "library" });
		link.lr({ ...STATE_101, module: "library", photo: null, file: null, sel: 0 });
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		assert.deepEqual(strip(link.take()), [{ t: "module", v: "develop" }]);
		link.lr({ ...STATE_101, photo: null, file: null, sel: 0 }); // in Develop, still with no photo
		link.lr({ t: "ranges", ranges: RAW_RANGES }); // values for a photo whose state hasn't come yet
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		assert.deepEqual(link.take(), [], "no set, which would have gone without ph");
		assert.deepEqual(model.held, ["Exposure"], "still held");
		arrive102(link);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 1, ph: "102" }], "the held tick applies to 102's value");
		assert.deepEqual(alerts, []);
		noProblems(link);
	});

	test("a gesture that starts just before a photo change reaches the deck is refused, and the next starts from the new photo", () => {
		for (const order of ["the err first", "the state first"] as const) {
			const { clock, link, model, alerts } = setup();
			// The user moved to photo 102 in Lightroom, and its state is on the way: a new gesture starts from 101's value.
			model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
			const [set] = link.take();
			assert.ok(set);
			assert.deepEqual(strip([set]), [{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" }], order);
			if (order === "the state first") arrive102(link);
			link.err(set, "stale");
			const result = model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
			assert.equal(result, order === "the err first" ? "held" : "applied", `${order}: wait only for a photo the deck hasn't seen`);
			if (order === "the err first") arrive102(link);
			clock.advance(40);
			assert.deepEqual(
				sets(link.take()).map((s) => strip([s])[0]),
				[{ t: "set", p: "Exposure", v: -0.97, g: 2, ph: "102" }],
				`${order}: one tick from 102's -1, never 101's value`,
			);
			assert.deepEqual(alerts, [], order);
			noProblems(link);
		}
	});

	test("a reset refused as stale is dropped without an alert; a turn waiting for it then goes, and its own ph catches it", () => {
		const { clock, link, model, alerts } = setup();
		// The user moved to photo 102 in Lightroom a moment ago, and the deck hasn't heard.
		model.reset("Exposure", DIAL);
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held", "turns wait for the reset's answer");
		const [reset] = link.take();
		assert.ok(reset);
		link.err(reset, "stale");
		assert.deepEqual(alerts, []);
		const [set] = link.take();
		assert.ok(set);
		assert.deepEqual(strip([set]), [{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" }], "the reset is gone; the held turn goes");
		link.err(set, "stale");
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held", "now turns wait for the new photo");
		arrive102(link);
		clock.advance(40);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 2, ph: "102" }]);
		assert.deepEqual(alerts, []);
		noProblems(link);
	});
});

describe("value model: locked photos (PROTOCOL.md, Locked photos)", () => {
	const locked = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...STATE_101, locked: true, ...extra });

	test("the lock ends the open gesture with done, and its pending final set never goes out", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL); // 0.38 goes at once
		link.lr({ t: "ack", p: "Exposure", v: 0.38, g: 1 });
		clock.advance(10);
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL); // 0.42 waits for the set interval
		link.lr(locked());
		assert.equal(model.state.locked, true);
		assert.equal(model.gesture, null);
		clock.advance(1000);
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "done", g: 1 },
		]);
		assert.equal(model.view("Exposure").value, 0.38, "what Lightroom has, not the 0.42 that never went out");
		noProblems(link);
	});

	test("while locked, turns and resets send nothing and hold nothing, and each dial alerts once per burst", () => {
		const { clock, link, model, alerts } = setup();
		link.lr(locked());
		for (let i = 0; i < 40; i++) {
			assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2"), "locked"); // a 2 s spin
			clock.advance(50);
		}
		assert.equal(model.reset("Exposure", "dial-2"), false, "a press straight after: the same burst");
		assert.deepEqual(alerts, ["dial-2"], "one alert for the whole burst");
		model.turn("Contrast", 1, "normal", slot("Contrast"), "dial-3");
		assert.deepEqual(alerts, ["dial-2", "dial-3"], "another dial has bursts of its own");
		clock.advance(800);
		assert.equal(model.reset("Exposure", "dial-2"), false);
		assert.deepEqual(alerts, ["dial-2", "dial-3", "dial-2"], "after a pause, a new burst");
		assert.deepEqual(link.take(), []);
		assert.deepEqual(model.held, []);
		assert.equal(model.view("Exposure").value, 0.35);
	});

	test("read-only as well: the lock comes first, so not even the guard's probe set goes out", () => {
		const { link, model, alerts } = setup({ writable: false });
		link.lr(locked());
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "locked");
		assert.deepEqual(link.take(), []);
		assert.deepEqual(alerts, [DIAL]);
	});

	test("outside Develop while locked, a turn sends no module develop", () => {
		const { link, model, alerts } = setup({ module: "library" });
		link.lr(locked({ module: "library" }));
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "locked");
		assert.deepEqual(link.take(), []);
		assert.deepEqual(model.held, []);
		assert.deepEqual(alerts, [DIAL]);
	});

	test("turns held when the lock comes are dropped with an alert, and nothing goes out for them later", () => {
		const { clock, link, model, alerts } = setup({ module: "library" });
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.deepEqual(strip(link.take()), [{ t: "module", v: "develop" }]);
		link.lr(locked()); // in Develop now, on a locked photo
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: RAW_VALUES });
		assert.deepEqual(model.held, []);
		clock.advance(2500);
		assert.deepEqual(link.take(), [], "no set, then or when the hold would have run out");
		assert.deepEqual(alerts, [DIAL], "one alert");
	});

	test("moving onto a locked photo: the gesture ends with done, and the turns held for the new photo are dropped", () => {
		const { clock, link, model, alerts } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		model.beforePhotoChange(); // Next
		link.send({ t: "nav", v: "next" });
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "held");
		arrive102(link, { locked: true });
		clock.advance(1000);
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "done", g: 1 },
			{ t: "nav", v: "next" },
		]);
		assert.deepEqual(alerts, [DIAL]);
	});

	test("when the lock ends everything works at once, and nothing carries over, not even a burst", () => {
		const { clock, link, model, alerts } = setup();
		link.lr(locked());
		for (let i = 0; i < 10; i++) {
			model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL); // one burst, 0 to 900 ms: one alert
			clock.advance(100);
		}
		link.lr(STATE_101);
		assert.equal(model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL), "applied", "no wait");
		assert.equal(model.reset("Contrast", "dial-3"), true);
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "done", g: 1 },
			{ t: "reset", p: "Contrast", ph: "101" },
		], "one tick from 0.35, none of the locked turns, and the reset ends that gesture as usual");
		clock.advance(100);
		// Locked again 200 ms after the last locked turn: a new lock's first turn alerts, though it's within 800 ms.
		link.lr(locked());
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		assert.deepEqual(alerts, [DIAL, DIAL]);
		noProblems(link);
	});

	test("err locked on a set, before the deck has seen the lock: that dial alerts, and its gesture ends with done", () => {
		const { clock, link, model, alerts } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		link.lr({ t: "ack", p: "Exposure", v: 0.38, g: 1 });
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		const [, second, third] = link.take();
		assert.ok(second && third);
		link.err(second, "locked");
		link.err(third, "locked");
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }], "one done");
		assert.deepEqual(alerts, ["dial-2"]);
		assert.equal(model.gesture, null);
		assert.equal(model.view("Exposure").value, 0.38, "the value Lightroom last confirmed");
		link.lr(locked()); // the state from the poll that saw the lock
		assert.deepEqual(link.take(), [], "nothing more to end");
	});

	test("err locked on sets after state.locked, the order Lightroom sends them in: one done, from the state, and the errs bring back the value Lightroom confirmed", () => {
		const { clock, link, model, alerts } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		link.lr({ t: "ack", p: "Exposure", v: 0.38, g: 1 });
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		clock.advance(40);
		model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
		const [, second, third] = link.take();
		assert.ok(second && third);
		// Lightroom's poll read the lock while 0.42 and 0.45 were on their way: its state.locked is ahead of their errs on the event socket.
		link.lr(locked());
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }], "the state ends the gesture");
		link.err(second, "locked");
		link.err(third, "locked");
		assert.deepEqual(link.take(), [], "no done for the errs");
		assert.deepEqual(alerts, ["dial-2"]);
		assert.equal(model.view("Exposure").value, 0.38, "the value Lightroom last confirmed, not the refused 0.45");
		clock.advance(400);
		link.lr(STATE_101); // the lock ends; Exposure didn't change, so no vals follow
		assert.equal(model.view("Exposure").value, 0.38);
		noProblems(link);
	});

	test("err locked on a reset: the dial alerts, and the gesture the reset ended gets its done", () => {
		const { link, model, alerts } = setup();
		model.turn("Exposure", 1, "normal", slot("Exposure"), DIAL);
		model.reset("Exposure", DIAL); // ends gesture 1 without done: Lightroom's reset would end it
		const sent = link.take();
		assert.deepEqual(
			sent.map((c) => c.t),
			["set", "reset"],
		);
		const reset = sent[1];
		assert.ok(reset);
		link.err(reset, "locked");
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }], "Lightroom changed nothing, so it still tracks gesture 1");
		assert.deepEqual(alerts, [DIAL]);
		noProblems(link);
	});
});

describe("the deck where the deck-vs-mock integration didn't reach (plan.md, ladder step 5)", () => {
	test("hello.v other than 1: the strips say Mismatch, inputs alert, and nothing but hello and ping goes out", async () => {
		const v2 = { t: "hello", v: 2, lr: "16.0", guard: "on", writable: true, inst: "v2" };
		const lr = await FakeLr.start(
			standardLightroom(v2, STATE_101, (cmd, fake) => {
				// A v2 Lightroom may well send values: they change nothing.
				if (cmd.t === "hello") {
					fake.send({ t: "ranges", ranges: RAW_RANGES });
					fake.send({ t: "vals", vals: RAW_VALUES });
				}
			}),
		);
		const client = new LrClient({ cmdPort: lr.cmdPort, evtPort: lr.evtPort, ver: "test", watch: watchList(DEFAULT_SLIDERS), timing: { pingIntervalMs: 100, tickMs: 20 } });
		const model = new LrModel(client);
		const deck = new DialDeck(DEFAULT_SLIDERS, model);
		const alerts: string[] = [];
		for (let c = 0; c < 4; c++) deck.add(`dial-${c}`, c, { setFeedback: () => undefined, showAlert: () => alerts.push(`dial-${c}`), setSettings: () => undefined });
		try {
			client.start();
			await waitFor(() => client.state === "mismatch" && model.view("Exposure").value === 0.35, "the mismatch, and Lightroom's values");
			assert.equal(model.hello?.v, 2);
			assert.equal(deck.rotate("dial-2", 1, false), "offline");
			deck.down("dial-3");
			deck.up("dial-3");
			deck.tap("dial-1", true); // a long touch: big steps on, which sends nothing and doesn't alert
			assert.equal(deck.bigSteps("dial-1"), true);
			assert.equal(deck.rotate("dial-1", 1, false), "offline", "a big step is refused like any turn");
			model.beforePhotoChange();
			assert.equal(client.send({ t: "nav", v: "next" }), false, "what a Next key sends is refused too");
			await sleep(300);
			assert.deepEqual([...new Set(lr.commands().map((c) => c.t))].sort(), ["hello", "ping"]);
			assert.ok(lr.commands("ping").length >= 2, "the heartbeat goes on");
			assert.deepEqual(alerts, ["dial-2", "dial-3", "dial-1"]);
			assert.deepEqual(
				[0, 1, 2, 3].map((c) => (deck.painted(`dial-${c}`)?.value as { value?: unknown } | undefined)?.value),
				["Mismatch", "Mismatch", "Mismatch", "Mismatch"],
			);
			assert.deepEqual(model.held, []);
		} finally {
			client.stop();
			await lr.close();
		}
	});

	test("two dials turned at once: each takeover sends the other gesture's final set at once, once, and both values land", () => {
		const { clock, link, model } = setup();
		// A Lightroom that acks every set and, after done, sends that gesture's param in vals.
		const values: Record<string, number> = { Exposure: 0.35, Contrast: 0 };
		const paramOf = new Map<number, string>();
		let seen = 0;
		const lightroom = (): void => {
			for (; seen < link.sent.length; seen++) {
				const cmd = link.sent[seen]?.cmd;
				if (cmd?.t === "set") {
					values[cmd.p] = cmd.v;
					paramOf.set(cmd.g, cmd.p);
					link.lr({ t: "ack", p: cmd.p, v: cmd.v, g: cmd.g });
				} else if (cmd?.t === "done" && cmd.g !== undefined) {
					const p = paramOf.get(cmd.g);
					if (p) link.lr({ t: "vals", vals: { [p]: values[p] } });
				}
			}
		};
		// Dials 2 and 3 turned together: their ticks interleave, 10 ms apart, so each param's come every 20 ms.
		for (let i = 0; i < 20; i++) {
			if (i % 2 === 0) model.turn("Exposure", 1, "normal", slot("Exposure"), "dial-2");
			else model.turn("Contrast", 1, "normal", slot("Contrast"), "dial-3");
			lightroom();
			clock.advance(10);
			lightroom();
		}
		clock.advance(1200);
		lightroom();

		const wire = link.sent.map((s) => ({ ...s.cmd, at: s.at }) as Command & { at: number });
		const problems: string[] = [];
		const early: string[] = [];
		const ended = new Set<number>();
		const lastSet = new Map<string, number>();
		wire.forEach((cmd, i) => {
			if (cmd.t === "done" && cmd.g !== undefined) ended.add(cmd.g);
			if (cmd.t !== "set") return;
			if (ended.has(cmd.g)) problems.push(`a set of gesture ${cmd.g} after its done`);
			const gap = cmd.at - (lastSet.get(cmd.p) ?? Number.NEGATIVE_INFINITY);
			lastSet.set(cmd.p, cmd.at);
			if (gap >= Math.ceil(1000 / 30)) return;
			// Sooner than 30 a second allows: only as a gesture's final set, straight before its done, when another dial took over.
			const next = wire[i + 1];
			const later = wire.slice(i + 1).some((c) => c.t === "set" && c.g === cmd.g);
			if (next?.t !== "done" || next.g !== cmd.g || later || wire[i + 2]?.t !== "set" || (wire[i + 2] as SetCmd).p === cmd.p) {
				problems.push(`set ${cmd.p} g ${cmd.g} came ${gap} ms after the last one, and isn't an early final set`);
			} else early.push(`${cmd.p} g ${cmd.g}`);
		});
		assert.deepEqual(problems, []);
		assert.ok(early.length >= 10, `the takeovers sent ${early.length} early final sets`);
		assert.equal(new Set(early).size, early.length, "at most one per gesture");
		const gestures = new Set(wire.flatMap((c) => (c.t === "set" ? [c.g] : [])));
		assert.deepEqual([...gestures].filter((g) => !ended.has(g)), [], "every gesture ended with done");
		// Both values land: Lightroom holds each param's last set, the deck shows the same, and both moved.
		assert.deepEqual([model.view("Exposure").value, model.view("Contrast").value], [values.Exposure, values.Contrast]);
		assert.equal(values.Contrast, 10, "ten whole-number ticks");
		assert.ok((values.Exposure ?? 0) > 0.6, `Exposure moved to ${values.Exposure}`);
		assert.equal(model.gesture, null);
		noProblems(link);
	});

	test("clamping at both ends of a range: pinned at a limit, more ticks send nothing, and one tick back moves at once", () => {
		const { clock, link, model } = setup();
		link.lr({ t: "vals", vals: { Shadows: -98, Temperature: 49_900 } });
		model.turn("Shadows", -10, "normal", slot("Shadows"), "dial-1");
		assert.deepEqual(sets(link.take()).map((s) => s.v), [-100]);
		clock.advance(50);
		model.turn("Shadows", -10, "normal", slot("Shadows"), "dial-1");
		clock.advance(50);
		assert.deepEqual(link.take(), [], "nothing new to send at the bottom");
		model.turn("Shadows", 1, "normal", slot("Shadows"), "dial-1");
		assert.deepEqual(sets(link.take()).map((s) => s.v), [-99]);
		clock.advance(1000);
		link.take();
		model.turn("Temperature", 4, "normal", slot("Temperature"), "dial-0"); // 4 × 50 K past 49 900
		clock.advance(50);
		model.turn("Temperature", 4, "normal", slot("Temperature"), "dial-0");
		clock.advance(50);
		assert.deepEqual(sets(link.take()).map((s) => s.v), [50_000], "pinned at the top: one set");
		assert.equal(model.view("Temperature").value, 50_000);
		model.turn("Temperature", -1, "normal", slot("Temperature"), "dial-0");
		assert.deepEqual(sets(link.take()).map((s) => s.v), [49_950]);
		noProblems(link);
	});
});
