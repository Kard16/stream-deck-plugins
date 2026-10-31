#!/usr/bin/env node
// The S2 latency harness (spikes/lr-harness/harness.mjs, runBurst) ported to protocol v1: each burst is
// one gesture g, with set {p, v, g} at a fixed rate, acks matched to sets in order, and done at the end.
// It reports, per rate: median, p95 and max ack latency; ok latency (LrSocket's "ok"); send drift;
// backlog (ack latency in the first window against the last); drain (last set to last ack, and done
// to the observer's vals); vals that leaked the tracked param during the burst; and errors.
// It reads the param's value first and puts it back at the end.
// It writes only with the test catalog open and exactly one photo selected, whatever Lightroom's guard
// says (with Auto Sync on, every set reaches all the selected photos), and stops writing if a hello from
// another plugin instance or catalog arrives mid-run. Against the real Lightroom, rates go up to 60.
// It writes only to the photo it started on. A state naming another photo, or a set refused as stale,
// stops the bursts at once. Before each burst, and before putting the value back, it asks for a fresh
// state (hello), because Lightroom puts a new gesture on whatever photo is the target. When Lightroom is on
// another photo by then, it skips the restore, says so, and the run fails.
//
//   mise exec -- node lightroom/tools/latency/latency.mjs --mock [--mock-set-ms N] [--rates 15,30,60] [--burst-ms 5000]
//   mise exec -- node lightroom/tools/latency/latency.mjs --ports 58780,58781 ...   (the real Lightroom, later)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LrClient, now, sleep } from '../lib/client.mjs';
import { median, round, round2, stats, triangle } from '../lib/stats.mjs';
import { CMD_PORT, EVT_PORT, TEST_CATALOG, parsePorts, sameCatalog } from '../lib/params.mjs';

// Spike S2 measured Lightroom at up to 60 sets a second (docs/lightroom/plan.md, spike run 2), and the
// deck sends at most 30 a second per param (PROTOCOL.md, Rates). Faster rates are for the mock only.
export const MAX_LIVE_RATE = 60;

export class LatencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LatencyError';
  }
}

const roundFor = (param, v) => (param === 'Exposure' ? round2(v) : Math.round(v)); // the deck rounds like this

async function expectMsg(client, pred, timeoutMs, what) {
  const r = await client.waitFor(pred, timeoutMs, now());
  if (!r) throw new LatencyError(`no ${what} within ${timeoutMs} ms`);
  return r.msg;
}

// One burst: one gesture g on `param`, sets at `hz` for `burstMs`, then done. writeCheck() says
// whether a set may go out now ({ ok }), or that writing must stop ({ stop }). onSet() runs for every set sent.
async function runBurst(client, { hz, g, param, base, amplitude, dir, lo, hi, burstMs, gapMs, writeCheck, onSet = () => {} }) {
  const period = 1000 / hz;
  const sets = [];
  const awaiting = []; // sets not yet acked, in send order
  const errs = [];
  let valsDuring = 0;
  let tLastAck = null;
  let skipped = 0;
  let sendFailures = 0;
  let maxBuffered = 0;
  let tDone = null;
  let tVals = null;

  const onAck = (m, t) => {
    if (m.p !== param || m.g !== g) return;
    const s = awaiting.shift();
    if (!s) return;
    s.tAck = t;
    s.ackV = m.v;
    tLastAck = t;
  };
  const onErr = (m, t) => {
    if (m.cmd !== 'set') return;
    errs.push({ t, code: m.code, msg: m.msg });
    const s = awaiting.shift();
    if (s) s.err = m.code;
  };
  const onVals = (m, t) => {
    if (!m.vals || !Object.prototype.hasOwnProperty.call(m.vals, param)) return;
    // Lightroom must leave the tracked param out while the gesture runs. Its events arrive in order, so vals
    // before the gesture's first ack went out before the gesture began, like the fresh greeting's push.
    if (tDone == null) {
      if (tLastAck != null) valsDuring += 1;
    } else if (tVals == null) {
      tVals = t;
    }
  };
  const onOk = ({ t, sent }) => {
    if (sent && sent.burst === g && sent.set) sent.set.tOk = t;
  };
  client.on('m:ack', onAck);
  client.on('m:err', onErr);
  client.on('m:vals', onVals);
  client.on('ok', onOk);

  const t0 = now();
  try {
    for (let k = 0; ;) {
      let target = t0 + k * period;
      if (target - t0 >= burstMs) break;
      const wait = target - now();
      if (wait > 0) await sleep(wait);
      // Never bunch: if we're late, skip to the latest due slot and send once.
      const kDue = Math.floor((now() - t0) / period);
      if (kDue > k) {
        skipped += kDue - k;
        k = kDue;
        target = t0 + k * period;
        if (target - t0 >= burstMs) break;
      }
      const raw = base + dir * amplitude * triangle((target - t0) / Math.max(burstMs, 1000));
      const v = Math.min(hi, Math.max(lo, roundFor(param, raw)));
      const s = { idx: sets.length, v, target, tSent: null, tOk: null, tAck: null, ackV: null, err: null };
      const w = writeCheck();
      if (w.stop) throw new LatencyError(w.stop);
      const rec = w.ok ? client.send({ t: 'set', p: param, v, g }, { burst: g, set: s }) : null;
      if (rec == null) {
        sendFailures += 1;
      } else {
        onSet();
        s.tSent = rec.t;
        sets.push(s);
        awaiting.push(s);
        maxBuffered = Math.max(maxBuffered, client.cmdBuffered());
      }
      k += 1;
    }
    const doneRec = client.send({ t: 'done', g });
    tDone = doneRec ? doneRec.t : now();
    // Let a backlog drain: every ack (up to 10 s), then the observer's vals (up to gapMs), then the
    // rest of the gap, so bursts never overlap.
    const ackDeadline = now() + 10000;
    while (awaiting.length > 0 && client.isUp() && now() < ackDeadline) await sleep(5);
    const valsDeadline = now() + Math.max(gapMs, 300);
    while (tVals == null && client.isUp() && now() < valsDeadline) await sleep(5);
    const rest = tDone + gapMs - now();
    if (rest > 0) await sleep(rest);
  } finally {
    client.off('m:ack', onAck);
    client.off('m:err', onErr);
    client.off('m:vals', onVals);
    client.off('ok', onOk);
  }

  const sent = sets.length;
  const tLastSent = sent ? sets[sent - 1].tSent : null;
  const span = sent > 1 ? sets[sent - 1].tSent - sets[0].tSent : 0;
  const acked = sets.filter((s) => s.tAck != null);
  const ackLat = acked.map((s) => s.tAck - s.tSent);
  const win = Math.min(1000, burstMs / 3);
  const firstWin = acked.filter((s) => s.target - t0 < win).map((s) => s.tAck - s.tSent);
  const lastWin = acked.filter((s) => s.target - t0 >= burstMs - win).map((s) => s.tAck - s.tSent);
  const ackFirst = median(firstWin);
  const ackLast = median(lastWin);
  const growth = ackFirst != null && ackLast != null ? ackLast - ackFirst : null;
  return {
    hz,
    g,
    burstMs,
    sent,
    actualHz: sent > 1 ? round((sent - 1) / (span / 1000)) : 0,
    skipped,
    sendFailures,
    ack: stats(ackLat),
    missingAcks: sent - acked.length - sets.filter((s) => s.err).length,
    ackMismatches: acked.filter((s) => typeof s.ackV !== 'number' || Math.abs(s.ackV - s.v) > 1e-6).length,
    ok: stats(sets.filter((s) => s.tOk != null).map((s) => s.tOk - s.tSent)),
    drift: stats(sets.map((s) => s.tSent - s.target)),
    backlog: {
      windowMs: round(win, 0),
      ackFirst: round(ackFirst),
      ackLast: round(ackLast),
      growth: round(growth),
      growing: growth != null && growth > Math.max(5, ackFirst ?? 0),
      maxBuffered,
    },
    drain: {
      ackMs: tLastAck != null && tLastSent != null ? round(tLastAck - tLastSent) : null,
      doneToValsMs: tVals != null ? round(tVals - tDone) : null,
    },
    valsDuring,
    errs: errs.length,
    errCodes: [...new Set(errs.map((e) => e.code))],
  };
}

// Connects, checks writes go through, reads the param, runs one burst per rate, puts the value back.
export async function runLatency({
  cmdPort = CMD_PORT, evtPort = EVT_PORT, host = '127.0.0.1',
  rates = [15, 30, 60], burstMs = 5000, gapMs = 1500, param = 'Exposure', amplitude,
  connectTimeoutMs = 10000, log = () => {},
} = {}) {
  // Bad numbers would make a burst that never ends, streaming sets with no valid value.
  if (!Array.isArray(rates) || rates.length === 0 || rates.some((x) => !Number.isFinite(x) || x <= 0)) throw new LatencyError('rates must be sets per second, above 0');
  if (!Number.isFinite(burstMs) || burstMs <= 0) throw new LatencyError('burstMs must be a number of ms above 0');
  if (!Number.isFinite(gapMs) || gapMs < 0) throw new LatencyError('gapMs must be a number of ms, 0 or more');
  if (amplitude !== undefined && !(Number.isFinite(amplitude) && amplitude > 0)) throw new LatencyError('amplitude must be a number above 0');
  const client = new LrClient({ host, cmdPort, evtPort, autoHello: false, clientName: 'latency', firstId: 800000 });
  const report = {
    param, host, cmdPort, evtPort, rates, burstMs, gapMs, startedAt: new Date().toISOString(),
    base: null, range: null, photo: null, file: null, bursts: [], restored: false, restoreError: null,
  };
  let inst0 = null;
  let wrote = false; // a set went out, so there is a value to put back
  // The photo the run writes to (from the state before the first burst), and the latest state's photo.
  let photo0 = null;
  let photoNow = null;
  let fileNow = null;
  let staleErr = null; // the first set Lightroom refused as stale: the photo or module changed under its gesture
  client.on('m:state', (m) => {
    photoNow = m.photo;
    fileNow = m.file;
  });
  client.on('m:err', (m) => {
    if (m.cmd === 'set' && m.code === 'stale' && !staleErr) staleErr = m;
  });
  // Why the Lightroom on the other end isn't the plugin instance and catalog checked at the start, or null.
  const otherLightroom = () => {
    const h = client.lastHello;
    if (h && h.inst !== inst0) return `Lightroom reloaded or relaunched mid-run (inst ${inst0}, now ${h.inst}): stopped writing; check ${param} on the photo`;
    if (h && !sameCatalog(h.path, TEST_CATALOG)) return `Lightroom has ${h.path ?? h.catalog} open now, not the test catalog: stopped writing`;
    return null;
  };
  // A set may go out only to that Lightroom, after a reconnect only once its greeting has arrived, and only
  // while it is on the run's photo: a state naming another photo, or a set refused as stale, stops the writing.
  const writeCheck = () => {
    const why = otherLightroom();
    if (why) return { stop: why };
    if (photo0 != null && photoNow !== photo0) {
      return { stop: `Lightroom moved from ${photoName(photo0, report.file)} to ${photoName(photoNow, fileNow)} mid-run: stopped writing` };
    }
    if (staleErr) return { stop: 'Lightroom refused a set as stale, so the photo or module changed mid-run: stopped writing' };
    return { ok: client.greeted() };
  };
  // Lightroom's state now. hello makes it greet again, and the greeting's state reads the target photo
  // straight from the catalog, while the states it pushes come from its 200 ms poll. Null if none comes.
  const freshState = async () => {
    if (!(await client.waitUp(5000))) return null;
    return new Promise((resolve) => {
      let sawHello = false;
      const finish = (st) => {
        clearTimeout(timer);
        client.off('msg', onMsg);
        resolve(st);
      };
      const onMsg = (m) => {
        if (m.t === 'hello') sawHello = true;
        else if (sawHello && m.t === 'state') finish(m);
      };
      const timer = setTimeout(() => finish(null), 3000);
      client.on('msg', onMsg);
      if (!client.hello()) finish(null);
    });
  };
  // Waits up to 5 s until a set may go out, then checks a fresh state: each burst starts a new gesture,
  // and Lightroom puts a new gesture on whatever photo is the target.
  const ready = async () => {
    const end = now() + 5000;
    for (;;) {
      const w = writeCheck();
      if (w.stop) throw new LatencyError(w.stop);
      if (w.ok) break;
      if (now() >= end) throw new LatencyError('lost the connection');
      await sleep(20);
    }
    if (!(await freshState())) throw new LatencyError('Lightroom did not answer hello with its state');
    const w = writeCheck();
    if (w.stop) throw new LatencyError(w.stop);
  };
  // Puts the value back as one more gesture g, but only onto the photo the run started on, by a fresh
  // state; anywhere else it would land on another photo. Sets report.restored, or report.restoreError.
  const restore = async (g) => {
    let why = otherLightroom();
    if (!why) {
      const st = await freshState();
      why = otherLightroom();
      if (!why && !st) why = 'Lightroom did not say which photo it is on';
      else if (!why && st.photo !== photo0) why = `Lightroom is on ${photoName(st.photo, st.file)} now`;
    }
    if (why) {
      report.restoreError = `can't put back ${param} ${report.base} on ${photoName(photo0, report.file)}: ${why}`;
      log(report.restoreError);
      return;
    }
    const t = now();
    client.send({ t: 'set', p: param, v: report.base, g });
    const back = await client.waitFor((m) => m.t === 'ack' && m.p === param && m.g === g, 3000, t);
    client.send({ t: 'done', g });
    report.restored = !!back && typeof back.msg.v === 'number' && Math.abs(back.msg.v - report.base) <= 1e-6;
    await sleep(100);
  };
  try {
    client.start();
    const tStart = now();
    if (!(await client.waitUp(connectTimeoutMs))) throw new LatencyError(`couldn't connect to ${host}:${cmdPort}/${evtPort}: is Lightroom (or the mock) running?`);
    await client.waitFor('hello', 3000, tStart - 1);
    const sync = await client.request({ t: 'ping' }, 5000);
    if (!sync.ok) throw new LatencyError('Lightroom did not answer a ping: is a menu or the Plug-in Manager open?');

    client.hello();
    const hello = await expectMsg(client, 'hello', 3000, 'hello');
    report.lr = hello.lr;
    report.catalog = hello.catalog;
    if (hello.v !== 1) throw new LatencyError(`Lightroom speaks protocol v${hello.v}, not v1`);
    if (!hello.writable) throw new LatencyError(`writes are off: ${hello.catalog} isn't the test catalog`);
    // Not the guard alone: once the user turns it off, writable is true in every catalog.
    if (!sameCatalog(hello.path, TEST_CATALOG)) throw new LatencyError(`Lightroom has ${hello.path ?? hello.catalog} open, not the test catalog ${TEST_CATALOG}: the harness writes only there`);
    inst0 = hello.inst;

    client.send({ t: 'module', v: 'develop' });
    const st = await expectMsg(client, (m) => m.t === 'state' && m.module === 'develop', 6000, 'state in Develop');
    if (st.sel !== 1) throw new LatencyError(`${st.sel ?? 0} photos are selected: select exactly one. With Auto Sync on, Lightroom copies every set to all the selected photos`);
    photo0 = st.photo;
    report.photo = st.photo;
    report.file = st.file;
    const tWatch = now();
    client.send({ t: 'watch', ps: [param] });
    const ranges = await client.waitFor((m) => m.t === 'ranges' && m.ranges && Array.isArray(m.ranges[param]), 3000, tWatch);
    const vals = await client.waitFor((m) => m.t === 'vals' && m.vals && typeof m.vals[param] === 'number', 3000, tWatch);
    if (!ranges || !vals) throw new LatencyError(`no ranges and vals for ${param}: is a photo selected?`);
    const [lo, hi] = ranges.msg.ranges[param];
    const base = vals.msg.vals[param];
    report.base = base;
    report.range = [lo, hi];
    const amp = amplitude ?? (param === 'Exposure' ? 0.5 : (hi - lo) * 0.05);
    const dir = base > (lo + hi) / 2 ? -1 : 1;
    log(`${param} starts at ${base} (range ${lo}..${hi}); sweeping ${dir > 0 ? '+' : '-'}${amp}`);

    for (let i = 0; i < rates.length; i += 1) {
      const hz = rates[i];
      await ready();
      const b = await runBurst(client, { hz, g: i + 1, param, base, amplitude: amp, dir, lo, hi, burstMs, gapMs, writeCheck, onSet: () => { wrote = true; } });
      report.bursts.push(b);
      log(formatBurst(b));
    }

    // Put the value back as one more gesture.
    await restore(rates.length + 1);
  } catch (err) {
    // Best effort: put the value back before giving up, so the photo isn't left changed. Never into a
    // Lightroom that reloaded, relaunched or opened another catalog since the start, nor onto another photo.
    if (wrote && !report.restored && !report.restoreError) {
      await restore(999);
      if (report.restored) log(`${param} set back to ${report.base} after the error`);
    }
    err.report = report;
    throw err;
  } finally {
    client.stop();
    report.endedAt = new Date().toISOString();
  }
  return report;
}

// Whether a run should exit 1: acks missing or not carrying the value sent, errors, leaks (the tracked
// param in vals mid-gesture, which v1 forbids), or the value not put back.
export const reportFailed = (r) => r.bursts.some((b) => b.missingAcks > 0 || b.errs > 0 || b.valsDuring > 0 || b.ackMismatches > 0) || !r.restored;

// A photo as a state names it, "101 (DSC01241.ARW)", or "no photo".
const photoName = (id, file) => (id == null ? 'no photo' : file ? `${id} (${file})` : String(id));

const cell = (x, w) => String(x ?? '-').padStart(w);

export function formatHeader() {
  return `${'rate'.padStart(6)} ${'sent'.padStart(5)} ${'hz'.padStart(6)} │ ${'ack med'.padStart(7)} ${'p95'.padStart(6)} ${'max'.padStart(6)} │ ${'ok med'.padStart(6)} │ ${'drift p95'.padStart(9)} │ ${'backlog'.padStart(9)} │ ${'drain'.padStart(6)} ${'done→vals'.padStart(9)} │ leaks errs`;
}

export function formatBurst(b) {
  const growth = b.backlog.growth == null ? '-' : `${b.backlog.growth >= 0 ? '+' : ''}${b.backlog.growth}${b.backlog.growing ? '!' : ''}`;
  return `${cell(`${b.hz}/s`, 6)} ${cell(b.sent, 5)} ${cell(b.actualHz, 6)} │ ${cell(b.ack.med, 7)} ${cell(b.ack.p95, 6)} ${cell(b.ack.max, 6)} │ ${cell(b.ok.med, 6)} │ ${cell(b.drift.p95, 9)} │ ${cell(growth, 9)} │ ${cell(b.drain.ackMs, 6)} ${cell(b.drain.doneToValsMs, 9)} │ ${cell(b.valsDuring, 5)} ${cell(b.errs, 4)}`;
}

export function formatReport(r) {
  const lines = [
    `latency: ${r.param} on ${r.host}:${r.cmdPort}/${r.evtPort}${r.lr ? ` (Lightroom ${r.lr}, ${r.catalog})` : ''}, base ${r.base}, bursts of ${r.burstMs} ms`,
    'times in ms; backlog = ack median in the last window minus the first ("!" = growing); leaks = vals carrying the tracked param mid-gesture',
    formatHeader(),
    ...r.bursts.map(formatBurst),
  ];
  const missing = r.bursts.reduce((n, b) => n + b.missingAcks, 0);
  const mismatched = r.bursts.reduce((n, b) => n + b.ackMismatches, 0);
  const growing = r.bursts.filter((b) => b.backlog.growing).map((b) => `${b.hz}/s`);
  lines.push(`acks missing ${missing}, acks not matching the value sent ${mismatched}; backlog ${growing.length ? `growing at ${growing.join(', ')}` : 'none'}; ${r.param} ${r.restored ? 'put back' : 'NOT put back'} to ${r.base}${r.photo != null ? ` on ${photoName(r.photo, r.file)}` : ''}`);
  if (r.restoreError) lines.push(r.restoreError);
  return lines.join('\n');
}

async function main() {
  let opt;
  try {
    opt = parseArgs({
      options: {
        ports: { type: 'string' },
        mock: { type: 'boolean' },
        'mock-set-ms': { type: 'string' },
        rates: { type: 'string', default: '15,30,60' },
        'burst-ms': { type: 'string', default: '5000' },
        'gap-ms': { type: 'string', default: '1500' },
        param: { type: 'string', default: 'Exposure' },
        json: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const usage = 'usage: node lightroom/tools/latency/latency.mjs (--mock [--mock-set-ms N] | --ports cmd,evt) [--rates 15,30,60] [--burst-ms 5000] [--gap-ms 1500] [--param Exposure] [--json out.json]';
  if (opt.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  // A finite number that passes ok(n). Anything else exits 2: a NaN burst length would never end.
  const num = (flag, ok, want) => {
    const text = opt[flag];
    const n = Number(text);
    if (String(text).trim() === '' || !Number.isFinite(n) || !ok(n)) throw new Error(`--${flag} wants ${want}, got "${text}"`);
    return n;
  };
  let rates;
  let ports;
  let burstMs;
  let gapMs;
  let mockSetMs = 0;
  try {
    rates = opt.rates.split(',').map(Number);
    if (rates.length === 0 || rates.some((x) => !Number.isFinite(x) || x <= 0 || x > 1000)) throw new Error('--rates wants sets per second, like 15,30,60');
    if (opt.mock && opt.ports) throw new Error('use --mock or --ports, not both');
    if (!opt.mock && !opt.ports) throw new Error('say --mock for the mock Lightroom, or --ports 58780,58781 for the real one');
    if (!opt.mock && rates.some((x) => x > MAX_LIVE_RATE)) {
      throw new Error(`--rates above ${MAX_LIVE_RATE} a second only with --mock: spike S2 measured Lightroom up to 60, and the deck sends at most 30 a second per param`);
    }
    burstMs = num('burst-ms', (n) => n > 0, 'a burst length in ms above 0');
    gapMs = num('gap-ms', (n) => n >= 0, 'a gap in ms, 0 or more');
    if (opt['mock-set-ms'] !== undefined) mockSetMs = num('mock-set-ms', (n) => n >= 0, 'the ms each set costs, 0 or more');
    ports = opt.ports ? parsePorts(opt.ports) : null;
  } catch (err) {
    process.stderr.write(`latency: ${err.message}\n${usage}\n`);
    process.exit(2);
  }
  let mock = null;
  if (opt.mock) {
    const { startMock } = await import('../mock-lr/index.mjs');
    mock = await startMock({ cmdPort: 0, evtPort: 0, setCostMs: mockSetMs });
    ports = [mock.cmdPort, mock.evtPort];
    process.stdout.write(`latency: mock Lightroom on ${ports.join('/')}${mock.control.state().setCostMs ? `, each set costing ${mock.control.state().setCostMs} ms` : ''}\n`);
  }
  try {
    const report = await runLatency({
      cmdPort: ports[0], evtPort: ports[1], rates, burstMs, gapMs, param: opt.param,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`\n${formatReport(report)}\n`);
    if (opt.json) fs.writeFileSync(path.resolve(opt.json), `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = reportFailed(report) ? 1 : 0;
  } catch (err) {
    process.stderr.write(`latency: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    if (mock) await mock.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
