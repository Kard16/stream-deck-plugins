import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { FIXTURES_DIR, FixtureError, fixtureFiles, parseFixture, readFixture, resolveFixture } from '../lib/fixtures.mjs'

test('fixtures: all 23 parse, each with a setup, and every reply checks an earlier labeled request', () => {
  const files = fixtureFiles()
  assert.equal(files.length, 23)
  for (const file of files) {
    const fx = readFixture(file)
    assert.ok(fx.setup.session?.host, `${fx.name} has a setup session`)
    assert.ok(fx.lines.length > 0, `${fx.name} has lines`)
    const labels = new Set()
    for (const l of fx.lines) {
      if (l.kind === 'plugin' && l.value.as) labels.add(l.value.as)
      if (l.kind === 'reply') assert.ok(labels.has(l.value.to), `${fx.name}:${l.n} replies to an earlier label`)
    }
  }
})

test('fixtures: a name or a path finds the file', () => {
  assert.equal(resolveFixture('approve'), path.join(FIXTURES_DIR, 'approve.jsonl'))
  assert.equal(readFixture('approve').name, 'approve')
  assert.equal(readFixture(path.join(FIXTURES_DIR, 'two-held.jsonl')).name, 'two-held')
  assert.throws(() => readFixture('no-such-fixture'), FixtureError)
})

test('fixtures: a malformed fixture fails with its file and line', () => {
  const setup = '{"setup":{"session":{"host":"local_x"}}}'
  const cases = [
    [`${setup}\n{"plugin":{"method":"GET"}}`, /x\.jsonl:2: plugin needs method and path/],
    [`${setup}\n{"reply":{"to":"p1","status":200}}`, /x\.jsonl:2: reply to "p1", which no earlier plugin line is labeled/],
    [`{"plugin":{"method":"GET","path":"/"}}\n${setup}`, /x\.jsonl:1: plugin before the setup line/],
    [`${setup}\n${setup}`, /x\.jsonl:2: a second setup line/],
    [`${setup}\n{"press":{"approve":{},"deny":{}}}`, /x\.jsonl:2: press has one key/],
    // The Mode dial and key went in Phase 8 (PROTOCOL.md, "Fixtures", as amended on 2026-11-06).
    [`${setup}\n{"press":{"mode":{"session":"local_x","mode":"plan"}}}`, /x\.jsonl:2: press has one key, one of approve, deny, prompt, dial$/],
    [`${setup}\n{"plugin":{"as":"a","method":"GET","path":"/"}}\n{"plugin":{"as":"a","method":"GET","path":"/"}}`, /x\.jsonl:3: label a used twice/],
    [`${setup}\n{"shout":{}}`, /x\.jsonl:2: a line has one key/],
    [`${setup}\nnot json`, /x\.jsonl:2: not JSON/],
    ['{"note":"only a note"}', /x\.jsonl: no setup line/],
    // A Session Slot dial's line (PROTOCOL.md, "Fixtures", as amended on 2026-11-04): its session, and one of picks,
    // decision and plan.
    [`${setup}\n{"press":{"dial":{"decision":"allow"}}}`, /x\.jsonl:2: press\.dial\.session must be a host/],
    [`${setup}\n{"press":{"dial":{"session":"local_x"}}}`, /x\.jsonl:2: press\.dial has one of picks, decision, plan; got none/],
    [`${setup}\n{"press":{"dial":{"session":"local_x","decision":"allow","plan":"auto"}}}`, /x\.jsonl:2: press\.dial has one of picks, decision, plan; got decision, plan/],
    [`${setup}\n{"press":{"dial":{"session":"local_x","decision":"approve"}}}`, /x\.jsonl:2: press\.dial\.decision must be allow or deny/],
    [`${setup}\n{"press":{"dial":{"session":"local_x","plan":"plan"}}}`, /x\.jsonl:2: press\.dial\.plan must be one of auto, acceptEdits, default, reject/],
    [`${setup}\n{"press":{"dial":{"session":"local_x","picks":{"Q?":"Blue"}}}}`, /x\.jsonl:2: press\.dial\.picks maps each question's text to the labels picked for it/],
    [`${setup}\n{"press":{"dial":{"session":"local_x","picks":[["Blue"]]}}}`, /x\.jsonl:2: press\.dial\.picks maps/],
    [`${setup}\n{"press":{"dial":{"session":"local_x","picks":{"Q?":[1]}}}}`, /x\.jsonl:2: press\.dial\.picks maps/],
  ]
  for (const [text, why] of cases) assert.throws(() => parseFixture(text, '/f/x.jsonl'), why)
})

test("fixtures: every dial line is well formed, and each of the three kinds is in some fixture", () => {
  const dials = fixtureFiles().flatMap((f) => readFixture(f).lines.filter((l) => l.kind === 'press' && l.value.dial).map((l) => l.value.dial))
  assert.deepEqual(['picks', 'decision', 'plan'].filter((k) => !dials.some((d) => d[k] !== undefined)), [], 'picks, decision and plan')
  const setup = '{"setup":{"session":{"host":"local_x"}}}'
  for (const dial of [{ picks: { 'Q?': ['A', 'B'] } }, { picks: { 'Q?': [] } }, { decision: 'deny' }, ...['auto', 'acceptEdits', 'default', 'reject'].map((plan) => ({ plan }))]) {
    const fx = parseFixture(`${setup}\n${JSON.stringify({ press: { dial: { session: 'local_x', ...dial } } })}`, '/f/x.jsonl')
    assert.deepEqual(fx.lines[0].value.dial, { session: 'local_x', ...dial })
  }
})

test('fixtures: notes before the setup are kept, and replied labels are known', () => {
  const fx = parseFixture('{"note":"one"}\n{"setup":{}}\n{"plugin":{"as":"h","method":"POST","path":"/v1/hello","body":{}}}\n{"reply":{"to":"h","status":200}}\n', '/f/y.jsonl')
  assert.deepEqual(fx.notes, ['one'])
  assert.deepEqual([...fx.replied], ['h'])
  assert.deepEqual(fx.lines.map((l) => [l.n, l.kind]), [[1, 'note'], [3, 'plugin'], [4, 'reply']])
})
