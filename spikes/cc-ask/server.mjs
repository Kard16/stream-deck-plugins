// Spike, revision 1: can a PermissionRequest hook answer AskUserQuestion and ExitPlanMode in a desktop session?
//
// A stand-in for the deck's /v1/permission on 127.0.0.1:47610, for one throwaway session from the deck-sandbox
// preset, whose spike plugin (spikes/cc-ask/plugin) sends its PermissionRequest hook here. The mod still talks to
// the real deck on 47600.
//   POST /permission  the hook: AskUserQuestion and ExitPlanMode are held until /answer; anything else gets {} at once
//   GET  /held        the held requests, oldest first, with their full input
//   POST /answer      {id, body}: sends `body` (the exact JSON) to held request `id`
// Every route needs the deck's token. Everything is logged to spikes/results/<stamp>-ask/requests.jsonl, without
// the token. A held request whose client goes away is logged as `closed`.
//
// Run: mise exec -- node spikes/cc-ask/server.mjs
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN = readFileSync(path.join(ROOT, 'claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token'), 'utf8').trim()
const HOLD = new Set(['AskUserQuestion', 'ExitPlanMode'])
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const OUT = path.join(ROOT, 'spikes/results', `${stamp}-ask`)
mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, 'requests.jsonl')

/** id → {id, at, host, body, res, done} */
const held = new Map()
let nextId = 1

function log(entry) {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const host = String(req.headers['x-deck-host'] ?? '')
    const route = `${req.method} ${req.url}`
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      log({ route, host, refused: 'token' })
      return reply(res, 401, { error: 'token' })
    }
    let body = null
    try {
      body = raw === '' ? null : JSON.parse(raw)
    } catch {
      body = { unparsed: raw.slice(0, 200) }
    }
    if (route === 'POST /permission') {
      const tool = body?.tool_name
      if (!HOLD.has(tool)) {
        log({ route, host, tool, input: body, answered: '{}' })
        return reply(res, 200, {})
      }
      const id = nextId++
      const entry = { id, at: Date.now(), host, body, res, done: false }
      held.set(id, entry)
      log({ route, host, tool, held: id, input: body })
      res.on('close', () => {
        if (!entry.done) {
          entry.done = true
          held.delete(id)
          log({ closed: id, tool, heldMs: Date.now() - entry.at })
        }
      })
      return
    }
    if (route === 'GET /held') {
      return reply(
        res,
        200,
        [...held.values()].map(h => ({ id: h.id, ageMs: Date.now() - h.at, host: h.host, tool: h.body?.tool_name, input: h.body })),
      )
    }
    if (route === 'POST /answer') {
      const h = held.get(body?.id)
      if (!h) return reply(res, 404, { error: 'not held' })
      h.done = true
      held.delete(h.id)
      const text = JSON.stringify(body.body ?? {})
      h.res.writeHead(200, { 'content-type': 'application/json' })
      h.res.end(text)
      log({ answered: h.id, tool: h.body?.tool_name, heldMs: Date.now() - h.at, sent: body.body ?? {} })
      return reply(res, 200, { ok: true, heldMs: Date.now() - h.at })
    }
    log({ route, host, unknown: true })
    return reply(res, 404, { error: 'route' })
  })
})

server.listen(47610, '127.0.0.1', () => {
  console.log(`ask spike listening on 127.0.0.1:47610, logging to ${path.relative(ROOT, LOG)}`)
})
