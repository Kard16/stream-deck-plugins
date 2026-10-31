import streamDeck from "@elgato/streamdeck";

import { DevelopDial } from "./actions/develop-dial";

// Debug level puts the spike's STARTUP, TICK and INPUT lines (logged at info) in
// com.karimdhanji.lightroom.sdPlugin/logs/com.karimdhanji.lightroom.0.log without the trace-level message dump.
streamDeck.logger.setLevel("debug");
streamDeck.logger.info(`STARTUP ${JSON.stringify({ pid: process.pid, node: process.version, t: Date.now() })}`);

streamDeck.actions.registerAction(new DevelopDial());

streamDeck.connect();
