#!/usr/bin/env node
// Verification ladder step 5 (docs/lightroom/plan.md): the real Stream Deck plugin bundle against the mock
// Lightroom. Tracks B and C built them independently from lightroom/protocol/PROTOCOL.md, so the point is to
// find where they disagree.
//
//   mise exec -- node lightroom/tools/integration/deck-vs-mock.mjs [--keep] [--plugin <.sdPlugin folder>]
//
// - The plugin: lightroom/deck/com.karimdhanji.lightroom.sdPlugin is copied to a temp folder, so the real
//   plugin's logs stay untouched, and its bin/plugin.js runs there with lightroom/deck/scripts/smoke-guard.mjs
//   preloaded: any connection to 58780/58781 throws. Build it first (npm run build in lightroom/deck). The copy
//   gets a log-level.txt saying debug, so the log checks see the plugin's debug lines as well. --plugin runs
//   another copy of the .sdPlugin folder instead, such as one with a patched bin/plugin.js for a negative control.
// - The Stream Deck app: a fake one speaking the plugin's SDK WebSocket protocol, after scripts/smoke.mjs. It
//   needs ws from lightroom/deck/node_modules.
// - Lightroom: startMock on ephemeral ports and the real clock, given to the plugin as DECKBRIDGE_CMD_PORT and
//   DECKBRIDGE_EVT_PORT.
//
// Each dial shows the slider its settings name, from the deck's sliders.json, and the fake app keeps those
// settings: what the plugin saves with setSettings, and what a dial's Property Inspector chooses. Stream Deck
// pages are willDisappear for one set of dials and willAppear for another (plan.md, Phase 7).
//
// Steps 1-8 are a session in which everything succeeds, with Phase 7's big steps, pages, Property Inspector and
// a slider sliders.json doesn't list in steps 3-3e, and big steps outside Develop in step 7. Steps 9-16 are
// Phase 6's: the ph race, locked photos, read-only mode, a version mismatch, two dials at once, clamping, presets
// that change sliders, and held ticks dropped after 2 s, with big steps where Phase 7 says how they behave. Step
// 17 checks rules over the whole session, allowing only the alerts and errs those steps expect, and step 18 runs
// a second copy of the plugin at the default log level, for quiet logs. The script exits 2 if sliders.json's big
// steps aren't plan.md's, since the checks' names state them. The checks look
// at the mock's state (values, flags, target, view, history) and at what the plugin sends the app (strip
// feedback, key images, alerts, settings, Property Inspector answers). It prints one ok/FAIL line per check and,
// on a failure, the tail of the plugin's log. It exits 0 when every check passes, 1 when one fails, and 2 when it
// can't start. --keep keeps the temp folder, with the plugin's logs and conversation.jsonl (every command, event
// and app message, in order). Nothing here touches Lightroom, the Stream Deck app or the deck.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadScenario, startMock } from '../mock-lr/index.mjs';
import { defaultRange, SLIDER_PARAMS, TEST_CATALOG } from '../lib/params.mjs';
import { validateCommand } from '../../deck/src/lr/validate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DECK = path.resolve(here, '..', '..', 'deck');
const UUID = 'com.karimdhanji.lightroom';
const pluginArg = process.argv.indexOf('--plugin');
const SOURCE = pluginArg > 0 ? path.resolve(process.argv[pluginArg + 1] ?? '') : path.join(DECK, `${UUID}.sdPlugin`);
const BUNDLE = path.join(SOURCE, 'bin', 'plugin.js');
const GUARD = path.join(DECK, 'scripts', 'smoke-guard.mjs');
// DeckBridge's ports, and MIDI2LR's and lightroom-mcp's: nothing here may bind or reach them.
const FORBIDDEN = new Set([58780, 58781, 58763, 58764]);
const KEEP = process.argv.includes('--keep');

function fatal(message) {
  console.error(`deck-vs-mock: ${message}`);
  process.exit(2);
}

if (!existsSync(BUNDLE)) fatal(`${BUNDLE} is missing: build the plugin first (npm run build in lightroom/deck)`);
let WebSocketServer;
try {
  ({ WebSocketServer } = createRequire(path.join(DECK, 'package.json'))('ws'));
} catch (err) {
  fatal(`can't load ws from lightroom/deck/node_modules (${err.message}): run npm install in lightroom/deck`);
}

// ---- sliders.json: what the strips should show ----

const SLIDERS_FILE = JSON.parse(readFileSync(path.join(SOURCE, 'sliders.json'), 'utf8'));
const SLIDERS = Array.isArray(SLIDERS_FILE.sliders) ? SLIDERS_FILE.sliders : [];
const WATCH = SLIDERS.map((s) => s.param); // the deck watches every slider, in the file's order
const sliderOf = (param) => SLIDERS.find((s) => s.param === param) ?? null;
// What a dial placed without settings shows, by column: bank 1 of the old banks (plan.md, Phase 7).
const DEFAULTS = ['Temperature', 'Tint', 'Exposure', 'Contrast'];
const TEMP = 0;
const TINT = 1;
const EXPOSURE = 2;
const CONTRAST = 3;
// The ranges plan.md gives the newer sliders, the same on every file type. They fill from the left, but Dehaze.
const NEW_RANGES = { Sharpness: [0, 150], LuminanceSmoothing: [0, 100], GrainAmount: [0, 100], Dehaze: [-100, 100] };
if (WATCH.length !== 17 || [...DEFAULTS, ...Object.keys(NEW_RANGES)].some((p) => !sliderOf(p)) || !sliderOf('Temperature').kelvin) {
  fatal('sliders.json no longer has the 17 sliders of plan.md, Phase 7 (with Temperature, Tint, Exposure, Contrast, Dehaze, Sharpness, LuminanceSmoothing and GrainAmount, and a kelvin variant for Temperature): update this script');
}
const amount = (v) => (typeof v === 'number' ? v : Number(String(v).split('/')[0]) / Number(String(v).split('/')[1]));
// A slider variant's units per tick, as the deck reads sliders.json: fine defaults to a quarter step, and macro
// (big steps) to ten steps.
function variantSteps(v) {
  const step = amount(v.step);
  return { step, fine: v.fine === undefined ? step / 4 : amount(v.fine), macro: v.macro === undefined ? step * 10 : amount(v.macro) };
}
// A slider's steps for a range: its kelvin variant's for a Kelvin range.
const steps = (slider, range) => variantSteps(range[0] >= 1000 && slider.kelvin ? slider.kelvin : slider);
const { step: STEP, fine: FINE, macro: MACRO } = steps(sliderOf('Exposure'), [-5, 5]); // EV per tick, push + turn tick and big step
const { step: CONTRAST_STEP, macro: CONTRAST_MACRO } = steps(sliderOf('Contrast'), [-100, 100]);
const KELVIN = steps(sliderOf('Temperature'), [2000, 50000]); // Temperature on raw files
const { step: TINT_STEP, macro: TINT_MACRO } = steps(sliderOf('Tint'), [-150, 150]);
const ACCEL = SLIDERS_FILE.acceleration ?? 0.5;
const MACRO_MS = (SLIDERS_FILE.macroSeconds ?? 2) * 1000; // big steps go off after this long without a turn
// The checks work their numbers out from sliders.json, but their names state plan.md's (Phase 7): big steps of
// 1/3 EV, 10 points and 500 K, each ten normal steps so that every strip says ×10, and off after 2 s. Without
// this, a shipped file with other big steps would pass under those names. The deck's own test/sliders.test.ts
// holds the file to the plan as well.
{
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  const n = (x) => Number(x.toFixed(4));
  const plan = [
    ['Exposure', STEP, MACRO, 1 / 30, 1 / 3, '1/30 and 1/3 EV'],
    ['Contrast', CONTRAST_STEP, CONTRAST_MACRO, 1, 10, '1 and 10'],
    ['Tint', TINT_STEP, TINT_MACRO, 1, 10, '1 and 10'],
    ['Temperature on raw files', KELVIN.step, KELVIN.macro, 50, 500, '50 and 500 K'],
  ];
  const variants = SLIDERS.flatMap((s) => [[s.param, s], ...(s.kelvin ? [[`${s.param}'s kelvin variant`, s.kelvin]] : [])]);
  const off = [
    ...plan.filter(([, step, macro, s, m]) => !eq(step, s) || !eq(macro, m)).map(([name, step, macro, , , want]) => `${name} has step ${n(step)} and big step ${n(macro)}, not ${want}`),
    ...variants.filter(([, v]) => !eq(variantSteps(v).macro, 10 * variantSteps(v).step)).map(([name]) => `${name}'s big step isn't ten steps`),
    ...(eq(MACRO_MS, 2000) ? [] : [`macroSeconds is ${MACRO_MS / 1000}, not 2`]),
  ];
  if (off.length > 0) fatal(`sliders.json's big steps are no longer plan.md's (Phase 7), which the checks' names state: ${off.join('; ')}. Update this script`);
}
const accelerate = (ticks) => ticks * (1 + ACCEL * (Math.abs(ticks) - 1));
const round2 = (v) => Math.round(v * 100) / 100;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The strip's value text for a slider, by sliders.json's display fields: the Kelvin variant for a Kelvin range.
function display(slider, v, range) {
  const k = range[0] >= 1000 && slider.kelvin ? slider.kelvin : null;
  const precision = (k ?? slider).precision ?? 0;
  const unit = (k ?? slider).unit ?? (k ? 'K' : '');
  const signed = (k ?? slider).signed ?? !k;
  const f = 10 ** precision;
  const r = (Math.sign(v) * Math.round(Math.abs(v) * f)) / f || 0; // halves away from zero, never -0
  return `${r < 0 ? '-' : signed && r > 0 ? '+' : ''}${Math.abs(r).toFixed(precision)}${unit ? ` ${unit}` : ''}`;
}
// The strip's mode text with big steps on: a big step in normal steps, for the variant in force.
function bigText(slider, range) {
  const m = steps(slider, range);
  return `×${Math.round((m.macro / m.step) * 10) / 10}`;
}

// The strip's colours that plan.md, Phase 7 names: big steps' green, and the status words' amber
// (STRIP_COLORS in lightroom/deck/src/dial/strip.ts). The others are learnt in step 1.
const GREEN = '#3DDC84';
const STATUS = '#E0A43A';
const NOT_LISTED = 'Not listed';

// Stream Deck pages of four dials, as lightroom/README.md suggests: page 1 holds the dials placed without
// settings, and pages 2-5 the other 13 sliders. Page 5 also has a dial whose settings name a Develop param
// sliders.json doesn't list, and two dials showing Exposure.
const UNLISTED = 'SharpenRadius';
const PAGES = [
  DEFAULTS,
  ['Highlights', 'Shadows', 'Whites', 'Blacks'],
  ['Texture', 'Clarity', 'Vibrance', 'Saturation'],
  ['PostCropVignetteAmount', 'Dehaze', 'Sharpness', 'LuminanceSmoothing'],
  ['GrainAmount', UNLISTED, 'Exposure', 'Exposure'],
];
if (sliderOf(UNLISTED) || WATCH.some((p) => !PAGES.flat().includes(p))) fatal(`the pages no longer cover every slider in sliders.json, or it now lists ${UNLISTED}: update PAGES`);

const SCENARIO = loadScenario(); // the mock's default scenario
const PRESET = SCENARIO.presets[0]; // Cobalt Classic Chrome, profile-only
// The two presets that change sliders, for step 15.
const PUNCHY = SCENARIO.presets.find((p) => p.name === 'Punchy');
const SOFT = SCENARIO.presets.find((p) => p.name === 'Soft Matte');
if (PUNCHY?.values?.Contrast === undefined || SOFT?.values?.Contrast === undefined) {
  fatal("the mock's default scenario no longer has the Punchy and Soft Matte presets, which set Contrast: update this script");
}
// Any catalog but the test catalog: the guard refuses writes there (step 11). The mock opens no files.
const OTHER_CATALOG = '/Users/karimdhanji/Pictures/Another Catalog/Another Catalog.lrcat';

// ---- checks ----

const now = () => performance.now();
const WALL0 = Date.now() - now(); // log lines carry wall-clock times: now() = Date.now() - WALL0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runs = []; // every plugin process started: { dir, child, output, exited }
let running = null; // the one the checks are about: once it has exited, every check fails at once
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  return !!ok;
}
async function until(test, timeoutMs) {
  const end = now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = test();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (now() >= end || running?.exited) return false; // a dead plugin fails every check at once
    await sleep(10);
  }
}
// A check that waits for its condition. `why` explains a failure.
async function waitFor(name, test, timeoutMs = 4000, why = null) {
  const ok = await until(test, timeoutMs);
  let detail = '';
  if (!ok) {
    detail = running?.exited ? `the plugin exited: ${JSON.stringify(running.exited)}` : `not within ${timeoutMs} ms`;
    try {
      if (why) detail += `; ${why()}`;
    } catch (err) {
      detail += `; ${err.message}`;
    }
  }
  return check(name, ok, detail);
}
const section = (title) => console.log(`\n-- ${title}`);

// ---- the mock Lightroom, watched ----

const received = []; // every line the mock took from its cmd socket: { at, gen, conn, line, cmd }
const sent = []; // every event it wrote: { at, gen, obj, target (the target photo then) }
const lost = []; // events that vanished into a stale or dead event socket
const mockLog = [];
let gen = 0;
let mock = null;

async function startWatchedMock(ports = { cmd: 0, evt: 0 }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const g = gen + 1;
    const m = await startMock({ cmdPort: ports.cmd, evtPort: ports.evt, clock: 'real', log: (kind, text) => mockLog.push({ at: now(), gen: g, kind, text }) });
    if (FORBIDDEN.has(m.cmdPort) || FORBIDDEN.has(m.evtPort)) {
      await m.stop();
      continue;
    }
    gen = g;
    const receive = m.lr.receiveLine.bind(m.lr);
    m.lr.receiveLine = (line) => {
      let cmd = null;
      try {
        cmd = JSON.parse(line);
      } catch {
        cmd = null;
      }
      received.push({ at: now(), gen: g, conn: m.server.connections.cmd, line, cmd });
      receive(line);
    };
    // Written means on the socket: with delayEvents, later than Lightroom sent it.
    m.control.on('sent', (obj) => sent.push({ at: now(), gen: g, obj, target: m.lr.target }));
    m.control.on('lost', (obj) => lost.push({ at: now(), gen: g, obj }));
    return m;
  }
  throw new Error('the OS kept handing out a DeckBridge port');
}

const st = () => mock.control.state();
const value = (p, photo) => {
  const s = st();
  return s.photos[photo ?? s.target].values[p];
};
const near = (a, b, eps = 0.0051) => typeof a === 'number' && Math.abs(a - b) <= eps;
const cmdsSince = (t, pred = () => true) => received.filter((r) => r.at >= t && r.cmd && pred(r.cmd)).map((r) => r.cmd);
const sentSince = (t, pred = () => true) => sent.filter((s) => s.at >= t && pred(s.obj));
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));
const describeMock = () => {
  const s = st();
  return `mock: ${s.module}, target ${s.target}, Exposure ${value('Exposure')}, Contrast ${value('Contrast')}, tracking ${s.tracking}, clients ${JSON.stringify(s.clients)}`;
};
const describeCmds = (t) => JSON.stringify(cmdsSince(t, (c) => c.t !== 'ping'));
const describeErrs = (t) => JSON.stringify(sentSince(t, (o) => o.t === 'err').map((s) => s.obj));

// ---- the fake Stream Deck app ----

const DEVICE = 'DECK';
const app = { server: null, socket: null, messages: [] };
const strips = new Map(); // context → every setFeedback merged, latest first: what the app shows
const stripEvents = []; // { at, context, payload }
const images = new Map(); // context → the last key image, as SVG text
const imageEvents = []; // { at, context, svg }
// context → a dial's settings as the app keeps them: what the plugin saved with setSettings, or what the dial's
// Property Inspector chose. The app sends them with every event for that dial. Like the real app, it doesn't echo
// the plugin's own setSettings back as didReceiveSettings.
const settingsOf = new Map();

function startApp() {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(server));
    server.on('error', reject);
    server.on('connection', (ws) => {
      app.socket = ws;
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        const at = now();
        app.messages.push({ at, msg });
        if (msg.event === 'setFeedback') {
          strips.set(msg.context, { ...strips.get(msg.context), ...msg.payload });
          stripEvents.push({ at, context: msg.context, payload: msg.payload });
        } else if (msg.event === 'setImage' && typeof msg.payload?.image === 'string') {
          const svg = Buffer.from(msg.payload.image.split(',')[1] ?? '', 'base64').toString('utf8');
          images.set(msg.context, svg);
          imageEvents.push({ at, context: msg.context, svg });
        } else if (msg.event === 'setSettings') {
          settingsOf.set(msg.context, msg.payload);
        }
      });
    });
  });
}

const toPlugin = (msg) => app.socket.send(JSON.stringify(msg));
const payload = (controller, coordinates, settings = {}, extra = {}) => ({ controller, coordinates, isInMultiAction: false, settings, resources: {}, ...extra });
const DIALS = [0, 1, 2, 3];
// Each page's dials: their contexts (each placed dial is its own action instance) and the param each should
// show. Page 1's dials start without settings; the other pages' were chosen in their Property Inspectors.
const pages = PAGES.map((params, i) => params.map((param, col) => ({ context: i === 0 ? `dial-${col}` : `p${i + 1}-${col}`, col, param })));
for (const page of pages.slice(1)) for (const d of page) settingsOf.set(d.context, { param: d.param });
let shownPage = 0; // the page the app shows, 0-based
const dialAt = (col) => pages[shownPage][col];
const dialContext = (col) => dialAt(col).context;
const dialPayload = (d, extra = {}) => ({ ...payload('Encoder', { column: d.col, row: 0 }, settingsOf.get(d.context) ?? {}), ...extra });
const dialMsg = (event, col, extra = {}) => toPlugin({ event, action: `${UUID}.dial`, context: dialContext(col), device: DEVICE, payload: dialPayload(dialAt(col), extra) });
const rotate = (col, ticks, pressed = false) => dialMsg('dialRotate', col, { ticks, pressed });
const dialDown = (col) => dialMsg('dialDown', col);
const dialUp = (col) => dialMsg('dialUp', col);
const touch = (col, hold = false) => dialMsg('touchTap', col, { hold, tapPos: [100, 50] });
const appeared = []; // { at, context }: every willAppear for a dial
const disappeared = []; // { at, context }: every willDisappear
function appear(d) {
  strips.delete(d.context); // the app shows the layout's defaults until the plugin paints
  appeared.push({ at: now(), context: d.context });
  toPlugin({ event: 'willAppear', action: `${UUID}.dial`, context: d.context, device: DEVICE, payload: dialPayload(d) });
}
function disappear(d) {
  disappeared.push({ at: now(), context: d.context });
  toPlugin({ event: 'willDisappear', action: `${UUID}.dial`, context: d.context, device: DEVICE, payload: dialPayload(d) });
}
// The dial's Property Inspector saves another slider: the app keeps it and tells the plugin.
function chooseSlider(col, param) {
  const d = dialAt(col);
  d.param = param;
  settingsOf.set(d.context, { param });
  toPlugin({ event: 'didReceiveSettings', action: `${UUID}.dial`, context: d.context, device: DEVICE, payload: dialPayload(d) });
}
const inspector = (event, col) => toPlugin({ event, action: `${UUID}.dial`, context: dialContext(col), device: DEVICE });
const askSliders = (col) => toPlugin({ event: 'sendToPlugin', action: `${UUID}.dial`, context: dialContext(col), payload: { t: 'getSliders' } });
// The plugin's latest answer to a dial's Property Inspector since t: {t: "sliders", items, param}.
const slidersReply = (t, context) => app.messages.filter((m) => m.at >= t && m.msg.event === 'sendToPropertyInspector' && m.msg.context === context && m.msg.payload?.t === 'sliders').at(-1)?.msg.payload;
const savedFor = (context, since = 0) => app.messages.filter((m) => m.at >= since && m.msg.event === 'setSettings' && m.msg.context === context).map((m) => m.msg.payload);
const settingsSaved = (since) => app.messages.filter((m) => m.at >= since && m.msg.event === 'setSettings').map((m) => `${m.msg.context} ${JSON.stringify(m.msg.payload)}`);

const KEYS = {
  pick: { action: 'pick', context: 'key-pick', coordinates: { column: 0, row: 0 }, settings: {} },
  reject: { action: 'reject', context: 'key-reject', coordinates: { column: 1, row: 0 }, settings: {} },
  unflag: { action: 'unflag', context: 'key-unflag', coordinates: { column: 2, row: 0 }, settings: {} },
  next: { action: 'next', context: 'key-next', coordinates: { column: 3, row: 0 }, settings: {} },
  prev: { action: 'prev', context: 'key-prev', coordinates: { column: 0, row: 1 }, settings: {} },
  ba: { action: 'before-after', context: 'key-ba', coordinates: { column: 1, row: 1 }, settings: {} },
  preset: { action: 'preset', context: 'key-preset', coordinates: { column: 2, row: 1 }, settings: { uuid: PRESET.uuid, name: PRESET.name } },
  // A second Apply Preset key, for step 15's presets that change sliders.
  sliders: { action: 'preset', context: 'key-sliders', coordinates: { column: 3, row: 1 }, settings: { uuid: PUNCHY.uuid, name: PUNCHY.name } },
};
const keyMsg = (event, k) => toPlugin({ event, action: `${UUID}.${k.action}`, context: k.context, device: DEVICE, payload: payload('Keypad', k.coordinates, k.settings, { state: 0 }) });
async function press(k) {
  keyMsg('keyDown', k);
  await sleep(60);
  keyMsg('keyUp', k);
}

const strip = (col) => strips.get(dialContext(col)) ?? {};
const shown = (col) => strip(col).value?.value;
const sawShown = (col, text, since) => stripEvents.some((e) => e.at >= since && e.context === dialContext(col) && e.payload.value?.value === text);
// The value texts a dial's strip showed from `from` on, in order.
const shownSince = (col, from) => stripEvents.filter((e) => e.at >= from && e.context === dialContext(col) && e.payload.value?.value !== undefined).map((e) => e.payload.value.value);
const nonDecreasing = (texts) => texts.every((s, i) => Number.isFinite(Number(s)) && (i === 0 || Number(s) >= Number(texts[i - 1])));
// Once the deck has `photo`'s values (the mock's first vals for it since `since`), the Exposure strip may only
// climb from that photo's own value while the dial turns up: an older photo's value showing would be a step back.
// The window starts 5 ms after those vals left the mock, past any paint that was already on its way.
function stripClimbsFrom(photo, base, since) {
  const valsAt = sent.find((s) => s.at >= since && s.obj.t === 'vals' && 'Exposure' in s.obj.vals && s.target === photo)?.at;
  const texts = valsAt === undefined ? [] : shownSince(EXPOSURE, valsAt + 5);
  return { ok: texts.length > 1 && nonDecreasing(texts) && Number(texts[0]) >= base - 0.006, texts: texts.join(' ') || 'nothing shown' };
}
const image = (context) => images.get(context) ?? '';
let NEXT_LIT = null; // the Next key's image while online, learnt in step 1: it changes only with the connection
let PRESET_LIT = null; // the Apply Preset key's image while online and writable, learnt in step 1
const nextKeyDimmedSince = (since) => imageEvents.some((e) => e.at >= since && e.context === KEYS.next.context && e.svg !== NEXT_LIT);
const alerts = () => app.messages.filter((m) => m.msg.event === 'showAlert');
const alertsOn = (context, since) => alerts().filter((m) => m.at >= since && m.msg.context === context).length;
const alertCounts = (since) => {
  const counts = {};
  for (const m of alerts()) if (m.at >= since) counts[m.msg.context] = (counts[m.msg.context] ?? 0) + 1;
  return counts;
};
const fromPluginSince = (t, pred) => app.messages.filter((m) => m.at >= t && pred(m.msg)).map((m) => m.msg);

let LIT = null; // a strip's label and value colours and its bar fill when live in Develop, learnt in step 1

// What a dial's strip should show: its slider's label and the mock's value for the target photo, or a status word
// (Locked, Mismatch) in place of the value, and no ×10. A param sliders.json doesn't list shows itself and
// "Not listed" whatever the state.
function wantStrip(d, s, word = null) {
  const slider = sliderOf(d.param);
  if (!slider) return { label: d.param, value: NOT_LISTED, mode: '' };
  if (word) return { label: slider.label, value: word, mode: '' };
  const ph = s.photos[s.target];
  return { label: slider.label, value: display(slider, ph.values[d.param], defaultRange(ph.fmt, d.param)), mode: '' };
}
// What differs between the shown page's strips and what they should show.
function stripMismatches(word = null) {
  const s = st();
  const bad = [];
  for (const d of pages[shownPage]) {
    const want = wantStrip(d, s, word);
    const got = strips.get(d.context) ?? {};
    const g = { label: got.label?.value, value: got.value?.value, mode: got.mode?.value };
    if (g.label !== want.label || g.value !== want.value || g.mode !== want.mode) {
      bad.push(`dial ${d.col + 1} wants ${want.label} "${want.value}"${want.mode ? ` ${want.mode}` : ''}, shows ${g.label} "${g.value}"${g.mode ? ` ${g.mode}` : ''}`);
    }
  }
  return bad;
}
const stripsMatch = (word = null) => stripMismatches(word).length === 0;
const lit = (col) => strip(col).label?.color === LIT.label && strip(col).value?.color === LIT.value;
const dimmed = (col) => strip(col).label?.color !== LIT.label && strip(col).value?.color !== LIT.value;
const stripsWhy = (word = null) => `page ${shownPage + 1}: ${stripMismatches(word).join('; ') || 'texts match'}; colours ${DIALS.map((c) => `${strip(c).label?.color}/${strip(c).value?.color}`).join(' ')}; ${describeMock()}`;

// Big steps on a dial, as its strip shows them: the mode text "×10" (for the variant in force) and the bar fill in
// `color`, green when live. Off: no mode text, and the usual fill.
function rangeOf(param) {
  const s = st();
  return defaultRange(s.photos[s.target].fmt, param);
}
const bigOn = (col, color = GREEN) => strip(col).mode?.value === bigText(sliderOf(dialAt(col).param), rangeOf(dialAt(col).param)) && strip(col).mode?.color === color && strip(col).bar?.bar_fill_c === color;
const bigOff = (col) => strip(col).mode?.value === '' && strip(col).bar?.bar_fill_c === LIT.fill;
let DIM = null; // a dimmed strip's bar fill with big steps off, learnt in step 7
const rgb = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null);
// Big steps' green as a dimmed strip shows it (plan.md, Phase 7: "A dimmed strip dims them too"): green over red
// and blue, darker than the live green, and not the plain dimmed fill.
function dimmedGreen(c) {
  const x = rgb(c);
  const live = rgb(GREEN);
  return x !== null && c !== GREEN && c !== DIM?.fill && x[1] > x[0] && x[1] > x[2] && x[0] + x[1] + x[2] < live[0] + live[1] + live[2];
}
// On while the strip is dimmed: the mode text and the fill in one dimmed green. Off: no mode text, and the plain
// dimmed fill.
const bigOnDimmed = (col) => strip(col).mode?.value === bigText(sliderOf(dialAt(col).param), rangeOf(dialAt(col).param)) && dimmedGreen(strip(col).mode?.color) && strip(col).bar?.bar_fill_c === strip(col).mode?.color;
const bigOffDimmed = (col) => strip(col).mode?.value === '' && DIM !== null && strip(col).bar?.bar_fill_c === DIM.fill;
const bigWhy = (col) => `${dialAt(col).param}: mode ${JSON.stringify(strip(col).mode)}, bar fill ${strip(col).bar?.bar_fill_c}`;
// When a dial's mode text was last emptied after `since`: big steps going off.
const offAt = (col, since) => stripEvents.find((e) => e.at >= since && e.context === dialContext(col) && e.payload.mode?.value === '')?.at;
// Big steps went off within 300 ms of an input sent at `t`, so the input turned them off. The countdown may have
// had well under its macroSeconds left by then, so going off within a longer wait proves nothing.
const offSoon = (col, t) => offAt(col, t) !== undefined && offAt(col, t) - t < 300;
const offWhen = (col, t) => (offAt(col, t) === undefined ? 'not off yet' : `off ${Math.round(offAt(col, t) - t)} ms after the input`);

// Switches pages as the app does: willDisappear for the shown page's dials, then willAppear for page i's, each
// with its settings. Then waits for page i's strips: the mock's values, or `word` in place of each value.
async function showPage(i, what, word = null) {
  for (const d of pages[shownPage]) disappear(d);
  shownPage = i;
  for (const d of pages[i]) appear(d);
  const names = pages[i].map((d) => sliderOf(d.param)?.label ?? d.param).join(', ');
  const name = i < PAGES.length ? `page ${i + 1}` : `its page ${i - PAGES.length + 1}`; // step 18's copy has pages of its own
  return waitFor(`${what}: ${name} (${names})`, () => stripsMatch(word), 2000, () => stripsWhy(word));
}
// Once round every page, back to page 1.
async function pageRound(what, word = null) {
  for (let i = 1; i < pages.length; i += 1) await showPage(i, what, word);
  await showPage(0, what, word);
}
// The strip updates dials got after willDisappear from `since` on, before they appeared again: there should be
// none. A paint already on its way when its page went may still arrive within 50 ms.
function lateStripUpdates(since) {
  return disappeared.filter((x) => x.at >= since).flatMap((x) => {
    const again = appeared.find((a) => a.at > x.at && a.context === x.context)?.at ?? Infinity;
    return stripEvents.filter((e) => e.context === x.context && e.at > x.at + 50 && e.at < again).map((e) => `${x.context} ${Math.round(e.at - x.at)} ms after it went`);
  });
}

// ---- what steps 9-16 expect, for the checks over the whole session (now() times) ----

const alertWindows = []; // { from, to, contexts }: alerts on these dials and keys
const errWindows = []; // { from, to, codes }: errs with these codes
const warnWindows = []; // { from, to, re }: WARN lines in the plugin's log

// ---- the plugin's log ----

let pluginDir = null; // the main run's copy of the plugin
function logText(plugin = pluginDir) {
  const dir = path.join(plugin, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse() // .1.log is older than .0.log
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('');
}
const logCount = (re) => logText().split('\n').filter((l) => re.test(l)).length;
// Log lines start with their wall-clock time, to the ms, then the level: "2026-11-03T21:06:22.123Z DEBUG Dials: ...".
const lineAt = (line) => Date.parse(line.slice(0, 24)) - WALL0;
const lineLevel = (line) => line.match(/^\S+ ([A-Z]+) /)?.[1] ?? null;
// TICK records (spikes/s4-ticks/analyze.mjs's format), with the time of their log line.
const tickRecords = (log) => log.split('\n').flatMap((l) => {
  const m = / TICK (\{.*\})\s*$/.exec(l);
  if (!m) return [];
  try {
    return [{ at: lineAt(l), ...JSON.parse(m[1]) }];
  } catch {
    return [];
  }
});
// Steps 2-3e are normal use of the dials, for the quiet-logs check in step 17.
const quiet = { from: 0, to: 0 };
// A log line a step expects: an alert for a dial it used, or a warning it allows, within the step.
function expectedLogLine(line) {
  const at = lineAt(line);
  if (!Number.isFinite(at)) return false;
  const within = (w) => at >= w.from - 100 && at <= w.to + 100;
  const alert = line.match(/alert for (\S+): /);
  if (alert) return alertWindows.some((w) => within(w) && w.contexts.includes(alert[1]));
  return warnWindows.some((w) => within(w) && w.re.test(line));
}

// ---- run ----

const tmp = mkdtempSync(path.join(os.tmpdir(), 'deck-vs-mock-'));
// A copy of the .sdPlugin folder under tmp, named as the SDK expects, since it names its log after the folder.
// The user's own log-level.txt and logs stay behind, so the copy logs at `level`, or at the default (info).
function copyPlugin(under, level = null) {
  const dir = path.join(tmp, under, `${UUID}.sdPlugin`);
  cpSync(SOURCE, dir, { recursive: true, filter: (src) => !src.startsWith(path.join(SOURCE, 'logs')) && path.basename(src) !== 'log-level.txt' });
  if (level) writeFileSync(path.join(dir, 'log-level.txt'), `${level}\n`);
  return dir;
}
pluginDir = copyPlugin('main', 'debug');

mock = await startWatchedMock();
for (let attempt = 0; ; attempt += 1) {
  app.server = await startApp();
  if (!FORBIDDEN.has(app.server.address().port)) break;
  app.server.close();
  if (attempt >= 4) fatal('the OS kept handing out a DeckBridge port');
}
const info = {
  application: { font: '.AppleSystemUIFont', language: 'en', platform: 'mac', platformVersion: '26.0.0', version: '7.6.0.23012' },
  plugin: { uuid: UUID, version: JSON.parse(readFileSync(path.join(SOURCE, 'manifest.json'), 'utf8')).Version },
  devicePixelRatio: 2,
  colors: {},
  devices: [{ id: DEVICE, name: 'Stream Deck +', size: { columns: 4, rows: 2 }, type: 7 }],
};
// Runs the plugin in `dir` against the fake app and the current mock.
function startPlugin(dir) {
  const run = { dir, output: '', exited: null };
  run.child = spawn(
    process.execPath,
    ['--import', pathToFileURL(GUARD).href, path.join(dir, 'bin', 'plugin.js'), '-port', String(app.server.address().port), '-pluginUUID', UUID, '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)],
    { cwd: dir, env: { ...process.env, DECKBRIDGE_CMD_PORT: String(mock.cmdPort), DECKBRIDGE_EVT_PORT: String(mock.evtPort) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  run.child.stdout.on('data', (d) => { run.output += d; });
  run.child.stderr.on('data', (d) => { run.output += d; });
  run.child.on('exit', (code, signal) => { run.exited = { code, signal }; });
  runs.push(run);
  running = run;
  return run;
}
const main = startPlugin(pluginDir); // steps 1-17; step 18 runs a second copy
const deadline = setTimeout(() => {
  console.error('deck-vs-mock: gave up after 300 s');
  console.log(`\n--- plugin log (last 80 lines) ---\n${logText().split('\n').slice(-81).join('\n')}`);
  for (const run of runs) run.child.kill('SIGKILL');
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}, 300_000);
deadline.unref();

class Abort extends Error {}
const must = (ok) => {
  if (!ok) throw new Abort();
};

// For the checks at the end: step 8c's pause, and each mock's history.
const pauses = [];
const histories = [];

try {
  // ---------------------------------------------------------------------------------------------------------
  section('1. The actions appear, and the plugin connects');
  must(await waitFor('the plugin registers with the fake Stream Deck app', () => app.messages.some((m) => m.msg.event === 'registerPlugin' && m.msg.uuid === UUID), 8000));
  // Four dials placed without settings, and the keys.
  for (const d of pages[0]) appear(d);
  for (const k of Object.values(KEYS)) toPlugin({ event: 'willAppear', action: `${UUID}.${k.action}`, context: k.context, device: DEVICE, payload: payload('Keypad', k.coordinates, k.settings, { state: 0 }) });

  must(await waitFor("it connects to both of the mock's sockets and is greeted", () => mock.control.clients().cmd && mock.control.clients().evt && mock.control.clients().greeted, 5000, describeMock));
  await waitFor('it says hello with v 1, its client name and version', () => cmdsSince(0, (c) => c.t === 'hello' && c.v === 1 && typeof c.client === 'string' && typeof c.ver === 'string').length >= 1, 3000, () => JSON.stringify(cmdsSince(0).slice(0, 3)));
  check(`the tools' SLIDER_PARAMS are sliders.json's ${WATCH.length} sliders, in its order`, same(SLIDER_PARAMS, WATCH), `SLIDER_PARAMS ${SLIDER_PARAMS.join(', ')}`);
  await waitFor(`it watches exactly the ${WATCH.length} sliders in sliders.json, in its order (${WATCH.join(', ')})`, () => cmdsSince(0, (c) => c.t === 'watch' && same(c.ps, WATCH)).length >= 1 && same(st().watch, WATCH), 3000, () => `watch commands ${JSON.stringify(cmdsSince(0, (c) => c.t === 'watch'))}; mock watches ${st().watch.join(', ')}`);
  const newRanges = (photo) => {
    const ranges = sent.find((s) => s.obj.t === 'ranges' && s.target === photo)?.obj.ranges ?? {};
    return { ok: same(Object.keys(ranges), WATCH) && Object.entries(NEW_RANGES).every(([p, r]) => same(ranges[p], r)), why: JSON.stringify(ranges) };
  };
  await waitFor("the mock reports ranges for all 17 on raw photo 101: Sharpness 0…150, LuminanceSmoothing 0…100 and GrainAmount 0…100, and Dehaze -100…100", () => newRanges('101').ok, 3000, () => newRanges('101').why);
  await waitFor('four dials placed without settings: the plugin saves Temperature, Tint, Exposure and Contrast, by column, with setSettings', () => pages[0].every((d) => same(savedFor(d.context), [{ param: DEFAULTS[d.col] }])), 3000, () => pages[0].map((d) => `${d.context} ${JSON.stringify(savedFor(d.context))}`).join('; '));
  must(await waitFor("the strips show Temp, Tint, Exposure and Contrast with the mock's values for photo 101, and no ×10", () => stripsMatch(), 4000, stripsWhy));
  LIT = { label: strip(0).label?.color, value: strip(0).value?.color, fill: strip(0).bar?.bar_fill_c };
  await waitFor("the keys show their captions, the flag keys for 101's flag (none) and the preset key its preset's name", () => {
    const want = { pick: '>Pick<', reject: '>Reject<', unflag: '>Unflagged<', next: '>Next<', prev: '>Previous<', ba: '>Before/After<', preset: '>Chrome<' };
    return Object.entries(want).every(([k, text]) => image(KEYS[k].context).includes(text));
  }, 3000, () => Object.keys(KEYS).map((k) => `${k} ${image(KEYS[k].context).match(/>([^<]+)</g)?.join('') ?? 'no image'}`).join('; '));
  NEXT_LIT = image(KEYS.next.context);
  PRESET_LIT = image(KEYS.preset.context);

  // ---------------------------------------------------------------------------------------------------------
  section('2. Turning Exposure');
  quiet.from = now();
  {
    const base = value('Exposure');
    const history0 = st().history.length;
    const t = now();
    // 20 ms apart, faster than the app's ~50 ms, so the deck's 30-a-second limit has to coalesce them.
    const events = [1, 1, 2, 1, 1, 2, 1];
    const effective = events.reduce((sum, n) => sum + accelerate(n), 0);
    const want = round2(base + effective * STEP);
    for (const n of events) {
      rotate(EXPOSURE, n);
      await sleep(20);
    }
    const lastTick = now() - 20;
    await waitFor(`${events.length} dial events (${effective} ticks after acceleration) raise the mock's Exposure from ${base} to ${want}`, () => near(value('Exposure'), want), 2000, describeMock);
    const sets = cmdsSince(t, (c) => c.t === 'set');
    const gs = [...new Set(sets.map((c) => c.g))];
    check('the turn is one gesture: every set is Exposure with the same g, and they only go up', sets.length > 0 && gs.length === 1 && sets.every((c, i) => c.p === 'Exposure' && (i === 0 || c.v > sets[i - 1].v)), `${sets.length} sets: ${sets.map((c) => c.v).join(', ')}; g ${gs.join(', ')}`);
    await waitFor('done with that g follows the last tick', () => cmdsSince(t, (c) => c.t === 'done' && c.g === gs[0]).length === 1, 3000);
    const doneAt = received.find((r) => r.at >= t && r.cmd?.t === 'done')?.at;
    check('done comes about 800 ms after the last tick', doneAt !== undefined && doneAt - lastTick >= 700 && doneAt - lastTick <= 1300, doneAt === undefined ? 'no done' : `${Math.round(doneAt - lastTick)} ms`);
    await sleep(100);
    const steps = st().history.slice(history0);
    check('the gesture is exactly one history step in the mock', steps.length === 1 && steps[0].kind === 'gesture' && steps[0].p === 'Exposure' && steps[0].photo === '101' && near(steps[0].from, base, 1e-9) && near(steps[0].to, want, 1e-9) && !steps[0].stale && !st().tracking, JSON.stringify(steps));
    await waitFor(`the strip shows the mock's final value (${display(sliderOf('Exposure'), want, [-5, 5])})`, () => stripsMatch(), 2000, stripsWhy);
    await sleep(400); // the deck's 300 ms echo window closes, and it applies the mock's held-back vals
    const texts = shownSince(EXPOSURE, t);
    check('the Exposure strip only ever moved up: no echo of an older value from the mock', nonDecreasing(texts) && stripsMatch(), texts.join(' '));
  }

  // ---------------------------------------------------------------------------------------------------------
  section('3. Fine adjust, a press, and a long touch that resets nothing');
  {
    let base = value('Exposure');
    let t = now();
    let history0 = st().history.length;
    dialDown(EXPOSURE);
    await sleep(30);
    rotate(EXPOSURE, 2, true);
    await sleep(45);
    rotate(EXPOSURE, 2, true);
    await sleep(45);
    const upAt = now();
    dialUp(EXPOSURE);
    let want = round2(base + 4 * FINE);
    await waitFor(`push + turn moves Exposure in fine steps (4 ticks of ${FINE.toFixed(4)} EV: ${base} to ${want})`, () => near(value('Exposure'), want), 2000, describeMock);
    await waitFor('the dial-up after push + turn ends the gesture at once with done, and doesn\'t reset', () => {
      const done = received.find((r) => r.at >= t && r.cmd?.t === 'done');
      return done !== undefined && done.at - upAt < 400 && cmdsSince(t, (c) => c.t === 'reset').length === 0;
    }, 2000, () => JSON.stringify(cmdsSince(t)));
    await sleep(150);
    check('that is one more history step', st().history.length === history0 + 1 && st().history.at(-1).kind === 'gesture', JSON.stringify(st().history.slice(history0)));
    await waitFor('the strip shows the fine value', () => stripsMatch(), 2000, stripsWhy);

    await sleep(400);
    t = now();
    history0 = st().history.length;
    dialDown(EXPOSURE);
    await sleep(80);
    dialUp(EXPOSURE);
    await waitFor('a press without turning resets Exposure to its default (0) in the mock', () => cmdsSince(t, (c) => c.t === 'reset' && c.p === 'Exposure').length === 1 && value('Exposure') === 0, 2000, describeMock);
    await waitFor('the strip shows 0.00', () => shown(EXPOSURE) === display(sliderOf('Exposure'), 0, [-5, 5]) && stripsMatch(), 2000, stripsWhy);
    check('the reset is one history step', st().history.length === history0 + 1 && st().history.at(-1).kind === 'reset', JSON.stringify(st().history.slice(history0)));

    // Contrast first moves off its default, turning down this time, so a reset would show.
    base = value('Contrast');
    t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(CONTRAST, -1);
      await sleep(50);
    }
    want = base - 3 * CONTRAST_STEP;
    await waitFor(`three ticks down take Contrast from ${base} to ${want}, and the strip says ${want}`, () => value('Contrast') === want && cmdsSince(t, (c) => c.t === 'done').length === 1 && shown(CONTRAST) === String(want), 3000, () => `${describeMock()}; strip ${shown(CONTRAST)}`);
    await sleep(400);
    t = now();
    touch(CONTRAST, true);
    await waitFor('a long touch turns big steps on for Contrast, as a tap does: ×10 and the bar fill in green', () => bigOn(CONTRAST), 1000, () => bigWhy(CONTRAST));
    await sleep(300);
    check(`and resets nothing: Contrast stays ${want} in the mock and on the strip`, value('Contrast') === want && shown(CONTRAST) === String(want), `${describeMock()}; strip ${shown(CONTRAST)}`);
    const tOff = now();
    touch(CONTRAST, true);
    await waitFor('a second long touch turns them off at once: no ×10, and the usual bar fill', () => bigOff(CONTRAST) && offSoon(CONTRAST, tOff), 1000, () => `${bigWhy(CONTRAST)}; ${offWhen(CONTRAST, tOff)}`);
    await sleep(100);
    check('the long touches sent Lightroom nothing and raised no alert', cmdsSince(t, (c) => c.t !== 'ping').length === 0 && alerts().filter((m) => m.at >= t).length === 0, `${describeCmds(t)}; ${JSON.stringify(alertCounts(t))}`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('3b. Big steps');
  {
    await sleep(600);
    const t3b = now();
    // Turns one dial in a burst, events 50 ms apart, and waits for the gesture's done. For the check at the end
    // that each burst is one gesture, ended by one done, and one history step in the mock.
    const bursts = [];
    const burst = async (col, events) => {
      const t = now();
      const history0 = st().history.length;
      let lastTurn = t;
      for (const n of events) {
        rotate(col, n);
        lastTurn = now();
        await sleep(50);
      }
      await until(() => !st().tracking && cmdsSince(t, (c) => c.t === 'done').length >= 1, 3000);
      await sleep(100);
      const sets = cmdsSince(t, (c) => c.t === 'set');
      const dones = cmdsSince(t, (c) => c.t === 'done');
      const history = st().history.slice(history0);
      const gs = [...new Set(sets.map((c) => c.g))];
      bursts.push({
        what: `${dialAt(col).param} ${events.join('+')}`,
        one: gs.length === 1 && dones.length === 1 && dones[0].g === gs[0] && history.length === 1 && history[0].kind === 'gesture' && history[0].why === 'done',
        detail: `sets ${sets.map((c) => c.v).join(', ')} with g ${gs.join(', ')}; ${dones.length} done; history ${JSON.stringify(history.map((h) => [h.kind, h.p, h.why]))}`,
      });
      return { lastTurn, sets };
    };

    // Exposure: a tap, one click, three clicks, another tap.
    let t = now();
    touch(EXPOSURE);
    await waitFor(`a tap on Exposure's strip turns big steps on for that dial: ×10 in green (${GREEN}), and the bar fill green too`, () => bigOn(EXPOSURE), 1000, () => bigWhy(EXPOSURE));
    check('the other dials stay as they were: no ×10, and the usual fill', [TEMP, TINT, CONTRAST].every(bigOff), [TEMP, TINT, CONTRAST].map(bigWhy).join('; '));
    check('the tap sent Lightroom nothing', cmdsSince(t, (c) => c.t !== 'ping').length === 0, describeCmds(t));
    let base = value('Exposure');
    let want = round2(base + MACRO);
    let b = await burst(EXPOSURE, [1]);
    check(`one click moves Exposure by a big step, 1/3 EV, as the mock records it: ${base} to ${want}`, value('Exposure') === want && b.sets.at(-1)?.v === want, `${describeMock()}; sets ${b.sets.map((c) => c.v).join(', ')}`);
    base = value('Exposure');
    want = round2(base + 3 * MACRO);
    b = await burst(EXPOSURE, [1, 1, 1]);
    check(`three clicks in three events 50 ms apart move it three big steps, with no acceleration: ${base} to ${want}`, value('Exposure') === want && b.sets.at(-1)?.v === want, `${describeMock()}; sets ${b.sets.map((c) => c.v).join(', ')}`);
    const exposureText = display(sliderOf('Exposure'), want, [-5, 5]);
    await waitFor(`the strip shows ${exposureText}, still with ×10 in green`, () => shown(EXPOSURE) === exposureText && bigOn(EXPOSURE), 1000, () => `${shown(EXPOSURE)}; ${bigWhy(EXPOSURE)}`);
    // The off-checks below want big steps off within 300 ms of the input (offSoon): each input comes about 900 ms
    // after the burst's last turn, when the countdown has only about 1.1 s to go.
    t = now();
    touch(EXPOSURE);
    await waitFor('another tap turns them off at once: no ×10, and the usual fill', () => bigOff(EXPOSURE) && offSoon(EXPOSURE, t), 1000, () => `${bigWhy(EXPOSURE)}; ${offWhen(EXPOSURE, t)}`);
    await sleep(100);
    check('that tap sent nothing either', cmdsSince(t, (c) => c.t !== 'ping').length === 0, describeCmds(t));

    // Contrast, -100…100: one event of 4 ticks, then a press.
    touch(CONTRAST);
    await waitFor('a tap turns big steps on for Contrast', () => bigOn(CONTRAST), 1000, () => bigWhy(CONTRAST));
    base = value('Contrast');
    want = base + 4 * CONTRAST_MACRO;
    b = await burst(CONTRAST, [4]);
    check(`one event of 4 ticks moves Contrast exactly 4 big steps, with no acceleration: ${base} to ${want} (accelerated, it would move ${accelerate(4) * CONTRAST_MACRO})`,
      value('Contrast') === want && b.sets.length === 1 && b.sets[0].v === want, `${describeMock()}; sets ${b.sets.map((c) => c.v).join(', ')}`);
    t = now();
    dialDown(CONTRAST);
    await waitFor('pressing the dial turns them off at dial-down, before the release', () => bigOff(CONTRAST) && offSoon(CONTRAST, t), 1000, () => `${bigWhy(CONTRAST)}; ${offWhen(CONTRAST, t)}`);
    dialUp(CONTRAST);
    await waitFor('and the press still resets Contrast to 0', () => cmdsSince(t, (c) => c.t === 'reset' && c.p === 'Contrast').length === 1 && value('Contrast') === 0 && shown(CONTRAST) === '0', 2000, () => `${describeCmds(t)}; ${describeMock()}`);

    // Temperature on a raw photo, where a big step is 500 K: one click, then push + turn.
    await sleep(300);
    const tempRange = rangeOf('Temperature');
    touch(TEMP);
    await waitFor(`a tap turns big steps on for Temp, ×10 on raw photo ${st().target} too: ${KELVIN.macro} K is ten ${KELVIN.step} K steps`, () => tempRange[0] >= 1000 && bigOn(TEMP), 1000, () => `${tempRange.join('…')}; ${bigWhy(TEMP)}`);
    base = value('Temperature');
    want = base + KELVIN.macro;
    b = await burst(TEMP, [1]);
    check(`one click moves Temperature ${KELVIN.macro} K on a raw photo: ${base} K to ${want} K`, value('Temperature') === want && b.sets.at(-1)?.v === want, `Temperature ${value('Temperature')}; sets ${b.sets.map((c) => c.v).join(', ')}`);
    const tempText = display(sliderOf('Temperature'), want, tempRange);
    await waitFor(`the strip shows ${tempText}`, () => shown(TEMP) === tempText, 1000, () => shown(TEMP));
    t = now();
    base = value('Temperature');
    dialDown(TEMP);
    await waitFor('pushing the dial turns them off at dial-down', () => bigOff(TEMP) && offSoon(TEMP, t), 1000, () => `${bigWhy(TEMP)}; ${offWhen(TEMP, t)}`);
    rotate(TEMP, 2, true);
    await sleep(45);
    rotate(TEMP, 2, true);
    await sleep(45);
    dialUp(TEMP);
    want = base + 4 * KELVIN.fine;
    await waitFor(`and push + turn moves in fine steps: 4 ticks of ${KELVIN.fine} K, ${base} K to ${want} K, ended by one done, with no reset`,
      () => value('Temperature') === want && cmdsSince(t, (c) => c.t === 'done').length === 1 && cmdsSince(t, (c) => c.t === 'reset').length === 0, 2000, () => `${describeCmds(t)}; Temperature ${value('Temperature')}`);

    // Tint: big steps go off by themselves after macroSeconds without a turn, and a turn starts the count again.
    // Temp's count runs meanwhile, from a tap of its own 600 ms after Tint's: each dial counts for itself.
    await sleep(300);
    t = now();
    touch(TINT);
    await waitFor('a tap turns big steps on for Tint', () => bigOn(TINT), 1000, () => bigWhy(TINT));
    await waitFor(`with no turn, they go off by themselves (macroSeconds, ${MACRO_MS / 1000} s)`, () => bigOff(TINT), MACRO_MS + 1500, () => bigWhy(TINT));
    let off = offAt(TINT, t);
    check(`they went off ${MACRO_MS / 1000} s after the tap, not before, and sent Lightroom nothing`, off - t >= MACRO_MS - 50 && off - t <= MACRO_MS + 400 && cmdsSince(t, (c) => c.t !== 'ping').length === 0, `${Math.round(off - t)} ms after the tap; ${describeCmds(t)}`);
    await sleep(300);
    t = now();
    touch(TINT);
    await waitFor('another tap turns them on again', () => bigOn(TINT), 1000, () => bigWhy(TINT));
    await sleep(Math.max(0, t + 600 - now()));
    const tTemp = now();
    touch(TEMP);
    await waitFor("600 ms later a tap turns them on for Temp too, with Tint's still on", () => bigOn(TEMP) && bigOn(TINT), 1000, () => `${bigWhy(TEMP)}; ${bigWhy(TINT)}`);
    await sleep(Math.max(0, t + 1200 - now()));
    base = value('Tint');
    want = base + TINT_MACRO;
    b = await burst(TINT, [1]);
    check(`a click 1.2 s after the tap moves Tint a big step: ${base} to ${want}`, value('Tint') === want, `Tint ${value('Tint')}; sets ${b.sets.map((c) => c.v).join(', ')}`);
    await sleep(Math.max(0, t + MACRO_MS + 200 - now()));
    check(`${(MACRO_MS + 200) / 1000} s after the tap they're still on: the turn started the count again`, bigOn(TINT), bigWhy(TINT));
    await waitFor(`then they go off by themselves, ${MACRO_MS / 1000} s after the turn`, () => bigOff(TINT), MACRO_MS + 1000, () => bigWhy(TINT));
    off = offAt(TINT, b.lastTurn);
    check(`they went off ${MACRO_MS / 1000} s after that turn, not after the tap`, off - b.lastTurn >= MACRO_MS - 50 && off - b.lastTurn <= MACRO_MS + 400, `${Math.round(off - b.lastTurn)} ms after the turn, ${Math.round(off - t)} ms after the tap`);
    const tempOff = offAt(TEMP, tTemp);
    check(`Temp's went off by themselves ${MACRO_MS / 1000} s after its own tap, while Tint's count ran on: each dial counts for itself`,
      tempOff !== undefined && tempOff - tTemp >= MACRO_MS - 50 && tempOff - tTemp <= MACRO_MS + 400 && tempOff < off && bigOff(TEMP),
      `${tempOff === undefined ? 'Temp not off' : `Temp off ${Math.round(tempOff - tTemp)} ms after its tap`}, Tint off ${Math.round(off - tTemp)} ms after it; ${bigWhy(TEMP)}`);

    check(`each big-step burst was one gesture, ended by one done, and one history step in the mock (${bursts.length} bursts)`, bursts.length === 5 && bursts.every((x) => x.one), bursts.filter((x) => !x.one).map((x) => `${x.what}: ${x.detail}`).join(' | '));
    const records = tickRecords(logText()).filter((r) => r.at >= t3b - 50);
    const modes = (mode) => records.filter((r) => r.mode === mode);
    check("the plugin's TICK lines say mode macro for the 7 big-step events, each applied, and fine for push + turn's 2",
      same(modes('macro').map((r) => [r.col, r.ticks, r.result]), [[2, 1, 'applied'], [2, 1, 'applied'], [2, 1, 'applied'], [2, 1, 'applied'], [3, 4, 'applied'], [0, 1, 'applied'], [1, 1, 'applied']]) && same(modes('fine').map((r) => [r.col, r.pressed]), [[0, true], [0, true]]),
      JSON.stringify(records.map((r) => [r.col, r.ticks, r.pressed, r.mode, r.result])));
  }

  // ---------------------------------------------------------------------------------------------------------
  section('3c. Stream Deck pages');
  {
    await sleep(300);
    const t3c = now();
    // Big steps go off when their dial goes away with its page.
    let t = now();
    touch(EXPOSURE);
    await waitFor('a tap turns big steps on for Exposure', () => bigOn(EXPOSURE), 1000, () => bigWhy(EXPOSURE));
    await showPage(1, "a page switch shows that page's sliders with the mock's values");
    await showPage(0, "switching straight back shows page 1's again, without ×10");
    const back = now() - t;
    check("big steps went off when Exposure's dial went away: it came back without them, before they'd have timed out", back < MACRO_MS - 200 && bigOff(EXPOSURE), `${Math.round(back)} ms after the tap; ${bigWhy(EXPOSURE)}`);

    // The newer sliders get values of their own: a mouse edit in the mock. So does Highlights, whose page 2 has been
    // away for over 200 ms by then: its dial must not repaint until page 2 comes back, and then show the new value.
    const edits = { Highlights: -33, Dehaze: 12, Sharpness: 40, LuminanceSmoothing: 25, GrainAmount: 15 };
    await sleep(200);
    t = now();
    mock.control.user({ edit: edits });
    await waitFor(`a mouse edit in the mock (${Object.entries(edits).map(([p, v]) => `${p} ${v}`).join(', ')}) reaches the deck`, () => Object.entries(edits).every(([p, v]) => sentSince(t, (o) => o.t === 'vals' && o.vals[p] === v).length > 0), 2000, describeMock);
    await sleep(100);
    const hidden = stripEvents.filter((e) => e.at >= t && pages[1].some((d) => d.context === e.context));
    check("page 2's dials, gone, got no strip update for the edit: Highlights waits for its page", hidden.length === 0, hidden.map((e) => `${e.context} ${JSON.stringify(e.payload)}`).slice(0, 3).join(', '));

    // Once round the pages.
    const bar = (col) => strip(col).bar ?? {};
    const fromLeft = (col, [min, max]) => bar(col).subtype === 0 && bar(col).range?.min === min && bar(col).range?.max === max && bar(col).value === value(dialAt(col).param) && bar(col).opacity !== 0;
    const fromCentre = (col) => bar(col).subtype === 1 && bar(col).range?.min === -100 && bar(col).range?.max === 100 && bar(col).value === value(dialAt(col).param) && bar(col).opacity !== 0;
    const barsWhy = () => DIALS.map((c) => `${dialAt(c).param} "${shown(c)}" ${JSON.stringify(bar(c))}`).join('; ');
    for (let i = 1; i < pages.length; i += 1) {
      await showPage(i, "a page switch shows the dials' named sliders with the mock's values");
      if (i === 1) {
        const text = display(sliderOf('Highlights'), edits.Highlights, rangeOf('Highlights'));
        check(`Highlights, edited while its page was away, comes back with the mock's ${text}`, strip(0).label?.value === 'Highlights' && shown(0) === text, barsWhy());
      } else if (i === 3) {
        check(`Sharpening and Noise fill from the left over 0…150 and 0…100, at the mock's ${edits.Sharpness} and ${edits.LuminanceSmoothing}, with no +; Vignette and Dehaze fill from the centre`,
          fromLeft(2, NEW_RANGES.Sharpness) && fromLeft(3, NEW_RANGES.LuminanceSmoothing) && shown(2) === String(edits.Sharpness) && shown(3) === String(edits.LuminanceSmoothing) && fromCentre(0) && fromCentre(1), barsWhy());
      } else if (i === 4) {
        check(`Grain fills from the left over 0…100, at the mock's ${edits.GrainAmount}, with no +`, fromLeft(0, NEW_RANGES.GrainAmount) && shown(0) === String(edits.GrainAmount), barsWhy());
        check("two dials can show the same slider: dials 3 and 4 both show Exposure, with the mock's value", strip(2).label?.value === 'Exposure' && strip(3).label?.value === 'Exposure' && shown(2) === display(sliderOf('Exposure'), value('Exposure'), [-5, 5]) && shown(3) === shown(2), barsWhy());
        const u = strip(1);
        check(`a dial whose settings name ${UNLISTED}, which sliders.json doesn't list, shows ${UNLISTED} and ${NOT_LISTED} in the status colour, with no bar and no ×10`,
          u.label?.value === UNLISTED && u.value?.value === NOT_LISTED && u.value?.color === STATUS && u.bar?.opacity === 0 && u.mode?.value === '', JSON.stringify(u));
      }
    }
    await showPage(0, 'back on page 1, its dials show their sliders again, from the settings the app kept for them');

    check('the page switches saved no settings: every dial that appeared named its slider', settingsSaved(t3c).length === 0, settingsSaved(t3c).join('; '));
    check('they sent Lightroom nothing', cmdsSince(t3c, (c) => c.t !== 'ping').length === 0, describeCmds(t3c));
    // After willDisappear, a dial's strip gets no updates until it appears again. Step 17 checks the same over the
    // whole session, where values change while pages are away.
    const late = lateStripUpdates(t3c);
    check('a dial whose page went away got no strip updates until its page came back', late.length === 0, late.slice(0, 5).join(', '));
  }

  // ---------------------------------------------------------------------------------------------------------
  section("3d. A slider sliders.json doesn't list");
  {
    await showPage(4, 'to page 5');
    const U = 1; // dial 2 on page 5
    await sleep(300);
    const t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(U, 1);
      await sleep(50);
    }
    await sleep(1000);
    dialDown(U);
    await sleep(80);
    dialUp(U);
    await sleep(1000);
    touch(U);
    await sleep(300);
    alertWindows.push({ from: t, to: now(), contexts: [dialContext(U)] });
    check(`turns, a press and a tap on ${UNLISTED}'s dial, a second apart, alert it once each, and no other dial`, alertsOn(dialContext(U), t) === 3 && alerts().filter((m) => m.at >= t).length === 3, JSON.stringify(alertCounts(t)));
    check('they send Lightroom nothing', cmdsSince(t, (c) => c.t !== 'ping').length === 0, describeCmds(t));
    check(`the tap turns no big steps on: the strip still shows ${UNLISTED} and ${NOT_LISTED}, with no ×10 and no bar`, strip(U).label?.value === UNLISTED && shown(U) === NOT_LISTED && strip(U).mode?.value === '' && strip(U).bar?.opacity === 0, JSON.stringify(strip(U)));
    // The strip of a param sliders.json doesn't list has no ×10 whatever the dial's state, so the log says what the
    // tap did. Step 17 holds the "big steps on for" wording to the deck's (its debug lines).
    const tapLines = logText().split('\n').filter((l) => lineAt(l) >= t - 100 && (l.includes(`big steps on for ${UNLISTED}`) || l.includes(`dial ${U + 1} tap: ${UNLISTED} isn't in sliders.json`)));
    check(`and the plugin's log says the tap was refused, with no "big steps on for ${UNLISTED}"`, tapLines.length === 1 && tapLines[0].includes("isn't in sliders.json"), tapLines.join(' | ') || 'no line for the tap');
    inspector('propertyInspectorDidAppear', U);
    await sleep(50);
    const t2 = now();
    askSliders(U);
    await waitFor(`its Property Inspector's answer names the dial's own param, ${UNLISTED}, which isn't among the ${WATCH.length} sliders it lists`, () => {
      const r = slidersReply(t2, dialContext(U));
      return r?.param === UNLISTED && same(r.items?.map((x) => x.param), WATCH);
    }, 2000, () => JSON.stringify(slidersReply(t2, dialContext(U)) ?? 'no answer'));
    inspector('propertyInspectorDidDisappear', U);
    await showPage(0, 'back to page 1');
  }

  // ---------------------------------------------------------------------------------------------------------
  section("3e. The dial's Property Inspector");
  {
    await sleep(300);
    const ctx = dialContext(CONTRAST);
    inspector('propertyInspectorDidAppear', CONTRAST);
    await sleep(50);
    let t = now();
    askSliders(CONTRAST);
    const items = SLIDERS.map((s) => ({ param: s.param, label: s.label }));
    await waitFor(`after propertyInspectorDidAppear, sendToPlugin getSliders gets the ${WATCH.length} sliders in sliders.json's order, with their labels, and dial 4's param, Contrast`, () => {
      const r = slidersReply(t, ctx);
      return r !== undefined && same(r.items, items) && r.param === 'Contrast';
    }, 2000, () => JSON.stringify(slidersReply(t, ctx) ?? 'no answer'));
    touch(CONTRAST);
    await waitFor('a tap turns big steps on for Contrast', () => bigOn(CONTRAST), 1000, () => bigWhy(CONTRAST));
    await sleep(100);
    t = now();
    chooseSlider(CONTRAST, 'Dehaze');
    const dehaze = display(sliderOf('Dehaze'), value('Dehaze'), rangeOf('Dehaze'));
    await waitFor(`choosing Dehaze there (didReceiveSettings) repaints dial 4 at once, with the mock's ${dehaze}, and its big steps go off`,
      () => strip(CONTRAST).label?.value === 'Dehaze' && shown(CONTRAST) === dehaze && bigOff(CONTRAST), 500, () => `${strip(CONTRAST).label?.value} "${shown(CONTRAST)}"; ${bigWhy(CONTRAST)}`);
    await sleep(300);
    const others = stripEvents.filter((e) => e.at >= t && e.context !== ctx);
    check('only that dial repainted, and Lightroom got nothing: Dehaze is already watched', others.length === 0 && cmdsSince(t, (c) => c.t !== 'ping').length === 0, `repainted ${others.map((e) => e.context).join(', ') || 'no other dial'}; ${describeCmds(t)}`);
    check('the plugin saved no settings of its own', settingsSaved(t).length === 0, settingsSaved(t).join('; '));
    t = now();
    askSliders(CONTRAST);
    await waitFor("asked again, the plugin names the dial's new param, Dehaze", () => slidersReply(t, ctx)?.param === 'Dehaze', 2000, () => JSON.stringify(slidersReply(t, ctx) ?? 'no answer'));
    chooseSlider(CONTRAST, 'Contrast');
    await waitFor("choosing Contrast again puts it back on dial 4, with the mock's value", () => stripsMatch(), 1000, stripsWhy);
    inspector('propertyInspectorDidDisappear', CONTRAST);
    await sleep(300);
  }
  quiet.to = now();

  // ---------------------------------------------------------------------------------------------------------
  section('4. Keys');
  {
    const flagKeysWhy = () => {
      const s = st();
      return `${describeMock()}; flags ${JSON.stringify(Object.fromEntries(Object.entries(s.photos).map(([id, p]) => [id, p.flag])))}; strips ${stripMismatches().join('; ') || 'match'}`;
    };
    const flagStep = async (k, v, from, to, flag, word) => {
      const t = now();
      await press(KEYS[k]);
      await waitFor(`${word} (advance on by default) flags ${from} in the mock and moves to ${to}; the strips show ${to}'s values`, () => {
        const s = st();
        return cmdsSince(t, (c) => c.t === 'flag' && c.v === v && c.advance === true).length === 1 && s.photos[from].flag === flag && s.target === to && stripsMatch();
      }, 3000, flagKeysWhy);
    };
    await flagStep('pick', 'pick', '101', '102', 1, 'Pick');
    await flagStep('reject', 'reject', '102', '103', -1, 'Reject');
    await flagStep('unflag', 'none', '103', '104', 0, 'Unflag');
    await waitFor("the flag keys show the new target's flag", () => {
      const flag = st().photos[st().target].flag;
      return image(KEYS.pick.context).includes(flag === 1 ? '>Picked<' : '>Pick<') && image(KEYS.reject.context).includes(flag === -1 ? '>Rejected<' : '>Reject<') && image(KEYS.unflag.context).includes(flag === 0 ? '>Unflagged<' : '>Unflag<');
    }, 2000, () => ['pick', 'reject', 'unflag'].map((k) => `${k} ${image(KEYS[k].context).match(/>([^<]+)</g)?.join('')}`).join('; '));

    const moves = [
      ['next', '105', 'Next moves the mock to 105, and the strips follow'],
      ['next', '106', 'Next again moves it to 106, a JPEG: the Temp strip shows slider units, not Kelvin'],
      ['prev', '105', 'Previous moves it back to 105'],
      ['prev', '104', 'and again to 104'],
    ];
    for (const [k, to, name] of moves) {
      const t = now();
      await press(KEYS[k]);
      await waitFor(name, () => cmdsSince(t, (c) => c.t === 'nav' && c.v === k).length === 1 && st().target === to && stripsMatch(), 3000, stripsWhy);
    }
    const jpeg = newRanges('106');
    check("on 106, a JPEG, the mock's ranges give the newer sliders the same as on raw files: Sharpness 0…150, LuminanceSmoothing 0…100, GrainAmount 0…100, Dehaze -100…100", jpeg.ok, jpeg.why);

    let t = now();
    keyMsg('keyDown', KEYS.ba);
    await waitFor('Before/After shows before while held (the mock\'s view is before; the key says Before)', () => cmdsSince(t, (c) => c.t === 'view' && c.v === 'before').length === 1 && st().view === 'before' && image(KEYS.ba.context).includes('>Before<'), 2000, () => `view ${st().view}`);
    await sleep(300);
    keyMsg('keyUp', KEYS.ba);
    await waitFor('and the loupe after release', () => cmdsSince(t, (c) => c.t === 'view' && c.v === 'after').length === 1 && st().view === 'loupe' && image(KEYS.ba.context).includes('>Before/After<'), 2000, () => `view ${st().view}`);

    t = now();
    await press(KEYS.preset);
    await waitFor(`Apply Preset gives the mock's target photo (104) "${PRESET.name}", and the key shows ok`, () => {
      const applied = mock.control.expect({ applied: { 104: [PRESET.uuid] } });
      return applied.ok && cmdsSince(t, (c) => c.t === 'preset' && c.uuid === PRESET.uuid).length === 1 && fromPluginSince(t, (m) => m.event === 'showOk' && m.context === KEYS.preset.context).length === 1;
    }, 3000, () => mock.control.expect({ applied: { 104: [PRESET.uuid] } }).errors.join('; '));

    toPlugin({ event: 'propertyInspectorDidAppear', action: `${UUID}.preset`, context: KEYS.preset.context, device: DEVICE });
    await sleep(50);
    t = now();
    toPlugin({ event: 'sendToPlugin', action: `${UUID}.preset`, context: KEYS.preset.context, payload: { t: 'getPresets', refresh: true } });
    await waitFor(`the preset Property Inspector gets the mock's ${SCENARIO.presets.length} presets`, () => fromPluginSince(t, (m) => m.event === 'sendToPropertyInspector' && m.payload?.t === 'presets' && m.payload.items?.length === SCENARIO.presets.length && !m.payload.error).length === 1, 3000, () => JSON.stringify(fromPluginSince(t, (m) => m.event === 'sendToPropertyInspector')));
  }

  // ---------------------------------------------------------------------------------------------------------
  section('5. A mouse edit in the mock');
  {
    const from = value('Contrast');
    mock.control.user({ edit: { Contrast: 37 } });
    await waitFor(`a mouse edit of Contrast (${from} to 37 on 104) reaches the Contrast strip`, () => shown(CONTRAST) === '+37' && stripsMatch(), 2000, stripsWhy);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('6. A photo change in the mock mid-gesture, while ticks keep coming');
  {
    const X = st().target;
    const Y = '108';
    const xBase = value('Exposure', X);
    const yBase = value('Exposure', Y);
    const alerts0 = alerts().length;
    const history0 = st().history.length;
    const t = now();
    let tSwitch = 0;
    let ticksAfter = 0;
    for (let i = 0; i < 30; i += 1) {
      if (i === 10) {
        // Just after a poll, so the next tick's set reaches the mock well before the poll that would notice the
        // switch: Lightroom refuses it as stale before the deck has seen the new photo. (Ending that gesture runs
        // the mock's observer, which then sends the new photo's state, as the plugin's afterAdjustment does.)
        await mock.control.nextPoll();
        tSwitch = now();
        mock.control.user({ photo: Y });
      }
      rotate(EXPOSURE, 1);
      if (tSwitch) ticksAfter += 1;
      await sleep(50);
    }
    const tStop = now();
    await until(() => !st().tracking && cmdsSince(tStop - 50, (c) => c.t === 'done').length >= 1, 3000);
    await sleep(400);
    errWindows.push({ from: tSwitch, to: now(), codes: ['stale'] });

    const acks = sentSince(t, (o) => o.t === 'ack' && o.p === 'Exposure');
    const oldGs = new Set(acks.filter((a) => a.target === X).map((a) => a.obj.g));
    const onY = acks.filter((a) => a.target === Y);
    const hi = yBase + (ticksAfter + 2) * STEP + 0.006;
    const leaks = onY.filter((a) => oldGs.has(a.obj.g) || a.obj.v < yBase - 0.006 || a.obj.v > hi);
    check(`no value worked out from ${X}'s Exposure (${xBase} and up) lands on ${Y} (${yBase})`, oldGs.size > 0 && onY.length > 0 && leaks.length === 0,
      `old g ${[...oldGs].join(', ')}; acks on ${Y}: ${onY.map((a) => `${a.obj.v} (g ${a.obj.g})`).join(', ') || 'none'}${leaks.length ? `; leaks: ${leaks.map((a) => a.obj.v).join(', ')}` : ''}`);
    const staleErrs = sentSince(tSwitch, (o) => o.t === 'err');
    const staleIds = new Set(staleErrs.map((e) => e.obj.id));
    const refusedSets = cmdsSince(tSwitch, (c) => c.t === 'set' && staleIds.has(c.id));
    check(`Lightroom ended the old gesture as stale; any set it refused was the old gesture's (${staleErrs.length} err stale)`,
      staleErrs.every((e) => e.obj.code === 'stale' && e.obj.cmd === 'set') && refusedSets.every((c) => oldGs.has(c.g)) && st().history.slice(history0).some((h) => h.kind === 'gesture' && h.photo === X && h.stale),
      `errs ${staleErrs.map((e) => e.obj.code).join(', ') || 'none'}; history ${JSON.stringify(st().history.slice(history0).map((h) => [h.kind, h.photo, h.g, h.from, h.to, h.why]))}`);
    // PROTOCOL.md, Gestures, "The deck on stale": no done after err stale; a done sent on seeing the new photo's
    // state first is late, and Lightroom ignores it.
    const errAt = staleErrs[0]?.at;
    const stateAt = sent.find((s) => s.at >= tSwitch && s.obj.t === 'state' && s.obj.photo === Y)?.at;
    const oldDone = received.filter((r) => r.at >= tSwitch && r.cmd?.t === 'done' && oldGs.has(r.cmd.g));
    const errFirst = errAt !== undefined && (stateAt === undefined || errAt < stateAt);
    check(`the err stale reached the deck before ${Y}'s state, and the deck ended the old gesture without done`, errFirst && oldDone.length === 0,
      `${errAt === undefined ? 'no err' : errFirst ? 'err first' : `state ${Math.round(errAt - stateAt)} ms before the err`}; ${oldDone.length} done for g ${[...oldGs].join(', ')}`);
    const xLast = acks.filter((a) => a.target === X).at(-1)?.obj.v;
    check(`${X} keeps the last value acked on it before the switch (${xLast})`, near(value('Exposure', X), xLast, 1e-9), `${value('Exposure', X)}`);
    const yNow = value('Exposure', Y);
    check(`the ticks turned after the switch move ${Y} on from its own value (${ticksAfter} ticks: ${yBase} to ${yNow})`, yNow >= yBase + (ticksAfter - 8) * STEP - 0.006 && yNow <= hi, `bound ${round2(yBase + (ticksAfter - 8) * STEP)} to ${round2(hi)}`);
    await waitFor(`the strips show ${Y}'s values`, () => stripsMatch(), 2000, stripsWhy);

    const t2 = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    const want = round2(yNow + 3 * STEP);
    await waitFor(`the deck keeps working: three more ticks take ${Y} from ${yNow} to ${want}`, () => near(value('Exposure', Y), want) && cmdsSince(t2, (c) => c.t === 'done').length === 1, 3000, describeMock);
    await sleep(400);
    await waitFor('and the strip shows it', () => stripsMatch(), 2000, stripsWhy);
    const climb = stripClimbsFrom(Y, yBase, tSwitch);
    check(`once the deck had ${Y}'s values, the Exposure strip only climbed from ${Y}'s ${yBase}`, climb.ok, climb.texts);
    check('the photo change raised no alert', alerts().length === alerts0, `${alerts().length - alerts0} alerts`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('6b. The same while the dial rests mid-gesture, so the deck sees the new photo first');
  {
    await sleep(300);
    const X = st().target;
    const Z = '103';
    const xBefore = value('Exposure', X);
    const zBase = value('Exposure', Z);
    const alerts0 = alerts().length;
    const history0 = st().history.length;
    const t = now();
    for (let i = 0; i < 5; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await mock.control.nextPoll();
    const tSwitch = now();
    mock.control.user({ photo: Z });
    await sleep(450); // the dial rests; the next poll tells the deck about Z, well inside the 800 ms before done
    const tResume = now();
    for (let i = 0; i < 6; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await until(() => !st().tracking && cmdsSince(tResume, (c) => c.t === 'done').length >= 1, 3000);
    await sleep(400);

    const acks = sentSince(t, (o) => o.t === 'ack' && o.p === 'Exposure');
    const oldGs = new Set(acks.filter((a) => a.target === X).map((a) => a.obj.g));
    const xLast = acks.filter((a) => a.target === X).at(-1)?.obj.v;
    const stateAt = sent.find((s) => s.at >= tSwitch && s.obj.t === 'state' && s.obj.photo === Z)?.at;
    const oldDone = received.filter((r) => r.at >= tSwitch && r.cmd?.t === 'done' && oldGs.has(r.cmd.g));
    const oldStep = st().history.slice(history0).filter((h) => h.kind === 'gesture' && h.photo === X);
    check(`the deck ended the old gesture on ${Z}'s state with one late done, which changed nothing in the mock`,
      oldGs.size === 1 && stateAt !== undefined && oldDone.length === 1 && oldDone[0].at > stateAt && oldStep.length === 1 && oldStep[0].stale && near(value('Exposure', X), xLast, 1e-9) && sentSince(tSwitch, (o) => o.t === 'err').length === 0,
      `${oldDone.length} done for g ${[...oldGs].join(', ')}; ${X} went from ${xBefore} to ${value('Exposure', X)}; history ${JSON.stringify(oldStep.map((h) => [h.g, h.why, h.stale]))}; errs ${sentSince(tSwitch, (o) => o.t === 'err').length}`);
    const onZ = acks.filter((a) => a.target === Z);
    const want = round2(zBase + 6 * STEP);
    check(`the next turn is a new gesture from ${Z}'s own value (6 ticks: ${zBase} to ${want})`,
      onZ.length > 0 && onZ.every((a) => !oldGs.has(a.obj.g) && a.obj.v >= zBase - 0.006 && a.obj.v <= want + 0.006) && near(value('Exposure', Z), want),
      `acks on ${Z}: ${onZ.map((a) => `${a.obj.v} (g ${a.obj.g})`).join(', ') || 'none'}; ${Z} is at ${value('Exposure', Z)}`);
    await waitFor(`the strips show ${Z}'s values`, () => stripsMatch(), 2000, stripsWhy);
    const climb = stripClimbsFrom(Z, zBase, tSwitch);
    check(`once the deck had ${Z}'s values, the Exposure strip only climbed from ${Z}'s ${zBase}`, climb.ok, climb.texts);
    check('no alert either', alerts().length === alerts0, `${alerts().length - alerts0} alerts`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('7. Library');
  {
    mock.control.user({ module: 'library' });
    await waitFor('when the user switches the mock to Library, the strips dim and keep their last values', () => DIALS.every(dimmed) && stripsMatch(), 2000, stripsWhy);
    DIM = { fill: strip(EXPOSURE).bar?.bar_fill_c };
    const base = value('Exposure');
    const t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    const want = round2(base + 3 * STEP);
    await waitFor(`a turn in Library switches the mock to Develop and applies (3 ticks: ${base} to ${want})`, () => st().module === 'develop' && near(value('Exposure'), want), 3000, describeMock);
    const cmds = cmdsSince(t, (c) => c.t !== 'ping');
    const firstSet = cmds.findIndex((c) => c.t === 'set');
    const moduleAt = cmds.findIndex((c) => c.t === 'module' && c.v === 'develop');
    const valsAt = sent.find((s) => s.at >= t && s.obj.t === 'vals' && 'Exposure' in s.obj.vals)?.at ?? Infinity;
    const setAt = received.find((r) => r.at >= t && r.cmd?.t === 'set')?.at ?? -Infinity;
    check('it sent module develop first, once, and the first set only after the mock\'s vals for Develop', moduleAt === 0 && cmds.filter((c) => c.t === 'module').length === 1 && firstSet > moduleAt && setAt > valsAt, cmds.map((c) => c.t).join(', '));
    await waitFor('the strips light up again with the mock\'s values', () => DIALS.every(lit) && stripsMatch(), 2000, stripsWhy);

    // 7b: big steps outside Develop (plan.md, Phase 7: taps work there, and held turns keep their mode). The
    // switch to Develop takes 300 ms this time, so every click of the turn waits for it.
    await sleep(1000); // the gesture above has ended
    mock.control.options({ moduleDelayMs: 300 });
    let t2 = now();
    mock.control.user({ module: 'library' });
    await waitFor('back in Library, the strips dim again', () => sentSince(t2, (o) => o.t === 'state' && o.module === 'library').length === 1 && DIALS.every(dimmed) && stripsMatch(), 2000, stripsWhy);
    t2 = now();
    touch(EXPOSURE);
    await waitFor('a tap there turns big steps on for Exposure: ×10 and the bar fill in dimmed green', () => bigOnDimmed(EXPOSURE), 1000, () => bigWhy(EXPOSURE));
    await sleep(100);
    check('the tap sent Lightroom nothing, not even module develop', cmdsSince(t2, (c) => c.t !== 'ping').length === 0, describeCmds(t2));
    const bigBase = value('Exposure');
    const bigWant = round2(bigBase + 3 * MACRO);
    t2 = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await waitFor(`then three clicks switch the mock to Develop and move Exposure three big steps, 1 EV: ${bigBase} to ${bigWant}`, () => st().module === 'develop' && near(value('Exposure'), bigWant), 3000, describeMock);
    const bigCmds = cmdsSince(t2, (c) => c.t !== 'ping');
    const bigSets = bigCmds.filter((c) => c.t === 'set');
    const bigValsAt = sent.find((s) => s.at >= t2 && s.obj.t === 'vals' && 'Exposure' in s.obj.vals)?.at ?? Infinity;
    const bigSetAt = received.find((r) => r.at >= t2 && r.cmd?.t === 'set')?.at ?? -Infinity;
    const heldTicks = tickRecords(logText()).filter((r) => r.at >= t2 - 50).map((r) => [r.col, r.ticks, r.mode, r.result]);
    check(`the clicks were held as big steps (TICK mode macro, held) until the mock's vals for Develop, then went out as big steps, ending at ${bigWant}`,
      bigCmds[0]?.t === 'module' && bigCmds.filter((c) => c.t === 'module').length === 1 && bigSetAt > bigValsAt && bigSets.length >= 1 && near(bigSets.at(-1).v, bigWant) && same(heldTicks, [[2, 1, 'macro', 'held'], [2, 1, 'macro', 'held'], [2, 1, 'macro', 'held']]),
      `${bigCmds.map((c) => (c.v === undefined ? c.t : `${c.t} ${c.v}`)).join(', ')}; TICK ${JSON.stringify(heldTicks)}`);
    await waitFor('in Develop the strips light up, and Exposure\'s shows ×10 in the live green: big steps are still on', () => bigOn(EXPOSURE) && DIALS.every(lit), 1000, () => `${bigWhy(EXPOSURE)}; ${stripsWhy()}`);
    mock.control.options({ moduleDelayMs: 0 });
    await waitFor(`and they go off by themselves, ${MACRO_MS / 1000} s after the last click`, () => bigOff(EXPOSURE) && stripsMatch(), MACRO_MS + 1000, () => `${bigWhy(EXPOSURE)}; ${stripsWhy()}`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('8. Recovery');
  {
    // 8a: Reload Plug-in, or a quick quit and relaunch: a new inst and an empty watch list. Dials 1 and 2 first
    // get other sliders in their Property Inspectors: a new inst drops the deck's values and ranges, but each dial
    // keeps its slider.
    await sleep(1000); // the gesture from step 7 has ended
    chooseSlider(TEMP, 'Dehaze');
    chooseSlider(TINT, 'Sharpness');
    await waitFor('the Property Inspector first gives dials 1 and 2 Dehaze and Sharpening', () => stripsMatch(), 2000, stripsWhy);
    const inst = st().inst;
    let t = now();
    const relaunched = mock.control.relaunch({ downMs: 500 });
    await waitFor('when the mock relaunches with a new inst, the strips say Offline meanwhile and the keys dim', () => DIALS.every((c) => sawShown(c, 'Offline', t)) && nextKeyDimmedSince(t), 3000, () => DIALS.map(shown).join(', '));
    await relaunched;
    await waitFor('the deck reconnects and the new instance greets it', () => st().inst !== inst && sentSince(t, (o) => o.t === 'hello' && o.inst === st().inst).length > 0, 6000, describeMock);
    await waitFor(`the deck watches the ${WATCH.length} sliders again`, () => cmdsSince(t, (c) => c.t === 'watch' && same(c.ps, WATCH)).length >= 1 && same(st().watch, WATCH), 4000, () => `mock watches ${st().watch.join(', ') || 'nothing'}`);
    await waitFor("after the new inst the dials keep their sliders: Dehaze, Sharpening, Exposure and Contrast come back with the mock's values, and the keys light up", () => stripsMatch() && DIALS.every(lit) && image(KEYS.next.context) === NEXT_LIT, 4000, stripsWhy);

    // 8b: the event socket goes stale: oks keep coming, events vanish.
    await sleep(500);
    let conns = { ...st().clients.connections };
    t = now();
    mock.control.stale();
    await waitFor('when the mock\'s event socket goes stale, the deck reconnects both sockets', () => {
      const c = st().clients;
      return c.connections.cmd > conns.cmd && c.connections.evt > conns.evt && c.greeted && !c.stale;
    }, 12000, describeMock);
    // From the last event that reached the deck (after stale() they vanish) to the deck closing its sockets.
    const lastEvent = sent.filter((s) => s.gen === gen && s.at < t).at(-1)?.at;
    const closedAt = mockLog.find((l) => l.gen === gen && l.at >= t && l.text === 'cmd: client closed')?.at;
    const quiet = closedAt - lastEvent;
    check('it gave up on the event socket after 6 s without events, as PROTOCOL.md\'s heartbeat says', quiet >= 5900 && quiet <= 6800, `${Math.round(quiet)} ms from the last event that reached it`);
    check('the strips never said Busy meanwhile: the oks kept coming', !DIALS.some((c) => sawShown(c, 'Busy', t)));
    await waitFor('the strips show the mock\'s values again', () => stripsMatch() && DIALS.every(lit), 4000, stripsWhy);
    check('the plugin logged the stale event socket', logCount(/the event socket is stale/) === 1, `${logCount(/the event socket is stale/)} lines`);

    // 8c: a menu opens in Lightroom: no oks, no events.
    await sleep(500);
    conns = { ...st().clients.connections };
    t = now();
    pauses.push([t, t + 6300]);
    mock.control.pause(6000);
    await waitFor('while the mock is paused (a menu is open), the strips say Busy and the keys dim', () => DIALS.every((c) => shown(c) === 'Busy') && image(KEYS.next.context) !== NEXT_LIT, 6000, () => DIALS.map(shown).join(', '));
    await waitFor('when it resumes, the strips show the values again and the keys light up', () => !st().paused && stripsMatch() && DIALS.every(lit) && image(KEYS.next.context) === NEXT_LIT, 8000, stripsWhy);
    check('the deck waited instead of reconnecting', st().clients.connections.cmd === conns.cmd && st().clients.connections.evt === conns.evt && !DIALS.some((c) => sawShown(c, 'Offline', t)), JSON.stringify(st().clients.connections));

    // 8d: Lightroom quits; a fresh one starts later on the same ports.
    await sleep(500);
    const ports = { cmd: mock.cmdPort, evt: mock.evtPort };
    const retries = logCount(/can't reach Lightroom/);
    histories.push(st().history);
    await mock.stop();
    await waitFor('when the mock goes away, the strips say Offline and the keys dim', () => DIALS.every((c) => shown(c) === 'Offline') && image(KEYS.next.context) !== NEXT_LIT, 3000, () => DIALS.map(shown).join(', '));
    await sleep(3000);
    check('they still say Offline 3 s later, and the plugin keeps trying', DIALS.every((c) => shown(c) === 'Offline') && logCount(/can't reach Lightroom/) > retries, `${DIALS.map(shown).join(', ')}; ${logCount(/can't reach Lightroom/) - retries} "can't reach" lines`);
    mock = await startWatchedMock(ports);
    t = now();
    await waitFor(`when a fresh mock starts on the same ports, the deck reconnects and watches the ${WATCH.length} sliders`, () => mock.control.clients().greeted && cmdsSince(t, (c) => c.t === 'watch' && same(c.ps, WATCH)).length >= 1, 8000, describeMock);
    const connectedAt = mockLog.find((l) => l.gen === gen && l.text === 'cmd: client connected')?.at;
    check('it reconnected within the backoff\'s 2 s cap', connectedAt - t <= 2300, `${Math.round(connectedAt - t)} ms after the mock was back`);
    await waitFor("the strips come back with the fresh mock's values (photo 101 again), the dials still on Dehaze, Sharpening, Exposure and Contrast, and the keys light up", () => st().target === '101' && stripsMatch() && DIALS.every(lit) && image(KEYS.next.context) === NEXT_LIT, 4000, stripsWhy);
  }

  // ---------------------------------------------------------------------------------------------------------
  section("9. The ph race: the user moves to another photo, and the deck turns before it hears");
  {
    // Temp and Tint back on dials 1 and 2, chosen in their Property Inspectors.
    chooseSlider(TEMP, 'Temperature');
    chooseSlider(TINT, 'Tint');
    await waitFor('the Property Inspector puts Temp and Tint back on dials 1 and 2', () => stripsMatch(), 2000, stripsWhy);
    await sleep(500);
    const X = st().target;
    const [Y, Z] = st().order.filter((id) => id !== X && !st().photos[id].locked);
    const xBase = value('Exposure', X);
    const yBase = value('Exposure', Y);
    const alerts0 = alerts().length;
    const history0 = st().history.length;
    // Just after a poll, the mock stops noticing photo changes by itself (PROTOCOL.md, Gestures: "The photo the
    // deck worked from"). The user moves to Y meanwhile, so the deck's latest state still says X.
    await mock.control.nextPoll();
    mock.control.holdPoll(10_000);
    const t = now();
    mock.control.user({ photo: Y });
    rotate(EXPOSURE, 1);
    const firstSet = () => cmdsSince(t, (c) => c.t === 'set')[0];
    await waitFor(`a turn before the deck hears of ${Y}: its set carries ph ${X}, from its latest state, and Lightroom refuses it with err stale`, () => {
      const set = firstSet();
      return set !== undefined && set.ph === X && sentSince(t, (o) => o.t === 'err' && o.id === set.id && o.code === 'stale').length === 1;
    }, 1000, () => `${describeCmds(t)}; errs ${describeErrs(t)}`);
    const refused = firstSet();
    const errAt = sentSince(t, (o) => o.t === 'err')[0]?.at ?? now();
    // The deck on stale: it holds turns for the new photo, for up to 500 ms.
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(40);
    }
    check(`nothing landed on either photo: ${X} keeps ${xBase}, ${Y} keeps ${yBase}, and the three turns after the refusal sent nothing`,
      value('Exposure', X) === xBase && value('Exposure', Y) === yBase && cmdsSince(errAt, (c) => c.t === 'set').length === 0 && sentSince(t, (o) => o.t === 'ack').length === 0 && st().history.length === history0,
      `${X} ${value('Exposure', X)}, ${Y} ${value('Exposure', Y)}; sets after the err ${JSON.stringify(cmdsSince(errAt, (c) => c.t === 'set'))}; ${sentSince(t, (o) => o.t === 'ack').length} acks; history ${JSON.stringify(st().history.slice(history0))}`);
    const tRelease = now();
    mock.control.holdPoll(0);
    await mock.control.nextPoll();
    const want = round2(yBase + 3 * STEP);
    await waitFor(`once ${Y}'s state and values reach the deck, the held turns go out with ph ${Y} and move ${Y} from its own value (3 ticks: ${yBase} to ${want})`, () => {
      const sets = cmdsSince(tRelease, (c) => c.t === 'set');
      return near(value('Exposure', Y), want) && sets.length > 0 && sets.every((c) => c.ph === Y);
    }, 2000, () => `${describeMock()}; ${Y} at ${value('Exposure', Y)}; sets ${JSON.stringify(cmdsSince(tRelease, (c) => c.t === 'set'))}`);
    await until(() => !st().tracking && cmdsSince(tRelease, (c) => c.t === 'done').length >= 1, 3000);
    await sleep(400);
    const lateDones = received.filter((r) => r.at >= t && r.cmd?.t === 'done' && r.cmd.g === refused?.g).length;
    check(`${X} still has ${xBase}, and the refused gesture got no done: Lightroom had ended it`, value('Exposure', X) === xBase && refused !== undefined && lateDones === 0, `${X} ${value('Exposure', X)}; ${lateDones} done for g ${refused?.g}`);
    await waitFor(`the strips show ${Y}'s values`, () => stripsMatch(), 2000, stripsWhy);
    // The held turns paint within a ms of Y's vals, and the dial rests meanwhile, so the window starts at the vals.
    const valsAt = sent.find((s) => s.at >= tRelease && s.obj.t === 'vals' && 'Exposure' in s.obj.vals && s.target === Y)?.at;
    const texts = valsAt === undefined ? [] : shownSince(EXPOSURE, valsAt);
    check(`once the deck had ${Y}'s values, the Exposure strip showed only values from ${Y}'s ${yBase} to ${want}`,
      texts.length > 0 && texts.every((s) => Number(s) >= yBase - 0.006 && Number(s) <= want + 0.006) && texts.at(-1) === display(sliderOf('Exposure'), want, [-5, 5]), texts.join(' ') || 'nothing shown');

    // A press in the same window: the reset carries the old photo too, and Lightroom refuses it the same way.
    await sleep(300);
    const yNow = value('Exposure', Y);
    const zBase = value('Exposure', Z);
    const history1 = st().history.length;
    await mock.control.nextPoll();
    mock.control.holdPoll(10_000);
    const t2 = now();
    mock.control.user({ photo: Z });
    dialDown(EXPOSURE);
    await sleep(80);
    dialUp(EXPOSURE);
    await waitFor(`a press before the deck hears of ${Z}: its reset carries ph ${Y}, and Lightroom refuses it with err stale`, () => {
      const reset = cmdsSince(t2, (c) => c.t === 'reset')[0];
      return reset !== undefined && reset.ph === Y && sentSince(t2, (o) => o.t === 'err' && o.id === reset.id && o.code === 'stale').length === 1;
    }, 1000, () => `${describeCmds(t2)}; errs ${describeErrs(t2)}`);
    await sleep(100);
    check(`the reset landed nowhere: ${Y} keeps ${yNow} and ${Z} keeps ${zBase}`, value('Exposure', Y) === yNow && value('Exposure', Z) === zBase && st().history.length === history1 && sentSince(t2, (o) => o.t === 'ack').length === 0,
      `${Y} ${value('Exposure', Y)}, ${Z} ${value('Exposure', Z)}; history ${JSON.stringify(st().history.slice(history1))}`);
    mock.control.holdPoll(0);
    await mock.control.nextPoll();
    await waitFor(`the strips show ${Z}'s values`, () => stripsMatch(), 2000, stripsWhy);
    const t3 = now();
    for (let i = 0; i < 2; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    const want2 = round2(zBase + 2 * STEP);
    await waitFor(`the next turn works on ${Z}: 2 ticks take it from ${zBase} to ${want2}, with ph ${Z}`, () => near(value('Exposure', Z), want2) && cmdsSince(t3, (c) => c.t === 'set').every((c) => c.ph === Z) && cmdsSince(t3, (c) => c.t === 'done').length === 1, 3000, describeMock);
    await sleep(400);
    errWindows.push({ from: t, to: now(), codes: ['stale'] });
    check('the ph race raised no alert', alerts().length === alerts0, `${alerts().length - alerts0} alerts`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('10. Locked photos');
  {
    // 10a: a background AI process, such as Denoise, locks the photo while a turn is still open.
    await sleep(300);
    const X = st().target;
    let base = value('Exposure');
    const history0 = st().history.length;
    let t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    const lastTick = now() - 50;
    await sleep(60); // every set is out, and done is still 700 ms away
    const tLock = now();
    mock.control.user({ locked: [X] });
    const lockedState = () => sentSince(tLock, (o) => o.t === 'state' && o.locked === true)[0];
    await waitFor(`a background process locks ${X} mid-turn: the mock's next poll sends state.locked, and the strips say Locked, dimmed`, () => lockedState() !== undefined && stripsMatch('Locked') && DIALS.every(dimmed), 1000, () => stripsWhy('Locked'));
    const lockedAt = lockedState()?.at ?? Infinity;
    const done = received.find((r) => r.at >= t && r.cmd?.t === 'done');
    check('the deck ended the open turn with done as soon as it saw state.locked, not 800 ms after its last tick', done !== undefined && done.at >= lockedAt && done.at - lockedAt < 100 && done.at - lastTick < 700,
      done === undefined ? 'no done' : `${Math.round(done.at - lockedAt)} ms after state.locked, ${Math.round(done.at - lastTick)} ms after the last tick`);
    await sleep(100);
    let want = round2(base + 3 * STEP);
    const steps = st().history.slice(history0);
    check(`no set after state.locked: the turn is one history step, ended by that done, and ${X} keeps its last value (${want})`,
      cmdsSince(lockedAt, (c) => c.t === 'set').length === 0 && steps.length === 1 && steps[0].kind === 'gesture' && steps[0].why === 'done' && near(value('Exposure'), want, 1e-9), `${value('Exposure')}; history ${JSON.stringify(steps)}`);

    // 10b: while it's locked, every turn and press on a dial does nothing but alert that dial, once per burst.
    await sleep(1100);
    const before = JSON.stringify(st().photos[X].values);
    t = now();
    for (let i = 0; i < 5; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    for (let i = 0; i < 3; i += 1) {
      rotate(CONTRAST, -1);
      await sleep(50);
    }
    dialDown(TINT);
    await sleep(30);
    rotate(TINT, 2, true);
    await sleep(45);
    rotate(TINT, 2, true);
    await sleep(45);
    dialUp(TINT);
    await sleep(100);
    await sleep(1200); // a new burst on Exposure's dial, past the 1 s between alerts
    dialDown(EXPOSURE);
    await sleep(80);
    dialUp(EXPOSURE);
    await sleep(300);
    alertWindows.push({ from: t, to: now(), contexts: DIALS.map(dialContext) });
    const counts = alertCounts(t);
    check('while locked, turns, push + turn and a press send Lightroom nothing', cmdsSince(t, (c) => c.t !== 'ping').length === 0, describeCmds(t));
    check('each dial alerts once per burst: Tint (push + turn) and Contrast (turn) once, Exposure twice (a turn, then a press 1.2 s later)',
      counts['dial-1'] === 1 && counts['dial-3'] === 1 && counts['dial-2'] === 2 && Object.keys(counts).length === 3, JSON.stringify(counts));
    check(`${X}'s values didn't move, and the strips still say Locked`, JSON.stringify(st().photos[X].values) === before && stripsMatch('Locked'), stripsWhy('Locked'));

    // 10c: taps still switch big steps on and off, and send nothing; turns and presses are still refused.
    await sleep(1100);
    t = now();
    touch(TEMP);
    await waitFor('while locked, a tap still turns big steps on (Temp): ×10 and the bar fill in dimmed green, and the strip still says Locked', () => bigOnDimmed(TEMP) && shown(TEMP) === 'Locked', 1000, () => `"${shown(TEMP)}"; ${bigWhy(TEMP)}`);
    touch(TINT, true);
    await waitFor('so does a long touch (Tint)', () => bigOnDimmed(TINT) && shown(TINT) === 'Locked', 1000, () => `"${shown(TINT)}"; ${bigWhy(TINT)}`);
    await sleep(100);
    check('the tap and the long touch sent Lightroom nothing and raised no alert', cmdsSince(t, (c) => c.t !== 'ping').length === 0 && alerts().filter((m) => m.at >= t).length === 0, `${describeCmds(t)}; ${JSON.stringify(alertCounts(t))}`);
    const tRefused = now();
    rotate(TEMP, 1);
    await sleep(300);
    check("with big steps on, a turn is still refused while locked: Temp's dial alerts once, and nothing goes out", alertsOn(dialContext(TEMP), tRefused) === 1 && alerts().filter((m) => m.at >= tRefused).length === 1 && cmdsSince(tRefused, (c) => c.t !== 'ping').length === 0, `${describeCmds(tRefused)}; ${JSON.stringify(alertCounts(tRefused))}`);
    const tPress = now();
    dialDown(TINT);
    await waitFor("pressing Tint's dial turns its big steps off at dial-down: no ×10, and the plain dimmed fill", () => bigOffDimmed(TINT) && offSoon(TINT, tPress), 1000, () => `${bigWhy(TINT)}; ${offWhen(TINT, tPress)}`);
    dialUp(TINT);
    await sleep(300);
    check('and the press is still refused: one alert, no reset', alertsOn(dialContext(TINT), tPress) === 1 && alerts().filter((m) => m.at >= tPress).length === 1 && cmdsSince(tPress, (c) => c.t !== 'ping').length === 0, `${describeCmds(tPress)}; ${JSON.stringify(alertCounts(tPress))}`);
    alertWindows.push({ from: tRefused, to: now(), contexts: [dialContext(TEMP), dialContext(TINT)] });
    t = now();
    touch(TEMP);
    await waitFor("another tap turns Temp's off at once: every strip says Locked, with no ×10 and the plain dimmed fill", () => stripsMatch('Locked') && bigOffDimmed(TEMP) && offSoon(TEMP, t), 1000, () => `${stripsWhy('Locked')}; ${bigWhy(TEMP)}; ${offWhen(TEMP, t)}`);
    await pageRound("a page switch while locked shows that page's sliders, all Locked", 'Locked');
    check('the tap and the page switches sent nothing and raised no alert', cmdsSince(t, (c) => c.t !== 'ping').length === 0 && alerts().filter((m) => m.at >= t).length === 0, `${describeCmds(t)}; ${JSON.stringify(alertCounts(t))}`);

    // 10d: outside Develop a locked dial doesn't ask for Develop either.
    t = now();
    mock.control.user({ module: 'library' });
    await waitFor('the user moves the mock to Library: its state still says locked, and so do the strips', () => sentSince(t, (o) => o.t === 'state' && o.module === 'library' && o.locked === true).length === 1 && stripsMatch('Locked'), 1000, () => stripsWhy('Locked'));
    await sleep(1100);
    t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await sleep(300);
    alertWindows.push({ from: t, to: now(), contexts: [dialContext(EXPOSURE)] });
    check('a turn in Library sends no module develop, nothing at all: the mock stays in Library, and the dial alerts once',
      cmdsSince(t, (c) => c.t !== 'ping').length === 0 && st().module === 'library' && alertsOn(dialContext(EXPOSURE), t) === 1 && alerts().filter((m) => m.at >= t).length === 1, `${describeCmds(t)}; module ${st().module}; ${JSON.stringify(alertCounts(t))}`);
    t = now();
    mock.control.user({ module: 'develop' });
    await waitFor('back in Develop and still locked, the strips still say Locked', () => sentSince(t, (o) => o.t === 'state' && o.module === 'develop' && o.locked === true).length === 1 && stripsMatch('Locked'), 1000, () => stripsWhy('Locked'));

    // 10e: the process finishes.
    await sleep(300);
    const tUnlock = now();
    mock.control.user({ locked: [] });
    await waitFor('when the process finishes, the next state says locked false, and the strips show the values again, lit', () => sentSince(tUnlock, (o) => o.t === 'state' && o.locked === false).length === 1 && stripsMatch() && DIALS.every(lit), 1000, stripsWhy);
    base = value('Exposure');
    t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    want = round2(base + 3 * STEP);
    await waitFor(`turns work again: 3 ticks take Exposure from ${base} to ${want}`, () => near(value('Exposure'), want) && cmdsSince(t, (c) => c.t === 'done').length === 1, 3000, describeMock);
    await sleep(400);
    check('with no alert since the unlock', alerts().filter((m) => m.at >= tUnlock).length === 0, JSON.stringify(alertCounts(tUnlock)));

    // 10f: a set that crosses state.locked on the wire. Lightroom sends state.locked from the poll that reads the
    // lock, so err locked only meets a set the deck sent before that state reached it. Here the mock's events
    // reach the deck 300 ms late, which widens that window from a fraction of a ms to 300 ms.
    await sleep(1000);
    base = value('Exposure');
    const history2 = st().history.length;
    mock.control.delayEvents(300);
    mock.control.user({ locked: [X] });
    await mock.control.nextPoll(); // it has read the lock: from now on set gets err locked
    const tRead = now();
    rotate(EXPOSURE, 1);
    await sleep(50);
    rotate(EXPOSURE, 1);
    const lockedEvt = () => sentSince(tRead - 50, (o) => o.t === 'state' && o.locked === true)[0];
    await waitFor('the delayed state.locked and both errs reach the deck', () => lockedEvt() !== undefined && sentSince(tRead, (o) => o.t === 'err').length === 2 && mock.control.clients().delayed === 0, 2000, () => `${describeCmds(tRead)}; errs ${describeErrs(tRead)}; ${mock.control.clients().delayed} events still on their way`);
    mock.control.delayEvents(0);
    const stAt = lockedEvt()?.at ?? Infinity;
    const sets = received.filter((r) => r.at >= tRead && r.cmd?.t === 'set');
    const errs = sentSince(tRead, (o) => o.t === 'err');
    check(`the deck sent ${sets.length} sets, with ph ${X}, after the mock's poll read the lock but before state.locked reached it: Lightroom refused each with err locked`,
      sets.length === 2 && sets.every((r) => r.at < stAt && r.cmd.ph === X && errs.some((e) => e.obj.id === r.cmd.id && e.obj.code === 'locked')), `${describeCmds(tRead)}; errs ${describeErrs(tRead)}`);
    check('the errs reached the deck after state.locked, as from Lightroom: the order of one event socket', errs.length === 2 && errs.every((e) => e.at >= stAt), errs.map((e) => `${Math.round(e.at - stAt)} ms`).join(', '));
    const dones = received.filter((r) => r.at >= tRead && r.cmd?.t === 'done');
    check('the deck ended that gesture with one done, as state.locked reached it', dones.length === 1 && dones[0].cmd.g === sets[0]?.cmd.g && dones[0].at >= stAt && dones[0].at - stAt < 100, JSON.stringify(dones.map((r) => [r.cmd.g, Math.round(r.at - stAt)])));
    check(`err locked alerted Exposure's dial once, and nothing changed: ${X} keeps ${base}, with no history step`,
      alertsOn(dialContext(EXPOSURE), tRead) === 1 && alerts().filter((m) => m.at >= tRead).length === 1 && value('Exposure') === base && st().history.length === history2, `${JSON.stringify(alertCounts(tRead))}; ${value('Exposure')}; history ${JSON.stringify(st().history.slice(history2))}`);
    await waitFor('the strips say Locked', () => stripsMatch('Locked'), 1000, () => stripsWhy('Locked'));
    alertWindows.push({ from: tRead, to: now(), contexts: [dialContext(EXPOSURE)] });
    errWindows.push({ from: tRead, to: now(), codes: ['locked'] });
    t = now();
    mock.control.user({ locked: [] });
    await waitFor('unlocked again, the strips show the values, lit', () => sentSince(t, (o) => o.t === 'state' && o.locked === false).length === 1 && stripsMatch() && DIALS.every(lit), 1000, stripsWhy);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('11. Read-only: another catalog is open');
  {
    await sleep(600);
    const alerts0 = alerts().length;
    let t = now();
    await mock.control.relaunch({ downMs: 500, catalog: OTHER_CATALOG });
    must(await waitFor('when the mock relaunches with another catalog open, its hello says writable false; the deck watches again, and the strips show its values, dimmed',
      () => sentSince(t, (o) => o.t === 'hello' && o.writable === false).length > 0 && cmdsSince(t, (c) => c.t === 'watch' && sameSet(c.ps, WATCH)).length >= 1 && stripsMatch() && DIALS.every(dimmed), 6000, stripsWhy));
    await waitFor('Apply Preset dims as well, since it writes, while Next stays lit', () => image(KEYS.preset.context) !== PRESET_LIT && image(KEYS.next.context) === NEXT_LIT, 2000);
    await sleep(300);
    const target = st().target;
    const base = value('Exposure');
    const cBase = value('Contrast');
    const flag = st().photos[target].flag;
    const applied0 = st().photos[target].applied.length;
    const bezels0 = st().bezels;
    // A burst's one set, for its first event of one click: a step from the value, or a big step with them on.
    const probe = (from, want = round2(base + STEP)) => {
      const sets = cmdsSince(from, (c) => c.t === 'set');
      const errs = sentSince(from, (o) => o.t === 'err');
      return sets.length === 1 && sets[0].p === 'Exposure' && sets[0].ph === target && near(sets[0].v, want) && errs.length === 1 && errs[0].obj.id === sets[0].id && errs[0].obj.code === 'guard';
    };
    const tReadOnly = now();
    t = now();
    for (let i = 0; i < 5; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await sleep(200);
    check(`a turn of 5 events sends one set, for its first, one step on (${round2(base + STEP)}), with ph; Lightroom refuses it with err guard`, probe(t), `${describeCmds(t)}; errs ${describeErrs(t)}`);
    check(`the Exposure dial alerts once, and nothing moves: the mock and the strip keep ${base}`, alertsOn(dialContext(EXPOSURE), t) === 1 && value('Exposure') === base && stripsMatch(), `${JSON.stringify(alertCounts(t))}; ${stripsWhy()}`);
    check("Lightroom's bezel says why: one, the most it shows in 5 s", st().bezels === bezels0 + 1, `${st().bezels - bezels0} bezels`);
    await sleep(1200);
    t = now();
    rotate(EXPOSURE, 1);
    await sleep(50);
    rotate(EXPOSURE, 1);
    await sleep(200);
    check('a second burst 1.2 s later sends one more set, refused the same way, with another alert', probe(t) && alertsOn(dialContext(EXPOSURE), t) === 1 && value('Exposure') === base, `${describeCmds(t)}; errs ${describeErrs(t)}; ${JSON.stringify(alertCounts(t))}`);
    // Big steps while read-only (plan.md, Phase 7: taps work in every state, and the probe uses the mode's step).
    await sleep(1200);
    t = now();
    touch(EXPOSURE);
    await waitFor('read-only, a tap still turns big steps on for Exposure: ×10 and the bar fill in dimmed green', () => bigOnDimmed(EXPOSURE), 1000, () => bigWhy(EXPOSURE));
    await sleep(100);
    check('the tap sent Lightroom nothing and raised no alert', cmdsSince(t, (c) => c.t !== 'ping').length === 0 && alerts().filter((m) => m.at >= t).length === 0, `${describeCmds(t)}; ${JSON.stringify(alertCounts(t))}`);
    t = now();
    rotate(EXPOSURE, 1);
    await sleep(50);
    rotate(EXPOSURE, 1);
    await sleep(200);
    check(`with big steps on, a burst's one set is a big step on (${round2(base + MACRO)}), refused the same way, with another alert, and nothing moves`,
      probe(t, round2(base + MACRO)) && alertsOn(dialContext(EXPOSURE), t) === 1 && value('Exposure') === base, `${describeCmds(t)}; errs ${describeErrs(t)}; ${JSON.stringify(alertCounts(t))}`);
    t = now();
    touch(EXPOSURE);
    await waitFor('another tap turns them off at once: no ×10, and the plain dimmed fill', () => bigOffDimmed(EXPOSURE) && offSoon(EXPOSURE, t), 1000, () => `${bigWhy(EXPOSURE)}; ${offWhen(EXPOSURE, t)}`);
    t = now();
    dialDown(CONTRAST);
    await sleep(80);
    dialUp(CONTRAST);
    await sleep(200);
    const resets = cmdsSince(t, (c) => c.t === 'reset');
    check(`a press sends its reset, with ph; err guard refuses it, the Contrast dial alerts, and Contrast stays ${cBase}`,
      resets.length === 1 && resets[0].ph === target && sentSince(t, (o) => o.t === 'err' && o.id === resets[0].id && o.code === 'guard').length === 1 && alertsOn(dialContext(CONTRAST), t) === 1 && value('Contrast') === cBase, `${describeCmds(t)}; errs ${describeErrs(t)}; ${JSON.stringify(alertCounts(t))}`);
    t = now();
    await press(KEYS.pick);
    await sleep(300);
    check(`Pick gets err guard: the key alerts, and ${target} keeps its flag and stays the target`,
      cmdsSince(t, (c) => c.t === 'flag').length === 1 && sentSince(t, (o) => o.t === 'err' && o.cmd === 'flag' && o.code === 'guard').length === 1 && alertsOn(KEYS.pick.context, t) === 1 && st().photos[target].flag === flag && st().target === target, `${describeCmds(t)}; errs ${describeErrs(t)}; target ${st().target}`);
    t = now();
    await press(KEYS.preset);
    await sleep(300);
    check('Apply Preset gets err guard: the key alerts, and nothing is applied',
      cmdsSince(t, (c) => c.t === 'preset').length === 1 && sentSince(t, (o) => o.t === 'err' && o.cmd === 'preset' && o.code === 'guard').length === 1 && alertsOn(KEYS.preset.context, t) === 1 && st().photos[target].applied.length === applied0, `${describeCmds(t)}; errs ${describeErrs(t)}`);
    alertWindows.push({ from: tReadOnly, to: now(), contexts: [dialContext(EXPOSURE), dialContext(CONTRAST), KEYS.pick.context, KEYS.preset.context] });
    errWindows.push({ from: tReadOnly, to: now(), codes: ['guard'] });
    check('those six are the only alerts', alerts().length === alerts0 + 6, JSON.stringify(alertCounts(tReadOnly)));

    await sleep(300);
    t = now();
    await mock.control.relaunch({ downMs: 500, catalog: TEST_CATALOG });
    must(await waitFor('when the mock relaunches with the test catalog, writable is true again: the strips light up with its values, and Apply Preset too',
      () => sentSince(t, (o) => o.t === 'hello' && o.writable === true).length > 0 && stripsMatch() && DIALS.every(lit) && image(KEYS.preset.context) === PRESET_LIT, 6000, stripsWhy));
    const b2 = value('Exposure');
    t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    const want = round2(b2 + 3 * STEP);
    await waitFor(`and turns write again: 3 ticks take Exposure from ${b2} to ${want}`, () => near(value('Exposure'), want) && cmdsSince(t, (c) => c.t === 'done').length === 1, 3000, describeMock);
    await sleep(400);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('12. A version mismatch');
  {
    await sleep(600);
    const base = value('Exposure');
    const alerts0 = alerts().length;
    let t = now();
    mock.control.options({ protocolVersion: 2 });
    mock.control.close('both');
    must(await waitFor("when the mock's hello says v 2 after a reconnect, the strips say Mismatch and the keys dim", () => sentSince(t, (o) => o.t === 'hello' && o.v === 2).length > 0 && stripsMatch('Mismatch') && image(KEYS.next.context) !== NEXT_LIT, 4000, () => stripsWhy('Mismatch')));
    check('the plugin logged the mismatch, once', logCount(/speaks protocol v2, this plugin speaks v1/) === 1, `${logCount(/speaks protocol v2/)} lines`);
    const t2 = now();
    rotate(EXPOSURE, 1);
    await sleep(50);
    rotate(EXPOSURE, 1);
    await sleep(50);
    await press(KEYS.pick);
    await sleep(300);
    check('a turn and a Pick press alert their dial and key, and change nothing', alertsOn(dialContext(EXPOSURE), t2) === 1 && alertsOn(KEYS.pick.context, t2) === 1 && alerts().length === alerts0 + 2 && value('Exposure') === base, `${JSON.stringify(alertCounts(t2))}; ${value('Exposure')}`);
    await sleep(2000); // a ping goes by
    const cmds = cmdsSince(t);
    const pings = cmds.filter((c) => c.t === 'ping');
    check(`while mismatched the deck sent only hello and ping, and the mock answered every ping (${pings.length})`,
      cmds.every((c) => c.t === 'hello' || c.t === 'ping') && pings.length >= 1 && pings.every((c) => sentSince(t, (o) => o.t === 'pong' && o.id === c.id).length === 1), cmds.map((c) => c.t).join(', '));
    alertWindows.push({ from: t2, to: now(), contexts: [dialContext(EXPOSURE), KEYS.pick.context] });
    warnWindows.push({ from: t, to: now(), re: /speaks protocol v2/ });
    t = now();
    mock.control.options({ protocolVersion: 1 });
    mock.control.close('both');
    must(await waitFor('when the mock speaks v1 again and the deck reconnects, it watches again, and the strips and keys come back',
      () => sentSince(t, (o) => o.t === 'hello' && o.v === 1).length > 0 && cmdsSince(t, (c) => c.t === 'watch' && sameSet(c.ps, WATCH)).length >= 1 && stripsMatch() && DIALS.every(lit) && image(KEYS.next.context) === NEXT_LIT, 4000, stripsWhy));
  }

  // ---------------------------------------------------------------------------------------------------------
  section('13. Two dials at once');
  {
    await sleep(600);
    const eBase = value('Exposure');
    const cBase = value('Contrast');
    const alerts0 = alerts().length;
    const history0 = st().history.length;
    const t = now();
    // Exposure and Contrast in turn, 25 ms apart: each dial's events come every 50 ms, as from two hands.
    for (let i = 0; i < 20; i += 1) {
      rotate(i % 2 === 0 ? EXPOSURE : CONTRAST, 1);
      await sleep(25);
    }
    const lastSetAt = () => received.filter((r) => r.at >= t && r.cmd?.t === 'set').at(-1)?.at ?? now();
    await until(() => !st().tracking && now() - lastSetAt() > 850, 3000);
    await sleep(400);
    // Each dial's turn ends the other's gesture, so every event is a gesture of its own, starting from the value
    // last sent: Exposure then gains 0.03 a tick rather than 1/30.
    const lo = round2(eBase + 10 * 0.03);
    const hi = round2(eBase + 10 * STEP);
    check(`both land: Contrast goes from ${cBase} to ${cBase + 10}, and Exposure from ${eBase} to ${value('Exposure')} (${lo} to ${hi})`, value('Contrast') === cBase + 10 && value('Exposure') >= lo - 0.0051 && value('Exposure') <= hi + 0.0051, describeMock());
    const steps = st().history.slice(history0);
    check(`each gesture ended with the deck's done before the other dial's next set: ${steps.length} history steps, each a gesture ended by done`, steps.length >= 2 && steps.every((h) => h.kind === 'gesture' && h.why === 'done'), JSON.stringify(steps.filter((h) => h.kind !== 'gesture' || h.why !== 'done')));
    await waitFor('the strips show both values', () => stripsMatch(), 2000, stripsWhy);
    check('no alert', alerts().length === alerts0, `${alerts().length - alerts0} alerts`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('14. Clamping at both ends of a range');
  {
    await sleep(300);
    const slot = sliderOf('Exposure');
    const per = accelerate(4) * STEP; // a 4-tick event, the most the app puts in one (spike S4)
    // Fast events in one direction until well past the end of Exposure's range, then the gesture's done.
    const turnPast = async (end) => {
      const t = now();
      const events = Math.ceil(Math.abs(end - value('Exposure')) / per) + 3;
      for (let i = 0; i < events; i += 1) {
        rotate(EXPOSURE, Math.sign(end) * 4);
        await sleep(50);
      }
      await until(() => !st().tracking && cmdsSince(t, (c) => c.t === 'done').length === 1, 3000);
      await sleep(400);
      return { events, sets: cmdsSince(t, (c) => c.t === 'set') };
    };
    for (const end of [5, -5]) {
      const { events, sets } = await turnPast(end);
      const text = display(slot, end, [-5, 5]);
      check(`${events} fast events stop Exposure at ${end > 0 ? 'the top' : 'the bottom'} of its range: the mock has ${end}, the strip says ${text}, and no set went past it`,
        value('Exposure') === end && shown(EXPOSURE) === text && stripsMatch() && sets.length > 0 && sets.every((c) => Math.abs(c.v) <= 5), `${describeMock()}; strip ${shown(EXPOSURE)}; sets ${sets.map((c) => c.v).join(', ')}`);
      check(`once at ${end} the deck sent nothing more: one set says ${end}, and it's the last`, sets.filter((c) => c.v === end).length === 1 && sets.at(-1)?.v === end, sets.map((c) => c.v).join(', '));
    }
    // Big steps clamp the same way (plan.md, Phase 7): from the bottom, events of 4 big steps up past the top.
    let t = now();
    touch(EXPOSURE);
    await waitFor('a tap turns big steps on for Exposure', () => bigOn(EXPOSURE), 1000, () => bigWhy(EXPOSURE));
    const from = value('Exposure');
    const events = Math.ceil((5 - from) / (4 * MACRO)) + 2;
    t = now();
    for (let i = 0; i < events; i += 1) {
      rotate(EXPOSURE, 4);
      await sleep(50);
    }
    await until(() => !st().tracking && cmdsSince(t, (c) => c.t === 'done').length === 1, 3000);
    const sets = cmdsSince(t, (c) => c.t === 'set');
    check(`${events} events of 4 big steps take Exposure from ${from} to the top and stop there: the mock has 5, the strip says ${display(slot, 5, [-5, 5])} with ×10, no set went past 5, and only the last says 5`,
      value('Exposure') === 5 && shown(EXPOSURE) === display(slot, 5, [-5, 5]) && bigOn(EXPOSURE) && sets.length > 1 && sets.every((c) => Math.abs(c.v) <= 5) && sets.filter((c) => c.v === 5).length === 1 && sets.at(-1)?.v === 5,
      `${describeMock()}; strip ${shown(EXPOSURE)}; ${bigWhy(EXPOSURE)}; sets ${sets.map((c) => c.v).join(', ')}`);
    t = now();
    dialDown(EXPOSURE);
    await sleep(80);
    dialUp(EXPOSURE);
    await waitFor('a press turns them off and puts Exposure back to 0', () => cmdsSince(t, (c) => c.t === 'reset').length === 1 && value('Exposure') === 0 && stripsMatch(), 2000, stripsWhy);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('15. Presets that change sliders');
  {
    await sleep(600);
    const T = st().target;
    const sliders = (preset) => Object.entries(preset.values).map(([p, v]) => `${p} ${v}`).join(', ');
    const lands = (preset) => Object.entries(preset.values).every(([p, v]) => value(p, T) === v) && st().photos[T].applied.at(-1) === preset.uuid;
    let t = now();
    await press(KEYS.sliders);
    await waitFor(`Apply Preset with "${PUNCHY.name}" sets ${T}'s ${sliders(PUNCHY)} in the mock, and the key shows ok`, () => lands(PUNCHY) && fromPluginSince(t, (m) => m.event === 'showOk' && m.context === KEYS.sliders.context).length === 1, 3000, describeMock);
    await pageRound(`the vals that follow reach every page's strips (${sliders(PUNCHY)})`);

    // The key now applies Soft Matte, as if picked in its Property Inspector. It's pressed just after a Contrast
    // turn's done, so the preset's vals for Contrast arrive inside the deck's 300 ms echo window (PROTOCOL.md,
    // Gestures: Echoes), and must still win when the window closes.
    KEYS.sliders.settings = { uuid: SOFT.uuid, name: SOFT.name };
    toPlugin({ event: 'didReceiveSettings', action: `${UUID}.preset`, context: KEYS.sliders.context, device: DEVICE, payload: payload('Keypad', KEYS.sliders.coordinates, KEYS.sliders.settings) });
    await sleep(300);
    const cBase = value('Contrast');
    t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(CONTRAST, 1);
      await sleep(50);
    }
    await waitFor(`a Contrast turn (${cBase} to ${cBase + 3}) ends with done`, () => cmdsSince(t, (c) => c.t === 'done').length === 1 && value('Contrast') === cBase + 3, 2000, describeMock);
    const doneAt = received.find((r) => r.at >= t && r.cmd?.t === 'done')?.at ?? now();
    t = now();
    await press(KEYS.sliders);
    await waitFor(`straight after it, Apply Preset with "${SOFT.name}" sets ${T}'s ${sliders(SOFT)}, and the key shows ok`, () => lands(SOFT) && fromPluginSince(t, (m) => m.event === 'showOk' && m.context === KEYS.sliders.context).length === 1, 3000, describeMock);
    const valsAt = sent.find((s) => s.at >= doneAt && s.obj.t === 'vals' && s.obj.vals.Contrast === SOFT.values.Contrast)?.at;
    check(`its vals for Contrast reached the deck inside the echo window (${valsAt === undefined ? 'none' : `${Math.round(valsAt - doneAt)} ms after done`})`, valsAt !== undefined && valsAt - doneAt < 280);
    const text = display(sliderOf('Contrast'), SOFT.values.Contrast, [-100, 100]);
    await waitFor(`when the window closes the Contrast strip shows the preset's ${text}, not the turn's ${cBase + 3}`, () => shown(CONTRAST) === text && stripsMatch(), 1500, stripsWhy);
    const firstAt = stripEvents.find((e) => e.at >= doneAt && e.context === dialContext(CONTRAST) && e.payload.value?.value === text)?.at;
    check(`and not before the window closed (${firstAt === undefined ? 'never' : `${Math.round(firstAt - doneAt)} ms after done`})`, firstAt !== undefined && firstAt - doneAt >= 280);
    await pageRound(`the other sliders reach every page's strips too (${sliders(SOFT)})`);
  }

  // ---------------------------------------------------------------------------------------------------------
  section('16. Held ticks dropped after 2 s outside Develop');
  {
    await sleep(600);
    // The switch to Develop takes 2.5 s, and Lightroom's handler waits 3 s for it, so nothing answers for 2.5 s.
    mock.control.options({ moduleDelayMs: 2500, moduleWaitMs: 3000 });
    let t = now();
    mock.control.user({ module: 'library' });
    await waitFor('the user moves the mock to Library: the strips dim', () => sentSince(t, (o) => o.t === 'state' && o.module === 'library').length === 1 && DIALS.every(dimmed) && stripsMatch(), 1000, stripsWhy);
    const base = value('Exposure');
    const alerts0 = alerts().length;
    t = now();
    for (let i = 0; i < 3; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await waitFor('a turn there sends module develop, once, and holds its ticks while the slow switch is on its way', () => cmdsSince(t, (c) => c.t === 'module' && c.v === 'develop').length === 1 && st().switching === 'develop' && cmdsSince(t, (c) => c.t === 'set').length === 0, 1000, () => `${describeCmds(t)}; switching ${st().switching}`);
    await waitFor('2 s without values, the deck drops the held ticks and alerts the dial', () => alertsOn(dialContext(EXPOSURE), t) === 1, 3000);
    const alertAt = alerts().find((m) => m.at >= t && m.msg.context === dialContext(EXPOSURE))?.at ?? now();
    check(`the alert came 2 s after the first tick (${Math.round(alertAt - t)} ms), before the switch landed, and the plugin logged the drop`,
      alertAt - t >= 1900 && alertAt - t <= 2400 && st().module === 'library' && logCount(/dropped held ticks for Exposure: no values from Lightroom within 2000 ms/) === 1, `module ${st().module}; ${logCount(/dropped held ticks/)} drop lines`);
    await waitFor('when the switch lands at 2.5 s, the strips light up with the mock\'s values', () => st().module === 'develop' && stripsMatch() && DIALS.every(lit), 2000, stripsWhy);
    await sleep(500);
    alertWindows.push({ from: t, to: now(), contexts: [dialContext(EXPOSURE)] });
    check(`the dropped ticks never apply: no set went out, Exposure is still ${base}, and that's the only alert`,
      cmdsSince(t, (c) => c.t === 'set').length === 0 && cmdsSince(t, (c) => c.t === 'module').length === 1 && value('Exposure') === base && alerts().length === alerts0 + 1, `${describeCmds(t)}; ${value('Exposure')}; ${JSON.stringify(alertCounts(t))}`);
    mock.control.options({ moduleDelayMs: 0, moduleWaitMs: 1000 });
  }

  // ---------------------------------------------------------------------------------------------------------
  section('17. The whole session');
  {
    const invalid = received.filter((r) => !r.cmd || validateCommand(r.cmd).length > 0).map((r) => `${r.line}: ${r.cmd ? validateCommand(r.cmd).join('; ') : 'not JSON'}`);
    check(`every command the mock received is valid per PROTOCOL.md (the deck's validate.ts; ${received.length} commands)`, received.length > 0 && invalid.length === 0, invalid.slice(0, 5).join(' | '));
    // PROTOCOL.md, Gestures: every set and reset carries ph, the photo of the latest state the deck had. A state
    // the mock wrote less than 50 ms before a command arrived may not have reached the deck in time, so its photo
    // will do too.
    const phBad = [];
    let phChecked = 0;
    for (const r of received) {
      if (r.cmd?.t !== 'set' && r.cmd?.t !== 'reset') continue;
      phChecked += 1;
      const states = sent.filter((s) => s.gen === r.gen && s.obj.t === 'state' && s.at <= r.at);
      const settled = states.filter((s) => s.at < r.at - 50).at(-1);
      const photos = new Set([settled, ...states.filter((s) => s.at >= r.at - 50)].filter(Boolean).map((s) => s.obj.photo));
      if (!photos.has(r.cmd.ph)) phBad.push(`${r.cmd.t} ${r.cmd.p} with ph ${r.cmd.ph ?? 'none'}; latest state ${[...photos].join(' or ') || 'none'}`);
    }
    check(`every set and reset carried ph, the photo of the latest state the mock had sent (${phChecked} commands)`, phChecked > 0 && phBad.length === 0, phBad.slice(0, 5).join(' | '));
    const firsts = new Map();
    for (const r of received) if (!firsts.has(`${r.gen}:${r.conn}`)) firsts.set(`${r.gen}:${r.conn}`, r.cmd?.t);
    check(`every connection starts with hello (${firsts.size} connections)`, [...firsts.values()].every((t) => t === 'hello'), JSON.stringify([...firsts]));
    // PROTOCOL.md, Rates: set at most 30 a second per param (34 ms apart; 25 here, for scheduling jitter),
    // except one early final set per gesture.
    const tooSoon = [];
    const bySeries = new Map();
    for (const r of received) {
      if (r.cmd?.t !== 'set') continue;
      const key = `${r.gen}:${r.conn}:${r.cmd.p}`;
      if (!bySeries.has(key)) bySeries.set(key, []);
      bySeries.get(key).push(r);
    }
    let minGap = Infinity;
    for (const list of bySeries.values()) {
      for (let i = 1; i < list.length; i += 1) {
        const gap = list[i].at - list[i - 1].at;
        minGap = Math.min(minGap, gap);
        const finalOfItsGesture = list[i].cmd.g === list[i - 1].cmd.g && !list.slice(i + 1).some((r) => r.cmd.g === list[i].cmd.g);
        if (gap < 25 && !finalOfItsGesture) tooSoon.push(`${list[i].cmd.p} g ${list[i].cmd.g} ${Math.round(gap)} ms`);
      }
    }
    check('set goes out at most 30 times a second per param', tooSoon.length === 0, `${tooSoon.join(', ')}${tooSoon.length ? '; ' : ''}closest ${Math.round(minGap)} ms apart`);

    // PROTOCOL.md, Gestures: each gesture ends with one done. One Lightroom refused as stale ends with none, or
    // with one late done if the deck saw the new photo first. One refused as locked ends with one (Locked photos),
    // and a read-only probe, one set that err guard answers, with none (Guard).
    const codes = new Map(sent.filter((s) => s.obj.t === 'err' && s.obj.id !== undefined).map((s) => [`${s.gen}:${s.obj.id}`, s.obj.code]));
    const gestures = new Map();
    for (const r of received) {
      if ((r.cmd?.t !== 'set' && r.cmd?.t !== 'done') || r.cmd.g === undefined) continue;
      const key = `${r.gen}:${r.cmd.g}`;
      const e = gestures.get(key) ?? { sets: 0, dones: 0, refused: [] };
      if (r.cmd.t === 'done') e.dones += 1;
      else {
        e.sets += 1;
        const code = codes.get(`${r.gen}:${r.cmd.id}`);
        if (code !== undefined && !e.refused.includes(code)) e.refused.push(code);
      }
      gestures.set(key, e);
    }
    const allowedDones = (e) => (e.refused.includes('stale') ? [0, 1] : e.refused.includes('guard') ? [0] : [1]);
    const badGestures = [...gestures].filter(([, e]) => e.sets === 0 || !allowedDones(e).includes(e.dones));
    const refusedAs = (code) => [...gestures.values()].filter((e) => e.refused.includes(code)).length;
    check(`each of the deck's ${gestures.size} gestures sent its sets and then one done; refused as stale (${refusedAs('stale')}): none, or one late; as locked (${refusedAs('locked')}): one; a read-only probe (${refusedAs('guard')}): none`,
      gestures.size > 0 && badGestures.length === 0, badGestures.map(([k, e]) => `${k} ${JSON.stringify(e)}`).join(', '));
    histories.push(st().history);
    const ended = histories.flat().filter((h) => h.kind === 'gesture');
    const notDone = ended.filter((h) => h.why !== 'done' && !h.stale);
    check(`every gesture in the mock ended with the deck's done, apart from the stale ones in steps 6 and 6b (${ended.length} gestures; none timed out after 2 s)`, ended.length > 0 && notDone.length === 0 && ended.filter((h) => h.stale).length === 2, JSON.stringify(notDone.concat(ended.filter((h) => h.stale))));

    // PROTOCOL.md, Heartbeat: a ping every 2 s, on every connection. Lines that waited out step 8c's pause don't count.
    const paused = (at) => pauses.some(([a, b]) => at >= a && at <= b);
    const pingGaps = [];
    const pingsBy = new Map();
    for (const r of received) {
      if (r.cmd?.t !== 'ping') continue;
      const key = `${r.gen}:${r.conn}`;
      if (!pingsBy.has(key)) pingsBy.set(key, []);
      pingsBy.get(key).push(r.at);
    }
    for (const list of pingsBy.values()) {
      for (let i = 1; i < list.length; i += 1) if (!paused(list[i - 1]) && !paused(list[i]) && !pauses.some(([a]) => list[i - 1] < a && list[i] > a)) pingGaps.push(list[i] - list[i - 1]);
    }
    const offBeat = pingGaps.filter((g) => g < 1900 || g > 2400);
    check(`the deck pings every 2 s (${pingGaps.length} gaps, ${Math.round(Math.min(...pingGaps))} to ${Math.round(Math.max(...pingGaps))} ms)`, pingGaps.length >= 4 && offBeat.length === 0, offBeat.map(Math.round).join(', '));

    // PROTOCOL.md, Rates: strip updates at most 15 a second per dial (67 ms apart; 55 here, for jitter), with
    // only the layout keys that changed. A dial that appears again starts afresh: the app shows the layout's
    // defaults until the plugin paints every key.
    const lastPaint = new Map();
    const painted = new Map();
    const fast = [];
    const resent = [];
    let minPaintGap = Infinity;
    const timeline = [...stripEvents.map((e) => ({ ...e, paint: true })), ...appeared.map((a) => ({ ...a, paint: false }))].sort((a, b) => a.at - b.at);
    for (const e of timeline) {
      if (!e.paint) {
        lastPaint.delete(e.context);
        painted.delete(e.context);
        continue;
      }
      const prev = lastPaint.get(e.context);
      if (prev !== undefined) {
        minPaintGap = Math.min(minPaintGap, e.at - prev);
        if (e.at - prev < 55) fast.push(`${e.context} ${Math.round(e.at - prev)} ms`);
      }
      lastPaint.set(e.context, e.at);
      const keys = painted.get(e.context) ?? {};
      for (const [k, v] of Object.entries(e.payload)) {
        if (keys[k] === JSON.stringify(v)) resent.push(`${e.context}.${k}`);
        keys[k] = JSON.stringify(v);
      }
      painted.set(e.context, keys);
    }
    check(`strip updates: at most 15 a second per dial, only changed keys (${stripEvents.length} updates, closest ${Math.round(minPaintGap)} ms apart)`, fast.length === 0 && resent.length === 0, [...fast.slice(0, 5), ...resent.slice(0, 5)].join(', '));
    // Section 3c's rule, over the whole session: from step 4 on, photo changes, presets and relaunches change every
    // value while pages 2-5 are away.
    const lateAll = lateStripUpdates(0);
    check(`a dial whose page went away got no strip updates until its page came back, all session (${disappeared.length} willDisappear)`, lateAll.length === 0, lateAll.length === 0 ? '' : `${lateAll.length} late, first ${lateAll.slice(0, 5).join(', ')}`);

    // The mock's side of PROTOCOL.md, Rates: vals at most 20 a second.
    const valsGaps = [];
    for (const g of new Set(sent.map((s) => s.gen))) {
      const list = sent.filter((s) => s.gen === g && s.obj.t === 'vals').map((s) => s.at);
      for (let i = 1; i < list.length; i += 1) valsGaps.push(list[i] - list[i - 1]);
    }
    check(`the mock sent vals at most 20 a second (closest ${Math.round(Math.min(...valsGaps))} ms apart)`, valsGaps.every((g) => g >= 49), valsGaps.filter((g) => g < 49).map(Math.round).join(', '));

    const errs = sent.filter((s) => s.obj.t === 'err');
    const unexpected = errs.filter((e) => !errWindows.some((w) => e.at >= w.from && e.at <= w.to && w.codes.includes(e.obj.code)));
    check(`the mock answered with err only where a step expects it: stale in steps 6 and 9, locked in 10, guard in 11 (${errs.length} errs)`, unexpected.length === 0, unexpected.map((e) => JSON.stringify(e.obj)).join(' | '));
    const unserved = mockLog.filter((l) => /waits, unserved/.test(l.text));
    check('the deck never left an event connection waiting unserved (the pair rule)', unserved.length === 0, `${unserved.length} times`);
    const mockErrors = mockLog.filter((l) => l.kind === 'error');
    check('the mock logged no errors of its own', mockErrors.length === 0, mockErrors.map((l) => l.text).join(' | '));
    const stray = alerts().filter((m) => !alertWindows.some((w) => m.at >= w.from && m.at <= w.to && w.contexts.includes(m.msg.context)));
    check(`the only alerts are the ${alerts().length} that steps 3d, 10, 11, 12 and 16 expect, each on a dial or key used there`, stray.length === 0, stray.map((m) => `${m.msg.context} at ${Math.round(m.at)}`).join(', '));

    // Quiet logs (plan.md, Phases 6 and 7): normal use of the dials logs nothing at info or above. Steps 2-3e are
    // that: turns, fine steps, presses, big-step taps, page switches and the Property Inspector. What they log is
    // at debug, below info: big steps going on and off, the dials' sliders, and the ranges Lightroom reports.
    const log = logText();
    const inQuiet = log.split('\n').filter((l) => {
      const at = lineAt(l);
      return Number.isFinite(at) && at >= quiet.from && at <= quiet.to;
    });
    const loud = inQuiet.filter((l) => lineLevel(l) !== 'DEBUG' && lineLevel(l) !== 'TRACE');
    check(`quiet logs: normal use of the dials in steps 2-3e (turns, fine steps, presses, big-step taps, page switches, the Property Inspector) logs nothing at info or above (${inQuiet.length} lines, all debug)`,
      inQuiet.length > 0 && loud.length === 0, loud.slice(0, 4).join(' | '));
    const debugLines = [
      "Dials: dial 1 has no slider in its settings: saving its column's default, Temperature",
      'Dials: big steps on for Exposure (dial 3, tap)',
      'Dials: big steps off for Exposure (dial 3): tap',
      'Dials: big steps on for Contrast (dial 4, long touch)',
      'Dials: big steps off for Contrast (dial 4): long touch',
      'Dials: big steps off for Contrast (dial 4): the dial was pressed',
      'Dials: big steps off for Temperature (dial 1): the dial was pressed',
      `Dials: big steps off for Tint (dial 2): ${MACRO_MS / 1000} s without a turn`,
      'Dials: big steps off for Exposure (dial 3): the dial disappeared',
      'Dials: big steps off for Contrast (dial 4): its slider changed',
      'Dials: dial 4 now shows Dehaze, in place of Contrast',
      /Model: ranges from Lightroom: Temperature 2000…50000, .*Sharpness 0…150, LuminanceSmoothing 0…100, .*GrainAmount 0…100/,
    ];
    const levels = debugLines.map((want) => {
      const lines = log.split('\n').filter((l) => (typeof want === 'string' ? l.includes(want) : want.test(l)));
      return { want: String(want), level: lines.length === 0 ? 'missing' : [...new Set(lines.map(lineLevel))].join('/') };
    });
    const notDebug = levels.filter((x) => x.level !== 'DEBUG');
    check(`and those steps' lines are at debug, below info: big steps going on and off, the dials' sliders, and Lightroom's ranges with the newer sliders' (${debugLines.length} kinds of line)`,
      notDebug.length === 0, notDebug.map((x) => `${x.level}: ${x.want}`).join(' | '));
    check('the plugin process is still running', main.exited === null, main.exited ? JSON.stringify(main.exited) : '');
  }

  // ---------------------------------------------------------------------------------------------------------
  section('18. Quiet logs at the default level: a second copy of the plugin, with no log-level.txt');
  {
    // The main copy logs at debug. This one logs at the default, info, as the user's does. Normal use, with
    // big-step taps and a page switch, must log nothing below info, and at info only its startup and connection.
    running = null; // the main copy stops on purpose
    main.child.kill('SIGTERM');
    await until(() => main.exited !== null, 3000);
    await sleep(200);
    const dir = copyPlugin('default');
    const from = now();
    const run = startPlugin(dir);
    must(await waitFor('a second copy, with no log-level.txt, registers with the fake app', () => app.messages.some((m) => m.at >= from && m.msg.event === 'registerPlugin' && m.msg.uuid === UUID), 8000));
    // Its own dials: a page placed without settings, and page 2's sliders on another.
    pages.push(DEFAULTS.map((param, col) => ({ context: `q1-${col}`, col, param })), PAGES[1].map((param, col) => ({ context: `q2-${col}`, col, param })));
    const [own, other] = [pages.length - 2, pages.length - 1];
    for (const d of pages[other]) settingsOf.set(d.context, { param: d.param });
    shownPage = own;
    for (const d of pages[own]) appear(d);
    must(await waitFor("it watches the 17 sliders, and its dials get their columns' sliders with the mock's values", () => cmdsSince(from, (c) => c.t === 'watch' && same(c.ps, WATCH)).length >= 1 && stripsMatch(), 6000, stripsWhy));
    let t = now();
    rotate(EXPOSURE, 1);
    await sleep(50);
    rotate(EXPOSURE, 2);
    await until(() => cmdsSince(t, (c) => c.t === 'done').length >= 1, 2000);
    await sleep(100);
    touch(EXPOSURE);
    await sleep(100);
    rotate(EXPOSURE, 1);
    touch(TINT, true);
    await sleep(100);
    touch(TINT, true);
    dialDown(CONTRAST);
    await sleep(80);
    dialUp(CONTRAST);
    dialDown(TEMP);
    await sleep(30);
    rotate(TEMP, 2, true);
    await sleep(45);
    dialUp(TEMP);
    await waitFor('turns, a big-step tap and click, a long touch on and off, a press and push + turn; then big steps go off by themselves', () => bigOff(EXPOSURE) && bigOff(TINT) && cmdsSince(t, (c) => c.t === 'reset').length === 1, MACRO_MS + 1500, () => `${bigWhy(EXPOSURE)}; ${describeCmds(t)}`);
    await showPage(other, 'a page switch shows its sliders');
    inspector('propertyInspectorDidAppear', 0);
    await sleep(50);
    const tAsk = now();
    askSliders(0);
    await waitFor('its Property Inspector gets the sliders', () => slidersReply(tAsk, dialContext(0))?.param === 'Highlights', 2000);
    chooseSlider(0, 'Dehaze');
    await waitFor('and a choice there repaints the dial', () => stripsMatch(), 1000, stripsWhy);
    inspector('propertyInspectorDidDisappear', 0);
    await sleep(900);
    const sets = cmdsSince(from, (c) => c.t === 'set');
    const gs = new Set(sets.map((c) => c.g));
    const dones = cmdsSince(from, (c) => c.t === 'done');
    check('that use reached the mock: sets in 3 gestures, each with its done, and a reset, and no err', gs.size === 3 && dones.length === 3 && dones.every((c) => gs.has(c.g)) && cmdsSince(from, (c) => c.t === 'reset').length === 1 && sentSince(from, (o) => o.t === 'err').length === 0,
      `${cmdsSince(from, (c) => c.t !== 'ping').map((c) => [c.t, c.p, c.v, c.g].filter((x) => x !== undefined).join(' ')).join(', ')}; errs ${describeErrs(from)}`);
    t = now();
    running = null;
    run.child.kill('SIGTERM');
    await until(() => run.exited !== null, 3000);
    await sleep(100);
    const lines = logText(dir).split('\n').filter((l) => l.trim() !== '');
    check('its STARTUP says log level info, the default', lines.some((l) => /STARTUP \{[^\n]*"log":"info"/.test(l)), lines.find((l) => l.includes('STARTUP')) ?? 'no STARTUP line');
    const below = lines.filter((l) => lineLevel(l) === 'DEBUG' || lineLevel(l) === 'TRACE' || / (TICK|INPUT) \{/.test(l));
    check('it logged nothing below info: no TICK or INPUT lines, and no big-step, slider or ranges lines', below.length === 0, `${below.length} lines, first ${below[0] ?? ''}`);
    const startup = [/ INFO +Lightroom: STARTUP \{/, new RegExp(` INFO +Lightroom: ${WATCH.length} sliders, big steps off after ${MACRO_MS / 1000} s; watching ${WATCH.join(', ')}$`), / INFO +LrClient: connecting to Lightroom on /, / INFO +LrClient: both sockets connected; saying hello$/, / INFO +LrClient: Lightroom connection: offline → online$/];
    const extra = lines.filter((l) => !startup.some((re) => re.test(l)));
    check(`at info it logged only its startup, its sliders and the connection (${lines.length} lines)`, extra.length === 0 && startup.every((re) => lines.some((l) => re.test(l))), `${extra.slice(0, 3).join(' | ')}${extra.length ? ' | ' : ''}missing ${startup.filter((re) => !lines.some((l) => re.test(l))).map(String).join(', ') || 'none'}`);
    check('it wrote nothing to stdout or stderr', run.output.trim() === '', run.output.trim().split('\n').slice(0, 3).join(' | '));
  }
} catch (err) {
  if (!(err instanceof Abort)) check(`the script ran to the end without throwing`, false, err && err.stack ? err.stack : String(err));
  else console.log('\n(stopped: a check the rest depends on failed)');
} finally {
  for (const run of runs) if (run.exited === null) run.child.kill('SIGTERM');
  await sleep(300);
  section("The main copy's log, over steps 1-17");
  const log = logText();
  check('the plugin logged its startup and the connection going online', log.includes('STARTUP') && log.includes('offline → online'));
  check('it logged at debug, as the copy\'s log-level.txt asks, so the check below sees its debug lines too', /STARTUP \{[^\n]*"log":"debug"/.test(log));
  // Step 8b's stale event socket is the one warning a session where everything succeeds has, and step 12's
  // mismatch adds another. Debug lines count too: a field the deck's parser dropped, an event type it ignored, an
  // alert it raised or held back. Alerts count only in the steps that expect them, for the dials used there.
  const noisy = log.split('\n').filter((l) => /^\S+ (WARN |ERROR)/.test(l) || /dropped badly typed fields|ignoring unknown event type|ignoring an invalid event|alert for /.test(l));
  const unexpectedLog = noisy.filter((l) => !/the event socket is stale/.test(l) && !expectedLogLine(l));
  check('the plugin\'s log has no warnings, errors or alerts beyond the ones steps 8, 10, 11, 12 and 16 expect', unexpectedLog.length === 0, unexpectedLog.slice(0, 4).join(' | '));
  check('the plugin wrote nothing to stdout or stderr (no crash, no uncaught warning)', main.output.trim() === '', main.output.trim().split('\n').slice(0, 3).join(' | '));
  if (results.some((r) => !r.ok)) {
    console.log(`\n--- plugin log (last 80 lines) ---\n${log.split('\n').slice(-81).join('\n')}`);
    if (main.output) console.log(`\n--- plugin stdout/stderr ---\n${main.output.slice(-4000)}`);
    for (const run of runs.slice(1)) console.log(`\n--- the second copy's log ---\n${logText(run.dir).split('\n').slice(-40).join('\n')}${run.output ? `\n--- its stdout/stderr ---\n${run.output.slice(-2000)}` : ''}`);
    console.log(`\n--- mock log (last 40 lines) ---\n${mockLog.slice(-40).map((l) => `${l.gen} ${l.kind} ${l.text}`).join('\n')}`);
  }
  app.server?.close();
  for (const ws of app.server?.clients ?? []) ws.terminate();
  await mock?.stop();
  if (KEEP) {
    // The whole conversation, in order: deck → mock commands, mock → deck events, plugin → app messages.
    const rows = [
      ...received.map((r) => ({ at: r.at, gen: r.gen, dir: 'cmd', msg: r.cmd ?? r.line })),
      ...sent.map((s) => ({ at: s.at, gen: s.gen, dir: 'evt', msg: s.obj, target: s.target })),
      ...lost.map((s) => ({ at: s.at, gen: s.gen, dir: 'lost', msg: s.obj })),
      ...app.messages.map((m) => ({ at: m.at, dir: 'app', msg: m.msg.event === 'setImage' ? { ...m.msg, payload: '(image)' } : m.msg })),
    ].sort((a, b) => a.at - b.at);
    writeFileSync(path.join(tmp, 'conversation.jsonl'), rows.map((r) => JSON.stringify({ ...r, at: Math.round(r.at) })).join('\n'));
    writeFileSync(path.join(tmp, 'plugin-output.txt'), runs.map((r) => `--- ${r.dir}\n${r.output}`).join('\n'));
    console.log(`\nkept ${tmp} (the plugin's logs, its stdout and stderr, and conversation.jsonl)`);
  } else rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
