// The deck-spike mod against the engine's own test kit (claude plugin test).
// Every `on` here stands for the engine beneath the mod; http.fetch is the
// spike bridge, answered from memory, so nothing touches the network.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Sent = { url: string; method: string; headers: Record<string, string>; body: any; socketPath?: string }

/** The world beneath the mod: a stub bridge and the `$` calls its hello makes. */
function world(on: On, o: { policy?: Record<string, unknown>; down?: boolean } = {}) {
  const sent: Sent[] = []
  const logs: { text: string; to: string }[] = []
  const statuses: (string | undefined)[] = []
  const pending: unknown[] = []
  const bridge = { down: o.down ?? false, policy: o.policy ?? {} }
  on('http.fetch', (_$, e) => {
    const init = e.init ?? {}
    sent.push({
      url: e.url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      socketPath: init.socketPath,
    })
    if (bridge.down) return { deny: 'connect ECONNREFUSED 127.0.0.1:47600' }
    if (e.url.includes('/mod/next')) {
      const cmds = pending.splice(0)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ cmds, policy: bridge.policy }) } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: '/sandbox' }))
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 2_000, percent: 1 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [] }))
  on('command.list', () => ({ value: [{ name: 'model', description: 'Set the model', source: 'builtin' as const }] }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs a command', mcp: false }] }))
  on('ui.log', (_$, e) => {
    logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const to = (route: string) => sent.filter(s => s.url.endsWith(route) || s.url.includes(`${route}?`))
  const results = () => Object.fromEntries(to('/mod/result').map(s => [s.body.id, s.body]))
  const events = (name: string) => to('/mod/event').map(s => s.body).filter(b => b.event === name)
  return { sent, logs, statuses, bridge, to, results, events, queue: (...cmds: unknown[]) => void pending.push(...cmds) }
}

const ENV = {
  CLAUDE_CODE_SESSION_ID: 'sid-1',
  CLAUDE_CODE_HOST_SESSION_ID: 'local_1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  DECK_TOKEN: 'tok-1',
}

test('hello reports what $ gives; the loop polls, runs commands and caches the policy', async ($, on) => {
  const w = world(on, { policy: { toolCheck: 'deny', classicPermission: 'allow' } })
  mock.env(on, ENV)
  const clock = mock.clock(on)
  let beneath = 0
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('classic.PermissionRequest', () => {
    beneath++
    return {}
  })

  await $.session.start({ cwd: '/sandbox', surface: null, isInteractive: false })
  await clock.settle()

  const [hello] = w.to('/mod/hello')
  expect(hello?.method).toBe('POST')
  expect(hello?.headers.authorization).toBe('Bearer tok-1')
  expect(hello?.body.sid).toBe('sid-1')
  expect(hello?.body.session.id).toBe('sid-1')
  expect(hello?.body.session.model).toBe('claude-haiku-5-5')
  expect(hello?.body.session.usage.context.percent).toBe(1)
  expect(hello?.body.env).toEqual({
    CLAUDE_CODE_SESSION_ID: 'sid-1',
    CLAUDE_CODE_HOST_SESSION_ID: 'local_1',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    DECK_TOKEN_present: true,
  })
  expect(hello?.body.tokenSource).toBe('env')
  expect(hello?.body.commands).toEqual([{ name: 'model', description: 'Set the model', source: 'builtin' }])
  expect(hello?.body.tools).toEqual(['Bash'])
  expect(hello?.body.start).toEqual({ cwd: '/sandbox', surface: null, isInteractive: false })
  // Calls nobody answers fail one by one, and the hello still goes.
  expect(typeof hello?.body.errors['session.root']).toBe('string')
  expect(JSON.stringify(hello?.body).includes('tok-1')).toBe(false)
  expect(w.to('/mod/next').length).toBe(0)

  w.queue(
    { id: 'c1', t: 'model' },
    { id: 'c2', t: 'nope' },
    { id: 'c3', t: 'status', text: 'from the deck' },
    { id: 'c4', t: 'env', name: 'CLAUDE_CODE_HOST_SESSION_ID' },
    { id: 'c5', t: 'env', name: 'HOME' },
    { id: 'c6', t: 'env', name: 'DECK_TOKEN' },
    { id: 'c7', t: 'usage' },
  )
  await clock.advance(1000)
  await clock.settle()
  expect(w.to('/mod/next')[0]?.url).toBe('http://127.0.0.1:47600/mod/next?sid=sid-1')
  const r = w.results()
  expect(r.c1?.ok).toBe(true)
  expect(r.c1?.result).toBe('claude-haiku-5-5')
  expect(r.c2?.ok).toBe(false)
  expect(r.c2?.error).toMatch(/unknown t/)
  expect(r.c3?.ok).toBe(true)
  expect(w.statuses).toEqual(['from the deck'])
  expect(r.c4?.result).toBe('local_1')
  expect(r.c5?.ok).toBe(false)
  expect(r.c6?.result).toEqual({ set: true })
  expect(r.c7?.result.context.window).toBe(200_000)
  expect(typeof r.c1?.ms).toBe('number')

  // The cached policy decides both guards.
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).toEqual({ decision: 'deny', reason: 'deck spike' })
  const answered = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(answered).toEqual({ decision: { behavior: 'allow' } })
  expect(beneath).toBe(0)
  await clock.settle()
  expect(w.events('tool.check')[0]?.verdict).toEqual({ decision: 'allow' })
  expect(w.events('tool.check')[0]?.answered).toEqual({ decision: 'deny', reason: 'deck spike' })
  expect(w.events('classic.PermissionRequest')[0]?.answered).toBe('allow')
})

test('at pass, the guards hand the engine its own answers; tool calls, prompts and turns are reported', async ($, on) => {
  const w = world(on)
  mock.env(on, ENV)
  const clock = mock.clock(on)
  // A query (no tool_use_id) and an `rm` ask; a real `ls` is allowed.
  on('tool.check', (_$, e) =>
    e.tool_use_id === undefined || JSON.stringify(e.input).includes('rm')
      ? { decision: 'ask' as const, reason: 'the mode asks' }
      : { decision: 'allow' as const })
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'deny' as const, message: 'from beneath' } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/sandbox', surface: null, isInteractive: false })
  await clock.advance(1000)
  await clock.settle()

  expect(await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).toEqual({ decision: 'ask', reason: 'the mode asks' })
  expect(await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({
    decision: { behavior: 'deny', message: 'from beneath' },
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  // An ask on a real call raises classic.PermissionRequest; beneath, it is denied.
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await $.prompt.submit({ text: 'list files', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'list files', turnId: 't-1' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't-1', reason: 'answer' })
  await clock.settle()

  const perm = w.events('classic.PermissionRequest')
  expect(perm.map(p => p.phase)).toEqual(['start', 'end', 'start', 'end'])
  expect(perm[1]?.result).toEqual({ decision: { behavior: 'deny', message: 'from beneath' } })
  expect(perm[2]?.tool_input).toEqual({ command: 'rm -rf build' })
  const calls = w.events('tool.call')
  expect(calls.map(c => c.phase)).toEqual(['start', 'end', 'start', 'end'])
  expect(calls[1]?.isError).toBe(false)
  expect(calls[1]?.tool).toBe('Bash')
  expect(calls[3]?.isError === true || calls[3]?.denied !== null).toBe(true)
  const checks = w.events('tool.check')
  expect(checks.some(c => c.tool_use_id !== null && c.verdict.decision === 'allow')).toBe(true)
  const prompts = w.events('prompt.submit')
  expect(prompts.map(p => p.phase)).toEqual(['start', 'end'])
  expect(prompts[0]?.textLength).toBe('list files'.length)
  expect(prompts[0]?.origin).toEqual({ kind: 'composer' })
  expect(prompts[1]?.dropped).toBe(null)
  expect(w.events('turn.start')[0]?.turnId).toBe('t-1')
  expect(w.events('turn.complete')[0]?.reason).toBe('answer')
})

test('commands reach prompt, command, config, abort, check and the Unix socket', async ($, on) => {
  const w = world(on)
  mock.env(on, ENV)
  const clock = mock.clock(on)
  const aborted: string[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.run', (_$, e) => ({ text: `ran /${e.command} ${e.args}` }))
  on('config.set', (_$, e) => (e.key === 'locked' ? { deny: 'a policy owns it' } : { value: e.value }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))

  await $.session.start({ cwd: '/sandbox', surface: null, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't-main' })
  await $.turn.start({ text: 'sub', turnId: 't-sub', agentId: 'a1' })
  w.queue(
    { id: 's1', t: 'submit', text: 'hello from the deck', asUser: true },
    { id: 'm1', t: 'command', command: 'model', args: 'haiku' },
    { id: 'k1', t: 'config', key: 'theme', value: 'dark' },
    { id: 'k2', t: 'config', key: 'locked', value: true },
    { id: 'a1', t: 'abort' },
    { id: 'x1', t: 'check', tool: 'Bash', input: { command: 'rm -rf /' } },
    { id: 'u1', t: 'unixFetch', socketPath: '/tmp/deck-test.sock' },
  )
  await clock.advance(1000)
  await clock.settle()
  await clock.settle()

  const r = w.results()
  expect(r.s1?.ok).toBe(true)
  expect(r.s1?.result.text).toBe('hello from the deck')
  // In the kit, the mod's own submit does not pass its own prompt.submit hook.
  expect(r.m1?.result.text).toBe('ran /model haiku')
  expect(r.k1?.result).toEqual({ value: 'dark' })
  expect(r.k2?.ok).toBe(false)
  expect(r.k2?.error).toBe('denied: a policy owns it')
  // Abort takes the main loop's turn, never a subagent's.
  expect(aborted).toEqual(['t-main'])
  expect(r.x1?.result).toEqual({ decision: 'ask' })
  const unix = w.sent.find(s => s.socketPath !== undefined)
  expect(unix?.url).toBe('http://bridge/mod/next?sid=probe')
  expect(unix?.socketPath).toBe('/tmp/deck-test.sock')
  expect(r.u1?.result.status).toBe(200)
})

test('with the bridge down the loop keeps polling and logs once per outage, at debug', async ($, on) => {
  const w = world(on, { down: true })
  mock.env(on, ENV)
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/sandbox', surface: null, isInteractive: false })
  await clock.settle()
  for (let i = 0; i < 3; i++) {
    await clock.advance(1000)
    await clock.settle()
  }
  expect(w.to('/mod/next').length).toBe(3)
  expect(w.logs.length).toBe(1)
  expect(w.logs[0]?.to).toBe('debug')
  expect(w.logs[0]?.text).toMatch(/bridge unreachable/)

  w.bridge.down = false
  await clock.advance(1000)
  await clock.settle()
  w.bridge.down = true
  await clock.advance(1000)
  await clock.settle()
  expect(w.logs.length).toBe(2)
})
