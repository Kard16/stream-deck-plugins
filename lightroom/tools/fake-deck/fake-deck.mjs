#!/usr/bin/env node
// A scriptable fake deck client, for driving the real DeckBridge plugin inside Lightroom from scripts
// (verification ladder step 4 in docs/lightroom/plan.md), or the mock.
//
//   mise exec -- node lightroom/tools/fake-deck/fake-deck.mjs <script.json> [--ports cmd,evt] [--timeout ms] [--connect-ms ms] [--quiet]
//
// It connects with the shared client (pair rule, backoff, ok draining, heartbeat), throws away the
// greeting Lightroom sends on connect, runs the script's steps and prints a step log. It exits 0 when
// every step and every cleanup step passed, 1 when one failed or Lightroom can't be reached, 2 on a
// bad script or bad arguments.
//
// A script is { "name", "about", "timeoutMs", "catalog", "steps": [...], "cleanup": [...] }, or just
// the steps. Cleanup steps always run, even after a failure, to put the photo back as the script found it.
// "catalog" (a .lrcat path) makes the script write only to that catalog, whatever the guard says: the
// run fails at connect if Lightroom's greeting names another catalog, an expect that matches a hello
// naming another one fails, and a write (set, reset, flag, preset) is refused unless the latest hello
// since the connection came up names that catalog. Paths compare without case, like the guard's.
// Steps (one action key each):
//   {"send": {...}}                 a command; {"raw": "text"} a raw line
//   {"expect": {...}, "timeout": ms, "save": {"var": "path.in.message"}, "hint": "..."}
//                                   waits for a matching event, by the fixture rules (lib/match.mjs):
//                                   extra state/vals/ranges/pong may come first, anything else fails
//   {"never": {...}}                until the next expect matches, no event may match this
//   {"wait": ms}                    lets time pass; {"drain": ms} waits, then checks that everything
//                                   that arrived meanwhile was an allowed extra
//   {"log": "text"}                 prints text; $var and $var.path are filled in
//   {"let": {"var": expr}}          sets variables; {"fail": "why"} fails the script
// Any step may carry "when": expr, and is skipped unless it's true. "note" is a comment.
// Values: "$var" or "$var.path" (whole strings) are replaced by variables, keeping their type.
// $state and $hello always hold the latest state and hello. Expressions: {"$add": [a, b, ...]},
// {"$round": [x, digits]}, {"$if": [cond, a, b]}, {"$and": [...]}, {"$or": [...]}, {"$eq": [a, b]},
// {"$ne": [a, b]}, {"$lt": [a, b]}, {"$gt": [a, b]}, {"$map": [value, {"key": result}]}. In sends and
// expects an unset variable is an error; in when and let it reads as null. In expect patterns,
// {"$not": pattern} and {"$type": "number"} work too. timeoutMs, timeout, wait and drain are numbers
// of ms. Anything Lightroom writes on the cmd socket other than "ok" fails the next expect or drain.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { LrClient, sleep } from '../lib/client.mjs';
import { Inbox, NUMBER_TOLERANCE, short } from '../lib/match.mjs';
import { CMD_PORT, EVT_PORT, parsePorts, sameCatalog } from '../lib/params.mjs';

const now = () => performance.now();
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export class ScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScriptError';
  }
}

const STEP_KINDS = ['send', 'raw', 'expect', 'never', 'wait', 'drain', 'log', 'let', 'fail'];
const STEP_MODIFIERS = ['when', 'timeout', 'save', 'hint', 'note'];
const WRITES = new Set(['set', 'reset', 'flag', 'preset']); // the guarded commands (PROTOCOL.md, Guard)

const isMs = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

// ---------- variables and expressions ----------

function getPath(obj, dotted) {
  if (!dotted) return obj;
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

const VAR_RE = /^\$([A-Za-z_]\w*)((?:\.[\w-]+)*)$/;

function lookup(text, vars, strict) {
  const m = VAR_RE.exec(text);
  if (!m) return { found: false };
  if (!Object.prototype.hasOwnProperty.call(vars, m[1])) {
    if (strict) throw new ScriptError(`$${m[1]} isn't set`);
    return { found: true, value: null };
  }
  const value = getPath(vars[m[1]], m[2].slice(1));
  if (value === undefined) {
    if (strict) throw new ScriptError(`${text} isn't set`);
    return { found: true, value: null };
  }
  return { found: true, value };
}

function deepEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= NUMBER_TOLERANCE;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return a === b;
}

const needNumber = (x, op) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new ScriptError(`${op} wants numbers, got ${short(x)}`);
  return x;
};

const EXPR = {
  $add: (args, ev) => {
    if (!Array.isArray(args)) throw new ScriptError('$add takes a list');
    return args.map(ev).reduce((sum, x) => sum + needNumber(x, '$add'), 0);
  },
  $round: (args, ev) => {
    const [x, digits = 0] = args.map(ev);
    const f = 10 ** needNumber(digits, '$round');
    return Math.round(needNumber(x, '$round') * f) / f;
  },
  $if: (args, ev) => (truthy(ev(args[0])) ? ev(args[1]) : ev(args[2])),
  $and: (args, ev) => args.every((a) => truthy(ev(a))),
  $or: (args, ev) => args.some((a) => truthy(ev(a))),
  $eq: (args, ev) => deepEqual(ev(args[0]), ev(args[1])),
  $ne: (args, ev) => !deepEqual(ev(args[0]), ev(args[1])),
  $lt: (args, ev) => needNumber(ev(args[0]), '$lt') < needNumber(ev(args[1]), '$lt'),
  $gt: (args, ev) => needNumber(ev(args[0]), '$gt') > needNumber(ev(args[1]), '$gt'),
  $map: (args, ev) => {
    const value = ev(args[0]);
    const table = args[1];
    if (!isObject(table)) throw new ScriptError('$map takes [value, {"key": result}]');
    const key = String(value);
    if (!Object.prototype.hasOwnProperty.call(table, key)) throw new ScriptError(`$map has no entry for ${short(value)}`);
    return ev(table[key]);
  },
};

const truthy = (x) => x !== false && x !== null && x !== undefined && x !== 0 && x !== '';

// Fills in variables and expressions. strict: an unset variable is an error (sends and expects);
// otherwise it reads as null (conditions).
export function evaluate(x, vars, { strict = true } = {}) {
  const ev = (y) => evaluate(y, vars, { strict });
  if (typeof x === 'string') {
    const r = lookup(x, vars, strict);
    return r.found ? r.value : x;
  }
  if (Array.isArray(x)) return x.map(ev);
  if (isObject(x)) {
    const keys = Object.keys(x);
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(EXPR, keys[0])) {
      const args = x[keys[0]];
      if (!Array.isArray(args)) throw new ScriptError(`${keys[0]} takes a list`);
      return EXPR[keys[0]](args, ev);
    }
    const out = {};
    for (const k of keys) out[k] = ev(x[k]);
    return out;
  }
  return x;
}

function interpolate(text, vars) {
  return String(text).replace(/\$([A-Za-z_]\w*)((?:\.[\w-]+)*)/g, (all) => {
    const r = lookup(all, vars, false);
    return r.value == null ? all : typeof r.value === 'object' ? short(r.value, 80) : String(r.value);
  });
}

// ---------- script loading ----------

export function loadScript(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ScriptError(`${file}: ${err.message}`);
  }
  return normalizeScript(data, path.basename(file));
}

export function normalizeScript(data, name = 'script') {
  const script = Array.isArray(data) ? { steps: data } : data;
  if (!isObject(script) || !Array.isArray(script.steps)) throw new ScriptError(`${name}: a script is a list of steps, or {"steps": [...]}`);
  const cleanup = script.cleanup ?? [];
  if (!Array.isArray(cleanup)) throw new ScriptError(`${name}: cleanup must be a list of steps`);
  const check = (list, label) => list.forEach((step, i) => {
    if (!isObject(step)) throw new ScriptError(`${name}: ${label} ${i + 1} must be an object`);
    const kinds = Object.keys(step).filter((k) => STEP_KINDS.includes(k));
    const unknown = Object.keys(step).filter((k) => !STEP_KINDS.includes(k) && !STEP_MODIFIERS.includes(k));
    const commentOnly = Object.keys(step).length === 1 && 'note' in step;
    if (kinds.length !== 1 && !commentOnly) throw new ScriptError(`${name}: ${label} ${i + 1} needs exactly one of ${STEP_KINDS.join(', ')}`);
    if (unknown.length) throw new ScriptError(`${name}: ${label} ${i + 1} has unknown keys ${unknown.join(', ')}`);
    // A timeout or wait that isn't a number would never run out, and the run would hang.
    for (const key of ['timeout', 'wait', 'drain']) {
      if (key in step && !isMs(step[key])) throw new ScriptError(`${name}: ${label} ${i + 1}: ${key} must be a number of ms, 0 or more`);
    }
  });
  check(script.steps, 'step');
  check(cleanup, 'cleanup step');
  const timeoutMs = script.timeoutMs ?? 3000;
  if (!isMs(timeoutMs) || timeoutMs === 0) throw new ScriptError(`${name}: timeoutMs must be a number of ms above 0`);
  if (script.catalog != null && (typeof script.catalog !== 'string' || script.catalog === '')) {
    throw new ScriptError(`${name}: catalog must be the path of a .lrcat file`);
  }
  return {
    name: script.name ?? name,
    about: script.about ?? '',
    timeoutMs,
    catalog: script.catalog ?? null,
    steps: script.steps,
    cleanup,
  };
}

function describeMsg(msg) {
  if (!isObject(msg)) return short(msg);
  switch (msg.t) {
    case 'hello': return `hello v${msg.v} ${msg.catalog ?? ''} writable ${msg.writable} inst ${msg.inst}`;
    case 'state': return `state ${msg.module} photo ${msg.photo} (${msg.file}) flag ${msg.flag} rating ${msg.rating} ${msg.label} sel ${msg.sel}`;
    case 'ranges': return `ranges for ${Object.keys(msg.ranges ?? {}).length} params`;
    case 'vals': return `vals ${short(msg.vals, 120)}`;
    case 'presets': return `presets: ${Array.isArray(msg.items) ? msg.items.length : '?'} items`;
    default: return short(msg, 140);
  }
}

// ---------- running ----------

// Runs a script against Lightroom (or the mock) on cmdPort/evtPort. Resolves
// { ok, name, failures: [{ where, step, error }], steps, ms }. Never throws for Lightroom's behaviour.
export async function runScript(scriptOrFile, {
  cmdPort = CMD_PORT, evtPort = EVT_PORT, host = '127.0.0.1',
  timeoutMs, connectTimeoutMs = 10000, out = (line) => process.stdout.write(`${line}\n`), quiet = false,
} = {}) {
  const script = typeof scriptOrFile === 'string' ? loadScript(scriptOrFile) : normalizeScript(scriptOrFile);
  // A timeout that isn't a number never runs out, and a missing reply would hang the run.
  if (timeoutMs !== undefined && (!isMs(timeoutMs) || timeoutMs === 0)) throw new ScriptError('timeoutMs must be a number of ms above 0');
  if (!isMs(connectTimeoutMs) || connectTimeoutMs === 0) throw new ScriptError('connectTimeoutMs must be a number of ms above 0');
  const stepTimeout = timeoutMs ?? script.timeoutMs;
  const print = (line) => { if (!quiet) out(line); };
  const t0 = now();
  const failures = [];
  const vars = {};
  const inbox = new Inbox({ ops: true });
  const client = new LrClient({ host, cmdPort, evtPort, autoHello: false, clientName: 'fake-deck', firstId: 900000 });
  let running = true;
  client.on('msg', (m, t) => {
    if (m.t === 'state') vars.state = m;
    if (m.t === 'hello') vars.hello = m;
    inbox.push(m, t);
  });
  // LrSocket's receive mode writes nothing but "ok" on the cmd socket, so anything else there is a bug.
  client.on('unexpected', ({ msg, t }) => inbox.push({ t: '(on the cmd socket)', msg }, t));
  client.on('badline', ({ side, line, t }) => inbox.push(side === 'evt' ? { t: '(not JSON)', line } : { t: '(on the cmd socket)', line }, t));
  client.on('down', (e) => { if (running) inbox.push({ t: '(disconnected)', side: e.side, reason: e.reason }); });

  // script.catalog: the only catalog the script may write to, whatever Lightroom's guard says.
  const wrongCatalog = (h) => (script.catalog && !sameCatalog(h.path, script.catalog)
    ? `Lightroom has ${h.path ?? h.catalog ?? 'a catalog it did not name'} open, not ${script.catalog}, the only catalog this script writes to`
    : null);
  // A write needs a hello since the sockets last came up that names script.catalog.
  const checkWrite = (cmd) => {
    if (!script.catalog || !isObject(cmd) || !WRITES.has(cmd.t)) return;
    if (!client.greeted()) throw new ScriptError(`refusing to send ${cmd.t}: no hello from Lightroom since it last connected, so the open catalog is unknown`);
    const why = wrongCatalog(client.lastHello);
    if (why) throw new ScriptError(`refusing to send ${cmd.t}: ${why}`);
  };
  client.on('paused', () => print('   (Lightroom is not taking lines: a menu, dialog or the Plug-in Manager may be open)'));
  client.on('stale', () => print('   (no events for 6 s while Lightroom still answers: reconnecting both sockets)'));

  print(`fake-deck: ${script.name}, Lightroom on ${host}:${cmdPort}/${evtPort}`);
  if (script.about) print(`   ${script.about}`);

  // Connects (or reconnects) and throws away the greeting: wait for its hello, then a ping round trip.
  const connect = async (limitMs) => {
    const tStart = now();
    if (!(await client.waitUp(limitMs))) {
      throw new ScriptError(`couldn't connect to ${host}:${cmdPort}/${evtPort} within ${Math.round(limitMs / 1000)} s. Is Lightroom running with DeckBridge loaded, and the Stream Deck plugin stopped? Lightroom serves one client at a time.`);
    }
    const greet = await client.waitFor('hello', 3000, tStart - 1);
    const why = greet && wrongCatalog(greet.msg);
    if (why) throw new ScriptError(`${why}. Open it in Lightroom and run again.`);
    const sync = await client.request({ t: 'ping' }, 5000);
    if (!sync.ok) throw new ScriptError('Lightroom took the connection but did not answer a ping: is a menu, a dialog or the Plug-in Manager open?');
    inbox.clear();
    print(`   connected in ${Math.round(now() - tStart)} ms; ${greet ? `greeting skipped (inst ${greet.msg.inst})` : 'no greeting on connect'}`);
  };

  const runStep = async (step) => {
    const kind = STEP_KINDS.find((k) => k in step);
    switch (kind) {
      case 'send': {
        const obj = evaluate(step.send, vars);
        checkWrite(obj);
        if (!client.send(obj)) throw new ScriptError('not connected');
        return `send   ${short(obj, 140)}`;
      }
      case 'raw': {
        const text = String(evaluate(step.raw, vars));
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON: Lightroom answers err bad and writes nothing */ }
        checkWrite(parsed);
        if (!client.sendRaw(text)) throw new ScriptError('not connected');
        return `raw    ${short(text, 140)}`;
      }
      case 'expect': {
        const pattern = evaluate(step.expect, vars);
        const tw = now();
        const r = await inbox.expect(pattern, { timeoutMs: step.timeout ?? stepTimeout });
        const why = r.msg.t === 'hello' && wrongCatalog(r.msg);
        if (why) throw new ScriptError(why);
        if (step.save) {
          for (const [name, where] of Object.entries(step.save)) {
            const value = getPath(r.msg, where);
            if (value === undefined) throw new ScriptError(`save: the ${r.msg.t} has no ${where}`);
            vars[name] = value;
          }
        }
        const skipped = r.skipped.length ? `, skipped ${r.skipped.length}` : '';
        return `expect ${describeMsg(r.msg)}  ok (${Math.round(now() - tw)} ms${skipped})`;
      }
      case 'never':
        inbox.never(evaluate(step.never, vars));
        return `never  ${short(step.never, 140)}`;
      case 'wait':
        await sleep(step.wait);
        return `wait   ${step.wait} ms`;
      case 'drain': {
        await sleep(step.drain);
        const extras = inbox.check();
        return `drain  ${step.drain} ms: ${extras.length ? `${extras.length} extra (${[...new Set(extras.map((m) => m.t))].join(', ')})` : 'nothing'}`;
      }
      case 'log':
        return `log    ${interpolate(step.log, vars)}`;
      case 'let':
        // Lenient, like when: an unset variable reads as null, so cleanup can test what got set.
        for (const [name, expr] of Object.entries(step.let)) vars[name] = evaluate(expr, vars, { strict: false });
        return `let    ${Object.keys(step.let).map((k) => `${k} = ${short(vars[k], 60)}`).join(', ')}`;
      case 'fail':
        throw new ScriptError(interpolate(step.fail, vars));
      default:
        throw new ScriptError(`unknown step ${short(step)}`);
    }
  };

  // Runs a list; with stopOnFail it stops at the first failure.
  const runList = async (list, label, stopOnFail) => {
    let ok = true;
    for (let i = 0; i < list.length; i += 1) {
      const step = list[i];
      const where = `${label}${i + 1}`;
      try {
        if (!STEP_KINDS.some((k) => k in step)) continue; // a note
        if (step.when !== undefined && !truthy(evaluate(step.when, vars, { strict: false }))) continue;
        const line = await runStep(step);
        print(`${where.padStart(4)}  ${line}`);
      } catch (err) {
        ok = false;
        const hint = step.hint ? `\n      hint: ${interpolate(step.hint, vars)}` : '';
        print(`${where.padStart(4)}  FAIL ${Object.keys(step).find((k) => STEP_KINDS.includes(k))}: ${err.message}${hint}`);
        failures.push({ where, step, error: err.message });
        if (stopOnFail) return false;
      }
    }
    return ok;
  };

  let connected = false;
  try {
    client.start();
    await connect(connectTimeoutMs);
    connected = true;
    await runList(script.steps, '', true);
  } catch (err) {
    print(`   FAIL ${err.message}`);
    failures.push({ where: 'connect', step: null, error: err.message });
  }

  if (connected && script.cleanup.length) {
    print('cleanup');
    try {
      if (!client.isUp() || inbox.queue.some((q) => q.msg.t === '(disconnected)')) await connect(5000);
      inbox.clear();
      inbox.nevers = [];
      await runList(script.cleanup, 'c', false);
    } catch (err) {
      print(`   FAIL cleanup: ${err.message}`);
      failures.push({ where: 'cleanup', step: null, error: err.message });
    }
  }
  running = false;
  client.stop();
  const ms = Math.round(now() - t0);
  const ok = failures.length === 0;
  const first = failures[0];
  print(`${script.name}: ${ok ? 'PASS' : `FAIL at ${first.where === 'connect' ? 'connect' : `step ${first.where}`}`} (${script.steps.length} steps, ${script.cleanup.length} cleanup, ${(ms / 1000).toFixed(1)} s)`);
  return { ok, name: script.name, failures, steps: script.steps.length, ms, vars };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        ports: { type: 'string' },
        timeout: { type: 'string' },
        'connect-ms': { type: 'string' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const usage = 'usage: node lightroom/tools/fake-deck/fake-deck.mjs <script.json> [--ports cmd,evt] [--timeout ms] [--connect-ms ms] [--quiet]\n  --ports default 58780,58781 (DeckBridge in Lightroom); --timeout per expect (default: the script\'s timeoutMs); --connect-ms default 10000';
  if (parsed.values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (parsed.positionals.length !== 1) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  // A number of ms above 0. Anything else would never time out, and a missing reply would hang the run.
  const ms = (flag) => {
    const text = parsed.values[flag];
    if (text === undefined) return undefined;
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || n <= 0) throw new Error(`--${flag} wants a number of ms above 0, got "${text}"`);
    return n;
  };
  let ports;
  let script;
  let timeoutMs;
  let connectTimeoutMs;
  try {
    ports = parsed.values.ports ? parsePorts(parsed.values.ports) : [CMD_PORT, EVT_PORT];
    timeoutMs = ms('timeout');
    connectTimeoutMs = ms('connect-ms') ?? 10000;
    script = loadScript(path.resolve(parsed.positionals[0]));
  } catch (err) {
    process.stderr.write(`fake-deck: ${err.message}\n`);
    process.exit(2);
  }
  const r = await runScript(script, { cmdPort: ports[0], evtPort: ports[1], timeoutMs, connectTimeoutMs, quiet: !!parsed.values.quiet });
  if (parsed.values.quiet) process.stdout.write(`${r.name}: ${r.ok ? 'PASS' : `FAIL (${r.failures.map((f) => `${f.where}: ${f.error}`).join('; ')})`}\n`);
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(2);
  });
}
