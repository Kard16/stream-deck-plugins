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
import { ALLOW, DENY, ROUTES } from '../lib/protocol.mjs'
import { runLog, sleep, startBridge, tempEnv, writeRecord, writeRegistry } from './helpers.mjs'

const NAMES = fixtureFiles().map((f) => readFixture(f).name)

async function playAgainstFake(t, fx, env = tempEnv(t)) {
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  const steps = []
  const r = await play(fx, { url: bridge.url, token: env.token, driver, say: (s) => steps.push(s) })
  return { r, steps, bridge, env }
}

test('play: there are 14 fixtures to play', () => {
  assert.equal(NAMES.length, 14)
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

test('play: all 14 in a row against one fake bridge, reset between fixtures', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  const results = []
  for (const name of NAMES) results.push(await play(readFixture(name), { url: bridge.url, token: env.token, driver }))
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`), [])
  // The deck's command ids aren't the fixtures' c1, c2…: binding is what made the command fixtures pass.
  const ids = runLog(env).filter((e) => e.kind === 'command' && e.state === 'queued').map((e) => e.id)
  assert.deepEqual(ids, ['cmd-1', 'cmd-2', 'cmd-3'])
})

// The fixtures' times are made up, around T0 = 2026-11-02 06:13:20 UTC. Nothing the bridge decides may hang
// on how its own clock compares with them, or the fixtures would pass or fail by the date.
const T0 = 1793600000000
for (const [label, offset] of [['a week after', 7 * 86_400_000], ['a week before', -7 * 86_400_000]]) {
  test(`play: all 14 pass with the bridge's clock ${label} the fixtures' times`, async (t) => {
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

/**
 * A deck that answers presses its own way, for answers the fake bridge never gives: hello is ok, events and
 * results get 204, polls are held, and a press answers the oldest held permission request with
 * `answer(key, its body)`. It plays nothing else of a deck: registry lines do nothing and expect lines go
 * unchecked, so a fixture through it checks only the replies.
 */
async function stubDeck(t, answer) {
  const held = []
  let taken = 0
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
      if (route === ROUTES.permission) held.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), reply })
      else if (route === ROUTES.hello) reply(200, { v: 1, ok: true })
      else if (route !== ROUTES.next) reply(204)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const driver = {
    name: 'stub',
    async begin() {},
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
    async registry() {},
    async expect() {
      return false
    },
  }
  return { url: `http://127.0.0.1:${server.address().port}`, driver }
}

test("play: an Allow or Deny with anything Claude Code would apply fails at its reply, though the fixture's body is all in it", async (t) => {
  // The stub itself is sound: answering as PROTOCOL.md writes them, both fixtures pass.
  const exact = (key) => (key === 'deny' ? DENY : ALLOW)
  for (const name of ['approve', 'deny']) {
    const { url, driver } = await stubDeck(t, exact)
    const r = await play(readFixture(name), { url, token: 'stub', driver })
    assert.equal(r.ok, true, `${name}: ${r.error}`)
    assert.equal(r.checked, 2, 'the replies to hello and to the press')
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
  ]
  for (const [name, answer, why] of cases) {
    const { url, driver } = await stubDeck(t, answer)
    const r = await play(readFixture(name), { url, token: 'stub', driver })
    assert.equal(r.ok, false, `${name} should fail with ${why}`)
    assert.match(r.error, why)
  }
})

test('play: the interactive driver, with a scripted person pressing on the fake bridge', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const control = controlClient(bridge.url, env.token)
  const shown = []
  const asked = []
  // The person: does what PRESS lines say on the fake deck, and answers every question with Enter.
  const ui = {
    show(text) {
      shown.push(text)
      const m = /^PRESS: press (Approve|Deny)\b/.exec(text)
      if (m) setTimeout(() => void control.call('POST', `/control/${m[1].toLowerCase()}`, {}), 30)
    },
    async ask(question) {
      asked.push(question)
      return ''
    },
  }
  const driver = interactive({ ui, pressTimeoutMs: 5000 })
  const say = (s) => ui.show(`  ${s}`)

  // The registry lines are skipped, so the fake bridge reads an empty folder: as the real deck would know
  // nothing of the fixture's sessions.
  let r = await play(readFixture('approve'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, `${r.error}\n${shown.join('\n')}`)
  assert.ok(shown.some((s) => /^PRESS: press Approve\. The key should show the oldest held request: local_test-a: Write s4\.txt\./.test(s)))
  assert.ok(shown.some((s) => s.startsWith('CHECK on the deck:')))
  assert.ok(shown.some((s) => s.startsWith('skip: registry')))
  assert.equal(r.checked, 2, 'the replies to hello and to the press; expect lines are for the person')
  assert.equal(asked.length, 3, 'one question per expect line')

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

  const notes = []
  const noting = interactive({ ui: { show: () => {}, ask: async () => 'the key shows nothing' }, pressTimeoutMs: 1000 })
  r = await play(readFixture('hello'), { url: bridge.url, token: env.token, driver: noting })
  notes.push(...r.notes)
  assert.equal(r.ok, true)
  assert.deepEqual(notes.map((n) => n.saw), ['the key shows nothing'])
})
