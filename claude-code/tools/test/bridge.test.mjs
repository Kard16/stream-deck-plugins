// The fake bridge over HTTP, on a free port with temp folders: transport rules, routes, long polls, the
// folders, the log, and shutdown.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parseWait, readToken, startFakeBridge } from '../lib/bridge.mjs'
import { send } from '../lib/client.mjs'
import { MAX_BODY } from '../lib/protocol.mjs'
import { request, runLog, sleep, startBridge, tempEnv, writeRecord, writeRegistry } from './helpers.mjs'

const A = { sid: 'sid-a', host: 'local_a', inst: 'ia', pid: 11 }

test('bridge: the Host is checked before the token; then routes, methods and bodies', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const port = new URL(bridge.url).port
  const call = (opts) => request(bridge, env.token, opts).answer
  const events = { sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [] }

  let r = await call({ method: 'POST', path: '/v1/events', headers: { host: 'evil.example:47600', authorization: 'Bearer wrong' }, json: events })
  assert.equal(r.status, 403)
  assert.ok(r.json.error)
  r = await call({ method: 'POST', path: '/v1/events', headers: { authorization: null }, json: events })
  assert.equal(r.status, 401)
  assert.equal(r.headers['www-authenticate'], 'Bearer realm="streamdeck"')
  r = await call({ method: 'POST', path: '/v1/events', headers: { authorization: `Bearer ${env.token}x` }, json: events })
  assert.equal(r.status, 401)
  r = await call({ method: 'POST', path: '/v1/events', headers: { host: `localhost:${port}`, authorization: `bearer ${env.token}` }, json: events })
  assert.equal(r.status, 204, 'localhost:<port> and any case of the scheme are fine')
  r = await call({ path: '/v1/nope' })
  assert.deepEqual([r.status, typeof r.json.error], [404, 'string'])
  r = await call({ path: '/v1/permission' })
  assert.deepEqual([r.status, r.headers.allow], [405, 'POST'])
  r = await call({ method: 'POST', path: '/v1/events', raw: 'not json' })
  assert.equal(r.status, 400)
  r = await call({ method: 'POST', path: '/v1/events', raw: '[1,2]' })
  assert.equal(r.status, 400)
  r = await call({ method: 'POST', path: '/v1/events', raw: `"${'x'.repeat(MAX_BODY)}"` })
  assert.equal(r.status, 413)
  r = await call({ method: 'POST', path: '/v1/events', json: events })
  assert.equal(r.status, 204, 'still serving after a 413')
  r = await call({ path: '/control/state', headers: { authorization: null } })
  assert.equal(r.status, 401, 'the control routes need the token too')
  r = await call({ path: 'http://[' })
  assert.equal(r.status, 400, 'a target that is not a URL')
  r = await call({ method: 'POST', path: '/v1/events', json: events })
  assert.equal(r.status, 204, 'and the server is still up')
})

test('bridge: hello answers with the version, and refuses another one', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const hello = { v: 1, sid: A.sid, host: A.host, inst: A.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' }
  let r = await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: hello }).answer
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: true }])
  r = await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { ...hello, v: 2 } }).answer
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: false, error: 'version' }])
})

test('bridge: a long poll waits, answers when a command is queued, and needs a session', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: Date.now() })
  const bridge = await startBridge(t, env)
  const next = (wait, extra = '') => request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${A.inst}&wait=${wait}${extra}` })

  let r = await next(0).answer
  assert.deepEqual([r.status, r.json], [200, { cmds: [] }])
  const started = Date.now()
  r = await next(1).answer
  assert.deepEqual(r.json, { cmds: [] })
  assert.ok(Date.now() - started >= 900, 'held about a second')

  const open = next(20)
  await sleep(50)
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'List the files.' } }).answer
  assert.equal(press.json.ok, true)
  r = await open.answer
  assert.deepEqual(r.json, { cmds: [{ id: press.json.cmd, t: 'prompt', text: 'List the files.' }] })

  r = await request(bridge, env.token, { path: '/v1/next?sid=unknown&inst=i&wait=0' }).answer
  assert.equal(r.status, 400)
  r = await request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&inst=${A.inst}&wait=0` }).answer
  assert.equal(r.status, 200, 'no host, but the registry knows the sid')
})

test('bridge: parseWait keeps the wait within 0 to 20 s', () => {
  assert.deepEqual(['0', '5', '20', '99', '', null, 'x', '-1', '2.5'].map(parseWait), [0, 5, 20, 20, 20, 20, 20, 20, 2.5])
})

test('bridge: a held request is released when its client closes, and the press after it alerts', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: Date.now() })
  const bridge = await startBridge(t, env)
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Write', tool_input: { file_path: '/s/a.txt', content: 'a' } } })
  await sleep(100)
  assert.equal(bridge.deck.view().held.length, 1)
  held.abort()
  await sleep(100)
  assert.equal(bridge.deck.view().held.length, 0)
  const r = await request(bridge, env.token, { method: 'POST', path: '/control/approve' }).answer
  assert.deepEqual([r.status, r.json.ok, r.json.alert], [200, false, true])
  assert.ok(runLog(env).some((e) => e.kind === 'release' && e.rule === 5))
})

test('bridge: the folders feed the deck: sessions from the registry, settings from the records', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, name: 'A', status: 'idle', statusUpdatedAt: 1 })
  writeRegistry(env, 12, { sessionId: 'sid-cli', status: 'busy' })
  fs.writeFileSync(path.join(env.registryDir, '13.json'), '{"half": ')
  fs.writeFileSync(path.join(env.registryDir, '11.key'), 'never read')
  writeRecord(env, A.host, { model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', lastFocusedAt: 5, postTurnSummary: { needs_action: true, status_detail: 'private text' } })
  const bridge = await startBridge(t, env)
  const view = bridge.deck.view()
  assert.deepEqual(view.sessions, [A.host], 'only entries with a hostSessionId are Code-tab sessions')
  assert.deepEqual(view.settings[A.host], { model: 'claude-haiku-5-5', effort: 'low', mode: 'default' })
  assert.equal(view.status[A.host], 'needs-you', 'the record says the last turn needs the user')
  assert.equal(JSON.stringify(bridge.deck.state()).includes('private text'), false, 'only the flag is kept')

  fs.rmSync(path.join(env.registryDir, `${A.pid}.json`))
  await bridge.rescan()
  assert.deepEqual(bridge.deck.view().sessions, [])
})

test('bridge: an unreadable registry folder is not every session ending', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Bash', tool_input: { command: 'ls' } } })
  await sleep(100)
  fs.rmSync(env.registryDir, { recursive: true })
  await bridge.rescan()
  assert.equal(bridge.deck.view().held.length, 1, 'still held')
  assert.deepEqual(bridge.deck.view().sessions, [A.host])
  held.abort()
})

test('bridge: the run log has every request and answer, and never the token', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  const sneaky = { session_id: A.sid, tool_name: 'Bash', tool_input: { command: `echo ${env.token}` } }
  const held = request(bridge, env.token, { method: 'POST', path: `/v1/permission?x=${env.token}`, headers: { 'x-deck-host': A.host }, json: sneaky })
  await sleep(100)
  await request(bridge, env.token, { method: 'POST', path: '/control/deny' }).answer
  const r = await held.answer
  assert.equal(r.json.hookSpecificOutput.decision.behavior, 'deny')
  await request(bridge, env.token, { path: '/v1/nope', headers: { authorization: `Bearer ${env.token}-wrong` } }).answer
  await bridge.close()
  const text = fs.readFileSync(path.join(env.runDir, 'events.jsonl'), 'utf8')
  assert.equal(text.includes(env.token), false, 'not in the log')
  assert.equal(lines.join('\n').includes(env.token), false, 'not on stdout')
  assert.ok(text.includes('echo <token>'))
  const log = runLog(env)
  assert.ok(log.some((e) => e.kind === 'request' && e.path === '/v1/permission'))
  assert.ok(log.some((e) => e.kind === 'answer' && e.body?.hookSpecificOutput?.decision?.behavior === 'deny'))
  assert.ok(log.some((e) => e.kind === 'held' && e.fp && e.summary === `echo <token>`))
  const config = JSON.parse(fs.readFileSync(path.join(env.runDir, 'bridge.json'), 'utf8'))
  assert.equal(config.tokenFile, env.tokenFile)
})

test('bridge: closing answers held requests with {} and open polls with no commands', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startFakeBridge({ port: 0, tokenFile: env.tokenFile, runDir: env.runDir, registryDir: env.registryDir, recordsDir: env.recordsDir, registryMs: 0, quiet: true })
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Write', tool_input: {} } })
  const poll = request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=ia&wait=20` })
  await sleep(100)
  await bridge.close()
  assert.deepEqual((await held.answer).json, {})
  assert.deepEqual((await poll.answer).json, { cmds: [] })
  await assert.rejects(send(bridge.url, { path: '/v1/next' }).answer, 'not listening any more')
})

test('bridge: it refuses to start without a token', async (t) => {
  const env = tempEnv(t)
  fs.writeFileSync(env.tokenFile, '\n')
  assert.throws(() => readToken(env.tokenFile), /is empty/)
  assert.throws(() => readToken(path.join(env.root, 'missing')), /can't read the token file/)
  await assert.rejects(startFakeBridge({ port: 0, tokenFile: env.tokenFile, runDir: env.runDir, registryDir: env.registryDir, recordsDir: env.recordsDir, quiet: true }), /is empty/)
})
