// Spike, Phase 5: can a PreToolUse hook's allow carry the deck's own mode change past the auto-mode classifier?
//
// A stand-in for the deck on 127.0.0.1:47610, for the throwaway sessions only (T2, T3):
//   POST /pretool  the spike's PreToolUse http hook: allow for the app's mode tool while that session is armed, else {}
//   GET  /next     the spike poller in the mod: the mode queued for its session, or an empty body
//   POST /result   the poller's report of the mode change it made
//   POST /control  {host, mode} queues a mode; {host, answer: "allow" | "none"} arms or disarms /pretool
// Every route needs the deck's token. Requests are logged to spikes/results/<stamp>-pretool/requests.jsonl,
// without the token.
//
// Run: mise exec -- node spikes/cc-pretool/server.mjs
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN = readFileSync(path.join(ROOT, 'claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token'), 'utf8').trim()
const MODE_TOOL = 'mcp__ccd_session_mgmt__set_session_permission_mode'
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const OUT = path.join(ROOT, 'spikes/results', `${stamp}-pretool`)
mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, 'requests.jsonl')

const queued = new Map() // host → mode
const armed = new Map() // host → 'allow' | 'none'

function log(entry) {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

function answer(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' })
  res.end(text)
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const host = String(req.headers['x-deck-host'] ?? '')
    const authed = req.headers.authorization === `Bearer ${TOKEN}`
    let body = null
    try {
      body = raw === '' ? null : JSON.parse(raw)
    } catch {
      body = { unparsed: raw.slice(0, 200) }
    }
    const route = `${req.method} ${req.url}`
    if (!authed) {
      log({ route, host, refused: 'token' })
      return answer(res, 401, { error: 'token' })
    }
    if (route === 'POST /pretool') {
      const tool = body?.tool_name
      const mode = armed.get(host) ?? 'none'
      const allow = tool === MODE_TOOL && mode === 'allow'
      const out = allow
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: 'Stream Deck spike: the mode change pressed on the deck',
            },
          }
        : {}
      log({ route, host, input: body, answered: allow ? 'allow' : '{}' })
      return answer(res, 200, out)
    }
    if (route === 'GET /next') {
      const mode = queued.get(host) ?? ''
      queued.delete(host)
      if (mode !== '') log({ route, host, handed: mode })
      return answer(res, 200, mode)
    }
    if (route === 'POST /result') {
      log({ route, host, result: body })
      return answer(res, 200, {})
    }
    if (route === 'POST /control') {
      if (typeof body?.host !== 'string') return answer(res, 400, { error: 'host' })
      if (typeof body.mode === 'string') queued.set(body.host, body.mode)
      if (body.answer === 'allow' || body.answer === 'none') armed.set(body.host, body.answer)
      log({ route, control: body })
      return answer(res, 200, { queued: queued.get(body.host) ?? null, armed: armed.get(body.host) ?? 'none' })
    }
    log({ route, host, unknown: true })
    return answer(res, 404, { error: 'route' })
  })
})

server.listen(47610, '127.0.0.1', () => {
  console.log(`spike listening on 127.0.0.1:47610, logging to ${path.relative(ROOT, LOG)}`)
})
