// deck-spike mod, Phase 1 spikes S0-S4 (docs/claude-code/plan.md).
//
// On session.start it reports to the spike bridge what `$` gives it
// (/mod/hello), then polls /mod/next every second for commands to run and the
// bridge's policy. Its event hooks post what they see to /mod/event, fire and
// forget. tool.check and classic.PermissionRequest answer as the cached policy
// says, and pass otherwise; on any failure they pass too (`.catch`), so the
// session's own flow never waits on the deck.
//
// API: Claude Code 2.1.309's mods API, early access
// (claude-code/vendor/mods-api-2.1.309/claude-code.d.ts).

import type { EngineInterface, Register, Timer } from 'claude-code'

type Dollar = EngineInterface
type Json = Record<string, unknown>
type Policy = { toolCheck?: unknown; classicPermission?: unknown; permission?: unknown }
type Outcome = { ok: boolean; result?: unknown; error?: string }

const BRIDGE = 'http://127.0.0.1:47600'
const POLL_MS = 1000
/** A poll still running after this long is taken as hung, and the next one goes ahead. */
const POLL_STUCK_MS = 30_000

/** One per load of this module: a hot reload shows up as a new instance. */
const instance = Math.random().toString(36).slice(2, 10)

let sid: string | undefined
let token: string | undefined
let tokenSource: 'env' | 'file' | 'none' = 'none'
/** The physical `.../spikes` folder: the plugin root may be reached through a link. */
let spikesDir: string | undefined
let policy: Policy = {}
let lastTurnId: string | undefined
// S4: a call the mod raises itself, forced to ask so a PermissionRequest
// hook can answer it with updatedPermissions (setMode).
let forceAsk: { tool: string, until: number } | undefined
let poller: Timer | undefined
let pollingSince = 0
let bridgeDown = false

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

/** Logs the first failure of each outage, at debug, and stays quiet otherwise. */
function noteFailure($: Dollar, err: unknown): void {
  if (bridgeDown) return
  bridgeDown = true
  try {
    $.ui.log(`deck-spike: bridge unreachable (${errText(err)}); still polling`, { to: 'debug' })
  } catch {}
}

/** Fire and forget: never awaited, never throws. `at` is the mod's clock. */
function post($: Dollar, route: string, body: Json): void {
  let text: string
  try {
    text = JSON.stringify({ sid: sid ?? null, instance, at: Date.now(), ...body })
  } catch (err) {
    text = JSON.stringify({ sid: sid ?? null, instance, at: Date.now(), unserializable: errText(err) })
  }
  try {
    $.http.fetch(`${BRIDGE}${route}`, { method: 'POST', headers: headers(), body: text }).then(
      () => {
        bridgeDown = false
      },
      err => noteFailure($, err),
    )
  } catch (err) {
    noteFailure($, err)
  }
}

// ---- boot: ids, paths, token, hello -----------------------------------------

async function resolvePaths($: Dollar): Promise<void> {
  try {
    const st = await $.fs.stat($.plugin.root, { resolve: true })
    const real = (st.realPath ?? $.plugin.root).replace(/\/+$/, '')
    spikesDir = real.slice(0, real.lastIndexOf('/'))
  } catch {
    spikesDir = undefined
  }
}

/** DECK_TOKEN from the environment (the preset sets it), else the bridge's token file. */
async function loadToken($: Dollar): Promise<void> {
  try {
    const v = await $.env.get('DECK_TOKEN')
    if (v !== undefined && v.trim() !== '') {
      token = v.trim()
      tokenSource = 'env'
      return
    }
  } catch {}
  if (spikesDir !== undefined) {
    try {
      const text = await $.fs.read(`${spikesDir}/cc-bridge/run/token`)
      if (text.trim() !== '') {
        token = text.trim()
        tokenSource = 'file'
        return
      }
    } catch {}
  }
  token = undefined
  tokenSource = 'none'
}

async function hello($: Dollar, start: unknown): Promise<void> {
  const errors: Record<string, string> = {}
  async function grab<T>(name: string, f: () => T | Promise<T>): Promise<T | null> {
    try {
      return await f()
    } catch (err) {
      errors[name] = errText(err)
      return null
    }
  }
  const [id, cwd, root, model, version, surfaces, turns, usage] = await Promise.all([
    grab('session.id', () => $.session.id()),
    grab('session.cwd', () => $.session.cwd()),
    grab('session.root', () => $.session.root()),
    grab('session.model', () => $.session.model()),
    grab('session.version', () => $.session.version()),
    grab('session.surfaces', () => $.session.surfaces()),
    grab('session.turns', () => $.session.turns()),
    grab('session.usage', () => $.session.usage()),
  ])
  // $.env.get takes string literals only: the names are read off the source.
  const [ccSession, ccHost, ccEntrypoint, deckToken] = await Promise.all([
    grab('env.CLAUDE_CODE_SESSION_ID', () => $.env.get('CLAUDE_CODE_SESSION_ID')),
    grab('env.CLAUDE_CODE_HOST_SESSION_ID', () => $.env.get('CLAUDE_CODE_HOST_SESSION_ID')),
    grab('env.CLAUDE_CODE_ENTRYPOINT', () => $.env.get('CLAUDE_CODE_ENTRYPOINT')),
    grab('env.DECK_TOKEN', async () => (await $.env.get('DECK_TOKEN')) !== undefined),
  ])
  const [config, commands, tools] = await Promise.all([
    grab('config.list', () => $.config.list()),
    grab('command.list', async () =>
      (await $.command.list()).map(c => ({ name: c.name, description: c.description, source: c.source }))),
    grab('tool.list', async () => (await $.tool.list()).map(t => t.name)),
  ])
  const plugin = await grab('plugin', () => ({ name: $.plugin.name, root: $.plugin.root }))
  post($, '/mod/hello', {
    start,
    session: { id, cwd, root, model, version, surfaces, turns, usage },
    env: {
      CLAUDE_CODE_SESSION_ID: ccSession ?? null,
      CLAUDE_CODE_HOST_SESSION_ID: ccHost ?? null,
      CLAUDE_CODE_ENTRYPOINT: ccEntrypoint ?? null,
      DECK_TOKEN_present: deckToken,
    },
    plugin: { ...plugin, spikesDir: spikesDir ?? null },
    tokenSource,
    config,
    commands,
    tools,
    errors,
  })
}

async function boot($: Dollar, start: unknown): Promise<void> {
  try {
    sid = await $.session.id()
  } catch {}
  await resolvePaths($)
  await loadToken($)
  post($, '/mod/event', { event: 'session.start', start })
  await hello($, start)
}

// ---- the poll loop and its commands -----------------------------------------

function startPolling($: Dollar): void {
  poller?.cancel()
  poller = $.clock.every(POLL_MS, () => {
    void tick($)
  })
}

async function tick($: Dollar): Promise<void> {
  const now = Date.now()
  if (pollingSince !== 0 && now - pollingSince < POLL_STUCK_MS) return
  pollingSince = now
  try {
    // A /clear goes on under a new id with no session.start: follow it here.
    const current = await $.session.id().catch(() => sid)
    if (current !== undefined && current !== sid) {
      const was = sid
      sid = current
      if (was !== undefined) void hello($, { reason: 'session id changed', was })
    }
    if (sid === undefined) return
    const res = await $.http.fetch(`${BRIDGE}/mod/next?sid=${encodeURIComponent(sid)}`, { headers: headers() })
    bridgeDown = false
    if (!res.ok) return
    const msg: unknown = JSON.parse(res.text)
    if (!isRecord(msg)) return
    if (isRecord(msg.policy)) policy = msg.policy
    const cmds = Array.isArray(msg.cmds) ? msg.cmds : []
    // Each runs on its own: a prompt waits for the session to be idle, and
    // the loop goes on polling meanwhile.
    for (const cmd of cmds) void run($, isRecord(cmd) ? cmd : {})
  } catch (err) {
    noteFailure($, err)
  } finally {
    pollingSince = 0
  }
}

async function run($: Dollar, cmd: Json): Promise<void> {
  const started = Date.now()
  let out: Outcome
  try {
    out = await execute($, cmd)
  } catch (err) {
    out = { ok: false, error: errText(err) }
  }
  post($, '/mod/result', {
    id: cmd.id ?? null,
    t: cmd.t ?? null,
    ok: out.ok,
    ...(out.ok ? {} : { error: out.error ?? 'failed' }),
    ...(out.result !== undefined ? { result: out.result } : {}),
    ms: Date.now() - started,
  })
}

const bad = (error: string): Outcome => ({ ok: false, error })

const isConfigValue = (v: unknown): v is boolean | string | number | string[] =>
  typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' ||
  (Array.isArray(v) && v.every(x => typeof x === 'string'))

async function execute($: Dollar, cmd: Json): Promise<Outcome> {
  const text = typeof cmd.text === 'string' ? cmd.text : undefined
  switch (cmd.t) {
    case 'submit': {
      if (text === undefined) return bad('submit needs text')
      const r = await $.prompt.submit(cmd.asUser === true ? { text, asUser: true } : { text })
      return r.drop !== undefined ? { ok: false, error: `dropped: ${r.drop}`, result: r } : { ok: true, result: r }
    }
    case 'command': {
      if (typeof cmd.command !== 'string') return bad('command needs command (the name, no slash)')
      const args = typeof cmd.args === 'string' ? cmd.args : undefined
      const r = await $.command.run(args === undefined ? { command: cmd.command } : { command: cmd.command, args })
      return { ok: true, result: r }
    }
    case 'config': {
      if (typeof cmd.key !== 'string' || !isConfigValue(cmd.value)) return bad('config needs key and value')
      const r = await $.config.set({ key: cmd.key, value: cmd.value })
      return r.deny !== undefined ? { ok: false, error: `denied: ${r.deny}`, result: r } : { ok: true, result: r }
    }
    case 'configList':
      return { ok: true, result: await $.config.list() }
    case 'usage': {
      const breakdown = cmd.breakdown === 'full' || cmd.breakdown === 'summary' ? cmd.breakdown : undefined
      return { ok: true, result: await $.session.usage(breakdown === undefined ? undefined : { breakdown }) }
    }
    case 'model':
      return { ok: true, result: await $.session.model() }
    case 'status':
      $.ui.status(text)
      return { ok: true }
    case 'toast':
      if (text === undefined) return bad('toast needs text')
      $.ui.toast(text)
      return { ok: true }
    case 'notice':
      if (typeof cmd.tool_use_id !== 'string') return bad('notice needs tool_use_id')
      $.ui.notice(cmd.tool_use_id, text)
      return { ok: true }
    case 'abort': {
      const turnId = typeof cmd.turnId === 'string' ? cmd.turnId : lastTurnId
      if (turnId === undefined) return bad('no main-loop turn seen yet')
      await $.turn.abort({ turnId })
      return { ok: true, result: { turnId } }
    }
    case 'check':
      if (typeof cmd.tool !== 'string') return bad('check needs tool')
      return { ok: true, result: await $.tool.check({ tool: cmd.tool, input: cmd.input ?? {} }) }
    case 'callTool': {
      // S4: $.tool.call with its own tool.check forced to ask (forceAsk above).
      if (typeof cmd.tool !== 'string') return bad('callTool needs tool')
      const input = isRecord(cmd.input) ? cmd.input : {}
      if (cmd.forceAsk === true) forceAsk = { tool: cmd.tool, until: Date.now() + 15_000 }
      const r = await $.tool.call({ tool: cmd.tool, ...input } as Parameters<Dollar['tool']['call']>[0])
      return { ok: true, result: JSON.parse(JSON.stringify(r, (k, v) => typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v)) }
    }
    case 'mcp': {
      // S4: the app's own tools, e.g. ccd_session_mgmt set_session_permission_mode.
      if (typeof cmd.server !== 'string' || typeof cmd.tool !== 'string') return bad('mcp needs server and tool')
      const args = cmd.args !== null && typeof cmd.args === 'object' && !Array.isArray(cmd.args)
        ? cmd.args as Record<string, unknown>
        : undefined
      const r = await $.mcp.call(cmd.server, cmd.tool, args)
      return r.isError === true ? { ok: false, error: 'tool error', result: r } : { ok: true, result: r }
    }
    case 'env':
      if (typeof cmd.name !== 'string') return bad('env needs name')
      return { ok: true, result: await readEnv($, cmd.name) }
    case 'unixFetch': {
      const socketPath = typeof cmd.socketPath === 'string'
        ? cmd.socketPath
        : spikesDir !== undefined ? `${spikesDir}/cc-bridge/run/bridge.sock` : undefined
      if (socketPath === undefined) return bad('no socket path: the plugin root did not resolve')
      const r = await $.http.fetch('http://bridge/mod/next?sid=probe', { socketPath, headers: headers() })
      return { ok: r.ok, ...(r.ok ? {} : { error: `status ${r.status}` }), result: { status: r.status, socketPath, text: r.text.slice(0, 300) } }
    }
    default:
      return bad(`unknown t: ${JSON.stringify(cmd.t ?? null)}`)
  }
}

/**
 * `$.env.get` takes string literals only (`claude plugin validate` reads the
 * names off the source), so the `env` command answers for these names alone.
 * Secrets answer only whether they are set.
 */
async function readEnv($: Dollar, name: string): Promise<unknown> {
  switch (name) {
    case 'CLAUDE_CODE_SESSION_ID': return (await $.env.get('CLAUDE_CODE_SESSION_ID')) ?? null
    case 'CLAUDE_CODE_HOST_SESSION_ID': return (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? null
    case 'CLAUDE_CODE_ENTRYPOINT': return (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? null
    case 'CLAUDE_CODE_MESSAGING_SOCKET': return (await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')) ?? null
    case 'CLAUDE_CODE_PLUGIN_DIRS': return (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? null
    case 'CLAUDE_CODE_PLUGIN_DIR_WATCH': return (await $.env.get('CLAUDE_CODE_PLUGIN_DIR_WATCH')) ?? null
    case 'CLAUDE_PROJECT_DIR': return (await $.env.get('CLAUDE_PROJECT_DIR')) ?? null
    case 'CLAUDE_PLUGIN_ROOT': return (await $.env.get('CLAUDE_PLUGIN_ROOT')) ?? null
    case 'CLAUDE_PLUGIN_DATA': return (await $.env.get('CLAUDE_PLUGIN_DATA')) ?? null
    case 'CLAUDE_CONFIG_DIR': return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? null
    case 'CLAUDE_EFFORT': return (await $.env.get('CLAUDE_EFFORT')) ?? null
    case 'PWD': return (await $.env.get('PWD')) ?? null
    case 'DECK_TOKEN': return { set: (await $.env.get('DECK_TOKEN')) !== undefined }
    case 'CLAUDE_CODE_MESSAGING_TOKEN': return { set: (await $.env.get('CLAUDE_CODE_MESSAGING_TOKEN')) !== undefined }
    default:
      throw new Error(`${name} is not a name this module spells; $.env.get takes string literals only`)
  }
}

// ---- hooks ------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    startPolling($)
    void boot($, { cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive })
    return r
  })

  on('session.end', ($, e, next) => {
    post($, '/mod/event', { event: 'session.end', reason: e.reason, sessionId: e.sessionId, resume: e.resume })
    return next(e)
  })

  on('session.attach', ($, e, next) => {
    post($, '/mod/event', { event: 'session.attach', surface: e.surface, clientId: e.clientId, viewport: e.viewport ?? null })
    return next(e)
  })

  on('session.detach', ($, e, next) => {
    post($, '/mod/event', { event: 'session.detach', surface: e.surface, clientId: e.clientId, reason: e.reason })
    return next(e)
  })

  // Not asked for by name: the pushed form of $.session.usage(), context % included.
  on('session.measure', ($, e, next) => {
    post($, '/mod/event', { event: 'session.measure', changed: e.changed, context: e.context, rateLimits: e.rateLimits, cost: e.cost ?? null })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) lastTurnId = e.turnId
    const x = e as unknown as Json
    post($, '/mod/event', {
      event: 'turn.start',
      turnId: e.turnId,
      agentId: e.agentId ?? null,
      textLength: e.text.length,
      ...('model' in x ? { model: x.model } : {}),
      ...('effort' in x ? { effort: x.effort } : {}),
    })
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    post($, '/mod/event', {
      event: 'turn.complete',
      turnId: e.turnId,
      agentId: e.agentId ?? null,
      reason: e.reason,
      isAborted: e.isAborted,
      durationMs: e.durationMs,
      answerLength: e.answer.length,
      usage: e.usage ?? null,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const base = { event: 'prompt.submit', origin: e.origin, textLength: e.text.length, command: e.command ?? null, isMeta: e.isMeta ?? false, turnId: e.turnId ?? null, wait: e.wait }
    post($, '/mod/event', { ...base, phase: 'start' })
    const r = await next(e)
    post($, '/mod/event', { ...base, phase: 'end', dropped: r.drop ?? null })
    return r
  })

  on('tool.call', async ($, e, next) => {
    const base = { event: 'tool.call', tool: e.tool, tool_use_id: e.tool_use_id, agentId: e.agentId ?? null }
    post($, '/mod/event', { ...base, phase: 'start' })
    const r = await next(e)
    post($, '/mod/event', { ...base, phase: 'end', isError: r.isError === true, denied: r.deny ?? null })
    return r
  })

  // next(e) here only reads the engine's verdict; it runs nothing.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const forced = forceAsk !== undefined && forceAsk.tool === e.tool && Date.now() < forceAsk.until
    if (forced) forceAsk = undefined
    const decision = forced ? 'ask' : policy.toolCheck === 'ask' ? 'ask' : policy.toolCheck === 'deny' ? 'deny' : undefined
    const answer = decision === undefined ? verdict : ({ decision, reason: 'deck spike' } as const)
    post($, '/mod/event', {
      event: 'tool.check',
      tool: e.tool,
      input: e.input,
      tool_use_id: e.tool_use_id ?? null,
      agentId: e.agentId ?? null,
      ceiling: e.ceiling ?? null,
      approver: e.approver ?? null,
      isReadOnly: e.isReadOnly ?? false,
      verdict,
      ...(answer !== verdict ? { answered: answer } : {}),
    })
    return answer
  }).catch(($, e, next) => next(e))

  // Beneath this hook run the settings hooks, ours from hooks.json included:
  // answering here (allow or deny) means the http and command hooks never fire.
  on('classic.PermissionRequest', async ($, e, next) => {
    const mode = policy.classicPermission
    const base = { event: 'classic.PermissionRequest', session_id: e.session_id, tool_name: e.tool_name, tool_input: e.tool_input, permission_suggestions: e.permission_suggestions ?? null, mode: mode ?? 'pass' }
    if (mode === 'allow') {
      post($, '/mod/event', { ...base, phase: 'answered', answered: 'allow' })
      return { decision: { behavior: 'allow' } }
    }
    if (mode === 'deny') {
      post($, '/mod/event', { ...base, phase: 'answered', answered: 'deny' })
      return { decision: { behavior: 'deny', message: 'deck spike' } }
    }
    post($, '/mod/event', { ...base, phase: 'start' })
    const r = await next(e)
    post($, '/mod/event', { event: 'classic.PermissionRequest', phase: 'end', session_id: e.session_id, tool_name: e.tool_name, result: r })
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Notification', ($, e, next) => {
    post($, '/mod/event', { event: 'classic.Notification', notification_type: e.notification_type, title: e.title ?? null, message: e.message })
    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    post($, '/mod/event', {
      event: 'classic.Stop',
      stop_hook_active: e.stop_hook_active,
      lastMessageLength: e.last_assistant_message?.length ?? null,
      background_tasks: e.background_tasks ?? null,
      session_crons: e.session_crons ?? null,
    })
    return next(e)
  })
}
