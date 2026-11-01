#!/usr/bin/env node
// Smoke test of the built plugin (bin/plugin.js), outside the Stream Deck app:
//   mise exec -- npm run build && mise exec -- npm run smoke [-- --keep]
//
// It copies the .sdPlugin folder to a temp directory (so the real plugin's logs are untouched), starts a fake
// Stream Deck app (the plugin WebSocket API) and a fake Lightroom (DeckBridge v1 on two TCP sockets), all on
// ephemeral ports, and runs the plugin process against them with DECKBRIDGE_CMD_PORT/DECKBRIDGE_EVT_PORT.
// scripts/smoke-guard.mjs makes any connection to 58780/58781 throw. Then it plays dial and key input through
// the SDK's events and checks what reaches Lightroom and the deck. That run logs at the default level; a short
// second run, with log-level.txt saying debug, checks the dial's TICK and INPUT lines that
// spikes/s4-ticks/analyze.mjs reads. --keep keeps the temp folder with both runs' logs. Nothing here touches the
// Stream Deck app, Lightroom or the physical deck.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WebSocketServer } from "ws";

import { validateCommand } from "../src/lr/validate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "com.karimdhanji.lightroom.sdPlugin");
const UUID = "com.karimdhanji.lightroom";
const TEST_CATALOG = "/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat";
const RANGES = { Temperature: [2000, 50000], Tint: [-150, 150], Exposure: [-5, 5] };
const VALUES = { Temperature: 5500, Tint: 10, Exposure: 0.35, Contrast: 0, Highlights: -20, Shadows: 15 };
const PRESETS = [
	{ uuid: "P1", name: "Classic Chrome", folder: "Cobalt Fuji" },
	{ uuid: "P2", name: "Velvia", folder: "Cobalt Fuji" },
];

const checks = [];
const check = (name, ok, detail = "") => {
	checks.push({ name, ok });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, timeoutMs = 4000) {
	const start = Date.now();
	while (!test()) {
		if (Date.now() - start > timeoutMs) {
			check(what, false, `not within ${timeoutMs} ms`);
			return false;
		}
		await sleep(10);
	}
	check(what, true);
	return true;
}

// ---- fake Lightroom ----

function fakeLightroom() {
	const lr = { received: [], invalid: [], cmdConns: [], evtConns: [], values: { ...VALUES }, flag: 0, photo: "101", locked: false, watched: [], lastSet: null };
	const send = (obj) => {
		const evt = lr.evtConns.at(-1);
		if (evt && !evt.destroyed) evt.write(`${JSON.stringify(obj)}\n`);
	};
	const hello = () => ({ t: "hello", v: 1, lr: "15.3", catalog: "Plugin Test.lrcat", path: TEST_CATALOG, guard: "on", writable: true, inst: "smoke" });
	const state = () => ({ t: "state", module: "develop", photo: lr.photo, file: `DSC0${lr.photo}.ARW`, flag: lr.flag, rating: 0, label: "none", sel: 1, locked: lr.locked });
	/** A background AI process takes or releases the photo: state says so at once, as Lightroom's poll would. */
	lr.setLocked = (locked) => {
		lr.locked = locked;
		send(state());
	};
	const watched = () => {
		const ranges = {};
		const vals = {};
		for (const p of lr.watched) {
			ranges[p] = RANGES[p] ?? [-100, 100];
			vals[p] = lr.values[p] ?? 0;
		}
		return [
			{ t: "ranges", ranges },
			{ t: "vals", vals },
		];
	};
	const handle = (cmd) => {
		lr.received.push(cmd);
		const problems = validateCommand(cmd);
		if (problems.length > 0) lr.invalid.push(`${JSON.stringify(cmd)}: ${problems.join("; ")}`);
		switch (cmd.t) {
			case "hello":
				send(hello());
				send(state());
				if (lr.watched.length) watched().forEach(send);
				break;
			case "watch":
				lr.watched = cmd.ps;
				watched().forEach(send);
				break;
			case "ping":
				send({ t: "pong", id: cmd.id, lt: Date.now() / 1000 });
				break;
			case "set": {
				if (lr.locked) {
					send({ t: "err", id: cmd.id, cmd: "set", code: "locked", msg: "the photo is locked" });
					break;
				}
				const [min, max] = RANGES[cmd.p] ?? [-100, 100];
				lr.values[cmd.p] = Math.min(max, Math.max(min, cmd.v));
				lr.lastSet = cmd.p;
				send({ t: "ack", p: cmd.p, v: lr.values[cmd.p], g: cmd.g });
				break;
			}
			case "done":
				if (lr.lastSet) send({ t: "vals", vals: { [lr.lastSet]: lr.values[lr.lastSet] } });
				break;
			case "reset":
				if (lr.locked) {
					send({ t: "err", id: cmd.id, cmd: "reset", code: "locked", msg: "the photo is locked" });
					break;
				}
				lr.values[cmd.p] = 0;
				send({ t: "ack", p: cmd.p, v: 0 });
				break;
			case "flag":
				lr.flag = { pick: 1, reject: -1, none: 0 }[cmd.v];
				send(state());
				break;
			case "nav":
				lr.photo = cmd.v === "next" ? "102" : "101";
				send(state());
				watched().forEach(send);
				break;
			case "presets":
				send({ t: "presets", id: cmd.id, items: PRESETS });
				break;
			case "preset":
				send({ t: "applied", id: cmd.id, uuid: cmd.uuid, n: 1, locked: 0 });
				break;
			default:
				break;
		}
	};
	lr.evtServer = net.createServer((sock) => {
		sock.on("error", () => undefined);
		lr.evtConns.push(sock);
		send(hello());
		send(state());
		if (lr.watched.length) watched().forEach(send);
	});
	lr.cmdServer = net.createServer((sock) => {
		sock.on("error", () => undefined);
		lr.cmdConns.push(sock);
		let buffer = "";
		sock.on("data", (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				sock.write("ok\n"); // like LrSocket's receive mode
				handle(JSON.parse(line));
			}
		});
	});
	return lr;
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// ---- fake Stream Deck app ----

const fromPlugin = [];
let pluginSocket = null;
let wss = null;
function startApp() {
	return new Promise((resolve) => {
		wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => resolve(wss.address().port));
		wss.on("connection", (ws) => {
			pluginSocket = ws;
			ws.on("message", (data) => fromPlugin.push(JSON.parse(data.toString())));
		});
	});
}
const toPlugin = (msg) => pluginSocket.send(JSON.stringify(msg));
const DEVICE = "DECK";
const payload = (controller, column, settings, extra = {}) => ({
	controller,
	coordinates: { column, row: 0 },
	isInMultiAction: false,
	settings,
	resources: {},
	...extra,
});
const willAppear = (action, context, controller, column, settings = {}) =>
	toPlugin({ event: "willAppear", action: `${UUID}.${action}`, context, device: DEVICE, payload: payload(controller, column, settings) });
const dialEvent = (event, column, extra = {}) =>
	toPlugin({ event, action: `${UUID}.dial`, context: `dial-${column}`, device: DEVICE, payload: { ...payload("Encoder", column, {}), ...extra } });
const keyEvent = (event, action, context, column, settings = {}) =>
	toPlugin({ event, action: `${UUID}.${action}`, context, device: DEVICE, payload: payload("Keypad", column, settings, { state: 0 }) });

/** A dial's strip as the app would show it: every setFeedback merged, latest first. */
function strip(context) {
	const out = {};
	for (const m of fromPlugin) if (m.event === "setFeedback" && m.context === context) Object.assign(out, m.payload);
	return out;
}
function lastImage(context) {
	const m = fromPlugin.findLast((x) => x.event === "setImage" && x.context === context);
	return m ? Buffer.from(m.payload.image.split(",")[1], "base64").toString("utf8") : "";
}
const lrGot = (lr, pred) => lr.received.some(pred);

// ---- run ----

const bundle = path.join(source, "bin", "plugin.js");
if (!existsSync(bundle)) {
	console.error("bin/plugin.js is missing: run npm run build first");
	process.exit(2);
}
const tmp = mkdtempSync(path.join(os.tmpdir(), "deck-smoke-"));
const KEEP = process.argv.includes("--keep");

/**
 * A copy of the .sdPlugin folder, under tmp/<name>/ and named as the SDK expects, since it names the log after
 * the folder. A log-level.txt in the source isn't copied, so each run logs at the level it asks for.
 */
function copyPlugin(name, logLevel = null) {
	const dir = path.join(tmp, name, `${UUID}.sdPlugin`);
	cpSync(source, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}logs`) && path.basename(src) !== "log-level.txt" });
	if (logLevel) writeFileSync(path.join(dir, "log-level.txt"), `${logLevel}\n`);
	return dir;
}

const lr = fakeLightroom();
const cmdPort = await listen(lr.cmdServer);
const evtPort = await listen(lr.evtServer);
const sdPort = await startApp();
const info = {
	application: { font: ".AppleSystemUIFont", language: "en", platform: "mac", platformVersion: "26.0.0", version: "7.6.0.23012" },
	plugin: { uuid: UUID, version: "0.2.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [{ id: DEVICE, name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }],
};
const runs = [];
/** Starts the plugin in `dir` against the fake app and the fake Lightroom. */
function startPlugin(dir) {
	const run = { dir, output: "", exited: null };
	run.child = spawn(
		process.execPath,
		["--import", pathToFileURL(path.join(here, "smoke-guard.mjs")).href, path.join(dir, "bin", "plugin.js"), "-port", String(sdPort), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
		{ cwd: dir, env: { ...process.env, DECKBRIDGE_CMD_PORT: String(cmdPort), DECKBRIDGE_EVT_PORT: String(evtPort) }, stdio: ["ignore", "pipe", "pipe"] },
	);
	run.child.stdout.on("data", (d) => (run.output += d));
	run.child.stderr.on("data", (d) => (run.output += d));
	run.child.on("exit", (code, signal) => (run.exited = { code, signal }));
	runs.push(run);
	return run;
}
/** Stops a run and returns its log. */
async function stopPlugin(run) {
	if (run.exited === null) run.child.kill("SIGTERM");
	await sleep(200);
	const logDir = path.join(run.dir, "logs");
	run.log = existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n") : "";
	return run.log;
}
// A hung run must never leave a plugin process or the temp folder behind.
const deadline = setTimeout(() => {
	console.error("smoke: gave up after 60 s");
	for (const run of runs) run.child.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
	process.exit(1);
}, 60_000);
deadline.unref();

const alertsOn = (context) => fromPlugin.filter((m) => m.event === "showAlert" && m.context === context).length;
/** analyze.mjs's pattern for the lines it reads, and their records. */
const RECORD = /\b(TICK|INPUT|STARTUP) (\{.*\})\s*$/;
const records = (log) =>
	log.split("\n").flatMap((line) => {
		const m = RECORD.exec(line);
		if (!m) return [];
		try {
			return [{ kind: m[1], ...JSON.parse(m[2]) }];
		} catch {
			return [];
		}
	});

const main = startPlugin(copyPlugin("default"));
try {
	await waitFor("the plugin registers with the Stream Deck app", () => fromPlugin.some((m) => m.event === "registerPlugin" && m.uuid === UUID));
	await waitFor("the plugin connects to Lightroom's two sockets", () => lr.cmdConns.length === 1 && lr.evtConns.length === 1);
	await waitFor("it says hello and watches all 13 bank params", () => lrGot(lr, (c) => c.t === "hello" && c.v === 1) && lrGot(lr, (c) => c.t === "watch" && c.ps.length === 13));

	for (let c = 0; c < 4; c++) willAppear("dial", `dial-${c}`, "Encoder", c);
	willAppear("pick", "key-pick", "Keypad", 0);
	willAppear("before-after", "key-ba", "Keypad", 1);
	willAppear("preset", "key-preset", "Keypad", 2, { uuid: "P1", name: "Classic Chrome" });
	willAppear("next", "key-next", "Keypad", 3);

	await waitFor("the strips show bank 1 with live values", () =>
		["Temp", "Tint", "Exposure", "Contrast"].every((label, c) => strip(`dial-${c}`).label?.value === label) &&
		strip("dial-0").value?.value === "5500 K" &&
		strip("dial-2").value?.value === "+0.35" &&
		strip("dial-2").bank?.value === "1/4",
	);
	await waitFor("the keys get live images", () => lastImage("key-pick").includes("Pick") && lastImage("key-preset").includes("Classic"));

	dialEvent("dialRotate", 2, { ticks: 1, pressed: false });
	await waitFor("a turn sends set Exposure 0.38 with g, and ph for photo 101", () => lrGot(lr, (c) => c.t === "set" && c.p === "Exposure" && c.v === 0.38 && Number.isInteger(c.g) && c.ph === "101"));
	await waitFor("the strip follows the turn", () => strip("dial-2").value?.value === "+0.38");
	await waitFor("done follows 800 ms after the last tick", () => lrGot(lr, (c) => c.t === "done"), 2000);

	dialEvent("dialDown", 3);
	dialEvent("dialUp", 3);
	await waitFor("a press without turning resets Contrast, with ph for photo 101", () => lrGot(lr, (c) => c.t === "reset" && c.p === "Contrast" && c.ph === "101"));

	dialEvent("dialDown", 1);
	dialEvent("dialRotate", 1, { ticks: 4, pressed: true });
	dialEvent("dialUp", 1);
	await waitFor("push + turn is fine (Tint +1) and the release doesn't reset", () => lrGot(lr, (c) => c.t === "set" && c.p === "Tint" && c.v === 11) && !lrGot(lr, (c) => c.t === "reset" && c.p === "Tint"));

	dialEvent("touchTap", 0, { hold: false, tapPos: [100, 50] });
	await waitFor("a tap moves every dial to bank 2", () =>
		["Highlights", "Shadows", "Whites", "Blacks"].every((label, c) => strip(`dial-${c}`).label?.value === label && strip(`dial-${c}`).bank?.value === "2/4"),
	);

	keyEvent("keyDown", "pick", "key-pick", 0, {});
	await waitFor("Pick sends flag pick with advance on by default", () => lrGot(lr, (c) => c.t === "flag" && c.v === "pick" && c.advance === true));
	await waitFor("the Pick key lights up from Lightroom's state", () => lastImage("key-pick").includes("Picked"));

	keyEvent("keyDown", "before-after", "key-ba", 1);
	await waitFor("Before/After key down shows Before", () => lrGot(lr, (c) => c.t === "view" && c.v === "before") && lastImage("key-ba").includes(">Before<"));
	keyEvent("keyUp", "before-after", "key-ba", 1);
	await waitFor("Before/After key up returns to After", () => lrGot(lr, (c) => c.t === "view" && c.v === "after") && lastImage("key-ba").includes("Before/After"));

	toPlugin({ event: "propertyInspectorDidAppear", action: `${UUID}.preset`, context: "key-preset", device: DEVICE });
	await sleep(50);
	toPlugin({ event: "sendToPlugin", action: `${UUID}.preset`, context: "key-preset", payload: { t: "getPresets", refresh: true } });
	await waitFor("the preset Property Inspector gets Lightroom's presets", () =>
		fromPlugin.some((m) => m.event === "sendToPropertyInspector" && m.context === "key-preset" && m.payload?.items?.length === 2),
	);

	keyEvent("keyDown", "preset", "key-preset", 2, { uuid: "P1", name: "Classic Chrome" });
	await waitFor("Apply Preset sends preset and shows ok when applied", () =>
		lrGot(lr, (c) => c.t === "preset" && c.uuid === "P1" && Number.isInteger(c.id)) && fromPlugin.some((m) => m.event === "showOk" && m.context === "key-preset"),
	);

	toPlugin({ event: "didReceiveSettings", action: `${UUID}.preset`, context: "key-preset", device: DEVICE, payload: payload("Keypad", 2, { uuid: "P2", name: "Velvia" }) });
	await waitFor("choosing another preset in the Property Inspector renames the key", () => lastImage("key-preset").includes("Velvia"));

	keyEvent("keyDown", "next", "key-next", 3);
	await waitFor("Next sends nav next", () => lrGot(lr, (c) => c.t === "nav" && c.v === "next"));

	lr.evtConns.at(-1).destroy();
	await waitFor("the strips say Offline when Lightroom goes away", () => strip("dial-0").value?.value === "Offline");
	await waitFor("losing the event socket makes the plugin close the command socket and reconnect both", () => lr.cmdConns.length === 2 && lr.evtConns.length === 2 && lr.cmdConns[0].destroyed, 4000);
	await waitFor("the strips come back online", () => strip("dial-0").value?.value === "-20");

	// A background AI process locks photo 102 (PROTOCOL.md, Locked photos).
	lr.setLocked(true);
	await waitFor("while the photo is locked every strip says Locked", () => [0, 1, 2, 3].every((c) => strip(`dial-${c}`).value?.value === "Locked"));
	const lockedFrom = lr.received.length;
	dialEvent("dialRotate", 1, { ticks: 1, pressed: false });
	dialEvent("dialDown", 2);
	dialEvent("dialUp", 2);
	dialEvent("touchTap", 0, { hold: false, tapPos: [100, 50] });
	await waitFor("a tap still moves every dial to the next bank, still Locked", () => strip("dial-0").label?.value === "Texture" && strip("dial-0").bank?.value === "3/4" && strip("dial-0").value?.value === "Locked");
	await waitFor("the dials turned and pressed while locked alert", () => alertsOn("dial-1") === 1 && alertsOn("dial-2") === 1);
	await sleep(300);
	const whileLocked = lr.received.slice(lockedFrom).filter((c) => c.t !== "ping");
	check("they send Lightroom nothing: no set, reset or module", whileLocked.length === 0, JSON.stringify(whileLocked));
	lr.setLocked(false);
	await waitFor("when the lock ends the strips show values again", () => [0, 1, 2, 3].every((c) => strip(`dial-${c}`).value?.value === "0"));

	check("every command Lightroom received matches PROTOCOL.md", lr.invalid.length === 0, lr.invalid.join(" | "));
	const alerts = fromPlugin.filter((m) => m.event === "showAlert").map((m) => m.context);
	check("the only alerts were the two dials used while the photo was locked", JSON.stringify(alerts.sort()) === JSON.stringify(["dial-1", "dial-2"]), JSON.stringify(alerts));
	check("the plugin process is still running", main.exited === null, main.exited ? JSON.stringify(main.exited) : "");

	const log = await stopPlugin(main);
	check("the plugin logged its startup, at the default level info, and the connection going online", records(log).some((r) => r.kind === "STARTUP" && r.log === "info") && log.includes("offline → online"));
	const below = log.split("\n").filter((l) => / (DEBUG|TRACE) /.test(l) || (RECORD.test(l) && !l.includes("STARTUP")));
	check("normal use logs nothing below info: no TICK or INPUT lines, no bank changes", below.length === 0, `${below.length} lines, first ${JSON.stringify(below[0] ?? "")}`);

	// The dial's instrumentation, with log-level.txt saying debug.
	const fromIndex = fromPlugin.length;
	const raised = startPlugin(copyPlugin("debug", "debug"));
	await waitFor("with log-level.txt saying debug, a second run registers", () => fromPlugin.slice(fromIndex).some((m) => m.event === "registerPlugin" && m.uuid === UUID));
	willAppear("dial", "dial-2", "Encoder", 2);
	await sleep(100);
	dialEvent("dialRotate", 2, { ticks: 2, pressed: false });
	dialEvent("dialDown", 2);
	dialEvent("dialUp", 2);
	dialEvent("touchTap", 2, { hold: true, tapPos: [40, 60] });
	await sleep(300);
	const raisedRecords = records(await stopPlugin(raised));
	const numbers = (r) => typeof r.t === "number" && typeof r.hr === "number" && r.col === 2;
	check("its STARTUP says debug", raisedRecords.some((r) => r.kind === "STARTUP" && r.log === "debug"));
	check(
		"TICK lines have analyze.mjs's format",
		raisedRecords.some((r) => r.kind === "TICK" && numbers(r) && r.ticks === 2 && r.pressed === false && typeof r.result === "string"),
		JSON.stringify(raisedRecords.filter((r) => r.kind === "TICK")),
	);
	check(
		"and so do INPUT lines",
		["dialDown", "dialUp", "touchTap"].every((ev) => raisedRecords.some((r) => r.kind === "INPUT" && r.ev === ev && numbers(r))) &&
			raisedRecords.some((r) => r.ev === "touchTap" && r.hold === true && JSON.stringify(r.tapPos) === "[40,60]"),
		JSON.stringify(raisedRecords.filter((r) => r.kind === "INPUT")),
	);
} finally {
	for (const run of runs) if (run.log === undefined) await stopPlugin(run);
	if (checks.some((c) => !c.ok)) {
		for (const run of runs) {
			console.log(`\n--- plugin log (${path.basename(path.dirname(run.dir))} run) ---\n${run.log.split("\n").slice(-60).join("\n")}`);
			if (run.output) console.log(`\n--- plugin stdout/stderr ---\n${run.output.slice(-4000)}`);
		}
	}
	wss.close();
	lr.cmdServer.close();
	lr.evtServer.close();
	for (const s of [...lr.cmdConns, ...lr.evtConns]) s.destroy();
	if (KEEP) console.log(`\nkept ${tmp}`);
	else rmSync(tmp, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} smoke checks passed`);
process.exit(failed === 0 ? 0 : 1);
