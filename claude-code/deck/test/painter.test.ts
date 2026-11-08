import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { KeyPainter, StripPainter } from "../src/util/painter.js";
import { MAX_TICK_MS, RETRY_TICK_MS, TICK_SLACK_MS, Ticker } from "../src/util/ticker.js";
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

	test("while no Stream Deck is connected, it sends nothing and nothing changes: no onShown, the same shown and since; once one is, the latest goes (agents-and-wake.md, C3)", () => {
		const clock = new FakeClock();
		const sent: unknown[] = [];
		const shown: unknown[] = [];
		let live = true;
		const painter = new StripPainter<number>((p) => sent.push(p), { clock, minIntervalMs: 0, onShown: (s) => shown.push(s), live: () => live });
		painter.update({ a: { value: 1 } }, 1);
		const since = clock.now();
		live = false;
		clock.advance(5000);
		painter.update({ a: { value: 2 } }, 2);
		painter.update({ a: { value: 3 } }, 3);
		assert.deepEqual([sent.length, shown, painter.shown, painter.shownSince, painter.painted], [1, [1], 1, since, { a: { value: 1 } }]);
		live = true;
		clock.advance(1000);
		painter.update({ a: { value: 4 } }, 4);
		assert.deepEqual([sent, shown, painter.shown, painter.shownSince], [[{ a: { value: 1 } }, { a: { value: 4 } }], [1, 4], 4, clock.now()], "4's since is its paint, not an update that reached nothing");
		painter.dispose();
	});
});

describe("the key painter (src/util/painter.ts)", () => {
	test("while no Stream Deck is connected, it sends nothing and nothing changes; once one is, the latest goes, and what it shows is timed from that paint (agents-and-wake.md, C3)", () => {
		const clock = new FakeClock();
		const sent: string[] = [];
		let live = false;
		const painter = new KeyPainter<number>((svg) => sent.push(svg), { clock, minIntervalMs: 0, live: () => live });
		painter.update("<a/>", 1);
		clock.advance(5000);
		painter.update("<b/>", 2);
		assert.deepEqual([sent, painter.shown, painter.shownSince, painter.svg], [[], undefined, null, null]);
		live = true;
		clock.advance(1000);
		painter.update("<b/>", 2);
		assert.deepEqual([sent, painter.shown, painter.shownSince], [["<b/>"], 2, clock.now()]);
		painter.dispose();
	});

	test("forget: the next update sends the image again, unchanged too, once; what it showed and since when stay (agents-and-wake.md, C2)", () => {
		const clock = new FakeClock();
		const sent: string[] = [];
		const painter = new KeyPainter<number>((svg) => sent.push(svg), { clock, minIntervalMs: 0 });
		painter.update("<a/>", 1);
		const since = clock.now();
		clock.advance(3000);
		painter.update("<a/>", 1);
		assert.deepEqual(sent, ["<a/>"], "unchanged: not sent");
		painter.forget();
		painter.update("<a/>", 1);
		painter.update("<a/>", 1);
		assert.deepEqual([sent, painter.shown, painter.shownSince], [["<a/>", "<a/>"], 1, since], "sent again once; the same thing, seen since its first paint");
		painter.dispose();
	});
});

describe("the ticker (the slots' repaint of their keys, dials and Others when a since changes, B6)", () => {
	test("ticks once, at the wall-clock moment asked for and TICK_SLACK_MS after it; a new moment replaces the last; null, or a time that isn't finite, asks for none", () => {
		const clock = new FakeClock();
		let wall = 10_000;
		let n = 0;
		const ticker = new Ticker(clock, () => n++, { wallNow: () => wall });
		assert.equal(TICK_SLACK_MS, 10);
		ticker.at(12_000);
		assert.equal(ticker.next, 12_000);
		clock.advance(2000 + TICK_SLACK_MS - 1);
		assert.equal(n, 0);
		clock.advance(1);
		assert.equal(n, 1);
		assert.equal(ticker.next, null, "once: the repaint asks for the next");
		clock.advance(60_000);
		assert.equal(n, 1);
		wall = 20_000;
		ticker.at(25_000);
		ticker.at(21_000);
		assert.equal(clock.pendingTimers, 1, "the later moment's timer went");
		clock.advance(1000 + TICK_SLACK_MS);
		assert.equal(n, 2);
		clock.advance(10_000);
		assert.equal([n, clock.pendingTimers].join(), "2,0", "the moment it replaced doesn't tick");
		// Asked again, the same moment is timed afresh from the wall clock now: after a sleep, which the timers don't
		// count, the tick comes on time. A "2h" 50 minutes before it reads "3h", then 30 minutes asleep: 20 minutes on.
		wall = 7_200_000;
		ticker.at(wall + 50 * 60_000);
		wall += 30 * 60_000;
		ticker.at(7_200_000 + 50 * 60_000);
		assert.equal(clock.pendingTimers, 1, "one timer, the new one");
		clock.advance(20 * 60_000 + TICK_SLACK_MS - 1);
		assert.equal(n, 2);
		clock.advance(1);
		assert.equal(n, 3, "on time by the wall clock, not 30 minutes late");
		wall += 20 * 60_000;
		// Null, stop and NaN leave none.
		ticker.at(null);
		assert.deepEqual([clock.pendingTimers, ticker.next], [0, null]);
		ticker.at(45_000);
		ticker.stop();
		ticker.at(Number.NaN);
		assert.deepEqual([clock.pendingTimers, ticker.next], [0, null]);
		clock.advance(10_000);
		assert.equal(n, 3);
		// A moment that has passed ticks at once, after the slack.
		ticker.at(wall - 5000);
		clock.advance(TICK_SLACK_MS);
		assert.equal(n, 4);
	});

	test("it waits at most MAX_TICK_MS, so the labels catch up within the hour with a wall clock that jumped", () => {
		const clock = new FakeClock();
		let n = 0;
		const ticker = new Ticker(clock, () => n++, { wallNow: () => 0 });
		ticker.at(5 * 86_400_000);
		clock.advance(MAX_TICK_MS - 1);
		assert.equal(n, 0);
		clock.advance(1);
		assert.equal(n, 1);
	});

	test("a throw from a tick is logged at error, and unless the tick asked for its next first, it ticks again RETRY_TICK_MS later: nothing escapes the timer", () => {
		const clock = new FakeClock();
		const log = new RecordingLog();
		let wall = 0;
		let n = 0;
		const ticker: Ticker = new Ticker(
			clock,
			() => {
				n++;
				if (n === 3) ticker.at(wall + 60_000);
				if (n <= 3) throw new Error("boom");
			},
			{ wallNow: () => wall, log, what: "a test tick" },
		);
		ticker.at(1000);
		const step = (ms: number): void => {
			wall += ms;
			clock.advance(ms);
		};
		step(1000 + TICK_SLACK_MS);
		assert.equal(n, 1);
		assert.equal(ticker.next, wall + RETRY_TICK_MS);
		step(RETRY_TICK_MS + TICK_SLACK_MS);
		assert.equal(n, 2);
		step(RETRY_TICK_MS + TICK_SLACK_MS);
		assert.equal(n, 3);
		assert.equal(ticker.next, wall + 60_000, "the moment it asked for before it threw");
		assert.deepEqual(
			[...new Set(log.at("error").map((l) => l.split("\n")[0]))],
			["error a test tick threw: Error: boom"],
		);
		ticker.stop();
	});
});
