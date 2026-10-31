// The mock's command line and REPL. Always --ports: the defaults are Lightroom's own 58780/58781.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LrClient } from '../lib/client.mjs';
import { DATA, holdPort, runNode, spawnNode } from './helpers.mjs';

const now = () => performance.now();

async function startCli(args = []) {
  const p = spawnNode(['mock-lr/cli.mjs', '--ports', '0,0', ...args]);
  const line = await p.waitLine(/listening: cmd \d+, evt \d+/, 10000);
  const [, cmd, evt] = /listening: cmd (\d+), evt (\d+)/.exec(line);
  return { p, cmdPort: Number(cmd), evtPort: Number(evt), banner: line };
}

describe('mock CLI', () => {
  test('starts on --ports 0,0, prints its ports, and takes REPL commands', async () => {
    const { p, cmdPort, evtPort } = await startCli(['--quiet']);
    const c = new LrClient({ cmdPort, evtPort, heartbeat: false }).start();
    try {
      assert.ok(await c.waitUp(3000));
      assert.ok(await c.waitFor('hello', 3000, -Infinity), 'greeted, so the mock has the evt socket');
      const tw = now();
      c.send({ t: 'watch', ps: ['Exposure'] });
      assert.ok(await c.waitFor('vals', 2000, tw));

      let t = now();
      p.write('photo 106\n');
      const st = await c.waitFor((m) => m.t === 'state' && m.photo === '106', 2000, t);
      assert.equal(st.msg.file, 'IMG_0106.JPG');

      t = now();
      p.write('edit Exposure 0.8\n');
      assert.ok(await c.waitFor((m) => m.t === 'vals' && m.vals.Exposure === 0.8, 2000, t), 'a mouse edit reaches the deck');

      t = now();
      p.write('module library\n');
      assert.ok(await c.waitFor((m) => m.t === 'state' && m.module === 'library', 2000, t));

      const from = p.lines.length;
      p.write('state\nbogus\n');
      await p.waitLine(/^module library, view loupe, target 106/, 2000, from);
      await p.waitLine(/^error: unknown command "bogus"/, 2000, from);

      t = now();
      let downs = 0;
      c.on('down', () => { downs += 1; });
      p.write('close\n');
      assert.ok(await c.waitFor('hello', 4000, t), 'the client reconnected after Lightroom closed the connections');
      assert.ok(downs >= 1);

      p.write('exit\n');
      const exit = await p.exited;
      assert.equal(exit.code, 0);
      // --quiet still prints the mock's own errors (exceptions it caught): there must be none.
      assert.deepEqual(p.lines.filter((l) => /^\[mock [\d:.]+\] error /.test(l)), []);
    } finally {
      c.stop();
      await p.kill();
    }
  });

  test('--scenario loads a setup file', async () => {
    const { p, banner } = await startCli(['--quiet', '--scenario', path.join(DATA, 'scenario-small.json')]);
    try {
      assert.match(banner, /2 photos, 1 presets/);
      const from = p.lines.length;
      p.write('state\n');
      await p.waitLine(/^module library, view loupe, target 1 \(A\.ARW/, 2000, from);
    } finally {
      await p.kill();
    }
  });

  test('ports already taken: exits 2 and asks whether Lightroom is running', async () => {
    const held = await holdPort();
    try {
      const r = await runNode(['mock-lr/cli.mjs', '--ports', `${held.port},0`], { timeoutMs: 10000 });
      assert.equal(r.code, 2);
      assert.match(r.stderr, new RegExp(`port ${held.port} \\(commands\\) is already in use: is Lightroom running\\?`));
    } finally {
      await held.close();
    }
  });

  test('bad arguments exit 2', async () => {
    let r = await runNode(['mock-lr/cli.mjs', '--ports', '1,2,3']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--ports wants two port numbers/);
    r = await runNode(['mock-lr/cli.mjs', '--ports', '0,0', '--scenario', path.join(DATA, 'nope.json')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ENOENT/);
    r = await runNode(['mock-lr/cli.mjs', '--frobnicate']);
    assert.equal(r.code, 2);
  });
});
