// The fake deck and smoke.json, against the mock Lightroom on ephemeral ports.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptError, evaluate, loadScript, normalizeScript, runScript } from '../fake-deck/fake-deck.mjs';
import { loadScenario } from '../mock-lr/index.mjs';
import { TEST_CATALOG } from '../lib/params.mjs';
import { DATA, TOOLS, freePort, runNode, withMock } from './helpers.mjs';

const SMOKE = path.join(TOOLS, 'fake-deck', 'smoke.json');
const smoke = JSON.parse(fs.readFileSync(SMOKE, 'utf8'));
const MAIN = '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat';

// What smoke.json must leave as it found it.
function photoState(mock) {
  const s = mock.control.state();
  const ph = s.photos[s.target];
  return { target: s.target, module: s.module, view: s.view, flag: ph.flag, values: ph.values, applied: ph.applied };
}

// Every photo, and what Lightroom shows: nothing here may change when a run refuses to write.
function wholeState(mock) {
  const s = mock.control.state();
  return { target: s.target, selected: s.selected, module: s.module, view: s.view, photos: s.photos, history: s.history };
}

// smoke.json's steps up to and including the first step matching pred, then an injected failure.
function failAfter(pred) {
  const i = smoke.steps.findIndex(pred);
  assert.ok(i >= 0);
  return { ...smoke, name: 'smoke-cut', steps: [...smoke.steps.slice(0, i + 1), { fail: 'injected failure' }] };
}

describe('fake deck: smoke.json against the mock', () => {
  test('the CLI passes in Develop and leaves the photo as it found it', async () => {
    await withMock({}, async (mock) => {
      const before = photoState(mock);
      const r = await runNode(['fake-deck/fake-deck.mjs', SMOKE, '--ports', `${mock.cmdPort},${mock.evtPort}`]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^smoke: PASS \(/m);
      assert.match(r.stdout, /expect hello v1 Plugin Test\.lrcat writable true/);
      assert.match(r.stdout, /expect ranges for 13 params {2}ok/);
      assert.match(r.stdout, /expect presets: 6 items {2}ok/);
      assert.deepEqual(photoState(mock), before);
      const steps = mock.control.state().history;
      assert.equal(steps.length, 1, 'one history step: the Exposure gesture');
      assert.equal(steps[0].kind, 'gesture');
      assert.equal(steps[0].from, steps[0].to, '+0.1 and back');
      assert.deepEqual(mock.control.state().watch, smoke.steps.find((s) => s.send && s.send.t === 'watch').send.ps);
    });
  });

  test('from Library, on a rejected photo: puts the module and the flag back', async () => {
    await withMock({}, async (mock) => {
      mock.control.user({ module: 'library', photo: '103' });
      const before = photoState(mock);
      assert.equal(before.flag, -1);
      const r = await runScript(SMOKE, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
      assert.ok(r.ok, JSON.stringify(r.failures));
      assert.deepEqual(photoState(mock), before);
    });
  });

  test('on the last photo, nav next cannot move: it fails with a hint and changes nothing', async () => {
    await withMock({}, async (mock) => {
      mock.control.user({ photo: '110' });
      const before = photoState(mock);
      const lines = [];
      const r = await runScript(SMOKE, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, out: (l) => lines.push(l) });
      assert.equal(r.ok, false);
      assert.match(lines.join('\n'), /hint: nav next didn't move: is 110 the last photo/);
      assert.deepEqual(photoState(mock), before);
    });
  });

  test('cleanup puts Exposure back after a failure mid-gesture', async () => {
    await withMock({}, async (mock) => {
      const before = photoState(mock);
      const script = failAfter((s) => s.expect && s.expect.t === 'ack' && s.expect.v === '$exp1');
      const r = await runScript(script, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1, JSON.stringify(r.failures));
      assert.equal(r.failures[0].error, 'injected failure');
      assert.deepEqual(photoState(mock), before);
      assert.equal(mock.control.state().tracking, false);
    });
  });

  test('cleanup puts the flag back after a failure between pick and none', async () => {
    await withMock({}, async (mock) => {
      mock.control.user({ photo: '102' }); // a pick
      const before = photoState(mock);
      const script = failAfter((s) => s.send && s.send.t === 'flag' && s.send.v === 'none');
      const r = await runScript(script, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1, JSON.stringify(r.failures));
      assert.deepEqual(photoState(mock), before);
    });
  });

  test('cleanup goes back to the first photo after a failure between nav next and prev', async () => {
    await withMock({}, async (mock) => {
      const before = photoState(mock);
      const script = failAfter((s) => s.expect && s.save && s.save.photo1);
      const r = await runScript(script, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1, JSON.stringify(r.failures));
      assert.deepEqual(photoState(mock), before);
    });
  });

  test('in another catalog it fails at connect and sends nothing, with the guard on and with it off', async () => {
    for (const guard of [true, false]) {
      await withMock({}, async (mock) => {
        mock.control.setup({ ...loadScenario(), catalog: MAIN });
        mock.control.options({ guard });
        assert.equal(mock.control.state().writable, !guard, 'with the guard off Lightroom says writable');
        const before = wholeState(mock);
        const commands = [];
        mock.control.on('command', (m) => commands.push(m.t));
        const r = await runScript(SMOKE, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
        assert.equal(r.ok, false);
        assert.equal(r.failures[0].where, 'connect', JSON.stringify(r.failures));
        assert.match(r.failures[0].error, /^Lightroom has \/Users\/karimdhanji\/Pictures\/Lightroom\/Main\.lrcat open, not \/Users\/karimdhanji\/Pictures\/Plugin Test\/Plugin Test\.lrcat/);
        assert.deepEqual(commands, [], `guard ${guard ? 'on' : 'off'}: nothing sent`);
        assert.deepEqual(wholeState(mock), before);
      });
    }
  });

  test('without a catalog in the script, step 3 still wants writable', async () => {
    await withMock({}, async (mock) => {
      mock.control.setup({ ...loadScenario(), catalog: MAIN });
      const before = wholeState(mock);
      const lines = [];
      const r = await runScript({ ...smoke, catalog: undefined }, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, out: (l) => lines.push(l) });
      assert.equal(r.ok, false);
      assert.equal(r.failures[0].where, '3');
      assert.match(lines.join('\n'), /hint: writable must be true: open .*Plugin Test\.lrcat/);
      assert.deepEqual(wholeState(mock), before);
    });
  });

  test('a write after Lightroom relaunched into another catalog is refused, guard or no guard', async () => {
    await withMock({}, async (mock) => {
      mock.control.options({ guard: false }); // writable everywhere: only the fake deck's own check is left
      const script = {
        name: 'relaunch', catalog: TEST_CATALOG, timeoutMs: 3000,
        // The client's first reconnect try comes 250 ms after the drop, long before the wait ends.
        steps: [{ send: { t: 'ping', id: 1 } }, { expect: { t: 'pong', id: 1 } }, { wait: 2000 }, { send: { t: 'flag', v: 'pick' } }],
      };
      let relaunched = null;
      mock.control.on('sent', (m) => {
        if (m.t === 'pong' && m.id === 1 && !relaunched) setImmediate(() => { relaunched = mock.control.relaunch({ downMs: 50, catalog: MAIN }); });
      });
      const flags = [];
      mock.control.on('command', (m) => { if (m.t === 'flag') flags.push(m); });
      const before = mock.control.state().photos;
      const r = await runScript(script, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
      await relaunched;
      assert.equal(r.ok, false);
      assert.equal(r.failures[0].where, '4', JSON.stringify(r.failures));
      assert.match(r.failures[0].error, /^refusing to send flag: Lightroom has \/Users\/karimdhanji\/Pictures\/Lightroom\/Main\.lrcat open/);
      assert.equal(mock.control.state().catalog, MAIN, 'the mock did relaunch into the other catalog');
      assert.deepEqual(flags, [], 'the flag never left');
      assert.deepEqual(mock.control.state().photos, before);
    });
  });

  test('with several photos selected it fails before writing', async () => {
    await withMock({}, async (mock) => {
      mock.control.user({ selected: ['101', '102', '103'] });
      const before = wholeState(mock);
      const lines = [];
      const r = await runScript(SMOKE, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, timeoutMs: 800, out: (l) => lines.push(l) });
      assert.equal(r.ok, false);
      assert.equal(r.failures[0].where, '4');
      assert.match(lines.join('\n'), /the last state differed at sel: expected 1, got 3/);
      assert.match(lines.join('\n'), /hint: select exactly one photo in the test catalog/);
      assert.deepEqual(wholeState(mock), before);
    });
  });

  test('with Lightroom\'s own Auto Advance on it stops before writing to another photo, and puts the first one back', async () => {
    await withMock({}, async (mock) => {
      mock.control.options({ autoAdvance: true });
      const before = mock.control.state();
      const lines = [];
      const r = await runScript(SMOKE, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, out: (l) => lines.push(l) });
      const log = lines.join('\n');
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1, JSON.stringify(r.failures));
      assert.match(r.failures[0].error, /which a never line forbids/);
      assert.match(log, /hint: Lightroom moved on to 102 after the flag: its own Auto Advance is on/);
      assert.match(log, /Auto Advance moved on to 102 after the flag: back to 101 with nav prev/, 'cleanup came back after its own flag');
      const after = mock.control.state();
      assert.equal(after.target, '101');
      assert.deepEqual(after.photos, before.photos, 'every photo as it was: 101 unflagged again, 102 never touched');
      assert.deepEqual(r.vars.flagDirty, true);
    });
  });
});

describe('fake deck: CLI and scripts', () => {
  test('a failing step exits 1', async () => {
    await withMock({}, async (mock) => {
      const r = await runNode(['fake-deck/fake-deck.mjs', path.join(DATA, 'failing-script.json'), '--ports', `${mock.cmdPort},${mock.evtPort}`]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      // A pong is an allowed extra, so the wrong one is skipped and the expect runs out of time.
      assert.match(r.stdout, /FAIL expect: nothing matched within 500 ms: expected \{"t":"pong","id":8\}; skipped pong; the last pong differed at id: expected 8, got 7/);
      assert.match(r.stdout, /^failing: FAIL at step 2/m);
    });
  });

  test('no Lightroom: exits 1 and says what to check', async () => {
    const [a, b] = [await freePort(), await freePort()];
    const r = await runNode(['fake-deck/fake-deck.mjs', SMOKE, '--ports', `${a},${b}`, '--connect-ms', '800']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /couldn't connect .* Is Lightroom running with DeckBridge loaded/);
  });

  test('a bad script or bad arguments exit 2', async () => {
    let r = await runNode(['fake-deck/fake-deck.mjs', path.join(DATA, 'broken.jsonl')]);
    assert.equal(r.code, 2);
    r = await runNode(['fake-deck/fake-deck.mjs', SMOKE, '--ports', 'nope']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--ports wants two port numbers/);
    r = await runNode(['fake-deck/fake-deck.mjs']);
    assert.equal(r.code, 2);
    // Not numbers: they would never time out, and a missing reply would hang the run.
    const [a, b] = [await freePort(), await freePort()];
    for (const [flag, value] of [['--timeout', 'abc'], ['--timeout', '0'], ['--connect-ms', 'abc'], ['--connect-ms', '-5']]) {
      r = await runNode(['fake-deck/fake-deck.mjs', path.join(DATA, 'failing-script.json'), '--ports', `${a},${b}`, `${flag}=${value}`], { timeoutMs: 10000 });
      assert.equal(r.code, 2, `${flag} ${value}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${flag} wants a number of ms above 0, got "${value}"`));
    }
  });

  test('scripts are checked before anything is sent', async () => {
    assert.throws(() => normalizeScript({ steps: [{ send: {}, expect: {} }] }), /exactly one of/);
    assert.throws(() => normalizeScript({ steps: [{ sned: {} }] }), /exactly one of/);
    assert.throws(() => normalizeScript({ steps: [{ send: {}, colour: 1 }] }), /unknown keys colour/);
    assert.throws(() => normalizeScript({ timeoutMs: 'abc', steps: [] }), /timeoutMs must be a number of ms above 0/);
    assert.throws(() => normalizeScript({ steps: [{ expect: {}, timeout: 'abc' }] }), /step 1: timeout must be a number of ms/);
    assert.throws(() => normalizeScript({ steps: [{ wait: 'x' }] }), /step 1: wait must be a number of ms/);
    assert.throws(() => normalizeScript({ steps: [], cleanup: [{ drain: -1 }] }), /cleanup step 1: drain must be a number of ms/);
    assert.throws(() => normalizeScript({ catalog: 5, steps: [] }), /catalog must be the path of a \.lrcat file/);
    await assert.rejects(runScript({ steps: [] }, { timeoutMs: Number('abc') }), ScriptError);
    await assert.rejects(runScript({ steps: [] }, { connectTimeoutMs: Number('abc') }), ScriptError);
    assert.equal(loadScript(SMOKE).steps.length, smoke.steps.length);
    assert.equal(loadScript(SMOKE).catalog, TEST_CATALOG, 'smoke.json writes only to the test catalog');
    assert.equal(normalizeScript([{ wait: 1 }]).steps.length, 1);
  });

  test('anything but ok on the cmd socket fails the run', async () => {
    await withMock({}, async (mock) => {
      mock.control.on('command', (m) => { if (m.t === 'ping' && m.id === 1) mock.server.cmd.sock.write('{"t":"junk"}\n'); });
      const steps = [{ send: { t: 'ping', id: 1 } }, { expect: { t: 'pong', id: 1 } }, { drain: 200 }];
      const r = await runScript({ name: 'junk', steps }, { cmdPort: mock.cmdPort, evtPort: mock.evtPort, quiet: true });
      assert.equal(r.ok, false);
      assert.match(r.failures[0].error, /\{"t":"\(on the cmd socket\)","msg":\{"t":"junk"\}\}/);
    });
  });

  test('variables and expressions', () => {
    const vars = { exp0: 0.35, flag0: -1, state: { photo: '101' } };
    assert.equal(evaluate({ $round: [{ $add: ['$exp0', 0.1] }, 2] }, vars), 0.45);
    assert.equal(evaluate({ $if: [{ $gt: ['$exp0', 4.85] }, 'down', 'up'] }, vars), 'up');
    assert.equal(evaluate({ $map: ['$flag0', { 1: 'pick', '-1': 'reject' }] }, vars), 'reject');
    assert.equal(evaluate('$state.photo', vars), '101');
    assert.deepEqual(evaluate({ t: 'state', photo: { $not: '$state.photo' } }, vars), { t: 'state', photo: { $not: '101' } });
    assert.equal(evaluate({ $and: ['$nope', true] }, vars, { strict: false }), false);
    assert.throws(() => evaluate({ v: '$nope' }, vars), /\$nope isn't set/);
    assert.throws(() => evaluate({ $add: ['$exp0', 'x'] }, vars), /\$add wants numbers/);
  });
});
