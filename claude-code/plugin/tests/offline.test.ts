// The mod with the bridge down, gone, stuck or on another version (PROTOCOL.md, "Failure and recovery"): it backs
// off 1, 2, 5, 10 and 30 s, then every 30 s, logs once per outage, says hello again when the bridge answers, and
// never holds up the session. The clock is the kit's mock, so the waits are exact.

import { expect, test } from 'claude-code/testing'
import { HOST, MODEL, START, TOKEN, world } from './world'

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

test("a hello answered ok: false with a v other than 1, even one that isn't a number, stops the mod as another version does", async ($, on) => {
  const w = world(on)
  w.bridge.hello = { status: 200, body: { v: '2', ok: false } }
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await w.clock.advance(300_000)
  expect(w.sent.map(r => r.route)).toEqual(['/v1/hello'])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/protocol version 2 and this plugin 1/)
})

test('a hello answered ok: false with no v and no version error is retried like an outage', async ($, on) => {
  const w = world(on)
  w.bridge.hello = { status: 200, body: { ok: false, error: 'busy' } }
  await $.session.start(START)
  await w.settle()
  await w.clock.advance(3000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/wasn't answered ok/)
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

test('a hello the bridge takes and never answers fails after 35 s; once the bridge answers, the poll opens and the queued events go out', async ($, on) => {
  const w = world(on, { mode: 'hang' })
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await $.tool.call(READ)).toEqual({ result: 'ran' })
  await w.clock.advance(34_999)
  expect(w.sent.map(r => r.route)).toEqual(['/v1/hello'])
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/the hello had no answer after 35 s/)

  // The bridge answers again: the hello 1 s after the failure is answered, the poll opens, and the events go out in
  // order.
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 36_000])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([36_000])
  expect(w.events().map(x => [x.seq, x.event.t])).toEqual([
    [1, 'turn.start'],
    [2, 'tool.start'],
    [3, 'tool.end'],
  ])
  // The first hello's answer comes at last, and changes nothing: no second poll, no other request.
  const before = w.sent.length
  w.answerHung(200, { v: 1, ok: true })
  await w.clock.advance(1000)
  expect(w.sent.length).toBe(before)
  expect(w.logs).toHaveLength(1)
})

test('an event the bridge takes and never answers fails after 35 s: after the next hello it goes again with its seq, and the line moves on', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.events = 'hang'
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  w.bridge.events = 204
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  // One request at a time: the second waits behind the first.
  expect(w.to('/v1/events')).toHaveLength(1)
  await w.clock.advance(34_999)
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/\/v1\/events had no answer after 35 s/)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 36_000])
  const sends = () => w.to('/v1/events').map(r => [r.body.seq, r.body.events[0].turn, r.at])
  expect(sends()).toEqual([
    [1, 't1', 0],
    [1, 't1', 36_000],
    [2, 't2', 36_000],
  ])

  // The first send's answer comes at last, and changes nothing: the line goes on from where it is.
  w.answerHung(204)
  await w.settle()
  await $.turn.start({ text: 'c', turnId: 't3' })
  await w.settle()
  expect(sends().map(([s]) => s)).toEqual([1, 1, 2, 3])
  expect(w.to('/v1/hello')).toHaveLength(2)
  expect(w.logs).toHaveLength(1)
})

test('a model that changed twice while the bridge was away, once before a turn ended and once after: the deck ends on the model now', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // The deck restarts. While it's away the model changes, a turn ends (which queues that model), and the model
  // changes again.
  w.bridge.mode = 'down'
  w.drop()
  await w.settle()
  w.session.model = 'claude-sonnet-5-5'
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
  w.session.model = 'claude-opus-5-5'
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  // The hello tells the model now, the queued settings the one before, and a settings event the model now again.
  const told = w.sent
    .filter(r => r.at === 1000 && r.route !== '/v1/next')
    .map(r => (r.route === '/v1/hello' ? `hello ${r.body.model}` : `${r.body.events[0].t} ${r.body.events[0].model ?? ''}`.trim()))
  expect(told).toEqual(['hello claude-opus-5-5', 'turn.end', 'settings claude-sonnet-5-5', 'settings claude-opus-5-5'])
  // From then on the deck has it: the next turn sends no settings.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await w.settle()
  expect(w.settings()).toEqual([{ model: 'claude-sonnet-5-5' }, { model: 'claude-opus-5-5' }])
})

test('a model that changed while the bridge was away, with no turn ending: the hello tells it, and no settings event repeats it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.mode = 'down'
  w.drop()
  await w.settle()
  w.session.model = 'claude-opus-5-5'
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.body.model)).toEqual([MODEL, 'claude-opus-5-5'])
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
  expect(w.settings()).toEqual([])
})

test('the model is read again once a hello is answered: a change made while the hello was out reaches the deck', async ($, on) => {
  const w = world(on, { mode: 'hang' })
  await $.session.start(START)
  await w.settle()
  expect(w.to('/v1/hello')[0]?.body.model).toBe(MODEL)
  w.session.model = 'claude-opus-5-5'
  w.bridge.mode = 'up'
  w.answerHung(200, { v: 1, ok: true })
  await w.settle()
  expect(w.settings()).toEqual([{ model: 'claude-opus-5-5' }])
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

test("a token across the 200-character cut of an error's text is hidden before the cut: no piece of it reaches the log", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // How many characters the engine puts before a refusal's reason, from an outage whose reason is a mark.
  w.bridge.mode = 'down'
  w.bridge.refusal = 'MARK'
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  const opening = "isn't answering ("
  const first = w.logs[0] ?? ''
  const before = first.indexOf('MARK') - first.indexOf(opening) - opening.length
  expect(before).toBeGreaterThanOrEqual(0)
  expect(before).toBeLessThan(150)
  w.bridge.mode = 'up'
  await w.clock.advance(1000)

  // A second outage, whose error's text holds the token from its 194th character: a cut at 199 made first would
  // leave the token's first 6 in the log, too few for a piece to be hidden on its own.
  const filler = 'x'.repeat(193 - before)
  w.bridge.mode = 'down'
  w.bridge.refusal = `${filler}${TOKEN} and on`
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  const line = w.logs[1] ?? ''
  expect(line).toContain(`${filler}<token…`)
  for (let i = 0; i + 5 <= TOKEN.length; i++) expect(line).not.toContain(TOKEN.slice(i, i + 5))
})

test("a piece of the token 8 characters or longer is hidden too, as in an error's text the engine had already cut short", async ($, on) => {
  const w = world(on, { mode: 'down' })
  w.bridge.refusal = `connect ECONNREFUSED (Authorization: Bearer ${TOKEN.slice(0, 12)}…) after ${TOKEN.slice(9)}`
  await $.session.start(START)
  await w.settle()
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toContain('(Authorization: Bearer <token>…) after <token>)')
  for (let i = 0; i + 8 <= TOKEN.length; i++) expect(w.logs[0]).not.toContain(TOKEN.slice(i, i + 8))
})
