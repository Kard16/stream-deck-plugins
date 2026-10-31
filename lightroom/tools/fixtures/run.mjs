#!/usr/bin/env node
// Runs the fixture conversations in lightroom/protocol/fixtures against the mock Lightroom, over real
// sockets on ephemeral ports, by the rules in PROTOCOL.md's Fixtures section:
// - connect both sockets, throw away whatever Lightroom sends on connect, then play the lines in order;
// - deck/raw lines go over the cmd socket; setup, user and expect lines go through the mock's control API;
// - after every deck, raw and user line, 200 ms pass and Lightroom's poll runs once; a wait passes time
//   in 200 ms poll steps. With --clock manual (the default) the runner owns the mock's clock; with
//   --clock real it just waits.
// A fixture also fails when the mock logs an error (an exception in its poll, observer, timers or socket
// hooks, which it catches) or writes anything but "ok" on the cmd socket.
// Exits non-zero if any fixture fails.
//
//   mise exec -- node lightroom/tools/fixtures/run.mjs [--clock manual|real|both] [--concurrency N] [file.jsonl ...]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startMock } from '../mock-lr/index.mjs';
import { LrClient, sleep } from '../lib/client.mjs';
import { Inbox, short } from '../lib/match.mjs';
import { FIXTURES_DIR, listFixtures, parseFixture, readFixture } from '../lib/fixtures.mjs';

const now = () => performance.now();

// Runs one fixture: a file path, or { name, text } with the JSONL in text. onMock(mock), for the
// runner's own tests, gets the mock before the client connects, to break it on purpose.
// Resolves { name, file, clock, ok, error, line, text, lines, ms }; never throws.
export async function runFixture(source, { clock = 'manual', lrTimeoutMs = 3000, onMock } = {}) {
  const t0 = now();
  const inline = typeof source !== 'string';
  const file = inline ? null : source;
  const result = { name: inline ? (source.name ?? 'inline') : path.basename(file), file, clock, ok: false, error: null, line: null, text: null, lines: 0, ms: 0 };
  let mock = null;
  let client = null;
  let current = null;
  try {
    const fx = inline ? parseFixture(source.text, result.name) : readFixture(file);
    result.lines = fx.lines.length;
    // The mock catches exceptions in its poll, observer, timers and socket hooks and logs them as
    // 'error', so a bug there would otherwise pass unless a later line happened to notice.
    const mockErrors = [];
    const log = (kind, text) => { if (kind === 'error') mockErrors.push(text); };
    mock = await startMock({ cmdPort: 0, evtPort: 0, clock, scenario: fx.setup, log });
    if (onMock) await onMock(mock);
    const { control } = mock;
    const manual = control.clock === 'manual';
    const inbox = new Inbox();
    let lost = null;
    const cmdJunk = []; // anything but "ok" on the cmd socket, where LrSocket's receive mode writes only that
    client = new LrClient({
      cmdPort: mock.cmdPort, evtPort: mock.evtPort,
      autoHello: false, heartbeat: false, reconnect: false, clientName: 'fixture-runner',
    });
    client.on('msg', (m, t) => inbox.push(m, t));
    client.on('unexpected', ({ msg }) => cmdJunk.push(short(msg)));
    client.on('badline', ({ side, line, t }) => {
      if (side === 'evt') inbox.push({ t: '(not JSON)', line }, t);
      else cmdJunk.push(short(line));
    });
    client.on('down', (e) => { if (!lost) lost = e; });
    const checkMock = () => {
      if (mockErrors.length) throw new Error(`the mock logged an error: ${mockErrors[0].split('\n')[0]}`);
      if (cmdJunk.length) throw new Error(`Lightroom wrote ${cmdJunk[0]} on the cmd socket, where only "ok" belongs`);
    };
    client.start();
    if (!(await client.waitUp(3000))) throw new Error('could not connect to the mock');
    if (!(await control.waitClients(3000))) throw new Error('the mock never greeted the client');

    // Waits until every event line the mock has written has arrived.
    const sync = async () => {
      const end = now() + 2000;
      while (client.evtLines < control.evtWritten()) {
        if (now() > end) throw new Error(`only ${client.evtLines} of the mock's ${control.evtWritten()} event lines arrived`);
        await sleep(1);
      }
    };
    await sync();
    inbox.clear(); // throw away whatever Lightroom sent on connect

    checkMock();
    for (const ln of fx.lines) {
      current = ln;
      if (lost) throw new Error(`the connection dropped (${lost.side ?? 'both'}: ${lost.reason ?? 'closed'})`);
      switch (ln.kind) {
        case 'note':
        case 'setup':
          break;
        case 'deck':
        case 'raw': {
          const rec = ln.kind === 'deck' ? client.send(ln.value) : client.sendRaw(ln.value);
          if (!rec) throw new Error('not connected');
          if (!(await client.waitOks(2000))) throw new Error('Lightroom did not answer the line with "ok" within 2 s');
          await control.step();
          break;
        }
        case 'user':
          control.user(ln.value);
          await control.step();
          break;
        case 'wait':
          await control.advance(ln.value);
          break;
        case 'never':
          inbox.never(ln.value);
          break;
        case 'lr':
          if (manual) await sync();
          await inbox.expect(ln.value, { timeoutMs: manual ? 0 : lrTimeoutMs });
          break;
        case 'expect': {
          const r = control.expect(ln.value);
          if (!r.ok) throw new Error(`Lightroom's state differs: ${r.errors.join('; ')}`);
          break;
        }
        default:
          throw new Error(`unknown line kind ${ln.kind}`);
      }
      checkMock(); // anything this line made the mock log or write on the cmd socket
    }
    current = null;
    // Whatever arrives after the last line must be allowed extras too.
    if (manual) await sync();
    else await sleep(250);
    inbox.check();
    checkMock();
    if (lost) throw new Error(`the connection dropped (${lost.side ?? 'both'})`);
    result.ok = true;
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
    if (current) {
      result.line = current.line;
      result.text = current.text;
    }
  } finally {
    if (client) client.stop();
    if (mock) await mock.stop();
    result.ms = Math.round(now() - t0);
  }
  return result;
}

// Runs fixture files with up to `concurrency` at a time. Resolves the results in file order.
export async function runFixtures(files = listFixtures(), { clock = 'manual', concurrency = 1, onResult } = {}) {
  const results = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      results[i] = await runFixture(files[i], { clock });
      if (onResult) onResult(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker));
  return results;
}

export function formatResult(r) {
  const head = `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.clock} clock, ${r.lines} lines, ${r.ms} ms)`;
  if (r.ok) return head;
  const where = r.line ? `\n      line ${r.line}: ${r.text}` : '';
  return `${head}${where}\n      ${r.error}`;
}

async function main() {
  let opt;
  let files;
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        clock: { type: 'string', default: 'manual' },
        concurrency: { type: 'string', default: '1' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    opt = parsed.values;
    files = parsed.positionals.length ? parsed.positionals.map((f) => path.resolve(f)) : listFixtures();
    if (!['manual', 'real', 'both'].includes(opt.clock)) throw new Error('--clock takes manual, real or both');
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node lightroom/tools/fixtures/run.mjs [--clock manual|real|both] [--concurrency N] [file.jsonl ...]\n`);
    process.exit(2);
  }
  if (opt.help) {
    process.stdout.write(`usage: node lightroom/tools/fixtures/run.mjs [--clock manual|real|both] [--concurrency N] [file.jsonl ...]\nWith no files it runs every fixture in ${path.relative(process.cwd(), FIXTURES_DIR) || FIXTURES_DIR}.\n`);
    return;
  }
  const clocks = opt.clock === 'both' ? ['manual', 'real'] : [opt.clock];
  const concurrency = Math.max(1, Number(opt.concurrency) || 1);
  let failed = 0;
  let total = 0;
  for (const clock of clocks) {
    const t0 = now();
    const results = await runFixtures(files, {
      clock,
      concurrency,
      onResult: (r) => { if (!opt.quiet || !r.ok) process.stdout.write(`${formatResult(r)}\n`); },
    });
    const bad = results.filter((r) => !r.ok).length;
    failed += bad;
    total += results.length;
    process.stdout.write(`fixtures: ${results.length - bad}/${results.length} passed (${clock} clock, ${((now() - t0) / 1000).toFixed(1)} s)\n`);
  }
  if (clocks.length > 1) process.stdout.write(`fixtures: ${total - failed}/${total} passed in all\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
