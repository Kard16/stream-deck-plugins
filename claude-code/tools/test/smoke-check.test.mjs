// smoke-check.mjs against a synthetic deck log made from the deck's own line formats (claude-code/deck/src, and the
// Phase 7 live test's log): a whole smoke test of a throwaway session T, with a session of the user's, U, pressing
// beside it, and lines before the window. Files go in temp folders; nothing here reads the deck's real log.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as C from '../smoke-check.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'smoke-check.mjs')
const D = '7649d20de0e42bd46f0da00edaec8718'
/** The throwaway session; a session of the user's, which the main thread runs in; one of theirs the update stopped; and the one T's long press replaces. */
const T = 'local_7e57c0de-0000-4000-8000-00000000000a'
const U = 'local_0a0a0a0a-1111-2222-3333-444444444444'
const STOPPED = 'local_5b5b5b5b-1111-2222-3333-444444444444'
const X = 'local_33baf43b-1111-2222-3333-444444444444'
const T0 = Date.parse('2026-11-06T05:00:00.000Z')
const SINCE = '2026-11-06T05:00:00Z'
/** A line as the SDK's logger writes it, `ms` after T0. */
const line = (ms, level, scope, message) => `${new Date(T0 + ms).toISOString()} ${level.padEnd(5)} ${scope}: ${message}`
const info = (ms, scope, message) => line(ms, 'INFO', scope, message)
const debug = (ms, scope, message) => line(ms, 'DEBUG', scope, message)

/** The deck's log through a whole smoke test, steps 1 to 14 in the doc's order, from an hour before T0. */
const LOG = [
  info(-3_600_000, 'Claude', 'STARTUP {"pid":55211,"node":"v24.22.1","t":1793937639449,"version":"0.5.0.0","log":"debug"}'),
  info(-3_600_000, 'Claude', 'token: using run/token'),
  info(-3_600_000, 'Slots', `SLOTS loaded: ${D}:1:0 ${X}, ${D}:1:1 ${U}, ${D}:1:2 ${STOPPED}`),
  info(-3_600_000, 'Bridge', 'listening on 127.0.0.1:47600'),
  info(-3_600_000, 'Registry', '2 session(s) running'),
  info(-3_600_000, 'Sessions', `HELLO ${U} inst "f787f03f0703" plugin "0.3.0" cc "2.1.317"`),
  info(-3_600_000, 'Sessions', `HELLO ${STOPPED} inst "7975ae77fe06" plugin "0.3.0" cc "2.1.317"`),
  // Before the window: proves nothing.
  info(-1_800_000, 'Sessions', `HELD #1 tool "Bash" "ls" fp 11111111 from ${U}; 1 held`),
  info(-1_799_000, 'Sessions', 'ANSWER #1 "Bash": allow, from a key press; 0 held'),
  // The app restarts for its update: every session ends, and the stopped one's dying mod says hello once more.
  info(-600_000, 'Registry', '0 session(s) running'),
  info(-600_000, 'Sessions', `ENDED ${U}: no registry file lists it any more`),
  info(-600_000, 'Sessions', `ENDED ${STOPPED}: no registry file lists it any more`),
  info(-599_900, 'Sessions', `HELLO ${STOPPED} inst "7975ae77fe06" plugin "0.3.0" cc "2.1.317"; the registry doesn't list it yet`),
  // The app comes back, and starts the session it shows.
  info(-300_000, 'Registry', '1 session(s) running'),
  info(-300_000, 'Sessions', `HELLO ${U} inst "0d6484b65d47" plugin "0.3.0" cc "2.1.320"`),
  debug(-1_000, 'Sessions', `POLL ${U} wait 20 s`),
  // 1. A jump starts a stopped session.
  info(10_000, 'Sessions', `TARGET ${STOPPED}: picked on slot key ${D}:1:2`),
  info(10_000, 'Keys', `jump ${STOPPED} via slot key ${D}:1:2: "Lightroom plugin feedback"`),
  info(10_064, 'Jump', `opened claude://code/continue?session=${STOPPED} in 64 ms`),
  info(13_000, 'Registry', '2 session(s) running'),
  info(13_200, 'Sessions', `HELLO ${STOPPED} inst "abe1f4d62c9d" plugin "0.3.0" cc "2.1.320"`),
  // T starts, and asks.
  info(30_000, 'Registry', '3 session(s) running'),
  info(30_100, 'Sessions', `HELLO ${T} inst "a1b2c3d4e5f6" plugin "0.3.0" cc "2.1.320"`),
  debug(31_000, 'Sessions', `EVENT ${T} turn.start`),
  debug(31_000, 'Sessions', `STATUS ${T} → working`),
  debug(32_000, 'Sessions', `EVENT ${T} tool.start "Bash" fp 2a2a2a2a`),
  info(32_100, 'Sessions', `HELD #2 tool "Bash" "echo one > smoke-1.txt" fp 2a2a2a2a from ${T}; 1 held`),
  debug(32_100, 'Sessions', `STATUS ${T} working → approval`),
  // 2. A jump from Others.
  info(40_000, 'Sessions', `TARGET ${T}: picked on the Others key`),
  info(40_000, 'Keys', `jump ${T} via the Others key: "Deck smoke test"`),
  info(40_061, 'Jump', `opened claude://code/continue?session=${T} in 61 ms`),
  debug(40_130, 'Sessions', `EVENT ${T} attach`),
  debug(40_500, 'Sessions', `EVENT ${U} detach`),
  // 3. A long press.
  info(50_000, 'Slots', `SLOT ${D}:1:0 ← ${T} (long press), in place of ${X}`),
  // 4. An approval on the dial.
  info(60_000, 'Sessions', 'ANSWER #2 "Bash": allow, from its session\'s dial; 0 held'),
  info(60_001, 'Dials', `slot dial ${D}:1:0 press: sent allow for #2 "Bash" of ${T}`),
  debug(60_500, 'Sessions', `EVENT ${T} tool.end "Bash" fp 2a2a2a2a`),
  debug(62_000, 'Sessions', `EVENT ${T} turn.end`),
  // The user's own press on the Approve key, for U: no proof for T.
  info(70_000, 'Sessions', `HELD #3 tool "Bash" "npm test" fp 3c3c3c3c from ${U}; 1 held`),
  info(75_000, 'Sessions', 'ANSWER #3 "Bash": allow, from a key press; 0 held'),
  // 5. A question on the dial.
  debug(90_000, 'Sessions', `EVENT ${T} turn.start`),
  debug(91_000, 'Sessions', `EVENT ${T} tool.start "AskUserQuestion" fp 4d4d4d4d`),
  info(91_100, 'Sessions', `HELD #4 ask "AskUserQuestion" "Red or blue?" fp 4d4d4d4d from ${T}; 1 held`),
  info(100_000, 'Sessions', String.raw`ANSWER #4 "AskUserQuestion": answered "{\"Red or blue?\":\"Blue\"}", from its session's dial; 0 held`),
  info(100_001, 'Dials', `slot dial ${D}:1:0 press: sent answers for #4 "AskUserQuestion" of ${T}`),
  debug(103_000, 'Sessions', `EVENT ${T} turn.end`),
  // 6. A plan into Manual.
  debug(121_000, 'Sessions', `EVENT ${T} turn.start`),
  info(125_000, 'Sessions', `HELD #5 ask "ExitPlanMode" "Plan ready" fp 5e5e5e5e from ${T}; 1 held`),
  info(135_000, 'Sessions', 'ANSWER #5 "ExitPlanMode": plan approved into default, from its session\'s dial; 0 held'),
  // 7. The Approve key.
  debug(137_000, 'Sessions', `EVENT ${T} tool.start "Write" fp 6f6f6f6f`),
  info(137_100, 'Sessions', `HELD #6 tool "Write" "smoke-3.txt" fp 6f6f6f6f from ${T}; 1 held`),
  info(145_000, 'Sessions', 'ANSWER #6 "Write": allow, from a key press; 0 held'),
  info(145_002, 'Dials', `slot dial ${D}:1:0: #6 left the strip, unanswered here; a press within 1000 ms alerts, unless the strip shows a newer request first`),
  debug(148_000, 'Sessions', `EVENT ${T} turn.end`),
  // 8. A Deny: the mod's fetches are abandoned, so it says hello again, then the turn ends.
  debug(160_000, 'Sessions', `EVENT ${T} turn.start`),
  debug(161_000, 'Sessions', `EVENT ${T} tool.start "Bash" fp 7a7a7a7a`),
  info(161_100, 'Sessions', `HELD #7 tool "Bash" "echo four > smoke-4.txt" fp 7a7a7a7a from ${T}; 1 held`),
  info(170_000, 'Sessions', 'ANSWER #7 "Bash": deny, from a key press; 0 held'),
  debug(171_100, 'Sessions', `HELLO ${T} inst "a1b2c3d4e5f6" again: its cwd and model taken, its mode and effort not`),
  debug(171_200, 'Sessions', `EVENT ${T} tool.end "Bash" fp 7a7a7a7a`),
  debug(171_300, 'Sessions', `EVENT ${T} turn.end`),
  // U's request let go by rule 2, and U reads needs-you again with nothing held: what the watch is for.
  info(180_000, 'Sessions', `HELD #8 tool "Bash" "git status" fp 8b8b8b8b from ${U}; 1 held`),
  info(185_000, 'Sessions', 'RELEASED #8 "Bash": the registry shows the session no longer waiting (rule 2); 0 held'),
  debug(185_010, 'Sessions', `STATUS ${U} approval → working`),
  debug(185_600, 'Sessions', `STATUS ${U} working → needs-you`),
  line(186_000, 'WARN', 'Front', 'front app check: lsappinfo front failed: Error: spawn EAGAIN; counted as not in front'),
  line(187_000, 'ERROR', 'Slots', 'slots refresh failed: TypeError: x is not a function'),
  '    at Slots.refresh (file:///x/bin/plugin.js:1:1)',
  // 9. Answered in the app, and let go by rule 1.
  debug(200_000, 'Sessions', `EVENT ${T} turn.start`),
  info(201_000, 'Sessions', `HELD #9 tool "Bash" "echo six > smoke-6.txt" fp 9c9c9c9c from ${T}; 1 held`),
  debug(210_000, 'Sessions', `EVENT ${T} tool.end "Bash" fp 9c9c9c9c`),
  info(210_001, 'Sessions', 'RELEASED #9 "Bash": the session reported the call\'s end (rule 1, fp 9c9c9c9c); 0 held'),
  debug(212_000, 'Sessions', `EVENT ${T} turn.end`),
  // 10. A jump from a slot key, with another session on screen.
  info(230_000, 'Sessions', `TARGET ${T}: picked on slot key ${D}:1:0`),
  info(230_000, 'Keys', `jump ${T} via slot key ${D}:1:0: "Deck smoke test"`),
  info(230_058, 'Jump', `opened claude://code/continue?session=${T} in 58 ms`),
  debug(230_120, 'Sessions', `EVENT ${T} attach`),
  debug(230_500, 'Sessions', `EVENT ${U} detach`),
  // 11. A Saved Prompt, and 12. seen, as its reply ends with T on screen and Claude in front.
  info(240_000, 'Keys', `Saved Prompt: c1 for "Deck smoke test" (${T})`),
  info(240_000, 'Sessions', `QUEUED c1 prompt (23 characters) for ${T}`),
  debug(240_010, 'Sessions', `DELIVERED c1 to ${T}`),
  debug(240_050, 'Sessions', 'RESULT c1 waiting'),
  info(240_300, 'Sessions', 'RESULT c1 done'),
  info(240_310, 'Keys', 'Saved Prompt c1: done'),
  debug(240_400, 'Sessions', `EVENT ${T} turn.start`),
  debug(243_000, 'Sessions', `EVENT ${T} turn.end`),
  debug(243_600, 'Sessions', `STATUS ${T} working → done`),
  debug(243_620, 'Sessions', `SEEN ${T}: on screen with Claude in front`),
  // 13. A swap, and back.
  info(260_000, 'Slots', `SLOT ${D}:1:0 ← ${U} (long press), from ${D}:1:1, which takes ${T}`),
  debug(261_000, 'Sessions', `SEEN ${U}: on screen with Claude in front`),
  info(265_000, 'Keys', `jump ${T} via slot key ${D}:1:1: "Deck smoke test"`),
  info(265_060, 'Jump', `opened claude://code/continue?session=${T} in 60 ms`),
  info(270_000, 'Slots', `SLOT ${D}:1:0 ← ${T} (long press), from ${D}:1:1, which takes ${U}`),
  debug(300_000, 'Sessions', `POLL ${T} wait 20 s`),
  '',
]

const at = (ms) => new Date(T0 + ms).toISOString()
/** The LOG's line at `ms` with `words` in it. */
const find = (ms, words, lines = LOG) => {
  const found = lines.find((l) => l.startsWith(at(ms)) && l.includes(words))
  assert.ok(found, `no line at ${ms} with ${words}`)
  return found
}
/** The LOG without its lines at `ms` that have `words`. */
const without = (ms, words, lines = LOG) => lines.filter((l) => !(l.startsWith(at(ms)) && l.includes(words)))
const report = (lines = LOG, opts = {}) => C.buildReport(lines.join('\n'), { since: T0, host: T, vendored: '2.1.317', ...opts })
const step = (r, id) => r.steps.find((s) => s.id === id)

function logFile(text = LOG.join('\n'), name = 'com.karimdhanji.claude.0.log', dir = null) {
  const into = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-check-'))
  if (dir === null) test.after(() => fs.rmSync(into, { recursive: true, force: true }))
  const file = path.join(into, name)
  fs.writeFileSync(file, text)
  return file
}

/** main() with the output stood in for. */
function run(argv, deps = {}) {
  let out = ''
  let err = ''
  const code = C.main(argv, { vendored: '2.1.317', ...deps, out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err }
}

test("smoke-check: reads the deck's lines by their scope and words, as the deck writes them", () => {
  // Lines from the Phase 7 live test's log (2026-11-05), as the deck wrote them.
  const kind = (raw) => C.classify(raw)?.kind
  assert.equal(kind('2026-11-05T04:12:18.999Z INFO  Sessions: HELD #1 ask "AskUserQuestion" "Red or blue?" fp 7e440372 from local_f47631fd-b9eb-47e4-8811-fbb72d5a2ce6; 1 held'), 'held')
  const answer = C.classify(String.raw`2026-11-05T04:13:01.351Z INFO  Sessions: ANSWER #1 "AskUserQuestion": answered "{\"Red or blue?\":\"Blue\"}", from its session's dial; 0 held`)
  assert.deepEqual([answer.kind, answer.m[1], answer.m[3], answer.m[4]], ['answer', '1', String.raw`answered "{\"Red or blue?\":\"Blue\"}"`, "its session's dial"])
  assert.equal(kind('2026-11-06T01:34:03.440Z INFO  Sessions: RELEASED #1 "AskUserQuestion": the session reported the call\'s end (rule 1, fp 807d8593); 0 held'), 'released')
  assert.equal(kind('2026-11-05T04:08:29.094Z INFO  Sessions: HELLO local_d3772792-58f9-45e2-9172-949814d0265a inst "2433a5e4ad88" plugin "0.2.1" cc "2.1.317"'), 'hello')
  // A slot id has colons, and the title comes after one.
  const jump = C.classify('2026-11-05T04:12:53.920Z INFO  Keys: jump local_f47631fd-b9eb-47e4-8811-fbb72d5a2ce6 via slot key 7649d20de0e42bd46f0da00edaec8718:1:1: "Deck test T7: dial answers live"')
  assert.deepEqual([jump.kind, jump.m[2]], ['jump', 'slot key 7649d20de0e42bd46f0da00edaec8718:1:1'])
  assert.equal(C.classify('2026-11-05T04:18:56.178Z INFO  Dials: jump local_bd3145de-853b-4e2b-906f-e944580a1eb9 via slot dial 7649d20de0e42bd46f0da00edaec8718:1:3 (tap): "Deck test T5: answers from the deck"').m[2], 'slot dial 7649d20de0e42bd46f0da00edaec8718:1:3 (tap)')
  assert.equal(kind('2026-11-05T04:12:53.982Z INFO  Jump: opened claude://code/continue?session=local_f47631fd-b9eb-47e4-8811-fbb72d5a2ce6 in 62 ms'), 'opened')
  const slot = C.classify('2026-11-05T04:19:32.579Z INFO  Slots: SLOT 7649d20de0e42bd46f0da00edaec8718:1:3 ← local_5b9b4bbb-84eb-45ea-a7d6-c676cea9e758 (long press), in place of local_bd3145de-853b-4e2b-906f-e944580a1eb9')
  assert.deepEqual([slot.kind, slot.m[5]], ['slot', 'local_bd3145de-853b-4e2b-906f-e944580a1eb9'])
  // Lines the steps don't read: a hello said again, a fill, a press queued, and a known word in another scope.
  assert.equal(kind(find(171_100, 'again')), null)
  assert.equal(kind('2026-11-05T04:11:02.047Z INFO  Slots: SLOT 7649d20de0e42bd46f0da00edaec8718:1:1 ← local_f47631fd-b9eb-47e4-8811-fbb72d5a2ce6 (fill: the newest): "Deck test T7: dial answers live"'), null)
  assert.equal(kind(find(240_000, 'Saved Prompt: c1')), null)
  assert.equal(kind(info(0, 'Keys', 'ANSWER #2 "Bash": allow, from a key press; 0 held')), null)
  assert.equal(C.classify('    at Slots.refresh (file:///x/bin/plugin.js:1:1)'), null)
})

test('smoke-check: a whole run proves all 14 steps, each with the lines that prove it', () => {
  const r = report()
  assert.deepEqual(r.summary, { ok: 14, missing: 0 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  // Lines with a time at or after T0: not the stack trace's, nor the end's empty one.
  assert.deepEqual(r.window, { since: at(0), to: at(300_000), host: T, lines: LOG.filter((l) => /^\d{4}-/.test(l) && l >= at(0)).length })
  // Step 1 is the stopped session's, though --host names T: its jump, the open, and the hello of its new process.
  assert.deepEqual(step(r, 'stopped').lines, [find(10_000, 'jump'), find(10_064, 'opened'), find(13_200, 'HELLO')])
  assert.equal(step(r, 'stopped').detail, 'opened in 64 ms, and its hello came 3.2 s after the press')
  assert.deepEqual(step(r, 'others').lines, [find(40_000, 'jump'), find(40_061, 'opened'), find(40_130, 'attach')])
  assert.equal(step(r, 'others').detail, 'opened in 61 ms, and the app showed it 130 ms after the press')
  assert.deepEqual(step(r, 'long-press').lines, [find(50_000, 'SLOT')])
  assert.deepEqual(step(r, 'dial-allow').lines, [find(60_000, 'ANSWER')])
  assert.deepEqual(step(r, 'question').lines, [find(100_000, 'ANSWER')])
  assert.deepEqual(step(r, 'plan').lines, [find(135_000, 'ANSWER')])
  assert.deepEqual(step(r, 'approve-key').lines, [find(145_000, 'ANSWER')], "T's press, not U's before it")
  assert.deepEqual(step(r, 'deny').lines, [find(170_000, 'ANSWER'), find(171_300, 'turn.end')])
  assert.equal(step(r, 'deny').detail, 'the turn ended 1.3 s later, with no other call')
  assert.deepEqual([step(r, 'in-app').lines, step(r, 'in-app').detail], [[find(210_001, 'RELEASED')], "#9, by rule 1: the call's end"])
  assert.deepEqual(step(r, 'slot-jump').lines, [find(230_000, 'jump'), find(230_058, 'opened'), find(230_120, 'attach')])
  assert.deepEqual([step(r, 'prompt').lines, step(r, 'prompt').detail], [[find(240_310, 'Saved Prompt c1')], 'c1, done 310 ms after it was queued'])
  assert.deepEqual(step(r, 'seen').lines, [find(243_620, 'SEEN')])
  assert.deepEqual([step(r, 'swap').lines, step(r, 'swap').detail], [[find(260_000, 'SLOT'), find(270_000, 'SLOT')], '2 swap(s)'])
  assert.deepEqual([step(r, 'version').lines, step(r, 'version').detail], [[find(30_100, 'HELLO')], "2.1.320, newer than the vendored reference's 2.1.317: expect the mark"])
  // What only the user can tell, for the steps that have it.
  assert.deepEqual(r.steps.filter((s) => s.see !== null).map((s) => s.n), [1, 2, 4, 5, 6, 8, 10, 14])
  assert.deepEqual(r.notes, [])
})

test("smoke-check: --host, only the session's lines prove a step, but for step 1's, which any session's can", () => {
  const all = report(LOG, { host: null })
  assert.equal(all.summary.ok, 14)
  assert.deepEqual(step(all, 'approve-key').lines, [find(75_000, 'ANSWER')], "U's press comes first")
  assert.deepEqual(step(all, 'version').lines, [find(30_100, 'HELLO')], 'the last hello in the window')
  // For U: its key press, its rule 2 release, its SEEN, and the swaps, which are long presses too.
  const u = report(LOG, { host: U })
  assert.deepEqual(u.steps.filter((s) => s.status === 'ok').map((s) => s.id), ['stopped', 'long-press', 'approve-key', 'in-app', 'seen', 'swap'])
  assert.deepEqual(step(u, 'approve-key').lines, [find(75_000, 'ANSWER')])
  assert.deepEqual(step(u, 'long-press').lines, [find(260_000, 'SLOT')])
  assert.equal(step(u, 'version').detail, 'no hello from it in the window', "U's hello came before the window")
  assert.equal(step(u, 'deny').detail, 'no Deny, from a key or a slot dial')
  assert.equal(u.ok, false)
})

test('smoke-check: the window, the lines before --since give context but prove nothing', () => {
  // Every line after the window's start: nothing in it.
  const late = report(LOG, { since: T0 + 400_000, host: null })
  assert.deepEqual([late.summary, late.window.to, late.window.lines], [{ ok: 0, missing: 14 }, null, 0])
  // The stopped session ended before the window, so its jump in the window started it.
  const running = report(without(-600_000, `ENDED ${STOPPED}`))
  assert.equal(step(running, 'stopped').detail, "no jump to a session that wasn't running: press a slot key that reads Not running")
  // A dying mod's hello, which the registry doesn't list, doesn't make its session running again.
  assert.equal(step(report(), 'stopped').status, 'ok')
  const relisted = LOG.map((l) => (l.startsWith(at(-599_900)) ? l.replace("; the registry doesn't list it yet", '') : l))
  assert.equal(step(report(relisted), 'stopped').status, 'missing')
})

test('smoke-check: a missing proof says why, with the nearest lines', () => {
  // The stopped session's jump with no hello after it.
  const noHello = step(report(without(13_200, 'HELLO')), 'stopped')
  assert.deepEqual([noHello.status, noHello.lines], ['missing', [find(10_000, 'jump')]])
  assert.equal(noHello.detail, `${STOPPED} wasn't running at the jump at 05:00:10.000, but no hello from it followed within 120 s`)
  // A Deny whose turn doesn't end: the next turn's end, 42 s later, isn't its.
  assert.equal(step(report(without(171_300, 'turn.end')), 'deny').detail, 'the turn of the Deny at 05:02:50.000 has no turn.end within 60 s, before the next turn.start')
  const lastDeny = LOG.slice(0, LOG.indexOf(find(171_300, 'turn.end')))
  assert.equal(step(report(lastDeny), 'deny').detail, 'the turn of the Deny at 05:02:50.000 has no turn.end within 60 s')
  // A Deny whose turn goes on: another call, or another request.
  const goesOn = [...LOG.slice(0, LOG.indexOf(find(171_300, 'turn.end'))), debug(171_250, 'Sessions', `EVENT ${T} tool.start "Bash" fp 7b7b7b7b`), ...LOG.slice(LOG.indexOf(find(171_300, 'turn.end')))]
  const on = step(report(goesOn), 'deny')
  assert.deepEqual([on.status, on.detail], ['missing', 'the turn went on after the Deny at 05:02:50.000: another call started before its end'])
  assert.equal(on.lines.length, 3)
  const asks = [...LOG.slice(0, LOG.indexOf(find(171_300, 'turn.end'))), info(171_250, 'Sessions', `HELD #10 tool "Bash" "echo five > smoke-5.txt" fp 7b7b7b7b from ${T}; 1 held`), ...LOG.slice(LOG.indexOf(find(171_300, 'turn.end')))]
  assert.equal(step(report(asks), 'deny').detail, 'the turn went on after the Deny at 05:02:50.000: another call started before its end')
  // The denied call's own tool.start, landing late, isn't the turn going on.
  const late = goesOn.map((l) => l.replace('fp 7b7b7b7b', 'fp 7a7a7a7a'))
  assert.equal(step(report(late), 'deny').status, 'ok')
  // A subagent's call isn't the main loop's turn going on.
  const agent = goesOn.map((l) => (l.includes('fp 7b7b7b7b') ? `${l} agent "a1b2"` : l))
  assert.equal(step(report(agent), 'deny').status, 'ok')
  // A slot key's jump the app never showed: the key's session was on screen already, say.
  const shown = step(report(without(230_120, 'attach')), 'slot-jump')
  assert.deepEqual([shown.status, shown.lines], ['missing', [find(230_000, 'jump'), find(230_058, 'opened')]])
  assert.match(shown.detail, /^the jump at 05:03:50\.000 opened in 58 ms, but no attach followed within 5 s: was the session on screen already\?$/)
  assert.equal(step(report(without(230_120, 'attach')), 'others').status, 'ok')
  // A jump with no "opened" line: /usr/bin/open failed.
  assert.equal(step(report(without(40_061, 'opened')), 'others').detail, 'the jump at 05:00:40.000 has no "opened" line within 5 s')
  // A plan into another mode than Manual.
  const auto = step(report(LOG.map((l) => l.replace('plan approved into default', 'plan approved into acceptEdits'))), 'plan')
  assert.deepEqual([auto.status, auto.detail], ['missing', 'the plan\'s answer was "plan approved into acceptEdits", not "plan approved into default"'])
  // A Saved Prompt the engine dropped.
  const dropped = LOG.map((l) => l.replace('Saved Prompt c1: done', 'Saved Prompt c1: refused: "dropped: the session was stopped and nobody has sent input since"'))
  const refused = step(report(dropped), 'prompt')
  assert.deepEqual([refused.status, refused.detail, refused.lines.length], ['missing', 'c1 ended refused', 1])
  // The approvals, the release and the swap, gone.
  assert.equal(step(report(without(60_000, 'ANSWER')), 'dial-allow').status, 'missing')
  assert.equal(step(report(without(210_001, 'RELEASED')), 'in-app').status, 'missing')
  assert.equal(step(report(without(260_000, 'SLOT').filter((l) => !l.includes('which takes'))), 'swap').status, 'missing')
  // The version against the vendored reference's.
  assert.equal(step(report(LOG, { vendored: '2.1.320' }), 'version').detail, "2.1.320, the vendored reference's: expect no mark")
  assert.equal(step(report(LOG, { vendored: '2.1.400' }), 'version').detail, "2.1.320, older than the vendored reference's 2.1.400")
  assert.equal(step(report(LOG, { vendored: null }), 'version').detail, '2.1.320, the vendored reference names no version')
  const noCc = LOG.map((l) => l.replace('plugin "0.3.0" cc "2.1.320"', 'plugin "0.3.0" cc none'))
  assert.equal(step(report(noCc), 'version').detail, 'its hello gave no Claude Code version')
})

test('smoke-check: the watch, each rule 2 release, flagged when its session reads needs-you again with nothing held, and every warn and error', () => {
  const r = report()
  assert.deepEqual(r.watch.rule2, [{ line: find(185_000, 'RELEASED'), host: U, hint: `${U} read needs-you 600 ms later with nothing held: was the app's dialog still up?` }])
  assert.deepEqual(r.watch.problems, [find(186_000, 'front app check'), find(187_000, 'slots refresh failed')], 'the first line of each, and the whole deck, though --host names T')
  // A request held again for the session before its needs-you: that's the new request's.
  const again = [...LOG.slice(0, LOG.indexOf(find(185_600, 'needs-you'))), info(185_300, 'Sessions', `HELD #10 ask "AskUserQuestion" "Why?" fp 0d0d0d0d from ${U}; 1 held`), ...LOG.slice(LOG.indexOf(find(185_600, 'needs-you')))]
  assert.equal(report(again).watch.rule2[0].hint, null)
  // Needs-you more than 5 s later, or none.
  assert.equal(report(LOG.map((l) => l.replace(`${at(185_600)} DEBUG`, `${at(191_000)} DEBUG`))).watch.rule2[0].hint, null)
  assert.equal(report(without(185_600, 'needs-you')).watch.rule2[0].hint, null)
  // Rule 2 lets T's request go while the user answers in the app: step 9 takes it too, and the watch lists it.
  const rule2 = LOG.map((l) => l.replace("the session reported the call's end (rule 1, fp 9c9c9c9c)", 'the registry shows the session no longer waiting (rule 2)'))
  const r2 = report(rule2)
  assert.equal(step(r2, 'in-app').detail, '#9, by rule 2: the registry leaving waiting')
  assert.deepEqual(r2.watch.rule2.map((x) => [x.host, x.hint]), [[U, r.watch.rule2[0].hint], [T, null]])
})

test('smoke-check: a deck restart in the window starts the ids again, forgets who was running, and is noted', () => {
  const lines = [
    info(-60_000, 'Claude', 'STARTUP {"pid":1,"log":"debug"}'),
    info(-60_000, 'Sessions', `HELLO ${STOPPED} inst "aa" plugin "0.3.0" cc "2.1.320"`),
    info(1_000, 'Sessions', `HELD #1 tool "Bash" "echo one > smoke-1.txt" fp 2a2a2a2a from ${T}; 1 held`),
    info(5_000, 'Claude', 'STARTUP {"pid":2,"log":"debug"}'),
    info(5_010, 'Sessions', `HELLO ${U} inst "bb" plugin "0.3.0" cc "2.1.320"`),
    info(6_000, 'Sessions', `HELD #1 tool "Bash" "npm test" fp 3c3c3c3c from ${U}; 1 held`),
    info(8_000, 'Sessions', 'ANSWER #1 "Bash": allow, from a key press; 0 held'),
    // The stopped session said no hello to the new deck, so it wasn't running at its jump.
    info(9_000, 'Keys', `jump ${STOPPED} via slot key ${D}:1:2: "Lightroom plugin feedback"`),
    info(9_060, 'Jump', `opened claude://code/continue?session=${STOPPED} in 60 ms`),
    info(12_000, 'Sessions', `HELLO ${STOPPED} inst "cc" plugin "0.3.0" cc "2.1.320"`),
    debug(13_000, 'Sessions', `POLL ${U} wait 20 s`),
  ]
  assert.equal(step(report(lines), 'approve-key').status, 'missing', "the new deck's #1 is U's")
  assert.equal(step(report(lines, { host: U }), 'approve-key').status, 'ok')
  assert.equal(step(report(lines), 'stopped').status, 'ok')
  assert.deepEqual(report(lines).notes, [`the deck started at ${at(5_000)}, in the window: requests it held then went back to the app's dialogs`])
})

test('smoke-check: with no debug line in the window, the proofs that are debug lines are missing, saying why', () => {
  const r = report(LOG.filter((l) => !l.includes(' DEBUG ')))
  assert.deepEqual(r.steps.filter((s) => s.status === 'missing').map((s) => s.n), [2, 8, 10, 12])
  for (const id of ['others', 'deny', 'slot-jump', 'seen']) assert.match(step(r, id).detail, /its proof is a debug line, and the window has none: log-level.txt isn't debug$/, id)
  assert.deepEqual(r.notes, ['no debug line in the window: steps 2, 8, 10 and 12 need the deck at debug (log-level.txt)'])
})

test("smoke-check: the deck's logs, the newest and the older ones back to --since, oldest first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-check-logs-'))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // A file the SDK rotated out at 150 s, an older one that doesn't reach the window, and one that isn't the deck's.
  const cut = LOG.indexOf(find(160_000, 'turn.start'))
  logFile(LOG.slice(0, cut).join('\n'), 'com.karimdhanji.claude.1.log', dir)
  logFile(LOG.slice(cut).join('\n'), 'com.karimdhanji.claude.0.log', dir)
  logFile(info(-7_200_000, 'Claude', 'STARTUP {"pid":0,"log":"debug"}'), 'com.karimdhanji.claude.2.log', dir)
  logFile('not a log', 'other.log', dir)
  assert.deepEqual(C.deckLogs(dir, T0).map((l) => path.basename(l.file)), ['com.karimdhanji.claude.1.log', 'com.karimdhanji.claude.0.log'])
  assert.deepEqual(C.deckLogs(dir, T0 + 200_000).map((l) => path.basename(l.file)), ['com.karimdhanji.claude.0.log'])
  assert.deepEqual(C.deckLogs(dir, T0 - 7_300_000).map((l) => path.basename(l.file)), ['com.karimdhanji.claude.2.log', 'com.karimdhanji.claude.1.log', 'com.karimdhanji.claude.0.log'])
  const joined = run(['--since', SINCE, '--host', T, '--json'], { logDir: dir })
  assert.equal(joined.code, 0, joined.out)
  assert.deepEqual(JSON.parse(joined.out).logs, [path.join(dir, 'com.karimdhanji.claude.1.log'), path.join(dir, 'com.karimdhanji.claude.0.log')])
  // Before the oldest: the note says what's gone, and both starts are in the window.
  const early = JSON.parse(run(['--since', '2026-11-06T02:00:00Z', '--host', T, '--json'], { logDir: dir }).out)
  assert.equal(early.notes[0], `the logs start at ${at(-7_200_000)}, after --since: older ones have gone`)
  assert.equal(early.notes.length, 3)
  // No newest log: nothing to read.
  fs.rmSync(path.join(dir, 'com.karimdhanji.claude.0.log'))
  const none = run(['--since', SINCE], { logDir: dir })
  assert.deepEqual([none.code, none.out], [1, ''])
  assert.match(none.err, /^smoke-check: can't read the deck's log: no com\.karimdhanji\.claude\.0\.log in /)
})

test("smoke-check: usage errors exit 2, a log it can't read exits 1, and --help exits 0", () => {
  const file = logFile()
  for (const argv of [[], ['--since', 'soon'], ['--since', SINCE, '--host', 'T7'], ['--since', SINCE, '--host', 'local_bad/host'], ['--since', SINCE, '--log', ''], ['--since', SINCE, '--nope'], ['--since', SINCE, 'stray']]) {
    const r = run(argv[0] === '--since' && !argv.includes('--log') ? [...argv, '--log', file] : argv)
    assert.equal(r.code, 2, JSON.stringify(argv))
    assert.match(r.err, /^smoke-check: .*\n\nusage:/, JSON.stringify(argv))
    assert.equal(r.out, '')
  }
  assert.match(run([]).err, /^smoke-check: --since is required/)
  const missing = run(['--since', SINCE, '--log', path.join(path.dirname(file), 'none.log')])
  assert.deepEqual([missing.code, missing.out], [1, ''])
  assert.match(missing.err, /^smoke-check: can't read the deck's log: ENOENT/)
  const help = run(['--help'])
  assert.deepEqual([help.code, help.err], [0, ''])
  assert.match(help.out, /^usage: node claude-code\/tools\/smoke-check\.mjs --since ISO/)
})

test('smoke-check: the command line, as a process: text and JSON, the exit status, and the log left as it was', () => {
  const file = logFile()
  const before = fs.readFileSync(file, 'utf8')
  const sh = (lines, ...args) => spawnSync(process.execPath, [SCRIPT, '--log', lines, '--since', SINCE, '--host', T, ...args], { encoding: 'utf8' })
  const json = sh(file, '--json')
  assert.equal(json.status, 0, json.stderr)
  const r = JSON.parse(json.stdout)
  assert.deepEqual([r.ok, r.summary, r.logs], [true, { ok: 14, missing: 0 }, [file]])
  const text = sh(file)
  assert.equal(text.status, 0, text.stderr)
  const out = text.stdout.split('\n')
  for (const want of [
    `window    ${at(0)} to ${at(300_000)}, 5 min, ${r.window.lines} line(s); session ${T}`,
    ' 8  ok       a Deny, whose interrupt stops the turn',
    `             ${find(170_000, 'ANSWER')}`,
    '             the turn ended 1.3 s later, with no other call',
    'watch',
    '  RELEASED … (rule 2): 1',
    `      ${U} read needs-you 600 ms later with nothing held: was the app's dialog still up?`,
    '  warn and error: 2',
    `    ${find(187_000, 'slots refresh failed')}`,
    'ask the user',
    '   8  the app marked the turn interrupted, and Claude said nothing more',
    '14 ok, 0 missing',
  ]) assert.ok(out.includes(want), `${want}\n---\n${text.stdout}`)
  // A step without its proof: exit 1, and it says which.
  const short = logFile(without(243_620, 'SEEN').join('\n'))
  const one = sh(short)
  assert.equal(one.status, 1, one.stderr)
  assert.ok(one.stdout.split('\n').includes('12  missing  seen, with the session on screen and Claude in front'), one.stdout)
  assert.match(one.stdout, /^13 ok, 1 missing$/m)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})
