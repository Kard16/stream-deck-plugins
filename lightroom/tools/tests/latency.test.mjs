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

  // Before each burst the harness asks for a fresh state with hello, and the greeting pushes every watched value
  // too. Lightroom reads ranges and values between the greeting's state and its vals, so the vals can reach the
  // harness after it started the burst; they still arrive before the burst's first ack, because Lightroom
  // finishes the greeting before it takes the burst's first set.
  test('the greeting\'s vals that arrive after a burst began, but before its first ack, are no leak', async () => {
    await withMock({}, async (mock) => {
      // Hold back everything after a greeting's state for 20 ms, in order, as Lightroom's reads would.
      const send = mock.server.send.bind(mock.server);
      let afterHello = false;
      let held = null;
      mock.server.send = (obj) => {
        if (held) {
          held.push(obj);
          return true;
        }
        const ok = send(obj);
        if (obj.t === 'hello') afterHello = true;
        else if (obj.t === 'state' && afterHello) {
          afterHello = false;
          held = [];
          setTimeout(() => {
            const list = held;
            held = null;
            for (const o of list) send(o);
          }, 20);
        }
        return ok;
      };
      const r = await runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, rates: [30, 30], burstMs: 600, gapMs: 400 });
      for (const b of r.bursts) assert.equal(b.valsDuring, 0, `${b.hz}/s, g ${b.g}: ${JSON.stringify(b)}`);
      assert.equal(r.restored, true);
      assert.ok(!reportFailed(r), formatReport(r));
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

// The harness writes only to the photo it started on. Each burst starts a new gesture, and Lightroom puts a new
// gesture on whatever photo is the target, so a photo change mid-run must stop it, and the restore must not
// follow Lightroom to the new photo.
describe('latency harness: the photo changes mid-run', () => {
  const FILES = Object.fromEntries(loadScenario().photos.map((p) => [p.id, p.file]));
  const CANT = `can't put back Exposure 0.35 on 101 (${FILES[101]}): Lightroom is on 102 (${FILES[102]}) now`;
  const MOVED = `Lightroom moved from 101 (${FILES[101]}) to 102 (${FILES[102]}) mid-run: stopped writing`;
  const STALE = 'Lightroom refused a set as stale, so the photo or module changed mid-run: stopped writing';

  // Once when(m) is true for a command Lightroom takes, runs then() just after it, and collects every later
  // command but the heartbeat's pings.
  function after(mock, when, then) {
    const later = [];
    let hit = false;
    mock.control.on('command', (m) => {
      if (hit) {
        if (m.t !== 'ping') later.push(m);
      } else if (when(m)) {
        hit = true;
        setImmediate(then);
      }
    });
    return later;
  }
  const third = () => {
    let n = 0;
    return (m) => m.t === 'set' && m.g === 1 && ++n === 3;
  };
  const run = (mock, opts) => runLatency({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, gapMs: 100, ...opts });

  test('the CLI: a photo change mid-burst writes nothing to the new photo, skips the restore, and exits 1', async () => {
    await withMock({}, async (mock) => {
      const before = mock.control.state().photos;
      after(mock, third(), () => mock.control.user({ photo: '102' }));
      const r = await runNode(['latency/latency.mjs', '--ports', `${mock.cmdPort},${mock.evtPort}`, '--rates', '10', '--burst-ms', '3000', '--gap-ms', '200'], { timeoutMs: 30000 });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.ok([MOVED, STALE].some((why) => r.stderr.includes(`latency: ${why}\n`)), r.stderr);
      assert.ok(r.stdout.includes(`${CANT}\n`), r.stdout);
      const s = mock.control.state();
      assert.deepEqual(s.photos[102].values, before[102].values, 'nothing landed on 102');
      assert.deepEqual(s.history.map((h) => [h.kind, h.g, h.photo]), [['gesture', 1, '101']], 'only the burst, on 101');
    });
  });

  test('the CLI: a run that stays on its photo puts the value back there, and exits 0', async () => {
    await withMock({}, async (mock) => {
      const r = await runNode(['latency/latency.mjs', '--ports', `${mock.cmdPort},${mock.evtPort}`, '--rates', '30', '--burst-ms', '400', '--gap-ms', '200'], { timeoutMs: 30000 });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.includes(`Exposure put back to 0.35 on 101 (${FILES[101]})\n`), r.stdout);
      assert.ok(!r.stdout.includes("can't put back"), r.stdout);
      const s = mock.control.state();
      assert.equal(s.photos[101].values.Exposure, 0.35);
      assert.deepEqual(s.history.map((h) => [h.kind, h.g, h.photo]), [['gesture', 1, '101'], ['gesture', 2, '101']], 'the burst and the restore, both on 101');
      assert.equal(s.history[1].to, 0.35);
    });
  });

  // The manual clock: Lightroom's poll never runs, so no state says the photo changed, and only the next set
  // finds out. The latest state still names 101, so only a fresh one keeps the restore off 102.
  test('a set refused as stale stops the bursts at once, and the restore is not written onto the new photo', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const before = mock.control.state().photos;
      const later = after(mock, third(), () => mock.control.user({ photo: '102' }));
      const logs = [];
      await assert.rejects(run(mock, { rates: [10], burstMs: 2000, log: (l) => logs.push(l) }),
        (err) => err instanceof LatencyError && err.message === STALE && err.report.restoreError === CANT);
      assert.deepEqual(later.map((m) => m.t), ['set', 'hello'], 'the set that found the photo changed, then only the fresh state before the restore');
      const s = mock.control.state();
      assert.deepEqual(s.photos[102].values, before[102].values, 'nothing landed on 102, the restore included');
      assert.deepEqual(s.history.map((h) => [h.kind, h.g, h.photo, h.stale]), [['gesture', 1, '101', true]]);
      assert.ok(logs.includes(CANT), logs.join('\n'));
    });
  });

  test('a state naming another photo stops the bursts before the next set', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const before = mock.control.state().photos;
      // The poll sees the new photo, ends the gesture, and says so in a state before the next set is due.
      const later = after(mock, third(), () => {
        mock.control.user({ photo: '102' });
        mock.control.step();
      });
      await assert.rejects(run(mock, { rates: [10], burstMs: 2000 }),
        (err) => err instanceof LatencyError && err.message === MOVED && err.report.restoreError === CANT);
      assert.deepEqual(later.map((m) => m.t), ['hello'], 'no set after the state');
      assert.deepEqual(mock.control.state().photos[102].values, before[102].values);
    });
  });

  test('a photo change between bursts, before any state says so: the next burst never starts', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const before = mock.control.state().photos;
      const later = after(mock, (m) => m.t === 'done' && m.g === 1, () => mock.control.user({ photo: '102' }));
      await assert.rejects(run(mock, { rates: [10, 10], burstMs: 300 }),
        (err) => err instanceof LatencyError && err.message === MOVED && err.report.restoreError === CANT);
      assert.deepEqual(later.map((m) => m.t), ['hello', 'hello'], 'only the fresh states, before the next burst and before the restore');
      const s = mock.control.state();
      assert.deepEqual(s.photos[102].values, before[102].values);
      assert.deepEqual(s.history.map((h) => [h.kind, h.g, h.photo, h.why]), [['gesture', 1, '101', 'done']]);
    });
  });

  test('a photo change before the first set: nothing was written, so nothing needs putting back', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const later = after(mock, (m) => m.t === 'watch', () => mock.control.user({ photo: '102' }));
      const logs = [];
      await assert.rejects(run(mock, { rates: [10], burstMs: 300, log: (l) => logs.push(l) }),
        (err) => err instanceof LatencyError && err.message === MOVED && err.report.restoreError === null);
      assert.deepEqual(later.map((m) => m.t), ['hello'], 'only the fresh state before the first burst');
      assert.deepEqual(mock.control.state().history, []);
      assert.ok(!logs.some((l) => l.startsWith("can't put back")), logs.join('\n'));
    });
  });
});
