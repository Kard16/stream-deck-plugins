#!/usr/bin/env node
// End-to-end test of the spike harness against fake-lr.mjs. Never touches the real ports or plugin dir.
// The fake behaves like real LrSocket: "ok" per cmd line, a send socket that never notices its client
// leaving, and a sender recreated when the cmd socket closes.
// Scenario 1 walks the user's checklist: connect late, tests, Auto Sync after a long menu pause,
// a stale sender the heartbeat must fix, Reload Plug-in, quit and relaunch.
// Scenario 2 runs the tests against a fake whose guard refuses writes.
// Scenario 3: vals before acks, hello only on request, and a slow Lightroom that builds a backlog.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-harness-test-'));
const SPIKE_VERSION = `-- Spike S3: the harness rewrites the next line to test module reloading.
local V = 'v1'
local LrDate = import 'LrDate'
local json = require 'json'
return { v = V, importOk = LrDate ~= nil, requireOk = json ~= nil }
`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

function start(script, args, logName) {
  const child = spawn(process.execPath, [path.join(here, script), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const logFile = path.join(tmpRoot, `${logName}.log`);
  child.lines = [];
  child.waiters = [];
  let buf = '';
  const onData = (d) => {
    fs.appendFileSync(logFile, d);
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      child.lines.push(line);
      for (const w of [...child.waiters]) if (line.includes(w.text)) w.resolve(line);
    }
  };
  child.stdout.setEncoding('utf8').on('data', onData);
  child.stderr.setEncoding('utf8').on('data', onData);
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.logFile = logFile;
  return child;
}

// Wait for a stdout line containing text, looking only at lines from index `from` on.
function waitLine(child, text, timeoutMs, from = 0) {
  if (child.lines.slice(from).some((l) => l.includes(text))) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const w = { text, resolve: () => { clearTimeout(timer); child.waiters.splice(child.waiters.indexOf(w), 1); resolve(true); } };
    const timer = setTimeout(() => {
      child.waiters.splice(child.waiters.indexOf(w), 1);
      reject(new Error(`timed out after ${timeoutMs} ms waiting for "${text}"`));
    }, timeoutMs);
    child.waiters.push(w);
  });
}

function tail(child, n = 40) {
  return child.lines.slice(-n).join('\n');
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return child.exited;
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const r = await child.exited;
  clearTimeout(timer);
  return r;
}

function makePluginDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SpikeVersion.lua'), SPIKE_VERSION);
  return dir;
}

async function scenarioMain() {
  console.log('\n# Scenario 1: full checklist against the fake (ports 59780/59781)');
  let beforeStale = null;
  let staleRecoveryMs = null;
  const pluginDir = makePluginDir('plugin-main');
  const svFile = path.join(pluginDir, 'SpikeVersion.lua');
  const out = path.join(tmpRoot, 'out-main');
  const fake = start('fake-lr.mjs', ['--cmd-port', '59780', '--evt-port', '59781', '--plugin-dir', pluginDir, '--refuse-first-ms', '1500', '--quit-down-ms', '6000'], 'fake-main');
  const harness = start('harness.mjs', ['--cmd-port', '59780', '--evt-port', '59781', '--plugin-dir', pluginDir, '--out', out, '--quick', '--max-minutes', '5'], 'harness-main');
  try {
    await waitLine(harness, '[mark] ready', 60000);
    check('S3 left SpikeVersion.lua at v2 while waiting for a reload', /local V = 'v2-/.test(fs.readFileSync(svFile, 'utf8')));
    fake.stdin.write('trigger tests\n');
    await waitLine(harness, '[mark] tests-done', 120000);
    // Lightroom paused for 6 s (a menu held open), then the menu item fires the autosync trigger.
    // The heartbeat must wait rather than reconnect, or the trigger would go to a dead socket.
    fake.stdin.write('freeze 6 autosync\n');
    await waitLine(harness, '[mark] autosync-done', 30000);
    beforeStale = harness.lines.length;
    // A stale sender: Lightroom keeps answering 'ok' but its events go nowhere. The heartbeat must notice.
    const tStale = Date.now();
    fake.stdin.write('stale\n');
    await waitLine(harness, '[mark] heartbeat-recovered', 15000, beforeStale);
    staleRecoveryMs = Date.now() - tStale;
    const beforeReload = harness.lines.length;
    fake.stdin.write('reload\n');
    await waitLine(harness, '[mark] lifecycle reload', 20000, beforeReload);
    await waitLine(harness, '[mark] s3-followup', 20000);
    check('SpikeVersion.lua restored after the reload follow-up', fs.readFileSync(svFile, 'utf8') === SPIKE_VERSION);
    fake.stdin.write('quit\n');
    await waitLine(harness, '[mark] lifecycle quit', 20000);
    await waitLine(harness, '[mark] lifecycle relaunch', 30000);
  } catch (e) {
    check('scenario 1 reached every step', false, e.message);
    console.log('--- harness tail ---\n' + tail(harness) + '\n--- fake tail ---\n' + tail(fake, 20));
  }
  const exit = await stop(harness);
  check('harness exits cleanly on SIGTERM', exit.code === 0, JSON.stringify(exit));
  fake.stdin.write('exit\n');
  await stop(fake);

  let S;
  try {
    S = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  } catch (e) {
    check('summary.json readable', false, e.message);
    return;
  }
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  check('SpikeVersion.lua matches the original after exit', fs.readFileSync(svFile, 'utf8') === SPIKE_VERSION);
  check('hello recorded with the test catalog', S.hello && S.hello.path === '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat');

  const c = S.s1.cycles;
  check('S1: 16 cycles (10 both, 3 cmd, 3 evt+rule)', c.length === 16 && c.filter((x) => x.kind === 'both').length === 10 && c.filter((x) => x.kind === 'cmd').length === 3 && c.filter((x) => x.kind === 'evt+rule').length === 3);
  check('S1: every cycle ok within 5 s of reconnecting', c.every((x) => x.ok && x.totalMs - x.reconnectAfterMs <= 5000), `max total ${Math.max(...c.map((x) => x.totalMs ?? Infinity))} ms from the drop`);
  check('S1: hello and connect times are positive', c.every((x) => x.helloMs > 0 && x.connectMs > 0));
  check('S1: every cycle verified with a hello', c.every((x) => typeof x.helloMs === 'number'));
  check('S1: cmd drops make the fake close evt (sender recreated)', c.filter((x) => x.kind === 'cmd').every((x) => x.lrClosedEvt === true));
  check('S1: evt drops close cmd too (pair rule)', c.filter((x) => x.kind === 'evt+rule').every((x) => x.pairClosed === true));
  check('S1: no retries needed', c.every((x) => !x.retried));
  check('S1: pass flag set', S.s1.pass === true);

  check("LrSocket 'ok' lines counted", S.link.okLines > 50, `${S.link.okLines}`);
  check("no 'ok' line reported as bad JSON", !S.unexpected.some((u) => /bad JSON/.test(u.why)) && !harness.lines.some((l) => /bad JSON/.test(l)));
  check("summary.md notes the 'ok' replies once", (md.match(/replies `ok` per line/g) || []).length === 1);
  const hb = S.link.heartbeat;
  check('heartbeat pinged and got pongs', hb && hb.pings > 5 && hb.pongs > 5, hb && `${hb.pings} pings, ${hb.pongs} pongs`);
  check('heartbeat waited out the 6 s pause', hb && hb.pausedEpisodes >= 1 && S.lifecycle.events.some((e) => e.kind === 'paused') && S.lifecycle.events.some((e) => e.kind === 'resumed'));
  check('no reconnect during the pause; the trigger after it arrived', beforeStale != null && !harness.lines.slice(0, beforeStale).some((l) => /reconnecting both sockets/.test(l)) && S.autosync.length === 1);
  check('heartbeat recovered the stale sender within about 6 s', staleRecoveryMs != null && staleRecoveryMs <= 6500, `${staleRecoveryMs} ms`);
  check('exactly one stale-sender reconnect', hb && hb.staleReconnects === 1, hb && `${hb.staleReconnects}`);
  const hbEv = S.lifecycle.events.find((e) => e.kind === 'heartbeat reconnect');
  check('lifecycle records the heartbeat reconnect and recovery', hbEv && hbEv.silentMs >= 4000 && S.lifecycle.events.some((e) => e.kind === 'heartbeat recovered'));

  const steps = Object.fromEntries(S.s3.steps.map((s) => [s.step.split(' ')[0], s]));
  check('S3 step 1 reads v1', steps['1'] && steps['1'].v === 'v1');
  check('S3 step 3 sees the require cache', steps['3'] && /cached/.test(steps['3'].verdict));
  check('S3 step 4 reload sees the edit', steps['4'] && steps['4'].ok && /^v2-/.test(steps['4'].v));
  check('S3 step 5 require still cached', steps['5'] && steps['5'].v === 'v1');
  check('S3 step 6 reload clears the cache', steps['6'] && steps['6'].ok && /clears/.test(S.status.s3));
  check('S3 file restored flag', S.s3.fileRestored === true);

  const run = S.s5.runs.at(-1);
  const names = run ? run.probes.map((p) => p.name) : [];
  const wanted = ['features', 'timing', 'presets', 'ranges', 'observerPhotoChange', 'flagAdvance', 'mask', 'select largestRaw', 'ranges (largest raw)'];
  check('S5: every probe ran', wanted.every((n) => names.includes(n)), names.join(', '));
  check('S5: every probe ok', run && run.probes.every((p) => p.ok));

  const s2 = S.s2.runs.at(-1);
  check('S2: 6 bursts', s2 && s2.bursts.length === 6);
  if (s2) {
    for (const b of s2.bursts) {
      const expected = b.hz * (b.burstMs / 1000);
      const label = `${b.hz}/s ${b.track ? 'tracked' : 'untracked'}`;
      check(`S2 ${label}: sent close to target`, b.sent >= expected * 0.7 && b.sent <= expected + 1, `sent ${b.sent}, expected ${expected}`);
      check(`S2 ${label}: actual rate within 25%`, Math.abs(b.actualHz - b.hz) <= b.hz * 0.25, `${b.actualHz}/s`);
      check(`S2 ${label}: acks and echoes measured`, b.ack.n >= b.sent * 0.9 && b.echo.n >= b.sent * 0.5 && b.echo.med > 0, `ack ${b.ack.n}, echo ${b.echo.n}, echo med ${b.echo.med}`);
      check(`S2 ${label}: no send bunching`, b.drift.p95 != null && b.drift.p95 < 1000 / b.hz, `drift p95 ${b.drift.p95} ms`);
    }
    check('S2: base restored', s2.restored === true && s2.base === 0.25);
    check('S2: photo recorded', s2.photo && s2.photo.file === 'DSCF0042.RAF');
  }
  check('Before/After probe ok', S.beforeAfter.at(-1) && S.beforeAfter.at(-1).ok);
  check('Auto Sync described', S.autosync.at(-1) && S.autosync.at(-1).ok && /2 of 2 other photos changed/.test(S.autosync.at(-1).text), S.autosync.at(-1) && S.autosync.at(-1).text);

  const ev = S.lifecycle.events;
  const reload = ev.find((e) => e.kind === 'reload');
  const quit = ev.find((e) => e.kind === 'quit');
  const relaunch = ev.find((e) => e.kind === 'relaunch');
  check('Lifecycle: reload with bye shutdownPlugin', reload && reload.byeWhy === 'shutdownPlugin' && typeof reload.downToHelloMs === 'number');
  check('Lifecycle: quit detected after bye shutdownApp', quit && quit.byeSeen && typeof quit.byeToCloseMs === 'number');
  check('Lifecycle: relaunch with a new inst', relaunch && relaunch.newInst !== relaunch.prevInst);
  check('No harness errors', S.errors.length === 0, JSON.stringify(S.errors).slice(0, 300));
  for (const h of ['## Status', '## S1 sockets', '## S3 hot reload', '## S5 probes', '## S2 latency', '## Before/After', '## Auto Sync', '## Lifecycle']) {
    check(`summary.md has "${h}"`, md.includes(h));
  }
  const evLines = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n');
  check('events.jsonl has both directions', evLines.some((l) => l.includes('"dir":"out"')) && evLines.some((l) => l.includes('"dir":"in"')), `${evLines.length} lines`);
  check('s2-samples.jsonl written', fs.existsSync(path.join(out, 's2-samples.jsonl')) && fs.statSync(path.join(out, 's2-samples.jsonl')).size > 0);
}

async function scenarioGuard() {
  console.log('\n# Scenario 2: guard refuses writes (ports 59782/59783)');
  const pluginDir = makePluginDir('plugin-guard');
  const svFile = path.join(pluginDir, 'SpikeVersion.lua');
  const out = path.join(tmpRoot, 'out-guard');
  const fake = start('fake-lr.mjs', ['--cmd-port', '59782', '--evt-port', '59783', '--plugin-dir', pluginDir, '--not-writable'], 'fake-guard');
  const harness = start('harness.mjs', ['--cmd-port', '59782', '--evt-port', '59783', '--plugin-dir', pluginDir, '--out', out, '--quick', '--max-minutes', '5'], 'harness-guard');
  try {
    await waitLine(harness, '[mark] ready', 60000);
    fake.stdin.write('trigger tests\n');
    await waitLine(harness, '[mark] tests-done', 120000);
  } catch (e) {
    check('scenario 2 reached every step', false, e.message);
    console.log('--- harness tail ---\n' + tail(harness));
  }
  // SIGINT this time, before any reload: the file must still be restored.
  const exit = await stop(harness, 'SIGINT');
  check('harness exits cleanly on SIGINT', exit.code === 0, JSON.stringify(exit));
  fake.stdin.write('exit\n');
  await stop(fake);
  const S = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  check('guard errors counted', S.guard.count > 0, `${S.guard.count}`);
  check('guarded probes recorded as failed', ['mask', 'flagAdvance'].every((n) => S.s5.runs.at(-1).probes.find((p) => p.name === n && !p.ok && p.msg === 'guard')));
  check('S2 bursts record the refused sets', S.s2.runs.at(-1).bursts.every((b) => b.errs > 0 && b.ack.n === 0));
  check('summary.md shows GUARD prominently', md.includes('> **GUARD:**'));
  check('harness stdout shows GUARD', harness.lines.some((l) => l.includes('[GUARD]')));
  check('SpikeVersion.lua restored on SIGINT', fs.readFileSync(svFile, 'utf8') === SPIKE_VERSION);
}

async function scenarioSlow() {
  console.log('\n# Scenario 3: vals before ack, hello only on request, 25 ms per set (ports 59784/59785)');
  const pluginDir = makePluginDir('plugin-slow');
  const out = path.join(tmpRoot, 'out-slow');
  const fake = start('fake-lr.mjs', ['--cmd-port', '59784', '--evt-port', '59785', '--plugin-dir', pluginDir, '--vals-before-ack', '--no-hello-on-connect', '--set-cost-ms', '25'], 'fake-slow');
  const harness = start('harness.mjs', ['--cmd-port', '59784', '--evt-port', '59785', '--plugin-dir', pluginDir, '--out', out, '--quick', '--max-minutes', '5'], 'harness-slow');
  try {
    await waitLine(harness, '[mark] ready', 90000);
    fake.stdin.write('trigger tests\n');
    await waitLine(harness, '[mark] tests-done', 120000);
  } catch (e) {
    check('scenario 3 reached every step', false, e.message);
    console.log('--- harness tail ---\n' + tail(harness));
  }
  await stop(harness);
  fake.stdin.write('exit\n');
  await stop(fake);
  const S = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  check('S1 passes when hello needs a hello command', S.s1.pass === true);
  check('S1 every cycle got a hello', S.s1.cycles.every((c) => typeof c.helloMs === 'number'));
  const bursts = S.s2.runs.at(-1).bursts;
  for (const b of bursts) {
    check(`S2 ${b.hz}/s ${b.track ? 'tracked' : 'untracked'}: echoes matched when vals precede acks`, b.echo.n >= b.sent * 0.9, `echo ${b.echo.n} of ${b.sent}`);
  }
  const at = (hz) => bursts.filter((b) => b.hz === hz);
  check('S2 backlog shows at 60/s (ack latency grows, long drain)', at(60).every((b) => b.backlog.ackGrowth > 100 && b.drain.ackMs > 150), JSON.stringify(at(60).map((b) => [b.backlog.ackGrowth, b.drain.ackMs])));
  check('S2 no backlog at 15/s', at(15).every((b) => b.backlog.ackGrowth != null && b.backlog.ackGrowth < 30), JSON.stringify(at(15).map((b) => b.backlog.ackGrowth)));
  check('S2 LR handler time reflects the 25 ms cost', bursts.every((b) => b.lr.med >= 20), JSON.stringify(bursts.map((b) => b.lr.med)));
}

const t0 = Date.now();
try {
  await scenarioMain();
  await scenarioGuard();
  await scenarioSlow();
} catch (e) {
  check('test runner', false, e.stack);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)} s. Logs and outputs: ${tmpRoot}`);
process.exit(failed.length ? 1 : 0);
