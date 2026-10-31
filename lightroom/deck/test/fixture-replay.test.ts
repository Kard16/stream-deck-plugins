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
 * - The deck clamps its own values to the param's range before sending (Develop values), so a fixture
 *   `set.v` outside the range, sent to test Lightroom's clamping, is expected clamped.
 * - The deck may also send a `done` for its own open gesture before the next one starts (Lightroom tracks one
 *   param at a time and would end it anyway), and `module develop` before a turn outside Develop.
 *
 * The fixture's `lr` lines are played back right after the `deck` or `user` line they follow, so acks carry
 * the deck's own gesture numbers, and an `err` carries the id of the deck's command for the line it answers.
 * A `user` photo change also brings what Lightroom sends after its state, every watched range and value for
 * the new photo, which fixtures leave out. At the end the deck must hold the values in the fixture's last
 * `expect` for the photo it's on, and no dial may have shown an alert.
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

function lineMatches(want: Obj, got: Obj): boolean {
	const { id: wantId, ...fields } = want;
	if (wantId !== undefined && !Number.isSafeInteger(got.id)) return false;
	const extra = Object.keys(got).filter((k) => !(k in fields));
	return fieldsMatch(fields, got) && extra.every((k) => k === "id");
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

/** Walks `sent` along the fixture's deck lines: the command that matched each line so far, and what didn't fit. */
function walkDeckLines(sent: Obj[], expected: Obj[], outsideDevelop: boolean): { matched: Obj[]; problems: string[] } {
	const problems: string[] = [];
	const matched: Obj[] = [];
	const gestures = new Set<unknown>();
	const done = new Set<unknown>();
	for (const cmd of sent) {
		const want = expected[matched.length];
		if (want && lineMatches(want, cmd)) matched.push(cmd);
		else if (cmd.t === "done" && gestures.has(cmd.g) && !done.has(cmd.g)) {
			// the deck ends its own gesture before the next one
		} else if (cmd.t === "module" && cmd.v === "develop" && outsideDevelop) {
			// the deck asks for Develop before a turn applies outside it
		} else problems.push(`unexpected ${JSON.stringify(cmd)}; next expected ${JSON.stringify(want ?? null)}`);
		if (cmd.t === "set") gestures.add(cmd.g);
		if (cmd.t === "done") done.add(cmd.g);
	}
	return { matched, problems };
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
};

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
	const expected = expectedDeckLines(fixture);
	const outsideDevelop = (setup.module ?? "develop") !== "develop";
	const played = new Set<string>();
	const problems: string[] = [];
	let errs = 0;
	const playSegment = (key: string): Obj[] => {
		if (played.has(key)) problems.push(`lr lines after ${key} played twice`);
		played.add(key);
		return segments.get(key) ?? [];
	};
	/** Lightroom answers a command with its own id: the deck's id for the command that matched deck line n. */
	const answer = (n: number, evt: Obj): Obj => {
		if (evt.t !== "err") return evt;
		errs += 1;
		const cmd = walkDeckLines(link.sent.map((s) => s.cmd as Obj), expected, outsideDevelop).matched[n - 1];
		if (!cmd) {
			problems.push(`the err after deck line ${n} was played before the deck sent that line`);
			return evt;
		}
		const { id: _id, ...rest } = evt;
		return typeof cmd.id === "number" ? { ...rest, id: cmd.id } : rest;
	};
	replay({
		clock,
		model,
		deck,
		lr: (n) => {
			for (const evt of playSegment(`deck ${n}`)) link.lr(answer(n, evt));
		},
		user: (k) => {
			const action = users[k - 1];
			for (const evt of playSegment(`user ${k}`)) link.lr(evt);
			if (typeof action?.photo !== "string") {
				problems.push(`the replay doesn't model user line ${k}: ${JSON.stringify(action ?? null)}`);
				return;
			}
			scene = { ...scene, target: action.photo, selected: [action.photo] };
			for (const evt of watchedValues(scene, WATCH)) link.lr(evt);
		},
		enterDevelop: () => {
			const inDevelop = { ...scene, module: "develop" };
			link.lr(connectState(inDevelop));
			for (const evt of watchedValues(inDevelop, WATCH)) link.lr(evt);
		},
	});
	for (const [key, lines] of segments) {
		if (lines.length > 0 && !played.has(key)) problems.push(`lr lines after ${key} were never played`);
	}
	if (link.routedErrs.length !== errs) problems.push(`${errs} err line(s) played, but ${link.routedErrs.length} reached the command they answer`);
	return { link, model, problems, alerts, scene };
}

describe("protocol fixtures, the deck's side: dial gestures send the fixtures' deck lines", () => {
	const fixtures = new Map(loadFixtures().map((f) => [f.name, f]));

	test("every replayed fixture exists", () => {
		assert.deepEqual(
			Object.keys(REPLAYS).filter((name) => !fixtures.has(name)),
			[],
		);
	});

	for (const [name, replay] of Object.entries(REPLAYS)) {
		test(name, () => {
			const fixture = fixtures.get(name);
			assert.ok(fixture, `${name} is in lightroom/protocol/fixtures`);
			const { link, model, problems, alerts, scene } = play(fixture, replay);
			assert.deepEqual(problems, []);

			const sent = link.sent.map((s) => s.cmd as Obj);
			assert.deepEqual(matchDeckLines(sent, expectedDeckLines(fixture), (fixture.setup.module ?? "develop") !== "develop"), [], JSON.stringify(sent));
			assert.deepEqual(link.problems, [], "every command matches PROTOCOL.md");
			assert.deepEqual(alerts, [], "no dial showed an alert");

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
	});
});
