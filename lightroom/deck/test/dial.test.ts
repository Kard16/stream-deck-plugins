import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_BANKS } from "../src/banks.js";
import { DialDeck, type DialSurface } from "../src/dial/deck.js";
import { StripPainter } from "../src/dial/painter.js";
import { STATUS_FONT, STRIP_COLORS, stripFor } from "../src/dial/strip.js";
import type { SetCmd } from "../src/lr/protocol.js";
import { formatValue } from "../src/model/format.js";
import { LrModel } from "../src/model/model.js";
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
	Vibrance: [-100, 100],
	Saturation: [-100, 100],
	PostCropVignetteAmount: [-100, 100],
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
	Vibrance: 0,
	Saturation: 0,
	PostCropVignetteAmount: 0,
};

type FakeDial = DialSurface & { payloads: Record<string, unknown>[]; alerts: number };

function surface(): FakeDial {
	const d: FakeDial = {
		payloads: [],
		alerts: 0,
		setFeedback: (payload) => d.payloads.push(payload),
		showAlert: () => {
			d.alerts += 1;
		},
	};
	return d;
}

function setup(opts: { module?: string; writable?: boolean; log?: Log } = {}) {
	const clock = new FakeClock();
	const link = new FakeLink(clock);
	const model = new LrModel(link, { clock, log: opts.log });
	const deck = new DialDeck(DEFAULT_BANKS, model, { clock, log: opts.log });
	link.lr({ t: "hello", v: 1, guard: "on", writable: opts.writable ?? true, inst: "A" });
	link.lr({ t: "state", module: opts.module ?? "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1 });
	link.lr({ t: "ranges", ranges: RAW_RANGES });
	link.lr({ t: "vals", vals: RAW_VALUES });
	const dials = [surface(), surface(), surface(), surface()];
	dials.forEach((d, column) => deck.add(`dial-${column}`, column, d));
	clock.advance(100);
	link.take();
	return { clock, link, model, deck, dials };
}

const text = (deck: DialDeck, id: string, key: string): unknown => (deck.painted(id)?.[key] as { value?: unknown } | undefined)?.value;

describe("Develop Dial", () => {
	test("each dial takes its slot from its column: bank 1 is Temp, Tint, Exposure, Contrast", () => {
		const { deck } = setup();
		assert.deepEqual(
			[0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "label")),
			["Temp", "Tint", "Exposure", "Contrast"],
		);
		assert.deepEqual(
			[0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "value")),
			["5500 K", "+10", "+0.35", "0"],
		);
		assert.equal(text(deck, "dial-0", "bank"), "1/4");
	});

	test("turning adjusts with acceleration: 1, 2, 3, 4 ticks an event move 1, 3, 6, 10 steps", () => {
		const { clock, link, deck } = setup();
		const values: number[] = [];
		for (const ticks of [1, 2, 3, 4]) {
			deck.rotate("dial-3", ticks, false);
			clock.advance(50);
			values.push(...link.take().flatMap((c) => (c.t === "set" ? [c.v] : [])));
		}
		assert.deepEqual(values, [1, 4, 10, 20]);
	});

	test("push + turn is fine (a quarter step, no acceleration) and the release doesn't reset", () => {
		const { clock, link, deck } = setup();
		deck.down("dial-3");
		deck.rotate("dial-3", 4, true); // 4 × 0.25 = 1, where unpressed 4 ticks would be 10
		clock.advance(50);
		deck.up("dial-3");
		const cmds = link.take().map((c) => {
			const { id: _id, ...rest } = c as typeof c & { id?: number };
			return rest;
		});
		assert.deepEqual(cmds, [
			{ t: "set", p: "Contrast", v: 1, g: 1, ph: "101" },
			{ t: "done", g: 1 },
		]);
	});

	test("pressing without turning resets the dial's slider; so does a long touch", () => {
		const { link, deck } = setup();
		deck.down("dial-2");
		deck.up("dial-2");
		deck.tap("dial-1", true);
		assert.deepEqual(
			link.take().map((c) => (c.t === "reset" ? c.p : c.t)),
			["Exposure", "Tint"],
		);
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

	test("a tap moves all four dials to the next bank and repaints them, wrapping after bank 4", () => {
		const { clock, deck } = setup();
		deck.tap("dial-0", false);
		clock.advance(100);
		assert.deepEqual(
			[0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "label")),
			["Highlights", "Shadows", "Whites", "Blacks"],
		);
		assert.equal(text(deck, "dial-3", "bank"), "2/4");
		deck.tap("dial-2", false);
		deck.tap("dial-2", false);
		clock.advance(100);
		assert.deepEqual(
			[0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "label")),
			["Vignette", "—", "—", "—"],
		);
		assert.equal(text(deck, "dial-1", "value"), "", "empty slots show only the dash");
		deck.tap("dial-0", false);
		clock.advance(100);
		assert.equal(text(deck, "dial-0", "label"), "Temp");
	});

	test("an empty slot ignores turns and presses", () => {
		const { clock, link, deck } = setup();
		for (let i = 0; i < 3; i++) deck.tap("dial-0", false);
		clock.advance(100);
		assert.equal(deck.rotate("dial-1", 3, false), "empty");
		deck.down("dial-1");
		deck.up("dial-1");
		assert.deepEqual(link.take(), []);
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
		for (const payload of dial.payloads) assert.deepEqual(Object.keys(payload).sort(), ["bar", "value"], "label and bank didn't change");
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

	test("while the photo is locked, turns, presses and long touches send nothing and alert once per burst; taps still change banks", () => {
		const { clock, link, deck, dials } = setup();
		const lockedState = { t: "state", module: "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1, locked: true };
		link.lr(lockedState);
		clock.advance(100);
		const values = (): unknown[] => [0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "value"));
		assert.deepEqual(values(), ["Locked", "Locked", "Locked", "Locked"]);
		assert.equal(deck.rotate("dial-2", 1, false), "locked");
		clock.advance(50);
		deck.rotate("dial-2", 2, false); // the same burst
		deck.down("dial-3");
		deck.up("dial-3"); // a press: no reset
		deck.tap("dial-1", true); // a long touch: no reset either
		deck.down("dial-0");
		deck.rotate("dial-0", 1, true); // push + turn: dropped, and the release doesn't reset
		deck.up("dial-0");
		deck.tap("dial-0", false); // a tap: bank 2, as usual
		clock.advance(100);
		assert.deepEqual(link.take(), []);
		assert.deepEqual(
			dials.map((d) => d.alerts),
			[1, 1, 1, 1],
		);
		assert.deepEqual(
			[0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "label")),
			["Highlights", "Shadows", "Whites", "Blacks"],
		);
		assert.deepEqual(values(), ["Locked", "Locked", "Locked", "Locked"]);
		// The background process finishes: values, live colours, and turns that apply.
		link.lr({ ...lockedState, locked: false });
		clock.advance(100);
		assert.deepEqual(values(), ["-20", "+15", "0", "0"]);
		assert.equal((deck.painted("dial-0")?.label as { color?: unknown } | undefined)?.color, STRIP_COLORS.label);
		assert.equal(deck.rotate("dial-1", 1, false), "applied");
		assert.deepEqual(
			link.take().map((c) => (c.t === "set" ? [c.p, c.v, c.ph] : c.t)),
			[["Shadows", 16, "101"]],
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
		assert.deepEqual(
			[0, 1, 2, 3].map((c) => text(deck, `dial-${c}`, "value")),
			["6100 K", "+10", "+0.38", "+25"],
			"Exposure's echo window is still open, so its new value waits",
		);
		clock.advance(200);
		assert.equal(text(deck, "dial-2", "value"), "+1.20", "then the preset's value");
		deck.tap("dial-0", false);
		clock.advance(100);
		assert.equal(text(deck, "dial-0", "value"), "-40", "bank 2 has the preset's values too");
		assert.deepEqual(link.take(), [], "the deck sends nothing for any of it");
	});
});

describe("quiet logs", () => {
	test("normal use logs nothing at info or above: gestures, fine adjust, resets, bank taps, a photo change, a stale set", () => {
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
		deck.tap("dial-0", false);
		deck.tap("dial-0", true); // long touch: reset Highlights
		link.lr({ t: "ack", p: "Highlights", v: 0 });
		clock.advance(900);
		deck.rotate("dial-1", 1, false); // Shadows, just before the user moves to photo 102 in Lightroom
		const [stale] = link.take().filter((c) => c.t === "set");
		assert.ok(stale);
		link.err(stale, "stale");
		link.lr({ t: "state", module: "develop", photo: "102", file: "DSC0102.ARW", flag: 0, rating: 0, label: "none", sel: 1, locked: false });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		link.lr({ t: "vals", vals: RAW_VALUES });
		clock.advance(2000);
		assert.deepEqual(log.at("info"), []);
		assert.ok(
			log.at("debug").some((l) => /bank 2\/4/.test(l)),
			"the per-event lines are there below info",
		);
	});
});

describe("strip", () => {
	const view = { value: 0.35, range: [-5, 5] as const, fresh: true, adjusting: false };
	const exposure = DEFAULT_BANKS.banks[0]?.[2] ?? null;
	const temp = DEFAULT_BANKS.banks[0]?.[0] ?? null;
	const base = { slot: exposure, bank: 0, bankCount: 4, view, conn: "online" as const, writable: true, inDevelop: true, locked: false };

	test("shows the label, the bank as n/4, the value and a bar over the range", () => {
		const s = stripFor(base);
		assert.deepEqual(s.label, { value: "Exposure", color: STRIP_COLORS.label });
		assert.deepEqual(s.bank, { value: "1/4", color: STRIP_COLORS.bank });
		assert.equal(s.value.value, "+0.35");
		assert.equal(s.value.color, STRIP_COLORS.value);
		assert.deepEqual(s.bar.range, { min: -5, max: 5 });
		assert.equal(s.bar.value, 0.35);
		assert.equal(s.bar.subtype, 1, "a range centred on 0 fills from the centre");
		assert.equal(s.bar.bar_fill_c, STRIP_COLORS.fill);
	});

	test("Temperature in Kelvin shows 5500 K and fills from the left", () => {
		const s = stripFor({ ...base, slot: temp, view: { value: 5500, range: [2000, 50000], fresh: true, adjusting: false } });
		assert.equal(s.value.value, "5500 K");
		assert.equal(s.bar.subtype, 0);
		assert.deepEqual(s.bar.range, { min: 2000, max: 50000 });
		const jpeg = stripFor({ ...base, slot: temp, view: { value: 12, range: [-100, 100], fresh: true, adjusting: false } });
		assert.equal(jpeg.value.value, "+12", "rendered files show slider units");
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
		assert.deepEqual([locked.label, locked.bank, locked.bar], [outside.label, outside.bank, outside.bar], "the same dimmed label, bank and bar");
		assert.equal(locked.bar.value, 0.35, "the bar keeps the last value");
		assert.equal(stripFor({ ...base, locked: true, inDevelop: false }).value.value, "Locked");
		assert.equal(stripFor({ ...base, locked: true, conn: "offline" }).value.value, "Offline");
		assert.equal(stripFor({ ...base, locked: true, view: { value: null, range: null, fresh: false, adjusting: false } }).value.value, "Locked");
		assert.deepEqual(stripFor({ ...base, locked: true, slot: null, view: null }), stripFor({ ...base, inDevelop: false, slot: null, view: null }), "an empty slot stays empty");
	});

	test("an empty slot shows a dash and hides the bar; an unknown value shows a dash", () => {
		const empty = stripFor({ ...base, slot: null, view: null });
		assert.equal(empty.label.value, "—");
		assert.equal(empty.value.value, "");
		assert.equal(empty.bar.opacity, 0);
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
