#!/usr/bin/env node
// Spike harness for S1 (sockets), S2 (latency), S3 (hot reload) and S5 (15.3 probes).
// Speaks spikes/protocol-v0.md to the spike build of DeckBridge. Start it before the plugin loads:
// it waits, runs S1 and S3 on connect, then reacts to the Deck Spike menu triggers, Reload Plug-in
// and quit/relaunch. Results: <out>/summary.md, summary.json, events.jsonl, s2-samples.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LrClient, now, sleep } from './lib/client.mjs';
import { round, round2, stats, median, triangle } from './lib/stats.mjs';
import { renderSummary } from './lib/summary.mjs';

const TEST_CATALOG = '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat';
const KNOWN_TYPES = new Set(['hello', 'state', 'vals', 'val', 'range', 'ack', 'pong', 'result', 'trigger', 'err', 'bye', 'log']);
const SV_LINE = /^(\s*local\s+V\s*=\s*)(['"])([^'"\n]*)\2/m;

// ---------- options ----------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values: opt } = parseArgs({
  options: {
    'cmd-port': { type: 'string' },
    'evt-port': { type: 'string' },
    'plugin-dir': { type: 'string' },
    out: { type: 'string' },
    quick: { type: 'boolean' },
    'max-minutes': { type: 'string' },
  },
  strict: false,
});

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const iso = () => new Date().toISOString();
const num = (x, dflt) => (x != null && Number.isFinite(Number(x)) ? Number(x) : dflt);

const runId = stamp();
const cfg = {
  cmdPort: num(opt['cmd-port'], 58780),
  evtPort: num(opt['evt-port'], 58781),
  pluginDir: opt['plugin-dir'] ? path.resolve(opt['plugin-dir']) : path.join(repoRoot, 'lightroom/lua/DeckBridge.lrdevplugin'),
  out: opt.out ? path.resolve(opt.out) : path.join(repoRoot, 'spikes/results', runId),
  quick: !!opt.quick,
  maxMinutes: num(opt['max-minutes'], 90),
};
fs.mkdirSync(cfg.out, { recursive: true });

// ---------- state, logging, recording ----------

const S = {
  meta: {
    runId, startedAt: iso(), updatedAt: null, endedAt: null, endReason: null,
    cmdPort: cfg.cmdPort, evtPort: cfg.evtPort, pluginDir: cfg.pluginDir, out: cfg.out,
    quick: cfg.quick, maxMinutes: cfg.maxMinutes, expectedCatalog: TEST_CATALOG,
  },
  hello: null,
  lastHello: null,
  firstConnectAt: null,
  state: null,
  counts: { in: 0, out: 0, byType: {} },
  status: { s1: 'pending', s3: 'pending', s5: 'pending (needs trigger tests)', s2: 'pending (runs after S5)', beforeAfter: 'pending', autosync: 'pending (needs trigger autosync)' },
  s1: { cycles: [], pass: null, note: null },
  s3: { steps: [], file: null, backup: null, rewrittenTo: null, followUpPending: false, fileRestored: null, restoreNote: null },
  s5: { runs: [] },
  s2: { runs: [] },
  beforeAfter: [],
  autosync: [],
  lifecycle: { events: [] },
  guard: { count: 0, samples: [] },
  errors: [],
  unexpected: [],
  late: [],
};

function hhmmss() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const events = fs.createWriteStream(path.join(cfg.out, 'events.jsonl'), { flags: 'a' });
events.on('error', () => {});
const samples = fs.createWriteStream(path.join(cfg.out, 's2-samples.jsonl'), { flags: 'a' });
samples.on('error', () => {});

function writeRecord(rec) {
  try { events.write(JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
}

function log(tag, msg) {
  const line = `${hhmmss()} [${tag}] ${msg}`;
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
  writeRecord({ hr: round(now(), 3), wall: Date.now(), dir: 'sys', msg: { log: line } });
}
const mark = (name) => log('mark', name);

function recordError(phase, err) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.trim() : String(err);
  S.errors.push({ phase, at: iso(), msg: msg.slice(0, 2000) });
  if (S.errors.length > 100) S.errors.splice(0, S.errors.length - 100);
  log('error', `${phase}: ${msg.split('\n')[0]}`);
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeSummary() {
  S.meta.updatedAt = iso();
  try { writeFileAtomic(path.join(cfg.out, 'summary.json'), JSON.stringify(S, null, 2)); } catch (e) { log('error', `summary.json: ${e.message}`); }
  try { writeFileAtomic(path.join(cfg.out, 'summary.md'), renderSummary(S)); } catch (e) { log('error', `summary.md: ${e.message}`); }
}

function cap(list, n) {
  if (list.length > n) list.splice(0, list.length - n);
}

// ---------- SpikeVersion.lua guard (S3 edits it; it must always be put back) ----------

const svGuard = { file: path.join(cfg.pluginDir, 'SpikeVersion.lua'), original: null, modified: false };

function restoreSpikeVersion(why) {
  if (!svGuard.modified || svGuard.original == null) return;
  try {
    fs.writeFileSync(svGuard.file, svGuard.original);
    const back = fs.readFileSync(svGuard.file, 'utf8');
    svGuard.modified = back !== svGuard.original;
    S.s3.fileRestored = !svGuard.modified;
    S.s3.restoreNote = `${why}, ${iso()}`;
    if (!svGuard.modified) log('S3', `SpikeVersion.lua restored (${why})`);
  } catch (e) {
    S.s3.fileRestored = false;
    S.s3.restoreNote = `restore failed during ${why}: ${e.message}`;
    log('error', `could not restore SpikeVersion.lua: ${e.message}`);
  }
}

// ---------- client ----------

const client = new LrClient({
  cmdPort: cfg.cmdPort,
  evtPort: cfg.evtPort,
  log,
  onRecord: (rec) => {
    if (rec.dir === 'in') {
      S.counts.in += 1;
      const t = rec.msg && typeof rec.msg.t === 'string' ? rec.msg.t : '?';
      S.counts.byType[t] = (S.counts.byType[t] ?? 0) + 1;
    } else if (rec.dir === 'out') {
      S.counts.out += 1;
    }
    writeRecord(rec);
  },
});

const timedOut = new Map(); // request id -> { rec, tSent } for requests that timed out

function compactReply(m) {
  const { t, ok, ms, msg, name, data } = m;
  return { t, name, ok, ms, msg, data };
}

function normalizeReply(name, r) {
  const rec = { name, at: iso(), id: r.id };
  if (!r.ok) {
    rec.ok = false;
    rec.msg = r.error;
    if (r.error === 'timeout') timedOut.set(r.id, { rec, tSent: r.tSent });
    return rec;
  }
  const m = r.reply;
  rec.rttMs = round(r.rttMs);
  if (m.t === 'err') {
    rec.ok = false;
    rec.msg = m.msg ?? 'err';
    return rec;
  }
  rec.ok = m.ok !== false;
  if (typeof m.ms === 'number') rec.ms = round(m.ms);
  if (m.msg !== undefined) rec.msg = m.msg;
  if (m.data !== undefined) {
    rec.data = m.data;
  } else {
    const { t, id, name: n, ok, ms, msg, ...rest } = m;
    if (Object.keys(rest).length) rec.data = rest;
  }
  if (m.t !== 'result') rec.replyType = m.t;
  return rec;
}

async function probe(name, args, timeoutMs = 10000) {
  const cmd = { t: 'probe', name };
  if (args !== undefined) cmd.args = args;
  return normalizeReply(name, await client.request(cmd, timeoutMs));
}

function bezel(msg, secs = 2) {
  if (client.isCmdUp()) client.send({ t: 'bezel', msg, secs });
}

// Find a version string in a requireVersion/reload result, tolerating different shapes.
function vOf(rec) {
  if (!rec) return null;
  const d = rec.data;
  if (d && typeof d === 'object') {
    if (typeof d.v === 'string' || typeof d.v === 'number') return String(d.v);
    for (const x of Object.values(d)) {
      if (x && typeof x === 'object' && (typeof x.v === 'string' || typeof x.v === 'number')) return String(x.v);
    }
  }
  return null;
}

let guardLogged = 0;
client.on('m:err', (m) => {
  if (typeof m.msg === 'string' && /guard/i.test(m.msg)) {
    S.guard.count += 1;
    if (S.guard.samples.length < 20) S.guard.samples.push({ cmd: m.cmd ?? null, id: m.id ?? null, at: iso() });
    if (guardLogged < 3 || S.guard.count % 100 === 0) {
      guardLogged += 1;
      log('GUARD', `!!! Lightroom refused "${m.cmd ?? '?'}" with err guard (${S.guard.count} so far). Is the test catalog open?`);
    }
  }
});

client.on('msg', (m) => {
  if (!KNOWN_TYPES.has(m.t)) {
    S.unexpected.push({ why: 'unknown type', at: iso(), msg: m });
    cap(S.unexpected, 50);
  }
});
client.on('unexpected', ({ why, msg }) => { S.unexpected.push({ why, at: iso(), msg }); cap(S.unexpected, 50); });
client.on('badline', ({ side, line }) => {
  S.unexpected.push({ why: `bad JSON line on ${side}`, at: iso(), msg: line.slice(0, 300) });
  cap(S.unexpected, 50);
  log('warn', `bad JSON on ${side}: ${line.slice(0, 120)}`);
});
client.on('late', ({ msg, t }) => {
  const e = timedOut.get(msg.id);
  const afterMs = e && typeof e.tSent === 'number' ? round(t - e.tSent) : null;
  const reply = compactReply(msg);
  if (e) {
    e.rec.late = { afterMs, reply };
    timedOut.delete(msg.id);
  }
  S.late.push({ at: iso(), id: msg.id, afterMs, reply });
  cap(S.late, 50);
  log('late', `reply for id ${msg.id} (${e ? e.rec.name : '?'}) arrived ${afterMs} ms after sending`);
  writeSummary();
});
client.on('m:state', (m) => {
  const { t, ...rest } = m;
  S.state = rest;
});
client.on('m:trigger', (m) => onTrigger(m.name));

// ---------- lifecycle ----------

let currentInst = null;
let tDown = null;
let lastBye = null;
let downTimer = null;

client.on('m:bye', (m, t) => {
  lastBye = { why: m.why ?? null, t, tClose: null };
  S.lifecycle.events.push({ kind: 'bye', at: iso(), why: m.why ?? null });
  log('life', `bye (${m.why ?? 'no reason'})`);
  writeSummary();
});

client.on('disconnect', ({ side, t, deliberate }) => {
  if (deliberate) return;
  if (lastBye && lastBye.tClose == null) lastBye.tClose = t;
  if (tDown == null) {
    tDown = t;
    log('life', `${side} socket closed by Lightroom`);
    clearTimeout(downTimer);
    downTimer = setTimeout(() => {
      downTimer = null;
      if (client.isUp()) return;
      const quit = lastBye && lastBye.why === 'shutdownApp';
      S.lifecycle.events.push({
        kind: quit ? 'quit' : 'down',
        at: iso(),
        byeSeen: !!lastBye,
        byeToCloseMs: lastBye && lastBye.tClose != null ? round(lastBye.tClose - lastBye.t) : null,
        note: quit ? 'still down 5 s after bye shutdownApp' : 'Lightroom unreachable for 5 s',
      });
      mark(`lifecycle ${quit ? 'quit' : 'down'}`);
      writeSummary();
    }, 5000);
  }
});

client.on('m:hello', (m, t) => {
  S.lastHello = m;
  if (!S.hello) S.hello = m;
  if (currentInst === null) {
    currentInst = m.inst ?? '(none)';
    tDown = null;
    return;
  }
  const inst = m.inst ?? '(none)';
  if (inst !== currentInst) {
    const downToHelloMs = tDown != null ? round(t - tDown) : null;
    let kind;
    if (lastBye && lastBye.why === 'shutdownApp') kind = 'relaunch';
    else if (lastBye && lastBye.why === 'shutdownPlugin') kind = 'reload';
    else kind = downToHelloMs != null && downToHelloMs > 10000 ? 'relaunch (no bye)' : 'reload (no bye)';
    S.lifecycle.events.push({
      kind,
      at: iso(),
      prevInst: currentInst,
      newInst: inst,
      gen: m.gen ?? null,
      byeSeen: !!lastBye,
      byeWhy: lastBye ? lastBye.why : null,
      byeToCloseMs: lastBye && lastBye.tClose != null ? round(lastBye.tClose - lastBye.t) : null,
      downToHelloMs,
      writable: m.writable,
    });
    currentInst = inst;
    lastBye = null;
    tDown = null;
    clearTimeout(downTimer);
    log('life', `${kind}: new inst ${inst}, down→hello ${downToHelloMs ?? '?'} ms`);
    mark(`lifecycle ${kind.split(' ')[0]}`);
    if (S.s3.followUpPending) enqueue('s3-followup', () => runS3FollowUp(kind));
    writeSummary();
  } else if (tDown != null) {
    S.lifecycle.events.push({ kind: 'reconnect-same-inst', at: iso(), downToHelloMs: round(t - tDown), gen: m.gen ?? null });
    cap(S.lifecycle.events, 200);
    log('life', `reconnected to the same instance after ${round(t - tDown)} ms (gen ${m.gen ?? '?'})`);
    tDown = null;
    clearTimeout(downTimer);
  }
});

// ---------- job queue (phases run one at a time) ----------

const queue = [];
let running = null;
const lastTrigger = new Map();

function enqueue(name, fn) {
  queue.push({ name, fn });
  pump();
}

async function pump() {
  if (running) return;
  while (queue.length) {
    const job = queue.shift();
    running = job.name;
    try {
      await job.fn();
    } catch (e) {
      recordError(job.name, e);
    }
    running = null;
    writeSummary();
  }
}

function onTrigger(name) {
  const t = Date.now();
  if (name !== 'tests' && name !== 'autosync') {
    log('trigger', `unknown trigger "${name}"`);
    return;
  }
  if (t - (lastTrigger.get(name) ?? 0) < 3000) {
    log('trigger', `${name}: duplicate within 3 s, ignored`);
    return;
  }
  if (running === name || queue.some((j) => j.name === name)) {
    log('trigger', `${name}: already ${running === name ? 'running' : 'queued'}, ignored`);
    return;
  }
  lastTrigger.set(name, t);
  log('trigger', `${name}${running ? ` (queued behind ${running})` : ''}`);
  enqueue(name, name === 'tests' ? runTests : runAutoSync);
}

// ---------- S1 ----------

async function s1Cycle(n, kind) {
  const sides = kind === 'both' ? ['cmd', 'evt'] : [kind];
  const res = { n, kind, ok: false };
  const tDrop = now();
  client.drop(sides, 300);
  const tReconnect = tDrop + 300;
  const deadline = tReconnect + 5000;
  const left = () => Math.max(1, deadline - now());
  if (!(await client.waitSides(sides, left()))) {
    res.note = 'socket did not reconnect within 5 s';
    return res;
  }
  res.connectMs = round(Math.max(...sides.map((s) => client.sides[s].connectedAt)) - tReconnect);
  if (sides.includes('evt')) {
    // The protocol says hello comes on evt connect. If it doesn't within 1 s, ask for it, and note that.
    let h = await client.waitHelloAfter(tDrop, Math.min(1000, left()));
    if (!h) {
      client.send({ t: 'hello', v: 0, client: 'spike-harness' });
      h = await client.waitHelloAfter(tDrop, left());
      if (h) res.note = 'hello only after a hello command';
    }
    if (!h) {
      res.note = 'no hello within 5 s';
      return res;
    }
    res.helloMs = round(h.t - tReconnect);
    res.gen = h.msg.gen ?? null;
  }
  const p = await client.request({ t: 'ping' }, left());
  if (!p.ok) {
    res.note = `ping ${p.error}`;
    return res;
  }
  if (p.reply.t !== 'pong') {
    res.note = `ping got ${p.reply.t}`;
    return res;
  }
  res.pingMs = round(p.rttMs);
  res.totalMs = round(now() - tReconnect);
  res.ok = res.totalMs <= 5000;
  if (!res.ok) res.note = 'over 5 s';
  return res;
}

async function runS1() {
  S.status.s1 = 'running';
  log('S1', 'start: 10 full drops, then 3 cmd-only and 3 evt-only');
  const plan = [...Array(10).fill('both'), 'cmd', 'cmd', 'cmd', 'evt', 'evt', 'evt'];
  let aborted = false;
  for (let i = 0; i < plan.length; i += 1) {
    let r = await s1Cycle(i + 1, plan[i]);
    if (!r.ok) {
      log('S1', `cycle ${i + 1} (${plan[i]}) failed: ${r.note}; waiting for recovery, then retrying once`);
      const first = r;
      if (!(await client.waitUp(10000))) {
        S.s1.cycles.push(first);
        S.s1.note = `aborted after cycle ${i + 1}: no recovery within 10 s`;
        aborted = true;
        break;
      }
      await sleep(500);
      r = await s1Cycle(i + 1, plan[i]);
      r.retried = true;
      r.note = [r.note, `first try: ${first.note}`].filter(Boolean).join('; ');
    }
    S.s1.cycles.push(r);
    log('S1', `cycle ${i + 1}/${plan.length} ${plan[i]} ${r.ok ? 'ok' : 'FAIL'} connect=${r.connectMs ?? '-'}ms${r.helloMs != null ? ` hello=${r.helloMs}ms` : ''} ping=${r.pingMs ?? '-'}ms${r.note ? ` (${r.note})` : ''}`);
    writeSummary();
    await sleep(200);
  }
  const all = S.s1.cycles;
  S.s1.pass = !aborted && all.length === plan.length && all.every((c) => c.ok);
  const okCount = all.filter((c) => c.ok).length;
  const retried = all.filter((c) => c.retried).length;
  S.status.s1 = `${S.s1.pass ? 'pass' : 'FAIL'}: ${okCount}/${plan.length} cycles ok${retried ? `, ${retried} after a retry` : ''}`;
  log('S1', S.status.s1);
  await client.waitUp(10000);
}

// ---------- S3 ----------

function s3Step(step, fields) {
  S.s3.steps.push({ step, at: iso(), ...fields });
  log('S3', `${step}: ${fields.ok === false ? 'FAIL ' : ''}${fields.v != null ? `v=${fields.v} ` : ''}${fields.verdict ?? ''}`);
  writeSummary();
}

async function runS3() {
  S.status.s3 = 'running';
  S.s3.file = svGuard.file;
  const r1 = await probe('requireVersion');
  const v1 = vOf(r1);
  s3Step('1 require', { ok: r1.ok, v: v1, verdict: r1.ok ? 'module loads through require' : r1.msg, detail: r1.data ?? r1.msg });

  let original;
  try {
    original = fs.readFileSync(svGuard.file, 'utf8');
  } catch (e) {
    s3Step('2 rewrite', { ok: false, verdict: `cannot read ${svGuard.file}: ${e.message}` });
    S.status.s3 = 'FAIL: SpikeVersion.lua not readable';
    return;
  }
  const m = original.match(SV_LINE);
  if (!m) {
    s3Step('2 rewrite', { ok: false, verdict: "no `local V = '…'` line in SpikeVersion.lua" });
    S.status.s3 = 'FAIL: unexpected SpikeVersion.lua shape';
    return;
  }
  if (/^v2-/.test(m[3])) {
    original = original.replace(SV_LINE, `$1$2v1$2`);
    log('S3', `SpikeVersion.lua was left at ${m[3]} by an earlier run; treating 'v1' as the original`);
  }
  svGuard.original = original;
  S.s3.backup = path.join(cfg.out, 'SpikeVersion.lua.orig');
  try { fs.writeFileSync(S.s3.backup, original); } catch { /* the backup is a convenience */ }

  const newV = `v2-${stamp().replace('-', '')}`;
  try {
    svGuard.modified = true;
    fs.writeFileSync(svGuard.file, original.replace(SV_LINE, `$1$2${newV}$2`));
    S.s3.rewrittenTo = newV;
    S.s3.fileRestored = false;
    S.s3.restoreNote = 'modified, waiting for Reload Plug-in';
  } catch (e) {
    svGuard.modified = false;
    s3Step('2 rewrite', { ok: false, verdict: `cannot write: ${e.message}` });
    S.status.s3 = 'FAIL: SpikeVersion.lua not writable';
    return;
  }
  s3Step('2 rewrite', { ok: true, v: newV, verdict: 'file on disk now says v2' });
  await sleep(500);

  const r2 = await probe('requireVersion');
  const v2 = vOf(r2);
  s3Step('3 require again', {
    ok: r2.ok, v: v2,
    verdict: !r2.ok ? r2.msg : v2 === newV ? 'require re-read the file (no cache)' : v2 === v1 ? 'require cached the old module' : 'unexpected value',
    detail: r2.data ?? r2.msg,
  });

  const r3 = normalizeReply('reload', await client.request({ t: 'reload' }, 15000));
  const v3 = vOf(r3);
  s3Step('4 reload command', {
    ok: r3.ok && v3 === newV, v: v3,
    verdict: !r3.ok ? r3.msg : v3 === newV ? 'reload sees the edit (hot reload works)' : 'reload did not see the edit',
    detail: r3.data ?? r3.msg,
  });

  const r4 = await probe('requireVersion');
  const v4 = vOf(r4);
  s3Step('5 require after reload', {
    ok: r4.ok, v: v4,
    verdict: !r4.ok ? r4.msg : v4 === newV ? 'require now returns the edit' : v4 === v1 ? 'require cache untouched by reload' : 'unexpected value',
    detail: r4.data ?? r4.msg,
  });

  S.s3.followUpPending = true;
  S.s3.pendingV = newV;
  S.s3.firstV = v1;
  S.status.s3 = `require ${v2 === v1 ? 'caches' : v2 === newV ? 'does not cache' : '?'}; reload command ${v3 === newV ? 'works' : 'FAILED'}; waiting for Reload Plug-in`;
  writeSummary();
}

async function runS3FollowUp(kind) {
  if (!S.s3.followUpPending) return;
  S.s3.followUpPending = false;
  await client.waitUp(20000);
  await sleep(500);
  const r = await probe('requireVersion');
  const v = vOf(r);
  const cleared = v === S.s3.pendingV;
  s3Step(`6 require after ${kind}`, {
    ok: r.ok && cleared, v,
    verdict: !r.ok ? r.msg : cleared ? `${kind} cleared the require cache` : `${kind} did not pick up the edit`,
    detail: r.data ?? r.msg,
  });
  restoreSpikeVersion(`after ${kind}`);
  const head = S.status.s3.replace(/; waiting for Reload Plug-in$/, '');
  S.status.s3 = `${head}; ${kind} ${cleared ? 'clears' : 'does NOT clear'} the cache`;
  mark('s3-followup');
}

// ---------- S5 + S2 + Before/After (trigger "tests") ----------

const PROBES = [
  ['features', 15000],
  ['timing', 30000],
  ['presets', 30000],
  ['ranges', 15000],
  ['observerPhotoChange', 30000],
  ['flagAdvance', 15000],
  ['mask', 60000],
];

async function runTests() {
  const run = { startedAt: iso(), endedAt: null, probes: [] };
  S.s5.runs.push(run);
  S.status.s5 = 'running';
  bezel('Deck spike: tests running, hands off for about 2 minutes', 4);
  await sleep(cfg.quick ? 300 : 2000);

  for (const [name, timeout] of PROBES) {
    if (!(await client.waitUp(15000))) {
      run.probes.push({ name, at: iso(), ok: false, msg: 'not connected' });
      continue;
    }
    bezel(`Deck spike: probe ${name}`, 1.5);
    const rec = await probe(name, undefined, timeout);
    run.probes.push(rec);
    log('S5', `${name} ${rec.ok ? 'ok' : 'FAIL'} ${rec.ms ?? '-'}ms${rec.ok ? '' : ` (${rec.msg})`}`);
    writeSummary();
    await sleep(cfg.quick ? 50 : 400);
  }
  const okCount = run.probes.filter((p) => p.ok).length;
  S.status.s5 = `${okCount}/${run.probes.length} probes ok (run ${S.s5.runs.length})`;
  writeSummary();

  try {
    await runS2(run);
  } catch (e) {
    recordError('S2', e);
    S.status.s2 = 'FAIL: harness error (see Errors)';
  }
  try {
    await runBeforeAfter();
  } catch (e) {
    recordError('beforeAfter', e);
  }
  run.endedAt = iso();
  bezel('Deck spike: tests done', 4);
  mark('tests-done');
}

function normalizePhoto(rec) {
  const d = (rec && rec.data) || {};
  const dims = d.dimensions && typeof d.dimensions === 'object' ? d.dimensions : {};
  return {
    ok: rec.ok, msg: rec.msg,
    file: d.file ?? d.fileName ?? d.name ?? null,
    format: d.format ?? d.fileFormat ?? null,
    fileSize: d.fileSize ?? d.size ?? null,
    width: d.width ?? dims.width ?? null,
    height: d.height ?? dims.height ?? null,
  };
}

let seqCounter = 0;

async function runBurst({ index, hz, track, base, dir, burstMs, gapMs }) {
  const period = 1000 / hz;
  const sets = [];
  const bySeq = new Map();
  const valsMsgs = [];
  const errs = [];
  let unmatchedVals = 0, dupVals = 0, lateVals = 0, sendFailures = 0, skipped = 0, maxBuffered = 0;
  let tLastAck = null, tLastVals = null;
  let lastAckIdx = -1;   // highest index Lightroom has acked: it can't have echoed anything later than idx + 1
  let lastMatchIdx = -1; // echoes arrive in send order, so the next match is after this one

  const onAck = (m, t) => {
    const s = bySeq.get(m.seq);
    if (!s || s.tAck != null) return;
    s.tAck = t;
    if (typeof m.v === 'number') s.ackV = m.v;
    if (typeof m.ms === 'number') s.lrMs = m.ms;
    if (m.cy !== undefined) s.cy = m.cy;
    lastAckIdx = Math.max(lastAckIdx, s.idx);
    tLastAck = t;
  };
  const near = (s, x) => Math.abs((s.ackV ?? s.v) - x) <= 0.005;
  const onVals = (m, t) => {
    const x = m.vals && typeof m.vals.Exposure === 'number' ? m.vals.Exposure : null;
    if (x == null) return;
    valsMsgs.push(t);
    tLastVals = t;
    // Candidates: sent in the last 2 s, after the previous match, and no later than one past the last ack
    // (the observer may fire inside setValue, before that set's own ack). Most recent first, so a
    // coalesced echo is credited to the newest set it reflects.
    const hi = lastAckIdx >= 0 ? Math.min(sets.length - 1, lastAckIdx + 1) : sets.length - 1;
    let match = null;
    for (let i = hi; i > lastMatchIdx; i -= 1) {
      const s = sets[i];
      if (s.tSent > t) continue;
      if (t - s.tSent > 2000) break;
      if (near(s, x)) { match = s; break; }
    }
    if (!match) {
      // Not a new echo. Classify it: a repeat of the last match, an older set, or nothing we sent.
      const old = sets.slice(Math.max(0, lastMatchIdx - 120), lastMatchIdx + 1).reverse().find((s) => near(s, x) && t - s.tSent <= 2000);
      if (old && old.idx === lastMatchIdx) dupVals += 1;
      else if (old) lateVals += 1;
      else unmatchedVals += 1;
      return;
    }
    match.matched = true;
    match.echoMs = t - match.tSent;
    for (let i = lastMatchIdx + 1; i < match.idx; i += 1) sets[i].superseded = true;
    lastMatchIdx = match.idx;
  };
  const onErr = (m, t) => { errs.push({ t, msg: m.msg, cmd: m.cmd }); };
  client.on('m:ack', onAck);
  client.on('m:vals', onVals);
  client.on('m:err', onErr);

  const t0 = now();
  let k = 0;
  try {
    for (;;) {
      let target = t0 + k * period;
      if (target - t0 >= burstMs) break;
      const wait = target - now();
      if (wait > 0) await sleep(wait);
      const tNow = now();
      // Never bunch: if we're behind, skip to the latest due slot and send once.
      const kDue = Math.floor((tNow - t0) / period);
      if (kDue > k) {
        skipped += kDue - k;
        k = kDue;
        target = t0 + k * period;
        if (target - t0 >= burstMs) break;
      }
      const v = Math.max(-5, Math.min(5, round2(base + dir * triangle((target - t0) / 2500))));
      const seq = ++seqCounter;
      const msg = { t: 'set', p: 'Exposure', v, seq };
      if (!track) msg.track = false;
      const tSent = client.send(msg);
      if (tSent == null) {
        sendFailures += 1;
      } else {
        const s = { idx: sets.length, seq, v, tSent, target, drift: tSent - target };
        sets.push(s);
        bySeq.set(seq, s);
        maxBuffered = Math.max(maxBuffered, client.cmdBuffered());
      }
      k += 1;
    }
    if (track) client.send({ t: 'done' });
    await sleep(gapMs);
  } finally {
    client.off('m:ack', onAck);
    client.off('m:vals', onVals);
    client.off('m:err', onErr);
  }

  for (const s of sets) {
    samples.write(JSON.stringify({
      run: S.s2.runs.length, burst: index, hz, track, seq: s.seq, v: s.v,
      tSent: round(s.tSent - t0, 2), drift: round(s.drift, 2),
      ack: s.tAck != null ? round(s.tAck - s.tSent, 2) : null, ackV: s.ackV ?? null, lrMs: s.lrMs ?? null,
      echo: s.matched ? round(s.echoMs, 2) : null, superseded: !!s.superseded,
    }) + '\n');
  }

  const sent = sets.length;
  const tLastSend = sent ? sets[sent - 1].tSent : null;
  const span = sent > 1 ? sets[sent - 1].tSent - sets[0].tSent : 0;
  const win = Math.min(1000, burstMs / 3);
  const firstWin = sets.filter((s) => s.target - t0 < win);
  const lastWin = sets.filter((s) => s.target - t0 >= burstMs - win);
  const ackOf = (list) => list.filter((s) => s.tAck != null).map((s) => s.tAck - s.tSent);
  const echoOf = (list) => list.filter((s) => s.matched).map((s) => s.echoMs);
  const ackLat = ackOf(sets);
  const backlog = {
    windowMs: round(win, 0),
    ackFirst: round(median(ackOf(firstWin))), ackLast: round(median(ackOf(lastWin))),
    echoFirst: round(median(echoOf(firstWin))), echoLast: round(median(echoOf(lastWin))),
  };
  backlog.ackGrowth = backlog.ackFirst != null && backlog.ackLast != null ? round(backlog.ackLast - backlog.ackFirst) : null;
  backlog.echoGrowth = backlog.echoFirst != null && backlog.echoLast != null ? round(backlog.echoLast - backlog.echoFirst) : null;
  const cySeen = [...new Set(sets.filter((s) => s.cy !== undefined).map((s) => String(s.cy)))];

  return {
    hz, track, burstMs,
    sent,
    actualHz: sent > 1 ? round((sent - 1) / (span / 1000)) : 0,
    skipped, sendFailures, maxBuffered,
    drift: stats(sets.map((s) => s.drift)),
    ack: stats(ackLat),
    missingAcks: sent - ackLat.length,
    lr: stats(sets.filter((s) => typeof s.lrMs === 'number').map((s) => s.lrMs)),
    echo: stats(echoOf(sets)),
    vals: valsMsgs.length,
    unmatchedVals, dupVals, lateVals,
    superseded: sets.filter((s) => s.superseded).length,
    backlog,
    drain: {
      ackMs: tLastAck != null && tLastSend != null ? round(tLastAck - tLastSend) : null,
      valsMs: tLastVals != null && tLastSend != null ? round(tLastVals - tLastSend) : null,
    },
    cySeen,
    errs: errs.length,
    errSamples: errs.slice(0, 3).map((e) => ({ msg: e.msg, cmd: e.cmd })),
  };
}

async function runS2(s5run) {
  const run = { startedAt: iso(), endedAt: null, photo: null, base: null, bursts: [], restored: false, note: null };
  S.s2.runs.push(run);
  S.status.s2 = 'running';
  if (!(await client.waitUp(15000))) {
    run.note = 'not connected';
    S.status.s2 = 'FAIL: not connected';
    return;
  }
  bezel('Deck spike: selecting the largest raw', 2);
  const sel = normalizeReply('select', await client.request({ t: 'select', what: 'largestRaw' }, 30000));
  run.photo = normalizePhoto(sel);
  s5run.probes.push({ ...sel, name: 'select largestRaw' });
  log('S2', `select largestRaw ${sel.ok ? 'ok' : 'FAIL'}: ${run.photo.file ?? sel.msg}`);
  await sleep(cfg.quick ? 200 : 1500);

  const rr = await probe('ranges', undefined, 15000);
  s5run.probes.push({ ...rr, name: 'ranges (largest raw)' });
  writeSummary();

  client.send({ t: 'watch', ps: ['Exposure'] });
  client.send({ t: 'config', pushHz: 0 });
  await sleep(500);
  const g = normalizeReply('get', await client.request({ t: 'get', p: 'Exposure' }, 10000));
  let base = null;
  if (g.ok && g.data && typeof g.data.v === 'number') base = g.data.v;
  if (base == null) {
    run.note = `could not read Exposure (${g.msg ?? 'no value'}); sweeping around 0`;
    base = 0;
  }
  run.base = round(base, 3);
  const dir = base > 3.5 ? -1 : 1;
  const burstMs = cfg.quick ? 1000 : 5000;
  const gapMs = cfg.quick ? 600 : 3000;
  const plan = [[15, true], [15, false], [30, true], [30, false], [60, true], [60, false]];
  for (let i = 0; i < plan.length; i += 1) {
    const [hz, track] = plan[i];
    if (!(await client.waitUp(15000))) {
      run.bursts.push({ hz, track, burstMs, sent: 0, note: 'not connected', drift: {}, ack: {}, echo: {}, lr: {}, backlog: {}, drain: {}, vals: 0 });
      continue;
    }
    bezel(`Deck spike: Exposure at ${hz}/s, ${track ? 'tracked' : 'untracked'}`, 2);
    await sleep(cfg.quick ? 150 : 1200);
    const b = await runBurst({ index: i, hz, track, base, dir, burstMs, gapMs });
    run.bursts.push(b);
    log('S2', `${hz}/s ${track ? 'tracked' : 'untracked'}: sent ${b.sent} (${b.actualHz}/s, skipped ${b.skipped}), ack med ${b.ack.med} p95 ${b.ack.p95} ms, echo med ${b.echo.med} p95 ${b.echo.p95} ms (${b.echo.n} echoes/${b.vals} vals), backlog Δ ${b.backlog.echoGrowth ?? '-'} ms, errs ${b.errs}`);
    writeSummary();
  }
  const seq = ++seqCounter;
  client.send({ t: 'set', p: 'Exposure', v: base, seq });
  await sleep(300);
  client.send({ t: 'done' });
  run.restored = true;
  run.endedAt = iso();
  const acked = run.bursts.filter((b) => b.ack && b.ack.n);
  const echoMed = (hz, track) => {
    const b = run.bursts.find((x) => x.hz === hz && x.track === track);
    return b && b.echo && b.echo.med != null ? b.echo.med : '-';
  };
  S.status.s2 = acked.length === plan.length
    ? `done. Echo median ms, tracked / untracked: ${[15, 30, 60].map((hz) => `${hz}/s ${echoMed(hz, true)} / ${echoMed(hz, false)}`).join(', ')}`
    : `partial: ${acked.length}/${plan.length} bursts got acks`;
  writeSummary();
}

async function runBeforeAfter() {
  if (!(await client.waitUp(15000))) {
    S.beforeAfter.push({ name: 'beforeAfter', at: iso(), ok: false, msg: 'not connected' });
    S.status.beforeAfter = 'FAIL: not connected';
    return;
  }
  bezel('Deck spike: Before view for 3 s', 2);
  await sleep(cfg.quick ? 150 : 1500);
  const rec = await probe('beforeAfter', { secs: cfg.quick ? 0.5 : 3 }, 20000);
  S.beforeAfter.push(rec);
  S.status.beforeAfter = rec.ok ? 'ok on the wire; the user confirms what they saw' : `FAIL: ${rec.msg}`;
  log('BA', `beforeAfter ${rec.ok ? 'ok' : 'FAIL'}${rec.ok ? '' : ` (${rec.msg})`}`);
  writeSummary();
}

// ---------- Auto Sync (trigger "autosync") ----------

function describeAutoSync(rec) {
  if (!rec.ok) return `Auto Sync test failed: ${rec.msg ?? 'unknown error'}`;
  const d = rec.data && typeof rec.data === 'object' ? rec.data : {};
  const list = Array.isArray(d.photos) ? d.photos : Array.isArray(d.others) ? d.others : null;
  let changed = null;
  let total = null;
  if (list) {
    const others = list.filter((p) => !(p && (p.active === true || p.isActive === true)));
    total = others.length;
    changed = others.filter((p) => p && p.changed === true).length;
  } else if (typeof d.changedCount === 'number') {
    changed = d.changedCount;
    total = typeof d.otherCount === 'number' ? d.otherCount : typeof d.total === 'number' ? d.total : null;
  } else if (Array.isArray(d.changed)) {
    changed = d.changed.length;
    total = typeof d.otherCount === 'number' ? d.otherCount : null;
  } else if (typeof d.changed === 'number') {
    changed = d.changed;
  } else if (typeof d.changed === 'boolean' || typeof d.propagated === 'boolean') {
    return (d.changed ?? d.propagated) ? 'Auto Sync carried the edit to the other photos' : 'Auto Sync did not carry the edit';
  }
  if (changed == null) return 'Auto Sync test done (see summary)';
  return total != null ? `Auto Sync: ${changed} of ${total} other photos changed` : `Auto Sync: ${changed} other photos changed`;
}

async function runAutoSync() {
  if (!(await client.waitUp(15000))) {
    S.autosync.push({ name: 'autoSync', at: iso(), ok: false, msg: 'not connected', text: 'not connected' });
    return;
  }
  S.status.autosync = 'running';
  bezel('Deck spike: Auto Sync test running', 2);
  const rec = await probe('autoSync', undefined, 30000);
  rec.text = describeAutoSync(rec);
  S.autosync.push(rec);
  S.status.autosync = rec.text;
  bezel(`Deck spike: ${rec.text}`, 5);
  log('autosync', rec.text);
  writeSummary();
  mark('autosync-done');
}

// ---------- startup ----------

async function startup() {
  log('wait', `waiting for Lightroom on 127.0.0.1:${cfg.cmdPort} (cmd) and :${cfg.evtPort} (evt), retrying quietly`);
  const still = setInterval(() => { if (!client.isUp()) log('wait', 'still waiting for Lightroom'); }, 5 * 60000);
  await client.waitUp(Infinity);
  clearInterval(still);
  S.firstConnectAt = iso();
  const h = await client.waitHelloAfter(-Infinity, 10000);
  if (!h) {
    recordError('startup', 'connected, but no hello arrived within 10 s');
  } else {
    const m = h.msg;
    log('LR', `hello lr=${m.lr} catalog=${m.catalog} guard=${m.guard} writable=${m.writable} inst=${m.inst} gen=${m.gen}`);
    log('LR', `catalog path ${m.path}`);
    if (m.path && m.path !== TEST_CATALOG) log('GUARD', `!!! Lightroom's catalog is not the test catalog (${TEST_CATALOG})`);
    if (m.writable === false) log('GUARD', '!!! Lightroom says writes are refused right now');
  }
  writeSummary();
  bezel('Deck spike: connected. Socket and reload checks, about 30 s.', 3);
  await sleep(300);
  try {
    await runS1();
  } catch (e) {
    recordError('S1', e);
    S.status.s1 = 'FAIL: harness error (see Errors)';
  }
  try {
    await runS3();
  } catch (e) {
    recordError('S3', e);
    S.status.s3 = 'FAIL: harness error (see Errors)';
  }
  writeSummary();
  bezel('Deck spike: ready. Run the tests from File ▸ Plug-in Extras.', 5);
  mark('ready');
}

// ---------- shutdown ----------

let shuttingDown = false;
function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('end', `stopping (${why})`);
  restoreSpikeVersion(why);
  S.meta.endedAt = iso();
  S.meta.endReason = why;
  writeSummary();
  client.stop();
  let pending = 2;
  const done = () => { pending -= 1; if (pending === 0) process.exit(0); };
  events.end(done);
  samples.end(done);
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('exit', () => {
  if (svGuard.modified && svGuard.original != null) {
    try { fs.writeFileSync(svGuard.file, svGuard.original); } catch { /* last resort */ }
  }
});
process.on('uncaughtException', (e) => {
  recordError('uncaught', e);
  writeSummary();
});
process.on('unhandledRejection', (e) => {
  recordError('unhandledRejection', e);
  writeSummary();
});

setTimeout(() => shutdown(`max-minutes ${cfg.maxMinutes}`), Math.min(cfg.maxMinutes * 60000, 2 ** 31 - 1));

log('start', `out: ${cfg.out}`);
log('start', `plugin dir: ${cfg.pluginDir}${cfg.quick ? ' (quick mode)' : ''}`);
writeSummary();
client.start();
enqueue('startup', startup);
