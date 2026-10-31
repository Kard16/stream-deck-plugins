import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { LineSplitter } from "../src/lr/framing.js";
import { portsFromEnv } from "../src/lr/ports.js";
import { type ErrCode, parseEvent, roundForSend } from "../src/lr/protocol.js";
import { validateCommand } from "../src/lr/validate.js";
import { loadFixtures } from "./helpers/fixtures.js";

describe("command validator (PROTOCOL.md, Commands)", () => {
	const good: Record<string, unknown>[] = [
		{ t: "hello", v: 1, client: "deck", ver: "0.2.0.0" },
		{ t: "ping", id: 1 },
		{ t: "watch", ps: ["Exposure", "Contrast"] },
		{ t: "set", p: "Exposure", v: 0.35, g: 1 },
		{ t: "set", p: "Exposure", v: -5, g: 2, id: 7 },
		{ t: "set", p: "Temperature", v: 5550, g: 3 },
		{ t: "done", g: 1 },
		{ t: "done" },
		{ t: "reset", p: "Exposure", id: 3 },
		{ t: "module", v: "develop" },
		{ t: "module", v: "library" },
		{ t: "flag", v: "pick", advance: true },
		{ t: "flag", v: "reject", advance: false, id: 9 },
		{ t: "flag", v: "none" },
		{ t: "nav", v: "next" },
		{ t: "nav", v: "prev" },
		{ t: "view", v: "before" },
		{ t: "view", v: "after" },
		{ t: "presets", id: 5 },
		{ t: "preset", id: 6, uuid: "A1B2C3D4E5F60718293A4B5C6D7E8F90" },
		{ t: "reload", id: 11, mods: ["Develop"] },
		{ t: "reload", id: 12 },
	];
	for (const cmd of good) {
		test(`accepts ${JSON.stringify(cmd)}`, () => assert.deepEqual(validateCommand(cmd), []));
	}

	const bad: [Record<string, unknown> | unknown, RegExp][] = [
		[[1, 2, 3], /JSON object/],
		[{ v: 1 }, /t must be a string/],
		[{ t: "explode", id: 4 }, /unknown command type/],
		[{ t: "hello", v: 2, client: "deck", ver: "1" }, /hello\.v must be 1/],
		[{ t: "ping" }, /ping\.id is missing/],
		[{ t: "ping", id: 1.5 }, /ping\.id must be an integer/],
		[{ t: "set", p: "Exposure", g: 1 }, /set\.v is missing/],
		[{ t: "set", p: "Exposure", v: 0.351, g: 1 }, /isn't rounded to 0\.01/],
		[{ t: "set", p: "Contrast", v: 10.5, g: 1 }, /isn't rounded to a whole number/],
		[{ t: "set", p: "Exposure", v: 1, g: 1, seq: 4 }, /set\.seq isn't a field/],
		[{ t: "set", p: "Exposure", v: Number.NaN, g: 1 }, /finite/],
		[{ t: "flag", v: "maybe" }, /flag\.v must be one of/],
		[{ t: "flag", v: "pick", advance: "yes" }, /advance must be a boolean/],
		[{ t: "watch", ps: ["Exposure", ""] }, /list of non-empty strings/],
		[{ t: "preset", id: 6 }, /preset\.uuid is missing/],
		[{ t: "view", v: "loupe" }, /view\.v must be one of/],
		// Names Object.prototype has must not count as command types or fields.
		[{ t: "constructor" }, /unknown command type "constructor"/],
		[{ t: "toString" }, /unknown command type "toString"/],
		[{ t: "__proto__" }, /unknown command type "__proto__"/],
		[{ t: "ping", id: 1, hasOwnProperty: 1 }, /ping\.hasOwnProperty isn't a field/],
	];
	for (const [cmd, problem] of bad) {
		test(`rejects ${JSON.stringify(cmd)}`, () => {
			const problems = validateCommand(cmd);
			assert.ok(
				problems.some((p) => problem.test(p)),
				`${JSON.stringify(problems)} should match ${problem}`,
			);
		});
	}

	test("every deck line in the fixtures passes, except the malformed ones errors.jsonl sends on purpose", () => {
		const failures: string[] = [];
		for (const fixture of loadFixtures()) {
			for (const line of fixture.lines) {
				if (!("deck" in line)) continue;
				const problems = validateCommand(line.deck);
				if (problems.length > 0) failures.push(`${fixture.name}: ${JSON.stringify(line.deck)}`);
			}
		}
		assert.deepEqual(failures, [
			'errors.jsonl: {"t":"explode","id":4}',
			'errors.jsonl: {"t":"set","p":"Exposure","g":1}',
			'errors.jsonl: {"t":"flag","v":"maybe"}',
		]);
	});
});

describe("event parsing (PROTOCOL.md, Events)", () => {
	test("accepts every event type and ignores unknown fields", () => {
		const events: Record<string, unknown>[] = [
			{ t: "hello", v: 1, lr: "15.3", catalog: "Plugin Test.lrcat", path: "/x.lrcat", guard: "on", writable: true, inst: "abc", extra: 1 },
			{ t: "state", module: "develop", photo: "101", file: "DSC0101.ARW", flag: -1, rating: 5, label: "red", sel: 3 },
			{ t: "state", module: "library", photo: null, file: null, flag: 0, rating: 0, label: "none", sel: 0 },
			{ t: "ranges", ranges: { Temperature: [2000, 50000] } },
			{ t: "vals", vals: { Exposure: 0.35 } },
			{ t: "ack", p: "Exposure", v: 5, g: 1 },
			{ t: "ack", p: "Exposure", v: 0 },
			{ t: "presets", id: 5, items: [{ uuid: "U", name: "N", folder: "F" }] },
			{ t: "applied", id: 6, uuid: "U", n: 2, locked: 0 },
			{ t: "reloaded", id: 11, mods: ["Develop"], ok: true, msg: "" },
			{ t: "pong", id: 1, lt: 812345.25 },
			{ t: "err", id: 4, cmd: "explode", code: "unknown", msg: "unknown command" },
			{ t: "err", code: "bad", msg: "bad JSON" },
		];
		for (const evt of events) assert.equal(parseEvent(evt).kind, "event", JSON.stringify(evt));
	});

	test("err stale: a set whose gesture ended when the photo or module changed (Amendments)", () => {
		const code: ErrCode = "stale";
		const errs = [
			{ t: "err", id: 7, cmd: "set", code, msg: "gesture 1 ended when the photo or module changed" },
			{ t: "err", cmd: "set", code },
		];
		for (const raw of errs) {
			const parsed = parseEvent(raw);
			assert.ok(parsed.kind === "event", JSON.stringify(raw));
			assert.deepEqual(parsed.evt, raw);
			assert.deepEqual(parsed.dropped, []);
		}
	});

	test("rejects malformed events, ignores unknown types, and drops badly typed optional fields", () => {
		assert.equal(parseEvent("ok").kind, "invalid");
		assert.equal(parseEvent({ v: 1 }).kind, "invalid");
		assert.equal(parseEvent({ t: "hello" }).kind, "invalid");
		assert.equal(parseEvent({ t: "vals", vals: [1] }).kind, "invalid");
		assert.equal(parseEvent({ t: "ack", p: "Exposure" }).kind, "invalid");
		assert.equal(parseEvent({ t: "err" }).kind, "invalid");
		assert.equal(parseEvent({ t: "bye", why: "shutdownApp" }).kind, "ignored");
		const parsed = parseEvent({ t: "state", module: "develop", flag: 7, photo: 101 });
		assert.equal(parsed.kind, "event");
		if (parsed.kind === "event") {
			assert.deepEqual(parsed.evt, { t: "state", module: "develop", photo: "101" });
			assert.deepEqual(parsed.dropped, ["flag"]);
		}
		const ranges = parseEvent({ t: "ranges", ranges: { Exposure: [-5, 5], Bad: [3, 1], Worse: "x" } });
		assert.ok(ranges.kind === "event" && ranges.evt.t === "ranges");
		if (ranges.kind === "event" && ranges.evt.t === "ranges") assert.deepEqual(Object.keys(ranges.evt.ranges), ["Exposure"]);
	});

	test("rounds before sending: Exposure to 0.01, everything else to whole numbers, never -0", () => {
		assert.equal(roundForSend("Exposure", 0.3833), 0.38);
		assert.equal(roundForSend("Exposure", 0.356), 0.36);
		assert.equal(roundForSend("Contrast", 10.5), 11);
		assert.equal(roundForSend("Temperature", 5562.5), 5563);
		assert.ok(Object.is(roundForSend("Contrast", -0.4), 0));
		assert.ok(Object.is(roundForSend("Exposure", -0.004), 0));
	});

	test("halves round away from zero, so fine adjust moves the same distance both ways", () => {
		assert.deepEqual(
			[0.5, -0.5, 1.5, -1.5, 2.5, -2.5].map((v) => roundForSend("Contrast", v)),
			[1, -1, 2, -2, 3, -3],
		);
		assert.deepEqual([roundForSend("Exposure", 0.025), roundForSend("Exposure", -0.025)], [0.03, -0.03]);
		assert.deepEqual([roundForSend("Temperature", 5487.5), roundForSend("Temperature", 5512.5)], [5488, 5513]);
	});
});

describe("line framing", () => {
	test("splits lines across chunks, trims CR, and keeps multi-byte characters whole", () => {
		const splitter = new LineSplitter();
		const bytes = Buffer.from('{"a":"é"}\r\n{"b":2}\n{"c":', "utf8");
		const cut = bytes.indexOf(0xc3) + 1; // inside é
		assert.deepEqual(splitter.push(bytes.subarray(0, cut)), []);
		assert.deepEqual(splitter.push(bytes.subarray(cut)), ['{"a":"é"}', '{"b":2}']);
		assert.equal(splitter.pending, 5);
		assert.deepEqual(splitter.push("3}\n"), ['{"c":3}']);
	});
});

describe("ports", () => {
	test("PROTOCOL.md's 58780 and 58781 unless DECKBRIDGE_CMD_PORT and DECKBRIDGE_EVT_PORT say otherwise", () => {
		assert.deepEqual(portsFromEnv({}), { cmdPort: 58780, evtPort: 58781 });
		assert.deepEqual(portsFromEnv({ DECKBRIDGE_CMD_PORT: "40001", DECKBRIDGE_EVT_PORT: "40002" }), { cmdPort: 40001, evtPort: 40002 });
		assert.deepEqual(portsFromEnv({ DECKBRIDGE_CMD_PORT: "nope", DECKBRIDGE_EVT_PORT: "70000" }), { cmdPort: 58780, evtPort: 58781 });
		assert.deepEqual(portsFromEnv({ DECKBRIDGE_CMD_PORT: " ", DECKBRIDGE_EVT_PORT: "1.5" }), { cmdPort: 58780, evtPort: 58781 });
	});
});
