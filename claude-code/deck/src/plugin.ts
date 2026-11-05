import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck from "@elgato/streamdeck";

import { ApproveKeyAction, DenyKeyAction } from "./actions/decision-keys.js";
import { ModeDialAction } from "./actions/mode-dial.js";
import { ModeKeyAction } from "./actions/mode-key.js";
import { OthersKeyAction } from "./actions/others.js";
import { PromptKeyAction } from "./actions/prompt-key.js";
import { SessionKeyAction } from "./actions/session-key.js";
import { SessionsDialAction } from "./actions/sessions-dial.js";
import { SessionSlotAction } from "./actions/slot.js";
import { BRIDGE_HOST, BRIDGE_PORT, RUN_DIR, TOKEN_FILE } from "./bridge/config.js";
import { BridgeServer } from "./bridge/server.js";
import { type LoadedToken, loadOrCreateToken } from "./bridge/token.js";
import { ModeKeys, PromptKeys } from "./keys/commands.js";
import { DecisionKeys } from "./keys/decision.js";
import { SessionKeys } from "./keys/session.js";
import { lsappinfoCheck } from "./model/front.js";
import { connectSources } from "./model/sources.js";
import { ModeDials } from "./mode/dials.js";
import { SessionsDials } from "./sessions/dials.js";
import { heldToolOf, othersArt, slotKeyArt } from "./slots/art.js";
import { SlotDials } from "./slots/dials.js";
import { SlotKeys } from "./slots/keys.js";
import { OthersKeys } from "./slots/others.js";
import { OthersActions, SlotActions } from "./slots/sdk.js";
import { Slots } from "./slots/slots.js";
import { SlotFile } from "./slots/store.js";
import { slotStrip } from "./slots/strip.js";
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

// The session model: the registry, the app's records and the bridge, merged by the app's local_ id. A hook's request
// or a hello that the latest reading doesn't confirm has the registry read once more at once, not at the next scan.
// The wiring is connectSources's, which the tests run too. For `seen`, it asks /usr/bin/lsappinfo whether Claude is
// the app in front, once a second, and only while a session whose turn ended unseen is on screen in the app and a
// Session Slot or Other Sessions key is on the deck (SessionModel.showsSeen).
const { registry, records, model } = connectSources({
	registryDir: REGISTRY_DIR,
	recordsDir: RECORDS_DIR,
	logs: { registry: scope("Registry"), records: scope("Records"), sessions: scope("Sessions") },
	model: { front: lsappinfoCheck({ log: scope("Front") }) },
});

// The bridge on 127.0.0.1:47600.
const bridge = loaded ? new BridgeServer({ port: BRIDGE_PORT, host: BRIDGE_HOST, token: loaded.token, routes: model, log: scope("Bridge") }) : null;
bridge?.onState((state) => model.setBridgeState(state));

// The actions. Each logic class repaints its keys or strips when the model changes.
const keysLog = scope("Keys");
const dialsLog = scope("Dials");
streamDeck.actions.registerAction(new SessionsDialAction(new SessionsDials(model, { log: dialsLog, open: openSession })));
streamDeck.actions.registerAction(new ModeDialAction(new ModeDials(model, { log: dialsLog })));
streamDeck.actions.registerAction(new ApproveKeyAction(new DecisionKeys(model, "allow", { log: keysLog, open: openSession })));
streamDeck.actions.registerAction(new DenyKeyAction(new DecisionKeys(model, "deny", { log: keysLog, open: openSession })));
streamDeck.actions.registerAction(new PromptKeyAction(new PromptKeys(model, { log: keysLog })));
streamDeck.actions.registerAction(new ModeKeyAction(new ModeKeys(model, { log: keysLog })));
streamDeck.actions.registerAction(new SessionKeyAction(new SessionKeys(model, { log: keysLog, open: openSession })));

// The Session Slots (session-keys.md): which session each slot holds, saved in run/slots.json, shared by a slot's
// key and its dial; and the Other Sessions key for the running sessions on no slot.
const slotsLog = scope("Slots");
const slots = new Slots(model, { store: new SlotFile(path.join(pluginDir, RUN_DIR), { log: slotsLog }), log: slotsLog });
const slotKeys = new SlotKeys(slots, model, { art: slotKeyArt({ heldTool: heldToolOf(model) }), log: keysLog, open: openSession });
const slotDials = new SlotDials(slots, model, { render: slotStrip, log: dialsLog, open: openSession });
const othersKeys = new OthersKeys(slots, model, { art: othersArt, log: keysLog, open: openSession });
const actionsLog = scope("Actions");
streamDeck.actions.registerAction(new SessionSlotAction(new SlotActions(slotKeys, slotDials, { log: actionsLog })));
streamDeck.actions.registerAction(new OthersKeyAction(new OthersActions(othersKeys, { log: actionsLog })));

// After sleep: re-read everything at once, and listen again if the bridge had stopped.
streamDeck.system.onSystemDidWakeUp(() => {
	log.info("woke up: rescanning");
	void registry.scanNow();
	void records.scanNow();
	bridge?.start();
});

// The Stream Deck app stops the plugin with SIGTERM. Say so, then drop held requests (their hooks get no
// decision, so the app's dialogs decide) and exit.
process.once("SIGTERM", () => {
	log.info(`SIGTERM: stopping, with ${model.held.size} request(s) held`);
	registry.stop();
	records.stop();
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

streamDeck.connect().catch((err: unknown) => log.error(`couldn't connect to the Stream Deck app: ${describeError(err)}`));
registry.start();
records.start();
bridge?.start();
