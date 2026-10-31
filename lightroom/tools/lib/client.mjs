// Two-socket client for DeckBridge protocol v1 (lightroom/protocol/PROTOCOL.md, Transport and Heartbeat).
// Copied from spikes/lr-harness/lib/client.mjs and updated for v1.
//
// cmd: we write commands to Lightroom's receive socket, which answers every line with "ok". We keep
//   reading it and discard the oks, but their timing tells whether Lightroom is taking lines at all.
// evt: we read events from Lightroom's send socket. That socket never notices a client leaving, and
//   Lightroom recreates it only when the cmd socket closes. So the two are a pair: when either closes,
//   errors or fails to connect, close the other too and reconnect both, after 250 ms doubling to 2 s,
//   forever (the pair rule).
// Heartbeat: ping every 2 s. No event at all for 6 s while Lightroom still answers each line with "ok"
//   within 1.5 s means its sender is stale: reconnect both. If the oks stop too, Lightroom is paused by a
//   menu, a dialog or the Plug-in Manager: wait ("busy") instead of reconnecting.
// Nothing here throws or emits 'error'.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { CMD_PORT, EVT_PORT, PROTOCOL_VERSION } from './params.mjs';

const MAX_LINE_BUFFER = 16 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_SENT_QUEUE = 10000;
const HISTORY = 200;

export const now = () => performance.now();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, MAX_TIMER_MS))));
}

export const HEARTBEAT_DEFAULTS = Object.freeze({ intervalMs: 2000, staleMs: 6000, okMs: 1500 });
export const BACKOFF = Object.freeze({ firstMs: 250, maxMs: 2000, stableMs: 2000 });

function makeSide(name, port) {
  return { name, port, sock: null, connected: false, connectedAt: null, hold: false, buf: '', failures: 0, lastError: null };
}

export class LrClient extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    cmdPort = CMD_PORT,
    evtPort = EVT_PORT,
    clientName = 'lightroom-tools',
    ver = '0.1.0',
    autoHello = true, // send hello whenever the cmd socket connects
    heartbeat = {}, // false turns it off; otherwise overrides for HEARTBEAT_DEFAULTS
    reconnect = true, // false: after a loss, close both and stay down
    firstId = 1, // request and heartbeat ids count up from here
    log = () => {},
    onRecord = () => {},
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.host = host;
    this.clientName = clientName;
    this.ver = ver;
    this.autoHello = autoHello;
    this.reconnect = reconnect;
    this.sides = { cmd: makeSide('cmd', cmdPort), evt: makeSide('evt', evtPort) };
    this.log = log;
    this.onRecord = onRecord;
    this.nextId = firstId;
    this.pending = new Map();
    this.running = false;
    this.pairTimer = null;
    this.pairDelay = BACKOFF.firstMs;
    this.pairDelayScheduled = null;
    this.upSince = null;
    this.lastUpMs = 0;
    this.sentQueue = [];
    this.sendSeq = 0;
    this.okLines = 0;
    this.evtLines = 0;
    this.lastOkAt = -Infinity;
    this.lastEvtAt = -Infinity;
    this.lastHello = null;
    this.lastHelloAt = -Infinity;
    this.inst = null;
    this.versionMismatch = false;
    this.history = [];
    this.retries = [];
    this.hb = heartbeat === false ? null : {
      ...HEARTBEAT_DEFAULTS,
      ...heartbeat,
      timer: null,
      lastPingAt: -Infinity,
      ids: new Map(),
      pings: 0, pongs: 0,
      stale: 0, pauses: 0,
      inPause: false, pauseStart: null, oksAtPause: 0,
    };
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._connect('evt');
    this._connect('cmd');
    // Check four times per ping interval, so timer jitter never pushes a ping a whole interval late.
    if (this.hb) this.hb.timer = setInterval(() => this._hbTick(), Math.max(10, Math.min(250, this.hb.intervalMs / 4)));
    return this;
  }

  stop() {
    this.running = false;
    if (this.hb) clearInterval(this.hb.timer);
    clearTimeout(this.pairTimer);
    this.pairTimer = null;
    for (const name of ['cmd', 'evt']) this._closeSide(name, { reason: 'stop', deliberate: true });
    for (const p of this.pending.values()) p.cancel('stopped');
    this.pending.clear();
  }

  isUp() { return this.sides.cmd.connected && this.sides.evt.connected; }

  // Whether Lightroom has sent hello since both sockets last came up, so lastHello describes the
  // Lightroom on the other end now (after a relaunch it may have another inst or catalog).
  greeted() { return this.isUp() && this.upSince != null && this.lastHelloAt >= this.upSince; }

  stats() {
    const hb = this.hb;
    return {
      okLines: this.okLines,
      evtLines: this.evtLines,
      retries: this.retries.length,
      heartbeat: hb ? { pings: hb.pings, pongs: hb.pongs, staleReconnects: hb.stale, pauses: hb.pauses } : null,
    };
  }

  _record(dir, side, msg, t = now()) {
    try { this.onRecord({ hr: Math.round(t * 1000) / 1000, wall: Date.now(), dir, side, msg }); } catch { /* never break the client */ }
  }

  _markUp(t) {
    if (this.upSince != null) return;
    this.upSince = t;
    this.lastEvtAt = t;
    if (this.hb) {
      this.hb.inPause = false;
      this.hb.pauseStart = null;
    }
    this.emit('up', { t });
  }

  _markDown(t, flags) {
    if (this.upSince == null) return;
    this.lastUpMs = t - this.upSince;
    this.upSince = null;
    this.emit('down', { t, ...flags });
  }

  _connect(name) {
    const s = this.sides[name];
    if (!this.running || s.hold || s.sock) return;
    let sock;
    try {
      sock = net.createConnection({ host: this.host, port: s.port });
    } catch (err) {
      s.lastError = String(err && err.message);
      s.failures += 1;
      this._sideLost(name, { reason: 'connect-error' });
      return;
    }
    s.sock = sock;
    s.buf = '';
    if (name === 'cmd') this.sentQueue = [];
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.on('connect', () => {
      if (s.sock !== sock) return;
      const t = now();
      s.connected = true;
      s.connectedAt = t;
      s.failures = 0;
      this._record('sys', name, { ev: 'connect' }, t);
      this.emit('connect', { side: name, t });
      if (name === 'cmd' && this.autoHello) this.hello();
      if (this.isUp()) this._markUp(t);
    });
    // Always keep reading both sockets, so Lightroom's "ok" replies never fill the cmd buffer.
    sock.on('data', (chunk) => {
      if (s.sock !== sock) return;
      const t = now();
      s.buf += chunk;
      let idx;
      while ((idx = s.buf.indexOf('\n')) >= 0) {
        const line = s.buf.slice(0, idx).replace(/\r$/, '');
        s.buf = s.buf.slice(idx + 1);
        if (line.trim() !== '') this._onLine(name, line, t);
        if (s.sock !== sock) return; // a handler closed this socket
      }
      if (s.buf.length > MAX_LINE_BUFFER) {
        this._record('sys', name, { ev: 'buffer-overflow', bytes: s.buf.length }, t);
        s.buf = '';
      }
    });
    sock.on('error', (err) => {
      s.lastError = (err && (err.code || err.message)) || 'error';
    });
    sock.on('close', () => {
      if (s.sock !== sock) return; // we closed it ourselves
      const t = now();
      const wasConnected = s.connected;
      s.sock = null;
      s.connected = false;
      if (wasConnected) {
        this._markDown(t, { side: name, deliberate: false });
        this._record('sys', name, { ev: 'disconnect', lastError: s.lastError }, t);
        this.emit('disconnect', { side: name, t, deliberate: false, pair: false, reason: 'closed' });
      } else {
        s.failures += 1;
        this.emit('connect-failed', { side: name, t, error: s.lastError });
      }
      this._sideLost(name, { reason: wasConnected ? 'closed' : `connect failed (${s.lastError})` });
    });
  }

  // Closes one side now. Returns whether it was connected.
  _closeSide(name, flags) {
    const s = this.sides[name];
    const sock = s.sock;
    const wasConnected = s.connected;
    s.sock = null;
    s.connected = false;
    if (sock) sock.destroy();
    if (wasConnected) {
      const t = now();
      this._markDown(t, { side: name, ...flags });
      this._record('sys', name, { ev: 'disconnect', ...flags }, t);
      this.emit('disconnect', { side: name, t, deliberate: !!flags.deliberate, pair: !!flags.pair, reason: flags.reason });
    }
    return wasConnected;
  }

  // The pair rule: one side is gone, so close the other and reconnect both. Returns the delay.
  _sideLost(name, { reason, deliberate = false } = {}) {
    const other = name === 'cmd' ? 'evt' : 'cmd';
    this._closeSide(other, { reason: `pair: ${name} ${reason}`, deliberate, pair: true });
    for (const p of this.pending.values()) p.cancel('disconnected');
    return this._schedulePair(reason);
  }

  _schedulePair(reason) {
    if (!this.running) return null;
    if (!this.reconnect) {
      this.emit('gave-up', { reason });
      return null;
    }
    if (this.pairTimer) return this.pairDelayScheduled;
    if (this.lastUpMs >= BACKOFF.stableMs) { // the last connection was stable: start the backoff again
      this.pairDelay = BACKOFF.firstMs;
      this.lastUpMs = 0;
    }
    const delay = this.pairDelay;
    this.pairDelay = Math.min(this.pairDelay * 2, BACKOFF.maxMs);
    this.pairDelayScheduled = delay;
    this.retries.push(delay);
    if (this.retries.length > 1000) this.retries.splice(0, 500);
    this.emit('retry', { delay, reason });
    this.pairTimer = setTimeout(() => {
      this.pairTimer = null;
      this._connect('evt');
      this._connect('cmd');
    }, delay);
    return delay;
  }

  // Closes the given sides on purpose, then reconnects them after reconnectAfterMs, without the
  // pair rule. Used to reproduce clients that break the rule.
  drop(names, reconnectAfterMs = 300) {
    for (const name of names) {
      this.sides[name].hold = true;
      this._closeSide(name, { reason: 'drop', deliberate: true });
    }
    setTimeout(() => {
      for (const name of names) {
        this.sides[name].hold = false;
        this._connect(name);
      }
    }, reconnectAfterMs);
  }

  // Loses one side as if it had closed by itself, so the pair rule runs. Returns the reconnect delay.
  loseSide(name) {
    this.pairDelay = BACKOFF.firstMs;
    this._closeSide(name, { reason: 'simulated loss', deliberate: true });
    return this._sideLost(name, { reason: 'simulated loss', deliberate: true });
  }

  // Closes both sockets and reconnects both. Used by the heartbeat.
  reconnectAll(reason) {
    this.pairDelay = BACKOFF.firstMs;
    this._closeSide('cmd', { reason, deliberate: true });
    this._closeSide('evt', { reason, deliberate: true });
    return this._schedulePair(reason);
  }

  _hbTick() {
    const hb = this.hb;
    if (!hb || !this.running || this.upSince == null) return;
    const t = now();
    const silent = t - this.lastEvtAt;
    if (silent > hb.staleMs && t - this.upSince > hb.staleMs) {
      let stale = false;
      if (hb.inPause) {
        // Two or more oks since the pause began, the last a second ago, and still no events:
        // Lightroom takes lines again, so only its sender is dead.
        stale = this.okLines - hb.oksAtPause >= 2 && t - this.lastOkAt >= 1000;
      } else if (this._unansweredMs(t) >= hb.okMs) {
        hb.inPause = true;
        hb.pauses += 1;
        hb.pauseStart = this.lastEvtAt;
        hb.oksAtPause = this.okLines;
        this._record('sys', null, { ev: 'heartbeat-paused', silentMs: Math.round(silent) }, t);
        this.emit('paused', { t, silentMs: silent });
      } else {
        stale = true;
      }
      if (stale) {
        hb.stale += 1;
        hb.inPause = false;
        this._record('sys', null, { ev: 'heartbeat-stale', silentMs: Math.round(silent), okLines: this.okLines }, t);
        this.emit('stale', { t, silentMs: silent });
        this.reconnectAll('heartbeat: event socket stale');
        return;
      }
    } else if (hb.inPause) {
      hb.inPause = false;
      this.emit('resumed', { t, pausedMs: t - hb.pauseStart });
    }
    if (t - hb.lastPingAt >= hb.intervalMs) {
      const id = this.nextId++;
      if (this.send({ t: 'ping', id }) != null) {
        hb.ids.set(id, t);
        hb.pings += 1;
        hb.lastPingAt = t;
        if (hb.ids.size > 1000) hb.ids.clear();
      }
    }
  }

  // How long the oldest line on the cmd socket has waited for its "ok".
  _unansweredMs(t) {
    return this.sentQueue.length ? t - this.sentQueue[0].t : 0;
  }

  _onLine(side, line, t) {
    if (side === 'cmd' && line.trim() === 'ok') {
      this.okLines += 1;
      this.lastOkAt = t;
      const sent = this.sentQueue.shift() ?? null;
      this._record('in-ok', 'cmd', sent ? { for: sent.type, seq: sent.seq, ms: Math.round((t - sent.t) * 100) / 100 } : {}, t);
      this.emit('ok', { t, sent });
      if (this.sentQueue.length === 0) this.emit('oks-drained', { t });
      return;
    }
    if (side === 'evt') {
      this.evtLines += 1;
      this.lastEvtAt = t;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = undefined;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      this._record('in-bad', side, { line: line.slice(0, 2000) }, t);
      this.emit('badline', { side, line, t });
      return;
    }
    this._record('in', side, msg, t);
    if (side === 'cmd') {
      this.emit('unexpected', { why: 'data on the cmd socket', msg, t });
      return;
    }
    if (msg.t === 'pong' && msg.id != null && this.hb && this.hb.ids.has(msg.id)) {
      this.hb.ids.delete(msg.id);
      this.hb.pongs += 1;
      return; // heartbeat pongs stop here
    }
    this.history.push({ msg, t });
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    if (msg.t === 'hello') this._onHello(msg, t);
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) p.resolve(msg, t);
    }
    this.emit('msg', msg, t);
    if (typeof msg.t === 'string') this.emit(`m:${msg.t}`, msg, t);
  }

  _onHello(msg, t) {
    this.lastHello = msg;
    this.lastHelloAt = t;
    this.versionMismatch = msg.v !== PROTOCOL_VERSION;
    if (this.versionMismatch) this.emit('mismatch', msg);
    if (msg.inst !== undefined && msg.inst !== this.inst) {
      const previous = this.inst;
      this.inst = msg.inst;
      this.emit('inst', { inst: msg.inst, previous });
    }
  }

  // Sends hello v1. Lightroom answers with hello, state, and ranges and vals when in Develop.
  hello() {
    return this.send({ t: 'hello', v: PROTOCOL_VERSION, client: this.clientName, ver: this.ver });
  }

  // Writes one line on the cmd socket. Returns { t, seq, type } (the send time), or null if not connected.
  sendRaw(line, meta = {}) {
    const s = this.sides.cmd;
    if (!s.sock || !s.connected) {
      this._record('out-fail', 'cmd', { line: String(line).slice(0, 200) });
      return null;
    }
    const t = now();
    s.sock.write(`${line}\n`);
    const rec = { t, seq: ++this.sendSeq, type: meta.type ?? null, id: meta.id ?? null, ...meta };
    this.sentQueue.push(rec);
    if (this.sentQueue.length > MAX_SENT_QUEUE) this.sentQueue.splice(0, this.sentQueue.length - MAX_SENT_QUEUE);
    return rec;
  }

  send(obj, meta = {}) {
    let line;
    try {
      line = JSON.stringify(obj);
    } catch (err) {
      this._record('out-fail', 'cmd', { error: String(err && err.message) });
      return null;
    }
    const rec = this.sendRaw(line, { type: obj && obj.t, id: obj && obj.id, ...meta });
    if (rec) this._record('out', 'cmd', obj, rec.t);
    return rec;
  }

  cmdBuffered() {
    const s = this.sides.cmd;
    return s.sock ? s.sock.writableLength : 0;
  }

  // Resolves true once every line sent so far has had its "ok", false on timeout or disconnect.
  waitOks(timeoutMs = 2000) {
    if (this.sentQueue.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        this.off('oks-drained', onDrained);
        this.off('disconnect', onDown);
        resolve(v);
      };
      const onDrained = () => done(true);
      const onDown = () => done(false);
      const timer = setTimeout(() => done(false), Math.max(1, Math.min(timeoutMs, MAX_TIMER_MS)));
      this.on('oks-drained', onDrained);
      this.on('disconnect', onDown);
    });
  }

  // Sends a command with a fresh integer id and waits for any event carrying the same id.
  // Always resolves: { ok: true, reply, rttMs, tSent, tRecv, id } or { ok: false, error, id }.
  request(obj, timeoutMs = 5000) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const rec = this.send({ ...obj, id });
      if (rec == null) {
        resolve({ ok: false, error: 'not connected', id });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout', id, tSent: rec.t });
      }, Math.max(1, Math.min(timeoutMs, MAX_TIMER_MS)));
      this.pending.set(id, {
        resolve: (reply, tRecv) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve({ ok: true, reply, tSent: rec.t, tRecv, rttMs: tRecv - rec.t, id });
        },
        cancel: (why) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve({ ok: false, error: why, id, tSent: rec.t });
        },
      });
    });
  }

  waitSides(names, timeoutMs = Infinity) {
    return new Promise((resolve) => {
      const check = () => names.every((n) => this.sides[n].connected);
      if (check()) { resolve(true); return; }
      let timer = null;
      const onConnect = () => { if (check()) { cleanup(); resolve(true); } };
      const cleanup = () => { if (timer) clearTimeout(timer); this.off('connect', onConnect); };
      this.on('connect', onConnect);
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => { cleanup(); resolve(false); }, Math.max(0, Math.min(timeoutMs, MAX_TIMER_MS)));
    });
  }

  waitUp(timeoutMs = Infinity) { return this.waitSides(['cmd', 'evt'], timeoutMs); }

  // Resolves { msg, t } for the first message received after time `after` that passes `pred`
  // (a type string or a function), or null on timeout. Looks back through recent history first.
  waitFor(pred, timeoutMs = 5000, after = -Infinity) {
    const test = typeof pred === 'function' ? pred : (m) => m.t === pred;
    const seen = this.history.find((h) => h.t > after && test(h.msg));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const onMsg = (msg, t) => { if (t > after && test(msg)) { cleanup(); resolve({ msg, t }); } };
      const cleanup = () => { clearTimeout(timer); this.off('msg', onMsg); };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, Math.max(0, Math.min(timeoutMs, MAX_TIMER_MS)));
      this.on('msg', onMsg);
    });
  }
}
