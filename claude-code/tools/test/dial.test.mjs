// The fake deck's Session Slot dial (PROTOCOL.md, "Permission requests", "Held requests" and "Fixtures", as amended on
// 2026-11-07 for Phase 9): it allows or denies its session's oldest held tool request, a press with nothing picked
// jumps, an ask request is display-only, and the first answer wins between the keys and the dials. Driven directly, on
// fake clocks.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BadRequest, FakeDeck } from '../lib/deck.mjs'
import { ALLOW, DENY, fingerprint } from '../lib/protocol.mjs'
import { fakeTimers, responder } from './helpers.mjs'

const A = { sid: 'sid-a', host: 'local_a', inst: 'ia', pid: 1 }
const B = { sid: 'sid-b', host: 'local_b', inst: 'ib', pid: 2 }

const COLOR = { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiSelect: false }] }
const PLAN = { plan: '# Plan\n\n1. Create s10.txt containing: ten.\n', planFilePath: '/Users/me/.claude/plans/tidy-otter.md' }
const W1 = { file_path: '/s/one.txt', content: '1' }

function setup() {
  const clock = fakeTimers()
  const log = []
  const deck = new FakeDeck({ now: clock.wall, monoNow: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (e) => log.push(e) })
  const reg = (...sessions) => deck.applyRegistry(sessions.map(([S, status]) => ({ pid: S.pid, sessionId: S.sid, hostSessionId: S.host, name: S.host, status, statusUpdatedAt: clock.now() })))
  const perm = (S, tool, input) => {
    const r = responder()
    const out = deck.permission({ body: { session_id: S.sid, tool_name: tool, tool_input: input, permission_mode: 'default' }, hostHeader: S.host, responder: r })
    return { r, ...out }
  }
  const seq = new Map()
  const ev = (S, ...events) => {
    seq.set(S.host, (seq.get(S.host) ?? 0) + 1)
    deck.events({ sid: S.sid, host: S.host, inst: S.inst, seq: seq.get(S.host), events: events.map((e) => ({ at: clock.now(), ...e })) })
  }
  const dial = (S, press = {}) => deck.dial({ host: S.host, ...press })
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

test('dial: a press with nothing picked jumps to the session and answers nothing: on an approval, and on a strip that has shown nothing', () => {
  // PROTOCOL.md, "Fixtures": a dial line without a decision presses with nothing picked, which jumps.
  const { reg, perm, dial, view, log } = setup()
  reg([A, 'waiting'])
  let r = dial(A)
  assert.deepEqual([r.ok, r.alert, r.jumped, r.request], [true, false, A.host, undefined], 'its pages: a press jumps')
  const p = perm(A, 'Write', W1)
  r = dial(A)
  assert.deepEqual([r.ok, r.alert, r.jumped, r.request, r.answered], [true, false, A.host, p.id, undefined])
  assert.deepEqual([p.r.sent, view().held.map((h) => h.id), view().jumped], [[], [p.id], A.host], 'still held')
  assert.deepEqual(log.filter((e) => e.kind === 'answered'), [])
  // A decision on a strip that has shown nothing has nothing to decide.
  const { dial: dialB, reg: regB } = setup()
  regB([B, 'idle'])
  assert.deepEqual([dialB(B, { decision: 'allow' }).alert, dialB(B, { decision: 'allow' }).error], [true, "local_b's dial has shown no request"])
})

test('dial: an ask request reads Answer in app: any press on it, with a decision or none, jumps and answers nothing', () => {
  // needs-you: the deck never answers an AskUserQuestion or an ExitPlanMode (Phase 9). The user answers in the app,
  // and the tool's end releases it.
  const { deck, reg, perm, ev, dial, view } = setup()
  reg([A, 'waiting'])
  for (const [tool, input] of [['AskUserQuestion', COLOR], ['ExitPlanMode', PLAN], ['ExitPlanMode', {}]]) {
    const p = perm(A, tool, input)
    for (const press of [{}, { decision: 'allow' }, { decision: 'deny' }]) {
      const r = dial(A, press)
      assert.deepEqual([r.ok, r.alert, r.jumped, r.request, r.answered], [true, false, A.host, p.id, undefined], `${tool} ${JSON.stringify(press)}`)
    }
    for (const key of ['approve', 'deny']) assert.equal(deck.press(key).jumped, A.host, `${tool}: the ${key} key jumps too`)
    assert.deepEqual([p.r.sent, view().status[A.host]], [[], 'needs-you'], tool)
    ev(A, { t: 'tool.end', tool, use: `u-${tool}`, fp: fingerprint(tool, input), ok: true })
    assert.deepEqual(p.r.sent, [{ status: 200, json: {} }], `${tool}: released by its tool.end`)
  }
  assert.deepEqual(view().held, [])
})

test('dial: the first answer wins: a press for a request that has gone, answered or released, alerts and sends nothing', () => {
  const { deck, reg, perm, ev, dial, view } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  // A key answers first: the dial's press for it alerts, with a decision or none.
  const p1 = perm(A, 'Write', W1)
  assert.equal(deck.press('approve', { shown: p1.id }).answered, 'allow')
  for (const press of [{ decision: 'deny' }, {}]) {
    const r = dial(A, press)
    assert.deepEqual([r.alert, r.error, r.request, r.jumped], [true, `${p1.id}, the request the dial showed, has gone (answered)`, p1.id, null], JSON.stringify(press))
  }
  assert.deepEqual(p1.r.sent, [{ status: 200, json: ALLOW }], 'answered once, by the key')

  // The dial answers first: the key's press for it alerts, and so does the dial's next.
  const p2 = perm(A, 'Write', W1)
  assert.equal(dial(A, { decision: 'allow' }).request, p2.id)
  assert.match(deck.press('deny', { shown: p2.id }).error, /^nothing is held$/)
  assert.match(dial(A, { decision: 'deny' }).error, /has gone \(answered\)$/)
  assert.deepEqual(p2.r.sent, [{ status: 200, json: ALLOW }])

  // dial-gone: allowed in the app, the tool's end releases it, and the dial's press alerts.
  const bash = { command: 'npm run build', description: 'Build' }
  const p3 = perm(A, 'Bash', bash)
  ev(A, { t: 'tool.end', tool: 'Bash', use: 'u9', fp: fingerprint('Bash', bash), ok: true })
  assert.deepEqual(p3.r.sent, [{ status: 200, json: {} }])
  const r = dial(A, { decision: 'allow' })
  assert.deepEqual([r.alert, r.error], [true, `${p3.id}, the request the dial showed, has gone (released)`])
  assert.equal(p3.r.sent.length, 1, 'nothing more sent')

  // A press as a dial whose strip showed a request: another session's, a younger one, or one that's gone.
  const a = perm(A, 'Write', W1)
  const a2 = perm(A, 'Bash', { command: 'make' })
  const b = perm(B, 'Write', W1)
  assert.match(dial(A, { decision: 'allow', shown: b.id }).error, new RegExp(`^${b.id} is local_b's request, not local_a's$`))
  assert.match(dial(A, { decision: 'allow', shown: a2.id }).error, new RegExp(`^the dial showed ${a2.id}; local_a's oldest held request is ${a.id}$`))
  assert.match(dial(A, { shown: a2.id }).error, /oldest held request is/, 'a press with nothing picked too')
  assert.match(dial(A, { decision: 'allow', shown: p1.id }).error, /has gone \(answered\)$/)
  assert.match(dial(A, { decision: 'allow', shown: 'p99' }).error, /^no request p99$/)
  assert.match(dial(A, { decision: 'allow', shown: null }).error, /has shown no request$/)
  assert.deepEqual([a.r.sent, a2.r.sent, b.r.sent], [[], [], []])
  assert.equal(dial(A, { decision: 'allow', shown: a.id }).request, a.id, 'the one it shows')

  // A request whose client went away: the press alerts, and it's no longer held.
  a2.r.open = false
  const gone = dial(A)
  assert.deepEqual([gone.alert, gone.error], [true, `${a2.id} had gone`])
  assert.deepEqual(view().held.map((h) => h.id), [b.id])
})

test("dial: its strip shows its session's oldest held request, and the next once that has gone, however it went", () => {
  const { deck, reg, perm, ev, dial } = setup()
  reg([A, 'waiting'], [B, 'waiting'])
  const p1 = perm(A, 'Write', W1)
  const p2 = perm(A, 'AskUserQuestion', COLOR)
  const p3 = perm(A, 'Bash', { command: 'make' })
  perm(B, 'Write', W1)
  assert.deepEqual(deck.state().dials, { [A.host]: p1.id, [B.host]: 'p4' })
  // Released by its tool.end: the strip shows the question, which a press jumps from.
  ev(A, { t: 'tool.end', tool: 'Write', use: 'u1', fp: fingerprint('Write', W1), ok: true })
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  assert.equal(deck.state().dials[A.host], p2.id)
  assert.equal(dial(A, { decision: 'allow' }).jumped, A.host)
  // Answered in the app: the Bash takes the strip.
  ev(A, { t: 'tool.end', tool: 'AskUserQuestion', use: 'u2', fp: fingerprint('AskUserQuestion', COLOR), ok: true })
  assert.equal(dial(A, { decision: 'allow' }).request, p3.id)
  // With none left, the dial still showed the last.
  assert.equal(deck.state().dials[A.host], p3.id)
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
  for (const press of [{ decision: 'allow' }, {}]) {
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

test('dial: a press that isn\'t one gets 400: a host, and a decision of allow or deny, or none', () => {
  const { deck, reg, perm } = setup()
  reg([A, 'waiting'])
  perm(A, 'Write', W1)
  const bad = [
    [{ decision: 'allow' }, /^host must be a session host/],
    [{ host: '', decision: 'allow' }, /^host must be a session host/],
    [{ host: A.host, decision: 'approve' }, /^decision must be allow or deny, or left out for a press with nothing picked$/],
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
