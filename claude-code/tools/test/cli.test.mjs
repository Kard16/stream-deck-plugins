// The two command lines as separate processes: help, usage errors, fake-claude --against-fake against a
// fake bridge started from its own CLI, the control commands, and the refusal to write into the app's
// folders. HOME points at a temp folder for every child, so nothing here can reach the real ~/.claude/.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { TOOLS, tempEnv } from './helpers.mjs'

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

test('cli: usage errors exit 2', async (t) => {
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
  r = await run(BRIDGE, ['answer', 'p1'], { env: home })
  assert.equal(r.code, 2)
  assert.match(r.err, /answer takes <id> allow\|deny\|none/)
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
  fs.writeFileSync(path.join(env.registryDir, '7.json'), JSON.stringify({ pid: 7, sessionId: 's7', hostSessionId: 'local_seven', name: 'Seven', status: 'busy', statusUpdatedAt: 1 }))
  const { url } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir], home)
  const ctl = (...args) => run(BRIDGE, [...args, '--url', url, '--token-file', env.tokenFile], { env: home })

  let r = await ctl('state')
  assert.equal(r.code, 0, r.err)
  const state = JSON.parse(r.out)
  assert.deepEqual(state.deck.sessions, ['local_seven'])
  assert.equal(state.dirs.registry, env.registryDir)
  assert.equal(r.out.includes(env.token), false)

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
  r = await ctl('reset')
  assert.equal(r.code, 0)
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
  const r = await run(CLAUDE, ['--against-fake', '--url', url, '--token-file', env.tokenFile, 'hello'], { env: home })
  assert.equal(r.code, 1)
  assert.match(r.out, /won't write fixture files into .*\.claude\/sessions/)
  assert.deepEqual(fs.readdirSync(sessions), [], 'nothing written')
  assert.deepEqual(fs.readdirSync(records), [])
})

test('cli: SIGTERM answers a held request with no decision before the bridge exits', async (t) => {
  const env = tempEnv(t)
  const home = { HOME: env.root }
  const { url, child } = await serve(env, ['--token-file', env.tokenFile, '--run-dir', env.runDir, '--registry-dir', env.registryDir, '--records-dir', env.recordsDir, '--quiet'], home)
  const { send, hostHeader } = await import('../lib/client.mjs')
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
