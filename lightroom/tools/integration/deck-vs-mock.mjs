#!/usr/bin/env node
// Verification ladder step 5 (docs/lightroom/plan.md): the real Stream Deck plugin bundle against the mock
// Lightroom. Tracks B and C built them independently from lightroom/protocol/PROTOCOL.md, so the point is to
// find where they disagree.
//
//   mise exec -- node lightroom/tools/integration/deck-vs-mock.mjs [--keep]
//
// - The plugin: lightroom/deck/com.karimdhanji.lightroom.sdPlugin is copied to a temp folder, so the real
//   plugin's logs stay untouched, and its bin/plugin.js runs there with lightroom/deck/scripts/smoke-guard.mjs
//   preloaded: any connection to 58780/58781 throws. Build it first (npm run build in lightroom/deck).
// - The Stream Deck app: a fake one speaking the plugin's SDK WebSocket protocol, after scripts/smoke.mjs. It
//   needs ws from lightroom/deck/node_modules.
// - Lightroom: startMock on ephemeral ports and the real clock, given to the plugin as DECKBRIDGE_CMD_PORT and
//   DECKBRIDGE_EVT_PORT.
//
// The checks look at the mock's state (values, flags, target, view, history) and at what the plugin sends the
// app (strip feedback, key images, alerts). It prints one ok/FAIL line per check and, on a failure, the tail of
// the plugin's log. It exits 0 when every check passes, 1 when one fails, and 2 when it can't start. --keep
// keeps the temp folder, with the plugin's log and conversation.jsonl (every command, event and app message, in
// order). Nothing here touches Lightroom, the Stream Deck app or the deck.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadScenario, startMock } from '../mock-lr/index.mjs';
import { defaultRange } from '../lib/params.mjs';
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

// ---- checks ----

const now = () => performance.now();
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
let lastPollAt = -Infinity; // when the mock last ran its 200 ms poll, which is how it learns of the user's photo changes

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
    m.control.on('sent', (obj) => sent.push({ at: now(), gen: g, obj, target: m.lr.target }));
    m.control.on('lost', (obj) => lost.push({ at: now(), gen: g, obj }));
    const poll = m.lr.poll.bind(m.lr);
    m.lr.poll = () => {
      lastPollAt = now();
      poll();
    };
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
const nextKeyDimmedSince = (since) => imageEvents.some((e) => e.at >= since && e.context === KEYS.next.context && e.svg !== NEXT_LIT);
const alerts = () => app.messages.filter((m) => m.msg.event === 'showAlert');
const fromPluginSince = (t, pred) => app.messages.filter((m) => m.at >= t && pred(m.msg)).map((m) => m.msg);

let bank = 0; // the bank the dials should be on, 0-based
let LIT = null; // a strip's label and value colours when live in Develop, learnt in step 1

function wantStrip(b, col, s) {
  const slot = slotAt(b, col);
  const bankText = `${b + 1}/${BANKS.banks.length}`;
  if (!slot) return { label: '—', value: '', bank: bankText };
  const ph = s.photos[s.target];
  return { label: slot.label, value: display(slot, ph.values[slot.param], defaultRange(ph.fmt, slot.param)), bank: bankText };
}
// What differs between the four strips and the mock's values for its target photo, on bank b.
function stripMismatches(b = bank) {
  const s = st();
  const bad = [];
  for (const col of DIALS) {
    const want = wantStrip(b, col, s);
    const got = strip(col);
    const g = { label: got.label?.value, value: got.value?.value, bank: got.bank?.value };
    if (g.label !== want.label || g.value !== want.value || g.bank !== want.bank) {
      bad.push(`dial ${col + 1} wants ${want.label} "${want.value}" ${want.bank}, shows ${g.label} "${g.value}" ${g.bank}`);
    }
  }
  return bad;
}
const stripsMatch = (b = bank) => stripMismatches(b).length === 0;
const lit = (col) => strip(col).label?.color === LIT.label && strip(col).value?.color === LIT.value;
const dimmed = (col) => strip(col).label?.color !== LIT.label && strip(col).value?.color !== LIT.value;
const stripsWhy = () => `${stripMismatches().join('; ') || 'texts match'}; colours ${DIALS.map((c) => `${strip(c).label?.color}/${strip(c).value?.color}`).join(' ')}; ${describeMock()}`;

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

// ---- run ----

const tmp = mkdtempSync(path.join(os.tmpdir(), 'deck-vs-mock-'));
pluginDir = path.join(tmp, `${UUID}.sdPlugin`); // the SDK names its log after this folder
cpSync(SOURCE, pluginDir, { recursive: true, filter: (src) => !src.startsWith(path.join(SOURCE, 'logs')) });

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
  console.error('deck-vs-mock: gave up after 180 s');
  console.log(`\n--- plugin log (last 80 lines) ---\n${logText().split('\n').slice(-81).join('\n')}`);
  child.kill('SIGKILL');
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}, 180_000);
deadline.unref();

class Abort extends Error {}
const must = (ok) => {
  if (!ok) throw new Abort();
};

// For the checks at the end: step 6's window, step 8c's pause, and each mock's history.
let staleWindow = null;
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
        await until(() => now() - lastPollAt < 10, 400);
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
    staleWindow = [tSwitch, now()];

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
    await until(() => now() - lastPollAt < 10, 400);
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
  section('9. The whole session');
  {
    const invalid = received.filter((r) => !r.cmd || validateCommand(r.cmd).length > 0).map((r) => `${r.line}: ${r.cmd ? validateCommand(r.cmd).join('; ') : 'not JSON'}`);
    check(`every command the mock received is valid per PROTOCOL.md (the deck's validate.ts; ${received.length} commands)`, received.length > 0 && invalid.length === 0, invalid.slice(0, 5).join(' | '));
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

    // PROTOCOL.md, Gestures: each gesture ends with one done. One that Lightroom refused as stale ends with none,
    // or with one late done if the deck saw the new photo first.
    const staleIds = new Set(sent.filter((s) => s.obj.t === 'err' && s.obj.code === 'stale').map((s) => `${s.gen}:${s.obj.id}`));
    const gestures = new Map();
    for (const r of received) {
      if ((r.cmd?.t !== 'set' && r.cmd?.t !== 'done') || r.cmd.g === undefined) continue;
      const key = `${r.gen}:${r.cmd.g}`;
      const e = gestures.get(key) ?? { sets: 0, dones: 0, stale: false };
      if (r.cmd.t === 'done') e.dones += 1;
      else {
        e.sets += 1;
        if (staleIds.has(`${r.gen}:${r.cmd.id}`)) e.stale = true;
      }
      gestures.set(key, e);
    }
    const badGestures = [...gestures].filter(([, e]) => e.sets === 0 || (e.stale ? e.dones > 1 : e.dones !== 1));
    check(`each of the deck's ${gestures.size} gestures sent its sets and then one done (one Lightroom refused as stale: none, or one late)`, gestures.size > 0 && badGestures.length === 0, badGestures.map(([k, e]) => `${k} ${JSON.stringify(e)}`).join(', '));
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
    const unexpected = errs.filter((e) => !(e.obj.code === 'stale' && staleWindow && e.at >= staleWindow[0] && e.at <= staleWindow[1]));
    check('the mock answered no command with err, apart from stale for step 6\'s old gesture', unexpected.length === 0, unexpected.map((e) => JSON.stringify(e.obj)).join(' | '));
    const unserved = mockLog.filter((l) => /waits, unserved/.test(l.text));
    check('the deck never left an event connection waiting unserved (the pair rule)', unserved.length === 0, `${unserved.length} times`);
    const mockErrors = mockLog.filter((l) => l.kind === 'error');
    check('the mock logged no errors of its own', mockErrors.length === 0, mockErrors.map((l) => l.text).join(' | '));
    check('no alert in a session where everything succeeded', alerts().length === 0, alerts().map((m) => m.msg.context).join(', '));
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
  // Step 8b's stale event socket is the one warning a good session has.
  // Debug lines count too: a field the deck's parser dropped, an event type it ignored, an alert it held back.
  const noisy = log.split('\n').filter((l) => /^\S+ (WARN |ERROR)/.test(l) || /dropped badly typed fields|ignoring unknown event type|ignoring an invalid event|alert for /.test(l));
  const unexpectedLog = noisy.filter((l) => !/the event socket is stale/.test(l));
  check('the plugin\'s log has no warnings or errors, apart from step 8\'s stale event socket', unexpectedLog.length === 0, unexpectedLog.slice(0, 4).join(' | '));
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
