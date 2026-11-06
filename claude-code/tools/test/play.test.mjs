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
import { EXPECT_SKIPPED, againstFake, interactive } from '../lib/drivers.mjs'
import { fixtureFiles, parseFixture, readFixture } from '../lib/fixtures.mjs'
import * as P from '../lib/play.mjs'
import { play } from '../lib/play.mjs'
import { ALLOW, DENY, ROUTES, answerBody, approvePlanBody, joinLabels } from '../lib/protocol.mjs'
import { TOOLS, runLog, sleep, startBridge, tempEnv, writeRecord, writeRegistry } from './helpers.mjs'

const NAMES = fixtureFiles().map((f) => readFixture(f).name)

async function playAgainstFake(t, fx, env = tempEnv(t)) {
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  const steps = []
  const r = await play(fx, { url: bridge.url, token: env.token, driver, say: (s) => steps.push(s) })
  return { r, steps, bridge, env }
}

test('play: there are 23 fixtures to play', () => {
  assert.equal(NAMES.length, 23)
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

test('play: all 23 in a row against one fake bridge, reset between fixtures', async (t) => {
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const driver = againstFake({ url: bridge.url, token: env.token })
  const results = []
  for (const name of NAMES) results.push(await play(readFixture(name), { url: bridge.url, token: env.token, driver }))
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`), [])
  // The deck's command ids aren't the fixtures' c1, c2…: binding is what made the command fixtures pass.
  const log = runLog(env)
  const ids = log.filter((e) => e.kind === 'command' && e.state === 'queued').map((e) => e.id)
  assert.deepEqual(ids, ['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4'], 'hello-again, prompt-refused, prompt and stray-instance')
  // hello-again's poll after its registry file went and came back, the one poll the fixtures answer 409 hello first.
  assert.deepEqual(log.filter((e) => e.kind === 'poll-hello-first').map((e) => e.host), ['local_test-a'])
  // not-desktop's two hook requests from processes that aren't a desktop session of their own.
  assert.deepEqual(log.filter((e) => e.kind === 'unconfirmed').map((e) => [e.route, e.why]), [
    ['permission', 'no host: X-Deck-Host is missing or not a local_ id'],
    ['permission', 'the registry lists local_test-a under another sessionId'],
  ])
})

// The fixtures' times are made up, around T0 = 2026-11-02 06:13:20 UTC. Nothing the bridge decides may hang
// on how its own clock compares with them, or the fixtures would pass or fail by the date.
const T0 = 1793600000000
for (const [label, offset] of [['a week after', 7 * 86_400_000], ['a week before', -7 * 86_400_000]]) {
  test(`play: all 23 pass with the bridge's clock ${label} the fixtures' times`, async (t) => {
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
  // A tool.start and a request each, in the fixtures' order: answer-question, answer-questions, answered-in-app-registry,
  // answered-in-app, approve, deny, dial-gone, dial-next (its question, then its Bash), needs-you, plan-approve and
  // plan-reject. dial-approve's sessions have no plugin, so there's no tool.start to compare.
  assert.deepEqual(checks.map((c) => c.tool), ['AskUserQuestion', 'AskUserQuestion', 'Bash', 'Write', 'Write', 'Bash', 'AskUserQuestion', 'AskUserQuestion', 'Bash', 'AskUserQuestion', 'ExitPlanMode', 'ExitPlanMode'])
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
 * results get 204, and a press answers the oldest held permission request with `answer(key, its body, the press
 * line's value)`. Polls go as PROTOCOL.md's "Commands" has them as far as these fixtures need: held, the open one
 * answered with none when the mod reports that the main loop's turn ended, and those after it answered at once while
 * the registry says busy and until a main-loop turn.start. It plays nothing else of a deck: registry lines only set
 * the status its polls go by, of the one session these fixtures have, and expect lines go unchecked, so a fixture
 * through it checks only the replies.
 */
async function stubDeck(t, answer) {
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
      const [key] = Object.keys(line.value)
      request?.reply(200, answer(key, request.body, line.value[key]))
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

test("play: an answer to a permission request with anything beyond one of PROTOCOL.md's five fails at its reply, though the fixture's body is all in it", async (t) => {
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
    // edits, and ladder step 5 would still show ok. It reads as an Approve plan, which goes only to an ExitPlanMode.
    ['approve', (key, body) => adding(ALLOW, { updatedPermissions: body.permission_suggestions }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision: an Approve plan goes only to an ExitPlanMode, and this request is for Write \(PROTOCOL\.md, "Permission requests"\)$/],
    // One that rewrites the call it allows: an Answer, which goes only to an AskUserQuestion.
    ['approve', (key, body) => adding(ALLOW, { updatedInput: { ...body.tool_input, content: 'five' } }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision: an Answer goes only to an AskUserQuestion, and this request is for Write/],
    // One whose Deny also writes a rule into the user's settings.
    ['deny', () => adding(DENY, { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'deny', destination: 'userSettings' }] }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.updatedPermissions: the deck sends updatedPermissions only in an Approve plan, in its allow's decision \(PROTOCOL\.md\), got \[\{"type":"addRules"/],
    // Fields of its own beside the decision: an answer to a permission request is exactly one of the five.
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

/**
 * The answer a dial line asks for, as PROTOCOL.md writes it, made from the request: the stub deck's sound answer for
 * the dial fixtures. The picks go in the order of the question's options.
 */
function dialAnswer(key, body, press) {
  if (key !== 'dial') return key === 'deny' ? DENY : ALLOW
  if (press.decision) return press.decision === 'deny' ? DENY : ALLOW
  if (press.plan) return press.plan === 'reject' ? DENY : approvePlanBody(body.tool_input, press.plan)
  const answers = Object.fromEntries(body.tool_input.questions.map((q) => {
    const labels = q.options.map((o) => o.label).filter((l) => press.picks[q.question].includes(l))
    return [q.question, q.multiSelect ? joinLabels(labels) : labels[0]]
  }))
  return answerBody(body.tool_input, answers)
}

test("play: a dial's Answer or Approve plan must equal the line's body exactly, fit its request, and be one of PROTOCOL.md's five, though the line's body is all in it", async (t) => {
  // The stub is sound: answering each dial line as PROTOCOL.md writes it, the fixtures pass.
  for (const [name, replies] of [['answer-question', 2], ['answer-questions', 2], ['plan-approve', 2], ['plan-reject', 3]]) {
    const { url, driver } = await stubDeck(t, dialAnswer)
    const r = await play(readFixture(name), { url, token: 'stub', driver })
    assert.deepEqual([r.ok, r.checked, r.error], [true, replies, undefined], name)
  }
  const sound = (key, body, press) => dialAnswer(key, body, press)
  const decision = (out, extra) => ({ hookSpecificOutput: { ...out.hookSpecificOutput, decision: { ...out.hookSpecificOutput.decision, ...extra } } })
  const input = (out) => out.hookSpecificOutput.decision.updatedInput
  const cases = [
    // A key of its own in the echoed input: Claude Code would fail it as a deny, and the question would be lost.
    ['answer-question', (...a) => decision(sound(...a), { updatedInput: { ...input(sound(...a)), extra: 1 } }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.updatedInput\.extra: not expected, got 1 \(an Answer's updatedInput is the request's tool_input exactly as it came, with answers added\)$/],
    // An option changed on the way back.
    ['answer-question', (...a) => decision(sound(...a), { updatedInput: { ...input(sound(...a)), questions: [{ ...input(sound(...a)).questions[0], multiSelect: true }] } }), /updatedInput\.questions\[0\]\.multiSelect: expected false, got true/],
    // A plain Allow, which Claude Code ignores for a question: T5's plan stayed on the app's card.
    ['answer-question', () => ALLOW, /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision: Claude Code ignores a plain Allow for AskUserQuestion, which needs the person/],
    // An Answer with a setMode too reads as an Approve plan, which a question never gets.
    ['answer-question', (...a) => decision(sound(...a), { updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] }), /an Approve plan goes only to an ExitPlanMode, and this request is for AskUserQuestion/],
    // The multi-select join, whose labels are Apple, `Pear, ripe` and `Plum "Victoria"`: a label holding ", " or a
    // double quote not written as a JSON string, or the labels in the order the dial line picked them.
    ['answer-questions', (...a) => answerBody(input(sound(...a)), { ...input(sound(...a)).answers, 'Which fruits?': 'Apple, Pear, ripe, "Plum \\"Victoria\\""' }), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.updatedInput\.answers\.Which fruits\?: expected "Apple, \\"Pear, ripe\\", \\"Plum \\\\\\"Victoria\\\\\\"\\"", got "Apple, Pear, ripe, \\"Plum \\\\\\"Victoria\\\\\\"\\"" \(an Answer or an Approve plan must equal the expected body exactly, updatedInput included\)$/],
    ['answer-questions', (...a) => answerBody(input(sound(...a)), { ...input(sound(...a)).answers, 'Which fruits?': 'Apple, "Pear, ripe", Plum "Victoria"' }), /answers\.Which fruits\?: expected "Apple, \\"Pear, ripe\\", \\"Plum \\\\\\"Victoria\\\\\\"\\"", got "Apple, \\"Pear, ripe\\", Plum \\"Victoria\\""/],
    ['answer-questions', (...a) => answerBody(input(sound(...a)), { ...input(sound(...a)).answers, 'Which fruits?': '"Plum \\"Victoria\\"", Apple, "Pear, ripe"' }), /answers\.Which fruits\?: expected "Apple, \\"Pear, ripe\\", \\"Plum \\\\\\"Victoria\\\\\\"\\"", got "\\"Plum \\\\\\"Victoria\\\\\\"\\", Apple, \\"Pear, ripe\\""/],
    // A question left out reads as unanswered.
    ['answer-questions', (...a) => answerBody(input(sound(...a)), { 'Which fruits?': 'Apple, "Pear, ripe", "Plum \\"Victoria\\""' }), /updatedInput\.answers: no answer for "Which size\?", and every question gets one$/],
    // An Approve plan into another mode, one with the plan edited, and a plain Allow.
    ['plan-approve', (...a) => decision(sound(...a), { updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] }), /updatedPermissions\[0\]\.mode: expected "acceptEdits", got "auto" \(an Answer or an Approve plan must equal/],
    ['plan-approve', (...a) => decision(sound(...a), { updatedInput: { ...input(sound(...a)), plan: '# Plan\n' } }), /updatedInput\.plan: expected "# Plan\\n\\n1\. Create s10\.txt containing: ten\.\\n", got "# Plan\\n" \(an Approve plan's updatedInput is the request's tool_input, unchanged\)$/],
    ['plan-approve', (...a) => decision(sound(...a), { updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' }] }), /updatedPermissions\[0\]\.destination: expected "session", got "localSettings"/],
    ['plan-approve', () => ALLOW, /Claude Code ignores a plain Allow for ExitPlanMode/],
    // A reject sent as an approval.
    ['plan-reject', (key, body) => approvePlanBody(body.tool_input, 'default'), /^line \d+ \(reply\): p1: body\.hookSpecificOutput\.decision\.behavior: expected "deny", got "allow" \(an Answer or an Approve plan must equal/],
  ]
  for (const [name, answer, why] of cases) {
    const { url, driver } = await stubDeck(t, answer)
    const r = await play(readFixture(name), { url, token: 'stub', driver })
    assert.equal(r.ok, false, `${name} should fail with ${why}`)
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

/**
 * What README.md's ladder step 5 says a fixture still checks against a real deck, from its list "By what each fixture
 * still checks against such a deck": the text after the clause that names it, `` `a`, `b` and `c`: what they check. ``,
 * up to the next such clause; null when no clause names it.
 */
function step5Says(name) {
  const readme = fs.readFileSync(path.join(TOOLS, 'README.md'), 'utf8')
  const list = readme.split('By what each fixture still checks against such a deck:\n')[1]?.split('\n\n')[0] ?? ''
  for (const line of list.split('\n').filter((l) => l.startsWith('- '))) {
    for (const m of line.slice(2).matchAll(/((?:`[\w-]+`(?:, | and )?)+): (.*?)(?=(?: (?:`[\w-]+`(?:, | and )?)+: )|$)/g)) {
      if ([...m[1].matchAll(/`([\w-]+)`/g)].some((x) => x[1] === name)) return m[2]
    }
  }
  return null
}

/** The replies and presses a play skipped, without the expect lines the interactive driver always skips. */
const repliesAndPresses = (r) => r.skipped.filter((s) => s.expect === undefined)

/** The expect lines a play skipped, as `[line, fields]`; and the fixture's own, the same way. */
const expectsSkipped = (r) => r.skipped.filter((s) => s.expect !== undefined).map((s) => [s.line, s.expect])
const expectLines = (fx) => fx.lines.filter((l) => l.kind === 'expect').map((l) => [l.n, Object.keys(l.value)])

/**
 * A person at a terminal, scripted: does what PRESS lines say on the fake deck, Approve and Deny keys and Session Slot
 * dials, the only ones the interactive driver asks for, and answers every question with Enter. For a dial, it makes
 * the next of `dials`, each a dial line's value, on the session the line names, which must be the one PRESS names.
 */
function scriptedPerson(control, { dials = [] } = {}) {
  const shown = []
  const asked = []
  const ui = {
    show(text) {
      shown.push(text)
      const key = /^PRESS: press (Approve|Deny)\b/.exec(text)
      if (key) setTimeout(() => void control.call('POST', `/control/${key[1].toLowerCase()}`, {}), 30)
      const dial = /^PRESS: on the Session Slot dial of (\S+),/.exec(text)
      if (dial) {
        const { session, ...press } = dials.shift()
        assert.equal(dial[1], session, 'the dial PRESS names')
        setTimeout(() => void control.call('POST', '/control/dial', { host: session, ...press }), 30)
      }
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
  assert.ok(shown.some((s) => s.startsWith('skip: registry')))
  assert.equal(r.checked, 3, 'the replies to hello, to the press and to the poll at the turn\'s end; expect lines are skipped')
  // Its expect lines are skipped and reported, every one, and nothing is asked: the press has its answer to wait for.
  assert.deepEqual(expectsSkipped(r), expectLines(readFixture('approve')))
  assert.deepEqual(asked, [])
  assert.equal(shown.filter((s) => s.startsWith('CHECK')).length, 0)
  // The poll after the turn's end is answered at once only while the registry says busy, which the skipped lines
  // would have said: the deck holds it, and its reply is skipped and reported.
  assert.deepEqual(repliesAndPresses(r).map((s) => [s.reply, s.why]), [['n2', 'the deck answers it at once only while the registry says busy after the turn ended, and this mode skips registry lines']])
  assert.ok(shown.some((s) => s === '  skip: reply n2, answered at once only while the skipped registry says busy'))

  r = await play(readFixture('answered-in-app-registry'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(repliesAndPresses(r).map((s) => s.reply), ['p1'], 'the reply that waits on a registry change')
  // Its events counted although the bridge saw the same fixture inst and seqs from 1 in the last play: its
  // tool.end released its request.
  const log = runLog(env)
  const insts = new Set(log.filter((e) => e.kind === 'hello' && e.ok).map((e) => e.inst))
  assert.equal(insts.size, 2, 'a fresh inst for each play')
  assert.ok(log.some((e) => e.kind === 'release' && e.rule === 1), 'released by its tool.end')
  assert.equal(log.filter((e) => e.kind === 'events' && e.dropped).length, 0)

  // The same poll in status and prompt-refused, as README.md says: n2. prompt-refused's Saved Prompt press is skipped
  // though this deck lists the session, and so is n3's reply, which expects its command: no person is asked to send
  // a fixture's prompt, since no real deck lists the fixture's session.
  for (const [name, skipped] of [['status', ['n2']], ['prompt-refused', ['n2', 'prompt', 'n3']]]) {
    r = await play(readFixture(name), { url: bridge.url, token: env.token, driver, say })
    assert.equal(r.ok, true, `${name}: ${r.error}\n${shown.join('\n')}`)
    assert.deepEqual(repliesAndPresses(r).map((s) => s.reply ?? s.press), skipped, name)
  }
  assert.ok(shown.includes("skip: press prompt: it would send the fixture's prompt to whichever of your own sessions the dial is on"))
  assert.deepEqual(shown.filter((s) => s.startsWith('PRESS:') && !/^PRESS: press (Approve|Deny)\./.test(s)), [], 'no other press asked for')
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'command'), [], 'and nothing queued')
  assert.deepEqual(asked, [], 'and still nothing asked')

  // Claude Code's requests are sent as they are: only the mod's carry its inst, bound to a fresh one per play. This
  // one is from a `claude` started inside the session, which the deck doesn't confirm, so it gets {} at once.
  const fx = fixtureOf('insts', [
    { plugin: { as: 'h', method: 'POST', path: '/v1/hello', body: { v: 1, sid: SID_A, host: HOST_A, inst: 'ia', cwd: '/s', model: 'm', plugin: '*', cc: '*' } } },
    { reply: { to: 'h', status: 200, body: { v: 1, ok: true } } },
    { plugin: { as: 'p1', method: 'POST', path: '/v1/permission', headers: { 'X-Deck-Host': HOST_A }, body: { session_id: 'sid-child', hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: '/s/a.md' }, inst: 'ia' } } },
    { reply: { to: 'p1', status: 200, body: {} } },
  ])
  r = await play(fx, { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  const sent = runLog(env).filter((e) => e.kind === 'request' && (e.path === '/v1/hello' || e.path === '/v1/permission')).slice(-2)
  assert.deepEqual(sent.map((e) => e.path), ['/v1/hello', '/v1/permission'])
  assert.match(sent[0].body.inst, /^ia-[a-z0-9]+$/, "the mod's")
  assert.equal(sent[1].body.inst, 'ia', "Claude Code's, untouched")
})

test("play: the interactive driver asks for a Session Slot dial press only when something fake-claude sent is held for the dial's session, says what to pick, and checks the answer", async (t) => {
  // A fake bridge whose registry lists the fixtures' sessions, as no real deck's does: it confirms their requests and
  // holds them, so a person can press their dials. The driver still skips the fixtures' registry lines.
  const env = tempEnv(t)
  for (const entry of readFixture('dial-approve').setup.registry) writeRegistry(env, entry.pid, entry)
  const bridge = await startBridge(t, env)
  const control = controlClient(bridge.url, env.token)
  const cases = [
    // [fixture, what PRESS says, replies checked, what's skipped]
    ['answer-question', ['PRESS: on the Session Slot dial of local_test-a, for "Red or blue?" pick "Blue", then send. Its strip should show the session\'s oldest held request: local_test-a: AskUserQuestion Red or blue?.'], 2, []],
    // The picks as the line gives them, out of the options' order: ticked in any order, the Answer joins them in theirs.
    ['answer-questions', ['PRESS: on the Session Slot dial of local_test-a, for "Which fruits?" pick "Plum \\"Victoria\\"" and "Apple" and "Pear, ripe"; for "Which size?" pick "Large", then send. Its strip should show the session\'s oldest held request: local_test-a: AskUserQuestion Which fruits?.'], 2, []],
    ['plan-approve', ['PRESS: on the Session Slot dial of local_test-a, turn to Approve · Accept edits and press. Its strip should show the session\'s oldest held request: local_test-a: ExitPlanMode Plan ready.'], 2, []],
    ['plan-reject', ['PRESS: on the Session Slot dial of local_test-a, turn to Reject and press. Its strip should show the session\'s oldest held request: local_test-a: ExitPlanMode Plan ready.'], 3, []],
    // B asked first, so the Approve key would show B's; A's dial shows A's, which it allows.
    ['dial-approve', [
      'PRESS: on the Session Slot dial of local_test-a, turn to Allow and press. Its strip should show the session\'s oldest held request: local_test-a: Write s9.txt.',
      'PRESS: on the Session Slot dial of local_test-b, turn to Deny and press. Its strip should show the session\'s oldest held request: local_test-b: Bash npm test.',
    ], 2, []],
    // Answered in the app before the press: nothing of fake-claude's is held for the session, so nobody is asked.
    ['dial-gone', [], 2, ['dial']],
  ]
  for (const [name, said, checked, skipped] of cases) {
    const fx = readFixture(name)
    const dials = fx.lines.filter((l) => l.kind === 'press' && l.value.dial).map((l) => l.value.dial)
    const { ui, shown, asked, say } = scriptedPerson(control, { dials })
    const r = await play(fx, { url: bridge.url, token: env.token, driver: interactive({ ui, pressTimeoutMs: 5000 }), say })
    assert.equal(r.ok, true, `${name}: ${r.error}\n${shown.join('\n')}`)
    assert.deepEqual(shown.filter((s) => s.startsWith('PRESS:')), said, name)
    assert.deepEqual([r.checked, repliesAndPresses(r).map((s) => s.reply ?? s.press)], [checked, skipped], name)
    assert.deepEqual(asked, [], `${name}: a reply follows each press, so nothing is asked`)
    if (skipped.length) {
      assert.ok(shown.includes('skip: press dial: nothing fake-claude sent is held for local_test-a'), name)
      assert.match(repliesAndPresses(r)[0].why, /^nothing fake-claude sent is held for local_test-a, so no dial's strip shows a request of the fixture's/)
    } else {
      assert.equal(dials.length, 0, `${name}: every dial pressed`)
    }
  }
  // Each answer went by the dial, none by a key.
  const answered = runLog(env).filter((e) => e.kind === 'answered')
  assert.deepEqual(answered.map((e) => [e.by, e.decision]), [['dial', 'answer'], ['dial', 'answer'], ['dial', 'approve plan'], ['dial', 'deny'], ['dial', 'allow'], ['dial', 'deny']])
})

test("play: the interactive driver skips a Session Slot dial press when what fake-claude sent is held for another session only, and shows no PRESS", async (t) => {
  // B's request is held, as a deck whose registry lists B holds it; the line presses A's dial, whose strip shows
  // nothing of the fixture's. Asked to press it, a person could only land on one of their own sessions' requests.
  const env = tempEnv(t)
  const registry = readFixture('dial-approve').setup.registry
  for (const entry of registry) writeRegistry(env, entry.pid, entry)
  const bridge = await startBridge(t, env)
  const b = registry.find((e) => e.hostSessionId === 'local_test-b')
  const fx = fixtureOf('dial-other-session', [
    { plugin: { as: 'p1', method: 'POST', path: '/v1/permission', headers: { 'X-Deck-Host': b.hostSessionId }, body: { session_id: b.sessionId, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } } } },
    { press: { dial: { session: HOST_A, decision: 'allow' } } },
  ], registry)
  const { ui, shown, asked, say } = scriptedPerson(controlClient(bridge.url, env.token), { dials: [{ session: HOST_A, decision: 'allow' }] })
  const r = await play(fx, { url: bridge.url, token: env.token, driver: interactive({ ui, pressTimeoutMs: 2000 }), say })
  assert.equal(r.ok, true, `${r.error}\n${shown.join('\n')}`)
  assert.deepEqual(r.skipped.map((s) => [s.line, s.press]), [[3, 'dial']])
  assert.match(r.skipped[0].why, /^nothing fake-claude sent is held for local_test-a, so no dial's strip shows a request of the fixture's, and a press could only land on another session's/)
  assert.ok(shown.includes('skip: press dial: nothing fake-claude sent is held for local_test-a'), shown.join('\n'))
  assert.deepEqual(shown.filter((s) => s.startsWith('PRESS:')), [], 'no press asked for')
  assert.deepEqual(asked, [], 'and nothing asked')
  const log = runLog(env)
  assert.deepEqual(log.filter((e) => e.kind === 'held').map((e) => e.host), ['local_test-b'], 'held while the driver looked')
  assert.deepEqual(log.filter((e) => e.kind === 'press' || e.kind === 'answered'), [], 'and nothing pressed or answered')
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
  assert.deepEqual(repliesAndPresses(r).map((s) => [s.press ?? s.reply, s.why === decision]), [['approve', false], ['p1', true], ['n2', false]])
  assert.match(repliesAndPresses(r)[0].why, /^nothing fake-claude sent is held, so a press could only land on another session's request/)
  assert.equal(shown.filter((s) => s.startsWith('PRESS:')).length, 0, 'no press asked for')
  assert.ok(shown.includes('skip: press approve: nothing fake-claude sent is held'))
  assert.ok(shown.includes("  skip: reply p1, answered {} at once: no registry the deck reads confirms the fixture's session"))
  assert.equal(r.checked, 2, 'the replies to hello and to the poll at the turn\'s end')

  // A reply that expects no decision is checked as usual; so is a hook request's from a process that isn't a desktop
  // session. A hello's 409 hangs on the registry.
  r = await play(readFixture('needs-you'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(repliesAndPresses(r).map((s) => s.press ?? s.reply), ['approve'])
  r = await play(readFixture('not-desktop'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(repliesAndPresses(r).map((s) => [s.reply, s.why]), [['h1', "the deck refuses a hello only from a host its registry lists under another sessionId, and this mode skips registry lines: no registry it reads lists the fixture's host"]])
  assert.equal(r.checked, 3, 'p1, p2 and h2')
  // A reply after a registry line is skipped, as README.md says of session-gone's p1.
  r = await play(readFixture('session-gone'), { url: bridge.url, token: env.token, driver, say })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(repliesAndPresses(r).map((s) => [s.reply, s.why]), [['p1', 'it waits on a registry change, which this mode skips']])
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

test('play: the interactive driver skips and reports every Saved Prompt press, and the replies that expect its command, so no person sends a fixture\'s prompt', async (t) => {
  // No real deck lists a fixture's session, so its Sessions dial is on one of the user's own: a press would send the
  // fixture's prompt there. The fake bridge here reads an empty registry, as no real deck's lists them.
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const shown = []
  const asked = []
  const ui = { show: (s) => shown.push(s), ask: async (q) => (asked.push(q), '') }
  const driver = interactive({ ui, pressTimeoutMs: 5000 })
  const cases = [
    // [fixture, what's skipped in order, how many replies are checked]
    ['prompt', ['prompt', 'n1'], 1],
    ['prompt-refused', ['n2', 'prompt', 'n3'], 2],
    ['stray-instance', ['prompt', 'n1'], 2],
    ['hello-again', ['n1', 'n2', 'prompt', 'n3'], 2],
  ]
  for (const [name, skipped, checked] of cases) {
    const started = Date.now()
    const r = await play(readFixture(name), { url: bridge.url, token: env.token, driver, say: (s) => shown.push(s) })
    assert.equal(r.ok, true, `${name}: ${r.error}\n${shown.join('\n')}`)
    assert.deepEqual([repliesAndPresses(r).map((s) => s.reply ?? s.press), r.checked], [skipped, checked], name)
    for (const s of r.skipped.filter((x) => x.press)) assert.match(s.why, /^a Saved Prompt press goes to the session picked on the Sessions dial, and no real deck lists the fixture's session/, name)
    const cmd = r.skipped.find((x) => x.reply && /command/.test(x.why))
    assert.equal(cmd?.why, 'it expects a command that only a Saved Prompt press queues, and the press was skipped', name)
    // A skipped press gives no reply after it a person's time: nothing here waits on one.
    assert.ok(Date.now() - started < 4000, `${name} took ${Date.now() - started} ms`)
  }
  assert.deepEqual(shown.filter((s) => s.startsWith('PRESS:')), [], 'no press asked for')
  assert.deepEqual(runLog(env).filter((e) => e.kind === 'command' || e.kind === 'press'), [], 'and nothing pressed or queued')
  // Nor is a person asked about a key nobody pressed: the expect lines on the commands are skipped like the rest.
  assert.deepEqual(asked, [])
  assert.ok(shown.some((s) => /^skip: expect \{"cmds":\{"c1":/.test(s)), shown.join('\n'))
})

test('play: the interactive driver skips and reports every expect line of every fixture, and asks a person nothing, as against a real deck', async (t) => {
  // A real deck shows nothing of a fixture's session: it lists only its registry's sessions, holds none of the
  // fixture's requests, and has no command of the fixture's, since Saved Prompt presses are skipped. So an
  // expect line, the fixture's deck's state, is about what it doesn't show, and a person asked to check one could
  // only report the deck's own sessions. Played as against a real deck: a bridge whose registry lists none of the
  // fixtures' sessions, never reset between fixtures.
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const shown = []
  const asked = []
  const ui = { show: (s) => shown.push(s), ask: async (q) => (asked.push(q), '') }
  const driver = interactive({ ui, pressTimeoutMs: 5000 })
  let expects = 0
  for (const name of NAMES) {
    const fx = readFixture(name)
    const r = await play(fx, { url: bridge.url, token: env.token, driver, say: (s) => shown.push(`  ${s}`) })
    assert.equal(r.ok, true, `${name}: ${r.error}`)
    assert.deepEqual(expectsSkipped(r), expectLines(fx), `${name}: every expect line skipped and reported, with its fields`)
    for (const s of r.skipped.filter((x) => x.expect !== undefined)) assert.equal(s.why, EXPECT_SKIPPED, name)
    const replies = fx.lines.filter((l) => l.kind === 'reply').length
    assert.equal(r.checked + repliesAndPresses(r).filter((s) => s.reply !== undefined).length, replies, `${name}: only replies are checked`)
    expects += expectLines(fx).length
    // README.md's step-5 list says what each fixture still checks against such a deck: its hello, when one is checked.
    const routes = new Map(fx.lines.filter((l) => l.kind === 'plugin' && l.value.as).map((l) => [l.value.as, l.value.path.split('?')[0]]))
    const skippedReplies = new Set(r.skipped.filter((s) => s.reply !== undefined).map((s) => s.reply))
    const checked = fx.lines.filter((l) => l.kind === 'reply' && !skippedReplies.has(l.value.to)).map((l) => l.value.to)
    const says = step5Says(name)
    assert.notEqual(says, null, `README.md's step-5 list names ${name}`)
    if (checked.some((label) => routes.get(label) === '/v1/hello')) assert.match(says, /hello/, `${name}: README.md says it checks its hello`)
    assert.equal(/^nothing\b/.test(says), checked.length === 0, `${name}: README.md says "${says}", and it checks ${checked.join(', ') || 'nothing'}`)
  }
  assert.ok(expects >= NAMES.length, `the fixtures have ${expects} expect lines`)
  assert.deepEqual(asked, [], 'no question at all')
  assert.deepEqual(shown.filter((s) => /^(CHECK|PRESS)/.test(s)), [])
  assert.equal(shown.filter((s) => s.startsWith('skip: expect ')).length, expects, 'a skip line for each')
})

/**
 * A deck that answers each of the plugin's routes as `answers[route](body)` says, `[status, json, delayMs]`, and every
 * other with 204, for the interactive driver's skips. Polls are held.
 */
async function scriptedDeck(t, answers) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const route = new URL(req.url, 'http://stub').pathname
      if (route === ROUTES.next) return
      const text = Buffer.concat(chunks).toString('utf8')
      const [status, json, delayMs = 0] = answers[route]?.(text ? JSON.parse(text) : undefined) ?? [204]
      setTimeout(() => {
        res.writeHead(status, json === undefined ? {} : { 'content-type': 'application/json' })
        res.end(json === undefined ? undefined : JSON.stringify(json))
      }, delayMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

test("play: the interactive driver skips a hook's reply only when it expects a decision, and the answer is {} that came within 0.5 s of the request by the client's own measure; a hello's only when it expects 409 and got ok", async (t) => {
  // Each condition of the skip, broken on its own: the reply is checked, and passes or fails on what came.
  const quiet = interactive({ ui: { show: () => {}, ask: async () => '' }, pressTimeoutMs: 1000 })
  const permission = (expected) => fixtureOf('permission', [
    { plugin: { as: 'p1', method: 'POST', path: '/v1/permission', headers: { 'X-Deck-Host': HOST_A }, body: { session_id: SID_A, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } } } },
    { reply: { to: 'p1', status: 200, body: expected } },
  ])
  const hello = (status, body) => fixtureOf('hello409', [
    { plugin: { as: 'h', method: 'POST', path: '/v1/hello', body: { v: 1, sid: SID_A, host: HOST_A, inst: 'ia', cwd: '/s', model: 'm', plugin: '*', cc: '*' } } },
    { reply: { to: 'h', status, body } },
  ])
  const skippedOnce = (to) => [[to], 0, true]
  const cases = [
    // [what, fixture, route answered, answer, [skipped replies, checked, ok], why it failed]
    ['{} at once', permission(ALLOW), ROUTES.permission, [200, {}, 0], skippedOnce('p1')],
    // The old runner looked 100 ms after sending: an answer after a slow second reading counted as held then.
    ['{} after 250 ms, still at once', permission(ALLOW), ROUTES.permission, [200, {}, 250], skippedOnce('p1')],
    ['{} after 700 ms, not at once', permission(ALLOW), ROUTES.permission, [200, {}, 700], [[], 0, false], /^line 3 \(reply\): p1: body\.hookSpecificOutput: missing/],
    ['Deny at once, not {}', permission(ALLOW), ROUTES.permission, [200, DENY, 0], [[], 0, false], /p1: body\.hookSpecificOutput\.decision\.behavior: expected "allow", got "deny"/],
    ['an error at once, not {}', permission(ALLOW), ROUTES.permission, [500, { error: 'x' }, 0], [[], 0, false], /p1: status: expected 200, got 500/],
    ['Allow at once', permission(ALLOW), ROUTES.permission, [200, ALLOW, 0], [[], 1, true]],
    ['{} at once, which the line expects', permission({}), ROUTES.permission, [200, {}, 0], [[], 1, true]],
    ['a hello\'s ok, where the line expects 409', hello(409, { error: 'not this session' }), ROUTES.hello, [200, { v: 1, ok: true }, 0], skippedOnce('h')],
    ['a hello\'s 409, as the line expects', hello(409, { error: 'not this session' }), ROUTES.hello, [409, { error: 'not this session' }, 0], [[], 1, true]],
    ['a hello\'s version refusal, where the line expects 409', hello(409, { error: 'not this session' }), ROUTES.hello, [200, { v: 2, ok: false, error: 'version' }, 0], [[], 0, false], /h: status: expected 409, got 200/],
    ['a hello\'s ok, as the line expects', hello(200, { v: 1, ok: true }), ROUTES.hello, [200, { v: 1, ok: true }, 0], [[], 1, true]],
  ]
  for (const [what, fx, route, answer, [skipped, checked, ok], why] of cases) {
    const url = await scriptedDeck(t, { [route]: () => answer })
    const r = await play(fx, { url, token: 'stub', driver: quiet })
    assert.deepEqual([r.skipped.map((s) => s.reply), r.checked, r.ok], [skipped, checked, ok], `${what}: ${r.error}`)
    if (why) assert.match(r.error, why, what)
  }
})

test('play: the interactive driver asks for an Approve or Deny press only when a request fake-claude sent has had no answer HOOK_AT_ONCE_MS after it was sent, by its own clock', async (t) => {
  // A deck that doesn't confirm the request's session answers it {} at once, after one more reading of its registry
  // at most. A slow reading isn't a held request: the driver doesn't decide by how long it slept after sending.
  assert.deepEqual([P.HOOK_AT_ONCE_MS, Object.hasOwn(P, 'AT_ONCE_MS')], [500, false], "not to be confused with protocol.mjs's AT_ONCE_MS")
  const fx = fixtureOf('press', [
    { plugin: { as: 'p1', method: 'POST', path: '/v1/permission', headers: { 'X-Deck-Host': HOST_A }, body: { session_id: SID_A, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } } } },
    { press: { approve: {} } },
    { reply: { to: 'p1', status: 200, body: ALLOW } },
  ])
  for (const [delayMs, asked, ok] of [[0, false, true], [250, false, true], [700, true, false]]) {
    const shown = []
    const driver = interactive({ ui: { show: (s) => shown.push(s), ask: async () => '' }, pressTimeoutMs: 1500 })
    const url = await scriptedDeck(t, { [ROUTES.permission]: () => [200, {}, delayMs] })
    const r = await play(fx, { url, token: 'stub', driver })
    const pressed = shown.some((s) => s.startsWith('PRESS: press Approve.'))
    assert.deepEqual([pressed, r.ok], [asked, ok], `{} after ${delayMs} ms: ${r.error}\n${shown.join('\n')}`)
    if (!asked) {
      assert.deepEqual(r.skipped.map((s) => s.press ?? s.reply), ['approve', 'p1'])
      assert.ok(shown.includes('skip: press approve: nothing fake-claude sent is held'))
    } else {
      assert.match(r.error, /^line 4 \(reply\): p1: body\.hookSpecificOutput: missing/, 'held past the threshold, then answered {}: checked as it is')
    }
  }
})

test('play: the interactive driver skips a poll\'s 409 hello first only when a skipped registry line removed the session\'s file since its hello; any other is checked', async (t) => {
  // hello-again's n2: the fixture's deck forgot the session when its file went (release rule 4). A deck that reads
  // another registry never did, and holds the poll. A 409 for a session no instance said hello for is checked.
  const env = tempEnv(t)
  const bridge = await startBridge(t, env)
  const driver = interactive({ ui: { show: () => {}, ask: async () => '' }, pressTimeoutMs: 1000 })
  const next = (as, wait = 20) => ({ plugin: { as, method: 'GET', path: `/v1/next?sid=${SID_A}&host=${HOST_A}&inst=ia&wait=${wait}` } })
  const first = (to) => ({ reply: { to, status: 409, body: { error: 'hello first' } } })
  const helloLine = { plugin: { method: 'POST', path: '/v1/hello', body: { v: 1, sid: SID_A, host: HOST_A, inst: 'ia', cwd: '/s', model: 'm', plugin: '*', cc: '*' } } }
  const file = { pid: 101, sessionId: SID_A, hostSessionId: HOST_A, status: 'idle', statusUpdatedAt: T0 }
  // Before any hello: the deck asks for one, and the reply is checked.
  let r = await play(fixtureOf('before-hello', [next('n1'), first('n1')], [file]), { url: bridge.url, token: env.token, driver })
  assert.deepEqual([r.ok, r.checked, r.skipped], [true, 1, []], r.error)
  // A registry line that removes another session's file forgets nothing of this one.
  r = await play(fixtureOf('other-gone', [
    { registry: { pid: 202, gone: true } }, next('n1'), first('n1'),
  ], [file, { pid: 202, sessionId: 'sid-b', hostSessionId: 'local_test-b', status: 'idle', statusUpdatedAt: T0 }]), { url: bridge.url, token: env.token, driver })
  assert.deepEqual([r.ok, r.checked, r.skipped], [true, 1, []], r.error)
  // Nor does one that removes one of two files listing this session's host: the other still lists it (release rule 4).
  r = await play(fixtureOf('one-of-two-gone', [
    helloLine, { registry: { pid: 101, gone: true } }, next('n1', 0), first('n1'),
  ], [file, { ...file, pid: 102, startedAt: T0 + 5 }]), { url: bridge.url, token: env.token, driver })
  assert.deepEqual([r.ok, r.skipped], [false, []], 'checked, not skipped')
  assert.match(r.error, /^line 5 \(reply\): n1: status: expected 409, got 200 \{"cmds":\[\]\}$/, 'and this deck, which has the hello, answers the poll')
  // Removed, then a hello: the deck has one from the mod again, so a 409 after it is checked too, and this deck, which
  // answers the poll (wait 0) with none, fails it.
  r = await play(fixtureOf('gone-then-hello', [
    { registry: { pid: 101, gone: true } }, { registry: { pid: 101, ...file } }, helloLine, next('n1', 0), first('n1'),
  ], [file]), { url: bridge.url, token: env.token, driver })
  assert.deepEqual([r.ok, r.skipped], [false, []])
  assert.match(r.error, /^line 6 \(reply\): n1: status: expected 409, got 200 \{"cmds":\[\]\}$/)
  // hello-again itself: n2 is skipped, and reported.
  r = await play(readFixture('hello-again'), { url: bridge.url, token: env.token, driver })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.skipped.find((s) => s.reply === 'n2')?.why, "the deck asks for a hello first only for a session it forgot, as at release rule 4 when the session's registry file goes, and this mode skips registry lines")
})
