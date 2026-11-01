import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_BANKS, watchList } from "../src/banks.js";
import { DialDeck, type DialSurface } from "../src/dial/deck.js";
import { clampToRange } from "../src/model/steps.js";
import { LrModel } from "../src/model/model.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { FakeLink } from "./helpers/fake-link.js";
import { concrete, connectHello, connectState, type Fixture, loadFixtures, rangesFor, type Setup, targetPhoto, watchedValues } from "./helpers/fixtures.js";

type Obj = Record<string, unknown>;

const WATCH = watchList(DEFAULT_BANKS);
const INST = "replay-inst";

/**
 * fixtures.test.ts feeds Lightroom's side of every fixture into the client. This file checks the deck's side:
 * for the conversations that are dial gestures, it turns, presses and touches the dials, and the commands the
 * model sends must be the fixture's `deck` lines, by these rules from PROTOCOL.md:
 *
 * - Every field of the fixture line must be there and equal (numbers within 1e-6); the deck may add an `id`.
 *   The deck numbers its own commands, so a fixture line's `id` only asks for one.
 * - The deck numbers its own gestures too: a fixture's `g` stands for one deck gesture, one to one, so a
 *   fixture's g 4 and g 5 can be the deck's g 1 and g 2, but not both its g 1.
 * - The deck clamps its own values to the param's range before sending (Develop values), so a fixture
 *   `set.v` outside the range, sent to test Lightroom's clamping, is expected clamped.
 * - The deck may also send a `done` for its own open gesture before the next one starts (Lightroom tracks one
 *   param at a time and would end it anyway), and `module develop` before a turn outside Develop.
 * - Every `set` and `reset` carries `ph`, which older fixture lines leave out (PROTOCOL.md, Gestures). It must
 *   be the photo Lightroom was on when the deck sent it, as far as the deck can know: the target photo until
 *   the replay plays a `user` photo change, then the new one.
 * - Some fixtures also test Lightroom with lines this deck never sends: a gesture number it already saw
 *   refused, a malformed `ph`, an older client's set, a write while it knows the photo is locked. NOT_SENT
 *   names them, and Lightroom's answers to them are played as plain events, matched to no deck command.
 *
 * The fixture's `lr` lines are played back right after the `deck` or `user` line they follow, so acks carry
 * the deck's own gesture numbers, and an `err` carries the id of the deck's command for the line it answers.
 * A `user` photo change also brings what Lightroom sends after its state, every watched range and value for
 * the new photo, which fixtures leave out. At the end the deck must hold the values in the fixture's last
 * `expect` for the photo it's on, and only the dials ALERTS names may have shown an alert.
 */

/** PROTOCOL.md's matching rules, for a deck line. */
function fieldsMatch(want: unknown, got: unknown): boolean {
	if (want === "*") return true;
	if (typeof want === "number") return typeof got === "number" && Math.abs(want - got) <= 1e-6;
	if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((w, i) => fieldsMatch(w, got[i]));
	if (typeof want === "object" && want !== null) {
		if (typeof got !== "object" || got === null) return false;
		return Object.entries(want).every(([k, w]) => fieldsMatch(w, (got as Obj)[k]));
	}
	return want === got;
}

/** The fixture's gesture numbers against the deck's, one to one. A pairing sticks once a line with it has matched. */
class GestureNumbers {
	readonly #deck = new Map<number, number>();
	readonly #fixture = new Map<number, number>();

	/** Whether fixture gesture `f` can be deck gesture `d`. */
	fits(f: unknown, d: unknown): boolean {
		if (f === "*") return true;
		if (typeof f !== "number" || typeof d !== "number") return false;
		const paired = this.#deck.get(f);
		return paired === undefined ? !this.#fixture.has(d) : paired === d;
	}

	pair(f: unknown, d: unknown): void {
		if (typeof f !== "number" || typeof d !== "number" || this.#deck.has(f)) return;
		this.#deck.set(f, d);
		this.#fixture.set(d, f);
	}

	/** The deck's number for fixture gesture `f`, once a deck line of it has matched. */
	deckFor(f: number): number | undefined {
		return this.#deck.get(f);
	}
}

function lineMatches(want: Obj, got: Obj, gestures: GestureNumbers = new GestureNumbers()): boolean {
	const { id: wantId, g: wantG, ...fields } = want;
	if (wantId !== undefined && !Number.isSafeInteger(got.id)) return false;
	if ("g" in want && !gestures.fits(wantG, got.g)) return false;
	// The deck adds an id where the line has none, and ph where an older fixture line has none.
	const allowed = new Set([...Object.keys(want), "id", ...(got.t === "set" || got.t === "reset" ? ["ph"] : [])]);
	return fieldsMatch(fields, got) && Object.keys(got).every((k) => allowed.has(k));
}

/** The fixture's deck lines as this deck sends them: `set.v` clamped to the target photo's range. */
function expectedDeckLines(fixture: Fixture): Obj[] {
	const photo = targetPhoto(fixture.setup);
	const ranges = photo ? rangesFor(fixture.setup, photo) : {};
	return deckLines(fixture).map((cmd) => {
		if (cmd.t !== "set" || typeof cmd.p !== "string" || typeof cmd.v !== "number") return cmd;
		return { ...cmd, v: clampToRange(cmd.v, ranges[cmd.p]) };
	});
}

function deckLines(fixture: Fixture): Obj[] {
	return fixture.lines.flatMap((l) => ("deck" in l ? [l.deck] : []));
}

/**
 * Walks `sent` along the fixture's deck lines: the command that matched each line so far, what didn't fit, and
 * how the fixture's gesture numbers paired with the deck's.
 */
function walkDeckLines(sent: Obj[], expected: Obj[], outsideDevelop: boolean): { matched: Obj[]; problems: string[]; numbers: GestureNumbers } {
	const problems: string[] = [];
	const matched: Obj[] = [];
	const numbers = new GestureNumbers();
	const gestures = new Set<unknown>();
	const done = new Set<unknown>();
	for (const cmd of sent) {
		const want = expected[matched.length];
		if (want && lineMatches(want, cmd, numbers)) {
			matched.push(cmd);
			numbers.pair(want.g, cmd.g);
		} else if (cmd.t === "done" && gestures.has(cmd.g) && !done.has(cmd.g)) {
			// the deck ends its own gesture before the next one
		} else if (cmd.t === "module" && cmd.v === "develop" && outsideDevelop) {
			// the deck asks for Develop before a turn applies outside it
		} else problems.push(`unexpected ${JSON.stringify(cmd)}; next expected ${JSON.stringify(want ?? null)}`);
		if (cmd.t === "set") gestures.add(cmd.g);
		if (cmd.t === "done") done.add(cmd.g);
	}
	return { matched, problems, numbers };
}

/** Returns what's wrong with `sent` as the deck's side of the conversation; empty when it matches. */
function matchDeckLines(sent: Obj[], expected: Obj[], outsideDevelop: boolean): string[] {
	const { matched, problems } = walkDeckLines(sent, expected, outsideDevelop);
	for (const missing of expected.slice(matched.length)) problems.push(`never sent ${JSON.stringify(missing)}`);
	return problems;
}

type Replay = {
	clock: FakeClock;
	model: LrModel;
	deck: DialDeck;
	/** Plays the fixture's `lr` lines that answer its `n`-th `deck` line (1-based), up to the next deck or user line. */
	lr(n: number): void;
	/**
	 * Plays the fixture's `k`-th `user` line (1-based): its `lr` lines, and for a photo change in Develop the new
	 * photo's ranges and vals for the watched params, which Lightroom sends after the state.
	 */
	user(k: number): void;
	/** Lightroom's answer to `module develop`: state, then ranges and vals for the watched params. */
	enterDevelop(): void;
	/** The ranges and vals for the watched params that Lightroom sends on entering Develop, where the fixture has the state but leaves those out. */
	developValues(): void;
};

/**
 * Dial input for each gesture fixture. The banks put Temp, Tint, Exposure, Contrast on dials 0–3 in bank 1.
 * Exposure moves 1/30 EV a tick and 1/120 EV a fine (push + turn) tick, so values like 0.40 need fine ticks.
 */
const REPLAYS: Record<string, (r: Replay) => void> = {
	"dial-gesture.jsonl": (r) => {
		r.deck.down("dial-2");
		r.deck.rotate("dial-2", 6, true); // 0.35 + 6/120 = 0.40
		r.lr(1);
		r.clock.advance(50);
		r.deck.rotate("dial-2", 8, true); // 0.4667, sent as 0.47
		r.lr(2);
		r.clock.advance(50);
		r.deck.rotate("dial-2", 10, true); // 0.55
		r.lr(3);
		r.deck.up("dial-2"); // push + turn: done on dial-up, not 800 ms later
		r.lr(4);
		r.clock.advance(400);
	},
	"clamp.jsonl": (r) => {
		r.deck.rotate("dial-2", 100, false); // far past +5 EV
		r.lr(1);
		r.clock.advance(50);
		r.deck.rotate("dial-0", -100, false); // far below 2000 K; ends the Exposure gesture first
		r.lr(2);
		r.clock.advance(800); // done, 800 ms after the last tick
		r.lr(3);
		r.clock.advance(400);
	},
	"gesture-switch.jsonl": (r) => {
		r.deck.down("dial-2");
		r.deck.rotate("dial-2", 18, true); // 0.35 + 18/120 = 0.50
		r.lr(1);
		r.clock.advance(50);
		r.deck.rotate("dial-3", 4, false); // 4 ticks accelerate to 10: Contrast 0 → 10, while Exposure's gesture is open
		r.lr(2);
		r.deck.up("dial-2"); // Exposure's gesture already ended: nothing to end, and no reset
		r.clock.advance(800);
		r.lr(3);
		r.clock.advance(400);
	},
	"reset.jsonl": (r) => {
		r.deck.down("dial-2");
		r.deck.rotate("dial-2", 102, true); // 0.35 + 102/120 = 1.20
		r.lr(1);
		r.deck.tap("dial-2", true); // long touch resets; Lightroom's reset ends the gesture, so no done
		r.lr(2);
		r.deck.up("dial-2");
		r.clock.advance(400);
	},
	"set-from-library.jsonl": (r) => {
		r.deck.tap("dial-0", false); // bank 2: Highlights, Shadows, Whites, Blacks
		r.deck.rotate("dial-1", 5, false); // 5 ticks accelerate to 15: Shadows 15 → 30, held until Develop's vals
		r.enterDevelop();
		r.lr(1);
		r.clock.advance(800);
		r.lr(2);
		r.clock.advance(400);
	},
	"stale-gesture.jsonl": (r) => {
		r.deck.down("dial-2");
		r.deck.rotate("dial-2", 18, true); // 0.35 + 18/120 = 0.50 on photo 101
		r.lr(1);
		r.clock.advance(50);
		r.deck.rotate("dial-2", 12, true); // 0.60, sent before the deck hears of the photo change
		r.clock.advance(50);
		r.deck.rotate("dial-2", 12, true); // 0.70, likewise
		// The user moves to photo 102 in Lightroom. Its poll sees it before either set arrives, so the deck gets
		// 102's state, ranges and vals first, and then the errs for gesture 1's two sets.
		r.user(1);
		r.lr(2);
		r.lr(3);
		r.clock.advance(50);
		r.deck.rotate("dial-2", 12, true); // a new gesture from 102's -0.40: -0.30
		r.lr(4);
		r.deck.up("dial-2"); // push + turn: done on dial-up
		r.clock.advance(400);
	},
	"stale-photo.jsonl": (r) => {
		// The user moved to photo 102 in Lightroom, and its state hasn't reached the deck: a turn and a press
		// both work from photo 101, so both carry ph 101.
		r.deck.rotate("dial-2", 1, false); // 0.35 + 1/30, sent as 0.38
		r.clock.advance(50);
		r.deck.down("dial-2");
		r.deck.up("dial-2"); // a press without turning resets, which ends the gesture without done
		r.user(1); // 102's state, ranges and vals arrive
		r.lr(1); // err stale for the set: the deck has seen 102 by now, so nothing more happens
		r.lr(2); // err stale for the reset: dropped, without an alert
		r.lr(3);
		r.clock.advance(50);
		r.deck.rotate("dial-2", 1, false); // a new gesture from 102's -0.40: -0.37, with ph 102
		r.lr(4);
		r.clock.advance(800); // done, 800 ms after the last tick
		r.lr(5);
		r.clock.advance(400);
		r.lr(6);
		r.lr(7); // an older client's set without ph lands, and Lightroom's ack for it is the value now
		r.lr(8);
		r.clock.advance(400);
	},
	"locked.jsonl": (r) => {
		r.user(1); // a background process locks photo 101, in Library
		r.deck.rotate("dial-2", 3, false); // dropped: no set, and no module develop either; the dial alerts
		r.lr(1);
		r.lr(2); // Lightroom goes to Develop all the same, and the photo is still locked
		r.developValues();
		r.clock.advance(1100);
		r.deck.down("dial-2");
		r.deck.up("dial-2"); // a press resets nothing; a new burst, so the dial alerts again
		r.lr(3);
		r.user(2); // the process finishes
		r.deck.down("dial-2");
		r.deck.rotate("dial-2", 18, true); // 0.35 + 18/120 = 0.50, sent at once
		r.lr(4);
		r.deck.up("dial-2"); // push + turn: done on dial-up
		r.lr(5);
		r.clock.advance(400);
	},
};

/**
 * Deck lines this deck never sends, by number among the fixture's deck lines (1-based), and why. They test
 * Lightroom; the replay still plays Lightroom's answers to them, as events no command of the deck's waits for.
 */
const NOT_SENT: Record<string, Record<number, string>> = {
	"stale-photo.jsonl": {
		3: "a set of a gesture Lightroom refused as stale: the deck never sends that g again",
		6: "a ph that isn't a string, malformed on purpose",
		7: "an older client's set, without ph",
		8: "that client's done",
	},
	"locked.jsonl": {
		1: "a set in Library: outside Develop the deck holds turns, and it drops them while the photo is locked",
		2: "module develop for a turn while the photo is locked",
		3: "a reset while the photo is locked",
	},
};

/** The dials that show an alert, in order, where a replay expects any. */
const ALERTS: Record<string, string[]> = {
	"locked.jsonl": ["dial-2", "dial-2"], // the turn in Library, then the press 1.1 s later: two bursts
};

/** The fixture's deck lines that this deck sends, as it sends them (see {@link expectedDeckLines}). */
function sentDeckLines(fixture: Fixture): Obj[] {
	const notSent = NOT_SENT[fixture.name] ?? {};
	return expectedDeckLines(fixture).filter((_, i) => notSent[i + 1] === undefined);
}

/** A gesture number for Lightroom's answers to lines in NOT_SENT: far from any the deck uses, so no ack lands on a deck gesture. */
const foreignGesture = (g: number): number => 1_000_000 + g;

type Played = { link: FakeLink; model: LrModel; problems: string[]; alerts: string[]; scene: Setup };

function play(fixture: Fixture, replay: (r: Replay) => void): Played {
	const setup: Setup = fixture.setup;
	/** Lightroom's photos and target as the conversation goes on: a user photo change moves the target. */
	let scene: Setup = setup;
	const clock = new FakeClock();
	const link = new FakeLink(clock);
	const model = new LrModel(link, { clock });
	const deck = new DialDeck(DEFAULT_BANKS, model, { clock });
	const alerts: string[] = [];
	for (let c = 0; c < 4; c++) {
		const id = `dial-${c}`;
		const surface: DialSurface = { setFeedback: () => undefined, showAlert: () => alerts.push(id) };
		deck.add(id, c, surface);
	}

	// The connection, as the client would have it: hello and state, then the answer to the deck's watch.
	link.lr(connectHello(setup, INST));
	link.lr(connectState(setup));
	for (const evt of watchedValues(setup, WATCH)) link.lr(evt);
	link.take();

	// The lr lines after each deck and user line, up to the next one, with wildcards made concrete.
	const segments = new Map<string, Obj[]>([["deck 0", []]]);
	const users: Obj[] = [];
	let segment = "deck 0";
	let decks = 0;
	for (const line of fixture.lines) {
		if ("deck" in line) segment = `deck ${++decks}`;
		else if ("user" in line) segment = `user ${users.push(line.user)}`;
		else if ("lr" in line) segments.get(segment)?.push(concrete(line.lr, INST) as Obj);
		if ("deck" in line || "user" in line) segments.set(segment, []);
	}
	const notSent = NOT_SENT[fixture.name] ?? {};
	const expected = sentDeckLines(fixture);
	const outsideDevelop = (setup.module ?? "develop") !== "develop";
	const played = new Set<string>();
	const problems: string[] = [];
	let errs = 0;
	const playSegment = (key: string): Obj[] => {
		if (played.has(key)) problems.push(`lr lines after ${key} played twice`);
		played.add(key);
		return segments.get(key) ?? [];
	};
	/** Where deck line n is among the lines the deck sends, 0-based. */
	const sentIndex = (n: number): number => Array.from({ length: n - 1 }, (_, i) => i + 1).filter((i) => notSent[i] === undefined).length;
	/**
	 * Lightroom answers the deck's own commands: an err carries the id of the command that matched deck line n,
	 * and an ack the deck's number for the fixture's gesture.
	 */
	const answer = (n: number, evt: Obj): Obj => {
		const walk = walkDeckLines(link.sent.map((s) => s.cmd as Obj), expected, outsideDevelop);
		if (evt.t === "ack" && typeof evt.g === "number") {
			const g = walk.numbers.deckFor(evt.g);
			if (g === undefined) problems.push(`the ack after deck line ${n} was played before the deck sent a set of gesture ${evt.g}`);
			return { ...evt, g: g ?? evt.g };
		}
		if (evt.t !== "err") return evt;
		errs += 1;
		const cmd = walk.matched[sentIndex(n)];
		if (!cmd) {
			problems.push(`the err after deck line ${n} was played before the deck sent that line`);
			return evt;
		}
		const { id: _id, ...rest } = evt;
		return typeof cmd.id === "number" ? { ...rest, id: cmd.id } : rest;
	};
	/** Lightroom's answer to a line in NOT_SENT: an err with no id and an ack of a gesture the deck never had, so neither reaches a deck command. */
	const unanswered = (evt: Obj): Obj => {
		if (evt.t === "ack" && typeof evt.g === "number") return { ...evt, g: foreignGesture(evt.g) };
		if (evt.t !== "err") return evt;
		const { id: _id, ...rest } = evt;
		return rest;
	};
	/** The photo each set and reset must carry as ph, from the sent command at index `from` on. */
	const photos: { from: number; photo: string | null }[] = [{ from: 0, photo: targetPhoto(setup)?.id ?? null }];
	replay({
		clock,
		model,
		deck,
		lr: (n) => {
			for (const evt of playSegment(`deck ${n}`)) link.lr(notSent[n] === undefined ? answer(n, evt) : unanswered(evt));
		},
		user: (k) => {
			const action = users[k - 1];
			const photo = typeof action?.photo === "string" ? action.photo : null;
			if (photo !== null) photos.push({ from: link.sent.length, photo });
			for (const evt of playSegment(`user ${k}`)) link.lr(evt);
			if (photo !== null) {
				scene = { ...scene, target: photo, selected: [photo] };
				for (const evt of watchedValues(scene, WATCH)) link.lr(evt);
			} else if (!Array.isArray(action?.locked)) {
				// A lock changes only state.locked, which the fixture's own lr line carries.
				problems.push(`the replay doesn't model user line ${k}: ${JSON.stringify(action ?? null)}`);
			}
		},
		enterDevelop: () => {
			scene = { ...scene, module: "develop" };
			link.lr(connectState(scene));
			for (const evt of watchedValues(scene, WATCH)) link.lr(evt);
		},
		developValues: () => {
			scene = { ...scene, module: "develop" };
			for (const evt of watchedValues(scene, WATCH)) link.lr(evt);
		},
	});
	for (const [key, lines] of segments) {
		if (lines.length > 0 && !played.has(key)) problems.push(`lr lines after ${key} were never played`);
	}
	if (link.routedErrs.length !== errs) problems.push(`${errs} err line(s) played, but ${link.routedErrs.length} reached the command they answer`);
	link.sent.forEach(({ cmd }, i) => {
		if (cmd.t !== "set" && cmd.t !== "reset") return;
		const want = photos.findLast((p) => p.from <= i)?.photo ?? null;
		if ((cmd.ph ?? null) !== want) problems.push(`${JSON.stringify(cmd)} should carry ph ${JSON.stringify(want)}, the photo Lightroom was on as far as the deck knew`);
	});
	return { link, model, problems, alerts, scene };
}

describe("protocol fixtures, the deck's side: dial gestures send the fixtures' deck lines", () => {
	const fixtures = new Map(loadFixtures().map((f) => [f.name, f]));

	test("every replayed fixture exists, and every line NOT_SENT names is one of its deck lines", () => {
		assert.deepEqual(
			[...Object.keys(REPLAYS), ...Object.keys(NOT_SENT), ...Object.keys(ALERTS)].filter((name) => !fixtures.has(name) || !REPLAYS[name]),
			[],
		);
		for (const [name, lines] of Object.entries(NOT_SENT)) {
			const count = deckLines(fixtures.get(name) as Fixture).length;
			assert.deepEqual(
				Object.keys(lines).filter((n) => !(Number(n) >= 1 && Number(n) <= count)),
				[],
				name,
			);
		}
	});

	for (const [name, replay] of Object.entries(REPLAYS)) {
		test(name, () => {
			const fixture = fixtures.get(name);
			assert.ok(fixture, `${name} is in lightroom/protocol/fixtures`);
			const { link, model, problems, alerts, scene } = play(fixture, replay);
			assert.deepEqual(problems, []);

			const sent = link.sent.map((s) => s.cmd as Obj);
			assert.deepEqual(matchDeckLines(sent, sentDeckLines(fixture), (fixture.setup.module ?? "develop") !== "develop"), [], JSON.stringify(sent));
			assert.deepEqual(link.problems, [], "every command matches PROTOCOL.md");
			assert.deepEqual(alerts, ALERTS[name] ?? [], "only the expected dials showed an alert");

			// The deck ends where the fixture's last expect leaves Lightroom, on the photo Lightroom is on now.
			const expects = fixture.lines.flatMap((l) => ("expect" in l ? [l.expect] : []));
			const last = expects.at(-1) ?? {};
			const target = targetPhoto(scene)?.id ?? "";
			assert.equal(model.state.photo, target, "the deck is on Lightroom's target photo");
			const values = ((last.values as Record<string, Record<string, number>> | undefined) ?? {})[target] ?? {};
			assert.ok(Object.keys(values).length > 0, "the fixture expects values");
			for (const [p, v] of Object.entries(values)) {
				const got = model.view(p).value;
				assert.ok(got !== null && Math.abs(got - v) <= 1e-6, `${p}: the deck shows ${got}, the fixture expects ${v}`);
			}
			if (typeof last.module === "string") assert.equal(model.state.module, last.module);
			if (last.tracking === false) assert.equal(model.gesture, null, "no gesture open");
			assert.deepEqual(model.held, []);
		});
	}

	test("the matcher rejects a deck that strays from the fixture", () => {
		const expected = [
			{ t: "set", p: "Exposure", v: 0.4, g: 1 },
			{ t: "done", g: 1 },
		];
		assert.deepEqual(matchDeckLines([{ t: "set", p: "Exposure", v: 0.4, g: 1, id: 3 }, { t: "done", g: 1 }], expected, false), []);
		assert.equal(matchDeckLines([{ t: "set", p: "Exposure", v: 0.41, g: 1 }, { t: "done", g: 1 }], expected, false).length > 0, true, "a wrong value");
		assert.equal(matchDeckLines([{ t: "set", p: "Exposure", v: 0.4, g: 1 }], expected, false).length > 0, true, "a missing done");
		assert.equal(matchDeckLines([{ t: "set", p: "Exposure", v: 0.4, g: 1, seq: 2 }, { t: "done", g: 1 }], expected, false).length > 0, true, "an unknown field");
		assert.equal(matchDeckLines([{ t: "module", v: "develop" }, ...expected], expected, false).length > 0, true, "module develop in Develop");
		assert.equal(matchDeckLines([{ t: "done", g: 7 }, ...expected], expected, false).length > 0, true, "done for a gesture never sent");
		// A fixture line's id asks for an id; the deck numbers its own commands.
		const withId = [{ t: "set", p: "Exposure", v: 0.6, g: 1, id: 7 }];
		assert.deepEqual(matchDeckLines([{ t: "set", p: "Exposure", v: 0.6, g: 1, id: 2 }], withId, false), []);
		assert.equal(matchDeckLines([{ t: "set", p: "Exposure", v: 0.6, g: 1 }], withId, false).length > 0, true, "no id at all");
		// It numbers its own gestures too, one to one with the fixture's.
		const twoGestures = [
			{ t: "set", p: "Exposure", v: 0.4, g: 4 },
			{ t: "done", g: 4 },
			{ t: "set", p: "Exposure", v: 0.5, g: 5 },
		];
		const deckGestures = (a: number, b: number, c: number): Obj[] => [
			{ t: "set", p: "Exposure", v: 0.4, g: a },
			{ t: "done", g: b },
			{ t: "set", p: "Exposure", v: 0.5, g: c },
		];
		assert.deepEqual(matchDeckLines(deckGestures(1, 1, 2), twoGestures, false), []);
		assert.equal(matchDeckLines(deckGestures(1, 1, 1), twoGestures, false).length > 0, true, "one deck gesture for two of the fixture's");
		assert.equal(matchDeckLines(deckGestures(1, 2, 2), twoGestures, false).length > 0, true, "a done for another gesture");
		// ph may come on a set or reset whose line has none; where the line has one, it must match.
		assert.deepEqual(matchDeckLines([{ t: "set", p: "Exposure", v: 0.4, g: 1, ph: "101" }, { t: "done", g: 1 }], expected, false), []);
		assert.equal(matchDeckLines([{ t: "set", p: "Exposure", v: 0.4, g: 1, ph: "102" }], [{ t: "set", p: "Exposure", v: 0.4, g: 1, ph: "101" }], false).length > 0, true, "another photo's ph");
		assert.equal(matchDeckLines([{ t: "set", p: "Exposure", v: 0.4, g: 1 }, { t: "done", g: 1, ph: "101" }], expected, false).length > 0, true, "ph on a done");
	});
});
