import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_BANKS, watchList } from "../src/banks.js";
import { LrClient } from "../src/lr/client.js";
import { LrModel } from "../src/model/model.js";
import { FakeLr } from "./helpers/fake-lr.js";
import { concrete, connectHello, connectState, loadFixtures, watchedValues } from "./helpers/fixtures.js";
import { waitFor } from "./helpers/wait.js";

type Obj = Record<string, unknown>;

const WATCH = watchList(DEFAULT_BANKS);
const INST = "fixture-inst";

/**
 * An independent reading of what the deck should believe after `events`, kept deliberately simple: the last
 * hello, the merged state, ranges and values (acks included), and a cache drop when `inst` changes.
 */
function reference(events: Obj[]): { hello: Obj | null; state: Obj; ranges: Obj; values: Record<string, number> } {
	let hello: Obj | null = null;
	let inst: string | null = null;
	const state: Obj = {};
	let ranges: Obj = {};
	let values: Record<string, number> = {};
	for (const e of events) {
		if (e.t === "hello") {
			hello = e;
			if (typeof e.inst === "string" && e.inst !== inst) {
				if (inst !== null) {
					ranges = {};
					values = {};
				}
				inst = e.inst;
			}
		} else if (e.t === "state") {
			for (const [k, v] of Object.entries(e)) if (k !== "t") state[k] = v;
		} else if (e.t === "ranges") Object.assign(ranges, e.ranges);
		else if (e.t === "vals") Object.assign(values, e.vals);
		else if (e.t === "ack") values[e.p as string] = e.v as number;
	}
	return { hello, state, ranges, values };
}

const value = (model: LrModel, p: string): number | null => model.view(p).value;

/** What each conversation leaves the deck knowing, beyond the generic consistency check. */
const EXPECT: Record<string, (model: LrModel) => void> = {
	"before-after.jsonl": (m) => assert.equal(m.state.module, "develop"),
	"clamp.jsonl": (m) => assert.deepEqual([value(m, "Exposure"), value(m, "Temperature")], [5, 2000]),
	"dial-gesture.jsonl": (m) => assert.equal(value(m, "Exposure"), 0.55),
	"errors.jsonl": (m) => assert.equal(value(m, "Exposure"), 0.35, "errors change nothing"),
	"flag-autoadvance.jsonl": (m) => assert.deepEqual([m.state.photo, m.state.flag, m.state.rating, m.state.label], ["102", 0, 2, "red"]),
	"flags.jsonl": (m) => assert.deepEqual([m.state.photo, m.state.flag], ["103", 1]),
	"gesture-switch.jsonl": (m) => assert.deepEqual([value(m, "Exposure"), value(m, "Contrast")], [0.5, 10]),
	"gesture-timeout.jsonl": (m) => assert.equal(value(m, "Tint"), 25),
	"guard.jsonl": (m) => {
		assert.equal(m.writable, false);
		assert.equal(m.state.photo, "102");
	},
	"handshake.jsonl": (m) => {
		assert.equal(m.writable, true);
		assert.deepEqual(m.view("Temperature"), { value: 5500, range: [2000, 50000], fresh: true, adjusting: false });
		assert.equal(value(m, "Exposure"), 0.35);
	},
	"mouse-edit.jsonl": (m) => {
		assert.deepEqual([value(m, "Exposure"), value(m, "Contrast")], [0.8, -12]);
		assert.equal(m.view("Contrast").fresh, true);
	},
	"nav.jsonl": (m) => assert.equal(m.state.photo, "101"),
	"outside-develop.jsonl": (m) => {
		assert.equal(m.inDevelop, false);
		assert.equal(value(m, "Exposure"), 0.35, "the last values stay, to be shown dimmed");
		assert.equal(m.view("Exposure").fresh, false);
	},
	"photo-change.jsonl": (m) => {
		assert.deepEqual([m.state.photo, m.state.file], ["104", "IMG0104.JPG"]);
		assert.deepEqual(m.view("Temperature"), { value: 0, range: [-100, 100], fresh: true, adjusting: false });
		assert.equal(value(m, "Contrast"), 5);
	},
	"presets.jsonl": (m) => assert.equal(m.state.sel, 2),
	"reload.jsonl": (m) => assert.equal(m.conn, "online"),
	"reset.jsonl": (m) => assert.equal(value(m, "Exposure"), 0),
	"set-from-library.jsonl": (m) => assert.equal(value(m, "Shadows"), 30),
	"stale-gesture.jsonl": (m) => {
		assert.deepEqual([m.state.photo, m.state.file, m.state.rating], ["102", "DSC0102.ARW", 2]);
		// Both errs answer sets this deck never sent, so they change nothing; the last ack is photo 102's -0.3.
		assert.deepEqual(m.view("Exposure"), { value: -0.3, range: [-5, 5], fresh: true, adjusting: false });
	},
	"stale-photo.jsonl": (m) => {
		assert.deepEqual([m.state.photo, m.state.file, m.state.rating], ["102", "DSC0102.ARW", 2]);
		// The stale and bad errs answer commands this deck never sent; the last ack, an older client's, is -0.3.
		assert.deepEqual(m.view("Exposure"), { value: -0.3, range: [-5, 5], fresh: true, adjusting: false });
	},
	"locked.jsonl": (m) => {
		assert.deepEqual([m.state.module, m.state.photo, m.state.locked], ["develop", "101", false], "the lock has ended");
		assert.equal(value(m, "Exposure"), 0.5);
	},
};

describe("protocol fixtures (lightroom/protocol/fixtures)", () => {
	const fixtures = loadFixtures();

	test("every fixture has a check here", () => {
		assert.ok(fixtures.length >= 21, `found ${fixtures.length} fixtures`);
		assert.deepEqual(
			fixtures.map((f) => f.name).filter((name) => !EXPECT[name]),
			[],
		);
	});

	for (const fixture of fixtures) {
		test(`${fixture.name}: the deck accepts every lr message and ends in a consistent state`, async () => {
			const { setup } = fixture;
			const lr = await FakeLr.start({
				onEvtConnect: (fake) => {
					fake.send(connectHello(setup, INST));
					fake.send(connectState(setup));
				},
				onCommand: (cmd, fake) => {
					if (cmd.t === "hello") {
						fake.send(connectHello(setup, INST));
						fake.send(connectState(setup));
					} else if (cmd.t === "watch") {
						for (const evt of watchedValues(setup, cmd.ps as string[])) fake.send(evt);
					} else if (cmd.t === "ping") fake.send({ t: "pong", id: cmd.id, lt: 1 });
				},
			});
			const client = new LrClient({ cmdPort: lr.cmdPort, evtPort: lr.evtPort, ver: "fixture-test", watch: WATCH, timing: { backoffMinMs: 20, backoffMaxMs: 100 } });
			const model = new LrModel(client);
			const alerts: string[] = [];
			model.onAlert((_origin, why) => alerts.push(why));
			const handled = (): number => client.stats.events + client.stats.invalidEvents + client.stats.ignoredEvents + client.stats.badLines;
			try {
				client.start();
				await waitFor(() => client.state === "online" && lr.commands("watch").length === 1, "the handshake");
				await waitFor(() => handled() >= lr.sent.length, "the handshake's events");

				const lines = fixture.lines.flatMap((l) => ("lr" in l ? [concrete(l.lr, INST) as Obj] : []));
				assert.ok(lines.length > 0, "the fixture has lr lines");
				for (const evt of lines) lr.send(evt);
				await waitFor(() => handled() >= lr.sent.length, "every lr line");

				// Every message was accepted as a valid v1 event.
				assert.deepEqual(
					{ invalid: client.stats.invalidEvents, ignored: client.stats.ignoredEvents, bad: client.stats.badLines },
					{ invalid: 0, ignored: 0, bad: 0 },
				);
				assert.equal(client.state, "online");

				// The deck's picture matches an independent reading of everything Lightroom sent.
				const ref = reference(lr.sent);
				for (const [k, v] of Object.entries(ref.state)) assert.deepEqual((model.state as Obj)[k], v, `state.${k}`);
				assert.equal(model.writable, ref.hello?.writable);
				for (const [p, r] of Object.entries(ref.ranges)) assert.deepEqual(model.view(p).range, r, `range of ${p}`);
				for (const [p, v] of Object.entries(ref.values)) assert.equal(model.view(p).value, v, `value of ${p}`);
				assert.equal(model.gesture, null);
				assert.deepEqual(model.held, []);
				assert.deepEqual(alerts, [], "Lightroom's messages alone raise no alert");
				EXPECT[fixture.name]?.(model);

				// Lightroom's messages alone never make the deck send anything but the handshake and heartbeat,
				// and everything it did send matches PROTOCOL.md.
				assert.deepEqual([...new Set(lr.commands().map((c) => c.t))].sort(), ["hello", "ping", "watch"].filter((t) => lr.commands(t).length > 0));
				assert.deepEqual(lr.invalid, []);
			} finally {
				client.stop();
				await lr.close();
			}
		});
	}
});
