import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import type { PollReply } from "../src/bridge/commands.js";
import { PromptKeys } from "../src/keys/commands.js";
import { DecisionKeys, type KeySurface, SETTLE_MS } from "../src/keys/decision.js";
import { Devices, DRIFT_RATIO, sleptText, WAKE_REPAINTS_MS, WAKE_WINDOW_MS, wakeLine } from "../src/model/devices.js";
import { SessionModel } from "../src/model/sessions.js";
import { ALLOW_DECISION } from "../src/protocol/wire.js";
import type { RegistrySession } from "../src/registry/registry.js";
import { heldToolOf, othersArt, slotKeyArt } from "../src/slots/art.js";
import { PICK_SETTLE_MS, SlotDials, type SlotDialSurface } from "../src/slots/dials.js";
import { dialSlotId, slotId } from "../src/slots/ids.js";
import { SlotKeys } from "../src/slots/keys.js";
import { OthersKeys } from "../src/slots/others.js";
import { Slots } from "../src/slots/slots.js";
import { MemorySlotStore } from "../src/slots/store.js";
import { slotStrip } from "../src/slots/strip.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { deckRoot } from "./helpers/paths.js";
import { RecordingLog } from "./helpers/recording-log.js";

const DECK = { id: "D1", name: "Stream Deck +" };

/** Devices on a fake clock, with a wall clock the test moves, counting its repaints and what it told onLive. */
function setup() {
	const clock = new FakeClock();
	let wall = 1_793_600_000_000;
	const log = new RecordingLog();
	const told: boolean[] = [];
	let repaints = 0;
	const devices = new Devices({ log, clock, wallNow: () => wall, repaint: () => repaints++, onLive: (live) => told.push(live) });
	/** Time awake: both clocks move. */
	const advance = (ms: number): void => {
		wall += ms;
		clock.advance(ms);
	};
	/** System sleep: only the wall clock moves, as performance.now() stops while macOS sleeps. */
	const sleep = (ms: number): void => {
		wall += ms;
	};
	return { devices, clock, log, told, repaints: () => repaints, advance, sleep, info: () => log.at("info").map((l) => l.slice("info ".length)) };
}

describe("which Stream Decks are connected (src/model/devices.ts, agents-and-wake.md C1)", () => {
	test("at start, the devices the SDK knows; each connect logs, tells onLive the first time and repaints every key and strip; a disconnect logs, and the last one tells onLive", () => {
		const { devices, told, repaints, info } = setup();
		devices.start([{ ...DECK, isConnected: false }]);
		assert.deepEqual([devices.live, told, repaints()], [false, [false], 0]);
		devices.connected(DECK.id, DECK.name);
		assert.deepEqual([devices.live, told, repaints()], [true, [false, true], 1]);
		devices.connected("D2", "Pedal");
		devices.connected(DECK.id, DECK.name);
		assert.deepEqual([told, repaints()], [[false, true], 3], "a connect for a device it has is the app's word that it's back too: repainted");
		devices.disconnected("D2", "Pedal");
		assert.deepEqual([devices.live, told], [true, [false, true]], "one is still connected");
		devices.disconnected(DECK.id, DECK.name);
		assert.deepEqual([devices.live, told], [false, [false, true, false]]);
		assert.deepEqual(info(), [
			'known at start: "Stream Deck +" (D1), not connected yet',
			'Device "Stream Deck +" (D1) connected',
			"Repaint: every key and strip (device connected)",
			'Device "Pedal" (D2) connected',
			"Repaint: every key and strip (device connected)",
			'Device "Stream Deck +" (D1) connected',
			"Repaint: every key and strip (device connected)",
			'Device "Pedal" (D2) disconnected',
			'Device "Stream Deck +" (D1) disconnected',
		]);
	});

	test("a device the SDK has as connected at start is connected, and repainted", () => {
		const { devices, told, repaints, info } = setup();
		devices.start([{ ...DECK, isConnected: true }, { id: "D2", name: "Pedal", isConnected: false }]);
		assert.deepEqual([devices.live, told.at(-1), repaints()], [true, true, 1]);
		assert.deepEqual(info().slice(0, 2), ['known at start: "Stream Deck +" (D1); "Pedal" (D2), not connected yet', 'Device "Stream Deck +" (D1) connected']);
	});

	test("a press from a device it has as away is a connect it missed: a warn line, then the connect; from one it has, nothing", () => {
		const { devices, log, repaints } = setup();
		devices.pressed(DECK.id, DECK.name);
		assert.deepEqual([devices.live, repaints()], [true, 1]);
		assert.ok(log.at("warn").some((l) => l.startsWith('warn Device "Stream Deck +" (D1): a press came from it, though the deck had it as not connected')), log.at("warn").join("\n"));
		assert.ok(log.at("info").includes('info Device "Stream Deck +" (D1) connected'));
		devices.pressed(DECK.id, DECK.name);
		assert.equal(repaints(), 1);
	});

	test("at a start whose connect never came, a press is the connect it missed: a warn line, then the connect; another device's press, and one after a disconnect, count for their own", () => {
		const { devices, log, told, repaints, info } = setup();
		devices.start([{ ...DECK, isConnected: false }]);
		assert.deepEqual([devices.live, told, repaints()], [false, [false], 0]);
		devices.pressed(DECK.id, DECK.name);
		assert.deepEqual([devices.live, told, repaints()], [true, [false, true], 1]);
		assert.deepEqual(log.at("warn"), ['warn Device "Stream Deck +" (D1): a press came from it, though the deck had it as not connected; taking it as connected']);
		assert.deepEqual(info().slice(2), ['Device "Stream Deck +" (D1) connected', "Repaint: every key and strip (device connected)"], "the warn line, then the usual connect line and repaint");
		devices.pressed(DECK.id, DECK.name);
		assert.deepEqual([repaints(), log.at("warn").length], [1, 1], "it has it now");
		devices.pressed("D2", "Stream Deck XL");
		devices.disconnected(DECK.id, DECK.name);
		devices.pressed(DECK.id, DECK.name);
		assert.deepEqual(
			log.at("warn").slice(1),
			['warn Device "Stream Deck XL" (D2): a press came from it, though the deck had it as not connected; taking it as connected', 'warn Device "Stream Deck +" (D1): a press came from it, though the deck had it as not connected; taking it as connected'],
		);
		assert.equal(repaints(), 3);
	});

	test("an action appearing is no connect: the app sends willAppear at a plugin start for a device that's away too", () => {
		const { devices } = setup();
		assert.equal("appeared" in devices, false, "Devices takes no willAppear");
		const plugin = readFileSync(path.join(deckRoot(), "src", "plugin.ts"), "utf8");
		assert.doesNotMatch(plugin, /onWillAppear/, "plugin.ts takes no willAppear of its own, in any spelling: each action's does its own work");
	});

	test("a repaint or an onLive that throws is logged at error, and nothing escapes into the SDK's handler", () => {
		const log = new RecordingLog();
		const devices = new Devices({
			log,
			clock: new FakeClock(),
			repaint: () => {
				throw new Error("paint");
			},
			onLive: () => {
				throw new Error("gate");
			},
		});
		devices.connected(DECK.id, DECK.name);
		devices.disconnected(DECK.id, DECK.name);
		assert.deepEqual(
			log.at("error").map((l) => l.split("\n")[0]),
			["error following the devices threw: Error: gate", "error repainting every key and strip threw: Error: paint", "error following the devices threw: Error: gate"],
		);
	});
});

describe("the wake (src/model/devices.ts, agents-and-wake.md C2 and C4)", () => {
	test("every key and strip is repainted 10 s and 20 s after each wake while a device is connected; a later wake's replace an earlier's; none while no device is", () => {
		const { devices, clock, log, repaints, advance, info } = setup();
		assert.deepEqual(WAKE_REPAINTS_MS, [10_000, 20_000]);
		devices.connected(DECK.id, DECK.name);
		devices.woke();
		advance(10_000 - 1);
		assert.equal(repaints(), 1, "the connect's");
		advance(1);
		assert.equal(repaints(), 2);
		advance(10_000);
		assert.equal(repaints(), 3);
		assert.deepEqual(info().slice(-2), ["Repaint: every key and strip (10 s after the wake)", "Repaint: every key and strip (20 s after the wake)"]);
		// A wake 5 s after another: its repaints only, at 15 s and 25 s from the first.
		devices.woke();
		advance(5000);
		devices.woke();
		advance(10_000 - 1);
		assert.equal(repaints(), 3);
		advance(1);
		assert.equal(repaints(), 4);
		advance(10_000);
		assert.deepEqual([repaints(), clock.pendingTimers], [5, 0]);
		devices.disconnected(DECK.id, DECK.name);
		devices.woke();
		advance(20_000);
		assert.equal(repaints(), 5, "no device: nothing to repaint");
		assert.ok(log.at("debug").includes("debug no repaint 10 s after the wake: no device is connected"));
		devices.woke();
		devices.dispose();
		assert.equal(clock.pendingTimers, 0, "dispose stops a wake's repaints");
	});

	test("a device that connects within 60 s of a wake says how long after it, to a tenth of a second; later, it doesn't", () => {
		const { devices, advance, info } = setup();
		devices.woke();
		advance(5340);
		devices.connected(DECK.id, DECK.name);
		devices.disconnected(DECK.id, DECK.name);
		advance(WAKE_WINDOW_MS - 5340);
		devices.connected(DECK.id, DECK.name);
		devices.disconnected(DECK.id, DECK.name);
		advance(1);
		devices.connected(DECK.id, DECK.name);
		assert.deepEqual(
			info().filter((l) => l.startsWith("Device") && l.includes("connected") && !l.includes("disconnected")),
			['Device "Stream Deck +" (D1) connected, 5.3 s after the wake', 'Device "Stream Deck +" (D1) connected, 60.0 s after the wake', 'Device "Stream Deck +" (D1) connected'],
		);
	});

	test("the wake line says how long the Mac was in system sleep, from how much further the wall clock went than the monotonic clock; a display's sleep is no system sleep", () => {
		const { devices, advance, sleep } = setup();
		advance(10 * 60_000);
		assert.equal(devices.woke(), 0, "awake throughout: the display only");
		assert.equal(wakeLine(0), "woke up: rescanning; no system sleep");
		advance(60_000);
		sleep(41 * 60_000);
		advance(3000);
		const slept = devices.woke();
		assert.equal(slept, 41 * 60_000);
		assert.equal(wakeLine(slept), "woke up: rescanning; slept 41 min");
		sleep(1900);
		assert.equal(devices.woke(), 0, "under 2 s: the clocks' jitter, or a time sync");
		sleep(2500);
		assert.equal(wakeLine(devices.woke()), "woke up: rescanning; slept 3 s");
		// Two days awake, which the clocks drift apart in by a few seconds: that isn't sleep, though a minute is.
		advance(2 * 86_400_000);
		sleep(2 * 86_400_000 * DRIFT_RATIO * 0.9);
		assert.equal(devices.woke(), 0);
		advance(2 * 86_400_000);
		sleep(60_000);
		assert.equal(devices.woke(), 60_000);
	});

	test("how long it slept reads as seconds, minutes, or hours and minutes", () => {
		assert.deepEqual(
			[2400, 38_000, 59_400, 59_600, 41 * 60_000, 59.6 * 60_000, 125 * 60_000, 3 * 3_600_000, 27 * 3_600_000 + 40 * 60_000].map(sleptText),
			["2 s", "38 s", "59 s", "1 min", "41 min", "1 h", "2 h 5 min", "3 h", "27 h 40 min"],
		);
	});
});

const A = "local_a";
const B = "local_b";

function reg(pid: number, host: string, fields: Partial<RegistrySession> = {}): RegistrySession {
	return { key: String(pid), name: `Session ${pid}`, status: "busy", cwd: `/p/${pid}`, hostSessionId: host, sessionId: `sid-${pid}`, statusUpdatedAt: 1000, startedAt: pid, ...fields };
}

class FakeReply implements PollReply {
	open = true;
	sent: unknown[] = [];
	send(_status: number, body: string): void {
		this.open = false;
		this.sent.push(JSON.parse(body));
	}
	onClose(): void {}
}

/**
 * The deck as plugin.ts wires it, with surfaces that record every call to the app: Approve, Deny and a Saved Prompt,
 * a Session Slot's key and dial, and Other Sessions, each painting only while a device is connected, all repainted in
 * full by Devices.
 */
function deck() {
	const clock = new FakeClock();
	const wall = 100_000;
	const log = new RecordingLog();
	const model = new SessionModel({ clock, log, wallNow: () => wall });
	model.setRegistry([reg(1, A)]);
	model.setBridgeState("listening");
	const slots = new Slots(model, { store: new MemorySlotStore(), log, clock, fillDelayMs: 0 });
	const live = (): boolean => devices.live;
	const opts = { clock, wallNow: () => wall, log, paintIntervalMs: 0, live };
	const approve = new DecisionKeys(model, "allow", opts);
	const deny = new DecisionKeys(model, "deny", opts);
	const prompt = new PromptKeys(model, opts);
	const keys = new SlotKeys(slots, model, { art: slotKeyArt({ heldTool: heldToolOf(model) }), ...opts });
	const dials = new SlotDials(slots, model, { render: slotStrip, ...opts, coalesceMs: 0 });
	const others = new OthersKeys(slots, model, { art: othersArt, ...opts });
	const screens = [approve, deny, prompt, keys, dials, others];
	const devices: Devices = new Devices({
		log,
		clock,
		wallNow: () => wall,
		repaint: () => {
			for (const s of screens) s.repaintInFull();
		},
		onLive: (connected) => {
			model.setDeckConnected(connected);
			slots.setDeckConnected(connected);
		},
	});
	/** Every call to the app, in order, as `<who> <call>`; an image or a feedback with what it carries. */
	const calls: string[] = [];
	const key = (who: string): KeySurface => ({ setImage: (svg) => calls.push(`${who} image ${svg}`), showOk: () => calls.push(`${who} ok`), showAlert: () => calls.push(`${who} alert`) });
	const dial: SlotDialSurface = {
		setLayout: (layout) => calls.push(`dial layout ${layout}`),
		setFeedback: (payload) => calls.push(`dial feedback ${Object.keys(payload).sort().join(",")}`),
		showAlert: () => calls.push("dial alert"),
	};
	devices.start([{ ...DECK, isConnected: false }]);
	approve.add("approve", key("approve"));
	deny.add("deny", key("deny"));
	prompt.add("prompt", key("prompt"), { text: "go on" });
	keys.add("slot", slotId(DECK.id, 1, 0), key("slot"));
	dials.add("dial", dialSlotId(DECK.id, 2, 0), dial);
	others.add("others", key("others"));
	const ask = (): FakeReply => {
		const reply = new FakeReply();
		void model.permission({ session_id: "sid-1", tool_name: "Bash", tool_input: { command: "npm test" } }, A, reply);
		return reply;
	};
	const push = (): void => {
		dials.down("dial");
		dials.up("dial");
	};
	/** Who got what since `from`, each call's kind only. */
	const since = (from: number): string[] => calls.slice(from).map((c) => c.split(" ").slice(0, 2).join(" "));
	return { clock, log, model, devices, dials, calls, ask, push, since };
}

describe("the deck away and back, wired as plugin.ts does (agents-and-wake.md, C2 and C3)", () => {
	test("nothing goes to the app while no device is connected, the model keeping up meanwhile; a connect repaints every key and strip in full, the dial's layout first", () => {
		const { model, devices, calls, ask, since } = deck();
		assert.deepEqual(since(0), [], "no device yet: the keys and the dial appeared, and sent nothing");
		devices.connected(DECK.id, DECK.name);
		const all = ["approve image", "deny image", "prompt image", "slot image", "dial layout", "dial feedback", "others image"];
		assert.deepEqual(since(0).sort(), [...all].sort());
		assert.equal(since(0).indexOf("dial layout") + 1, since(0).indexOf("dial feedback"), "the layout, then the feedback that fills it");
		assert.match(calls.find((c) => c.startsWith("dial layout")) ?? "", /slot-pages\.json$/);
		// Away: a request arrives, and nothing goes.
		devices.disconnected(DECK.id, DECK.name);
		let from = calls.length;
		ask();
		assert.equal(model.session(A)?.status, "approval", "the model keeps up");
		assert.deepEqual(since(from), []);
		// Back: everything goes again, as it is now: the approval's layout on the strip, and the request on the keys.
		devices.connected(DECK.id, DECK.name);
		assert.deepEqual(since(from).sort(), [...all].sort());
		assert.match(calls.find((c, i) => i >= from && c.startsWith("dial layout")) ?? "", /slot-approval\.json$/);
		assert.match(calls.findLast((c) => c.startsWith("approve image")) ?? "", /npm test/);
		// Back again with nothing changed: the same images go again, since the app may have lost them, and the strip's
		// layout and every key of it.
		from = calls.length;
		const before = calls.filter((c) => c.includes(" image ") || c.startsWith("dial ")).slice(-7);
		devices.connected(DECK.id, DECK.name);
		assert.deepEqual(calls.slice(from).sort(), [...before].sort());
	});

	test("a start whose connect never comes: nothing paints until a press from the device, and then every key and strip does", () => {
		const { devices, since } = deck();
		assert.deepEqual(since(0), [], "the SDK has the device as not connected, and nothing has gone");
		devices.pressed(DECK.id, DECK.name);
		assert.deepEqual(since(0).sort(), ["approve image", "deny image", "dial feedback", "dial layout", "others image", "prompt image", "slot image"]);
	});

	test("10 s and 20 s after a wake, every key and strip is repainted in full while a device is connected", () => {
		const { clock, devices, since, calls } = deck();
		devices.connected(DECK.id, DECK.name);
		const from = calls.length;
		devices.woke();
		clock.advance(10_000);
		assert.equal(since(from).length, 7, "each of the six once, the dial's layout and feedback");
		clock.advance(10_000);
		assert.equal(since(from).length, 14);
	});

	test("the dial's 1 s counts from the paint that reached the deck: a request that came while it was away can't be allowed until 1 s after it's back", () => {
		const { clock, log, devices, ask, push, dials, calls } = deck();
		devices.connected(DECK.id, DECK.name);
		devices.disconnected(DECK.id, DECK.name);
		const reply = ask();
		clock.advance(5000);
		devices.connected(DECK.id, DECK.name);
		dials.rotate("dial", 1, false);
		clock.advance(PICK_SETTLE_MS);
		push();
		assert.deepEqual([reply.sent, calls.at(-1)], [[], "dial alert"], "on the strip for 300 ms, not 1 s");
		assert.ok(log.at("info").some((l) => l.endsWith("nothing sent: #1 had been in sight on the strip for 300 ms, under 1000 ms")), log.at("info").join("\n"));
		clock.advance(SETTLE_MS);
		push();
		assert.deepEqual(reply.sent, [ALLOW_DECISION]);
	});

	test("a slot key's press that shows the deck its device is back acts on what the key showed when pressed, not on the repaint that press brings: plugin.ts runs Devices' press after the key's keyDown and before its keyUp", () => {
		const clock = new FakeClock();
		const log = new RecordingLog();
		const model = new SessionModel({ clock, log, wallNow: () => 100_000 });
		model.setRegistry([reg(1, A), reg(2, B)]);
		const slots = new Slots(model, { store: new MemorySlotStore(), log, clock, fillDelayMs: 0 });
		const opened: string[] = [];
		const feedback: string[] = [];
		let devices: Devices | null = null;
		const keys = new SlotKeys(slots, model, { art: (look) => `key ${look.session?.host ?? "none"}`, clock, wallNow: () => 100_000, log, open: (h) => opened.push(h), paintIntervalMs: 0, live: () => devices?.live ?? false });
		devices = new Devices({ log, clock, repaint: () => keys.repaintInFull(), onLive: (connected) => slots.setDeckConnected(connected) });
		devices.start([{ ...DECK, isConnected: true }]);
		const slot = slotId(DECK.id, 1, 0);
		keys.add("slot", slot, { setImage: () => {}, showOk: () => feedback.push("ok"), showAlert: () => feedback.push("alert") });
		slots.place(slot, A, "the test");
		assert.equal(keys.painted("slot"), `key ${A}`);
		// The device goes, and the slot takes B meanwhile: its key sends nothing, so it still shows A. The device comes
		// back, and the deck misses its connect.
		devices.disconnected(DECK.id, DECK.name);
		slots.place(slot, B, "the test");
		assert.equal(keys.painted("slot"), `key ${A}`);
		// A press on the key that shows A: its keyDown, then plugin.ts's onKeyDown (Devices' press, a full repaint), then
		// its keyUp, which is when a slot key acts.
		keys.down("slot");
		devices.pressed(DECK.id, DECK.name);
		assert.equal(keys.painted("slot"), `key ${B}`, "the press's repaint shows B");
		keys.up("slot");
		assert.deepEqual([opened, feedback], [[], ["alert"]], "the key showed A when pressed, so the press does nothing");
		assert.ok(log.at("info").some((l) => l.endsWith(`press: nothing done: the key showed ${A}, but the slot holds ${B} now`)), log.at("info").join("\n"));
		// Now it shows B, and a press jumps there.
		keys.down("slot");
		keys.up("slot");
		assert.deepEqual([opened, feedback], [[B], ["alert"]]);
		slots.dispose();
		model.dispose();
	});

	test("the same for a slot dial's push or tap on its pages: it jumps only to the session its strip showed, a push by what showed at its dialDown, before the repaint that push brings", () => {
		for (const via of ["push", "tap"] as const) {
			const clock = new FakeClock();
			const log = new RecordingLog();
			const model = new SessionModel({ clock, log, wallNow: () => 100_000 });
			model.setRegistry([reg(1, A), reg(2, B)]);
			const slots = new Slots(model, { store: new MemorySlotStore(), log, clock, fillDelayMs: 0 });
			const opened: string[] = [];
			const names: string[] = [];
			let devices: Devices | null = null;
			const dials = new SlotDials(slots, model, { render: slotStrip, clock, wallNow: () => 100_000, log, open: (h) => opened.push(h), paintIntervalMs: 0, coalesceMs: 0, live: () => devices?.live ?? false });
			devices = new Devices({ log, clock, repaint: () => dials.repaintInFull(), onLive: (connected) => slots.setDeckConnected(connected) });
			devices.start([{ ...DECK, isConnected: true }]);
			const slot = dialSlotId(DECK.id, 2, 0);
			const surface: SlotDialSurface = {
				setLayout: () => {},
				setFeedback: (payload) => {
					const name = (payload.name as { value?: string } | undefined)?.value;
					if (name !== undefined) names.push(name);
				},
				showAlert: () => opened.push("alert"),
			};
			dials.add("dial", slot, surface);
			slots.place(slot, A, "the test");
			// The device goes, the slot takes B, and the strip, sending nothing, still shows A's pages.
			devices.disconnected(DECK.id, DECK.name);
			slots.place(slot, B, "the test");
			assert.equal(names.at(-1), "Session 1", via);
			if (via === "push") {
				dials.down("dial");
				devices.pressed(DECK.id, DECK.name);
				assert.equal(names.at(-1), "Session 2", "the push's repaint shows B");
				dials.up("dial");
			} else {
				// A tap acts at once, before plugin.ts's onTouchTap repaints.
				dials.tap("dial", false);
				devices.pressed(DECK.id, DECK.name);
			}
			assert.deepEqual(opened, ["alert"], `${via}: the strip showed A, so nothing opens`);
			assert.ok(log.at("info").some((l) => l.endsWith(`${via === "push" ? "press" : "tap"}: nothing done: the strip showed ${A}, but the slot holds ${B} now`)), log.at("info").join("\n"));
			// Now it shows B, and a press jumps there.
			dials.down("dial");
			dials.up("dial");
			assert.deepEqual(opened, ["alert", B], via);
			slots.dispose();
			model.dispose();
		}
	});
});

describe("plugin.ts hands Devices the SDK's device events, presses and wakes", () => {
	// plugin.ts imports the SDK, which the tests can't load, so this reads it.
	const plugin = readFileSync(path.join(deckRoot(), "src", "plugin.ts"), "utf8");

	test("connects, disconnects, the devices at start, the presses and the wakes go to Devices", () => {
		for (const call of [
			"streamDeck.devices.onDeviceDidConnect((ev) => devices.connected(ev.device.id, ev.device.name))",
			"streamDeck.devices.onDeviceDidDisconnect((ev) => devices.disconnected(ev.device.id, ev.device.name))",
			"() => devices.start(streamDeck.devices)",
			"devices.pressed(device.id, device.name)",
			"streamDeck.actions.onKeyDown((ev) => pressed(ev.action.device))",
			"streamDeck.actions.onDialDown((ev) => pressed(ev.action.device))",
			"streamDeck.actions.onTouchTap((ev) => pressed(ev.action.device))",
			"log.info(wakeLine(devices.woke()))",
			"model.setDeckConnected(connected)",
			"slots.setDeckConnected(connected)",
			"devices.dispose()",
		])
			assert.ok(plugin.includes(call), call);
	});

	test("every key and dial class it makes paints only while a device is connected, and is repainted in full", () => {
		const screens = (/const screens = \[([^\]]*)\]/.exec(plugin)?.[1] ?? "").split(",").map((s) => s.trim());
		const made = [...plugin.matchAll(/const (\w+) = new (DecisionKeys|PromptKeys|SlotKeys|SlotDials|OthersKeys)\((.*)\);/g)];
		assert.deepEqual(made.map((m) => m[2]).sort(), ["DecisionKeys", "DecisionKeys", "OthersKeys", "PromptKeys", "SlotDials", "SlotKeys"]);
		for (const [, name, cls, args] of made) {
			assert.ok(screens.includes(name ?? ""), `${name}, a ${cls}, is repainted in full`);
			assert.match(args ?? "", /\blive \}$/, `${name}, a ${cls}, is given live`);
		}
		assert.equal(screens.length, made.length);
	});
});
