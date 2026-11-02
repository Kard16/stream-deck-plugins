// The fake bridge's HTTP side (claude-code/protocol/PROTOCOL.md, v1): the five /v1/ routes on 127.0.0.1,
// the control routes beside them, the registry and records readings, and a JSONL log of every request and
// answer in the run folder. The token is checked like the deck checks it and never written anywhere. The
// deck's logic lives in deck.mjs; this file only adapts HTTP and the folders to it.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { BadRequest, FakeDeck } from './deck.mjs'
import { REPO } from './fixtures.mjs'
import { MAX_BODY, MAX_WAIT_S, ROUTE_METHODS, ROUTES } from './protocol.mjs'
import { findRecord, readRecord, readRegistry, signature } from './registry.mjs'

export const DEFAULTS = Object.freeze({
  port: 47600,
  /** The spike bridge's token, so the deck-sandbox preset's DECK_TOKEN works with the fake bridge too. */
  tokenFile: path.join(REPO, 'spikes', 'cc-bridge', 'run', 'token'),
  /** Run folders go under here, one per start. The root .gitignore's rule for run folders keeps them out of git. */
  runRoot: path.join(REPO, 'claude-code', 'tools', 'run'),
  registryDir: path.join(os.homedir(), '.claude', 'sessions'),
  recordsDir: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  registryMs: 1000,
})

/** The control routes and their methods. Token-checked like the rest. */
export const CONTROL_ROUTES = Object.freeze({
  '/control/state': 'GET',
  '/control/taken': 'GET',
  '/control/answer': 'POST',
  '/control/approve': 'POST',
  '/control/deny': 'POST',
  '/control/prompt': 'POST',
  '/control/mode': 'POST',
  '/control/rescan': 'POST',
  '/control/reset': 'POST',
})

/** A logged body bigger than this is cut to its outline: a Write can carry a whole file. */
const LOGGED_BODY_MAX = 64 * 1024

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const pad = (n, w = 2) => String(n).padStart(w, '0')
const round1 = (x) => Math.round(x * 10) / 10

function clock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** The token: the trimmed file. A missing or empty one stops the start, since every request would fail. */
export function readToken(file) {
  let token
  try {
    token = fs.readFileSync(file, 'utf8').trim()
  } catch (err) {
    throw new Error(`can't read the token file ${file}: ${err.code ?? err.message}`)
  }
  if (token === '') throw new Error(`the token file ${file} is empty`)
  return token
}

/** `Bearer <token>`, the scheme in any case, compared in constant time: ok, missing or wrong. */
export function checkBearer(header, token) {
  if (header === undefined || header.trim() === '') return 'missing'
  const m = /^bearer\s+(\S+)\s*$/i.exec(header.trim())
  if (!m) return 'wrong'
  const presented = createHash('sha256').update(m[1]).digest()
  const expected = createHash('sha256').update(token).digest()
  return timingSafeEqual(presented, expected) ? 'ok' : 'wrong'
}

/** The long poll's wait in seconds: 0–20, 20 when it's missing or not a number. */
export function parseWait(raw) {
  if (raw === null || raw === '') return MAX_WAIT_S
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return MAX_WAIT_S
  return Math.min(n, MAX_WAIT_S)
}

function makeRunDir(dir, root) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return path.resolve(dir)
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const base = `${stamp()}-fake-bridge`
  for (let i = 1; ; i++) {
    const d = path.join(root, i === 1 ? base : `${base}-${i}`)
    try {
      fs.mkdirSync(d, { mode: 0o700 })
      return d
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

/** Reads a body up to `max` bytes: `{text}`, or `{tooLarge: true}`. Rejects when the client goes away. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (fn) => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > max) {
        settle(() => resolve({ tooLarge: true }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => settle(() => resolve({ text: Buffer.concat(chunks).toString('utf8') })))
    req.on('error', (err) => settle(() => reject(err)))
    req.on('close', () => settle(() => reject(new Error('closed before the body ended'))))
  })
}

/** A body for the log: as it came, or its outline when it's large. */
function forLog(body, text) {
  if (text.length <= LOGGED_BODY_MAX) return body
  const outline = { truncated: true, bytes: Buffer.byteLength(text) }
  if (isObject(body)) {
    outline.keys = Object.keys(body)
    for (const k of ['tool_name', 'session_id', 'sid', 'host', 'inst', 'seq']) if (k in body) outline[k] = body[k]
  }
  return outline
}

/**
 * Starts the fake bridge. Options (DEFAULTS fills the rest): `port` (0 for any free one), `token` or
 * `tokenFile`, `runDir`, `registryDir`, `recordsDir`, `registryMs` (0 reads only on /control/rescan),
 * `now` (the deck's clock, for tests), `inFlightMs`, `cmdPrefix`, `quiet`, `print(line)`.
 * Resolves `{port, url, runDir, deck, rescan(), close()}`.
 */
export async function startFakeBridge(options = {}) {
  const o = { ...DEFAULTS }
  for (const [k, v] of Object.entries(options)) if (v !== undefined) o[k] = v
  const token = o.token ?? readToken(o.tokenFile)
  const runDir = makeRunDir(o.runDir, o.runRoot)
  const logFile = path.join(runDir, 'events.jsonl')
  const print = o.quiet ? () => {} : (o.print ?? ((line) => process.stdout.write(`${line}\n`)))
  // The token never reaches the log: every line is scrubbed of it as a whole, whatever field it hid in, both
  // as it is and as JSON escapes it.
  const escaped = JSON.stringify(token).slice(1, -1)
  const scrub = (text) => text.split(token).join('<token>').split(escaped).join('<token>')
  // A log that can't be written (its folder gone, the disk full) must not take the bridge down with it.
  let writeFailed = false
  const write = (obj) => {
    try {
      fs.appendFileSync(logFile, `${scrub(JSON.stringify(obj))}\n`)
      writeFailed = false
    } catch (err) {
      if (!writeFailed) process.stderr.write(`fake bridge: can't write ${logFile}: ${err.code ?? err.message}\n`)
      writeFailed = true
    }
  }
  const log = (event) => {
    const { say, ...rest } = event
    write({ t: Date.now(), ...rest })
    if (say) print(`${clock()} ${scrub(say)}`)
  }

  const deck = new FakeDeck({ log, now: o.now, inFlightMs: o.inFlightMs, cmdPrefix: o.cmdPrefix })
  let taken = 0
  let reqSeq = 0
  let port = null
  let allowedHosts = []

  // ---- folders ---------------------------------------------------------------------------------------------

  let registryEntries = new Map()
  const recordFiles = new Map()
  let dirErrorLogged = false
  let scanning = Promise.resolve()

  async function scanOnce() {
    try {
      const r = await readRegistry(o.registryDir, registryEntries)
      if (!r.ok) {
        // An unreadable folder isn't every session ending: keep what the deck has.
        if (!dirErrorLogged) log({ kind: 'registry-unreadable', dir: o.registryDir, error: r.error, say: `registry folder unreadable (${r.error}): ${o.registryDir}` })
        dirErrorLogged = true
        return
      }
      dirErrorLogged = false
      registryEntries = r.entries
      deck.applyRegistry(registryEntries.values())
      const listed = new Set(deck.listed)
      for (const host of listed) {
        let rec = recordFiles.get(host)
        if (!rec?.file) {
          rec = { file: await findRecord(o.recordsDir, host), sig: null }
          recordFiles.set(host, rec)
          if (!rec.file) continue
        }
        const sig = await signature(rec.file)
        if (sig === null) {
          recordFiles.delete(host)
          deck.applyRecord(host, null)
        } else if (sig !== rec.sig) {
          // A record that doesn't parse is most likely half-written: keep the last good one and read again.
          const record = await readRecord(rec.file)
          if (record) {
            rec.sig = sig
            deck.applyRecord(host, record)
          }
        }
      }
      for (const host of [...recordFiles.keys()]) {
        if (listed.has(host)) continue
        recordFiles.delete(host)
        deck.applyRecord(host, null)
      }
    } catch (err) {
      log({ kind: 'scan-error', error: String(err?.message ?? err), say: `scan failed: ${err?.message ?? err}` })
    }
  }

  /** Reads the folders now, after any reading already under way: readings never overlap. */
  const rescan = () => (scanning = scanning.then(scanOnce))

  // ---- HTTP ------------------------------------------------------------------------------------------------

  function handle(req, res) {
    const n = ++reqSeq
    const t0 = performance.now()
    let url
    try {
      url = new URL(req.url ?? '/', 'http://bridge')
    } catch {
      // A target URL can't parse (`http://[`, say): an error here would take the whole server down.
      write({ kind: 'request', n, t: Date.now(), method: req.method, target: String(req.url).slice(0, 200), bad: true })
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: "the request's target isn't a path" }))
      req.resume()
      return
    }
    const route = url.pathname
    const isControl = route.startsWith('/control/')
    const entry = { kind: 'request', n, t: Date.now(), method: req.method, path: route, ...(url.search ? { query: url.search } : {}), hostHeader: req.headers.host ?? null }
    let answered = false
    let logged = false
    const logRequest = () => {
      if (!logged) write(entry)
      logged = true
    }

    const send = (status, json, headers = {}) => {
      if (answered || res.writableEnded || res.destroyed) return false
      answered = true
      const text = json === undefined ? '' : JSON.stringify(json)
      res.writeHead(status, text ? { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : headers)
      res.end(text)
      write({ kind: 'answer', n, t: Date.now(), status, ms: round1(performance.now() - t0), ...(json === undefined ? {} : { body: json }) })
      return true
    }
    const responder = {
      get open() {
        return !answered && !res.writableEnded && !res.destroyed && !req.socket.destroyed
      },
      send,
    }
    /** For held requests and polls: tells the deck when the client goes away first. */
    const watchClose = (fn) => {
      const onClose = () => {
        if (answered) return
        answered = true
        write({ kind: 'close', n, t: Date.now(), ms: round1(performance.now() - t0) })
        fn()
      }
      res.once('close', onClose)
      if (req.socket.destroyed) onClose()
    }
    const counted = () => {
      if (!isControl) taken++
    }
    const reject = (status, error, headers) => {
      logRequest()
      send(status, { error }, headers)
      req.resume()
      counted()
    }

    // The Host first, before the token is looked at (PROTOCOL.md, "Transport").
    if (!allowedHosts.includes((req.headers.host ?? '').toLowerCase())) {
      reject(403, `Host ${JSON.stringify(req.headers.host ?? null)} isn't 127.0.0.1:${port} or localhost:${port}`)
      return
    }
    const auth = checkBearer(req.headers.authorization, token)
    entry.auth = auth
    if (auth !== 'ok') {
      reject(401, auth === 'missing' ? 'no token' : 'wrong token', { 'www-authenticate': 'Bearer realm="streamdeck"' })
      return
    }
    const method = isControl ? CONTROL_ROUTES[route] : ROUTE_METHODS[route]
    if (!method) {
      reject(404, `no route ${route}`)
      return
    }
    if (req.method !== method) {
      reject(405, `${route} takes ${method}`, { allow: method })
      return
    }

    readBody(req, MAX_BODY).then(
      ({ text, tooLarge }) => {
        if (tooLarge) {
          reject(413, `the body is over ${MAX_BODY} bytes`)
          return
        }
        let body
        if (method === 'POST' && !(isControl && text === '')) {
          try {
            // The token is taken out before anything reads the body, as the deck does: a summary cut short
            // could otherwise carry part of it past the scrubbing. A request whose input held the token then
            // gets another fp than the mod's, and is released by the other rules.
            body = JSON.parse(scrub(text))
          } catch {
            reject(400, "the body isn't JSON")
            return
          }
          entry.body = forLog(body, text)
          if (!isObject(body)) {
            reject(400, 'the body must be a JSON object')
            return
          }
        }
        logRequest()
        if (isControl) {
          control(route, body ?? {}, send).catch((err) => {
            log({ kind: 'control-error', route, error: String(err?.message ?? err), say: `${route} failed: ${err?.message ?? err}` })
            send(500, { error: String(err?.message ?? err) })
          })
          return
        }
        dispatch(route, url, req, body, responder, watchClose)
        counted()
      },
      (err) => write({ kind: 'close', n, t: Date.now(), ms: round1(performance.now() - t0), error: String(err?.message ?? err) }),
    )
  }

  function dispatch(route, url, req, body, responder, watchClose) {
    switch (route) {
      case ROUTES.permission: {
        const r = deck.permission({ body, hostHeader: req.headers['x-deck-host'], responder })
        if (r.id) watchClose(() => deck.clientClosed(r.id))
        return
      }
      case ROUTES.hello:
        responder.send(200, deck.hello(body))
        return
      case ROUTES.events:
        deck.events(body)
        responder.send(204)
        return
      case ROUTES.result:
        deck.result(body)
        responder.send(204)
        return
      case ROUTES.next: {
        const q = url.searchParams
        const id = deck.poll({ sid: q.get('sid'), host: q.get('host'), inst: q.get('inst'), wait: parseWait(q.get('wait')), responder })
        if (id === null) responder.send(400, { error: 'the poll names no session: give host, or a sid the registry knows' })
        else if (responder.open) watchClose(() => deck.pollClosed(id))
        return
      }
      default:
        responder.send(404, { error: `no route ${route}` })
    }
  }

  async function control(route, b, send) {
    try {
      switch (route) {
        case '/control/state':
          send(200, { v: 1, url: `http://127.0.0.1:${port}`, runDir, dirs: { registry: o.registryDir, records: o.recordsDir }, taken, ...deck.state() })
          return
        case '/control/taken':
          send(200, { taken })
          return
        case '/control/answer': {
          const r = deck.answer({ id: b.id, decision: b.decision })
          send(r.ok ? 200 : 404, r)
          return
        }
        case '/control/approve':
        case '/control/deny':
          send(200, deck.press(route.slice('/control/'.length), Object.hasOwn(b, 'shown') ? { shown: b.shown } : {}))
          return
        case '/control/prompt':
          send(200, deck.prompt({ host: b.host, text: b.text }))
          return
        case '/control/mode':
          send(200, deck.mode({ host: b.host, mode: b.mode }))
          return
        case '/control/rescan':
          await rescan()
          send(200, { ok: true, sessions: deck.listed })
          return
        case '/control/reset':
          // Forgets the run so far: held requests get no decision, polls no commands. The folders are read
          // again from scratch, so what they hold now reads as new.
          deck.reset()
          taken = 0
          registryEntries = new Map()
          for (const host of recordFiles.keys()) deck.applyRecord(host, null)
          recordFiles.clear()
          await rescan()
          log({ kind: 'reset', say: 'reset' })
          send(200, { ok: true, sessions: deck.listed })
          return
        default:
          send(404, { error: `no route ${route}` })
      }
    } catch (err) {
      if (err instanceof BadRequest) send(400, { ok: false, error: err.message })
      else throw err
    }
  }

  // ---- start and stop --------------------------------------------------------------------------------------

  const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 30_000 }, handle)
  // Held requests last up to the hook's 600 s and polls up to 20 s: nothing on the socket times them out.
  server.timeout = 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = server.address().port
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  const url = `http://127.0.0.1:${port}`

  fs.writeFileSync(
    path.join(runDir, 'bridge.json'),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), url, tokenFile: o.token ? '(given)' : o.tokenFile, registryDir: o.registryDir, recordsDir: o.recordsDir, registryMs: o.registryMs }, null, 2)}\n`,
  )
  print(`fake bridge on ${url}`)
  print(`  token from ${o.token ? '(given)' : o.tokenFile}; log in ${runDir}`)
  print(`  registry ${o.registryDir} and records ${o.recordsDir}, read only, every ${o.registryMs || '(only on rescan)'} ms`)

  await rescan()
  const timer = o.registryMs > 0 ? setInterval(() => void rescan(), o.registryMs) : null

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    await scanning
    try {
      deck.close()
    } catch (err) {
      process.stderr.write(`fake bridge: closing the deck: ${err.message ?? err}\n`)
    }
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
      // The answers just written go out and their connections close; anything still open after a moment is cut.
      setTimeout(() => server.closeAllConnections(), 200).unref()
    })
    write({ kind: 'stop', t: Date.now() })
  }

  return { port, url, runDir, deck, rescan, close }
}
