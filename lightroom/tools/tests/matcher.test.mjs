// The matcher and fixture reader, against PROTOCOL.md's Fixtures section.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { Inbox, MatchError, match, mismatch } from '../lib/match.mjs';
import { FixtureError, listFixtures, parseFixture, readFixture } from '../lib/fixtures.mjs';

describe('matcher', () => {
  test('every expected field must be present and equal; extra fields are allowed', () => {
    assert.ok(match({ t: 'ack', p: 'Exposure' }, { t: 'ack', p: 'Exposure', v: 1, g: 2 }));
    assert.ok(!match({ t: 'ack', g: 1 }, { t: 'ack' }));
    assert.equal(mismatch({ t: 'ack', g: 1 }, { t: 'ack' }), 'g: missing');
    assert.ok(!match({ t: 'ack' }, { t: 'err' }));
  });

  test('"*" matches any value, null included, but the field must be there', () => {
    assert.ok(match({ lt: '*' }, { lt: 12.5 }));
    assert.ok(match({ photo: '*' }, { photo: null }));
    assert.ok(match({ x: '*' }, { x: { deep: [1] } }));
    assert.ok(!match({ lt: '*' }, {}));
  });

  test('numbers match within 1e-6, and only numbers', () => {
    assert.ok(match({ v: 0.3 }, { v: 0.1 + 0.2 }));
    assert.ok(match({ v: 5 }, { v: 5 + 5e-7 }));
    assert.ok(!match({ v: 5 }, { v: 5 + 2e-6 }));
    assert.ok(!match({ v: 1 }, { v: '1' }));
    assert.ok(!match({ v: 0 }, { v: false }));
  });

  test('arrays need the same length and matching elements in order', () => {
    assert.ok(match([2000, 50000], [2000, 50000]));
    assert.ok(!match([2000, 50000], [50000, 2000]));
    assert.ok(!match([1], [1, 2]));
    assert.ok(match({ items: [{ uuid: 'A' }] }, { items: [{ uuid: 'A', name: 'x', folder: 'y' }] }));
    assert.equal(mismatch({ items: [1] }, { items: [1, 2] }), 'items: expected 1 items, got 2');
  });

  test('vals and ranges match on a key subset', () => {
    assert.ok(match({ t: 'ranges', ranges: { Exposure: [-5, 5] } }, { t: 'ranges', ranges: { Exposure: [-5, 5], Tint: [-150, 150] } }));
    assert.ok(match({ t: 'vals', vals: { Exposure: 0.35 } }, { t: 'vals', vals: { Exposure: 0.35, Contrast: 0 } }));
    assert.ok(!match({ t: 'vals', vals: { Exposure: 0.35 } }, { t: 'vals', vals: { Contrast: 0 } }));
  });

  test('strings, booleans and null match exactly', () => {
    assert.ok(match({ a: 'x', b: true, c: null }, { a: 'x', b: true, c: null }));
    assert.ok(!match({ c: null }, { c: 0 }));
    assert.ok(!match({ b: false }, { b: 0 }));
  });

  test('operators only work when asked for (the fake deck), never in fixtures', () => {
    assert.ok(!match({ photo: { $not: '101' } }, { photo: '102' }));
    assert.ok(match({ photo: { $not: '101' } }, { photo: '102' }, { ops: true }));
    assert.ok(!match({ photo: { $not: '101' } }, { photo: '101' }, { ops: true }));
    assert.ok(match({ items: { $type: 'array' } }, { items: [] }, { ops: true }));
    assert.ok(!match({ lt: { $type: 'number' } }, { lt: '1' }, { ops: true }));
  });
});

describe('inbox: the stream rules', () => {
  const state = (photo) => ({ t: 'state', module: 'develop', photo });

  test('expected messages in order, with extra state, vals, ranges and pong skipped', async () => {
    const inbox = new Inbox();
    for (const m of [state('1'), { t: 'vals', vals: {} }, { t: 'pong', id: 1 }, { t: 'ranges', ranges: {} }, { t: 'ack', p: 'Exposure', v: 1, g: 1 }]) inbox.push(m);
    const r = await inbox.expect({ t: 'ack', v: 1 }, { timeoutMs: 0 });
    assert.equal(r.skipped.length, 4);
  });

  test('any other unexpected message fails', async () => {
    const inbox = new Inbox();
    inbox.push({ t: 'err', code: 'bad' });
    await assert.rejects(inbox.expect({ t: 'ack' }, { timeoutMs: 0 }), (err) => err instanceof MatchError && err.kind === 'unexpected');
  });

  test('a message of the expected type that differs says which field', async () => {
    const inbox = new Inbox();
    inbox.push({ t: 'ack', p: 'Exposure', v: 5, g: 1 });
    await assert.rejects(inbox.expect({ t: 'ack', v: 7.5 }, { timeoutMs: 0 }), /v: expected 7\.5, got 5/);
  });

  test('a never line holds until the next expected message matches', async () => {
    const inbox = new Inbox();
    inbox.never({ t: 'vals', vals: { Exposure: '*' } });
    inbox.push({ t: 'vals', vals: { Contrast: 1 } });
    inbox.push({ t: 'ack', g: 1 });
    await inbox.expect({ t: 'ack' }, { timeoutMs: 0 });
    inbox.push({ t: 'vals', vals: { Exposure: 1 } }); // allowed again: the never ended with the match
    assert.deepEqual(inbox.check().map((m) => m.t), ['vals']);

    inbox.never({ t: 'vals' });
    inbox.push({ t: 'vals', vals: {} });
    await assert.rejects(inbox.expect({ t: 'ack' }, { timeoutMs: 0 }), (err) => err.kind === 'never');
  });

  test('the expected message wins over a never line it also matches', async () => {
    const inbox = new Inbox();
    inbox.never({ t: 'vals' });
    inbox.push({ t: 'vals', vals: { Exposure: 0.55 } });
    await inbox.expect({ t: 'vals', vals: { Exposure: 0.55 } }, { timeoutMs: 0 });
  });

  test('check() fails on leftovers that are not allowed extras', () => {
    const inbox = new Inbox();
    inbox.push(state('1'));
    inbox.push({ t: 'applied', id: 1 });
    assert.throws(() => inbox.check(), /unexpected/);
  });

  test('expect waits for messages still on their way, then times out naming the closest one', async () => {
    const inbox = new Inbox();
    setTimeout(() => inbox.push({ t: 'pong', id: 3 }), 20);
    const r = await inbox.expect({ t: 'pong', id: 3 }, { timeoutMs: 1000 });
    assert.equal(r.msg.id, 3);
    inbox.push(state('101'));
    await assert.rejects(inbox.expect(state('102'), { timeoutMs: 50 }), /within 50 ms.*photo: expected "102", got "101"/);
  });
});

describe('fixture reader', () => {
  test('reads all 21 fixtures, each starting with a setup', () => {
    const files = listFixtures();
    assert.equal(files.length, 21);
    for (const f of files) {
      const fx = readFixture(f);
      assert.ok(fx.lines.length > 0, f);
      assert.ok(fx.lines.some((l) => l.kind === 'setup'), `${f} has a setup line`);
    }
  });

  test('rejects malformed lines with the file and line number', () => {
    const bad = [
      ['{"deck":{"t":"ping"},"lr":{}}', /:1: a line needs exactly one/],
      ['{"bogus":1}', /:1: a line needs exactly one/],
      ['not json', /:1: not JSON/],
      ['[1]', /:1: each line must be a JSON object/],
      ['{"deck":{"t":"ping"}}\n{"setup":{}}', /:2: setup must be the first line/],
      ['{"raw":5}', /raw must be a string/],
      ['{"wait":-1}', /wait must be a number/],
      ['{"lr":"pong"}', /lr must be an object/],
    ];
    for (const [text, re] of bad) assert.throws(() => parseFixture(text, 'x.jsonl'), (err) => err instanceof FixtureError && re.test(err.message), text);
  });

  test('notes may come before the setup, and blank lines are skipped', () => {
    const fx = parseFixture('{"note":"hi"}\n\n{"setup":{"module":"library"}}\n{"wait":200}\n', 'x');
    assert.deepEqual(fx.setup, { module: 'library' });
    assert.deepEqual(fx.lines.map((l) => [l.kind, l.line]), [['note', 1], ['setup', 3], ['wait', 4]]);
  });
});
