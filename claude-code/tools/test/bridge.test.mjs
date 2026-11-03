// The fake bridge over HTTP, on a free port with temp folders: transport rules, routes, long polls, the
// folders, the log, and shutdown.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'

import { parseWait, readToken, scrubber, startFakeBridge } from '../lib/bridge.mjs'
import { hostHeader, send, within } from '../lib/client.mjs'
import { ALLOW, MAX_BODY, MODE_TOOL, PRE_ALLOW, fingerprint, summary } from '../lib/protocol.mjs'
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
    for (const p of ['/v1/permission', '/v1/pretool']) {
      const headers = header === undefined ? {} : { 'x-deck-host': header }
      const r = await within(request(bridge, env.token, { method: 'POST', path: p, headers, json: { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' } } }).answer, 1000, `${p}: no answer within 1 s`)
      assert.deepEqual([p, r.status, r.json], [p, 200, {}])
    }
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

  // Its sid changes (a /clear), and the file says so before the bridge has read it: a hello, and then a mode check,
  // each read it once more, rather than being refused on the reading before.
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, ...mod, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/mode', json: { host: A.host, mode: 'default' } }).answer
  await request(bridge, env.token, { path: `/v1/next?sid=${A.sid}&host=${A.host}&inst=${A.inst}&wait=0` }).answer
  assert.equal(bridge.deck.view().cmds[press.json.cmd], 'delivered')
  writeRegistry(env, A.pid, { sessionId: 'sid-a2', hostSessionId: A.host, status: 'busy', statusUpdatedAt: 2 })
  let r = await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: 'sid-a2', host: A.host, inst: A.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  assert.deepEqual([r.status, r.json], [200, { v: 1, ok: true }])
  writeRegistry(env, A.pid, { sessionId: 'sid-a3', hostSessionId: A.host, status: 'busy', statusUpdatedAt: 3 })
  r = await request(bridge, env.token, { method: 'POST', path: '/v1/pretool', headers: { 'x-deck-host': A.host }, json: { session_id: 'sid-a3', tool_name: MODE_TOOL, tool_input: { session_id: 'self', mode: 'default' } } }).answer
  assert.deepEqual([r.status, r.json], [200, PRE_ALLOW])
  held.abort()
})

test('bridge: a hook\'s request whose X-Deck-Host and session_id the registry lists apart, each with another session, gets {} at once after the second reading, and nothing is held', async (t) => {
  // PROTOCOL.md, "Desktop sessions only": confirmed by the pair, the request's X-Deck-Host listed with its session_id.
  const env = tempEnv(t)
  const B = { sid: 'sid-b', host: 'local_b', inst: 'ib', pid: 12 }
  for (const S of [A, B]) writeRegistry(env, S.pid, { sessionId: S.sid, hostSessionId: S.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  // B has a mode command in flight for default, so a request taken as B's would be allowed at once.
  await request(bridge, env.token, { method: 'POST', path: '/v1/hello', json: { v: 1, sid: B.sid, host: B.host, inst: B.inst, cwd: '/s', model: 'm', plugin: '0.1.0', cc: '2.1.309' } }).answer
  const press = await request(bridge, env.token, { method: 'POST', path: '/control/mode', json: { host: B.host, mode: 'default' } }).answer
  await request(bridge, env.token, { path: `/v1/next?sid=${B.sid}&host=${B.host}&inst=${B.inst}&wait=0` }).answer
  assert.equal(bridge.deck.view().cmds[press.json.cmd], 'delivered')
  const hook = (p, host, sid) => within(
    request(bridge, env.token, { method: 'POST', path: p, headers: { 'x-deck-host': host }, json: { session_id: sid, tool_name: MODE_TOOL, tool_input: { session_id: 'self', mode: 'default' } } }).answer,
    1000, `${p} from ${host} with ${sid}: no answer within 1 s`,
  )
  // B's host with A's session id, and a host the registry doesn't list, as a pre-warmed spare's, with A's.
  const asked = []
  for (const host of [B.host, 'local_spare']) {
    for (const p of ['/v1/permission', '/v1/pretool']) {
      const r = await hook(p, host, A.sid)
      assert.deepEqual([p, host, r.status, r.json], [p, host, 200, {}])
      asked.push([p.slice('/v1/'.length), host, A.sid])
    }
  }
  assert.deepEqual(bridge.deck.view().held, [])
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'unconfirmed').map((e) => [e.route, e.host, e.sid]), asked)
  // B's own check and raise are allowed: neither allowance went to a request from another session.
  assert.deepEqual((await hook('/v1/pretool', B.host, B.sid)).json, PRE_ALLOW)
  assert.deepEqual((await hook('/v1/permission', B.host, B.sid)).json, ALLOW)
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

test('bridge: POST /v1/pretool is answered at once, never held, and takes POST only', async (t) => {
  const env = tempEnv(t)
  writeRegistry(env, A.pid, { sessionId: A.sid, hostSessionId: A.host, status: 'busy', statusUpdatedAt: 1 })
  const bridge = await startBridge(t, env)
  const check = (input) => request(bridge, env.token, { method: 'POST', path: '/v1/pretool', headers: { 'x-deck-host': A.host }, json: { session_id: A.sid, tool_name: MODE_TOOL, tool_input: input } }).answer
  const r = await within(check({ session_id: 'self', mode: 'plan' }), 1000, 'no answer within 1 s')
  assert.deepEqual([r.status, r.json], [200, {}], 'no command in flight: no decision, at once')
  assert.deepEqual(bridge.deck.view().held, [])
  const get = await request(bridge, env.token, { path: '/v1/pretool' }).answer
  assert.deepEqual([get.status, get.headers.allow, typeof get.json.error], [405, 'POST', 'string'])
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
  assert.deepEqual(s.hello, { at: s.hello.at, inst: A.inst, cwd: null, model: null, mode: null, effort: null, plugin: null, cc: null })
  assert.deepEqual(s.tools.map((x) => [x.use, x.agent]), [['u1', null]], 'an agent that isn\'t a string counts as missing')
  assert.deepEqual(state.json.deck.doing[A.host], 'a.md')
  assert.deepEqual(Object.keys(s.lastSeq).sort(), [A.inst, 'null'])
  assert.deepEqual(state.json.commands.map((c) => [c.state, c.error, c.detail]), [['failed', null, null]])
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
  // Only a hello makes an inst current: without one, every poll is answered at once.
  let r = await next(1).answer
  assert.deepEqual([r.status, r.json, r.ms < 500], [200, { cmds: [] }, true], 'no hello yet: at once')
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
  // A mode command: delivered to the open poll, its check and its raise allowed; a check from a `claude` started
  // inside the session; a result from an inst that never said hello.
  const press = await call({ method: 'POST', path: '/control/mode', json: { host: A.host, mode: 'plan' } })
  await answered(n2, 'n2')
  const input = { session_id: 'self', mode: 'plan' }
  await answered(hook('/v1/pretool', { tool_name: MODE_TOOL, tool_input: input }), 'the mode check')
  await answered(hook('/v1/permission', { tool_name: MODE_TOOL, tool_input: input }), "the raise's PermissionRequest")
  await call({ method: 'POST', path: '/v1/pretool', headers: { 'x-deck-host': A.host }, json: { session_id: 'sid-child', tool_name: MODE_TOOL, tool_input: input } })
  await call({ method: 'POST', path: '/v1/result', json: { ...mod('istray'), id: press.json.cmd, state: 'done', detail: '' } })
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
  // A reset with a poll open cuts it off.
  const n4 = next('ia2')
  await sleep(30)
  await call({ method: 'POST', path: '/control/reset' })
  assert.equal(await within(n4.answer.then(() => 'answered', () => 'cut off'), 3000, 'n4: neither answered nor cut off within 3 s'), 'cut off')
  bridge.deck.state = () => {
    throw new TypeError('the state broke')
  }
  const broken = await call({ path: '/control/state' })
  assert.equal(broken.status, 500)
  await bridge.close()

  const log = runLog(env)
  const kinds = ['fp-check', 'held', 'release', 'answered', 'command', 'result-ignored', 'mode-check', 'mode-allowed', 'unconfirmed', 'poll-turn-end', 'poll-at-once', 'poll-superseded', 'poll-stale', 'poll-cut', 'hello', 'mod-restart', 'request', 'registry', 'route-error', 'control-error', 'client-error']
  assert.deepEqual(kinds.filter((k) => !log.some((e) => e.kind === k)), [], 'every kind the jq lines select')
  assert.ok(log.some((e) => e.unlogged), 'and a line that says why its body is missing')
  // The fields the jq lines pick out.
  assert.ok(log.some((e) => e.kind === 'fp-check' && e.match === true && e.bridgeFp === e.modFp && e.bridgeSummary === 'a.txt'))
  assert.ok(log.some((e) => e.kind === 'release' && e.rule === 1 && typeof e.why === 'string'))
  assert.ok(log.some((e) => e.kind === 'answered' && e.decision === 'allow' && e.by === 'press'))
  assert.ok(log.some((e) => e.kind === 'mode-check' && e.allowed === true && e.cmd === press.json.cmd && e.mode === 'plan'))
  assert.ok(log.some((e) => e.kind === 'unconfirmed' && e.route === 'pretool' && e.sid === 'sid-child' && e.host === A.host))
  assert.ok(log.some((e) => e.kind === 'poll-at-once' && Array.isArray(e.cmds) && Number.isFinite(e.sinceTurnEndMs)))
  assert.ok(log.some((e) => e.kind === 'request' && e.path === '/v1/next' && typeof e.query === 'string' && Number.isInteger(e.n) && e.method === 'GET' && e.auth === 'ok'))
  assert.ok(log.some((e) => e.kind === 'registry' && e.change === 'changed' && e.to.status === 'idle' && e.host === A.host))

  const said = lines.join('\n')
  const want = [
    [/ hello local_a inst ia \(plugin 0\.2\.0, cc 2\.1\.309, m\)/, 'hello'],
    [/ p1 HELD tool local_a Write: a\.txt fp [0-9a-f]{8}/, 'a held request'],
    [/ p2 released with \{\}: tool\.end with the same fp \(rule 1\)/, 'a release'],
    [/ press approve: allow p1/, 'a press'],
    [new RegExp(` ${press.json.cmd} queued for local_a: mode plan`), 'a command'],
    [new RegExp(` ${press.json.cmd} delivered to local_a \\(inst ia\\)`), 'its delivery'],
    [/ registry ~ local_a busy → idle/, 'a registry change'],
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
  assert.deepEqual(Object.keys(r.json).toSorted(), ['commands', 'deck', 'dirs', 'lastPress', 'recent', 'records', 'registry', 'runDir', 'sessions', 'taken', 'url', 'v'])
  assert.deepEqual(Object.keys(r.json.deck).toSorted(), ['alert', 'cmds', 'context', 'doing', 'held', 'jumped', 'sessions', 'settings', 'status', 'target'])
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
  assert.equal(scrub(`${token}${token.slice(0, 9)}`), '<token><token>')
  const quoted = 'ab"cd\\ef0123'
  assert.equal(scrubber(quoted)(JSON.stringify({ k: `x${quoted}y` })), '{"k":"x<token>y"}')
  assert.equal(scrubber('short')('a short b'), 'a <token> b', 'a token under 8 characters goes whole')
  assert.equal(scrubber('')('as it is'), 'as it is')
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
