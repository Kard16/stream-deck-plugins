// The v1 latency harness, in short runs against the mock.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyError, formatReport, reportFailed, runLatency } from '../latency/latency.mjs';
import { loadScenario } from '../mock-lr/index.mjs';
import { freePort, runNode, withMock } from './helpers.mjs';

const MAIN = '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat';

describe('latency harness against the mock', () => {
  test('a short run: every set acked with its value, nothing leaked, the value put back', async () => {
    await withMock({}, async (mock) => {
      const before = mock.control.state().photos[101].values.Exposure;
      const r = await runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, rates: [15, 60], burstMs: 600, gapMs: 200 });
      assert.equal(r.bursts.length, 2);
      assert.equal(r.base, before);
      for (const b of r.bursts) {
        const label = `${b.hz}/s: ${JSON.stringify(b)}`;
        assert.ok(b.sent >= 3, label); // a loaded machine may skip slots, never bunch them
        assert.equal(b.missingAcks, 0, label);
        assert.equal(b.ackMismatches, 0, label);
        assert.equal(b.errs, 0, label);
        assert.equal(b.valsDuring, 0, `the tracked param stayed out of vals: ${label}`);
        for (const k of ['med', 'p95', 'max']) assert.equal(typeof b.ack[k], 'number', label);
        assert.equal(typeof b.drift.p95, 'number', label);
        assert.equal(typeof b.drain.ackMs, 'number', label);
        assert.equal(typeof b.drain.doneToValsMs, 'number', `done brought the observer's vals: ${label}`);
        assert.equal(b.backlog.growing, false, label);
      }
      assert.equal(r.restored, true);
      const s = mock.control.state();
      assert.equal(s.photos[101].values.Exposure, before);
      assert.equal(s.history.filter((h) => h.kind === 'gesture').length, 3, 'two bursts and the restore, one history step each');
      assert.match(formatReport(r), /acks missing 0, acks not matching the value sent 0; backlog none; Exposure put back to 0\.35/);
    });
  });

  test('a slow Lightroom shows up as a growing backlog', async () => {
    await withMock({ setCostMs: 30 }, async (mock) => {
      const r = await runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, rates: [10, 60], burstMs: 900, gapMs: 200 });
      const [slow, fast] = r.bursts;
      assert.equal(slow.backlog.growing, false, JSON.stringify(slow.backlog));
      assert.equal(fast.backlog.growing, true, JSON.stringify(fast.backlog));
      assert.ok(fast.ack.max > 200, `acks queue up behind 30 ms sets: ${JSON.stringify(fast.ack)}`);
      assert.equal(fast.missingAcks, 0, 'the drain waits for every ack');
      assert.equal(r.restored, true);
    });
  });

  test('the CLI with --mock prints the table and exits 0', async () => {
    const r = await runNode(['latency/latency.mjs', '--mock', '--rates', '30', '--burst-ms', '400', '--gap-ms', '200']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /rate {2}sent/);
    assert.match(r.stdout, /^ {2}30\/s/m);
    assert.match(r.stdout, /acks missing 0/);
  });

  test('the CLI wants --mock or --ports', async () => {
    const r = await runNode(['latency/latency.mjs']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /say --mock for the mock Lightroom, or --ports/);
  });

  test('another catalog: refuses before writing, with the guard off too', async () => {
    await withMock({}, async (mock) => {
      mock.control.setup({ ...loadScenario(), catalog: MAIN });
      mock.control.options({ guard: false }); // Lightroom says writable in every catalog now
      const before = mock.control.state();
      await assert.rejects(
        runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, rates: [15], burstMs: 300, gapMs: 100 }),
        (err) => err instanceof LatencyError && err.message.startsWith(`Lightroom has ${MAIN} open, not the test catalog`),
      );
      const after = mock.control.state();
      assert.deepEqual(after.photos, before.photos);
      assert.deepEqual(after.history, [], 'nothing written');
    });
  });

  test('several photos selected: refuses before writing, since Auto Sync would copy every set', async () => {
    await withMock({}, async (mock) => {
      mock.control.user({ selected: ['101', '102', '103'] });
      const before = mock.control.state();
      await assert.rejects(
        runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, rates: [15], burstMs: 300, gapMs: 100 }),
        /^LatencyError: 3 photos are selected: select exactly one/,
      );
      const after = mock.control.state();
      assert.deepEqual(after.photos, before.photos);
      assert.deepEqual(after.history, [], 'nothing written');
    });
  });

  test('a relaunch mid-run stops the writing: nothing reaches the new Lightroom, not even the restore', async () => {
    await withMock({}, async (mock) => {
      let relaunched = null;
      let back = false;
      const late = [];
      mock.control.on('up', () => { back = true; });
      mock.control.on('command', (m) => {
        if (back && (m.t === 'set' || m.t === 'reset')) late.push(m);
        if (!relaunched && m.t === 'set' && m.g === 1) setImmediate(() => { relaunched = mock.control.relaunch({ downMs: 300 }); });
      });
      await assert.rejects(
        runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, rates: [30], burstMs: 3000, gapMs: 100 }),
        /^LatencyError: Lightroom reloaded or relaunched mid-run \(inst \w+, now \w+\): stopped writing/,
      );
      await relaunched;
      assert.equal(back, true, 'the mock came back');
      assert.deepEqual(late, [], 'no set after the relaunch');
    });
  });

  test('the CLI checks its numbers, and caps the rate for the real Lightroom at 60', async () => {
    const [a, b] = [await freePort(), await freePort()];
    const cases = [
      [['--mock', '--burst-ms', 'abc'], /--burst-ms wants a burst length in ms above 0, got "abc"/],
      [['--mock', '--burst-ms', '0'], /--burst-ms wants a burst length in ms above 0/],
      [['--mock', '--gap-ms=-5'], /--gap-ms wants a gap in ms, 0 or more, got "-5"/],
      [['--mock', '--mock-set-ms', 'slow'], /--mock-set-ms wants the ms each set costs/],
      [['--ports', `${a},${b}`, '--rates', '30,120'], /--rates above 60 a second only with --mock/],
    ];
    for (const [args, want] of cases) {
      const r = await runNode(['latency/latency.mjs', ...args], { timeoutMs: 10000 });
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, want);
    }
    await assert.rejects(runLatency({ cmdPort: a, evtPort: b, burstMs: Number('abc') }), /burstMs must be a number of ms above 0/);
  });

  test('the exit code counts leaks and acks that don\'t match too', () => {
    const burst = { missingAcks: 0, errs: 0, valsDuring: 0, ackMismatches: 0 };
    assert.equal(reportFailed({ bursts: [burst], restored: true }), false);
    for (const k of Object.keys(burst)) assert.equal(reportFailed({ bursts: [{ ...burst, [k]: 1 }], restored: true }), true, k);
    assert.equal(reportFailed({ bursts: [burst], restored: false }), true);
  });
});
