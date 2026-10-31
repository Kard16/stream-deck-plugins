// Mock Lightroom: DeckBridge protocol v1 over real localhost sockets, with LrSocket's quirks as
// measured on Lightroom Classic 15.3 (docs/lightroom/plan.md, spike runs 1 and 2):
// - the receive (cmd) socket answers every line with "ok";
// - the send (evt) socket never notices its client leaving: after a client drops only the evt
//   connection, Lightroom keeps writing into the dead socket, and new evt connections wait unserved;
// - the send socket is recreated only when the cmd socket closes;
// - Lightroom sometimes closes connections by itself (control.close());
// - an open menu pauses everything (control.pause()); quitting sends no goodbye (control.relaunch()).
//
//   import { startMock } from './mock-lr/index.mjs';
//   const { cmdPort, evtPort, control, stop } = await startMock({ cmdPort: 0, evtPort: 0, clock: 'manual' });
//
// See lightroom/tools/README.md for the control API.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MockLightroom, TIMING, SetupError } from './lightroom.mjs';
import { makeClock, sleep } from '../lib/clock.mjs';
import { CMD_PORT, EVT_PORT } from '../lib/params.mjs';

export { TIMING, SetupError };

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCENARIO = path.join(here, 'default-scenario.json');

export function loadScenario(file = DEFAULT_SCENARIO) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class PortInUseError extends Error {
  constructor(port, which) {
    super(`port ${port} (${which}) is already in use: is Lightroom running? DeckBridge listens on ${CMD_PORT}/${EVT_PORT}. Quit Lightroom, or give the mock other ports with --ports, e.g. --ports 59780,59781.`);
    this.name = 'PortInUseError';
    this.port = port;
    this.code = 'EADDRINUSE';
  }
}

function listen(server, port, host, which) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err && err.code === 'EADDRINUSE' ? new PortInUseError(port, which) : err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host, exclusive: true });
  });
}

const blankSender = () => ({ sock: null, stale: false, written: 0, lost: 0, greeted: false });

export class MockServer extends EventEmitter {
  constructor({ lr, host = '127.0.0.1', cmdPort = CMD_PORT, evtPort = EVT_PORT, log = () => {} }) {
    super();
    this.setMaxListeners(100);
    this.lr = lr;
    this.host = host;
    this.cmdPort = cmdPort;
    this.evtPort = evtPort;
    this.log = log;
    this.cmd = null; // { sock, buf }: the receive socket's client
    this.sender = blankSender(); // Lightroom's send socket and the client it's attached to
    this.backlog = new Set(); // evt connections waiting while the sender is taken
    this.sockets = new Set();
    this.cmdServer = null;
    this.evtServer = null;
    this.bound = false;
    this.stopped = false;
    this.connections = { cmd: 0, evt: 0 };
    lr.transport = { send: (obj) => this.send(obj), connected: () => this.sender.sock != null };
    lr.on('command', (m) => this.emit('command', m));
  }

  async bind() {
    const cmdServer = net.createServer((s) => this.onCmd(s));
    const evtServer = net.createServer((s) => this.onEvt(s));
    try {
      this.cmdPort = await listen(cmdServer, this.cmdPort, this.host, 'commands');
    } catch (err) {
      cmdServer.close();
      throw err;
    }
    try {
      this.evtPort = await listen(evtServer, this.evtPort, this.host, 'events');
    } catch (err) {
      cmdServer.close();
      evtServer.close();
      throw err;
    }
    for (const srv of [cmdServer, evtServer]) srv.on('error', (err) => this.log('error', `server error: ${err.message}`));
    this.cmdServer = cmdServer;
    this.evtServer = evtServer;
    this.bound = true;
  }

  async unbind() {
    this.bound = false;
    const servers = [this.cmdServer, this.evtServer].filter(Boolean);
    this.cmdServer = null;
    this.evtServer = null;
    this.cmd = null;
    this.sender = blankSender();
    this.backlog.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await Promise.all(servers.map((srv) => new Promise((resolve) => srv.close(() => resolve()))));
  }

  track(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
  }

  onCmd(sock) {
    this.track(sock);
    this.connections.cmd += 1;
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.on('error', () => {});
    const conn = { sock, buf: '' };
    const old = this.cmd;
    this.cmd = conn;
    this.log('conn', 'cmd: client connected');
    this.emit('cmd-connect');
    if (old) {
      this.log('conn', 'cmd: a new client replaced the old one');
      old.sock.destroy();
      this.lr.run(() => {
        this.lr.onClientGone('a new client replaced the old one');
        this.recreateSender('a new cmd client replaced the old one');
      });
    }
    sock.on('data', (chunk) => {
      conn.buf += chunk;
      let i;
      while ((i = conn.buf.indexOf('\n')) >= 0) {
        const line = conn.buf.slice(0, i).replace(/\r$/, '');
        conn.buf = conn.buf.slice(i + 1);
        this.lr.run(() => this.onLine(conn, line));
      }
    });
    sock.on('close', () => {
      if (this.cmd !== conn) return;
      this.cmd = null;
      this.log('conn', 'cmd: client closed');
      this.emit('cmd-close');
      // Only the receive socket's close tells Lightroom the client left; it then recreates the sender.
      this.lr.run(() => {
        this.lr.onClientGone('the client disconnected');
        this.recreateSender('cmd socket closed');
      });
    });
  }

  onLine(conn, line) {
    if (!conn.sock.destroyed && conn.sock.writable) conn.sock.write('ok\n'); // LrSocket's receive mode
    this.lr.receiveLine(line);
  }

  onEvt(sock) {
    this.track(sock);
    this.connections.evt += 1;
    sock.setNoDelay(true);
    sock.on('error', () => {});
    sock.on('data', () => {}); // the deck never writes here
    if (this.sender.sock) {
      // The send socket is still attached to an earlier client, perhaps one that's gone.
      this.backlog.add(sock);
      sock.on('close', () => this.backlog.delete(sock));
      this.log('conn', 'evt: client connected, but the send socket is still attached to an earlier client: it waits, unserved');
      this.emit('evt-backlog');
      return;
    }
    const sender = { ...blankSender(), sock };
    this.sender = sender;
    // Deliberately nothing frees the sender when this connection closes: LrSocket's send mode never notices.
    sock.on('close', () => {
      if (this.sender === sender) this.log('conn', 'evt: client went away; Lightroom doesn\'t notice and keeps writing into the dead socket');
    });
    this.log('conn', 'evt: client connected');
    this.emit('evt-connect');
    this.lr.run(() => {
      if (this.sender !== sender) return;
      this.lr.onEvtConnected();
      sender.greeted = true;
      this.emit('greeted');
    });
  }

  // Returns false when no client is attached (Lightroom drops the message and knows it), true otherwise,
  // including writes that vanish into a dead or stale connection (Lightroom can't tell).
  send(obj) {
    const s = this.sender;
    if (!s.sock) return false;
    if (s.stale || s.sock.destroyed || !s.sock.writable) {
      s.lost += 1;
      this.emit('lost', obj);
      return true;
    }
    s.sock.write(`${JSON.stringify(obj)}\n`);
    s.written += 1;
    this.emit('sent', obj);
    return true;
  }

  recreateSender(why) {
    const old = this.sender;
    this.sender = blankSender();
    if (old.sock && !old.sock.destroyed) old.sock.destroy();
    for (const s of this.backlog) s.destroy(); // pending connections die with the old listener
    this.backlog.clear();
    this.log('conn', `evt: send socket recreated (${why})`);
    this.emit('sender-recreated', why);
  }

  // The sender goes stale: events vanish until the cmd socket closes, though "ok"s keep coming.
  makeStale() {
    if (!this.sender.sock) return false;
    this.sender.stale = true;
    this.log('conn', 'evt: the send socket is stale: events vanish until the cmd socket closes');
    return true;
  }

  // Lightroom closes the client connection(s) by itself, as it does around menus and the Plug-in Manager.
  closeClients(which = 'both') {
    if (!['cmd', 'evt', 'both'].includes(which)) throw new Error('close takes cmd, evt or both');
    this.log('conn', `Lightroom closes the ${which === 'both' ? 'client connections' : `${which} connection`} by itself`);
    if (which === 'evt' || which === 'both') {
      if (this.sender.sock) this.sender.sock.destroy();
      this.recreateSender('Lightroom closed the event connection');
    }
    if ((which === 'cmd' || which === 'both') && this.cmd) this.cmd.sock.destroy();
  }

  // Quit (no goodbye: sockets close before the shutdown hooks run) and relaunch after downMs,
  // optionally with another catalog. The new plugin instance has a new inst and an empty watch list.
  async relaunch({ downMs = 3000, catalog } = {}) {
    this.log('info', `Lightroom quits${catalog ? ` to open ${catalog}` : ''}; back in ${downMs} ms`);
    this.lr.shutdown();
    await this.unbind();
    this.emit('down');
    await new Promise((resolve) => this.lr.clock.setTimeout(resolve, downMs));
    if (this.stopped) return;
    this.lr.boot({ catalog });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.bind();
        break;
      } catch (err) {
        if (attempt >= 20) throw err;
        await sleep(100);
      }
    }
    if (this.stopped) {
      await this.unbind();
      return;
    }
    this.log('info', `Lightroom is back (inst ${this.lr.inst})`);
    this.emit('up');
  }
}

function makeControl({ lr, server, clock }) {
  const control = {
    clock: clock.kind,
    // PROTOCOL.md, Fixtures: a setup line. Replaces Lightroom's whole state.
    setup: (setup) => lr.load(setup ?? {}),
    // A user line: {photo}, {selected}, {module}, {edit}; also {flag}, {rating}, {label}.
    user: (action) => lr.user(action),
    // An expect line: returns { ok, errors }.
    expect: (exp) => lr.expect(exp),
    state: () => ({ ...lr.snapshot(), clients: control.clients(), ports: { cmd: server.cmdPort, evt: server.evtPort } }),
    // Lets time pass: on the manual clock in 200 ms poll steps; on the real clock it just waits.
    async advance(ms) {
      if (clock.kind !== 'manual') {
        await sleep(ms);
        return;
      }
      let left = Math.max(0, ms);
      while (left > 0) {
        const step = Math.min(TIMING.pollMs, left);
        clock.advanceSync(step);
        left -= step;
      }
    },
    // One poll step: 200 ms, which runs Lightroom's poll once.
    step: () => control.advance(TIMING.pollMs),
    pause: (ms) => lr.pause(ms),
    resume: () => lr.resume(),
    stale: () => server.makeStale(),
    close: (which) => server.closeClients(which),
    relaunch: (opts) => server.relaunch(opts),
    busy: (ms) => lr.setBusy(ms),
    options: (opts) => lr.setOptions(opts),
    evtWritten: () => server.sender.written,
    clients: () => ({
      cmd: !!server.cmd,
      evt: !!server.sender.sock,
      greeted: server.sender.greeted,
      stale: server.sender.stale,
      written: server.sender.written,
      lost: server.sender.lost,
      backlog: server.backlog.size,
      connections: { ...server.connections },
    }),
    // Resolves true once a client holds both sockets and has been greeted.
    async waitClients(timeoutMs = 3000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const c = control.clients();
        if (c.cmd && c.evt && c.greeted) return true;
        if (Date.now() >= end) return false;
        await sleep(5);
      }
    },
    on: (event, fn) => { server.on(event, fn); return control; },
    off: (event, fn) => { server.off(event, fn); return control; },
  };
  return control;
}

// Starts a mock Lightroom. Ports default to DeckBridge's 58780/58781; pass 0 for ephemeral ports.
// scenario: a fixture setup object (default: default-scenario.json). clock: 'real' or 'manual'.
// log: optional function(kind, text). setCostMs: each set takes this long, and later lines wait.
export async function startMock({
  cmdPort = CMD_PORT,
  evtPort = EVT_PORT,
  ports,
  host = '127.0.0.1',
  clock = 'real',
  scenario,
  log,
  setCostMs = 0,
  lrVersion = '15.3',
} = {}) {
  if (ports) [cmdPort, evtPort] = ports;
  if (cmdPort !== 0 && cmdPort === evtPort) throw new Error(`the cmd and evt ports must differ (both are ${cmdPort})`);
  const clk = makeClock(clock);
  const logger = typeof log === 'function' ? log : () => {};
  const lr = new MockLightroom({ clock: clk, log: logger, lrVersion });
  lr.load(scenario ?? loadScenario());
  lr.setOptions({ setCostMs });
  const server = new MockServer({ lr, host, cmdPort, evtPort, log: logger });
  await server.bind();
  lr.start();
  const control = makeControl({ lr, server, clock: clk });
  let stopped = null;
  return {
    get cmdPort() { return server.cmdPort; },
    get evtPort() { return server.evtPort; },
    control,
    lr,
    server,
    stop() {
      if (!stopped) {
        server.stopped = true;
        lr.shutdown();
        stopped = server.unbind();
      }
      return stopped;
    },
  };
}
