// The world beneath the mod, for the tests. Every `on` here stands for the engine (the test kit puts the test's
// hooks beneath the plugin), and the bridge answers from memory, so nothing touches the network. Tests change
// how it behaves through the returned object, never with `on`: the kit takes no hooks after the first call on `$`.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const TOKEN = 'tok-0123456789abcdef'
export const HOST = 'local_test-1'
export const SID = '3fa86955-0000-4000-8000-0000000000aa'
export const MODEL = 'claude-haiku-5-5'
export const BRIDGE = 'http://127.0.0.1:47600'
export const START = { cwd: '/sandbox', surface: null, isInteractive: false } as const

/** A request the mod sent: what the bridge would see, and the mock clock's time it came at. */
export type Sent = {
  method: string
  route: string
  query: Record<string, string>
  headers: Record<string, string>
  // Parsed JSON, as sent: the tests read into it freely.
  body: any
  at: number
}

type HttpValue = { status: number; ok: boolean; headers: Record<string, string>; text: string }
type Answer = { value: HttpValue } | { deny: string }

/** How the fake bridge behaves: answering, refusing connections (down), or taking requests it leaves unanswered (hang). */
export type Mode = 'up' | 'down' | 'hang'

export type WorldOptions = {
  /** The environment `$.env.get` reads; by default the token and the host id. */
  env?: Record<string, string>
  mode?: Mode
  /** Answers `$.prompt.submit`: a drop reason refuses it; by default the prompt enters. */
  submit?: (text: string) => string | undefined
  /** Answers `$.mcp.call` (`{ value }` or `{ deny }`); by default the mode changes. */
  mcp?: (e: { server: string; tool: string; args: Record<string, unknown> }) => unknown
}

const answer = (status: number, body?: unknown): Answer => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) },
})

export function world(on: On, o: WorldOptions = {}) {
  const sent: Sent[] = []
  const logs: string[] = []
  const held: { req: Sent; reply: (a: Answer) => void }[] = []
  /** Requests the bridge took and left unanswered: all of them in mode `hang`, or a route's set to `'hang'`. */
  const hung: { req: Sent; reply: (a: Answer) => void }[] = []
  const bridge = {
    mode: o.mode ?? ('up' as Mode),
    hello: { status: 200, body: { v: 1, ok: true } as unknown },
    /** The status events and results are answered with, or `'hang'` to take them and never answer. */
    events: 204 as number | 'hang',
    result: 204 as number | 'hang',
    /** Seconds the bridge holds a poll with nothing to send: the poll's own `wait` when undefined. */
    pollHold: undefined as number | undefined,
    /** The reason a refused connection gives. */
    refusal: 'connect ECONNREFUSED 127.0.0.1:47600',
  }
  const session = { sid: SID, model: MODEL, version: '2.1.309' }
  /** Answers each `$.tool.call`, standing for the tool itself. */
  const engine = {
    tool: (_e: Record<string, unknown>): unknown => ({ result: 'ran' }),
  }

  const clock = mock.clock(on)
  mock.env(on, o.env ?? { DECK_TOKEN: TOKEN, CLAUDE_CODE_HOST_SESSION_ID: HOST })
  on('session.id', () => ({ value: session.sid }))
  on('session.model', () => ({ value: session.model }))
  on('session.cwd', () => ({ value: '/sandbox' }))
  on('session.version', () => ({ value: { version: session.version } }))
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    const drop = o.submit?.(e.text)
    return drop === undefined ? { text: e.text, origin: e.origin } : { drop }
  })
  on('mcp.call', (_$, e) => {
    if (o.mcp !== undefined) return o.mcp(e) as { value: { content: never[]; isError: boolean } }
    return { value: { content: [{ type: 'text' as const, text: `This session now runs in ${String(e.args.mode)} mode.` }], isError: false } }
  })

  function answerPoll(entry: { req: Sent; reply: (a: Answer) => void }, cmds: unknown[]): void {
    const i = held.indexOf(entry)
    if (i < 0) return
    held.splice(i, 1)
    entry.reply(answer(200, { cmds }))
  }

  function hang(req: Sent): Promise<Answer> {
    return new Promise<Answer>(reply => {
      hung.push({ req, reply })
    })
  }

  on('http.fetch', (_$, e) => {
    const init = e.init ?? {}
    const url = new URL(e.url)
    const query: Record<string, string> = {}
    url.searchParams.forEach((v, k) => {
      query[k] = v
    })
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
    const req: Sent = {
      method: init.method ?? 'GET',
      route: url.pathname,
      query,
      headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      at: clock.now(),
    }
    sent.push(req)
    if (`${url.protocol}//${url.host}` !== BRIDGE) return { deny: `not the bridge: ${e.url}` }
    if (bridge.mode === 'down') return { deny: bridge.refusal }
    if (bridge.mode === 'hang') return hang(req)
    switch (req.route) {
      case '/v1/hello':
        return answer(bridge.hello.status, bridge.hello.body)
      case '/v1/events':
        return bridge.events === 'hang' ? hang(req) : answer(bridge.events)
      case '/v1/result':
        return bridge.result === 'hang' ? hang(req) : answer(bridge.result)
      case '/v1/next':
        return new Promise<Answer>(reply => {
          const entry = { req, reply }
          held.push(entry)
          const hold = bridge.pollHold ?? Number(req.query.wait ?? '20')
          if (hold === 0) answerPoll(entry, [])
          else if (Number.isFinite(hold)) void clock.sleep(hold * 1000).then(() => answerPoll(entry, []))
        })
      default:
        return answer(404, { error: 'no such route' })
    }
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => engine.tool(e as unknown as Record<string, unknown>) as { result: string })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.StopFailure', () => ({}))

  const to = (route: string): Sent[] => sent.filter(r => r.route === route)

  return {
    sent,
    logs,
    bridge,
    session,
    engine,
    clock,
    to,
    /** Every event the mod sent, in order, with its request's seq; a request sent twice shows twice. */
    events: (): { seq: number; event: any }[] =>
      to('/v1/events').flatMap(r => (r.body.events as unknown[]).map(event => ({ seq: r.body.seq as number, event }))),
    /** The settings events' fields, without `t` and `at`. */
    settings: (): Record<string, unknown>[] =>
      to('/v1/events')
        .flatMap(r => r.body.events as Record<string, unknown>[])
        .filter(x => x.t === 'settings')
        .map(({ t: _t, at: _at, ...fields }) => fields),
    /** Every command result the mod sent, without the session's ids. */
    results: (): Record<string, unknown>[] =>
      to('/v1/result').map(r => {
        const { sid: _sid, host: _host, inst: _inst, ...rest } = r.body as Record<string, unknown>
        return rest
      }),
    /** Answers the oldest held poll with these commands, as the deck does after a key press. */
    deliver: (cmds: unknown[]): void => {
      const entry = held[0]
      if (entry === undefined) throw new Error('no poll is open to deliver commands to')
      answerPoll(entry, cmds)
    },
    /** The deck restarts: every held poll's connection drops. */
    drop: (): void => {
      for (const entry of held.splice(0)) entry.reply({ deny: 'socket hang up' })
    },
    /** The bridge wakes up late: answers every request it left hanging, oldest first. */
    answerHung: (status: number, body?: unknown): void => {
      for (const entry of hung.splice(0)) entry.reply(answer(status, body))
    },
    /** Lets everything under way run without moving the clock. */
    settle: async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await clock.settle()
    },
  }
}
