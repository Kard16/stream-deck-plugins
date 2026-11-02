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
    [['state', '--url', 'not a url'], /--url not a url isn't a URL/],
    [['state', '--port', 'x'], /--port must be a whole number/],
  ]
  for (const [args, why] of cases) {
    r = await run(BRIDGE, [...args, '--token-file', missing], { env: home })
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`)
    assert.match(r.err.split('\n')[0], why)
  }
})

test('cli: fake-claude --against-fake plays all 14 fixtures against the fake bridge\'s own CLI', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  const r = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', env.tokenFile], { env: home })
  assert.equal(r.code, 0, `${r.out}${r.err}`)
  assert.match(r.out, /14 passed, 0 failed \(against-fake\)/)
  assert.equal((r.out.match(/^ok {2}/gm) ?? []).length, 14)

  const one = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', env.tokenFile, '--verbose', 'two-held'], { env: home })
  assert.equal(one.code, 0, one.out)
  assert.match(one.out, /press approve: allow p\d+/)
  assert.match(one.out, /1 passed, 0 failed/)

  const wrong = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', path.join(env.root, 'registry', 'nope'), 'hello'], { env: home })
  assert.equal(wrong.code, 1)
  assert.match(wrong.err, /can't read the token file/)
})

test('cli: fake-claude --interactive reads the person\'s answers from stdin', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  // auth has no presses or checks; hello has one check, answered with what the person saw.
  const r = await run(CLAUDE, ['--interactive', '--url', url, '--token-file', env.tokenFile, 'auth', 'hello'], { env: home, input: 'the dial lists other sessions\n' })
  assert.equal(r.code, 0, `${r.out}${r.err}`)
  assert.match(r.out, /CHECK on the deck:\n {2}- the Sessions dial lists local_test-a/)
  assert.match(r.out, /hello line \d+: expected .*; saw: the dial lists other sessions/)
  assert.match(r.out, /2 passed, 0 failed \(interactive\)/)
  // At the end of its input it goes on as if the person pressed Enter.
  const eof = await run(CLAUDE, ['--interactive', '--url', url, '--token-file', env.tokenFile, 'hello'], { env: home, input: '' })
  assert.equal(eof.code, 0, eof.out)
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
  r = await ctl('mode', 'local_seven', 'bypassPermissions')
  assert.equal(r.code, 1)
  assert.match(JSON.parse(r.out).error, /mode must be one of/)
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

  // answer never answers an ask request: the deck doesn't, and a press on one jumps.
  const ask = hold('AskUserQuestion', { questions: [{ question: 'Red or blue?' }] })
  await sleep(100)
  const [askId] = JSON.parse((await ctl('state')).out).deck.held.map((h) => h.id)
  r = await ctl('answer', askId, 'none')
  assert.equal(r.code, 1)
  assert.match(JSON.parse(r.out).error, /never answers: a press on it jumps to local_seven instead/)
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

test('cli: SIGTERM answers a held request with no decision before the bridge exits', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  const { url, child } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  const held = send(url, {
    method: 'POST', path: '/v1/permission',
    headers: { host: hostHeader(url), authorization: `Bearer ${env.token}`, 'x-deck-host': 'local_x' },
    body: JSON.stringify({ session_id: 's', tool_name: 'Write', tool_input: {} }),
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const answer = await held.answer
  assert.deepEqual([answer.status, answer.json], [200, {}])
  assert.equal(await exited, 0)
})
