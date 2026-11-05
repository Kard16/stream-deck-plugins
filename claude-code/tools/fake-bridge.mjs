#!/usr/bin/env node
// The fake bridge: the deck plugin's side of the bridge protocol (claude-code/protocol/PROTOCOL.md, v1),
// without the deck, to run the real Claude Code plugin against (ladder step 4 in docs/claude-code/plan.md).
// It takes the hooks' requests only from sessions the registry confirms, holds permission requests until told
// otherwise (only the mode rules answer on their own: a mode check and a raise's PermissionRequest for a mode
// command in flight), queues commands for the mod's long poll, asks a session no instance has said hello for to say
// one (409 hello first), follows sessions and events, applies the release rules, and logs every request and answer
// to its run folder. The same file is a small CLI for its token-checked
// /control/ routes. README.md has the walkthrough. Node 24, no dependencies.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULTS, readToken, startFakeBridge } from './lib/bridge.mjs'
import { controlClient, ControlError } from './lib/client.mjs'
import { REPO } from './lib/fixtures.mjs'
import { DIAL_PLANS, MODES } from './lib/protocol.mjs'

const rel = (p) => {
  const r = path.relative(REPO, p)
  return r.startsWith('..') ? p : r
}

const USAGE = `usage:
  node claude-code/tools/fake-bridge.mjs [options]              run the fake bridge
  node claude-code/tools/fake-bridge.mjs <command> [options]    call a running one

Running it:
  --port N             TCP port on 127.0.0.1 (default ${DEFAULTS.port}; 0 picks a free one)
  --token-file PATH    the bearer token (default ${rel(DEFAULTS.tokenFile)}, the spike
                       bridge's, which the deck-sandbox preset's DECK_TOKEN holds)
  --run-dir DIR        where events.jsonl and bridge.json go (default
                       ${rel(DEFAULTS.runRoot)}/<YYYYMMDD-HHMMSS>-fake-bridge)
  --registry-dir DIR   the session registry, read only (default ~/.claude/sessions)
  --records-dir DIR    the app's session records, read only (default
                       ~/Library/Application Support/Claude/claude-code-sessions)
  --registry-ms N      how often to read the registry (default ${DEFAULTS.registryMs}; 0 reads only on rescan)
  --quiet              only the first line, where it listens
  It logs every request and answer to the run folder as JSONL, never the token. It takes a hook's request
  only from a session the registry lists with that X-Deck-Host and session_id, and answers any other {} at
  once. Ctrl-C answers any held request with {} (no decision), so the app's dialogs decide.

Commands, to the fake bridge at --url (default http://127.0.0.1:${DEFAULTS.port}) or --port, with --token-file:
  state                          the deck's view, sessions, held requests, commands, registry
  answer <id> allow|deny|none    answers one held tool request (ids p1, p2… are in state); never
                                 an ask request, which only its session's dial answers
  approve [<id>]                 Approve: the oldest held request, as the key does. With an id, as
                                 a key that showed that request: it alerts if the oldest is another
  deny [<id>]                    Deny: the same
  dial <host> allow|deny [<id>]  a Session Slot dial's press for its session's oldest held request,
                                 the one its strip showed last: allow or deny a tool request. With
                                 an id, as a dial whose strip showed that request: it alerts if
                                 that one has gone or isn't the session's oldest
  dial <host> plan <choice> [<id>]
                                 an ExitPlanMode: ${DIAL_PLANS.join(', ')}. reject is the
                                 keys' Deny; the others approve it, leaving Plan mode into that mode
  dial <host> picks <json> [<id>]
                                 an AskUserQuestion: <json> maps each question's text to the
                                 labels picked, as '{"Red or blue?": ["Blue"]}'. A question or plan
                                 the dial can't read shows Answer in app, and a press jumps
  prompt <host> <text>           the Saved Prompt key with that text: queues a prompt for that
                                 session (local_…), or alerts while the key's last prompt is
                                 still queued, delivered or waiting, and for a session whose mod
                                 has no current instance: none has said hello, or its last one
                                 went 60 s without a poll
  mode <host> <mode>             the Mode dial: ${MODES.join(', ')}. Its mode check, and the
                                 PermissionRequest a raise brings, are allowed at once, once each
  rescan                         reads the registry and records now
  reset                          forgets everything: held requests get {}, and open polls are
                                 cut off with no answer, so their mods say hello again; a mod
                                 with none open hears 409 hello first at its next poll
  It prints the answer as JSON and exits 1 when the call failed or the press alerted, and 2 for a
  usage error, before it reads any token.

  -h, --help                     this text
`

const OPTIONS = {
  port: { type: 'string' },
  url: { type: 'string' },
  'token-file': { type: 'string' },
  'run-dir': { type: 'string' },
  'registry-dir': { type: 'string' },
  'records-dir': { type: 'string' },
  'registry-ms': { type: 'string' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

class UsageError extends Error {}

function number(raw, flag, fallback) {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a whole number >= 0`)
  return n
}

async function serve(values) {
  const bridge = await startFakeBridge({
    port: number(values.port, '--port', DEFAULTS.port),
    tokenFile: values['token-file'] ? path.resolve(values['token-file']) : undefined,
    runDir: values['run-dir'],
    registryDir: values['registry-dir'] ? path.resolve(values['registry-dir']) : undefined,
    recordsDir: values['records-dir'] ? path.resolve(values['records-dir']) : undefined,
    registryMs: number(values['registry-ms'], '--registry-ms', DEFAULTS.registryMs),
    quiet: values.quiet,
  })
  // Quiet or not, say where it listens: with --port 0 that's the only way to know.
  if (values.quiet) process.stdout.write(`fake bridge on ${bridge.url}\n`)
  const stop = async (signal) => {
    if (!values.quiet) process.stdout.write(`\n${signal}: closing\n`)
    await bridge.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))
}

/** The control call for a command and its arguments, `[method, route, body]`, or a UsageError. */
function controlCall(cmd, args) {
  const want = (n, shape) => {
    if (!(Array.isArray(n) ? n : [n]).includes(args.length)) throw new UsageError(`${cmd} takes ${shape}`)
  }
  switch (cmd) {
    case 'state':
      want(0, 'no arguments')
      return ['GET', '/control/state']
    case 'answer':
      want(2, '<id> allow|deny|none')
      return ['POST', '/control/answer', { id: args[0], decision: args[1] }]
    case 'approve':
    case 'deny':
      // An id presses as a key that showed that request: the control route's `shown` guard.
      want([0, 1], 'nothing, or the id of the request the key shows (p3)')
      return ['POST', `/control/${cmd}`, args.length ? { shown: args[0] } : {}]
    case 'rescan':
    case 'reset':
      want(0, 'no arguments')
      return ['POST', `/control/${cmd}`, {}]
    case 'prompt':
      want(2, '<host> <text> (quote the text)')
      return ['POST', '/control/prompt', { host: args[0], text: args[1] }]
    case 'mode':
      want(2, `<host> <mode>, the mode one of ${MODES.join(', ')}`)
      return ['POST', '/control/mode', { host: args[0], mode: args[1] }]
    case 'dial':
      return ['POST', '/control/dial', dialPress(args)]
    default:
      throw new UsageError(`unknown command ${cmd}`)
  }
}

const DIAL_SHAPE = `<host> allow|deny [<id>], <host> plan ${DIAL_PLANS.join('|')} [<id>] or <host> picks <json> [<id>]`

/**
 * The control route's body for `dial`'s arguments: `{host, decision | plan | picks, shown?}`, the id being the request
 * the strip showed. A UsageError for anything else, before any token is read.
 */
function dialPress(args) {
  const [host, what, ...rest] = args
  if (!host || !what) throw new UsageError(`dial takes ${DIAL_SHAPE}`)
  const press = { host }
  let id
  if (what === 'allow' || what === 'deny') {
    if (rest.length > 1) throw new UsageError(`dial ${what} takes the host, then at most the id of the request the strip shows (p3)`)
    press.decision = what
    ;[id] = rest
  } else if (what === 'plan') {
    if (!DIAL_PLANS.includes(rest[0]) || rest.length > 2) throw new UsageError(`dial plan takes one of ${DIAL_PLANS.join(', ')}, then at most the id of the request the strip shows`)
    press.plan = rest[0]
    ;[, id] = rest
  } else if (what === 'picks') {
    if (rest.length < 1 || rest.length > 2) throw new UsageError(`dial picks takes a JSON object of each question's labels, as '{"Red or blue?": ["Blue"]}', then at most the id of the request the strip shows`)
    let picks
    try {
      picks = JSON.parse(rest[0])
    } catch {
      throw new UsageError(`dial picks: ${rest[0]} isn't JSON`)
    }
    const fits = picks !== null && typeof picks === 'object' && !Array.isArray(picks) && Object.values(picks).every((v) => Array.isArray(v) && v.every((l) => typeof l === 'string'))
    if (!fits) throw new UsageError(`dial picks: ${rest[0]} isn't an object from each question's text to a list of labels`)
    press.picks = picks
    ;[, id] = rest
  } else {
    throw new UsageError(`dial takes ${DIAL_SHAPE}`)
  }
  if (id !== undefined) press.shown = id
  return press
}

async function command(values, [cmd, ...args]) {
  // Usage first: a mistyped command exits 2 without reading any token.
  const [method, route, body] = controlCall(cmd, args)
  const url = values.url ?? `http://127.0.0.1:${number(values.port, '--port', DEFAULTS.port)}`
  try {
    new URL(url)
  } catch {
    throw new UsageError(`--url ${url} isn't a URL`)
  }
  const token = readToken(values['token-file'] ? path.resolve(values['token-file']) : DEFAULTS.tokenFile)
  const r = await controlClient(url, token).call(method, route, body)
  process.stdout.write(`${JSON.stringify(r.json, null, 2)}\n`)
  return r.status < 300 && r.json?.ok !== false ? 0 : 1
}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (err) {
    process.stderr.write(`fake-bridge: ${err.message}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    if (positionals.length) return await command(values, positionals)
    await serve(values)
    return null
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`fake-bridge: ${err.message}\n\n${USAGE}`)
      return 2
    }
    if (err instanceof ControlError) {
      process.stderr.write(`fake-bridge: ${err.message}\n`)
      return 1
    }
    process.stderr.write(`fake-bridge: ${err.message ?? err}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2))
  // null: the server runs on until a signal.
  if (code !== null) process.exitCode = code
}
