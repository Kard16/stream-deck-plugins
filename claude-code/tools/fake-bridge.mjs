#!/usr/bin/env node
// The fake bridge: the deck plugin's side of the bridge protocol (claude-code/protocol/PROTOCOL.md, v1),
// without the deck, to run the real Claude Code plugin against (ladder step 4 in docs/claude-code/plan.md).
// It holds permission requests until told otherwise (only the mode rule answers on its own), queues commands
// for the mod's long poll, follows sessions and events, applies the release rules, and logs every request
// and answer to its run folder. The same file is a small CLI for its token-checked /control/ routes.
// README.md has the walkthrough. Node 24, no dependencies.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULTS, readToken, startFakeBridge } from './lib/bridge.mjs'
import { controlClient, ControlError } from './lib/client.mjs'
import { REPO } from './lib/fixtures.mjs'
import { MODES } from './lib/protocol.mjs'

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
  It logs every request and answer to the run folder as JSONL, never the token. Ctrl-C answers any held
  request with {} (no decision), so the app's dialogs decide.

Commands, to the fake bridge at --url (default http://127.0.0.1:${DEFAULTS.port}) or --port, with --token-file:
  state                          the deck's view, sessions, held requests, commands, registry
  answer <id> allow|deny|none    answers one held request (ids p1, p2… are in state)
  approve                        Approve: the oldest held request, as the key does
  deny                           Deny: the same
  prompt <host> <text>           a Saved Prompt key: queues a prompt for that session (local_…)
  mode <host> <mode>             the Mode dial: ${MODES.join(', ')}
  rescan                         reads the registry and records now
  reset                          forgets everything: held requests get {}, polls no commands
  It prints the answer as JSON and exits 1 when the call failed or the press alerted.

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

async function command(values, [cmd, ...args]) {
  const url = values.url ?? `http://127.0.0.1:${number(values.port, '--port', DEFAULTS.port)}`
  const token = readToken(values['token-file'] ? path.resolve(values['token-file']) : DEFAULTS.tokenFile)
  const control = controlClient(url, token)
  const want = (n, shape) => {
    if (args.length !== n) throw new UsageError(`${cmd} takes ${shape}`)
  }
  let r
  switch (cmd) {
    case 'state':
      want(0, 'no arguments')
      r = await control.call('GET', '/control/state')
      break
    case 'answer':
      want(2, '<id> allow|deny|none')
      r = await control.call('POST', '/control/answer', { id: args[0], decision: args[1] })
      break
    case 'approve':
    case 'deny':
    case 'rescan':
    case 'reset':
      want(0, 'no arguments')
      r = await control.call('POST', `/control/${cmd}`, {})
      break
    case 'prompt':
      want(2, '<host> <text> (quote the text)')
      r = await control.call('POST', '/control/prompt', { host: args[0], text: args[1] })
      break
    case 'mode':
      want(2, `<host> <mode>, the mode one of ${MODES.join(', ')}`)
      r = await control.call('POST', '/control/mode', { host: args[0], mode: args[1] })
      break
    default:
      throw new UsageError(`unknown command ${cmd}`)
  }
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
