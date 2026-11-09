import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { SETTLE_MS } from "../src/keys/decision.js";
import { SessionModel } from "../src/model/sessions.js";
import { ALLOW_DECISION } from "../src/protocol/wire.js";
import type { AppRecord } from "../src/records/records.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { heldToolOf, othersArt, slotKeyArt } from "../src/slots/art.js";
import { COALESCE_MS, SlotDials } from "../src/slots/dials.js";
import { slotId } from "../src/slots/ids.js";
import { HOLD_MS, SlotKeys } from "../src/slots/keys.js";
import { OthersKeys } from "../src/slots/others.js";
import { dialSlot, firing, keySlot, OthersActions, type SdkDial, type SdkKey, SlotActions } from "../src/slots/sdk.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { slotStrip } from "../src/slots/strip.js";
import type { Feedback } from "../src/util/painter.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { deckRoot } from "./helpers/paths.js";
import { RecordingLog } from "./helpers/recording-log.js";

class FakeReply implements PollReply {
	open = true;
	sent: unknown[] = [];
	send(_status: number, body: string): void {
		this.open = false;
		this.sent.push(JSON.parse(body));
	}
	onClose(): void {}
}

/** A fake SDK key: what the wiring reads, and each call it makes, in order. */
type FakeKey = SdkKey & { calls: string[]; images: string[] };

function fakeKey(id: string, place: { device?: string; row?: number; column?: number; multi?: boolean } = {}): FakeKey {
	const calls: string[] = [];
	const images: string[] = [];
	return {
		id,
		device: { id: place.device ?? "dev" },
		coordinates: place.multi ? undefined : { row: place.row ?? 1, column: place.column ?? 0 },
		isInMultiAction: () => place.multi ?? false,
		setImage: async (image?: string) => {
			calls.push("setImage");
			images.push(image ?? "");
		},
		showOk: async () => {
			calls.push("showOk");
		},
		showAlert: async () => {
			calls.push("showAlert");
		},
		calls,
		images,
	};
}

/** A fake SDK dial on a Stream Deck + (2 rows of keys over 4 dials). */
type FakeDial = SdkDial & { calls: string[]; feedback: Feedback[] };

function fakeDial(id: string, place: { device?: string; rows?: number; column?: number } = {}): FakeDial {
	const calls: string[] = [];
	const feedback: Feedback[] = [];
	return {
		id,
		device: { id: place.device ?? "dev", size: { rows: place.rows ?? 2 } },
		coordinates: { row: 0, column: place.column ?? 0 },
		setFeedback: async (payload: Feedback) => {
			calls.push("setFeedback");
			feedback.push(payload);
		},
		setFeedbackLayout: async (layout: string) => {
			calls.push(`setFeedbackLayout ${layout}`);
		},
		showAlert: async () => {
			calls.push("showAlert");
		},
		calls,
		feedback,
	};
}

/** The SVG inside a key image's data URL. */
function svgOf(image: string | undefined): string {
	const prefix = "data:image/svg+xml;base64,";
	const url = image ?? "";
	assert.ok(url.startsWith(prefix), `an SVG data URL: ${url.slice(0, 40)}`);
	return Buffer.from(url.slice(prefix.length), "base64").toString("utf8");
}

function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "busy", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

function record(host: string, fields: Partial<AppRecord> = {}): AppRecord {
	return { host, title: null, model: null, effort: null, permissionMode: null, lastFocusedAt: null, turnCategory: null, isArchived: false, lastActivityAt: null, cwd: null, summary: null, needs: null, parent: null, offer: null, ...fields };
}

/** The plugin's wiring (src/plugin.ts) with fakes: the model, the slots, both logic classes and both actions' wiring. */
function setup(registry: RegistrySession[] = [reg(1, "local_a"), reg(2, "local_b")]) {
	const clock = new FakeClock();
	const wall = 100_000;
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => wall });
	model.setRegistry(registry);
	model.setBridgeState("listening");
	const slots = new Slots(model, { store: new MemorySlotStore(), log, clock, fillDelayMs: 0 });
	const opened: string[] = [];
	const open = (host: string) => opened.push(host);
	const keys = new SlotKeys(slots, model, { art: slotKeyArt({ heldTool: heldToolOf(model) }), clock, wallNow: () => wall, log, open, paintIntervalMs: 0 });
	const dials = new SlotDials(slots, model, { render: slotStrip, clock, wallNow: () => wall, log, open, paintIntervalMs: 0 });
	const others = new OthersKeys(slots, model, { art: othersArt, clock, wallNow: () => wall, log, open, paintIntervalMs: 0 });
	const slotActions = new SlotActions(keys, dials, { log });
	const othersActions = new OthersActions(others, { log });
	const press = (id: string): void => {
		slotActions.keyDown(id);
		slotActions.keyUp(id);
	};
	const push = (id: string): void => {
		slotActions.dialDown(id);
		slotActions.dialUp(id);
	};
	const strip = (id: string): Record<string, unknown> => {
		const p = dials.painted(id) as Record<string, { value: unknown }> | null;
		return Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, v.value]));
	};
	return { clock, log, model, slots, keys, dials, others, slotActions, othersActions, opened, press, push, strip };
}

describe("where a Session Slot sits (src/slots/sdk.ts)", () => {
	test("a key's slot is its device, row and column; in a multi-action it has none", () => {
		assert.equal(keySlot(fakeKey("k", { device: "D1", row: 1, column: 3 })), slotId("D1", 1, 3));
		assert.equal(keySlot(fakeKey("k", { device: "D1", row: 0, column: 0 })), "D1:0:0", "a top-row key has a slot too, with no dial");
		assert.equal(keySlot(fakeKey("m", { multi: true })), null);
		assert.equal(keySlot({ ...fakeKey("m", { row: 1, column: 0 }), isInMultiAction: () => true }), null, "a multi-action's key, whatever coordinates it carries");
		assert.equal(keySlot({ ...fakeKey("k"), isInMultiAction: () => false, coordinates: undefined }), null);
	});

	test("a dial's slot is the bottom row's key in its column, from the device's size", () => {
		assert.equal(dialSlot(fakeDial("d", { device: "D1", rows: 2, column: 2 })), "D1:1:2");
		assert.equal(dialSlot(fakeDial("d", { device: "D1", rows: 2, column: 2 })), keySlot(fakeKey("k", { device: "D1", row: 1, column: 2 })));
		assert.equal(dialSlot(fakeDial("d", { device: "D1", rows: 4, column: 0 })), "D1:3:0", "another device's bottom row");
	});
});

describe("the Session Slot action on a key (SlotActions)", () => {
	test("a key that appears joins its slot, which fills, and shows its face as an SVG data URL", () => {
		const { slots, slotActions } = setup();
		const key = fakeKey("k0", { row: 1, column: 0 });
		slotActions.appearKey(key);
		assert.equal(slots.host("dev:1:0"), "local_b", "the newest running session");
		assert.ok(slots.showing("dev:1:0"));
		const svg = svgOf(key.images.at(-1));
		assert.match(svg, /Working/);
		assert.match(svg, /Session 2/);
	});

	test("a press jumps to the session and makes it the target; held 500 ms, it takes the session on screen and shows OK; the key-up after does nothing", () => {
		const { clock, model, slots, slotActions, opened, press } = setup();
		const k0 = fakeKey("k0", { row: 1, column: 0 });
		const k1 = fakeKey("k1", { row: 1, column: 1 });
		slotActions.appearKey(k0);
		slotActions.appearKey(k1);
		assert.deepEqual(slots.entries(), [["dev:1:0", "local_b"], ["dev:1:1", "local_a"]]);
		press("k0");
		assert.deepEqual([opened, model.picked], [["local_b"], "local_b"]);
		// local_a comes on screen in the app; a hold on k0 takes it, and the two slots swap.
		model.setRecords(new Map([["local_a", record("local_a", { lastFocusedAt: 99_000 })]]));
		slotActions.keyDown("k0");
		clock.advance(HOLD_MS - 1);
		assert.ok(!k0.calls.includes("showOk"));
		clock.advance(1);
		assert.ok(k0.calls.includes("showOk"));
		slotActions.keyUp("k0");
		assert.deepEqual(opened, ["local_b"], "the key-up after the hold is no press");
		assert.deepEqual(slots.entries(), [["dev:1:0", "local_a"], ["dev:1:1", "local_b"]]);
	});

	test("a hold with nothing known to be on screen alerts", () => {
		const { clock, slotActions } = setup();
		const k0 = fakeKey("k0");
		slotActions.appearKey(k0);
		slotActions.keyDown("k0");
		clock.advance(HOLD_MS);
		slotActions.keyUp("k0");
		assert.deepEqual(k0.calls.filter((c) => c !== "setImage"), ["showAlert"]);
	});

	test("in a multi-action it has no slot and does nothing: no press, no hold, nothing filled", () => {
		const { clock, slots, slotActions, opened, press, log } = setup();
		const m = fakeKey("m", { multi: true });
		slotActions.appearKey(m);
		press("m");
		slotActions.keyDown("m");
		clock.advance(HOLD_MS);
		slotActions.keyUp("m");
		assert.deepEqual([opened, slots.entries(), m.calls.filter((c) => c !== "setImage")], [[], [], []]);
		assert.ok(log.at("info").some((l) => l.includes("multi-action")));
	});
});

describe("the Session Slot action on a dial (SlotActions)", () => {
	test("a dial joins the slot of the key above it: the same session, its layout set before its feedback", () => {
		const { slots, slotActions, strip } = setup();
		const key = fakeKey("k2", { row: 1, column: 2 });
		const dial = fakeDial("d2", { column: 2 });
		slotActions.appearKey(key);
		slotActions.appearDial(dial);
		assert.equal(slots.host("dev:1:2"), "local_b");
		assert.deepEqual(dial.calls.slice(0, 2), ["setFeedbackLayout layouts/slot-pages.json", "setFeedback"]);
		assert.equal(strip("d2").name, "Session 2");
	});

	test("turning pages, a push or a tap jumps, a long touch goes back to the first page, and a push that turned while held is no press", () => {
		const { clock, model, slotActions, opened, push, strip } = setup();
		slotActions.appearDial(fakeDial("d0"));
		assert.equal(strip("d0").dots, "●○○");
		slotActions.dialRotate("d0", 1, false);
		clock.advance(COALESCE_MS);
		assert.equal(strip("d0").dots, "○●○");
		push("d0");
		assert.deepEqual([opened, model.picked], [["local_b"], "local_b"]);
		slotActions.touchTap("d0", false);
		assert.deepEqual(opened, ["local_b", "local_b"], "a tap is a press");
		slotActions.touchTap("d0", true);
		clock.advance(COALESCE_MS);
		assert.equal(strip("d0").dots, "●○○", "a long touch goes back to the first page");
		slotActions.dialDown("d0");
		slotActions.dialRotate("d0", 1, true);
		slotActions.dialUp("d0");
		assert.equal(opened.length, 2, "turned while pushed: no press");
	});

	test("an approval on the strip: a turn picks Allow, and a push once it has been in sight 1 s sends the keys' Allow", () => {
		const { clock, model, slotActions, push, strip } = setup([reg(1, "local_a")]);
		const dial = fakeDial("d0");
		slotActions.appearDial(dial);
		const reply = new FakeReply();
		void model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "npm test" } }, "local_a", reply);
		assert.deepEqual([strip("d0").head, strip("d0").line1], ["Allow Bash?", "npm test"]);
		assert.ok(dial.calls.includes("setFeedbackLayout layouts/slot-approval.json"));
		slotActions.dialRotate("d0", 1, false);
		clock.advance(SETTLE_MS);
		push("d0");
		assert.deepEqual(reply.sent, [ALLOW_DECISION]);
	});

	test("whatever disappears leaves its slot, which keeps its session; its later events do nothing", () => {
		const { slots, slotActions, opened, press, push } = setup();
		slotActions.appearKey(fakeKey("k0"));
		slotActions.appearDial(fakeDial("d0"));
		slotActions.disappear("k0");
		assert.ok(slots.showing("dev:1:0"), "the dial still shows it");
		slotActions.disappear("d0");
		assert.ok(!slots.showing("dev:1:0"));
		assert.equal(slots.host("dev:1:0"), "local_b", "a hidden slot keeps its session");
		press("k0");
		push("d0");
		assert.deepEqual(opened, []);
	});
});

describe("the SDK's calls to the app (Fire)", () => {
	test("a call that fails, or throws, is logged at warn and goes no further", async () => {
		const log = new RecordingLog();
		const fire = firing(log);
		fire("setImage", () => Promise.reject(new Error("socket closed")));
		fire("showOk", () => {
			throw new Error("not connected");
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(log.at("warn").map((l) => l.split("\n")[0]).sort(), ["warn setImage failed: Error: socket closed", "warn showOk failed: Error: not connected"].sort());
	});

	test("a key whose setImage rejects still answers its presses", async () => {
		const { slotActions, opened, press, log } = setup();
		const key = { ...fakeKey("k0"), setImage: () => Promise.reject(new Error("gone")) };
		slotActions.appearKey(key);
		press("k0");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(opened, ["local_b"]);
		assert.ok(log.at("warn").some((l) => l.startsWith("warn setImage failed")));
	});
});

describe("the Other Sessions action (OthersActions)", () => {
	test("it shows the sessions on no slot; a press jumps to the one waiting longest, or alerts with none", () => {
		const { model, slotActions, othersActions, opened } = setup([reg(1, "local_a"), reg(2, "local_b"), reg(3, "local_c")]);
		slotActions.appearKey(fakeKey("k0"));
		const other = fakeKey("o", { row: 0, column: 3 });
		othersActions.appear(other);
		assert.match(svgOf(other.images.at(-1)), /2 running/);
		othersActions.keyDown("o");
		assert.deepEqual([opened, other.calls.at(-1)], [[], "showAlert"]);
		void model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "ls" } }, "local_a", new FakeReply());
		assert.match(svgOf(other.images.at(-1)), /1 needs you/);
		othersActions.keyDown("o");
		assert.deepEqual([opened, model.picked], [["local_a"], "local_a"]);
		othersActions.disappear("o");
		othersActions.keyDown("o");
		assert.deepEqual(opened, ["local_a"]);
	});
});

describe("the SDK wrappers (src/actions/slot.ts and others.ts)", () => {
	// The wrappers import the SDK, which the tests can't load, so this reads them: each hands every event on, and
	// nothing else.
	const source = (file: string): string => readFileSync(path.join(deckRoot(), "src", "actions", file), "utf8");

	test("Session Slot hands on each of its key's and dial's events", () => {
		const s = source("slot.ts");
		const handlers: [string, string][] = [
			["onWillAppear", "this.#slots.appearKey(ev.action)"],
			["onWillAppear", "this.#slots.appearDial(ev.action)"],
			["onWillDisappear", "this.#slots.disappear(ev.action.id)"],
			["onKeyDown", "this.#slots.keyDown(ev.action.id)"],
			["onKeyUp", "this.#slots.keyUp(ev.action.id)"],
			["onDialRotate", "this.#slots.dialRotate(ev.action.id, ev.payload.ticks, ev.payload.pressed)"],
			["onDialDown", "this.#slots.dialDown(ev.action.id)"],
			["onDialUp", "this.#slots.dialUp(ev.action.id)"],
			["onTouchTap", "this.#slots.touchTap(ev.action.id, ev.payload.hold)"],
		];
		for (const [handler, call] of handlers) {
			assert.ok(s.includes(`override ${handler}(`), handler);
			assert.ok(s.includes(call), call);
		}
		assert.match(s, /@action\(\{ UUID: "com\.karimdhanji\.claude\.slot" \}\)/);
	});

	test("Other Sessions hands on its key's events", () => {
		const s = source("others.ts");
		for (const call of ["this.#others.appear(ev.action)", "this.#others.disappear(ev.action.id)", "this.#others.keyDown(ev.action.id)"]) assert.ok(s.includes(call), call);
		assert.match(s, /@action\(\{ UUID: "com\.karimdhanji\.claude\.others" \}\)/);
	});
});
