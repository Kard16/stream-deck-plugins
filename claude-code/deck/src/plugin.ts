import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck from "@elgato/streamdeck";

import { ApproveKeyAction, DenyKeyAction } from "./actions/decision-keys.js";
import { OthersKeyAction } from "./actions/others.js";
import { PromptKeyAction } from "./actions/prompt-key.js";
import { SessionSlotAction } from "./actions/slot.js";
import { BRIDGE_HOST, BRIDGE_PORT, RUN_DIR, TOKEN_FILE } from "./bridge/config.js";
import { BridgeServer } from "./bridge/server.js";
import { type LoadedToken, loadOrCreateToken } from "./bridge/token.js";
import { PromptKeys } from "./keys/commands.js";
import { DecisionKeys } from "./keys/decision.js";
import { Devices, wakeLine } from "./model/devices.js";
import { lsappinfoCheck } from "./model/front.js";
import { connectSources } from "./model/sources.js";
import { VersionCheck, versionFiles } from "./model/versions.js";
import { heldToolOf, othersArt, slotKeyArt } from "./slots/art.js";
import { SlotDials } from "./slots/dials.js";
import { SlotKeys } from "./slots/keys.js";
import { OthersKeys } from "./slots/others.js";
import { OthersActions, SlotActions } from "./slots/sdk.js";
import { Slots } from "./slots/slots.js";
import { SlotFile } from "./slots/store.js";
import { slotStrip } from "./slots/strip.js";
import { startIdleLog } from "./util/idle.js";
import { loadLogLevelFile, LOG_LEVEL_FILE } from "./util/log-level.js";
import { describeError, type Log, redacting, Scrubber } from "./util/log.js";

// bin/plugin.js → the .sdPlugin folder, which holds run/token and the optional log-level.txt.
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The live session registry (one file per running session) and the app's own session records (S5). Read only. */
const REGISTRY_DIR = path.join(os.homedir(), ".claude", "sessions");
const RECORDS_DIR = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

// The log is com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log, at info unless log-level.txt
// says otherwise. "trace" needs a debugger (--inspect), so without one it falls back to debug.
const logLevel = loadLogLevelFile(path.join(pluginDir, LOG_LEVEL_FILE));
streamDeck.logger.setLevel(logLevel.level);
const traceRefused = streamDeck.logger.level !== logLevel.level;
if (traceRefused) streamDeck.logger.setLevel("debug");
const log = streamDeck.logger.createScope("Claude");
log.info(`STARTUP ${JSON.stringify({ pid: process.pid, node: process.version, t: Date.now(), version: streamDeck.info.plugin.version, log: streamDeck.logger.level })}`);
if (logLevel.warning) log.warn(logLevel.warning);
if (traceRefused) log.info(`${LOG_LEVEL_FILE} asks for ${logLevel.level}, which needs a debugger (--inspect); logging at debug`);

// The bridge token: created on first start (file 0600, folder 0700), never logged. Without it the bridge stays off.
let loaded: LoadedToken | null = null;
try {
	loaded = loadOrCreateToken(path.join(pluginDir, RUN_DIR));
	log.info(`token: ${loaded.created ? "created" : "using"} ${RUN_DIR}/${TOKEN_FILE}`);
	for (const note of loaded.notes) log.warn(`token: ${note}`);
} catch (err) {
	log.error(`can't set up ${RUN_DIR}/${TOKEN_FILE}, so the bridge stays off: ${describeError(err)}`);
}
/** Every logger below has the token taken out of its lines. */
const scrubber = new Scrubber(loaded?.token ?? "");
const scope = (name: string): Log => redacting(streamDeck.logger.createScope(name), scrubber);

// A jump opens the app's own link for the session (spike S5): it focuses the main window and shows that session.
// openUrl can't open custom schemes, so it goes through /usr/bin/open.
const jumpLog = scope("Jump");
const openSession = (host: string): void => {
	const url = `claude://code/continue?session=${encodeURIComponent(host)}`;
	const started = Date.now();
	execFile("/usr/bin/open", [url], (err) => {
		if (err) jumpLog.warn(`open ${url} failed: ${describeError(err)}`);
		else jumpLog.info(`opened ${url} in ${Date.now() - started} ms`);
	});
};

// Drift (hardening.md, C1): each session's hello is held to the repo the deck is linked from, its vendored mods API
// reference's Claude Code version and its plugin's version. Both are read now, and again when a hello brings a newer one,
// so a refresh or a release mid-run is seen without a restart.
const versions = new VersionCheck(versionFiles(pluginDir), { log: scope("Versions") });

// The session model: the registry, the app's records and the bridge, merged by the app's local_ id. Both folders are
// watched (fs.watch, FSEvents) and read about 50 ms after they change, and every 30 s whatever the watch says. A hook's
// request or a hello that the latest reading doesn't confirm has the registry read once more at once. The wiring is
// connectSources's, which the tests run too. For `seen`, it asks /usr/bin/lsappinfo whether Claude is the app in front,
// only while a session whose turn ended unseen is on screen in the app and a Session Slot or Other Sessions key is on
// a connected deck (SessionModel.showsSeen and setDeckConnected): every second at first, backing off to once a minute
// (front.ts's frontIntervalMs).
const { registry, records, model } = connectSources({
	registryDir: REGISTRY_DIR,
	recordsDir: RECORDS_DIR,
	logs: { registry: scope("Registry"), records: scope("Records"), sessions: scope("Sessions") },
	model: { front: lsappinfoCheck({ log: scope("Front") }), versions },
});

// The bridge on 127.0.0.1:47600. It listens again should its server close or fail (agents-and-wake.md, C5).
const bridge = loaded ? new BridgeServer({ port: BRIDGE_PORT, host: BRIDGE_HOST, token: loaded.token, routes: model, log: scope("Bridge") }) : null;
bridge?.onState((state) => model.setBridgeState(state));

// The Stream Deck devices (agents-and-wake.md, C1 to C4). While none is connected, the keys and strips send nothing,
// and the front-app check and the slots' repaint tick stop; the model keeps up. Every key and strip is repainted in
// full when a device connects, and 10 s and 20 s after a wake: the Stream Deck app turns the deck off at every display
// sleep or lock, and may bring it back without telling the plugin. The SDK knows the devices once it has connected.
const devices = new Devices({
	log: scope("Devices"),
	repaint: () => {
		for (const keys of screens) keys.repaintInFull();
	},
	onLive: (connected) => {
		model.setDeckConnected(connected);
		slots.setDeckConnected(connected);
	},
});
const live = (): boolean => devices.live;
streamDeck.devices.onDeviceDidConnect((ev) => devices.connected(ev.device.id, ev.device.name));
streamDeck.devices.onDeviceDidDisconnect((ev) => devices.disconnected(ev.device.id, ev.device.name));

// The actions. Each logic class repaints its keys or strips when the model changes.
const keysLog = scope("Keys");
const approveKeys = new DecisionKeys(model, "allow", { log: keysLog, open: openSession, live });
const denyKeys = new DecisionKeys(model, "deny", { log: keysLog, open: openSession, live });
const promptKeys = new PromptKeys(model, { log: keysLog, live });
streamDeck.actions.registerAction(new ApproveKeyAction(approveKeys));
streamDeck.actions.registerAction(new DenyKeyAction(denyKeys));
streamDeck.actions.registerAction(new PromptKeyAction(promptKeys));

// The Session Slots (session-keys.md): which session each slot holds, saved in run/slots.json, shared by a slot's
// key and its dial; and the Other Sessions key for the running sessions on no slot.
const slotsLog = scope("Slots");
const slots = new Slots(model, { store: new SlotFile(path.join(pluginDir, RUN_DIR), { log: slotsLog }), log: slotsLog });
const slotKeys = new SlotKeys(slots, model, { art: slotKeyArt({ heldTool: heldToolOf(model) }), log: keysLog, open: openSession, live });
const slotDials = new SlotDials(slots, model, { render: slotStrip, log: scope("Dials"), open: openSession, live });
const othersKeys = new OthersKeys(slots, model, { art: othersArt, log: keysLog, open: openSession, live });
const actionsLog = scope("Actions");
streamDeck.actions.registerAction(new SessionSlotAction(new SlotActions(slotKeys, slotDials, { log: actionsLog })));
streamDeck.actions.registerAction(new OthersKeyAction(new OthersActions(othersKeys, { log: actionsLog })));

/** Every key and strip, which a device's connect repaints in full. */
const screens = [approveKeys, denyKeys, promptKeys, slotKeys, slotDials, othersKeys];

// A press anywhere on the deck, on any of this plugin's keys or dials: the user is there, so the front-app check for
// `seen` asks every second again (hardening.md, B5). And the press's device is connected, whatever the deck last heard.
const pressed = (device: { id: string; name: string }): void => {
	devices.pressed(device.id, device.name);
	model.userPresent();
};
streamDeck.actions.onKeyDown((ev) => pressed(ev.action.device));
streamDeck.actions.onDialDown((ev) => pressed(ev.action.device));
streamDeck.actions.onTouchTap((ev) => pressed(ev.action.device));

// After sleep: re-read everything at once, listen again if the bridge had stopped, and repaint the slots' keys, dials
// and Others, which times their next repaint afresh: the timers don't count the sleep. The user is likely back, so the
// front-app check asks every second again. The line says whether the Mac slept, or only its display (C4).
streamDeck.system.onSystemDidWakeUp(() => {
	log.info(wakeLine(devices.woke()));
	void registry.scanNow();
	void records.scanNow();
	bridge?.start();
	slots.refresh();
	model.userPresent();
});

// The Stream Deck app stops the plugin with SIGTERM. Say so, then drop held requests (their hooks get no
// decision, so the app's dialogs decide) and exit.
process.once("SIGTERM", () => {
	log.info(`SIGTERM: stopping, with ${model.held.size} request(s) held`);
	registry.stop();
	records.stop();
	devices.dispose();
	slots.dispose();
	model.dispose();
	const exit = (): never => process.exit(0);
	if (!bridge) exit();
	else {
		void bridge.stop().then(exit, exit);
		// Never hang on the way out.
		setTimeout(exit, 1000).unref();
	}
});

// The idle count (docs/claude-code/hardening.md, A1): at debug or trace, one IDLE line a minute with the CPU time,
// the event loop's use, the memory, and the counts of scans, spawns, emits, polls, sends and ticks since the last.
startIdleLog(scope("Idle"), { level: streamDeck.logger.level });

streamDeck.connect().then(
	() => devices.start(streamDeck.devices),
	(err: unknown) => log.error(`couldn't connect to the Stream Deck app: ${describeError(err)}`),
);
registry.start();
records.start();
bridge?.start();
