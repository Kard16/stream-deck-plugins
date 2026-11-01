// The mock Lightroom's model: DeckBridge protocol v1 (lightroom/protocol/PROTOCOL.md) on top of a fake
// catalog, with the behaviour spikes S1-S5 measured on Lightroom Classic 15.3 (docs/lightroom/plan.md, Log):
// - the adjustment observer stays silent during a tracked gesture and fires once, ~4 ms after stopTracking;
// - a 200 ms poll diffs state and the watched values (the observer doesn't say what changed);
// - ranges depend on the file format (Temperature is Kelvin on raw, -100..100 on JPEG);
// - writes go through only while the test catalog is open (the guard), compared without case;
// - while a menu is open (pause), plugin tasks and socket callbacks wait until it closes.
// Like the plugin (Poll.sync), it learns of the user's photo and module changes only from its poll; a set can
// reach one first. A gesture belongs to the photo it started on: once the photo or module changes under it,
// its later sets get err stale (PROTOCOL.md, Gestures). So does a set or reset whose ph, the photo the deck
// worked from, isn't the target photo, and one whose target photo changed while Lightroom switched to Develop
// for it. The poll also reads whether a background AI process holds the target photo, and set and reset on it
// get err locked by that reading, before a switch to Develop and again after it (PROTOCOL.md, Locked photos).
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
  moduleWaitMs: 1000, // a handler waits this long for a module switch (Config.MODULE_SECS)
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
// set and reset may carry ph, the photo from the latest state the deck has: optional, but a string when
// present. JSON null counts as absent, as in the plugin, whose JSON decoder drops null fields.
const hasPh = (m) => m.ph !== undefined && m.ph !== null;
const badPh = (m) => hasPh(m) && typeof m.ph !== 'string';

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
    this.protocolVersion = PROTOCOL_VERSION; // the v that hello says
    this.moduleDelayMs = 0; // a module switch the plugin asks for lands this long after
    this.moduleWaitMs = TIMING.moduleWaitMs; // how long the plugin's handlers wait for it
    this.pollWaiters = []; // nextPoll() promises
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
    this.waiting = null; // a handler waiting for a module switch: later lines queue behind it
    this.pendingSwitch = null; // a module switch on its way: { name, timer }
    this.lockRead = null; // the poll's latest lock reading: { photo, locked }
    this.pollHeldUntil = -Infinity; // holdPoll(): the poll reads nothing until then
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
    this.watchId = undefined; // the id of the watch that set the list, for its late err bad
    this.watchChecked = true; // whether unknown params have been dropped from the list yet
    this.staleG = null; // g of a gesture that ended when the photo or module changed
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
    this.cancel(this.observerTimer);
    this.observerTimer = null;
  }

  // autoAdvance, guard and lock change what the setup said. setCostMs, protocolVersion, moduleDelayMs and
  // moduleWaitMs last across setup() and relaunches.
  setOptions({ autoAdvance, guard, setCostMs, lock, protocolVersion, moduleDelayMs, moduleWaitMs } = {}) {
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
    if (protocolVersion !== undefined) this.protocolVersion = protocolVersion;
    if (moduleDelayMs !== undefined) this.moduleDelayMs = Math.max(0, Number(moduleDelayMs) || 0);
    if (moduleWaitMs !== undefined) this.moduleWaitMs = Math.max(0, Number(moduleWaitMs) || 0);
  }

  setBusy(ms) {
    this.busyUntil = this.clock.now() + Math.max(0, ms);
  }

  // The poll runs late: for ms it reads nothing, so the mock notices no photo or module change by itself that
  // long. A command or the observer can still make it read the state (refresh). 0 lets the next poll run.
  holdPoll(ms) {
    this.pollHeldUntil = this.clock.now() + Math.max(0, Number(ms) || 0);
  }

  // Resolves just after the next poll has run: on the manual clock, during the advance that runs it.
  nextPoll() {
    return new Promise((resolve) => { this.pollWaiters.push(resolve); });
  }

  // ---------- lifecycle ----------

  start() {
    if (this.pollTimer != null) return;
    this.pollTimer = this.clock.setInterval(() => {
      if (!this.paused) this.run(() => this.poll());
    }, TIMING.pollMs);
  }

  // Lightroom quits or the plugin unloads: every task stops, nothing more is sent. An open gesture ends
  // as if done had arrived, so it is still one history step (Shutdown.lua).
  shutdown() {
    if (this.gesture) this.endGesture('shutdown');
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
    this.waiting = null;
    this.pendingSwitch = null;
    this.cancelGesture();
    this.observerTimer = null;
  }

  // A new plugin instance: new inst, and the plugin's state (the watch list, a stale g, the lock reading)
  // starts empty again.
  boot({ catalog } = {}) {
    if (catalog) this.catalog = catalog;
    this.inst = newInst();
    this.watch = [];
    this.watchId = undefined;
    this.watchChecked = true;
    this.staleG = null;
    this.lockRead = null;
    this.pollHeldUntil = -Infinity;
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
  // like Lightroom's main thread. While a handler waits for a module switch, the plugin's dispatch task is
  // busy: ping and lines it can't route are handled at once, and every other command queues behind it.
  receiveLine(line) {
    if (this.waiting && this.queueTimer == null && this.jumpsQueue(line)) {
      this.handleLine(line);
      return;
    }
    if (this.setCostMs > 0 || this.queue.length > 0 || this.queueTimer != null || this.waiting) {
      this.queue.push(line);
      if (this.queueTimer == null) this.pump();
      return;
    }
    this.handleLine(line);
  }

  // Whether the plugin's dispatcher handles a line at once even while its queue is busy: ping, and the
  // lines it answers with an err straight away, since they aren't commands it knows (Dispatch.onLine).
  jumpsQueue(line) {
    let m;
    try {
      m = JSON.parse(String(line).trim());
    } catch {
      return true;
    }
    if (!isObject(m) || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, m.t)) return true;
    return m.t === 'ping';
  }

  pump() {
    while (this.queue.length > 0 && !this.waiting) {
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
      v: this.protocolVersion,
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
      locked: ph ? this.lockedNow() : false,
    };
  }

  // hello, state, then ranges and vals when in Develop with watched params. A restarted deck numbers its
  // gestures from 1 again, so the greeting forgets a stale g (Core.greeting).
  greet() {
    this.staleG = null;
    this.send(this.helloMsg());
    this.lastStateKey = null;
    this.refresh({ forceState: true, forceDevelop: true });
  }

  // Ends an open gesture the target photo or the module moved away from, as stale: the plugin's poll does
  // this (Poll.sync), so a change the user or Lightroom's own Auto Advance made ends the gesture here.
  noticeMoves() {
    const gs = this.gesture;
    if (!gs) return;
    if (this.module !== 'develop') this.endGesture('left Develop', true);
    else if (gs.photo !== this.target) this.endGesture('the photo changed', true);
  }

  // Ends a gesture the target photo or module moved away from and reads the lock, then sends state if it
  // changed (or forceState), then on a photo change or on entering Develop (or forceDevelop) ranges and all
  // watched vals. Always in that order. This is the plugin's Poll.sync, which commands and the observer
  // run too.
  refresh({ forceState = false, forceDevelop = false } = {}) {
    this.noticeMoves();
    this.readLock();
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
      if (this.inDevelopWithPhoto()) {
        this.checkWatch();
        if (this.watch.length > 0) {
          this.send({ t: 'ranges', ranges: this.rangesFor(this.watch) });
          this.sendOwedVals();
        }
      }
    }
  }

  // getRange works only in Develop with a photo, so the plugin drops unknown watched params once it's there:
  // at once for a watch sent there, otherwise on entering it. Their err bad carries the watch's id.
  checkWatch() {
    if (this.watchChecked || !this.inDevelopWithPhoto()) return;
    this.watchChecked = true;
    const unknown = this.watch.filter((p) => !this.isParamName(p));
    if (unknown.length === 0) return;
    this.watch = this.watch.filter((p) => this.isParamName(p));
    this.err({ t: 'watch', id: this.watchId }, 'bad', `unknown params dropped from the watch list: ${unknown.map((p) => short(p)).join(', ')}`);
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
    this.lastValsAt = this.clock.now();
    return true;
  }

  // The observer's callback and the 200 ms value poll: send the watched params that changed since
  // they were last sent, leaving out the tracked one. So after a gesture, vals carry its final value
  // only if it differs from the last value sent for its param (PROTOCOL.md, Commands: done).
  flushVals() {
    if (!this.transport.connected()) return;
    if (this.lastPhoto !== this.target || this.lastModule !== this.module) {
      this.refresh();
      return;
    }
    if (!this.inDevelopWithPhoto()) return;
    this.checkWatch();
    const ph = this.targetPhoto();
    const changed = [];
    for (const p of this.watch) {
      if (this.gesture && this.gesture.p === p) continue;
      if (this.lastVals[p] !== this.getValue(ph, p)) changed.push(p);
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

  // Like the plugin's, the poll ends gestures the photo or module moved away from, and reads the lock, even
  // with no client. While it's held (holdPoll), it reads nothing.
  poll() {
    if (this.clock.now() < this.pollHeldUntil) return;
    this.noticeMoves();
    this.readLock();
    if (this.transport.connected()) {
      this.refresh();
      this.flushVals();
    }
    const waiters = this.pollWaiters;
    this.pollWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // The poll's isAvailableForEditing() reading for the target photo (PROTOCOL.md, Locked photos). state.locked
  // and the checks in set and reset go by it, so a write can still land in the 200 ms after a lock starts.
  readLock() {
    const ph = this.targetPhoto();
    this.lockRead = { photo: ph ? ph.id : null, locked: !!(ph && ph.locked) };
  }

  // The latest reading, when it was taken for the current target photo: false until the poll has read that
  // photo (Develop.isLocked).
  lockedNow() {
    const r = this.lockRead;
    return r != null && r.photo != null && r.photo === this.target && r.locked;
  }

  // Whether a set or reset's ph rules it out as stale: it isn't the target photo's id. No target photo is a
  // mismatch too. Commands without ph aren't checked.
  wrongPhoto(m) {
    return hasPh(m) && m.ph !== this.target;
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

  // Why writes are refused, in Guard.writable's words, or null when they go through.
  whyNotWritable() {
    if (!this.guardOn || String(this.catalog).toLowerCase() === this.testCatalog.toLowerCase()) return null;
    return "the test catalog isn't open";
  }

  writable() {
    return this.whyNotWritable() == null;
  }

  guardOk(m) {
    const why = this.whyNotWritable();
    if (why == null) return true;
    this.err(m, 'guard', `writes are off: ${why}`);
    const t = this.clock.now();
    if (t - this.lastBezelAt >= TIMING.bezelGapMs) {
      this.lastBezelAt = t;
      this.bezels += 1;
      this.log('bezel', `Deck Bridge: writes are off (${why})`);
    }
    return false;
  }

  // The target photo changes in Lightroom. An open gesture ends when the poll, or a set for it, notices.
  setTarget(id, selected = id == null ? [] : [id]) {
    this.target = id;
    this.selected = selected;
  }

  // The photo LrSelection.nextPhoto() / previousPhoto() moves to, or null at either end of the filmstrip.
  neighbour(dir) {
    const i = this.photos.findIndex((p) => p.id === this.target);
    const j = i + dir;
    return i >= 0 && j >= 0 && j < this.photos.length ? this.photos[j].id : null;
  }

  // LrSelection.nextPhoto() / previousPhoto(): the neighbour becomes the only selected photo.
  navigate(dir) {
    const id = this.neighbour(dir);
    if (id == null) return false;
    this.setTarget(id);
    this.log('lr', `${dir > 0 ? 'nextPhoto' : 'previousPhoto'} → ${this.target}`);
    return true;
  }

  // The deck's nav and a flag's advance end the open gesture first, as stale (Library.nav and Library.flag),
  // even at an end of the filmstrip where nothing moves: refusing the deck's later sets for it is safer than
  // applying them to the wrong photo.
  navigateForDeck(dir, why) {
    this.endGesture(why, true);
    return this.navigate(dir);
  }

  // The module changes. An open gesture ends when the poll notices it left Develop; the module command
  // ends it itself.
  switchModule(name) {
    if (this.module === name) return false;
    this.module = name;
    this.log('lr', `module → ${name}`);
    return true;
  }

  // LrApplicationView.switchToModule: the switch lands at once, or moduleDelayMs later. then(ok) runs once
  // Lightroom is in that module, or with ok false when it still isn't after moduleWaitMs, which is as long as
  // the plugin's handlers wait (Library.switchTo, Develop.ensureDevelop). Meanwhile later lines queue behind
  // the handler (receiveLine). A switch that lands after the wait still lands, and the poll notices it.
  askModule(name, then) {
    if (this.module === name) {
      // Already there, so the plugin asks Lightroom for nothing (Library.switchTo): a switch still on its way
      // elsewhere lands all the same, and the poll reports it.
      then(true);
      return;
    }
    if (this.moduleDelayMs <= 0) {
      this.switchModule(name);
      then(true);
      return;
    }
    this.scheduleSwitch(name);
    const w = { name, timer: null, landed: null };
    const finish = (ok) => {
      if (this.waiting !== w) return;
      this.cancel(w.timer);
      this.waiting = null;
      then(ok);
      this.pump();
    };
    w.landed = () => finish(true);
    w.timer = this.timer(this.moduleWaitMs, () => finish(this.module === name));
    this.waiting = w;
  }

  // A switch already on its way to the same module keeps its time; one to another module replaces it.
  scheduleSwitch(name) {
    const pending = this.pendingSwitch;
    if (pending && pending.name === name) return;
    if (pending) this.cancel(pending.timer);
    const sw = { name, timer: null };
    sw.timer = this.timer(this.moduleDelayMs, () => {
      if (this.pendingSwitch !== sw) return;
      this.pendingSwitch = null;
      this.switchModule(name);
      if (this.waiting && this.waiting.name === name) this.waiting.landed();
    });
    this.pendingSwitch = sw;
    this.log('lr', `switchToModule('${name}'): Lightroom gets there in ${this.moduleDelayMs} ms`);
  }

  // Switches to Develop if needed, then runs then(switched), switched saying whether it had to; m gets err
  // noDevelop instead when Lightroom isn't there within the wait (Develop.ensureDevelop).
  ensureDevelop(m, then) {
    if (this.module === 'develop') {
      then(false);
      return;
    }
    this.askModule('develop', (ok) => {
      if (!ok) {
        this.err(m, 'noDevelop', 'could not switch to Develop');
        return;
      }
      this.refresh({ forceState: true });
      then(true);
    });
  }

  // After a set or reset made Lightroom switch to Develop, it reads the target photo again: during the switch the
  // user can pick another photo, and the poll can read a lock (PROTOCOL.md, Gestures: the photo the deck worked
  // from). photo is the target the command's earlier checks were made against. Answers m and returns its err code
  // when it's refused, otherwise null; the caller makes a set's g stale on 'stale'.
  refusedAfterSwitch(m, photo) {
    if (this.target !== photo) {
      this.err(m, 'stale', `the target photo changed while Lightroom switched to Develop (${photo ?? 'none'} to ${this.target ?? 'none'})`);
      return 'stale';
    }
    if (this.lockedNow()) {
      this.err(m, 'locked', `photo ${this.target} was locked by a background AI process while Lightroom switched to Develop`);
      return 'locked';
    }
    return null;
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

  // A gesture belongs to the photo it started on: the target photo its first set was checked against, which a set
  // that switched to Develop checks again once there (Develop.set), so it's also the photo its sets change. A new
  // gesture means the deck has moved on, so a stale g is forgotten.
  startGesture(p, g) {
    const ph = this.targetPhoto();
    this.gesture = { p, g, photo: ph.id, from: this.getValue(ph, p), sets: 0, timer: null };
    this.staleG = null;
    this.log('dev', `startTracking ${p} (g ${g})`);
  }

  touchGesture() {
    const gs = this.gesture;
    this.cancel(gs.timer);
    gs.timer = this.timer(TIMING.gestureTimeoutMs, () => {
      if (this.gesture === gs) this.endGesture('no set for 2 s');
    });
  }

  // stopTracking(): one history step, then the observer fires once. stale is true when the gesture ends
  // because the target photo or the module changed: its g is remembered, and later sets with it get
  // err stale (Develop.endGesture).
  endGesture(why, stale = false) {
    const gs = this.gesture;
    if (!gs) return;
    this.cancel(gs.timer);
    this.gesture = null;
    if (stale) this.staleG = gs.g;
    const ph = this.byId.get(gs.photo);
    const to = ph ? this.getValue(ph, gs.p) : null;
    this.history.push({ kind: 'gesture', p: gs.p, g: gs.g, photo: gs.photo, from: gs.from, to, sets: gs.sets, why, stale });
    this.log('dev', `stopTracking ${gs.p} (g ${gs.g}: ${why}${stale ? '; its later sets are stale' : ''})`);
    this.scheduleObserver();
  }

  // Drops an open gesture without the observer, for setup and shutdown.
  cancelGesture() {
    if (this.gesture) this.cancel(this.gesture.timer);
    this.gesture = null;
  }

  // ---------- control: user actions, expect lines, snapshots ----------

  // PROTOCOL.md, Fixtures: user lines. photo, selected, module, edit, locked; plus flag, rating and label for
  // the REPL.
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
        case 'locked': {
          // Exactly these photos are locked, as if a background AI process held them; [] unlocks every photo.
          // The poll reads it for the target photo.
          if (!Array.isArray(v)) throw new SetupError('locked must be a list of photo ids');
          const ids = v.map(String);
          for (const id of ids) if (!this.byId.has(id)) throw new SetupError(`no photo ${id}`);
          for (const ph of this.photos) ph.locked = ids.includes(ph.id);
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
      staleG: this.staleG,
      lockRead: this.lockRead ? { ...this.lockRead } : null,
      photos,
      presets: this.presets.map((p) => ({ ...p, values: p.values ? { ...p.values } : null })),
      history: clone(this.history),
      paused: this.paused,
      busy: this.busyUntil > this.clock.now(),
      bezels: this.bezels,
      setCostMs: this.setCostMs,
      protocolVersion: this.protocolVersion,
      moduleDelayMs: this.moduleDelayMs,
      moduleWaitMs: this.moduleWaitMs,
      switching: this.pendingSwitch ? this.pendingSwitch.name : null, // a module switch on its way there
      waiting: this.waiting ? this.waiting.name : null, // a handler waiting for that switch
      pollHeld: this.clock.now() < this.pollHeldUntil,
    };
  }
}

// ---------- command handlers (PROTOCOL.md, Commands) ----------

const HANDLERS = {
  // A deck speaking another v still gets the plugin's greeting, and the plugin logs it. The plugin speaks v1
  // unless options({ protocolVersion }) says otherwise.
  hello(m) {
    if (m.v !== this.protocolVersion) this.log('warn', `the deck speaks protocol v${short(m.v)}; this plugin speaks v${short(this.protocolVersion)}`);
    this.greet();
  },

  ping(m) {
    this.send({ t: 'pong', id: m.id, lt: lrTime(this.clock.wall()) });
  },

  // Entries that aren't param names are dropped with err bad at once. Unknown params need getRange, so
  // they are dropped once Lightroom is in Develop with a photo (checkWatch).
  watch(m) {
    if (!Array.isArray(m.ps)) {
      this.bad(m, 'watch needs ps, a list of params');
      return;
    }
    const keep = [];
    let wrong = 0;
    for (const p of m.ps) {
      if (typeof p !== 'string' || p === '') wrong += 1;
      else if (!keep.includes(p)) keep.push(p);
    }
    this.watch = keep;
    this.watchId = m.id;
    this.watchChecked = false;
    if (wrong > 0) this.bad(m, `${wrong} entries in ps are not param names, dropped`);
    if (!this.inDevelopWithPhoto()) return;
    this.checkWatch();
    if (this.watch.length > 0) {
      this.send({ t: 'ranges', ranges: this.rangesFor(this.watch) });
      this.sendOwedVals();
    }
  },

  // Checks in the order PROTOCOL.md's Guard section gives for writes: fields, the guard, a stale gesture or
  // photo, a locked photo, the switch to Develop and, after one, the target photo and its lock again, then the
  // target photo and the param. Like the plugin, it can check the param only once in Develop, where getRange works.
  set(m) {
    if (typeof m.p !== 'string' || m.p === '') {
      this.bad(m, `set needs p, a param name; got ${short(m.p)}`);
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
    if (badPh(m)) {
      this.bad(m, `set: ph must be a string, the photo id from state; got ${short(m.ph)}`);
      return;
    }
    if (!this.guardOk(m)) return;
    // A set can reach a photo change before the poll does: it ends its gesture as the poll would have.
    const open = this.gesture;
    if (open && open.g === m.g && this.target != null && open.photo !== this.target) this.endGesture('the photo changed', true);
    if (m.g === this.staleG) {
      this.err(m, 'stale', `gesture ${m.g} ended when the photo or module changed`);
      return;
    }
    // The deck worked this set out from another photo's values, so its gesture's later sets are refused too.
    // An open gesture is left alone: this set changes nothing.
    if (this.wrongPhoto(m)) {
      this.staleG = m.g;
      this.err(m, 'stale', `ph ${m.ph} isn't the target photo (${this.target ?? 'none'})`);
      return;
    }
    if (this.lockedNow()) {
      this.err(m, 'locked', `photo ${this.target} is locked by a background AI process`);
      return;
    }
    // The photo those checks were made against. A switch to Develop checks it and its lock again once there: the
    // set was worked out for this photo, so another one by then makes it stale, and its g too, like a wrong ph.
    const photo = this.target;
    this.ensureDevelop(m, (switched) => {
      if (switched) {
        const refused = this.refusedAfterSwitch(m, photo);
        if (refused === 'stale') this.staleG = m.g;
        if (refused) return;
      }
      const ph = this.targetPhoto();
      if (!ph) {
        this.err(m, 'noPhoto', 'no target photo');
        return;
      }
      if (!this.isParamName(m.p)) {
        this.bad(m, `unknown param ${short(m.p)}`);
        return;
      }
      if (this.gesture && (this.gesture.p !== m.p || this.gesture.g !== m.g)) this.endGesture(`a set for ${m.p}, g ${m.g}`);
      if (!this.gesture) this.startGesture(m.p, m.g);
      this.touchGesture();
      const [lo, hi] = this.range(ph, m.p);
      ph.values[m.p] = Math.min(hi, Math.max(lo, m.v)); // setValue clamps nothing, so Lightroom clamps first
      this.gesture.sets += 1;
      this.send({ t: 'ack', p: m.p, v: this.getValue(ph, m.p), g: m.g });
    });
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

  // The order of checks for writes, as for set, the target photo and its lock again after a switch to Develop
  // included. A reset has no g to make stale, and each refusal leaves an open gesture alone.
  reset(m) {
    if (typeof m.p !== 'string' || m.p === '') {
      this.bad(m, `reset needs p, a param name; got ${short(m.p)}`);
      return;
    }
    if (badPh(m)) {
      this.bad(m, `reset: ph must be a string, the photo id from state; got ${short(m.ph)}`);
      return;
    }
    if (!this.guardOk(m)) return;
    if (this.wrongPhoto(m)) {
      this.err(m, 'stale', `ph ${m.ph} isn't the target photo (${this.target ?? 'none'})`);
      return;
    }
    if (this.lockedNow()) {
      this.err(m, 'locked', `photo ${this.target} is locked by a background AI process`);
      return;
    }
    const photo = this.target;
    this.ensureDevelop(m, (switched) => {
      if (switched && this.refusedAfterSwitch(m, photo)) return;
      const ph = this.targetPhoto();
      if (!ph) {
        this.err(m, 'noPhoto', 'no target photo');
        return;
      }
      if (!this.isParamName(m.p)) {
        this.bad(m, `unknown param ${short(m.p)}`);
        return;
      }
      if (this.gesture) this.endGesture('reset');
      const from = this.getValue(ph, m.p);
      ph.values[m.p] = this.defaultOf(ph, m.p);
      this.history.push({ kind: 'reset', p: m.p, photo: ph.id, from, to: ph.values[m.p] });
      this.scheduleObserver();
      this.send({ t: 'ack', p: m.p, v: this.getValue(ph, m.p) });
    });
  },

  // When Lightroom isn't in the module within the wait, noDevelop for Develop and failed for Library, as
  // Library.module answers.
  module(m) {
    if (m.v !== 'develop' && m.v !== 'library') {
      this.bad(m, 'module v must be "develop" or "library"');
      return;
    }
    if (m.v !== 'develop') this.endGesture('left Develop', true); // Library.module
    this.askModule(m.v, (ok) => {
      if (!ok) {
        if (m.v === 'develop') this.err(m, 'noDevelop', 'could not switch to Develop');
        else this.err(m, 'failed', `could not switch to ${m.v}`);
        return;
      }
      this.refresh({ forceState: true, forceDevelop: m.v === 'develop' });
    });
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
        if (this.target === flagged) this.navigateForDeck(1, 'flag advance');
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
    this.navigateForDeck(m.v === 'next' ? 1 : -1, `nav ${m.v}`);
    this.refresh({ forceState: true });
  },

  view(m) {
    if (m.v !== 'before' && m.v !== 'after') {
      this.bad(m, 'view v must be "before" or "after"');
      return;
    }
    this.ensureDevelop(m, () => {
      this.view = m.v === 'before' ? 'before' : 'loupe';
      this.log('lr', `showView('${m.v === 'before' ? 'develop_before' : 'develop_loupe'}')`);
    });
  },

  presets(m) {
    this.send({ t: 'presets', id: m.id, items: this.presets.map(({ uuid, name, folder }) => ({ uuid, name, folder })) });
  },

  // The order of checks for writes: fields, the guard, the target photo, then the preset (Presets.apply).
  preset(m) {
    if (typeof m.uuid !== 'string' || m.uuid === '') {
      this.bad(m, 'preset needs uuid');
      return;
    }
    if (!this.guardOk(m)) return;
    if (!this.targetPhoto()) {
      this.err(m, 'noPhoto', 'no target photo');
      return;
    }
    const preset = this.presets.find((p) => p.uuid === m.uuid);
    if (!preset) {
      this.err(m, 'notFound', `no preset with uuid ${m.uuid}`);
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
    // Like the plugin (Reload.reload): no reload while writes would be refused, since it can swap the write
    // handlers; and every name must be reloadable, or nothing reloads. (The mock reloads nothing.)
    const mods = m.mods ?? [...RELOADABLE];
    const reply = (ok, msg) => this.send({ t: 'reloaded', id: m.id, mods, ok, msg });
    const why = this.whyNotWritable();
    if (why != null) {
      this.log('lr', `reload refused: ${why}`);
      reply(false, `reload is off while writes are: ${why}`);
      return;
    }
    const refused = mods.find((x) => !RELOADABLE.includes(x));
    if (refused !== undefined) {
      reply(false, `${refused} doesn't hot-reload; use Reload Plug-in`);
      return;
    }
    reply(true, `reloaded ${mods.join(', ')}`);
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
