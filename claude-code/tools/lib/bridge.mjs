// The fake bridge's HTTP side (claude-code/protocol/PROTOCOL.md, v1): the five /v1/ routes on 127.0.0.1,
// the control routes beside them, the registry and records readings, and a JSONL log of every request and
// answer in the run folder. The token is checked like the deck checks it and never written anywhere. The
// deck's logic lives in deck.mjs; this file only adapts HTTP and the folders to it, and reads the registry once
// more when a hook's request or a hello needs it ("Desktop sessions only").

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { BadRequest, FakeDeck, NotThisSession } from './deck.mjs'
import { REPO } from './fixtures.mjs'
import { HOST_PATTERN, MAX_BODY, MAX_WAIT_S, ROUTE_METHODS, ROUTES } from './protocol.mjs'
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
  '/control/dial': 'POST',
  '/control/prompt': 'POST',
  '/control/rescan': 'POST',
  '/control/reset': 'POST',
})

/** A logged body bigger than this is cut to its outline: a Write can carry a whole file. */
const LOGGED_BODY_MAX = 64 * 1024

/** Runs of the token this long or longer are scrubbed too, not only the whole of it. */
const TOKEN_RUN = 8

/** The status Node answers each of its own errors with; any other is 400. */
const NODE_ERRORS = Object.freeze({ HPE_HEADER_OVERFLOW: 431, HPE_CHUNK_EXTENSIONS_OVERFLOW: 413, ERR_HTTP_REQUEST_TIMEOUT: 408 })

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const pad = (n, w = 2) => String(n).padStart(w, '0')
const round1 = (x) => Math.round(x * 10) / 10

/**
 * What an exception says, on one short line. Nothing about it can throw again: a getter, a toString, a
 * message nested too deep to print.
 */
export function errorText(err) {
  try {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : `a thrown ${typeof err}`
    return text.split('\n')[0].slice(0, 200)
  } catch {
    return 'an exception that has no message'
  }
}

/**
 * The deck's Scrubber for one secret (claude-code/deck/src/util/log.ts): every window of TOKEN_RUN characters of
 * `text` that's also one of the secret's is covered, and each run of overlapping or touching windows becomes one
 * `<token>`, so the secret written twice in a row is one. A run is enough to leak it: the mod cuts a summary to 39
 * characters from an input that holds the token, so its tool.start can carry the token's first few characters without
 * the rest. A secret shorter than TOKEN_RUN is only taken out whole, and an empty one takes nothing out. One pass, with
 * no regular expression, so its time grows only with the text's length.
 */
export function secretScrubber(secret) {
  if (secret === '') return (text) => text
  if (secret.length < TOKEN_RUN) return (text) => text.split(secret).join('<token>')
  const chars = new Set()
  for (let i = 0; i < secret.length; i++) chars.add(secret.charCodeAt(i))
  const windows = new Set()
  for (let i = 0; i + TOKEN_RUN <= secret.length; i++) windows.add(secret.slice(i, i + TOKEN_RUN))
  return (text) => {
    if (text.length < TOKEN_RUN) return text
    let out = ''
    let copied = 0
    // The covered run being built, [start, end).
    let start = -1
    let end = -1
    // How many of the secret's characters in a row end at i: only a window made wholly of them can be one of its.
    let stretch = 0
    for (let i = 0; i < text.length; i++) {
      if (!chars.has(text.charCodeAt(i))) {
        stretch = 0
        continue
      }
      if (++stretch < TOKEN_RUN) continue
      const from = i + 1 - TOKEN_RUN
      if (!windows.has(text.slice(from, i + 1))) continue
      if (from > end) {
        if (start >= 0) {
          out += `${text.slice(copied, start)}<token>`
          copied = end
        }
        start = from
      }
      end = i + 1
    }
    if (start < 0) return text
    return `${out}${text.slice(copied, start)}<token>${text.slice(end)}`
  }
}

/**
 * What every line of the log, every control answer and every line on stdout is scrubbed with: the token and any run
 * of TOKEN_RUN or more of its characters, as secretScrubber takes them out, both as they are and as JSON escapes them,
 * since a line of the log is JSON. A body is scrubbed once it has parsed, with the token as it is (scrubBody).
 */
export function scrubber(token) {
  const scrubs = [...new Set([token, JSON.stringify(token).slice(1, -1)])].map(secretScrubber)
  return (text) => scrubs.reduce((t, scrub) => scrub(t), text)
}

/**
 * A parsed body with the token taken out of every string in it, names included, as the deck's bridge takes it out
 * (scrubJson in claude-code/deck/src/bridge/server.ts; PROTOCOL.md, "Transport"): after parsing, so a number that holds
 * a run of the token's digits is left alone, and a body that parses is never refused for the scrub. `scrub` is
 * secretScrubber's, for the token as it is. The body is changed in place, since nothing else holds it, and walked from
 * a list of the objects and arrays still to visit rather than by recursion, so no depth of nesting can overflow the
 * stack. A renamed key is defined as JSON.parse defines it, so a "__proto__" stays an ordinary key; of two names that
 * scrub alike, the later value wins, in the earlier's place.
 */
export function scrubBody(body, scrub) {
  if (typeof body === 'string') return scrub(body)
  const todo = [body]
  while (todo.length > 0) {
    const value = todo.pop()
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const v = value[i]
        if (typeof v === 'string') value[i] = scrub(v)
        else if (v !== null && typeof v === 'object') todo.push(v)
      }
    } else if (isObject(value)) {
      let renamed = false
      for (const k of Object.keys(value)) {
        const v = value[k]
        if (typeof v === 'string') value[k] = scrub(v)
        else if (v !== null && typeof v === 'object') todo.push(v)
        if (scrub(k) !== k) renamed = true
      }
      if (!renamed) continue
      const entries = Object.entries(value)
      for (const [k] of entries) delete value[k]
      for (const [k, v] of entries) Object.defineProperty(value, scrub(k), { value: v, writable: true, enumerable: true, configurable: true })
    }
  }
  return body
}

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
 * `tokenFile`, `runDir` (else a new folder under `runRoot`), `registryDir`, `recordsDir`, `registryMs` (0 reads
 * only on /control/rescan, and when a request needs a second reading), `now` (the deck's wall clock, for tests),
 * `monoNow` (its monotonic clock, for tests), `inFlightMs`, `cmdPrefix`, `quiet`, `print(line)`.
 * Resolves `{port, url, runDir, deck, rescan(), close()}`.
 */
export async function startFakeBridge(options = {}) {
  const o = { ...DEFAULTS }
  for (const [k, v] of Object.entries(options)) if (v !== undefined) o[k] = v
  const token = o.token ?? readToken(o.tokenFile)
  const runDir = makeRunDir(o.runDir, o.runRoot)
  const logFile = path.join(runDir, 'events.jsonl')
  const print = o.quiet ? () => {} : (o.print ?? ((line) => process.stdout.write(`${line}\n`)))
  // The token never reaches the log: every line is scrubbed of it, and of any run of it, whatever field it
  // hid in. Bodies are scrubbed as the deck scrubs them, once they've parsed, of the token as it is.
  const scrub = scrubber(token)
  const scrubToken = secretScrubber(token)
  // A number whose digits hold a run of the token, which a body can carry since the scrub leaves numbers alone, goes
  // into a line of the log or a control answer as a string, scrubbed, so the line is still JSON once it's scrubbed.
  const numbers = (k, v) => {
    if (typeof v !== 'number') return v
    const text = JSON.stringify(v)
    const scrubbed = scrub(text)
    return scrubbed === text ? v : scrubbed
  }
  // A log that can't be written (its folder gone, the disk full) must not take the bridge down with it, and
  // nor must a line that can't be made: one holding a body nested too deep for JSON.stringify keeps its plain
  // fields, which can't fail, and says why the rest is missing.
  let writeFailed = false
  const write = (obj) => {
    let line
    try {
      line = JSON.stringify(obj, numbers)
    } catch (err) {
      const plain = Object.entries(obj).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
      line = JSON.stringify({ ...Object.fromEntries(plain), unlogged: errorText(err) }, numbers)
    }
    try {
      fs.appendFileSync(logFile, `${scrub(line)}\n`)
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

  const deck = new FakeDeck({ log, now: o.now, monoNow: o.monoNow, inFlightMs: o.inFlightMs, cmdPrefix: o.cmdPrefix })
  let taken = 0
  let reqSeq = 0
  let port = null
  let allowedHosts = []

  // ---- folders ---------------------------------------------------------------------------------------------

  let registryEntries = new Map()
  const recordFiles = new Map()
  // What the last reading of the registry folder found wrong with it, so each is said once until it changes: null, or
  // 'missing', or 'unreadable'.
  let dirTrouble = null
  let scanning = Promise.resolve()

  async function scanOnce() {
    try {
      const r = await readRegistry(o.registryDir, registryEntries)
      if (!r.ok) {
        // PROTOCOL.md, "The deck's session model": a reading that can't list the folder changes nothing. The deck keeps
        // its last reading, and warns once until a reading succeeds.
        if (dirTrouble !== 'unreadable') log({ kind: 'registry-unreadable', dir: o.registryDir, error: r.error, say: `registry folder unreadable (${r.error}), so the last reading stands until one succeeds: ${o.registryDir}` })
        dirTrouble = 'unreadable'
        return
      }
      // A folder that doesn't exist is no sessions: said once, and every session it listed ends (release rule 4).
      if (r.missing && dirTrouble !== 'missing') log({ kind: 'registry-missing', dir: o.registryDir, say: `registry folder missing, so no sessions: ${o.registryDir}` })
      dirTrouble = r.missing ? 'missing' : null
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
      const why = errorText(err)
      log({ kind: 'scan-error', error: why, say: `scan failed: ${why}` })
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
      let text
      try {
        text = json === undefined ? '' : JSON.stringify(json, isControl ? numbers : undefined)
      } catch (err) {
        // Written out before the request counts as answered: a body that can't be, one nested too deep, gets a
        // plain 500 in its place, which can't fail, rather than no answer at all.
        return send(500, { error: `the fake bridge can't write its answer: ${errorText(err)}` })
      }
      // A control answer reaches a person's terminal, so it's scrubbed like the log: the registry's and records'
      // fields come from files the token can be in, a session's title say, and nothing scrubbed them on the way in.
      if (isControl) text = scrub(text)
      answered = true
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
      /**
       * Drops the connection with no answer, as a deck that restarts drops it, so the client's request fails: a mod
       * whose poll fails says hello again (PROTOCOL.md, "Failure and recovery"). A reset does this to open polls.
       */
      cut() {
        if (!responder.open) return false
        answered = true
        write({ kind: 'cut', n, t: Date.now(), ms: round1(performance.now() - t0) })
        req.socket.destroy()
        return true
      },
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
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(400, "the body isn't JSON")
            return
          }
          // The token, and any run of it, is taken out of every string and name before anything reads the body, as
          // the deck takes it out (PROTOCOL.md, "Transport"): a summary cut short, the bridge's or the mod's, could
          // otherwise carry part of it into the state and the log. A request whose input held the token then gets
          // another fp than the mod's, and is released by the other rules.
          body = scrubBody(parsed, scrubToken)
          entry.body = forLog(body, text)
          if (!isObject(body)) {
            reject(400, 'the body must be a JSON object')
            return
          }
        }
        logRequest()
        if (isControl) {
          control(route, body ?? {}, send).catch((err) => failed('control-error', n, route, err, send))
          return
        }
        const routeFailed = (err) => {
          if (err instanceof NotThisSession) send(409, { error: err.message })
          else if (err instanceof BadRequest) send(400, { error: err.message })
          else failed('route-error', n, route, err, send)
        }
        // Taken once it's answered or held: after the second reading of the registry, for a request that needs one.
        let pending
        try {
          pending = dispatch(route, url, req, body, responder, watchClose)
        } catch (err) {
          routeFailed(err)
        }
        if (!pending) {
          counted()
          return
        }
        pending.then(counted, (err) => {
          routeFailed(err)
          counted()
        })
      },
      (err) => write({ kind: 'close', n, t: Date.now(), ms: round1(performance.now() - t0), error: errorText(err) }),
    )
  }

  /**
   * A route that threw: 500 for its client, and the bridge carries on. A tool_input nested too deep for
   * canonical() does this, say. The hook takes a 500 as no decision, so the app's dialog decides. The log
   * line is made of nothing that can throw again: neither the body nor the error itself.
   */
  function failed(kind, n, route, err, send) {
    const why = errorText(err)
    write({ kind, n, t: Date.now(), route, error: why })
    try {
      print(`${clock()} ${route} failed: ${scrub(why)}`)
    } catch {}
    send(500, { error: `the fake bridge failed on this request: ${why}` })
  }

  /**
   * Hands a request to the deck. Returns a promise when the deck needs the registry read once more first
   * (PROTOCOL.md, "Desktop sessions only"), which settles once the request is answered or held; else nothing.
   */
  function dispatch(route, url, req, body, responder, watchClose) {
    switch (route) {
      case ROUTES.permission: {
        const hostHeader = req.headers['x-deck-host']
        const take = () => {
          const r = deck.permission({ body, hostHeader, responder })
          if (r.id) watchClose(() => deck.clientClosed(r.id))
        }
        // A hook's request from a session the latest reading doesn't confirm: the registry is read once more, and the
        // deck then takes it or answers {} at once. Its client may have gone meanwhile, as the real deck allows for:
        // then nothing is answered or held.
        if (deck.hookNeedsReading(hostHeader, body)) {
          return rescan().then(() => {
            if (responder.open) {
              take()
              return
            }
            const host = typeof hostHeader === 'string' && HOST_PATTERN.test(hostHeader) ? hostHeader : null
            log({
              kind: 'client-gone', route: route.slice('/v1/'.length), host, sid: typeof body.session_id === 'string' ? body.session_id : null,
              why: 'its client went away while the registry was read once more',
              say: `permission request from ${host ?? '(no host)'}: its client went away while the registry was read once more, so it isn't taken`,
            })
          })
        }
        take()
        return
      }
      case ROUTES.hello: {
        const answer = () => responder.send(200, deck.hello(body))
        // A hello the latest reading would refuse: read once more, so a session whose id has just changed isn't
        // refused on a reading made before.
        if (deck.helloNeedsReading(body)) return rescan().then(answer)
        answer()
        return
      }
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
        case '/control/dial':
          // A Session Slot dial's press for its session's request, with a decision or nothing picked: `shown` as for the
          // keys, the request its strip showed. Any other field is a press the dial can't make since Phase 9.
          {
            const stray = Object.keys(b).find((k) => !['host', 'decision', 'shown'].includes(k))
            if (stray !== undefined) throw new BadRequest(`a dial press has a host, and at most a decision and the request its strip showed; got ${stray}`)
          }
          send(200, deck.dial({ host: b.host, decision: b.decision, ...(Object.hasOwn(b, 'shown') ? { shown: b.shown } : {}) }))
          return
        case '/control/prompt':
          send(200, deck.prompt({ host: b.host, text: b.text }))
          return
        case '/control/rescan':
          await rescan()
          send(200, { ok: true, sessions: deck.listed })
          return
        case '/control/reset':
          // Forgets the run so far: held requests get no decision, and open polls are cut off with no answer, so
          // their mods say hello again (FakeDeck.reset). The folders are read again from scratch, so what they hold
          // now reads as new.
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
  // A request Node takes no further: one it can't parse, with headers over its limit, or too slow to arrive. Node's
  // own answer has no body; this one carries {"error"}, like every error answer ("Transport"), with Node's status.
  // It goes only where it can't cut into another answer, a connection nothing has been written to, and a client
  // that has gone gets nothing.
  server.on('clientError', (err, socket) => {
    if (err.code !== 'ECONNRESET' && socket.writable && socket.bytesWritten === 0) {
      const status = NODE_ERRORS[err.code] ?? 400
      const text = JSON.stringify({ error: http.STATUS_CODES[status] })
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`)
      write({ kind: 'client-error', t: Date.now(), status, code: err.code ?? null })
    }
    socket.destroy()
  })
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
