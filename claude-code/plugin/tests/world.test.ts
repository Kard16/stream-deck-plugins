// The test world's own check (world.ts, MAX_AT_ONCE): a mod that sends again at once without end runs on promises
// alone, so no timer, the test's timeout included, fires again, and `claude plugin test` would hang. The fake bridge
// fails such a loop's test instead, whatever route the loop sends on, and stops the mod.
//
// Here a plugin beside the mod sends the requests, as a loop of the mod's would, and the test takes the check's
// failure through `onBusyLoop` so as not to fail. A test's `$` raises the engine's events but can't fetch, so the
// sender is a plugin of its own: each `$.tool.describe`, an event nothing else here hooks, sends one request.

import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { MAX_AT_ONCE, START, world } from './world'

/**
 * Sends one request to the bridge per `$.tool.describe`, to the route the tool names, and answers with what became of
 * it: its route, status and body, or its route and the refusal's text. The engine loads a plugin from its source, so
 * this one names the bridge itself and uses nothing else of this file's.
 */
const sender: Register = on => {
  on('tool.describe', async ($, e) => {
    const route = `/v1/${e.tool}`
    try {
      const init = route === '/v1/next' ? { method: 'GET' } : { method: 'POST', body: '{}' }
      const res = await $.http.fetch(`http://127.0.0.1:47600${route}`, init)
      return { description: `${route} ${res.status} ${res.text}`.trim() }
    } catch (err) {
      return { description: `${route} refused: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}

test(`past ${MAX_AT_ONCE} requests at one time on the clock, whatever their routes, the next fails the busy-loop check and is refused; from then on every request is left unanswered but a hello, which is answered as another protocol version, so the mod stops`, { plugins: [{ name: 'sender', register: sender }] }, async ($, on) => {
  const caught: string[] = []
  const w = world(on, { onBusyLoop: what => caught.push(what) })
  const send = async (tool: string): Promise<string> =>
    (await $.tool.describe({ tool, description: '', provider: { plugin: 'engine', tier: 'core' } })).description
  // Every poll answered at once, as a 409 hello first is, so each route here answers at once.
  w.bridge.poll = { status: 200, body: { cmds: [] } }
  const routes = ['hello', 'next', 'events', 'result']
  const answered = new Set([
    '/v1/hello 200 {"v":1,"ok":true}',
    '/v1/next 200 {"cmds":[]}',
    '/v1/events 204',
    '/v1/result 204',
  ])
  /** `n` requests, each route in turn, each sent once the last one's answered, as a loop's are: what they got. */
  const loop = async (n: number): Promise<Set<string>> => {
    const got = new Set<string>()
    for (let i = 0; i < n; i++) got.add(await send(routes[i % routes.length] ?? ''))
    return got
  }

  // As many as that at one time are answered; the clock moves on and the count starts again, so as many again are too.
  expect(await loop(MAX_AT_ONCE)).toEqual(answered)
  await w.clock.advance(1)
  expect(await loop(MAX_AT_ONCE)).toEqual(answered)
  expect(caught).toEqual([])

  // One more then, an event, fails the check, which counts each route's requests, and its fetch is refused.
  expect(await send('events')).toMatch(/^\/v1\/events refused: .*as in a busy loop/)
  expect(caught).toHaveLength(1)
  expect(caught[0]).toContain(`${MAX_AT_ONCE + 1} requests at 1 ms on the clock, as in a busy loop (`)
  for (const route of routes) expect(caught[0]).toMatch(new RegExp(`\\d+ to /v1/${route}\\b`))

  // From then on, whatever the time, every request but a hello is never answered: a loop that sends again at once,
  // on that refusal too, stops there.
  const late: string[] = []
  for (const route of ['next', 'events', 'result']) void send(route).then(got => late.push(got))
  await w.settle()
  await w.clock.advance(60_000)
  expect(late).toEqual([])
  expect(await send('hello')).toBe('/v1/hello 200 {"v":0,"ok":false,"error":"version"}')

  // A hello is answered as a deck on another protocol version: the mod's own stops it, and it sends nothing more.
  const before = w.sent.length
  await $.session.start(START)
  await w.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await w.clock.advance(60_000)
  expect(w.sent.slice(before).map(r => r.route)).toEqual(['/v1/hello'])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/protocol version 0 and this plugin 1, so this session stops talking to it/)
  expect(caught).toHaveLength(1)
})
