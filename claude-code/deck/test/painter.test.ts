import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { StripPainter } from "../src/util/painter.js";
import { Ticker } from "../src/util/ticker.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { RecordingLog } from "./helpers/recording-log.js";

describe("the strip painter's shown (what a press on a Session Slot dial acts on)", () => {
	test("remembers what the strip last showed and since when: a new paint of the same thing keeps the time, another thing resets it", () => {
		const clock = new FakeClock();
		const sent: unknown[] = [];
		const shown: unknown[] = [];
		const painter = new StripPainter<number | null>((p) => sent.push(p), { clock, minIntervalMs: 100, onShown: (s) => shown.push(s) });
		assert.deepEqual([painter.shown, painter.shownSince], [undefined, null]);
		painter.update({ a: { value: 1 } }, null);
		assert.deepEqual([painter.shown, painter.shownSince], [null, clock.now()]);
		clock.advance(50);
		painter.update({ a: { value: 2 } }, 7);
		assert.equal(painter.shown, null, "held back by the 100 ms: the strip still shows the last");
		clock.advance(50);
		assert.deepEqual([painter.shown, painter.shownSince], [7, clock.now()]);
		const since = clock.now();
		clock.advance(500);
		painter.update({ a: { value: 3 } }, 7);
		assert.deepEqual([painter.shown, painter.shownSince], [7, since], "the same request, painted again");
		clock.advance(500);
		painter.update({ a: { value: 3 } }, 8);
		assert.deepEqual([painter.shown, painter.shownSince], [8, clock.now()], "another request, though the keys came out the same");
		assert.deepEqual(shown, [null, 7, 8]);
		assert.equal(sent.length, 3, "nothing sent for keys that didn't change");
		painter.dispose();
	});

	test("with equals, a value that is the same thing keeps the time, though it's another object; another thing resets it", () => {
		const clock = new FakeClock();
		const shown: unknown[] = [];
		const painter = new StripPainter<{ id: number; pick: string }>(() => {}, { clock, minIntervalMs: 0, equals: (a, b) => a?.id === b?.id && a?.pick === b?.pick, onShown: (s) => shown.push(s) });
		painter.update({ a: { value: 1 } }, { id: 1, pick: "none" });
		const since = clock.now();
		clock.advance(500);
		painter.update({ a: { value: 2 } }, { id: 1, pick: "none" });
		assert.equal(painter.shownSince, since);
		painter.update({ a: { value: 3 } }, { id: 1, pick: "Allow" });
		assert.equal(painter.shownSince, clock.now());
		assert.deepEqual(shown, [{ id: 1, pick: "none" }, { id: 1, pick: "Allow" }]);
		painter.dispose();
	});

	test("without a shown value, it paints as before", () => {
		const sent: unknown[] = [];
		const painter = new StripPainter((p) => sent.push(p), { clock: new FakeClock(), minIntervalMs: 0 });
		painter.update({ a: { value: 1 }, b: { value: 2 } });
		painter.update({ a: { value: 1 }, b: { value: 3 } });
		assert.deepEqual(sent, [{ a: { value: 1 }, b: { value: 2 } }, { b: { value: 3 } }]);
		assert.equal(painter.shown, undefined);
	});
});

describe("the ticker (the slot keys' and dials' repaint for since)", () => {
	test("runs every interval while running, and a stop, from inside or out, holds", () => {
		const clock = new FakeClock();
		let n = 0;
		const ticker = new Ticker(clock, 1000, () => {
			n++;
			if (n === 3) ticker.stop();
		});
		ticker.start();
		ticker.start();
		clock.advance(10_000);
		assert.equal(n, 3);
		assert.equal(clock.pendingTimers, 0);
		ticker.start();
		clock.advance(1000);
		assert.equal(n, 4);
		ticker.stop();
		clock.advance(5000);
		assert.equal(n, 4);
		assert.equal(ticker.running, false);
	});

	test("a throw from a tick is logged at error, and the ticks go on: nothing escapes the timer", () => {
		const clock = new FakeClock();
		const log = new RecordingLog();
		let n = 0;
		const ticker = new Ticker(
			clock,
			1000,
			() => {
				n++;
				if (n === 2) throw new Error("boom");
			},
			{ log, what: "a test tick" },
		);
		ticker.start();
		clock.advance(3000);
		assert.equal(n, 3);
		assert.deepEqual(log.at("error").map((l) => l.split("\n")[0]), ["error a test tick threw: Error: boom"]);
		ticker.stop();
	});
});
