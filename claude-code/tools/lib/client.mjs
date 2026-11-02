// A small HTTP client for talking to a bridge exactly as a fixture says: every header as given (a wrong
// Host or token included), each request on a connection of its own so a held one can be dropped on its own,
// and the answer kept for a later check. Also the control client for the fake bridge's /control/ routes.

import http from 'node:http'
import { performance } from 'node:perf_hooks'

const parseJson = (text) => {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The Host header a well-behaved client sends to `base`: what PROTOCOL.md's Host check expects. */
export function hostHeader(base) {
  const u = new URL(base)
  return `${u.hostname}:${u.port || 80}`
}

/**
 * Sends one request. `headers` go as given, by lowercased name; a null value leaves the header out (Host
 * included). `body` is the text to send. Returns `{answer, abort, settled}`: `answer` resolves to
 * `{status, headers, text, json, ms}` and rejects if the connection fails or is dropped.
 */
export function send(base, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const u = new URL(base)
  const out = {}
  let setHost = true
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase()
    if (v === null || v === undefined) {
      if (name === 'host') setHost = false
      delete out[name]
      continue
    }
    out[name] = String(v)
  }
  const data = body === undefined ? null : Buffer.from(body, 'utf8')
  if (data) {
    out['content-length'] = String(data.length)
    if (!('content-type' in out)) out['content-type'] = 'application/json'
  }
  const started = performance.now()
  let req
  const handle = { settled: false, result: undefined, error: undefined }
  handle.answer = new Promise((resolve, reject) => {
    req = http.request({ host: u.hostname, port: u.port || 80, method, path, headers: out, setHost, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, text, json: parseJson(text), ms: Math.round(performance.now() - started) })
      })
      res.on('error', reject)
      res.on('close', () => {
        if (!res.complete) reject(new Error('the answer was cut off'))
      })
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  }).then(
    (r) => {
      handle.settled = true
      handle.result = r
      return r
    },
    (err) => {
      handle.settled = true
      handle.error = err
      throw err
    },
  )
  // A held request may be dropped without anyone awaiting it; that's not an unhandled rejection.
  handle.answer.catch(() => {})
  handle.abort = () => req.destroy()
  return handle
}

/** Resolves to `promise`'s value, or rejects with `message` after `ms`. */
export function within(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export class ControlError extends Error {}

/**
 * Calls the fake bridge's control routes. `call(method, route, body)` resolves to `{status, json}`, and
 * throws ControlError when there's no bridge or it isn't the fake one.
 */
export function controlClient(base, token) {
  const headers = { host: hostHeader(base), authorization: `Bearer ${token}` }
  return {
    async call(method, route, body) {
      let r
      try {
        r = await within(send(base, { method, path: route, headers, body: body === undefined ? undefined : JSON.stringify(body) }).answer, 10_000, `${route} took over 10 s`)
      } catch (err) {
        throw new ControlError(`no bridge at ${base} (${err.code ?? err.message})`)
      }
      if (r.status === 401) throw new ControlError(`the bridge at ${base} refused the token (401): is --token-file the one it reads?`)
      // The fake bridge's own 404s (an unknown request id) carry `ok`; any other 404 means no such route.
      if (r.status === 404 && r.json?.ok === undefined) throw new ControlError(`the bridge at ${base} has no ${route}: it isn't the fake bridge`)
      return { status: r.status, json: r.json }
    },
  }
}
