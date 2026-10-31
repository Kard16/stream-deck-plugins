// The shared client: backoff, request ids, ok draining, heartbeat, inst and version checks.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { LrClient } from '../lib/client.mjs';
import { freePort, sleep, waitUntil, withMock } from './helpers.mjs';

const now = () => performance.now();

// Two raw servers that send `greeting` lines to each evt client and answer ok on cmd.
async function fakeLightroom(greeting) {
  const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  const socks = new Set();
  const cmd = net.createServer((s) => {
    socks.add(s);
    s.on('error', () => {});
    s.on('data', (d) => { for (const _ of String(d).split('\n').slice(0, -1)) s.write('ok\n'); });
  });
  const evt = net.createServer((s) => {
    socks.add(s);
    s.on('error', () => {});
    for (const g of greeting) s.write(`${JSON.stringify(g)}\n`);
  });
  const ports = [await listen(cmd), await listen(evt)];
  return {
    ports,
    close: async () => {
      for (const s of socks) s.destroy();
      await Promise.all([cmd, evt].map((srv) => new Promise((r) => srv.close(() => r()))));
    },
  };
}

describe('shared client', () => {
  test('backoff: 250 ms, doubling to at most 2 s, while nothing listens', async () => {
    const c = new LrClient({ cmdPort: await freePort(), evtPort: await freePort(), heartbeat: false });
    const delays = [];
    c.on('retry', (e) => delays.push(e.delay));
    c.start();
    try {
      assert.ok(await waitUntil(() => delays.length >= 5, 8000), `retries: ${delays}`);
      assert.deepEqual(delays.slice(0, 5), [250, 500, 1000, 2000, 2000]);
    } finally {
      c.stop();
    }
  });

  test('request ids: the reply carries the id, counting up from firstId', async () => {
    await withMock({}, async (mock) => {
      const c = new LrClient({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, heartbeat: false, firstId: 500 }).start();
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        const a = await c.request({ t: 'presets' }, 2000);
        const b = await c.request({ t: 'ping' }, 2000);
        assert.deepEqual([a.ok, a.id, a.reply.t, a.reply.id], [true, 500, 'presets', 500]);
        assert.deepEqual([b.ok, b.id, b.reply.t], [true, 501, 'pong']);
        assert.equal(typeof b.rttMs, 'number');
      } finally {
        c.stop();
      }
    });
  });

  test('ok draining: every line gets an ok, which never shows up as a message', async () => {
    await withMock({}, async (mock) => {
      const c = new LrClient({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, heartbeat: false, autoHello: false }).start();
      const types = [];
      c.on('msg', (m) => types.push(m.t));
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        for (let i = 0; i < 5; i += 1) c.send({ t: 'ping', id: i });
        c.sendRaw('not json');
        assert.ok(await c.waitOks(2000));
        assert.equal(c.okLines, 6);
        assert.ok(await waitUntil(() => types.filter((t) => t === 'pong').length === 5, 2000));
        assert.ok(!types.includes('ok'));
      } finally {
        c.stop();
      }
    });
  });

  test('the heartbeat pings every interval and keeps its own pongs to itself', async () => {
    await withMock({}, async (mock) => {
      const c = new LrClient({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, heartbeat: { intervalMs: 100 } }).start();
      const pongs = [];
      c.on('m:pong', (m) => pongs.push(m));
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000));
        const t = now();
        assert.ok(await waitUntil(() => c.hb.pings >= 6 && c.hb.pongs >= 5, 3000), `${c.hb.pings} pings, ${c.hb.pongs} pongs`);
        const ms = now() - t;
        assert.ok(ms >= 450, `pings spaced by the interval: 6 took ${Math.round(ms)} ms`);
        assert.deepEqual(pongs, [], 'heartbeat pongs never reach the listeners');
      } finally {
        c.stop();
      }
    });
  });

  test('hello: a new inst and a version mismatch are reported', async () => {
    const fake = await fakeLightroom([{ t: 'hello', v: 2, inst: 'abc' }]);
    const c = new LrClient({ cmdPort: fake.ports[0], evtPort: fake.ports[1], heartbeat: false });
    const seen = [];
    c.on('inst', (e) => seen.push(['inst', e.inst, e.previous]));
    c.on('mismatch', (m) => seen.push(['mismatch', m.v]));
    c.start();
    try {
      assert.ok(await waitUntil(() => seen.length >= 2, 2000));
      assert.deepEqual(seen, [['mismatch', 2], ['inst', 'abc', null]]);
      assert.equal(c.versionMismatch, true);
    } finally {
      c.stop();
      await fake.close();
    }
  });

  test('with reconnect off, a loss closes both sides and stays down', async () => {
    await withMock({}, async (mock) => {
      const c = new LrClient({ cmdPort: mock.cmdPort, evtPort: mock.evtPort, heartbeat: false, reconnect: false }).start();
      let gaveUp = false;
      c.on('gave-up', () => { gaveUp = true; });
      try {
        assert.ok(await c.waitUp(2000));
        assert.ok(await mock.control.waitClients(2000), 'the mock has accepted both sockets');
        const t = now();
        mock.control.close('cmd');
        assert.ok(await waitUntil(() => gaveUp && !c.sides.evt.connected, 2000), 'pair closed');
        await sleep(400);
        assert.equal(c.isUp(), false);
        assert.ok(now() - t >= 400);
      } finally {
        c.stop();
      }
    });
  });
});
