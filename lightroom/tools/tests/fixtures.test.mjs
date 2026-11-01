// Every fixture in lightroom/protocol/fixtures against the mock Lightroom, over real sockets,
// on the manual clock (the runner owns time) and on the real clock.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listFixtures } from '../lib/fixtures.mjs';
import { formatResult, runFixture } from '../fixtures/run.mjs';
import { DATA, runNode } from './helpers.mjs';

const files = listFixtures();

test('there are 21 fixtures', () => {
  assert.equal(files.length, 21);
});

describe('fixtures against the mock, manual clock', () => {
  for (const file of files) {
    test(path.basename(file), async () => {
      const r = await runFixture(file, { clock: 'manual' });
      assert.ok(r.ok, formatResult(r));
    });
  }
});

describe('fixtures against the mock, real clock', { concurrency: 6 }, () => {
  for (const file of files) {
    test(path.basename(file), async () => {
      const r = await runFixture(file, { clock: 'real' });
      assert.ok(r.ok, formatResult(r));
    });
  }
});

describe('the runner catches broken fixtures', () => {
  const base = fs.readFileSync(files.find((f) => f.endsWith('dial-gesture.jsonl')), 'utf8').trim().split('\n');
  const variant = (name, edit) => ({ name, text: edit([...base]).join('\n') });

  test('a wrong value in an lr line', async () => {
    const r = await runFixture(variant('wrong-ack', (l) => l.map((x) => x.replace('{"lr":{"t":"ack","p":"Exposure","v":0.47', '{"lr":{"t":"ack","p":"Exposure","v":0.48'))));
    assert.equal(r.ok, false);
    assert.match(r.error, /unexpected \{"t":"ack".*v: expected 0\.48, got 0\.47/);
    assert.equal(r.line, 7); // note, setup, deck, lr, never, deck, then this lr line
  });

  test('a never line that Lightroom breaks', async () => {
    // After done, the observer's vals carries Exposure: forbid it.
    const r = await runFixture(variant('never-broken', (l) => {
      const i = l.findIndex((x) => x.includes('"t":"done"'));
      l.splice(i, 0, '{"never":{"t":"vals","vals":{"Exposure":"*"}}}');
      l.splice(i + 2, 1, '{"lr":{"t":"pong","id":1}}');
      return l;
    }));
    assert.equal(r.ok, false);
    assert.match(r.error, /never line forbids/);
  });

  test('a message Lightroom never sends', async () => {
    const r = await runFixture(variant('missing', (l) => [...l, '{"lr":{"t":"applied","id":1}}']));
    assert.equal(r.ok, false);
    assert.match(r.error, /nothing matched/);
  });

  test('a trailing message that is not an allowed extra', async () => {
    const r = await runFixture(variant('trailing-err', (l) => [...l, '{"deck":{"t":"nav","v":"sideways"}}']));
    assert.equal(r.ok, false);
    assert.match(r.error, /unexpected \{"t":"err","cmd":"nav","code":"bad"/);
  });

  test('a wrong expect line', async () => {
    const r = await runFixture(variant('wrong-expect', (l) => l.map((x) => x.replace('{"expect":{"tracking":false', '{"expect":{"tracking":true'))));
    assert.equal(r.ok, false);
    assert.match(r.error, /tracking: expected true, got false/);
  });

  test('an expect field PROTOCOL.md does not define', async () => {
    const r = await runFixture(variant('bad-expect', (l) => [...l, '{"expect":{"history":1}}']));
    assert.equal(r.ok, false);
    assert.match(r.error, /"history" isn't a field PROTOCOL.md defines/);
  });

  test('a mock that logs an error fails the fixture, where it happened', async () => {
    const r = await runFixture(variant('mock-error', (l) => l), {
      onMock: (mock) => { mock.lr.poll = () => { throw new Error('boom'); }; },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /^the mock logged an error: mock bug: Error: boom/);
    assert.equal(r.line, 3, 'the first deck line, whose poll step threw');
  });

  test('anything but ok on the cmd socket fails the fixture', async () => {
    for (const junk of ['{"t":"vals","vals":{}}', 'okay']) {
      const r = await runFixture(variant('cmd-junk', (l) => l), {
        onMock: (mock) => mock.control.on('command', (m) => { if (m.t === 'done') mock.server.cmd.sock.write(`${junk}\n`); }),
      });
      assert.equal(r.ok, false, junk);
      assert.equal(r.error, `Lightroom wrote ${JSON.stringify(junk.startsWith('{') ? JSON.parse(junk) : junk)} on the cmd socket, where only "ok" belongs`);
    }
  });
});

describe('fixtures/run.mjs', () => {
  test('exits 0 when every fixture passes', async () => {
    const r = await runNode(['fixtures/run.mjs', '--quiet']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /fixtures: 21\/21 passed \(manual clock/);
  });

  test('exits 1 when one fails, and says where', async () => {
    const r = await runNode(['fixtures/run.mjs', path.join(DATA, 'broken.jsonl')]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL {2}broken\.jsonl/);
    assert.match(r.stdout, /line 4: \{"lr"/);
    assert.match(r.stdout, /fixtures: 0\/1 passed/);
  });

  test('exits 2 on a bad option', async () => {
    const r = await runNode(['fixtures/run.mjs', '--clock', 'sundial']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--clock takes manual, real or both/);
  });
});
