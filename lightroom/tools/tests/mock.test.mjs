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

// Runs one command as line() does, and returns Lightroom's answers to it: "ack <g>" and "err <code>".
async function answers(mock, c, cmd, send = line) {
  const t = now();
  await send(mock, c, cmd);
  return since(c, t).filter((m) => m.t === 'ack' || m.t === 'err').map((m) => (m.t === 'ack' ? `ack ${m.g}` : `err ${m.code}`));
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

// PROTOCOL.md, Guard: "Order of checks for a write: fields (bad), the guard (guard), then for set a stale
// gesture (stale), the switch to Develop if needed (noDevelop), then the target photo and param (noPhoto,
// bad, notFound)." The plugin can check a param only in Develop, where getRange works.
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
