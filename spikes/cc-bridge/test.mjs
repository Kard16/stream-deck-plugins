// Tests for the spike bridge (bridge.mjs, ctl.mjs) and the deck-spike plugin's
// scripts (spikes/cc-plugin/bin). Run: mise exec -- node --test spikes/cc-bridge/test.mjs
//
// Every bridge here listens on an ephemeral port and a temp socket, with a
// test token and temp results and registry folders: nothing touches
// 127.0.0.1:47600, run/bridge.sock, run/token or ~/.claude.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, REGISTRY_FIELDS, startBridge } from './bridge.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'cc-plugin')
const HOOK_SH = path.join(PLUGIN, 'bin', 'hook.sh')
const PERMISSION_SH = path.join(PLUGIN, 'bin', 'permission.sh')
const TOKEN = 'test-token-5f0c2e9a7b31d4c8'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-'))

async function bridge(t, opts = {}) {
  const dir = tmp()
  const tokenFile = path.join(dir, 'token')
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const o = {
    port: 0, socketPath: path.join(dir, 'b.sock'), tokenFile, resultsDir: path.join(dir, 'results'),
    sessionsDir: path.join(dir, 'sessions'), registry: false, quiet: true, ...opts,
  }
  assert.notEqual(o.port, DEFAULTS.port, 'tests never bind the real port')
  assert.notEqual(o.socketPath, DEFAULTS.socketPath, 'tests never bind the real socket')
  assert.notEqual(o.tokenFile, DEFAULTS.tokenFile, 'tests never read the real token')
  const b = await startBridge(o)
  t.after(() => b.close())
  return { ...b, dir, tokenFile }
}

const parse = text => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One HTTP request. `open` returns the live request too, to destroy it. */
function open({ port, socketPath, method = 'GET', path: route, body, headers = {} }) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  let req
  const done = new Promise((resolve, reject) => {
    req = http.request({
      host: '127.0.0.1', port, socketPath, method, path: route, agent: false,
      headers: { ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text, json: parse(text) }))
    })
    req.on('error', reject)
    if (data !== undefined) req.write(data)
    req.end()
  })
  return { req, done }
}

const call = opts => open(opts).done
const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` })

function lines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    return []
  }
}
const events = b => lines(path.join(b.runDir, 'events.jsonl'))
const registryLog = b => lines(path.join(b.runDir, 'registry.jsonl'))

async function waitFor(fn, what = 'condition', ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(15)
  }
}

const state = b => call({ port: b.port, path: '/control/state' }).then(r => r.json)
const setPolicy = (b, patch) => call({ port: b.port, method: 'POST', path: '/control/policy', body: patch })
const answer = (b, body) => call({ port: b.port, method: 'POST', path: '/control/answer', body })
const queue = (b, sid, cmd) => call({ port: b.port, method: 'POST', path: '/control/queue', body: { sid, cmd } })
const next = (b, sid, socketPath) => call({ port: socketPath ? undefined : b.port, socketPath, path: `/mod/next?sid=${encodeURIComponent(sid)}` })

const PERMISSION_INPUT = {
  session_id: 's-1', transcript_path: '/t.jsonl', cwd: '/sandbox', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'clean' },
}

describe('bridge', () => {
  test('a hook event is logged with auth, body and timing, and answered 204', async t => {
    const b = await bridge(t)
    const body = { session_id: 's-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/sandbox', ppid: 4242, env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_1' } }
    const r = await call({ port: b.port, method: 'POST', path: '/hook/PreToolUse', body, headers: auth() })
    assert.equal(r.status, 204)
    assert.equal(r.text, '')
    const [req, res] = events(b)
    assert.equal(req.kind, 'request')
    assert.equal(req.conn, 'tcp')
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/hook/PreToolUse')
    assert.equal(req.auth, 'match')
    assert.equal(req.event, 'PreToolUse')
    assert.deepEqual(req.body, body)
    assert.equal(typeof req.t, 'number')
    assert.equal(typeof req.mono, 'number')
    assert.equal(res.kind, 'response')
    assert.equal(res.status, 204)
    const s = (await state(b)).sessions['s-1']
    assert.equal(s.hostSessionId, 'local_1')
    assert.equal(s.cwd, '/sandbox')
    assert.equal(s.ppid, 4242)
    assert.equal(s.lastEvent.name, 'PreToolUse')
    assert.equal(typeof s.firstSeen, 'number')
  })

  test('auth reads match, mismatch or absent, notes a literal $DECK_TOKEN, and never logs the token', async t => {
    const b = await bridge(t)
    const post = headers => call({ port: b.port, method: 'POST', path: '/hook/Stop', body: { session_id: 's' }, headers })
    await post({})
    await post(auth('wrong'))
    await post({ authorization: 'Bearer $DECK_TOKEN' })
    await post({ authorization: 'Bearer ' })
    await post(auth())
    // A body carrying the token is logged with it taken out.
    await call({ port: b.port, method: 'POST', path: '/hook/PostToolUse', body: { session_id: 's', tool_response: `env: DECK_TOKEN=${TOKEN}` }, headers: auth() })
    await call({ port: b.port, method: 'POST', path: '/hook/Odd', body: 'not json', headers: auth() })
    const reqs = events(b).filter(e => e.kind === 'request')
    assert.deepEqual(reqs.map(e => e.auth), ['absent', 'mismatch', 'mismatch', 'mismatch', 'match', 'match', 'match'])
    assert.equal(reqs[2].authLiteral, true)
    assert.equal(reqs[2].authDetail, 'literal $DECK_TOKEN')
    assert.equal(reqs[3].authDetail, 'empty bearer')
    assert.equal(reqs[5].body.tool_response, 'env: DECK_TOKEN=<token>')
    assert.equal(reqs[5].redacted, true)
    assert.equal(reqs[6].body, 'not json')
    assert.ok(!fs.readFileSync(path.join(b.runDir, 'events.jsonl'), 'utf8').includes(TOKEN))
  })

  test('a held request is answered from /control/answer, by id or oldest', async t => {
    const b = await bridge(t)
    const p1 = call({ port: b.port, method: 'POST', path: '/permission', body: PERMISSION_INPUT, headers: auth() })
    const held = await waitFor(async () => (await state(b)).held[0], 'p1 held')
    assert.equal(held.id, 'p1')
    assert.equal(held.via, 'http')
    assert.equal(held.sessionId, 's-1')
    assert.equal(held.tool, 'Bash')
    assert.equal(held.input, 'rm -rf build')
    assert.equal(typeof held.ageMs, 'number')

    const updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    const a = await answer(b, { id: 'p1', decision: 'allow', updatedPermissions })
    assert.equal(a.json.ok, true)
    assert.equal(a.json.wasOpen, true)
    const r1 = await p1
    assert.equal(r1.status, 200)
    assert.deepEqual(r1.json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions } } })
    const again = await answer(b, { id: 'p1', decision: 'deny' })
    assert.equal(again.json.wasOpen, false)
    assert.equal(again.json.end, 'answered')

    const p2 = call({ port: b.port, method: 'POST', path: '/permission', body: PERMISSION_INPUT })
    await waitFor(async () => (await state(b)).held.length === 1, 'p2 held')
    await answer(b, { id: 'oldest', decision: 'deny', message: 'not from the deck', interrupt: true })
    assert.deepEqual((await p2).json.hookSpecificOutput.decision, { behavior: 'deny', message: 'not from the deck', interrupt: true })

    const p3 = call({ port: b.port, method: 'POST', path: '/permission', body: PERMISSION_INPUT })
    await waitFor(async () => (await state(b)).held.length === 1, 'p3 held')
    await answer(b, { id: 'p3', decision: 'none' })
    assert.deepEqual((await p3).json, {})

    assert.equal((await answer(b, { id: 'p99', decision: 'allow' })).status, 404)
    assert.equal((await answer(b, { id: 'oldest', decision: 'allow' })).status, 404)
    assert.equal((await answer(b, { id: 'p1', decision: 'maybe' })).status, 400)

    const done = events(b).filter(e => e.kind === 'response' && e.path === '/permission')
    assert.deepEqual(done.map(e => [e.id, e.end, e.by, e.decision]), [
      ['p1', 'answered', 'control', 'allow'], ['p2', 'answered', 'control', 'deny'], ['p3', 'answered', 'control', 'none'],
    ])
    assert.ok(done.every(e => typeof e.heldMs === 'number' && e.heldMs >= 0))
    assert.deepEqual((await state(b)).recent.map(r => r.id), ['p1', 'p2', 'p3'])
  })

  test('a client closing a held request is detected and logged with its timing', async t => {
    const b = await bridge(t)
    const { req, done } = open({ port: b.port, method: 'POST', path: '/permission', body: PERMISSION_INPUT })
    done.catch(() => {})
    await waitFor(async () => (await state(b)).held.length === 1, 'p1 held')
    await sleep(120)
    req.destroy()
    const closed = await waitFor(() => events(b).find(e => e.kind === 'close' && e.id === 'p1'), 'close line')
    assert.equal(closed.end, 'client-closed')
    assert.ok(closed.heldMs >= 100, `heldMs ${closed.heldMs}`)
    const s = await state(b)
    assert.equal(s.held.length, 0)
    assert.equal(s.recent[0].end, 'client-closed')
    const late = await answer(b, { id: 'p1', decision: 'allow' })
    assert.equal(late.json.wasOpen, false)
    assert.equal(late.json.end, 'client-closed')
  })

  test('a held request times out at the cap with {}', async t => {
    const b = await bridge(t, { holdCapMs: 300 })
    const started = Date.now()
    const r = await call({ port: b.port, method: 'POST', path: '/permission', body: PERMISSION_INPUT })
    assert.ok(Date.now() - started >= 250)
    assert.deepEqual(r.json, {})
    const res = events(b).find(e => e.kind === 'response' && e.id === 'p1')
    assert.equal(res.end, 'timeout')
    assert.equal(res.by, 'cap')
  })

  test('the policy picks the endpoint that holds, and answers allow, deny or none by itself', async t => {
    const b = await bridge(t)
    const post = (route, body = PERMISSION_INPUT) => call({ port: b.port, method: 'POST', path: route, body })

    // Default: http holds, cmd gets {} at once.
    assert.deepEqual((await post('/permission-cmd')).json, {})

    // via=cmd: the http hook gets {} at once, the command hook is held.
    assert.equal((await setPolicy(b, { permission: { via: 'cmd' } })).json.policy.permission.via, 'cmd')
    assert.deepEqual((await post('/permission')).json, {})
    const held = post('/permission-cmd')
    const h = await waitFor(async () => (await state(b)).held[0], 'cmd held')
    assert.equal(h.via, 'cmd')
    await answer(b, { id: h.id, decision: 'allow' })
    assert.equal((await held).json.hookSpecificOutput.decision.behavior, 'allow')

    // none: no decision from either.
    await setPolicy(b, { permission: { action: 'none' } })
    assert.deepEqual((await post('/permission-cmd')).json, {})

    // allow after a delay, with only the fields allow takes.
    await setPolicy(b, { permission: { via: 'http', action: 'allow', delayMs: 200, message: 'left over', updatedInput: { command: 'ls' } } })
    const started = Date.now()
    const allowed = await post('/permission')
    assert.ok(Date.now() - started >= 180)
    assert.deepEqual(allowed.json.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { command: 'ls' } })

    // deny with message and interrupt; interrupt false is left out.
    await setPolicy(b, { permission: { action: 'deny', delayMs: 0, interrupt: true, message: 'no' } })
    assert.deepEqual((await post('/permission')).json.hookSpecificOutput.decision, { behavior: 'deny', message: 'no', interrupt: true })
    await setPolicy(b, { permission: { interrupt: false, message: null } })
    assert.deepEqual((await post('/permission')).json.hookSpecificOutput.decision, { behavior: 'deny' })

    // A typo is refused and changes nothing.
    const before = (await state(b)).policy
    for (const bad of [{ permission: { action: 'maybe' } }, { toolcheck: 'ask' }, { permission: { delayMs: -1 } }, { classicPermission: 'ask' }, []]) {
      const r = await setPolicy(b, bad)
      assert.equal(r.status, 400, JSON.stringify(bad))
      assert.equal(r.json.ok, false)
    }
    assert.deepEqual((await state(b)).policy, before)

    // The mod's policy rides on /mod/next.
    await setPolicy(b, { toolCheck: 'ask', classicPermission: 'deny' })
    const polled = (await next(b, 's-1')).json.policy
    assert.equal(polled.toolCheck, 'ask')
    assert.equal(polled.classicPermission, 'deny')
  })

  test('mod commands queue per session; * goes once to the first poller; probe never takes *', async t => {
    const b = await bridge(t)
    assert.equal((await queue(b, 'A', { t: 'status', text: 'a' })).json.id, 'c1')
    assert.equal((await queue(b, '*', { t: 'toast', text: 'all' })).json.id, 'c2')
    assert.equal((await queue(b, 'A', { id: 'mine', t: 'model' })).json.id, 'mine')
    assert.deepEqual(Object.keys((await state(b)).queued).sort(), ['*', 'A'])

    const forB = (await next(b, 'B')).json
    assert.deepEqual(forB.cmds, [{ t: 'toast', text: 'all', id: 'c2' }])
    assert.equal(forB.policy.permission.action, 'hold')
    assert.deepEqual((await next(b, 'A')).json.cmds.map(c => c.id), ['c1', 'mine'])
    assert.deepEqual((await next(b, 'A')).json.cmds, [])

    await queue(b, '*', { t: 'usage' })
    assert.deepEqual((await next(b, 'probe')).json.cmds, [])
    assert.deepEqual((await next(b, 'A')).json.cmds.map(c => c.t), ['usage'])
    assert.equal((await call({ port: b.port, path: '/mod/next' })).status, 400)
    assert.equal((await queue(b, 'A', 'not a command')).status, 400)

    for (const [route, body] of [
      ['/mod/hello', { sid: 'A', instance: 'i1', env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_A' }, session: { cwd: '/sandbox' } }],
      ['/mod/event', { sid: 'A', event: 'turn.start', turnId: 't1' }],
      ['/mod/result', { sid: 'A', id: 'c1', t: 'status', ok: true, ms: 3 }],
    ]) {
      const r = await call({ port: b.port, method: 'POST', path: route, body, headers: auth() })
      assert.equal(r.status, 200)
      assert.deepEqual(r.json, {})
    }
    const a = (await state(b)).sessions.A
    assert.equal(a.hostSessionId, 'local_A')
    assert.equal(a.cwd, '/sandbox')
    assert.equal(a.lastEvent.name, 'mod:result c1')
    assert.equal(typeof a.lastPoll, 'number')
    assert.equal((await state(b)).sessions.probe, undefined)
    const polls = events(b).filter(e => e.kind === 'response' && e.path === '/mod/next' && e.cmds > 0)
    assert.ok(polls.every(e => Array.isArray(e.body.cmds)))
  })

  test('the Unix socket serves the plugin endpoints, not control, and is 0600', async t => {
    const b = await bridge(t)
    assert.equal(fs.statSync(b.socketPath).mode & 0o777, 0o600)
    await queue(b, 'U', { t: 'model' })
    const r = await next(b, 'U', b.socketPath)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.cmds.map(c => c.t), ['model'])
    const hook = await call({ socketPath: b.socketPath, method: 'POST', path: '/hook/Stop', body: { session_id: 'U' } })
    assert.equal(hook.status, 204)
    const ctl = await call({ socketPath: b.socketPath, path: '/control/state' })
    assert.equal(ctl.status, 403)
    const unix = events(b).filter(e => e.kind === 'request' && e.conn === 'unix')
    assert.deepEqual(unix.map(e => e.path), ['/mod/next', '/hook/Stop', '/control/state'])
    await b.close()
    assert.equal(fs.existsSync(b.socketPath), false)
  })

  test('a stale socket file is replaced; a live one or a non-socket is refused', async t => {
    const dir = tmp()
    const sock = path.join(dir, 's.sock')
    const first = await bridge(t, { socketPath: sock })
    await assert.rejects(bridge(t, { socketPath: sock }), /another bridge is listening/)
    await first.close()
    // A socket file left behind by a process that was killed.
    const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up'))", sock], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(r => child.stdout.once('data', r))
    child.kill('SIGKILL')
    await new Promise(r => child.once('exit', r))
    assert.ok(fs.lstatSync(sock).isSocket(), 'the killed process left its socket')
    const second = await bridge(t, { socketPath: sock })
    assert.ok(fs.existsSync(second.socketPath))
    await second.close()
    const plain = path.join(dir, 'plain.sock')
    fs.writeFileSync(plain, 'not a socket')
    await assert.rejects(bridge(t, { socketPath: plain }), /not a socket/)
    assert.equal(fs.readFileSync(plain, 'utf8'), 'not a socket')
  })

  test('the registry watcher logs adds, changes and removes, skips .key files and survives half-written JSON', async t => {
    const sessionsDir = path.join(tmp(), 'sessions')
    fs.mkdirSync(sessionsDir)
    const write = (name, value) => fs.writeFileSync(path.join(sessionsDir, name), typeof value === 'string' ? value : JSON.stringify(value))
    const base = {
      pid: 111, sessionId: 's-111', hostSessionId: 'local_111', cwd: '/a', name: 'one', nameSource: 'auto',
      status: 'idle', statusUpdatedAt: 1, updatedAt: 1, kind: 'interactive', entrypoint: 'claude-desktop', version: '2.1.309',
      messagingSocketPath: '/tmp/cc-socks/111.sock', secretThing: 'do not log this',
    }
    write('100.json', { ...base, pid: 100, sessionId: 's-100' })
    write('100.key', 'a key file')
    const reads = []
    const readFile = (p, enc) => {
      reads.push(p)
      return fsp.readFile(p, enc)
    }
    const b = await bridge(t, { registry: true, registryMs: 20, sessionsDir, readFile })
    const find = pred => waitFor(() => registryLog(b).find(pred), 'a registry line')

    const initial = await find(e => e.kind === 'added' && e.file === '100.json')
    assert.equal(initial.initial, true)

    write('111.json', base)
    write('111.key', JSON.stringify({ sessionId: 'from-a-key-file' }))
    const added = await find(e => e.kind === 'added' && e.file === '111.json')
    assert.equal(added.initial, undefined)
    assert.deepEqual(Object.keys(added.fields).sort(), [...REGISTRY_FIELDS].sort())
    assert.deepEqual(added.otherKeys, ['messagingSocketPath', 'secretThing'])

    write('111.json', { ...base, status: 'busy', statusUpdatedAt: 2 })
    const changed = await find(e => e.kind === 'changed' && e.file === '111.json')
    assert.deepEqual(changed.changed, { status: { from: 'idle', to: 'busy' }, statusUpdatedAt: { from: 1, to: 2 } })

    write('111.json', { ...base, status: 'busy', statusUpdatedAt: 2, brandNew: 1 })
    const keys = await find(e => e.kind === 'changed' && e.otherKeysAdded)
    assert.deepEqual(keys.otherKeysAdded, ['brandNew'])

    write('222.json', '{"pid": 222, "sessionId": "s-2')
    await find(e => e.kind === 'unreadable' && e.file === '222.json')
    await sleep(80)
    assert.equal(registryLog(b).some(e => e.kind === 'added' && e.file === '222.json'), false)
    write('222.json', { ...base, pid: 222, sessionId: 's-222' })
    await find(e => e.kind === 'added' && e.file === '222.json')

    fs.unlinkSync(path.join(sessionsDir, '111.json'))
    const removed = await find(e => e.kind === 'removed' && e.file === '111.json')
    assert.equal(removed.last.sessionId, 's-111')

    const s = await state(b)
    assert.deepEqual(s.registry.map(r => r.file).sort(), ['100.json', '222.json'])
    assert.ok(reads.length > 0)
    assert.ok(reads.every(p => p.endsWith('.json')), `read: ${reads.filter(p => !p.endsWith('.json'))}`)
    const text = fs.readFileSync(path.join(b.runDir, 'registry.jsonl'), 'utf8')
    assert.ok(!text.includes('do not log this'))
    assert.ok(!text.includes('from-a-key-file'))
    assert.ok(!text.includes('.key'))
  })

  test('ctl.mjs drives the control endpoints', async t => {
    const b = await bridge(t)
    const ctl = (...args) => run(process.execPath, [path.join(HERE, 'ctl.mjs'), ...args], {
      env: { ...process.env, PORT: String(b.port), BRIDGE_TOKEN_FILE: b.tokenFile },
    })
    const s = await ctl('state')
    assert.equal(s.code, 0)
    assert.equal(JSON.parse(s.stdout).policy.permission.via, 'http')
    assert.equal((await ctl('policy', '{"toolCheck":"ask"}')).code, 0)
    assert.equal((await state(b)).policy.toolCheck, 'ask')
    const q = await ctl('queue', '*', '{"t":"model"}')
    assert.equal(JSON.parse(q.stdout).id, 'c1')
    const held = call({ port: b.port, method: 'POST', path: '/permission', body: PERMISSION_INPUT })
    await waitFor(async () => (await state(b)).held.length === 1, 'held')
    const a = await ctl('answer', 'p1', 'deny', '{"message":"from ctl"}')
    assert.equal(a.code, 0)
    assert.equal((await held).json.hookSpecificOutput.decision.message, 'from ctl')
    assert.equal((await ctl('answer', 'p9', 'allow')).code, 1)
    assert.equal((await ctl('policy', 'not json')).code, 2)
    // ctl's requests carry fetch's user agent; the test's own helper sends none.
    // Five: `policy 'not json'` stops at its usage line, before any request.
    const fromCtl = events(b).filter(e => e.kind === 'request' && e.path.startsWith('/control/') && e.ua)
    assert.equal(fromCtl.length, 5)
    assert.ok(fromCtl.every(e => e.auth === 'match'), JSON.stringify(fromCtl.map(e => [e.ua, e.auth])))
    assert.ok(!s.stdout.includes(TOKEN))
  })
})

/** Runs a program; resolves its exit code (or signal), stdout, stderr and duration. */
function run(cmd, args, { env = process.env, stdin, signalAfter } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started, pid: child.pid }))
    if (signalAfter) signalAfter(child)
    child.stdin.end(stdin ?? '')
  })
}

async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}

describe('plugin scripts', () => {
  const scriptEnv = (b, extra = {}) => {
    const env = { ...process.env, DECK_SPIKE_URL: `http://127.0.0.1:${b.port}`, DECK_SPIKE_TOKEN_FILE: b.tokenFile, ...extra }
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'DECK_TOKEN']) {
      if (!(k in extra)) delete env[k]
    }
    return env
  }

  test('hook.sh adds event, t_ms, ppid and env, posts with the token, prints nothing, exits 0', async t => {
    const b = await bridge(t)
    const input = {
      session_id: 's-1', transcript_path: '/t.jsonl', cwd: '/sandbox', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'echo "hi" \\ there\n' },
    }
    const r = await run(HOOK_SH, ['PreToolUse'], {
      stdin: JSON.stringify(input),
      env: scriptEnv(b, {
        CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_CODE_HOST_SESSION_ID: 'local_9', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
        CLAUDE_PROJECT_DIR: '/odd "dir"\\with\ttab', CLAUDE_PLUGIN_ROOT: PLUGIN, DECK_TOKEN: 'set-but-never-sent',
      }),
    })
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    const req = events(b).find(e => e.kind === 'request')
    assert.equal(req.path, '/hook/PreToolUse')
    assert.equal(req.auth, 'match')
    const body = req.body
    assert.equal(body.event, 'PreToolUse')
    assert.ok(Math.abs(body.t_ms - Date.now()) < 10_000, `t_ms ${body.t_ms}`)
    assert.equal(body.ppid, process.pid, 'ppid is whoever ran the script: here the test')
    assert.deepEqual(body.env, {
      CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_CODE_HOST_SESSION_ID: 'local_9', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_PROJECT_DIR: '/odd "dir"\\with\ttab', CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: null, DECK_TOKEN_present: true,
    })
    for (const [k, v] of Object.entries(input)) assert.deepEqual(body[k], v, k)
    assert.ok(!JSON.stringify(req).includes('set-but-never-sent'))
  })

  test('hook.sh copes with an empty object, non-JSON stdin and no token', async t => {
    const b = await bridge(t)
    await run(HOOK_SH, ['SessionEnd'], { stdin: '  {  }\n', env: scriptEnv(b) })
    await run(HOOK_SH, ['Setup'], { stdin: 'not json', env: scriptEnv(b, { DECK_SPIKE_TOKEN_FILE: '/nonexistent/token' }) })
    const reqs = events(b).filter(e => e.kind === 'request')
    assert.equal(reqs[0].body.event, 'SessionEnd')
    assert.equal(reqs[0].body.env.DECK_TOKEN_present, false)
    assert.equal(reqs[0].auth, 'match')
    assert.equal(reqs[1].body.stdin, 'not json')
    assert.equal(reqs[1].auth, 'absent')
  })

  test('hook.sh finds run/token from its real path when run through a link to the plugin', async t => {
    const b = await bridge(t)
    // tmp/spikes/cc-plugin/bin/hook.sh and tmp/spikes/cc-bridge/run/token, reached
    // through tmp/claude-code/sandbox-plugin -> ../spikes/cc-plugin.
    const root = tmp()
    fs.mkdirSync(path.join(root, 'spikes', 'cc-plugin', 'bin'), { recursive: true })
    fs.mkdirSync(path.join(root, 'spikes', 'cc-bridge', 'run'), { recursive: true })
    fs.mkdirSync(path.join(root, 'claude-code'))
    fs.copyFileSync(HOOK_SH, path.join(root, 'spikes', 'cc-plugin', 'bin', 'hook.sh'))
    fs.chmodSync(path.join(root, 'spikes', 'cc-plugin', 'bin', 'hook.sh'), 0o755)
    fs.copyFileSync(b.tokenFile, path.join(root, 'spikes', 'cc-bridge', 'run', 'token'))
    fs.symlinkSync('../spikes/cc-plugin', path.join(root, 'claude-code', 'sandbox-plugin'))
    const env = scriptEnv(b)
    delete env.DECK_SPIKE_TOKEN_FILE
    const r = await run(path.join(root, 'claude-code', 'sandbox-plugin', 'bin', 'hook.sh'), ['Stop'], { stdin: '{"session_id":"s-l"}', env })
    assert.equal(r.code, 0)
    assert.equal(events(b).find(e => e.kind === 'request').auth, 'match')
  })

  test('hook.sh with no bridge exits 0 at once and prints nothing', async () => {
    const port = await closedPort()
    const r = await run(HOOK_SH, ['Stop'], { stdin: '{"session_id":"s"}', env: { ...process.env, DECK_SPIKE_URL: `http://127.0.0.1:${port}`, DECK_SPIKE_TOKEN_FILE: '/nonexistent' } })
    assert.equal(r.code, 0)
    assert.equal(r.stdout + r.stderr, '')
    assert.ok(r.ms < 2500, `${r.ms} ms`)
  })

  test('permission.sh prints the held decision exactly, and exits 0', async t => {
    const b = await bridge(t)
    await setPolicy(b, { permission: { via: 'cmd' } })
    const child = run(PERMISSION_SH, [], { stdin: JSON.stringify(PERMISSION_INPUT), env: scriptEnv(b) })
    const held = await waitFor(async () => (await state(b)).held[0], 'cmd held')
    assert.equal(held.via, 'cmd')
    const a = await answer(b, { id: held.id, decision: 'deny', message: 'via the command hook' })
    const r = await child
    assert.equal(r.code, 0)
    assert.equal(r.stderr, '')
    assert.equal(r.stdout, JSON.stringify(a.json.sent))
    const req = events(b).find(e => e.kind === 'request' && e.path === '/permission-cmd')
    assert.equal(req.auth, 'match')
    assert.deepEqual(req.body, PERMISSION_INPUT)
  })

  test('permission.sh prints nothing for {}, for a bridge that is down, or for a body that is not an object', async t => {
    const b = await bridge(t)
    // Default policy holds /permission, so /permission-cmd answers {} at once.
    const r1 = await run(PERMISSION_SH, [], { stdin: JSON.stringify(PERMISSION_INPUT), env: scriptEnv(b) })
    assert.deepEqual([r1.code, r1.stdout], [0, ''])

    const port = await closedPort()
    const r2 = await run(PERMISSION_SH, [], { stdin: '{}', env: { ...process.env, DECK_SPIKE_URL: `http://127.0.0.1:${port}`, DECK_SPIKE_TOKEN_FILE: '/nonexistent' } })
    assert.deepEqual([r2.code, r2.stdout], [0, ''])

    // A stand-in server: 200 with text, then 500 with a decision.
    let reply = [200, 'ok then']
    const fake = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(reply[0])
        res.end(reply[1])
      })
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    t.after(() => fake.close())
    const env = { ...process.env, DECK_SPIKE_URL: `http://127.0.0.1:${fake.address().port}`, DECK_SPIKE_TOKEN_FILE: '/nonexistent' }
    const r3 = await run(PERMISSION_SH, [], { stdin: '{}', env })
    assert.deepEqual([r3.code, r3.stdout], [0, ''])
    reply = [500, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}']
    const r4 = await run(PERMISSION_SH, [], { stdin: '{}', env })
    assert.deepEqual([r4.code, r4.stdout], [0, ''])
    reply = [200, ' { \n } ']
    const r5 = await run(PERMISSION_SH, [], { stdin: '{}', env })
    assert.deepEqual([r5.code, r5.stdout], [0, ''])
  })

  test('permission.sh stopped with TERM closes its held request at once', async t => {
    const b = await bridge(t)
    await setPolicy(b, { permission: { via: 'cmd' } })
    let child
    const done = run(PERMISSION_SH, [], { stdin: JSON.stringify(PERMISSION_INPUT), env: scriptEnv(b), signalAfter: c => { child = c } })
    await waitFor(async () => (await state(b)).held.length === 1, 'cmd held')
    await sleep(100)
    const killedAt = Date.now()
    child.kill('SIGTERM')
    const closed = await waitFor(() => events(b).find(e => e.kind === 'close' && e.path === '/permission-cmd'), 'close line', 3000)
    assert.equal(closed.end, 'client-closed')
    assert.ok(Date.now() - killedAt < 1500, `${Date.now() - killedAt} ms after TERM`)
    const r = await done
    assert.equal(r.stdout, '')
    assert.equal((await state(b)).held.length, 0)
  })
})
