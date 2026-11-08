// The two command lines as separate processes: help, usage errors, fake-claude --against-fake against a
// fake bridge started from its own CLI, the control commands, and the refusal to write into the app's
// folders. HOME points at a temp folder for every child, so nothing here can reach the real ~/.claude/.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { hostHeader, send } from '../lib/client.mjs'
import { TOOLS, sleep, tempEnv } from './helpers.mjs'

const BRIDGE = path.join(TOOLS, 'fake-bridge.mjs')
const CLAUDE = path.join(TOOLS, 'fake-claude.mjs')

/** Runs a CLI to its end: `{code, out, err}`. */
function run(script, args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(input ?? '')
  })
}

/** Starts the fake bridge's CLI on a free port; resolves `{url, child}` once it says where it listens. */
function serve(env, args, vars = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, '--port', '0', ...args], { env: { ...process.env, ...vars }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => reject(new Error(`no listening line: ${out}${err}`)), 10_000)
    child.stdout.on('data', (d) => {
      out += d
      const m = /fake bridge on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ url: m[1], child, output: () => out })
      }
    })
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`the fake bridge exited ${code}: ${out}${err}`))
    })
    // Stopped before tempEnv removes its folders: tempEnv's hook runs these first.
    env.closers?.push(() => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    }))
  })
}

test('cli: both --help texts exit 0 without touching anything', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  for (const script of [BRIDGE, CLAUDE]) {
    const r = await run(script, ['--help'], { env: home })
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^usage:/)
  }
  assert.deepEqual(fs.readdirSync(env.root).sort(), ['records', 'registry', 'token'], 'no run folder or anything else made')
})

test('cli: usage errors exit 2, before any token is read', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  let r = await run(CLAUDE, [], { env: home })
  assert.equal(r.code, 2)
  assert.match(r.err, /give one of --against-fake and --interactive/)
  r = await run(CLAUDE, ['--against-fake', '--interactive'], { env: home })
  assert.equal(r.code, 2)
  r = await run(CLAUDE, ['--against-fake', '--bogus'], { env: home })
  assert.equal(r.code, 2)
  r = await run(BRIDGE, ['--port', 'x'], { env: home })
  assert.equal(r.code, 2)
  // With no --token-file the default is the spike bridge's, which git ignores: usage comes first, so it's never read.
  r = await run(BRIDGE, ['answer', 'p1'], { env: home })
  assert.equal(r.code, 2)
  assert.match(r.err, /^fake-bridge: answer takes <id> allow\|deny\|none\n/)
  // A token file that isn't there shows the order: read first, each would exit 1 for it.
  const missing = path.join(env.root, 'no-token')
  const cases = [
    [['answer', 'p1'], /answer takes/],
    [['approve', 'p1', 'p2'], /approve takes nothing, or the id/],
    [['deny', 'p1', 'p2'], /deny takes nothing, or the id/],
    [['state', 'x'], /state takes no arguments/],
    [['prompt', 'local_x'], /prompt takes <host> <text>/],
    [['bogus'], /unknown command bogus/],
    // The Mode dial went in Phase 8 (PROTOCOL.md, as amended on 2026-11-06).
    [['mode', 'local_x', 'plan'], /unknown command mode/],
    [['state', '--url', 'not a url'], /--url not a url isn't a URL/],
    [['state', '--port', 'x'], /--port must be a whole number/],
    // The dial's presses: a host, then allow, deny or press (nothing picked), and at most an id. A question's picks and
    // a plan's choice went in Phase 9.
    [['dial'], /^fake-bridge: dial takes <host> allow\|deny\|press \[<id>\]$/],
    [['dial', 'local_x'], /dial takes <host> allow\|deny\|press/],
    [['dial', 'local_x', 'approve'], /dial takes <host> allow\|deny\|press/],
    [['dial', 'local_x', 'allow', 'p1', 'p2'], /dial takes <host> allow\|deny\|press/],
    [['dial', 'local_x', 'plan', 'auto'], /dial takes <host> allow\|deny\|press/],
    [['dial', 'local_x', 'picks', '{"Q?": ["A"]}'], /dial takes <host> allow\|deny\|press/],
  ]
  for (const [args, why] of cases) {
    r = await run(BRIDGE, [...args, '--token-file', missing], { env: home })
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`)
    assert.match(r.err.split('\n')[0], why)
  }
})

test('cli: fake-claude --against-fake plays all 21 fixtures against the fake bridge\'s own CLI', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  const r = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', env.tokenFile], { env: home })
  assert.equal(r.code, 0, `${r.out}${r.err}`)
  assert.match(r.out, /21 passed, 0 failed \(against-fake\)/)
  assert.equal((r.out.match(/^ok {2}/gm) ?? []).length, 21)

  const one = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', env.tokenFile, '--verbose', 'two-held'], { env: home })
  assert.equal(one.code, 0, one.out)
  assert.match(one.out, /press approve: allow p\d+/)
  assert.match(one.out, /1 passed, 0 failed/)

  const wrong = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', path.join(env.root, 'registry', 'nope'), 'hello'], { env: home })
  assert.equal(wrong.code, 1)
  assert.match(wrong.err, /can't read the token file/)
})

test('cli: fake-claude --interactive against a deck whose registry lists none of the fixtures\' sessions, as no real deck\'s does, asks nothing: it skips and counts the presses and checks', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  // auth has no presses or checks; hello has one check, skipped and counted. What the person types goes unread.
  const r = await run(CLAUDE, ['--interactive', '--url', url, '--token-file', env.tokenFile, 'auth', 'hello'], { env: home, input: 'the dial lists other sessions\n' })
  assert.equal(r.code, 0, `${r.out}${r.err}`)
  assert.match(r.out, /^skip: expect \{"sessions":\["local_test-a"\].*: a real deck shows nothing of a fixture's session$/m)
  assert.doesNotMatch(r.out, /CHECK|What you saw|the dial lists other sessions/)
  assert.match(r.out, /^ok {4}auth +7 checked +[\d.]+ s$/m)
  assert.match(r.out, /^ok {4}hello +1 checked +[\d.]+ s {2}\(1 check\(s\) skipped\)$/m)
  assert.match(r.out, /2 passed, 0 failed \(interactive\)/)
  // No registry the fake bridge reads lists approve's session: its permission request gets {} at once, so the press
  // and the replies that hang on it are skipped, and counted, with its checks.
  const skips = await run(CLAUDE, ['--interactive', '--url', url, '--token-file', env.tokenFile, '--press-timeout', '5', 'approve'], { env: home, input: '' })
  assert.equal(skips.code, 0, skips.out)
  assert.match(skips.out, /skip: press approve: nothing fake-claude sent is held/)
  assert.doesNotMatch(skips.out, /PRESS:|CHECK/)
  assert.match(skips.out, /^ok {4}approve +2 checked +[\d.]+ s {2}\(2 reply\(s\) skipped, 1 press\(es\) skipped, 3 check\(s\) skipped\)$/m)
})

test('cli: fake-claude\'s defaults are those README.md gives: the bridge on 47600, each mode\'s token, a press waited on for 300 s', async (t) => {
  const env = tempEnv(t)
  const r = await run(CLAUDE, ['--help'], { env: { HOME: env.root } })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /--url URL +the bridge \(default http:\/\/127\.0\.0\.1:47600\)/)
  assert.match(r.out, /--token-file PATH +the bridge's token \(default: --against-fake, spikes\/cc-bridge\/run\/token;\n +--interactive, claude-code\/deck\/com\.karimdhanji\.claude\.sdPlugin\/run\/token\)/)
  assert.match(r.out, /--press-timeout S +--interactive: how long to wait for the answer after a press \(default 300\)/)
})

test('cli: the fake bridge\'s defaults are those README.md gives: port 47600, the spike bridge\'s token, the real folders read only, a run folder of its own', async (t) => {
  const env = tempEnv(t)
  const r = await run(BRIDGE, ['--help'], { env: { HOME: env.root } })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /--port N +TCP port on 127\.0\.0\.1 \(default 47600; 0 picks a free one\)/)
  assert.match(r.out, /--token-file PATH +the bearer token \(default spikes\/cc-bridge\/run\/token, the spike\n/)
  assert.match(r.out, /--registry-dir DIR +the session registry, read only \(default ~\/\.claude\/sessions\)/)
  assert.match(r.out, /--records-dir DIR +the app's session records, read only \(default\n +~\/Library\/Application Support\/Claude\/claude-code-sessions\)/)
  assert.match(r.out, /--run-dir DIR +where events\.jsonl and bridge\.json go \(default\n +claude-code\/tools\/run\/<YYYYMMDD-HHMMSS>-fake-bridge\)/)
  // The values themselves, and a run folder named as README.md says when none is given.
  const script = path.join(env.root, 'defaults.mjs')
  fs.writeFileSync(script, `import { DEFAULTS, startFakeBridge } from ${JSON.stringify(pathToFileURL(path.join(TOOLS, 'lib', 'bridge.mjs')).href)}
const bridge = await startFakeBridge({ port: 0, tokenFile: ${JSON.stringify(env.tokenFile)}, runRoot: ${JSON.stringify(path.join(env.root, 'runs'))}, registryDir: ${JSON.stringify(env.registryDir)}, recordsDir: ${JSON.stringify(env.recordsDir)}, registryMs: 0, quiet: true })
await bridge.close()
process.stdout.write(JSON.stringify({ ...DEFAULTS, runDir: bridge.runDir }))
`)
  const d = await run(script, [], { env: { HOME: env.root } })
  assert.equal(d.code, 0, d.err)
  const got = JSON.parse(d.out)
  const repo = path.resolve(TOOLS, '..', '..')
  assert.deepEqual([got.port, got.tokenFile, got.registryDir, got.recordsDir, got.registryMs, got.runRoot], [
    47600, path.join(repo, 'spikes', 'cc-bridge', 'run', 'token'), path.join(env.root, '.claude', 'sessions'),
    path.join(env.root, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'), 1000, path.join(repo, 'claude-code', 'tools', 'run'),
  ])
  assert.match(path.basename(got.runDir), /^\d{8}-\d{6}-fake-bridge$/)
  assert.ok(fs.existsSync(path.join(got.runDir, 'events.jsonl')) && fs.existsSync(path.join(got.runDir, 'bridge.json')))
})

test('cli: the control commands', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  // A session titled with a run of the token, as a session that set it might be.
  fs.writeFileSync(path.join(env.registryDir, '7.json'), JSON.stringify({ pid: 7, sessionId: 's7', hostSessionId: 'local_seven', name: `Seven ${env.token.slice(2, 16)}`, status: 'busy', statusUpdatedAt: 1 }))
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir], home)
  const ctl = (...args) => run(BRIDGE, [...args, '--url', url, '--token-file', env.tokenFile], { env: home })

  let r = await ctl('state')
  assert.equal(r.code, 0, r.err)
  const state = JSON.parse(r.out)
  assert.deepEqual(state.deck.sessions, ['local_seven'])
  assert.equal(state.dirs.registry, env.registryDir)
  assert.equal(r.out.includes(env.token.slice(2, 16)), false, 'no run of the token on stdout')
  assert.equal(state.registry.local_seven.name, 'Seven <token>')

  r = await ctl('approve')
  assert.equal(r.code, 1, 'nothing held: the press alerts')
  assert.equal(JSON.parse(r.out).alert, true)
  r = await ctl('prompt', 'local_seven', 'List the files.')
  assert.equal(r.code, 1, 'no plugin in that session')
  assert.match(JSON.parse(r.out).error, /has no plugin/)
  r = await ctl('answer', 'p1', 'allow')
  assert.equal(r.code, 1)
  assert.match(JSON.parse(r.out).error, /no request p1/)
  r = await ctl('rescan')
  assert.equal(r.code, 0)

  // approve and deny take the id the key showed, as the control route's `shown`: another oldest alerts.
  const hold = (tool, input) => send(url, {
    method: 'POST', path: '/v1/permission',
    headers: { host: hostHeader(url), authorization: `Bearer ${env.token}`, 'x-deck-host': 'local_seven' },
    body: JSON.stringify({ session_id: 's7', tool_name: tool, tool_input: input }),
  })
  const write = hold('Write', { file_path: '/s/a.txt', content: 'a' })
  await sleep(100)
  const bash = hold('Bash', { command: 'make' })
  await sleep(100)
  const [first, second] = JSON.parse((await ctl('state')).out).deck.held.map((h) => h.id)
  r = await ctl('approve', second)
  assert.equal(r.code, 1, 'the key showed the second, but the oldest is the first')
  assert.match(JSON.parse(r.out).error, new RegExp(`the key showed ${second}; the oldest is ${first}`))
  r = await ctl('approve', first)
  assert.equal(r.code, 0, r.out)
  assert.equal((await write.answer).json.hookSpecificOutput.decision.behavior, 'allow')
  r = await ctl('deny', second)
  assert.equal(r.code, 0, r.out)
  assert.equal((await bash.answer).json.hookSpecificOutput.decision.behavior, 'deny')

  // answer never answers an ask request, which the deck never answers: a press on one jumps.
  const ask = hold('AskUserQuestion', { questions: [{ question: 'Red or blue?' }] })
  await sleep(100)
  const [askId] = JSON.parse((await ctl('state')).out).deck.held.map((h) => h.id)
  r = await ctl('answer', askId, 'none')
  assert.equal(r.code, 1)
  assert.match(JSON.parse(r.out).error, /which the deck never answers: a press on it jumps to local_seven/)
  assert.equal(ask.settled, false, 'still held')
  r = await ctl('dial', 'local_seven', 'allow')
  assert.equal(r.code, 0, r.out)
  assert.equal(JSON.parse(r.out).jumped, 'local_seven')
  assert.equal(ask.settled, false, 'still held')

  r = await ctl('reset')
  assert.equal(r.code, 0)
  assert.deepEqual((await ask.answer).json, {}, 'reset releases it with no decision')
  r = await run(BRIDGE, ['state', '--url', url, '--token-file', path.join(env.root, 'token-wrong')], { env: home })
  assert.equal(r.code, 1)
  fs.writeFileSync(path.join(env.root, 'token-wrong'), 'wrong\n')
  r = await run(BRIDGE, ['state', '--url', url, '--token-file', path.join(env.root, 'token-wrong')], { env: home })
  assert.equal(r.code, 1)
  assert.match(r.err, /refused the token \(401\)/)
})

test("cli: dial presses a session's Session Slot dial: allow or deny, or a press with nothing picked, for the request its strip showed", async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  fs.writeFileSync(path.join(env.registryDir, '7.json'), JSON.stringify({ pid: 7, sessionId: 's7', hostSessionId: 'local_seven', status: 'waiting', statusUpdatedAt: 1 }))
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  const ctl = (...args) => run(BRIDGE, [...args, '--url', url, '--token-file', env.tokenFile], { env: home })
  const hold = async (tool, input) => {
    const h = send(url, {
      method: 'POST', path: '/v1/permission',
      headers: { host: hostHeader(url), authorization: `Bearer ${env.token}`, 'x-deck-host': 'local_seven' },
      body: JSON.stringify({ session_id: 's7', tool_name: tool, tool_input: input }),
    })
    await sleep(100)
    return h
  }

  let r = await ctl('dial', 'local_seven', 'allow')
  assert.equal(r.code, 1, 'nothing shown yet: the press alerts')
  assert.equal(JSON.parse(r.out).error, "local_seven's dial has shown no request")
  r = await ctl('dial', 'local_seven', 'press')
  assert.deepEqual([r.code, JSON.parse(r.out).jumped], [0, 'local_seven'], 'on its pages, a press jumps')

  const write = await hold('Write', { file_path: '/s/a.txt', content: 'a' })
  const bash = await hold('Bash', { command: 'make' })
  const [w, b] = JSON.parse((await ctl('state')).out).deck.held.map((h) => h.id)
  // As a dial that showed the Bash while the Write is still the session's oldest: it alerts, and sends nothing.
  r = await ctl('dial', 'local_seven', 'deny', b)
  assert.equal(r.code, 1)
  assert.equal(JSON.parse(r.out).error, `the dial showed ${b}; local_seven's oldest held request is ${w}`)
  r = await ctl('dial', 'local_seven', 'press', w)
  assert.deepEqual([r.code, JSON.parse(r.out).jumped, write.settled], [0, 'local_seven', false], 'nothing picked: a jump')
  r = await ctl('dial', 'local_seven', 'allow', w)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual((await write.answer).json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  r = await ctl('dial', 'local_seven', 'deny')
  assert.equal(r.code, 0, r.out)
  assert.equal((await bash.answer).json.hookSpecificOutput.decision.behavior, 'deny')
  // The first answer won: the strip's last request has gone, so a press alerts.
  r = await ctl('dial', 'local_seven', 'allow')
  assert.equal(r.code, 1)
  assert.equal(JSON.parse(r.out).error, `${b}, the request the dial showed, has gone (answered)`)
  r = await ctl('approve', b)
  assert.equal(r.code, 1, 'and so does a key that showed it')
})

test('cli: fake-claude won\'t write fixture files into the app\'s folders', async (t) => {
  const env = tempEnv(t)
  // HOME is the temp root, so "~/.claude/sessions" here is a temp folder standing in for the real one.
  const sessions = path.join(env.root, '.claude', 'sessions')
  const records = path.join(env.root, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
  fs.mkdirSync(sessions, { recursive: true })
  fs.mkdirSync(records, { recursive: true })
  const home = { HOME: env.root }
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--quiet'], home)
  let r = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', env.tokenFile, 'hello'], { env: home })
  assert.equal(r.code, 1)
  assert.match(r.out, /won't write fixture files into .*\.claude\/sessions/)

  // The same folders by other names: real paths compare as the system gives them, which on a case-insensitive
  // volume (the Mac's default) includes each name's case on disk.
  if (fs.existsSync(path.join(env.root, '.CLAUDE'))) {
    const upper = await serve(env, ['--token-file', env.tokenFile, '--run-dir', path.join(env.root, 'run-upper'), '--registry-dir', path.join(env.root, '.CLAUDE', 'SESSIONS'), '--records-dir', path.join(env.root, 'records'), '--quiet'], home)
    r = await run(CLAUDE, ['--against-fake', '--url', upper.url, '--token-file', env.tokenFile, 'hello'], { env: home })
    assert.equal(r.code, 1)
    assert.match(r.out, /won't write fixture files into .*\.CLAUDE\/SESSIONS/)
  } else {
    t.diagnostic('this volume is case-sensitive: the case check was skipped')
  }
  // The same folder through the Data volume, which the Mac firmlinks /private and /Users into: realpath keeps the
  // name it's given, so the guard compares without the /System/Volumes/Data prefix.
  const firm = path.join('/System/Volumes/Data', fs.realpathSync.native(sessions))
  if (fs.existsSync(firm)) {
    const data = await serve(env, ['--token-file', env.tokenFile, '--run-dir', path.join(env.root, 'run-data'), '--registry-dir', firm, '--records-dir', path.join(env.root, 'records'), '--quiet'], home)
    r = await run(CLAUDE, ['--against-fake', '--url', data.url, '--token-file', env.tokenFile, 'hello'], { env: home })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /won't write fixture files into \/System\/Volumes\/Data\/.*\.claude\/sessions, inside /)
  } else {
    t.diagnostic(`no ${firm}: the Data volume check was skipped`)
  }
  // A link in a fake records folder that leads into the app's: each folder written into is checked too.
  const fakeRecords = path.join(env.root, 'fake-records')
  fs.mkdirSync(fakeRecords)
  fs.symlinkSync(records, path.join(fakeRecords, 'fixture-account'))
  const linked = await serve(env, ['--token-file', env.tokenFile, '--run-dir', path.join(env.root, 'run-linked'), '--registry-dir', path.join(env.root, 'registry'), '--records-dir', fakeRecords, '--quiet'], home)
  r = await run(CLAUDE, ['--against-fake', '--url', linked.url, '--token-file', env.tokenFile, 'hello'], { env: home })
  assert.equal(r.code, 1)
  assert.match(r.out, /won't write fixture files into .*fake-records\/fixture-account, inside .*Application Support\/Claude:/)

  assert.deepEqual(fs.readdirSync(sessions), [], 'nothing written')
  assert.deepEqual(fs.readdirSync(records), [])
  assert.deepEqual(fs.readdirSync(path.join(env.root, 'registry')), [], 'and the fake registry folder left as it was')
})

test('cli: the app\'s folders stay protected when HOME points elsewhere', async (t) => {
  const env = tempEnv(t)
  // Only reads the list: nothing here goes near the real folders.
  const script = path.join(env.root, 'protected.mjs')
  fs.writeFileSync(script, `import { PROTECTED } from ${JSON.stringify(pathToFileURL(path.join(TOOLS, 'lib', 'drivers.mjs')).href)}\nprocess.stdout.write(JSON.stringify(PROTECTED))\n`)
  const r = await run(script, [], { env: { HOME: env.root } })
  assert.equal(r.code, 0, r.err)
  const dirs = JSON.parse(r.out)
  const own = os.userInfo().homedir
  for (const home of [env.root, own]) {
    assert.ok(dirs.includes(path.join(home, '.claude')), `${home}/.claude in ${r.out}`)
    assert.ok(dirs.includes(path.join(home, 'Library', 'Application Support', 'Claude')), `${home}'s app folder in ${r.out}`)
  }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`cli: ${signal} answers a held request with no decision, and an open poll with no commands, before the bridge exits`, async (t) => {
    // SIGINT is Ctrl-C, as README.md says to stop it.
    const env = tempEnv(t)
    const home = { HOME: env.root }
    fs.writeFileSync(path.join(env.registryDir, '7.json'), JSON.stringify({ pid: 7, sessionId: 's7', hostSessionId: 'local_x', status: 'busy', statusUpdatedAt: 1 }))
    const { url, child, output } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir], home)
    const headers = { host: hostHeader(url), authorization: `Bearer ${env.token}` }
    const held = send(url, { method: 'POST', path: '/v1/permission', headers: { ...headers, 'x-deck-host': 'local_x' }, body: JSON.stringify({ session_id: 's7', tool_name: 'Write', tool_input: {} }) })
    await send(url, { method: 'POST', path: '/v1/hello', headers, body: JSON.stringify({ v: 1, sid: 's7', host: 'local_x', inst: 'ix', cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' }) }).answer
    const poll = send(url, { path: '/v1/next?sid=s7&host=local_x&inst=ix&wait=20', headers })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual([held.settled, poll.settled], [false, false], 'both held')
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill(signal)
    const [answer, polled] = [await held.answer, await poll.answer]
    assert.deepEqual([answer.status, answer.json, polled.json], [200, {}, { cmds: [] }])
    assert.equal(await exited, 0)
    assert.match(output(), new RegExp(`${signal}: closing`))
  })
}
