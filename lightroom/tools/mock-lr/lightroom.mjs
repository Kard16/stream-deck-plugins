// The mock Lightroom's model: DeckBridge protocol v1 (lightroom/protocol/PROTOCOL.md) on top of a fake
// catalog, with the behaviour spikes S1-S5 measured on Lightroom Classic 15.3 (docs/lightroom/plan.md, Log):
// - the adjustment observer stays silent during a tracked gesture and fires once, ~4 ms after stopTracking;
// - a 200 ms poll diffs state and the watched values (the observer doesn't say what changed);
// - ranges depend on the file format (Temperature is Kelvin on raw, -100..100 on JPEG);
// - writes go through only while the test catalog is open (the guard), compared without case;
// - while a menu is open (pause), plugin tasks and socket callbacks wait until it closes.
// Sockets live in index.mjs; this file talks to them through `transport`.
import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BANK_PARAMS, LABELS, MODULES, PARAMS, PROTOCOL_VERSION, TEST_CATALOG,
  defaultRange, defaultValue, lrTime,
} from '../lib/params.mjs';

export const TIMING = Object.freeze({
  pollMs: 200, // state and value poll
  observerMs: 4, // the observer fires this long after an untracked change or stopTracking (S2)
  valsGapMs: 50, // vals at most 20 a second
  gestureTimeoutMs: 2000, // no set for 2 s ends the gesture
  advanceMs: 150, // flag {advance: true} waits this long before nextPhoto()
  autoAdvanceMs: 30, // Lightroom's own Auto Advance moves on this long after a flag
  writeTimeoutMs: 3000, // withWriteAccessDo(..., {timeout = 3})
  bezelGapMs: 5000, // guard bezel at most every 5 s
});

const FLAG_VALUES = Object.freeze({ pick: 1, reject: -1, none: 0 });
// The modules the real plugin hot-reloads, in its load order (Reload.MODULES in
// lightroom/lua/DeckBridge.lrdevplugin/Reload.lua). Any other name, Server and State included, needs
// Reload Plug-in, and the plugin answers ok false.
export const RELOADABLE = Object.freeze(['Proto', 'Develop', 'Poll', 'Library', 'Presets', 'Dispatch', 'Core', 'Reload']);
const PARAM_SET = new Set(PARAMS);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const newInst = () => crypto.randomBytes(4).toString('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));

function short(x, max = 200) {
  const s = JSON.stringify(x) ?? String(x);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

function normalizePhoto(p, i) {
  if (!isObject(p) || p.id == null) throw new SetupError(`photos[${i}] needs an id`);
  const id = String(p.id);
  const fmt = String(p.fmt ?? 'RAW').toUpperCase();
  const flag = p.flag ?? 0;
  const rating = p.rating ?? 0;
  const label = p.label ?? 'none';
  if (![-1, 0, 1].includes(flag)) throw new SetupError(`photo ${id}: flag must be -1, 0 or 1`);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new SetupError(`photo ${id}: rating must be 0-5`);
  if (!LABELS.includes(label)) throw new SetupError(`photo ${id}: label must be one of ${LABELS.join(', ')}`);
  const values = isObject(p.values) ? { ...p.values } : {};
  const defaults = isObject(p.defaults) ? { ...p.defaults } : {};
  for (const [k, v] of Object.entries({ ...values, ...defaults })) {
    if (!isNum(v)) throw new SetupError(`photo ${id}: ${k} must be a number`);
  }
  return {
    id,
    file: p.file ?? `${id}.${fmt === 'RAW' ? 'ARW' : fmt}`,
    fmt,
    flag,
    rating,
    label,
    values,
    defaults,
    locked: !!p.locked,
    applied: Array.isArray(p.applied) ? p.applied.map(String) : [],
  };
}

export class MockLightroom extends EventEmitter {
  constructor({ clock, log = () => {}, lrVersion = '15.3', testCatalog = TEST_CATALOG } = {}) {
    super();
    this.clock = clock;
    this.log = log;
    this.lrVersion = lrVersion;
    this.testCatalog = testCatalog;
    this.transport = { send: () => false, connected: () => false };
    this.timers = new Set();
    this.pollTimer = null;
    this.paused = false;
    this.pauseTimer = null;
    this.deferred = [];
    this.queue = [];
    this.queueTimer = null;
    this.queuePaid = false;
    this.setCostMs = 0;
    this.inst = newInst();
    this.load({});
  }

  // ---------- setup (PROTOCOL.md, Fixtures: setup) ----------

  load(setup = {}) {
    if (!isObject(setup)) throw new SetupError('setup must be an object');
    const photos = (setup.photos ?? []).map(normalizePhoto);
    const byId = new Map();
    for (const ph of photos) {
      if (byId.has(ph.id)) throw new SetupError(`photo ${ph.id} appears twice`);
      byId.set(ph.id, ph);
    }
    const module = setup.module ?? 'develop';
    if (!MODULES.includes(module)) throw new SetupError(`module must be one of ${MODULES.join(', ')}`);
    let selected = setup.selected != null ? setup.selected.map(String) : null;
    let target = setup.target != null ? String(setup.target) : (selected ? selected[0] : photos[0]?.id) ?? null;
    if (selected == null) selected = target ? [target] : [];
    for (const id of [...selected, ...(target ? [target] : [])]) {
      if (!byId.has(id)) throw new SetupError(`no photo ${id}`);
    }
    if (target && !selected.includes(target)) selected = [target, ...selected];
    if (selected.length > 0 && !target) target = selected[0];

    const ranges = {};
    if (setup.ranges != null) {
      if (!isObject(setup.ranges)) throw new SetupError('ranges must be {fmt: {param: [min, max]}}');
      for (const [fmt, table] of Object.entries(setup.ranges)) {
        if (!isObject(table)) throw new SetupError(`ranges.${fmt} must be {param: [min, max]}`);
        ranges[fmt.toUpperCase()] = {};
        for (const [p, r] of Object.entries(table)) {
          if (!Array.isArray(r) || r.length !== 2 || !r.every(isNum) || r[0] > r[1]) throw new SetupError(`ranges.${fmt}.${p} must be [min, max]`);
          ranges[fmt.toUpperCase()][p] = [r[0], r[1]];
        }
      }
    }
    this.extraParams = new Set();
    for (const ph of photos) for (const p of Object.keys({ ...ph.values, ...ph.defaults })) this.extraParams.add(p);
    for (const table of Object.values(ranges)) for (const p of Object.keys(table)) this.extraParams.add(p);

    const presets = (setup.presets ?? []).map((p, i) => {
      if (!isObject(p) || typeof p.uuid !== 'string') throw new SetupError(`presets[${i}] needs a uuid`);
      if (p.values != null && !isObject(p.values)) throw new SetupError(`preset ${p.uuid}: values must be an object`);
      return { uuid: p.uuid, name: String(p.name ?? p.uuid), folder: String(p.folder ?? 'User Presets'), values: p.values ? { ...p.values } : null };
    });

    // A fresh Lightroom: nothing pending from the old state may fire into the new one.
    this.cancelGesture();
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
    this.queue = [];
    this.queueTimer = null;
    this.queuePaid = false;
    this.photos = photos;
    this.byId = byId;
    this.catalog = setup.catalog ?? TEST_CATALOG;
    this.guardOn = setup.guard ?? true; // mock extension: only the user turns the guard off
    this.module = module;
    this.view = setup.view === 'before' ? 'before' : 'loupe';
    this.target = target;
    this.selected = selected;
    this.ranges = ranges;
    this.presets = presets;
    this.autoAdvance = !!setup.autoAdvance;
    this.watch = [];
    for (const p of setup.watch ?? []) {
      if (!this.isParamName(p)) throw new SetupError(`watch: unknown param ${p}`);
      if (!this.watch.includes(p)) this.watch.push(p);
    }
    this.history = [];
    this.busyUntil = -Infinity;
    this.lastBezelAt = -Infinity;
    this.bezels = 0;
    this.resetBaselines();
  }

  resetBaselines() {
    this.lastStateKey = null;
    this.lastVals = {};
    this.lastValsAt = -Infinity;
    this.lastPhoto = undefined;
    this.lastModule = undefined;
    this.forced = new Set();
    this.cancel(this.observerTimer);
    this.observerTimer = null;
  }

  setOptions({ autoAdvance, guard, setCostMs, lock } = {}) {
    if (autoAdvance !== undefined) this.autoAdvance = !!autoAdvance;
    if (guard !== undefined) this.guardOn = !!guard;
    if (setCostMs !== undefined) this.setCostMs = Math.max(0, Number(setCostMs) || 0);
    if (lock !== undefined) {
      for (const [id, on] of Object.entries(lock)) {
        const ph = this.byId.get(String(id));
        if (!ph) throw new SetupError(`no photo ${id}`);
        ph.locked = !!on;
      }
    }
  }

  setBusy(ms) {
    this.busyUntil = this.clock.now() + Math.max(0, ms);
  }

  // ---------- lifecycle ----------

  start() {
    if (this.pollTimer != null) return;
    this.pollTimer = this.clock.setInterval(() => {
      if (!this.paused) this.run(() => this.poll());
    }, TIMING.pollMs);
  }

  // Lightroom quits or the plugin unloads: every task stops, nothing more is sent.
  shutdown() {
    if (this.pollTimer != null) this.clock.clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
    if (this.pauseTimer != null) this.clock.clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this.paused = false;
    this.deferred = [];
    this.queue = [];
    this.queueTimer = null;
    this.queuePaid = false;
    this.cancelGesture();
    this.observerTimer = null;
  }

  // A new plugin instance: new inst, and the watch list (plugin state) starts empty again.
  boot({ catalog } = {}) {
    if (catalog) this.catalog = catalog;
    this.inst = newInst();
    this.watch = [];
    this.resetBaselines();
    this.start();
  }

  // Runs plugin code now, or after the open menu closes.
  run(fn) {
    if (this.paused) {
      this.deferred.push(fn);
      return;
    }
    try {
      fn();
    } catch (err) {
      this.log('error', `mock bug: ${err && err.stack ? err.stack : err}`);
    }
  }

  timer(ms, fn) {
    const h = this.clock.setTimeout(() => {
      this.timers.delete(h);
      this.run(fn);
    }, ms);
    this.timers.add(h);
    return h;
  }

  cancel(h) {
    if (h == null) return;
    this.clock.clearTimeout(h);
    this.timers.delete(h);
  }

  // A menu, dialog or the Plug-in Manager is open: plugin tasks pause and no lines are taken.
  pause(ms) {
    this.paused = true;
    if (this.pauseTimer != null) this.clock.clearTimeout(this.pauseTimer);
    this.pauseTimer = this.clock.setTimeout(() => this.resume(), Math.max(0, ms));
    this.log('lr', `paused for ${ms} ms, as if a menu were open: no ok, no reads, no events`);
  }

  resume() {
    if (this.pauseTimer != null) this.clock.clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    if (!this.paused) return;
    this.paused = false;
    const list = this.deferred;
    this.deferred = [];
    this.log('lr', `resumed: running ${list.length} waiting callback(s)`);
    for (const fn of list) this.run(fn);
  }

  // ---------- socket hooks ----------

  onEvtConnected() {
    this.greet();
  }

  // The cmd socket closed: the client is gone, so any open gesture ends.
  onClientGone(why) {
    if (this.gesture) this.endGesture(why);
  }

  // A line from the cmd socket. With setCostMs, set lines take that long each and later lines wait,
  // like Lightroom's main thread.
  receiveLine(line) {
    if (this.setCostMs > 0 || this.queue.length > 0 || this.queueTimer != null) {
      this.queue.push(line);
      if (this.queueTimer == null) this.pump();
      return;
    }
    this.handleLine(line);
  }

  pump() {
    while (this.queue.length > 0) {
      const line = this.queue[0];
      if (this.setCostMs > 0 && !this.queuePaid && /"t"\s*:\s*"set"/.test(line)) {
        this.queuePaid = true;
        this.queueTimer = this.timer(this.setCostMs, () => {
          this.queueTimer = null;
          this.pump();
        });
        return;
      }
      this.queue.shift();
      this.queuePaid = false;
      this.handleLine(line);
    }
  }

  handleLine(line) {
    const text = String(line).trim();
    if (text === '') return;
    let m;
    try {
      m = JSON.parse(text);
    } catch (err) {
      this.err(null, 'bad', `not JSON: ${err.message}`);
      return;
    }
    if (!isObject(m)) {
      this.err(null, 'bad', 'a command must be a JSON object');
      return;
    }
    if (typeof m.t !== 'string') {
      this.err(m, 'bad', 'a command needs a string t');
      return;
    }
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, m.t) ? HANDLERS[m.t] : null;
    if (!handler) {
      this.err(m, 'unknown', `unknown command ${m.t}`);
      return;
    }
    this.log('cmd', short(m));
    this.emit('command', m);
    try {
      handler.call(this, m);
    } catch (err) {
      this.err(m, 'failed', String(err && err.message ? err.message : err));
    }
  }

  // ---------- sending ----------

  send(obj) {
    const ok = this.transport.send(obj);
    if (ok) this.log('evt', short(obj));
    return ok;
  }

  err(m, code, msg) {
    const e = { t: 'err' };
    if (m && m.id !== undefined) e.id = m.id;
    if (m && typeof m.t === 'string') e.cmd = m.t;
    e.code = code;
    e.msg = msg;
    this.log('err', `${e.cmd ?? '-'}: ${code}: ${msg}`);
    this.send(e);
  }

  bad(m, msg) {
    this.err(m, 'bad', msg);
  }

  helloMsg() {
    return {
      t: 'hello',
      v: PROTOCOL_VERSION,
      lr: this.lrVersion,
      catalog: path.basename(this.catalog),
      path: this.catalog,
      guard: this.guardOn ? 'on' : 'off',
      writable: this.writable(),
      inst: this.inst,
      mock: true,
    };
  }

  stateMsg() {
    const ph = this.targetPhoto();
    return {
      t: 'state',
      module: this.module,
      photo: ph ? ph.id : null,
      file: ph ? ph.file : null,
      flag: ph ? ph.flag : 0,
      rating: ph ? ph.rating : 0,
      label: ph ? ph.label : 'none',
      sel: this.selected.length,
    };
  }

  // hello, state, then ranges and vals when in Develop with watched params.
  greet() {
    this.send(this.helloMsg());
    this.lastStateKey = null;
    this.refresh({ forceState: true, forceDevelop: true });
  }

  // Sends state if it changed (or forceState), then on a photo change or on entering Develop
  // (or forceDevelop) ranges and all watched vals. Always in that order.
  refresh({ forceState = false, forceDevelop = false } = {}) {
    if (!this.transport.connected()) return;
    const st = this.stateMsg();
    const key = JSON.stringify(st);
    if (forceState || key !== this.lastStateKey) {
      if (this.send(st)) this.lastStateKey = key;
    }
    const changed = this.lastPhoto !== this.target || this.lastModule !== this.module;
    if (changed || forceDevelop) {
      this.lastPhoto = this.target;
      this.lastModule = this.module;
      this.lastVals = {};
      this.forced.clear();
      if (this.inDevelopWithPhoto() && this.watch.length > 0) {
        this.send({ t: 'ranges', ranges: this.rangesFor(this.watch) });
        this.sendOwedVals();
      }
    }
  }

  // vals for every watched param, which the deck is owed after hello, watch, entering Develop and a
  // photo change. These count toward "vals at most 20 a second" too (PROTOCOL.md, Rates), as in the
  // plugin: within valsGapMs of the last vals they go out with the observer's next flush, which sends
  // every watched param because lastVals is cleared. Either way they come after state and ranges.
  sendOwedVals() {
    this.lastVals = {};
    if (this.clock.now() - this.lastValsAt < TIMING.valsGapMs) {
      this.scheduleObserver();
      return;
    }
    this.sendVals(this.watch);
  }

  sendVals(params) {
    const ph = this.targetPhoto();
    if (!ph) return false;
    const vals = {};
    for (const p of params) {
      if (this.gesture && this.gesture.p === p) continue; // the deck owns the tracked param
      vals[p] = this.getValue(ph, p);
    }
    if (Object.keys(vals).length === 0) return false;
    if (!this.send({ t: 'vals', vals })) return false;
    Object.assign(this.lastVals, vals);
    for (const p of Object.keys(vals)) this.forced.delete(p);
    this.lastValsAt = this.clock.now();
    return true;
  }

  // The observer's callback and the 200 ms value poll: send the watched params that changed since
  // they were last sent, leaving out the tracked one.
  flushVals() {
    if (!this.transport.connected()) return;
    if (this.lastPhoto !== this.target || this.lastModule !== this.module) {
      this.refresh();
      return;
    }
    if (!this.inDevelopWithPhoto()) return;
    const ph = this.targetPhoto();
    const changed = [];
    for (const p of this.watch) {
      if (this.gesture && this.gesture.p === p) {
        this.forced.delete(p);
        continue;
      }
      if (this.forced.has(p) || this.lastVals[p] !== this.getValue(ph, p)) changed.push(p);
    }
    if (changed.length === 0) return;
    if (this.clock.now() - this.lastValsAt < TIMING.valsGapMs) {
      this.scheduleObserver();
      return;
    }
    this.sendVals(changed);
  }

  scheduleObserver() {
    if (this.observerTimer != null) return;
    const due = Math.max(TIMING.observerMs, this.lastValsAt + TIMING.valsGapMs - this.clock.now());
    this.observerTimer = this.timer(due, () => {
      this.observerTimer = null;
      this.flushVals();
    });
  }

  poll() {
    if (!this.transport.connected()) return;
    this.refresh();
    this.flushVals();
  }

  // ---------- catalog model ----------

  isParamName(p) {
    return typeof p === 'string' && (PARAM_SET.has(p) || this.extraParams.has(p));
  }

  targetPhoto() {
    return this.target != null ? this.byId.get(this.target) ?? null : null;
  }

  selectedPhotos() {
    return this.selected.map((id) => this.byId.get(id)).filter(Boolean);
  }

  inDevelopWithPhoto() {
    return this.module === 'develop' && this.targetPhoto() != null;
  }

  range(ph, p) {
    const table = this.ranges[ph.fmt];
    return table && table[p] ? [...table[p]] : defaultRange(ph.fmt, p);
  }

  rangesFor(params) {
    const ph = this.targetPhoto();
    const out = {};
    for (const p of params) out[p] = this.range(ph, p);
    return out;
  }

  defaultOf(ph, p) {
    return isNum(ph.defaults[p]) ? ph.defaults[p] : defaultValue(ph.fmt, p);
  }

  getValue(ph, p) {
    return isNum(ph.values[p]) ? ph.values[p] : this.defaultOf(ph, p);
  }

  writable() {
    return !this.guardOn || String(this.catalog).toLowerCase() === this.testCatalog.toLowerCase();
  }

  guardOk(m) {
    if (this.writable()) return true;
    this.err(m, 'guard', 'writes are off: the test catalog is not open');
    const t = this.clock.now();
    if (t - this.lastBezelAt >= TIMING.bezelGapMs) {
      this.lastBezelAt = t;
      this.bezels += 1;
      this.log('bezel', 'Deck Bridge: writes are off (not the test catalog)');
    }
    return false;
  }

  setTarget(id, selected = id == null ? [] : [id]) {
    if (this.gesture && id !== this.target) this.endGesture('the photo changed');
    this.target = id;
    this.selected = selected;
  }

  // LrSelection.nextPhoto() / previousPhoto(): the neighbour becomes the only selected photo.
  navigate(dir) {
    const i = this.photos.findIndex((p) => p.id === this.target);
    if (i < 0) return false;
    const j = i + dir;
    if (j < 0 || j >= this.photos.length) return false;
    this.setTarget(this.photos[j].id);
    this.log('lr', `${dir > 0 ? 'nextPhoto' : 'previousPhoto'} → ${this.target}`);
    return true;
  }

  switchModule(name) {
    if (this.module === name) return false;
    if (this.module === 'develop' && this.gesture) this.endGesture('left Develop');
    this.module = name;
    this.log('lr', `module → ${name}`);
    return true;
  }

  ensureDevelop() {
    if (this.module === 'develop') return;
    this.switchModule('develop');
    this.refresh({ forceState: true });
  }

  // LrSelection's rule: with the Library grid, all selected photos; otherwise the active photo.
  flagScope() {
    if (this.module === 'library') return this.selectedPhotos();
    const ph = this.targetPhoto();
    return ph ? [ph] : [];
  }

  applyFlag(value) {
    for (const ph of this.flagScope()) ph.flag = value;
  }

  // Lightroom's own Auto Advance, when it's on.
  lrAutoAdvance(flaggedId) {
    if (!this.autoAdvance) return;
    this.timer(TIMING.autoAdvanceMs, () => {
      if (this.target === flaggedId && this.navigate(1)) this.log('lr', 'Auto Advance moved on');
    });
  }

  // ---------- gestures (PROTOCOL.md, Gestures) ----------

  startGesture(p, g) {
    const ph = this.targetPhoto();
    this.gesture = { p, g, photo: ph.id, from: this.getValue(ph, p), sets: 0, timer: null };
    this.forced.delete(p);
    this.log('dev', `startTracking ${p} (g ${g})`);
  }

  touchGesture() {
    const gs = this.gesture;
    this.cancel(gs.timer);
    gs.timer = this.timer(TIMING.gestureTimeoutMs, () => {
      if (this.gesture === gs) this.endGesture('no set for 2 s');
    });
  }

  // stopTracking(): one history step, then the observer fires once.
  endGesture(why) {
    const gs = this.gesture;
    if (!gs) return;
    this.cancel(gs.timer);
    this.gesture = null;
    const ph = this.byId.get(gs.photo);
    const to = ph ? this.getValue(ph, gs.p) : null;
    this.history.push({ kind: 'gesture', p: gs.p, g: gs.g, photo: gs.photo, from: gs.from, to, sets: gs.sets, why });
    this.log('dev', `stopTracking ${gs.p} (g ${gs.g}: ${why})`);
    if (ph && ph.id === this.target) this.forced.add(gs.p);
    this.scheduleObserver();
  }

  // Drops an open gesture without the observer, for setup and shutdown.
  cancelGesture() {
    if (this.gesture) this.cancel(this.gesture.timer);
    this.gesture = null;
  }

  // ---------- control: user actions, expect lines, snapshots ----------

  // PROTOCOL.md, Fixtures: user lines. photo, selected, module, edit; plus flag, rating and label for the REPL.
  user(action) {
    if (!isObject(action)) throw new SetupError('a user action is an object');
    for (const [key, v] of Object.entries(action)) {
      switch (key) {
        case 'photo': {
          const id = String(v);
          if (!this.byId.has(id)) throw new SetupError(`no photo ${id}`);
          this.setTarget(id, [id]);
          break;
        }
        case 'selected': {
          if (!Array.isArray(v)) throw new SetupError('selected must be a list of photo ids');
          const ids = v.map(String);
          for (const id of ids) if (!this.byId.has(id)) throw new SetupError(`no photo ${id}`);
          this.setTarget(ids[0] ?? null, ids);
          break;
        }
        case 'module':
          if (!MODULES.includes(v)) throw new SetupError(`module must be one of ${MODULES.join(', ')}`);
          this.switchModule(v);
          break;
        case 'edit': {
          if (!isObject(v)) throw new SetupError('edit must be {param: value}');
          const ph = this.targetPhoto();
          if (!ph) throw new SetupError('edit needs a target photo');
          for (const [p, x] of Object.entries(v)) {
            if (!this.isParamName(p)) throw new SetupError(`edit: unknown param ${p}`);
            if (!isNum(x)) throw new SetupError(`edit: ${p} must be a number`);
            const from = this.getValue(ph, p);
            ph.values[p] = x;
            this.history.push({ kind: 'edit', p, photo: ph.id, from, to: x });
          }
          if (!this.gesture) this.scheduleObserver(); // silent during a tracked gesture; the poll catches it
          break;
        }
        case 'flag': {
          const value = typeof v === 'number' ? v : FLAG_VALUES[v];
          if (![-1, 0, 1].includes(value)) throw new SetupError('flag must be pick, reject or none');
          const flagged = this.target;
          this.applyFlag(value);
          this.lrAutoAdvance(flagged);
          break;
        }
        case 'rating':
          if (!Number.isInteger(v) || v < 0 || v > 5) throw new SetupError('rating must be 0-5');
          for (const ph of this.flagScope()) ph.rating = v;
          break;
        case 'label':
          if (!LABELS.includes(v)) throw new SetupError(`label must be one of ${LABELS.join(', ')}`);
          for (const ph of this.flagScope()) ph.label = v;
          break;
        default:
          throw new SetupError(`unknown user action "${key}"`);
      }
    }
  }

  // PROTOCOL.md, Fixtures: expect lines. Returns { ok, errors }.
  expect(exp) {
    const errors = [];
    if (!isObject(exp)) return { ok: false, errors: ['expect must be an object'] };
    const near = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) <= 1e-6;
    for (const [key, want] of Object.entries(exp)) {
      switch (key) {
        case 'values':
          for (const [id, vals] of Object.entries(want ?? {})) {
            const ph = this.byId.get(id);
            if (!ph) { errors.push(`values: no photo ${id}`); continue; }
            for (const [p, x] of Object.entries(vals ?? {})) {
              const got = this.getValue(ph, p);
              if (!near(got, x)) errors.push(`values.${id}.${p}: expected ${x}, got ${got}`);
            }
          }
          break;
        case 'flags':
          for (const [id, x] of Object.entries(want ?? {})) {
            const ph = this.byId.get(id);
            if (!ph) errors.push(`flags: no photo ${id}`);
            else if (ph.flag !== x) errors.push(`flags.${id}: expected ${x}, got ${ph.flag}`);
          }
          break;
        case 'target':
          if (this.target !== (want == null ? null : String(want))) errors.push(`target: expected ${want}, got ${this.target}`);
          break;
        case 'module':
          if (this.module !== want) errors.push(`module: expected ${want}, got ${this.module}`);
          break;
        case 'view':
          if (this.view !== want) errors.push(`view: expected ${want}, got ${this.view}`);
          break;
        case 'tracking':
          if (!!this.gesture !== want) errors.push(`tracking: expected ${want}, got ${!!this.gesture}${this.gesture ? ` (${this.gesture.p}, g ${this.gesture.g})` : ''}`);
          break;
        case 'applied': {
          // Exact: the photos with presets applied, and the uuids in order. {} means none.
          const got = {};
          for (const ph of this.photos) if (ph.applied.length) got[ph.id] = ph.applied;
          const ids = new Set([...Object.keys(got), ...Object.keys(want ?? {})]);
          for (const id of ids) {
            const a = got[id] ?? [];
            const w = (want ?? {})[id] ?? [];
            if (a.length !== w.length || a.some((u, i) => u !== w[i])) errors.push(`applied.${id}: expected ${short(w)}, got ${short(a)}`);
          }
          break;
        }
        default:
          errors.push(`expect: "${key}" isn't a field PROTOCOL.md defines (values, flags, target, module, view, tracking, applied)`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  snapshot() {
    const photos = {};
    for (const ph of this.photos) {
      const values = {};
      for (const p of BANK_PARAMS) values[p] = this.getValue(ph, p);
      Object.assign(values, ph.values);
      photos[ph.id] = { file: ph.file, fmt: ph.fmt, flag: ph.flag, rating: ph.rating, label: ph.label, locked: ph.locked, values, applied: [...ph.applied] };
    }
    return {
      inst: this.inst,
      lr: this.lrVersion,
      catalog: this.catalog,
      guard: this.guardOn,
      writable: this.writable(),
      module: this.module,
      view: this.view,
      target: this.target,
      selected: [...this.selected],
      order: this.photos.map((p) => p.id),
      autoAdvance: this.autoAdvance,
      watch: [...this.watch],
      tracking: !!this.gesture,
      gesture: this.gesture ? { p: this.gesture.p, g: this.gesture.g, photo: this.gesture.photo } : null,
      photos,
      presets: this.presets.map((p) => ({ ...p, values: p.values ? { ...p.values } : null })),
      history: clone(this.history),
      paused: this.paused,
      busy: this.busyUntil > this.clock.now(),
      bezels: this.bezels,
      setCostMs: this.setCostMs,
    };
  }
}

// ---------- command handlers (PROTOCOL.md, Commands) ----------

const HANDLERS = {
  hello() {
    this.greet();
  },

  ping(m) {
    this.send({ t: 'pong', id: m.id, lt: lrTime(this.clock.wall()) });
  },

  watch(m) {
    if (!Array.isArray(m.ps)) {
      this.bad(m, 'watch needs ps, a list of params');
      return;
    }
    const keep = [];
    const dropped = [];
    for (const p of m.ps) {
      if (this.isParamName(p)) {
        if (!keep.includes(p)) keep.push(p);
      } else {
        dropped.push(p);
      }
    }
    if (dropped.length > 0) this.bad(m, `unknown params dropped from the watch list: ${dropped.map((p) => short(p)).join(', ')}`);
    this.watch = keep;
    if (this.inDevelopWithPhoto() && keep.length > 0) {
      this.send({ t: 'ranges', ranges: this.rangesFor(keep) });
      this.sendOwedVals();
    }
  },

  set(m) {
    if (!this.isParamName(m.p)) {
      this.bad(m, `set needs p, a Develop param; got ${short(m.p)}`);
      return;
    }
    if (!isNum(m.v)) {
      this.bad(m, 'set needs v, a number');
      return;
    }
    if (!isNum(m.g)) {
      this.bad(m, 'set needs g, the gesture number');
      return;
    }
    if (!this.guardOk(m)) return;
    if (!this.targetPhoto()) {
      this.err(m, 'noPhoto', 'no target photo');
      return;
    }
    this.ensureDevelop();
    if (this.gesture && (this.gesture.p !== m.p || this.gesture.g !== m.g)) this.endGesture(`a set for ${m.p}, g ${m.g}`);
    if (!this.gesture) this.startGesture(m.p, m.g);
    this.touchGesture();
    const ph = this.targetPhoto();
    const [lo, hi] = this.range(ph, m.p);
    ph.values[m.p] = Math.min(hi, Math.max(lo, m.v)); // setValue clamps nothing, so Lightroom clamps first
    this.gesture.sets += 1;
    this.send({ t: 'ack', p: m.p, v: this.getValue(ph, m.p), g: m.g });
  },

  done(m) {
    if (m.g !== undefined && !isNum(m.g)) {
      this.bad(m, 'done: g must be a number');
      return;
    }
    if (!this.gesture) return;
    if (m.g !== undefined && m.g !== this.gesture.g) return; // that gesture already ended
    this.endGesture('done');
  },

  reset(m) {
    if (!this.isParamName(m.p)) {
      this.bad(m, `reset needs p, a Develop param; got ${short(m.p)}`);
      return;
    }
    if (!this.guardOk(m)) return;
    const ph = this.targetPhoto();
    if (!ph) {
      this.err(m, 'noPhoto', 'no target photo');
      return;
    }
    this.ensureDevelop();
    if (this.gesture) this.endGesture('reset');
    const from = this.getValue(ph, m.p);
    ph.values[m.p] = this.defaultOf(ph, m.p);
    this.history.push({ kind: 'reset', p: m.p, photo: ph.id, from, to: ph.values[m.p] });
    this.scheduleObserver();
    this.send({ t: 'ack', p: m.p, v: this.getValue(ph, m.p) });
  },

  module(m) {
    if (m.v !== 'develop' && m.v !== 'library') {
      this.bad(m, 'module v must be "develop" or "library"');
      return;
    }
    this.switchModule(m.v);
    this.refresh({ forceState: true, forceDevelop: m.v === 'develop' });
  },

  flag(m) {
    if (!Object.prototype.hasOwnProperty.call(FLAG_VALUES, m.v)) {
      this.bad(m, 'flag v must be "pick", "reject" or "none"');
      return;
    }
    if (m.advance !== undefined && typeof m.advance !== 'boolean') {
      this.bad(m, 'flag advance must be true or false');
      return;
    }
    if (!this.guardOk(m)) return;
    const ph = this.targetPhoto();
    if (!ph) {
      this.err(m, 'noPhoto', 'no target photo');
      return;
    }
    const flagged = ph.id;
    this.applyFlag(FLAG_VALUES[m.v]);
    this.log('lr', `${m.v === 'pick' ? 'flagAsPick' : m.v === 'reject' ? 'flagAsReject' : 'removeFlag'} on ${flagged}`);
    this.refresh({ forceState: true });
    this.lrAutoAdvance(flagged);
    if (m.advance) {
      this.timer(TIMING.advanceMs, () => {
        if (this.target === flagged) this.navigate(1);
        else this.log('lr', 'advance skipped: the target photo already changed (Auto Advance)');
        this.refresh({ forceState: true });
      });
    }
  },

  nav(m) {
    if (m.v !== 'next' && m.v !== 'prev') {
      this.bad(m, 'nav v must be "next" or "prev"');
      return;
    }
    this.navigate(m.v === 'next' ? 1 : -1);
    this.refresh({ forceState: true });
  },

  view(m) {
    if (m.v !== 'before' && m.v !== 'after') {
      this.bad(m, 'view v must be "before" or "after"');
      return;
    }
    this.ensureDevelop();
    this.view = m.v === 'before' ? 'before' : 'loupe';
    this.log('lr', `showView('${m.v === 'before' ? 'develop_before' : 'develop_loupe'}')`);
  },

  presets(m) {
    this.send({ t: 'presets', id: m.id, items: this.presets.map(({ uuid, name, folder }) => ({ uuid, name, folder })) });
  },

  preset(m) {
    if (typeof m.uuid !== 'string' || m.uuid === '') {
      this.bad(m, 'preset needs uuid');
      return;
    }
    if (!this.guardOk(m)) return;
    const preset = this.presets.find((p) => p.uuid === m.uuid);
    if (!preset) {
      this.err(m, 'notFound', `no preset with uuid ${m.uuid}`);
      return;
    }
    if (!this.targetPhoto()) {
      this.err(m, 'noPhoto', 'no target photo');
      return;
    }
    const wait = this.busyUntil - this.clock.now();
    if (wait > 0) {
      if (wait > TIMING.writeTimeoutMs) {
        this.timer(TIMING.writeTimeoutMs, () => this.err(m, 'busy', 'withWriteAccessDo timed out after 3 s: the catalog is busy'));
      } else {
        this.timer(wait, () => applyPreset.call(this, m, preset));
      }
      return;
    }
    applyPreset.call(this, m, preset);
  },

  reload(m) {
    if (m.mods !== undefined && !(Array.isArray(m.mods) && m.mods.every((x) => typeof x === 'string'))) {
      this.bad(m, 'reload mods must be a list of module names');
      return;
    }
    // Like the plugin: every name must be reloadable, or nothing reloads. (The mock reloads nothing.)
    const mods = m.mods ?? [...RELOADABLE];
    const refused = mods.find((x) => !RELOADABLE.includes(x));
    const ok = refused === undefined;
    const msg = ok ? `reloaded ${mods.join(', ')}` : `${refused} doesn't hot-reload; use Reload Plug-in`;
    this.send({ t: 'reloaded', id: m.id, mods, ok, msg });
  },
};

// One withWriteAccessDo over getTargetPhotos(), skipping photos locked by background AI.
function applyPreset(m, preset) {
  if (!this.targetPhoto()) {
    this.err(m, 'noPhoto', 'no target photo');
    return;
  }
  if (this.gesture) this.endGesture('a preset was applied');
  let n = 0;
  let locked = 0;
  let touchedTarget = false;
  for (const ph of this.selectedPhotos()) {
    if (ph.locked) {
      locked += 1;
      continue;
    }
    ph.applied.push(preset.uuid);
    if (preset.values) Object.assign(ph.values, preset.values);
    if (ph.id === this.target) touchedTarget = true;
    n += 1;
  }
  this.history.push({ kind: 'preset', uuid: preset.uuid, n, locked });
  this.log('lr', `applied "${preset.name}" to ${n} photo(s), skipped ${locked} locked`);
  if (touchedTarget && preset.values && Object.keys(preset.values).length > 0) this.scheduleObserver();
  this.send({ t: 'applied', id: m.id, uuid: preset.uuid, n, locked });
}
