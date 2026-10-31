#!/usr/bin/env node
// Fake Lightroom for testing the spike harness. Speaks spikes/protocol-v0.md on configurable ports,
// close enough to the spike DeckBridge plugin to exercise every harness phase.
// stdin commands: "trigger tests", "trigger autosync", "reload", "quit", "state", "exit".
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    'cmd-port': { type: 'string' },
    'evt-port': { type: 'string' },
    'plugin-dir': { type: 'string' },
    'echo-ms': { type: 'string' },
    'jitter-ms': { type: 'string' },
    'refuse-first-ms': { type: 'string' },
    'reload-down-ms': { type: 'string' },
    'quit-down-ms': { type: 'string' },
    'not-writable': { type: 'boolean' },
    'vals-before-ack': { type: 'boolean' },
    'no-hello-on-connect': { type: 'boolean' },
    'set-cost-ms': { type: 'string' },
    catalog: { type: 'string' },
    quiet: { type: 'boolean' },
  },
  strict: false,
});

const num = (x, d) => (x != null && Number.isFinite(Number(x)) ? Number(x) : d);
const cfg = {
  cmdPort: num(opt['cmd-port'], 59780),
  evtPort: num(opt['evt-port'], 59781),
  pluginDir: opt['plugin-dir'] ? path.resolve(opt['plugin-dir']) : null,
  echoMs: num(opt['echo-ms'], 20),
  jitterMs: num(opt['jitter-ms'], 10),
  refuseFirstMs: num(opt['refuse-first-ms'], 0),
  reloadDownMs: num(opt['reload-down-ms'], 1000),
  quitDownMs: num(opt['quit-down-ms'], 5000),
  writable: !opt['not-writable'],
  valsBeforeAck: !!opt['vals-before-ack'],
  helloOnConnect: !opt['no-hello-on-connect'],
  setCostMs: num(opt['set-cost-ms'], 0),
  catalog: opt.catalog ?? '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat',
  quiet: !!opt.quiet,
};

const say = (msg) => { if (!cfg.quiet) process.stdout.write(`[fake] ${msg}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lt = () => Date.now() / 1000 - 978307200; // seconds since 2001-01-01, like LrDate.currentTime()
const newInst = () => Math.random().toString(36).slice(2, 10);

const RANGES = { Exposure: [-5, 5], Temperature: [2000, 50000], Tint: [-150, 150] };
const range = (p) => RANGES[p] ?? [-100, 100];
const PARAMS = ['Temperature', 'Tint', 'Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks', 'Texture', 'Clarity', 'Vibrance', 'Saturation', 'PostCropVignetteAmount'];

const lr = {
  inst: newInst(),
  gen: 0,
  values: Object.fromEntries(PARAMS.map((p) => [p, p === 'Temperature' ? 5500 : p === 'Exposure' ? 0.25 : 0])),
  watched: ['Exposure', 'Contrast', 'Highlights', 'Shadows'],
  pushHz: 0,
  tracking: null,
  module: 'develop',
  photo: 101,
  sel: 1,
  flag: 0,
  rating: 0,
  label: 'none',
  requireCache: null,
  observerCount: 0,
};

let cmdServer = null;
let evtServer = null;
let cmdSock = null;
let evtSock = null;
let lastEchoAt = 0;
let pendingVals = {};
let flushTimer = null;

function send(obj) {
  if (evtSock && !evtSock.destroyed) evtSock.write(JSON.stringify(obj) + '\n');
}

function readSpikeVersion() {
  if (!cfg.pluginDir) return 'v1';
  try {
    const src = fs.readFileSync(path.join(cfg.pluginDir, 'SpikeVersion.lua'), 'utf8');
    const m = src.match(/^\s*local\s+V\s*=\s*(['"])([^'"\n]*)\1/m);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

function sendHello() {
  send({ t: 'hello', v: 0, lr: '15.3 (fake)', catalog: path.basename(cfg.catalog), path: cfg.catalog, guard: 'on', writable: cfg.writable, inst: lr.inst, gen: lr.gen });
}
function sendState() {
  send({ t: 'state', module: lr.module, photo: String(lr.photo), file: `DSCF${lr.photo}.RAF`, flag: lr.flag, rating: lr.rating, label: lr.label, sel: lr.sel });
}
function sendVals(params) {
  const vals = {};
  for (const p of params) vals[p] = lr.values[p];
  send({ t: 'vals', vals, lt: lt() });
}

function emitChange(p) {
  lr.observerCount += 1;
  if (!lr.watched.includes(p)) return;
  if (lr.pushHz > 0) {
    pendingVals[p] = lr.values[p];
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        send({ t: 'vals', vals: pendingVals, lt: lt() });
        pendingVals = {};
      }, 1000 / lr.pushHz);
    }
    return;
  }
  // Unthrottled: one vals per change, after a delay, never reordered.
  const v = lr.values[p];
  if (cfg.valsBeforeAck) {
    send({ t: 'vals', vals: { [p]: v }, lt: lt() });
    return;
  }
  const delay = Math.max(0, cfg.echoMs + (Math.random() * 2 - 1) * cfg.jitterMs);
  const at = Math.max(lastEchoAt, Date.now() + delay);
  lastEchoAt = at;
  setTimeout(() => send({ t: 'vals', vals: { [p]: v }, lt: lt() }), at - Date.now());
}

function guardOk(cmd) {
  if (cfg.writable) return true;
  send({ t: 'err', id: cmd.id, msg: 'guard', cmd: cmd.t });
  return false;
}

function result(cmd, name, ok, data, ms = 1 + Math.random() * 3) {
  const r = { t: 'result', id: cmd.id, name, ok, ms: Math.round(ms * 10) / 10 };
  if (ok) r.data = data;
  else r.msg = data;
  send(r);
}

async function runProbe(cmd) {
  const name = cmd.name;
  const t0 = Date.now();
  switch (name) {
    case 'features':
      return result(cmd, name, true, {
        setEnhance: true, getEnhancePanelState: true, changeDenoiseAmount: true, createNewMask: true,
        shutdown: true, addActivePhotoChangeObserver: false, addHapticObserver: true, removeFromCatalog: true,
        isAvailableForEditing: true, getPhotosAvailableForEditing: true, showBezel: true,
        loadstring: true, loadfile: false, dofile: false,
        lists: { LrDevelopController: ['getValue', 'setValue', 'getRange', 'startTracking', 'stopTracking'] },
      });
    case 'timing':
      await sleep(200);
      return result(cmd, name, true, { poll: { med: 0.8, max: 2.1 }, getTargetPhotos: { med: 0.3, max: 0.9 }, getFlag: { med: 0.1, max: 0.2 } }, Date.now() - t0);
    case 'presets':
      await sleep(50);
      return result(cmd, name, true, { folders: 12, presets: 140, first: [{ folder: 'Deck Profiles', name: 'Cobalt Classic Chrome', uuid: 'A1B2' }] }, Date.now() - t0);
    case 'ranges': {
      const params = {};
      for (const p of PARAMS) params[p] = { min: range(p)[0], max: range(p)[1], v: lr.values[p] };
      return result(cmd, name, true, { format: 'RAW', params });
    }
    case 'observerPhotoChange': {
      const before = lr.observerCount;
      lr.photo += 1;
      lr.observerCount += 1;
      sendState();
      await sleep(1500);
      lr.photo -= 1;
      sendState();
      await sleep(500);
      return result(cmd, name, true, { photoChangeFired: lr.observerCount > before, before, after: lr.observerCount, moduleTripFired: true }, Date.now() - t0);
    }
    case 'flagAdvance':
      if (!guardOk(cmd)) return undefined;
      await sleep(400);
      return result(cmd, name, true, { advanced: false, restored: true }, Date.now() - t0);
    case 'mask':
      if (!guardOk(cmd)) return undefined;
      await sleep(1500);
      return result(cmd, name, true, { created: true, createMs: 1400, removed: true }, Date.now() - t0);
    case 'beforeAfter': {
      const secs = cmd.args && typeof cmd.args.secs === 'number' ? cmd.args.secs : 2;
      await sleep(secs * 1000);
      return result(cmd, name, true, { shown: ['develop_before', 'develop_loupe'] }, Date.now() - t0);
    }
    case 'autoSync': {
      if (!guardOk(cmd)) return undefined;
      if (lr.sel < 2) return result(cmd, name, false, 'need 2 or more selected photos');
      await sleep(3000);
      const photos = [{ id: String(lr.photo), active: true, before: 0.25, after: 0.75, changed: true }];
      for (let i = 1; i < lr.sel; i += 1) photos.push({ id: String(lr.photo + i), active: false, before: 0, after: 0.5, changed: true });
      return result(cmd, name, true, { photos }, Date.now() - t0);
    }
    case 'requireVersion':
      if (lr.requireCache == null) lr.requireCache = readSpikeVersion();
      return result(cmd, name, true, { v: lr.requireCache, importOk: true, requireOk: true });
    default:
      return result(cmd, name, false, `unknown probe ${name}`);
  }
}

let setChain = Promise.resolve();
function applySet(cmd, t0) {
  const [lo, hi] = range(cmd.p);
  if (cmd.track !== false && lr.tracking !== cmd.p) lr.tracking = cmd.p;
  lr.values[cmd.p] = Math.max(lo, Math.min(hi, Number(cmd.v)));
  emitChange(cmd.p);
  send({ t: 'ack', seq: cmd.seq, p: cmd.p, v: lr.values[cmd.p], ms: Math.round((Date.now() - t0 + Math.random()) * 10) / 10, cy: true });
}

async function handle(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    send({ t: 'err', msg: 'bad json' });
    return;
  }
  const t0 = Date.now();
  switch (cmd.t) {
    case 'hello':
      sendHello();
      sendState();
      sendVals(lr.watched);
      return;
    case 'ping':
      send({ t: 'pong', id: cmd.id, lt: lt() });
      return;
    case 'watch':
      lr.watched = Array.isArray(cmd.ps) ? cmd.ps : [];
      sendVals(lr.watched);
      return;
    case 'get':
      send({ t: 'val', id: cmd.id, p: cmd.p, v: lr.values[cmd.p] ?? 0 });
      return;
    case 'range':
      send({ t: 'range', id: cmd.id, p: cmd.p, min: range(cmd.p)[0], max: range(cmd.p)[1] });
      return;
    case 'set': {
      if (!guardOk(cmd)) return;
      if (cfg.setCostMs > 0) {
        // Simulate a busy main thread: sets are handled one at a time, each taking setCostMs.
        setChain = setChain.then(async () => {
          const t1 = Date.now();
          await sleep(cfg.setCostMs);
          applySet(cmd, t1);
        });
        return;
      }
      applySet(cmd, t0);
      return;
    }
    case 'done':
      lr.tracking = null;
      return;
    case 'reset':
      if (!guardOk(cmd)) return;
      lr.values[cmd.p] = cmd.p === 'Temperature' ? 5500 : 0;
      emitChange(cmd.p);
      return;
    case 'probe':
      await runProbe(cmd);
      return;
    case 'reload':
      send({ t: 'result', id: cmd.id, name: 'reload', ok: true, ms: 2.5, data: { v: readSpikeVersion(), importOk: true, requireOk: true, loader: 'loadstring' } });
      return;
    case 'bezel':
      say(`bezel: ${cmd.msg}`);
      return;
    case 'select':
      send({ t: 'result', id: cmd.id, name: 'select', ok: true, ms: 12, data: { file: 'DSCF0042.RAF', format: 'RAW', fileSize: 55574528, width: 7728, height: 5152 } });
      return;
    case 'config':
      if (typeof cmd.pushHz === 'number') lr.pushHz = cmd.pushHz;
      return;
    default:
      send({ t: 'err', id: cmd.id, msg: `unknown command ${cmd.t}`, cmd: cmd.t });
  }
}

function onCmdConnection(sock) {
  if (cmdSock) cmdSock.destroy();
  cmdSock = sock;
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handle(line).catch((e) => say(`handler error ${e.message}`));
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => { if (cmdSock === sock) cmdSock = null; });
}

function onEvtConnection(sock) {
  if (evtSock) evtSock.destroy();
  evtSock = sock;
  lr.gen += 1;
  sock.setNoDelay(true);
  sock.on('error', () => {});
  sock.on('close', () => { if (evtSock === sock) evtSock = null; });
  if (!cfg.helloOnConnect) return;
  sendHello();
  sendState();
  sendVals(lr.watched);
}

function bind() {
  cmdServer = net.createServer(onCmdConnection);
  evtServer = net.createServer(onEvtConnection);
  cmdServer.on('error', (e) => say(`cmd server error ${e.message}`));
  evtServer.on('error', (e) => say(`evt server error ${e.message}`));
  cmdServer.listen(cfg.cmdPort, '127.0.0.1');
  evtServer.listen(cfg.evtPort, '127.0.0.1');
  say(`listening on ${cfg.cmdPort}/${cfg.evtPort}, inst ${lr.inst}`);
}

function unbind() {
  for (const s of [cmdSock, evtSock]) if (s) s.destroy();
  cmdSock = null;
  evtSock = null;
  for (const srv of [cmdServer, evtServer]) if (srv) srv.close();
  cmdServer = null;
  evtServer = null;
}

async function restart(why, downMs) {
  send({ t: 'bye', why });
  await sleep(50);
  unbind();
  say(`${why}: down for ${downMs} ms`);
  await sleep(downMs);
  lr.inst = newInst();
  lr.gen = 0;
  lr.requireCache = null;
  bind();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === 'trigger') {
    if (arg === 'autosync') {
      lr.sel = 3;
      sendState();
    }
    send({ t: 'trigger', name: arg });
    say(`sent trigger ${arg}`);
  } else if (cmd === 'reload') {
    restart('shutdownPlugin', cfg.reloadDownMs);
  } else if (cmd === 'quit') {
    restart('shutdownApp', cfg.quitDownMs);
  } else if (cmd === 'state') {
    sendState();
  } else if (cmd === 'exit') {
    unbind();
    process.exit(0);
  }
});

if (cfg.refuseFirstMs > 0) {
  say(`not listening for ${cfg.refuseFirstMs} ms`);
  setTimeout(bind, cfg.refuseFirstMs);
} else {
  bind();
}
