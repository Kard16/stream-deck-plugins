// The fake bridge over HTTP, on a free port with temp folders: transport rules, routes, long polls, the
// folders, the log, and shutdown.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'

import { parseWait, readToken, scrubBody, scrubber, secretScrubber, startFakeBridge } from '../lib/bridge.mjs'
import { hostHeader, send, within } from '../lib/client.mjs'
import { ALLOW, DENY, MAX_BODY, fingerprint, summary } from '../lib/protocol.mjs'
import { MOD, TOOLS, modLoop, request, runLog, sleep, startBridge, tempEnv, writeRecord, writeRegistry } from './helpers.mjs'

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

test('bridge: Node\'s own error answers carry {"error"} too: a request it can\'t parse, or headers over its limit', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  // Written straight to a socket, since a client library wouldn't send either.
  const raw = (text) => within(new Promise((resolve, reject) => {
    const chunks = []
    const socket = net.connect(Number(new URL(bridge.url).port), '127.0.0.1', () => socket.write(text))
    socket.on('data', (c) => chunks.push(c))
    socket.on('error', reject)
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
  }), 3000, 'no answer within 3 s')
  const answer = (text) => {
    const [head, body] = text.split('\r\n\r\n')
    return { status: Number(head.split(' ')[1]), type: /content-type: application\/json/i.test(head), json: body ? JSON.parse(body) : null }
  }
  assert.deepEqual(answer(await raw('NOT HTTP\r\n\r\n')), { status: 400, type: true, json: { error: 'Bad Request' } })
  const big = `POST /v1/permission HTTP/1.1\r\nhost: ${hostHeader(bridge.url)}\r\nx-big: ${'x'.repeat(20_000)}\r\ncontent-length: 2\r\n\r\n{}`
  assert.deepEqual(answer(await raw(big)), { status: 431, type: true, json: { error: 'Request Header Fields Too Large' } })
  const r = await request(bridge, env.token, { path: '/control/taken' }).answer
  assert.equal(r.status, 200, 'and it carries on')
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'client-error').map((e) => e.status), [400, 431])
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

test('bridge: a mod request naming no session it can place gets 400; a hook\'s request from a session the registry doesn\'t confirm gets {} at once', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
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
  // A terminal session's hook, with no host and a sid the deck doesn't know; and one whose sid the registry knows,
  // with no host: neither is placed by its sid any more.
  for (const [header, sid] of [['not-local', 'sid-unknown'], [undefined, A.sid]]) {
    const headers = header === undefined ? {} : { 'x-deck-host': header }
    const r = await within(request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers, json: { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' } } }).answer, 1000, `${header}: no answer within 1 s`)
    assert.deepEqual([header, r.status, r.json], [header, 200, {}])
  }
  assert.deepEqual(bridge.deck.view().held, [])
})

test('bridge: a hook\'s request the latest reading doesn\'t confirm waits for the registry to be read once more, and is taken if it then confirms it', async (t) => {
  // PROTOCOL.md, "Desktop sessions only". The bridge reads its folders only when told to here (registryMs 0).
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const mod = { sid: A.sid, host: A.host, inst: A.inst }
  // A new session, its registry file written after the bridge's last reading: the hook comes before the next scan.
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Write', tool_input: { file_path: '/s/a.txt', content: 'a' } } })
  await sleep(100)
  assert.deepEqual([held.settled, bridge.deck.view().held.map((h) => h.host)], [false, [A.host]], 'held, once the second reading confirmed it')
  assert.equal((await request(bridge, env.token, { path: '/control/taken' }).answer).json.taken, 1, 'taken once held')

  // Its sid changes (a /clear), and the file says so before the bridge has read it: a hello, and then a permission
  // request, each read it once more, rather than being refused on the reading before.
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, ...mod, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  writeRegistry(env, A.pid, { sessionId: 'sid-a2', hostSessionId: A.host, status: 'busy', statusUpdatedAt: 2 })
  const r = await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: 'sid-a2', host: A.host, inst: A.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: true }])
  writeRegistry(env, A.pid, { sessionId: 'sid-a3', hostSessionId: A.host, status: 'busy', statusUpdatedAt: 3 })
  const again = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: 'sid-a3', tool_name: 'Write', tool_input: { file_path: '/s/b.txt', content: 'b' } } })
  await sleep(100)
  assert.deepEqual([again.settled, bridge.deck.view().held.map((h) => h.summary)], [false, ['a.txt', 'b.txt']], 'held, once the second reading confirmed it')
  held.abort()
  again.abort()
})

test('bridge: a hook\'s request whose X-Deck-Host and session_id the registry lists apart, each with another session, gets {} at once after the second reading, and nothing is held', async (t) => {
  // PROTOCOL.md, "Desktop sessions only": confirmed by the pair, the request's X-Deck-Host listed with its session_id.
  const env = tempEnv(t)
  const B = { sid: 'sid-b', host: 'local_b', inst: 'ib', pid: 12 }
  for (const S of [A, B]) writeRegistry(env, S.pid, { sessionId: S.sid, hostSessionId: S.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  // A request taken as B's would be held, and not answered at once.
  const hook = (host, sid) => request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': host }, json: { session_id: sid, tool_name: 'Write', tool_input: { file_path: '/s/b.txt', content: 'b' } } })
  // B's host with A's session id, and a host the registry doesn't list, as a pre-warmed spare's, with A's.
  for (const host of [B.host, 'local_spare']) {
    const r = await within(hook(host, A.sid).answer, 1000, `from ${host} with ${A.sid}: no answer within 1 s`)
    assert.deepEqual([host, r.status, r.json], [host, 200, {}])
  }
  assert.deepEqual(bridge.deck.view().held, [])
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'unconfirmed').map((e) => [e.route, e.host, e.sid]), [['permission', B.host, A.sid], ['permission', 'local_spare', A.sid]])
  // B's own is held: only the pair the registry lists confirms a request.
  const own = hook(B.host, B.sid)
  await sleep(100)
  assert.deepEqual([own.settled, bridge.deck.view().held.map((h) => h.host)], [false, [B.host]])
  own.abort()
})

test('bridge: a hello from a host the registry lists under another sessionId gets 409 {"error": "not this session"}; one from a host it doesn\'t list is taken', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const hello = (sid, host, inst) => request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid, host, inst, cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' } }).answer
  let r = await hello('sid-child', A.host, 'ichild')
  assert.deepEqual([r.status, r.json], [409, { error: 'not this session' }])
  r = await hello('sid-spare', 'local_spare', 'ispare')
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: true }])
  assert.deepEqual(bridge.deck.view().sessions, [A.host])
  r = await hello(A.sid, A.host, A.inst)
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: true }])
  const log = runLog(env)
  assert.ok(log.some((e) => e.kind === 'answer' && e.status === 409 && e.body?.error === 'not this session'))
  assert.equal(log.filter((e) => e.kind === 'route-error').length, 0)
})

test('bridge: the mode hook of a session started before plugin 0.3.0 gets 404, an unknown route, at once, and nothing is held', async (t) => {
  // PROTOCOL.md, as amended on 2026-11-06 for Phase 8: such a session keeps the mode hook until it restarts, and
  // Claude Code takes the 404 as no decision, as with a deck that's down.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const body = { session_id: A.sid, hook_event_name: 'PreToolUse', tool_name: 'mcp__ccd_session_mgmt__set_session_permission_mode', tool_input: { session_id: 'self', mode: 'plan' } }
  const r = await within(request(bridge, env.token, { method: 'POST', path: '/v1/pretool', headers: { 'x-deck-host': A.host }, json: body }).answer, 1000, 'no answer within 1 s')
  assert.deepEqual([r.status, Object.keys(r.json), typeof r.json.error], [404, ['error'], 'string'])
  assert.deepEqual(bridge.deck.view().held, [])
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
  r = await post('/v1/result', `{${mod},"id":"${press.json.cmd}","state":"failed","error":${deep}}`)
  assert.equal(r.status, 204)

  const state = await within(request(bridge, env.token, { path: '/control/state' }).answer, 3000, 'the state: no answer within 3 s')
  assert.equal(state.status, 200, state.text.slice(0, 200))
  const s = state.json.sessions[A.host]
  assert.deepEqual(s.hello, { at: s.hello.at, inst: A.inst, cwd: null, model: null, mode: null, effort: null, plugin: null, cc: null })
  assert.deepEqual(s.tools.map((x) => [x.use, x.agent]), [['u1', null]], 'an agent that isn\'t a string counts as missing')
  assert.deepEqual(state.json.deck.doing[A.host], 'a.md')
  assert.deepEqual(Object.keys(s.lastSeq).sort(), [A.inst, 'null'])
  assert.deepEqual(state.json.commands.map((c) => [c.state, c.error]), [['failed', null]])
})

test('bridge: a mod value nested too deep in a refused hello\'s v, an event\'s t or a result\'s id or state fails nothing: its line names it instead', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
  const post = (p, raw) => within(request(bridge, env.token, { method: 'POST', path: p, raw }).answer, 3000, `${p}: no answer within 3 s`)
  const mod = `"sid":"${A.sid}","host":"${A.host}","inst":"${A.inst}"`
  let r = await post('/v1/hello', `{"v":${deep},${mod}}`)
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: false, error: 'version' }])
  await post('/v1/hello', `{"v":1,${mod},"cwd":"/s","model":"m","plugin":"0.1.0","cc":"2.1.309"}`)
  // The rest of its request still applies: the mod has spent the seq, and a retry would be dropped.
  r = await post('/v1/events', `{${mod},"seq":1,"events":[{"t":${deep},"at":1},{"t":"measure","context":{"percent":12,"window":10},"at":1}]}`)
  assert.equal(r.status, 204)
  assert.equal(bridge.deck.view().context[A.host], 12)
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'x' } }).answer
  await request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${A.inst}&wait=0` }).answer
  // A 500 here would come back after every hello, and the mod's line would never move on.
  for (const raw of [`{${mod},"id":"${press.json.cmd}","state":${deep}}`, `{${mod},"id":${deep},"state":"done"}`]) {
    r = await post('/v1/result', raw)
    assert.equal(r.status, 204)
  }
  assert.equal(bridge.deck.view().cmds[press.json.cmd], 'delivered', 'neither result applies')

  const said = lines.join('\n')
  for (const line of [
    'hello from local_a on version a value nested too deep to show: refused',
    'local_a: event of unknown type a value nested too deep to show ignored',
    `result for ${press.json.cmd} ignored: unknown state a value nested too deep to show`,
    'result for a value nested too deep to show ignored: unknown command',
  ]) assert.ok(said.includes(line), line)
  const log = runLog(env)
  assert.equal(log.filter((e) => e.kind === 'route-error').length, 0)
  assert.ok(log.some((e) => e.kind === 'result-ignored' && e.id === press.json.cmd && /Maximum call stack/.test(e.unlogged)), 'the log line keeps what it can write')
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

test('bridge: status rule 6 is the app\'s own needs-input indicator, read from each shape of record as the app reads it', async (t) => {
  const env = tempEnv(t)
  const last = { postTurnSummaryFor: 'msg-9', lastAssistantUuid: 'msg-9' }
  const cases = [
    // [record, status]. With no wrap-up, a summary of the last assistant message says by its category.
    [{ ...last, postTurnSummary: { status_category: 'blocked' } }, 'needs-you'],
    [{ ...last, postTurnSummary: { status_category: 'need_input' } }, 'needs-you'],
    [{ ...last, postTurnSummary: { status_category: 'review_ready', needs_action: 'Pick a colour.' } }, 'idle'],
    [{ ...last, postTurnSummary: { status_category: 'failed' } }, 'idle'],
    [{ ...last, postTurnSummary: { needs_action: 'Pick a colour.' } }, 'idle'],
    [{ ...last, postTurnSummary: 'blocked' }, 'idle'],
    // A summary of an earlier message, or with no ids to compare, or ids that aren't strings, doesn't count.
    [{ postTurnSummaryFor: 'msg-8', lastAssistantUuid: 'msg-9', postTurnSummary: { status_category: 'blocked' } }, 'idle'],
    [{ postTurnSummaryFor: 'msg-9', postTurnSummary: { status_category: 'blocked' } }, 'idle'],
    [{ postTurnSummary: { status_category: 'need_input', needs_action: 'Pick a colour.' } }, 'idle'],
    [{ postTurnSummaryFor: 7, lastAssistantUuid: 7, postTurnSummary: { status_category: 'blocked' } }, 'idle'],
    // A valid wrap-up makes the record count, whatever its summary is for, and recasts the summary's category.
    [{ turnWrapUp: { description: 'Blocked on you.', needsUser: 'Approve the plan before I go on.' } }, 'needs-you'],
    [{ turnWrapUp: { description: '', needsUser: '' }, postTurnSummaryFor: 'msg-8', lastAssistantUuid: 'msg-9' }, 'needs-you'],
    [{ turnWrapUp: { description: 'Done.' }, ...last, postTurnSummary: { status_category: 'blocked' } }, 'idle'],
    [{ turnWrapUp: { description: 'Done.' }, ...last, postTurnSummary: { status_category: 'need_input' } }, 'idle'],
    [{ turnWrapUp: { description: 'Done.' } }, 'idle'],
    [{ turnWrapUp: { description: 'Stuck.', needsUser: 'Read the error.' }, ...last, postTurnSummary: { status_category: 'failed' } }, 'idle'],
    // Any other wrap-up is dropped, as the app's loader drops it, and the summary decides alone.
    [{ turnWrapUp: { description: 'Blocked on you.', needsUser: true } }, 'idle'],
    [{ turnWrapUp: { description: 'Done.', needsUser: null }, ...last, postTurnSummary: { status_category: 'review_ready' } }, 'idle'],
    [{ turnWrapUp: { description: 7, needsUser: 'Approve.' } }, 'idle'],
    [{ turnWrapUp: { needsUser: 'Approve.' }, ...last, postTurnSummary: { status_category: 'review_ready' } }, 'idle'],
    [{ turnWrapUp: 'Blocked on you.', ...last, postTurnSummary: { status_category: 'need_input' } }, 'needs-you'],
    // A summary the app's loader drops (its OM) counts as none: one of its seven fields there and not a string, null
    // included, or an is_noteworthy there and not a boolean. Fields it doesn't list don't matter.
    [{ ...last, postTurnSummary: { status_category: 'need_input', is_noteworthy: 'yes' } }, 'idle'],
    [{ ...last, postTurnSummary: { status_category: 'need_input', status_detail: null } }, 'idle'],
    [{ ...last, postTurnSummary: { status_category: 'blocked', title: 7 } }, 'idle'],
    [{ ...last, postTurnSummary: { status_category: 'blocked', summarizes_uuid: ['msg-9'] } }, 'idle'],
    [{ ...last, postTurnSummary: { status_category: 'need_input', is_noteworthy: false, priority: 3, extra: { nested: 1 } } }, 'needs-you'],
    [{ ...last, postTurnSummary: ['need_input'] }, 'idle'],
    [{ ...last, postTurnSummary: null }, 'idle'],
    // With a valid wrap-up, a dropped summary has no category: a failed one doesn't stay failed, and needsUser blocks.
    [{ turnWrapUp: { description: 'Stuck.', needsUser: 'Read the error.' }, ...last, postTurnSummary: { status_category: 'failed', recent_action: 7 } }, 'needs-you'],
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

test('bridge: task cards and threads, as the deck reads them (PROTOCOL.md\'s 2026-11-08 amendment: rules 2, 6 and 9)', async (t) => {
  const env = tempEnv(t)
  const last = { postTurnSummaryFor: 'msg-9', lastAssistantUuid: 'msg-9' }
  const blocked = { ...last, postTurnSummary: { status_category: 'blocked' }, turnWrapUp: { description: 'Two threads planned.' } }
  const card = (fields = {}) => ({ id: 'task_1', title: 'Doc 40 T1', createdAt: 1, ...fields })
  const thread = (parent, fields = {}) => ({ spawnedFrom: { sessionId: parent, taskId: 'task_1', sideSession: true, ...fields } })
  const cases = [
    // [host, registry status, record, status]
    ['local_cards', 'idle', { ...blocked, backgroundTaskSuggestions: [card()] }, 'needs-you'],
    ['local_suggestion', 'idle', { ...last, postTurnSummary: { status_category: 'completed' }, turnWrapUp: { description: 'Done.' }, backgroundTaskSuggestions: [card()] }, 'idle'],
    ['local_started', 'idle', blocked, 'idle'],
    ['local_accepted', 'idle', { ...blocked, backgroundTaskSuggestions: [card({ offer: true, accepted: true })] }, 'idle'],
    ['local_offer', 'busy', { backgroundTaskSuggestions: [card({ offer: true })] }, 'needs-you'],
    // The parent with two threads, one working: background. A thread's own side chat, a detached one, an archived one
    // and an idle one don't count.
    ['local_parent', 'idle', {}, 'background'],
    ['local_t1', 'busy', thread('local_parent'), 'working'],
    ['local_t2', 'idle', thread('local_parent'), 'idle'],
    ['local_alone', 'idle', {}, 'idle'],
    ['local_btw', 'busy', thread('local_alone', { btw: true, userFork: true }), 'working'],
    ['local_detached', 'busy', { ...thread('local_alone'), lineageDetached: true }, 'working'],
    ['local_archived', 'busy', { ...thread('local_alone'), isArchived: true }, 'working'],
  ]
  cases.forEach(([host, status, record], i) => {
    writeRegistry(env, 200 + i, { sessionId: `sid-c${i}`, hostSessionId: host, status, statusUpdatedAt: 1 })
    writeRecord(env, host, record)
  })
  const bridge = await startBridge(t, env)
  const status = bridge.deck.view().status
  assert.deepEqual(cases.map(([host]) => [host, status[host]]), cases.map(([host, , , want]) => [host, want]))
})

test('bridge: a long poll waits, answers when a command is queued, and needs a session', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: Date.now() })
  const bridge = await startBridge(t, env)
  const next = (wait, extra = '') => request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${A.inst}&wait=${wait}${extra}` })
  // Only a hello makes an inst current: without one, every poll asks for a hello, at once.
  let r = await next(1).answer
  assert.deepEqual([r.status, r.json, r.ms < 500], [409, { error: 'hello first' }, true], 'no hello yet: at once')
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst: A.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer

  r = await next(0).answer
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

test('bridge: a poll from an older inst is answered at once with no commands, and the newest one\'s stays open', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const hello = (inst) => request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  const next = (inst) => request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${inst}&wait=20` })
  await hello('ia')
  await hello('ia2')
  const open = next('ia2')
  await sleep(50)
  const r = await within(next('ia').answer, 1000, 'the older inst\'s poll: no answer within 1 s')
  assert.deepEqual([r.status, r.json], [200, { cmds: [] }])
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'x' } }).answer
  const got = await within(open.answer, 1000, 'the newest inst\'s poll: no answer within 1 s')
  assert.deepEqual(got.json, { cmds: [{ id: press.json.cmd, t: 'prompt', text: 'x' }] })
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

test("bridge: POST /control/dial answers a session's own oldest tool request with the keys' bodies, jumps with nothing picked or on an ask, and refuses a press that isn't one with 400", async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'waiting', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const ask = { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] }
  const hold = (tool, input, extra = {}) => request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: tool, tool_input: input, ...extra } })
  const dial = (json) => request(bridge, env.token, { method: 'POST', path: '/control/dial', json }).answer

  // A question's picks and a plan's choice went with the dial's answers to them (Phase 9): a press that has them is
  // refused, not taken as one with nothing picked.
  for (const json of [{}, { host: A.host, decision: 'yes' }, { host: A.host, plan: 'auto' }, { host: A.host, picks: { 'Red or blue?': ['Blue'] } }, { host: A.host, decision: 'allow', shown: 3 }]) {
    const r = await dial(json)
    assert.deepEqual([r.status, r.json.ok, typeof r.json.error], [400, false, 'string'], JSON.stringify(json))
  }
  const q = hold('AskUserQuestion', ask)
  await sleep(100)
  for (const json of [{ host: A.host, decision: 'allow' }, { host: A.host, shown: 'p1' }]) {
    const r = await dial(json)
    assert.deepEqual([r.status, r.json.ok, r.json.jumped, r.json.answered], [200, true, A.host, undefined], JSON.stringify(json))
  }
  assert.equal(q.settled, false, 'an ask is never answered')
  q.abort()
  await sleep(50)
  const w = hold('Write', { file_path: '/s/a.txt', content: 'a' })
  await sleep(100)
  let r = await dial({ host: A.host })
  assert.deepEqual([r.json.jumped, w.settled], [A.host, false], 'nothing picked: a jump')
  r = await dial({ host: A.host, decision: 'deny', shown: 'p2' })
  assert.deepEqual([r.status, r.json.ok, r.json.answered], [200, true, 'deny'])
  assert.deepEqual((await w.answer).json, DENY)
  r = await dial({ host: A.host, decision: 'allow' })
  assert.deepEqual([r.json.alert, r.json.error], [true, 'p2, the request the dial showed, has gone (answered)'])
  const answered = runLog(env).find((e) => e.kind === 'answered')
  assert.deepEqual([answered.id, answered.decision, answered.by], ['p2', 'deny', 'dial'])
})

test('bridge: a body is scrubbed once it has parsed, as the deck scrubs it (PROTOCOL.md, "Transport"): numbers are left alone, an escaped token is caught, and touching runs are one', async (t) => {
  const env = tempEnv(t)
  // A token with a run of digits in it, so that a number can hold 8 or more of its characters.
  env.token = `${env.token}-9081726354453627`
  fs.writeFileSync(env.tokenFile, `${env.token}\n`, { mode: 0o600 })
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'waiting', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const DIGITS = 90817263544
  const run = env.token.slice(3, 13)
  const raw = (body) => request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, raw: body })
  const hold = (tool, input, extra = {}) => raw(JSON.stringify({ session_id: A.sid, hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input, ...extra }))
  /** The request just held, as the deck read it, once the bridge has taken it; then let go, its client gone. */
  const heldAs = async (handle) => {
    await sleep(80)
    const h = bridge.deck.view().held.at(-1)
    handle.abort()
    await sleep(40)
    return h
  }
  const mod = { sid: A.sid, host: A.host, inst: A.inst }

  // A number holding a run of the token's digits is no reason to refuse a body: the events, and a seq, are taken.
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, ...mod, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  let r = await request(bridge, env.token, { method: 'POST', path: '/v1/events', json: { ...mod, seq: DIGITS, events: [{ t: 'measure', context: { percent: 7, tokens: DIGITS, window: DIGITS }, at: DIGITS }] } }).answer
  assert.equal(r.status, 204)
  assert.equal(bridge.deck.view().context[A.host], 7)
  // A request whose input holds one is held, with the mod's fp.
  const bash = { command: 'sleep 1', timeout: DIGITS }
  let h = await heldAs(hold('Bash', bash))
  assert.deepEqual([h.tool, h.summary, h.fp], ['Bash', 'sleep 1', fingerprint('Bash', bash)])

  // The token written with \u escapes is the token once parsed, and is taken out; touching or overlapping runs are one.
  const escaped = [...env.token].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  h = await heldAs(raw(`{"session_id":"${A.sid}","tool_name":"Bash","tool_input":{"command":"echo ${escaped}"}}`))
  assert.deepEqual([h.summary, h.fp], ['echo <token>', fingerprint('Bash', { command: 'echo <token>' })])
  for (const command of [`echo ${env.token}${env.token}`, `echo ${env.token.slice(0, 12)}${env.token.slice(4)}`]) {
    h = await heldAs(hold('Bash', { command }))
    assert.deepEqual([h.summary, h.fp], ['echo <token>', fingerprint('Bash', { command: 'echo <token>' })], command)
  }
  // A name is scrubbed too, defined as JSON.parse defines it: a "__proto__" beside it stays an ordinary key.
  const named = `{"__proto__":{"command":"x"},"command":"echo hi","k_${run}":1}`
  h = await heldAs(raw(`{"session_id":"${A.sid}","tool_name":"Bash","tool_input":${named}}`))
  assert.equal(h.fp, fingerprint('Bash', JSON.parse(`{"__proto__":{"command":"x"},"command":"echo hi","k_<token>":1}`)))

  // An input that is a string is scrubbed as any string is.
  h = await heldAs(hold('AskUserQuestion', `Is ${run} it?`))
  assert.equal(h.fp, fingerprint('AskUserQuestion', 'Is <token> it?'))

  // What reaches a person is still scrubbed, and still JSON: a number holding a run is a string there, scrubbed.
  const state = await request(bridge, env.token, { path: '/control/state' }).answer
  assert.equal(state.status, 200)
  assert.equal(state.json.sessions[A.host].lastSeq[A.inst], '<token>')
  await bridge.close()
  const runs = []
  for (let i = 0; i + 8 <= env.token.length; i++) runs.push(env.token.slice(i, i + 8))
  const text = fs.readFileSync(path.join(env.runDir, 'events.jsonl'), 'utf8')
  assert.deepEqual([runs.filter((x) => text.includes(x)), runs.filter((x) => state.text.includes(x))], [[], []], 'no run in the log or the state')
  const events = runLog(env).find((e) => e.kind === 'request' && e.path === '/v1/events')
  assert.deepEqual([events.body.seq, events.body.events[0].context.tokens], ['<token>', '<token>'], 'every line of the log parses')
})

test('bridge: the folders feed the deck: sessions from the registry, settings from the records', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, name: 'A', status: 'idle', statusUpdatedAt: 1 })
  writeRegistry(env, 12, { sessionId: 'sid-cli', status: 'busy' })
  fs.writeFileSync(path.join(env.registryDir, '13.json'), '{"half": ')
  // A .key file that a reader opening it would list: registry JSON for a session of its own.
  fs.writeFileSync(path.join(env.registryDir, '11.key'), JSON.stringify({ pid: 14, sessionId: 'sid-key', hostSessionId: 'local_key', name: 'Key', status: 'waiting', statusUpdatedAt: 1 }))
  writeRecord(env, A.host, {
    model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', lastFocusedAt: 5, postTurnSummaryFor: 'msg-1', lastAssistantUuid: 'msg-1',
    postTurnSummary: { status_category: 'need_input', needs_action: 'private text', status_detail: 'private text' },
  })
  // App 4.4212.0 writes what the turn needs as a sentence.
  writeRegistry(env, 15, { sessionId: 'sid-b', hostSessionId: 'local_b', name: 'B', status: 'idle', statusUpdatedAt: 1 })
  writeRecord(env, 'local_b', { model: 'claude-haiku-5-5', turnWrapUp: { description: 'private text', needsUser: 'Approve the plan before I go on.' } })
  const bridge = await startBridge(t, env)
  const view = bridge.deck.view()
  assert.deepEqual(view.sessions.sort(), [A.host, 'local_b'], 'only entries with a hostSessionId are Code-tab sessions, and never a .key file')
  for (const what of ['local_key', 'sid-key']) assert.equal(JSON.stringify(bridge.deck.state()).includes(what), false, `nothing of the .key file: ${what}`)
  assert.deepEqual(view.settings[A.host], { model: 'claude-haiku-5-5', effort: 'low', mode: 'default' })
  assert.equal(view.status[A.host], 'needs-you', 'the record says the last turn needs the user')
  assert.equal(view.status.local_b, 'needs-you', 'a wrap-up says so too')
  for (const what of ['private text', 'Approve the plan']) assert.equal(JSON.stringify(bridge.deck.state()).includes(what), false, `only the flag is kept: ${what}`)

  fs.rmSync(path.join(env.registryDir, `${A.pid}.json`))
  await bridge.rescan()
  assert.deepEqual(bridge.deck.view().sessions, ['local_b'])

  // Only ever reading them: after all of that, and a session's whole life over HTTP, the folders hold what the test
  // wrote, unchanged.
  const listing = () => {
    const out = {}
    for (const dir of [env.registryDir, env.recordsDir]) {
      for (const f of fs.readdirSync(dir, { recursive: true })) {
        const p = path.join(dir, f)
        out[p] = fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : 'folder'
      }
    }
    return out
  }
  const before = listing()
  const mod = { sid: 'sid-b', host: 'local_b', inst: 'ib' }
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, ...mod, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  await request(bridge, env.token, { method: 'POST', path: '/v1/events', json: { ...mod, seq: 1, events: [{ t: 'turn.start', turn: 't1', at: 1 }, { t: 'turn.end', turn: 't1', reason: 'answer', at: 2 }] } }).answer
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': 'local_b' }, json: { session_id: 'sid-b', tool_name: 'Bash', tool_input: { command: 'ls' } } })
  await sleep(50)
  await request(bridge, env.token, { method: 'POST', path: '/control/approve' }).answer
  await within(held.answer, 3000, 'the approved request: no answer within 3 s')
  await request(bridge, env.token, { method: 'POST', path: '/control/reset' }).answer
  await bridge.close()
  assert.deepEqual(listing(), before)
})

test('bridge: a registry folder that can\'t be listed changes nothing: the last reading stands, and the bridge warns once until a reading succeeds', async (t) => {
  // PROTOCOL.md, "The deck's session model", as amended for Phase 6 (item 5): until then such a reading ended every
  // session at once.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Bash', tool_input: { command: 'ls' } } })
  await sleep(100)
  const moved = `${env.registryDir}-moved`
  const warnings = () => runLog(env).filter((e) => e.kind === 'registry-unreadable').map((e) => e.error)
  // A file where the folder was (ENOTDIR), read twice; then a folder it may not list (EACCES), after a good reading.
  fs.renameSync(env.registryDir, moved)
  fs.writeFileSync(env.registryDir, 'not a folder')
  await bridge.rescan()
  await bridge.rescan()
  assert.equal(bridge.deck.view().held.length, 1, 'still held')
  assert.deepEqual([bridge.deck.view().sessions, bridge.deck.view().status[A.host]], [[A.host], 'approval'])
  assert.deepEqual(warnings(), ['ENOTDIR'], 'one warning for both readings')
  fs.rmSync(env.registryDir)
  fs.renameSync(moved, env.registryDir)
  await bridge.rescan()
  if (process.getuid?.() !== 0) {
    fs.chmodSync(env.registryDir, 0o000)
    try {
      await bridge.rescan()
      await bridge.rescan()
    } finally {
      fs.chmodSync(env.registryDir, 0o700)
    }
    assert.deepEqual(warnings(), ['ENOTDIR', 'EACCES'], 'warned again once a reading had succeeded between')
    assert.deepEqual([bridge.deck.view().held.length, bridge.deck.view().sessions], [1, [A.host]])
  } else {
    t.diagnostic('running as root, which lists any folder: the EACCES case was skipped')
  }
  assert.ok(lines.some((l) => / registry folder unreadable \(ENOTDIR\), so the last reading stands until one succeeds: /.test(l)), lines.join('\n'))
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'registry' && e.change === 'removed'), [], 'no session ended')
  held.abort()
})

test('bridge: a registry folder that doesn\'t exist is no sessions: each ends, release rule 4, and the bridge says so once until the folder is back, and again if it goes a second time', async (t) => {
  // PROTOCOL.md, "The deck's session model": "A folder that doesn't exist is no sessions."
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Bash', tool_input: { command: 'ls' } } })
  await sleep(100)
  assert.equal(bridge.deck.view().held.length, 1)
  fs.rmSync(env.registryDir, { recursive: true })
  await bridge.rescan()
  await bridge.rescan()
  assert.deepEqual((await within(held.answer, 1000, 'the held request: no answer within 1 s')).json, {}, 'released with no decision')
  assert.deepEqual([bridge.deck.view().held, bridge.deck.view().sessions], [[], []])
  const log = runLog(env)
  assert.deepEqual(log.filter((e) => e.kind === 'release').map((e) => e.rule), [4])
  assert.deepEqual(log.filter((e) => e.kind === 'registry-missing').length, 1, 'said once')
  assert.deepEqual(log.filter((e) => e.kind === 'registry-unreadable'), [], 'and no warning: nothing went wrong')
  const said = () => lines.filter((l) => / registry folder missing, so no sessions: /.test(l)).length
  assert.equal(said(), 1, 'one line on stdout')
  // Back, with the session: it's listed again, and nothing more is said.
  fs.mkdirSync(env.registryDir)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 2 })
  await bridge.rescan()
  await bridge.rescan()
  assert.deepEqual(bridge.deck.view().sessions, [A.host])
  const missing = () => runLog(env).filter((e) => e.kind === 'registry-missing').length
  assert.deepEqual([missing(), said()], [1, 1], 'nothing more once it\'s back')
  // Gone a second time: said again, once, however many readings find it gone.
  fs.rmSync(env.registryDir, { recursive: true })
  await bridge.rescan()
  await bridge.rescan()
  await bridge.rescan()
  assert.deepEqual([bridge.deck.view().sessions, missing(), said()], [[], 2, 2])
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'registry-unreadable'), [], 'and still no warning')
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
  const r = await within(held.answer, 3000, 'the denied request: no answer within 3 s')
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

test('bridge: stdout gets a line for each hello, held request, release, press, command and registry change, and the log a line of every kind README.md\'s jq lines select', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const lines = []
  // The 60 s a command or a current instance has stay 60 s here, so no step races them on a slow machine. Only the
  // step that needs an instance to stop counting has them cut short, on a bridge of its own at the end.
  const bridge = await startBridge(t, env, { quiet: false, print: (l) => lines.push(l) })
  // Every answer this waits for comes within 3 s, or the test fails: a fake that held one wrongly mustn't hang it.
  const answered = (handle, what) => within(handle.answer, 3000, `${what}: no answer within 3 s`)
  const call = (opts) => answered(request(bridge, env.token, opts), opts.path)
  const mod = (inst = A.inst) => ({ sid: A.sid, host: A.host, inst })
  const hook = (p, json, header = A.host) => request(bridge, env.token, { method: 'POST', path: p, headers: { 'x-deck-host': header }, json: { session_id: A.sid, ...json } })
  const next = (inst = A.inst) => request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${inst}&wait=20` })
  let seq = 0
  const events = (...evs) => call({ method: 'POST', path: '/v1/events', json: { ...mod(), seq: ++seq, events: evs.map((e) => ({ at: 1, ...e })) } })
  const W = { file_path: '/s/a.txt', content: 'a' }
  const B1 = { command: 'make' }

  await call({ method: 'POST', path: '/v1/hello', json: { v: 1, ...mod(), cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' } })
  next()
  await sleep(30)
  const n2 = next()
  await sleep(30)
  // A held request, paired with its tool.start, then answered by a press; another released by its tool.end.
  await events({ t: 'tool.start', tool: 'Write', use: 'u1', summary: 'a.txt', fp: fingerprint('Write', W) })
  const p1 = hook('/v1/permission', { tool_name: 'Write', tool_input: W })
  await sleep(50)
  await call({ method: 'POST', path: '/control/approve' })
  await answered(p1, 'p1')
  const p2 = hook('/v1/permission', { tool_name: 'Bash', tool_input: B1 })
  await sleep(50)
  await events({ t: 'tool.end', tool: 'Bash', use: 'u2', fp: fingerprint('Bash', B1), ok: true })
  await answered(p2, 'p2')
  // A subagent's request its session's dial allows, and a question its dial only jumps from, released by its tool.end.
  const q1 = hook('/v1/permission', { tool_name: 'Bash', tool_input: B1, agent_id: 'w1' })
  await sleep(50)
  assert.equal((await call({ method: 'POST', path: '/control/dial', json: { host: A.host, decision: 'allow' } })).json.answered, 'allow')
  await answered(q1, 'q1')
  const Q = { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }] }
  const q2 = hook('/v1/permission', { tool_name: 'AskUserQuestion', tool_input: Q })
  await sleep(50)
  assert.equal((await call({ method: 'POST', path: '/control/dial', json: { host: A.host } })).json.jumped, A.host)
  await events({ t: 'tool.end', tool: 'AskUserQuestion', use: 'u3', fp: fingerprint('AskUserQuestion', Q), ok: true })
  await answered(q2, 'q2')
  // A prompt: delivered to the open poll; a request from a `claude` started inside the session; a result from an inst
  // that never said hello.
  const press = await call({ method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'List the files.' } })
  await answered(n2, 'n2')
  await call({ method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: 'sid-child', tool_name: 'Write', tool_input: W } })
  await call({ method: 'POST', path: '/v1/result', json: { ...mod('istray'), id: press.json.cmd, state: 'done' } })
  // A restart; the main loop's turn end with a poll open, the poll after it answered at once, and a stray poll.
  await call({ method: 'POST', path: '/v1/hello', json: { v: 1, ...mod('ia2'), cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' } })
  const n3 = next('ia2')
  await sleep(30)
  await events({ t: 'turn.start', turn: 't1' }, { t: 'turn.end', turn: 't1', reason: 'answer' })
  await answered(n3, 'n3')
  await answered(next('ia2'), 'the poll after the turn end')
  await answered(next('iold'), 'the stray poll')
  // The registry changes; a route throws, on a body nested too deep to log; Node can't parse a request; a control
  // route throws.
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 2 })
  await call({ method: 'POST', path: '/control/rescan' })
  const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
  await call({ method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, raw: `{"session_id":"${A.sid}","tool_name":"Bash","tool_input":${deep}}` })
  await within(new Promise((resolve) => {
    const socket = net.connect(Number(new URL(bridge.url).port), '127.0.0.1', () => socket.write('NOT HTTP\r\n\r\n'))
    socket.on('data', () => {})
    socket.on('close', resolve)
    socket.on('error', resolve)
  }), 3000, 'no close within 3 s')
  // A request whose client goes away while the registry is read once more, slowly.
  const readdir = fsp.readdir
  fsp.readdir = async (...args) => {
    await sleep(150)
    return readdir(...args)
  }
  try {
    const gone = hook('/v1/permission', { session_id: 'sid-gone', tool_name: 'Write', tool_input: W })
    await sleep(30)
    gone.abort()
    await sleep(250)
  } finally {
    fsp.readdir = readdir
  }
  // A reset with a poll open cuts it off, and the mod's next poll asks for a hello.
  const n4 = next('ia2')
  await sleep(30)
  await call({ method: 'POST', path: '/control/reset' })
  assert.equal(await within(n4.answer.then(() => 'answered', () => 'cut off'), 3000, 'n4: neither answered nor cut off within 3 s'), 'cut off')
  assert.deepEqual((await answered(next('ia2'), 'the poll after the reset')).json, { error: 'hello first' })
  bridge.deck.state = () => {
    throw new TypeError('the state broke')
  }
  const broken = await call({ path: '/control/state' })
  assert.equal(broken.status, 500)
  await bridge.close()

  // An instance that stops counting, on a bridge of its own whose 60 s are cut to QUIET_MS, with a run folder of its
  // own: its hello makes it current, and with no poll after it, it stops counting.
  const QUIET_MS = 500
  const quietEnv = { ...env, runDir: path.join(env.root, 'run-quiet') }
  const quiet = await startBridge(t, quietEnv, { quiet: false, print: (l) => lines.push(l), inFlightMs: QUIET_MS })
  const helloQuiet = await within(request(quiet, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, ...mod('ia2'), cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' } }).answer, 3000, 'the hello: no answer within 3 s')
  assert.deepEqual([helloQuiet.json, quiet.deck.state().sessions[A.host].inst], [{ v: 1, ok: true }, 'ia2'])
  for (let i = 0; i < 300 && quiet.deck.state().sessions[A.host]?.inst !== null; i++) await sleep(10)
  assert.equal(quiet.deck.state().sessions[A.host].inst, null, 'no instance counts')
  await quiet.close()

  const log = [...runLog(env), ...runLog(quietEnv)]
  const kinds = ['fp-check', 'held', 'release', 'answered', 'command', 'result-ignored', 'unconfirmed', 'client-gone', 'poll-turn-end', 'poll-at-once', 'poll-superseded', 'poll-stale', 'poll-cut', 'poll-hello-first', 'hello', 'mod-restart', 'inst-quiet', 'request', 'registry', 'route-error', 'control-error', 'client-error']
  assert.deepEqual(kinds.filter((k) => !log.some((e) => e.kind === k)), [], 'every kind the jq lines select')
  assert.ok(log.some((e) => e.unlogged), 'and a line that says why its body is missing')
  // The fields the jq lines pick out.
  assert.ok(log.some((e) => e.kind === 'fp-check' && e.match === true && e.bridgeFp === e.modFp && e.bridgeSummary === 'a.txt'))
  assert.ok(log.some((e) => e.kind === 'release' && e.rule === 1 && typeof e.why === 'string'))
  assert.ok(log.some((e) => e.kind === 'answered' && e.decision === 'allow' && e.by === 'press'))
  // Each held request's kind and loop, and an answer from a dial.
  const heldLines = log.filter((e) => e.kind === 'held')
  assert.deepEqual(heldLines.map((e) => [e.tool, e.requestKind, e.agent]), [['Write', 'tool', null], ['Bash', 'tool', null], ['Bash', 'tool', 'w1'], ['AskUserQuestion', 'ask', null]])
  assert.ok(log.some((e) => e.kind === 'answered' && e.by === 'dial' && e.decision === 'allow' && e.id === heldLines[2].id))
  assert.ok(log.some((e) => e.kind === 'unconfirmed' && e.route === 'permission' && e.sid === 'sid-child' && e.host === A.host))
  assert.ok(log.some((e) => e.kind === 'client-gone' && e.route === 'permission' && e.sid === 'sid-gone' && e.host === A.host && typeof e.why === 'string'))
  assert.ok(log.some((e) => e.kind === 'poll-hello-first' && e.host === A.host && e.inst === 'ia2' && Number.isInteger(e.poll)))
  assert.ok(log.some((e) => e.kind === 'inst-quiet' && e.host === A.host && e.inst === 'ia2' && e.quietMs >= QUIET_MS / 2))
  assert.ok(log.some((e) => e.kind === 'hello' && e.again === false && e.madeCurrent === true && Array.isArray(e.took) && Array.isArray(e.kept) && typeof e.saidBefore === 'boolean'))
  assert.ok(log.some((e) => e.kind === 'poll-at-once' && Array.isArray(e.cmds) && Number.isFinite(e.sinceTurnEndMs)))
  assert.ok(log.some((e) => e.kind === 'request' && e.path === '/v1/next' && typeof e.query === 'string' && Number.isInteger(e.n) && e.method === 'GET' && e.auth === 'ok'))
  assert.ok(log.some((e) => e.kind === 'registry' && e.change === 'changed' && e.to.status === 'idle' && e.host === A.host))

  const said = lines.join('\n')
  const want = [
    [/ hello local_a inst ia \(plugin 0\.2\.0, cc 2\.1\.309, m\)/, 'hello'],
    [/ p1 HELD tool local_a Write: a\.txt fp [0-9a-f]{8}\n/, 'a held request'],
    [/ p3 HELD tool local_a Bash: make fp [0-9a-f]{8} agent w1\n/, "a subagent's held request"],
    [/ press dial local_a: jumps to local_a/, 'a jump from a dial'],
    [/ p2 released with \{\}: tool\.end with the same fp \(rule 1\)/, 'a release'],
    [/ press approve: allow p1/, 'a press'],
    [new RegExp(` ${press.json.cmd} queued for local_a: prompt "List the files\\."`), 'a command'],
    [new RegExp(` ${press.json.cmd} delivered to local_a \\(inst ia\\)`), 'its delivery'],
    [/ registry ~ local_a busy → idle/, 'a registry change'],
    [/ local_a: poll from inst ia2 answered 409 hello first: no instance has said hello for the session/, 'a hello first'],
    [/ local_a: inst ia2 has had no poll open for 0\.5 s, so it no longer counts: the mod's next poll gets 409 hello first, and the next hello, from any instance that said hello before or a new one, makes its own current/, 'an instance that stopped polling'],
  ]
  assert.deepEqual(want.filter(([re]) => !re.test(said)).map(([, what]) => what), [], said)
})

test('bridge: the control routes check the Host before the token too, and the state has what README.md lists; a reset sets taken back to 0', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  let r = await request(bridge, env.token, { path: '/control/state', headers: { host: 'evil.example:47600', authorization: null } }).answer
  assert.equal(r.status, 403, 'a bad Host and no token: the Host first')
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst: A.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  r = await request(bridge, env.token, { path: '/control/state' }).answer
  assert.deepEqual(Object.keys(r.json).toSorted(), ['commands', 'deck', 'dials', 'dirs', 'lastPress', 'recent', 'records', 'registry', 'runDir', 'sessions', 'taken', 'url', 'v'])
  assert.deepEqual(Object.keys(r.json.deck).toSorted(), ['alert', 'cmds', 'context', 'doing', 'held', 'jumped', 'sessions', 'settings', 'status', 'target', 'threads'])
  assert.deepEqual([r.json.sessions[A.host].inst, r.json.sessions[A.host].insts, r.json.taken, r.json.runDir, r.json.dirs], [A.inst, [A.inst], 1, env.runDir, { registry: env.registryDir, records: env.recordsDir }])
  await request(bridge, env.token, { method: 'POST', path: '/control/reset' }).answer
  r = await request(bridge, env.token, { path: '/control/taken' }).answer
  assert.deepEqual(r.json, { taken: 0 })
})

test('bridge: a hook\'s request that needs the registry read once more counts as taken only once that reading is done and the request held', async (t) => {
  // fake-claude waits on /control/taken so that what follows a held request lands after it.
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  // Readings of the folder made slow, so a count made too early would show.
  const readdir = fsp.readdir
  fsp.readdir = async (...args) => {
    await sleep(150)
    return readdir(...args)
  }
  try {
    const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Write', tool_input: {} } })
    const seen = []
    for (let i = 0; i < 200; i++) {
      const { taken } = (await request(bridge, env.token, { path: '/control/taken' }).answer).json
      seen.push([taken, bridge.deck.view().held.length])
      if (taken === 1) break
      await sleep(10)
    }
    assert.deepEqual(seen.filter(([taken, holding]) => taken === 1 && holding === 0), [], 'never taken before it was held')
    assert.deepEqual(seen.at(-1), [1, 1])
    held.abort()
  } finally {
    fsp.readdir = readdir
  }
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
  await within(held.answer, 3000, 'the denied request: no answer within 3 s')
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
  // Touching or overlapping runs are one, as the deck's Scrubber has them; runs apart stay apart.
  assert.equal(scrub(`${token}${token.slice(0, 9)}`), '<token>')
  assert.equal(scrub(`${token}${token}`), '<token>')
  assert.equal(scrub(`${token.slice(0, 12)}${token.slice(4)}`), '<token>')
  assert.equal(scrub(`${token.slice(0, 8)} ${token.slice(0, 8)}`), '<token> <token>')
  const quoted = 'ab"cd\\ef0123'
  assert.equal(scrubber(quoted)(JSON.stringify({ k: `x${quoted}y` })), '{"k":"x<token>y"}')
  assert.equal(secretScrubber(quoted)(`x${quoted}y`), 'x<token>y', 'as it is, in a string a body parsed to')
  assert.equal(secretScrubber(quoted)(JSON.stringify(quoted)), JSON.stringify(quoted), "a body's strings are scrubbed of the token as it is, not as JSON escapes it")
  assert.equal(scrubber('short')('a short b'), 'a <token> b', 'a token under 8 characters goes whole')
  assert.equal(scrubber('')('as it is'), 'as it is')
})

test("bridge: scrubBody takes the token out of every string and name of a parsed body, as the deck's scrubJson does", () => {
  const token = 'tok-0123456789abcdef'
  const scrub = secretScrubber(token)
  const run = token.slice(2, 12)
  const of = (text) => scrubBody(JSON.parse(text), scrub)
  // Strings at any depth, and names, in their order; numbers, booleans and null as they are.
  let r = of(JSON.stringify({ a: [`x ${token}`, { [`k_${run}`]: run, n: 1234567890123, b: true, z: null }], c: 'plain' }))
  assert.equal(JSON.stringify(r), '{"a":["x <token>",{"k_<token>":"<token>","n":1234567890123,"b":true,"z":null}],"c":"plain"}')
  // A renamed name is defined as JSON.parse defines it: a "__proto__" beside it stays an ordinary key, in its place.
  r = of(`{"tool_input": {"__proto__": {"x": 1}, "k_${run}": 2, "last": 3}}`)
  assert.deepEqual(Object.keys(r.tool_input), ['__proto__', 'k_<token>', 'last'])
  assert.equal(Object.getPrototypeOf(r.tool_input), Object.prototype)
  assert.deepEqual(r.tool_input.__proto__, { x: 1 })
  // Of two names that scrub alike, the later value wins, in the earlier's place.
  r = of(`{"k_${run}": 1, "m": 2, "k_${token.slice(4, 14)}": 3}`)
  assert.equal(JSON.stringify(r), '{"k_<token>":3,"m":2}')
  // A string body, and nesting too deep for a walk by recursion.
  assert.equal(scrubBody(`a ${token}`, scrub), 'a <token>')
  const deep = JSON.parse(`{"tool_input":${'['.repeat(100_000)}"${run}"${']'.repeat(100_000)}}`)
  let bottom = scrubBody(deep, scrub).tool_input
  while (Array.isArray(bottom)) bottom = bottom[0]
  assert.equal(bottom, '<token>')
})

test('bridge: a reset cuts the open poll off with no answer, so the live mod\'s fetch fails and it says hello again; its next poll is held and takes the next command', async (t) => {
  // The reset forgets every inst that said hello, and only a hello makes one current again (PROTOCOL.md, Identity).
  // The mod says hello again only after a failed request ("Failure and recovery"): had its poll been answered with no
  // commands, it would have polled on, its polls answered at once, and a press would never have reached it.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const hello = () => request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst: A.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  const next = () => request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${A.inst}&wait=20` })
  await hello()
  const n1 = next()
  await sleep(50)
  assert.equal(n1.settled, false, 'held')
  assert.equal((await request(bridge, env.token, { method: 'POST', path: '/control/reset' }).answer).status, 200)
  const outcome = await within(n1.answer.then((r) => `answered ${r.status} ${r.text}`, (err) => `failed: ${err.code ?? err.message}`), 1000, 'the open poll: neither answered nor cut off within 1 s')
  assert.match(outcome, /^failed: /, 'cut off with no answer, as a deck that restarts drops it')
  // As the mod does after a fetch that fails: hello again, with the same inst, then poll.
  assert.deepEqual((await hello()).json, { v: 1, ok: true })
  const n2 = next()
  await sleep(50)
  assert.equal(n2.settled, false, 'its next poll is held: the inst is current again')
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'Hi.' } }).answer
  assert.equal(press.json.ok, true, JSON.stringify(press.json))
  const got = await within(n2.answer, 1000, 'the poll after the hello: no answer within 1 s')
  assert.deepEqual(got.json, { cmds: [{ id: press.json.cmd, t: 'prompt', text: 'Hi.' }] })
  const log = runLog(env)
  assert.deepEqual(log.filter((e) => e.kind === 'poll-cut').map((e) => [e.host, e.inst, e.why]), [[A.host, A.inst, 'the bridge was reset']])
  assert.equal(log.filter((e) => e.kind === 'cut').length, 1, 'and a cut line for its request')
})

/** Index of the first trace item after `from` that `test` picks, or -1; -1 too when `from` is. */
const findFrom = (trace, from, test) => {
  if (from < 0) return -1
  for (let i = from + 1; i < trace.length; i++) if (test(trace[i])) return i
  return -1
}

/** Index of the first hello answered ok after the first poll answered 409 after `from`, or -1. */
const helloAfter409 = (trace, from) => findFrom(trace, findFrom(trace, from, (x) => x.what === 'poll' && x.status === 409), (x) => x.what === 'hello' && x.status === 200)

test('bridge: two registry files for one host, read from the folder: the one that started later shows, and either\'s session id confirms a hook\'s request or a hello', async (t) => {
  // A restarted process whose old file lingers. registry.mjs keeps startedAt, which picks the file the deck shows.
  const env = tempEnv(t)
  // The older start has the higher pid and the later file name, so neither the order of reading nor the pid picks it.
  writeRegistry(env, 99, { sessionId: 'sid-old', hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1, startedAt: 1000 })
  writeRegistry(env, 100, { sessionId: 'sid-new', hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1, startedAt: 2000 })
  const bridge = await startBridge(t, env)
  assert.deepEqual([bridge.deck.view().sessions, bridge.deck.view().status[A.host], bridge.deck.state().registry[A.host].startedAt], [[A.host], 'working', 2000])
  const hook = (sid) => request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: sid, tool_name: 'Bash', tool_input: { command: `echo ${sid}` } } })
  const own = [hook('sid-old'), hook('sid-new')]
  assert.deepEqual((await within(hook('sid-other').answer, 1000, 'sid-other: no answer within 1 s')).json, {})
  await sleep(50)
  assert.deepEqual([own.map((h) => h.settled), bridge.deck.view().held.map((h) => h.summary).toSorted()], [[false, false], ['echo sid-new', 'echo sid-old']], "either file's session id confirms a request, which is held")
  for (const h of own) h.abort()
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'unconfirmed').map((e) => e.sid), ['sid-other'], 'only the session id no file lists is unconfirmed')
  const hello = (sid, inst) => request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid, host: A.host, inst, cwd: '/s', model: 'm', plugin: '0.3.0', cc: '2.1.309' } }).answer
  assert.deepEqual([(await hello('sid-old', 'i1')).status, (await hello('sid-new', 'i2')).status, (await hello('sid-other', 'i3')).status], [200, 200, 409])
})

test('bridge: a mod waiting out its second after a turn end, with nothing open, when the deck resets hears 409 hello first at its next poll, says hello 100 ms later, and takes the next command', async (t) => {
  // PROTOCOL.md, Identity, as amended (item 5). The mod is played as claude-code/plugin/hooks/bridge.ts plays it.
  // Before the amendment its next poll went through, answered at once with none, and so did every one after it.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const mod = modLoop(bridge, env.token, A)
  t.after(() => mod.stop())
  mod.start()
  const open = () => bridge.deck.state().sessions[A.host]?.poll !== null && bridge.deck.state().sessions[A.host]?.poll !== undefined
  await mod.until(() => open(), 2000, 'its first poll held')
  // The main loop's turn ends: the bridge answers the open poll with none, and the mod waits out the rest of its second.
  const events = { sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [{ t: 'turn.start', turn: 't1', at: 1 }, { t: 'turn.end', turn: 't1', reason: 'answer', at: 2 }] }
  assert.equal((await request(bridge, env.token, { method: 'POST', path: '/v1/events', json: events }).answer).status, 204)
  await mod.until((tr) => tr.some((x) => x.what === 'poll' && x.status === 200), 2000, 'the poll answered at the turn end')
  // Now, in that second, with nothing of the mod's open, the deck restarts.
  assert.equal(open(), false, 'nothing open')
  assert.equal((await request(bridge, env.token, { method: 'POST', path: '/control/reset' }).answer).status, 200)
  const resetAt = mod.trace.length - 1
  const early = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'Too soon.' } }).answer
  assert.equal(early.json.alert, true, 'a press before its hello alerts, and queues nothing')
  // Its next poll asks for a hello, which it says quietly 100 ms later, and its poll after that is held.
  await mod.until((tr) => helloAfter409(tr, resetAt) >= 0, 3000, 'a hello after the 409')
  const i409 = findFrom(mod.trace, resetAt, (x) => x.what === 'poll' && x.status === 409)
  const iHello = findFrom(mod.trace, i409, (x) => x.what === 'hello')
  assert.ok(mod.trace[iHello].ms - mod.trace[i409].ms >= MOD.RETRY_MS - 10, JSON.stringify(mod.trace))
  assert.deepEqual(mod.trace.slice(i409, iHello + 1).map((x) => x.what), ['poll', 'quick-hello', 'hello'], 'no outage: the 409 is a quick hello')
  await mod.until(() => open(), 2000, 'its poll held after the hello')
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'Hi.' } }).answer
  assert.equal(press.json.ok, true, JSON.stringify(press.json))
  await mod.until(() => mod.cmds.some((c) => c.id === press.json.cmd), 2000, 'the command delivered')
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'poll-hello-first').map((e) => [e.host, e.inst]), [[A.host, A.inst]])
  assert.equal(runLog(env).filter((e) => e.kind === 'poll-cut').length, 0, 'the reset found no poll to cut')
})

test('bridge: a registry reading that misses the session answers its poll and forgets it; with its file back, the mod\'s next poll hears 409 hello first, and it takes commands again after its hello', async (t) => {
  // The hello-again fixture's case, with the mod played as bridge.ts plays it.
  const env = tempEnv(t)
  const file = { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 }
  writeRegistry(env, A.pid, file)
  const bridge = await startBridge(t, env)
  const mod = modLoop(bridge, env.token, A)
  t.after(() => mod.stop())
  mod.start()
  const open = () => (bridge.deck.state().sessions[A.host]?.poll ?? null) !== null
  await mod.until(() => open(), 2000, 'its first poll held')
  fs.rmSync(path.join(env.registryDir, `${A.pid}.json`))
  await bridge.rescan()
  await mod.until((tr) => tr.some((x) => x.what === 'poll' && x.status === 200), 2000, 'the poll answered at release rule 4')
  const goneAt = mod.trace.length - 1
  writeRegistry(env, A.pid, { ...file, statusUpdatedAt: 2 })
  await bridge.rescan()
  await mod.until((tr) => helloAfter409(tr, goneAt) >= 0, 3000, 'a hello after the 409')
  await mod.until(() => open(), 2000, 'its poll held after the hello')
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'Hi.' } }).answer
  assert.equal(press.json.ok, true, JSON.stringify(press.json))
  await mod.until(() => mod.cmds.some((c) => c.id === press.json.cmd), 2000, 'the command delivered')
  assert.deepEqual(mod.trace.filter((x) => x.what === 'outage'), [], 'and no outage')
})

test('bridge: after a reset, a live mod and its lingering predecessor both say hello, the predecessor\'s last: once that has gone the bridge\'s limit with no poll, the live mod\'s next poll hears 409, its hello makes it current, and it takes the next command', async (t) => {
  // PROTOCOL.md, Identity, as amended for Phase 6 (item 1): the two-processes case from round 2's review. The live mod
  // is played as claude-code/plugin/hooks/bridge.ts plays it; the bridge's 60 s are cut to 2.5 s (inFlightMs).
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env, { inFlightMs: 2_500 })
  const live = modLoop(bridge, env.token, { ...A, inst: 'inew' })
  t.after(() => live.stop())
  live.start()
  const state = () => bridge.deck.state().sessions[A.host]
  const control = (p, json = {}) => request(bridge, env.token, { method: 'POST', path: p, json }).answer
  await live.until(() => state()?.poll?.inst === 'inew', 2000, 'its first poll held')
  // The deck restarts: the live mod's poll is cut off, and it says hello again 100 ms later.
  await control('/control/reset')
  await live.until((tr) => tr.filter((x) => x.what === 'hello' && x.status === 200).length === 2, 2000, 'its hello after the reset')
  await live.until(() => state()?.poll?.inst === 'inew', 2000, 'its poll held again')
  // The predecessor's hello lands last: it's made current, and it never polls.
  const old = await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst: 'iold', cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' } }).answer
  assert.deepEqual([old.json, state().inst], [{ v: 1, ok: true }, 'iold'])
  const since = live.trace.length
  // The live mod's polls are answered at once with none, a second apart, as an older instance's.
  await live.until((tr) => tr.slice(since).filter((x) => x.what === 'poll' && x.status === 200).length >= 2, 3000, 'polls answered at once')
  assert.equal(state().inst, 'iold')
  // Then the predecessor has gone 2.5 s with no poll: it stops counting. The live mod's next poll asks for a hello.
  await live.until((tr) => helloAfter409(tr, since - 1) >= 0, 4000, 'a 409, then a hello')
  await live.until(() => state()?.poll?.inst === 'inew', 2000, 'its poll held after the hello')
  assert.equal(state().inst, 'inew')
  const press = await control('/control/prompt', { host: A.host, text: 'Hi.' })
  assert.equal(press.json.ok, true, JSON.stringify(press.json))
  await live.until(() => live.cmds.some((c) => c.id === press.json.cmd), 2000, 'the command delivered')
  await live.until(() => state()?.poll?.inst === 'inew', 2000, 'its poll held after the command')
  // One of the predecessor's fetches rejects, and it says hello again. The deck still remembers it (PROTOCOL.md,
  // Identity, as amended for Phase 6, round 4), so nothing changes: no restart over the live mod.
  const again = await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst: 'iold', cwd: '/s', model: 'm', plugin: '0.2.0', cc: '2.1.309' } }).answer
  assert.deepEqual([again.json, state().inst, state().poll?.inst], [{ v: 1, ok: true }, 'inew', 'inew'], 'the live mod stays current, its poll held')
  assert.notEqual(bridge.deck.state().commands.find((c) => c.id === press.json.cmd).error, 'the mod restarted')
  const log = runLog(env)
  assert.deepEqual(log.filter((e) => e.kind === 'mod-restart').map((e) => [e.from, e.to]), [['inew', 'iold']], 'only the predecessor\'s first hello after the reset')
  assert.deepEqual(log.filter((e) => e.kind === 'hello').at(-1).madeCurrent, false)
  assert.deepEqual(log.filter((e) => e.kind === 'inst-quiet').map((e) => [e.host, e.inst]), [[A.host, 'iold']])
  assert.deepEqual(log.filter((e) => e.kind === 'poll-stale').map((e) => [e.inst, e.current]).slice(0, 2), [['inew', 'iold'], ['inew', 'iold']])
  assert.deepEqual(live.trace.filter((x) => x.what === 'outage'), [], 'and no outage: each 409 brought a quick hello')
})

test('bridge: 30 sessions at once: each says hello and keeps a poll open, their held requests are answered oldest first across sessions, and a command reaches only its own session', async (t) => {
  const env = tempEnv(t)
  const S = Array.from({ length: 30 }, (_, i) => ({ i, sid: `sid-${i}`, host: `local_s${i}`, inst: `i${i}`, pid: 1000 + i }))
  for (const s of S) writeRegistry(env, s.pid, { sessionId: s.sid, hostSessionId: s.host, name: `Session ${s.i}`, status: 'busy', statusUpdatedAt: 1, startedAt: s.i })
  const bridge = await startBridge(t, env)
  const until = async (test, ms, what) => {
    const deadline = Date.now() + ms
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`)
      await sleep(5)
    }
  }
  const view = () => bridge.deck.view()
  assert.equal(view().sessions.length, 30)
  // Every hello at once; then every mod's long poll, held.
  const hellos = await Promise.all(S.map((s) => request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: s.sid, host: s.host, inst: s.inst, cwd: `/s/${s.i}`, model: `m${s.i}`, plugin: '0.3.1', cc: '2.1.309' } }).answer))
  assert.deepEqual(hellos.filter((r) => r.status !== 200 || r.json.ok !== true), [])
  const polls = S.map((s) => request(bridge, env.token, { path: `/v1/next?sid=${s.sid}&host=${s.host}&inst=${s.inst}&wait=20` }))
  const sessions = () => bridge.deck.state().sessions
  await until(() => S.every((s) => sessions()[s.host]?.poll?.inst === s.inst), 3000, 'every poll held')
  assert.deepEqual(S.map((s) => view().settings[s.host].model), S.map((s) => `m${s.i}`), 'each session its own hello')
  // A request from each session, in a scrambled order, each sent once the one before is held: that's their age.
  const order = S.map((_, k) => S[(k * 7) % 30])
  const held = []
  for (const s of order) {
    const h = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': s.host }, json: { session_id: s.sid, tool_name: 'Bash', tool_input: { command: `echo ${s.i}` } } })
    held.push({ s, h })
    await until(() => view().held.length === held.length, 2000, `${s.host}'s request held`)
  }
  assert.deepEqual(view().held.map((x) => x.host), order.map((s) => s.host), 'oldest first, across sessions')
  assert.ok(S.every((s) => view().status[s.host] === 'approval'))
  // Approve and Deny in turn, each on the key showing the oldest: each answers exactly that one, the rest stay held.
  for (const [k, { s, h }] of held.entries()) {
    const oldest = view().held[0]
    assert.equal(oldest.host, s.host)
    const key = k % 2 === 0 ? 'approve' : 'deny'
    const r = await request(bridge, env.token, { method: 'POST', path: `/control/${key}`, json: { shown: oldest.id } }).answer
    assert.deepEqual([r.json.ok, r.json.request], [true, oldest.id])
    const a = await within(h.answer, 2000, `${s.host}: no answer within 2 s`)
    assert.deepEqual(a.json, key === 'approve' ? ALLOW : DENY)
    assert.equal(view().held.length, 29 - k)
    assert.ok(held.slice(k + 1).every((x) => !x.h.settled), `after ${k + 1} presses, the rest still held`)
  }
  // A prompt for one session, and another for a second, reach only their own polls.
  const prompt = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: S[17].host, text: 'Only you.' } }).answer
  const other = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: S[3].host, text: 'And you.' } }).answer
  assert.deepEqual((await within(polls[17].answer, 2000, 'S17\'s poll')).json, { cmds: [{ id: prompt.json.cmd, t: 'prompt', text: 'Only you.' }] })
  assert.deepEqual((await within(polls[3].answer, 2000, 'S3\'s poll')).json, { cmds: [{ id: other.json.cmd, t: 'prompt', text: 'And you.' }] })
  await sleep(100)
  assert.deepEqual(polls.map((p, i) => [i, p.settled]).filter(([i, settled]) => settled !== (i === 3 || i === 17)), [], 'every other poll still open')
  assert.deepEqual([view().cmds[prompt.json.cmd], view().cmds[other.json.cmd]], ['delivered', 'delivered'])
})

test('bridge: a reset with the mod\'s poll open cuts it off: the mod\'s fetch fails, it says hello 100 ms later, and takes the next command', async (t) => {
  // As a deck that restarts drops the connection; the mod played as bridge.ts plays it, no 409 needed.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const mod = modLoop(bridge, env.token, A)
  t.after(() => mod.stop())
  mod.start()
  const open = () => (bridge.deck.state().sessions[A.host]?.poll ?? null) !== null
  await mod.until(() => open(), 2000, 'its first poll held')
  await request(bridge, env.token, { method: 'POST', path: '/control/reset' }).answer
  await mod.until((tr) => tr.some((x) => x.what === 'hello' && x.status === 200 && tr.indexOf(x) > 0), 2000, 'a second hello')
  assert.deepEqual(mod.trace.map((x) => [x.what, x.status ?? null]).slice(0, 4), [['hello', 200], ['poll', null], ['quick-hello', null], ['hello', 200]])
  await mod.until(() => open(), 2000, 'its poll held after the hello')
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/prompt', json: { host: A.host, text: 'Hi.' } }).answer
  await mod.until(() => mod.cmds.some((c) => c.id === press.json.cmd), 2000, 'the command delivered')
  assert.equal(runLog(env).filter((e) => e.kind === 'poll-hello-first').length, 0)
})

test('bridge: modLoop plays by claude-code/plugin/hooks/bridge.ts\'s own timings', () => {
  // Read only: the mod's constants as the plugin exports them, so the helper can't drift from what it stands in for.
  const source = fs.readFileSync(path.join(TOOLS, '..', 'plugin', 'hooks', 'bridge.ts'), 'utf8')
  const constant = (name) => {
    const m = new RegExp(`^export const ${name}(?:: [^=]+)? = (.+)$`, 'm').exec(source)
    assert.ok(m, `bridge.ts exports ${name}`)
    return JSON.parse(m[1].replaceAll('_', ''))
  }
  const theirs = Object.fromEntries(['RETRY_MS', 'QUICK_WINDOW_MS', 'POLL_MIN_MS', 'BACKOFF_MS'].map((k) => [k, constant(k)]))
  assert.deepEqual(theirs, { ...MOD })
})

test('bridge: the mod as bridge.ts plays it: a poll held, then abandoned more than 2 s after a quick hello\'s answer, gets a quick hello of its own; one abandoned within the 2 s begins the outage', async (t) => {
  // PROTOCOL.md, "Failure and recovery", as amended for Phase 6 (item 6), and QUICK_WINDOW_MS in
  // claude-code/plugin/hooks/bridge.ts: the engine abandons a mod's fetches at every Esc or deck Deny while the bridge
  // is still there. Without the window, every Esc after a quick hello, the poll held since, would begin an outage.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'idle', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const mod = modLoop(bridge, env.token, A)
  t.after(() => mod.stop())
  mod.start()
  const held = () => bridge.deck.state().sessions[A.host]?.poll?.inst === A.inst
  const hellos = (tr) => tr.filter((x) => x.what === 'hello' && x.status === 200)
  const whats = (from) => mod.trace.slice(from).map((x) => x.what)
  /** How long after `answered`, a trace time, the mod's poll failed: the first poll after `from` with no status. */
  const failedAfter = (from, answered) => mod.trace.slice(from).find((x) => x.what === 'poll' && x.status === null).ms - answered
  await mod.until(held, 2000, 'its first poll held')
  // An Esc abandons the held poll: a quick hello 100 ms later, and its poll is held again.
  let from = mod.trace.length
  mod.abandon()
  await mod.until((tr) => hellos(tr).length === 2, 2000, 'the quick hello')
  await mod.until(held, 2000, 'its poll held after the quick hello')
  assert.deepEqual(whats(from).slice(0, 3), ['poll', 'quick-hello', 'hello'])
  // More than 2 s after that hello's answer, its poll held all the while, the window has closed: another Esc gets a
  // quick hello of its own, not an outage.
  let answered = hellos(mod.trace).at(-1).ms
  await sleep(MOD.QUICK_WINDOW_MS + 300)
  assert.equal(held(), true, 'still held')
  from = mod.trace.length
  mod.abandon()
  await mod.until((tr) => hellos(tr).length === 3, 2000, 'a second hello')
  await mod.until(held, 2000, 'its poll held after the second hello')
  const late = failedAfter(from, answered)
  assert.ok(late > MOD.QUICK_WINDOW_MS, `abandoned ${late} ms after the quick hello's answer`)
  assert.deepEqual(whats(from).slice(0, 3), ['poll', 'quick-hello', 'hello'], `a quick hello of its own: ${JSON.stringify(mod.trace)}`)
  // Within 2 s of that hello's answer, another Esc is the second failure: the outage begins.
  answered = hellos(mod.trace).at(-1).ms
  from = mod.trace.length
  mod.abandon()
  await mod.until((tr) => tr.slice(from).some((x) => x.what === 'outage'), 2000, 'the outage')
  const soon = failedAfter(from, answered)
  assert.ok(soon <= MOD.QUICK_WINDOW_MS, `abandoned ${soon} ms after the quick hello's answer`)
  assert.deepEqual(whats(from).slice(0, 2), ['poll', 'outage'], JSON.stringify(mod.trace))
  assert.deepEqual(mod.trace.filter((x) => x.what === 'outage').map((x) => [x.channel, x.wait]), [['poll', MOD.BACKOFF_MS[0]]], 'one outage, the abandoned poll\'s, its first wait')
  assert.deepEqual(mod.trace.filter((x) => x.what === 'quick-window-closed').length, 1, 'the first quick hello\'s window closed; the second\'s was still open')
})

test('bridge: a hook\'s request whose client goes away while the registry is read once more isn\'t taken: nothing held', async (t) => {
  // As the real deck: after the second reading, the request is taken only if its client is still there.
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const hook = (json) => request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, ...json } })
  // Each time, the session's id changes (a /clear) before the bridge has read it: the request waits for one more
  // reading, made slow here, which confirms it, and its client goes away meanwhile.
  const readdir = fsp.readdir
  fsp.readdir = async (...args) => {
    await sleep(200)
    return readdir(...args)
  }
  const sids = ['sid-a2', 'sid-a3']
  const taken = async () => (await request(bridge, env.token, { path: '/control/taken' }).answer).json.taken
  try {
    // A tool request and an ask.
    const requests = [{ tool_name: 'Write', tool_input: { file_path: '/s/a.txt', content: 'a' } }, { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } }]
    for (const [i, json] of requests.entries()) {
      writeRegistry(env, A.pid, { sessionId: sids[i], hostSessionId: A.host, status: 'busy', statusUpdatedAt: 2 + i })
      const before = await taken()
      const h = hook({ ...json, session_id: sids[i] })
      await sleep(50)
      h.abort()
      // /control/taken counts it once that reading is done, though it's neither held nor answered (README.md): what
      // fake-claude sends next can't land before the bridge is done with it.
      let after = before
      for (let n = 0; n < 100 && after === before; n++) {
        await sleep(10)
        after = await taken()
      }
      assert.equal(after, before + 1, `${json.tool_name} from ${sids[i]}: counted as taken`)
    }
  } finally {
    fsp.readdir = readdir
  }
  assert.deepEqual(bridge.deck.view().held, [], 'nothing held')
  const log = runLog(env)
  assert.deepEqual(log.filter((e) => e.kind === 'client-gone').map((e) => [e.route, e.host, e.sid]), [['permission', A.host, 'sid-a2'], ['permission', A.host, 'sid-a3']])
  assert.deepEqual(log.filter((e) => ['held', 'unconfirmed'].includes(e.kind)), [], 'none of them taken')
  // The session's next request, its client still there, is held as usual.
  const next = hook({ session_id: 'sid-a3', tool_name: 'Bash', tool_input: { command: 'ls' } })
  await sleep(100)
  assert.deepEqual([next.settled, bridge.deck.view().held.map((h) => h.tool)], [false, ['Bash']])
  next.abort()
})

test('bridge: closing answers held requests with {} and open polls with no commands', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startFakeBridge({ port: 0, tokenFile: env.tokenFile, runDir: env.runDir, registryDir: env.registryDir, recordsDir: env.recordsDir, registryMs: 0, quiet: true })
  const held = request(bridge, env.token, { method: 'POST', path: '/v1/permission', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: 'Write', tool_input: {} } })
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: A.sid, host: A.host, inst: 'ia', cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  const poll = request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=ia&wait=20` })
  await sleep(100)
  assert.deepEqual([held.settled, poll.settled, bridge.deck.view().held.length], [false, false, 1], 'both held')
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
