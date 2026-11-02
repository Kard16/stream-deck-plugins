import assert from 'node:assert/strict'
import test from 'node:test'

import { Bindings, commandIdHook, expectMismatch, matches, mismatch, pathMismatch } from '../lib/match.mjs'
import { permissionAnswerMismatch, replyMismatch } from '../lib/play.mjs'
import { ALLOW, DENY } from '../lib/protocol.mjs'

test('match: every expected field must be there and equal; extra fields are fine', () => {
  assert.ok(matches({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x', d: 2 }, e: 3 }))
  assert.equal(mismatch({ a: 1 }, { a: 2 }), 'a: expected 1, got 2')
  assert.equal(mismatch({ a: { b: 1 } }, { a: {} }), 'a.b: missing (expected 1)')
  assert.equal(mismatch({ a: null }, {}), 'a: missing (expected null)')
  assert.ok(matches({ a: null }, { a: null }))
  assert.match(mismatch({ a: {} }, { a: 'x' }), /a: expected an object/)
  assert.ok(matches(5, 5))
  assert.ok(!matches('5', 5))
})

test('match: "*" matches any value that is there, null included, and not a missing one', () => {
  assert.ok(matches({ a: '*' }, { a: null }))
  assert.ok(matches({ a: '*' }, { a: { deep: [1] } }))
  assert.equal(mismatch({ a: '*' }, {}), 'a: missing (expected "*")')
})

test('match: arrays need the same length and match in order', () => {
  assert.ok(matches([{ a: 1 }, { b: 2 }], [{ a: 1, x: 0 }, { b: 2 }]))
  assert.match(mismatch([{ a: 1 }], [{ a: 1 }, { a: 2 }]), /expected 1 item\(s\), got 2/)
  assert.equal(mismatch([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }]), '[0].a: missing (expected 1)')
  assert.ok(!matches([], {}))
})

test('match: `at` is never compared, at any depth', () => {
  assert.ok(matches({ events: [{ t: 'turn.start', at: 1 }] }, { events: [{ t: 'turn.start', at: 999 }] }))
  assert.ok(matches({ at: 5 }, {}))
})

test('match: reasons start from the path given', () => {
  assert.equal(mismatch({ ok: true }, { ok: false }, { at: 'body' }), 'body.ok: expected true, got false')
  assert.equal(mismatch([{ tool: 'Write' }], [{ tool: 'Bash' }], { at: 'held' }), 'held[0].tool: expected "Write", got "Bash"')
})

test('match: a path with a query matches on the route and each listed parameter', () => {
  const want = '/v1/next?sid=s1&host=h1&inst=ia&wait=20'
  assert.equal(pathMismatch(want, '/v1/next?wait=20&inst=ia&host=h1&sid=s1&extra=1'), null)
  assert.equal(pathMismatch(want, '/v1/next?sid=s1&host=h1&inst=ib&wait=20'), 'query inst: expected ia, got ib')
  assert.equal(pathMismatch(want, '/v1/next?sid=s1&host=h1&wait=20'), 'query inst: missing (expected ia)')
  assert.equal(pathMismatch('/v1/next?inst=*', '/v1/next?inst=zz'), null)
  assert.equal(pathMismatch('/v1/hello', '/v1/events'), 'route: expected /v1/hello, got /v1/events')
})

test('match: a name binds at its first appearance, holds after, and binds one to one', () => {
  const b = new Bindings()
  assert.equal(b.bind('cmd', 'c1', 'k7'), null)
  assert.equal(b.real('cmd', 'c1'), 'k7')
  assert.equal(b.bind('cmd', 'c1', 'k7'), null)
  assert.match(b.bind('cmd', 'c1', 'k8'), /c1 is "k7" since its first appearance, got "k8"/)
  assert.match(b.bind('cmd', 'c2', 'k7'), /"k7" is already c1, not c2/)
  assert.equal(b.bind('inst', 'c2', 'k7'), null, 'kinds are separate')
  assert.match(b.bind('cmd', 'c3', undefined), /missing/)
})

test('match: command ids in a poll answer bind through the hook, then hold', () => {
  const b = new Bindings()
  const hook = commandIdHook(b)
  const want = { cmds: [{ id: 'c1', t: 'prompt', text: 'x' }] }
  assert.equal(mismatch(want, { cmds: [{ id: 'cmd-9', t: 'prompt', text: 'x' }] }, { at: 'body', hook }), null)
  assert.equal(b.real('cmd', 'c1'), 'cmd-9')
  assert.match(mismatch(want, { cmds: [{ id: 'cmd-10', t: 'prompt', text: 'x' }] }, { at: 'body', hook }), /c1 is "cmd-9"/)
})

test('match: a permission reply of {} means no decision, so a decision fails it', () => {
  const b = new Bindings()
  assert.equal(replyMismatch('/v1/permission', {}, {}, b), null)
  assert.match(replyMismatch('/v1/permission', {}, ALLOW, b), /expected no decision/)
  assert.match(replyMismatch('/v1/permission', {}, DENY, b), /expected no decision/)
  assert.equal(replyMismatch('/v1/permission', ALLOW, ALLOW, b), null)
  assert.match(replyMismatch('/v1/permission', ALLOW, DENY, b), /behavior: expected "allow", got "deny"/)
  // Elsewhere {} keeps the general rule.
  assert.equal(replyMismatch('/v1/hello', {}, { v: 1, ok: true }, b), null)
})

test("match: an answer to a permission request is one of PROTOCOL.md's three, whatever the reply line expects", () => {
  const b = new Bindings()
  const adding = (base, extra) => ({ hookSpecificOutput: { ...base.hookSpecificOutput, decision: { ...base.hookSpecificOutput.decision, ...extra } } })
  // approve's request suggests this one: a deck that echoed it would raise the session at every Approve.
  const setMode = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const addRules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' }]
  const cases = [
    [ALLOW, adding(ALLOW, { updatedPermissions: setMode }), /^body\.hookSpecificOutput\.decision\.updatedPermissions: the deck never sends updatedPermissions \(PROTOCOL\.md\), got \[\{"type":"setMode"/],
    [ALLOW, adding(ALLOW, { updatedInput: { command: 'ls' } }), /^body\.hookSpecificOutput\.decision\.updatedInput: the deck never sends updatedInput/],
    [DENY, adding(DENY, { updatedPermissions: addRules }), /^body\.hookSpecificOutput\.decision\.updatedPermissions: the deck never sends/],
    [DENY, { hookSpecificOutput: { ...DENY.hookSpecificOutput, updatedPermissions: addRules } }, /^body\.hookSpecificOutput\.updatedPermissions: the deck never sends/],
    // Anything else added to Allow or Deny: they're exact.
    [ALLOW, adding(ALLOW, { message: 'Approved from the deck.' }), /^body\.hookSpecificOutput\.decision\.message: not in Allow, got "Approved from the deck\." \(a decision is Allow or Deny exactly/],
    [ALLOW, { hookSpecificOutput: { ...ALLOW.hookSpecificOutput, additionalContext: ['x'] } }, /^body\.hookSpecificOutput\.additionalContext: not in Allow/],
    // Claude Code's own fields at the top.
    [DENY, { ...DENY, continue: false }, /^body\.continue: Claude Code acts on it, and none of PROTOCOL\.md's answers has it, got false$/],
  ]
  for (const [expected, actual, why] of cases) {
    // By the general rule each one matches: everything the fixture expects is in it.
    assert.equal(mismatch(expected, actual), null)
    assert.match(replyMismatch('/v1/permission', expected, actual, b), why)
  }

  // Whatever the line expects: part of a decision, an error, no decision, or no body at all.
  const echo = adding(ALLOW, { updatedPermissions: setMode })
  assert.match(replyMismatch('/v1/permission', { hookSpecificOutput: { decision: { behavior: 'allow' } } }, echo, b), /updatedPermissions: the deck never sends/)
  assert.match(replyMismatch('/v1/permission', { error: '*' }, { error: 'x', updatedInput: {} }, b, 405), /^body\.updatedInput: the deck never sends/)
  assert.match(replyMismatch('/v1/permission', {}, { updatedPermissions: setMode }, b), /^body\.updatedPermissions: the deck never sends/)
  assert.match(replyMismatch('/v1/permission', {}, { systemMessage: 'Approved' }, b), /^body\.systemMessage: Claude Code acts on it/)
  assert.match(replyMismatch('/v1/permission', undefined, echo, b), /updatedPermissions: the deck never sends/)
  const partialDeny = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', interrupt: true } } }
  assert.match(replyMismatch('/v1/permission', { hookSpecificOutput: { decision: { behavior: 'deny' } } }, partialDeny, b), /^body\.hookSpecificOutput\.decision\.message: missing \(expected "Denied from the Stream Deck\."\)/)

  // PROTOCOL.md's answers pass, and an error answer to a request that isn't one, which Claude Code doesn't parse.
  for (const answer of [ALLOW, DENY, {}]) assert.equal(permissionAnswerMismatch(answer), null)
  assert.equal(replyMismatch('/v1/permission', { error: '*' }, { error: '/v1/permission takes POST' }, b, 405), null)
  assert.equal(replyMismatch('/v1/permission', undefined, DENY, b), null)
  // A line on another route that gives no body checks nothing.
  assert.equal(replyMismatch('/v1/hello', undefined, { v: 1, ok: false, error: 'version' }, b), null)
})

test('match: an answer to a permission request has nothing beyond its body, at the top either: Transport exempts it from "unknown fields are ignored"', () => {
  const b = new Bindings()
  const cases = [
    // The verifier's: each matches by the general rule, as everything the line expects is in it.
    [{}, { note: 'x' }, 200, /^body\.note: not in any of PROTOCOL\.md's answers, got "x" \(an answer is Allow, Deny or \{\} exactly\)$/],
    [ALLOW, { ...ALLOW, note: 'x' }, 200, /^body\.note: not in any of PROTOCOL\.md's answers/],
    [DENY, { ...DENY, extra: { nested: 1 } }, 200, /^body\.extra: not in any of PROTOCOL\.md's answers, got \{"nested":1\}/],
    [undefined, { ...ALLOW, note: 'x' }, 200, /^body\.note: not in any/],
    // Any 2xx is parsed, and its body is one of the three: one that isn't JSON or isn't an object is neither.
    [undefined, undefined, 200, /^body: expected Allow, Deny or \{\}, got nothing$/],
    [undefined, [], 204, /^body: expected Allow, Deny or \{\}, got \[\]$/],
    // An error answer is Transport's, exactly.
    [{ error: '*' }, { error: 'x', note: 'y' }, 405, /^body\.note: not in an error answer, got "y" \(an error answer is \{"error": "<reason>"\} exactly\)$/],
    [undefined, {}, 401, /^body: expected an error answer, \{"error": "<reason>"\}, got \{\}$/],
    [undefined, ALLOW, 500, /^body\.hookSpecificOutput: not in an error answer/],
  ]
  for (const [expected, actual, status, why] of cases) {
    if (expected !== undefined && actual !== undefined) assert.equal(mismatch(expected, actual), null, 'the general rule lets it through')
    assert.match(replyMismatch('/v1/permission', expected, actual, b, status) ?? 'no mismatch', why)
  }
  assert.match(permissionAnswerMismatch({ note: 'x' }), /^body\.note: not in any of PROTOCOL\.md's answers/)
  // Elsewhere the general rule stands: a field added later is fine.
  assert.equal(replyMismatch('/v1/hello', { v: 1, ok: true }, { v: 1, ok: true, note: 'x' }, b), null)
})

test('match: expect lines, field by field', () => {
  const deck = {
    sessions: ['local_b', 'local_a'],
    held: [{ id: 'p1', host: 'local_a', tool: 'Write', kind: 'tool', summary: 's4.txt', fp: 'x' }],
    status: { local_a: 'approval', local_b: 'idle' },
    doing: { local_a: null, local_b: 'npm test' },
    context: { local_a: 12, local_b: null },
    settings: { local_a: { model: 'm', effort: 'low', mode: 'default' } },
    cmds: { 'cmd-3': 'done' },
    jumped: null,
    alert: false,
  }
  const commandId = (label) => ({ c1: 'cmd-3' })[label]
  assert.equal(expectMismatch({ sessions: ['local_a', 'local_b'] }, deck), null)
  assert.match(expectMismatch({ sessions: ['local_a'] }, deck), /sessions: expected \["local_a"\], got \["local_a","local_b"\]/)
  assert.equal(expectMismatch({ held: [{ host: 'local_a', tool: 'Write', kind: 'tool', summary: 's4.txt' }] }, deck), null)
  assert.match(expectMismatch({ held: [] }, deck), /held: expected 0 item/)
  assert.equal(expectMismatch({ status: { local_a: 'approval' }, doing: { local_a: null, local_b: 'npm test' }, context: { local_a: 12 } }, deck), null)
  assert.match(expectMismatch({ status: { local_b: 'done' } }, deck), /status\.local_b: expected "done", got "idle"/)
  assert.match(expectMismatch({ status: { local_c: 'idle' } }, deck), /status\.local_c: missing/)
  assert.equal(expectMismatch({ settings: { local_a: { mode: 'default' } } }, deck), null)
  assert.equal(expectMismatch({ cmds: { c1: 'done' } }, deck, { commandId }), null)
  assert.match(expectMismatch({ cmds: { c1: 'refused' } }, deck, { commandId }), /cmds\.c1 \(cmd-3\): expected "refused", got "done"/)
  assert.match(expectMismatch({ cmds: { c2: 'done' } }, deck, { commandId }), /no command of the deck's is bound to c2/)
  assert.equal(expectMismatch({ jumped: null, alert: false }, deck), null)
  assert.match(expectMismatch({ jumped: 'local_a' }, deck), /jumped: expected "local_a", got null/)
  assert.match(expectMismatch({ helds: [] }, deck), /unknown expect field helds/)
})
