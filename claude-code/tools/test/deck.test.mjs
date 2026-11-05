// The fake deck's logic, driven directly with fake timers: kinds, presses, release rules, commands, polls
// and statuses, each against the PROTOCOL.md section it follows.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BadRequest, FakeDeck, NotThisSession } from '../lib/deck.mjs'
import { ALLOW, DENY, MODE_TOOL, PRE_ALLOW, fingerprint } from '../lib/protocol.mjs'
import { fakeTimers, responder } from './helpers.mjs'

const A = { sid: 'sid-a', host: 'local_a', inst: 'ia', pid: 1 }
const B = { sid: 'sid-b', host: 'local_b', inst: 'ib', pid: 2 }
const W1 = { file_path: '/s/one.txt', content: '1' }
const ASK = { questions: [{ question: 'Red or blue?' }] }

/**
 * A fake deck on fake clocks, with helpers. `options` go to the FakeDeck: `inFlightMs` longer than 60 s, for a test of
 * the 60 s after a turn end that leaves out the mod's polls each second, so its current instance doesn't stop
 * counting meanwhile (PROTOCOL.md, Identity).
 */
function setup(options = {}) {
  const clock = fakeTimers()
  const log = []
  const deck = new FakeDeck({ now: clock.wall, monoNow: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (e) => log.push(e), ...options })
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
  // A mode check, as the mode hook sends it: the app's mode tool for `self` and `mode`, unless `opts` says otherwise.
  const pre = (S, mode, opts = {}) => {
    const header = Object.hasOwn(opts, 'header') ? opts.header : S.host
    const r = responder()
    const out = deck.pretool({
      body: {
        session_id: S.sid, hook_event_name: 'PreToolUse', permission_mode: 'auto', effort: { level: 'high' },
        tool_name: opts.tool ?? MODE_TOOL, tool_input: opts.input ?? { session_id: 'self', mode }, tool_use_id: 'toolu_plugin_0001', ...opts.extra,
      },
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
  return { deck, clock, log, reg, hello, ev, perm, pre, poll, view: () => deck.view() }
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

test('deck: a mode check is allowed at once for a mode command in flight, the first per command, counted apart from kind mode\'s allowance', () => {
  // PROTOCOL.md, "Mode checks": the PreToolUse allow takes the deck's own change past the auto-mode classifier.
  const { deck, log, reg, hello, perm, pre, poll, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  const none = [{ status: 200, json: {} }]
  const allow = [{ status: 200, json: PRE_ALLOW }]
  assert.deepEqual(pre(A, 'default').r.sent, none, 'no command at all')
  const c1 = deck.mode({ host: A.host, mode: 'default' }).cmd
  assert.deepEqual(pre(A, 'default').r.sent, none, 'queued is not in flight')
  poll(A)
  assert.equal(view().cmds[c1], 'delivered')
  assert.deepEqual(pre(A, 'plan').r.sent, none, 'another mode')
  assert.deepEqual(pre(B, 'default').r.sent, none, 'another session')
  assert.deepEqual(pre(A, 'default', { input: { session_id: A.host, mode: 'default' } }).r.sent, none, 'not self')
  assert.deepEqual(pre(A, 'default', { input: { mode: 'default' } }).r.sent, none, 'no session_id in the input')
  assert.deepEqual(pre(A, 'default', { tool: 'Bash', input: { command: 'ls', session_id: 'self', mode: 'default' } }).r.sent, none, 'another tool')
  const q = pre(A, 'default')
  assert.deepEqual([q.kind, q.cmd, q.r.sent], ['allow', c1, allow])
  assert.deepEqual(pre(A, 'default').r.sent, none, 'one check allowed per command')
  // Kind mode's allowance is counted apart: the raise's PermissionRequest still gets its own, once.
  const p = perm(A, MODE_TOOL, { session_id: 'self', mode: 'default' })
  assert.deepEqual([p.kind, p.r.sent], ['mode', [{ status: 200, json: ALLOW }]])
  assert.equal(perm(A, MODE_TOOL, { session_id: 'self', mode: 'default' }).kind, 'tool', 'one request allowed per command')

  // The other way round: a command whose PermissionRequest came first still has its check.
  const c2 = deck.mode({ host: A.host, mode: 'plan' }).cmd
  poll(A)
  assert.equal(perm(A, MODE_TOOL, { session_id: 'self', mode: 'plan' }).kind, 'mode')
  assert.deepEqual(pre(A, 'plan').r.sent, allow)
  // A stray waiting keeps it in flight; a final result ends it.
  const c3 = deck.mode({ host: A.host, mode: 'acceptEdits' }).cmd
  poll(A)
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c3, state: 'waiting' })
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c2, state: 'done', detail: '' })
  assert.deepEqual([pre(A, 'acceptEdits').r.sent, pre(A, 'plan').r.sent], [allow, none])

  // A check is never held, and its body's mode and effort aren't the session's: only PermissionRequests' are.
  assert.deepEqual(view().held.map((h) => h.tool), [MODE_TOOL])
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'low', mode: 'default' })
  assert.deepEqual(log.filter((e) => e.kind === 'mode-check' && e.allowed).map((e) => e.cmd), [c1, c2, c3])
  assert.deepEqual(log.filter((e) => e.kind === 'mode-check' && !e.allowed).map((e) => e.why).slice(0, 3), [
    'no mode command for "default" in flight whose check hasn\'t been allowed', 'no mode command for "default" in flight whose check hasn\'t been allowed', 'no mode command for "plan" in flight whose check hasn\'t been allowed',
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

test('deck: release rule 3, by what the bridge saw: a reading of idle after one of another status', () => {
  const { clock, reg, perm } = setup()
  // Held while the session's first reading showed it idle: the deck has seen no change, whatever the times say. A
  // request is held only for a session the registry lists ("Desktop sessions only"), so it's never held before one.
  reg([A, 'idle', clock.now() + 60_000])
  const p1 = perm(A, 'Write', W1)
  clock.advance(500)
  reg([A, 'idle', clock.now() + 60_000])
  assert.equal(p1.r.sent.length, 0, 'idle again is no change, though its statusUpdatedAt is after the request came')
  reg([A, 'idle', null])
  assert.equal(p1.r.sent.length, 0, 'nor is idle without statusUpdatedAt')
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

  // A session that left the registry took its requests with it (rule 4). Back, it's read for the first time again,
  // and a request held since waits for a change the deck sees.
  reg([A, 'idle'], [B, 'busy'])
  const p4 = perm(B, 'Write', W1)
  reg([A, 'idle'])
  reg([A, 'idle'], [B, 'idle'])
  const p5 = perm(B, 'Write', W1)
  reg([A, 'idle'], [B, 'idle'])
  assert.deepEqual([p4.r.sent, p5.r.sent], [[{ status: 200, json: {} }], []], 'p4 by rule 4; p5 waits for a change')
  reg([A, 'idle'], [B, 'busy'])
  reg([A, 'idle'], [B, 'idle'])
  assert.deepEqual(p5.r.sent, [{ status: 200, json: {} }])
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

test('deck: a hook\'s request is taken only from a session the registry lists under its X-Deck-Host with its session_id; any other gets {} at once, and nothing is held or changed', () => {
  // PROTOCOL.md, "Desktop sessions only": every Claude Code process that reads ~/.claude/settings.json runs the hooks.
  const { deck, log, reg, hello, perm, pre, view } = setup()
  const LONG = { sid: 'sid-long', host: `local_${'x'.repeat(64)}`, pid: 5 }
  reg([A, 'busy'], [B, 'busy', undefined, { sessionId: undefined }], [LONG, 'busy'])
  hello(A)
  const none = [{ status: 200, json: {} }]
  const cases = [
    // A terminal or VS Code session, or a `claude -p` run: no host. Or a header Claude Code didn't fill in.
    ...[undefined, '', '$CLAUDE_CODE_HOST_SESSION_ID', 'not-local', 'local_', `local_${'x'.repeat(65)}`, 'local_a/b', ' local_a', 'local_a\n'].map((header) => [A, { header }, 'no host: X-Deck-Host is missing or not a local_ id']),
    // A `claude` started inside A: A's host, with its own session id.
    [{ ...A, sid: 'sid-child' }, {}, 'the registry lists local_a under another sessionId'],
    // A host the registry doesn't list, as a pre-warmed spare's before it's claimed.
    [{ sid: 'sid-spare', host: 'local_spare' }, {}, "the registry doesn't list local_spare"],
    // No session_id, and a listed host with no sessionId to compare it with.
    [A, { extra: { session_id: undefined } }, 'no session_id'],
    [B, {}, 'the registry lists local_b without a sessionId'],
  ]
  for (const [S, opts, why] of cases) {
    const p = perm(S, 'Write', W1, opts)
    const q = pre(S, 'default', opts)
    const what = `${S.sid} with ${JSON.stringify(opts)}`
    assert.deepEqual([p.kind, p.r.sent, q.kind, q.r.sent], ['unconfirmed', none, 'unconfirmed', none], what)
    assert.deepEqual(log.filter((e) => e.kind === 'unconfirmed').slice(-2).map((e) => [e.route, e.why]), [['permission', why], ['pretool', why]], what)
  }
  assert.deepEqual(view().held, [], 'nothing held')
  assert.deepEqual(Object.keys(deck.state().sessions), [A.host], 'no session made of them')
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: null, mode: null }, 'nor their mode or effort taken')
  assert.throws(() => deck.events({ sid: 'sid-child', host: '', inst: 'ichild', seq: 1, events: [] }), BadRequest, 'nor their session ids kept as pairs')

  // Whether bridge.mjs reads the registry once more first: only when another reading could confirm it.
  const needs = (header, body) => deck.hookNeedsReading(header, body)
  assert.deepEqual(
    [needs(A.host, { session_id: A.sid }), needs(undefined, { session_id: A.sid }), needs('not-local', { session_id: A.sid }), needs(A.host, {}), needs(A.host, { session_id: 'sid-child' }), needs('local_spare', { session_id: 'sid-spare' })],
    [false, false, false, false, true, true],
  )

  // The session's own, with a host of up to 64 characters after local_, are taken.
  const own = perm(A, 'Write', W1)
  assert.deepEqual([own.kind, own.r.sent], ['tool', []], 'held')
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'low', mode: 'default' }, 'its mode and effort taken')
  assert.equal(perm(LONG, 'Write', W1).kind, 'tool')
  assert.deepEqual(view().held.map((h) => h.host), [A.host, LONG.host])
  assert.deepEqual(pre(A, 'default').r.sent, none, 'a mode check from it with no command in flight: no decision')
})

test('deck: a hook\'s request is confirmed by the pair, its X-Deck-Host listed with its session_id: a host and a session id the registry lists apart, each with another session, confirm nothing', () => {
  // PROTOCOL.md, "Desktop sessions only": "a confirmed session is one the registry lists under the request's
  // X-Deck-Host, with a sessionId equal to the request's session_id". Neither half alone will do: a host listed under
  // another session, or a session id listed under another host or with a host the registry doesn't list.
  const { deck, log, reg, hello, perm, pre, poll, view } = setup()
  reg([A, 'busy'], [B, 'busy'])
  hello(A)
  hello(B)
  // Each session has a mode command in flight for default, so a request taken as either's would be allowed at once.
  const ca = deck.mode({ host: A.host, mode: 'default' }).cmd
  const cb = deck.mode({ host: B.host, mode: 'default' }).cmd
  poll(A)
  poll(B)
  assert.deepEqual([view().cmds[ca], view().cmds[cb]], ['delivered', 'delivered'])
  const none = [{ status: 200, json: {} }]
  const mode = { session_id: 'self', mode: 'default' }
  const cases = [
    // A listed host with another listed session's id.
    [{ ...A, host: B.host }, 'the registry lists local_b under another sessionId'],
    [{ ...B, host: A.host }, 'the registry lists local_a under another sessionId'],
    // A host the registry doesn't list, as a pre-warmed spare's, with a listed session's id.
    [{ ...A, host: 'local_spare' }, "the registry doesn't list local_spare"],
    [{ ...B, host: 'local_spare' }, "the registry doesn't list local_spare"],
  ]
  for (const [S, why] of cases) {
    const what = `X-Deck-Host ${S.host} with session_id ${S.sid}`
    const raise = perm(S, MODE_TOOL, mode)
    const write = perm(S, 'Write', W1)
    const check = pre(S, 'default')
    assert.deepEqual(
      [raise.kind, raise.r.sent, write.kind, write.r.sent, check.kind, check.r.sent],
      ['unconfirmed', none, 'unconfirmed', none, 'unconfirmed', none],
      what,
    )
    assert.deepEqual(log.filter((e) => e.kind === 'unconfirmed').slice(-3).map((e) => [e.route, e.host, e.sid, e.why]), [
      ['permission', S.host, S.sid, why], ['permission', S.host, S.sid, why], ['pretool', S.host, S.sid, why],
    ], what)
    assert.equal(deck.hookNeedsReading(S.host, { session_id: S.sid }), true, `${what}: the registry is read once more first`)
  }
  assert.deepEqual(view().held, [], 'nothing held')
  assert.deepEqual(Object.keys(deck.state().sessions).toSorted(), [A.host, B.host], 'no session made of them')
  assert.deepEqual([A, B].map((S) => view().settings[S.host]), [A, B].map(() => ({ model: 'm1', effort: null, mode: null })), 'nor their mode or effort taken')
  // Each session's own check and raise still get their allowances: none went to a request from another.
  for (const S of [A, B]) {
    assert.deepEqual(pre(S, 'default').r.sent, [{ status: 200, json: PRE_ALLOW }], `${S.host}'s own mode check`)
    assert.deepEqual(perm(S, MODE_TOOL, mode).r.sent, [{ status: 200, json: ALLOW }], `${S.host}'s own raise`)
  }
})

test('deck: the host fallback places a mod\'s request by its sid, in the registry, then among the sid and host pairs seen from mods, never from hooks', () => {
  const { deck, reg, hello, perm, view } = setup()
  const measure = (sid, host, inst, seq, percent) => deck.events({ sid, host, inst, seq, events: [{ t: 'measure', context: { percent, window: 10 }, at: 1 }] })
  reg([A, 'busy'])
  // The registry places a mod's request by its sid, whatever its host says.
  measure(A.sid, 'not-local', A.inst, 1, 7)
  assert.equal(view().context[A.host], 7)
  // C isn't in the registry. Its sid changes (a /clear, say), and its mod's next hello brings the new pair.
  const C = { sid: 'sid-c1', host: 'local_c', inst: 'ic', pid: 3 }
  hello(C)
  hello({ ...C, sid: 'sid-c2' })
  // A late request on the first sid and one on the second, both without a host: each pair places its own.
  measure('sid-c1', '', C.inst, 1, 9)
  assert.equal(view().context[C.host], 9)
  measure('sid-c2', '', C.inst, 2, 10)
  assert.equal(view().context[C.host], 10)

  // A hook's session_id is no pair. D's PermissionRequest is confirmed and held; then the registry lists D under a
  // new sessionId, and a mod request with no host and D's old sid can't be placed.
  const D = { sid: 'sid-d', host: 'local_d', inst: 'id', pid: 4 }
  reg([A, 'busy'], [D, 'busy'])
  assert.equal(perm(D, 'Write', W1).kind, 'tool')
  reg([A, 'busy'], [{ ...D, sid: 'sid-d2' }, 'busy'])
  assert.throws(() => measure('sid-d', '', D.inst, 1, 5), BadRequest)
  assert.equal(view().context[D.host], null)
})

test('deck: a hello from a host the registry lists under another sessionId is refused, and nothing of it is kept', () => {
  const { deck, log, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A)
  const n1 = poll(A)
  // A `claude` started inside A, whose mod runs under A's host: the engine's test can't tell, so the bridge does.
  const child = { ...A, sid: 'sid-child', inst: 'ichild' }
  assert.throws(() => hello(child, { model: 'child-model', mode: 'plan' }), (err) => err instanceof NotThisSession && err.message === 'not this session')
  assert.equal(n1.r.sent.length, 0, 'the session\'s open poll is left alone: no restart')
  const s = deck.state().sessions[A.host]
  assert.deepEqual([s.inst, s.insts, s.hello.inst], ['ia', ['ia'], 'ia'], 'nor is its inst current, or known')
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: null, mode: null }, 'nor its model or mode taken')
  assert.throws(() => deck.events({ sid: 'sid-child', host: '', inst: 'ichild', seq: 1, events: [] }), BadRequest, 'nor its sid a pair')
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 0)
  assert.deepEqual(log.filter((e) => e.kind === 'hello' && e.status === 409).map((e) => [e.host, e.inst, e.sid, e.listedSids]), [[A.host, 'ichild', 'sid-child', [A.sid]]])
  // A hello with no sid isn't the listed session's either; one on another version is refused for that first.
  assert.throws(() => hello(A, { sid: undefined, inst: 'inosid' }), NotThisSession)
  assert.deepEqual(hello(child, { v: 2 }), { v: 1, ok: false, error: 'version' })
  // Whether bridge.mjs reads the registry once more first: only for a hello it would refuse.
  const body = (S, extra = {}) => ({ v: 1, sid: S.sid, host: S.host, inst: S.inst, ...extra })
  assert.deepEqual([deck.helloNeedsReading(body(child)), deck.helloNeedsReading(body(A)), deck.helloNeedsReading(body(child, { v: 2 })), deck.helloNeedsReading(body(B))], [true, false, false, false])

  // A listed entry with no sessionId refuses nothing: only another sessionId does.
  reg([A, 'idle'], [B, 'idle', undefined, { sessionId: undefined }])
  assert.deepEqual(hello({ ...B, sid: 'sid-whatever' }), { v: 1, ok: true })
})

test('deck: a hello from a host the registry doesn\'t list yet, as from a pre-warmed spare, is taken, and the deck lists the session once the registry does', () => {
  const { deck, reg, hello, poll, view } = setup()
  const SPARE = { sid: 'sid-spare', host: 'local_spare', inst: 'isp', pid: 9 }
  reg([A, 'idle'])
  assert.deepEqual(hello(SPARE), { v: 1, ok: true })
  assert.deepEqual([view().sessions, deck.state().sessions[SPARE.host].inst], [[A.host], 'isp'], 'unlisted, its inst current')
  assert.match(deck.prompt({ host: SPARE.host, text: 'Hi.' }).error, /isn't running: the registry doesn't list it/)
  assert.match(deck.mode({ host: SPARE.host, mode: 'plan' }).error, /isn't running: the registry doesn't list it/)
  const n1 = poll(SPARE)
  assert.equal(n1.r.sent.length, 0, 'its poll is held: it said hello')
  // Claimed: the registry lists it, under the spare's session id.
  reg([A, 'idle'], [SPARE, 'idle'])
  assert.deepEqual(view().sessions.toSorted(), [A.host, SPARE.host])
  const c = deck.prompt({ host: SPARE.host, text: 'Hi.' }).cmd
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Hi.' }] } }])
})

test('deck: only a hello makes an inst current: one that hasn\'t said hello has its events taken, its polls answered at once with none, and never takes the session over', () => {
  // PROTOCOL.md, Identity: after a deck restart, a replaced instance's late request could take over a session's polls.
  const { deck, log, reg, hello, ev, poll, view } = setup()
  reg([A, 'idle'])
  const OLD = { ...A, inst: 'iold' }
  // Before any hello, as just after a deck restart: the replaced instance's late poll, and one with no inst. The
  // session has no current instance, so each asks for a hello; a replaced instance can't give one.
  const stray1 = poll(OLD)
  const stray2 = poll(A, 20, null)
  const helloFirst = [{ status: 409, json: { error: 'hello first' } }]
  assert.deepEqual([stray1.r.sent, stray2.r.sent], [helloFirst, helloFirst], 'answered at once')
  assert.equal(deck.state().sessions[A.host].inst, null, 'neither made current')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-hello-first').map((e) => [e.poll, e.inst]), [[stray1.id, 'iold'], [stray2.id, null]])
  // The live instance's hello, then its poll.
  hello(A)
  const n1 = poll(A)
  assert.equal(n1.r.sent.length, 0, 'held')
  // More from the old instance: its events are taken, its polls answered at once, and the live one's poll stays.
  ev(OLD, { t: 'measure', context: { percent: 42, window: 10 } })
  assert.equal(view().context[A.host], 42)
  const stray3 = poll(OLD)
  assert.deepEqual([stray3.r.sent, n1.r.sent], [[{ status: 200, json: { cmds: [] } }], []])
  const c = deck.prompt({ host: A.host, text: 'x' }).cmd
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'x' }] } }], 'the current instance takes the command')
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 0, 'none of it is a restart')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-stale').map((e) => [e.poll, e.inst, e.current]), [[stray3.id, 'iold', 'ia']])
})

test('deck: the deck remembers at least the last 8 insts that said hello for a session: none of them counts again', () => {
  const { deck, log, reg, hello, poll } = setup()
  reg([A, 'idle'])
  const insts = Array.from({ length: 9 }, (_, i) => `i${i + 1}`)
  for (const inst of insts) hello({ ...A, inst })
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 8)
  const n = poll({ ...A, inst: 'i9' })
  // The oldest eight say hello again, as after a failed request: none is a restart, and the current one's poll stays.
  for (const inst of insts.slice(0, 8)) assert.deepEqual(hello({ ...A, inst }), { v: 1, ok: true })
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 8)
  assert.deepEqual([deck.state().sessions[A.host].inst, n.r.sent], ['i9', []])
})

test('deck: a hello that doesn\'t make its inst current is answered ok and changes nothing: no model, mode or effort taken', () => {
  // PROTOCOL.md, Identity, as amended: "Its hello is answered ok but changes nothing, its model, mode and effort
  // included". A replaced instance's late hello, a retry say, carries what that instance last saw.
  const { deck, log, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A, { model: 'm1', mode: 'default', effort: 'low' })
  hello({ ...A, inst: 'ia2' }, { model: 'm2', mode: 'acceptEdits', effort: 'medium' })
  const n = poll({ ...A, inst: 'ia2' })
  const settings = { model: 'm2', effort: 'medium', mode: 'acceptEdits' }
  const helloSeen = deck.state().sessions[A.host].hello
  assert.deepEqual([view().settings[A.host], helloSeen.inst, helloSeen.model], [settings, 'ia2', 'm2'])
  // The replaced instance says hello again, and one says hello with no inst at all.
  for (const extra of [{ inst: 'ia', model: 'm-old', mode: 'plan', effort: 'high' }, { inst: undefined, model: 'm-none', mode: 'auto', effort: 'xhigh' }]) {
    assert.deepEqual(hello(A, extra), { v: 1, ok: true }, `${extra.inst ?? 'no inst'}: answered ok`)
    assert.deepEqual(view().settings[A.host], settings, `${extra.inst ?? 'no inst'}: no model, mode or effort taken`)
    assert.equal(deck.state().sessions[A.host].hello, helloSeen, `${extra.inst ?? 'no inst'}: nor is it the session's hello`)
  }
  assert.deepEqual([deck.state().sessions[A.host].inst, n.r.sent], ['ia2', []], 'the current instance and its poll stay')
  assert.deepEqual(log.filter((e) => e.kind === 'hello').map((e) => [e.inst, e.madeCurrent, e.current]), [['ia', true, 'ia'], ['ia2', true, 'ia2'], ['ia', false, 'ia2'], [null, false, 'ia2']])

  // A session with no current instance: a hello with no inst makes none current, and its polls still ask for one.
  reg()
  reg([A, 'idle'])
  assert.deepEqual(hello(A, { inst: undefined, model: 'm-none' }), { v: 1, ok: true })
  assert.deepEqual([deck.state().sessions[A.host].inst, view().settings[A.host].model], [null, null])
  assert.deepEqual(poll(A, 20, null).r.sent, [{ status: 409, json: { error: 'hello first' } }])
})

test('deck: the current instance\'s hello, said again as after a rejected fetch or a Deny, takes its cwd and model only: the deck keeps its own mode and effort, which a PermissionRequest may have made newer', () => {
  // PROTOCOL.md, Identity, as amended for Phase 6 (item 2). The mod says a quick hello with its own inst after a fetch
  // the engine abandoned, at an Esc or every deck Deny, and in an outage. Its model is the mod's own reading, which it
  // takes the deck to have once the hello is answered (connected() in claude-code/plugin/hooks/bridge.ts). Its mode
  // and effort are only what the mod last sent as settings, and could put back an older mode than the one the
  // PermissionRequest just brought.
  const { deck, log, reg, hello, perm, poll, view } = setup()
  reg([A, 'busy'])
  hello(A, { model: 'm1', mode: 'default', effort: 'low' })
  const n1 = poll(A)
  const c = deck.prompt({ host: A.host, text: 'x' }).cmd
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'x' }] } }])
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c, state: 'waiting' })
  const n2 = poll(A)
  // A PermissionRequest brings the session's newer mode and effort; the user denies it on the deck, and the Deny
  // abandons the mod's fetches, so it says hello again, with the mode and effort it last sent.
  const p = perm(A, 'Write', W1, { extra: { permission_mode: 'acceptEdits', effort: { level: 'high' } } })
  deck.press('deny')
  assert.deepEqual(p.r.sent, [{ status: 200, json: DENY }])
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'high', mode: 'acceptEdits' })

  assert.deepEqual(hello(A, { cwd: '/s2', model: 'm2', mode: 'default', effort: 'low' }), { v: 1, ok: true })
  assert.deepEqual(view().settings[A.host], { model: 'm2', effort: 'high', mode: 'acceptEdits' }, 'its model taken, its mode and effort not')
  const s = deck.state().sessions[A.host]
  assert.deepEqual([s.hello.inst, s.hello.cwd, s.hello.model, s.hello.mode, s.hello.effort], ['ia', '/s2', 'm2', 'default', 'low'], 'its cwd and model are the hello the state shows; the rest is the first hello\'s')
  // Nothing else changes: no restart, so the waiting prompt and the open poll stay, and so does the instance.
  assert.deepEqual([s.inst, s.insts, view().cmds[c], n2.r.sent], ['ia', ['ia'], 'waiting', []])
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 0)
  // A field the hello leaves out, as the mod does a model it can't read, is kept.
  hello(A, { cwd: undefined, model: undefined })
  assert.deepEqual([view().settings[A.host].model, deck.state().sessions[A.host].hello.cwd], ['m2', '/s2'])
  assert.deepEqual(log.filter((e) => e.kind === 'hello').map((e) => [e.inst, e.madeCurrent, e.again, e.took]), [
    ['ia', true, false, ['cwd', 'model', 'mode', 'effort']], ['ia', true, true, ['cwd', 'model']], ['ia', true, true, ['cwd', 'model']],
  ])

  // A hello that makes an instance current takes its cwd and model, and its mode and effort unless the deck took them
  // from a PermissionRequest (PROTOCOL.md, "The deck's session model", as amended for Phase 6, round 4): a restart's
  // here keeps the PermissionRequest's; one after a reset, as a deck restart, with none since, takes all four.
  hello({ ...A, inst: 'ia2' }, { cwd: '/s3', model: 'm3', mode: 'plan', effort: 'medium' })
  assert.deepEqual([deck.state().sessions[A.host].inst, view().settings[A.host], deck.state().sessions[A.host].hello.cwd], ['ia2', { model: 'm3', effort: 'high', mode: 'acceptEdits' }, '/s3'])
  assert.deepEqual([log.at(-1).kind, log.at(-1).took, log.at(-1).kept], ['hello', ['cwd', 'model'], ['mode', 'effort']])
  deck.reset()
  reg([A, 'busy'])
  hello({ ...A, inst: 'ia2' }, { cwd: '/s4', model: 'm4', mode: 'auto', effort: 'xhigh' })
  assert.deepEqual([view().settings[A.host], deck.state().sessions[A.host].hello.cwd], [{ model: 'm4', effort: 'xhigh', mode: 'auto' }, '/s4'])
  // And a replaced instance's hello changes nothing at all, its model included.
  hello({ ...A, inst: 'ia3' }, { model: 'm5', mode: 'plan', effort: 'low' })
  hello({ ...A, inst: 'ia2' }, { cwd: '/s-old', model: 'm-old', mode: 'default', effort: 'max' })
  assert.deepEqual([deck.state().sessions[A.host].inst, view().settings[A.host], deck.state().sessions[A.host].hello.cwd], ['ia3', { model: 'm5', effort: 'low', mode: 'plan' }, '/s'])
  assert.deepEqual(log.filter((e) => e.kind === 'hello').slice(-2).map((e) => [e.inst, e.madeCurrent, e.again]), [['ia3', true, false], ['ia2', false, false]])
})

test('deck: the current instance\'s hello, said again, gives only its model wherever the deck took its mode and effort from: a hello, a settings event, or nowhere yet, as well as a PermissionRequest', () => {
  // PROTOCOL.md, Identity: the current instance's hello, said again, "takes its cwd and model, and nothing else
  // changes"; "The deck's session model", as amended for Phase 6, round 4: it "gives only its model". That rule stands
  // apart from round 4's, which keeps a PermissionRequest's mode and effort from a hello that makes an instance
  // current: the test above has them from a PermissionRequest, where either rule keeps them.
  const { deck, clock, log, reg, hello, ev, view } = setup()
  const from = () => deck.state().sessions[A.host].settingsFrom
  const line = () => {
    const e = log.filter((x) => x.kind === 'hello').at(-1)
    return [e.madeCurrent, e.again, e.took]
  }
  reg([A, 'busy'])
  // The effort from the hello that made the instance current, the mode from a settings event since.
  hello(A, { mode: 'plan', effort: 'high' })
  ev(A, { t: 'settings', mode: 'acceptEdits' })
  assert.deepEqual(from(), { model: 'hello', effort: 'hello', mode: 'settings' })
  hello(A, { cwd: '/s2', model: 'm2', mode: 'default', effort: 'low' })
  assert.deepEqual([view().settings[A.host], from(), line()], [{ model: 'm2', effort: 'high', mode: 'acceptEdits' }, { model: 'hello', effort: 'hello', mode: 'settings' }, [true, true, ['cwd', 'model']]], 'its model taken; the settings event\'s mode and the first hello\'s effort stay')
  // 60 s on with no poll, its hello makes it current again and gives its mode and effort, neither from a
  // PermissionRequest; said again just after, it gives only its model.
  clock.advance(60_000)
  assert.equal(deck.state().sessions[A.host].inst, null)
  hello(A, { model: 'm3', mode: 'auto', effort: 'max' })
  assert.deepEqual([view().settings[A.host], line()], [{ model: 'm3', effort: 'max', mode: 'auto' }, [true, false, ['cwd', 'model', 'mode', 'effort']]])
  hello(A, { model: 'm4', mode: 'plan', effort: 'medium' })
  assert.deepEqual([view().settings[A.host], from(), line()], [{ model: 'm4', effort: 'max', mode: 'auto' }, { model: 'hello', effort: 'hello', mode: 'hello' }, [true, true, ['cwd', 'model']]])
  // With neither from the plugin yet, as from a mod whose first hello came before it had seen them, the app's record
  // shows them, and a hello said again doesn't replace it either.
  deck.reset()
  reg([A, 'busy'])
  deck.applyRecord(A.host, { model: 'm-rec', effort: 'medium', permissionMode: 'auto' })
  hello(A)
  hello(A, { mode: 'default', effort: 'low' })
  assert.deepEqual([view().settings[A.host], from(), line()], [{ model: 'm1', effort: 'medium', mode: 'auto' }, { model: 'hello', effort: null, mode: null }, [true, true, ['cwd', 'model']]])
})

test('deck: a session no instance has said hello for asks for one: every poll gets 409 hello first at once, whatever its inst, until a hello; with a current instance nothing changes', () => {
  // PROTOCOL.md, Identity, as amended (item 5): after a deck restart, or release rule 4, the mod may have had no request
  // open to fail. Its polls answered {"cmds": []} would go through, and it would poll on unheard for good.
  const { deck, clock, log, reg, hello, ev, poll, view } = setup()
  const first = [{ status: 409, json: { error: 'hello first' } }]
  reg([A, 'busy'], [B, 'busy'])
  hello(B)
  const nB = poll(B)
  // A's mod is there, its events taken, but no instance of it has said hello to this deck.
  ev(A, { t: 'measure', context: { percent: 7, window: 10 } })
  for (const [inst, wait] of [[A.inst, 20], ['iold', 20], [null, 20], [A.inst, 0]]) {
    assert.deepEqual(poll(A, wait, inst).r.sent, first, `inst ${inst}, wait ${wait}: at once`)
  }
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].poll, view().context[A.host]], [null, null, 7], 'none made current or held; its events still count')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-hello-first').map((e) => [e.host, e.inst]), [[A.host, A.inst], [A.host, 'iold'], [A.host, null], [A.host, A.inst]])
  assert.deepEqual(nB.r.sent, [], "another session's poll is left alone")

  // The hello, about 100 ms later: the same inst is current, and its next poll is held and takes the next command.
  clock.advance(100)
  hello(A)
  const n1 = poll(A)
  assert.equal(n1.r.sent.length, 0, 'held')
  const c = deck.prompt({ host: A.host, text: 'Hi.' }).cmd
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Hi.' }] } }])
  // With a current instance, a poll from another inst is answered at once with none, never 409: it can't displace it.
  assert.deepEqual(poll(A, 20, 'iold').r.sent, [{ status: 200, json: { cmds: [] } }])
  assert.equal(log.filter((e) => e.kind === 'poll-hello-first').length, 4)

  // A registry reading that misses the session forgets it (release rule 4), and answers its open poll. With the file
  // back, the mod's next poll is its first to a deck with no hello from it: it asks for one again.
  const n2 = poll(A)
  reg([B, 'busy'])
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [] } }])
  reg([A, 'busy'], [B, 'busy'])
  assert.deepEqual(poll(A).r.sent, first)
  hello(A)
  assert.equal(poll(A).r.sent.length, 0, 'held after the hello')
})

test('deck: two live mods for one host across a deck restart: the predecessor\'s hello lands last and is made current; 60 s on with no poll of its own, it stops counting, and the live mod\'s next poll gets 409 and its hello makes it current', () => {
  // PROTOCOL.md, Identity, as amended for Phase 6 (item 1): a restarted process and its lingering predecessor both get
  // 409 hello first after the deck restarts, and both say hello. The mods can't rank themselves (no pid, and a
  // resumed session keeps its session id), so the deck makes current whichever hello lands last. Since round 4 the
  // deck still remembers both once the predecessor stops counting.
  const { deck, clock, log, reg, hello, poll, view } = setup()
  const NEW = { ...A, inst: 'inew' }
  const OLD = { ...A, inst: 'iold' }
  const first = [{ status: 409, json: { error: 'hello first' } }]
  const none = [{ status: 200, json: { cmds: [] } }]
  reg([A, 'idle'])
  // Before the restart: the restarted process's mod replaced its predecessor's.
  hello(OLD)
  hello(NEW, { mode: 'acceptEdits' })
  deck.reset()
  reg([A, 'idle'])
  assert.deepEqual([poll(NEW).r.sent, poll(OLD).r.sent], [first, first])
  hello(NEW)
  const n1 = poll(NEW)
  hello(OLD)
  assert.deepEqual([deck.state().sessions[A.host].inst, n1.r.sent], ['iold', none], 'the later hello is current, and the live mod\'s open poll is answered')
  // The predecessor never polls again; the live mod polls each second, each answered at once with none.
  for (let i = 0; i < 59; i++) {
    clock.advance(1_000)
    assert.deepEqual(poll(NEW).r.sent, none)
  }
  clock.advance(999)
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].insts], ['iold', ['inew', 'iold']], '59.999 s')
  clock.advance(1)
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].insts], [null, ['inew', 'iold']], '60 s: no instance counts, and the deck still remembers both')
  assert.deepEqual(log.filter((e) => e.kind === 'inst-quiet').map((e) => [e.host, e.inst, e.quietMs]), [[A.host, 'iold', 60_000]])
  // A press alerts; the live mod's next poll asks for a hello, and its hello makes it current, with no restart.
  assert.match(deck.prompt({ host: A.host, text: 'Hi.' }).error, /has no current instance/)
  assert.deepEqual(poll(NEW).r.sent, first)
  const restarts = log.filter((e) => e.kind === 'mod-restart').length
  hello(NEW)
  assert.deepEqual([deck.state().sessions[A.host].inst, log.filter((e) => e.kind === 'mod-restart').length], ['inew', restarts])
  const n2 = poll(NEW)
  assert.equal(n2.r.sent.length, 0, 'held')
  const c = deck.prompt({ host: A.host, text: 'Hi.' }).cmd
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Hi.' }] } }])
  // The predecessor's late poll gets none, and leaves the live mod's alone.
  assert.deepEqual(poll(OLD).r.sent, none)
  assert.deepEqual([deck.state().sessions[A.host].inst, view().cmds[c]], ['inew', 'delivered'])
})

test('deck: once the current instance stops counting, the live mod\'s hello makes it current, and the predecessor\'s later hello changes nothing: no restart, its prompt still waits, its poll stays open', () => {
  // PROTOCOL.md, Identity, as amended for Phase 6, round 4 (item 1): the flip-flop round 3's review found. Round 3 forgot
  // which instances had said hello at the 60 s, so a live predecessor's hello after one of its fetches rejected counted
  // as new: a restart over the live mod, which failed its commands and made it a stray for another minute.
  const { deck, clock, log, reg, hello, poll, view } = setup()
  const NEW = { ...A, inst: 'inew' }
  const OLD = { ...A, inst: 'iold' }
  const restarts = () => log.filter((e) => e.kind === 'mod-restart').map((e) => [e.from, e.to])
  reg([A, 'busy'])
  // As after a deck restart, the predecessor's hello lands last, and it never polls: 60 s on it stops counting.
  hello(NEW)
  hello(OLD)
  clock.advance(60_000)
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].insts, restarts()], [null, ['inew', 'iold'], [['inew', 'iold']]])
  // The live mod's next poll asks for a hello, and its hello makes it current, with no restart.
  assert.deepEqual(poll(NEW).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(NEW)
  assert.deepEqual([deck.state().sessions[A.host].inst, restarts().length], ['inew', 1])
  // A prompt goes to it and waits for the turn; its next poll is held.
  const n1 = poll(NEW)
  const c = deck.prompt({ host: A.host, text: 'Hi.' }).cmd
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Hi.' }] } }])
  deck.result({ sid: A.sid, host: A.host, inst: 'inew', id: c, state: 'waiting' })
  const n2 = poll(NEW)
  // One of the predecessor's fetches rejects, and it says hello again: answered ok, and nothing changes.
  assert.deepEqual(hello(OLD, { cwd: '/old', model: 'm-old', mode: 'plan', effort: 'max' }), { v: 1, ok: true })
  assert.deepEqual([deck.state().sessions[A.host].inst, restarts().length, view().cmds[c], n2.r.sent], ['inew', 1, 'waiting', []], 'no restart: the prompt still waits, and the live mod\'s poll stays open')
  assert.deepEqual([view().settings[A.host].model, deck.state().sessions[A.host].hello.inst], ['m1', 'inew'], 'nor is anything of it taken')
  assert.deepEqual(log.filter((e) => e.kind === 'hello').at(-1).madeCurrent, false)
  // Its polls are answered at once with none, and leave the live mod's alone, which takes the next command.
  assert.deepEqual(poll(OLD).r.sent, [{ status: 200, json: { cmds: [] } }])
  const m = deck.mode({ host: A.host, mode: 'plan' }).cmd
  assert.deepEqual(n2.r.sent, [{ status: 200, json: { cmds: [{ id: m, t: 'mode', mode: 'plan' }] } }])
  assert.deepEqual([view().cmds[c], view().cmds[m], restarts().length], ['waiting', 'delivered', 1])
})

test('deck: a lone mod quiet for 60 s is made current again by its own hello, which the deck still remembers: no restart, and its next poll takes commands; with it current, nothing else changes', () => {
  // PROTOCOL.md, Identity, as amended for Phase 6, round 4: "While a session has no current instance, any instance's
  // hello makes it current, one the deck has had a hello from before included. That isn't a restart".
  const { deck, clock, log, reg, hello, poll, view } = setup()
  const restarts = () => log.filter((e) => e.kind === 'mod-restart').length
  reg([A, 'idle'])
  hello(A)
  // Its poll runs out, and the mod polls no more for a minute: a process that hung, say.
  poll(A)
  clock.advance(20_000)
  clock.advance(60_000)
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].insts], [null, ['ia']], 'it no longer counts, and the deck remembers its hello')
  assert.equal(deck.prompt({ host: A.host, text: 'Hi.' }).error, 'local_a has no current instance: its last, ia, has had no poll open for 60 s, so it can\'t take commands until an instance of its mod says hello again')
  // Its next poll asks for a hello; its own hello makes it current again.
  assert.deepEqual(poll(A).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  assert.deepEqual(hello(A), { v: 1, ok: true })
  const line = log.filter((e) => e.kind === 'hello').at(-1)
  assert.deepEqual([deck.state().sessions[A.host].inst, line.madeCurrent, line.again, line.saidBefore, restarts()], ['ia', true, false, true, 0])
  const n = poll(A)
  assert.equal(n.r.sent.length, 0, 'its next poll is held')
  const c = deck.prompt({ host: A.host, text: 'Hi.' }).cmd
  assert.deepEqual(n.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Hi.' }] } }])
  // With it current, as before round 4: its own hello said again is no restart, a new inst's is, and then its own
  // hello changes nothing.
  hello(A)
  assert.deepEqual([log.filter((e) => e.kind === 'hello').at(-1).again, restarts(), view().cmds[c]], [true, 0, 'delivered'])
  hello({ ...A, inst: 'ia2' })
  assert.deepEqual([deck.state().sessions[A.host].inst, restarts(), view().cmds[c]], ['ia2', 1, 'failed'])
  hello(A)
  assert.deepEqual([deck.state().sessions[A.host].inst, restarts(), log.filter((e) => e.kind === 'hello').at(-1).madeCurrent], ['ia2', 1, false])
})

test('deck: while none is current, whichever instance says hello first is made current: a predecessor\'s, landing first, makes the live mod a stray until the predecessor stops counting', () => {
  // PROTOCOL.md, Identity, as amended for Phase 6, round 4: any instance's hello makes it current while none is, and
  // "From then on the others don't count". Its "Why" accepts the cost: the live mod's polls are answered at once with
  // none until the predecessor's mod has gone 60 s without one.
  const { deck, clock, log, reg, hello, poll, view } = setup()
  const NEW = { ...A, inst: 'inew' }
  const OLD = { ...A, inst: 'iold' }
  const first = [{ status: 409, json: { error: 'hello first' } }]
  const none = [{ status: 200, json: { cmds: [] } }]
  const restarts = () => log.filter((e) => e.kind === 'mod-restart').map((e) => [e.from, e.to])
  reg([A, 'busy'])
  hello(NEW)
  hello(OLD)
  clock.advance(60_000)
  assert.equal(deck.state().sessions[A.host].inst, null)
  // Both mods' fetches failed in that minute: the predecessor's hello lands first, then the live mod's.
  hello(OLD)
  hello(NEW)
  assert.deepEqual([deck.state().sessions[A.host].inst, restarts()], ['iold', [['inew', 'iold']]], 'the live mod\'s hello is no restart')
  assert.deepEqual(log.filter((e) => e.kind === 'hello').slice(-2).map((e) => [e.inst, e.madeCurrent]), [['iold', true], ['inew', false]])
  // The live mod is a stray: its polls are answered at once with none, and a command queued now waits for the
  // predecessor's poll, which never comes.
  const q = deck.prompt({ host: A.host, text: 'Queued.' }).cmd
  for (let i = 0; i < 59; i++) {
    clock.advance(1_000)
    assert.deepEqual(poll(NEW).r.sent, none)
  }
  assert.deepEqual([view().cmds[q], log.filter((e) => e.kind === 'poll-stale' && e.inst === 'inew').length], ['queued', 59])
  // A minute after its hello the predecessor, which never polled, stops counting again, and the command fails "not
  // delivered"; the live mod's next poll asks for a hello, and its hello makes it current.
  clock.advance(1_000)
  assert.deepEqual([deck.state().sessions[A.host].inst, view().cmds[q], poll(NEW).r.sent], [null, 'failed', first])
  hello(NEW)
  const n = poll(NEW)
  const c = deck.prompt({ host: A.host, text: 'Hi.' }).cmd
  assert.deepEqual([deck.state().sessions[A.host].inst, n.r.sent, restarts().length], ['inew', [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'Hi.' }] } }], 1])
  assert.equal(view().cmds[c], 'delivered')
})

test('deck: while none is current, a new inst\'s hello, as after a hot reload, makes it current with no restart, though the deck remembers another: nothing is failed or forgotten', () => {
  // PROTOCOL.md, Identity, as amended for Phase 6, round 4: "While a session has no current instance, any instance's
  // hello makes it current ... That isn't a restart: nothing is failed or forgotten." A restart is a new inst's hello
  // while another is current, and an instance the deck only remembers, which stopped polling, isn't current.
  const { deck, clock, log, reg, hello, ev, perm, poll, view } = setup()
  const NEW = { ...A, inst: 'ia2' }
  const restarts = () => log.filter((e) => e.kind === 'mod-restart').length
  reg([A, 'busy'])
  hello(A)
  // A call under way, and a request for its tool whose fp differs from the call's: the two pair as a mismatch when
  // the request ends, unless the mod restarted while it was held, when its own tool.start may never come.
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'tool.start', tool: 'Write', use: 'u1', summary: 'one.txt', fp: 'deadbeef' })
  const p = perm(A, 'Write', W1)
  // Its poll runs out, and it polls no more. A prompt queued 30 s on waits for a poll; 60 s after the poll's end the
  // instance stops counting.
  poll(A)
  clock.advance(20_000)
  clock.advance(30_000)
  const q = deck.prompt({ host: A.host, text: 'Queued.' }).cmd
  clock.advance(30_000)
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].insts, view().cmds[q]], [null, ['ia'], 'queued'])
  // The mod reloads, and its new instance says hello: made current, with no restart.
  assert.deepEqual(hello(NEW), { v: 1, ok: true })
  const said = log.filter((e) => e.kind === 'hello').at(-1)
  assert.deepEqual([deck.state().sessions[A.host].inst, said.madeCurrent, said.saidBefore, restarts()], ['ia2', true, false, 0])
  // Nothing forgotten: the current tool, the held request, and which instances said hello, the new one newest.
  assert.deepEqual([view().doing[A.host], view().held.map((h) => h.id), p.r.sent, deck.state().sessions[A.host].insts], ['one.txt', [p.id], [], ['ia', 'ia2']])
  // Nothing failed: the new instance's first poll takes the queued prompt.
  assert.deepEqual(poll(NEW).r.sent, [{ status: 200, json: { cmds: [{ id: q, t: 'prompt', text: 'Queued.' }] } }])
  assert.equal(view().cmds[q], 'delivered')
  // The request, answered, pairs with the one call of its tool, a mismatch: no restart came while it was held.
  deck.press('approve')
  const check = log.find((e) => e.kind === 'fp-check' && e.request === p.id)
  assert.deepEqual([p.r.sent, check.match, check.modFp, check.doubt], [[{ status: 200, json: ALLOW }], false, 'deadbeef', undefined])
  // From then on the instance that stopped doesn't count: its hello, after one of its fetches rejects say, changes
  // nothing, and leaves the new instance's poll open.
  const n = poll(NEW)
  hello(A, { model: 'm-old' })
  assert.deepEqual([deck.state().sessions[A.host].inst, restarts(), n.r.sent, view().settings[A.host].model], ['ia2', 0, [], 'm1'])
})

test('deck: a current instance stops counting only after 60 s with no poll open and none sent: a held poll, or one answered at once, keeps it; another inst\'s polls don\'t', () => {
  // PROTOCOL.md, Identity, as Commands counts it for a waiting prompt: "A live mod always keeps one open; a poll
  // answered at once counts, but one from an inst that doesn't count doesn't."
  const { deck, clock, log, reg, hello, ev, poll } = setup()
  const current = () => deck.state().sessions[A.host]?.inst ?? null
  reg([A, 'idle'])
  // A hello alone, with no poll after it: 60 s from the hello.
  hello(A)
  clock.advance(59_999)
  assert.equal(current(), 'ia')
  clock.advance(1)
  assert.equal(current(), null)
  // Its hello said again, as after a rejected fetch, isn't a poll: the 60 s still run from the hello that made it current.
  hello(A)
  clock.advance(30_000)
  hello(A)
  assert.deepEqual([current(), log.filter((e) => e.kind === 'hello').at(-1).again], ['ia', true])
  clock.advance(29_999)
  assert.equal(current(), 'ia')
  clock.advance(1)
  assert.equal(current(), null, 'not 60 s from the hello said again')
  assert.deepEqual(log.filter((e) => e.kind === 'inst-quiet').map((e) => e.quietMs), [60_000, 60_000])
  // Ten minutes of 20 s polls held to their end, the mod polling again at once each time: never.
  hello(A)
  for (let i = 0; i < 30; i++) {
    poll(A)
    clock.advance(20_000)
  }
  assert.equal(current(), 'ia', 'held polls')
  // A poll left open as long as it lasts, with none after it: 60 s from its end. (The fake timers fire with the clock at
  // the end of an advance, so the poll's end is a step of its own.)
  poll(A, 20)
  clock.advance(20_000)
  clock.advance(59_999)
  assert.equal(current(), 'ia')
  clock.advance(1)
  assert.equal(current(), null)
  // Polls answered at once, after a turn end while the registry says busy, or with wait 0: each counts as sent.
  hello(A)
  reg([A, 'busy'])
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  for (let i = 0; i < 50; i++) {
    clock.advance(1_000)
    assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }])
  }
  for (let i = 0; i < 3; i++) {
    clock.advance(50_000)
    assert.deepEqual(poll(A, 0).r.sent, [{ status: 200, json: { cmds: [] } }])
  }
  assert.equal(current(), 'ia', 'answered at once')
  // Another inst's polls, answered at once as a replaced instance's, don't keep the current one counting.
  hello({ ...A, inst: 'ia2' })
  for (let i = 0; i < 59; i++) {
    clock.advance(1_000)
    poll(A)
  }
  clock.advance(1_000)
  assert.equal(current(), null, 'ia\'s polls kept ia2 current not at all')
})

test('deck: a current instance that stops counting leaves the rest as it was, and so does its hello that makes it current again: settings, held requests, commands, the current tool and seqs; a waiting prompt fails with it', () => {
  // PROTOCOL.md, Identity: "it's no longer current. The deck keeps the rest: settings, held requests, commands, the
  // current tool, and which instances have said hello."
  const { deck, clock, log, reg, hello, ev, perm, poll, view } = setup()
  reg([A, 'busy'])
  hello(A, { model: 'm1', mode: 'plan', effort: 'high' })
  ev(A, { t: 'measure', context: { percent: 42, window: 10 } }, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'a.md', fp: 'f1' })
  const p = perm(A, 'Write', W1, { extra: { permission_mode: 'plan', effort: { level: 'high' } } })
  const waiting = deck.prompt({ host: A.host, text: 'one' }).cmd
  poll(A)
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: waiting, state: 'waiting' })
  const mode = deck.mode({ host: A.host, mode: 'acceptEdits' }).cmd
  poll(A)
  clock.advance(30_000)
  const queued = deck.prompt({ host: A.host, text: 'two' }).cmd
  clock.advance(30_000)
  assert.equal(deck.state().sessions[A.host].inst, null)
  assert.deepEqual([view().cmds[waiting], deck.state().commands.find((x) => x.id === waiting).error], ['failed', 'no result'], 'the waiting prompt fails at the same 60 s')
  assert.deepEqual([view().cmds[mode], view().cmds[queued]], ['failed', 'queued'], 'the delivered one on its own 60 s, from delivery; the queued one waits')
  assert.deepEqual([view().held.map((h) => h.id), view().status[A.host], p.r.sent], [[p.id], 'approval', []], 'still held')
  assert.deepEqual([view().settings[A.host], view().context[A.host], view().doing[A.host]], [{ model: 'm1', effort: 'high', mode: 'plan' }, 42, 'a.md'])
  assert.deepEqual([deck.state().sessions[A.host].insts, deck.state().sessions[A.host].settingsFrom], [['ia'], { model: 'hello', effort: 'permission', mode: 'permission' }], 'and which instances said hello, and where each setting came from')
  // The seqs it has seen stay: a request sent again under seq 1, as a retry, is still dropped.
  deck.events({ sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [{ t: 'measure', at: clock.now(), context: { percent: 99, window: 10 } }] })
  assert.equal(view().context[A.host], 42, 'seq 1 again: dropped')
  assert.deepEqual(log.filter((e) => e.kind === 'events' && e.dropped).map((e) => [e.host, e.seq]), [[A.host, 1]])
  // And the same inst's next events go on from its seq.
  ev(A, { t: 'measure', context: { percent: 43, window: 10 } })
  assert.equal(view().context[A.host], 43)
  // Its hello makes it current again, with no restart: the rest stays as it was, the current tool and the held request
  // included (Identity: "nothing is failed or forgotten"), and its next poll takes what's queued.
  hello(A)
  assert.deepEqual([deck.state().sessions[A.host].inst, log.filter((e) => e.kind === 'hello').at(-1).saidBefore, log.filter((e) => e.kind === 'mod-restart').length], ['ia', true, 0])
  assert.deepEqual([view().doing[A.host], view().held.map((h) => h.id), p.r.sent, view().settings[A.host]], ['a.md', [p.id], [], { model: 'm1', effort: 'high', mode: 'plan' }])
  assert.deepEqual(poll(A).r.sent[0].json.cmds.map((c) => c.id), [queued])
})

test('deck: a current instance that stops counting leaves the main loop\'s turn as it was: how it ended, and the polls answered at once after its end', () => {
  // PROTOCOL.md, Identity: "keeps the rest". The two-processes case: the predecessor's hello landed last and it never
  // polls, while the live mod's turn ends; its events count whichever inst is current. Forgetting the turn too would
  // read the session idle, and hold the live mod's next poll, which keeps the session busy (Commands).
  const ends = [
    [{ t: 'turn.end', turn: 't1', reason: 'answer' }, 'done'],
    [{ t: 'turn.end', turn: 't1', reason: 'aborted' }, 'interrupted'],
    [{ t: 'failed', error: 'API error' }, 'failed'],
  ]
  for (const [end, status] of ends) {
    const { deck, clock, reg, hello, ev, poll, view } = setup()
    const NEW = { ...A, inst: 'inew' }
    reg([A, 'busy'])
    hello(NEW)
    hello({ ...A, inst: 'iold' })
    clock.advance(30_000)
    ev(NEW, { t: 'turn.start', turn: 't1' }, end)
    const before = { ...deck.state().sessions[A.host].turn }
    clock.advance(30_000)
    assert.equal(deck.state().sessions[A.host].inst, null, `${status}: iold forgotten 60 s after its hello`)
    assert.deepEqual(deck.state().sessions[A.host].turn, before, `${status}: the turn as it was`)
    // The live mod's next poll asks for a hello, and its hello makes it current. 30 s after the turn's end, with the
    // registry still busy, its poll is answered at once, as it would have been before.
    assert.deepEqual(poll(NEW).r.sent, [{ status: 409, json: { error: 'hello first' } }])
    hello(NEW)
    assert.deepEqual(poll(NEW).r.sent, [{ status: 200, json: { cmds: [] } }], `${status}: answered at once`)
    reg([A, 'idle'])
    assert.equal(view().status[A.host], status)
  }
})

test('deck: Approve and Deny still answer a held request for a session whose current instance stopped counting: only a prompt or mode press alerts', () => {
  // PROTOCOL.md, Held requests: Approve and Deny act on the oldest held request across all sessions; Commands: "A prompt
  // or mode press also alerts when the target ... has no instance that has said hello to this deck." The real deck's
  // Approve and Deny don't look at the session's instance either (claude-code/deck/src/keys/decision.ts). In the
  // two-processes case the user would otherwise have to answer in the app's dialog for up to a minute.
  const { deck, clock, reg, hello, perm, view } = setup()
  reg([A, 'busy'])
  hello({ ...A, inst: 'inew' })
  hello({ ...A, inst: 'iold' })
  const p1 = perm(A, 'Write', W1)
  const p2 = perm(A, 'Bash', { command: 'ls' })
  const q = perm(A, 'AskUserQuestion', ASK)
  clock.advance(60_000)
  assert.deepEqual([deck.state().sessions[A.host].inst, view().status[A.host]], [null, 'approval'])
  for (const r of [deck.prompt({ host: A.host, text: 'Hi.' }), deck.mode({ host: A.host, mode: 'plan' })]) assert.match(r.error, /has no current instance/)
  const approve = deck.press('approve', { shown: p1.id })
  assert.deepEqual([approve.ok, approve.alert, approve.answered, p1.r.sent], [true, false, 'allow', [{ status: 200, json: ALLOW }]])
  const deny = deck.press('deny', { shown: p2.id })
  assert.deepEqual([deny.ok, deny.alert, deny.answered, p2.r.sent], [true, false, 'deny', [{ status: 200, json: DENY }]])
  // A question still opens its session, and is left for the app.
  const jump = deck.press('approve', { shown: q.id })
  assert.deepEqual([jump.ok, jump.alert, jump.jumped, q.r.sent, view().held.map((h) => h.id)], [true, false, A.host, [], [q.id]])
})

test('deck: a prompt or mode press for a session with no current instance alerts, as the real deck does, and queues nothing', () => {
  // PROTOCOL.md, "Commands": "A prompt or mode press also alerts when the target has ended, has no plugin, or has no
  // instance that has said hello to this deck." A command queued then would fail "not delivered" a minute later.
  const { deck, clock, reg, hello, ev, poll, view } = setup()
  reg([A, 'idle'])
  ev(A, { t: 'measure', context: { percent: 7, window: 10 } })
  assert.equal(deck.state().sessions[A.host].plugin, true, 'its mod is there')
  const why = /^local_a has no current instance: no instance of its mod has said hello to this deck, so it can't take commands until one does$/
  for (const r of [deck.prompt({ host: A.host, text: 'Hi.' }), deck.mode({ host: A.host, mode: 'plan' })]) {
    assert.deepEqual([r.ok, r.alert, r.cmd], [false, true, undefined])
    assert.match(r.error, why)
  }
  assert.deepEqual([view().cmds, view().alert], [{}, true], 'nothing queued')
  // Its poll asks for a hello; once one comes, the presses go through.
  assert.deepEqual(poll(A).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(A)
  const n = poll(A)
  const r = deck.prompt({ host: A.host, text: 'Hi.' })
  assert.deepEqual([r.ok, n.r.sent[0]?.json.cmds.map((c) => c.id)], [true, [r.cmd]])
  // A reset forgets the instance: the presses alert again until its next hello.
  deck.reset()
  reg([A, 'idle'])
  ev({ ...A, inst: 'ia-reset' }, { t: 'measure', context: { percent: 8, window: 10 } })
  assert.match(deck.mode({ host: A.host, mode: 'plan' }).error, why)
  clock.advance(60_000)
  assert.deepEqual(view().cmds, {}, 'and nothing failed "not delivered" later, as nothing was queued')
})

test('deck: two registry files that list one host: either file\'s sessionId confirms a hook\'s request and takes a hello, and the deck shows the file that started later', () => {
  // A restarted process whose old file lingers beside its new one. The real deck counts every file for confirmation,
  // and shows the one with the later startedAt.
  const { deck, log, reg, hello, perm, pre, view } = setup()
  const file = (pid, sessionId, status, startedAt, extra = {}) => ({ pid, sessionId, hostSessionId: A.host, name: `${A.host} ${pid}`, status, statusUpdatedAt: 1, startedAt, ...extra })
  const OLD = file(7, 'sid-old', 'idle', 100)
  const NEW = file(3, 'sid-new', 'busy', 200)
  for (const order of [[OLD, NEW], [NEW, OLD]]) {
    deck.applyRegistry(order)
    assert.deepEqual([view().sessions, view().status[A.host], deck.state().registry[A.host].pid], [[A.host], 'working', 3], `${order.map((f) => f.pid)}: the later start shows`)
  }
  // Each file's sessionId confirms a request with A's host; a third doesn't.
  const none = [{ status: 200, json: {} }]
  for (const sid of ['sid-old', 'sid-new']) {
    assert.equal(perm({ ...A, sid }, 'Write', W1).kind, 'tool', `${sid}: held`)
    assert.equal(pre({ ...A, sid }, 'default').kind, 'none', `${sid}: a mode check taken, with no command in flight`)
  }
  const child = perm({ ...A, sid: 'sid-child' }, 'Write', W1)
  assert.deepEqual([child.kind, child.r.sent], ['unconfirmed', none])
  assert.equal(log.filter((e) => e.kind === 'unconfirmed').at(-1).why, 'the registry lists local_a under another sessionId')
  assert.equal(deck.hookNeedsReading(A.host, { session_id: 'sid-old' }), false, 'no second reading for either file\'s')
  // A hello is refused only when no file lists the host with its sid.
  assert.deepEqual(hello({ ...A, sid: 'sid-old' }), { v: 1, ok: true })
  assert.deepEqual(hello({ ...A, sid: 'sid-new', inst: 'ia2' }), { v: 1, ok: true })
  assert.throws(() => hello({ ...A, sid: 'sid-child', inst: 'ichild' }), NotThisSession)
  assert.deepEqual(log.filter((e) => e.kind === 'hello' && e.status === 409).map((e) => e.listedSids.toSorted()), [['sid-new', 'sid-old']])
  assert.equal(deck.helloNeedsReading({ v: 1, sid: 'sid-old', host: A.host }), false)

  // Ties: the same startedAt, or none on both, goes to the lower pid; a file without one loses to a file with one.
  // Every file reads busy, as the shown one did, so no release rule runs.
  deck.applyRegistry([file(9, 'sid-9', 'busy', 300), file(4, 'sid-4', 'busy', 300)])
  assert.equal(deck.state().registry[A.host].pid, 4, 'the same start: the lower pid')
  deck.applyRegistry([file(9, 'sid-9', 'busy', undefined), file(4, 'sid-4', 'busy', undefined)])
  assert.equal(deck.state().registry[A.host].pid, 4, 'no start on either: the lower pid')
  deck.applyRegistry([file(2, 'sid-2', 'busy', undefined), file(8, 'sid-8', 'busy', 50)])
  assert.equal(deck.state().registry[A.host].pid, 8, 'a start beats none')
  // The session ends only when no file lists it: its held requests go with the last.
  assert.equal(view().held.length, 2)
  deck.applyRegistry([file(8, 'sid-8', 'busy', 50)])
  assert.equal(view().held.length, 2, 'one file left: still listed')
  reg()
  assert.deepEqual([view().held, view().sessions], [[], []])
})

test('deck: a mod\'s request with no host is placed only by the sessionId of a file the deck shows, as the real deck\'s #hostForSid: a lingering old file\'s places nothing', () => {
  const { deck, reg, view } = setup()
  const file = (pid, sessionId, startedAt) => ({ pid, sessionId, hostSessionId: A.host, name: A.host, status: 'busy', statusUpdatedAt: 1, startedAt })
  const measure = (sid, seq, percent) => deck.events({ sid, host: '', inst: 'ia', seq, events: [{ t: 'measure', context: { percent, window: 10 }, at: 1 }] })
  deck.applyRegistry([file(7, 'sid-old', 100), file(3, 'sid-new', 200)])
  assert.equal(deck.state().registry[A.host].sessionId, 'sid-new', 'the later start shows')
  measure('sid-new', 1, 5)
  assert.equal(view().context[A.host], 5)
  assert.throws(() => measure('sid-old', 2, 6), BadRequest, "the lingering file's sessionId places nothing")
  assert.equal(view().context[A.host], 5)
  // Shown, it places them; a file of another host that shows lists its own.
  deck.applyRegistry([file(7, 'sid-old', 300), file(3, 'sid-new', 200), { ...file(8, 'sid-b', 1), hostSessionId: B.host }])
  measure('sid-old', 3, 7)
  measure('sid-b', 4, 8)
  assert.deepEqual([view().context[A.host], view().context[B.host]], [7, 8])
})

test('deck: a reset forgets the registry\'s reading, its session ids included: until it reads the registry again, no hook\'s request is confirmed, and no hello refused', () => {
  // A reset is the deck restarting; bridge.mjs reads the folders again at once, but the deck itself keeps nothing.
  const { deck, reg, hello, perm, pre } = setup()
  reg([A, 'busy'])
  assert.equal(perm(A, 'Write', W1).kind, 'tool')
  deck.reset()
  assert.deepEqual([perm(A, 'Write', W1).kind, pre(A, 'plan').kind], ['unconfirmed', 'unconfirmed'])
  assert.equal(deck.hookNeedsReading(A.host, { session_id: A.sid }), true, 'one more reading could confirm it')
  assert.deepEqual(hello({ ...A, sid: 'sid-other' }), { v: 1, ok: true }, 'a host it no longer lists refuses no hello')
  assert.equal(deck.helloNeedsReading({ v: 1, sid: 'sid-third', host: A.host }), false)
  reg([A, 'busy'])
  assert.equal(perm(A, 'Write', W1).kind, 'tool')
  assert.throws(() => hello({ ...A, sid: 'sid-third', inst: 'i3' }), NotThisSession)
})

test('deck: a hook\'s request from a session the registry doesn\'t confirm leaves the mode command in flight its allowances, both kinds', () => {
  // A `claude` started inside A has A's host and its own session id. Its mode check, and the PermissionRequest its
  // mode tool raises, get no decision; A's own, for A's command, are each still allowed once.
  const { deck, log, reg, hello, perm, pre, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  const CHILD = { ...A, sid: 'sid-child' }
  const SPARE = { ...A, sid: 'sid-spare', host: 'local_spare' }
  const mode = { session_id: 'self', mode: 'plan' }
  const none = [{ status: 200, json: {} }]
  const deliver = () => {
    const c = deck.mode({ host: A.host, mode: 'plan' }).cmd
    poll(A)
    assert.equal(deck.view().cmds[c], 'delivered')
    return c
  }
  // Each kind on its own, then both, from the child and from a host the registry doesn't list.
  const cases = [
    [CHILD, ['check']],
    [CHILD, ['raise']],
    [CHILD, ['check', 'raise']],
    [CHILD, ['raise', 'check']],
    [SPARE, ['check', 'raise']],
  ]
  for (const [S, kinds] of cases) {
    const c = deliver()
    for (const kind of kinds) {
      const r = kind === 'check' ? pre(S, 'plan') : perm(S, MODE_TOOL, mode)
      assert.deepEqual([r.kind, r.r.sent], ['unconfirmed', none], `${S.sid}'s ${kind}`)
    }
    const check = pre(A, 'plan')
    const raise = perm(A, MODE_TOOL, mode)
    assert.deepEqual([check.kind, check.cmd, check.r.sent], ['allow', c, [{ status: 200, json: PRE_ALLOW }]], `${kinds.join(', ')} from ${S.sid}: A's check`)
    assert.deepEqual([raise.kind, raise.cmd, raise.r.sent], ['mode', c, [{ status: 200, json: ALLOW }]], `${kinds.join(', ')} from ${S.sid}: A's raise`)
    deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c, state: 'done', detail: '' })
  }
  assert.equal(log.filter((e) => e.kind === 'unconfirmed').length, 8)
  assert.deepEqual(deck.view().held, [], 'and nothing held')
})

test('deck: a result is taken only from the inst its command was delivered to', () => {
  // PROTOCOL.md, "Commands": one from another inst is ignored, as the deck ignores it.
  const { deck, log, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A)
  hello({ ...A, inst: 'ia2' })
  const c = deck.prompt({ host: A.host, text: 'x' }).cmd
  poll({ ...A, inst: 'ia2' })
  const result = (inst, state) => deck.result({ sid: A.sid, host: A.host, ...(inst === undefined ? {} : { inst }), id: c, state })
  // From the instance it replaced, from one that never said hello, and with no inst at all.
  for (const inst of ['ia', 'izz', undefined]) result(inst, 'waiting')
  assert.equal(view().cmds[c], 'delivered')
  assert.deepEqual(log.filter((e) => e.kind === 'result-ignored').map((e) => e.why), [
    'it came from inst "ia", and was delivered to ia2', 'it came from inst "izz", and was delivered to ia2', 'it came from inst (none), and was delivered to ia2',
  ])
  result('ia2', 'waiting')
  result('ia', 'done')
  assert.equal(view().cmds[c], 'waiting')
  result('ia2', 'done')
  assert.equal(view().cmds[c], 'done')
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
  // The same 60 s has the current instance stop counting (PROTOCOL.md, Identity): the mod's next poll asks for a
  // hello, which makes it current again.
  assert.equal(deck.state().sessions[A.host].inst, null)
  assert.deepEqual(poll(A).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(A)

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

test('deck: a poll answered at once, with wait 0 or with commands queued, starts a waiting prompt\'s 60 s without a poll again', () => {
  // README, "Where PROTOCOL.md leaves room": it shows the mod is there.
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'idle'])
  hello(A)
  const c1 = deck.prompt({ host: A.host, text: 'one' }).cmd
  poll(A)
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c1, state: 'waiting' })
  clock.advance(50_000)
  assert.deepEqual(poll(A, 0).r.sent, [{ status: 200, json: { cmds: [] } }], 'wait 0')
  clock.advance(50_000)
  const c2 = deck.mode({ host: A.host, mode: 'plan' }).cmd
  assert.deepEqual(poll(A).r.sent[0].json.cmds.map((c) => c.id), [c2], 'one that takes a command')
  clock.advance(59_999)
  assert.equal(view().cmds[c1], 'waiting', '159.999 s since it went waiting, 59.999 s since the last poll\'s answer')
  clock.advance(1)
  assert.deepEqual([view().cmds[c1], deck.state().commands.find((c) => c.id === c1).error], ['failed', 'no result'])
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

  // A later request from the session's mod starts afresh: its seqs are forgotten with its insts, so the same inst's
  // seq 1 is taken, not dropped as a retry.
  reg([A, 'busy'])
  deck.events({ sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [{ t: 'measure', context: { percent: 60, window: 10 }, at: 1 }] })
  assert.equal(view().context[A.host], 60)
  assert.deepEqual([deck.state().sessions[A.host].inst, deck.state().sessions[A.host].insts], [null, []], 'and no inst current until its next hello')
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
  // Those 60 s without a poll have the current instance stop counting too: the mod's next poll asks for a hello.
  assert.deepEqual(poll(A).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(A)

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

test('deck: the 60 s of polls answered at once after a turn end run on the monotonic clock: the wall clock jumping either way moves them not at all', () => {
  // As the deck times them. A time sync after wake moves the wall clock, and so does a fixture runner's clock that
  // follows the registry's times (PROTOCOL.md, "Fixtures").
  const { clock, log, reg, hello, ev, poll } = setup()
  reg([A, 'busy'])
  hello(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  clock.jumpWall(120_000)
  clock.advance(1_000)
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }], 'at once: the wall clock says 121 s, the monotonic 1 s')
  clock.jumpWall(-600_000)
  clock.advance(58_999)
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }], 'at once: 59.999 s, though the wall clock went back')
  clock.advance(1)
  const held = poll(A)
  assert.equal(held.r.sent.length, 0, 'held from 60 s on')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-at-once').map((e) => e.sinceTurnEndMs), [1_000, 59_999])
})

test('deck: a session\'s time without an open poll runs on the monotonic clock too: a wall clock that jumps fails no waiting prompt early', () => {
  const { deck, clock, reg, hello, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  const result = (id) => deck.result({ sid: A.sid, host: A.host, inst: A.inst, id, state: 'waiting' })
  const c1 = deck.prompt({ host: A.host, text: 'one' }).cmd
  const c2 = deck.prompt({ host: A.host, text: 'two' }).cmd
  poll(A)
  result(c1)
  // The wall clock jumps 2 minutes on before the second prompt's waiting comes, which looks at the time without a poll again.
  clock.jumpWall(120_000)
  clock.advance(1_000)
  result(c2)
  assert.deepEqual([view().cmds[c1], view().cmds[c2]], ['waiting', 'waiting'])
  clock.advance(58_999)
  assert.deepEqual([view().cmds[c1], view().cmds[c2]], ['waiting', 'waiting'], '59.999 s without a poll')
  clock.advance(1)
  assert.deepEqual([view().cmds[c1], view().cmds[c2]], ['failed', 'failed'], '60 s')
})

test('deck: a poll answered at once after the main loop\'s turn end counts as the mod polling, for a waiting prompt\'s clock', () => {
  // README, "Where PROTOCOL.md leaves room": such a poll counts as answered like any poll answered at once.
  const { deck, clock, reg, hello, ev, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  const c = deck.prompt({ host: A.host, text: 'Next.' }).cmd
  poll(A)
  deck.result({ sid: A.sid, host: A.host, inst: A.inst, id: c, state: 'waiting' })
  const n1 = poll(A)
  ev(A, { t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  assert.deepEqual(n1.r.sent, [{ status: 200, json: { cmds: [] } }], 'the open poll, at the turn end')
  // 50 s on, the mod's next poll, answered at once as the registry still says busy; then nothing.
  clock.advance(50_000)
  assert.deepEqual(poll(A).r.sent, [{ status: 200, json: { cmds: [] } }])
  clock.advance(59_999)
  assert.equal(view().cmds[c], 'waiting', '60 s run from that poll\'s answer, not from the turn end')
  clock.advance(1)
  assert.deepEqual([view().cmds[c], deck.state().commands.find((x) => x.id === c).error], ['failed', 'no result'])
})

test('deck: the polls after the main loop\'s turn end are answered at once for less than 60 s after it, by the bridge\'s monotonic clock', () => {
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
  // The mod's polls each second while the registry says busy are left out: its instance's 60 s are set long here.
  const { clock, log, reg, hello, ev, poll } = setup({ inFlightMs: 600_000 })
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
  // The mod's long poll, held 20 s, keeps its instance current through the minute.
  poll(A)
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
  // A mod that hasn't polled since its hello, 60 s ago, no longer counts either (PROTOCOL.md, Identity): its next poll
  // asks for a hello, and the hello makes it current again.
  assert.equal(deck.state().sessions[A.host].inst, null)
  assert.deepEqual(poll(A).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(A)

  // One a poll takes in time has a delivered command's 60 s from then on instead.
  const c2 = deck.mode({ host: A.host, mode: 'plan' }).cmd
  clock.advance(40_000)
  poll(A)
  assert.equal(clock.pending, 2, 'its queued clock stopped: only the delivered one runs, with the session\'s time without a poll')
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

  // A prompt that no poll takes ends with "not delivered", so the key can't stay locked. B's mod, which hasn't polled
  // all that time, says hello again once its next poll asks for one: the session has no current instance until then.
  clock.advance(60_000)
  assert.equal(view().cmds[r.cmd], 'failed')
  assert.match(press('Run the tests.', B.host).error, /has no current instance/)
  hello(B)
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
  // Rule 3's turn.start: the main loop's turn runs on, the registry's idle read before it began.
  assert.equal(status(), 'working', 'a subagent\'s turn end is not the main loop\'s')
  ev(A, { t: 'turn.end', turn: 't4', reason: 'answer' })
  assert.equal(status(), 'done')
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

test('deck: status rule 3, by what the bridge saw: working from the main loop\'s turn.start while the registry\'s idle was read before it, until the turn ends or an idle read since', () => {
  // PROTOCOL.md, status rule 3, as amended for Phase 6 (item 3): the plugin's turn.start arrives within milliseconds,
  // while the deck reads the registry once a second and Claude Code writes busy a moment into the turn.
  const { reg, hello, ev, view } = setup()
  const status = () => view().status[A.host]
  reg([A, 'idle', 1000])
  hello(A)
  assert.equal(status(), 'idle')
  ev(A, { t: 'turn.start', turn: 't1' })
  assert.deepEqual([status(), view().doing[A.host]], ['working', null], 'before the registry says busy')
  ev(A, { t: 'tool.start', tool: 'Read', use: 'u1', summary: 'notes.md', fp: 'f1' })
  assert.equal(view().doing[A.host], 'notes.md')
  reg([A, 'idle', 1000, { name: 'Renamed' }])
  assert.equal(status(), 'working', 'the same idle, read again: its status and statusUpdatedAt are as they were')
  reg([A, 'busy', 2000])
  assert.equal(status(), 'working')
  ev(A, { t: 'turn.end', turn: 't1', reason: 'answer' })
  reg([A, 'idle', 3000])
  assert.equal(status(), 'done', 'an idle read since the turn.start, and the turn ended')

  // A turn that ended unseen: an idle read after its turn.start, a new statusUpdatedAt, doesn't count, and the rules
  // after it take the session as idle: not done, since the deck didn't see the turn end.
  ev(A, { t: 'turn.start', turn: 't2' })
  assert.equal(status(), 'working')
  reg([A, 'idle', 4000])
  assert.equal(status(), 'idle', 'a new idle since the turn.start')
  // Without statusUpdatedAt, the idle's first reading says when it began.
  reg([A, 'busy', null])
  reg([A, 'idle', null])
  ev(A, { t: 'turn.start', turn: 't3' })
  assert.equal(status(), 'working', 'idle first read before the turn.start')
  reg([A, 'idle', null])
  assert.equal(status(), 'working', 'the same idle, read again')
  reg([A, 'busy', null])
  reg([A, 'idle', null])
  assert.equal(status(), 'idle', 'an idle first read after it')

  // Only the main loop's turn.start, and only until its turn ends, a failed included.
  ev(A, { t: 'turn.start', turn: 's1', agent: 'ag1' })
  assert.equal(status(), 'idle', 'a subagent\'s')
  ev(A, { t: 'turn.start', turn: 't4' }, { t: 'failed', error: 'API error' })
  assert.equal(status(), 'failed', 'a failed ends the turn')
  ev(A, { t: 'turn.start', turn: 't5' }, { t: 'turn.end', turn: 't5', reason: 'aborted' })
  assert.equal(status(), 'interrupted')
  // A session the registry doesn't list, or lists waiting, isn't working by it.
  hello(B)
  ev(B, { t: 'turn.start', turn: 't1' })
  assert.equal(view().status[B.host], 'idle', 'not listed')
  reg([A, 'waiting', 5000], [B, 'idle', 5000])
  ev(A, { t: 'turn.start', turn: 't6' })
  assert.equal(status(), 'needs-you', 'waiting')
  assert.equal(view().status[B.host], 'idle', 'B\'s idle was first read after its turn.start')
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

/** The last hello line's madeCurrent, again, took and kept. */
const lastHello = (log) => {
  const e = log.filter((x) => x.kind === 'hello').at(-1)
  return [e.madeCurrent, e.again, e.took, e.kept]
}

test('deck: after the 60 s, the hello that makes an instance current again takes its cwd and model, and keeps the mode and effort the deck took from a PermissionRequest', () => {
  // PROTOCOL.md, "The deck's session model", as amended for Phase 6, round 4 (item 2). A hello's mode and effort are
  // what its mod has already sent or queued as settings; a PermissionRequest's are the engine's own at that moment.
  // The Mode dial's press without a turn applies the mode it shows, so an older one put back could be applied.
  const { deck, clock, log, reg, hello, perm, poll, view } = setup()
  const NEW = { ...A, inst: 'inew' }
  reg([A, 'busy'])
  // The two-processes case: the live mod reported Manual; after a deck restart the predecessor's hello lands last.
  hello(NEW, { mode: 'default', effort: 'low' })
  hello({ ...A, inst: 'iold' })
  // The user changes the mode in the app; a PermissionRequest brings the engine's new mode and effort first.
  perm(A, 'Write', W1, { extra: { permission_mode: 'acceptEdits', effort: { level: 'high' } } })
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'high', mode: 'acceptEdits' })
  // 60 s on, the predecessor stops counting; the live mod's hello, with the mode and effort it last sent, makes it current.
  clock.advance(60_000)
  assert.deepEqual(poll(NEW).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(NEW, { cwd: '/s2', model: 'm2', mode: 'default', effort: 'low' })
  assert.equal(deck.state().sessions[A.host].inst, 'inew')
  assert.deepEqual(view().settings[A.host], { model: 'm2', effort: 'high', mode: 'acceptEdits' }, 'its model taken, the PermissionRequest\'s mode and effort kept')
  assert.deepEqual(lastHello(log), [true, false, ['cwd', 'model'], ['mode', 'effort']])
  assert.deepEqual([deck.state().sessions[A.host].hello.cwd, deck.state().sessions[A.host].settingsFrom], ['/s2', { model: 'hello', effort: 'permission', mode: 'permission' }])
  assert.match(log.filter((e) => e.kind === 'hello').at(-1).say, /its mode and effort not taken: the deck took them from a PermissionRequest/)
})

test('deck: after a deck restart, a PermissionRequest that comes before the mod\'s first hello keeps its mode and effort over that hello\'s', () => {
  // PROTOCOL.md, "The deck's session model", round 4: "after a deck restart, a PermissionRequest can come before the
  // mod's first hello". A reset is the fake's deck restart.
  const { deck, log, reg, hello, perm, view } = setup()
  reg([A, 'busy'])
  hello(A, { mode: 'default', effort: 'low' })
  deck.reset()
  reg([A, 'busy'])
  const p = perm(A, 'Write', W1, { extra: { permission_mode: 'acceptEdits', effort: { level: 'high' } } })
  assert.deepEqual([p.kind, deck.state().sessions[A.host].inst], ['tool', null], 'held, before any hello')
  // The mod's hello: its quick hello after the reset cut its poll off, or after a 409.
  hello(A, { mode: 'default', effort: 'low' })
  assert.deepEqual([deck.state().sessions[A.host].inst, view().settings[A.host]], ['ia', { model: 'm1', effort: 'high', mode: 'acceptEdits' }])
  assert.deepEqual(lastHello(log), [true, false, ['cwd', 'model'], ['mode', 'effort']])
  // With no PermissionRequest since the reset, the first hello takes all four, as before.
  deck.reset()
  reg([A, 'busy'])
  hello(A, { model: 'm2', mode: 'plan', effort: 'medium' })
  assert.deepEqual([view().settings[A.host], lastHello(log)], [{ model: 'm2', effort: 'medium', mode: 'plan' }, [true, false, ['cwd', 'model', 'mode', 'effort'], []]])
})

test('deck: each setting goes by where the deck took it from: a hello still gives the effort when only the mode came from a PermissionRequest, and the mode when only the effort did', () => {
  // PROTOCOL.md, "The deck's session model", round 4: "Each field goes by where the deck took it from".
  const { deck, log, reg, hello, perm, view } = setup()
  // A PermissionRequest with no effort.level: only its mode is taken.
  reg([A, 'busy'])
  perm(A, 'Write', W1, { extra: { permission_mode: 'plan', effort: undefined } })
  hello(A, { mode: 'default', effort: 'medium' })
  assert.deepEqual([view().settings[A.host], lastHello(log)], [{ model: 'm1', effort: 'medium', mode: 'plan' }, [true, false, ['cwd', 'model', 'effort'], ['mode']]])
  assert.deepEqual(deck.state().sessions[A.host].settingsFrom, { model: 'hello', effort: 'hello', mode: 'permission' })
  // One with no permission_mode: only its effort.
  deck.reset()
  reg([A, 'busy'])
  perm(A, 'Write', W1, { extra: { permission_mode: undefined, effort: { level: 'xhigh' } } })
  hello(A, { mode: 'acceptEdits', effort: 'low' })
  assert.deepEqual([view().settings[A.host], lastHello(log)], [{ model: 'm1', effort: 'xhigh', mode: 'acceptEdits' }, [true, false, ['cwd', 'model', 'mode'], ['effort']]])
  assert.deepEqual(deck.state().sessions[A.host].settingsFrom, { model: 'hello', effort: 'permission', mode: 'hello' })
  // A restarted mod's first hello carries neither, as its mod has seen none yet: nothing to keep, and both stay.
  perm(A, 'Write', W1, { extra: { permission_mode: 'plan', effort: { level: 'high' } } })
  hello({ ...A, inst: 'ia2' }, { model: 'm2' })
  assert.deepEqual([view().settings[A.host], lastHello(log)], [{ model: 'm2', effort: 'high', mode: 'plan' }, [true, false, ['cwd', 'model'], []]])
})

test('deck: a settings event, or a later PermissionRequest, replaces a mode or effort the deck took from a PermissionRequest; a restart\'s hello doesn\'t, and replaces one from a settings event', () => {
  // PROTOCOL.md, "The deck's session model", round 4: "A settings event, or a later PermissionRequest, replaces them as
  // usual." And "No hello", a restart's included.
  const { deck, clock, log, reg, hello, ev, perm, poll, view } = setup()
  const from = () => deck.state().sessions[A.host].settingsFrom
  reg([A, 'busy'])
  hello(A, { mode: 'default', effort: 'low' })
  perm(A, 'Write', W1, { extra: { permission_mode: 'acceptEdits', effort: { level: 'high' } } })
  // A settings event replaces the PermissionRequest's mode; its effort stays the PermissionRequest's.
  ev(A, { t: 'settings', mode: 'plan' })
  assert.deepEqual([view().settings[A.host], from()], [{ model: 'm1', effort: 'high', mode: 'plan' }, { model: 'hello', effort: 'permission', mode: 'settings' }])
  // So after the 60 s, the hello that makes the instance current again gives the mode, and not the effort.
  clock.advance(60_000)
  assert.deepEqual(poll(A).r.sent, [{ status: 409, json: { error: 'hello first' } }])
  hello(A, { mode: 'default', effort: 'low' })
  assert.deepEqual([view().settings[A.host], lastHello(log)], [{ model: 'm1', effort: 'high', mode: 'default' }, [true, false, ['cwd', 'model', 'mode'], ['effort']]])
  // A later PermissionRequest replaces the hello's mode and the earlier PermissionRequest's effort.
  perm(A, 'Bash', { command: 'ls' }, { extra: { permission_mode: 'auto', effort: { level: 'medium' } } })
  assert.deepEqual([view().settings[A.host], from()], [{ model: 'm1', effort: 'medium', mode: 'auto' }, { model: 'hello', effort: 'permission', mode: 'permission' }])
  perm(A, 'Bash', { command: 'pwd' }, { extra: { permission_mode: 'acceptEdits', effort: { level: 'max' } } })
  assert.deepEqual(view().settings[A.host], { model: 'm1', effort: 'max', mode: 'acceptEdits' }, 'and a PermissionRequest\'s, from an earlier one')
  // A restart's hello keeps both; then, with the effort from a settings event, the next restart's hello gives it.
  hello({ ...A, inst: 'ia2' }, { model: 'm2', mode: 'default', effort: 'low' })
  assert.deepEqual([deck.state().sessions[A.host].inst, view().settings[A.host], lastHello(log)], ['ia2', { model: 'm2', effort: 'max', mode: 'acceptEdits' }, [true, false, ['cwd', 'model'], ['mode', 'effort']]])
  ev({ ...A, inst: 'ia2' }, { t: 'settings', effort: 'low' })
  hello({ ...A, inst: 'ia3' }, { model: 'm3', mode: 'plan', effort: 'high' })
  assert.deepEqual([deck.state().sessions[A.host].inst, view().settings[A.host], lastHello(log)], ['ia3', { model: 'm3', effort: 'high', mode: 'acceptEdits' }, [true, false, ['cwd', 'model', 'effort'], ['mode']]])
  assert.equal(log.filter((e) => e.kind === 'mod-restart').length, 2)
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

test("deck: only the desktop app's own attach and detach count, for the target and for being on screen: another surface's, or one with none, changes nothing", () => {
  // PROTOCOL.md, "Events", as amended on 2026-11-04 for session keys: the mods API sends them per client, so a phone
  // leaving a session would otherwise take it off a desktop that still shows it.
  const { deck, clock, reg, hello, ev, view } = setup()
  reg([A, 'idle'], [B, 'idle'])
  deck.applyRecord(A.host, { lastFocusedAt: 10 })
  deck.applyRecord(B.host, { lastFocusedAt: 20 })
  hello(A)
  clock.advance(1000)
  const seen = () => [view().target, deck.state().sessions[A.host].onScreen, deck.state().sessions[A.host].attachAt]
  for (const surface of ['mobile', 'vscode', 'terminal', 'Desktop', '', null, undefined]) {
    ev(A, { t: 'attach', ...(surface === undefined ? {} : { surface }) })
    assert.deepEqual(seen(), [B.host, false, null], `an attach from ${JSON.stringify(surface) ?? 'no surface'}`)
  }
  ev(A, { t: 'attach', surface: 'desktop' })
  assert.deepEqual(seen(), [A.host, true, clock.wall()], "the desktop's attach")
  for (const surface of ['mobile', 'vscode', undefined]) {
    ev(A, { t: 'detach', ...(surface === undefined ? {} : { surface }) })
    assert.deepEqual(seen(), [A.host, true, clock.wall()], `a detach from ${surface ?? 'no surface'}: still on the desktop`)
  }
  ev(A, { t: 'detach', surface: 'desktop' })
  assert.deepEqual(seen().slice(1, 2), [false], "the desktop's detach")
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
    [p1.id]: ['unpaired', "no registry file lists the session's host any more", 'the mod restarted while it was held, so its own tool.start may never come'],
    [p2.id]: ['unpaired', "no registry file lists the session's host any more", 'another request of its tool waited beside it unpaired'],
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

test('deck: answer refuses an ask request, which only its session\'s dial answers: a key press jumps instead', () => {
  const { deck, reg, perm, view } = setup()
  reg([A, 'busy'])
  for (const [tool, input] of [['AskUserQuestion', ASK], ['ExitPlanMode', { plan: 'x' }]]) {
    const ask = perm(A, tool, input)
    for (const decision of ['allow', 'deny', 'none']) {
      assert.throws(() => deck.answer({ id: ask.id, decision }), (err) => err instanceof BadRequest && /which only local_a's Session Slot dial answers: use dial \(POST \/control\/dial\); a key press on it jumps to local_a/.test(err.message))
    }
    assert.equal(ask.r.sent.length, 0, `${tool}: nothing sent`)
  }
  assert.deepEqual(view().held.map((h) => h.kind), ['ask', 'ask'], 'both still held')
  assert.equal(deck.press('approve').jumped, A.host)
})

test('deck: a reset answers held requests with {} and cuts open polls off with no answer, so their mods say hello again; close answers polls with no commands', () => {
  const { deck, clock, log, reg, hello, perm, poll, view } = setup()
  reg([A, 'busy'])
  hello(A)
  const p1 = perm(A, 'Write', W1)
  const n1 = poll(A)
  deck.prompt({ host: A.host, text: 'x' })
  const n2 = poll(A)
  deck.reset()
  assert.deepEqual(p1.r.sent, [{ status: 200, json: {} }])
  assert.deepEqual(n1.r.sent[0].json.cmds.length, 1)
  // A poll answered with none would go through: the mod, which says hello again only after a failed request, would
  // poll on with an inst the reset forgot, its polls answered at once for good.
  assert.deepEqual([n2.r.sent, n2.r.wasCut], [[], true], 'the open poll is cut off, so the mod\'s fetch fails')
  assert.deepEqual(log.filter((e) => e.kind === 'poll-cut').map((e) => [e.host, e.poll, e.inst]), [[A.host, n2.id, A.inst]])
  assert.deepEqual([view().sessions, view().held, view().cmds], [[], [], {}])
  assert.equal(clock.pending, 0, 'no timers left behind')
  // Until it says hello again, the reset having forgotten its inst, its polls ask for a hello: as a mod with no poll open
  // at the reset, waiting out its second after a poll answered at once, finds at its next.
  reg([A, 'busy'])
  const stale = poll(A)
  assert.deepEqual(stale.r.sent, [{ status: 409, json: { error: 'hello first' } }])
  // Its fetch failed, so the mod says hello again, with the same inst: current again, its next poll is held and takes
  // the next command.
  hello(A)
  const n3 = poll(A)
  assert.equal(n3.r.sent.length, 0, 'held')
  const c = deck.prompt({ host: A.host, text: 'y' }).cmd
  assert.equal(c, 'cmd-2', 'command ids stay unique for the run')
  assert.deepEqual(n3.r.sent, [{ status: 200, json: { cmds: [{ id: c, t: 'prompt', text: 'y' }] } }])
  // Closing: nothing serves the mod's next request, so open polls are answered with no commands.
  const p2 = perm(A, 'Write', W1)
  const n4 = poll(A)
  deck.close()
  assert.deepEqual([p2.r.sent, n4.r.sent, n4.r.wasCut], [[{ status: 200, json: {} }], [{ status: 200, json: { cmds: [] } }], false])
  assert.equal(clock.pending, 0, 'no timers left behind')
})
