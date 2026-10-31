#!/usr/bin/env node
// Smoke test of the built plugin (bin/plugin.js), outside the Stream Deck app:
//   mise exec -- npm run build && mise exec -- npm run smoke
//
// It copies the .sdPlugin folder to a temp directory (so the real plugin's logs are untouched), starts a fake
// Stream Deck app (the plugin WebSocket API) and a fake Lightroom (DeckBridge v1 on two TCP sockets), all on
// ephemeral ports, and runs the plugin process against them with DECKBRIDGE_CMD_PORT/DECKBRIDGE_EVT_PORT.
// scripts/smoke-guard.mjs makes any connection to 58780/58781 throw. Then it plays dial and key input through
// the SDK's events and checks what reaches Lightroom and the deck. Nothing here touches the Stream Deck app,
// Lightroom or the physical deck.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
	const lr = { received: [], invalid: [], cmdConns: [], evtConns: [], values: { ...VALUES }, flag: 0, photo: "101", watched: [], lastSet: null };
	const send = (obj) => {
		const evt = lr.evtConns.at(-1);
		if (evt && !evt.destroyed) evt.write(`${JSON.stringify(obj)}\n`);
	};
	const hello = () => ({ t: "hello", v: 1, lr: "15.3", catalog: "Plugin Test.lrcat", path: TEST_CATALOG, guard: "on", writable: true, inst: "smoke" });
	const state = () => ({ t: "state", module: "develop", photo: lr.photo, file: `DSC0${lr.photo}.ARW`, flag: lr.flag, rating: 0, label: "none", sel: 1 });
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
const plugin = path.join(tmp, `${UUID}.sdPlugin`);
cpSync(source, plugin, { recursive: true, filter: (src) => !src.includes(`${path.sep}logs`) });

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
const child = spawn(
	process.execPath,
	["--import", pathToFileURL(path.join(here, "smoke-guard.mjs")).href, path.join(plugin, "bin", "plugin.js"), "-port", String(sdPort), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
	{ cwd: plugin, env: { ...process.env, DECKBRIDGE_CMD_PORT: String(cmdPort), DECKBRIDGE_EVT_PORT: String(evtPort) }, stdio: ["ignore", "pipe", "pipe"] },
);
let childOutput = "";
child.stdout.on("data", (d) => (childOutput += d));
child.stderr.on("data", (d) => (childOutput += d));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));
// A hung run must never leave the plugin process or the temp folder behind.
const deadline = setTimeout(() => {
	console.error("smoke: gave up after 60 s");
	child.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
	process.exit(1);
}, 60_000);
deadline.unref();

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
	await waitFor("a turn sends set Exposure 0.38 with g", () => lrGot(lr, (c) => c.t === "set" && c.p === "Exposure" && c.v === 0.38 && Number.isInteger(c.g)));
	await waitFor("the strip follows the turn", () => strip("dial-2").value?.value === "+0.38");
	await waitFor("done follows 800 ms after the last tick", () => lrGot(lr, (c) => c.t === "done"), 2000);

	dialEvent("dialDown", 3);
	dialEvent("dialUp", 3);
	await waitFor("a press without turning resets Contrast", () => lrGot(lr, (c) => c.t === "reset" && c.p === "Contrast"));

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

	check("every command Lightroom received matches PROTOCOL.md", lr.invalid.length === 0, lr.invalid.join(" | "));
	check("no alerts in a session where everything succeeded", !fromPlugin.some((m) => m.event === "showAlert"));
	check("the plugin process is still running", exited === null, exited ? JSON.stringify(exited) : "");
} finally {
	child.kill("SIGTERM");
	await sleep(200);
	const logDir = path.join(plugin, "logs");
	const logs = existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n") : "";
	check("the plugin logged its startup and the connection going online", logs.includes("STARTUP") && logs.includes("offline → online"));
	if (checks.some((c) => !c.ok)) {
		console.log("\n--- plugin log ---\n" + logs.split("\n").slice(-60).join("\n"));
		if (childOutput) console.log("\n--- plugin stdout/stderr ---\n" + childOutput.slice(-4000));
	}
	wss.close();
	lr.cmdServer.close();
	lr.evtServer.close();
	for (const s of [...lr.cmdConns, ...lr.evtConns]) s.destroy();
	rmSync(tmp, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} smoke checks passed`);
process.exit(failed === 0 ? 0 : 1);
