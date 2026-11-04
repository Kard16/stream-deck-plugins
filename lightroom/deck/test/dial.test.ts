import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DialDeck, type DialSurface } from "../src/dial/deck.js";
import { isSlidersRequest, slidersReply } from "../src/dial/inspector.js";
import { StripPainter } from "../src/dial/painter.js";
import { macroText, STATUS_FONT, STRIP_COLORS, stripFor, UNLISTED_STATUS, VALUE_FONT } from "../src/dial/strip.js";
import type { Command, SetCmd } from "../src/lr/protocol.js";
import { formatValue } from "../src/model/format.js";
import { LrModel } from "../src/model/model.js";
import { DEFAULT_SLIDERS, parseSliders, type Slider, type SliderConfig, sliderFor } from "../src/sliders.js";
import type { Log } from "../src/util/log.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { FakeLink } from "./helpers/fake-link.js";
import { RecordingLog } from "./helpers/recording-log.js";

const RAW_RANGES = {
	Temperature: [2000, 50000],
	Tint: [-150, 150],
	Exposure: [-5, 5],
	Contrast: [-100, 100],
	Highlights: [-100, 100],
	Shadows: [-100, 100],
	Whites: [-100, 100],
	Blacks: [-100, 100],
	Texture: [-100, 100],
	Clarity: [-100, 100],
	Dehaze: [-100, 100],
	Vibrance: [-100, 100],
	Saturation: [-100, 100],
	Sharpness: [0, 150],
	LuminanceSmoothing: [0, 100],
	PostCropVignetteAmount: [-100, 100],
	GrainAmount: [0, 100],
};
const RAW_VALUES = {
	Temperature: 5500,
	Tint: 10,
	Exposure: 0.35,
	Contrast: 0,
	Highlights: -20,
	Shadows: 15,
	Whites: 0,
	Blacks: 0,
	Texture: 0,
	Clarity: 0,
	Dehaze: 0,
	Vibrance: 0,
	Saturation: 0,
	Sharpness: 40,
	LuminanceSmoothing: 0,
	PostCropVignetteAmount: 0,
	GrainAmount: 0,
};
const STATE_101 = { t: "state", module: "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1, locked: false };

type FakeDial = DialSurface & { payloads: Record<string, unknown>[]; alerts: number; saved: { param: string }[] };

function surface(): FakeDial {
	const d: FakeDial = {
		payloads: [],
		alerts: 0,
		saved: [],
		setFeedback: (payload) => d.payloads.push(payload),
		showAlert: () => {
			d.alerts += 1;
		},
		setSettings: (settings) => d.saved.push(settings),
	};
	return d;
}

type Setup = { module?: string; writable?: boolean; locked?: boolean; log?: Log; config?: SliderConfig; settings?: Record<string, unknown>[] };

/** Lightroom on photo 101 in Develop, and four dials in columns 0–3 with the given settings (none: the column defaults). */
function setup(opts: Setup = {}) {
	const clock = new FakeClock();
	const link = new FakeLink(clock);
	const model = new LrModel(link, { clock, log: opts.log });
	const deck = new DialDeck(opts.config ?? DEFAULT_SLIDERS, model, { clock, log: opts.log });
	link.lr({ t: "hello", v: 1, guard: "on", writable: opts.writable ?? true, inst: "A" });
	link.lr({ ...STATE_101, module: opts.module ?? "develop", locked: opts.locked ?? false });
	link.lr({ t: "ranges", ranges: RAW_RANGES });
	link.lr({ t: "vals", vals: RAW_VALUES });
	const dials = [surface(), surface(), surface(), surface()];
	dials.forEach((d, column) => deck.add(`dial-${column}`, column, d, opts.settings?.[column] ?? {}));
	clock.advance(100);
	link.take();
	return { clock, link, model, deck, dials };
}

const DIALS = ["dial-0", "dial-1", "dial-2", "dial-3"];
const item = (deck: DialDeck, id: string, key: string): { value?: unknown; color?: unknown } | undefined =>
	deck.painted(id)?.[key] as { value?: unknown; color?: unknown } | undefined;
const text = (deck: DialDeck, id: string, key: string): unknown => item(deck, id, key)?.value;
const texts = (deck: DialDeck, key: string, ids: string[] = DIALS): unknown[] => ids.map((id) => text(deck, id, key));
const fill = (deck: DialDeck, id: string): unknown => (deck.painted(id)?.bar as { bar_fill_c?: unknown } | undefined)?.bar_fill_c;
const wire = (cmds: Command[]): Record<string, unknown>[] =>
	cmds.map((c) => {
		const { id: _id, ...rest } = c as Command & { id?: number };
		return rest;
	});
const setValues = (cmds: Command[]): number[] => cmds.flatMap((c) => (c.t === "set" ? [c.v] : []));

describe("Develop Dial: each dial has its own slider", () => {
	test("each dial shows the slider its settings name, and two dials may show the same one", () => {
		const { clock, link, deck, dials } = setup({ settings: [{ param: "Dehaze" }, { param: "Sharpness" }, { param: "Exposure" }, { param: "Exposure" }] });
		assert.deepEqual(texts(deck, "label"), ["Dehaze", "Sharpening", "Exposure", "Exposure"]);
		assert.deepEqual(texts(deck, "value"), ["0", "40", "+0.35", "+0.35"]);
		assert.deepEqual(texts(deck, "mode"), ["", "", "", ""], "big steps are off");
		assert.deepEqual(
			dials.map((d) => d.saved),
			[[], [], [], []],
			"settings that name a slider aren't saved again",
		);
		assert.deepEqual(DIALS.map((id) => deck.paramOf(id)), ["Dehaze", "Sharpness", "Exposure", "Exposure"]);
		deck.rotate("dial-3", 1, false);
		clock.advance(100);
		assert.deepEqual(wire(link.take()), [{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" }]);
		assert.deepEqual(texts(deck, "value", ["dial-2", "dial-3"]), ["+0.38", "+0.38"], "both Exposure dials follow");
	});

	test("a dial that appears without a slider gets its column's default, saved with setSettings: Temp, Tint, Exposure, Contrast, then the first slider", () => {
		const { deck, dials } = setup();
		assert.deepEqual(texts(deck, "label"), ["Temp", "Tint", "Exposure", "Contrast"]);
		assert.deepEqual(texts(deck, "value"), ["5500 K", "+10", "+0.35", "0"]);
		assert.deepEqual(
			dials.map((d) => d.saved),
			[[{ param: "Temperature" }], [{ param: "Tint" }], [{ param: "Exposure" }], [{ param: "Contrast" }]],
		);
		const fifth = surface();
		deck.add("dial-x", 4, fifth, {});
		assert.deepEqual(fifth.saved, [{ param: "Temperature" }], "any other column: the first slider");
		for (const settings of [{ param: "" }, { param: 7 }, null, "Exposure"]) {
			const d = surface();
			deck.add("dial-y", 2, d, settings);
			assert.deepEqual(d.saved, [{ param: "Exposure" }], `settings ${JSON.stringify(settings)} name no slider`);
			deck.remove("dial-y");
		}
	});

	test("with a sliders.json that lacks a column's default, that column gets the first slider", () => {
		const { config, errors } = parseSliders(JSON.stringify({ sliders: [{ param: "Dehaze", label: "Dehaze", step: 1 }, { param: "Exposure", label: "EV", step: "1/30", precision: 2 }] }));
		assert.deepEqual(errors, []);
		const { deck, dials } = setup({ config });
		assert.deepEqual(texts(deck, "label"), ["Dehaze", "Dehaze", "EV", "Dehaze"]);
		assert.deepEqual(
			dials.map((d) => d.saved.map((s) => s.param)),
			[["Dehaze"], ["Dehaze"], ["Exposure"], ["Dehaze"]],
		);
	});

	test("choosing another slider in the Property Inspector repaints the dial at once and sends Lightroom nothing", () => {
		const { clock, link, deck, dials } = setup();
		deck.settings("dial-2", { param: "Highlights" });
		assert.deepEqual([text(deck, "dial-2", "label"), text(deck, "dial-2", "value")], ["Highlights", "-20"], "no wait");
		assert.deepEqual(link.take(), []);
		assert.deepEqual(dials[2]?.saved, [{ param: "Exposure" }], "the Property Inspector saved it, not the plugin");
		deck.rotate("dial-2", 1, false);
		assert.deepEqual(wire(link.take()), [{ t: "set", p: "Highlights", v: -19, g: 1, ph: "101" }]);
		clock.advance(1000);
		link.take();
		// Settings that name no slider: the column's default again, saved.
		deck.settings("dial-2", {});
		clock.advance(100);
		assert.equal(text(deck, "dial-2", "label"), "Exposure");
		assert.deepEqual(dials[2]?.saved, [{ param: "Exposure" }, { param: "Exposure" }]);
		deck.settings("nobody", { param: "Tint" });
		assert.deepEqual(link.take(), []);
	});

	test("a press that spans a change of slider resets neither slider; one that turned still ends its gesture on release", () => {
		const { clock, link, deck } = setup();
		deck.down("dial-2"); // on Exposure
		deck.settings("dial-2", { param: "Tint" }); // the Property Inspector, while the dial is held
		deck.up("dial-2");
		assert.deepEqual(link.take(), [], "no reset: the press began on Exposure, and the dial shows Tint now");
		deck.down("dial-2");
		deck.up("dial-2");
		assert.deepEqual(wire(link.take()), [{ t: "reset", p: "Tint", ph: "101" }], "the next press resets Tint");
		link.lr({ t: "ack", p: "Tint", v: 0 });
		// Held across the change, then turned: push + turn on the new slider, which the release ends at once.
		deck.down("dial-2");
		deck.settings("dial-2", { param: "Exposure" });
		deck.rotate("dial-2", 4, true);
		deck.up("dial-2");
		assert.deepEqual(wire(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" },
			{ t: "done", g: 1 },
		]);
		// Turned, then changed: the release ends the old slider's gesture at once, and resets nothing.
		clock.advance(1000);
		deck.down("dial-2");
		deck.rotate("dial-2", 4, true);
		deck.settings("dial-2", { param: "Contrast" });
		deck.up("dial-2");
		assert.deepEqual(wire(link.take()), [
			{ t: "set", p: "Exposure", v: 0.41, g: 2, ph: "101" },
			{ t: "done", g: 2 },
		]);
	});

	test("the Property Inspector asks with getSliders, and the answer is every slider in file order with that dial's param", () => {
		assert.equal(isSlidersRequest({ t: "getSliders" }), true);
		for (const other of [{ t: "getPresets" }, null, "getSliders", {}]) assert.equal(isSlidersRequest(other), false, JSON.stringify(other));
		const { deck } = setup({ settings: [{}, { param: "Bogus" }, { param: "GrainAmount" }, {}] });
		const reply = deck.slidersReply("dial-2");
		assert.equal(reply.t, "sliders");
		assert.equal(reply.param, "GrainAmount");
		assert.equal(reply.items.length, 17);
		assert.deepEqual(reply.items.slice(0, 3), [
			{ param: "Temperature", label: "Temp" },
			{ param: "Tint", label: "Tint" },
			{ param: "Exposure", label: "Exposure" },
		]);
		assert.deepEqual(
			reply.items.map((i) => i.param),
			DEFAULT_SLIDERS.sliders.map((s) => s.param),
		);
		assert.equal(deck.slidersReply("dial-1").param, "Bogus", "an unlisted param, for the Property Inspector to show as such");
		assert.equal(deck.slidersReply("dial-0").param, "Temperature", "a column default");
		assert.equal(deck.slidersReply("nobody").param, null);
		assert.deepEqual(JSON.parse(JSON.stringify(slidersReply(DEFAULT_SLIDERS.sliders, "Tint"))), slidersReply(DEFAULT_SLIDERS.sliders, "Tint"), "plain JSON");
	});

	test("a param sliders.json doesn't list: the param as the label, Not listed, no bar; turns, presses and taps only alert, once per burst", () => {
		const { clock, link, deck, dials } = setup({ settings: [{ param: "Bogus" }, {}, {}, {}] });
		assert.deepEqual(item(deck, "dial-0", "label"), { value: "Bogus", color: STRIP_COLORS.label });
		assert.deepEqual(deck.painted("dial-0")?.value, { value: UNLISTED_STATUS, color: STRIP_COLORS.status, font: STATUS_FONT });
		assert.equal((deck.painted("dial-0")?.bar as { opacity?: unknown }).opacity, 0, "no bar");
		assert.deepEqual(dials[0]?.saved, [], "its settings name a param, so nothing is saved");
		assert.equal(deck.rotate("dial-0", 3, false), "unlisted");
		clock.advance(50);
		deck.rotate("dial-0", 3, true);
		deck.up("dial-0");
		deck.down("dial-0");
		deck.up("dial-0"); // a press
		deck.tap("dial-0", false);
		deck.tap("dial-0", true);
		assert.equal(deck.bigSteps("dial-0"), false, "taps don't turn big steps on");
		assert.equal(dials[0]?.alerts, 1, "one alert for the burst");
		clock.advance(800);
		deck.tap("dial-0", false);
		assert.equal(dials[0]?.alerts, 2, "after a pause, a new burst");
		clock.advance(800);
		deck.down("dial-0");
		deck.up("dial-0");
		assert.equal(dials[0]?.alerts, 3, "a press alerts too");
		clock.advance(2000);
		assert.deepEqual(link.take(), [], "nothing goes to Lightroom");
		assert.equal(text(deck, "dial-0", "value"), UNLISTED_STATUS);
		// Choosing a listed slider brings the dial to life.
		deck.settings("dial-0", { param: "Clarity" });
		clock.advance(100);
		assert.deepEqual([text(deck, "dial-0", "label"), text(deck, "dial-0", "value")], ["Clarity", "0"]);
		assert.equal(deck.rotate("dial-0", 1, false), "applied");
	});

	test("a page switch: the dials that go stop painting and lose their timers, and the new page's dials show their own sliders", () => {
		const { clock, link, deck, dials } = setup();
		deck.tap("dial-1", false); // big steps on Tint: a timer
		const timers = clock.pendingTimers;
		for (const id of DIALS) deck.remove(id); // willDisappear for the page
		assert.equal(clock.pendingTimers, timers - 1, "the big-step timer went with the dial");
		const page2 = DIALS.map(() => surface());
		const params = ["Highlights", "Shadows", "Whites", "Blacks"];
		page2.forEach((d, c) => deck.add(`page2-${c}`, c, d, { param: params[c] }));
		const ids2 = page2.map((_, c) => `page2-${c}`);
		assert.deepEqual(texts(deck, "label", ids2), params);
		assert.deepEqual(texts(deck, "value", ids2), ["-20", "+15", "0", "0"]);
		assert.deepEqual(
			page2.map((d) => d.saved),
			[[], [], [], []],
		);
		const before = dials.map((d) => d.payloads.length);
		link.lr({ t: "vals", vals: { Tint: 20, Highlights: -30 } });
		clock.advance(3000);
		assert.deepEqual(
			dials.map((d) => d.payloads.length),
			before,
			"the old page's dials get no more feedback",
		);
		assert.equal(text(deck, "page2-0", "value"), "-30");
		assert.equal(deck.rotate("dial-1", 1, false), "ignored", "a dial that's gone");
		// Back to page 1: its dials come back with their saved settings, and big steps off.
		for (const id of ids2) deck.remove(id);
		dials.forEach((d, c) => deck.add(DIALS[c] ?? "", c, d, { param: d.saved[0]?.param }));
		assert.deepEqual(texts(deck, "label"), ["Temp", "Tint", "Exposure", "Contrast"]);
		assert.equal(text(deck, "dial-1", "value"), "+20");
		assert.equal(deck.bigSteps("dial-1"), false);
		assert.equal(text(deck, "dial-1", "mode"), "");
		assert.deepEqual(link.take(), []);
	});

	test("a dial that goes and comes back within one strip interval shows only its new slider: the old strip's pending paint goes with it", () => {
		const { clock, deck, dials } = setup();
		deck.rotate("dial-3", 1, false); // Contrast +1, painted at once
		clock.advance(10);
		deck.rotate("dial-3", 1, false); // +2, waiting for the strip interval
		const before = dials[3]?.payloads.length;
		deck.remove("dial-3"); // willDisappear, then willAppear for the same id, as when an action moves
		const again = surface();
		deck.add("dial-3", 3, again, { param: "Highlights" });
		clock.advance(200);
		assert.deepEqual(
			again.payloads.map((p) => (p.value as { value?: unknown } | undefined)?.value),
			["-20"],
			"one paint, of Highlights in full, and nothing of Contrast's",
		);
		assert.deepEqual(Object.keys(again.payloads[0] ?? {}).sort(), ["bar", "label", "mode", "value"]);
		assert.equal(text(deck, "dial-3", "label"), "Highlights");
		assert.equal(dials[3]?.payloads.length, before, "the old surface gets nothing more");
	});
});

describe("Develop Dial: gestures", () => {
	test("turning adjusts with acceleration: 1, 2, 3, 4 ticks an event move 1, 3, 6, 10 steps", () => {
		const { clock, link, deck } = setup();
		const values: number[] = [];
		for (const ticks of [1, 2, 3, 4]) {
			assert.equal(deck.mode("dial-3", false), "normal");
			deck.rotate("dial-3", ticks, false);
			clock.advance(50);
			values.push(...setValues(link.take()));
		}
		assert.deepEqual(values, [1, 4, 10, 20]);
	});

	test("push + turn is fine (a quarter step, no acceleration) and the release doesn't reset", () => {
		const { clock, link, deck } = setup();
		deck.down("dial-3");
		assert.equal(deck.mode("dial-3", true), "fine");
		deck.rotate("dial-3", 4, true); // 4 × 0.25 = 1, where unpressed 4 ticks would be 10
		clock.advance(50);
		deck.up("dial-3");
		assert.deepEqual(wire(link.take()), [
			{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" },
			{ t: "done", g: 1 },
		]);
	});

	test("a slider's own fine and macro from sliders.json set its steps, on raw files and rendered ones", () => {
		const { config, errors } = parseSliders(
			JSON.stringify({
				sliders: [
					{ param: "Temperature", label: "Temp", step: 1, fine: 0.5, macro: 8, kelvin: { step: 50, fine: 25, macro: 250 } },
					{ param: "Contrast", label: "Contrast", step: 1, fine: "1/2", macro: 5 },
					{ param: "Exposure", label: "Exposure", step: "1/30", fine: "1/60", macro: "1/2", precision: 2 },
				],
			}),
		);
		assert.deepEqual(errors, []);
		const { clock, link, deck } = setup({ config, settings: [{ param: "Temperature" }, { param: "Contrast" }, { param: "Exposure" }, { param: "Exposure" }] });
		/** A gesture in each mode: a click, push + turn for 4, then a tap and `big` clicks. Their sets, and the mode text in big steps. */
		const turns = (id: string, big: number): [number[], number[], number[], unknown] => {
			deck.rotate(id, 1, false);
			clock.advance(1000);
			const normal = setValues(link.take());
			deck.down(id);
			deck.rotate(id, 4, true);
			deck.up(id);
			clock.advance(1000);
			const fine = setValues(link.take());
			deck.tap(id, false);
			const shown = text(deck, id, "mode");
			deck.rotate(id, big, false);
			clock.advance(2000); // done, and big steps off by themselves
			return [normal, fine, setValues(link.take()), shown];
		};
		// Each gesture starts from the value the one before it sent. With the defaults, fine would be a quarter step and a big step ten.
		assert.deepEqual(turns("dial-1", 3), [[1], [3], [18], "×5"], "Contrast from 0: 1, then 4 × 1/2, then 3 × 5");
		assert.deepEqual(turns("dial-2", 2), [[0.38], [0.45], [1.45], "×15"], "Exposure from 0.35: 1/30, then 4 × 1/60, then 2 × 1/2");
		assert.deepEqual(turns("dial-0", 2), [[5550], [5650], [6150], "×5"], "Temperature on a raw file, from 5500 K: 50, then 4 × 25, then 2 × 250");
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		link.lr({ t: "ranges", ranges: { ...RAW_RANGES, Temperature: [-100, 100], Tint: [-100, 100] } });
		link.lr({ t: "vals", vals: { Temperature: 0 } });
		assert.deepEqual(turns("dial-0", 2), [[1], [3], [19], "×8"], "on a rendered file, from 0: 1, then 4 × 1/2, then 2 × 8");
	});

	test("pressing without turning resets the dial's slider; a long touch no longer does", () => {
		const { link, deck } = setup();
		deck.down("dial-2");
		deck.up("dial-2");
		deck.tap("dial-1", true);
		assert.deepEqual(wire(link.take()), [{ t: "reset", p: "Exposure", ph: "101" }]);
		assert.equal(deck.bigSteps("dial-1"), true, "the long touch turned big steps on");
	});

	test("a dial-up without a press this plugin saw does nothing (the dial was held when the plugin started)", () => {
		const { clock, link, deck } = setup();
		deck.up("dial-2");
		assert.deepEqual(link.take(), [], "no reset");
		// Held at startup and turned: the push + turn shows it's down, so its release still ends the fine gesture.
		deck.rotate("dial-3", 4, true);
		clock.advance(50);
		deck.up("dial-3");
		assert.deepEqual(
			link.take().map((c) => c.t),
			["set", "done"],
		);
	});

	test("at most 15 strip updates a second per dial, each with only the changed keys", () => {
		const { clock, deck, dials } = setup();
		const dial = dials[3];
		assert.ok(dial);
		dial.payloads.length = 0;
		for (let i = 0; i < 60; i++) {
			deck.rotate("dial-3", 1, false);
			clock.advance(1000 / 60);
		}
		clock.advance(100);
		assert.ok(dial.payloads.length <= 16, `${dial.payloads.length} updates`);
		for (const payload of dial.payloads) assert.deepEqual(Object.keys(payload).sort(), ["bar", "value"], "label and mode didn't change");
		assert.equal(text(deck, "dial-3", "value"), "+60");
		assert.equal(dials[0]?.payloads.length, 1, "the other dials only painted once, on appearing");
	});

	test("an alert goes to the dial whose command Lightroom refused", () => {
		const { link, deck, dials } = setup();
		deck.rotate("dial-2", 1, false);
		const set = link.take().find((c): c is SetCmd => c.t === "set");
		assert.ok(set);
		link.err(set, "bad");
		assert.deepEqual(
			dials.map((d) => d.alerts),
			[0, 0, 1, 0],
		);
	});

	test("a preset that changes sliders: the vals that follow its applied update the strips, the one just turned when its echo window closes", () => {
		const { clock, link, deck } = setup();
		deck.rotate("dial-2", 1, false); // Exposure 0.38
		clock.advance(800); // done
		link.take();
		// The Apply Preset key's request is answered, then Lightroom's observer reports what the preset changed.
		link.lr({ t: "applied", id: 1, uuid: "P1", n: 1, locked: 0 });
		link.lr({ t: "vals", vals: { Temperature: 6100, Exposure: 1.2, Contrast: 25, Highlights: -40 } });
		clock.advance(100);
		assert.deepEqual(texts(deck, "value"), ["6100 K", "+10", "+0.38", "+25"], "Exposure's echo window is still open, so its new value waits");
		clock.advance(200);
		assert.equal(text(deck, "dial-2", "value"), "+1.20", "then the preset's value");
		deck.settings("dial-0", { param: "Highlights" });
		clock.advance(100);
		assert.equal(text(deck, "dial-0", "value"), "-40", "a dial switched to Highlights shows the preset's value too");
		assert.deepEqual(link.take(), [], "the deck sends nothing for any of it");
	});
});

describe("Develop Dial: big steps", () => {
	test("a tap turns them on for that dial alone: ×10 and the bar in green, and each tick moves a big step, with no acceleration", () => {
		const { clock, link, deck, dials } = setup();
		deck.tap("dial-2", false);
		assert.deepEqual(
			DIALS.map((id) => deck.bigSteps(id)),
			[false, false, true, false],
		);
		assert.deepEqual(item(deck, "dial-2", "mode"), { value: "×10", color: STRIP_COLORS.macro });
		assert.equal(fill(deck, "dial-2"), STRIP_COLORS.macro);
		assert.equal(fill(deck, "dial-3"), STRIP_COLORS.fill, "the other dials keep the blue fill");
		assert.deepEqual(link.take(), [], "a tap sends Lightroom nothing");
		assert.equal(deck.mode("dial-2", false), "macro");
		assert.equal(deck.rotate("dial-2", 4, false), "applied");
		clock.advance(50);
		// An event of 4 ticks is exactly 4 big steps: 4 × 1/3 EV. With acceleration it would be 10 of them.
		assert.deepEqual(wire(link.take()), [{ t: "set", p: "Exposure", v: 1.68, g: 1, ph: "101" }]);
		deck.rotate("dial-2", -1, false);
		clock.advance(50);
		assert.deepEqual(setValues(link.take()), [1.35], "one big step back");
		deck.rotate("dial-3", 4, false); // normal steps on Contrast, accelerated: 10
		clock.advance(50);
		assert.deepEqual(setValues(link.take()), [10]);
		clock.advance(800);
		assert.deepEqual(
			link.take().map((c) => c.t),
			["done"],
			"one gesture per burst, as for any turn",
		);
		assert.deepEqual(
			dials.map((d) => d.alerts),
			[0, 0, 0, 0],
		);
	});

	test("Temperature's big steps are 500 K on raw files and 10 on rendered ones; the strip says ×10 on both", () => {
		const { clock, link, deck } = setup();
		deck.tap("dial-0", false);
		assert.equal(text(deck, "dial-0", "mode"), "×10");
		deck.rotate("dial-0", 2, false);
		clock.advance(1000);
		assert.deepEqual(
			wire(link.take()),
			[
				{ t: "set", p: "Temperature", v: 6500, g: 1, ph: "101" },
				{ t: "done", g: 1 },
			],
		);
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		link.lr({ t: "ranges", ranges: { ...RAW_RANGES, Temperature: [-100, 100], Tint: [-100, 100] } });
		link.lr({ t: "vals", vals: { Temperature: 0 } });
		assert.equal(deck.bigSteps("dial-0"), true, "a photo change leaves them on");
		deck.rotate("dial-0", 1, false);
		clock.advance(100);
		assert.deepEqual(setValues(link.take()), [10]);
		assert.equal(text(deck, "dial-0", "mode"), "×10");
		assert.equal(text(deck, "dial-0", "value"), "+10");
	});

	test("another tap turns them off, and a long touch toggles them just like a tap", () => {
		const { clock, link, deck } = setup();
		const flips: [boolean, boolean][] = [
			[false, true],
			[false, false],
			[true, true],
			[true, false],
			[false, true],
			[true, false],
			[true, true],
			[false, false],
		];
		for (const [hold, on] of flips) {
			deck.tap("dial-1", hold);
			clock.advance(100);
			assert.equal(deck.bigSteps("dial-1"), on, `${hold ? "long touch" : "tap"} → ${on ? "on" : "off"}`);
			assert.equal(text(deck, "dial-1", "mode"), on ? "×10" : "");
			assert.equal(fill(deck, "dial-1"), on ? STRIP_COLORS.macro : STRIP_COLORS.fill);
		}
		assert.deepEqual(link.take(), [], "no reset, no set: taps send nothing");
	});

	test(`they go off after macroSeconds without a turn, counted from the tap and restarted by every turn`, () => {
		const { clock, link, deck } = setup();
		deck.tap("dial-2", false);
		clock.advance(1999);
		assert.equal(deck.bigSteps("dial-2"), true);
		clock.advance(1);
		assert.equal(deck.bigSteps("dial-2"), false, "2 s after the tap");
		assert.equal(text(deck, "dial-2", "mode"), "");
		assert.equal(fill(deck, "dial-2"), STRIP_COLORS.fill);
		deck.tap("dial-2", false);
		clock.advance(1500);
		deck.rotate("dial-2", 1, false); // restarts the count
		clock.advance(1500);
		deck.rotate("dial-2", 1, false);
		clock.advance(1999);
		assert.equal(deck.bigSteps("dial-2"), true, "1999 ms after the last turn");
		clock.advance(1);
		assert.equal(deck.bigSteps("dial-2"), false, "2 s after the last turn");
		assert.deepEqual(
			wire(link.take()),
			[
				{ t: "set", p: "Exposure", v: 0.68, g: 1, ph: "101" },
				{ t: "done", g: 1 },
				{ t: "set", p: "Exposure", v: 1.01, g: 2, ph: "101" },
				{ t: "done", g: 2 },
			],
			"going off sends nothing; each gesture starts from the value it last sent",
		);
		deck.rotate("dial-2", 1, false);
		clock.advance(100);
		assert.deepEqual(setValues(link.take()), [1.04], "a normal step again");
	});

	test("macroSeconds from sliders.json sets the time", () => {
		const { config } = parseSliders(JSON.stringify({ macroSeconds: 0.5, sliders: [{ param: "Exposure", label: "Exposure", step: "1/30", precision: 2 }] }));
		assert.equal(config.macroSeconds, 0.5);
		const { clock, deck } = setup({ config, settings: [{ param: "Exposure" }, {}, {}, {}] });
		deck.tap("dial-0", false);
		clock.advance(499);
		assert.equal(deck.bigSteps("dial-0"), true);
		clock.advance(1);
		assert.equal(deck.bigSteps("dial-0"), false);
	});

	test("they go off on dial-down, so a press still resets and push + turn is fine", () => {
		const { clock, link, deck } = setup();
		deck.tap("dial-2", false);
		clock.advance(100);
		deck.down("dial-2");
		assert.equal(deck.bigSteps("dial-2"), false, "off as the dial goes down");
		clock.advance(100);
		assert.equal(text(deck, "dial-2", "mode"), "");
		deck.up("dial-2");
		assert.deepEqual(wire(link.take()), [{ t: "reset", p: "Exposure", ph: "101" }]);
		link.lr({ t: "ack", p: "Exposure", v: 0 });
		deck.tap("dial-2", false);
		deck.down("dial-2");
		assert.equal(deck.mode("dial-2", true), "fine");
		deck.rotate("dial-2", 4, true);
		clock.advance(50);
		deck.up("dial-2");
		assert.deepEqual(
			wire(link.take()),
			[
				{ t: "set", p: "Exposure", v: 0.03, g: 1, ph: "101" },
				{ t: "done", g: 1 },
			],
			"4 fine ticks from 0: 4/120",
		);
		clock.advance(1000);
		assert.equal(deck.mode("dial-2", false), "normal", "still off after the release");
		deck.rotate("dial-2", 1, false);
		assert.deepEqual(setValues(link.take()), [0.06], "a normal step, from the 0.03 sent");
	});

	test("push + turn is fine even with big steps on, after a tap while the dial is held, and its release ends the gesture at once", () => {
		const { clock, link, deck } = setup();
		deck.down("dial-2"); // Exposure: big steps off as the dial goes down
		deck.tap("dial-2", false); // and on again while it's held
		assert.equal(deck.bigSteps("dial-2"), true);
		assert.equal(deck.mode("dial-2", true), "fine", "the press wins");
		deck.rotate("dial-2", 4, true);
		assert.deepEqual(wire(link.take()), [{ t: "set", p: "Exposure", v: 0.38, g: 1, ph: "101" }], "4/120 from 0.35, where 4 big steps would be 1.68");
		deck.up("dial-2");
		assert.deepEqual(wire(link.take()), [{ t: "done", g: 1 }], "the release ends it now, and doesn't reset");
		assert.equal(deck.mode("dial-2", false), "macro", "big steps are still on for turns without the press");
		clock.advance(100);
		deck.rotate("dial-2", 1, false);
		assert.deepEqual(setValues(link.take()), [0.71], "a big step from the 0.38 sent");
	});

	test("they go off when the dial disappears or its slider changes, and the timer goes with them", () => {
		const { clock, link, deck, dials } = setup();
		deck.tap("dial-1", false);
		const timers = clock.pendingTimers;
		deck.remove("dial-1");
		assert.equal(clock.pendingTimers, timers - 1);
		deck.add("dial-1", 1, dials[1] ?? surface(), { param: "Tint" });
		assert.equal(deck.bigSteps("dial-1"), false);
		deck.tap("dial-2", false);
		clock.advance(100);
		const before = clock.pendingTimers;
		deck.settings("dial-2", { param: "Clarity" });
		assert.equal(deck.bigSteps("dial-2"), false);
		assert.equal(clock.pendingTimers, before - 1);
		clock.advance(100);
		assert.deepEqual([text(deck, "dial-2", "label"), text(deck, "dial-2", "mode"), fill(deck, "dial-2")], ["Clarity", "", STRIP_COLORS.fill]);
		deck.tap("dial-3", false);
		deck.settings("dial-3", { param: "Contrast" }); // the same slider: nothing changes
		assert.equal(deck.bigSteps("dial-3"), true);
		deck.tap("dial-0", false);
		const again = surface();
		deck.add("dial-0", 0, again, { param: "Temperature" }); // appears again without disappearing
		assert.equal(deck.bigSteps("dial-0"), false);
		clock.advance(100);
		assert.deepEqual(Object.keys(again.payloads[0] ?? {}).sort(), ["bar", "label", "mode", "value"], "its strip, in full, through the surface it came back with");
		assert.deepEqual(link.take(), []);
	});

	test("taps work in every state and send nothing: offline, busy, mismatched, read-only, outside Develop, locked", () => {
		const cases: [string, Setup, (link: FakeLink) => void][] = [
			["offline", {}, (link) => link.setState("offline")],
			["busy", {}, (link) => link.setState("busy")],
			["mismatched", {}, (link) => link.setState("mismatch")],
			["read-only", { writable: false }, () => undefined],
			["outside Develop", { module: "library" }, () => undefined],
			["locked", { locked: true }, () => undefined],
		];
		for (const [what, opts, enter] of cases) {
			const { clock, link, deck, dials } = setup(opts);
			enter(link);
			clock.advance(100);
			deck.tap("dial-2", false);
			clock.advance(100);
			assert.equal(deck.bigSteps("dial-2"), true, what);
			assert.deepEqual(item(deck, "dial-2", "mode"), { value: "×10", color: STRIP_COLORS.dimMacro }, `${what}: dimmed green`);
			assert.equal(fill(deck, "dial-2"), STRIP_COLORS.dimMacro, what);
			deck.tap("dial-2", true);
			clock.advance(100);
			assert.equal(deck.bigSteps("dial-2"), false, what);
			assert.equal(fill(deck, "dial-2"), STRIP_COLORS.dimFill, what);
			assert.deepEqual(link.take(), [], `${what}: nothing sent`);
			assert.equal(dials[2]?.alerts, 0, `${what}: no alert`);
		}
	});

	test("while the photo is locked, turns and presses send nothing and alert once per burst; taps and long touches still switch big steps", () => {
		const { clock, link, deck, dials } = setup();
		link.lr({ ...STATE_101, locked: true });
		clock.advance(100);
		assert.deepEqual(texts(deck, "value"), ["Locked", "Locked", "Locked", "Locked"]);
		deck.tap("dial-2", false); // big steps on, as usual
		assert.equal(deck.rotate("dial-2", 1, false), "locked");
		clock.advance(50);
		deck.rotate("dial-2", 2, false); // the same burst
		deck.down("dial-3");
		deck.up("dial-3"); // a press: no reset
		deck.down("dial-0");
		deck.rotate("dial-0", 1, true); // push + turn: dropped, and the release doesn't reset
		deck.up("dial-0");
		deck.tap("dial-1", true); // a long touch: big steps on
		clock.advance(100);
		assert.deepEqual(link.take(), []);
		assert.deepEqual(
			dials.map((d) => d.alerts),
			[1, 0, 1, 1],
		);
		assert.deepEqual(
			DIALS.map((id) => deck.bigSteps(id)),
			[false, true, true, false],
		);
		assert.deepEqual(texts(deck, "mode"), ["", "×10", "×10", ""]);
		assert.deepEqual(texts(deck, "value"), ["Locked", "Locked", "Locked", "Locked"]);
		// The background process finishes: values, live colours, and turns that apply, as big steps on dial 3.
		link.lr(STATE_101);
		clock.advance(100);
		assert.deepEqual(texts(deck, "value"), ["5500 K", "+10", "+0.35", "0"]);
		assert.equal(item(deck, "dial-0", "label")?.color, STRIP_COLORS.label);
		assert.equal(fill(deck, "dial-2"), STRIP_COLORS.macro);
		assert.equal(deck.rotate("dial-2", 1, false), "applied");
		assert.deepEqual(wire(link.take()), [{ t: "set", p: "Exposure", v: 0.68, g: 1, ph: "101" }]);
	});
});

describe("quiet logs", () => {
	test("normal use logs nothing at info or above: gestures, fine adjust, resets, big steps, settings, a page switch, a photo change, a stale set", () => {
		const log = new RecordingLog();
		const { clock, link, deck } = setup({ log });
		deck.rotate("dial-2", 3, false);
		const [set] = link.take();
		assert.ok(set?.t === "set");
		link.lr({ t: "ack", p: "Exposure", v: set.v, g: set.g });
		clock.advance(900);
		deck.down("dial-3");
		deck.rotate("dial-3", 4, true);
		deck.up("dial-3");
		deck.down("dial-1");
		deck.up("dial-1"); // reset
		link.lr({ t: "ack", p: "Tint", v: 0 });
		deck.tap("dial-2", false); // big steps on
		deck.rotate("dial-2", 1, false);
		clock.advance(3000); // done, then big steps off by themselves
		deck.tap("dial-1", true); // on by long touch
		deck.tap("dial-1", false); // off by tap
		deck.settings("dial-0", { param: "Highlights" });
		for (const id of DIALS) deck.remove(id);
		["Highlights", "Shadows", "Whites", "Blacks"].forEach((param, c) => deck.add(`page2-${c}`, c, surface(), { param }));
		clock.advance(900);
		deck.rotate("page2-1", 1, false); // Shadows, just before the user moves to photo 102 in Lightroom
		const stale = link
			.take()
			.filter((c) => c.t === "set")
			.at(-1);
		assert.ok(stale?.t === "set" && stale.p === "Shadows");
		link.err(stale, "stale");
		link.lr({ t: "state", module: "develop", photo: "102", file: "DSC0102.ARW", flag: 0, rating: 0, label: "none", sel: 1, locked: false });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: RAW_VALUES });
		clock.advance(2000);
		assert.deepEqual(log.at("info"), []);
		const debug = log.at("debug");
		for (const line of [/big steps on for Exposure \(dial 3, tap\)/, /big steps off for Exposure \(dial 3\): 2 s without a turn/, /big steps on for Tint \(dial 2, long touch\)/, /big steps off for Tint \(dial 2\): tap/, /ranges from Lightroom: Temperature 2000…50000, .*Sharpness 0…150/, /dial 1 now shows Highlights/]) {
			assert.ok(
				debug.some((l) => line.test(l)),
				`${line} is logged below info`,
			);
		}
	});
});

describe("strip", () => {
	const view = { value: 0.35, range: [-5, 5] as const, fresh: true, adjusting: false };
	const slider = (p: string): Slider => {
		const s = sliderFor(DEFAULT_SLIDERS, p);
		assert.ok(s);
		return s;
	};
	const exposure = slider("Exposure");
	const temp = slider("Temperature");
	const base = { slider: exposure, param: "Exposure", big: false, view, conn: "online" as const, writable: true, inDevelop: true, locked: false };

	test("shows the label, an empty mode, the value and a bar over the range", () => {
		const s = stripFor(base);
		assert.deepEqual(s.label, { value: "Exposure", color: STRIP_COLORS.label });
		assert.equal(s.mode.value, "");
		assert.deepEqual(s.value, { value: "+0.35", color: STRIP_COLORS.value, font: VALUE_FONT });
		assert.deepEqual(s.bar.range, { min: -5, max: 5 });
		assert.equal(s.bar.value, 0.35);
		assert.equal(s.bar.subtype, 1, "a range centred on 0 fills from the centre");
		assert.equal(s.bar.bar_fill_c, STRIP_COLORS.fill);
		assert.deepEqual(Object.keys(s).sort(), ["bar", "label", "mode", "value"], "the layout's four keys");
	});

	test("big steps: ×10 and the bar fill in green, #3DDC84; a dimmed strip dims both", () => {
		assert.equal(STRIP_COLORS.macro, "#3DDC84");
		const on = stripFor({ ...base, big: true });
		assert.deepEqual(on.mode, { value: "×10", color: STRIP_COLORS.macro });
		assert.equal(on.bar.bar_fill_c, STRIP_COLORS.macro);
		assert.deepEqual([on.label, on.value, on.bar.bar_bg_c], [stripFor(base).label, stripFor(base).value, STRIP_COLORS.groove], "the rest stays");
		for (const change of [{ conn: "offline" as const }, { writable: false }, { inDevelop: false }, { locked: true }]) {
			const dim = stripFor({ ...base, ...change, big: true });
			assert.deepEqual(dim.mode, { value: "×10", color: STRIP_COLORS.dimMacro }, JSON.stringify(change));
			assert.equal(dim.bar.bar_fill_c, STRIP_COLORS.dimMacro, JSON.stringify(change));
			assert.equal(stripFor({ ...base, ...change }).bar.bar_fill_c, STRIP_COLORS.dimFill, "off: the usual dim fill");
		}
		assert.notEqual(STRIP_COLORS.dimMacro, STRIP_COLORS.macro);
		assert.notEqual(STRIP_COLORS.macro, STRIP_COLORS.fill);
		assert.notEqual(STRIP_COLORS.macro, STRIP_COLORS.status);
	});

	test("the mode text is a big step in normal steps for the variant in force, to at most one decimal place", () => {
		assert.equal(stripFor({ ...base, slider: temp, param: "Temperature", big: true, view: { value: 5500, range: [2000, 50000], fresh: true, adjusting: false } }).mode.value, "×10", "500 K ÷ 50 K");
		assert.equal(stripFor({ ...base, slider: temp, param: "Temperature", big: true, view: { value: 0, range: [-100, 100], fresh: true, adjusting: false } }).mode.value, "×10", "10 ÷ 1");
		const variant = { step: 1, fine: 0.25, precision: 0, unit: "", signed: true };
		assert.deepEqual(
			[2.5, 25, 1 / 3, 0.5, 10].map((macro) => macroText({ ...variant, macro })),
			["×2.5", "×25", "×0.3", "×0.5", "×10"],
		);
		assert.equal(macroText({ ...variant, step: 0.1, macro: 1 / 3 }), "×3.3");
		const kelvin = parseSliders(JSON.stringify({ sliders: [{ param: "Temperature", label: "T", step: 1, macro: 20, kelvin: { step: 50, macro: 250 } }] })).config.sliders[0];
		assert.ok(kelvin);
		assert.equal(stripFor({ ...base, slider: kelvin, param: "Temperature", big: true, view: { value: 5500, range: [2000, 50000], fresh: true, adjusting: false } }).mode.value, "×5", "the Kelvin variant's");
		assert.equal(stripFor({ ...base, slider: kelvin, param: "Temperature", big: true, view: { value: 0, range: [-100, 100], fresh: true, adjusting: false } }).mode.value, "×20");
	});

	test("Temperature in Kelvin shows 5500 K and fills from the left", () => {
		const s = stripFor({ ...base, slider: temp, param: "Temperature", view: { value: 5500, range: [2000, 50000], fresh: true, adjusting: false } });
		assert.equal(s.value.value, "5500 K");
		assert.equal(s.bar.subtype, 0);
		assert.deepEqual(s.bar.range, { min: 2000, max: 50000 });
		const jpeg = stripFor({ ...base, slider: temp, param: "Temperature", view: { value: 12, range: [-100, 100], fresh: true, adjusting: false } });
		assert.equal(jpeg.value.value, "+12", "rendered files show slider units");
	});

	test("ranges such as 0…150 fill from the left, and unsigned sliders show no +", () => {
		const s = stripFor({ ...base, slider: slider("Sharpness"), param: "Sharpness", view: { value: 40, range: [0, 150], fresh: true, adjusting: false } });
		assert.deepEqual([s.label.value, s.value.value, s.bar.value, s.bar.subtype, s.bar.range], ["Sharpening", "40", 40, 0, { min: 0, max: 150 }]);
		const noise = stripFor({ ...base, slider: slider("LuminanceSmoothing"), param: "LuminanceSmoothing", view: { value: null, range: [0, 100], fresh: false, adjusting: false } });
		assert.deepEqual([noise.label.value, noise.value.value, noise.bar.value], ["Noise", "—", 0], "an unknown value rests at the left");
	});

	test("dimmed when offline, busy, mismatched, read-only or outside Develop; the reason shows when there's no connection", () => {
		const live = stripFor(base);
		const cases = [
			[{ conn: "offline" as const }, "Offline"],
			[{ conn: "busy" as const }, "Busy"],
			[{ conn: "mismatch" as const }, "Mismatch"],
			[{ writable: false }, "+0.35"],
			[{ inDevelop: false }, "+0.35"],
		] as const;
		for (const [change, shown] of cases) {
			const s = stripFor({ ...base, ...change });
			assert.equal(s.value.value, shown, JSON.stringify(change));
			assert.equal(s.label.color, STRIP_COLORS.dimLabel, JSON.stringify(change));
			assert.equal(s.bar.bar_fill_c, STRIP_COLORS.dimFill, JSON.stringify(change));
			assert.notDeepEqual(s, live);
		}
	});

	test("a locked photo: Locked in place of the value, dimmed as outside Develop; the connection's word comes first", () => {
		const locked = stripFor({ ...base, locked: true });
		assert.deepEqual(locked.value, { value: "Locked", color: STRIP_COLORS.status, font: STATUS_FONT });
		const outside = stripFor({ ...base, inDevelop: false });
		assert.deepEqual([locked.label, locked.mode, locked.bar], [outside.label, outside.mode, outside.bar], "the same dimmed label, mode and bar");
		assert.equal(locked.bar.value, 0.35, "the bar keeps the last value");
		assert.equal(stripFor({ ...base, locked: true, inDevelop: false }).value.value, "Locked");
		assert.equal(stripFor({ ...base, locked: true, conn: "offline" }).value.value, "Offline");
		assert.equal(stripFor({ ...base, locked: true, view: { value: null, range: null, fresh: false, adjusting: false } }).value.value, "Locked");
	});

	test("a param sliders.json doesn't list: the param as the label, Not listed in the status colour, no bar, whatever the state", () => {
		const unlisted = { ...base, slider: null, param: "Bogus", view: null };
		const s = stripFor(unlisted);
		assert.deepEqual(s.label, { value: "Bogus", color: STRIP_COLORS.label });
		assert.deepEqual(s.value, { value: "Not listed", color: STRIP_COLORS.status, font: STATUS_FONT });
		assert.equal(s.bar.opacity, 0);
		assert.equal(s.mode.value, "");
		assert.equal(stripFor({ ...unlisted, big: true }).mode.value, "", "never big steps");
		const offline = stripFor({ ...unlisted, conn: "offline" });
		assert.deepEqual([offline.label.color, offline.value.value], [STRIP_COLORS.dimLabel, "Not listed"], "dimmed like any strip, and still Not listed");
	});

	test("an unknown value shows a dash", () => {
		const unknown = stripFor({ ...base, view: { value: null, range: null, fresh: false, adjusting: false } });
		assert.equal(unknown.value.value, "—");
	});

	test("formats Exposure as +0.35, Kelvin unsigned with a unit, others as signed whole numbers, never -0", () => {
		const signed = { precision: 0, unit: "", signed: true };
		assert.equal(formatValue(0.35, { precision: 2, unit: "", signed: true }), "+0.35");
		assert.equal(formatValue(-1.2, { precision: 2, unit: "", signed: true }), "-1.20");
		assert.equal(formatValue(0, { precision: 2, unit: "", signed: true }), "0.00");
		assert.equal(formatValue(5500, { precision: 0, unit: "K", signed: false }), "5500 K");
		assert.equal(formatValue(15, signed), "+15");
		assert.equal(formatValue(-20, signed), "-20");
		assert.equal(formatValue(-0.4, signed), "0");
		assert.equal(formatValue(0.25, signed), "0");
		assert.deepEqual([formatValue(0.5, signed), formatValue(-0.5, signed)], ["+1", "-1"], "halves round away from zero, like the values sent");
		assert.equal(formatValue(-0.025, { precision: 2, unit: "", signed: true }), "-0.03");
	});
});

describe("strip painter", () => {
	test("sends only changed keys, at most once per interval, latest content winning", () => {
		const clock = new FakeClock();
		const sent: Record<string, unknown>[] = [];
		const painter = new StripPainter((p) => sent.push(p), { clock, minIntervalMs: 67 });
		painter.update({ a: { value: 1 }, b: { value: "x" } });
		assert.deepEqual(sent, [{ a: { value: 1 }, b: { value: "x" } }]);
		painter.update({ a: { value: 2 }, b: { value: "x" } });
		painter.update({ a: { value: 3 }, b: { value: "x" } });
		assert.equal(sent.length, 1, "throttled");
		clock.advance(67);
		assert.deepEqual(sent[1], { a: { value: 3 } });
		painter.update({ a: { value: 3 }, b: { value: "x" } });
		clock.advance(100);
		assert.equal(sent.length, 2, "nothing changed, nothing sent");
		painter.forget();
		painter.update({ a: { value: 3 }, b: { value: "x" } });
		assert.deepEqual(sent[2], { a: { value: 3 }, b: { value: "x" } }, "after forget, everything is sent again");
	});
});
