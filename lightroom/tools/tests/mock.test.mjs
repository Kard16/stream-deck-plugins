// The mock Lightroom's quirks, as measured on Lightroom Classic 15.3 (docs/lightroom/plan.md, spike runs
// 1 and 2), and recovery from them by the shared client's pair rule and heartbeat.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { PortInUseError, TIMING, loadScenario, startMock } from '../mock-lr/index.mjs';
import { LrClient } from '../lib/client.mjs';
import { holdPort, rawSocket, sleep, waitUntil, withMock } from './helpers.mjs';

const now = () => performance.now();
const FAST_HB = { intervalMs: 100, staleMs: 600, okMs: 300 };
const PUNCHY = '9D1E2F3A4B5C6D7E8F90A1B2C3D4E5F6';
const MAIN = '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat';

function connect(mock, opts = {}) {
  return new LrClient({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, clientName: 'test', ...opts }).start();
}

// Waits until every event the mock wrote has reached the client.
const synced = (mock, c) => waitUntil(() => c.evtLines >= mock.control.evtWritten(), 2000, 2);
const since = (c, t, type) => c.history.filter((h) => h.t > t && (!type || h.msg.t === type)).map((h) => h.msg);
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// A connected client with the mock greeted and in sync, on the manual clock.
async function ready(mock) {
  const c = connect(mock, { heartbeat: false, autoHello: false });
  assert.ok(await c.waitUp(2000));
  assert.ok(await mock.control.waitClients(2000));
  assert.ok(await synced(mock, c));
  return c;
}

// Sends one command, waits for its ok, lets one 200 ms poll step pass, and waits until every event
// the mock wrote has arrived.
async function line(mock, c, cmd) {
  c.send(cmd);
  assert.ok(await c.waitOks(), `ok for ${JSON.stringify(cmd)}`);
  await mock.control.step();
  assert.ok(await synced(mock, c));
}

// The same without the poll step: on the manual clock, the poll hasn't run since.
async function lineNow(mock, c, cmd) {
  c.send(cmd);
  assert.ok(await c.waitOks(), `ok for ${JSON.stringify(cmd)}`);
  assert.ok(await synced(mock, c));
}

// Runs one command as line() does, and returns Lightroom's answers to it: "ack <g>" ("ack" after a reset)
// and "err <code>".
async function answers(mock, c, cmd, send = line) {
  const t = now();
  await send(mock, c, cmd);
  return since(c, t).filter((m) => m.t === 'ack' || m.t === 'err').map((m) => {
    if (m.t === 'err') return `err ${m.code}`;
    return m.g === undefined ? 'ack' : `ack ${m.g}`;
  });
}

describe('mock Lightroom: sockets', () => {
  test('the cmd socket answers every line with ok, bad lines too', async () => {
    await withMock({}, async (mock) => {
      const evt = await rawSocket(mock.evtPort);
      const cmd = await rawSocket(mock.cmdPort);
      cmd.send({ t: 'ping', id: 1 });
      cmd.send('not json');
      cmd.send({ t: 'explode', id: 2 });
      assert.ok(await waitUntil(() => cmd.lines.length >= 3, 2000));
      assert.deepEqual(cmd.lines, ['ok', 'ok', 'ok']);
      assert.ok(await waitUntil(() => evt.json().filter((m) => m.t === 'pong' || m.t === 'err').length >= 3, 2000));
      const types = evt.json().map((m) => m.t);
      assert.deepEqual(types.slice(0, 2), ['hello', 'state'], 'greeted on connect');
      evt.close();
      cmd.close();
    });
  });

  test('the send socket ignores a client dropping only evt, and keeps writing into the dead socket', async () => {
    await withMock({}, async (mock) => {
      const evt = await rawSocket(mock.evtPort);
      const cmd = await rawSocket(mock.cmdPort);
      assert.ok(await waitUntil(() => evt.json().some((m) => m.t === 'hello'), 2000));
      evt.close();
      await sleep(100);
      const lostBefore = mock.control.clients().lost;
      cmd.send({ t: 'ping', id: 2 });
      assert.ok(await waitUntil(() => cmd.lines.length >= 1, 2000), 'Lightroom still takes lines');
      assert.ok(await waitUntil(() => mock.control.clients().lost > lostBefore, 2000), 'the pong went into the dead socket');
      assert.equal(mock.control.clients().evt, true, 'Lightroom still thinks the client is there');

      // A new event connection is accepted but never served.
      const evt2 = await rawSocket(mock.evtPort);
      cmd.send({ t: 'ping', id: 3 });
      await sleep(300);
      assert.deepEqual(evt2.lines, []);
      assert.equal(mock.control.clients().backlog, 1);

      // Only the cmd socket closing makes Lightroom recreate the sender; the waiting connection dies with it.
      cmd.close();
      assert.ok(await waitUntil(() => evt2.closed, 2000), 'the unserved evt connection is closed');

      // Both again, as the pair rule does it: served.
      const evt3 = await rawSocket(mock.evtPort);
      const cmd3 = await rawSocket(mock.cmdPort);
      assert.ok(await waitUntil(() => evt3.json().some((m) => m.t === 'hello'), 2000));
      evt3.close();
      cmd3.close();
    });
  });

  test('the pair rule: losing evt closes cmd too, and both reconnect', async () => {
    await withMock({}, async (mock) => {
      const c = connect(mock, { heartbeat: false });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await c.waitFor('hello', 2000, -Infinity));
        const evtConns = mock.control.clients().connections.evt;
        const t = now();
        c.loseSide('evt');
        assert.ok(await c.waitFor('hello', 3000, t), 'greeted again');
        assert.equal(mock.control.clients().connections.evt, evtConns + 1);
        assert.equal(mock.control.clients().backlog, 0);
      } finally {
        c.stop();
      }
    });
  });

  test('a stale sender: oks keep coming, events stop, and the heartbeat reconnects both', async () => {
    await withMock({}, async (mock) => {
      const c = connect(mock, { heartbeat: FAST_HB });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await c.waitFor('hello', 2000, -Infinity));
        let stale = 0;
        let paused = 0;
        c.on('stale', () => { stale += 1; });
        c.on('paused', () => { paused += 1; });
        const t = now();
        assert.ok(mock.control.stale());
        const again = await c.waitFor('hello', 5000, t);
        assert.ok(again, 'greeted again after the heartbeat reconnected');
        assert.ok(again.t - t >= FAST_HB.staleMs, `waited the stale timeout (${Math.round(again.t - t)} ms)`);
        assert.equal(stale, 1);
        assert.equal(paused, 0, 'oks kept coming, so not "busy"');
        assert.equal(mock.control.clients().stale, false, 'a fresh sender');
        assert.ok((await c.request({ t: 'ping' }, 2000)).ok, 'events flow again');
      } finally {
        c.stop();
      }
    });
  });

  test('a client that breaks the pair rule gets nothing until its heartbeat reconnects both', async () => {
    await withMock({}, async (mock) => {
      const c = connect(mock, { heartbeat: FAST_HB });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await c.waitFor('hello', 2000, -Infinity));
        let stale = 0;
        c.on('stale', () => { stale += 1; });
        const t = now();
        c.drop(['evt'], 50); // reconnect evt alone, keeping cmd open
        await sleep(400);
        assert.equal(mock.control.clients().backlog, 1, 'the new evt connection waits unserved');
        assert.deepEqual(since(c, t), [], 'no events at all');
        assert.ok(await c.waitFor('hello', 5000, t), 'greeted once both were reconnected');
        assert.equal(stale, 1);
      } finally {
        c.stop();
      }
    });
  });

  test('Lightroom closing connections by itself: the client reconnects every time', async () => {
    await withMock({}, async (mock) => {
      const c = connect(mock, { heartbeat: false });
      try {
        assert.ok(await c.waitUp(2000));
        for (const which of ['both', 'evt', 'cmd']) {
          assert.ok(await mock.control.waitClients(4000), `the mock has the client before closing ${which}`);
          const conns = mock.control.clients().connections.cmd;
          const t = now();
          mock.control.close(which);
          assert.ok(await c.waitFor('hello', 4000, t), `greeted again after Lightroom closed ${which}`);
          assert.ok(await waitUntil(() => mock.control.clients().connections.cmd > conns, 2000), `a new cmd connection after closing ${which}`);
        }
      } finally {
        c.stop();
      }
    });
  });

  test('an open menu: no ok, no events, and the heartbeat waits instead of reconnecting', async () => {
    await withMock({}, async (mock) => {
      const c = connect(mock, { heartbeat: FAST_HB });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await c.waitFor('hello', 2000, -Infinity));
        const counts = { stale: 0, paused: 0, resumed: 0, down: 0 };
        for (const ev of Object.keys(counts)) c.on(ev, () => { counts[ev] += 1; });
        await sleep(250);
        const pongs = c.hb.pongs;
        mock.control.pause(1500);
        const oks = c.okLines;
        assert.ok(await waitUntil(() => counts.paused === 1, 3000), 'the client sees Lightroom busy');
        assert.equal(c.okLines, oks, 'no oks while paused');
        assert.ok(await waitUntil(() => counts.resumed === 1, 4000), 'and then back');
        assert.deepEqual({ stale: counts.stale, down: counts.down }, { stale: 0, down: 0 }, 'no reconnect');
        assert.ok(c.hb.pongs > pongs + 3, 'the pings sent during the pause were answered after it');
      } finally {
        c.stop();
      }
    });
  });

  test('quit and relaunch: no goodbye, a new inst, and the watch list starts empty', async () => {
    await withMock({}, async (mock) => {
      const c = connect(mock, { heartbeat: false });
      try {
        assert.ok(await c.waitUp(2000));
        const h1 = await c.waitFor('hello', 2000, -Infinity);
        const tw = now();
        c.send({ t: 'watch', ps: ['Exposure'] });
        assert.ok(await c.waitFor('vals', 2000, tw));
        const insts = [];
        c.on('inst', (e) => insts.push(e));
        const t = now();
        const relaunched = mock.control.relaunch({ downMs: 400 });
        const h2 = await c.waitFor((m) => m.t === 'hello' && m.inst !== h1.msg.inst, 6000, t);
        await relaunched;
        assert.ok(h2, 'greeted by the new instance');
        assert.equal(insts.length, 1);
        assert.equal(insts[0].previous, h1.msg.inst);
        assert.deepEqual(mock.control.state().watch, []);
        await sleep(300);
        const types = since(c, t).map((m) => m.t);
        assert.ok(!types.includes('bye'), 'no goodbye');
        assert.ok(!since(c, h2.t).some((m) => m.t === 'vals'), 'nothing watched, so no vals');
      } finally {
        c.stop();
      }
    });
  });

  test('ports already taken: a clear "is Lightroom running?" error', async () => {
    const held = await holdPort();
    try {
      await assert.rejects(startMock({ cmdPort: held.port, evtPort: 0 }), (err) => err instanceof PortInUseError && /is Lightroom running\?/.test(err.message) && err.message.includes(String(held.port)));
      await assert.rejects(startMock({ cmdPort: 0, evtPort: held.port }), PortInUseError);
      await assert.rejects(startMock({ cmdPort: held.port, evtPort: held.port }), /must differ/);
    } finally {
      await held.close();
    }
  });

  test('stop() during a relaunch leaves nothing listening', async () => {
    const mock = await startMock({ cmdPort: 0, evtPort: 0 });
    const { cmdPort } = mock;
    const relaunched = mock.control.relaunch({ downMs: 200 });
    await sleep(50);
    await mock.stop();
    await relaunched;
    await sleep(100);
    // The port is free again: binding it works.
    await new Promise((resolve, reject) => {
      const srv = net.createServer().once('error', reject).listen(cmdPort, '127.0.0.1', () => srv.close(resolve));
    });
  });

  test('setup() drops whatever was pending in the old state', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      mock.control.options({ autoAdvance: true });
      mock.control.user({ flag: 'pick' }); // Auto Advance would move on in 30 ms
      mock.control.setup({ photos: [{ id: '1' }, { id: '2' }] });
      await mock.control.advance(1000);
      assert.equal(mock.control.state().target, '1');
    });
  });
});

describe('mock Lightroom: Develop', () => {
  const ONE = {
    module: 'develop',
    photos: [{ id: '1', file: 'A.ARW', fmt: 'RAW', values: { Exposure: 0.35, Contrast: 0 } }],
    watch: ['Exposure', 'Contrast'],
  };

  test('the observer is silent during a tracked gesture and reports once after stopTracking; the 200 ms poll catches mouse edits', async () => {
    await withMock({ clock: 'manual', scenario: ONE }, async (mock) => {
      const c = connect(mock, { heartbeat: false, autoHello: false });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        assert.ok(await synced(mock, c));
        const t0 = now();
        for (const v of [0.4, 0.5, 0.6]) {
          c.send({ t: 'set', p: 'Exposure', v, g: 1 });
          assert.ok(await c.waitOks());
          await mock.control.step();
        }
        mock.control.user({ edit: { Contrast: 7 } });
        await mock.control.step();
        assert.ok(await synced(mock, c));
        let vals = since(c, t0, 'vals').map((m) => m.vals);
        assert.ok(vals.every((v) => !('Exposure' in v)), `no Exposure while tracking: ${JSON.stringify(vals)}`);
        assert.deepEqual(vals, [{ Contrast: 7 }], 'the poll reported the mouse edit');
        const tDone = now();
        c.send({ t: 'done', g: 1 });
        assert.ok(await c.waitOks());
        await mock.control.advance(1000);
        assert.ok(await synced(mock, c));
        vals = since(c, tDone, 'vals').map((m) => m.vals);
        assert.deepEqual(vals, [{ Exposure: 0.6 }], 'one report after stopTracking');
        const gestures = mock.control.state().history.filter((h) => h.kind === 'gesture');
        assert.equal(gestures.length, 1, 'one gesture, one history step');
        assert.equal(gestures[0].sets, 3);
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Events: vals are "Never outside Develop". The fixtures can't see a poll that breaks this.
  test('outside Develop: no vals from the poll or the observer, and leaving Develop ends the gesture', async () => {
    await withMock({ clock: 'manual', scenario: ONE }, async (mock) => {
      const c = await ready(mock);
      try {
        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 });
        assert.equal(mock.control.state().tracking, true);
        const t = now();
        await line(mock, c, { t: 'module', v: 'library' });
        const s = mock.control.state();
        assert.equal(s.tracking, false, 'leaving Develop ended the gesture');
        assert.deepEqual(pick(s.history.at(-1), ['kind', 'p', 'g', 'why']), { kind: 'gesture', p: 'Exposure', g: 1, why: 'left Develop' });
        await mock.control.advance(1000);
        mock.control.user({ edit: { Contrast: 9 } });
        await mock.control.advance(1000);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t).map((m) => m.t), ['state'], `state only, no vals in Library: ${JSON.stringify(since(c, t))}`);
        const t2 = now();
        await line(mock, c, { t: 'module', v: 'develop' });
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t2, 'vals').map((m) => m.vals), [{ Exposure: 0.5, Contrast: 9 }], 'every watched value on entering Develop');
      } finally {
        c.stop();
      }
    });
  });

  test('a photo change ends the gesture, from nav and from the user', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 });
        assert.equal(mock.control.state().tracking, true);
        await line(mock, c, { t: 'nav', v: 'next' });
        let s = mock.control.state();
        assert.equal(s.target, '102');
        assert.equal(s.tracking, false, 'nav next ended the gesture');
        assert.deepEqual(pick(s.history.at(-1), ['kind', 'photo', 'g', 'why']), { kind: 'gesture', photo: '101', g: 1, why: 'nav next' });

        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.1, g: 2 });
        assert.equal(mock.control.state().tracking, true);
        mock.control.user({ photo: '104' });
        await mock.control.step();
        s = mock.control.state();
        assert.equal(s.tracking, false, 'clicking another photo ended the gesture');
        assert.deepEqual(pick(s.history.at(-1), ['kind', 'photo', 'g', 'why']), { kind: 'gesture', photo: '102', g: 2, why: 'the photo changed' });
        assert.deepEqual([101, 102, 104].map((id) => s.photos[id].values.Exposure), [0.5, 0.1, 0.6], 'each set stayed on its own photo');
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Events: ack's g is "absent after reset". The fixtures allow extra fields, so they can't see one.
  test('reset ends the gesture, and its ack carries no g', async () => {
    await withMock({ clock: 'manual', scenario: ONE }, async (mock) => {
      const c = await ready(mock);
      try {
        await line(mock, c, { t: 'set', p: 'Exposure', v: 1.2, g: 3 });
        const t = now();
        await line(mock, c, { t: 'reset', p: 'Exposure' });
        assert.ok(await synced(mock, c));
        const acks = since(c, t, 'ack');
        assert.deepEqual(acks, [{ t: 'ack', p: 'Exposure', v: 0 }], 'p and v only');
        const s = mock.control.state();
        assert.equal(s.tracking, false);
        assert.deepEqual(s.history.slice(-2).map((h) => [h.kind, h.why ?? null]), [['gesture', 'reset'], ['reset', null]]);
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Rates: vals at most 20 a second. The ones owed after a photo change count too, as in the plugin.
  test('vals go out at most 20 a second, the ones owed after quick photo changes too', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const out = [];
      mock.control.on('sent', (m) => { if (m.t === 'vals' || m.t === 'state') out.push({ at: mock.lr.clock.now(), m }); });
      const c = await ready(mock);
      try {
        await line(mock, c, { t: 'watch', ps: ['Exposure', 'Contrast'] });
        await mock.control.advance(1000);
        const from = out.length;
        for (let i = 0; i < 4; i += 1) c.send({ t: 'nav', v: 'next' }); // four at the same instant
        assert.ok(await c.waitOks());
        await mock.control.advance(1000);
        assert.ok(await synced(mock, c));
        const vals = out.filter((x) => x.m.t === 'vals');
        const gaps = vals.slice(1).map((x, i) => x.at - vals[i].at);
        assert.ok(gaps.every((g) => g >= TIMING.valsGapMs), `vals ${TIMING.valsGapMs} ms apart or more: gaps ${gaps.join(', ')}`);
        const burst = out.slice(from);
        assert.deepEqual(burst.map((x) => (x.m.t === 'state' ? `state ${x.m.photo}` : `vals@${x.at - burst[0].at}`)),
          ['state 102', 'vals@0', 'state 103', 'state 104', 'state 105', `vals@${TIMING.valsGapMs}`],
          'the first photo\'s vals at once, then the last photo\'s once the limit allows');
        const s = mock.control.state();
        assert.equal(s.target, '105');
        assert.deepEqual(burst.at(-1).m.vals, { Exposure: s.photos[105].values.Exposure, Contrast: s.photos[105].values.Contrast });
      } finally {
        c.stop();
      }
    });
  });

  test('ranges per file format: Kelvin on RAW and DNG, -100..100 on JPEG', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const { lr } = mock;
      const params = ['Temperature', 'Tint', 'Exposure', 'Contrast'];
      const want = {
        101: { Temperature: [2000, 50000], Tint: [-150, 150], Exposure: [-5, 5], Contrast: [-100, 100] },
        108: { Temperature: [2000, 50000], Tint: [-150, 150], Exposure: [-5, 5], Contrast: [-100, 100] },
        106: { Temperature: [-100, 100], Tint: [-100, 100], Exposure: [-5, 5], Contrast: [-100, 100] },
      };
      for (const [id, ranges] of Object.entries(want)) {
        mock.control.user({ photo: id });
        assert.deepEqual(lr.rangesFor(params), ranges, `photo ${id}`);
      }
      mock.control.setup({ photos: [{ id: '9', fmt: 'JPG' }], ranges: { JPG: { Exposure: [-4, 4] } } });
      assert.deepEqual(lr.rangesFor(['Exposure', 'Temperature']), { Exposure: [-4, 4], Temperature: [-100, 100] }, 'setup ranges override the defaults');
    });
  });

  test('a gesture ends when the client disconnects', async () => {
    await withMock({ scenario: ONE }, async (mock) => {
      const c = connect(mock, { heartbeat: false });
      assert.ok(await c.waitUp(2000));
      assert.ok(await mock.control.waitClients(2000));
      const t = now();
      c.send({ t: 'set', p: 'Exposure', v: 1, g: 1 });
      assert.ok(await c.waitFor('ack', 2000, t));
      assert.equal(mock.control.state().tracking, true);
      c.stop();
      assert.ok(await waitUntil(() => !mock.control.state().tracking, 2000));
      const last = mock.control.state().history.at(-1);
      assert.equal(last.kind, 'gesture');
      assert.match(last.why, /disconnected/);
    });
  });

  test('presets skip locked photos, and a busy catalog answers err busy after 3 s', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = connect(mock, { heartbeat: false, autoHello: false });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        mock.control.user({ selected: ['106', '107', '108'] }); // 107 is locked by background AI
        const t1 = now();
        c.send({ t: 'preset', id: 1, uuid: PUNCHY });
        assert.ok(await c.waitOks());
        const applied = await c.waitFor('applied', 1000, t1);
        assert.deepEqual({ ...applied.msg, t: undefined }, { t: undefined, id: 1, uuid: PUNCHY, n: 2, locked: 1 });
        const s = mock.control.state();
        assert.deepEqual([s.photos[106].applied, s.photos[107].applied, s.photos[108].applied], [[PUNCHY], [], [PUNCHY]]);
        assert.equal(s.photos[106].values.Contrast, 25, 'the preset changed the sliders');

        mock.control.busy(5000);
        const t2 = now();
        c.send({ t: 'preset', id: 2, uuid: PUNCHY });
        assert.ok(await c.waitOks());
        await mock.control.advance(2800);
        assert.ok(await synced(mock, c));
        assert.equal(since(c, t2).filter((m) => m.id === 2).length, 0, 'still waiting for write access');
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t2).filter((m) => m.id === 2).map((m) => m.code), ['busy']);

        mock.control.busy(1000);
        const t3 = now();
        c.send({ t: 'preset', id: 3, uuid: PUNCHY });
        assert.ok(await c.waitOks());
        await mock.control.advance(1200);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t3).filter((m) => m.id === 3).map((m) => m.t), ['applied'], 'access came within the 3 s timeout');
      } finally {
        c.stop();
      }
    });
  });

  test('the guard: writes only in the test catalog, compared without case', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      mock.control.setup({ catalog: '/USERS/karimdhanji/pictures/plugin test/PLUGIN TEST.LRCAT', photos: [{ id: '1' }] });
      assert.equal(mock.control.state().writable, true);
      mock.control.setup({ catalog: '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat', photos: [{ id: '1' }] });
      assert.equal(mock.control.state().writable, false);
      mock.control.options({ guard: false });
      assert.equal(mock.control.state().writable, true, 'only the user turns the guard off');
    });
  });

  test('Lightroom\'s own Auto Advance moves on after a flag, and flag advance does not move twice', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      mock.control.options({ autoAdvance: true });
      mock.control.user({ flag: 'pick' });
      await mock.control.step();
      assert.equal(mock.control.state().target, '102');
      mock.control.options({ autoAdvance: false });
      mock.control.user({ flag: 'reject' });
      await mock.control.step();
      assert.equal(mock.control.state().target, '102');
      assert.equal(mock.control.state().photos[102].flag, -1);
    });
  });

  test('command names are looked up exactly: toString and constructor are unknown', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = connect(mock, { heartbeat: false, autoHello: false });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        for (const t of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
          const r = await c.request({ t }, 1000);
          assert.equal(r.ok, true, t);
          assert.deepEqual([r.reply.t, r.reply.cmd, r.reply.code], ['err', t, 'unknown']);
        }
      } finally {
        c.stop();
      }
    });
  });

  test('reload takes the plugin\'s reloadable modules; any other name, Server and State included, needs Reload Plug-in', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = connect(mock, { heartbeat: false, autoHello: false });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        const all = await c.request({ t: 'reload' }, 1000);
        assert.equal(all.reply.ok, true);
        // Reload.MODULES in lightroom/lua/DeckBridge.lrdevplugin/Reload.lua
        assert.deepEqual(all.reply.mods, ['Proto', 'Develop', 'Poll', 'Library', 'Presets', 'Dispatch', 'Core', 'Reload']);
        const one = await c.request({ t: 'reload', mods: ['Develop'] }, 1000);
        assert.deepEqual(pick(one.reply, ['mods', 'ok', 'msg']), { mods: ['Develop'], ok: true, msg: 'reloaded Develop' });
        for (const name of ['Server', 'State', 'Guard', 'Log', 'Config', 'Foo']) {
          const bad = await c.request({ t: 'reload', mods: ['Develop', name] }, 1000);
          assert.deepEqual(pick(bad.reply, ['ok', 'msg']), { ok: false, msg: `${name} doesn't hot-reload; use Reload Plug-in` }, name);
        }
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Commands: done. The amended text says the final value comes "if it differs from the last
  // value Lightroom sent for p", as the plugin's diffing push does it.
  test('after a gesture, vals carry its final value only if that differs from the last value sent', async () => {
    await withMock({ clock: 'manual', scenario: ONE }, async (mock) => {
      const c = await ready(mock);
      try {
        const t = now();
        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 });
        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.35, g: 1 }); // back where it started
        await line(mock, c, { t: 'done', g: 1 });
        await mock.control.advance(1000);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t, 'vals'), [], 'Exposure is back at 0.35, the value last sent');
        const t2 = now();
        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 2 });
        await line(mock, c, { t: 'done', g: 2 });
        await mock.control.advance(1000);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t2, 'vals').map((m) => m.vals), [{ Exposure: 0.6 }]);
        assert.equal(mock.control.state().history.filter((h) => h.kind === 'gesture').length, 2, 'one history step each');
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Commands: watch. getRange needs Develop, so the plugin finds unknown params on entering it.
  test('unknown watched params are dropped on entering Develop, with an err bad carrying the watch\'s id', async () => {
    await withMock({ clock: 'manual', scenario: { ...ONE, module: 'library', watch: [] } }, async (mock) => {
      const c = await ready(mock);
      try {
        const t = now();
        await line(mock, c, { t: 'watch', id: 3, ps: ['Exposure', 'NoSuchSlider', 7, 'Exposure'] });
        assert.deepEqual(since(c, t).map((m) => pick(m, ['t', 'id', 'cmd', 'code'])), [{ t: 'err', id: 3, cmd: 'watch', code: 'bad' }],
          'in Library, only the entry that is no name gets its err at once');
        assert.deepEqual(mock.control.state().watch, ['Exposure', 'NoSuchSlider']);

        const t2 = now();
        await line(mock, c, { t: 'module', v: 'develop' });
        const got = since(c, t2);
        assert.deepEqual(got.map((m) => m.t), ['state', 'err', 'ranges', 'vals']);
        assert.deepEqual(pick(got[1], ['id', 'cmd', 'code']), { id: 3, cmd: 'watch', code: 'bad' });
        assert.match(got[1].msg, /NoSuchSlider/);
        assert.deepEqual([got[2].ranges, got[3].vals], [{ Exposure: [-5, 5] }, { Exposure: 0.35 }]);
        assert.deepEqual(mock.control.state().watch, ['Exposure']);

        const t3 = now();
        await line(mock, c, { t: 'watch', id: 4, ps: ['Contrast', 'Bogus'] });
        assert.deepEqual(since(c, t3).map((m) => (m.t === 'err' ? `err ${m.id} ${m.code}` : m.t)), ['err 4 bad', 'ranges', 'vals'], 'in Develop, at once');
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Gestures: Lightroom ends the gesture itself when the plugin shuts down, as if done had arrived.
  test('a gesture still open when the plugin shuts down ends as one history step', async () => {
    await withMock({ scenario: ONE }, async (mock) => {
      const c = connect(mock, { heartbeat: false });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        const t = now();
        c.send({ t: 'set', p: 'Exposure', v: 1, g: 1 });
        assert.ok(await c.waitFor('ack', 2000, t));
        await mock.control.relaunch({ downMs: 100 });
        const s = mock.control.state();
        assert.equal(s.tracking, false);
        assert.deepEqual(s.history.map((h) => pick(h, ['kind', 'g', 'why', 'stale'])), [{ kind: 'gesture', g: 1, why: 'shutdown', stale: false }]);
      } finally {
        c.stop();
      }
    });
  });

  test('a deck speaking another v still gets the v1 hello, and the plugin logs it', async () => {
    const logs = [];
    await withMock({ clock: 'manual', log: (kind, text) => logs.push({ kind, text }) }, async (mock) => {
      const c = await ready(mock);
      try {
        const t = now();
        await line(mock, c, { t: 'hello', v: 2, client: 'future-deck', ver: '9.0.0' });
        assert.deepEqual(since(c, t, 'hello').map((m) => m.v), [1]);
        assert.ok(logs.some((l) => l.kind === 'warn' && /protocol v2/.test(l.text)), JSON.stringify(logs.filter((l) => l.kind !== 'evt')));
      } finally {
        c.stop();
      }
    });
  });
});

// PROTOCOL.md, Gestures: a gesture belongs to the photo it started on. Once the photo or the module changes
// under it, the deck's later sets for it carry values worked out for the old photo, and get err stale.
describe('mock Lightroom: stale gestures', () => {
  const THREE = {
    module: 'develop',
    photos: [
      { id: '101', file: 'A.ARW', fmt: 'RAW', values: { Exposure: 0.35, Contrast: 0 } },
      { id: '102', file: 'B.ARW', fmt: 'RAW', values: { Exposure: -0.4, Contrast: 5 } },
      { id: '103', file: 'C.ARW', fmt: 'RAW', values: { Exposure: 0.1, Contrast: -3 } },
    ],
    watch: ['Exposure', 'Contrast'],
  };
  const values = (mock, p) => Object.fromEntries(['101', '102', '103'].map((id) => [id, mock.control.state().photos[id].values[p]]));

  test('a set that reaches a photo change before the poll ends its gesture as stale, and is refused', async () => {
    await withMock({ clock: 'manual', scenario: THREE }, async (mock) => {
      const c = await ready(mock);
      try {
        await line(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 });
        mock.control.user({ photo: '102' });
        assert.equal(mock.control.state().tracking, true, 'only the poll notices a photo change, and it hasn\'t run');
        const t = now();
        await lineNow(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 1, id: 7 });
        assert.deepEqual(since(c, t).map((m) => pick(m, ['t', 'id', 'cmd', 'code'])), [{ t: 'err', id: 7, cmd: 'set', code: 'stale' }]);
        let s = mock.control.state();
        assert.equal(s.tracking, false);
        assert.equal(s.staleG, 1);
        assert.deepEqual(pick(s.history.at(-1), ['kind', 'photo', 'g', 'to', 'stale']), { kind: 'gesture', photo: '101', g: 1, to: 0.5, stale: true });
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.5, 102: -0.4, 103: 0.1 }, 'the set changed nothing');

        // The rest of that gesture is refused too, whatever its p; the deck's next gesture goes to 102.
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Contrast', v: 9, g: 1 }), ['err stale']);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: -0.3, g: 2 }), ['ack 2']);
        s = mock.control.state();
        assert.equal(s.staleG, null, 'a new gesture forgets the stale g');
        assert.deepEqual(s.gesture, { p: 'Exposure', g: 2, photo: '102' });
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.5, 102: -0.3, 103: 0.1 });
        assert.deepEqual(values(mock, 'Contrast'), { 101: 0, 102: 5, 103: -3 });
      } finally {
        c.stop();
      }
    });
  });

  test('a gesture that starts on the new photo before the poll notices goes on: it belongs to that photo', async () => {
    await withMock({ clock: 'manual', scenario: THREE }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ photo: '102' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.2, g: 4 }, lineNow), ['ack 4']);
        await mock.control.advance(400); // the poll sees 102
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.25, g: 4 }), ['ack 4']);
        const s = mock.control.state();
        assert.deepEqual(s.gesture, { p: 'Exposure', g: 4, photo: '102' }, 'still the one gesture');
        assert.deepEqual([s.history, s.staleG], [[], null]);
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.35, 102: 0.25, 103: 0.1 });
      } finally {
        c.stop();
      }
    });
  });

  test('the poll ends a gesture as stale when the user changes the photo or the selection, Auto Advance moves on, or the user leaves Develop', async () => {
    await withMock({ clock: 'manual', scenario: THREE }, async (mock) => {
      const c = await ready(mock);
      const ask = (cmd) => answers(mock, c, cmd);
      try {
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.5, g: 1 }), ['ack 1']);
        mock.control.user({ photo: '102' });
        await mock.control.step();
        assert.deepEqual([mock.control.state().tracking, mock.control.state().staleG], [false, 1], 'the poll ended it');
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.6, g: 1 }), ['err stale'], 'after a photo change');

        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 10, g: 2 }), ['ack 2']);
        mock.control.user({ selected: ['103', '101'] });
        await mock.control.step();
        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 12, g: 2 }), ['err stale'], 'after a selection change');

        mock.control.user({ photo: '101' });
        mock.control.options({ autoAdvance: true });
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.2, g: 3 }), ['ack 3']);
        mock.control.user({ flag: 'pick' }); // Lightroom's own Auto Advance moves on to 102
        await mock.control.step();
        assert.equal(mock.control.state().target, '102');
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.3, g: 3 }), ['err stale'], 'after Auto Advance');

        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: -0.1, g: 4 }), ['ack 4']);
        mock.control.user({ module: 'library' });
        await mock.control.step();
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0, g: 4 }), ['err stale'], 'after leaving Develop');
        assert.equal(mock.control.state().module, 'library', 'a stale set switches nothing');
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.2, 102: -0.1, 103: 0.1 });
        assert.deepEqual(values(mock, 'Contrast'), { 101: 0, 102: 10, 103: -3 });

        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0, g: 5 }), ['ack 5'], 'a new gesture still switches');
        assert.equal(mock.control.state().module, 'develop');
        const ended = mock.control.state().history.filter((h) => h.kind === 'gesture').map((h) => [h.g, h.photo, h.stale]);
        assert.deepEqual(ended, [[1, '101', true], [2, '102', true], [3, '101', true], [4, '102', true]]);
      } finally {
        c.stop();
      }
    });
  });

  test('the deck\'s own nav, a flag\'s advance and module library end the open gesture as stale', async () => {
    await withMock({ clock: 'manual', scenario: THREE }, async (mock) => {
      const c = await ready(mock);
      const ask = (cmd) => answers(mock, c, cmd);
      try {
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.5, g: 1 }), ['ack 1']);
        await line(mock, c, { t: 'nav', v: 'next' });
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.6, g: 1 }), ['err stale'], 'after nav');

        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: -0.2, g: 2 }), ['ack 2']);
        await line(mock, c, { t: 'flag', v: 'pick', advance: true });
        await mock.control.advance(200);
        assert.equal(mock.control.state().target, '103');
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: -0.1, g: 2 }), ['err stale'], 'after flag with advance');

        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 7, g: 3 }), ['ack 3']);
        await line(mock, c, { t: 'module', v: 'library' });
        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 8, g: 3 }), ['err stale'], 'after module library');
        const s = mock.control.state();
        assert.equal(s.module, 'library', 'a stale set switches nothing');
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.5, 102: -0.2, 103: 0.1 });
        assert.deepEqual(values(mock, 'Contrast'), { 101: 0, 102: 5, 103: 7 });
        assert.deepEqual(s.history.filter((h) => h.kind === 'gesture').map((h) => [h.g, h.photo, h.stale]), [[1, '101', true], [2, '102', true], [3, '103', true]]);
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Gestures: "the deck sends nav, or a flag's advance moves on, even at an end of the filmstrip
  // where nothing moves". Refusing a set is safer than applying one to the wrong photo.
  test('nav and a flag\'s advance end the open gesture as stale at either end of the filmstrip too, where nothing moves', async () => {
    await withMock({ clock: 'manual', scenario: THREE }, async (mock) => {
      const c = await ready(mock);
      const ask = (cmd) => answers(mock, c, cmd);
      try {
        // 101 is the first photo: nav prev can't move.
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.5, g: 1 }), ['ack 1']);
        const t = now();
        await line(mock, c, { t: 'nav', v: 'prev' });
        assert.equal(mock.control.state().target, '101', 'nothing moved');
        assert.deepEqual(since(c, t, 'state').map((m) => m.photo), ['101'], 'nav still answers with state');
        assert.deepEqual(await ask({ t: 'set', p: 'Exposure', v: 0.6, g: 1 }), ['err stale'], 'after nav prev on the first photo');

        // 103 is the last: neither nav next nor a flag's advance can move.
        mock.control.user({ photo: '103' });
        await mock.control.step();
        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 4, g: 2 }), ['ack 2']);
        await line(mock, c, { t: 'nav', v: 'next' });
        assert.equal(mock.control.state().target, '103', 'nothing moved');
        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 5, g: 2 }), ['err stale'], 'after nav next on the last photo');
        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 6, g: 3 }), ['ack 3']);
        await line(mock, c, { t: 'flag', v: 'pick', advance: true });
        await mock.control.advance(200);
        assert.equal(mock.control.state().target, '103', 'nothing moved');
        assert.deepEqual(await ask({ t: 'set', p: 'Contrast', v: 7, g: 3 }), ['err stale'], 'after a flag\'s advance on the last photo');

        const s = mock.control.state();
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.5, 102: -0.4, 103: 0.1 });
        assert.deepEqual(values(mock, 'Contrast'), { 101: 0, 102: 5, 103: 6 });
        assert.deepEqual(s.history.filter((h) => h.kind === 'gesture').map((h) => [h.g, h.photo, h.why, h.stale]),
          [[1, '101', 'nav prev', true], [2, '103', 'nav next', true], [3, '103', 'flag advance', true]]);
      } finally {
        c.stop();
      }
    });
  });

  test('the greeting forgets the stale g, so a reconnected deck may number from 1 again; a hello greets too', async () => {
    await withMock({ clock: 'manual', scenario: THREE }, async (mock) => {
      let c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 }), ['ack 1']);
        await line(mock, c, { t: 'nav', v: 'next' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 1 }), ['err stale']);
        c.stop();
        assert.ok(await waitUntil(() => !mock.control.clients().cmd && !mock.control.clients().evt, 2000), 'Lightroom saw the deck go');
        c = await ready(mock);
        assert.equal(mock.control.state().staleG, null);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: -0.3, g: 1 }), ['ack 1'], 'the restarted deck\'s first gesture');

        await line(mock, c, { t: 'nav', v: 'next' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.2, g: 1 }), ['err stale']);
        await line(mock, c, { t: 'hello', v: 1, client: 'test', ver: '0.1.0' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.2, g: 1 }), ['ack 1'], 'after a hello');
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.5, 102: -0.3, 103: 0.2 });
      } finally {
        c.stop();
      }
    });
  });
});

// PROTOCOL.md, Guard: the order of checks for a write is fields (bad), the guard (guard), for set and reset a
// stale gesture or photo (stale) then a locked photo (locked), the switch to Develop if needed (noDevelop),
// then the target photo and param (noPhoto, bad, notFound). The plugin can check a param only in Develop,
// where getRange works.
describe('mock Lightroom: the order of checks for writes', () => {
  const errs = (c, t) => since(c, t, 'err').map((m) => `${m.cmd} ${m.code}`);

  test('fields first, then the guard: an unknown param or preset is no field error, and nothing switches', async () => {
    await withMock({ clock: 'manual', scenario: { ...loadScenario(), catalog: MAIN, module: 'library' } }, async (mock) => {
      const c = await ready(mock);
      try {
        const before = mock.control.state();
        const t = now();
        for (const cmd of [
          { t: 'set', v: 1, g: 1 },
          { t: 'set', p: 'NoSuchSlider', v: 1, g: 1 },
          { t: 'reset', p: 'NoSuchSlider' },
          { t: 'preset', id: 5, uuid: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' },
        ]) await line(mock, c, cmd);
        assert.deepEqual(errs(c, t), ['set bad', 'set guard', 'reset guard', 'preset guard']);
        const s = mock.control.state();
        assert.deepEqual([s.module, s.photos, s.history], [before.module, before.photos, []]);
      } finally {
        c.stop();
      }
    });
  });

  test('the guard comes before a stale gesture', async () => {
    await withMock({ clock: 'manual', scenario: { ...loadScenario(), catalog: MAIN } }, async (mock) => {
      mock.control.options({ guard: false });
      const c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 }), ['ack 1']);
        await line(mock, c, { t: 'nav', v: 'next' });
        assert.equal(mock.control.state().staleG, 1);
        mock.control.options({ guard: true });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 1 }), ['err guard']);
      } finally {
        c.stop();
      }
    });
  });

  test('a ph that isn\'t a string is a field error, before the guard; the guard comes before a wrong ph and a locked photo', async () => {
    await withMock({ clock: 'manual', scenario: { ...loadScenario(), catalog: MAIN } }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ locked: ['101'] });
        await mock.control.step();
        const t = now();
        for (const cmd of [
          { t: 'set', p: 'Exposure', v: 1, g: 1, ph: 101 },
          { t: 'reset', p: 'Exposure', ph: 101 },
          { t: 'set', p: 'Exposure', v: 1, g: 1, ph: '102' },
          { t: 'reset', p: 'Exposure', ph: '102' },
          { t: 'set', p: 'Exposure', v: 1, g: 2, ph: '101' },
          { t: 'reset', p: 'Exposure', ph: '101' },
        ]) await line(mock, c, cmd);
        assert.deepEqual(errs(c, t), ['set bad', 'reset bad', 'set guard', 'reset guard', 'set guard', 'reset guard']);
        const s = mock.control.state();
        assert.deepEqual([s.staleG, s.history, s.photos[101].values.Exposure], [null, [], 0.35], 'no stale g, and nothing changed');
      } finally {
        c.stop();
      }
    });
  });

  test('a stale gesture or photo comes before a locked photo', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1, ph: '101' }), ['ack 1']);
        await line(mock, c, { t: 'nav', v: 'next' });
        mock.control.user({ locked: ['102'] });
        await mock.control.step();
        assert.deepEqual(mock.control.state().lockRead, { photo: '102', locked: true });
        const t = now();
        for (const cmd of [
          { t: 'set', p: 'Exposure', v: 0.6, g: 1, ph: '102' }, // its gesture ended with nav
          { t: 'set', p: 'Exposure', v: 0.6, g: 2, ph: '101' }, // worked out on 101
          { t: 'reset', p: 'Exposure', ph: '101' },
          { t: 'set', p: 'Exposure', v: 0.6, g: 3, ph: '102' },
          { t: 'reset', p: 'Exposure', ph: '102' },
        ]) await line(mock, c, cmd);
        assert.deepEqual(errs(c, t), ['set stale', 'set stale', 'reset stale', 'set locked', 'reset locked']);
        assert.deepEqual([mock.control.state().photos[102].values.Exposure, mock.control.state().staleG], [-0.2, 2]);
      } finally {
        c.stop();
      }
    });
  });

  test('a locked photo comes before the switch to Develop and the param', async () => {
    await withMock({ clock: 'manual', scenario: { ...loadScenario(), module: 'library' } }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ locked: ['101'] });
        await mock.control.step();
        const t = now();
        await line(mock, c, { t: 'set', p: 'NoSuchSlider', v: 1, g: 1, ph: '101' });
        await line(mock, c, { t: 'reset', p: 'NoSuchSlider' });
        assert.deepEqual(errs(c, t), ['set locked', 'reset locked']);
        const s = mock.control.state();
        assert.deepEqual([s.module, s.history, s.tracking], ['library', [], false], 'nothing switched to Develop');
      } finally {
        c.stop();
      }
    });
  });

  test('a stale gesture comes before the switch to Develop, the photo and the param', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1 }), ['ack 1']);
        await line(mock, c, { t: 'module', v: 'library' });
        mock.control.user({ selected: [] });
        await mock.control.step();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'NoSuchSlider', v: 1, g: 1 }), ['err stale']);
        assert.equal(mock.control.state().module, 'library');
      } finally {
        c.stop();
      }
    });
  });

  test('the switch to Develop comes before the target photo and the param', async () => {
    await withMock({ clock: 'manual', scenario: { ...loadScenario(), module: 'library' } }, async (mock) => {
      const c = await ready(mock);
      try {
        const t = now();
        await line(mock, c, { t: 'set', p: 'NoSuchSlider', v: 1, g: 1 });
        assert.equal(mock.control.state().module, 'develop', 'set switched to Develop, then found the param unknown');
        await line(mock, c, { t: 'module', v: 'library' });
        mock.control.user({ selected: [] });
        await line(mock, c, { t: 'set', p: 'Exposure', v: 1, g: 2 });
        assert.equal(mock.control.state().module, 'develop', 'set switched to Develop, then found no photo');
        await line(mock, c, { t: 'module', v: 'library' });
        await line(mock, c, { t: 'reset', p: 'Exposure' });
        assert.equal(mock.control.state().module, 'develop', 'reset switched to Develop, then found no photo');
        // In Develop with no photo, noPhoto comes before an unknown param.
        await line(mock, c, { t: 'set', p: 'NoSuchSlider', v: 1, g: 3 });
        await line(mock, c, { t: 'reset', p: 'NoSuchSlider' });
        assert.deepEqual(errs(c, t), ['set bad', 'set noPhoto', 'reset noPhoto', 'set noPhoto', 'reset noPhoto']);
        const s = mock.control.state();
        assert.deepEqual([s.history, s.tracking, s.photos[101].values.Exposure], [[], false, 0.35], 'nothing else changed');
        assert.equal(since(c, t, 'state').at(-1).sel, 0, 'state.sel is 0 without a target photo');
      } finally {
        c.stop();
      }
    });
  });

  test('preset: the target photo before the preset', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ selected: [] });
        const t = now();
        await line(mock, c, { t: 'preset', id: 6, uuid: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' });
        assert.deepEqual(since(c, t, 'err').map((m) => [m.id, m.code]), [[6, 'noPhoto']]);
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Guard: reload "is refused at the same times, because it can swap the write handlers".
  test('reload is refused while writes would be, with the plugin\'s reason, and changes nothing', async () => {
    await withMock({ clock: 'manual', scenario: { ...loadScenario(), catalog: MAIN } }, async (mock) => {
      const c = await ready(mock);
      try {
        const msg = "reload is off while writes are: the test catalog isn't open";
        const all = await c.request({ t: 'reload' }, 1000);
        assert.deepEqual(pick(all.reply, ['t', 'mods', 'ok', 'msg']), {
          t: 'reloaded', mods: ['Proto', 'Develop', 'Poll', 'Library', 'Presets', 'Dispatch', 'Core', 'Reload'], ok: false, msg,
        });
        const some = await c.request({ t: 'reload', mods: ['Develop', 'Server'] }, 1000);
        assert.deepEqual(pick(some.reply, ['mods', 'ok', 'msg']), { mods: ['Develop', 'Server'], ok: false, msg }, 'the guard comes before the names');
        const bad = await c.request({ t: 'reload', mods: 'Develop' }, 1000);
        assert.deepEqual(pick(bad.reply, ['t', 'cmd', 'code']), { t: 'err', cmd: 'reload', code: 'bad' }, 'fields come first');
        mock.control.options({ guard: false });
        const off = await c.request({ t: 'reload', mods: ['Develop'] }, 1000);
        assert.deepEqual(pick(off.reply, ['ok', 'msg']), { ok: true, msg: 'reloaded Develop' }, 'with the guard off, writes and reload go through');
      } finally {
        c.stop();
      }
    });
  });
});

// PROTOCOL.md, Gestures: "The photo the deck worked from". set and reset carry ph, the photo from the deck's
// latest state. One that isn't the target photo is stale and changes nothing, and a set's g stays stale.
describe('mock Lightroom: the photo the deck worked from (ph)', () => {
  const TWO = {
    module: 'develop',
    photos: [
      { id: '101', file: 'A.ARW', fmt: 'RAW', values: { Exposure: 0.35, Contrast: 0 } },
      { id: '102', file: 'B.ARW', fmt: 'RAW', values: { Exposure: -0.4, Contrast: 5 } },
    ],
    watch: ['Exposure', 'Contrast'],
  };
  const values = (mock, p) => Object.fromEntries(['101', '102'].map((id) => [id, mock.control.state().photos[id].values[p]]));

  test('a new gesture worked out on the old photo, before its state reached the deck, is refused, and its g stays stale', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ photo: '102' }); // the poll hasn't run, so no state has said so
        const t = now();
        await lineNow(mock, c, { t: 'set', p: 'Exposure', v: 0.4, g: 1, ph: '101', id: 3 });
        assert.deepEqual(since(c, t).map((m) => pick(m, ['t', 'id', 'cmd', 'code'])), [{ t: 'err', id: 3, cmd: 'set', code: 'stale' }]);
        let s = mock.control.state();
        assert.deepEqual([s.tracking, s.staleG, s.history], [false, 1, []], 'no gesture started, and g 1 is stale');
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.35, 102: -0.4 });

        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: -0.3, g: 1, ph: '102' }), ['err stale'], 'g 1 stays stale with the right ph');
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: -0.3, g: 2, ph: '102' }), ['ack 2']);
        s = mock.control.state();
        assert.deepEqual([s.staleG, s.gesture], [null, { p: 'Exposure', g: 2, photo: '102' }]);
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.35, 102: -0.3 });
      } finally {
        c.stop();
      }
    });
  });

  test('a wrong ph changes nothing: not a value, the module, or an open gesture', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Contrast', v: 9, g: 1, ph: '101' }), ['ack 1']);
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Contrast', ph: '102' }), ['err stale']);
        let s = mock.control.state();
        assert.deepEqual([s.gesture, s.staleG, s.history], [{ p: 'Contrast', g: 1, photo: '101' }, null, []], 'a reset has no g to make stale, and ends no gesture');
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 1, g: 5, ph: '102' }), ['err stale']);
        s = mock.control.state();
        assert.deepEqual([s.gesture, s.staleG], [{ p: 'Contrast', g: 1, photo: '101' }, 5], 'the open gesture is left alone');
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Contrast', v: 10, g: 1, ph: '101' }), ['ack 1'], 'and goes on');
        assert.deepEqual(values(mock, 'Contrast'), { 101: 10, 102: 5 });

        // In Library, nothing switches to Develop.
        await line(mock, c, { t: 'done', g: 1 });
        mock.control.user({ module: 'library' });
        await mock.control.step();
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Contrast', ph: '102' }), ['err stale']);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Contrast', v: 3, g: 2, ph: '102' }), ['err stale']);
        s = mock.control.state();
        assert.equal(s.module, 'library');
        assert.deepEqual(values(mock, 'Contrast'), { 101: 10, 102: 5 });
        assert.deepEqual(s.history.map((h) => [h.kind, h.g, h.why]), [['gesture', 1, 'done']]);
      } finally {
        c.stop();
      }
    });
  });

  // The set first ends the gesture the photo moved away from, as the poll would have, and only then finds its ph
  // wrong. So the gesture doesn't track the old photo until the next poll, and the observer that stopTracking
  // fires sends the deck the new photo's state within ms.
  test('a set with the old photo\'s ph, for a gesture the photo moved away from, ends that gesture first: the observer sends the new photo\'s state at once', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.4, g: 1, ph: '101' }), ['ack 1']);
        mock.control.holdPoll(1000); // the poll notices nothing by itself
        mock.control.user({ photo: '102' });
        const t = now();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.45, g: 1, ph: '101' }, lineNow), ['err stale']);
        const s = mock.control.state();
        assert.deepEqual([s.tracking, s.staleG], [false, 1]);
        assert.deepEqual(s.history.map((h) => pick(h, ['kind', 'g', 'photo', 'to', 'why', 'stale'])), [{ kind: 'gesture', g: 1, photo: '101', to: 0.4, why: 'the photo changed', stale: true }]);
        await mock.control.advance(TIMING.observerMs);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t, 'state').map((m) => m.photo), ['102'], 'from the observer, with the poll held');
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.4, 102: -0.4 });
      } finally {
        c.stop();
      }
    });
  });

  test('with no target photo, every ph is wrong', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ selected: [] });
        await mock.control.step();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 1, g: 1, ph: '101' }), ['err stale']);
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph: '101' }), ['err stale']);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 1, g: 2 }), ['err noPhoto'], 'without ph, noPhoto as before');
        assert.equal(mock.control.state().staleG, 1);
      } finally {
        c.stop();
      }
    });
  });

  test('without ph nothing is checked, so older decks still work; null counts as no ph, as the plugin decodes it', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ photo: '102' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.4, g: 1 }, lineNow), ['ack 1'], 'a new gesture lands on the target photo');
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Contrast' }, lineNow), ['ack']);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 2, ph: null }, lineNow), ['ack 2']);
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph: null }, lineNow), ['ack']);
        assert.deepEqual(values(mock, 'Exposure'), { 101: 0.35, 102: 0 });
        assert.deepEqual(values(mock, 'Contrast'), { 101: 0, 102: 0 });
        for (const ph of [102, true, ['102'], { id: '102' }]) {
          assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 1, g: 3, ph }), ['err bad'], `set with ph ${JSON.stringify(ph)}`);
          assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph }), ['err bad'], `reset with ph ${JSON.stringify(ph)}`);
        }
        assert.equal(mock.control.state().staleG, null, 'a field error leaves no stale g');
      } finally {
        c.stop();
      }
    });
  });
});

// PROTOCOL.md, Locked photos: the poll reads isAvailableForEditing() for the target photo, state.locked carries
// that reading, and set and reset go by it.
describe('mock Lightroom: locked photos', () => {
  const TWO = {
    module: 'develop',
    photos: [
      { id: '101', file: 'A.ARW', fmt: 'RAW', values: { Exposure: 0.35, Contrast: 0 } },
      { id: '102', file: 'B.ARW', fmt: 'RAW', values: { Exposure: -0.4, Contrast: 5 } },
    ],
    watch: ['Exposure', 'Contrast'],
  };

  test('state.locked carries the poll\'s reading for the target photo, and is false without one', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        assert.equal(c.history.find((h) => h.msg.t === 'state').msg.locked, false, 'the greeting\'s state');
        const t = now();
        for (const action of [{ locked: ['101'] }, { photo: '102' }, { photo: '101' }, { selected: [] }, { photo: '101' }, { locked: [] }]) {
          mock.control.user(action);
          await mock.control.step();
        }
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t, 'state').map((m) => `${m.photo} ${m.locked}`), ['101 true', '102 false', '101 true', 'null false', '101 true', '101 false']);
      } finally {
        c.stop();
      }
    });
  });

  test('set and reset on a locked photo get err locked and change nothing: not a value, the module, or an open gesture', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1, ph: '101' }), ['ack 1']);
        mock.control.user({ locked: ['101'] });
        await mock.control.step();
        const t = now();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 1, ph: '101' }), ['err locked']);
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph: '101', id: 4 }), ['err locked']);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Contrast', v: 3, g: 2 }), ['err locked'], 'without ph too');
        assert.deepEqual(pick(since(c, t, 'err')[1], ['id', 'cmd', 'code']), { id: 4, cmd: 'reset', code: 'locked' });
        let s = mock.control.state();
        assert.deepEqual([s.gesture, s.staleG], [{ p: 'Exposure', g: 1, photo: '101' }, null], 'the open gesture is left alone, and no g is stale');
        assert.deepEqual([s.photos[101].values.Exposure, s.photos[101].values.Contrast], [0.5, 0]);

        await line(mock, c, { t: 'done', g: 1 });
        mock.control.user({ module: 'library' });
        await mock.control.step();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 3, ph: '101' }), ['err locked']);
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph: '101' }), ['err locked']);
        s = mock.control.state();
        assert.equal(s.module, 'library', 'nothing switched to Develop');
        assert.deepEqual(s.history.map((h) => [h.kind, h.g, h.to]), [['gesture', 1, 0.5]]);
      } finally {
        c.stop();
      }
    });
  });

  test('set and reset go by the poll\'s reading: a write still lands before the poll reads a lock, and waits for it to read the unlock', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ locked: ['101'] });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.5, g: 1, ph: '101' }, lineNow), ['ack 1'], 'the poll hasn\'t read the lock yet');
        await mock.control.step();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 1, ph: '101' }, lineNow), ['err locked']);
        mock.control.user({ locked: [] });
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph: '101' }, lineNow), ['err locked'], 'nor the unlock');
        await mock.control.step();
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 2, ph: '101' }, lineNow), ['ack 2']);
        assert.equal(mock.control.state().photos[101].values.Exposure, 0.6);
      } finally {
        c.stop();
      }
    });
  });

  test('a reading counts only for the photo it was taken for, either way: a target the poll hasn\'t read yet is unlocked', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ locked: ['102'] });
        await mock.control.step();
        assert.deepEqual(mock.control.state().lockRead, { photo: '101', locked: false });
        mock.control.user({ photo: '102' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.1, g: 1 }, lineNow), ['ack 1'], 'the reading is still 101\'s');
        await mock.control.step();
        assert.deepEqual(mock.control.state().lockRead, { photo: '102', locked: true });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.2, g: 1 }, lineNow), ['err locked']);
        assert.equal(mock.control.state().photos[102].values.Exposure, 0.1);

        // The other way round: 102's locked reading doesn't hold for 101, so back there a set and a reset land
        // before the poll reads 101.
        mock.control.user({ photo: '101' });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Contrast', v: 7, g: 2 }, lineNow), ['ack 2']);
        assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure' }, lineNow), ['ack']);
        const s = mock.control.state();
        assert.deepEqual(s.lockRead, { photo: '102', locked: true }, 'the poll still hasn\'t read 101');
        assert.deepEqual([s.photos[101].values.Contrast, s.photos[101].values.Exposure], [7, 0]);
      } finally {
        c.stop();
      }
    });
  });

  // With several photos selected, the target is the first, and only its reading counts: a locked photo elsewhere
  // in the selection mustn't lock up the dials, which change the target photo only.
  test('a locked photo in a multi-selection: state.locked follows the target photo, and a set on it lands', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        const t = now();
        mock.control.user({ selected: ['108', '107'] }); // the default scenario's 107 is locked
        await mock.control.step();
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t, 'state').map((m) => pick(m, ['photo', 'sel', 'locked'])), [{ photo: '108', sel: 2, locked: false }]);
        assert.deepEqual(mock.control.state().lockRead, { photo: '108', locked: false });
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: -0.3, g: 1, ph: '108' }), ['ack 1']);
        assert.deepEqual([mock.control.state().photos[108].values.Exposure, mock.control.state().photos[107].values.Exposure], [-0.3, 0.25]);
      } finally {
        c.stop();
      }
    });
  });

  // nav's own state, and a flag's advance's, come from the mock reading the state (refresh), which reads the lock
  // too: they can't wait for the next poll, or the deck's next set would land on the locked photo.
  test('moving onto a locked photo with nav: nav\'s own state says locked, and a set straight after gets err locked', async () => {
    await withMock({ clock: 'manual', scenario: TWO }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ locked: ['102'] });
        await mock.control.step();
        const t = now();
        await lineNow(mock, c, { t: 'nav', v: 'next' });
        assert.deepEqual(since(c, t, 'state').map((m) => pick(m, ['photo', 'locked'])), [{ photo: '102', locked: true }], 'before any poll');
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.1, g: 1, ph: '102' }, lineNow), ['err locked']);
        assert.equal(mock.control.state().photos[102].values.Exposure, -0.4);
      } finally {
        c.stop();
      }
    });
  });

  test('flag isn\'t checked, and a preset skips locked photos and counts them', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.user({ selected: ['107', '108'] }); // the default scenario's 107 is locked
        await mock.control.step();
        const t = now();
        await line(mock, c, { t: 'flag', v: 'pick' });
        assert.deepEqual(since(c, t, 'state').map((m) => [m.photo, m.flag, m.locked]).at(-1), ['107', 1, true]);
        const r = await c.request({ t: 'preset', uuid: PUNCHY }, 1000);
        assert.deepEqual(pick(r.reply, ['t', 'n', 'locked']), { t: 'applied', n: 1, locked: 1 });
        assert.deepEqual(mock.control.state().photos[107].applied, []);
      } finally {
        c.stop();
      }
    });
  });

  test('the user line {locked}: exactly these photos, and [] for none; anything else is a setup error that changes nothing', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const lockedIds = () => Object.entries(mock.control.state().photos).filter(([, p]) => p.locked).map(([id]) => id);
      assert.deepEqual(lockedIds(), ['107']);
      mock.control.user({ locked: ['101', 103] });
      assert.deepEqual(lockedIds(), ['101', '103'], 'numbers are ids too, and 107 is unlocked');
      mock.control.user({ locked: [] });
      assert.deepEqual(lockedIds(), []);
      assert.throws(() => mock.control.user({ locked: '101' }), /locked must be a list of photo ids/);
      assert.throws(() => mock.control.user({ locked: ['101', '999'] }), /no photo 999/);
      assert.deepEqual(lockedIds(), []);
      mock.control.options({ lock: { 104: true } });
      mock.control.options({ lock: { 105: true } });
      assert.deepEqual(lockedIds(), ['104', '105'], 'options({ lock }) changes one photo at a time');
    });
  });
});

// The control calls deck-vs-mock scenarios use beyond the fixture lines (lightroom/tools/README.md).
describe('mock Lightroom: control calls for deck scenarios', () => {
  const LIB = {
    module: 'library',
    photos: [{ id: '1', file: 'A.ARW', fmt: 'RAW', values: { Exposure: 0.35 } }],
    watch: ['Exposure'],
  };
  const kinds = (list) => list.map((m) => (m.t === 'state' ? `state ${m.module}` : m.t === 'err' ? `err ${m.code}` : m.t));

  test('protocolVersion: hello says another v, on connect and in answer to hello, across setup()', async () => {
    const logs = [];
    await withMock({ clock: 'manual', log: (kind, text) => logs.push({ kind, text }) }, async (mock) => {
      mock.control.options({ protocolVersion: 2 });
      const c = await ready(mock);
      try {
        assert.equal(c.history.find((h) => h.msg.t === 'hello').msg.v, 2, 'the greeting on connect');
        let t = now();
        await line(mock, c, { t: 'hello', v: 1, client: 'test', ver: '0.1.0' });
        assert.deepEqual(since(c, t, 'hello').map((m) => m.v), [2]);
        assert.ok(logs.some((l) => l.kind === 'warn' && l.text === 'the deck speaks protocol v1; this plugin speaks v2'), JSON.stringify(logs.filter((l) => l.kind === 'warn')));
        mock.control.setup(loadScenario());
        t = now();
        await line(mock, c, { t: 'hello', v: 1, client: 'test', ver: '0.1.0' });
        assert.deepEqual(since(c, t, 'hello').map((m) => m.v), [2], 'setup() keeps it');
        mock.control.options({ protocolVersion: 1 });
        t = now();
        await line(mock, c, { t: 'hello', v: 1, client: 'test', ver: '0.1.0' });
        assert.deepEqual(since(c, t, 'hello').map((m) => m.v), [1]);
      } finally {
        c.stop();
      }
    });
  });

  test('catalog: started in another catalog, hello says writable false and every write is refused', async () => {
    await withMock({ clock: 'manual', catalog: MAIN }, async (mock) => {
      const c = await ready(mock);
      try {
        const hello = c.history.find((h) => h.msg.t === 'hello').msg;
        assert.deepEqual(pick(hello, ['catalog', 'path', 'guard', 'writable']), { catalog: 'Main.lrcat', path: MAIN, guard: 'on', writable: false });
        const t = now();
        for (const cmd of [
          { t: 'set', p: 'Exposure', v: 1, g: 1, ph: '101' },
          { t: 'reset', p: 'Exposure', ph: '101' },
          { t: 'flag', v: 'pick' },
          { t: 'preset', id: 2, uuid: PUNCHY },
        ]) await line(mock, c, cmd);
        assert.deepEqual(since(c, t, 'err').map((m) => `${m.cmd} ${m.code}`), ['set guard', 'reset guard', 'flag guard', 'preset guard']);
        assert.equal((await c.request({ t: 'reload' }, 1000)).reply.ok, false);
        const s = mock.control.state();
        assert.deepEqual([s.history, s.bezels, s.photos[101].values.Exposure, s.order.length], [[], 1, 0.35, 10], 'one bezel in 5 s, nothing changed, and otherwise the default scenario');
      } finally {
        c.stop();
      }
    });
  });

  test('moduleDelayMs: module develop answers once the switch lands, and lines queue behind it, all but ping', async () => {
    await withMock({ clock: 'manual', scenario: LIB }, async (mock) => {
      mock.control.options({ moduleDelayMs: 600 });
      const c = await ready(mock);
      try {
        const t = now();
        c.send({ t: 'module', v: 'develop' });
        c.send({ t: 'set', p: 'Exposure', v: 0.5, g: 1, ph: '1' });
        c.send({ t: 'presets', id: 6 });
        c.send({ t: 'ping', id: 5 });
        c.send({ t: 'explode' });
        assert.ok(await c.waitOks());
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['pong', 'err unknown'], 'ping and a line the plugin can\'t route, at once');
        assert.deepEqual(pick(mock.control.state(), ['module', 'switching', 'waiting']), { module: 'library', switching: 'develop', waiting: 'develop' });
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['pong', 'err unknown', 'state develop', 'ranges', 'vals', 'ack', 'presets'], 'the rest in order, once the switch landed');
        assert.deepEqual(pick(mock.control.state(), ['module', 'switching', 'waiting']), { module: 'develop', switching: null, waiting: null });
        assert.equal(mock.control.state().photos[1].values.Exposure, 0.5);
      } finally {
        c.stop();
      }
    });
  });

  test('moduleDelayMs beyond the plugin\'s 1 s wait: err noDevelop, then the switch lands and the poll reports it', async () => {
    await withMock({ clock: 'manual', scenario: LIB }, async (mock) => {
      mock.control.options({ moduleDelayMs: 2500 });
      const c = await ready(mock);
      try {
        const t = now();
        c.send({ t: 'module', v: 'develop', id: 7 });
        assert.ok(await c.waitOks());
        await mock.control.advance(TIMING.moduleWaitMs);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t).map((m) => pick(m, ['t', 'id', 'cmd', 'code'])), [{ t: 'err', id: 7, cmd: 'module', code: 'noDevelop' }]);
        assert.equal(mock.control.state().module, 'library');
        const t2 = now();
        await mock.control.advance(1800);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t2)), ['state develop', 'ranges', 'vals'], 'the poll noticed Develop');
      } finally {
        c.stop();
      }
    });
  });

  // Library.switchTo asks Lightroom for nothing when it's already in the module, so it can't call off a switch.
  test('moduleDelayMs: module library while a switch to Develop is on its way answers at once, and that switch still lands', async () => {
    await withMock({ clock: 'manual', scenario: LIB }, async (mock) => {
      mock.control.options({ moduleDelayMs: 2500 });
      const c = await ready(mock);
      try {
        const t = now();
        c.send({ t: 'module', v: 'develop' });
        c.send({ t: 'module', v: 'library' });
        assert.ok(await c.waitOks());
        await mock.control.advance(2400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['err noDevelop', 'state library'], 'library answers once the develop handler gives up');
        assert.deepEqual(pick(mock.control.state(), ['module', 'switching']), { module: 'library', switching: 'develop' });
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['err noDevelop', 'state library', 'state develop', 'ranges', 'vals'], 'the poll reports Develop');
        assert.deepEqual(pick(mock.control.state(), ['module', 'switching']), { module: 'develop', switching: null });
      } finally {
        c.stop();
      }
    });
  });

  test('moduleWaitMs above moduleDelayMs: nothing at all comes back until the switch lands, as the deck\'s 2 s drop of held ticks needs', async () => {
    await withMock({ clock: 'manual', scenario: LIB }, async (mock) => {
      mock.control.options({ moduleDelayMs: 2500, moduleWaitMs: 3000 });
      const c = await ready(mock);
      try {
        const t = now();
        c.send({ t: 'module', v: 'develop' });
        assert.ok(await c.waitOks());
        await mock.control.advance(2400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t), []);
        await mock.control.advance(200);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['state develop', 'ranges', 'vals']);
      } finally {
        c.stop();
      }
    });
  });

  test('moduleDelayMs: set, reset and view outside Develop wait for the switch too, or get err noDevelop and change nothing', async () => {
    await withMock({ clock: 'manual', scenario: LIB }, async (mock) => {
      mock.control.options({ moduleDelayMs: 300 });
      const c = await ready(mock);
      try {
        let t = now();
        c.send({ t: 'set', p: 'Exposure', v: 0.5, g: 1, ph: '1' });
        assert.ok(await c.waitOks());
        await mock.control.advance(200);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t), [], 'still switching');
        await mock.control.advance(200);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['state develop', 'ranges', 'vals', 'ack']);

        await line(mock, c, { t: 'done', g: 1 });
        mock.control.user({ module: 'library' });
        await mock.control.step();
        assert.ok(await synced(mock, c));
        mock.control.options({ moduleDelayMs: 1500 });
        t = now();
        c.send({ t: 'reset', p: 'Exposure', ph: '1', id: 8 });
        c.send({ t: 'view', v: 'before' });
        assert.ok(await c.waitOks());
        await mock.control.advance(TIMING.moduleWaitMs);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t).map((m) => pick(m, ['t', 'id', 'cmd', 'code'])), [{ t: 'err', id: 8, cmd: 'reset', code: 'noDevelop' }]);
        assert.deepEqual(pick(mock.control.state(), ['module', 'view', 'waiting']), { module: 'library', view: 'loupe', waiting: 'develop' }, 'view waits for the same switch');
        await mock.control.advance(600);
        assert.ok(await synced(mock, c));
        assert.deepEqual(pick(mock.control.state(), ['module', 'view', 'waiting']), { module: 'develop', view: 'before', waiting: null }, 'which keeps its time: 1.5 s after the reset asked');
        const s = mock.control.state();
        assert.equal(s.photos[1].values.Exposure, 0.5, 'the reset changed nothing');
        assert.deepEqual(s.history.map((h) => h.kind), ['gesture']);
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Gestures (the photo the deck worked from): a set or reset that makes Lightroom switch to Develop
  // reads the target photo again once there, as the plugin does (Develop.set and Develop.reset). Another photo by then
  // is stale, with or without ph, and makes a set's g stale; a lock the poll read meanwhile is locked. Either way
  // nothing changes but the module.
  const TWO_LIB = { ...LIB, photos: [...LIB.photos, { id: '2', file: 'B.ARW', values: { Exposure: -1 } }] };

  test('moduleDelayMs: another photo picked during the switch to Develop: the set gets err stale, with or without ph, and its g stays stale; only the module changed', async () => {
    for (const ph of ['1', undefined]) {
      await withMock({ clock: 'manual', scenario: TWO_LIB }, async (mock) => {
        mock.control.options({ moduleDelayMs: 300 });
        const c = await ready(mock);
        const what = ph ? 'with ph' : 'without ph';
        try {
          const t = now();
          c.send({ t: 'set', id: 3, p: 'Exposure', v: 0.5, g: 1, ...(ph ? { ph } : {}) });
          assert.ok(await c.waitOks());
          mock.control.user({ photo: '2' });
          await mock.control.advance(300);
          assert.ok(await synced(mock, c));
          assert.deepEqual(kinds(since(c, t)), ['state library', 'state develop', 'ranges', 'vals', 'err stale'], what);
          assert.deepEqual(pick(since(c, t, 'err')[0], ['id', 'cmd', 'code']), { id: 3, cmd: 'set', code: 'stale' }, what);
          const s = mock.control.state();
          assert.deepEqual(pick(s, ['module', 'tracking', 'gesture', 'staleG']), { module: 'develop', tracking: false, gesture: null, staleG: 1 }, `${what}: Lightroom stays in Develop, with no gesture, and g 1 is stale`);
          assert.deepEqual([s.photos[1].values.Exposure, s.photos[2].values.Exposure, s.history], [0.35, -1, []], `${what}: no value changed`);
          assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 1, ph: '2' }), ['err stale'], `${what}: from then on, even with the right photo`);
          assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.6, g: 2, ph: '2' }), ['ack 2'], `${what}: the deck's next gesture`);
          assert.deepEqual([mock.control.state().photos[1].values.Exposure, mock.control.state().photos[2].values.Exposure], [0.35, 0.6], what);
        } finally {
          c.stop();
        }
      });
    }
  });

  test('moduleDelayMs: another photo picked during the switch to Develop: the reset gets err stale, with or without ph, and nothing resets', async () => {
    for (const ph of ['1', undefined]) {
      await withMock({ clock: 'manual', scenario: TWO_LIB }, async (mock) => {
        mock.control.options({ moduleDelayMs: 300 });
        const c = await ready(mock);
        const what = ph ? 'with ph' : 'without ph';
        try {
          const t = now();
          c.send({ t: 'reset', id: 4, p: 'Exposure', ...(ph ? { ph } : {}) }); // a dial press in Library
          assert.ok(await c.waitOks());
          mock.control.user({ photo: '2' });
          await mock.control.advance(300);
          assert.ok(await synced(mock, c));
          assert.deepEqual(kinds(since(c, t)), ['state library', 'state develop', 'ranges', 'vals', 'err stale'], what);
          assert.deepEqual(pick(since(c, t, 'err')[0], ['id', 'cmd', 'code']), { id: 4, cmd: 'reset', code: 'stale' }, what);
          const s = mock.control.state();
          assert.deepEqual(pick(s, ['module', 'staleG']), { module: 'develop', staleG: null }, `${what}: Lightroom stays in Develop, and a reset makes no g stale`);
          assert.deepEqual([s.photos[1].values.Exposure, s.photos[2].values.Exposure, s.history], [0.35, -1, []], `${what}: nothing reset`);
          assert.deepEqual(await answers(mock, c, { t: 'reset', p: 'Exposure', ph: '2' }), ['ack'], `${what}: the next press, in Develop, resets photo 2`);
          assert.deepEqual([mock.control.state().photos[1].values.Exposure, mock.control.state().photos[2].values.Exposure], [0.35, 0], what);
        } finally {
          c.stop();
        }
      });
    }
  });

  test('moduleDelayMs: a lock the poll read during the switch to Develop: set and reset get err locked, and only the module changed', async () => {
    for (const cmd of [
      { t: 'set', id: 5, p: 'Exposure', v: 0.5, g: 1, ph: '1' },
      { t: 'reset', id: 5, p: 'Exposure', ph: '1' },
      { t: 'set', id: 5, p: 'Exposure', v: 0.5, g: 1 },
      { t: 'reset', id: 5, p: 'Exposure' },
    ]) {
      await withMock({ clock: 'manual', scenario: TWO_LIB }, async (mock) => {
        mock.control.options({ moduleDelayMs: 300 });
        const c = await ready(mock);
        const what = `${cmd.t} ${cmd.ph ? 'with' : 'without'} ph`;
        try {
          const t = now();
          c.send(cmd);
          assert.ok(await c.waitOks());
          mock.control.user({ locked: ['1'] }); // Denoise starts on photo 1 while Lightroom switches
          await mock.control.step(); // and the poll reads it before the switch lands
          assert.ok(await synced(mock, c));
          assert.deepEqual(since(c, t).map((m) => `${m.t} ${m.module} ${m.locked}`), ['state library true'], `${what}: the poll read the lock; no answer yet`);
          await mock.control.advance(200);
          assert.ok(await synced(mock, c));
          assert.deepEqual(kinds(since(c, t)), ['state library', 'state develop', 'ranges', 'vals', 'err locked'], what);
          assert.deepEqual(pick(since(c, t, 'err')[0], ['id', 'cmd', 'code']), { id: 5, cmd: cmd.t, code: 'locked' }, what);
          const s = mock.control.state();
          assert.deepEqual(pick(s, ['module', 'tracking', 'staleG']), { module: 'develop', tracking: false, staleG: null }, `${what}: Lightroom stays in Develop, and no g is stale`);
          assert.deepEqual([s.photos[1].values.Exposure, s.history], [0.35, []], `${what}: nothing changed`);
        } finally {
          c.stop();
        }
      });
    }
  });

  test('holdPoll: a photo change stays unnoticed, so a set with the old photo\'s ph is refused before any state says so', async () => {
    await withMock({ clock: 'manual', scenario: { ...LIB, module: 'develop', photos: [...LIB.photos, { id: '2', file: 'B.ARW', values: { Exposure: -1 } }] } }, async (mock) => {
      const c = await ready(mock);
      try {
        const t = now();
        mock.control.holdPoll(600);
        mock.control.user({ photo: '2' });
        await mock.control.advance(400);
        assert.deepEqual(await answers(mock, c, { t: 'set', p: 'Exposure', v: 0.4, g: 1, ph: '1' }, lineNow), ['err stale']);
        assert.deepEqual([since(c, t, 'state'), mock.control.state().pollHeld], [[], true], 'no state for photo 2 yet');
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        assert.deepEqual([since(c, t, 'state').map((m) => m.photo), mock.control.state().pollHeld], [['2'], false]);
        assert.deepEqual([mock.control.state().photos[1].values.Exposure, mock.control.state().photos[2].values.Exposure], [0.35, -1]);
      } finally {
        c.stop();
      }
    });
  });

  // PROTOCOL.md, Locked photos: err locked answers a set the deck sent before state.locked reached it. The poll sends
  // state.locked as it reads the lock, so that window is the state's trip to the deck, which delayEvents widens.
  test('delayEvents: events reach the deck late and in order, so a set can meet err locked before the deck sees state.locked', async () => {
    await withMock({ clock: 'manual', scenario: LIB }, async (mock) => {
      const c = await ready(mock);
      try {
        mock.control.delayEvents(300);
        mock.control.user({ locked: ['1'] });
        await mock.control.step(); // the poll reads the lock, and its state is on its way
        const t = now();
        c.send({ t: 'set', p: 'Exposure', v: 0.5, g: 1, ph: '1' });
        assert.ok(await c.waitOks());
        await sleep(50);
        assert.deepEqual([since(c, t), mock.control.clients().delayed], [[], 2], 'nothing has reached the deck yet');
        await mock.control.advance(300);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t).map((m) => (m.t === 'state' ? `state locked ${m.locked}` : `err ${m.code}`)), ['state locked true', 'err locked']);

        // Back to 0 while an event is on its way: a new event no longer waits 300 ms, but it still goes after that one.
        mock.control.delayEvents(300);
        const t2 = now();
        c.send({ t: 'ping', id: 8 });
        assert.ok(await c.waitOks());
        await mock.control.advance(100);
        mock.control.delayEvents(0);
        c.send({ t: 'ping', id: 9 });
        assert.ok(await c.waitOks());
        await sleep(50);
        assert.deepEqual([since(c, t2), mock.control.clients().delayed], [[], 2], 'the pong for 9 waits behind the one for 8');
        await mock.control.advance(200);
        assert.ok(await synced(mock, c));
        assert.deepEqual(since(c, t2).map((m) => `${m.t} ${m.id}`), ['pong 8', 'pong 9']);
        const t3 = now();
        await lineNow(mock, c, { t: 'ping', id: 10 });
        assert.deepEqual(since(c, t3).map((m) => m.t), ['pong'], 'at once again');
      } finally {
        c.stop();
      }
    });
  });

  // The manual clock runs timers in order, but the real one, which deck-vs-mock runs on, needn't: Node truncates
  // each timer's delay to whole ms and keeps one list per duration. So the events wait in one queue, behind one
  // timer, and this checks the order where a timer per event let a later event overtake an earlier one.
  test('delayEvents keeps the order on the real clock too: hundreds of events 0.1 ms apart, and a switch back to 0 mid-stream', async () => {
    await withMock({ scenario: LIB }, async (mock) => {
      const c = await ready(mock);
      try {
        const pongs = [];
        c.on('m:pong', (m, at) => pongs.push({ id: m.id, at }));
        mock.control.delayEvents(20);
        const t = now();
        let queued = 0;
        for (let i = 1; i <= 600; i += 1) {
          if (i === 401) {
            queued = mock.control.clients().delayed;
            mock.control.delayEvents(0);
          }
          c.send({ t: 'ping', id: i });
          // Yields until the next ping is due, so the mock answers each one in a turn of the event loop of its own.
          while (now() < t + i * 0.1) await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(await waitUntil(() => pongs.length === 600, 3000, 5), `${pongs.length} of 600 pongs arrived`);
        assert.ok(queued > 0 && pongs[0].at - t >= 15, `${queued} events were on their way at the switch; the first pong took ${Math.round(pongs[0].at - t)} ms`);
        const overtaken = pongs.filter((p, i) => i > 0 && p.id < pongs[i - 1].id).map((p) => p.id);
        assert.deepEqual(overtaken, [], 'every pong came after the one for the ping before it');
        assert.equal(mock.control.clients().delayed, 0);
      } finally {
        c.stop();
      }
    });
  });

  test('nextPoll resolves just after the next poll, on either clock', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      let polled = false;
      const p = mock.control.nextPoll().then(() => { polled = true; });
      await mock.control.advance(100);
      assert.equal(polled, false);
      await mock.control.advance(100);
      await p;
      assert.equal(polled, true);
    });
    await withMock({}, async (mock) => {
      await mock.control.nextPoll();
      const first = now();
      await mock.control.nextPoll();
      const gap = now() - first;
      assert.ok(gap > TIMING.pollMs / 2 && gap < TIMING.pollMs * 2, `polls about ${TIMING.pollMs} ms apart: ${Math.round(gap)} ms`);
    });
  });

  test('a preset whose apply changes sliders: vals follow with the changed values, and a profile-only one sends none', async () => {
    await withMock({ clock: 'manual' }, async (mock) => {
      const c = await ready(mock);
      try {
        await line(mock, c, { t: 'watch', ps: ['Exposure', 'Contrast', 'Vibrance', 'Clarity'] });
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        let t = now();
        await line(mock, c, { t: 'preset', id: 3, uuid: PUNCHY });
        const got = since(c, t);
        assert.deepEqual(kinds(got), ['applied', 'vals']);
        assert.deepEqual(got[1].vals, { Contrast: 25, Vibrance: 20, Clarity: 10 }, 'only the sliders Punchy changes');
        t = now();
        await line(mock, c, { t: 'preset', id: 4, uuid: loadScenario().presets[0].uuid });
        await mock.control.advance(400);
        assert.ok(await synced(mock, c));
        assert.deepEqual(kinds(since(c, t)), ['applied']);
      } finally {
        c.stop();
      }
    });
  });
});
