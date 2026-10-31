// Shared helpers for the tools' tests. Everything binds ephemeral ports (port 0) only: Lightroom
// itself listens on 58780/58781, and other tracks run their tests at the same time.
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from '../mock-lr/index.mjs';

export const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(TOOLS, 'tests', 'data');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(pred, timeoutMs = 5000, stepMs = 10) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= end) return false;
    await sleep(stepMs);
  }
}

// Runs fn with a mock on ephemeral ports, then stops it. The mock catches exceptions in its poll,
// observer, timers and socket hooks and logs them as 'error': any such entry fails the test.
export async function withMock(opts = {}, fn) {
  const errors = [];
  const log = (kind, text) => {
    if (kind === 'error') errors.push(text);
    if (typeof opts.log === 'function') opts.log(kind, text);
  };
  const mock = await startMock({ cmdPort: 0, evtPort: 0, ...opts, log });
  let result;
  try {
    result = await fn(mock);
  } finally {
    await mock.stop();
  }
  if (errors.length) throw new Error(`the mock logged ${errors.length} error(s):\n${errors.join('\n')}`);
  return result;
}

// A port nothing listens on: bind an ephemeral one and close it again.
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Holds an ephemeral port open. Resolves { port, close }.
export function holdPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

// A raw line reader on one port, for tests that must break the client rules on purpose.
export function rawSocket(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const lines = [];
    let buf = '';
    let closed = false;
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    sock.on('close', () => { closed = true; });
    sock.on('error', () => {});
    sock.once('connect', () => resolve({
      sock,
      lines,
      get closed() { return closed; },
      json: () => lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)),
      send: (obj) => sock.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`),
      close: () => sock.destroy(),
    }));
    sock.once('error', reject);
  });
}

// Runs `node <args>` and collects its output. Resolves { code, signal, stdout, stderr }.
export function runNode(args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: TOOLS, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Spawns `node <args>` and keeps it running. lines() and waitLine() look at stdout and stderr.
export function spawnNode(args) {
  const child = spawn(process.execPath, args, { cwd: TOOLS, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  const onData = (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.setEncoding('utf8').on('data', onData);
  child.stderr.setEncoding('utf8').on('data', onData);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    lines,
    exited,
    write: (text) => child.stdin.write(text),
    async waitLine(re, timeoutMs = 5000, from = 0) {
      let found = null;
      await waitUntil(() => {
        found = lines.slice(from).find((l) => re.test(l)) ?? null;
        return found != null;
      }, timeoutMs);
      if (found == null) throw new Error(`no line matching ${re} within ${timeoutMs} ms; got:\n${lines.join('\n')}`);
      return found;
    },
    async kill() {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
      return exited;
    },
  };
}
