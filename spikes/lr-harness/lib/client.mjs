// Two-socket client for the DeckBridge spike protocol (spikes/protocol-v0.md).
// cmd: we write commands to Lightroom's receive socket. evt: we read events from its send socket.
// Both sides reconnect forever with backoff (250 ms doubling to 2 s). Nothing here throws or emits 'error'.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

const MAX_LINE_BUFFER = 16 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;

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
    delay: 250,
    timer: null,
    hold: false,
    buf: '',
    bufSince: null,
    partialWarned: false,
    failures: 0,
    lastError: null,
  };
}

export class LrClient extends EventEmitter {
  constructor({ host = '127.0.0.1', cmdPort = 58780, evtPort = 58781, onRecord = () => {}, log = () => {} } = {}) {
    super();
    this.setMaxListeners(100);
    this.host = host;
    this.sides = { cmd: makeSide('cmd', cmdPort), evt: makeSide('evt', evtPort) };
    this.onRecord = onRecord;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.running = false;
    this.lastHello = null;
    this.lastHelloAt = -Infinity;
    this.partialTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._connect('cmd');
    this._connect('evt');
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
  }

  stop() {
    this.running = false;
    clearInterval(this.partialTimer);
    for (const s of Object.values(this.sides)) {
      clearTimeout(s.timer);
      s.timer = null;
      if (s.sock) {
        const sock = s.sock;
        s.sock = null;
        s.connected = false;
        sock.destroy();
      }
    }
  }

  isUp() { return this.sides.cmd.connected && this.sides.evt.connected; }
  isCmdUp() { return this.sides.cmd.connected; }

  _record(dir, side, msg, t = now()) {
    try { this.onRecord({ hr: Math.round(t * 1000) / 1000, wall: Date.now(), dir, side, msg }); } catch { /* recording must never break the client */ }
  }

  _connect(name) {
    const s = this.sides[name];
    if (!this.running || s.hold || s.sock) return;
    clearTimeout(s.timer);
    s.timer = null;
    let sock;
    try {
      sock = net.createConnection({ host: this.host, port: s.port });
    } catch (err) {
      s.lastError = String(err && err.message);
      this._schedule(name);
      return;
    }
    s.sock = sock;
    s.buf = '';
    s.bufSince = null;
    s.partialWarned = false;
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.on('connect', () => {
      if (s.sock !== sock) return;
      const t = now();
      s.connected = true;
      s.connectedAt = t;
      s.delay = 250;
      if (s.failures > 0) this._record('sys', name, { ev: 'connect-after-failures', failures: s.failures, lastError: s.lastError }, t);
      s.failures = 0;
      this._record('sys', name, { ev: 'connect' }, t);
      this.emit('connect', { side: name, t });
      // Ask Lightroom to (re)send hello, state and vals. Harmless if the evt side isn't up yet.
      if (name === 'cmd') this.send({ t: 'hello', v: 0, client: 'spike-harness' });
      if (this.isUp()) this.emit('up', { t });
    });
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
      if (s.sock !== sock) return;
      const t = now();
      const wasConnected = s.connected;
      const wasUp = this.isUp();
      s.sock = null;
      s.connected = false;
      if (wasConnected) {
        this._record('sys', name, { ev: 'disconnect', deliberate: false, lastError: s.lastError }, t);
        this.emit('disconnect', { side: name, t, deliberate: false });
        if (wasUp) this.emit('down', { side: name, t, deliberate: false });
      } else {
        s.failures += 1;
      }
      this._schedule(name);
    });
  }

  _schedule(name) {
    const s = this.sides[name];
    if (!this.running || s.hold) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; this._connect(name); }, s.delay);
    s.delay = Math.min(s.delay * 2, 2000);
  }

  // Close the given sides on purpose, then reconnect them after reconnectAfterMs.
  drop(names, reconnectAfterMs = 300) {
    const t = now();
    const wasUp = this.isUp();
    for (const name of names) {
      const s = this.sides[name];
      s.hold = true;
      clearTimeout(s.timer);
      s.timer = null;
      const sock = s.sock;
      const wasConnected = s.connected;
      s.sock = null;
      s.connected = false;
      if (sock) sock.destroy();
      if (wasConnected) {
        this._record('sys', name, { ev: 'disconnect', deliberate: true }, t);
        this.emit('disconnect', { side: name, t, deliberate: true });
      }
    }
    if (wasUp) this.emit('down', { side: names.join('+'), t, deliberate: true });
    setTimeout(() => {
      for (const name of names) {
        const s = this.sides[name];
        s.hold = false;
        s.delay = 250;
        this._connect(name);
      }
    }, reconnectAfterMs);
  }

  _onLine(side, line, t) {
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
    this._record('out', 'cmd', obj, t);
    return t;
  }

  cmdBuffered() {
    const s = this.sides.cmd;
    return s.sock ? s.sock.writableLength : 0;
  }

  // Send a command with a fresh integer id and wait for any event carrying the same id.
  // Always resolves: { ok: true, reply, rttMs, tSent, tRecv, id } or { ok: false, error, id }.
  request(obj, timeoutMs = 5000) {
    const id = this.nextId++;
    const msg = { ...obj, id };
    return new Promise((resolve) => {
      const tSent = this.send(msg);
      if (tSent == null) {
        resolve({ ok: false, error: 'not connected', id });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout', id, tSent });
      }, Math.max(1, Math.min(timeoutMs, MAX_TIMER_MS)));
      this.pending.set(id, {
        resolve: (reply, tRecv) => {
          clearTimeout(timer);
          this.pending.delete(id);
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
