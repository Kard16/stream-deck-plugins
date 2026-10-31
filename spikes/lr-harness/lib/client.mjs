// Two-socket client for the DeckBridge spike protocol (spikes/protocol-v0.md).
// cmd: we write commands to Lightroom's receive socket, which answers every line with "ok".
// evt: we read events from Lightroom's send socket. That socket never notices a client going away,
// and Lightroom recreates it only when the cmd socket closes. So the two are a pair: when either
// closes or fails unexpectedly, close the other too and reconnect both (backoff 250 ms doubling to 2 s).
// Heartbeat: ping every 2 s. If no event arrives for 4 s while Lightroom still answers our lines with
// "ok" promptly, its sender is stale: reconnect both. If our lines sit unanswered too, Lightroom is
// paused (a menu, a dialog, the Plug-in Manager), and reconnecting would only lose the events it sends
// when it resumes, so wait. Nothing here throws or emits 'error'.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

const MAX_LINE_BUFFER = 16 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_SENT_QUEUE = 10000;

export const now = () => performance.now();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, MAX_TIMER_MS))));
}

function makeSide(name, port) {
  return {
    name, port,
    sock: null,
    connected: false,
    connectedAt: null,
    hold: false,
    buf: '',
    bufSince: null,
    partialWarned: false,
    failures: 0,
    lastError: null,
  };
}

export class LrClient extends EventEmitter {
  constructor({ host = '127.0.0.1', cmdPort = 58780, evtPort = 58781, onRecord = () => {}, log = () => {}, heartbeat = { intervalMs: 2000, timeoutMs: 4000 }, clientName = 'spike-harness' } = {}) {
    super();
    this.setMaxListeners(100);
    this.host = host;
    this.clientName = clientName;
    this.sides = { cmd: makeSide('cmd', cmdPort), evt: makeSide('evt', evtPort) };
    this.onRecord = onRecord;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.running = false;
    this.lastHello = null;
    this.lastHelloAt = -Infinity;
    this.partialTimer = null;
    this.pairTimer = null;
    this.pairDelay = 250;
    this.pairDelayScheduled = null;
    this.upSince = null;
    this.lastUpMs = 0;
    this.sentQueue = [];
    this.okLines = 0;
    this.lastOkAt = -Infinity;
    this.lastEvtAt = -Infinity;
    this.slowPending = 0;
    this.hb = heartbeat ? {
      intervalMs: heartbeat.intervalMs ?? 2000,
      timeoutMs: heartbeat.timeoutMs ?? 4000,
      timer: null,
      lastPingAt: -Infinity,
      ids: new Map(),
      pings: 0, pongs: 0, latePongs: 0,
      stale: 0, graceEpisodes: 0, pauseEpisodes: 0,
      inGrace: false, inPause: false, pauseStart: null, oksAtPause: 0,
    } : null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._connect('evt');
    this._connect('cmd');
    // Warn once per connection if bytes sit in the buffer without a newline (missing '\n' on the Lua side).
    this.partialTimer = setInterval(() => {
      for (const s of Object.values(this.sides)) {
        if (s.buf.length > 0 && s.bufSince != null && now() - s.bufSince > 2000 && !s.partialWarned) {
          s.partialWarned = true;
          this.log('client', `${s.name}: ${s.buf.length} bytes waiting for a newline for over 2 s (is '\\n' missing?)`);
          this._record('sys', s.name, { ev: 'partial-line', bytes: s.buf.length, head: s.buf.slice(0, 200) });
        }
      }
    }, 1000);
    if (this.hb) this.hb.timer = setInterval(() => this._hbTick(), 250);
  }

  stop() {
    this.running = false;
    clearInterval(this.partialTimer);
    if (this.hb) clearInterval(this.hb.timer);
    clearTimeout(this.pairTimer);
    this.pairTimer = null;
    for (const name of ['cmd', 'evt']) this._closeSide(name, { reason: 'stop', deliberate: true });
  }

  isUp() { return this.sides.cmd.connected && this.sides.evt.connected; }
  isCmdUp() { return this.sides.cmd.connected; }

  stats() {
    const hb = this.hb;
    return {
      okLines: this.okLines,
      heartbeat: hb ? {
        intervalMs: hb.intervalMs, timeoutMs: hb.timeoutMs,
        pings: hb.pings, pongs: hb.pongs, latePongs: hb.latePongs,
        staleReconnects: hb.stale, slowGraceEpisodes: hb.graceEpisodes, pausedEpisodes: hb.pauseEpisodes,
      } : null,
    };
  }

  _record(dir, side, msg, t = now()) {
    try { this.onRecord({ hr: Math.round(t * 1000) / 1000, wall: Date.now(), dir, side, msg }); } catch { /* recording must never break the client */ }
  }

  _markUp(t) {
    if (this.upSince != null) return;
    this.upSince = t;
    this.lastEvtAt = t;
    if (this.hb) {
      this.hb.inGrace = false;
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
    s.bufSince = null;
    s.partialWarned = false;
    if (name === 'cmd') this.sentQueue = [];
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.on('connect', () => {
      if (s.sock !== sock) return;
      const t = now();
      s.connected = true;
      s.connectedAt = t;
      if (s.failures > 0) this._record('sys', name, { ev: 'connect-after-failures', failures: s.failures, lastError: s.lastError }, t);
      s.failures = 0;
      this._record('sys', name, { ev: 'connect' }, t);
      this.emit('connect', { side: name, t });
      // Ask Lightroom to (re)send hello, state and vals. Harmless if the evt side isn't up yet.
      if (name === 'cmd') this.send({ t: 'hello', v: 0, client: this.clientName });
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
      }
      if (s.buf.length === 0) {
        s.bufSince = null;
      } else if (s.bufSince == null) {
        s.bufSince = t;
      }
      if (s.buf.length > MAX_LINE_BUFFER) {
        this._record('sys', name, { ev: 'buffer-overflow', bytes: s.buf.length }, t);
        s.buf = '';
        s.bufSince = null;
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
        this._record('sys', name, { ev: 'disconnect', deliberate: false, lastError: s.lastError }, t);
        this.emit('disconnect', { side: name, t, deliberate: false, pair: false, reason: 'closed' });
      } else {
        s.failures += 1;
      }
      this._sideLost(name, { reason: wasConnected ? 'closed' : 'connect failed' });
    });
  }

  // Close one side now. Returns whether it was connected.
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
      this.emit('disconnect', { side: name, t, deliberate: !!flags.deliberate, pair: !!flags.pair, simulated: !!flags.simulated, reason: flags.reason });
    }
    return wasConnected;
  }

  // The pair rule: one side is gone, so close the other and reconnect both. Returns the reconnect delay.
  _sideLost(name, { reason, deliberate = false } = {}) {
    const other = name === 'cmd' ? 'evt' : 'cmd';
    this._closeSide(other, { reason: `pair: ${name} ${reason}`, deliberate, pair: true });
    return this._schedulePair();
  }

  _schedulePair() {
    if (!this.running) return null;
    if (this.pairTimer) return this.pairDelayScheduled;
    if (this.lastUpMs >= 2000) { // the last connection was stable: start the backoff again
      this.pairDelay = 250;
      this.lastUpMs = 0;
    }
    const delay = this.pairDelay;
    this.pairDelay = Math.min(this.pairDelay * 2, 2000);
    this.pairDelayScheduled = delay;
    this.pairTimer = setTimeout(() => {
      this.pairTimer = null;
      this._connect('evt');
      this._connect('cmd');
    }, delay);
    return delay;
  }

  // Close the given sides on purpose, then reconnect them after reconnectAfterMs.
  drop(names, reconnectAfterMs = 300) {
    this.pairDelay = 250;
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

  // Lose one side as if it had closed by itself, so the pair rule runs. Returns the reconnect delay.
  loseSide(name) {
    this.pairDelay = 250;
    this._closeSide(name, { reason: 'simulated loss', deliberate: true, simulated: true });
    return this._sideLost(name, { reason: 'simulated loss', deliberate: true });
  }

  // Close both sockets and reconnect both. Used by the heartbeat.
  reconnectAll(reason) {
    this.pairDelay = 250;
    this._closeSide('cmd', { reason, deliberate: true });
    this._closeSide('evt', { reason, deliberate: true });
    return this._schedulePair();
  }

  _hbTick() {
    const hb = this.hb;
    if (!hb || !this.running || this.upSince == null) return;
    const t = now();
    const silent = t - this.lastEvtAt;
    if (silent > hb.timeoutMs && t - this.upSince > hb.timeoutMs) {
      if (this.slowPending > 0) {
        // A slow probe may hold up Lightroom's replies, pongs included. Wait for it.
        if (!hb.inGrace) {
          hb.inGrace = true;
          hb.graceEpisodes += 1;
          this._record('sys', null, { ev: 'heartbeat-grace', silentMs: Math.round(silent) }, t);
          this.emit('grace', { t, silentMs: silent });
        }
      } else if (this.okLines > 0 && this._unansweredMs(t) >= 1500 && !this._oksDuringPause(t)) {
        // Our lines are waiting for their "ok" too: Lightroom isn't running plugin code right now.
        if (!hb.inPause) {
          hb.inPause = true;
          hb.pauseEpisodes += 1;
          hb.pauseStart = this.lastEvtAt;
          hb.oksAtPause = this.okLines;
          this._record('sys', null, { ev: 'heartbeat-paused', silentMs: Math.round(silent) }, t);
          this.emit('paused', { t, silentMs: silent });
        }
      } else {
        hb.stale += 1;
        hb.inPause = false;
        this._record('sys', null, { ev: 'heartbeat-stale', silentMs: Math.round(silent), unansweredMs: Math.round(this._unansweredMs(t)), okLines: this.okLines }, t);
        this.emit('stale', { t, silentMs: silent });
        this.reconnectAll('heartbeat');
        return;
      }
    } else {
      if (hb.inPause) {
        hb.inPause = false;
        this.emit('resumed', { t, pausedMs: t - hb.pauseStart });
      }
      hb.inGrace = false;
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

  // During a pause, two or more "ok"s (the last a second ago) with still no events means
  // Lightroom is taking lines after all and only its sender is dead.
  _oksDuringPause(t) {
    const hb = this.hb;
    return hb.inPause && this.okLines - hb.oksAtPause >= 2 && t - this.lastOkAt >= 1000;
  }

  _onLine(side, line, t) {
    if (side === 'evt') this.lastEvtAt = t;
    // LrSocket's receive mode answers every line it gets with "ok". Count it and match it to the
    // oldest line still waiting, which gives the time until Lightroom took the line.
    if (side === 'cmd' && line.trim() === 'ok') {
      this.okLines += 1;
      this.lastOkAt = t;
      const sent = this.sentQueue.shift();
      this._record('in-ok', 'cmd', sent ? { for: sent.type, seq: sent.seq, id: sent.id, ms: Math.round((t - sent.t) * 100) / 100 } : {}, t);
      this.emit('ok', { t, sent: sent ?? null });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._record('in-bad', side, { line: line.slice(0, 2000) }, t);
      this.emit('badline', { side, line, t });
      return;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      this._record('in-bad', side, { line: line.slice(0, 2000) }, t);
      this.emit('badline', { side, line, t });
      return;
    }
    this._record('in', side, msg, t);
    if (msg.t === 'pong' && msg.id != null && this.hb && this.hb.ids.has(msg.id)) {
      const sentAt = this.hb.ids.get(msg.id);
      this.hb.ids.delete(msg.id);
      this.hb.pongs += 1;
      if (t - sentAt > this.hb.timeoutMs) this.hb.latePongs += 1;
      return; // heartbeat pongs stop here
    }
    if (side === 'cmd') this.emit('unexpected', { why: 'data on the cmd socket', msg, t });
    if (msg.t === 'hello') {
      this.lastHello = msg;
      this.lastHelloAt = t;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) p.resolve(msg, t);
      else if (typeof msg.id === 'number' && msg.id < this.nextId) this.emit('late', { msg, t });
    }
    this.emit('msg', msg, t);
    if (typeof msg.t === 'string') this.emit('m:' + msg.t, msg, t);
  }

  // Write one command line on the cmd socket. Returns the send time, or null if not connected.
  send(obj) {
    const s = this.sides.cmd;
    if (!s.sock || !s.connected) {
      this._record('out-fail', 'cmd', obj);
      return null;
    }
    let line;
    try {
      line = JSON.stringify(obj) + '\n';
    } catch (err) {
      this._record('out-fail', 'cmd', { error: String(err && err.message) });
      return null;
    }
    const t = now();
    s.sock.write(line);
    this.sentQueue.push({ t, type: obj.t, seq: obj.seq, id: obj.id });
    if (this.sentQueue.length > MAX_SENT_QUEUE) this.sentQueue.splice(0, this.sentQueue.length - MAX_SENT_QUEUE);
    this._record('out', 'cmd', obj, t);
    return t;
  }

  cmdBuffered() {
    const s = this.sides.cmd;
    return s.sock ? s.sock.writableLength : 0;
  }

  // Send a command with a fresh integer id and wait for any event carrying the same id.
  // Always resolves: { ok: true, reply, rttMs, tSent, tRecv, id } or { ok: false, error, id }.
  // slow: true asks the heartbeat not to reconnect while this request is outstanding.
  request(obj, timeoutMs = 5000, { slow = false } = {}) {
    const id = this.nextId++;
    const msg = { ...obj, id };
    return new Promise((resolve) => {
      const tSent = this.send(msg);
      if (tSent == null) {
        resolve({ ok: false, error: 'not connected', id });
        return;
      }
      if (slow) this.slowPending += 1;
      const finish = () => { if (slow) this.slowPending = Math.max(0, this.slowPending - 1); };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        finish();
        resolve({ ok: false, error: 'timeout', id, tSent });
      }, Math.max(1, Math.min(timeoutMs, MAX_TIMER_MS)));
      this.pending.set(id, {
        resolve: (reply, tRecv) => {
          clearTimeout(timer);
          this.pending.delete(id);
          finish();
          resolve({ ok: true, reply, tSent, tRecv, rttMs: tRecv - tSent, id });
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

  // Resolve with { msg, t } for the first hello received after time `after`, or null on timeout.
  waitHelloAfter(after, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (this.lastHelloAt > after) { resolve({ msg: this.lastHello, t: this.lastHelloAt }); return; }
      let timer = null;
      const onHello = (msg, t) => { if (t > after) { cleanup(); resolve({ msg, t }); } };
      const cleanup = () => { if (timer) clearTimeout(timer); this.off('m:hello', onHello); };
      this.on('m:hello', onHello);
      timer = setTimeout(() => { cleanup(); resolve(null); }, Math.max(0, Math.min(timeoutMs, MAX_TIMER_MS)));
    });
  }
}
