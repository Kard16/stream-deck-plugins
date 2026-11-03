// The mod with the bridge down, gone, stuck or on another version (PROTOCOL.md, "Failure and recovery"): a fetch
// that rejects, or a poll answered 409 hello first, is followed 100 ms later by a quick hello, quietly. A failure
// after that hello, until its request goes through or more than 2 s pass from its answer, is the second, and a failed
// request backs off 1, 2, 5, 10 and 30 s, then every 30 s, with a hello each time, until the request that failed goes
// through; it logs once per outage, and never holds up the session. The clock is the kit's mock, so the waits are
// exact.

import { expect, test } from 'claude-code/testing'
import { HELLO_FIRST, HOST, MODEL, START, TOKEN, world, type Reply } from './world'

const READ = { tool: 'Read', tool_use_id: 'u1', file_path: '/sandbox/notes.md' } as const

// Without DECK_TOKEN the mod never talks at all: desktop.test.ts, with the gate's other tests.

test("with the bridge down from the start, the first hello's refusal has a quick hello 100 ms later, whose refusal begins the outage: hello backs off 1, 2, 5, 10 and 30 s, then every 30 s, and logs once; the hello answered at last ends that outage", async ($, on) => {
  const w = world(on, { mode: 'down' })
  await $.session.start(START)
  await w.settle()
  // The session goes on meanwhile: the hooks return at once, and their events wait.
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await $.tool.call(READ)).toEqual({ result: 'ran' })
  await w.clock.advance(78_100)
  // A refused connection rejects the fetch. Only the first refusal has a quick hello; the outage's waits run from
  // the second.
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 3100, 8100, 18_100, 48_100, 78_100])
  expect(w.sent.every(r => r.route === '/v1/hello')).toBe(true)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/isn't answering \(.*ECONNREFUSED/)

  // The deck comes up: the next hello is answered, the queued events go out in order, and the poll opens.
  w.bridge.mode = 'up'
  await w.clock.advance(30_000)
  expect(w.to('/v1/hello').map(r => r.at).slice(8)).toEqual([108_100])
  expect(w.events().map(x => [x.seq, x.event.t])).toEqual([
    [1, 'turn.start'],
    [2, 'tool.start'],
    [3, 'tool.end'],
  ])
  const sinceUp = w.sent.filter(r => r.at >= 108_100).map(r => r.route)
  expect(sinceUp[0]).toBe('/v1/hello')
  expect(sinceUp.filter(r => r === '/v1/next')).toHaveLength(1)
  expect(w.logs).toHaveLength(1)

  // The hello began that outage, so its answer ended it: a later failure is a new one, with a line of its own and
  // hello again after 1 s.
  w.bridge.events = 503
  await $.turn.start({ text: 'again', turnId: 't2' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at).slice(9)).toEqual([109_100])
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

  // The deck stops: new connections are refused, while the open poll hangs on, unanswered. The first refusal has a
  // quick hello 100 ms later, quietly; that hello's refusal is the second failure, with the outage's line, and hello
  // 1 s after it.
  w.bridge.mode = 'down'
  await $.tool.call(READ)
  await w.settle()
  expect(w.logs).toEqual([])
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(1)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100])

  // Back again: the next hello (2 s after that one's refusal) is answered.
  w.bridge.mode = 'up'
  await w.clock.advance(2000)
  const hellos = w.to('/v1/hello')
  expect(hellos.map(r => r.at)).toEqual([0, 100, 1100, 3100])
  expect(new Set(hellos.map(h => h.body.inst)).size).toBe(1)
  // A hello after an outage tells a deck that restarted what this mod knows of the settings.
  expect(hellos[3]?.body).toMatchObject({ v: 1, host: HOST, mode: 'acceptEdits', effort: 'high' })
  // tool.start was refused and went again with its seq, after the hello that was answered; tool.end followed.
  expect(w.to('/v1/events').map(r => [r.body.seq, r.body.events[0].t, r.at])).toEqual([
    [1, 'settings', 0],
    [2, 'turn.start', 0],
    [3, 'tool.start', 0],
    [3, 'tool.start', 3100],
    [4, 'tool.end', 3100],
  ])
  // The new poll is open, and the outage made one log line.
  expect(w.to('/v1/next').filter(r => r.at === 3100)).toHaveLength(1)
  expect(w.logs).toHaveLength(1)

  // A later outage is a new one, with a line of its own: here the deck restarts and drops the poll, and refuses the
  // quick hello 100 ms later.
  w.bridge.mode = 'down'
  w.drop()
  await w.settle()
  expect(w.logs).toHaveLength(1)
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(2)
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at).slice(4)).toEqual([3200, 4200])
})

test("an event whose fetch rejects, as when the engine abandons a mod's fetches at an interrupt, has a quick hello 100 ms later, then goes again under its seq: no log line, no outage, and the line waits for it", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.abandon('/v1/events')
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.clock.advance(99)
  const sends = () => w.to('/v1/events').map(r => [r.body.seq, r.body.events[0].turn, r.at])
  expect(sends()).toEqual([[1, 't1', 0]])
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
  await w.clock.advance(1)
  // The hello first, then the poll opens again and the line goes on from the event that was abandoned.
  expect(w.sent.filter(r => r.at === 100).map(r => r.route)[0]).toBe('/v1/hello')
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100])
  expect(sends()).toEqual([
    [1, 't1', 0],
    [1, 't1', 100],
    [2, 't2', 100],
  ])
  // The same request went again, word for word.
  const [first, again] = w.to('/v1/events')
  expect(again?.body).toEqual(first?.body)
  expect(w.logs).toEqual([])

  // No outage: the event went through, so the next rejection has a quick hello of its own, and nothing else follows.
  w.abandon('/v1/events')
  await $.turn.start({ text: 'c', turnId: 't3' })
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 200])
  expect(sends().slice(3)).toEqual([
    [3, 't3', 100],
    [3, 't3', 200],
  ])
  await w.clock.advance(60_000)
  expect(w.to('/v1/hello')).toHaveLength(3)
  expect(w.logs).toEqual([])
})

test('a hello, a result and a poll whose fetches reject have a quick hello 100 ms later too, then go again, with no log line', async ($, on) => {
  const w = world(on)
  w.abandon('/v1/hello')
  await $.session.start(START)
  await w.settle()
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
  await w.clock.advance(100)
  // The quick hello is the same hello, and its answer opened the poll.
  const hellos = w.to('/v1/hello')
  expect(hellos.map(r => r.at)).toEqual([0, 100])
  expect(hellos[1]?.body).toEqual(hellos[0]?.body)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([100])

  // A prompt's waiting is abandoned: a quick hello, then it goes again, and done follows it. The poll the command
  // came on had opened another, which the hello's poll leaves behind.
  w.abandon('/v1/result')
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Run the tests.' }])
  await w.settle()
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 200])
  expect(w.to('/v1/result').map(r => [r.body.state, r.at])).toEqual([
    ['waiting', 100],
    ['waiting', 200],
    ['done', 200],
  ])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([100, 100, 200])

  // The open polls are abandoned, the one left behind too: a quick hello, then a poll again.
  w.drop()
  await w.settle()
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 200])
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 200, 300])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([100, 100, 200, 300])
  expect(w.logs).toEqual([])
})

test('a poll dropped as `streamdeck restart` stops the deck, with the new deck up 85 ms later: the first request it sees is the quick hello, and only then a poll; a new deck on another version stops the mod before any poll', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.mode = 'down'
  w.drop()
  await w.clock.advance(85)
  w.bridge.mode = 'up'
  const back = w.sent.length
  await w.clock.advance(15)
  expect(w.sent.slice(back).map(r => [r.route, r.at])).toEqual([
    ['/v1/hello', 100],
    ['/v1/next', 100],
  ])
  expect(w.sent[back]?.body).toMatchObject({ v: 1, host: HOST })
  expect(w.logs).toEqual([])

  // The same restart once that poll has been answered, and the deck comes back on another version: the quick hello
  // is its first request, and its answer stops the mod.
  await w.clock.advance(20_000)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, 20_100])
  w.bridge.mode = 'down'
  w.drop()
  await w.clock.advance(85)
  w.bridge.mode = 'up'
  w.bridge.hello = { status: 200, body: { v: 2, ok: false, error: 'version' } }
  const again = w.sent.length
  await w.clock.advance(300_000)
  expect(w.sent.slice(again).map(r => [r.route, r.at])).toEqual([['/v1/hello', 20_200]])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/protocol version 2/)
})

test("a deck that restarted, or forgot the session, while the mod had nothing open answers its next poll 409 hello first: a quick hello 100 ms later, quietly, then the poll, and the commands the deck hands out after it run, though their ids came before", async ($, on) => {
  const submitted: string[] = []
  const w = world(on, {
    submit: text => {
      submitted.push(text)
      return undefined
    },
  })
  await $.session.start(START)
  await w.settle()
  w.deliver([{ id: 'c1', t: 'prompt', text: 'One.' }])
  await w.settle()
  // The turn the prompt started ends 500 ms on: the deck answers the poll empty, and the mod waits out the rest of
  // that poll's second with no request open. In that second the deck restarts, or a registry reading misses the
  // session (release rule 4): either way no instance has said hello for the session, and no request of the mod fails.
  await w.clock.advance(500)
  w.deliver([])
  await w.settle()
  w.forget()
  await w.clock.advance(500)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 0, 1000])
  await w.clock.advance(99)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  // The same hello, first, then the poll, which the deck holds again.
  expect(w.sent.filter(r => r.at === 1100).map(r => r.route)).toEqual(['/v1/hello', '/v1/next'])
  const hellos = w.to('/v1/hello')
  expect(hellos[1]?.body).toEqual(hellos[0]?.body)
  expect(w.logs).toEqual([])

  // A deck that restarted hands out its command ids again, and the hello cleared the ones that ran: c1 runs.
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Two.' }])
  await w.settle()
  expect(submitted).toEqual(['One.', 'Two.'])
  expect(w.results()).toEqual([
    { id: 'c1', state: 'waiting' },
    { id: 'c1', state: 'done' },
    { id: 'c1', state: 'waiting' },
    { id: 'c1', state: 'done' },
  ])
  expect(w.logs).toEqual([])
})

test('a second 409 hello first, right after the quick hello is answered and before a poll goes through, is a failed request: the outage begins, with its one log line, and hello backs off 1, 2, 5 and 10 s; a poll held and answered at last ends it, so the next 409 has a quick hello again', async ($, on) => {
  const w = world(on)
  // A deck that asks each poll for a hello, and takes none of them.
  w.bridge.poll = HELLO_FIRST
  await $.session.start(START)
  await w.clock.advance(99)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
  expect(w.logs).toEqual([])
  // The quick hello is answered, and the poll after it is answered 409 again: the second failure.
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/isn't answering \(a poll was answered 409 hello first\)/)
  await w.clock.advance(999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  await w.clock.advance(7001)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 3100, 8100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, 1100, 3100, 8100])
  expect(w.logs).toHaveLength(1)

  // The deck takes the hello 10 s on: the poll after it is held its 20 s and answered, which ends the outage.
  w.bridge.poll = undefined
  await w.clock.advance(30_000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 3100, 8100, 18_100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, 1100, 3100, 8100, 18_100, 38_100])
  // So a 409 now is the first again: the deck forgets the session, answering the open poll, and the poll after the
  // rest of that second is answered 409: a quick hello 100 ms on, with no line.
  w.forget()
  await w.clock.advance(1100)
  expect(w.to('/v1/hello').map(r => r.at).slice(6)).toEqual([39_200])
  expect(w.to('/v1/next').map(r => r.at).slice(7)).toEqual([39_100, 39_200])
  expect(w.logs).toHaveLength(1)
})

/** Poll answers that aren't 409 hello first: each is a failed poll, as any other answer that isn't 2xx. */
const NOT_HELLO_FIRST: readonly { what: string; reply: Reply; status: number }[] = [
  { what: '409 with another error', reply: { status: 409, body: { error: 'not this session' } }, status: 409 },
  { what: '409 with no body', reply: { status: 409 }, status: 409 },
  { what: '409 with the error in another case', reply: { status: 409, body: { error: 'Hello first' } }, status: 409 },
  { what: '409 with the words alone for a body', reply: { status: 409, body: 'hello first' }, status: 409 },
  { what: '400 with the error hello first', reply: { status: 400, body: { error: 'hello first' } }, status: 400 },
  { what: '503 with the error hello first', reply: { status: 503, body: { error: 'hello first' } }, status: 503 },
]

for (const c of NOT_HELLO_FIRST) {
  test(`a poll answered ${c.what} is a failed poll, as before: no quick hello, but the outage at once, with its log line and hello 1 s later`, async ($, on) => {
    const w = world(on)
    w.bridge.poll = c.reply
    await $.session.start(START)
    await w.settle()
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain(`isn't answering (a poll was answered ${c.status});`)
    await w.clock.advance(999)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
    await w.clock.advance(1)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000])
    expect(w.logs).toHaveLength(1)
  })
}

test("a poll answered 409 hello first during an outage is one more failure in it: no quick hello and no line of its own, and the outage's waits go on until the request that began it goes through; after that, a 409 has its quick hello again", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // An event answered 503 begins an outage, with its line and hello 1 s later.
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  expect(w.logs).toHaveLength(1)
  // The deck answers each hello, but takes the event and leaves it unanswered, and asks each poll for a hello.
  w.bridge.events = 'hang'
  w.bridge.poll = HELLO_FIRST
  await w.clock.advance(3000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 3000])
  await w.clock.advance(4999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000])
  expect(w.logs).toHaveLength(1)

  // The deck answers the event and holds polls again: after the hello 5 s on, the event goes through, which ends the
  // outage.
  w.bridge.events = 204
  w.bridge.poll = undefined
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 1000],
    [1, 3000],
    [1, 8000],
  ])
  // So a 409 now has its quick hello, with no line: the deck forgets the session, answering the open poll, and the
  // poll after the rest of that second is answered 409.
  w.forget()
  await w.clock.advance(1100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000, 9100])
  expect(w.logs).toHaveLength(1)
})

test('what ladder step 4 saw: a deck Deny interrupts the turn, and the engine abandons the open poll and the tool.end on its way at the same moment; one quick hello 100 ms later, then a poll and the tool.end again under its seq, with no log line', async ($, on) => {
  const w = world(on)
  const refusal = "The user doesn't want to proceed with this tool use."
  // The call waits on its permission dialog until the deck's Deny refuses it.
  let deny: () => void = () => {}
  w.engine.tool = () =>
    new Promise(resolve => {
      deny = () => resolve({ result: `Error: ${refusal}`, text: refusal, isError: true })
    })
  await $.session.start(START)
  await w.settle()
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'rm -rf build' })
  await w.settle()
  expect(w.events().map(x => x.event.t)).toEqual(['tool.start'])
  // The tool.end is still on its way, beside the open poll, when the engine abandons both.
  w.bridge.events = 'hang'
  deny()
  expect(await call).toMatchObject({ isError: true })
  await w.settle()
  const sends = () => w.to('/v1/events').map(r => [r.body.seq, r.body.events[0].t, r.at])
  expect(sends()).toEqual([
    [1, 'tool.start', 0],
    [2, 'tool.end', 0],
  ])
  w.bridge.events = 204
  w.abandonOpen()
  await w.clock.advance(99)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
  await w.clock.advance(1)
  // One hello for both rejections, first, then the poll and the tool.end again.
  expect(w.sent.filter(r => r.at === 100).map(r => r.route)[0]).toBe('/v1/hello')
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100])
  expect(sends()).toEqual([
    [1, 'tool.start', 0],
    [2, 'tool.end', 0],
    [2, 'tool.end', 100],
  ])
  expect(w.logs).toEqual([])

  // Both went through, the poll once answered in its 20 s: the polls go on, and the next Deny has a quick hello of
  // its own, with no line.
  await w.clock.advance(20_000)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, 20_100])
  w.abandonOpen()
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 20_200])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, 20_100, 20_200])
  expect(w.logs).toEqual([])
})

test('the quick hello answered, and the event that went again after it rejected again: that is the second failure, so the outage begins, logged once, with hello 1 s later, and the event goes again under its seq', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.abandon('/v1/events', 2)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.clock.advance(99)
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/isn't answering \(.*aborted/)
  await w.clock.advance(999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 100],
    [1, 1100],
  ])
  expect(w.logs).toHaveLength(1)
})

test('a hello, and a poll, rejected again after their quick hello are failed requests too: an outage, with its log line and hello 1 s later', async ($, on) => {
  const w = world(on)
  w.abandon('/v1/hello', 2)
  await $.session.start(START)
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(1)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([1100])

  // The poll drops: a quick hello 100 ms later, quietly, since the hello's answer ended the last outage. The poll it
  // opens drops too before it's answered, which begins a new outage, with a line of its own.
  w.drop()
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 1200])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([1100, 1200])
  expect(w.logs).toHaveLength(1)
  w.drop()
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 1200, 2200])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([1100, 1200, 2200])
})

test("a quick hello that is itself rejected, or answered 5xx, is the second failure: the outage begins, with its one log line and hello 1 s later, and it's the rejected request's, so a hello answered alone doesn't end it", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // The deck stops and takes longer than 100 ms to come back: the event is refused, and the quick hello too.
  w.bridge.mode = 'down'
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.clock.advance(99)
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/isn't answering \(.*ECONNREFUSED/)
  w.bridge.mode = 'up'
  await w.clock.advance(999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 1100],
  ])
  expect(w.logs).toHaveLength(1)

  // The event went through, which ended that outage. An event abandoned now has a quick hello answered 503: a new
  // outage, with a line of its own and hello 1 s later. That hello is answered, but the event is answered 503 again:
  // the outage goes on, with no line, and the next hello waits 2 s.
  w.abandon('/v1/events')
  w.bridge.hello = { status: 503, body: { error: 'starting' } }
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(2)
  expect(w.logs[1]).toMatch(/the hello was answered 503/)
  w.bridge.hello = { status: 200, body: { v: 1, ok: true } }
  w.bridge.events = 503
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at).slice(3)).toEqual([1200, 2200])
  w.bridge.events = 204
  await w.clock.advance(2000)
  expect(w.to('/v1/hello').map(r => r.at).slice(3)).toEqual([1200, 2200, 4200])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at]).slice(2)).toEqual([
    [2, 1100],
    [2, 2200],
    [2, 4200],
  ])
  expect(w.logs).toHaveLength(2)
})

// The quick hello's window (PROTOCOL.md, "Failure and recovery"): until the request whose rejection, or 409, asked
// for a quick hello goes through, a failure up to 2 s after that hello's answer is still the second, and begins the
// outage. A rejection or a 409 that comes later is a first failure again, with a quick hello of its own.

/** How long after a quick hello's answer a failure comes, and whether it's still the second. */
const WINDOW: readonly { after: number; second: boolean }[] = [
  { after: 1000, second: true },
  { after: 2000, second: true },
  { after: 2001, second: false },
  { after: 5000, second: false },
]

const SECOND = 'is still the second failure: the outage begins, with its one log line and hello 1 s later'
const FIRST_AGAIN = 'is a first failure again: a quick hello of its own 100 ms later, with no log line and no outage'

for (const c of WINDOW) {
  test(`a poll the deck holds after a quick hello, abandoned ${c.after} ms after that hello's answer at an Esc or a Deny, ${c.second ? SECOND : FIRST_AGAIN}`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.settle()
    // A Deny abandons the open poll: a quick hello 100 ms later, whose answer opens the poll again, and the deck
    // holds it.
    w.abandonOpen()
    await w.clock.advance(100)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
    expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100])
    // The next interrupt abandons that poll, still held, so the request the quick hello was for hasn't gone through.
    await w.clock.advance(c.after)
    const at = 100 + c.after
    w.abandonOpen()
    await w.settle()
    if (c.second) {
      expect(w.logs).toHaveLength(1)
      expect(w.logs[0]).toMatch(/isn't answering \(.*aborted/)
      await w.clock.advance(999)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
      await w.clock.advance(1)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, at + 1000])
      expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, at + 1000])
      expect(w.logs).toHaveLength(1)
    } else {
      expect(w.logs).toEqual([])
      await w.clock.advance(99)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
      await w.clock.advance(1)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, at + 100])
      expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, at + 100])
      // No outage: the poll that hello opened is held its 20 s, and so are the ones after it, with no hello between.
      await w.clock.advance(60_000)
      expect(w.to('/v1/hello')).toHaveLength(3)
      expect(w.to('/v1/next').map(r => r.at).slice(2)).toEqual([at + 100, at + 20_100, at + 40_100, at + 60_100])
      expect(w.logs).toEqual([])
    }
  })
}

for (const c of WINDOW) {
  test(`a poll answered 409 hello first ${c.after} ms after a quick hello's answer, while the event that hello was for is still unanswered, ${c.second ? SECOND : FIRST_AGAIN}`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.settle()
    // An event's fetch is abandoned: a quick hello 100 ms later. The deck takes the event that goes again after it
    // and leaves it unanswered, so the event doesn't go through, and only the window can end the quick hello.
    w.abandon('/v1/events')
    await $.turn.start({ text: 'a', turnId: 't1' })
    await w.settle()
    w.bridge.events = 'hang'
    await w.clock.advance(100)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
    expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
      [1, 0],
      [1, 100],
    ])
    // The deck forgets the session (release rule 4, or a current instance that stopped polling): it answers the poll
    // it holds with no commands, and the poll after it, at once, with 409 hello first.
    await w.clock.advance(c.after)
    const at = 100 + c.after
    w.forget()
    await w.settle()
    expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, at])
    if (c.second) {
      expect(w.logs).toHaveLength(1)
      expect(w.logs[0]).toMatch(/isn't answering \(a poll was answered 409 hello first\)/)
      await w.clock.advance(999)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
      await w.clock.advance(1)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, at + 1000])
      expect(w.logs).toHaveLength(1)
    } else {
      expect(w.logs).toEqual([])
      await w.clock.advance(99)
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
      await w.clock.advance(1)
      // The same hello, then the poll, which the deck holds again, and the event once more under its seq.
      expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, at + 100])
      expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100, at, at + 100])
      expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
        [1, 0],
        [1, 100],
        [1, at + 100],
      ])
      expect(w.logs).toEqual([])
    }
  })
}

test("the quick hello's own failure is the second whenever it comes, since the window opens only at its answer: a quick hello the deck takes, leaves unanswered and drops 5 s later begins the outage, with its one log line and hello 1 s later", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // A Deny abandons the open poll, and the deck takes the quick hello 100 ms later and leaves it unanswered.
  w.bridge.mode = 'hang'
  w.abandonOpen()
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.logs).toEqual([])
  // 5 s on, the connection drops with that hello still unanswered.
  await w.clock.advance(5000)
  w.bridge.mode = 'up'
  w.abandonOpen()
  await w.settle()
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/isn't answering \(.*aborted/)
  await w.clock.advance(999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 6100])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 6100])
  expect(w.logs).toHaveLength(1)
})

test("a quick hello whose request went through is over, its window with it: a later quick hello's window runs from its own answer, so a poll abandoned 0.9 s after that answer, though 2.4 s after the first one's, begins the outage", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // An event's fetch is abandoned: a quick hello 100 ms later, then the event goes again and through.
  w.abandon('/v1/events')
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.clock.advance(100)
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 100],
  ])
  // 1.4 s on, a Deny abandons the poll that hello opened: a first failure, since the event went through, so a quick
  // hello 100 ms later.
  await w.clock.advance(1400)
  w.abandonOpen()
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1600])
  expect(w.logs).toEqual([])
  // 0.9 s after that hello's answer, 2.4 s after the first's, an Esc abandons the poll it opened: the second failure.
  await w.clock.advance(900)
  w.abandonOpen()
  await w.settle()
  expect(w.logs).toHaveLength(1)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1600, 3500])
  expect(w.logs).toHaveLength(1)
})

test("a quick hello that met its second failure is over, its window with it: once that outage ends, a later quick hello's window runs from its own answer, so a poll abandoned 1 s after that answer, though 2.2 s after the first one's, begins an outage", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // An event's fetch is abandoned: a quick hello 100 ms later, and the event that goes again after it is answered
  // 503, the second failure: an outage, with its line and hello 1 s later. The event goes through after that hello.
  w.abandon('/v1/events')
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(1)
  w.bridge.events = 204
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 100],
    [1, 1100],
  ])
  // A Deny abandons the poll that hello opened: a first failure, since the outage is over, so a quick hello.
  await w.clock.advance(100)
  w.abandonOpen()
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 1300])
  expect(w.logs).toHaveLength(1)
  // 1 s after that hello's answer, 2.2 s after the first's, an Esc abandons the poll it opened: the second failure.
  await w.clock.advance(1000)
  w.abandonOpen()
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 1300, 3300])
  expect(w.logs).toHaveLength(2)
})

test('a rejection ends its epoch, so the poll left open in it changes nothing when its 35 s run out before the quick hello: no outage, and the poll the hello opens has 35 s of its own', async ($, on) => {
  const w = world(on)
  w.bridge.pollHold = Number.POSITIVE_INFINITY
  await $.session.start(START)
  await w.clock.advance(34_950)
  w.abandon('/v1/events')
  await $.turn.start({ text: 'a', turnId: 't1' })
  // The first poll's 35 s run out between the event's rejection and its quick hello.
  await w.clock.advance(100)
  expect(w.logs).toEqual([])
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 35_050])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 34_950],
    [1, 35_050],
  ])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 35_050])
  await w.clock.advance(34_999)
  expect(w.logs).toEqual([])
  await w.clock.advance(1)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/a poll had no answer after 35 s/)
})

/** Late answers to a poll from an epoch that has ended: the check for its epoch comes before the 409's. */
const LATE: readonly { what: string; reply: Reply }[] = [
  { what: '409 hello first', reply: HELLO_FIRST },
  { what: '503', reply: { status: 503, body: { error: 'starting' } } },
]

for (const late of LATE) {
  test(`a poll answered ${late.what} once another request's rejection has ended its epoch changes nothing: the quick hello that rejection asked for comes alone, 100 ms on, with no log line and no outage`, async ($, on) => {
    const w = world(on, { mode: 'hang' })
    await $.session.start(START)
    await w.settle()
    // The deck answers the hello late, then takes the poll after it and leaves it unanswered.
    w.answerHung(200, { v: 1, ok: true })
    await w.settle()
    expect(w.to('/v1/next').map(r => r.at)).toEqual([0])
    // An event's fetch is abandoned, which ends the epoch that poll is open in.
    w.bridge.mode = 'up'
    w.abandon('/v1/events')
    await $.turn.start({ text: 'a', turnId: 't1' })
    await w.settle()
    // The poll's answer comes before the quick hello, from an epoch that's over.
    w.answerHung(late.reply.status, late.reply.body)
    await w.settle()
    expect(w.logs).toEqual([])
    await w.clock.advance(99)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
    await w.clock.advance(1)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
    expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 100])
    expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
      [1, 0],
      [1, 100],
    ])
    await w.clock.advance(60_000)
    expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
    expect(w.logs).toEqual([])
  })
}

test('after a quick hello, the request that goes again fails as any request does: answered 5xx, the outage begins as the answer comes; left unanswered, 35 s after it went again', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.abandon('/v1/events')
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.clock.advance(100)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/\/v1\/events was answered 503/)
  w.bridge.events = 204
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 100],
    [1, 1100],
  ])

  // That event went through, so a rejection and then a stall is a new outage, from 35 s after the event went again.
  w.abandon('/v1/events')
  w.bridge.events = 'hang'
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.clock.advance(35_099)
  expect(w.logs).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.logs).toHaveLength(2)
  expect(w.logs[1]).toMatch(/\/v1\/events had no answer after 35 s/)
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at]).slice(3)).toEqual([
    [2, 1100],
    [2, 1200],
  ])
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 1200])
})

test('an answer of any status, or a stall, is no rejection: a hello answered 503, an event answered 503 and a stalled poll each begin the outage at once, with no quick hello; and a rejection in an outage has none either, but waits its turn', async ($, on) => {
  const w = world(on)
  w.bridge.hello = { status: 503, body: { error: 'starting' } }
  w.bridge.pollHold = Number.POSITIVE_INFINITY
  await $.session.start(START)
  await w.clock.advance(999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0])
  expect(w.logs).toHaveLength(1)
  w.bridge.hello = { status: 200, body: { v: 1, ok: true } }
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000])

  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.clock.advance(999)
  expect(w.to('/v1/events').map(r => r.at)).toEqual([1000])
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000])
  expect(w.logs).toHaveLength(2)
  // The hello 1 s later is rejected: in the event's outage that's one more failure, so the next hello waits its 2 s.
  w.bridge.events = 204
  w.abandon('/v1/hello')
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000])
  await w.clock.advance(1999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000])
  await w.clock.advance(1)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000, 4000])
  expect(w.to('/v1/events').map(r => r.at)).toEqual([1000, 4000])
  expect(w.logs).toHaveLength(2)

  // The poll that opened with that hello is never answered.
  await w.clock.advance(34_999)
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1)
  expect(w.logs).toHaveLength(3)
  expect(w.logs[2]).toMatch(/a poll had no answer after 35 s/)
  await w.clock.advance(999)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000, 4000])
  await w.clock.advance(1)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([1000, 4000, 40_000])
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000, 4000, 40_000])
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

test('a bridge that answers each hello but 503s the event: the outage goes on, hello backs off 1, 2, 5, 10 and 30 s, then every 30 s, and logs once; once the event goes through, the next outage starts over', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  await w.clock.advance(108_000)
  // Each hello is answered and the event goes again, and fails again: an answered hello alone ends no outage.
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000, 18_000, 48_000, 78_000, 108_000])
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 1000],
    [1, 3000],
    [1, 8000],
    [1, 18_000],
    [1, 48_000],
    [1, 78_000],
    [1, 108_000],
  ])
  expect(w.logs).toHaveLength(1)

  // The event goes through after the next hello, which ends the outage. A later failure begins a new one, with a
  // line of its own and hello again after 1 s, then 2 s.
  w.bridge.events = 204
  await w.clock.advance(30_000)
  w.bridge.events = 503
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(3000)
  expect(w.to('/v1/hello').map(r => r.at).slice(8)).toEqual([138_000, 139_000, 141_000])
  expect(w.to('/v1/events').slice(8).map(r => [r.body.seq, r.at])).toEqual([
    [1, 138_000],
    [2, 138_000],
    [2, 139_000],
    [2, 141_000],
  ])
  expect(w.logs).toHaveLength(2)
})

test('a bridge that answers each hello but never the event: each send fails after 35 s, and hello backs off 1, 2, 5, 10 and 30 s past each, logging once; the event answered at last ends the outage', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.events = 'hang'
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  await w.clock.advance(288_000)
  // The polls are answered all along, each after its 20 s, and end nothing: the event began the outage.
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 36_000, 73_000, 113_000, 158_000, 223_000, 288_000])
  expect(w.to('/v1/events').map(r => r.at)).toEqual([0, 36_000, 73_000, 113_000, 158_000, 223_000, 288_000])
  expect(w.to('/v1/next').filter(r => r.at === 56_000)).toHaveLength(1)
  expect(w.logs).toHaveLength(1)

  // The bridge answers the latest send within its 35 s: the event went through, so a later failure is a new outage.
  w.answerHung(204)
  await w.settle()
  w.bridge.events = 503
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at).slice(7)).toEqual([289_000])
})

test('a bridge that answers each hello but never a poll: hello backs off past each 35 s stall and logs once, events going through meanwhile end nothing, and a poll answered ends the outage', async ($, on) => {
  const w = world(on)
  w.bridge.pollHold = Number.POSITIVE_INFINITY
  await $.session.start(START)
  await w.settle()
  await w.clock.advance(40_000)
  expect(w.logs).toHaveLength(1)
  // An event goes through between the stalls: it isn't the request that failed, so the outage goes on.
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  expect(w.to('/v1/events').map(r => r.at)).toEqual([40_000])
  await w.clock.advance(248_000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 36_000, 73_000, 113_000, 158_000, 223_000, 288_000])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 36_000, 73_000, 113_000, 158_000, 223_000, 288_000])
  expect(w.logs).toHaveLength(1)

  // Polls are answered again: after the next stall and hello, the poll goes through in its 20 s and the outage is
  // over, so a later failure is a new one, with a line of its own and hello again after 1 s.
  w.bridge.pollHold = undefined
  await w.clock.advance(85_000)
  expect(w.to('/v1/hello').map(r => r.at).slice(7)).toEqual([353_000])
  expect(w.logs).toHaveLength(1)
  w.bridge.events = 503
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at).slice(7)).toEqual([353_000, 374_000])
})

test('a model that changed twice while the bridge was away, once before a turn ended and once after: the deck ends on the model now', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // The deck restarts, and the quick hello 100 ms later is refused too. While it's away the model changes, a turn
  // ends (which queues that model), and the model changes again.
  w.bridge.mode = 'down'
  w.drop()
  await w.clock.advance(100)
  w.session.model = 'claude-sonnet-5-5'
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
  w.session.model = 'claude-opus-5-5'
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  // The hello tells the model now, the queued settings the one before, and a settings event the model now again.
  const told = w.sent
    .filter(r => r.at === 1100 && r.route !== '/v1/next')
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
  // The deck restarts, and the quick hello 100 ms later, still with the model then, is refused too.
  w.bridge.mode = 'down'
  w.drop()
  await w.clock.advance(100)
  w.session.model = 'claude-opus-5-5'
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.body.model)).toEqual([MODEL, MODEL, 'claude-opus-5-5'])
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

test("a model the mod can't read is left out of the hello, though the deck was told one before; once it reads again, the deck hears it", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // The deck restarts, refusing the quick hello 100 ms later too, and while it's away the model can't be read.
  w.bridge.mode = 'down'
  w.drop()
  await w.clock.advance(100)
  w.session.model = undefined
  w.bridge.mode = 'up'
  await w.clock.advance(1000)
  const hellos = w.to('/v1/hello')
  expect(hellos.map(r => r.at)).toEqual([0, 100, 1100])
  expect(hellos[0]?.body.model).toBe(MODEL)
  expect(hellos[2]?.body).not.toHaveProperty('model')
  // A deck that restarted knows no model from this mod now, so the model goes out once it reads, though unchanged.
  w.session.model = MODEL
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
  expect(w.settings()).toEqual([{ model: MODEL }])
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

test('a poll answered at once with only commands the mod skips waits out the second too: none with a string id, or one it ran already', async ($, on) => {
  const submitted: string[] = []
  const w = world(on, {
    submit: text => {
      submitted.push(text)
      return undefined
    },
  })
  await $.session.start(START)
  await w.settle()
  w.deliver([
    { t: 'prompt', text: 'no id' },
    { id: 7, t: 'prompt', text: 'a number for an id' },
  ])
  await w.settle()
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0])
  await w.clock.advance(1000)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000])
  // A command it runs: the next poll goes at once. The same id again is skipped: the poll after it waits.
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Once.' }])
  await w.settle()
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Once.' }])
  await w.settle()
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 1000])
  await w.clock.advance(1000)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 1000, 2000])
  expect(submitted).toEqual(['Once.'])
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

test('a result answered 4xx, or an event answered 3xx, is dropped and logged once, and is no failure: no hello, and the line goes on', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.result = 409
  w.bridge.events = 302
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Go.' }])
  await w.settle()
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.results()).toEqual([
    { id: 'c1', state: 'waiting' },
    { id: 'c1', state: 'done' },
  ])
  expect(w.events().map(x => x.seq)).toEqual([1, 2])
  expect(w.logs).toEqual([
    'The Stream Deck bridge refused a /v1/result request with 409; it was dropped.',
    'The Stream Deck bridge refused a /v1/events request with 302; it was dropped.',
  ])
  await w.clock.advance(60_000)
  expect(w.to('/v1/hello')).toHaveLength(1)
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 0, 20_000, 40_000, 60_000])
})

test('an event answered with any status under 500 has gone through: the one that began an outage, answered 404 after the hello, ends it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  w.bridge.events = 404
  await w.clock.advance(1000)
  expect(w.to('/v1/events').map(r => [r.body.seq, r.at])).toEqual([
    [1, 0],
    [1, 1000],
  ])
  expect(w.logs).toHaveLength(2)
  expect(w.logs[1]).toMatch(/refused a \/v1\/events request with 404/)
  // So the next failure is a new outage: a line of its own, and hello 1 s after it, not 2.
  w.bridge.events = 503
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.settle()
  expect(w.logs).toHaveLength(3)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000])
})

test('a result answered with any status under 500 has gone through too: the one that began an outage, answered 302 after the hello, ends it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.bridge.result = 503
  w.deliver([{ id: 'c1', t: 'prompt', text: 'Go.' }])
  await w.settle()
  expect(w.logs).toHaveLength(1)
  w.bridge.result = 302
  await w.clock.advance(1000)
  expect(w.to('/v1/result').map(r => [r.body.state, r.at])).toEqual([
    ['waiting', 0],
    ['waiting', 1000],
    ['done', 1000],
  ])
  expect(w.logs).toHaveLength(2)
  expect(w.logs[1]).toMatch(/refused a \/v1\/result request with 302/)
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  expect(w.logs).toHaveLength(3)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 2000])
})

test('a poll outage ends only with a 2xx: a poll answered 404 after each hello fails again in the same outage, with no line of its own, and the waits go on', async ($, on) => {
  const w = world(on)
  w.bridge.poll = { status: 503, body: { error: 'starting' } }
  await $.session.start(START)
  await w.settle()
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/a poll was answered 503/)
  // A 404 would end an outage an event or result began; a poll's is another failure, and the waits go on.
  w.bridge.poll = { status: 404, body: { error: 'no such route' } }
  await w.clock.advance(8000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 3000, 8000])
  expect(w.logs).toHaveLength(1)

  // Polls are held again: the one after the next hello is answered in its 20 s and ends the outage, so a later
  // failure is a new one, with a line of its own and hello 1 s after it.
  w.bridge.poll = undefined
  await w.clock.advance(30_000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 1000, 3000, 8000, 18_000])
  w.bridge.events = 503
  await $.turn.start({ text: 'a', turnId: 't1' })
  await w.settle()
  expect(w.logs).toHaveLength(2)
  await w.clock.advance(1000)
  expect(w.to('/v1/hello').map(r => r.at).slice(5)).toEqual([39_000])
})

test("a version-shaped answer to an event or a poll stops nothing: only a hello's answer can stop the mod", async ($, on) => {
  const w = world(on)
  const version = { v: 2, ok: false, error: 'version' }
  w.bridge.events = { status: 200, body: version }
  w.bridge.poll = { status: 200, body: version }
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.start({ text: 'b', turnId: 't2' })
  await w.clock.advance(2000)
  // The events went through, one after the other, and the polls go on a second apart: an answer with no command.
  expect(w.events().map(x => x.seq)).toEqual([1, 2])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 2000])
  expect(w.logs).toEqual([])

  // Answered 400, the same body drops an event and fails a poll: the mod says hello again, and goes on.
  w.bridge.events = { status: 400, body: version }
  w.bridge.poll = { status: 400, body: version }
  await $.turn.start({ text: 'c', turnId: 't3' })
  await w.clock.advance(2000)
  expect(w.events().map(x => x.seq)).toEqual([1, 2, 3])
  expect(w.to('/v1/next').map(r => r.at)).toEqual([0, 1000, 2000, 3000, 4000])
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 4000])
  expect(w.logs).toHaveLength(2)
  expect(w.logs[0]).toMatch(/refused a \/v1\/events request with 400/)
  expect(w.logs[1]).toMatch(/a poll was answered 400/)

  // A hello answered with it stops the mod.
  w.bridge.hello = { status: 200, body: version }
  await w.clock.advance(300_000)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 4000, 6000])
  expect(w.sent.filter(r => r.at > 6000)).toEqual([])
  expect(w.logs).toHaveLength(3)
  expect(w.logs[2]).toMatch(/protocol version 2/)
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
  // A refused send, then the quick hello refused too, begin the outage: each error's text holds the token.
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
  await w.clock.advance(100)
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
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(2)
  const line = w.logs[1] ?? ''
  expect(line).toContain(`${filler}<token…`)
  for (let i = 0; i + 5 <= TOKEN.length; i++) expect(line).not.toContain(TOKEN.slice(i, i + 5))
})

test("a piece of the token 8 characters or longer is hidden too, as in an error's text the engine had already cut short", async ($, on) => {
  const w = world(on, { mode: 'down' })
  w.bridge.refusal = `connect ECONNREFUSED (Authorization: Bearer ${TOKEN.slice(0, 12)}…) after ${TOKEN.slice(9)}`
  await $.session.start(START)
  await w.clock.advance(100)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toContain('(Authorization: Bearer <token>…) after <token>)')
  for (let i = 0; i + 8 <= TOKEN.length; i++) expect(w.logs[0]).not.toContain(TOKEN.slice(i, i + 8))
})
