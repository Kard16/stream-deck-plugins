// The fake deck's logic, driven directly with fake timers: kinds, presses, release rules, commands, polls
// and statuses, each against the PROTOCOL.md section it follows.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BadRequest, FakeDeck } from '../lib/deck.mjs'
import { ALLOW, DENY, MODE_TOOL, fingerprint } from '../lib/protocol.mjs'
import { fakeTimers, responder } from './helpers.mjs'

const A = { sid: 'sid-a', host: 'local_a', inst: 'ia', pid: 1 }
const B = { sid: 'sid-b', host: 'local_b', inst: 'ib', pid: 2 }
const W1 = { file_path: '/s/one.txt', content: '1' }
const ASK = { questions: [{ question: 'Red or blue?' }] }

function setup() {
  const clock = fakeTimers()
  const log = []
  const deck = new FakeDeck({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (e) => log.push(e) })
  const seq = new Map()
  const reg = (...entries) => deck.applyRegistry(entries.map(([S, status, at = clock.now(), extra = {}]) => ({ pid: S.pid, sessionId: S.sid, hostSessionId: S.host, name: S.host, status, statusUpdatedAt: at, ...extra })))
  const hello = (S, extra = {}) => deck.hello({ v: 1, sid: S.sid, host: S.host, inst: S.inst, cwd: '/s', model: 'm1', plugin: '0.1.0', cc: '2.1.309', ...extra })
  const ev = (S, ...events) => {
    const key = `${S.host}/${S.inst}`
    seq.set(key, (seq.get(key) ?? 0) + 1)
    deck.events({ sid: S.sid, host: S.host, inst: S.inst, seq: seq.get(key), events: events.map((e) => ({ at: clock.now(), ...e })) })
  }
  // `header: undefined` sends no X-Deck-Host; leaving `header` out sends the session's own.
  const perm = (S, tool, input, opts = {}) => {
    const header = Object.hasOwn(opts, 'header') ? opts.header : S.host
    const extra = opts.extra ?? {}
    const r = responder()
    const out = deck.permission({
      body: { session_id: S.sid, tool_name: tool, tool_input: input, permission_mode: 'default', effort: { level: 'low' }, ...extra },
      hostHeader: header,
      responder: r,
    })
    return { r, ...out }
  }
  const poll = (S, wait = 20, inst = S.inst) => {
    const r = responder()
    const id = deck.poll({ sid: S.sid, host: S.host, inst, wait, responder: r })
    return { r, id }
  }
  return { deck, clock, log, reg, hello, ev, perm, poll, view: () => deck.view() }
}

test('deck: requests sort into tool, ask and mode; a mode command allows exactly the request it raises', () => {
  const { deck, reg, hello, perm, poll, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  assert.equal(perm(A, 'Write', W1).kind, 'tool')
  assert.equal(perm(A, 'AskUserQuestion', ASK).kind, 'ask')
  assert.equal(perm(A, 'ExitPlanMode', { plan: 'x' }).kind, 'ask')
  assert.equal(perm(A, MODE_TOOL, { session_id: 'self', mode: 'acceptEdits' }).kind, 'tool', 'no command in flight')

  const queued = deck.mode({ host: A.host, mode: 'acceptEdits' })
  assert.equal(perm(A, MODE_TOOL, { session_id: 'self', mode: 'acceptEdits' }).kind, 'tool', 'queued is not in flight')
  poll(A)
  assert.equal(view().cmds[queued.cmd], 'delivered')
  assert.equal(perm(A, MODE_TOOL, { session_id: 'self', mode: 'plan' }).kind, 'tool', 'another mode')
  assert.equal(perm(B, MODE_TOOL, { session_id: 'self', mode: 'acceptEdits' }).kind, 'tool', 'another session')
  assert.equal(perm(A, MODE_TOOL, { session_id: 'local_a', mode: 'acceptEdits' }).kind, 'tool', 'not self')
  const m = perm(A, MODE_TOOL, { session_id: 'self', mode: 'acceptEdits' })
  assert.equal(m.kind, 'mode')
  assert.deepEqual(m.r.sent, [{ status: 200, json: ALLOW }])
  assert.equal(perm(A, MODE_TOOL, { session_id: 'self', mode: 'acceptEdits' }).kind, 'tool', 'one press, one allowance')
  assert.deepEqual(view().held.map((h) => [h.tool, h.kind]), [
    ['Write', 'tool'], ['AskUserQuestion', 'ask'], ['ExitPlanMode', 'ask'], [MODE_TOOL, 'tool'], [MODE_TOOL, 'tool'],
    [MODE_TOOL, 'tool'], [MODE_TOOL, 'tool'], [MODE_TOOL, 'tool'], [MODE_TOOL, 'tool'],
  ])
})

test('deck: Approve and Deny act on the oldest held request across sessions, and only on the one the key showed', () => {
  const { deck, reg, perm, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  const p1 = perm(A, 'Write', W1)
  const p2 = perm(B, 'Bash', { command: 'make' })
  let r = deck.press('approve')
  assert.equal(r.answered, 'allow')
  assert.deepEqual(p1.r.sent, [{ status: 200, json: ALLOW }])
  assert.deepEqual(view().held.map((h) => h.id), [p2.id])

  r = deck.press('deny', { shown: 'p9' })
  assert.equal(r.alert, true)
  assert.equal(p2.r.sent.length, 0, 'a press for another request does nothing')
  assert.equal(view().alert, true)
  r = deck.press('deny', { shown: null })
  assert.equal(r.alert, true, 'the key showed nothing, but something is held now')

  r = deck.press('deny', { shown: p2.id })
  assert.equal(r.ok, true)
  assert.deepEqual(p2.r.sent, [{ status: 200, json: DENY }])
  assert.equal(view().alert, false)

  r = deck.press('approve')
  assert.deepEqual([r.ok, r.alert, r.error], [false, true, 'nothing is held'])

  const ask = perm(A, 'AskUserQuestion', ASK)
  r = deck.press('deny')
  assert.equal(r.jumped, A.host)
  assert.equal(ask.r.sent.length, 0, 'an ask is never answered by a press')
  assert.deepEqual([view().jumped, view().alert, view().held.length], [A.host, false, 1])

  ask.r.open = false
  r = deck.press('approve')
  assert.equal(r.alert, true, 'a request whose client went away alerts')
  assert.equal(view().held.length, 0)
  assert.throws(() => deck.press('maybe'), BadRequest)
})

test('deck: release rule 1: tool.end with the same fp, from the same session', () => {
  const { reg, hello, ev, perm, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  const p1 = perm(A, 'Write', W1)
  const p2 = perm(B, 'Write', W1)
  ev(A, { t: 'tool.end', tool: 'Write', use: 'u9', fp: fingerprint('Write', { ...W1, content: '2' }), ok: true })
  assert.equal(view().held.length, 2, 'another fp releases nothing')
  ev(A, { t: 'tool.end', tool: 'Write', use: 'u1', fp: fingerprint('Write', W1), ok: true })
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  assert.equal(p2.r.sent.length, 0, 'only the same session')
  assert.deepEqual(view().held.map((h) => h.host), [B.host])
})

test('deck: release rule 2: leaving waiting releases the only request, held while the registry showed waiting', () => {
  const { reg, perm, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  const p1 = perm(A, 'Bash', { command: 'npm test' })
  reg([A, 'waiting'], [B, 'busy'])
  reg([A, 'busy'], [B, 'busy'])
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])

  const p2 = perm(A, 'Bash', { command: 'one' })
  const p3 = perm(A, 'Bash', { command: 'two' })
  reg([A, 'waiting'], [B, 'busy'])
  reg([A, 'busy'], [B, 'busy'])
  assert.deepEqual([p2.r.sent.length, p3.r.sent.length], [0, 0], 'not the only one')

  const q = perm(B, 'Bash', { command: 'three' })
  reg([A, 'busy'], [B, 'waiting'])
  const late = perm(B, 'Bash', { command: 'four' })
  q.r.open = false
  // q's client went away without a close event: still counted as held, so `late` isn't the only one either.
  reg([A, 'busy'], [B, 'busy'])
  assert.equal(late.r.sent.length, 0)
  assert.equal(view().held.length, 4)
})

test('deck: release rule 2 waits for a reading of waiting after the request arrived', () => {
  const { reg, perm } = setup()
  reg([A, 'waiting'])
  const p1 = perm(A, 'Write', W1)
  reg([A, 'busy'])
  assert.equal(p1.r.sent.length, 0, 'the waiting it left may have been for something else')
})

test('deck: release rule 3, by what the bridge saw: a reading of idle after one of another status, never a first reading', () => {
  const { clock, reg, perm } = setup()
  // Held before the session's first reading, which shows it idle: the deck saw no change, whatever the time says.
  const p1 = perm(A, 'Write', W1)
  clock.advance(500)
  reg([A, 'idle', clock.now()])
  assert.equal(p1.r.sent.length, 0, 'a first reading is no change')
  reg([A, 'idle', null])
  assert.equal(p1.r.sent.length, 0, 'idle again is no change either')
  reg([A, 'busy', null])
  reg([A, 'idle', clock.now() - 60_000])
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }], 'it saw the change, whatever statusUpdatedAt says')

  // A request that arrived while the session read idle waits for a change it sees after.
  const p2 = perm(A, 'Write', W1)
  reg([A, 'idle', clock.now() + 10])
  assert.equal(p2.r.sent.length, 0, 'idle already, before it arrived')
  reg([A, 'waiting', null])
  const p3 = perm(A, 'Write', W1)
  reg([A, 'idle', null])
  assert.deepEqual([p2.r.sent, p3.r.sent], [[{ status: 200, json: {} }], [{ status: 200, json: {} }]], 'the change came after both')

  // A session that left the registry and came back is read for the first time again.
  const p4 = perm(B, 'Write', W1)
  reg([A, 'idle'], [B, 'busy'])
  reg([A, 'idle'])
  const p5 = perm(B, 'Write', W1, { header: B.host })
  reg([A, 'idle'], [B, 'idle'])
  assert.deepEqual([p4.r.sent, p5.r.sent], [[{ status: 200, json: {} }], []], 'p4 by rule 4; p5 waits for a change')
})

test('deck: release rules 4 and 5: the registry file disappears, or the client closes', () => {
  const { deck, reg, perm, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  const p1 = perm(A, 'Write', W1)
  const p2 = perm(B, 'Write', W1)
  reg([B, 'busy'])
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  assert.deepEqual(view().sessions, [B.host])
  assert.equal(deck.clientClosed(p2.id), true)
  assert.equal(p2.r.sent.length, 0, 'nothing to send to a closed client')
  assert.deepEqual(view().held, [])
  assert.equal(deck.clientClosed(p2.id), false)
})

test('deck: nothing else answers a held request: no timeout, no default', () => {
  const { clock, reg, perm, view } = setup()
  reg([A, 'busy'])
  const p1 = perm(A, 'Write', W1)
  clock.advance(3_600_000)
  assert.equal(p1.r.sent.length, 0)
  assert.equal(view().held.length, 1)
})

test('deck: the host comes from X-Deck-Host, else the sid in the registry; one that isn\'t a local_ id is missing', () => {
  const { reg, perm, view } = setup()
  reg([A, 'busy'])
  const missing = [undefined, '', '$CLAUDE_CODE_HOST_SESSION_ID', 'not-local', 'local_', `local_${'x'.repeat(65)}`, 'local_a/b', ' local_a', 'local_a\n']
  for (const header of missing) perm(A, 'Write', W1, { header })
  assert.deepEqual(view().held.map((h) => h.host), missing.map(() => A.host), 'each placed by its sid')
  perm(A, 'Write', W1, { header: `local_${'x'.repeat(64)}` })
  assert.equal(view().held.at(-1).host, `local_${'x'.repeat(64)}`, '64 characters after local_ is still a host')
  perm(B, 'Write', W1, { header: 'remote_b' })
  assert.equal(view().held.at(-1).host, null, 'an unknown sid has no host yet')
  reg([A, 'busy'], [B, 'busy'])
  assert.equal(view().held.at(-1).host, B.host, 'filled in once the registry knows the sid')
})

test('deck: the host fallback takes every sid and host pair seen from mods and hooks, and places a request held without a host by one later', () => {
  const { deck, reg, hello, perm, view } = setup()
  reg([A, 'busy'])
  // Neither session is in the registry. C's sid changes (a /clear, say), and its hook brings the new pair.
  const C = { sid: 'sid-c1', host: 'local_c', inst: 'ic', pid: 3 }
  const D = { sid: 'sid-d', host: 'local_d', inst: 'id', pid: 4 }
  hello(C)
  perm({ ...C, sid: 'sid-c2' }, 'Write', W1)
  // A late mod request on the first sid, and a hook's on the second, both without a host: each pair places its own.
  deck.events({ sid: 'sid-c1', host: '', inst: 'ic', seq: 1, events: [{ t: 'measure', context: { percent: 9, window: 10 }, at: 1 }] })
  assert.equal(view().context[C.host], 9)
  perm({ ...C, sid: 'sid-c2' }, 'Bash', { command: 'ls' }, { header: undefined })
  assert.equal(view().held.at(-1).host, C.host)
  // A request held without a host: a pair seen after it came places it at the next registry reading.
  perm(D, 'Write', W1, { header: undefined })
  assert.equal(view().held.at(-1).host, null)
  hello(D)
  reg([A, 'busy'])
  assert.equal(view().held.at(-1).host, D.host)
})

test('deck: a mod request it can\'t place is refused, so the bridge answers 400', () => {
  const { deck, reg } = setup()
  reg([A, 'idle'])
  const nobody = { sid: 'sid-unknown', host: '$CLAUDE_CODE_HOST_SESSION_ID', inst: 'iz' }
  assert.throws(() => deck.hello({ v: 1, ...nobody, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' }), BadRequest)
  assert.throws(() => deck.events({ ...nobody, seq: 1, events: [{ t: 'turn.start', turn: 't1', at: 1 }] }), BadRequest)
  assert.throws(() => deck.result({ ...nobody, id: 'cmd-1', state: 'done' }), BadRequest)
  assert.equal(deck.poll({ ...nobody, wait: 20, responder: responder() }), null)
  assert.deepEqual(Object.keys(deck.state().sessions), [], 'nothing made of them')
  // The sid alone places it once the registry knows it, whatever the host says.
  assert.deepEqual(deck.hello({ v: 1, sid: A.sid, host: 'not-local', inst: 'ia', cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' }), { v: 1, ok: true })
  assert.deepEqual(Object.keys(deck.state().sessions), [A.host])
  assert.deepEqual(deck.hello({ v: 2, ...nobody }), { v: 1, ok: false, error: 'version' }, 'the version is checked first')
})

test('deck: a command is queued, delivered by a poll, and in flight until its final result or 60 s', () => {
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'idle'], [B, 'idle'])
  hello(A)
  hello(B)
  const c1 = deck.prompt({ host: A.host, text: 'Run the tests.' }).cmd
  assert.equal(view().cmds[c1], 'queued')
  const n1 = poll(A)
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c1, t: 'prompt', text: 'Run the tests.' }] } }])
  assert.equal(view().cmds[c1], 'delivered')

  deck.result({ sid: B.sid, host: B.host, inst: B.inst, id: c1, state: 'done' })
  assert.equal(view().cmds[c1], 'delivered', 'a result from another session is ignored')
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c1, state: 'waiting' })
  assert.equal(view().cmds[c1], 'waiting')
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c1, state: 'done', detail: 'ok' })
  assert.equal(view().cmds[c1], 'done')
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c1, state: 'refused', error: 'late' })
  assert.equal(view().cmds[c1], 'done', 'a finished command keeps its result')
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: 'nope', state: 'done' })

  const c2 = deck.prompt({ host: A.host, text: 'Again.' }).cmd
  poll(A)
  clock.advance(59_999)
  assert.equal(view().cmds[c2], 'delivered')
  clock.advance(1)
  assert.equal(view().cmds[c2], 'failed')
  assert.equal(deck.state().commands.find((c) => c.id === c2).error, 'no result')
})

test('deck: a prompt\'s waiting stops its 60 s; it fails only once its session has gone 60 s without an open poll', () => {
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  const result = (id, state) => deck.result({ sid: A.sid, host: A.host, inst: A.inst, id, state })
  const error = (id) => deck.state().commands.find((c) => c.id === id).error

  const c1 = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  poll(A)
  result(c1, 'waiting')
  // A ten-minute turn, with the mod polling again each time a poll ends, as a live one does.
  for (let i = 0; i < 30; i++) {
    poll(A)
    clock.advance(20_000)
  }
  assert.equal(view().cmds[c1], 'waiting', 'held by the engine for as long as the turn lasts')
  clock.advance(59_999)
  assert.equal(view().cmds[c1], 'waiting')
  clock.advance(1)
  assert.deepEqual([view().cmds[c1], error(c1)], ['failed', 'no result'], '60 s without an open poll')

  // The gap runs from when the last poll ended, here by its client going away, and a new poll ends it.
  const c2 = deck.prompt({ host: A.host, text: 'Again.' }).cmd
  poll(A)
  result(c2, 'waiting')
  const n = poll(A)
  n.r.open = false
  deck.pollClosed(n.id)
  clock.advance(59_999)
  poll(A)
  clock.advance(10_000)
  assert.equal(view().cmds[c2], 'waiting', 'a poll came within the 60 s')
  result(c2, 'done')
  assert.equal(view().cmds[c2], 'done')

  // A mode command keeps its 60 s from delivery after a stray waiting, however the mod polls: it bounds how
  // long the mode rule can allow a change.
  const m = deck.mode({ host: A.host, mode: 'plan' }).cmd
  assert.equal(view().cmds[m], 'delivered', 'to the poll that was open')
  result(m, 'waiting')
  for (let i = 0; i < 2; i++) {
    poll(A)
    clock.advance(20_000)
  }
  poll(A)
  clock.advance(19_999)
  assert.equal(view().cmds[m], 'waiting')
  clock.advance(1)
  assert.deepEqual([view().cmds[m], error(m)], ['failed', 'no result'])
})

test('deck: release rule 4 fails all the session\'s commands, answers its open poll and forgets the session', () => {
  const { deck, clock, reg, hello, ev, perm, poll, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  ev(A, { t: 'measure', context: { percent: 30, tokens: 3, window: 10 } })
  const result = (id, state) => deck.result({ sid: A.sid, host: A.host, inst: A.inst, id, state })
  const done = deck.prompt({ host: A.host, text: 'zero' }).cmd
  poll(A)
  result(done, 'done')
  const waiting = deck.prompt({ host: A.host, text: 'one' }).cmd
  poll(A)
  result(waiting, 'waiting')
  const delivered = deck.mode({ host: A.host, mode: 'plan' }).cmd
  poll(A)
  const queued = deck.prompt({ host: A.host, text: 'two' }).cmd
  const p1 = perm(A, 'Write', W1)
  const nB = poll(B)

  reg([B, 'busy'])
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  const cmds = Object.fromEntries(deck.state().commands.map((c) => [c.id, [c.state, c.error]]))
  assert.deepEqual([cmds[waiting], cmds[delivered], cmds[queued]], Array(3).fill(['failed', 'the session ended']))
  assert.deepEqual(cmds[done], ['done', null], 'a finished one keeps its result')
  assert.equal(deck.state().sessions[A.host], undefined, 'what the bridge knew of it is gone')
  assert.equal(view().context[A.host], undefined)
  assert.equal(nB.r.sent.length, 0, 'the other session is untouched')

  reg()
  assert.deepEqual(nB.r.sent, [{ status: 200, json: { cmds: [] } }], 'its open poll is answered')
  assert.equal(clock.pending, 0, 'no timers left behind')
})

test('deck: long polls: wait, one open poll per session, answered as soon as a command is queued', () => {
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A)
  const first = poll(A)
  const second = poll(A)
  assert.deepEqual(first.r.sent, [{ status: 200, json: { cmds: [] } }], 'a new poll answers the older one')
  assert.equal(second.r.sent.length, 0)
  const c = deck.mode({ host: A.host, mode: 'plan' }).cmd
  assert.deepEqual(second.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'mode', mode: 'plan' }] } }])

  assert.deepEqual(poll(A, 0).r.sent, [{ status: 200, json: { cmds: [] } }], 'wait=0 answers at once')
  const timed = poll(A, 20)
  clock.advance(19_999)
  assert.equal(timed.r.sent.length, 0)
  clock.advance(1)
  assert.deepEqual(timed.r.sent, [{ status: 200, json: { cmds: [] } }])

  const gone = poll(A, 20)
  gone.r.open = false
  assert.equal(deck.pollClosed(gone.id), true)
  const later = deck.prompt({ host: A.host, text: 'x' }).cmd
  assert.equal(view().cmds[later], 'queued', 'nobody was polling')
  assert.equal(deck.poll({ sid: 'unknown', host: '', inst: 'i', wait: 20, responder: responder() }), null)
})

test('deck: the main loop\'s turn.end answers the session\'s open poll with no commands at once, and once the registry says idle the poll after it is held as usual', () => {
  // PROTOCOL.md, "Commands": Claude Code keeps a session busy in the registry until a moment after the turn when the
  // mod has no request open, so a poll held past the turn's end kept the deck showing working for up to 20 s more
  // (Phase 4).
  const { deck, clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  const n1 = poll(A)
  const nB = poll(B)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'notes.md', fp: 'f1' }, { t: 'tool.end', tool: 'Read', use: 'u1', fp: 'f1', ok: true })
  clock.advance(5_000)
  assert.equal(n1.r.sent.length, 0, 'held while the turn runs')
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }], 'answered at the turn.end, not when its wait runs out')
  assert.equal(nB.r.sent.length, 0, 'another session\'s poll stays open')
  assert.equal(deck.state().sessions[A.host].poll, null)
  assert.deepEqual(log.filter((e) => e.kind === 'poll-turn-end').map((e) => [e.host, e.poll, e.by]), [[A.host, n1.id, 'turn.end']])

  // With no request open, Claude Code turns the session idle. Once the bridge reads that, the mod's next poll is held
  // as usual though the turn ended just before it: polls are answered at once only while the registry still says busy
  // (the tests after these). Had the mod's fetch of the turn.end rejected after the deck took it, its quiet hello, its
  // new poll and its resend under the same seq change nothing: the resend is dropped as a retry.
  reg([A, 'idle'], [B, 'busy'])
  hello(A)
  const n2 = poll(A)
  deck.events({ sid: A.sid, host: A.host, inst: A.inst, seq: 2, events: [{ t: 'turn.end', turn: 't1', reason: 'answer', at: 1 }] })
  clock.advance(19_999)
  assert.equal(n2.r.sent.length, 0)
  const c = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Next.' }] } }], 'answered when a command is queued')
  const n3 = poll(A)
  clock.advance(19_999)
  assert.equal(n3.r.sent.length, 0)
  clock.advance(1)
  assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [] } }], 'or when its wait runs out')

  // A turn the user stopped with Esc ends with reason aborted, which answers it too.
  const n4 = poll(A)
  ev(A, { t: 'turn.start', turn: 't2' }, { t: 'turn.end', turn: 't2', reason: 'aborted' })
  assert.deepEqual(n4.r.sent, [{ status: 200, json: { cmds: [] } }])
})

test('deck: the main loop\'s failed answers the open poll too, and so does a turn end whose agent isn\'t a non-empty string', () => {
  const { log, reg, hello, ev, poll } = setup()
  // The registry doesn't say busy, so the polls after a turn end are held as usual, not answered at once (the tests
  // after these), and each turn end here finds one open.
  reg([A, 'idle'])
  hello(A)
  const n1 = poll(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'failed', error: 'API error' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
  // The failed turn's own turn.end may follow it, and answers the poll the mod opened since: PROTOCOL.md names both.
  const n2 = poll(A)
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.deepEqual(log.filter((e) => e.kind === 'poll-turn-end').map((e) => [e.poll, e.by]), [[n1.id, 'failed'], [n2.id, 'turn.end']])

  // PROTOCOL.md, "Events": an agent that isn't a non-empty string counts as none, the main loop's.
  for (const agent of ['', null, 7, ['ag1'], { id: 'ag1' }]) {
    for (const e of [{ t: 'failed', agent, error: 'API error' }, { t: 'turn.end', turn: 't2', agent, reason: 'answer' }]) {
      const n = poll(A)
      ev(A, e)
      assert.deepEqual(n.r.sent, [{ status: 200, json: { cmds: [] } }], `${e.t} with agent ${JSON.stringify(agent)}`)
    }
  }
})

test('deck: a subagent\'s turn.end or failed leaves the open poll alone, as do the main loop\'s other events', () => {
  const { reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  const n1 = poll(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.start', turn: 's1', agent: 'ag1' }, { t: 'turn.start', turn: 's2', agent: 'ag2' })
  ev(A, { t: 'turn.end', turn: 's1', agent: 'ag1', reason: 'answer' })
  ev(A, { t: 'failed', agent: 'ag2', error: 'overloaded' })
  ev(A, { t: 'turn.end', turn: 's2', agent: 'ag2', reason: 'aborted' })
  assert.equal(n1.r.sent.length, 0, 'the main loop\'s turn is still running')
  ev(
    A,
    { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'a.md', fp: 'f1' },
    { t: 'tool.end', tool: 'Read', use: 'u1', fp: 'f1', ok: true },
    { t: 'measure', context: { percent: 5, window: 10 } },
    { t: 'settings', mode: 'plan' },
    { t: 'attach', surface: 'desktop' },
    { t: 'detach', surface: 'desktop' },
    { t: 'end', reason: 'clear' },
    { t: 'turn.ended', turn: 't1' },
  )
  assert.equal(n1.r.sent.length, 0)
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }], 'the main loop\'s turn.end does')
})

test('deck: a main-loop turn end with no poll open breaks nothing, and the poll after it is held until the next turn end', () => {
  const { deck, clock, log, reg, hello, ev, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  // Before the mod's first poll.
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  // Between a poll's answer and the next, with a prompt the engine holds until the session is idle (S3): its time
  // without an open poll runs from that answer, whatever ends a turn meanwhile.
  const c = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  poll(A)
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c, state: 'waiting' })
  clock.advance(30_000)
  ev(A, { t: 'turn.start', turn: 't2' }, { t: 'failed', error: 'API error' }, { t: 'turn.end', turn: 't2', reason: 'answer' })
  assert.deepEqual(log.filter((e) => e.kind === 'poll-turn-end'), [], 'no poll to answer')
  reg([A, 'idle'])
  assert.equal(view().status[A.host], 'failed', 'the turn ended as usual')
  clock.advance(29_999)
  assert.equal(view().cmds[c], 'waiting')
  clock.advance(1)
  assert.deepEqual([view().cmds[c], deck.state().commands.find((x) => x.id === c).error], ['failed', 'no result'])

  // Nothing was kept for the next poll, and the registry says idle: it's held as usual, until the main loop's next
  // turn ends.
  const n1 = poll(A)
  clock.advance(19_999)
  assert.equal(n1.r.sent.length, 0)
  ev(A, { t: 'turn.start', turn: 't3' }, { t: 'turn.end', turn: 't3', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
})

test('deck: a poll answered at a main-loop turn end starts a waiting prompt\'s 60 s without a poll, as any poll\'s end does', () => {
  const { deck, clock, reg, hello, ev, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  // A prompt pressed while the session was busy waits for the turn's end (S3).
  const c = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  poll(A)
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c, state: 'waiting' })
  const n1 = poll(A)
  clock.advance(5_000)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
  // The mod never polls again.
  clock.advance(59_999)
  assert.equal(view().cmds[c], 'waiting')
  clock.advance(1)
  assert.deepEqual([view().cmds[c], deck.state().commands.find((x) => x.id === c).error], ['failed', 'no result'])
})

test('deck: a main-loop turn end from an inst seen before answers the open poll, the newest instance\'s', () => {
  // Its events still count (PROTOCOL.md, "Identity"), and the session's turn has ended whichever instance says so.
  const { reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  hello({ ...A, inst: 'ia2' })
  const n1 = poll(A, 20, 'ia2')
  ev(A, { t: 'turn.start', turn: 't1' })
  assert.equal(n1.r.sent.length, 0)
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
})

/** The `poll-at-once` lines of `log`, as [poll, cmds]. */
const atOnce = (log) => log.filter((e) => e.kind === 'poll-at-once').map((e) => [e.poll, e.cmds])

test('deck: after the main loop\'s turn end, the session\'s polls are answered at once with no commands while the registry still says busy', () => {
  // PROTOCOL.md, "Commands": Claude Code keeps the session busy until a moment after the turn when the mod has no
  // request open. A poll the mod opened while its measure for the turn was still on its line kept it busy until the
  // poll ran out, 20 s (Phase 4).
  const { deck, clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  const n1 = poll(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
  const n2 = poll(A)
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }], 'answered at once, not held for its 20 s')
  ev(A, { t: 'measure', context: { percent: 12, window: 10 } })
  // The mod waits out the rest of its second after an early empty answer, then polls again.
  clock.advance(1_000)
  const n3 = poll(A)
  assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.equal(deck.state().sessions[A.host].poll, null, 'no poll left open between them')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-at-once').map((e) => [e.host, e.poll, e.cmds, e.sinceTurnEndMs]), [[A.host, n2.id, [], 0], [A.host, n3.id, [], 1_000]])
  assert.deepEqual(log.filter((e) => e.kind === 'poll-turn-end').map((e) => e.poll), [n1.id], 'only the poll open at the turn end')

  // Another session's polls are held as usual: its turn hasn't ended.
  const nB = poll(B)
  clock.advance(19_999)
  assert.equal(nB.r.sent.length, 0)
})

test('deck: a poll answered at once after the main loop\'s turn end takes the commands queued for the session, oldest first', () => {
  const { deck, clock, log, reg, hello, ev, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  const n1 = poll(A)
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
  // Pressed while the mod waits out its second: no poll is open, so they're queued, and its next poll takes them.
  const c = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  const m = deck.mode({ host: A.host, mode: 'plan' }).cmd
  assert.deepEqual([view().cmds[c], view().cmds[m]], ['queued', 'queued'])
  clock.advance(1_000)
  const n2 = poll(A)
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Next.' }, { id: m, t: 'mode', mode: 'plan' }] } }])
  assert.deepEqual([view().cmds[c], view().cmds[m]], ['delivered', 'delivered'])
  assert.deepEqual(atOnce(log), [[n1.id, []], [n2.id, [c, m]]])
  // The next one has none left to take.
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }])
})

test('deck: a registry reading that doesn\'t say busy ends the polls answered at once after the turn end; each poll is judged by the latest', () => {
  for (const status of ['idle', 'waiting']) {
    const { clock, log, reg, hello, ev, poll } = setup()
    reg([A, 'busy'])
    hello(A)
    ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
    const n1 = poll(A)
    assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }], 'at once while it says busy')
    reg([A, status])
    const n2 = poll(A)
    clock.advance(19_999)
    assert.equal(n2.r.sent.length, 0, `held as usual once it says ${status}`)
    clock.advance(1)
    assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }], 'until its wait runs out')
    // The bridge judges each poll as it comes, by its latest reading: busy again, with no turn.start and within the
    // 60 s, answers them at once again.
    reg([A, 'busy'])
    const n3 = poll(A)
    assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [] } }], `busy again after ${status}`)
    assert.deepEqual(atOnce(log).map(([p]) => p), [n1.id, n3.id])
  }

  // A session the registry doesn't list has no reading that says busy.
  const { log, reg, hello, ev, poll } = setup()
  reg([B, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.equal(poll(A).r.sent.length, 0)
  reg([A, 'busy'], [B, 'busy'])
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }], 'listed busy since')
  assert.equal(atOnce(log).length, 1)
})

test('deck: a main-loop turn.start ends the polls answered at once after the turn end, and a subagent\'s doesn\'t', () => {
  const { clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  const n1 = poll(A)
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
  // A background subagent's turn carries on past the main loop's.
  ev(A, { t: 'turn.start', turn: 's1', agent: 'ag1' })
  const n2 = poll(A)
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }], 'a subagent\'s turn.start isn\'t a new turn of the session\'s')
  // The next prompt's turn, under the same busy.
  ev(A, { t: 'turn.start', turn: 't2' })
  const n3 = poll(A)
  clock.advance(19_999)
  assert.equal(n3.r.sent.length, 0, 'held as usual while the new turn runs')
  ev(A, { t: 'turn.end', turn: 't2', reason: 'answer' })
  assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [] } }], 'until it ends')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-turn-end').map((e) => e.poll), [n3.id])
  assert.deepEqual(atOnce(log).map(([p]) => p), [n1.id, n2.id])
  // And from that turn end, at once again.
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.equal(atOnce(log).length, 3)
})

test('deck: the polls after the main loop\'s turn end are answered at once for less than 60 s after it, by the bridge\'s clock', () => {
  const { deck, clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  clock.advance(30_000)
  // Its turn.end again, dropped as a retry: no turn end at all, so the 60 s still run from the first.
  deck.events({ sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [{ t: 'turn.end', turn: 't1', reason: 'answer', at: 1 }] })
  clock.advance(29_999)
  const n1 = poll(A)
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }], '1 ms before the 60 s')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-at-once').map((e) => e.sinceTurnEndMs), [59_999])
  clock.advance(1)
  const n2 = poll(A)
  clock.advance(19_999)
  assert.equal(n2.r.sent.length, 0, 'held as usual from the 60 s on, though the registry still says busy')
  clock.advance(1)
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.deepEqual(atOnce(log).map(([p]) => p), [n1.id])
})

test('deck: a main-loop failed starts the polls answered at once too, as does a turn end whose agent isn\'t a non-empty string, and each starts the 60 s again', () => {
  const { clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  const n1 = poll(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'failed', error: 'API error' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }])
  const n2 = poll(A)
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }], 'at once after the failed')
  // The failed turn's own turn.end, 30 s on: the 60 s run from it.
  clock.advance(30_000)
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  clock.advance(59_999)
  const n3 = poll(A)
  assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [] } }], '89.999 s after the failed, 59.999 s after the turn.end')
  clock.advance(1)
  const n4 = poll(A)
  assert.equal(n4.r.sent.length, 0)
  assert.deepEqual(atOnce(log).map(([p]) => p), [n2.id, n3.id])

  // PROTOCOL.md, "Events": an agent that isn't a non-empty string counts as none, the main loop's.
  let turn = 1
  for (const agent of ['', null, 7, ['ag1'], { id: 'ag1' }]) {
    for (const t of ['failed', 'turn.end']) {
      const id = `t${++turn}`
      ev(A, { t: 'turn.start', turn: id })
      const held = poll(A)
      assert.equal(held.r.sent.length, 0, 'held while the turn runs')
      ev(A, t === 'failed' ? { t, agent, error: 'API error' } : { t, turn: id, agent, reason: 'answer' })
      assert.deepEqual(held.r.sent, [{ status: 200, json: { cmds: [] } }])
      assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }], `at once after ${t} with agent ${JSON.stringify(agent)}`)
    }
  }
})

test('deck: a subagent\'s turn.end or failed doesn\'t start the polls answered at once; the main loop\'s turn end does', () => {
  const { clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.start', turn: 's1', agent: 'ag1' }, { t: 'turn.start', turn: 's2', agent: 'ag2' })
  ev(A, { t: 'turn.end', turn: 's1', agent: 'ag1', reason: 'answer' })
  const n1 = poll(A)
  clock.advance(19_999)
  assert.equal(n1.r.sent.length, 0, 'held after a subagent\'s turn.end: the main loop\'s turn is still running')
  clock.advance(1)
  ev(A, { t: 'failed', agent: 'ag2', error: 'overloaded' })
  const n2 = poll(A)
  clock.advance(19_999)
  assert.equal(n2.r.sent.length, 0, 'and after a subagent\'s failed')
  assert.deepEqual(atOnce(log), [])
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }], 'at once after the main loop\'s')
  assert.equal(atOnce(log).length, 1)
})

test('deck: a main-loop turn end from an older inst has the newest instance\'s polls answered at once, while an older one\'s still get no commands and leave its poll alone; a new inst keeps the rest of the 60 s', () => {
  // PROTOCOL.md, "Identity": an older instance's events still count, but its polls never displace the newest
  // instance's poll and never receive commands, after a turn end too. A new inst keeps the rest.
  const { deck, clock, log, reg, hello, ev, poll, view } = setup()
  const A2 = { ...A, inst: 'ia2' }
  const A3 = { ...A, inst: 'ia3' }
  reg([A, 'busy'])
  hello(A)
  hello(A2)
  // The old instance's line still brings the main loop's turn. A prompt pressed after it ends finds no poll open.
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  const c = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  const stale1 = poll(A)
  assert.deepEqual(stale1.r.sent, [{ status: 200, json: { cmds: [] } }], 'an old instance\'s poll gets none of it')
  assert.equal(view().cmds[c], 'queued')
  assert.deepEqual(atOnce(log), [], 'nor is it one answered at once after the turn end')
  const n1 = poll(A2)
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Next.' }] } }], 'the newest instance\'s takes it')
  clock.advance(1_000)
  const n2 = poll(A2)
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }], 'and its next, with nothing queued, is answered at once too')
  assert.deepEqual(atOnce(log), [[n1.id, [c]], [n2.id, []]])

  // The newest instance has a poll open after the turn end only while the registry doesn't say busy. An old
  // instance's poll leaves it alone.
  reg([A, 'idle'])
  const n3 = poll(A2)
  assert.equal(n3.r.sent.length, 0)
  const stale2 = poll(A)
  assert.deepEqual(stale2.r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.equal(n3.r.sent.length, 0, 'the newest instance\'s poll stays open')
  const open = deck.state().sessions[A.host].poll
  assert.deepEqual([open.id, open.inst], [n3.id, 'ia2'])
  assert.deepEqual(log.filter((e) => e.kind === 'poll-stale').map((e) => e.poll), [stale1.id, stale2.id])

  // A new inst answers the open poll, ia2's now, and its own polls are answered at once while the registry says busy
  // until 60 s after the turn end: the restart neither ends them nor starts the 60 s again.
  hello(A3)
  assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [] } }])
  reg([A, 'busy'])
  clock.advance(58_999)
  const n4 = poll(A3)
  assert.deepEqual(n4.r.sent, [{ status: 200, json: { cmds: [] } }], '59.999 s after the turn end')
  clock.advance(1)
  const n5 = poll(A3)
  assert.equal(n5.r.sent.length, 0, 'held from the 60 s on')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-at-once').map((e) => [e.poll, e.sinceTurnEndMs]), [[n1.id, 0], [n2.id, 1_000], [n4.id, 59_999]])
})

test('deck: a reading that turns busy after a main-loop turn end answers the poll held before it did, and none outside that time', () => {
  // PROTOCOL.md, "Commands": after a turn shorter than a scan, or a Deny with the reading still waiting, a poll can
  // come before the reading says busy. Held, it would keep the session busy until its wait ran out.
  const { clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'idle'], [B, 'waiting'])
  hello(A)
  hello(B)
  const nA = poll(A)
  const nB = poll(B)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  ev(B, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual([nA.r.sent, nB.r.sent], [[{ status: 200, json: { cmds: [] } }], [{ status: 200, json: { cmds: [] } }]], 'the open polls, at the turn ends')
  const nA2 = poll(A)
  const nB2 = poll(B)
  assert.deepEqual([nA2.r.sent.length, nB2.r.sent.length], [0, 0], 'held: neither reading says busy yet')
  reg([A, 'busy'], [B, 'idle'])
  assert.deepEqual(nA2.r.sent, [{ status: 200, json: { cmds: [] } }], 'answered once the reading turns busy')
  assert.equal(nB2.r.sent.length, 0, 'a reading that goes from waiting to idle answers nothing')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-turn-end' && e.by === 'busy').map((e) => [e.host, e.poll]), [[A.host, nA2.id]])

  // Outside that time: during the next turn, and 60 s after a turn end.
  ev(A, { t: 'turn.start', turn: 't2' })
  reg([A, 'idle'], [B, 'idle'])
  const nA3 = poll(A)
  reg([A, 'busy'], [B, 'idle'])
  assert.equal(nA3.r.sent.length, 0, 'held during a turn')
  ev(A, { t: 'turn.end', turn: 't2', reason: 'answer' })
  assert.deepEqual(nA3.r.sent, [{ status: 200, json: { cmds: [] } }], 'answered at its end')
  reg([A, 'idle'], [B, 'idle'])
  clock.advance(60_000)
  const nA4 = poll(A)
  reg([A, 'busy'], [B, 'idle'])
  assert.equal(nA4.r.sent.length, 0, 'held 60 s after the turn end')
  assert.equal(log.filter((e) => e.kind === 'poll-turn-end' && e.by === 'busy').length, 1)
})

test('deck: a new inst forgets the session\'s current tool and in-flight commands, and keeps the rest', () => {
  const { deck, reg, hello, ev, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'measure', context: { percent: 30, tokens: 3, window: 10 } }, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'a.md', fp: 'x' })
  const sent = deck.prompt({ host: A.host, text: 'one' }).cmd
  poll(A)
  const queued = deck.prompt({ host: A.host, text: 'two' }).cmd
  assert.equal(view().doing[A.host], 'a.md')
  hello({ ...A, inst: 'ia2' })
  assert.equal(view().doing[A.host], null)
  assert.equal(view().cmds[sent], 'failed')
  assert.equal(deck.state().commands.find((c) => c.id === sent).error, 'the mod restarted')
  assert.equal(view().cmds[queued], 'queued')
  assert.equal(view().context[A.host], 30)
  const n = poll({ ...A, inst: 'ia2' })
  assert.equal(n.r.sent[0].json.cmds[0].id, queued, 'the queued one goes to the new mod')
})

test('deck: an inst seen before for the session doesn\'t count as a restart again', () => {
  const { deck, reg, hello, ev, poll, view, log } = setup()
  reg([A, 'busy'])
  hello(A)
  hello({ ...A, inst: 'ia2' })
  const c = deck.prompt({ host: A.host, text: 'one' }).cmd
  poll({ ...A, inst: 'ia2' })
  ev({ ...A, inst: 'ia2' }, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'a.md', fp: 'x' })
  // A late request from the first instance, a retry say.
  ev(A, { t: 'measure', context: { percent: 40, tokens: 4, window: 10 } })
  deck.result({ sid: A.sid, host: A.host, inst: 'ia', id: 'nope', state: 'done' })
  assert.equal(view().cmds[c], 'delivered', 'still in flight to ia2')
  assert.equal(view().doing[A.host], 'a.md', 'its current tool kept')
  assert.equal(deck.state().sessions[A.host].inst, 'ia2')
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 1)
  hello({ ...A, inst: 'ia3' })
  assert.equal(view().cmds[c], 'failed', 'a new one still does')
})

test('deck: a new inst answers the old instance\'s open poll with no commands, so what\'s queued next waits for the new one', () => {
  const { deck, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A)
  const old = poll(A)
  hello({ ...A, inst: 'ia2' })
  assert.deepEqual(old.r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.equal(deck.state().sessions[A.host].poll, null)
  const c = deck.prompt({ host: A.host, text: 'one' }).cmd
  assert.equal(view().cmds[c], 'queued', 'not delivered to the instance that went')
  assert.deepEqual(poll({ ...A, inst: 'ia2' }).r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'one' }] } }])
})

test('deck: a poll from an inst that isn\'t the newest is answered at once with no commands, and leaves the newest one\'s poll alone', () => {
  const { deck, clock, reg, hello, ev, poll, view, log } = setup()
  reg([A, 'busy'])
  hello(A)
  hello({ ...A, inst: 'ia2' })
  const newest = poll(A, 20, 'ia2')
  const stale = poll(A, 20, 'ia')
  assert.deepEqual(stale.r.sent, [{ status: 200, json: { cmds: [] } }], 'answered at once')
  assert.equal(newest.r.sent.length, 0, 'the newest instance\'s poll stays open')
  const c1 = deck.prompt({ host: A.host, text: 'one' }).cmd
  assert.deepEqual(newest.r.sent, [{ status: 200, json: { cmds: [{ id: c1, t: 'prompt', text: 'one' }] } }], 'and gets the command')

  // With a command queued and no poll open, an old inst's poll still gets none of it, whatever its wait.
  const c2 = deck.prompt({ host: A.host, text: 'two' }).cmd
  assert.deepEqual(poll(A, 20, 'ia').r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.deepEqual(poll(A, 0, 'ia').r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.deepEqual([view().cmds[c2], deck.state().sessions[A.host].poll], ['queued', null])
  // Its events are still taken.
  ev(A, { t: 'measure', context: { percent: 40, tokens: 4, window: 10 } })
  assert.equal(view().context[A.host], 40)

  // Nor does it keep a waiting prompt alive: only the newest instance's polls show the session's mod is there.
  assert.deepEqual(poll(A, 20, 'ia2').r.sent[0].json.cmds.map((c) => c.id), [c2])
  deck.result({ sid: A.sid, host: A.host, inst: 'ia2', id: c2, state: 'waiting' })
  for (let i = 0; i < 3; i++) {
    poll(A, 20, 'ia')
    clock.advance(20_000)
  }
  assert.deepEqual([view().cmds[c2], deck.state().commands.find((c) => c.id === c2).error], ['failed', 'no result'])
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 1, 'and none of it is a restart')
})

test('deck: a queued command that no poll takes within 60 s fails with "not delivered"', () => {
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A)
  const error = (id) => deck.state().commands.find((c) => c.id === id).error
  const c1 = deck.prompt({ host: A.host, text: 'one' }).cmd
  clock.advance(59_999)
  assert.equal(view().cmds[c1], 'queued')
  clock.advance(1)
  assert.deepEqual([view().cmds[c1], error(c1)], ['failed', 'not delivered'])

  // One a poll takes in time has a delivered command's 60 s from then on instead.
  const c2 = deck.mode({ host: A.host, mode: 'plan' }).cmd
  clock.advance(40_000)
  poll(A)
  assert.equal(clock.pending, 1, 'its queued clock stopped: only the delivered one runs')
  clock.advance(59_999)
  assert.equal(view().cmds[c2], 'delivered')
  clock.advance(1)
  assert.deepEqual([view().cmds[c2], error(c2)], ['failed', 'no result'])
  assert.equal(clock.pending, 0, 'no timers left behind')
})

test('deck: a Saved Prompt key, known by its text, alerts and queues nothing while its last prompt is queued, delivered or waiting', () => {
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'idle'], [B, 'idle'])
  hello(A)
  hello(B)
  const press = (text, host = A.host) => deck.prompt({ host, text })
  const result = (id, state) => deck.result({ sid: A.sid, host: A.host, inst: A.inst, id, state })
  const queued = () => Object.keys(view().cmds).length

  const c1 = press('Run the tests.').cmd
  let r = press('Run the tests.')
  assert.deepEqual([r.ok, r.alert, queued(), view().alert], [false, true, 1, true])
  assert.equal(r.error, `the key's last prompt, ${c1} for ${A.host}, is still queued`)
  assert.equal(press('Run the tests.', B.host).alert, true, 'whatever the target')
  const other = press('Report.')
  assert.equal(other.ok, true, 'another key')
  poll(A)
  assert.match(press('Run the tests.').error, /is still delivered$/)
  result(c1, 'waiting')
  assert.match(press('Run the tests.').error, /is still waiting$/)
  result(c1, 'done')
  r = press('Run the tests.', B.host)
  assert.equal(r.ok, true, 'sent: the key is free again')
  result(other.cmd, 'refused')
  assert.equal(press('Report.').ok, true, 'refused frees it too')
  assert.equal(queued(), 4)

  // A prompt that no poll takes ends with "not delivered", so the key can't stay locked.
  clock.advance(60_000)
  assert.equal(view().cmds[r.cmd], 'failed')
  assert.equal(press('Run the tests.', B.host).ok, true)
  // A reset forgets the keys with the commands.
  press('Report.')
  deck.reset()
  reg([A, 'idle'])
  hello(A)
  assert.equal(press('Report.').ok, true)
})

test('deck: events with a seq not above the last for their inst are dropped', () => {
  const { deck, reg, hello, view } = setup()
  reg([A, 'busy'])
  hello(A)
  const send = (inst, seq, percent) => deck.events({ sid: A.sid, host: A.host, inst, seq, events: [{ t: 'measure', context: { percent }, at: 1 }] })
  send('ia', 1, 10)
  send('ia', 1, 50)
  assert.equal(view().context[A.host], 10)
  send('ia', 3, 20)
  send('ia', 2, 60)
  assert.equal(view().context[A.host], 20)
  send('ia2', 1, 70)
  assert.equal(view().context[A.host], 70, 'seq starts again for a new inst')
})

test('deck: statuses come in the order PROTOCOL.md gives', () => {
  const { deck, reg, hello, ev, perm, view } = setup()
  const status = () => view().status[A.host]
  reg([A, 'idle'])
  assert.equal(status(), 'idle')
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' })
  reg([A, 'busy'])
  assert.equal(status(), 'working')
  ev(A, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'notes.md', fp: 'f1' })
  ev(A, { t: 'tool.start', tool: 'Grep', use: 'u2', agent: 'ag1', summary: 'TODO', fp: 'f2' })
  assert.equal(view().doing[A.host], 'notes.md', 'the main loop\'s tool, not a subagent\'s')
  const ask = perm(A, 'AskUserQuestion', ASK)
  assert.equal(status(), 'needs-you')
  const tool = perm(A, 'Write', W1)
  assert.equal(status(), 'approval', 'a tool request beats an ask')
  deck.clientClosed(ask.id)
  deck.clientClosed(tool.id)
  reg([A, 'waiting'])
  assert.equal(status(), 'needs-you', 'waiting with nothing held')
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  reg([A, 'idle'])
  assert.equal(status(), 'done')
  assert.equal(view().doing[A.host], null)
  deck.applyRecord(A.host, { needsUser: true })
  assert.equal(status(), 'needs-you', 'the record says the turn needs the user')
  ev(A, { t: 'turn.start', turn: 't2' }, { t: 'turn.end', turn: 't2', reason: 'aborted' })
  assert.equal(status(), 'interrupted')
  ev(A, { t: 'turn.start', turn: 't3' }, { t: 'failed', error: 'API error' })
  assert.equal(status(), 'failed')
  ev(A, { t: 'turn.start', turn: 't4' }, { t: 'turn.end', turn: 't4', agent: 'ag1', reason: 'answer' })
  deck.applyRecord(A.host, null)
  assert.equal(status(), 'idle', 'a subagent\'s turn end is not the main loop\'s')
})

test('deck: a main-loop failed marks only its own turn: a turn.end for another turn reads done, as the deck reads rule 4', () => {
  const { reg, hello, ev, view } = setup()
  const status = () => view().status[A.host]
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'failed', error: 'API error' })
  reg([A, 'idle'])
  assert.equal(status(), 'failed')
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.equal(status(), 'failed', 'its own turn\'s end keeps it')
  // The next turn's start went missing: its end is another turn's.
  ev(A, { t: 'turn.end', turn: 't2', reason: 'answer' })
  assert.equal(status(), 'done')
  // With no turn id on one side or the other it can't tell the turns apart, and the failed stays.
  ev(A, { t: 'turn.start' }, { t: 'failed', error: 'API error' }, { t: 'turn.end', turn: 't3', reason: 'answer' })
  assert.equal(status(), 'failed')
  ev(A, { t: 'turn.start', turn: 't4' }, { t: 'failed', error: 'API error' }, { t: 'turn.end', reason: 'answer' })
  assert.equal(status(), 'failed')
})

test('deck: status rule 3, by what the bridge saw: a busy read before the main loop\'s turn ended aborted doesn\'t count, and the rules after it take the session as idle', () => {
  // Claude Code kept an interrupted session busy for up to 8 s after Esc, while the turn.end came at once (Phase 4).
  const { deck, clock, reg, hello, ev, perm, view } = setup()
  const status = () => view().status[A.host]
  const later = clock.now() + 60_000
  reg([A, 'busy', later])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' })
  assert.equal(status(), 'working')
  ev(A, { t: 'turn.end', turn: 't1', reason: 'aborted' })
  assert.equal(status(), 'interrupted', 'its first reading came before the turn.end, whatever its statusUpdatedAt says')
  reg([A, 'busy', later])
  reg([A, 'busy', later, { name: 'Renamed' }])
  assert.equal(status(), 'interrupted', 'the same busy, read again and renamed')
  reg([A, 'busy', null])
  assert.equal(status(), 'interrupted', 'and with its statusUpdatedAt gone, which is no news')
  const p = perm(A, 'Write', W1)
  assert.equal(status(), 'approval', 'a held request still comes first')
  deck.clientClosed(p.id)
  const q = perm(A, 'AskUserQuestion', ASK)
  assert.equal(status(), 'needs-you', 'so does a held question')
  deck.clientClosed(q.id)
  reg([A, 'waiting'])
  assert.equal(status(), 'needs-you', 'and a registry waiting, with nothing held')
  reg([A, 'idle'])
  assert.equal(status(), 'interrupted', 'idle at last')

  // Rule 4 still comes before rule 5.
  ev(A, { t: 'turn.start', turn: 't2' })
  reg([A, 'busy'])
  assert.equal(status(), 'working')
  ev(A, { t: 'failed', error: 'API error' }, { t: 'turn.end', turn: 't2', reason: 'aborted' })
  assert.equal(status(), 'failed')
})

test('deck: status rule 3: a busy the bridge read after the main loop\'s aborted turn.end counts: a new status, a rewritten statusUpdatedAt or a first reading', () => {
  const { clock, reg, hello, ev, view } = setup()
  const status = (S) => view().status[S.host]
  reg([A, 'idle'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'aborted' })
  assert.equal(status(A), 'interrupted')
  clock.advance(1000)
  reg([A, 'busy'])
  assert.equal(status(A), 'working', 'busy since the turn.end, though no turn.start came')

  ev(A, { t: 'turn.start', turn: 't2' }, { t: 'turn.end', turn: 't2', reason: 'aborted' })
  assert.equal(status(A), 'interrupted')
  clock.advance(1000)
  reg([A, 'busy'])
  assert.equal(status(A), 'working', 'a rewritten statusUpdatedAt is a new busy')

  // Without statusUpdatedAt, the busy is the reading that first showed it.
  ev(A, { t: 'turn.start', turn: 't3' })
  reg([A, 'busy', null])
  ev(A, { t: 'turn.end', turn: 't3', reason: 'aborted' })
  reg([A, 'busy', null])
  assert.equal(status(A), 'interrupted')
  reg([A, 'idle', null])
  reg([A, 'busy', null])
  assert.equal(status(A), 'working')

  hello(B)
  ev(B, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'aborted' })
  assert.equal(status(B), 'interrupted', 'not listed yet')
  reg([A, 'busy', null], [B, 'busy'])
  assert.equal(status(B), 'working', 'its first reading came after the turn.end')
})

test('deck: status rule 3 takes only the main loop\'s turn.end with reason aborted, and a new turn ends it', () => {
  const { reg, hello, ev, view } = setup()
  const status = () => view().status[A.host]
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.equal(status(), 'working', 'a turn that ended otherwise')
  ev(A, { t: 'turn.start', turn: 't2' }, { t: 'turn.end', turn: 's1', agent: 'ag1', reason: 'aborted' })
  assert.equal(status(), 'working', 'a subagent\'s turn.end isn\'t the main loop\'s')
  ev(A, { t: 'turn.end', turn: 't2', reason: 'aborted' })
  assert.equal(status(), 'interrupted')
  ev(A, { t: 'turn.start', turn: 't3' })
  assert.equal(status(), 'working', 'a new turn, under the same busy')
})

test('deck: settings are the latest from hello, settings events and requests, else the record', () => {
  const { deck, reg, hello, ev, perm, view } = setup()
  reg([A, 'busy'])
  deck.applyRecord(A.host, { model: 'rec-model', effort: 'high', permissionMode: 'plan', needsUser: false })
  assert.deepEqual(view().settings[A.host], { model: 'rec-model', effort: 'high', mode: 'plan' })
  hello(A)
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'high', mode: 'plan' })
  perm(A, 'Write', W1)
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'low', mode: 'default' })
  ev(A, { t: 'settings', mode: 'acceptEdits' })
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'low', mode: 'acceptEdits' })
})

test('deck: prompts and modes go only to listed sessions that have the plugin', () => {
  const { deck, reg, hello, view } = setup()
  reg([A, 'idle'], [B, 'idle'])
  hello(A)
  let r = deck.prompt({ host: 'local_gone', text: 'x' })
  assert.deepEqual([r.ok, r.alert], [false, true])
  assert.match(r.error, /isn't running/)
  r = deck.mode({ host: B.host, mode: 'plan' })
  assert.match(r.error, /has no plugin/)
  assert.equal(view().alert, true)
  assert.throws(() => deck.mode({ host: A.host, mode: 'bypassPermissions' }), BadRequest)
  assert.throws(() => deck.prompt({ host: A.host, text: '' }), BadRequest)
  assert.throws(() => deck.prompt({ text: 'x' }), BadRequest)
  r = deck.prompt({ host: A.host, text: 'x' })
  assert.deepEqual([r.ok, view().alert], [true, false])
})

test('deck: a hello on another version is refused and doesn\'t count as the plugin', () => {
  const { deck, reg, hello } = setup()
  reg([A, 'idle'])
  assert.deepEqual(hello(A, { v: 2 }), { v: 1, ok: false, error: 'version' })
  assert.equal(deck.state().sessions[A.host], undefined)
  assert.deepEqual(hello(A), { v: 1, ok: true })
  assert.equal(deck.state().sessions[A.host].plugin, true)
})

test('deck: with no dial, the target is the session on screen latest: its attach, as the deck got it, or its lastFocusedAt', () => {
  const { deck, clock, reg, hello, ev, view } = setup()
  reg([A, 'idle'], [B, 'idle'])
  assert.equal(view().target, null)
  deck.applyRecord(A.host, { lastFocusedAt: 10 })
  deck.applyRecord(B.host, { lastFocusedAt: 20 })
  assert.equal(view().target, B.host)
  hello(A)
  ev(A, { t: 'attach', surface: 'desktop', at: 5 })
  assert.equal(view().target, A.host, 'the attach came now, whatever the mod\'s clock said')
  clock.advance(1000)
  deck.applyRecord(B.host, { lastFocusedAt: clock.now() })
  assert.equal(view().target, B.host, 'focused in the app since')
})

const DOCS = { url: 'https://docs.example.com/a', prompt: 'Summarise' }
const NEWS = { url: 'https://news.example.com/b', prompt: 'Summarise' }
const fetchStart = (use, input, fp = fingerprint('WebFetch', input)) => ({ t: 'tool.start', tool: 'WebFetch', use, summary: new URL(input.url).host, fp })
const fpChecks = (log) => log.filter((e) => e.kind === 'fp-check').map((e) => [e.request, e.unpaired ? 'unpaired' : e.match ? 'match' : 'mismatch', e.modSummary])

test('deck: two parallel calls of one tool pair each request with the tool.start that has its fp, in every order', () => {
  // [what, the steps in order]: `docs`/`news` for a request, `+docs`/`+news` for its call's tool.start.
  const orders = [
    // The tool.starts first, as the mod's events usually come (S1): the latest is news, but docs's request is docs's.
    ['tool.starts first', ['+docs', '+news', 'docs', 'news']],
    ['requests first, tool.starts the other way round', ['docs', 'news', '+news', '+docs']],
    // The verifier's: a request before its own tool.start, while the other call of the tool is unfinished.
    ['a request, then the other call, then its own', ['docs', '+news', '+docs', 'news']],
    ['one pair done, then a request before its own', ['+news', 'news', 'docs', '+docs']],
  ]
  for (const [what, steps] of orders) {
    const { log, reg, hello, ev, perm } = setup()
    reg([A, 'busy'])
    hello(A)
    const ids = {}
    let use = 0
    for (const step of steps) {
      const input = step.endsWith('docs') ? DOCS : NEWS
      if (step.startsWith('+')) ev(A, fetchStart(`u${++use}`, input))
      else ids[step] = perm(A, 'WebFetch', input).id
    }
    ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
    const want = steps.filter((s) => s.startsWith('+')).map((s) => s.slice(1))
    const got = fpChecks(log)
    assert.deepEqual(got.toSorted(), want.map((k) => [ids[k], 'match', `${k}.example.com`]).toSorted(), what)
  }
})

test('deck: a request no tool.start pairs with by fp is judged as it ends: a mismatch only when it can pair one way, else unpaired', () => {
  const { deck, log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'])
  hello(A)
  const turnEnd = (turn) => ev(A, { t: 'turn.end', turn, reason: 'answer' })
  const check = (p) => log.find((e) => e.kind === 'fp-check' && e.request === p.id)
  const end = (p) => deck.answer({ id: p.id, decision: 'none' })

  // One call of the tool and one request for it, with fps that differ: it can only be that one, a true difference.
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u1', summary: 'ls', fp: 'deadbeef' })
  const p1 = perm(A, 'Bash', { command: 'ls' })
  turnEnd('t1')
  assert.equal(check(p1), undefined, 'nothing while it\'s held, though the main loop\'s turn ended: its own tool.start may still come')
  end(p1)
  assert.deepEqual([check(p1).match, check(p1).modFp, check(p1).modSummary, check(p1).unpaired, check(p1).why], [false, 'deadbeef', 'ls', undefined, 'answered none by the control route'])

  // Two parallel calls whose fps both differ from their requests': it can't tell which is which.
  ev(A, fetchStart('u2', DOCS, 'deadbee1'), fetchStart('u3', NEWS, 'deadbee2'))
  const p2 = perm(A, 'WebFetch', DOCS)
  const p3 = perm(A, 'WebFetch', NEWS)
  end(p2)
  end(p3)
  for (const p of [p2, p3]) {
    assert.deepEqual([check(p).match, check(p).unpaired, check(p).modFp, check(p).doubt], [null, true, null, 'another request of its tool waited beside it unpaired'])
    assert.deepEqual(check(p).calls, [{ fp: 'deadbee1', summary: 'docs.example.com' }, { fp: 'deadbee2', summary: 'news.example.com' }])
  }
  turnEnd('t2')

  // One request, and two calls of its tool that paired with nothing: one may have needed no permission.
  ev(A, fetchStart('u4', DOCS, 'deadbee3'), fetchStart('u5', NEWS, 'deadbee4'))
  const p4 = perm(A, 'WebFetch', DOCS)
  end(p4)
  assert.deepEqual([check(p4).unpaired, check(p4).calls.length, check(p4).doubt], [true, 2, '2 unpaired calls of its tool were under way while it was held'])
  turnEnd('t3')

  // No call of its tool at all, only one of another's.
  ev(A, fetchStart('u6', DOCS))
  const p5 = perm(A, 'Write', W1)
  end(p5)
  assert.deepEqual([check(p5).unpaired, check(p5).calls], [true, []])
  turnEnd('t4')

  // A call that ended before the request arrived wasn't its own; one that ended while it was held, answered in the
  // app say, may have been.
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u7', summary: 'pwd', fp: 'deadbee5' }, { t: 'tool.end', tool: 'Bash', use: 'u7', fp: 'deadbee5', ok: true })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u8', summary: 'make', fp: 'deadbee6' })
  const p6 = perm(A, 'Bash', { command: 'make' })
  ev(A, { t: 'tool.end', tool: 'Bash', use: 'u8', fp: 'deadbee6', ok: true })
  end(p6)
  assert.deepEqual([check(p6).match, check(p6).modFp, check(p6).modSummary], [false, 'deadbee6', 'make'])
  turnEnd('t5')

  // A request of its tool that ended unpaired while it waited may have been the one call's: neither can tell.
  ev(A, fetchStart('u9', DOCS, 'deadbee7'))
  const p7 = perm(A, 'WebFetch', DOCS)
  ev(A, { t: 'tool.end', tool: 'WebFetch', use: 'u9', fp: 'deadbee7', ok: true })
  const p8 = perm(A, 'WebFetch', NEWS)
  ev(A, fetchStart('u10', NEWS, 'deadbee8'))
  end(p7)
  end(p8)
  assert.deepEqual([p7, p8].map((p) => [check(p).unpaired, check(p).calls.length, check(p).doubt]), [
    [true, 2, 'another request of its tool waited beside it unpaired'],
    [true, 1, 'another request of its tool waited beside it unpaired'],
  ])
  turnEnd('t6')

  // Nor was a call that ended before it came its own, though that call ended while another request of its tool waited.
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u11', summary: 'pwd', fp: 'deadbee9' })
  const p9 = perm(A, 'Bash', { command: 'ls' })
  ev(A, { t: 'tool.end', tool: 'Bash', use: 'u11', fp: 'deadbee9', ok: true })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u12', summary: 'ls', fp: fingerprint('Bash', { command: 'ls' }) })
  const p10 = perm(A, 'Bash', { command: 'make' })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u13', summary: 'make', fp: 'deadbeea' })
  end(p10)
  assert.deepEqual([check(p9).match, check(p10).match, check(p10).modFp], [true, false, 'deadbeea'])
  assert.equal(log.filter((e) => e.kind === 'fp-check').length, 10, 'one line for each request')
})

test('deck: a request waits for its own tool.start across a mod restart, since an older inst\'s events still count', () => {
  // Round 3's probe (probe-fp.mjs): an auto-allowed call of Bash, a request for another whose tool.start is still
  // on the old instance's line, a hello from a new inst, then the old line's late tool.start.
  const { deck, log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u1', summary: 'ls', fp: fingerprint('Bash', { command: 'ls' }) })
  const p1 = perm(A, 'Bash', { command: 'make' })
  hello({ ...A, inst: 'ia2' })
  assert.deepEqual(fpChecks(log), [], 'not given up at the restart')
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u2', summary: 'make', fp: fingerprint('Bash', { command: 'make' }) })
  assert.deepEqual(fpChecks(log), [[p1.id, 'match', 'make']])

  // Had its tool.start been lost with the old instance, it ends unpaired, not a mismatch with the one other call.
  const p2 = perm(A, 'Bash', { command: 'make install' })
  hello({ ...A, inst: 'ia3' })
  deck.answer({ id: p2.id, decision: 'allow' })
  const c = log.find((e) => e.kind === 'fp-check' && e.request === p2.id)
  assert.deepEqual([c.unpaired, c.match, c.calls], [true, null, [{ fp: fingerprint('Bash', { command: 'ls' }), summary: 'ls' }]])
  assert.equal(c.doubt, 'the mod restarted while it was held, so its own tool.start may never come')
})

test('deck: a request waits for its own tool.start past the main loop\'s turn end, since a background subagent\'s call can outlast it', () => {
  // Round 3's probe (probe-fp.mjs): a background subagent's call of Bash starts before the main loop's turn ends
  // and asks for permission after, then the subagent makes an auto-allowed call of Bash.
  const { log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u1', agent: 'bg', summary: 'make', fp: fingerprint('Bash', { command: 'make' }) })
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  const p1 = perm(A, 'Bash', { command: 'make' })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u2', agent: 'bg', summary: 'ls', fp: fingerprint('Bash', { command: 'ls' }) })
  ev(A, { t: 'turn.end', turn: 't2', reason: 'answer' })
  assert.deepEqual(fpChecks(log), [[p1.id, 'match', 'make']])

  // The other way round: its request before the main loop's turn end, its tool.start after.
  const p2 = perm(A, 'Bash', { command: 'npm test' })
  ev(A, { t: 'turn.end', turn: 't3', reason: 'answer' }, { t: 'turn.end', turn: 's1', agent: 'other', reason: 'answer' })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u3', agent: 'bg', summary: 'npm test', fp: fingerprint('Bash', { command: 'npm test' }) })
  assert.deepEqual(fpChecks(log), [[p1.id, 'match', 'make'], [p2.id, 'match', 'npm test']])
})

test('deck: a request released by a tool.end with its fp, whose tool.start never came, is unpaired, not a mismatch with another call', () => {
  const { log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u1', agent: 'ag1', summary: 'npm test', fp: fingerprint('Bash', { command: 'npm test' }) })
  const p1 = perm(A, 'Bash', { command: 'make' })
  // Its own tool.start was lost, a 4xx dropped it say, and its tool.end releases it (rule 1).
  ev(A, { t: 'tool.end', tool: 'Bash', use: 'u2', fp: fingerprint('Bash', { command: 'make' }), ok: true })
  const c = log.find((e) => e.kind === 'fp-check')
  assert.deepEqual([c.request, c.unpaired, c.why, c.doubt], [p1.id, true, 'tool.end with the same fp', 'a tool.end with its fp released it, so its own tool.start never came'])
})

test('deck: both sides\' fingerprints are compared in the log, whichever comes second', () => {
  const { log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'tool.start', tool: 'Write', use: 'u1', summary: 'one.txt', fp: fingerprint('Write', W1) })
  perm(A, 'Write', W1)
  perm(A, 'Bash', { command: 'ls' })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u2', summary: 'ls', fp: 'deadbeef' })
  ev(A, { t: 'failed', error: 'API error' })
  // Rule 3 ends both requests, and the Bash one with them: the one call of Bash was under way while it was held.
  reg([A, 'idle'])
  const checks = log.filter((e) => e.kind === 'fp-check').map((e) => [e.tool, e.match, e.modFp])
  assert.deepEqual(checks, [['Write', true, fingerprint('Write', W1)], ['Bash', false, 'deadbeef']])
})

test('deck: a subagent\'s failed isn\'t the main loop\'s: its calls and waiting requests stay, and its turn still ends done', () => {
  const { log, reg, hello, ev, perm, view } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'notes.md', fp: 'f1' })
  // A subagent's call of Bash, then a request from the main loop whose own tool.start is still on the mod's line.
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u2', agent: 'ag1', summary: 'ls', fp: fingerprint('Bash', { command: 'ls' }) })
  const p1 = perm(A, 'Bash', { command: 'make' })
  ev(A, { t: 'failed', agent: 'ag1', error: 'overloaded' })
  assert.deepEqual(fpChecks(log), [], 'p1 goes on waiting: the main loop\'s turn hasn\'t ended')
  assert.equal(view().doing[A.host], 'notes.md', 'the main loop\'s call is still running')
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u3', summary: 'make', fp: fingerprint('Bash', { command: 'make' }) })
  assert.deepEqual(fpChecks(log), [[p1.id, 'match', 'make']], 'paired with its own call, not the subagent\'s')
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  reg([A, 'idle'])
  assert.equal(view().status[A.host], 'done')
})

test('deck: a request waits for its tool.start until it ends, its session ending or the bridge resetting included', () => {
  const { deck, log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  const p1 = perm(A, 'Write', W1)
  hello({ ...A, inst: 'ia2' })
  const p2 = perm(A, 'Write', W1)
  ev({ ...A, inst: 'ia2' }, { t: 'tool.start', tool: 'Write', use: 'u1', summary: 'one.txt', fp: 'deadbeef' })
  const p3 = perm(B, 'Write', W1)
  assert.deepEqual(fpChecks(log), [], 'still waiting, the mod\'s restart notwithstanding')
  reg([B, 'busy'])
  const p4 = perm(B, 'Bash', { command: 'make' })
  ev(B, { t: 'tool.start', tool: 'Write', use: 'u2', summary: 'one.txt', fp: 'deadbee1' })
  deck.reset()
  const why = Object.fromEntries(log.filter((e) => e.kind === 'fp-check').map((e) => [e.request, [e.unpaired ? 'unpaired' : e.match, e.why, e.doubt]]))
  assert.deepEqual(why, {
    [p1.id]: ['unpaired', "the session's registry file disappeared", 'the mod restarted while it was held, so its own tool.start may never come'],
    [p2.id]: ['unpaired', "the session's registry file disappeared", 'another request of its tool waited beside it unpaired'],
    [p3.id]: [false, 'the bridge was reset', undefined],
    [p4.id]: ['unpaired', 'the bridge was reset', 'no unpaired call of its tool was under way while it was held'],
  })
})

test('deck: answer by id, and an ended request says how it ended', () => {
  const { deck, reg, perm } = setup()
  reg([A, 'busy'])
  const p1 = perm(A, 'Write', W1)
  assert.deepEqual(deck.answer({ id: p1.id, decision: 'deny' }), { ok: true, id: p1.id, decision: 'deny', kind: 'tool' })
  assert.deepEqual(p1.r.sent, [{ status: 200, json: DENY }])
  assert.match(deck.answer({ id: p1.id, decision: 'allow' }).error, /already ended \(answered\)/)
  assert.match(deck.answer({ id: 'p99', decision: 'allow' }).error, /no request p99/)
  assert.throws(() => deck.answer({ id: p1.id, decision: 'yes' }), BadRequest)
})

test('deck: answer refuses an ask request, which the deck never answers: a press jumps instead', () => {
  const { deck, reg, perm, view } = setup()
  reg([A, 'busy'])
  for (const [tool, input] of [['AskUserQuestion', ASK], ['ExitPlanMode', { plan: 'x' }]]) {
    const ask = perm(A, tool, input)
    for (const decision of ['allow', 'deny', 'none']) {
      assert.throws(() => deck.answer({ id: ask.id, decision }), (err) => err instanceof BadRequest && /never answers: a press on it jumps to local_a instead/.test(err.message))
    }
    assert.equal(ask.r.sent.length, 0, `${tool}: nothing sent`)
  }
  assert.deepEqual(view().held.map((h) => h.kind), ['ask', 'ask'], 'both still held')
  assert.equal(deck.press('approve').jumped, A.host)
})

test('deck: reset and close answer held requests with {} and open polls with no commands', () => {
  const { deck, clock, reg, hello, perm, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  const p1 = perm(A, 'Write', W1)
  const n1 = poll(A)
  deck.prompt({ host: A.host, text: 'x' })
  const n2 = poll(A)
  deck.reset()
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  assert.deepEqual(n1.r.sent[0].json.cmds.length, 1)
  assert.equal(n2.r.sent.length, 1)
  assert.deepEqual([view().sessions, view().held, view().cmds], [[], [], {}])
  assert.equal(clock.pending, 0, 'no timers left behind')
  reg([A, 'busy'])
  hello(A)
  assert.equal(deck.prompt({ host: A.host, text: 'y' }).cmd, 'cmd-2', 'command ids stay unique for the run')
})
