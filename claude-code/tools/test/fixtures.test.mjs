import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { FIXTURES_DIR, FixtureError, fixtureFiles, parseFixture, readFixture, resolveFixture } from '../lib/fixtures.mjs'

test('fixtures: all 17 parse, each with a setup, and every reply checks an earlier labeled request', () => {
  const files = fixtureFiles()
  assert.equal(files.length, 17)
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
    [`${setup}\n{"plugin":{"as":"a","method":"GET","path":"/"}}\n{"plugin":{"as":"a","method":"GET","path":"/"}}`, /x\.jsonl:3: label a used twice/],
    [`${setup}\n{"shout":{}}`, /x\.jsonl:2: a line has one key/],
    [`${setup}\nnot json`, /x\.jsonl:2: not JSON/],
    ['{"note":"only a note"}', /x\.jsonl: no setup line/],
  ]
  for (const [text, why] of cases) assert.throws(() => parseFixture(text, '/f/x.jsonl'), why)
})

test('fixtures: notes before the setup are kept, and replied labels are known', () => {
  const fx = parseFixture('{"note":"one"}\n{"setup":{}}\n{"plugin":{"as":"h","method":"POST","path":"/v1/hello","body":{}}}\n{"reply":{"to":"h","status":200}}\n', '/f/y.jsonl')
  assert.deepEqual(fx.notes, ['one'])
  assert.deepEqual([...fx.replied], ['h'])
  assert.deepEqual(fx.lines.map((l) => [l.n, l.kind]), [[1, 'note'], [3, 'plugin'], [4, 'reply']])
})
