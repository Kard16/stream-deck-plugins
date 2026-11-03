// The plugin side of the protocol's fixtures (PROTOCOL.md, "Fixtures"): each conversation with `mod` lines is
// played against the real mod, through the engine's own test kit.
//
// Beneath the mod, the runner answers `$.session.*` and `$.env.get` from the fixture's setup, as a desktop session
// of its own (PROTOCOL.md, "Desktop sessions only"): CLAUDE_CODE_ENTRYPOINT is claude-desktop, and CLAUDECODE,
// CLAUDE_CODE_CHILD_SESSION and CLAUDE_CODE_TAGS are unset. It answers `$.prompt.submit` and `$.mcp.call` from the
// fixture's `engine` lines (checking their arguments), and each engine event with the `mod` line's result. It
// stands for the bridge too: hello answers {"v": 1, "ok": true}, events and results 204, and a poll nothing, unless
// a `reply` line says otherwise. Each request the mod sends must be the fixture's next `plugin` line (polls in order
// among themselves), with the token in its Authorization header, and the mod may send nothing more. Lines about
// /v1/permission and /v1/pretool, which Claude Code's hooks send, not the mod, and lines about other sessions,
// presses, the registry and the deck's state are the deck side's.

import type { On } from 'claude-code'
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import { POLL_MIN_MS } from '../hooks/bridge'
import { FIXTURES } from './fixtures.gen'

const BRIDGE = 'http://127.0.0.1:47600'

// Fixture lines are JSON: the runner reads into them freely.
type Json = any

type Req = {
  method: string
  route: string
  query: Record<string, string>
  headers: Record<string, string>
  body: Json
  reply: (status: number, body?: unknown) => void
}

type Answer = { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } }

const answer = (status: number, body?: unknown): Answer => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) },
})

function parsePath(path: string): { route: string; query: Record<string, string> } {
  const url = new URL(path, BRIDGE)
  const query: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    query[k] = v
  })
  return { route: url.pathname, query }
}

/** A `tool.call` answer from the fixture's result: the kit takes `{ result }` or `{ deny }`, nothing else. */
const toolAnswer = (r: Json): unknown =>
  r !== undefined && typeof r.deny === 'string'
    ? { deny: r.deny }
    : { result: r?.result ?? '', ...(r?.isError === true ? { isError: true } : {}) }

async function settle(clock: MockClock): Promise<void> {
  for (let i = 0; i < 5; i++) await clock.settle()
}

/** Raises an engine event through the plugin, as a session would. */
function raise($: Engine, event: string, e: Json): Promise<unknown> {
  switch (event) {
    case 'session.start':
      return $.session.start(e)
    case 'session.end':
      return $.session.end(e)
    case 'session.attach':
      return $.session.attach(e)
    case 'session.detach':
      return $.session.detach(e)
    case 'session.measure':
      return $.session.measure(e)
    case 'turn.start':
      return $.turn.start(e)
    case 'turn.complete':
      return $.turn.complete(e)
    case 'tool.call':
      return $.tool.call(e)
    case 'classic.UserPromptSubmit':
      return $.classic.UserPromptSubmit(e)
    case 'classic.PostToolUse':
      return $.classic.PostToolUse(e)
    case 'classic.PostToolUseFailure':
      return $.classic.PostToolUseFailure(e)
    case 'classic.Stop':
      return $.classic.Stop(e)
    case 'classic.StopFailure':
      return $.classic.StopFailure(e)
    default:
      return Promise.reject(new Error(`this runner can't raise ${event}`))
  }
}

async function play($: Engine, on: On, lines: readonly Json[]): Promise<string[]> {
  const problems: string[] = []
  const s = lines.find(l => 'setup' in l)?.setup?.session as { sid: string; host: string; model: string; cwd: string; token: string }

  // The engine's answers, in order, per call.
  const engine = new Map<string, Json[]>()
  for (const l of lines) if ('engine' in l) engine.set(l.engine.call, [...(engine.get(l.engine.call) ?? []), l.engine])
  const take = (call: string): Json | undefined => engine.get(call)?.shift()

  // Requests a reply line answers wait for it; the others get the default answer once matched.
  const replied = new Set(lines.filter(l => 'reply' in l).map(l => l.reply.to))
  const polls: Req[] = []
  const others: Req[] = []
  /** What next(e) resolves to beneath the mod for the `mod` line being played. */
  let result: Json

  /** "The plugin side binds the mod's real inst to the fixture's at its first appearance." */
  const insts = new Map<string, string>()
  function bindInst(fixture: string, real: unknown, at: string): void {
    const bound = insts.get(fixture)
    if (bound === undefined) {
      if (typeof real === 'string' && real !== '') insts.set(fixture, real)
      else problems.push(`${at}: inst is ${JSON.stringify(real)}`)
    } else if (real !== bound) problems.push(`${at}: inst is ${JSON.stringify(real)}, not the ${JSON.stringify(bound)} it was`)
  }

  /** Every expected field present and equal, extra fields allowed, "*" any value, `at` never compared. */
  function match(x: Json, a: Json, at: string): void {
    if (x === '*') return
    if (Array.isArray(x)) {
      if (!Array.isArray(a) || a.length !== x.length) {
        problems.push(`${at}: expected ${x.length} items, got ${JSON.stringify(a)}`)
        return
      }
      x.forEach((xi, i) => match(xi, a[i], `${at}[${i}]`))
      return
    }
    if (x !== null && typeof x === 'object') {
      if (a === null || typeof a !== 'object' || Array.isArray(a)) {
        problems.push(`${at}: expected an object, got ${JSON.stringify(a)}`)
        return
      }
      for (const [k, xv] of Object.entries(x)) {
        if (k === 'at') continue
        if (!(k in a)) problems.push(`${at}.${k}: missing, expected ${JSON.stringify(xv)}`)
        else if (k === 'inst' && typeof xv === 'string') bindInst(xv, a[k], `${at}.inst`)
        else match(xv, a[k], `${at}.${k}`)
      }
      return
    }
    if (!Object.is(x, a)) problems.push(`${at}: expected ${JSON.stringify(x)}, got ${JSON.stringify(a)}`)
  }

  function compare(p: Json, route: string, query: Record<string, string>, req: Req, at: string): void {
    if (req.method !== p.method || req.route !== route) {
      problems.push(`${at}: the mod sent ${req.method} ${req.route}`)
      return
    }
    for (const [k, v] of Object.entries(query)) {
      if (k === 'inst') bindInst(v, req.query.inst, `${at} query inst`)
      else if (req.query[k] !== v) problems.push(`${at}: query ${k} is ${JSON.stringify(req.query[k])}, not ${JSON.stringify(v)}`)
    }
    for (const [k, v] of Object.entries((p.headers ?? {}) as Record<string, string | null>)) {
      const want = v === null ? undefined : v.replaceAll('$TOKEN', s.token)
      if (req.headers[k.toLowerCase()] !== want) problems.push(`${at}: header ${k} isn't as the fixture says`)
    }
    if (req.headers.authorization !== `Bearer ${s.token}`) problems.push(`${at}: Authorization doesn't carry the token`)
    if (p.body !== undefined) match(p.body, req.body, `${at} body`)
  }

  function answerDefault(req: Req): void {
    if (req.route === '/v1/hello') req.reply(200, { v: 1, ok: true })
    else if (req.route === '/v1/events' || req.route === '/v1/result') req.reply(204)
    else if (req.route !== '/v1/next') req.reply(404, { error: 'no such route' })
  }

  const clock = mock.clock(on)
  // A desktop session of its own; a variable not listed is unset.
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_HOST_SESSION_ID: s.host, DECK_TOKEN: s.token })
  on('session.id', () => ({ value: s.sid }))
  on('session.model', () => ({ value: s.model }))
  on('session.cwd', () => ({ value: s.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309' } }))
  on('ui.log', (_$, e) => {
    problems.push(`the mod logged: ${e.text}`)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    const x = take('prompt.submit')
    if (x === undefined) {
      problems.push(`the mod called $.prompt.submit(${JSON.stringify(e.text)}), which the fixture doesn't`)
      return { drop: 'not in the fixture' }
    }
    match(x.args, { text: e.text, asUser: e.origin?.kind === 'plugin' && e.origin.asUser === true ? true : undefined }, '$.prompt.submit')
    return x.returns
  })
  on('mcp.call', (_$, e) => {
    const x = take('mcp.call')
    if (x === undefined) {
      problems.push(`the mod called $.mcp.call(${JSON.stringify(e)}), which the fixture doesn't`)
      return { deny: 'not in the fixture' }
    }
    match(x.args, { server: e.server, tool: e.tool, args: e.args }, '$.mcp.call')
    return { value: x.returns }
  })
  on('http.fetch', (_$, e) => {
    const init = e.init ?? {}
    const url = new URL(e.url)
    if (`${url.protocol}//${url.host}` !== BRIDGE) problems.push(`the mod fetched ${e.url}, which isn't the bridge`)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
    let body: Json
    try {
      body = init.body === undefined ? undefined : JSON.parse(init.body)
    } catch {
      body = init.body
    }
    const { route, query } = parsePath(`${url.pathname}${url.search}`)
    return new Promise<Answer>(resolve => {
      const req: Req = { method: init.method ?? 'GET', route, query, headers, body, reply: (status, b) => resolve(answer(status, b)) }
      ;(route === '/v1/next' ? polls : others).push(req)
    })
  })
  on('session.start', (_$, e) => result ?? { cwd: e.cwd })
  on('session.end', (_$, e) => result ?? { sessionId: e.sessionId })
  on('session.attach', (_$, e) => result ?? { clientId: e.clientId })
  on('session.detach', (_$, e) => result ?? { clientId: e.clientId })
  on('session.measure', (_$, e) => result ?? { changed: e.changed })
  on('turn.start', (_$, e) => result ?? { turnId: e.turnId })
  on('turn.complete', (_$, e) => result ?? { text: e.answer })
  on('tool.call', () => toolAnswer(result) as { result: unknown })
  on('classic.UserPromptSubmit', () => result ?? {})
  on('classic.PostToolUse', () => result ?? {})
  on('classic.PostToolUseFailure', () => result ?? {})
  on('classic.Stop', () => result ?? {})
  on('classic.StopFailure', () => result ?? {})

  const ours = (p: Json): boolean => {
    const host = p.body?.host ?? parsePath(p.path).query.host
    return host === undefined || host === s.host
  }
  /** Labels of lines the mod doesn't send (null) or of the requests matched to them. */
  const labels = new Map<string, Req | null>()
  let pollsSeen = 0
  let othersSeen = 0

  for (const [i, line] of lines.entries()) {
    const at = `line ${i + 1}`
    if ('mod' in line) {
      result = line.mod.result
      try {
        await raise($, line.mod.on, line.mod.e)
      } catch (err) {
        problems.push(`${at}: ${line.mod.on} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      result = undefined
      await settle(clock)
    } else if ('plugin' in line) {
      const p = line.plugin
      const { route, query } = parsePath(p.path)
      // The hooks' requests: their reply lines are skipped with them.
      const hooks = route === '/v1/permission' || route === '/v1/pretool'
      if (hooks || !ours(p)) {
        if (p.as !== undefined) labels.set(p.as, null)
        continue
      }
      const isPoll = route === '/v1/next'
      const list = isPoll ? polls : others
      const n = isPoll ? pollsSeen++ : othersSeen++
      for (let k = 0; k < 20 && list.length <= n; k++) await clock.settle()
      // After an empty answer that came sooner than POLL_MIN_MS, as at a turn's end, the mod waits out the rest
      // before it polls again (PROTOCOL.md, "Commands"). The clock moves only when told to.
      if (isPoll && list.length <= n) await clock.advance(POLL_MIN_MS)
      for (let k = 0; k < 20 && list.length <= n; k++) await clock.settle()
      const req = list[n]
      if (req === undefined) {
        problems.push(`${at}: the mod never sent ${p.method} ${p.path}`)
        break
      }
      compare(p, route, query, req, `${at} (${p.method} ${route})`)
      if (p.as !== undefined) labels.set(p.as, req)
      if (p.as === undefined || !replied.has(p.as)) answerDefault(req)
      await settle(clock)
    } else if ('reply' in line) {
      const req = labels.get(line.reply.to)
      if (req === null) continue
      if (req === undefined) {
        problems.push(`${at}: a reply to ${line.reply.to}, which the mod hasn't sent`)
        break
      }
      req.reply(line.reply.status, line.reply.body)
      await settle(clock)
    }
    // note, setup and engine lines are read above; press, registry and expect lines are the deck side's.
  }

  await settle(clock)
  for (const r of others.slice(othersSeen)) problems.push(`the mod also sent ${r.method} ${r.route} ${JSON.stringify(r.body)}`)
  for (const r of polls.slice(pollsSeen)) problems.push(`the mod also polled with ${JSON.stringify(r.query)}`)
  for (const [call, left] of engine) for (const x of left) problems.push(`the mod never called $.${call}(${JSON.stringify(x.args)})`)
  return problems
}

for (const [name, lines] of Object.entries(FIXTURES)) {
  if (!lines.some(l => 'mod' in l)) {
    test(`${name}: no mod lines, so it's the deck side's alone`, () => {})
    continue
  }
  test(`${name}: the mod sends what the fixture says`, async ($, on) => {
    expect(await play($, on, lines)).toEqual([])
  })
}
