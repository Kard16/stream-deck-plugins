import path from "node:path";
import { fileURLToPath } from "node:url";

import streamDeck from "@elgato/streamdeck";

import { ApplyPresetKey } from "./actions/apply-preset.js";
import { DevelopDial } from "./actions/develop-dial.js";
import { PickKey, RejectKey, UnflagKey } from "./actions/flag-keys.js";
import type { ActionContext } from "./actions/shared.js";
import { BeforeAfterKey, NextKey, PrevKey } from "./actions/view-keys.js";
import { loadBanksFile, watchList } from "./banks.js";
import { DialDeck } from "./dial/deck.js";
import { LrClient } from "./lr/client.js";
import { portsFromEnv } from "./lr/ports.js";
import { LrModel } from "./model/model.js";

// Debug level keeps the dial's TICK and INPUT lines (for spikes/s4-ticks/analyze.mjs) and connection details
// in com.karimdhanji.lightroom.sdPlugin/logs/com.karimdhanji.lightroom.0.log. Per-line traffic is at trace.
streamDeck.logger.setLevel("debug");
const log = streamDeck.logger.createScope("Lightroom");
log.info(`STARTUP ${JSON.stringify({ pid: process.pid, node: process.version, t: Date.now(), version: streamDeck.info.plugin.version })}`);

// bin/plugin.js → the .sdPlugin folder, which holds the user's banks.json.
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const banks = loadBanksFile(path.join(pluginDir, "banks.json"));
for (const warning of banks.warnings) log.warn(warning);
const watch = watchList(banks.config);
log.info(`${banks.config.banks.length} banks; watching ${watch.join(", ")}`);

const client = new LrClient({
	...portsFromEnv(process.env),
	client: "deck",
	ver: streamDeck.info.plugin.version,
	watch,
	log: streamDeck.logger.createScope("LrClient"),
});
const model = new LrModel(client, { log: streamDeck.logger.createScope("Model") });
const deck = new DialDeck(banks.config, model, { log: streamDeck.logger.createScope("Dials") });
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
