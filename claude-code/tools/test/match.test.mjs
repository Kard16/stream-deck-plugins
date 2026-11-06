import assert from 'node:assert/strict'
import test from 'node:test'

import { Bindings, commandIdHook, exactMismatch, expectMismatch, matches, mismatch, pathMismatch } from '../lib/match.mjs'
import { hookAnswerMismatch, permissionAnswerMismatch, replyMismatch } from '../lib/play.mjs'
import { ALLOW, DENY, answerBody, approvePlanBody } from '../lib/protocol.mjs'

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

test("match: an answer to a permission request is one of PROTOCOL.md's five, whatever the reply line expects", () => {
  const b = new Bindings()
  const adding = (base, extra) => ({ hookSpecificOutput: { ...base.hookSpecificOutput, decision: { ...base.hookSpecificOutput.decision, ...extra } } })
  // approve's request suggests this one: a deck that echoed it into an Allow would raise the session at every Approve.
  const setMode = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const addRules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' }]
  const cases = [
    // updatedPermissions only in an Approve plan, which has its request's input as updatedInput too.
    [ALLOW, adding(ALLOW, { updatedPermissions: setMode }), /^body\.hookSpecificOutput\.decision\.updatedInput: missing \(expected "\*"\) \(a decision is Allow, Deny, an Answer or an Approve plan exactly/],
    // updatedInput alone is an Answer's, whose updatedInput carries its answers.
    [ALLOW, adding(ALLOW, { updatedInput: { command: 'ls' } }), /^body\.hookSpecificOutput\.decision\.updatedInput\.answers: expected an object from each question's text to its answer, got nothing$/],
    // In a Deny, or beside the decision: never.
    [DENY, adding(DENY, { updatedPermissions: addRules }), /^body\.hookSpecificOutput\.decision\.updatedPermissions: the deck sends updatedPermissions only in an Approve plan, in its allow's decision \(PROTOCOL\.md\), got \[\{"type":"addRules"/],
    [DENY, { hookSpecificOutput: { ...DENY.hookSpecificOutput, updatedPermissions: addRules } }, /^body\.hookSpecificOutput\.updatedPermissions: the deck sends updatedPermissions only in an Approve plan/],
    [ALLOW, { hookSpecificOutput: { ...ALLOW.hookSpecificOutput, updatedInput: { answers: {} } } }, /^body\.hookSpecificOutput\.updatedInput: the deck sends updatedInput only in an Answer or an Approve plan, in its allow's decision/],
    // Anything else added to Allow or Deny: they're exact.
    [ALLOW, adding(ALLOW, { message: 'Approved from the deck.' }), /^body\.hookSpecificOutput\.decision\.message: not in Allow, got "Approved from the deck\." \(a decision is Allow, Deny, an Answer or an Approve plan exactly/],
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
  const echo = adding(DENY, { updatedPermissions: setMode })
  assert.match(replyMismatch('/v1/permission', { hookSpecificOutput: { decision: { behavior: 'deny' } } }, echo, b), /updatedPermissions: the deck sends updatedPermissions only in an Approve plan/)
  assert.match(replyMismatch('/v1/permission', { error: '*' }, { error: 'x', updatedInput: {} }, b, 405), /^body\.updatedInput: the deck sends updatedInput only in an Answer or an Approve plan/)
  assert.match(replyMismatch('/v1/permission', {}, { updatedPermissions: setMode }, b), /^body\.updatedPermissions: the deck sends updatedPermissions only in an Approve plan/)
  assert.match(replyMismatch('/v1/permission', {}, { systemMessage: 'Approved' }, b), /^body\.systemMessage: Claude Code acts on it/)
  assert.match(replyMismatch('/v1/permission', undefined, echo, b), /updatedPermissions: the deck sends updatedPermissions only/)
  const partialDeny = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', interrupt: true } } }
  assert.match(replyMismatch('/v1/permission', { hookSpecificOutput: { decision: { behavior: 'deny' } } }, partialDeny, b), /^body\.hookSpecificOutput\.decision\.message: missing \(expected "Denied from the Stream Deck\."\)/)

  // PROTOCOL.md's answers pass, and an error answer to a request that isn't one, which Claude Code doesn't parse.
  const ask = { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }
  for (const answer of [ALLOW, DENY, {}, answerBody(ask, { 'Q?': 'A' }), approvePlanBody({}, 'auto')]) assert.equal(permissionAnswerMismatch(answer), null)
  assert.equal(replyMismatch('/v1/permission', { error: '*' }, { error: '/v1/permission takes POST' }, b, 405), null)
  assert.equal(replyMismatch('/v1/permission', undefined, DENY, b), null)
  // A line on another route that gives no body checks nothing.
  assert.equal(replyMismatch('/v1/hello', undefined, { v: 1, ok: false, error: 'version' }, b), null)
})

const QUESTIONS = { questions: [{ question: 'Which fruits?', options: [{ label: 'Apple' }, { label: 'Plum' }], multiSelect: true }, { question: 'Which size?', options: [{ label: 'Small' }, { label: 'Large' }] }] }
const ASKED = { session_id: 's', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }
const PLAN = { plan: '# Plan\n', planFilePath: '/p.md' }
const PLANNED = { session_id: 's', tool_name: 'ExitPlanMode', tool_input: PLAN }
const WRITE = { session_id: 's', tool_name: 'Write', tool_input: { file_path: '/s/a.txt', content: 'a' } }

test("match: an Answer and an Approve plan have PROTOCOL.md's shape, whatever the line expects", () => {
  const answered = answerBody(QUESTIONS, { 'Which fruits?': 'Apple, Plum', 'Which size?': 'Large' })
  const decision = (d) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...d } } })
  const cases = [
    [decision({ updatedInput: [] }), /^body\.hookSpecificOutput\.decision\.updatedInput: expected the request's tool_input with answers added, got \[\]$/],
    [decision({ updatedInput: { ...QUESTIONS, answers: [] } }), /^body\.hookSpecificOutput\.decision\.updatedInput\.answers: expected an object from each question's text/],
    [decision({ updatedInput: { ...QUESTIONS, answers: { 'Which fruits?': ['Apple', 'Plum'] } } }), /^body\.hookSpecificOutput\.decision\.updatedInput\.answers\.Which fruits\?: an answer is a string, got \["Apple","Plum"\]$/],
    [decision({ updatedInput: QUESTIONS.questions, message: 'x' }), /^body\.hookSpecificOutput\.decision\.message: not in Answer/],
    [{ hookSpecificOutput: { ...answered.hookSpecificOutput, additionalContext: 'x' } }, /^body\.hookSpecificOutput\.additionalContext: not in Answer/],
    // An Approve plan's setMode: one, into auto, acceptEdits or default, for the session.
    [decision({ updatedInput: PLAN, updatedPermissions: [] }), /^body\.hookSpecificOutput\.decision\.updatedPermissions: expected one setMode for the session, got \[\]$/],
    [decision({ updatedInput: PLAN, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }, { type: 'setMode', mode: 'auto', destination: 'session' }] }), /expected one setMode for the session/],
    [decision({ updatedInput: PLAN, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'userSettings' }] }), /^body\.hookSpecificOutput\.decision\.updatedPermissions\[0\]\.destination: expected "session", got "userSettings"/],
    [decision({ updatedInput: PLAN, updatedPermissions: [{ type: 'addRules', mode: 'auto', destination: 'session' }] }), /updatedPermissions\[0\]\.type: expected "setMode", got "addRules"/],
    [decision({ updatedInput: PLAN, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session', rules: [] }] }), /updatedPermissions\[0\]\.rules: not expected, got \[\] \(an Approve plan's updatedPermissions is one setMode, for the session\)$/],
    [decision({ updatedInput: PLAN, updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }), /updatedPermissions\[0\]\.mode: expected one of auto, acceptEdits, default, got "bypassPermissions"$/],
    [decision({ updatedInput: PLAN, updatedPermissions: [{ type: 'setMode', mode: 'plan', destination: 'session' }] }), /mode: expected one of auto, acceptEdits, default, got "plan"$/],
    [decision({ updatedInput: 'plan', updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] }), /^body\.hookSpecificOutput\.decision\.updatedInput: expected the request's tool_input, an object, got "plan"$/],
  ]
  for (const [actual, why] of cases) assert.match(permissionAnswerMismatch(actual) ?? 'no mismatch', why)
  // An Answer's own input is the request's: keys named like the deck's fields inside it are its business.
  assert.equal(permissionAnswerMismatch(answerBody({ ...QUESTIONS, updatedPermissions: [1] }, { 'Which fruits?': 'Apple', 'Which size?': 'Large' })), null)
  assert.equal(permissionAnswerMismatch(approvePlanBody({ plan: 'x', updatedInput: 1 }, 'default')), null)
})

test('match: with the request it answers, an Answer goes only to an AskUserQuestion, echoing its input as it came with an answer for every question; an Approve plan only to an ExitPlanMode, unchanged; and a plain Allow to neither', () => {
  const answers = { 'Which fruits?': 'Apple, Plum', 'Which size?': 'Large' }
  const answered = answerBody(QUESTIONS, answers)
  const approved = approvePlanBody(PLAN, 'acceptEdits')
  const ok = [[answered, ASKED], [approved, PLANNED], [DENY, ASKED], [DENY, PLANNED], [{}, ASKED], [{}, PLANNED], [ALLOW, WRITE], [DENY, WRITE], [{}, WRITE]]
  for (const [actual, request] of ok) assert.equal(permissionAnswerMismatch(actual, 200, request), null, `${JSON.stringify(actual).slice(0, 60)} for ${request.tool_name}`)
  const cases = [
    [answered, WRITE, /^body\.hookSpecificOutput\.decision: an Answer goes only to an AskUserQuestion, and this request is for Write \(PROTOCOL\.md, "Permission requests"\)$/],
    [answered, PLANNED, /an Answer goes only to an AskUserQuestion, and this request is for ExitPlanMode/],
    [approved, ASKED, /^body\.hookSpecificOutput\.decision: an Approve plan goes only to an ExitPlanMode, and this request is for AskUserQuestion/],
    [approved, { session_id: 's' }, /an Approve plan goes only to an ExitPlanMode, and this request is for no tool/],
    [ALLOW, ASKED, /^body\.hookSpecificOutput\.decision: Claude Code ignores a plain Allow for AskUserQuestion, which needs the person: the deck answers one with an Answer, a Deny or \{\}$/],
    [ALLOW, PLANNED, /Claude Code ignores a plain Allow for ExitPlanMode, which needs the person: the deck answers one with an Approve plan, a Deny or \{\}$/],
    // The echo: as it came, with answers added, and nothing else.
    [answerBody({ ...QUESTIONS, metadata: { x: 1 } }, answers), ASKED, /^body\.hookSpecificOutput\.decision\.updatedInput\.metadata: not expected, got \{"x":1\} \(an Answer's updatedInput is the request's tool_input exactly as it came, with answers added\)$/],
    [answerBody({ questions: QUESTIONS.questions.slice(0, 1) }, answers), ASKED, /updatedInput\.questions: expected 2 item\(s\), got 1/],
    [answerBody({ questions: [{ ...QUESTIONS.questions[0], multiSelect: false }, QUESTIONS.questions[1]] }, answers), ASKED, /updatedInput\.questions\[0\]\.multiSelect: expected true, got false/],
    [answerBody(QUESTIONS, { 'Which fruits?': 'Apple' }), ASKED, /^body\.hookSpecificOutput\.decision\.updatedInput\.answers: no answer for "Which size\?", and every question gets one$/],
    [answerBody(QUESTIONS, { ...answers, 'Which colour?': 'Red' }), ASKED, /updatedInput\.answers\.Which colour\?: none of the request's questions asks it$/],
    [answerBody(QUESTIONS, answers), { ...ASKED, tool_input: 'x' }, /^body\.hookSpecificOutput\.decision\.updatedInput: the request has no tool_input for an Answer to echo, got "x"$/],
    [approvePlanBody({ ...PLAN, plan: '# Plan, edited\n' }, 'auto'), PLANNED, /^body\.hookSpecificOutput\.decision\.updatedInput\.plan: expected "# Plan\\n", got "# Plan, edited\\n" \(an Approve plan's updatedInput is the request's tool_input, unchanged\)$/],
    [approvePlanBody({}, 'auto'), PLANNED, /updatedInput\.plan: missing/],
    [approvePlanBody(PLAN, 'auto'), { ...PLANNED, tool_input: {} }, /updatedInput\.plan: not expected/],
  ]
  for (const [actual, request, why] of cases) assert.match(permissionAnswerMismatch(actual, 200, request) ?? 'no mismatch', why)
  // The echo is compared literally: a "*" in the request is a "*", not any value.
  const starred = { ...ASKED, tool_input: { ...QUESTIONS, metadata: '*' } }
  assert.equal(permissionAnswerMismatch(answerBody({ ...QUESTIONS, metadata: '*' }, answers), 200, starred), null)
  assert.match(permissionAnswerMismatch(answerBody({ ...QUESTIONS, metadata: 'other' }, answers), 200, starred), /updatedInput\.metadata: expected "\*", got "other"/)
  // A request whose own input has answers already: the Answer's replace them.
  assert.equal(permissionAnswerMismatch(answerBody({ ...QUESTIONS, answers: { old: 'x' } }, answers), 200, { ...ASKED, tool_input: { ...QUESTIONS, answers: { old: 'x' } } }), null)
})

test('match: an Answer or an Approve plan, expected or got, must equal the expected body exactly, updatedInput included', () => {
  const b = new Bindings()
  const answers = { 'Which fruits?': 'Apple, Plum', 'Which size?': 'Large' }
  const answered = answerBody(QUESTIONS, answers)
  assert.equal(replyMismatch('/v1/permission', answered, structuredClone(answered), b, 200, ASKED), null)
  const cases = [
    // An Allow expected, an Answer got: by the general rule it would match.
    [ALLOW, answered, WRITE, /an Answer goes only to an AskUserQuestion/],
    [ALLOW, answered, undefined, /^body\.hookSpecificOutput\.decision\.updatedInput: not expected, got .* \(an Answer or an Approve plan must equal the expected body exactly, updatedInput included\)$/],
    // An Answer expected: one whose answer differs, or whose updatedInput has a key of its own.
    [answered, answerBody(QUESTIONS, { ...answers, 'Which fruits?': 'Plum, Apple' }), ASKED, /^body\.hookSpecificOutput\.decision\.updatedInput\.answers\.Which fruits\?: expected "Apple, Plum", got "Plum, Apple" \(an Answer or an Approve plan must equal/],
    [answered, answerBody({ ...QUESTIONS, extra: 1 }, answers), undefined, /updatedInput\.extra: not expected, got 1 \(an Answer or an Approve plan must equal/],
    [answered, ALLOW, undefined, /^body\.hookSpecificOutput\.decision\.updatedInput: missing/],
    [answered, ALLOW, ASKED, /Claude Code ignores a plain Allow for AskUserQuestion/],
    [answered, {}, ASKED, /^body\.hookSpecificOutput: missing/],
    // An Approve plan into another mode.
    [approvePlanBody(PLAN, 'acceptEdits'), approvePlanBody(PLAN, 'auto'), PLANNED, /updatedPermissions\[0\]\.mode: expected "acceptEdits", got "auto"/],
    [approvePlanBody(PLAN, 'acceptEdits'), DENY, PLANNED, /decision\.behavior: expected "allow", got "deny"/],
  ]
  for (const [expected, actual, request, why] of cases) assert.match(replyMismatch('/v1/permission', expected, actual, b, 200, request) ?? 'no mismatch', why)
  // The two the general rule alone lets through: an Answer where an Allow is expected, and one with a key of its own.
  assert.equal(mismatch(ALLOW, answered), null)
  assert.equal(mismatch(answered, answerBody({ ...QUESTIONS, extra: 1 }, answers)), null)
  // `at` is compared too, at any depth, though the general rule never compares it.
  const atInput = { questions: [{ question: 'Q?', options: [{ label: 'A' }] }], at: 1 }
  assert.match(replyMismatch('/v1/permission', answerBody(atInput, { 'Q?': 'A' }), answerBody({ ...atInput, at: 2 }, { 'Q?': 'A' }), b) ?? 'no mismatch', /updatedInput\.at: expected 1, got 2/)
  // exactMismatch on its own: both ways, "*" for any value there unless told otherwise.
  assert.equal(exactMismatch({ a: [1, { b: '*' }] }, { a: [1, { b: null }] }), null)
  assert.equal(exactMismatch({ a: '*' }, {}), 'a: missing (expected "*")')
  assert.equal(exactMismatch({ a: 1 }, { a: 1, b: 2 }), 'b: not expected, got 2')
  assert.equal(exactMismatch({ a: '*' }, { a: 1 }, '', { wildcard: false }), 'a: expected "*", got 1')
})

test('match: an answer to a permission request has nothing beyond its body, at the top either: Transport exempts it from "unknown fields are ignored"', () => {
  const b = new Bindings()
  const cases = [
    // The verifier's: each matches by the general rule, as everything the line expects is in it.
    [{}, { note: 'x' }, 200, /^body\.note: not in any of PROTOCOL\.md's answers, got "x" \(an answer is Allow, Deny, an Answer, an Approve plan or \{\} exactly\)$/],
    [ALLOW, { ...ALLOW, note: 'x' }, 200, /^body\.note: not in any of PROTOCOL\.md's answers/],
    [DENY, { ...DENY, extra: { nested: 1 } }, 200, /^body\.extra: not in any of PROTOCOL\.md's answers, got \{"nested":1\}/],
    [undefined, { ...ALLOW, note: 'x' }, 200, /^body\.note: not in any/],
    // Any 2xx is parsed, and its body is one of the five: one that isn't JSON or isn't an object is none of them.
    [undefined, undefined, 200, /^body: expected Allow, Deny, an Answer, an Approve plan or \{\}, got nothing$/],
    [undefined, [], 204, /^body: expected Allow, Deny, an Answer, an Approve plan or \{\}, got \[\]$/],
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
  // Another hook's answer, a PreToolUse's, is none of the five.
  assert.match(permissionAnswerMismatch({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }), /^body\.hookSpecificOutput\.hookEventName: expected "PermissionRequest", got "PreToolUse"/)
  // Elsewhere the general rule stands: a field added later is fine.
  assert.equal(replyMismatch('/v1/hello', { v: 1, ok: true }, { v: 1, ok: true, note: 'x' }, b), null)
  // The permission hook's route is Claude Code's only one since the mode check went (PROTOCOL.md, 2026-11-06).
  for (const route of ['/v1/hello', '/v1/pretool']) assert.throws(() => hookAnswerMismatch(route, {}), /isn't one of the hooks' routes/, route)
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
