import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_BANKS, type Slot } from "../src/banks.js";
import type { Command, SetCmd } from "../src/lr/protocol.js";
import { LrModel } from "../src/model/model.js";
import { accelerate } from "../src/model/steps.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { FakeLink } from "./helpers/fake-link.js";

const slots = new Map<string, Slot>();
for (const bank of DEFAULT_BANKS.banks) for (const s of bank) if (s) slots.set(s.param, s);
const slot = (p: string): Slot => {
	const s = slots.get(p);
	if (!s) throw new Error(`no slot for ${p}`);
	return s;
};

const RAW_RANGES = { Temperature: [2000, 50000], Tint: [-150, 150], Exposure: [-5, 5], Contrast: [-100, 100], Shadows: [-100, 100] };
const JPG_RANGES = { Temperature: [-100, 100], Tint: [-100, 100], Exposure: [-5, 5], Contrast: [-100, 100], Shadows: [-100, 100] };
const RAW_VALUES = { Temperature: 5500, Tint: 10, Exposure: 0.35, Contrast: 0, Shadows: 15 };

const DIAL = "dial-0";

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
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "applied");
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.38, g: 1 }]);
		assert.ok(Math.abs((model.view("Exposure").value ?? 0) - (0.35 + 1 / 30)) < 1e-9);
		assert.equal(model.view("Exposure").adjusting, true);
		noProblems(link);
	});

	test("sends at most 30 sets a second per param, each with the latest value", () => {
		const { clock, link, model } = setup();
		// A tick every 5 ms for a second: 200 ticks of 50 K on a raw file.
		for (let i = 0; i < 200; i++) {
			model.turn("Temperature", 1, false, slot("Temperature"), DIAL);
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
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		clock.advance(300);
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		link.take();
		clock.advance(799);
		assert.deepEqual(link.take(), [], "no done before 800 ms after the last tick");
		clock.advance(1);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
		assert.equal(model.gesture, null);
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.g, 2);
		noProblems(link);
	});

	test("push + turn: fine steps of a quarter step, and done on dial-up rather than after 800 ms", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 4, true, slot("Contrast"), DIAL); // 4 fine ticks = 1 unit
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1 }]);
		clock.advance(100);
		model.release(DIAL);
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
		noProblems(link);
	});

	test("dial-up right after a tick still sends that tick's value before done", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 4, true, slot("Contrast"), DIAL);
		clock.advance(10);
		model.turn("Contrast", 4, true, slot("Contrast"), DIAL); // within the 34 ms set interval
		model.release(DIAL);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1 }], "the second set waits for the rate limit");
		clock.advance(40);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 2, g: 1 }, { t: "done", g: 1 }]);
		noProblems(link);
	});

	test("the 30 a second limit is per param: a new gesture right after the last one waits too", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 4, true, slot("Contrast"), DIAL); // push + turn: set Contrast 1
		clock.advance(3);
		model.release(DIAL); // done
		clock.advance(2);
		model.turn("Contrast", 4, true, slot("Contrast"), DIAL); // a new gesture 5 ms after the last set
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Contrast", v: 1, g: 1 },
			{ t: "done", g: 1 },
		]);
		clock.advance(28);
		assert.deepEqual(link.take(), [], "not before 34 ms after Contrast's last set");
		clock.advance(1);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 2, g: 2 }]);
		noProblems(link);
	});

	test("fine adjust is symmetric: two quarter ticks either way move a whole-number param by 1", () => {
		for (const dir of [1, -1]) {
			const { link, model } = setup();
			model.turn("Contrast", dir, true, slot("Contrast"), DIAL); // ±0.25: rounds to 0, nothing to send
			assert.deepEqual(link.take(), []);
			model.turn("Contrast", dir, true, slot("Contrast"), DIAL); // ±0.5: rounds away from zero
			assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: dir, g: 1 }], `direction ${dir}`);
			noProblems(link);
		}
	});

	test("turning another param ends the open gesture first: its final set and done go before the new set", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, false, slot("Exposure"), "dial-2");
		clock.advance(5);
		model.turn("Exposure", 1, false, slot("Exposure"), "dial-2");
		clock.advance(5);
		model.turn("Contrast", 1, false, slot("Contrast"), "dial-3");
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1 },
			{ t: "set", p: "Exposure", v: 0.42, g: 1 },
			{ t: "done", g: 1 },
			{ t: "set", p: "Contrast", v: 1, g: 2 },
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
		model.turn("Exposure", 10, false, slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 5);
		assert.equal(model.view("Exposure").value, 5);
		clock.advance(50);
		model.turn("Exposure", -1, false, slot("Exposure"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 4.97);
		noProblems(link);
	});

	test("rounds Exposure to 0.01 and everything else to whole numbers before sending", () => {
		const { clock, link, model } = setup();
		model.turn("Contrast", 1, true, slot("Contrast"), DIAL); // 0.25: still rounds to 0, so nothing to send
		assert.deepEqual(link.take(), []);
		clock.advance(50);
		model.turn("Contrast", 1, true, slot("Contrast"), DIAL); // 0.5 rounds to 1
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1 }]);
		clock.advance(1000);
		link.take();
		model.turn("Exposure", 1, true, slot("Exposure"), DIAL); // 0.35 + 1/120
		assert.equal(sets(link.take())[0]?.v, 0.36);
		noProblems(link);
	});

	test("Temperature steps 50 K a tick on raw files and 1 a tick on rendered files", () => {
		const { clock, link, model } = setup();
		model.turn("Temperature", 1, false, slot("Temperature"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 5550);
		model.turn("Temperature", 1, true, slot("Temperature"), DIAL); // fine: 12.5 K
		clock.advance(40);
		assert.equal(sets(link.take())[0]?.v, 5563);
		clock.advance(1000);
		link.take();
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		link.lr({ t: "ranges", ranges: JPG_RANGES });
		link.lr({ t: "vals", vals: { Temperature: 0, Tint: 0, Exposure: 0, Contrast: 5 } });
		model.turn("Temperature", 1, false, slot("Temperature"), DIAL);
		assert.equal(sets(link.take())[0]?.v, 1);
		noProblems(link);
	});
});

describe("value model: echoes and acks", () => {
	test("vals for the param are ignored during its gesture; other params still update", () => {
		const { link, model } = setup();
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		link.lr({ t: "vals", vals: { Exposure: 0.35, Contrast: 7 } });
		assert.ok(Math.abs((model.view("Exposure").value ?? 0) - 0.3833) < 1e-3, "the deck owns Exposure during the gesture");
		assert.equal(model.view("Contrast").value, 7);
	});

	test("vals for the param are ignored for 300 ms after done, then the latest one is applied", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		clock.advance(800); // done
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1 },
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
		model.turn("Temperature", 1, false, slot("Temperature"), DIAL);
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
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "held");
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "held");
		assert.deepEqual(strip(link.take()), [{ t: "module", v: "develop" }]);
		link.lr({ t: "state", module: "develop" });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(link.take(), [], "ranges alone don't release the ticks");
		link.lr({ t: "vals", vals: RAW_VALUES });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.42, g: 1 }]);
		assert.deepEqual(model.held, []);
		noProblems(link);
	});

	test("held ticks are dropped after 2 s without vals, with an alert", () => {
		const { clock, link, model, alerts } = setup({ module: "library" });
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
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
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		const [cmd] = link.take();
		assert.ok(cmd);
		link.err(cmd, "noDevelop");
		assert.deepEqual(model.held, []);
		assert.deepEqual(alerts, [DIAL]);
	});

	test("a photo change ends the gesture and holds ticks until the new photo's vals", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		link.take();
		clock.advance(100); // the user changes photo in Lightroom a moment later
		link.lr({ t: "state", photo: "104", file: "IMG0104.JPG" });
		assert.deepEqual(link.take(), [{ t: "done", g: 1 }]);
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "held");
		assert.deepEqual(link.take(), [], "no module command: already in Develop");
		link.lr({ t: "ranges", ranges: JPG_RANGES });
		link.lr({ t: "vals", vals: { Temperature: 0, Tint: 0, Exposure: 0, Contrast: 5 } });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.03, g: 2 }]);
		noProblems(link);
	});

	test("Next during a gesture: its final set and done go before nav, and turns wait for the new photo's values", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL); // set 0.38 goes at once
		clock.advance(10);
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL); // 0.42 waits for the set interval
		// What NavKey does on key down:
		model.beforePhotoChange();
		link.send({ t: "nav", v: "next" });
		assert.deepEqual(strip(link.take()), [
			{ t: "set", p: "Exposure", v: 0.38, g: 1 },
			{ t: "set", p: "Exposure", v: 0.42, g: 1 },
			{ t: "done", g: 1 },
			{ t: "nav", v: "next" },
		]);
		assert.equal(model.gesture, null);
		// A tick before Lightroom says which photo it's on would apply the old photo's value to the new one: it waits.
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "held");
		clock.advance(5);
		link.lr({ t: "vals", vals: { Exposure: 0.42 } }); // the observer's final value, for the old photo
		clock.advance(5);
		link.lr({ t: "state", photo: "102", file: "DSC0102.ARW" });
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(link.take(), [], "still waiting for the new photo's vals");
		link.lr({ t: "vals", vals: { ...RAW_VALUES, Exposure: -1 } });
		clock.advance(40);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: -0.97, g: 2 }], "the held tick applies to the new photo's value");
		noProblems(link);
	});

	test("Next at the end of the filmstrip: the photo stays, and held turns apply when the wait ends", () => {
		const { clock, link, model } = setup();
		model.beforePhotoChange();
		link.send({ t: "nav", v: "next" });
		link.take();
		assert.equal(model.turn("Contrast", 1, false, slot("Contrast"), DIAL), "held");
		link.lr({ t: "state", module: "develop", photo: "101", file: "DSC0101.ARW", flag: 0, rating: 0, label: "none", sel: 1 }); // nav's answer: same photo
		clock.advance(499);
		assert.deepEqual(link.take(), []);
		clock.advance(1);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Contrast", v: 1, g: 1 }]);
		assert.equal(model.turn("Contrast", 1, false, slot("Contrast"), DIAL), "applied", "turns apply at once again");
		noProblems(link);
	});

	test("a turn waits for the param's range, which picks the Kelvin step and bounds the clamp", () => {
		const { link, model } = setup({ module: "library" });
		assert.equal(model.turn("Temperature", 1, false, slot("Temperature"), DIAL), "held");
		link.take(); // module develop
		link.lr({ t: "state", module: "develop" });
		link.lr({ t: "vals", vals: RAW_VALUES });
		assert.deepEqual(link.take(), [], "a value without its range doesn't release the tick");
		link.lr({ t: "ranges", ranges: RAW_RANGES });
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Temperature", v: 5550, g: 1 }], "50 K a tick on a raw file, not 1");
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

describe("value model: reset, errors, guard, connection", () => {
	test("reset sends reset; turns wait for its ack and start from the reset value", () => {
		const { link, model } = setup();
		assert.equal(model.reset("Exposure", DIAL), true);
		assert.deepEqual(strip(link.take()), [{ t: "reset", p: "Exposure" }]);
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "held");
		link.lr({ t: "ack", p: "Exposure", v: 0 });
		assert.equal(model.view("Exposure").value, 0.03333333333333333);
		assert.deepEqual(strip(link.take()), [{ t: "set", p: "Exposure", v: 0.03, g: 1 }]);
		noProblems(link);
	});

	test("reset during a gesture cancels it without done: Lightroom's reset ends the gesture", () => {
		const { clock, link, model } = setup();
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
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
		model.turn("Exposure", 1, false, slot("Exposure"), "dial-2");
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
			assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "readonly");
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
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		assert.equal(link.take().length, 1, "a new burst probes again");
		noProblems(link);
	});

	test("offline or busy: turns and resets are refused with an alert, and nothing is sent", () => {
		const { clock, link, model, alerts } = setup();
		link.setState("busy");
		assert.equal(model.turn("Exposure", 1, false, slot("Exposure"), DIAL), "offline");
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
		model.turn("Exposure", 1, false, slot("Exposure"), DIAL);
		link.disconnect();
		assert.deepEqual(model.held, []);
		assert.deepEqual(alerts, [DIAL]);
		assert.equal(model.view("Contrast").value, 3);
		assert.equal(model.view("Contrast").fresh, false);
	});
});
