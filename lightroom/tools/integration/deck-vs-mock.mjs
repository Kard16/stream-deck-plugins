#!/usr/bin/env node
// Verification ladder step 5 (docs/lightroom/plan.md): the real Stream Deck plugin bundle against the mock
// Lightroom. Tracks B and C built them independently from lightroom/protocol/PROTOCOL.md, so the point is to
// find where they disagree.
//
//   mise exec -- node lightroom/tools/integration/deck-vs-mock.mjs [--keep]
//
// - The plugin: lightroom/deck/com.karimdhanji.lightroom.sdPlugin is copied to a temp folder, so the real
//   plugin's logs stay untouched, and its bin/plugin.js runs there with lightroom/deck/scripts/smoke-guard.mjs
//   preloaded: any connection to 58780/58781 throws. Build it first (npm run build in lightroom/deck). The copy
//   gets a log-level.txt saying debug, so the log checks see the plugin's debug lines as well.
// - The Stream Deck app: a fake one speaking the plugin's SDK WebSocket protocol, after scripts/smoke.mjs. It
//   needs ws from lightroom/deck/node_modules.
// - Lightroom: startMock on ephemeral ports and the real clock, given to the plugin as DECKBRIDGE_CMD_PORT and
//   DECKBRIDGE_EVT_PORT.
//
// Steps 1-8 are a session in which everything succeeds. Steps 9-16 are Phase 6's: the ph race, locked photos,
// read-only mode, a version mismatch, two dials at once, clamping, presets that change sliders, and held ticks
// dropped after 2 s. Step 17 checks rules over the whole session, allowing only the alerts and errs those steps
// expect. The checks look at the mock's state (values, flags, target, view, history) and at what the plugin
// sends the app (strip feedback, key images, alerts). It prints one ok/FAIL line per check and, on a failure,
// the tail of the plugin's log. It exits 0 when every check passes, 1 when one fails, and 2 when it can't start.
// --keep keeps the temp folder, with the plugin's log and conversation.jsonl (every command, event and app
// message, in order). Nothing here touches Lightroom, the Stream Deck app or the deck.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadScenario, startMock } from '../mock-lr/index.mjs';
import { defaultRange, TEST_CATALOG } from '../lib/params.mjs';
import { validateCommand } from '../../deck/src/lr/validate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DECK = path.resolve(here, '..', '..', 'deck');
const UUID = 'com.karimdhanji.lightroom';
const SOURCE = path.join(DECK, `${UUID}.sdPlugin`);
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

// ---- banks.json: what the strips should show ----

const BANKS = JSON.parse(readFileSync(path.join(SOURCE, 'banks.json'), 'utf8'));
const slotAt = (bank, col) => BANKS.banks[bank]?.[col] ?? null;
const WATCH = [...new Set(BANKS.banks.flat().filter(Boolean).map((s) => s.param))];
const EXPOSURE = 2; // dial 3 of bank 1
const CONTRAST = 3; // dial 4 of bank 1
if (slotAt(0, EXPOSURE)?.param !== 'Exposure' || slotAt(0, CONTRAST)?.param !== 'Contrast' || WATCH.length !== 13) {
  fatal('banks.json no longer has the kickoff banks (13 params, Exposure and Contrast on dials 3 and 4 of bank 1): update this script');
}
const amount = (v) => (typeof v === 'number' ? v : Number(String(v).split('/')[0]) / Number(String(v).split('/')[1]));
const STEP = amount(slotAt(0, EXPOSURE).step); // EV per tick
const FINE = amount(slotAt(0, EXPOSURE).fine); // EV per push + turn tick
const CONTRAST_STEP = amount(slotAt(0, CONTRAST).step);
const ACCEL = BANKS.acceleration;
const accelerate = (ticks) => ticks * (1 + ACCEL * (Math.abs(ticks) - 1));
const round2 = (v) => Math.round(v * 100) / 100;

// The strip's value text for a slot, by banks.json's display fields: the Kelvin variant for a Kelvin range.
function display(slot, v, range) {
  const k = range[0] >= 1000 && slot.kelvin ? slot.kelvin : null;
  const precision = (k ?? slot).precision ?? 0;
  const unit = (k ?? slot).unit ?? (k ? 'K' : '');
  const signed = (k ?? slot).signed ?? !k;
  const f = 10 ** precision;
  const r = (Math.sign(v) * Math.round(Math.abs(v) * f)) / f || 0; // halves away from zero, never -0
  return `${r < 0 ? '-' : signed && r > 0 ? '+' : ''}${Math.abs(r).toFixed(precision)}${unit ? ` ${unit}` : ''}`;
}

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
let exited = null; // the plugin process's exit, once it has exited
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
    if (now() >= end || exited) return false; // a dead plugin fails every check at once
    await sleep(10);
  }
}
// A check that waits for its condition. `why` explains a failure.
async function waitFor(name, test, timeoutMs = 4000, why = null) {
  const ok = await until(test, timeoutMs);
  let detail = '';
  if (!ok) {
    detail = exited ? `the plugin exited: ${JSON.stringify(exited)}` : `not within ${timeoutMs} ms`;
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
        }
      });
    });
  });
}

const toPlugin = (msg) => app.socket.send(JSON.stringify(msg));
const payload = (controller, coordinates, settings = {}, extra = {}) => ({ controller, coordinates, isInMultiAction: false, settings, resources: {}, ...extra });
const DIALS = [0, 1, 2, 3];
const dialContext = (col) => `dial-${col}`;
const dialMsg = (event, col, extra = {}) =>
  toPlugin({ event, action: `${UUID}.dial`, context: dialContext(col), device: DEVICE, payload: { ...payload('Encoder', { column: col, row: 0 }), ...extra } });
const rotate = (col, ticks, pressed = false) => dialMsg('dialRotate', col, { ticks, pressed });
const dialDown = (col) => dialMsg('dialDown', col);
const dialUp = (col) => dialMsg('dialUp', col);
const touch = (col, hold = false) => dialMsg('touchTap', col, { hold, tapPos: [100, 50] });

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

let bank = 0; // the bank the dials should be on, 0-based
let LIT = null; // a strip's label and value colours when live in Develop, learnt in step 1

// With a status word (Locked, Mismatch), each slot shows the word in place of its value.
function wantStrip(b, col, s, word = null) {
  const slot = slotAt(b, col);
  const bankText = `${b + 1}/${BANKS.banks.length}`;
  if (!slot) return { label: '—', value: '', bank: bankText };
  if (word) return { label: slot.label, value: word, bank: bankText };
  const ph = s.photos[s.target];
  return { label: slot.label, value: display(slot, ph.values[slot.param], defaultRange(ph.fmt, slot.param)), bank: bankText };
}
// What differs between the four strips and the mock's values for its target photo (or the word), on bank b.
function stripMismatches(b = bank, word = null) {
  const s = st();
  const bad = [];
  for (const col of DIALS) {
    const want = wantStrip(b, col, s, word);
    const got = strip(col);
    const g = { label: got.label?.value, value: got.value?.value, bank: got.bank?.value };
    if (g.label !== want.label || g.value !== want.value || g.bank !== want.bank) {
      bad.push(`dial ${col + 1} wants ${want.label} "${want.value}" ${want.bank}, shows ${g.label} "${g.value}" ${g.bank}`);
    }
  }
  return bad;
}
const stripsMatch = (b = bank, word = null) => stripMismatches(b, word).length === 0;
const lit = (col) => strip(col).label?.color === LIT.label && strip(col).value?.color === LIT.value;
const dimmed = (col) => strip(col).label?.color !== LIT.label && strip(col).value?.color !== LIT.value;
const stripsWhy = (word = null) => `${stripMismatches(bank, word).join('; ') || 'texts match'}; colours ${DIALS.map((c) => `${strip(c).label?.color}/${strip(c).value?.color}`).join(' ')}; ${describeMock()}`;

// Taps the strips once round every bank, back to the one they started on, waiting at each bank for its strips:
// the mock's values, or `word` in place of each value.
async function tapRound(what, word = null) {
  for (let i = 1; i <= BANKS.banks.length; i += 1) {
    touch(i % 4);
    bank = (bank + 1) % BANKS.banks.length;
    const names = DIALS.map((c) => slotAt(bank, c)?.label ?? '—').join(', ');
    await waitFor(`${what}: bank ${bank + 1} (${names})`, () => stripsMatch(bank, word), 2000, () => stripsWhy(word));
  }
}

// ---- what steps 9-16 expect, for the checks over the whole session (now() times) ----

const alertWindows = []; // { from, to, contexts }: alerts on these dials and keys
const errWindows = []; // { from, to, codes }: errs with these codes
const warnWindows = []; // { from, to, re }: WARN lines in the plugin's log

// ---- the plugin's log ----

let pluginDir = null;
function logText() {
  const dir = path.join(pluginDir, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse() // .1.log is older than .0.log
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('');
}
const logCount = (re) => logText().split('\n').filter((l) => re.test(l)).length;
// A log line a step expects: an alert for a dial it used, or a warning it allows, within the step. Log lines
// start with their wall-clock time, to the ms.
function expectedLogLine(line) {
  const at = Date.parse(line.slice(0, 24)) - WALL0;
  if (!Number.isFinite(at)) return false;
  const within = (w) => at >= w.from - 100 && at <= w.to + 100;
  const alert = line.match(/alert for (\S+): /);
  if (alert) return alertWindows.some((w) => within(w) && w.contexts.includes(alert[1]));
  return warnWindows.some((w) => within(w) && w.re.test(line));
}

// ---- run ----

const tmp = mkdtempSync(path.join(os.tmpdir(), 'deck-vs-mock-'));
pluginDir = path.join(tmp, `${UUID}.sdPlugin`); // the SDK names its log after this folder
// The user's own log-level.txt stays behind: the copy logs at debug.
cpSync(SOURCE, pluginDir, { recursive: true, filter: (src) => !src.startsWith(path.join(SOURCE, 'logs')) && path.basename(src) !== 'log-level.txt' });
writeFileSync(path.join(pluginDir, 'log-level.txt'), 'debug\n');

mock = await startWatchedMock();
for (let attempt = 0; ; attempt += 1) {
  app.server = await startApp();
  if (!FORBIDDEN.has(app.server.address().port)) break;
  app.server.close();
  if (attempt >= 4) fatal('the OS kept handing out a DeckBridge port');
}
const info = {
  application: { font: '.AppleSystemUIFont', language: 'en', platform: 'mac', platformVersion: '26.0.0', version: '7.6.0.23012' },
  plugin: { uuid: UUID, version: '0.2.0.0' },
  devicePixelRatio: 2,
  colors: {},
  devices: [{ id: DEVICE, name: 'Stream Deck +', size: { columns: 4, rows: 2 }, type: 7 }],
};
const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(GUARD).href, path.join(pluginDir, 'bin', 'plugin.js'), '-port', String(app.server.address().port), '-pluginUUID', UUID, '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)],
  { cwd: pluginDir, env: { ...process.env, DECKBRIDGE_CMD_PORT: String(mock.cmdPort), DECKBRIDGE_EVT_PORT: String(mock.evtPort) }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let childOutput = '';
child.stdout.on('data', (d) => { childOutput += d; });
child.stderr.on('data', (d) => { childOutput += d; });
child.on('exit', (code, signal) => { exited = { code, signal }; });
const deadline = setTimeout(() => {
  console.error('deck-vs-mock: gave up after 300 s');
  console.log(`\n--- plugin log (last 80 lines) ---\n${logText().split('\n').slice(-81).join('\n')}`);
  child.kill('SIGKILL');
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
  for (const col of DIALS) toPlugin({ event: 'willAppear', action: `${UUID}.dial`, context: dialContext(col), device: DEVICE, payload: payload('Encoder', { column: col, row: 0 }) });
  for (const k of Object.values(KEYS)) toPlugin({ event: 'willAppear', action: `${UUID}.${k.action}`, context: k.context, device: DEVICE, payload: payload('Keypad', k.coordinates, k.settings, { state: 0 }) });

  must(await waitFor("it connects to both of the mock's sockets and is greeted", () => mock.control.clients().cmd && mock.control.clients().evt && mock.control.clients().greeted, 5000, describeMock));
  await waitFor('it says hello with v 1, its client name and version', () => cmdsSince(0, (c) => c.t === 'hello' && c.v === 1 && typeof c.client === 'string' && typeof c.ver === 'string').length >= 1, 3000, () => JSON.stringify(cmdsSince(0).slice(0, 3)));
  await waitFor(`it watches the 13 bank params (${WATCH.join(', ')})`, () => cmdsSince(0, (c) => c.t === 'watch' && sameSet(c.ps, WATCH)).length >= 1 && sameSet(st().watch, WATCH), 3000, () => `watch commands ${JSON.stringify(cmdsSince(0, (c) => c.t === 'watch'))}; mock watches ${st().watch.join(', ')}`);
  must(await waitFor("the strips show bank 1's names and the mock's values for photo 101", () => stripsMatch(0), 4000, stripsWhy));
  LIT = { label: strip(0).label?.color, value: strip(0).value?.color };
  await waitFor("the keys show their captions, the flag keys for 101's flag (none) and the preset key its preset's name", () => {
    const want = { pick: '>Pick<', reject: '>Reject<', unflag: '>Unflagged<', next: '>Next<', prev: '>Previous<', ba: '>Before/After<', preset: '>Chrome<' };
    return Object.entries(want).every(([k, text]) => image(KEYS[k].context).includes(text));
  }, 3000, () => Object.keys(KEYS).map((k) => `${k} ${image(KEYS[k].context).match(/>([^<]+)</g)?.join('') ?? 'no image'}`).join('; '));
  NEXT_LIT = image(KEYS.next.context);
  PRESET_LIT = image(KEYS.preset.context);

  // ---------------------------------------------------------------------------------------------------------
  section('2. Turning Exposure');
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
    await waitFor(`the strip shows the mock's final value (${display(slotAt(0, EXPOSURE), want, [-5, 5])})`, () => stripsMatch(), 2000, stripsWhy);
    await sleep(400); // the deck's 300 ms echo window closes, and it applies the mock's held-back vals
    const texts = shownSince(EXPOSURE, t);
    check('the Exposure strip only ever moved up: no echo of an older value from the mock', nonDecreasing(texts) && stripsMatch(), texts.join(' '));
  }

  // ---------------------------------------------------------------------------------------------------------
  section('3. Fine adjust, press and long touch, banks');
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
    await waitFor('the strip shows 0.00', () => shown(EXPOSURE) === display(slotAt(0, EXPOSURE), 0, [-5, 5]) && stripsMatch(), 2000, stripsWhy);
    check('the reset is one history step', st().history.length === history0 + 1 && st().history.at(-1).kind === 'reset', JSON.stringify(st().history.slice(history0)));

    // Contrast first moves off its default, turning down this time, so the long touch's reset shows.
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
    await waitFor('a long touch resets Contrast to its default (0)', () => cmdsSince(t, (c) => c.t === 'reset' && c.p === 'Contrast').length === 1 && value('Contrast') === 0 && shown(CONTRAST) === '0', 2000, () => `${describeMock()}; strip ${shown(CONTRAST)}`);

    t = now();
    for (let b = 1; b <= BANKS.banks.length; b += 1) {
      touch(b % 4);
      bank = b % BANKS.banks.length;
      const names = DIALS.map((c) => slotAt(bank, c)?.label ?? '—').join(', ');
      await waitFor(bank === 0 ? `a fourth tap brings all four dials round to bank 1 (${names})` : `a tap moves all four dials to bank ${bank + 1} (${names}), with the mock's values`, () => stripsMatch(), 2000, stripsWhy);
    }
    check('changing banks sends Lightroom nothing', cmdsSince(t, (c) => c.t !== 'ping').length === 0, JSON.stringify(cmdsSince(t, (c) => c.t !== 'ping')));
  }

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
  }

  // ---------------------------------------------------------------------------------------------------------
  section('8. Recovery');
  {
    // 8a: Reload Plug-in, or a quick quit and relaunch: a new inst and an empty watch list. The dials go to
    // bank 2 first: a new inst drops the deck's values and ranges but keeps its banks.
    await sleep(1000); // the gesture from step 7 has ended
    touch(0);
    bank = 1;
    await waitFor('a tap first moves the dials to bank 2', () => stripsMatch(), 2000, stripsWhy);
    const inst = st().inst;
    let t = now();
    const relaunched = mock.control.relaunch({ downMs: 500 });
    await waitFor('when the mock relaunches with a new inst, the strips say Offline meanwhile and the keys dim', () => DIALS.every((c) => sawShown(c, 'Offline', t)) && nextKeyDimmedSince(t), 3000, () => DIALS.map(shown).join(', '));
    await relaunched;
    await waitFor('the deck reconnects and the new instance greets it', () => st().inst !== inst && sentSince(t, (o) => o.t === 'hello' && o.inst === st().inst).length > 0, 6000, describeMock);
    await waitFor('the deck watches the 13 bank params again', () => cmdsSince(t, (c) => c.t === 'watch' && sameSet(c.ps, WATCH)).length >= 1 && sameSet(st().watch, WATCH), 4000, () => `mock watches ${st().watch.join(', ') || 'nothing'}`);
    await waitFor('the strips come back on bank 2 with the mock\'s values, and the keys light up', () => stripsMatch() && DIALS.every(lit) && image(KEYS.next.context) === NEXT_LIT, 4000, stripsWhy);

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
    await waitFor('when a fresh mock starts on the same ports, the deck reconnects and watches the 13 params', () => mock.control.clients().greeted && cmdsSince(t, (c) => c.t === 'watch' && sameSet(c.ps, WATCH)).length >= 1, 8000, describeMock);
    const connectedAt = mockLog.find((l) => l.gen === gen && l.text === 'cmd: client connected')?.at;
    check('it reconnected within the backoff\'s 2 s cap', connectedAt - t <= 2300, `${Math.round(connectedAt - t)} ms after the mock was back`);
    await waitFor('the strips come back with the fresh mock\'s values (photo 101 again), and the keys light up', () => st().target === '101' && stripsMatch() && DIALS.every(lit) && image(KEYS.next.context) === NEXT_LIT, 4000, stripsWhy);
  }

  // ---------------------------------------------------------------------------------------------------------
  section("9. The ph race: the user moves to another photo, and the deck turns before it hears");
  {
    // Back to bank 1, where Exposure and Contrast are.
    while (bank !== 0) {
      touch(0);
      bank = (bank + 1) % BANKS.banks.length;
      await sleep(100);
    }
    await waitFor('taps bring the dials back round to bank 1', () => stripsMatch(), 2000, stripsWhy);
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
      texts.length > 0 && texts.every((s) => Number(s) >= yBase - 0.006 && Number(s) <= want + 0.006) && texts.at(-1) === display(slotAt(0, EXPOSURE), want, [-5, 5]), texts.join(' ') || 'nothing shown');

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
    await waitFor(`a background process locks ${X} mid-turn: the mock's next poll sends state.locked, and the strips say Locked, dimmed`, () => lockedState() !== undefined && stripsMatch(bank, 'Locked') && DIALS.every(dimmed), 1000, () => stripsWhy('Locked'));
    const lockedAt = lockedState()?.at ?? Infinity;
    const done = received.find((r) => r.at >= t && r.cmd?.t === 'done');
    check('the deck ended the open turn with done as soon as it saw state.locked, not 800 ms after its last tick', done !== undefined && done.at >= lockedAt && done.at - lockedAt < 100 && done.at - lastTick < 700,
      done === undefined ? 'no done' : `${Math.round(done.at - lockedAt)} ms after state.locked, ${Math.round(done.at - lastTick)} ms after the last tick`);
    await sleep(100);
    let want = round2(base + 3 * STEP);
    const steps = st().history.slice(history0);
    check(`no set after state.locked: the turn is one history step, ended by that done, and ${X} keeps its last value (${want})`,
      cmdsSince(lockedAt, (c) => c.t === 'set').length === 0 && steps.length === 1 && steps[0].kind === 'gesture' && steps[0].why === 'done' && near(value('Exposure'), want, 1e-9), `${value('Exposure')}; history ${JSON.stringify(steps)}`);

    // 10b: while it's locked, every input on a dial does nothing but alert that dial, once per burst.
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
    dialDown(1);
    await sleep(30);
    rotate(1, 2, true);
    await sleep(45);
    rotate(1, 2, true);
    await sleep(45);
    dialUp(1);
    await sleep(100);
    touch(0, true);
    await sleep(1200); // a new burst on Exposure's dial, past the 1 s between alerts
    dialDown(EXPOSURE);
    await sleep(80);
    dialUp(EXPOSURE);
    await sleep(300);
    alertWindows.push({ from: t, to: now(), contexts: DIALS.map(dialContext) });
    const counts = alertCounts(t);
    check('while locked, turns, push + turn, a long touch and a press send Lightroom nothing', cmdsSince(t, (c) => c.t !== 'ping').length === 0, describeCmds(t));
    check('each dial alerts once per burst: Temp (long touch), Tint (push + turn) and Contrast (turn) once, Exposure twice (a turn, then a press 1.2 s later)',
      counts['dial-0'] === 1 && counts['dial-1'] === 1 && counts['dial-3'] === 1 && counts['dial-2'] === 2 && Object.keys(counts).length === 4, JSON.stringify(counts));
    check(`${X}'s values didn't move, and the strips still say Locked`, JSON.stringify(st().photos[X].values) === before && stripsMatch(bank, 'Locked'), stripsWhy('Locked'));

    // 10c: tapping a strip still changes the bank.
    t = now();
    await tapRound('a tap still changes banks while locked, and every bank says Locked', 'Locked');
    check('the taps sent nothing and raised no alert', cmdsSince(t, (c) => c.t !== 'ping').length === 0 && alerts().filter((m) => m.at >= t).length === 0, `${describeCmds(t)}; ${JSON.stringify(alertCounts(t))}`);

    // 10d: outside Develop a locked dial doesn't ask for Develop either.
    t = now();
    mock.control.user({ module: 'library' });
    await waitFor('the user moves the mock to Library: its state still says locked, and so do the strips', () => sentSince(t, (o) => o.t === 'state' && o.module === 'library' && o.locked === true).length === 1 && stripsMatch(bank, 'Locked'), 1000, () => stripsWhy('Locked'));
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
    await waitFor('back in Develop and still locked, the strips still say Locked', () => sentSince(t, (o) => o.t === 'state' && o.module === 'develop' && o.locked === true).length === 1 && stripsMatch(bank, 'Locked'), 1000, () => stripsWhy('Locked'));

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
    await waitFor('the strips say Locked', () => stripsMatch(bank, 'Locked'), 1000, () => stripsWhy('Locked'));
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
    const probe = (from) => {
      const sets = cmdsSince(from, (c) => c.t === 'set');
      const errs = sentSince(from, (o) => o.t === 'err');
      return sets.length === 1 && sets[0].p === 'Exposure' && sets[0].ph === target && errs.length === 1 && errs[0].obj.id === sets[0].id && errs[0].obj.code === 'guard';
    };
    const tReadOnly = now();
    t = now();
    for (let i = 0; i < 5; i += 1) {
      rotate(EXPOSURE, 1);
      await sleep(50);
    }
    await sleep(200);
    check('a turn of 5 events sends one set, for its first, with ph; Lightroom refuses it with err guard', probe(t), `${describeCmds(t)}; errs ${describeErrs(t)}`);
    check(`the Exposure dial alerts once, and nothing moves: the mock and the strip keep ${base}`, alertsOn(dialContext(EXPOSURE), t) === 1 && value('Exposure') === base && stripsMatch(), `${JSON.stringify(alertCounts(t))}; ${stripsWhy()}`);
    check("Lightroom's bezel says why: one, the most it shows in 5 s", st().bezels === bezels0 + 1, `${st().bezels - bezels0} bezels`);
    await sleep(1200);
    t = now();
    rotate(EXPOSURE, 1);
    await sleep(50);
    rotate(EXPOSURE, 1);
    await sleep(200);
    check('a second burst 1.2 s later sends one more set, refused the same way, with another alert', probe(t) && alertsOn(dialContext(EXPOSURE), t) === 1 && value('Exposure') === base, `${describeCmds(t)}; errs ${describeErrs(t)}; ${JSON.stringify(alertCounts(t))}`);
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
    check('those five are the only alerts', alerts().length === alerts0 + 5, JSON.stringify(alertCounts(tReadOnly)));

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
    must(await waitFor("when the mock's hello says v 2 after a reconnect, the strips say Mismatch and the keys dim", () => sentSince(t, (o) => o.t === 'hello' && o.v === 2).length > 0 && stripsMatch(bank, 'Mismatch') && image(KEYS.next.context) !== NEXT_LIT, 4000, () => stripsWhy('Mismatch')));
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
    const slot = slotAt(0, EXPOSURE);
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
    const t = now();
    dialDown(EXPOSURE);
    await sleep(80);
    dialUp(EXPOSURE);
    await waitFor('a press puts Exposure back to 0', () => cmdsSince(t, (c) => c.t === 'reset').length === 1 && value('Exposure') === 0 && stripsMatch(), 2000, stripsWhy);
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
    await tapRound(`the vals that follow reach the strips (${sliders(PUNCHY)})`);

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
    const text = display(slotAt(0, CONTRAST), SOFT.values.Contrast, [-100, 100]);
    await waitFor(`when the window closes the Contrast strip shows the preset's ${text}, not the turn's ${cBase + 3}`, () => shown(CONTRAST) === text && stripsMatch(), 1500, stripsWhy);
    const firstAt = stripEvents.find((e) => e.at >= doneAt && e.context === dialContext(CONTRAST) && e.payload.value?.value === text)?.at;
    check(`and not before the window closed (${firstAt === undefined ? 'never' : `${Math.round(firstAt - doneAt)} ms after done`})`, firstAt !== undefined && firstAt - doneAt >= 280);
    await tapRound(`the other sliders reach the strips too (${sliders(SOFT)})`);
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
    // only the layout keys that changed.
    const lastPaint = new Map();
    const painted = new Map();
    const fast = [];
    const resent = [];
    let minPaintGap = Infinity;
    for (const e of stripEvents) {
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
    check(`the only alerts are the ${alerts().length} that steps 10, 11, 12 and 16 expect, each on a dial or key used there`, stray.length === 0, stray.map((m) => `${m.msg.context} at ${Math.round(m.at)}`).join(', '));
    check('the plugin process is still running', exited === null, exited ? JSON.stringify(exited) : '');
  }
} catch (err) {
  if (!(err instanceof Abort)) check(`the script ran to the end without throwing`, false, err && err.stack ? err.stack : String(err));
  else console.log('\n(stopped: a check the rest depends on failed)');
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  const log = logText();
  check('the plugin logged its startup and the connection going online', log.includes('STARTUP') && log.includes('offline → online'));
  check('it logged at debug, as the copy\'s log-level.txt asks, so the check below sees its debug lines too', /STARTUP \{[^\n]*"log":"debug"/.test(log));
  // Step 8b's stale event socket is the one warning a session where everything succeeds has, and step 12's
  // mismatch adds another. Debug lines count too: a field the deck's parser dropped, an event type it ignored, an
  // alert it raised or held back. Alerts count only in the steps that expect them, for the dials used there.
  const noisy = log.split('\n').filter((l) => /^\S+ (WARN |ERROR)/.test(l) || /dropped badly typed fields|ignoring unknown event type|ignoring an invalid event|alert for /.test(l));
  const unexpectedLog = noisy.filter((l) => !/the event socket is stale/.test(l) && !expectedLogLine(l));
  check('the plugin\'s log has no warnings, errors or alerts beyond the ones steps 8, 10, 11, 12 and 16 expect', unexpectedLog.length === 0, unexpectedLog.slice(0, 4).join(' | '));
  check('the plugin wrote nothing to stdout or stderr (no crash, no uncaught warning)', childOutput.trim() === '', childOutput.trim().split('\n').slice(0, 3).join(' | '));
  if (results.some((r) => !r.ok)) {
    console.log(`\n--- plugin log (last 80 lines) ---\n${log.split('\n').slice(-81).join('\n')}`);
    if (childOutput) console.log(`\n--- plugin stdout/stderr ---\n${childOutput.slice(-4000)}`);
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
    writeFileSync(path.join(tmp, 'plugin-output.txt'), childOutput);
    console.log(`\nkept ${tmp} (the plugin's logs, its stdout and stderr, and conversation.jsonl)`);
  } else rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
