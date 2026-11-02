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

test('deck: release rule 3: the registry shows idle with a statusUpdatedAt after the request arrived', () => {
  const { clock, reg, perm } = setup()
  reg([A, 'busy'])
  const arrived = clock.now()
  const p1 = perm(A, 'Write', W1)
  clock.advance(500)
  reg([A, 'idle', arrived - 1000])
  assert.equal(p1.r.sent.length, 0, 'a stale idle')
  reg([A, 'idle', arrived])
  assert.equal(p1.r.sent.length, 0, 'not after')
  reg([A, 'idle', arrived + 10])
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
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

test('deck: the host comes from X-Deck-Host, else the sid in the registry; an uninterpolated variable is missing', () => {
  const { reg, perm, view } = setup()
  reg([A, 'busy'])
  perm(A, 'Write', W1, { header: undefined })
  perm(A, 'Write', W1, { header: '' })
  perm(A, 'Write', W1, { header: '$CLAUDE_CODE_HOST_SESSION_ID' })
  assert.deepEqual(view().held.map((h) => h.host), [A.host, A.host, A.host])
  perm(B, 'Write', W1, { header: undefined })
  assert.equal(view().held[3].host, null, 'an unknown sid has no host yet')
  reg([A, 'busy'], [B, 'busy'])
  assert.equal(view().held[3].host, B.host, 'filled in once the registry knows the sid')
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
  assert.equal(view().cmds[queued], 'queued')
  assert.equal(view().context[A.host], 30)
  const n = poll({ ...A, inst: 'ia2' })
  assert.equal(n.r.sent[0].json.cmds[0].id, queued, 'the queued one goes to the new mod')
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

test('deck: with no dial, the target is the latest attach, else the latest lastFocusedAt', () => {
  const { deck, reg, hello, ev, view } = setup()
  reg([A, 'idle'], [B, 'idle'])
  assert.equal(view().target, null)
  deck.applyRecord(A.host, { lastFocusedAt: 10 })
  deck.applyRecord(B.host, { lastFocusedAt: 20 })
  assert.equal(view().target, B.host)
  hello(A)
  ev(A, { t: 'attach', surface: 'desktop', at: 5 })
  assert.equal(view().target, A.host)
})

test('deck: both sides\' fingerprints are compared in the log, whichever comes second', () => {
  const { log, reg, hello, ev, perm } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'tool.start', tool: 'Write', use: 'u1', summary: 'one.txt', fp: fingerprint('Write', W1) })
  perm(A, 'Write', W1)
  perm(A, 'Bash', { command: 'ls' })
  ev(A, { t: 'tool.start', tool: 'Bash', use: 'u2', summary: 'ls', fp: 'deadbeef' })
  const checks = log.filter((e) => e.kind === 'fp-check').map((e) => [e.tool, e.match, e.modFp])
  assert.deepEqual(checks, [['Write', true, fingerprint('Write', W1)], ['Bash', false, 'deadbeef']])
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
  const ask = perm(A, 'AskUserQuestion', ASK)
  assert.match(deck.answer({ id: ask.id, decision: 'none' }).note, /never answers ask/)
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
