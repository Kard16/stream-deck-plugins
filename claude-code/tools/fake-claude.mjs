#!/usr/bin/env node
// fake-claude: plays the plugin side of the bridge protocol's fixtures (claude-code/protocol/fixtures/)
// against a bridge, standing in for Claude Code and the mod at once: Claude Code's hooks send the permission
// requests and mode checks, the mod the rest. It sends the fixtures' plugin lines and checks the replies; press,
// registry and expect lines go one of two ways:
// - --against-fake: through the fake bridge's control routes and folders, and checked against its state.
// - --interactive: a person presses on the real deck plugin and checks it by eye (ladder step 5 in
//   docs/claude-code/plan.md). Registry lines are skipped there, and so are the replies and presses that hang on
//   them: no registry the real deck reads lists the fixtures' sessions.
// README.md has the walkthrough. Node 24, no dependencies.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { readToken } from './lib/bridge.mjs'
import { againstFake, interactive, terminalUi } from './lib/drivers.mjs'
import { FixtureError, REPO, fixtureFiles, readFixture } from './lib/fixtures.mjs'
import { play } from './lib/play.mjs'

const TOKEN_FILES = {
  /** The fake bridge's default token: the spike bridge's. */
  'against-fake': path.join(REPO, 'spikes', 'cc-bridge', 'run', 'token'),
  /** The real deck plugin's token, which it makes on its first start (PROTOCOL.md, "Transport"). */
  interactive: path.join(REPO, 'claude-code', 'deck', 'com.karimdhanji.claude.sdPlugin', 'run', 'token'),
}

const USAGE = `usage: node claude-code/tools/fake-claude.mjs --against-fake|--interactive [options] [fixture ...]

Plays the plugin side of the protocol's fixtures against a bridge: it sends their plugin lines as Claude
Code and the mod would, and checks the bridge's replies. Fixtures are names in claude-code/protocol/fixtures
(approve, two-held…) or paths; the default is all of them.

  --against-fake       against the fake bridge (fake-bridge.mjs): presses go to its control routes, registry
                       and records files are written into the folders it reads (it refuses the real ones),
                       and expect lines are checked against its state. One failure ends that fixture.
  --interactive        against the real deck plugin (ladder step 5): it says what to press on the deck and
                       waits for the answer, skips registry lines (the deck reads the real registry, which
                       this never writes) and the replies and presses that hang on them, and shows expect
                       lines for you to check by eye.
  --url URL            the bridge (default http://127.0.0.1:47600)
  --token-file PATH    the bridge's token (default: --against-fake, ${path.relative(REPO, TOKEN_FILES['against-fake'])};
                       --interactive, ${path.relative(REPO, TOKEN_FILES.interactive)})
  --press-timeout S    --interactive: how long to wait for the answer after a press (default 300)
  --verbose            print every line as it plays (--interactive always does)
  -h, --help           this text

Exit status: 0 when every fixture passed, 1 when one failed, 2 for a usage error.
`

const OPTIONS = {
  'against-fake': { type: 'boolean' },
  interactive: { type: 'boolean' },
  url: { type: 'string' },
  'token-file': { type: 'string' },
  'press-timeout': { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

class UsageError extends Error {}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (err) {
    process.stderr.write(`fake-claude: ${err.message}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    if (Boolean(values['against-fake']) === Boolean(values.interactive)) throw new UsageError('give one of --against-fake and --interactive')
    const mode = values.interactive ? 'interactive' : 'against-fake'
    const url = values.url ?? 'http://127.0.0.1:47600'
    try {
      new URL(url)
    } catch {
      throw new UsageError(`--url ${url} isn't a URL`)
    }
    const pressS = values['press-timeout'] === undefined ? 300 : Number(values['press-timeout'])
    if (!Number.isFinite(pressS) || pressS <= 0) throw new UsageError('--press-timeout must be a number of seconds above 0')
    const token = readToken(values['token-file'] ? path.resolve(values['token-file']) : TOKEN_FILES[mode])
    const fixtures = (positionals.length ? positionals : fixtureFiles()).map((f) => readFixture(f))

    const ui = mode === 'interactive' ? terminalUi() : null
    const driver = mode === 'interactive' ? interactive({ ui, pressTimeoutMs: pressS * 1000 }) : againstFake({ url, token })
    const say = mode === 'interactive' ? (t) => ui.show(`  ${t}`) : values.verbose ? (t) => process.stdout.write(`  ${t}\n`) : () => {}
    if (mode === 'interactive') {
      ui.show(`fake-claude, interactive, against ${url}.`)
      ui.show('Before going on: no real session should be waiting for approval (Approve acts on the oldest held request, whosever it is), and Saved Prompt and Mode presses must target the fixture\'s session, never a real one.')
    }

    const results = []
    try {
      for (const fx of fixtures) {
        if (mode === 'against-fake' && values.verbose) process.stdout.write(`${fx.name}\n`)
        const started = Date.now()
        const r = await play(fx, { url, token, driver, say })
        results.push(r)
        const secs = ((Date.now() - started) / 1000).toFixed(2)
        const replies = r.skipped.filter((s) => s.reply !== undefined).length
        const presses = r.skipped.filter((s) => s.press !== undefined).length
        const extra = [replies ? `${replies} reply(s) skipped` : '', presses ? `${presses} press(es) skipped` : '', r.notes.length ? `${r.notes.length} note(s)` : ''].filter(Boolean).join(', ')
        process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${fx.name.padEnd(26)} ${String(r.checked).padStart(2)} checked  ${secs} s${extra ? `  (${extra})` : ''}${r.ok ? '' : `\n      ${r.error}`}\n`)
      }
    } finally {
      // The terminal's reader keeps the process alive until it's closed.
      ui?.close()
    }

    const failed = results.filter((r) => !r.ok)
    const notes = results.flatMap((r) => r.notes.map((n) => ({ fixture: r.name, ...n })))
    if (notes.length) {
      process.stdout.write('\nWhat you saw that differed:\n')
      for (const n of notes) process.stdout.write(`  ${n.fixture} line ${n.line}: expected ${JSON.stringify(n.expected)}; saw: ${n.saw}\n`)
    }
    process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed (${mode})\n`)
    return failed.length ? 1 : 0
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`fake-claude: ${err.message}\n\n${USAGE}`)
      return 2
    }
    process.stderr.write(`fake-claude: ${err instanceof FixtureError ? err.message : (err.message ?? err)}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
