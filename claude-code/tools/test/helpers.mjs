// Shared by the tests: temp folders standing in for the registry and records, a fake bridge on a free port,
// a recording responder and fake timers for driving the deck model directly. Nothing here reads or writes
// ~/.claude/ or the app's folders, and nothing binds 47600 or 47601.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { startFakeBridge } from '../lib/bridge.mjs'
import { hostHeader, send } from '../lib/client.mjs'

export const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A temp root with empty registry and records folders, a run folder and a token file; removed after `t`,
 * once whatever was pushed on `env.closers` (bridges) has closed, newest first.
 */
export function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tools-'))
  const env = {
    root,
    registryDir: path.join(root, 'registry'),
    recordsDir: path.join(root, 'records'),
    runDir: path.join(root, 'run'),
    tokenFile: path.join(root, 'token'),
    token: `test-${randomBytes(12).toString('hex')}`,
    closers: [],
  }
  fs.mkdirSync(env.registryDir)
  fs.mkdirSync(env.recordsDir)
  fs.writeFileSync(env.tokenFile, `${env.token}\n`, { mode: 0o600 })
  t?.after(async () => {
    for (const close of env.closers.reverse()) await close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return env
}

/** A fake bridge on a free port over `env`'s folders, quiet, reading the folders only when told; closed after the test. */
export async function startBridge(t, env, options = {}) {
  const bridge = await startFakeBridge({
    port: 0, tokenFile: env.tokenFile, runDir: env.runDir, registryDir: env.registryDir, recordsDir: env.recordsDir,
    registryMs: 0, quiet: true, ...options,
  })
  env.closers.push(() => bridge.close())
  return bridge
}

/** A request to `bridge` with the right Host and token unless `headers` says otherwise. */
export function request(bridge, token, { method = 'GET', path: p = '/', headers = {}, json, raw } = {}) {
  const h = { host: hostHeader(bridge.url), authorization: `Bearer ${token}`, ...headers }
  return send(bridge.url, { method, path: p, headers: h, body: raw ?? (json === undefined ? undefined : JSON.stringify(json)) })
}

export function writeRegistry(env, pid, fields) {
  fs.writeFileSync(path.join(env.registryDir, `${pid}.json`), JSON.stringify({ pid, ...fields }))
}

export function writeRecord(env, host, record) {
  const dir = path.join(env.recordsDir, 'acct', 'org')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${host}.json`), JSON.stringify(record))
}

/** The run folder's events.jsonl as objects. */
export function runLog(env) {
  return fs.readFileSync(path.join(env.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

/**
 * A responder that records what it's sent, and `wasCut` when its connection was cut off with no answer; set
 * `open = false` to play a client that went away.
 */
export function responder() {
  return {
    open: true,
    sent: [],
    wasCut: false,
    send(status, json) {
      if (!this.open) throw new Error('sent on a closed responder')
      this.open = false
      this.sent.push({ status, json })
    },
    cut() {
      if (!this.open) throw new Error('cut on a closed responder')
      this.open = false
      this.wasCut = true
      return true
    },
  }
}

/**
 * Clocks and timers the test moves by hand. `now` is the monotonic clock, which `advance(ms)` moves, firing the
 * timers due. `wall` is the wall clock: it moves with `now`, and `jumpWall(ms)` moves it alone, as a time sync after
 * wake can, or a fixture runner's clock that follows the registry's times.
 */
export function fakeTimers(start = 1_800_000_000_000) {
  let now = start
  let wallOffset = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    wall: () => now + wallOffset,
    jumpWall(ms) {
      wallOffset += ms
    },
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms
      for (const [id, tm] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (tm.at > now) continue
        timers.delete(id)
        tm.fn()
      }
    },
    get pending() {
      return timers.size
    },
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** claude-code/plugin/hooks/bridge.ts's timings, which modLoop plays by. */
export const MOD = Object.freeze({ RETRY_MS: 100, POLL_MIN_MS: 1000, BACKOFF_MS: [1000, 2000, 5000, 10_000, 30_000] })

/**
 * A mod's hello and long poll as claude-code/plugin/hooks/bridge.ts plays them, on real timers, against `bridge`:
 * - hello, and once one is answered `ok: true`, the poll, again as soon as one answers;
 * - a poll answered under POLL_MIN_MS with no command waits out the rest of that second, with nothing open;
 * - a fetch that rejects, or a poll answered 409 `{"error": "hello first"}` (PROTOCOL.md, "Failure and recovery", as
 *   amended on 2026-11-03), brings a quiet hello RETRY_MS later. A second failure before a poll goes through begins
 *   an outage, with a hello after each of BACKOFF_MS; any other failed hello or poll does too.
 * Only the poll's side: no events or results. `trace` lists what it did, `{ms, what, status?, cmds?}` by the time
 * since `start()`, and `cmds` the commands it took. `stop()` drops its open poll and its timers.
 */
export function modLoop(bridge, token, { sid, host, inst, cwd = '/s', model = 'm' }) {
  const headers = { host: hostHeader(bridge.url), authorization: `Bearer ${token}` }
  const trace = []
  const cmds = []
  const timers = new Set()
  let t0 = 0
  let epoch = 0
  let running = false
  let attempt = 0
  let outage
  let quick
  let polling = null
  const note = (what, extra = {}) => trace.push({ ms: Math.round(performance.now() - t0), what, ...extra })
  const after = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (running) fn()
    }, ms)
    timers.add(timer)
  }
  const through = (channel) => {
    if (quick === channel) quick = undefined
    if (outage !== channel) return
    outage = undefined
    attempt = 0
  }
  const helloAfter = (ms) => {
    epoch++
    after(ms, () => void hello())
  }
  const fail = (channel) => {
    if (outage === undefined) {
      outage = quick ?? channel
      quick = undefined
    }
    const wait = MOD.BACKOFF_MS[Math.min(attempt, MOD.BACKOFF_MS.length - 1)]
    attempt++
    note('outage', { channel, wait })
    helloAfter(wait)
  }
  const rejected = (channel) => {
    if (outage !== undefined || quick !== undefined) return fail(channel)
    quick = channel
    note('quick-hello', { channel })
    helloAfter(MOD.RETRY_MS)
  }
  async function hello() {
    const ep = ++epoch
    let r
    try {
      r = await send(bridge.url, { method: 'POST', path: '/v1/hello', headers, body: JSON.stringify({ v: 1, sid, host, inst, cwd, model, plugin: '0.3.0', cc: '2.1.309' }) }).answer
    } catch {
      note('hello', { status: null })
      if (ep === epoch && running) rejected('hello')
      return
    }
    note('hello', { status: r.status })
    if (ep !== epoch || !running) return
    if (r.status >= 200 && r.status < 300 && r.json?.ok === true) {
      through('hello')
      void poll(ep)
      return
    }
    fail('hello')
  }
  async function poll(ep) {
    while (running && ep === epoch) {
      const started = performance.now()
      polling = send(bridge.url, { path: `/v1/next?sid=${encodeURIComponent(sid)}&host=${encodeURIComponent(host)}&inst=${encodeURIComponent(inst)}&wait=20`, headers })
      let r
      try {
        r = await polling.answer
      } catch {
        note('poll', { status: null })
        if (ep === epoch && running) rejected('poll')
        return
      }
      const got = Array.isArray(r.json?.cmds) ? r.json.cmds : []
      note('poll', { status: r.status, cmds: got.map((c) => c.id) })
      if (r.status === 409 && r.json?.error === 'hello first') {
        if (ep === epoch && running) rejected('poll')
        return
      }
      if (ep !== epoch || !running) return
      if (r.status < 200 || r.status > 299) return fail('poll')
      through('poll')
      cmds.push(...got)
      const rest = MOD.POLL_MIN_MS - (performance.now() - started)
      if (got.length === 0 && rest > 0) await new Promise((resolve) => after(rest, resolve))
    }
  }
  return {
    trace,
    cmds,
    start() {
      t0 = performance.now()
      running = true
      void hello()
    },
    stop() {
      running = false
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      polling?.abort()
    },
    /** Resolves once `test(trace)` holds, or rejects after `ms`. */
    async until(test, ms, what) {
      const deadline = performance.now() + ms
      while (!test(trace)) {
        if (performance.now() > deadline) throw new Error(`${what}: not within ${ms} ms; the mod did ${JSON.stringify(trace)}`)
        await sleep(10)
      }
    },
  }
}
