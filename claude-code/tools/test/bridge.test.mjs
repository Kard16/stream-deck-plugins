// The fake bridge over HTTP, on a free port with temp folders: transport rules, routes, long polls, the
// folders, the log, and shutdown.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parseWait, readToken, scrubber, startFakeBridge } from '../lib/bridge.mjs'
import { send, within } from '../lib/client.mjs'
import { MAX_BODY, fingerprint, summary } from '../lib/protocol.mjs'
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

test('bridge: a mod request naming no session it can place gets 400; a permission request is held without a host', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const nobody = { sid: 'sid-unknown', host: '$CLAUDE_CODE_HOST_SESSION_ID', inst: 'iz' }
  const posts = [
    ['/v1/hello', { v: 1, ...nobody, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' }],
    ['/v1/events', { ...nobody, seq: 1, events: [{ t: 'turn.start', turn: 't1', at: 1 }] }],
    ['/v1/result', { ...nobody, id: 'cmd-1', state: 'done' }],
  ]
  for (const [p, json] of posts) {
    const r = await request(bridge, env.token, { method: 'POST', path: p, json }).answer
    assert.deepEqual([p, r.status, typeof r.json?.error], [p, 400, 'string'])
  }
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': 'not-local' }, json: { session_id: 'sid-unknown', tool_name: 'Bash', tool_input: { command: 'ls' } } })
  await sleep(100)
  assert.deepEqual(bridge.deck.view().held.map((h) => h.host), [null])
  held.abort()
})

test('bridge: a request a route throws on gets 500, which the hook takes as no decision, and the bridge carries on', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  // 40 KB of tool_input nested 20,000 deep: JSON.parse takes it, and canonical() runs out of stack on it.
  const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
  const raw = `{"session_id":"${A.sid}","tool_name":"Bash","tool_input":${deep}}`
  let r = await request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, raw }).answer
  assert.equal(r.status, 500)
  assert.match(r.json.error, /Maximum call stack size exceeded/)
  assert.equal(bridge.deck.view().held.length, 0, 'nothing held')

  r = await request(bridge, env.token, { method: 'POST', path: '/v1/events', json: { sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [{ t: 'measure', context: { percent: 7, window: 10 }, at: 1 }] } }).answer
  assert.equal(r.status, 204, 'still serving')
  assert.equal(bridge.deck.view().context[A.host], 7)
  r = await request(bridge, env.token, { path: '/control/state' }).answer
  assert.equal(r.status, 200)

  const log = runLog(env)
  const req = log.find((e) => e.kind === 'request' && e.path === '/v1/permission')
  assert.match(req.unlogged, /Maximum call stack/, 'the request is logged without the body it could not print')
  assert.ok(log.some((e) => e.kind === 'route-error' && e.n === req.n && e.route === '/v1/permission' && /RangeError: Maximum call stack/.test(e.error)))
  assert.ok(log.some((e) => e.kind === 'answer' && e.n === req.n && e.status === 500))
  assert.ok(lines.some((l) => / \/v1\/permission failed: RangeError: Maximum call stack size exceeded$/.test(l)))
})

test('bridge: an answer that can\'t be written out, one nested too deep, gets a plain 500 rather than no answer', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  // /control/answer says it has no request with the id it was given, and gives the id back.
  const deep = `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`
  const r = await within(request(bridge, env.token, { method: 'POST', path: '/control/answer', raw: `{"id":${deep},"decision":"allow"}` }).answer, 3000, 'no answer within 3 s')
  assert.equal(r.status, 500)
  assert.match(r.json.error, /^the fake bridge can't write its answer: RangeError: Maximum call stack size exceeded$/)
  const state = await request(bridge, env.token, { path: '/control/state' }).answer
  assert.equal(state.status, 200, 'and it carries on')
  assert.ok(runLog(env).some((e) => e.kind === 'answer' && e.status === 500 && /can't write its answer/.test(e.body?.error)))
})

test('bridge: values nested too deep in a mod\'s fields that PROTOCOL.md gives as strings aren\'t kept, so the state still answers', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
  const post = (p, raw) => within(request(bridge, env.token, { method: 'POST', path: p, raw }).answer, 3000, `${p}: no answer within 3 s`)
  const mod = `"sid":"${A.sid}","host":"${A.host}","inst":"${A.inst}"`
  let r = await post('/v1/hello', `{"v":1,${mod},"cwd":${deep},"model":${deep},"mode":${deep},"effort":${deep},"plugin":${deep},"cc":${deep}}`)
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: true }])
  r = await post('/v1/events', `{${mod},"seq":1,"events":[{"t":"tool.start","tool":"Read","use":"u1","agent":${deep},"summary":"a.md","fp":"x","at":1}]}`)
  assert.equal(r.status, 204)
  r = await post('/v1/events', `{"sid":"${A.sid}","host":"${A.host}","inst":${deep},"seq":1,"events":[]}`)
  assert.equal(r.status, 204)
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'x' } }).answer
  await request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${A.inst}&wait=0` }).answer
  r = await post('/v1/result', `{${mod},"id":"${press.json.cmd}","state":"failed","error":${deep},"detail":${deep}}`)
  assert.equal(r.status, 204)

  const state = await within(request(bridge, env.token, { path: '/control/state' }).answer, 3000, 'the state: no answer within 3 s')
  assert.equal(state.status, 200, state.text.slice(0, 200))
  const s = state.json.sessions[A.host]
  assert.deepEqual(s.hello, { at: s.hello.at, cwd: null, model: null, mode: null, effort: null, plugin: null, cc: null })
  assert.deepEqual(s.tools.map((x) => [x.use, x.agent]), [['u1', null]], 'an agent that isn\'t a string counts as missing')
  assert.deepEqual(state.json.deck.doing[A.host], 'a.md')
  assert.deepEqual(Object.keys(s.lastSeq).sort(), [A.inst, 'null'])
  assert.deepEqual(state.json.commands.map((c) => [c.state, c.error, c.detail]), [['failed', null, null]])
})

test('bridge: a control answer is scrubbed of the token, the registry\'s and records\' fields included', async (t) => {
  const env = tempEnv(t)
  // A session named after a command line that set the token, and a record that took a run of it.
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, name: `export DECK_TOKEN=${env.token.slice(0, 20)}`, status: 'idle', statusUpdatedAt: 1 })
  writeRecord(env, A.host, { model: `model-${env.token.slice(6, 18)}`, lastFocusedAt: 1 })
  const bridge = await startBridge(t, env)
  const runs = []
  for (let i = 0; i + 8 <= env.token.length; i++) runs.push(env.token.slice(i, i + 8))
  for (const p of ['/control/state', '/control/rescan']) {
    const r = await request(bridge, env.token, { method: p === '/control/state' ? 'GET' : 'POST', path: p }).answer
    assert.equal(r.status, 200)
    assert.deepEqual(runs.filter((run) => r.text.includes(run)), [], `no run of the token in ${p}`)
  }
  const state = (await request(bridge, env.token, { path: '/control/state' }).answer).json
  assert.equal(state.registry[A.host].name, 'export DECK_TOKEN=<token>')
  assert.equal(state.records[A.host].model, 'model-<token>')
  assert.equal(state.deck.settings[A.host].model, 'model-<token>')
})

test('bridge: status rule 6 reads a record as the app does: a wrap-up with a description decides by its needsUser alone', async (t) => {
  const env = tempEnv(t)
  const cases = [
    // [record, status]
    [{ turnWrapUp: { description: 'Done.', needsUser: false }, postTurnSummary: { needs_action: true } }, 'idle'],
    [{ turnWrapUp: { description: 'Blocked on you.', needsUser: 'Approve the plan before I go on.' } }, 'needs-you'],
    [{ turnWrapUp: { description: 'Done.', needsUser: '' }, postTurnSummary: { needs_action: 'Pick a colour.' } }, 'idle'],
    [{ turnWrapUp: { description: '', needsUser: true } }, 'needs-you'],
    // Without a string description the wrap-up doesn't count, and the summary decides.
    [{ turnWrapUp: { needsUser: true } }, 'idle'],
    [{ turnWrapUp: { description: 7, needsUser: false }, postTurnSummary: { needs_action: 'Pick a colour.' } }, 'needs-you'],
    [{ postTurnSummary: { needs_action: true } }, 'needs-you'],
    [{ postTurnSummary: { needs_action: '' } }, 'idle'],
    [{ postTurnSummary: { needs_action: false } }, 'idle'],
  ]
  const hosts = cases.map((_, i) => `local_r${i}`)
  cases.forEach(([record], i) => {
    writeRegistry(env, 100 + i, { sessionId: `sid-r${i}`, hostSessionId: hosts[i], status: 'idle', statusUpdatedAt: 1 })
    writeRecord(env, hosts[i], record)
  })
  const bridge = await startBridge(t, env)
  const status = bridge.deck.view().status
  assert.deepEqual(hosts.map((h) => [h, status[h]]), cases.map(([, want], i) => [hosts[i], want]))
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
  // A .key file that a reader opening it would list: registry JSON for a session of its own.
  fs.writeFileSync(path.join(env.registryDir, '11.key'), JSON.stringify({ pid: 14, sessionId: 'sid-key', hostSessionId: 'local_key', name: 'Key', status: 'waiting', statusUpdatedAt: 1 }))
  writeRecord(env, A.host, { model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', lastFocusedAt: 5, postTurnSummary: { needs_action: true, status_detail: 'private text' } })
  // App 4.4212.0 writes a sentence where needs_action was true.
  writeRegistry(env, 15, { sessionId: 'sid-b', hostSessionId: 'local_b', name: 'B', status: 'idle', statusUpdatedAt: 1 })
  writeRecord(env, 'local_b', { model: 'claude-haiku-5-5', postTurnSummary: { needs_action: 'Approve the plan before I go on.' } })
  const bridge = await startBridge(t, env)
  const view = bridge.deck.view()
  assert.deepEqual(view.sessions.sort(), [A.host, 'local_b'], 'only entries with a hostSessionId are Code-tab sessions, and never a .key file')
  for (const what of ['local_key', 'sid-key']) assert.equal(JSON.stringify(bridge.deck.state()).includes(what), false, `nothing of the .key file: ${what}`)
  assert.deepEqual(view.settings[A.host], { model: 'claude-haiku-5-5', effort: 'low', mode: 'default' })
  assert.equal(view.status[A.host], 'needs-you', 'the record says the last turn needs the user')
  assert.equal(view.status.local_b, 'needs-you', 'a sentence says so too')
  for (const what of ['private text', 'Approve the plan']) assert.equal(JSON.stringify(bridge.deck.state()).includes(what), false, `only the flag is kept: ${what}`)

  fs.rmSync(path.join(env.registryDir, `${A.pid}.json`))
  await bridge.rescan()
  assert.deepEqual(bridge.deck.view().sessions, ['local_b'])
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

test('bridge: no run of 8 or more of the token reaches the log, stdout or the state, even at the end of a summary cut short', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  const input = { command: `export DECK_TOKEN=${env.token}` }
  // The mod's summary of the call: cut to 39 characters and an ellipsis, it ends in the token's first 21.
  const cut = summary('Bash', input)
  assert.deepEqual([cut.length, cut.endsWith(`${env.token.slice(0, 21)}…`), cut.includes(env.token)], [40, true, false])
  const mod = { sid: A.sid, host: A.host, inst: A.inst }
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, ...mod, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  let r = await request(bridge, env.token, { method: 'POST', path: '/v1/events', json: { ...mod, seq: 1, events: [{ t: 'tool.start', tool: 'Bash', use: 'u1', summary: cut, fp: fingerprint('Bash', input), at: 1 }] } }).answer
  assert.equal(r.status, 204)
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Bash', tool_input: input } })
  await sleep(100)
  // A run from the middle, in an event and in a query.
  const middle = env.token.slice(5, 14)
  await request(bridge, env.token, { method: 'POST', path: `/v1/events?x=${middle}`, json: { ...mod, seq: 2, events: [{ t: 'settings', model: `claude_${middle}`, at: 2 }] } }).answer
  const state = await request(bridge, env.token, { path: '/control/state' }).answer
  assert.equal(state.json.sessions[A.host].tools[0].summary, 'export DECK_TOKEN=<token>…')
  await request(bridge, env.token, { method: 'POST', path: '/control/deny' }).answer
  await held.answer
  await bridge.close()

  const runs = []
  for (let i = 0; i + 8 <= env.token.length; i++) runs.push(env.token.slice(i, i + 8))
  const leaked = (text) => runs.filter((run) => text.includes(run))
  const text = fs.readFileSync(path.join(env.runDir, 'events.jsonl'), 'utf8')
  assert.deepEqual(leaked(text), [], 'in the log')
  assert.deepEqual(leaked(lines.join('\n')), [], 'on stdout')
  assert.deepEqual(leaked(state.text), [], 'in the state')
  assert.ok(text.includes('export DECK_TOKEN=<token>…'), 'the cut summary is there, scrubbed')
  assert.ok(text.includes('claude_<token>'))
})

test('bridge: the scrubber takes the token and every run of 8 or more of it, as it is and as JSON escapes it', () => {
  const token = 'tok-0123456789abcdef'
  const scrub = scrubber(token)
  assert.equal(scrub(`a ${token} b`), 'a <token> b')
  assert.equal(scrub(`cut ${token.slice(0, 8)}…`), 'cut <token>…')
  assert.equal(scrub(`end ${token.slice(-12)}.`), 'end <token>.')
  assert.equal(scrub(`seven ${token.slice(3, 10)} stays`), `seven ${token.slice(3, 10)} stays`)
  assert.equal(scrub(`${token}${token.slice(0, 9)}`), '<token><token>')
  const quoted = 'ab"cd\\ef0123'
  assert.equal(scrubber(quoted)(JSON.stringify({ k: `x${quoted}y` })), '{"k":"x<token>y"}')
  assert.equal(scrubber('short')('a short b'), 'a <token> b', 'a token under 8 characters goes whole')
  assert.equal(scrubber('')('as it is'), 'as it is')
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
