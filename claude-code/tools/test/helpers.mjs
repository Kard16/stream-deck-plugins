// Shared by the tests: temp folders standing in for the registry and records, a fake bridge on a free port,
// a recording responder and fake timers for driving the deck model directly. Nothing here reads or writes
// ~/.claude/ or the app's folders, and nothing binds 47600 or 47601.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
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
