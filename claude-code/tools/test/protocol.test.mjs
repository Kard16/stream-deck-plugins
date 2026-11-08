import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { REPO, fixtureFiles, readFixture, readVectors } from '../lib/fixtures.mjs'
import {
  ALLOW, DENY, HELLO_FIRST, HOOK_ROUTES, MOD_ROUTES, NOT_THIS_SESSION, NO_DECISION, ROUTE_METHODS, THREAD_KINDS, answerFor, canonical, fingerprint,
  summary,
} from '../lib/protocol.mjs'

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

test("protocol: the routes, the hello's 409 and the poll's are PROTOCOL.md's own", () => {
  const text = fs.readFileSync(path.join(REPO, 'claude-code', 'protocol', 'PROTOCOL.md'), 'utf8')
  // The routes table: every route, with its method, and which party sends it.
  const rows = [...text.matchAll(/^\| `(GET|POST) (\/v1\/[a-z]+)` \| ([^|]+) \|/gm)].map(([, method, route, from]) => [route, method, from.trim()])
  assert.deepEqual(rows.map(([route, method]) => [route, method]).toSorted(), Object.entries(ROUTE_METHODS).toSorted())
  assert.deepEqual(rows.filter(([, , from]) => from !== 'the mod').map(([route]) => route).toSorted(), [...HOOK_ROUTES].toSorted(), "the hook's route")
  assert.deepEqual(rows.filter(([, , from]) => from === 'the mod').map(([route]) => route).toSorted(), [...MOD_ROUTES].toSorted(), "the mod's routes")
  assert.ok(text.includes(`409 \`{"error": "${NOT_THIS_SESSION}"}\``), "the hello's refusal")
  // A poll for a session no instance has said hello for (Identity), in the routes table too.
  assert.ok(text.includes(`409 \`{"error": "${HELLO_FIRST}"}\``), "the poll's hello first")
  assert.match(text, /^\| `GET \/v1\/next` \| the mod \| [^|]+ \| 200 `\{"cmds": \[\.\.\.\]\}`, or 409 `\{"error": "hello first"\}` \|$/m)
})

test("protocol: a threads agent's kinds are PROTOCOL.md's own", () => {
  // PROTOCOL.md, "Events", as amended on 2026-11-07 for Phase 9: the spawn's kinds, and `other` for a loop with none.
  const text = fs.readFileSync(path.join(REPO, 'claude-code', 'protocol', 'PROTOCOL.md'), 'utf8')
  const line = text.split('\n').find((l) => l.includes('`kind` comes from the loop'))
  assert.ok(line, "PROTOCOL.md's line on a threads agent's kind")
  // `workflow` when it has `workflow`, … else `subagent`. A loop the mod saw no `agent.spawn` for is `other`.
  assert.deepEqual([...line.matchAll(/`(\w+)` when\b|else `(\w+)`|is `(\w+)`\./g)].map((m) => m[1] ?? m[2] ?? m[3]).toSorted(), [...THREAD_KINDS].toSorted())
})

test("protocol: each fixture's dial decision gets the keys' own Allow or Deny, and a press with nothing picked gets no answer", () => {
  // The generator writes the fixtures' answers by hand: a dial answers only a tool request, with the keys' bodies, since
  // the Answer and the Approve plan went in Phase 9.
  let checked = 0
  for (const file of fixtureFiles()) {
    const fx = readFixture(file)
    const requests = new Set(fx.lines.filter((l) => l.kind === 'plugin' && l.value.as && l.value.path === '/v1/permission').map((l) => l.value.as))
    let dial = null
    for (const l of fx.lines) {
      if (l.kind === 'press') dial = l.value.dial ?? null
      if (l.kind !== 'reply' || !dial || !requests.has(l.value.to)) continue
      assert.ok(dial.decision, `${fx.name}:${l.n}: a press with nothing picked answers nothing`)
      assert.deepEqual(l.value.body, answerFor(dial.decision), `${fx.name}:${l.n}: the reply to ${l.value.to}`)
      checked++
      dial = null
    }
  }
  assert.equal(checked, 3, 'dial-approve twice, and dial-next')
})
