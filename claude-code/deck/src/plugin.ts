import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck from "@elgato/streamdeck";

import { ApproveKeyAction } from "./actions/approve-key.js";
import { SessionsDialAction } from "./actions/sessions-dial.js";
import { BRIDGE_HOST, BRIDGE_PORT, RUN_DIR, TOKEN_FILE } from "./bridge/config.js";
import { HeldQueue } from "./bridge/held.js";
import { BridgeServer } from "./bridge/server.js";
import { type LoadedToken, loadOrCreateToken } from "./bridge/token.js";
import { ApproveKeys } from "./keys/approve.js";
import { RegistryReader } from "./registry/registry.js";
import { RegistryWatcher } from "./registry/watcher.js";
import { SessionsDials } from "./sessions/dials.js";
import { loadLogLevelFile, LOG_LEVEL_FILE } from "./util/log-level.js";
import { describeError, type Log, redacting } from "./util/log.js";

// bin/plugin.js → the .sdPlugin folder, which holds run/token and the optional log-level.txt.
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const scope = (name: string): Log => redacting(streamDeck.logger.createScope(name), loaded?.token ?? "");

// The Sessions dial, fed from the live registry, one file per running session. The .key files are never read.
const registryLog = scope("Registry");
const registry = new RegistryWatcher(new RegistryReader(path.join(os.homedir(), ".claude", "sessions"), { log: registryLog }), { log: registryLog });
// A jump opens the app's own link for the session (spike S5): it focuses the main window and shows that session.
// openUrl can't open custom schemes, so it goes through /usr/bin/open.
const sessionsLog = scope("Sessions");
const openSession = (hostSessionId: string): void => {
	const url = `claude://code/continue?session=${encodeURIComponent(hostSessionId)}`;
	const started = Date.now();
	execFile("/usr/bin/open", [url], (err) => {
		if (err) sessionsLog.warn(`open ${url} failed: ${describeError(err)}`);
		else sessionsLog.info(`opened ${url} in ${Date.now() - started} ms`);
	});
};
const dials = new SessionsDials({ log: sessionsLog, open: openSession });
registry.onChange((sessions) => dials.setSessions(sessions));

// The bridge on 127.0.0.1:47601 and the Approve key.
const queue = new HeldQueue();
const keys = new ApproveKeys(queue, { log: scope("Approve") });
const bridge = loaded ? new BridgeServer({ port: BRIDGE_PORT, host: BRIDGE_HOST, token: loaded.token, queue, log: scope("Bridge") }) : null;
bridge?.onState((state) => keys.setBridgeState(state));

streamDeck.actions.registerAction(new SessionsDialAction(dials));
streamDeck.actions.registerAction(new ApproveKeyAction(keys));

// After sleep: re-read the registry at once, and listen again if the bridge had stopped.
streamDeck.system.onSystemDidWakeUp(() => {
	void registry.scanNow();
	bridge?.start();
});

streamDeck.connect().catch((err: unknown) => log.error(`couldn't connect to the Stream Deck app: ${describeError(err)}`));
registry.start();
bridge?.start();
