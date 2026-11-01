#!/usr/bin/env node
// Spike bridge for the Claude Code side, Phase 1 (docs/claude-code/plan.md).
//
// Logs every request from the deck-spike plugin (spikes/cc-plugin), holds
// PermissionRequest hooks until /control answers them, queues commands for
// the mod, and watches the session registry (~/.claude/sessions/*.json,
// never the .key files). Node 24, no dependencies. README.md has the usage,
// the policy and command shapes, and where results go.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULTS = Object.freeze({
  port: 47600,
  socketPath: path.join(HERE, 'run', 'bridge.sock'),
  tokenFile: path.join(HERE, 'run', 'token'),
  resultsDir: path.resolve(HERE, '..', 'results'),
  sessionsDir: path.join(os.homedir(), '.claude', 'sessions'),
  holdCapMs: 590_000,
  registryMs: 250,
})

/** The registry fields worth logging; any other top-level key is logged by name only. */
export const REGISTRY_FIELDS = Object.freeze([
  'pid', 'sessionId', 'hostSessionId', 'cwd', 'name', 'nameSource',
  'status', 'statusUpdatedAt', 'updatedAt', 'kind', 'entrypoint', 'version',
])

const ENUMS = {
  via: ['http', 'cmd'],
  action: ['none', 'hold', 'allow', 'deny'],
  toolCheck: ['pass', 'ask', 'deny'],
  classicPermission: ['pass', 'allow', 'deny'],
}

/** Which endpoint each permission hook calls. */
const VIA_BY_PATH = { '/permission': 'http', '/permission-cmd': 'cmd' }

const MAX_BODY = 32 * 1024 * 1024
const RECENT_KEPT = 10

export function defaultPolicy() {
  return {
    permission: { via: 'http', action: 'hold', delayMs: 0, interrupt: false },
    toolCheck: 'pass',
    classicPermission: 'pass',
  }
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function oneOf(field, value) {
  if (!ENUMS[field].includes(value)) {
    throw new Error(`${field} must be one of ${ENUMS[field].join(', ')}`)
  }
}

/**
 * Merges a /control/policy body into the policy. `permission` merges field by
 * field; null removes an optional field. Throws on an unknown field or value,
 * so a typo never passes silently.
 */
export function mergePolicy(current, patch) {
  if (!isObject(patch)) throw new Error('the policy must be a JSON object')
  const next = structuredClone(current)
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'toolCheck' || key === 'classicPermission') {
      oneOf(key, value)
      next[key] = value
    } else if (key === 'permission') {
      if (!isObject(value)) throw new Error('permission must be an object')
      for (const [k, v] of Object.entries(value)) {
        const p = next.permission
        switch (k) {
          case 'via':
          case 'action':
            oneOf(k, v)
            p[k] = v
            break
          case 'delayMs':
            if (!(Number.isFinite(v) && v >= 0)) throw new Error('delayMs must be a number >= 0')
            p.delayMs = v
            break
          case 'interrupt':
            if (typeof v !== 'boolean') throw new Error('interrupt must be true or false')
            p.interrupt = v
            break
          case 'message':
            if (v === null) delete p.message
            else if (typeof v === 'string') p.message = v
            else throw new Error('message must be a string or null')
            break
          case 'updatedPermissions':
            if (v === null) delete p.updatedPermissions
            else if (Array.isArray(v)) p.updatedPermissions = v
            else throw new Error('updatedPermissions must be an array or null')
            break
          case 'updatedInput':
            if (v === null) delete p.updatedInput
            else if (isObject(v)) p.updatedInput = v
            else throw new Error('updatedInput must be an object or null')
            break
          default:
            throw new Error(`unknown permission field: ${k}`)
        }
      }
    } else {
      throw new Error(`unknown policy field: ${key}`)
    }
  }
  return next
}

/**
 * The PermissionRequest answer for `behavior`, carrying whichever extras are
 * given: `message` (a non-empty string), `interrupt` (only when true; the
 * type takes `true` alone), `updatedPermissions` (an array), `updatedInput`
 * (an object). `none` answers `{}`, which is no decision.
 */
export function decisionJson(behavior, extra = {}) {
  if (behavior === 'none') return {}
  const decision = { behavior }
  if (typeof extra.message === 'string' && extra.message !== '') decision.message = extra.message
  if (extra.interrupt === true) decision.interrupt = true
  if (Array.isArray(extra.updatedPermissions)) decision.updatedPermissions = extra.updatedPermissions
  if (isObject(extra.updatedInput)) decision.updatedInput = extra.updatedInput
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}

/**
 * The policy's own answer: only the fields that fit the behavior, per the
 * d.ts (allow: updatedInput, updatedPermissions; deny: message, interrupt),
 * so a field left in the policy from an earlier test never rides along.
 */
function policyDecision(p) {
  if (p.action === 'allow') {
    return decisionJson('allow', { updatedPermissions: p.updatedPermissions, updatedInput: p.updatedInput })
  }
  return decisionJson('deny', { message: p.message, interrupt: p.interrupt })
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

function runStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function clockTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

const round1 = x => Math.round(x * 10) / 10

function clip(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ')
  return str.length > n ? `${str.slice(0, n - 1)}…` : str
}

const short = id => (typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : id ?? '-')

function inputSummary(input) {
  if (!isObject(input)) return clip(JSON.stringify(input ?? null), 120)
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    if (typeof input[k] === 'string') return clip(input[k], 120)
  }
  return clip(JSON.stringify(input), 120)
}

function readTokenFile(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    return t === '' ? null : t
  } catch {
    return null
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * How the request authenticated. `auth` is match, mismatch or absent; the
 * detail says why a mismatch happened, notably when the literal, never
 * interpolated `$DECK_TOKEN` arrived. The token itself is never returned.
 */
export function authOf(header, token) {
  if (header === undefined) return { auth: 'absent' }
  const out = {}
  const raw = String(header).trim()
  const m = /^Bearer(?:\s+(.*))?$/i.exec(raw)
  const presented = m ? (m[1] ?? '').trim() : raw
  out.auth = token !== null && presented !== '' && safeEqual(presented, token) ? 'match' : 'mismatch'
  if (raw.includes('$DECK_TOKEN') || raw.includes('${DECK_TOKEN}')) out.authLiteral = true
  if (out.auth === 'mismatch') {
    if (!m) out.authDetail = 'not a Bearer header'
    else if (presented === '') out.authDetail = 'empty bearer'
    else if (out.authLiteral) out.authDetail = 'literal $DECK_TOKEN'
    else if (token === null) out.authDetail = 'bridge has no token'
  }
  return out
}

/** Parses a body as JSON when it can, after taking any copy of the token out. */
function parseBody(text, token) {
  if (text === '') return { body: null }
  let redacted = false
  if (token !== null && text.includes(token)) {
    text = text.split(token).join('<token>')
    redacted = true
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.length > 262_144 ? `${text.slice(0, 262_144)}…[${text.length} chars]` : text
  }
  return redacted ? { body, redacted } : { body }
}

function makeRunDir(resultsDir) {
  fs.mkdirSync(resultsDir, { recursive: true })
  const base = `${runStamp()}-cc`
  for (let i = 1; ; i++) {
    const dir = path.join(resultsDir, i === 1 ? base : `${base}-${i}`)
    try {
      fs.mkdirSync(dir)
      return dir
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Refuses to replace anything but a stale socket at the Unix socket path. */
async function clearStaleSocket(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return
  }
  if (!st.isSocket()) throw new Error(`${p} exists and is not a socket; not touching it`)
  const live = await new Promise(resolve => {
    const s = net.connect(p)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
  if (live) throw new Error(`another bridge is listening on ${p}`)
  fs.unlinkSync(p)
}

function listen(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const done = () => { server.off('error', reject); resolve() }
    if (typeof target === 'string') server.listen(target, done)
    else server.listen(target.port, target.host, done)
  })
}

/**
 * Starts the bridge. Options (all optional; DEFAULTS fills the rest):
 *   port (0 = ephemeral), socketPath (null = no Unix socket), tokenFile,
 *   resultsDir, sessionsDir, holdCapMs, registryMs, registry (false = no
 *   watcher), allPolls (print empty /mod/next polls too), quiet, print
 *   (a line sink in place of stdout), readFile (the registry's reader).
 * Resolves { port, socketPath, runDir, close, policy() }.
 */
export async function startBridge(options = {}) {
  const o = { ...DEFAULTS }
  for (const [k, v] of Object.entries(options)) if (v !== undefined) o[k] = v
  const print = o.quiet ? () => {} : (o.print ?? (line => process.stdout.write(`${line}\n`)))
  const readFile = o.readFile ?? fsp.readFile

  const token = readTokenFile(o.tokenFile)
  const runDir = makeRunDir(o.resultsDir)
  const eventsFile = path.join(runDir, 'events.jsonl')
  const registryFile = path.join(runDir, 'registry.jsonl')
  const write = (file, obj) => fs.appendFileSync(file, `${JSON.stringify(obj)}\n`)
  const stampLine = () => ({ t: Date.now(), mono: round1(performance.now()) })

  let policy = defaultPolicy()
  const sessions = new Map()
  const perms = new Map()
  const recent = []
  const queues = new Map()
  const polled = new Set()
  let permSeq = 0
  let cmdSeq = 0
  let queueSeq = 0

  // ---- sessions seen ------------------------------------------------------

  function touch(sid, source, info = {}) {
    if (typeof sid !== 'string' || sid === '') return
    const now = Date.now()
    let s = sessions.get(sid)
    if (!s) {
      s = { sessionId: sid, hostSessionId: null, cwd: null, ppid: null, firstSeen: now, lastSeen: now, lastEvent: null, lastPoll: null, counts: {} }
      sessions.set(sid, s)
    }
    s.lastSeen = now
    s.counts[source] = (s.counts[source] ?? 0) + 1
    if (info.host) s.hostSessionId = info.host
    if (info.cwd) s.cwd = info.cwd
    if (Number.isInteger(info.ppid)) s.ppid = info.ppid
    if (info.event) s.lastEvent = { name: info.event, t: now }
    if (info.poll) s.lastPoll = now
  }

  // ---- held permission requests ------------------------------------------

  function permView(e) {
    const v = { id: e.id, via: e.via, conn: e.conn, sessionId: e.sid, tool: e.tool, input: e.summary, ageMs: Math.round(performance.now() - e.mono) }
    if (e.state !== 'held') {
      v.end = e.state
      v.heldMs = e.heldMs
      if (e.decision) v.decision = e.decision
    }
    return v
  }

  function finish(e, state, extra = {}) {
    e.state = state
    e.heldMs = Math.round(performance.now() - e.mono)
    for (const timer of e.timers) clearTimeout(timer)
    e.timers = []
    recent.push(e)
    if (recent.length > RECENT_KEPT) recent.shift()
    Object.assign(e.ctx.meta, { id: e.id, via: e.via, end: state, heldMs: e.heldMs }, extra)
  }

  /** Ends a held request with `json`; false when it had already ended. */
  function answer(e, json, by) {
    if (e.state !== 'held') return false
    const end = by === 'cap' ? 'timeout' : by === 'shutdown' ? 'shutdown' : 'answered'
    const behavior = json.hookSpecificOutput?.decision?.behavior ?? 'none'
    e.decision = behavior
    finish(e, end, { by, decision: behavior })
    e.ctx.respBody = json
    sendJson(e.res, 200, json)
    e.res = null
    print(`${clockTime()}       ${e.id} ${end} ${behavior} (${by}) after ${(e.heldMs / 1000).toFixed(1)}s`)
    return true
  }

  function onPermission(ctx, req, res, body) {
    const via = VIA_BY_PATH[ctx.path]
    const id = `p${++permSeq}`
    const b = isObject(body) ? body : {}
    const sid = typeof b.session_id === 'string' ? b.session_id : null
    const p = policy.permission
    const e = {
      id, via, conn: ctx.conn, sid, tool: b.tool_name ?? null, summary: inputSummary(b.tool_input),
      mono: ctx.mono, state: 'held', timers: [], res, ctx, decision: null, heldMs: 0,
    }
    Object.assign(ctx.meta, { id, via })
    touch(sid, 'permission', { cwd: b.cwd, event: `PermissionRequest(${via})` })
    ctx.logRequest({ id, via, sessionId: sid, policy: { via: p.via, action: p.action } })
    perms.set(id, e)
    const who = `${ctx.method} ${ctx.path} ${id} ${ctx.auth} ${short(sid)} ${e.tool ?? '?'}: ${clip(e.summary, 60)}`

    if (p.via !== via || p.action === 'none') {
      const reason = p.via !== via ? 'via-mismatch' : 'policy-none'
      e.decision = 'none'
      finish(e, 'answered', { by: reason, decision: 'none' })
      ctx.respBody = {}
      sendJson(res, 200, {})
      e.res = null
      print(`${ctx.head} ${who} -> {} (${reason})`)
      return
    }

    // Runs from handle()'s close listener, before its close line is written.
    ctx.onClose = () => {
      if (e.state !== 'held') return
      finish(e, 'client-closed')
      e.res = null
      print(`${clockTime()}       ${id} client-closed after ${(e.heldMs / 1000).toFixed(1)}s`)
    }
    e.timers.push(setTimeout(() => answer(e, {}, 'cap'), o.holdCapMs))
    if (p.action === 'hold') {
      print(`${ctx.head} ${who} HOLD`)
    } else {
      const json = policyDecision(p)
      print(`${ctx.head} ${who} ${p.action} in ${p.delayMs}ms`)
      e.timers.push(setTimeout(() => answer(e, json, 'policy'), p.delayMs))
    }
  }

  // ---- mod command queue --------------------------------------------------

  function drain(sid) {
    const mine = queues.get(sid) ?? []
    queues.delete(sid)
    // `probe` is the mod's unixFetch check: it never takes the `*` commands.
    let shared = []
    if (sid !== '*' && sid !== 'probe') {
      shared = queues.get('*') ?? []
      queues.delete('*')
    }
    return [...mine, ...shared].sort((a, b) => a.seq - b.seq).map(q => q.cmd)
  }

  function queuedView() {
    const out = {}
    for (const [sid, list] of queues) out[sid] = list.map(q => q.cmd)
    return out
  }

  // ---- HTTP ---------------------------------------------------------------

  function sendJson(res, status, obj) {
    if (res.writableEnded || res.destroyed) return
    const text = JSON.stringify(obj)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  function sendStatus(res, status) {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status)
    res.end()
  }

  async function handle(conn, req, res) {
    const t = Date.now()
    const mono = performance.now()
    const url = new URL(req.url ?? '/', 'http://bridge')
    const ctx = {
      conn, method: req.method, path: url.pathname, query: url.search, t, mono, meta: {}, respBody: undefined,
      head: `${clockTime(new Date(t))} ${conn.padEnd(4)}`,
    }
    const base = () => ({ conn, method: ctx.method, path: ctx.path, ...(ctx.query ? { query: ctx.query } : {}) })
    let requestLogged = false
    res.on('finish', () => {
      write(eventsFile, { kind: 'response', ...stampLine(), ...base(), status: res.statusCode, ms: round1(performance.now() - mono), ...ctx.meta, ...(ctx.respBody !== undefined ? { body: ctx.respBody } : {}) })
    })
    res.on('close', () => {
      if (res.writableFinished || !requestLogged) return
      ctx.onClose?.()
      write(eventsFile, { kind: 'close', ...stampLine(), ...base(), ms: round1(performance.now() - mono), ...ctx.meta, ...(ctx.meta.end ? {} : { end: 'client-closed' }) })
    })

    let text
    try {
      text = await readBody(req)
    } catch (err) {
      sendJson(res, err.status ?? 400, { error: String(err.message ?? err) })
      return
    }
    const a = authOf(req.headers.authorization, token)
    ctx.auth = a.auth
    const parsed = parseBody(text, token)
    ctx.logRequest = (fields = {}) => {
      requestLogged = true
      const ua = req.headers['user-agent']
      write(eventsFile, {
        kind: 'request', t, mono: round1(mono), ...base(), ...a,
        ...(ua ? { ua: clip(ua, 80) } : {}), host: req.headers.host ?? null,
        ...fields, ...parsed,
      })
    }
    try {
      route(ctx, req, res, url, parsed.body, a)
    } catch (err) {
      if (!requestLogged) ctx.logRequest()
      sendJson(res, 500, { error: String(err?.message ?? err) })
      print(`${ctx.head} ${ctx.method} ${ctx.path} 500 ${err?.message ?? err}`)
    }
  }

  function route(ctx, req, res, url, body, a) {
    const p = ctx.path
    const post = ctx.method === 'POST'
    const b = isObject(body) ? body : {}

    if (p.startsWith('/hook/') && post) {
      const event = decodeURIComponent(p.slice('/hook/'.length))
      const env = isObject(b.env) ? b.env : {}
      touch(b.session_id, 'hook', { host: env.CLAUDE_CODE_HOST_SESSION_ID, cwd: b.cwd, ppid: b.ppid, event })
      ctx.logRequest({ event, sessionId: b.session_id ?? null })
      sendStatus(res, 204)
      const hint = b.tool_name ?? b.notification_type ?? b.source ?? b.reason ?? b.agent_type ?? ''
      print(`${ctx.head} POST /hook/${event} 204 ${a.auth} ${short(b.session_id)} ${clip(hint, 40)}`.trimEnd())
      return
    }

    if (VIA_BY_PATH[p] && post) {
      onPermission(ctx, req, res, body)
      return
    }

    if ((p === '/mod/hello' || p === '/mod/event' || p === '/mod/result') && post) {
      const kind = p.slice('/mod/'.length)
      const env = isObject(b.env) ? b.env : {}
      const event = kind === 'event' ? `mod:${b.event ?? '?'}` : kind === 'result' ? `mod:result ${b.id ?? '?'}` : 'mod:hello'
      touch(b.sid, 'mod', { host: env.CLAUDE_CODE_HOST_SESSION_ID, cwd: isObject(b.session) ? b.session.cwd : undefined, event })
      ctx.logRequest({ sessionId: b.sid ?? null })
      sendJson(res, 200, {})
      let tail = ''
      if (kind === 'event') tail = `${b.event ?? '?'}${b.phase ? `:${b.phase}` : ''} ${clip(b.tool ?? b.reason ?? '', 30)}`
      if (kind === 'result') tail = `${b.id ?? '?'} ${b.t ?? ''} ${b.ok ? 'ok' : `error: ${clip(b.error, 60)}`} ${b.ms ?? '?'}ms`
      if (kind === 'hello') tail = `instance ${b.instance ?? '?'}`
      print(`${ctx.head} POST ${p} ${a.auth} ${short(b.sid)} ${tail}`.trimEnd())
      return
    }

    if (p === '/mod/next' && ctx.method === 'GET') {
      const sid = url.searchParams.get('sid')
      if (!sid) {
        ctx.logRequest()
        sendJson(res, 400, { error: 'sid is required' })
        return
      }
      if (sid !== 'probe') touch(sid, 'poll', { poll: true })
      const cmds = drain(sid)
      ctx.meta.cmds = cmds.length
      if (cmds.length) ctx.respBody = { cmds }
      ctx.logRequest({ sessionId: sid })
      sendJson(res, 200, { cmds, policy })
      const first = !polled.has(sid)
      polled.add(sid)
      if (o.allPolls || first || cmds.length) {
        print(`${ctx.head} GET /mod/next ${a.auth} ${short(sid)} cmds=${cmds.length}${first ? ' (first poll)' : ''}${cmds.length ? ` ${cmds.map(c => `${c.id}:${c.t}`).join(' ')}` : ''}`)
      }
      return
    }

    if (p.startsWith('/control/')) {
      ctx.logRequest()
      if (ctx.conn !== 'tcp') {
        sendJson(res, 403, { error: 'control endpoints are TCP only' })
        return
      }
      control(ctx, res, p, body)
      return
    }

    ctx.logRequest()
    sendJson(res, 404, { error: `no route for ${ctx.method} ${p}` })
    print(`${ctx.head} ${ctx.method} ${p} 404`)
  }

  function control(ctx, res, p, body) {
    const b = isObject(body) ? body : {}
    if (p === '/control/state' && ctx.method === 'GET') {
      sendJson(res, 200, state())
      return
    }
    if (p === '/control/policy' && ctx.method === 'POST') {
      try {
        policy = mergePolicy(policy, body)
      } catch (err) {
        ctx.respBody = { ok: false, error: err.message }
        sendJson(res, 400, ctx.respBody)
        print(`${ctx.head} policy refused: ${err.message}`)
        return
      }
      ctx.respBody = { ok: true, policy }
      sendJson(res, 200, ctx.respBody)
      print(`${ctx.head} policy ${JSON.stringify(policy)}`)
      return
    }
    if (p === '/control/answer' && ctx.method === 'POST') {
      if (!['allow', 'deny', 'none'].includes(b.decision)) {
        ctx.respBody = { ok: false, error: 'decision must be allow, deny or none' }
        sendJson(res, 400, ctx.respBody)
        return
      }
      let e
      if (b.id === 'oldest') {
        e = [...perms.values()].filter(x => x.state === 'held').sort((x, y) => x.mono - y.mono)[0]
        if (!e) {
          ctx.respBody = { ok: false, wasOpen: false, error: 'no held request' }
          sendJson(res, 404, ctx.respBody)
          return
        }
      } else {
        e = perms.get(b.id)
        if (!e) {
          ctx.respBody = { ok: false, wasOpen: false, error: `unknown id ${b.id}` }
          sendJson(res, 404, ctx.respBody)
          return
        }
      }
      const json = decisionJson(b.decision, b)
      const wasOpen = answer(e, json, 'control')
      ctx.respBody = wasOpen
        ? { ok: true, id: e.id, wasOpen: true, heldMs: e.heldMs, sent: json }
        : { ok: false, id: e.id, wasOpen: false, end: e.state, heldMs: e.heldMs }
      sendJson(res, 200, ctx.respBody)
      if (!wasOpen) print(`${ctx.head} answer ${e.id}: already ended (${e.state})`)
      return
    }
    if (p === '/control/queue' && ctx.method === 'POST') {
      if (typeof b.sid !== 'string' || b.sid === '' || !isObject(b.cmd) || typeof b.cmd.t !== 'string') {
        ctx.respBody = { ok: false, error: 'body must be {"sid": "<session id or *>", "cmd": {"t": ...}}' }
        sendJson(res, 400, ctx.respBody)
        return
      }
      const cmd = { ...b.cmd }
      if (cmd.id === undefined) cmd.id = `c${++cmdSeq}`
      const list = queues.get(b.sid) ?? []
      list.push({ seq: ++queueSeq, cmd })
      queues.set(b.sid, list)
      ctx.respBody = { ok: true, id: cmd.id, sid: b.sid, queued: list.length }
      sendJson(res, 200, ctx.respBody)
      print(`${ctx.head} queued ${cmd.id}:${cmd.t} for ${b.sid === '*' ? '*' : short(b.sid)}`)
      return
    }
    sendJson(res, 404, { error: `no control route for ${ctx.method} ${p}` })
  }

  function state() {
    const sessionsOut = {}
    for (const [sid, s] of sessions) sessionsOut[sid] = s
    return {
      now: Date.now(),
      runDir,
      policy,
      sessions: sessionsOut,
      held: [...perms.values()].filter(e => e.state === 'held').map(permView),
      recent: recent.map(permView),
      queued: queuedView(),
      registry: [...registry.entries()].map(([file, r]) => ({ file, ...r.fields, otherKeys: r.otherKeys })),
    }
  }

  // ---- registry watcher ---------------------------------------------------

  const registry = new Map()
  const unreadable = new Set()
  let scanning = false
  let initial = true
  let dirMissingLogged = false

  function pick(obj) {
    const out = {}
    for (const k of REGISTRY_FIELDS) if (k in obj) out[k] = obj[k]
    return out
  }

  const pidOf = file => (/^(\d+)\.json$/.exec(file) ?? [])[1] ?? null

  async function scan() {
    if (scanning) return
    scanning = true
    try {
      let names
      try {
        names = await fsp.readdir(o.sessionsDir)
        dirMissingLogged = false
      } catch (err) {
        if (!dirMissingLogged) {
          dirMissingLogged = true
          write(registryFile, { ...stampLine(), kind: 'dir-unreadable', dir: o.sessionsDir, error: err.code ?? String(err) })
        }
        names = []
      }
      // Only *.json: the .key files beside them are never opened.
      const jsons = new Set(names.filter(n => n.endsWith('.json')))
      for (const file of jsons) {
        const full = path.join(o.sessionsDir, file)
        let st
        try {
          st = await fsp.stat(full)
        } catch {
          continue
        }
        const sig = `${st.mtimeMs}:${st.size}`
        const prev = registry.get(file)
        if (prev && prev.sig === sig) continue
        let obj
        try {
          obj = JSON.parse(await readFile(full, 'utf8'))
          if (!isObject(obj)) throw new Error('not a JSON object')
        } catch (err) {
          // Half-written, most likely: keep what we had and read it again next tick.
          if (!unreadable.has(file)) {
            unreadable.add(file)
            write(registryFile, { ...stampLine(), kind: 'unreadable', file, error: clip(err.message ?? err, 120) })
          }
          continue
        }
        unreadable.delete(file)
        const fields = pick(obj)
        const otherKeys = Object.keys(obj).filter(k => !REGISTRY_FIELDS.includes(k)).sort()
        registry.set(file, { sig, fields, otherKeys })
        if (!prev) {
          write(registryFile, { ...stampLine(), kind: 'added', file, fields, otherKeys, ...(initial ? { initial: true } : {}) })
          print(`${clockTime()}       registry + ${pidOf(file) ?? file} ${short(fields.sessionId)} ${fields.status ?? '?'} ${clip(JSON.stringify(fields.name ?? ''), 40)}${initial ? ' (already there)' : ''}`)
          continue
        }
        const changed = {}
        for (const k of new Set([...Object.keys(prev.fields), ...Object.keys(fields)])) {
          if (JSON.stringify(prev.fields[k]) !== JSON.stringify(fields[k])) changed[k] = { from: prev.fields[k] ?? null, to: fields[k] ?? null }
        }
        const keysAdded = otherKeys.filter(k => !prev.otherKeys.includes(k))
        const keysRemoved = prev.otherKeys.filter(k => !otherKeys.includes(k))
        if (Object.keys(changed).length || keysAdded.length || keysRemoved.length) {
          write(registryFile, {
            ...stampLine(), kind: 'changed', file, sessionId: fields.sessionId ?? null, changed,
            ...(keysAdded.length ? { otherKeysAdded: keysAdded } : {}),
            ...(keysRemoved.length ? { otherKeysRemoved: keysRemoved } : {}),
          })
          const shown = Object.entries(changed)
            .filter(([k]) => k !== 'updatedAt' && k !== 'statusUpdatedAt')
            .map(([k, v]) => `${k}=${clip(JSON.stringify(v.to), 40)}`)
          if (keysAdded.length) shown.push(`+keys ${keysAdded.join(',')}`)
          if (keysRemoved.length) shown.push(`-keys ${keysRemoved.join(',')}`)
          if (shown.length) print(`${clockTime()}       registry ~ ${pidOf(file) ?? file} ${short(fields.sessionId)} ${shown.join(' ')}`)
        }
      }
      for (const [file, r] of registry) {
        if (jsons.has(file)) continue
        registry.delete(file)
        unreadable.delete(file)
        write(registryFile, { ...stampLine(), kind: 'removed', file, last: r.fields })
        print(`${clockTime()}       registry - ${pidOf(file) ?? file} ${short(r.fields.sessionId)}`)
      }
      for (const file of unreadable) if (!jsons.has(file)) unreadable.delete(file)
    } finally {
      scanning = false
      initial = false
    }
  }

  // ---- start --------------------------------------------------------------

  const servers = []
  const tcp = http.createServer((req, res) => void handle('tcp', req, res))
  servers.push(tcp)
  // Held requests may last up to the cap: no server-side request timeouts.
  tcp.requestTimeout = 0
  tcp.timeout = 0
  await listen(tcp, { port: o.port, host: '127.0.0.1' })
  const port = tcp.address().port

  let socketPath = null
  if (o.socketPath) {
    try {
      await clearStaleSocket(o.socketPath)
      const unix = http.createServer((req, res) => void handle('unix', req, res))
      unix.requestTimeout = 0
      unix.timeout = 0
      await listen(unix, o.socketPath)
      fs.chmodSync(o.socketPath, 0o600)
      servers.push(unix)
      socketPath = o.socketPath
    } catch (err) {
      await new Promise(r => tcp.close(r))
      throw err
    }
  }

  const config = {
    pid: process.pid, node: process.version, startedAt: new Date().toISOString(),
    tcp: `127.0.0.1:${port}`, socketPath, tokenFile: o.tokenFile, token: token === null ? 'missing' : 'loaded',
    sessionsDir: o.registry === false ? null : o.sessionsDir, holdCapMs: o.holdCapMs, registryMs: o.registryMs, policy,
  }
  fs.writeFileSync(path.join(runDir, 'bridge.json'), `${JSON.stringify(config, null, 2)}\n`)
  print(`deck-spike bridge: tcp 127.0.0.1:${port}${socketPath ? `, unix ${socketPath}` : ''}`)
  print(`  results ${runDir}`)
  print(`  token ${token === null ? `MISSING (${o.tokenFile}): every request will read auth=mismatch or absent` : 'loaded'}; hold cap ${o.holdCapMs} ms; registry ${o.registry === false ? 'off' : o.sessionsDir}`)

  let regTimer = null
  if (o.registry !== false) {
    await scan()
    regTimer = setInterval(() => void scan(), o.registryMs)
  }

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    if (regTimer) clearInterval(regTimer)
    for (const e of perms.values()) if (e.state === 'held') answer(e, {}, 'shutdown')
    await Promise.all(servers.map(s => new Promise(resolve => {
      s.close(() => resolve())
      s.closeAllConnections()
    })))
    if (socketPath) {
      try {
        if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath)
      } catch {}
    }
  }

  return { port, socketPath, runDir, close, policy: () => policy, scan }
}

// ---- command line -----------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      sock: { type: 'string' },
      'token-file': { type: 'string' },
      results: { type: 'string' },
      'sessions-dir': { type: 'string' },
      'hold-cap-ms': { type: 'string' },
      'registry-ms': { type: 'string' },
      'no-registry': { type: 'boolean' },
      'all-polls': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stdout.write(`usage: node bridge.mjs [--port N] [--sock PATH|none] [--token-file PATH] [--results DIR]
                      [--sessions-dir DIR] [--hold-cap-ms N] [--registry-ms N] [--no-registry] [--all-polls]
env: PORT, BRIDGE_SOCK, BRIDGE_TOKEN_FILE, BRIDGE_RESULTS_DIR, CC_SESSIONS_DIR, BRIDGE_HOLD_CAP_MS, BRIDGE_REGISTRY_MS
`)
    return
  }
  const num = (flag, env, fallback) => {
    const raw = values[flag] ?? process.env[env]
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a number >= 0`)
    return n
  }
  const sock = values.sock ?? process.env.BRIDGE_SOCK
  const bridge = await startBridge({
    port: num('port', 'PORT', DEFAULTS.port),
    socketPath: sock === 'none' ? null : sock ? path.resolve(sock) : DEFAULTS.socketPath,
    tokenFile: values['token-file'] ?? process.env.BRIDGE_TOKEN_FILE,
    resultsDir: values.results ?? process.env.BRIDGE_RESULTS_DIR,
    sessionsDir: values['sessions-dir'] ?? process.env.CC_SESSIONS_DIR,
    holdCapMs: num('hold-cap-ms', 'BRIDGE_HOLD_CAP_MS', DEFAULTS.holdCapMs),
    registryMs: num('registry-ms', 'BRIDGE_REGISTRY_MS', DEFAULTS.registryMs),
    registry: !values['no-registry'],
    allPolls: values['all-polls'],
  })
  const stop = async signal => {
    process.stdout.write(`\n${signal}: closing\n`)
    await bridge.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`bridge: ${err.message ?? err}\n`)
    process.exit(1)
  })
}
