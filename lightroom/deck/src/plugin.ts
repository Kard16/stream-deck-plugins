import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck from "@elgato/streamdeck";

import { ApplyPresetKey } from "./actions/apply-preset.js";
import { DevelopDial } from "./actions/develop-dial.js";
import { PickKey, RejectKey, UnflagKey } from "./actions/flag-keys.js";
import type { ActionContext } from "./actions/shared.js";
import { BeforeAfterKey, NextKey, PrevKey } from "./actions/view-keys.js";
import { DialDeck } from "./dial/deck.js";
import { LrClient } from "./lr/client.js";
import { portsFromEnv } from "./lr/ports.js";
import { LrModel } from "./model/model.js";
import { loadSlidersFile, watchList } from "./sliders.js";
import { loadLogLevelFile, LOG_LEVEL_FILE } from "./util/log-level.js";

// bin/plugin.js → the .sdPlugin folder, which holds the user's sliders.json and the optional log-level.txt.
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The log is com.karimdhanji.lightroom.sdPlugin/logs/com.karimdhanji.lightroom.0.log, at info unless
// log-level.txt says otherwise. "debug" adds the dial's TICK and INPUT lines (for spikes/s4-ticks/analyze.mjs),
// big steps going on and off, the ranges Lightroom reports, and stale refusals. "trace" adds every line to and
// from Lightroom, but the SDK allows it only under a debugger (--inspect) and otherwise drops to info, so it
// falls back to debug here.
const logLevel = loadLogLevelFile(path.join(pluginDir, LOG_LEVEL_FILE));
streamDeck.logger.setLevel(logLevel.level);
const traceRefused = streamDeck.logger.level !== logLevel.level;
if (traceRefused) streamDeck.logger.setLevel("debug");
const log = streamDeck.logger.createScope("Lightroom");
log.info(`STARTUP ${JSON.stringify({ pid: process.pid, node: process.version, t: Date.now(), version: streamDeck.info.plugin.version, log: streamDeck.logger.level })}`);
if (logLevel.warning) log.warn(logLevel.warning);
if (traceRefused) log.info(`${LOG_LEVEL_FILE} asks for ${logLevel.level}, which needs a debugger (--inspect); logging at debug`);

const sliders = loadSlidersFile(path.join(pluginDir, "sliders.json"));
for (const warning of sliders.warnings) log.warn(warning);
const watch = watchList(sliders.config);
log.info(`${watch.length} sliders, big steps off after ${sliders.config.macroSeconds} s; watching ${watch.join(", ")}`);

const client = new LrClient({
	...portsFromEnv(process.env),
	client: "deck",
	ver: streamDeck.info.plugin.version,
	watch,
	log: streamDeck.logger.createScope("LrClient"),
});
const model = new LrModel(client, { log: streamDeck.logger.createScope("Model") });
const deck = new DialDeck(sliders.config, model, { log: streamDeck.logger.createScope("Dials") });
const ctx: ActionContext = { model, link: client, log };

streamDeck.actions.registerAction(new DevelopDial(deck));
streamDeck.actions.registerAction(new PickKey(ctx));
streamDeck.actions.registerAction(new RejectKey(ctx));
streamDeck.actions.registerAction(new UnflagKey(ctx));
streamDeck.actions.registerAction(new NextKey(ctx));
streamDeck.actions.registerAction(new PrevKey(ctx));
streamDeck.actions.registerAction(new BeforeAfterKey(ctx));
streamDeck.actions.registerAction(new ApplyPresetKey(ctx));

// Sockets can be half-dead after sleep, and macOS can refuse localhost for a while after waking: start over.
streamDeck.system.onSystemDidWakeUp(() => client.reconnectNow("the Mac woke up"));

streamDeck.connect().catch((err: unknown) => log.error(`couldn't connect to the Stream Deck app: ${String(err)}`));
client.start();
