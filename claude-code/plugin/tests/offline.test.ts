// The mod with the bridge down, gone, stuck or on another version (PROTOCOL.md, "Failure and recovery"): it backs
// off 1, 2, 5, 10 and 30 s, then every 30 s, logs once per outage, says hello again when the bridge answers, and
// never holds up the session. The clock is the kit's mock, so the waits are exact.

import { expect, test } from 'claude-code/testing'
import { HOST, START, TOKEN, world } from './world'

const READ = { tool: 'Read', tool_use_id: 'u1', file_path: '/sandbox/notes.md' } as const

test("without DECK_TOKEN the mod sends nothing, says so once in the log, and passes every hook through", async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_HOST_SESSION_ID: HOST } })
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await $.tool.call(READ)).toEqual({ result: 'ran' })
  await $.classic.Stop({ stop_hook_active: false, permission_mode: 'default', effort: { level: 'low' } })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.advance(120_000)
  expect(w.sent).toEqual([])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/DECK_TOKEN/)
})

test('with the bridge down from the start, hello backs off 1, 2, 5, 10 and 30 s, then every 30 s, and logs once', async ($, on) => {
  const w = world(on, { mode: 'down' })
  await $.session.start(START)
  await w.settle()
  // The session goes on meanwhile: the hooks return at once, and their events wait.
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await $.tool.call(READ)).toEqual({ result: 'ran' })
  await w.clock.advance(78_000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000, 18_000, 48_000, 78_000])
  expect(w.sent.every(r => r.route === '/v1/hello')).toBe(true)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/isn't answering \(.*ECONNREFUSED/)

  // The deck comes up: the next hello is answered, the queued events go out in order, and the poll opens.
  w.bridge.mode = 'up'
  await w.clock.advance(30_000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000, 18_000, 48_000, 78_000, 108_000])
  expect(w.events().map(x => [x.seq, x.event.t])).toEqual([
    [1, 'turn.start'],
    [2, 'tool.start'],
    [3, 'tool.end'],
  ])
  const sinceUp = w.sent.filter(r => r.at >= 108_000).map(r => r.route)
  expect(sinceUp[0]).toBe('/v1/hello')
  expect(sinceUp.filter(r => r === '/v1/next')).toHaveLength(1)
  expect(w.logs).toHaveLength(1)
})

test('when the bridge goes away mid-session, the mod logs once more, says hello again as the same inst, and resends what failed with its seq', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'acceptEdits', effort: { level: 'high' } })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await w.settle()
  expect(w.events().map(x => [x.seq, x.event.t])).toEqual([
    [1, 'settings'],
    [2, 'turn.start'],
  ])
  expect(w.logs).toEqual([])

  // The deck stops: new connections are refused, while the open poll hangs on, unanswered.
  w.bridge.mode = 'down'
  await $.tool.call(READ)
  await w.settle()
  expect(w.logs).toHaveLength(1)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello')).toHaveLength(2)

  // Back again: the third hello (1 + 2 s after the failure) is answered.
  w.bridge.mode = 'up'
  await w.clock.advance(2000)
  const hellos = w.to('/v1/hello')
  expect(hellos).toHaveLength(3)
  expect(new Set(hellos.map(h => h.body.inst)).size).toBe(1)
  // A hello after an outage tells a deck that restarted what this mod knows of the settings.
  expect(hellos[2]?.body).toMatchObject({ v: 1, host: HOST, mode: 'acceptEdits', effort: 'high' })
  // tool.start failed once and went again with its seq; tool.end followed.
  expect(w.events().map(x => [x.seq, x.event.t])).toEqual([
    [1, 'settings'],
    [2, 'turn.start'],
    [3, 'tool.start'],
    [3, 'tool.start'],
    [4, 'tool.end'],
  ])
  // The new poll is open, and the outage made one log line.
  expect(w.to('/v1/next').filter(r => r.at === 3000)).toHaveLength(1)
  expect(w.logs).toHaveLength(1)

  // A later outage is a new one, with a line of its own: here the deck restarts and drops the poll.
  w.bridge.mode = 'down'
  w.drop()
  await w.settle()
  expect(w.logs).toHaveLength(2)
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  expect(w.to('/v1/hello')).toHaveLength(4)
})

test('no hook waits on the bridge, even one that takes requests and never answers', async ($, on) => {
  const w = world(on, { mode: 'hang' })
  expect(await $.session.start(START)).toEqual({ cwd: '/sandbox' })
  await w.settle()
  expect(w.to('/v1/hello')).toHaveLength(1)
  // Each of these returns although nothing is ever answered: a hook that waited would time the test out.
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await $.tool.call(READ)).toEqual({ result: 'ran' })
  await $.session.measure({ changed: ['context'], context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [] })
  await $.classic.Stop({ stop_hook_active: false, permission_mode: 'default', effort: { level: 'low' } })
  await $.classic.StopFailure({ error: 'overloaded' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  await w.settle()
  // Nothing went out behind the unanswered hello.
  expect(w.sent.map(r => r.route)).toEqual(['/v1/hello'])
})

test('a deck on another protocol version: the mod logs that once and stops talking to the bridge', async ($, on) => {
  const w = world(on)
  w.bridge.hello = { status: 200, body: { v: 2, ok: false, error: 'version' } }
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(READ)
  await w.clock.advance(300_000)
  expect(w.sent.map(r => r.route)).toEqual(['/v1/hello'])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/protocol version 2/)
})

test('a hello the bridge refuses (401) is retried like an outage', async ($, on) => {
  const w = world(on)
  w.bridge.hello = { status: 401, body: { error: 'unauthorized' } }
  await $.session.start(START)
  await w.settle()
  await w.clock.advance(3000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000])
  expect(w.to('/v1/next')).toHaveLength(0)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/401/)
  w.bridge.hello = { status: 200, body: { v: 1, ok: true } }
  await w.clock.advance(5000)
  expect(w.to('/v1/hello')).toHaveLength(4)
  expect(w.to('/v1/next')).toHaveLength(1)
})

test('a poll the bridge leaves unanswered 35 s counts as a failed request: hello again, and a new poll', async ($, on) => {
  const w = world(on)
  w.bridge.pollHold = Number.POSITIVE_INFINITY
  await $.session.start(START)
  await w.settle()
  expect(w.to('/v1/next')).toHaveLength(1)
  await w.clock.advance(34_999)
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/no answer after 35 s/)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 36_000])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 36_000])
})

test('the bridge holding each poll its 20 s: the mod polls again as each answers, one open at a time', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  await w.clock.advance(100_000)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 20_000, 40_000, 60_000, 80_000, 100_000])
  expect(w.to('/v1/next').every(r => r.query.wait === '20')).toBe(true)
  expect(w.to('/v1/hello')).toHaveLength(1)
  expect(w.logs).toEqual([])
})

test('a poll answered empty at once waits out a second before the next, so a confused bridge gets no busy loop', async ($, on) => {
  const w = world(on)
  w.bridge.pollHold = 0
  await $.session.start(START)
  await w.settle()
  expect(w.to('/v1/next')).toHaveLength(1)
  await w.clock.advance(4000)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 2000, 3000, 4000])
})

test('a 4xx drops that one request and the next goes on; a 5xx is an outage, and the request goes again', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.events = 400
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  w.bridge.events = 204
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.events().map(x => x.seq)).toEqual([1, 2])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/refused a \/v1\/events request with 400/)

  w.bridge.events = 503
  await $.turn.start({ text: 'c', turnId: 't3' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  w.bridge.events = 204
  await w.clock.advance(1000)
  expect(w.events().map(x => x.seq)).toEqual([1, 2, 3, 3])
  expect(w.to('/v1/hello')).toHaveLength(2)
})

test('the token goes in the Authorization header alone: never in a URL, a body or the log', async ($, on) => {
  const w = world(on)
  // An error whose text holds the token must not carry it into the log.
  w.bridge.refusal = `connect ECONNREFUSED (Authorization: Bearer ${TOKEN})`
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Run the tests.' }])
  await w.settle()
  // The outage starts with a refused send, whose error text holds the token.
  w.bridge.mode = 'down'
  await $.turn.start({ text: 'again', turnId: 't2' })
  await w.settle()
  await w.clock.advance(3000)
  expect(w.sent.length).toBeGreaterThan(5)
  for (const r of w.sent) {
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify([r.route, r.query, r.body]).includes(TOKEN)).toBe(false)
  }
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]?.includes(TOKEN)).toBe(false)
  expect(w.logs[0]).toMatch(/<token>/)
})
