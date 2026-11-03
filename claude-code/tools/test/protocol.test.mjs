import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { REPO, readVectors } from '../lib/fixtures.mjs'
import { ALLOW, DENY, HELLO_FIRST, HOOK_ROUTES, MOD_ROUTES, NOT_THIS_SESSION, NO_DECISION, PRE_ALLOW, ROUTES, ROUTE_METHODS, answerFor, canonical, fingerprint, summary } from '../lib/protocol.mjs'

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

test("protocol: the mode check's allow, the routes, the hello's 409 and the poll's are PROTOCOL.md's own", () => {
  const text = fs.readFileSync(path.join(REPO, 'claude-code', 'protocol', 'PROTOCOL.md'), 'utf8')
  // "Mode checks" writes the allow out in full, on a line of its own.
  const line = text.split('\n').find((l) => l.includes('"hookEventName": "PreToolUse"'))
  assert.ok(line, 'PROTOCOL.md has the mode check\'s allow')
  assert.deepEqual(PRE_ALLOW, JSON.parse(line.slice(line.indexOf('`') + 1, line.lastIndexOf('`'))))
  assert.ok(Object.isFrozen(PRE_ALLOW.hookSpecificOutput))
  // The routes table: every route, with its method, and which party sends it.
  const rows = [...text.matchAll(/^\| `(GET|POST) (\/v1\/[a-z]+)` \| ([^|]+) \|/gm)].map(([, method, route, from]) => [route, method, from.trim()])
  assert.deepEqual(rows.map(([route, method]) => [route, method]).toSorted(), Object.entries(ROUTE_METHODS).toSorted())
  assert.deepEqual(rows.filter(([, , from]) => from !== 'the mod').map(([route]) => route).toSorted(), [...HOOK_ROUTES].toSorted(), "the hooks' routes")
  assert.deepEqual(rows.filter(([, , from]) => from === 'the mod').map(([route]) => route).toSorted(), [...MOD_ROUTES].toSorted(), "the mod's routes")
  assert.equal(ROUTES.pretool, '/v1/pretool')
  assert.ok(text.includes(`409 \`{"error": "${NOT_THIS_SESSION}"}\``), "the hello's refusal")
  // A poll for a session no instance has said hello for (Identity), in the routes table too.
  assert.ok(text.includes(`409 \`{"error": "${HELLO_FIRST}"}\``), "the poll's hello first")
  assert.match(text, /^\| `GET \/v1\/next` \| the mod \| [^|]+ \| 200 `\{"cmds": \[\.\.\.\]\}`, or 409 `\{"error": "hello first"\}` \|$/m)
})
