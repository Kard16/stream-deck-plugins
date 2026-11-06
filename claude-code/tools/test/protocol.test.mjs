import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { REPO, fixtureFiles, readFixture, readVectors } from '../lib/fixtures.mjs'
import {
  ALLOW, ASK_INPUT_MAX, DENY, DIAL_PLANS, HELLO_FIRST, HOOK_ROUTES, MOD_ROUTES, NOT_THIS_SESSION, NO_DECISION, PLAN_MODES, ROUTE_METHODS,
  answerBody, answerFor, approvePlanBody, canonical, fingerprint, joinLabels, summary,
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

test("protocol: the Answer and the Approve plan have PROTOCOL.md's shapes, with the request's own input", () => {
  // PROTOCOL.md, "Permission requests", as amended on 2026-11-04 for session keys.
  const ask = { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }], metadata: { source: 'x' } }
  assert.deepEqual(answerBody(ask, { 'Red or blue?': 'Blue' }), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ask, answers: { 'Red or blue?': 'Blue' } } } },
  })
  // One key added, and the rest as it came: an answers key already there is replaced, a `__proto__` key kept as one.
  const odd = JSON.parse('{"__proto__": {"x": 1}, "answers": {"old": "x"}, "questions": []}')
  const echoed = answerBody(odd, { Q: 'A' }).hookSpecificOutput.decision.updatedInput
  assert.deepEqual(JSON.parse(JSON.stringify(echoed)), JSON.parse('{"__proto__": {"x": 1}, "answers": {"Q": "A"}, "questions": []}'))
  assert.equal(Object.getPrototypeOf(echoed), Object.prototype)
  assert.equal(odd.answers.old, 'x', "the request's own input isn't changed")

  const plan = { plan: '# Plan\n', planFilePath: '/p.md' }
  for (const mode of PLAN_MODES) {
    assert.deepEqual(approvePlanBody(plan, mode), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: plan, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } },
    })
  }
  assert.deepEqual(approvePlanBody({}, 'auto').hookSpecificOutput.decision.updatedInput, {}, 'a plan with no file: {} goes back as it is')
  assert.deepEqual([PLAN_MODES, DIAL_PLANS, ASK_INPUT_MAX], [['auto', 'acceptEdits', 'default'], ['auto', 'acceptEdits', 'default', 'reject'], 65536])
  // PROTOCOL.md names the modes and the size, which is in UTF-8 bytes of the JSON.
  const text = fs.readFileSync(path.join(REPO, 'claude-code', 'protocol', 'PROTOCOL.md'), 'utf8')
  assert.ok(text.includes('`<mode>` is `auto`, `acceptEdits` or `default`'))
  assert.match(text, /keeps its `tool_input`\*\* when its JSON, as UTF-8 bytes of `JSON\.stringify`, is at most 64 KiB/)
})

test('protocol: a multi-select answer is its labels joined with ", ", each that holds ", " or a double quote written as a JSON string', () => {
  assert.equal(joinLabels(['Apple', 'Plum']), 'Apple, Plum', 'T5, live')
  assert.equal(joinLabels(['Apple', 'Pear, ripe']), 'Apple, "Pear, ripe"', 'answer-questions')
  assert.equal(joinLabels(['Say "hi"', 'Bye']), '"Say \\"hi\\"", Bye')
  assert.equal(joinLabels(['a,b', 'c']), 'a,b, c', 'a comma alone is no ", "')
  assert.equal(joinLabels(['Pear, ripe']), '"Pear, ripe"', 'one tick of a multi-select question, written the same way')
  assert.equal(joinLabels(['Plum', 'Apple']), 'Plum, Apple', 'in the order given: the caller gives the options\' order')
})

test("protocol: each fixture's Answer and Approve plan is the request's own input with the dial line's picks or plan, as these bodies make them", () => {
  // The generator writes the fixtures' answers by hand; these bodies, the join and the picks' option order make the
  // same ones from the request and the dial line, so a change on either side shows here.
  let checked = 0
  for (const file of fixtureFiles()) {
    const fx = readFixture(file)
    const requests = new Map(fx.lines.filter((l) => l.kind === 'plugin' && l.value.as && l.value.path === '/v1/permission').map((l) => [l.value.as, l.value.body]))
    let dial = null
    for (const l of fx.lines) {
      if (l.kind === 'press') dial = l.value.dial ?? null
      if (l.kind !== 'reply' || !dial || !requests.has(l.value.to)) continue
      const { tool_name: tool, tool_input: input } = requests.get(l.value.to)
      let want = null
      if (dial.picks) {
        const answers = Object.fromEntries(input.questions.map((q) => {
          const labels = q.options.map((o) => o.label).filter((label) => dial.picks[q.question].includes(label))
          return [q.question, q.multiSelect ? joinLabels(labels) : labels[0]]
        }))
        want = answerBody(input, answers)
      } else if (dial.plan) {
        want = dial.plan === 'reject' ? DENY : approvePlanBody(input, dial.plan)
      } else if (dial.decision) {
        want = answerFor(dial.decision)
      }
      assert.ok(tool, `${fx.name}: the request has a tool`)
      assert.deepEqual(l.value.body, want, `${fx.name}:${l.n}: the reply to ${l.value.to}`)
      checked++
      dial = null
    }
  }
  assert.equal(checked, 7, 'answer-question, answer-questions, dial-approve twice, dial-next, plan-approve and plan-reject')
})
