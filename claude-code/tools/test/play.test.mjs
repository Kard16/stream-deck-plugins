// Every fixture end to end: fake-claude's runner against the fake bridge on a free port, with temp registry
// and records folders. Then the same runner on altered fixtures, to show a mismatch fails rather than
// passing quietly; against a stub deck whose answers carry more than PROTOCOL.md's, which must fail too; and
// the interactive driver with a scripted person in place of the deck.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { controlClient } from '../lib/client.mjs'
import { againstFake, interactive } from '../lib/drivers.mjs'
import { fixtureFiles, parseFixture, readFixture } from '../lib/fixtures.mjs'
import { play } from '../lib/play.mjs'
import { ALLOW, DENY, MODE_TOOL, PRE_ALLOW, ROUTES } from '../lib/protocol.mjs'
import { runLog, sleep, startBridge, tempEnv, writeRecord, writeRegistry } from './helpers.mjs'

const NAMES = fixtureFiles().map((f) => readFixture(f).name)

async function playAgainstFake(t, fx, env = tempEnv(t)) {
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  const steps = []
  const r = await play(fx, { url: bridge.url, token: env.token, driver, say: (s) => steps.push(s) })
  return { r, steps, bridge, env }
}

test('play: there are 17 fixtures to play', () => {
  assert.equal(NAMES.length, 17)
})

for (const name of NAMES) {
  test(`play: fixture ${name} passes against the fake bridge`, async (t) => {
    const fx = readFixture(name)
    const { r, steps, env } = await playAgainstFake(t, fx)
    assert.equal(r.ok, true, `${r.error}\n${steps.join('\n')}`)
    const replies = fx.lines.filter((l) => l.kind === 'reply').length
    const expects = fx.lines.filter((l) => l.kind === 'expect').length
    assert.equal(r.checked, replies + expects, 'every reply and expect line was checked')
    // It cleans up after itself, so a fake folder can be reused.
    assert.deepEqual(fs.readdirSync(env.registryDir), [])
    assert.deepEqual(fs.readdirSync(env.recordsDir), [])
  })
}

test('play: all 17 in a row against one fake bridge, reset between fixtures', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  const results = []
  for (const name of NAMES) results.push(await play(readFixture(name), { url: bridge.url, token: env.token, driver }))
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`), [])
  // The deck's command ids aren't the fixtures' c1, c2…: binding is what made the command fixtures pass.
  const log = runLog(env)
  const ids = log.filter((e) => e.kind === 'command' && e.state === 'queued').map((e) => e.id)
  assert.deepEqual(ids, ['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4', 'cmd-5'], 'mode-from-auto, mode-raise, prompt, prompt-refused and stray-instance')
  // The mode checks the fixtures make: the two allowed, mode-from-auto's and mode-raise's, each for its own command.
  assert.deepEqual(log.filter((e) => e.kind === 'mode-check' && e.allowed).map((e) => e.cmd), ['cmd-1', 'cmd-2'])
  // not-desktop's three hook requests from processes that aren't a desktop session of their own.
  assert.deepEqual(log.filter((e) => e.kind === 'unconfirmed').map((e) => [e.route, e.why]), [
    ['permission', 'no host: X-Deck-Host is missing or not a local_ id'],
    ['permission', 'the registry lists local_test-a under another sessionId'],
    ['pretool', 'the registry lists local_test-a under another sessionId'],
  ])
})

// The fixtures' times are made up, around T0 = 2026-11-02 06:13:20 UTC. Nothing the bridge decides may hang
// on how its own clock compares with them, or the fixtures would pass or fail by the date.
const T0 = 1793600000000
for (const [label, offset] of [['a week after', 7 * 86_400_000], ['a week before', -7 * 86_400_000]]) {
  test(`play: all 17 pass with the bridge's clock ${label} the fixtures' times`, async (t) => {
    const env = tempEnv(t)
    const started = Date.now()
    const bridge = await startBridge(t, env, { now: () => T0 + offset + (Date.now() - started) })
    const driver = againstFake({ url: bridge.url, token: env.token })
    const failed = []
    for (const name of NAMES) {
      const r = await play(readFixture(name), { url: bridge.url, token: env.token, driver })
      if (!r.ok) failed.push(`${name}: ${r.error}`)
    }
    assert.deepEqual(failed, [])
  })
}

test('play: the fingerprints of both sides matched for every held request the fixtures make', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  for (const name of NAMES) await play(readFixture(name), { url: bridge.url, token: env.token, driver })
  const checks = runLog(env).filter((e) => e.kind === 'fp-check')
  // approve, deny, answered-in-app, answered-in-app-registry and needs-you: a tool.start and a request each.
  assert.deepEqual(checks.map((c) => c.tool), ['Bash', 'Write', 'Write', 'Bash', 'AskUserQuestion'])
  assert.deepEqual(checks.filter((c) => !c.match || c.bridgeSummary !== c.modSummary), [])
})

test('play: against-fake won\'t play into a registry or records folder holding files it didn\'t write', async (t) => {
  const env = tempEnv(t)
  writeRecord(env, 'local_other', { model: 'm', lastFocusedAt: 1 })
  let { r } = await playAgainstFake(t, readFixture('hello'), env)
  assert.equal(r.ok, false)
  assert.match(r.error, /the fake bridge's records folder .* holds files fake-claude didn't write \(acct\/org\/local_other\.json\): give it an empty one/)
  assert.deepEqual(fs.readdirSync(env.registryDir), [], 'nothing written')
  assert.deepEqual(fs.readdirSync(path.join(env.recordsDir, 'acct', 'org')), ['local_other.json'], 'and nothing removed')

  const other = tempEnv(t)
  writeRegistry(other, 7, { sessionId: 's7', hostSessionId: 'local_seven', status: 'idle' })
  ;({ r } = await playAgainstFake(t, readFixture('hello'), other))
  assert.match(r.error, /registry folder .* holds files fake-claude didn't write \(7\.json\)/)
})

/** A fixture's text with one replacement, which must apply. */
function altered(name, from, to) {
  const file = fixtureFiles().find((f) => f.endsWith(`/${name}.jsonl`))
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${name} contains ${from}`)
  return parseFixture(text.replace(from, to), file)
}

const ALLOW_TEXT = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

test('play: a mismatch fails the fixture with the line and the reason', async (t) => {
  const cases = [
    // The reply wants Deny where Approve answers Allow.
    [altered('approve', '{"press":{"approve":{}}}', '{"press":{"deny":{}}}'), /line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.behavior: expected "allow", got "deny"/],
    // No decision is expected, but the press allows: {} must not match a decision.
    [altered('approve', `{"reply":{"to":"p1","status":200,"body":${ALLOW_TEXT}}}`, '{"reply":{"to":"p1","status":200,"body":{}}}'), /p1: body: expected no decision \(\{\}\), got/],
    // A wrong status in an expect line.
    [altered('status', '{"expect":{"status":{"local_test-a":"done"}', '{"expect":{"status":{"local_test-a":"failed"}'), /line \d+ \(expect\): expect: status\.local_test-a: expected "failed", got "done"/],
    // A command state the deck never reached.
    [altered('prompt', '{"expect":{"cmds":{"c1":"done"}}}', '{"expect":{"cmds":{"c1":"refused"}}}'), /cmds\.c1 \(cmd-1\): expected "refused", got "done"/],
    // A reply that never comes: the held request isn't answered by anything.
    [altered('two-held', '{"press":{"approve":{}}}', '{"note":"no press"}'), /p1: no answer within 2 s/],
    // A wrong status for a request the runner waits on.
    [altered('auth', '{"reply":{"to":"a5","status":404', '{"reply":{"to":"a5","status":200'), /a5: status: expected 200, got 404/],
    // An answer the fixture doesn't expect, on a request without a reply line.
    [altered('status', '"path":"/v1/events"', '"path":"/v1/eventz"'), /line \d+ \(plugin\): POST \/v1\/eventz answered 404/],
    // The same on a labeled request: its reply line catches it.
    [altered('hello', '"path":"/v1/hello"', '"path":"/v1/hullo"'), /line \d+ \(reply\): h: status: expected 200, got 404/],
  ]
  for (const [fx, why] of cases) {
    const { r } = await playAgainstFake(t, fx)
    assert.equal(r.ok, false, `${fx.name} should fail with ${why}`)
    assert.match(r.error, why)
  }
})

/** The main loop's events in an events body: those without agent, or whose agent isn't a non-empty string (PROTOCOL.md, "Events"). */
const mainEvents = (body) => (Array.isArray(body?.events) ? body.events : []).filter((e) => e !== null && typeof e === 'object' && !(typeof e.agent === 'string' && e.agent !== ''))

/**
 * A deck that answers presses its own way, for answers the fake bridge never gives: hello is ok, events and
 * results get 204, a press answers the oldest held permission request with `answer(key, its body)`, and a mode
 * check gets `pretool(its body)`, `[status, json]`, at once. Polls go as PROTOCOL.md's "Commands" has them as far as
 * these fixtures need: held, the open one answered with none when the mod reports that the main loop's turn ended,
 * and those after it answered at once while the registry says busy and until a main-loop turn.start. It plays
 * nothing else of a deck: registry lines only set the status its polls go by, of the one session these fixtures
 * have, and expect lines go unchecked, so a fixture through it checks only the replies.
 */
async function stubDeck(t, answer, { pretool = () => [200, {}] } = {}) {
  const held = []
  const polls = []
  let taken = 0
  let status = null
  let turnEnded = false
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      taken++
      const reply = (status, json) => {
        res.writeHead(status, json === undefined ? {} : { 'content-type': 'application/json' })
        res.end(json === undefined ? undefined : JSON.stringify(json))
      }
      const route = new URL(req.url, 'http://stub').pathname
      const body = () => JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (route === ROUTES.permission) held.push({ body: body(), reply })
      else if (route === ROUTES.pretool) reply(...pretool(body()))
      else if (route === ROUTES.hello) reply(200, { v: 1, ok: true })
      else if (route === ROUTES.next) {
        if (turnEnded && status === 'busy') reply(200, { cmds: [] })
        else polls.push(reply)
      } else {
        for (const e of route === ROUTES.events ? mainEvents(body()) : []) {
          if (e.t === 'turn.start') turnEnded = false
          if (e.t !== 'turn.end' && e.t !== 'failed') continue
          turnEnded = true
          for (const poll of polls.splice(0)) poll(200, { cmds: [] })
        }
        reply(204)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const driver = {
    name: 'stub',
    async begin(fx) {
      status = fx.setup.registry?.[0]?.status ?? null
    },
    async taken(sent) {
      const deadline = Date.now() + 2000
      while (taken < sent) {
        if (Date.now() >= deadline) throw new Error(`the stub took ${taken} of ${sent} requests`)
        await sleep(5)
      }
    },
    async press(line) {
      const request = held.shift()
      request?.reply(200, answer(Object.keys(line.value)[0], request.body))
    },
    async registry(line) {
      status = line.value.gone ? null : (line.value.status ?? status)
    },
    async expect() {
      return false
    },
  }
  return { url: `http://127.0.0.1:${server.address().port}`, driver }
}

test("play: an answer to a permission request with anything beyond one of PROTOCOL.md's three fails at its reply, though the fixture's body is all in it", async (t) => {
  // The stub itself is sound: answering as PROTOCOL.md writes them, both fixtures pass.
  const exact = (key) => (key === 'deny' ? DENY : ALLOW)
  const sound = [
    ['approve', 4, 'the replies to hello, to the press, to the poll at the turn\'s end and to the next, answered at once while the registry says busy'],
    ['deny', 3, 'the replies to hello, to the press and to the poll at the turn\'s end: the next is held, as the registry says waiting'],
  ]
  for (const [name, replies, which] of sound) {
    const { url, driver } = await stubDeck(t, exact)
    const r = await play(readFixture(name), { url, token: 'stub', driver })
    assert.equal(r.ok, true, `${name}: ${r.error}`)
    assert.equal(r.checked, replies, `${name}: ${which}`)
  }

  const adding = (base, extra) => ({ hookSpecificOutput: { ...base.hookSpecificOutput, decision: { ...base.hookSpecificOutput.decision, ...extra } } })
  const cases = [
    // A deck that echoes the request's permission_suggestions: every Approve would raise the session to Accept
    // edits, and ladder step 5 would still show ok.
    ['approve', (key, body) => adding(ALLOW, { updatedPermissions: body.permission_suggestions }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.updatedPermissions: the deck never sends updatedPermissions \(PROTOCOL\.md\), got \[\{"type":"setMode","mode":"acceptEdits","destination":"session"\}\]$/],
    // One that rewrites the call it allows.
    ['approve', (key, body) => adding(ALLOW, { updatedInput: { ...body.tool_input, content: 'five' } }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.updatedInput: the deck never sends updatedInput/],
    // One whose Deny also writes a rule into the user's settings.
    ['deny', () => adding(DENY, { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'deny', destination: 'userSettings' }] }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.updatedPermissions: the deck never sends updatedPermissions/],
    // Fields of its own beside the decision: an answer to a permission request is exactly one of the three.
    ['approve', () => ({ ...ALLOW, note: 'x' }), /^line \d+ \(reply\): p1: body\.note: not in any of PROTOCOL\.md's answers, got "x"/],
    ['deny', () => ({ ...DENY, extra: { nested: 1 } }), /^line \d+ \(reply\): p1: body\.extra: not in any of PROTOCOL\.md's answers/],
    // And beside no decision, where the line expects {}.
    [altered('approve', `{"reply":{"to":"p1","status":200,"body":${ALLOW_TEXT}}}`, '{"reply":{"to":"p1","status":200,"body":{}}}'), () => ({ note: 'x' }), /^line \d+ \(reply\): p1: body\.note: not in any of PROTOCOL\.md's answers, got "x"/],
  ]
  for (const [fixture, answer, why] of cases) {
    const fx = typeof fixture === 'string' ? readFixture(fixture) : fixture
    const { url, driver } = await stubDeck(t, answer)
    const r = await play(fx, { url, token: 'stub', driver })
    assert.equal(r.ok, false, `${fx.name} should fail with ${why}`)
    assert.match(r.error, why)
  }
})

const SID_A = '3fa86955-0000-4000-8000-00000000000a'
const HOST_A = 'local_test-a'

/** A fixture made of `lines`, with the session the fixtures' A, and the registry `registry` (default: none). */
function fixtureOf(name, lines, registry = []) {
  const setup = { setup: { session: { sid: SID_A, host: HOST_A, model: 'm', cwd: '/s', token: 't' }, registry } }
  return parseFixture([setup, ...lines].map((l) => JSON.stringify(l)).join('\n'), `${name}.jsonl`)
}

/** A mode check from A, as the mode hook sends it, for the app's mode tool. */
const modeCheck = (as, extra = {}) => ({
  plugin: {
    ...(as ? { as } : {}), method: 'POST', path: '/v1/pretool', headers: { 'X-Deck-Host': HOST_A },
    body: { session_id: SID_A, hook_event_name: 'PreToolUse', tool_name: MODE_TOOL, tool_input: { session_id: 'self', mode: 'plan' }, tool_use_id: 'toolu_plugin_0001', ...extra },
  },
})

test("play: an answer to a mode check is held to PROTOCOL.md's two bodies, when it comes and at its reply, whatever the line expects", async (t) => {
  const allowed = (expected) => fixtureOf('pretool', [modeCheck('q1'), { reply: { to: 'q1', status: 200, body: expected } }])
  const inside = (extra) => ({ hookSpecificOutput: { ...PRE_ALLOW.hookSpecificOutput, ...extra } })
  // The stub is sound: answering as PROTOCOL.md writes it, the line passes.
  let { url, driver } = await stubDeck(t, () => ({}), { pretool: () => [200, PRE_ALLOW] })
  let r = await play(allowed(PRE_ALLOW), { url, token: 'stub', driver })
  assert.deepEqual([r.ok, r.checked, r.error], [true, 1, undefined])

  const cases = [
    // At the request's own line, before any reply line, though the line's body is all in it.
    [PRE_ALLOW, [200, { ...PRE_ALLOW, note: 'x' }], /^line 2 \(plugin\): POST \/v1\/pretool: body\.note: not in any of PROTOCOL\.md's answers, got "x" \(an answer is the mode check's allow or \{\} exactly\)$/],
    [PRE_ALLOW, [200, inside({ updatedInput: { session_id: 'self', mode: 'bypassPermissions' } })], /^line 2 \(plugin\): POST \/v1\/pretool: body\.hookSpecificOutput\.updatedInput: the deck never sends updatedInput/],
    [{}, [200, inside({ permissionDecision: 'deny', permissionDecisionReason: 'No.' })], /^line 2 \(plugin\): POST \/v1\/pretool: body\.hookSpecificOutput\.permissionDecision: expected "allow", got "deny"/],
    [{}, [204, undefined], /^line 2 \(plugin\): POST \/v1\/pretool: body: expected the mode check's allow or \{\}, got nothing$/],
    // At the reply: an expected {} is no decision.
    [{}, [200, PRE_ALLOW], /^line 3 \(reply\): q1: body: expected no decision \(\{\}\), got \{"hookSpecificOutput"/],
  ]
  for (const [expected, answer, why] of cases) {
    ;({ url, driver } = await stubDeck(t, () => ({}), { pretool: () => answer }))
    r = await play(allowed(expected), { url, token: 'stub', driver })
    assert.equal(r.ok, false, `${JSON.stringify(answer)} should fail with ${why}`)
    assert.match(r.error, why)
  }
  // A mode check with no reply line is held to them too: Claude Code acts on its answer all the same.
  ;({ url, driver } = await stubDeck(t, () => ({}), { pretool: () => [200, { ...PRE_ALLOW, systemMessage: 'Allowed.' }] }))
  r = await play(fixtureOf('unreplied', [modeCheck()]), { url, token: 'stub', driver })
  assert.match(r.error ?? 'passed', /^line 2 \(plugin\): POST \/v1\/pretool: body\.systemMessage: Claude Code acts on it/)
})

/**
 * A person at a terminal, scripted: does what PRESS lines say on the fake deck, Approve, Deny and Saved Prompt keys,
 * and answers every question with Enter.
 */
function scriptedPerson(control) {
  const shown = []
  const asked = []
  const ui = {
    show(text) {
      shown.push(text)
      const key = /^PRESS: press (Approve|Deny)\b/.exec(text)
      if (key) setTimeout(() => void control.call('POST', `/control/${key[1].toLowerCase()}`, {}), 30)
      const prompt = /^PRESS: pick (\S+) on the Sessions dial, then press a Saved Prompt key whose text is (".*")\.$/.exec(text)
      if (prompt) setTimeout(() => void control.call('POST', '/control/prompt', { host: prompt[1], text: JSON.parse(prompt[2]) }), 30)
    },
    async ask(question) {
      asked.push(question)
      return ''
    },
  }
  return { ui, shown, asked, say: (s) => ui.show(`  ${s}`) }
}

test('play: the interactive driver, with a scripted person pressing on a fake bridge whose registry lists the fixture\'s session', async (t) => {
  const env = tempEnv(t)
  // As if the deck's registry listed the session: the fake bridge confirms its hook requests and holds them. The
  // driver still skips the fixture's registry lines.
  const [entry] = readFixture('approve').setup.registry
  writeRegistry(env, entry.pid, entry)
  const bridge = await startBridge(t, env)
  const { ui, shown, asked, say } = scriptedPerson(controlClient(bridge.url, env.token))
  const driver = interactive({ ui, pressTimeoutMs: 5000 })

  let r = await play(readFixture('approve'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, `${r.error}\n${shown.join('\n')}`)
  assert.ok(shown.some((s) => /^PRESS: press Approve\. The key should show the oldest held request: local_test-a: Write s4\.txt\./.test(s)))
  assert.ok(shown.some((s) => s.startsWith('CHECK on the deck:')))
  assert.ok(shown.some((s) => s.startsWith('skip: registry')))
  assert.equal(r.checked, 3, 'the replies to hello, to the press and to the poll at the turn\'s end; expect lines are for the person')
  assert.equal(asked.length, 3, 'one question per expect line')
  // The poll after the turn's end is answered at once only while the registry says busy, which the skipped lines
  // would have said: the deck holds it, and its reply is skipped and reported.
  assert.deepEqual(r.skipped.map((s) => [s.reply, s.why]), [['n2', 'the deck answers it at once only while the registry says busy after the turn ended, and this mode skips registry lines']])
  assert.ok(shown.some((s) => s === '  skip: reply n2, answered at once only while the skipped registry says busy'))

  r = await play(readFixture('answered-in-app-registry'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.skipped.map((s) => s.reply), ['p1'], 'the reply that waits on a registry change')
  // Its events counted although the bridge saw the same fixture inst and seqs from 1 in the last play: its
  // tool.end released its request.
  const log = runLog(env)
  const insts = new Set(log.filter((e) => e.kind === 'hello' && e.ok).map((e) => e.inst))
  assert.equal(insts.size, 2, 'a fresh inst for each play')
  assert.ok(log.some((e) => e.kind === 'release' && e.rule === 1), 'released by its tool.end')
  assert.equal(log.filter((e) => e.kind === 'events' && e.dropped).length, 0)

  // The same poll in status and prompt-refused, as README.md says: n2.
  for (const name of ['status', 'prompt-refused']) {
    r = await play(readFixture(name), { url: bridge.url, token: env.token, driver, say })
    assert.equal(r.ok, true, `${name}: ${r.error}\n${shown.join('\n')}`)
    assert.deepEqual(r.skipped.map((s) => s.reply), ['n2'], name)
  }
  assert.ok(shown.includes('PRESS: pick local_test-a on the Sessions dial, then press a Saved Prompt key whose text is "Carry on.".'))

  const notes = []
  const noting = interactive({ ui: { show: () => {}, ask: async () => 'the key shows nothing' }, pressTimeoutMs: 1000 })
  r = await play(readFixture('hello'), { url: bridge.url, token: env.token, driver: noting })
  notes.push(...r.notes)
  assert.equal(r.ok, true)
  assert.deepEqual(notes.map((n) => n.saw), ['the key shows nothing'])

  // Claude Code's requests are sent as they are: only the mod's carry its inst, bound to a fresh one per play.
  const fx = fixtureOf('insts', [
    { plugin: { as: 'h', method: 'POST', path: '/v1/hello', body: { v: 1, sid: SID_A, host: HOST_A, inst: 'ia', cwd: '/s', model: 'm', plugin: '*', cc: '*' } } },
    { reply: { to: 'h', status: 200, body: { v: 1, ok: true } } },
    modeCheck('q1', { inst: 'ia' }),
    { reply: { to: 'q1', status: 200, body: {} } },
  ])
  r = await play(fx, { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  const sent = runLog(env).filter((e) => e.kind === 'request' && (e.path === '/v1/hello' || e.path === '/v1/pretool')).slice(-2)
  assert.deepEqual(sent.map((e) => e.path), ['/v1/hello', '/v1/pretool'])
  assert.match(sent[0].body.inst, /^ia-[a-z0-9]+$/, "the mod's")
  assert.equal(sent[1].body.inst, 'ia', "Claude Code's, untouched")
})

test('play: the interactive driver against a deck whose registry doesn\'t list the fixture\'s session, as no real deck\'s does: it skips what hangs on the registry, and never asks for a press on nothing', async (t) => {
  // PROTOCOL.md, "Desktop sessions only": such a deck answers the fixture's hook requests {} at once, and takes a hello
  // that the fixture's registry would have it refuse.
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const { ui, shown, say } = scriptedPerson(controlClient(bridge.url, env.token))
  const driver = interactive({ ui, pressTimeoutMs: 5000 })
  const decision = "the deck answered {} at once, as it does for a session its registry doesn't confirm, and this mode skips registry lines: no registry it reads lists the fixture's session"

  let r = await play(readFixture('approve'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, `${r.error}\n${shown.join('\n')}`)
  assert.deepEqual(r.skipped.map((s) => [s.press ?? s.reply, s.why === decision]), [['approve', false], ['p1', true], ['n2', false]])
  assert.match(r.skipped[0].why, /^nothing fake-claude sent is held, so a press could only land on another session's request/)
  assert.equal(shown.filter((s) => s.startsWith('PRESS:')).length, 0, 'no press asked for')
  assert.ok(shown.includes('skip: press approve: nothing fake-claude sent is held'))
  assert.ok(shown.includes("  skip: reply p1, answered {} at once: no registry the deck reads confirms the fixture's session"))
  assert.equal(r.checked, 2, 'the replies to hello and to the poll at the turn\'s end')

  // A reply that expects no decision is checked as usual; so is a hook request's from a process that isn't a desktop
  // session. A hello's 409 hangs on the registry.
  r = await play(readFixture('needs-you'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.skipped.map((s) => s.press ?? s.reply), ['approve'])
  r = await play(readFixture('not-desktop'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.skipped.map((s) => [s.reply, s.why]), [['h1', "the deck refuses a hello only from a host its registry lists under another sessionId, and this mode skips registry lines: no registry it reads lists the fixture's host"]])
  assert.equal(r.checked, 4, 'p1, p2, q1 and h2')
  // A reply after a registry line is skipped, as README.md says of session-gone's p1.
  r = await play(readFixture('session-gone'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.skipped.map((s) => [s.reply, s.why]), [['p1', 'it waits on a registry change, which this mode skips']])
})

test('play: with registry lines skipped, only the reply to a poll answered at once because the registry says busy after the turn end is skipped', async (t) => {
  // A poll while the registry says busy before the turn ends (n2), one after it while busy (n3), one after the
  // registry says idle (n4), and one while busy again in the next turn (n6): only n3's answer hangs on the registry,
  // so only its reply is skipped.
  const SID = '3fa86955-0000-4000-8000-00000000000a'
  const HOST = 'local_test-a'
  const next = (as) => ({ plugin: { as, method: 'GET', path: `/v1/next?sid=${SID}&host=${HOST}&inst=ia&wait=20` } })
  const none = (to) => ({ reply: { to, status: 200, body: { cmds: [] } } })
  const ev = (seq, e) => ({ plugin: { method: 'POST', path: '/v1/events', body: { sid: SID, host: HOST, inst: 'ia', seq, events: [{ ...e, at: T0 + seq }] } } })
  const lines = [
    { setup: { session: { sid: SID, host: HOST, model: 'm', cwd: '/s', token: 't' }, registry: [{ pid: 101, sessionId: SID, hostSessionId: HOST, name: 'A', cwd: '/s', status: 'idle', statusUpdatedAt: T0 }] } },
    { plugin: { as: 'h', method: 'POST', path: '/v1/hello', body: { v: 1, sid: SID, host: HOST, inst: 'ia', cwd: '/s', model: 'm', plugin: '*', cc: '*' } } },
    { reply: { to: 'h', status: 200, body: { v: 1, ok: true } } },
    next('n1'),
    ev(1, { t: 'turn.start', turn: 't1' }),
    { registry: { pid: 101, status: 'busy', statusUpdatedAt: T0 + 1000 } },
    next('n2'),
    none('n1'),
    ev(2, { t: 'turn.end', turn: 't1', reason: 'answer' }),
    none('n2'),
    next('n3'),
    none('n3'),
    { registry: { pid: 101, status: 'idle', statusUpdatedAt: T0 + 2000 } },
    next('n4'),
    next('n5'),
    none('n4'),
    ev(3, { t: 'turn.start', turn: 't2' }),
    { registry: { pid: 101, status: 'busy', statusUpdatedAt: T0 + 3000 } },
    next('n6'),
    none('n5'),
    ev(4, { t: 'turn.end', turn: 't2', reason: 'answer' }),
    none('n6'),
  ]
  const fx = parseFixture(lines.map((l) => JSON.stringify(l)).join('\n'), 'at-once.jsonl')

  // The fake bridge, its registry written, gives every reply.
  let { r } = await playAgainstFake(t, fx)
  assert.equal(r.ok, true, r.error)
  assert.deepEqual([r.checked, r.skipped], [7, []])

  // With its registry lines skipped, the bridge holds n3 too, and its reply alone is skipped and reported.
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  r = await play(fx, { url: bridge.url, token: env.token, driver: interactive({ ui: { show: () => {}, ask: async () => '' }, pressTimeoutMs: 1000 }) })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.checked, 6, 'the replies to hello, n1, n2, n4, n5 and n6')
  assert.deepEqual(r.skipped.map((s) => [s.line, s.reply]), [[12, 'n3']])
})
