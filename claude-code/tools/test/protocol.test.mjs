import assert from 'node:assert/strict'
import test from 'node:test'

import { readVectors } from '../lib/fixtures.mjs'
import { ALLOW, DENY, NO_DECISION, answerFor, canonical, fingerprint, summary } from '../lib/protocol.mjs'

test('protocol: canonical forms, fingerprints and summaries match every vector in vectors.json', () => {
  const vectors = readVectors()
  assert.ok(vectors.length >= 20, `expected the protocol's vectors, got ${vectors.length}`)
  for (const v of vectors) {
    const what = `${v.tool} ${JSON.stringify(v.input).slice(0, 60)}`
    assert.equal(canonical(v.input), v.canonical, `canonical of ${what}`)
    assert.equal(fingerprint(v.tool, v.input), v.fp, `fp of ${what}`)
    assert.equal(summary(v.tool, v.input), v.summary, `summary of ${what}`)
  }
})

test('protocol: the three answers have the shapes PROTOCOL.md gives, and nothing can change them', () => {
  assert.deepEqual(answerFor('allow'), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  assert.deepEqual(answerFor('deny'), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from the Stream Deck.', interrupt: true } },
  })
  assert.deepEqual(answerFor('none'), {})
  assert.throws(() => answerFor('maybe'))
  assert.ok(Object.isFrozen(ALLOW.hookSpecificOutput.decision) && Object.isFrozen(DENY.hookSpecificOutput.decision) && Object.isFrozen(NO_DECISION))
})
