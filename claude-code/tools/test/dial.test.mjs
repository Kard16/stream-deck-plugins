// The fake deck's Session Slot dial (PROTOCOL.md, "Permission requests" and "Held requests", as amended on 2026-11-04
// for session keys): what its strip shows for each kind of request, the Answer and the Approve plan it sends, the
// presses it alerts on, and the first answer winning between the keys and the dials. Driven directly, on fake clocks.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BadRequest, FakeDeck } from '../lib/deck.mjs'
import { ALLOW, ASK_INPUT_MAX, DENY, answerBody, approvePlanBody, fingerprint } from '../lib/protocol.mjs'
import { fakeTimers, responder } from './helpers.mjs'

const A = { sid: 'sid-a', host: 'local_a', inst: 'ia', pid: 1 }
const B = { sid: 'sid-b', host: 'local_b', inst: 'ib', pid: 2 }

const COLOR = { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiSelect: false }] }
const FRUIT = {
  questions: [
    { question: 'Which fruits?', header: 'Fruit', options: [{ label: 'Apple' }, { label: 'Pear, ripe' }, { label: 'Plum' }, { label: 'Say "hi"' }], multiSelect: true },
    { question: 'Which size?', header: 'Size', options: [{ label: 'Small, round' }, { label: 'Large' }], multiSelect: false },
  ],
  // Fields the dial doesn't read go back as they came.
  metadata: { source: 'remember' },
}
const PLAN = { plan: '# Plan\n\n1. Create s10.txt containing: ten.\n', planFilePath: '/Users/me/.claude/plans/tidy-otter.md' }
const W1 = { file_path: '/s/one.txt', content: '1' }

function setup() {
  const clock = fakeTimers()
  const log = []
  const deck = new FakeDeck({ now: clock.wall, monoNow: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (e) => log.push(e) })
  const reg = (...sessions) => deck.applyRegistry(sessions.map(([S, status]) => ({ pid: S.pid, sessionId: S.sid, hostSessionId: S.host, name: S.host, status, statusUpdatedAt: clock.now() })))
  const perm = (S, tool, input, { scrubbed } = {}) => {
    const r = responder()
    const out = deck.permission({ body: { session_id: S.sid, tool_name: tool, tool_input: input, permission_mode: 'default' }, hostHeader: S.host, responder: r, inputScrubbed: scrubbed })
    return { r, ...out }
  }
  const seq = new Map()
  const ev = (S, ...events) => {
    seq.set(S.host, (seq.get(S.host) ?? 0) + 1)
    deck.events({ sid: S.sid, host: S.host, inst: S.inst, seq: seq.get(S.host), events: events.map((e) => ({ at: clock.now(), ...e })) })
  }
  const dial = (S, press) => deck.dial({ host: S.host, ...press })
  return { deck, clock, log, reg, perm, ev, dial, view: () => deck.view() }
}

/** The one answer a request got, or null for none. */
const answer = (p) => (p.r.sent.length ? p.r.sent[0].json : null)

test("dial: a tool request: its session's dial allows or denies the session's own oldest, whatever is older elsewhere", () => {
  // dial-approve: B asked first, so the keys show B's, but A's dial answers A's.
  const { deck, reg, perm, dial, view } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  const b1 = perm(B, 'Bash', { command: 'npm test' })
  const a1 = perm(A, 'Write', W1)
  const a2 = perm(A, 'Bash', { command: 'make' })
  let r = dial(A, { decision: 'allow' })
  assert.deepEqual([r.ok, r.alert, r.request, r.answered, r.key, r.session], [true, false, a1.id, 'allow', 'dial', A.host])
  assert.deepEqual([answer(a1), answer(b1), answer(a2)], [ALLOW, null, null], "A's oldest, and only it")
  r = dial(A, { decision: 'deny' })
  assert.deepEqual([r.request, answer(a2)], [a2.id, DENY], 'then the next, once the strip shows it')
  r = dial(B, { decision: 'deny' })
  assert.deepEqual([r.request, answer(b1)], [b1.id, DENY])
  assert.deepEqual([view().held, view().alert], [[], false])
  // Each answered exactly once.
  assert.deepEqual([a1.r.sent.length, a2.r.sent.length, b1.r.sent.length], [1, 1, 1])
  assert.equal(deck.press('approve').error, 'nothing is held')
})

test('dial: an AskUserQuestion: the picks make the Answer, the input as it came with answers added; a multi-select one joins its labels in the order of its options, quoting those with ", " or a double quote', () => {
  const { reg, perm, dial, view, log } = setup()
  reg([A, 'waiting'])
  const cases = [
    // [picks, answers]
    [{ 'Which fruits?': ['Plum', 'Apple'], 'Which size?': ['Small, round'] }, { 'Which fruits?': 'Apple, Plum', 'Which size?': 'Small, round' }],
    [{ 'Which fruits?': ['Pear, ripe', 'Apple', 'Pear, ripe'], 'Which size?': ['Large'] }, { 'Which fruits?': 'Apple, "Pear, ripe"', 'Which size?': 'Large' }],
    [{ 'Which fruits?': ['Say "hi"'], 'Which size?': ['Large'] }, { 'Which fruits?': '"Say \\"hi\\""', 'Which size?': 'Large' }],
    [{ 'Which size?': ['Large'], 'Which fruits?': ['Say "hi"', 'Plum', 'Pear, ripe', 'Apple'] }, { 'Which fruits?': 'Apple, "Pear, ripe", Plum, "Say \\"hi\\""', 'Which size?': 'Large' }],
  ]
  for (const [picks, answers] of cases) {
    const p = perm(A, 'AskUserQuestion', FRUIT)
    const r = dial(A, { picks })
    assert.deepEqual([r.ok, r.answered, r.answers], [true, 'answer', answers], JSON.stringify(picks))
    assert.deepEqual(answer(p), answerBody(FRUIT, answers))
    assert.deepEqual(answer(p).hookSpecificOutput.decision.updatedInput, { ...FRUIT, answers }, 'exactly as it came, with answers')
  }
  // One question, single-select: its label as it is.
  const p = perm(A, 'AskUserQuestion', COLOR)
  dial(A, { picks: { 'Red or blue?': ['Blue'] } })
  assert.deepEqual(answer(p), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...COLOR, answers: { 'Red or blue?': 'Blue' } } } } })
  assert.deepEqual(view().held, [])
  const answered = log.filter((e) => e.kind === 'answered').at(-1)
  assert.deepEqual([answered.decision, answered.by, answered.answers], ['answer', 'dial', { 'Red or blue?': 'Blue' }])
})

test("dial: picks or a press the strip can't make alert and send nothing, and the request stays held", () => {
  const { reg, perm, dial, view } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  const q = perm(A, 'AskUserQuestion', FRUIT)
  const both = { 'Which fruits?': ['Apple'], 'Which size?': ['Large'] }
  const cases = [
    [{ picks: { ...both, 'Which colour?': ['Red'] } }, /^the strip asks no question "Which colour\?"; it asks "Which fruits\?", "Which size\?"$/],
    [{ picks: { 'Which fruits?': ['Apple'] } }, /^nothing picked for "Which size\?": every question gets an answer$/],
    [{ picks: { ...both, 'Which size?': ['Medium'] } }, /^"Which size\?" has no option "Medium"; its options are "Small, round", "Large"$/],
    [{ picks: { ...both, 'Which size?': ['Large', 'Small, round'] } }, /^"Which size\?" is single-select, and got 2 picks$/],
    [{ picks: { ...both, 'Which fruits?': [] } }, /^nothing picked for "Which fruits\?": a multi-select question needs at least one tick$/],
    [{ picks: { ...both, 'Which size?': [] } }, /^nothing picked for "Which size\?": every question gets an answer$/],
    [{ decision: 'allow' }, /is a question: its dial answers it with picks$/],
    [{ plan: 'auto' }, /is a question: its dial answers it with picks$/],
  ]
  for (const [press, why] of cases) {
    const r = dial(A, press)
    assert.deepEqual([r.ok, r.alert, r.request], [false, true, q.id], JSON.stringify(press))
    assert.match(r.error, why)
    assert.equal(view().alert, true)
  }
  const t = perm(B, 'Write', W1)
  const plan = perm(A, 'ExitPlanMode', PLAN)
  for (const [S, press, why] of [[B, { picks: both }, /is an approval for Write: its dial allows or denies it$/], [B, { plan: 'reject' }, /is an approval/]]) {
    assert.match(dial(S, press).error, why)
  }
  assert.deepEqual([q.r.sent, t.r.sent, plan.r.sent], [[], [], []], 'nothing sent')
  assert.deepEqual(view().held.map((h) => h.id), [q.id, t.id, plan.id], 'all still held')
  // The plan is A's second: its strip shows the question until that's answered.
  dial(A, { picks: both })
  for (const press of [{ decision: 'allow' }, { picks: both }]) assert.match(dial(A, press).error, /is a plan: its dial approves it into a mode, or rejects it$/)
  assert.equal(plan.r.sent.length, 0)
})

test("dial: an ExitPlanMode: an Approve plan into each mode, the input unchanged, and reject as the keys' Deny", () => {
  const { reg, perm, dial, log } = setup()
  reg([A, 'waiting'])
  for (const [mode, input] of [['auto', PLAN], ['acceptEdits', PLAN], ['default', {}]]) {
    const p = perm(A, 'ExitPlanMode', input)
    const r = dial(A, { plan: mode })
    assert.deepEqual([r.ok, r.answered, r.mode], [true, 'approve plan', mode])
    assert.deepEqual(answer(p), approvePlanBody(input, mode))
    assert.deepEqual(answer(p).hookSpecificOutput.decision.updatedPermissions, [{ type: 'setMode', mode, destination: 'session' }])
    assert.deepEqual(answer(p).hookSpecificOutput.decision.updatedInput, input, 'unchanged: {} with no plan file')
  }
  const p = perm(A, 'ExitPlanMode', PLAN)
  const r = dial(A, { plan: 'reject' })
  assert.deepEqual([r.answered, answer(p)], ['deny', DENY], 'a dial rejects a plan with Deny')
  assert.deepEqual(log.filter((e) => e.kind === 'answered').map((e) => [e.decision, e.mode ?? null]), [['approve plan', 'auto'], ['approve plan', 'acceptEdits'], ['approve plan', 'default'], ['deny', null]])
})

test('dial: the first answer wins: a press for a request that has gone, answered or released, alerts and sends nothing', () => {
  const { deck, reg, perm, ev, dial, view } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  // Never shown anything.
  let r = dial(A, { decision: 'allow' })
  assert.deepEqual([r.alert, r.error], [true, "local_a's dial has shown no request"])

  // A key answers first: the dial's press for it alerts.
  const p1 = perm(A, 'Write', W1)
  assert.equal(deck.press('approve', { shown: p1.id }).answered, 'allow')
  r = dial(A, { decision: 'deny' })
  assert.deepEqual([r.alert, r.error, r.request], [true, `${p1.id}, the request the dial showed, has gone (answered)`, p1.id])
  assert.deepEqual(p1.r.sent, [{ status: 200, json: ALLOW }], 'answered once, by the key')

  // The dial answers first: the key's press for it alerts, and so does the dial's next.
  const p2 = perm(A, 'Write', W1)
  assert.equal(dial(A, { decision: 'allow' }).request, p2.id)
  assert.match(deck.press('deny', { shown: p2.id }).error, /^nothing is held$/)
  assert.match(dial(A, { decision: 'deny' }).error, /has gone \(answered\)$/)
  assert.deepEqual(p2.r.sent, [{ status: 200, json: ALLOW }])

  // dial-gone: answered in the app, the tool's end releases it, and the dial's press alerts.
  const p3 = perm(A, 'AskUserQuestion', COLOR)
  ev(A, { t: 'tool.end', tool: 'AskUserQuestion', use: 'u6', fp: fingerprint('AskUserQuestion', COLOR), ok: true })
  assert.deepEqual(p3.r.sent, [{ status: 200, json: {} }])
  r = dial(A, { picks: { 'Red or blue?': ['Red'] } })
  assert.deepEqual([r.alert, r.error], [true, `${p3.id}, the request the dial showed, has gone (released)`])
  assert.equal(p3.r.sent.length, 1, 'nothing more sent')

  // A press as a dial whose strip showed a request: another session's, a younger one, or one that's gone.
  const a = perm(A, 'Write', W1)
  const a2 = perm(A, 'Bash', { command: 'make' })
  const b = perm(B, 'Write', W1)
  assert.match(dial(A, { decision: 'allow', shown: b.id }).error, new RegExp(`^${b.id} is local_b's request, not local_a's$`))
  assert.match(dial(A, { decision: 'allow', shown: a2.id }).error, new RegExp(`^the dial showed ${a2.id}; local_a's oldest held request is ${a.id}$`))
  assert.match(dial(A, { decision: 'allow', shown: p1.id }).error, /has gone \(answered\)$/)
  assert.match(dial(A, { decision: 'allow', shown: 'p99' }).error, /^no request p99$/)
  assert.match(dial(A, { decision: 'allow', shown: null }).error, /has shown no request$/)
  assert.deepEqual([a.r.sent, a2.r.sent, b.r.sent], [[], [], []])
  assert.equal(dial(A, { decision: 'allow', shown: a.id }).request, a.id, 'the one it shows')

  // A request whose client went away: the press alerts, and it's no longer held.
  a2.r.open = false
  r = dial(A, { decision: 'allow' })
  assert.deepEqual([r.alert, r.error], [true, `${a2.id} had gone`])
  assert.deepEqual(view().held.map((h) => h.id), [b.id])
})

test("dial: its strip shows its session's oldest held request, and the next once that has gone, however it went", () => {
  const { deck, reg, perm, ev, dial } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  const p1 = perm(A, 'Write', W1)
  const p2 = perm(A, 'AskUserQuestion', COLOR)
  const p3 = perm(A, 'ExitPlanMode', PLAN)
  perm(B, 'Write', W1)
  assert.deepEqual(deck.state().dials, { [A.host]: p1.id, [B.host]: 'p4' })
  // Released by its tool.end: the strip shows the question.
  ev(A, { t: 'tool.end', tool: 'Write', use: 'u1', fp: fingerprint('Write', W1), ok: true })
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  assert.equal(deck.state().dials[A.host], p2.id)
  assert.equal(dial(A, { picks: { 'Red or blue?': ['Red'] } }).request, p2.id)
  assert.equal(dial(A, { plan: 'acceptEdits' }).request, p3.id)
  // With none left, the dial still showed the last.
  assert.equal(deck.state().dials[A.host], p3.id)
})

/** An AskUserQuestion's input whose JSON is `bytes` long, padded with `fill` in an option's description. */
function sized(bytes, fill = 'x') {
  const input = (pad) => ({ questions: [{ question: 'Q?', options: [{ label: 'A', description: pad }, { label: 'B' }], multiSelect: false }] })
  const base = Buffer.byteLength(JSON.stringify(input('')))
  const unit = Buffer.byteLength(fill)
  assert.equal((bytes - base) % unit, 0, 'a size the fill can make')
  const out = input(fill.repeat((bytes - base) / unit))
  assert.equal(Buffer.byteLength(JSON.stringify(out)), bytes)
  return out
}

test('dial: a held ask request keeps its tool_input up to 64 KiB of JSON, in bytes; over that, the strip says Answer in app, and any press jumps', () => {
  const { reg, perm, dial, view } = setup()
  reg([A, 'waiting'])
  const kept = sized(ASK_INPUT_MAX)
  const p1 = perm(A, 'AskUserQuestion', kept)
  assert.equal(view().held[0].dial.screen, 'question')
  dial(A, { picks: { 'Q?': ['B'] } })
  assert.deepEqual(answer(p1), answerBody(kept, { 'Q?': 'B' }), 'echoed whole, at the limit')

  // A byte over, and a form well under 64 Ki UTF-16 units that is over 64 KiB of UTF-8.
  const wide = sized(ASK_INPUT_MAX + 2, 'é')
  assert.ok(JSON.stringify(wide).length < ASK_INPUT_MAX, 'fewer code units than the limit')
  for (const [tool, input] of [['AskUserQuestion', sized(ASK_INPUT_MAX + 1)], ['AskUserQuestion', wide], ['ExitPlanMode', { plan: 'x'.repeat(ASK_INPUT_MAX) }]]) {
    const p = perm(A, tool, input)
    const shown = view().held.find((h) => h.id === p.id).dial
    assert.equal(shown.screen, 'answer-in-app')
    assert.match(shown.why, new RegExp(`^its tool_input is ${Buffer.byteLength(JSON.stringify(input))} bytes of JSON, over the ${ASK_INPUT_MAX} the deck keeps$`))
    for (const press of [{ picks: { 'Q?': ['A'] } }, { plan: 'auto' }, { decision: 'allow' }]) {
      const r = dial(A, press)
      assert.deepEqual([r.ok, r.alert, r.jumped, r.request], [true, false, A.host, p.id], `${tool}: ${JSON.stringify(press)}`)
      assert.equal(view().jumped, A.host)
    }
    assert.equal(p.r.sent.length, 0, 'nothing sent: the user answers in the app')
    // Released, as the app's answer releases it, so the next one is on the strip.
    p.r.open = false
    dial(A, { decision: 'allow' })
  }
})

test("dial: a question or plan the dial can't read says Answer in app, and any press jumps", () => {
  const { reg, perm, dial, view } = setup()
  reg([A, 'waiting'])
  const q = (over) => ({ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], ...over })
  const cases = [
    ['AskUserQuestion', {}, 'it has no list of questions to read'],
    ['AskUserQuestion', { questions: [] }, 'it has no list of questions to read'],
    ['AskUserQuestion', { questions: 'Q?' }, 'it has no list of questions to read'],
    ['AskUserQuestion', [q()], 'it has no list of questions to read'],
    ['AskUserQuestion', undefined, 'it has no tool_input'],
    ['AskUserQuestion', { questions: [q({ question: '' })] }, 'question 1 has no text'],
    ['AskUserQuestion', { questions: [q(), 'Q2?'] }, 'question 2 has no text'],
    ['AskUserQuestion', { questions: [q(), q()] }, 'two questions ask "Q?", and the answers go by a question\'s text'],
    ['AskUserQuestion', { questions: [q({ multiSelect: 'yes' })] }, "question 1's multiSelect isn't a boolean"],
    ['AskUserQuestion', { questions: [q({ multiSelect: null })] }, "question 1's multiSelect isn't a boolean"],
    // A header or a description that's there must be a string, null included, as the real deck's parseAskForm reads
    // them (claude-code/deck/src/protocol/ask.ts): its strip shows both.
    ['AskUserQuestion', { questions: [q({ header: 5 })] }, "question 1's header isn't a string"],
    ['AskUserQuestion', { questions: [q(), q({ question: 'Q2?', header: null })] }, "question 2's header isn't a string"],
    ['AskUserQuestion', { questions: [q({ options: [{ label: 'A', description: 7 }, { label: 'B' }] })] }, `the description of question 1's option "A" isn't a string`],
    ['AskUserQuestion', { questions: [q({ options: [{ label: 'A' }, { label: 'B', description: null }] })] }, `the description of question 1's option "B" isn't a string`],
    ['AskUserQuestion', { questions: [q({ options: [] })] }, 'question 1 has no options to pick from'],
    ['AskUserQuestion', { questions: [{ question: 'Name?', kind: 'text' }] }, 'question 1 has no options to pick from'],
    ['AskUserQuestion', { questions: [q({ options: [{ label: 'A' }, { description: 'no label' }] })] }, 'an option of question 1 has no label'],
    ['AskUserQuestion', { questions: [q({ options: [{ label: '' }, { label: 'B' }] })] }, 'an option of question 1 has no label'],
    ['AskUserQuestion', { questions: [q({ options: [{ label: 'A' }, { label: 'A' }] })] }, 'two options of question 1 have the label "A"'],
    ['ExitPlanMode', 'a plan', "its tool_input isn't an object"],
    ['ExitPlanMode', undefined, 'it has no tool_input'],
  ]
  for (const [tool, input, why] of cases) {
    const p = perm(A, tool, input)
    assert.deepEqual(view().held.at(-1).dial, { screen: 'answer-in-app', why }, `${tool} ${JSON.stringify(input)}`)
    const r = dial(A, tool === 'ExitPlanMode' ? { plan: 'auto' } : { picks: { 'Q?': ['A'] } })
    assert.deepEqual([r.ok, r.alert, r.jumped, r.why], [true, false, A.host, why])
    assert.equal(p.r.sent.length, 0)
    p.r.open = false
    dial(A, { decision: 'deny' })
  }
  // What it can read: no header, no multiSelect (single-select), and options with no description.
  const plain = { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] }
  let p = perm(A, 'AskUserQuestion', plain)
  assert.deepEqual(view().held.at(-1).dial, { screen: 'question', questions: [{ question: 'Q?', header: null, multiSelect: false, labels: ['A', 'B'] }] })
  assert.match(dial(A, { picks: { 'Q?': ['A', 'B'] } }).error, /is single-select/)
  dial(A, { picks: { 'Q?': ['B'] } })
  assert.deepEqual(answer(p).hookSpecificOutput.decision.updatedInput, { ...plain, answers: { 'Q?': 'B' } })
  // An empty header and description are strings, and fields neither side reads go back as they came.
  const odd = { questions: [{ question: 'Q?', header: '', options: [{ label: 'A', description: '' }, { label: 'B', icon: 7 }], multiSelect: false, kind: null }], extra: [1] }
  p = perm(A, 'AskUserQuestion', odd)
  assert.deepEqual(view().held.at(-1).dial, { screen: 'question', questions: [{ question: 'Q?', header: '', multiSelect: false, labels: ['A', 'B'] }] })
  dial(A, { picks: { 'Q?': ['A'] } })
  assert.deepEqual(answer(p).hookSpecificOutput.decision.updatedInput, { ...odd, answers: { 'Q?': 'A' } })
})

test("dial: a plan's first line on its strip is the real deck's: the first line with text, without a heading's marks, whole", () => {
  const { reg, perm, dial, view } = setup()
  reg([A, 'waiting'])
  const long = `Step ${'x'.repeat(200)}`
  const cases = [
    // [tool_input, the line]
    [PLAN, 'Plan'],
    [{ plan: '   # Title\nmore' }, 'Title'],
    [{ plan: '\n\n  ## Tidy the deck  \nmore' }, 'Tidy the deck'],
    [{ plan: '#\n\n# \n\t ###\t\nReal line' }, 'Real line'],
    [{ plan: '# Title\rsecond' }, 'Title'],
    [{ plan: '\r\n\r\nStep one\r\nStep two' }, 'Step one'],
    [{ plan: '#hashtag ##' }, 'hashtag ##'],
    [{ plan: long }, long],
    [{ plan: '' }, null],
    [{ plan: '  \n #\r\n' }, null],
    [{ plan: 3 }, null],
    [{}, null],
  ]
  for (const [input, line] of cases) {
    const p = perm(A, 'ExitPlanMode', input)
    assert.deepEqual(view().held.at(-1).dial, { screen: 'plan', plan: line }, JSON.stringify(input).slice(0, 60))
    dial(A, { plan: 'reject' })
    assert.deepEqual(answer(p), DENY)
  }
})

test('dial: a request answered elsewhere makes the press alert only until the session holds a newer one, which the press then answers (dial-next)', () => {
  // The fixture, with a press between: A's question goes, answered in the app; a press then is for it, and alerts.
  // Its next request, a Bash held after, takes the strip, and the press allows it.
  const { reg, perm, ev, dial, view } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  const p1 = perm(A, 'AskUserQuestion', COLOR)
  ev(A, { t: 'tool.end', tool: 'AskUserQuestion', use: 'u6', fp: fingerprint('AskUserQuestion', COLOR), ok: true })
  assert.deepEqual([p1.r.sent, view().held], [[{ status: 200, json: {} }], []])
  // Another session's request changes nothing for A's dial.
  const b1 = perm(B, 'Bash', { command: 'make' })
  for (const press of [{ decision: 'allow' }, { picks: { 'Red or blue?': ['Red'] } }]) {
    const r = dial(A, press)
    assert.deepEqual([r.alert, r.request, r.error], [true, p1.id, `${p1.id}, the request the dial showed, has gone (released)`], JSON.stringify(press))
  }
  const p2 = perm(A, 'Bash', { command: 'npm test' })
  const r = dial(A, { decision: 'allow' })
  assert.deepEqual([r.ok, r.alert, r.request, r.answered], [true, false, p2.id, 'allow'])
  assert.deepEqual([answer(p2), view().alert, b1.r.sent], [ALLOW, false, []])
  // With nothing newer since, a press for p2 alerts again: the dial answered it, and it has gone.
  assert.equal(dial(A, { decision: 'allow' }).error, `${p2.id}, the request the dial showed, has gone (answered)`)
})

test("dial: a tool_input the bridge scrubbed a run of the token out of isn't kept: it can't go back as it came", () => {
  const { reg, perm, dial, view } = setup()
  reg([A, 'waiting'])
  for (const [tool, press] of [['AskUserQuestion', { picks: { 'Red or blue?': ['Red'] } }], ['ExitPlanMode', { plan: 'auto' }]]) {
    const p = perm(A, tool, tool === 'ExitPlanMode' ? PLAN : COLOR, { scrubbed: true })
    assert.deepEqual(view().held.at(-1).dial, { screen: 'answer-in-app', why: "the bridge scrubbed a run of the token out of its tool_input, so it can't echo the input back as it came" })
    assert.equal(dial(A, press).jumped, A.host)
    assert.equal(p.r.sent.length, 0)
    p.r.open = false
    dial(A, press)
  }
  // A tool request's input is never echoed, scrubbed or not: its dial sends the keys' Allow.
  const t = perm(A, 'Write', W1, { scrubbed: true })
  dial(A, { decision: 'allow' })
  assert.deepEqual(answer(t), ALLOW)
})

test("dial: the keys still only jump on an ask request, and the view shows what each request's strip shows", () => {
  const { deck, reg, perm, view } = setup()
  reg([A, 'waiting'])
  const q = perm(A, 'AskUserQuestion', FRUIT)
  perm(A, 'ExitPlanMode', PLAN)
  perm(A, 'ExitPlanMode', {})
  perm(A, 'Write', W1)
  assert.deepEqual(view().held.map((h) => h.dial), [
    {
      screen: 'question',
      questions: [
        { question: 'Which fruits?', header: 'Fruit', multiSelect: true, labels: ['Apple', 'Pear, ripe', 'Plum', 'Say "hi"'] },
        { question: 'Which size?', header: 'Size', multiSelect: false, labels: ['Small, round', 'Large'] },
      ],
    },
    { screen: 'plan', plan: 'Plan' },
    { screen: 'plan', plan: null },
    { screen: 'approval' },
  ])
  for (const key of ['approve', 'deny']) {
    const r = deck.press(key)
    assert.deepEqual([r.jumped, r.answered, r.alert], [A.host, undefined, false], key)
  }
  assert.equal(q.r.sent.length, 0)
  assert.equal(view().status[A.host], 'approval', 'a tool request is held too')
})

test('dial: a press that isn\'t one gets 400: a host, and one of picks, decision and plan, each of its kind', () => {
  const { deck, reg, perm } = setup()
  reg([A, 'waiting'])
  perm(A, 'Write', W1)
  const bad = [
    [{ decision: 'allow' }, /^host must be a session host/],
    [{ host: '', decision: 'allow' }, /^host must be a session host/],
    [{ host: A.host }, /^a dial press has one of picks, decision and plan; got none$/],
    [{ host: A.host, decision: 'allow', plan: 'auto' }, /got decision, plan$/],
    [{ host: A.host, decision: 'approve' }, /^decision must be allow or deny$/],
    [{ host: A.host, plan: 'plan' }, /^plan must be one of auto, acceptEdits, default, reject$/],
    [{ host: A.host, plan: 'bypassPermissions' }, /^plan must be one of/],
    [{ host: A.host, picks: ['Red'] }, /^picks maps each question's text to a list of the labels picked for it$/],
    [{ host: A.host, picks: { 'Q?': 'Red' } }, /^picks maps/],
    [{ host: A.host, picks: { 'Q?': [1] } }, /^picks maps/],
    [{ host: A.host, decision: 'allow', shown: 3 }, /^shown must be the id of a request/],
  ]
  for (const [press, why] of bad) assert.throws(() => deck.dial(press), (err) => err instanceof BadRequest && why.test(err.message), JSON.stringify(press))
  assert.equal(deck.view().held.length, 1, 'nothing answered')
})

test('dial: a reset forgets what each dial showed', () => {
  const { deck, reg, perm, dial } = setup()
  reg([A, 'waiting'])
  const p = perm(A, 'Write', W1)
  deck.reset()
  assert.deepEqual([p.r.sent, deck.state().dials], [[{ status: 200, json: {} }], {}])
  reg([A, 'waiting'])
  assert.equal(dial(A, { decision: 'allow' }).error, "local_a's dial has shown no request")
})
