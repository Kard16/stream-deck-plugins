// idle-report.mjs against a synthetic deck log in a temp folder and canned ps and top output. Nothing here reads the
// deck's real log or runs ps or top: --live goes through a stand-in for them.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as I from '../idle-report.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'idle-report.mjs')
const A = 'local_aaaaaaaa-1111-2222-3333-444444444444'
const B = 'local_bbbbbbbb-1111-2222-3333-444444444444'
const T0 = Date.parse('2026-11-06T00:30:00.000Z')

/** A deck log as the SDK writes it: three minutes from T0, with a line before them, a stack trace's line, and an IDLE line that doesn't parse. */
const LOG = [
  `2026-11-06T00:29:59.000Z DEBUG Sessions: POLL ${A} wait 20 s`,
  '2026-11-06T00:30:00.000Z INFO  Claude: STARTUP {"pid":1,"log":"debug"}',
  `2026-11-06T00:30:01.000Z DEBUG Sessions: POLL ${A} wait 20 s`,
  `2026-11-06T00:30:02.000Z DEBUG Sessions: POLL ${A} answered at once: the turn ended and the registry still says busy`,
  `2026-11-06T00:30:03.000Z DEBUG Sessions: POLL ${B} from mod instance "i2", not the current one: answered with none`,
  `2026-11-06T00:30:04.000Z DEBUG Sessions: POLL ${A} answered with none: the turn ended`,
  `2026-11-06T00:30:05.000Z DEBUG Sessions: EVENT ${A} turn.end`,
  '2026-11-06T00:30:05.500Z DEBUG Bridge: REQ 204 POST "/v1/events"',
  '2026-11-06T00:30:06.000Z WARN  Front: front app check: lsappinfo front failed: Error: boom; counted as not in front',
  '    at run (file:///x/plugin.js:1:1)',
  '2026-11-06T00:31:00.000Z DEBUG Idle: IDLE {"s":60,"userMs":12.5,"sysMs":4.5,"elu":0.002,"rssMB":61.2,"counts":{"emit":3,"reg.scan":60,"reg.stat":120}}',
  `2026-11-06T00:31:30.000Z DEBUG Sessions: POLL ${A} wait 20 s`,
  '2026-11-06T00:31:40.000Z DEBUG Records: 2 app record(s) read; no file for 1',
  '2026-11-06T00:32:00.000Z DEBUG Idle: IDLE {"s":60,"userMs":7.5,"sysMs":5.5,"elu":0.004,"rssMB":60.8,"counts":{"emit":1,"reg.scan":60,"reg.stat":120,"tick":60}}',
  '2026-11-06T00:32:10.000Z DEBUG Idle: IDLE {not json',
  `2026-11-06T00:32:20.000Z DEBUG Sessions: STATUS ${A} idle → done`,
  `2026-11-06T00:32:30.000Z INFO  Sessions: HELLO FIRST ${B}: mod instance "i3" polls, but no instance has said hello to this deck for the session, so the deck answers 409 to ask for one`,
  '',
].join('\n')

/** Three samples of `top -l 3 -s 60 -c d -pid 1513 -stats pid,time,csw,sysbsd,idlew,power` as this Mac prints them (2026-11-05). */
const TOP = (pid = 1513) =>
  [
    ['2026/11/05 18:42:37', '02:36.59 1524558 6221855 0     0.0'],
    ['2026/11/05 18:43:37', '02:36.60 40      140     0     0.2'],
    ['2026/11/05 18:44:37', '02:36.60 38      109     3     0.1'],
  ]
    .map(([at, row]) =>
      [
        'Processes: 809 total, 2 running, 807 sleeping, 4794 threads ',
        at,
        'Load Avg: 1.27, 1.73, 1.79 ',
        'CPU usage: 0.80% user, 5.64% sys, 93.54% idle ',
        'PhysMem: 47G used (2566M wired, 23M compressor), 16G unused.',
        'Networks: packets: 0/0B in, 0/0B out.',
        '',
        'PID   TIME     CSW     SYSBSD  IDLEW POWER',
        `${pid}  ${row} `,
      ].join('\n'),
    )
    .join('\n')

const PS = [
  '    1 /sbin/launchd',
  ' 1499 vim /Users/me/Projects/stream-deck-plugins/claude-code/deck/com.karimdhanji.claude.sdPlugin/bin/plugin.js',
  ' 1500 /Users/me/Library/Application Support/com.elgato.StreamDeck/NodeJS/24.22.1/node --no-global-search-paths /Users/me/Projects/stream-deck-plugins/lightroom/deck/com.karimdhanji.lightroom.sdPlugin/bin/plugin.js -port 28196',
  ' 1513 /Users/me/Library/Application Support/com.elgato.StreamDeck/NodeJS/24.22.1/node --no-global-search-paths --enable-source-maps /Users/me/Projects/stream-deck-plugins/claude-code/deck/com.karimdhanji.claude.sdPlugin/bin/plugin.js -port 28196 -pluginUUID 2f20',
  '',
].join('\n')

function logFile(text = LOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-report-'))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'com.karimdhanji.claude.0.log')
  fs.writeFileSync(file, text)
  return file
}

/** main() with the clock, ps, top and the output stood in for: what it printed, and the commands it ran. */
async function run(argv, { now = T0, ps = PS, top = TOP() } = {}) {
  const calls = []
  let out = ''
  let err = ''
  const code = await I.main(argv, {
    now: () => now,
    run: async (file, args, opts) => {
      calls.push({ file, args, opts })
      return { stdout: file === '/bin/ps' ? ps : top }
    },
    out: (s) => (out += s),
    err: (s) => (err += s),
  })
  return { code, out, err, calls }
}

test("idle-report: the deck's POLL lines, as claude-code/deck/src/model/sessions.ts writes them now, each with its kind, every why of an answer with none included", () => {
  // A POLL line the deck adds or changes fails here until idle-report's kinds are checked against it.
  const source = fs.readFileSync(path.join(I.REPO, 'claude-code', 'deck', 'src', 'model', 'sessions.ts'), 'utf8')
  const general = (template) => template.replace(/\$\{[^}]*\}/g, '…')
  const templates = [...source.matchAll(/`POLL \$\{b\.host\} ([^`]*)`/g)].map((m) => m[1])
  const kinds = {
    'from mod instance …, not the current one: answered with none': 'stray',
    'answered at once: the turn ended and the registry still says busy': 'atOnce',
    'wait … s': 'wait',
    'answered with none: …': 'none',
  }
  assert.deepEqual(templates.map(general).toSorted(), Object.keys(kinds).toSorted())
  // The whys of an answer with none: a turn's end or failure, the registry turning busy after one, and the other loops
  // leaving their turns (Phase 9).
  const whys = [...source.matchAll(/#(?:answerPoll|turnOver)\(b, "([^"]+)"\)/g)].map((m) => m[1])
  assert.deepEqual(whys.toSorted(), ['the session\'s other loops left their turns', 'the turn ended', 'the turn ended and the registry now says busy', 'the turn failed'])
  for (const template of templates) {
    for (const why of template.includes('${why}') ? whys : [null]) {
      const message = `POLL ${A} ${template.replaceAll('${why}', why).replace(/\$\{[^}]*\}/g, '20')}`
      assert.equal(I.classify({ scope: 'Sessions', message }).poll, kinds[general(template)], message)
    }
  }
})

test('idle-report: reads the lines the SDK writes, and tells IDLE, POLL by its answer, EVENT and the rest apart', () => {
  assert.deepEqual(I.parseLine('2026-11-06T00:30:00.000Z INFO  Claude: STARTUP {"pid":1}'), { t: T0, level: 'info', scope: 'Claude', message: 'STARTUP {"pid":1}' })
  assert.equal(I.parseLine('    at run (file:///x/plugin.js:1:1)'), null)
  assert.equal(I.parseLine(''), null)
  const kind = (message, scope = 'Sessions') => I.classify({ scope, message })
  assert.deepEqual(kind('IDLE {"s":60,"counts":{"emit":1}}', 'Idle'), { kind: 'idle', idle: { s: 60, counts: { emit: 1 } } })
  assert.deepEqual(kind('IDLE {not json', 'Idle'), { kind: 'other', what: 'Idle IDLE unreadable' })
  assert.deepEqual(kind('IDLE [1]', 'Idle'), { kind: 'other', what: 'Idle IDLE unreadable' })
  // The deck's four POLL lines (sessions.ts's next and #answerPoll); a stray's says "answered with none" too.
  assert.deepEqual(kind(`POLL ${A} wait 20 s`), { kind: 'poll', host: A, poll: 'wait' })
  assert.deepEqual(kind(`POLL ${A} answered at once: the turn ended and the registry still says busy`), { kind: 'poll', host: A, poll: 'atOnce' })
  assert.deepEqual(kind(`POLL ${A} from mod instance "i2", not the current one: answered with none`), { kind: 'poll', host: A, poll: 'stray' })
  assert.deepEqual(kind(`POLL ${A} answered with none: the turn failed`), { kind: 'poll', host: A, poll: 'none' })
  // Since Phase 9 a held poll is answered with none when the session's other loops leave their turns too, and the at-once
  // polls after that drop have the at-once line.
  assert.deepEqual(kind(`POLL ${A} answered with none: the session's other loops left their turns`), { kind: 'poll', host: A, poll: 'none' })
  assert.deepEqual(kind(`POLL ${A} answered with none: the turn ended and the registry now says busy`), { kind: 'poll', host: A, poll: 'none' })
  assert.deepEqual(kind(`POLL ${A} something new`), { kind: 'poll', host: A, poll: 'other' })
  assert.deepEqual(kind(`EVENT ${A} tool.start "Bash" fp 1234abcd`), { kind: 'event', host: A })
  // The rest by scope and leading capitals, else by their first words, made general.
  assert.equal(I.otherKind('Bridge', 'REQ 204 POST "/v1/events"'), 'Bridge REQ')
  assert.equal(I.otherKind('Sessions', `HELLO FIRST ${B}: mod instance "i3" polls`), 'Sessions HELLO FIRST')
  assert.equal(I.otherKind('Sessions', `NO HELLO ${B}: mod instance "i3" sends events`), 'Sessions NO HELLO')
  assert.equal(I.otherKind('Records', '2 app record(s) read; no file for 1'), 'Records N app')
  assert.equal(I.otherKind('Keys', `jump ${A} from its key`), 'Keys jump <host>')
  assert.equal(I.otherKind('RegistrationParameters', 'info={"application":{"font":"x y"}}'), 'RegistrationParameters info=…')
  assert.equal(I.otherKind('', 'A plain line'), 'A plain')
})

test('idle-report: per minute and in total, with --since: IDLE lines in the minute they cover, polls per session by kind, events per session, the rest by kind', () => {
  const r = I.buildReport(LOG, { log: 'x.log', from: T0, by: '--since' })
  assert.deepEqual(r.window, { from: '2026-11-06T00:30:00.000Z', to: '2026-11-06T00:32:30.001Z', minutes: 2.5, by: '--since' })
  // The line before T0 and the stack trace's line don't count.
  assert.equal(r.lines, 15)
  assert.deepEqual(r.minutes.map((m) => m.start), ['2026-11-06T00:30:00.000Z', '2026-11-06T00:31:00.000Z', '2026-11-06T00:32:00.000Z'])
  const [m0, m1, m2] = r.minutes
  // The IDLE line at 00:31:00 covers 00:30 to 00:31.
  assert.deepEqual(m0.idle, { lines: 1, s: 60, userMs: 12.5, sysMs: 4.5, cpuPct: 0.028, elu: 0.002, rssMB: 61.2, rssMinMB: 61.2, rssMaxMB: 61.2, counts: { emit: 3, 'reg.scan': 60, 'reg.stat': 120 } })
  assert.deepEqual(m0.polls, { [A]: { wait: 1, atOnce: 1, stray: 0, none: 1, other: 0 }, [B]: { wait: 0, atOnce: 0, stray: 1, none: 0, other: 0 } })
  assert.deepEqual(m0.events, { [A]: 1 })
  assert.deepEqual(m0.other, { 'Bridge REQ': 1, 'Claude STARTUP': 1, 'Front front app': 1 })
  assert.equal(m1.idle.counts.tick, 60)
  assert.deepEqual(m1.polls, { [A]: { wait: 1, atOnce: 0, stray: 0, none: 0, other: 0 } })
  assert.deepEqual(m1.other, { 'Records N app': 1 })
  assert.equal(m2.idle, null)
  assert.deepEqual(m2.other, { 'Idle IDLE unreadable': 1, 'Sessions HELLO FIRST': 1, 'Sessions STATUS': 1 })
  assert.ok(!('top' in m0), 'no top without --live')
  assert.deepEqual(r.total.idle, {
    lines: 2, s: 120, userMs: 20, sysMs: 10, cpuPct: 0.025, elu: 0.003, rssMB: 60.8, rssMinMB: 60.8, rssMaxMB: 61.2,
    counts: { emit: 4, 'reg.scan': 120, 'reg.stat': 240, tick: 60 },
    perMinute: { emit: 2, 'reg.scan': 60, 'reg.stat': 120, tick: 30 },
  })
  assert.deepEqual(r.total.polls, { [A]: { wait: 2, atOnce: 1, stray: 0, none: 1, other: 0 }, [B]: { wait: 0, atOnce: 0, stray: 1, none: 0, other: 0 } })
  assert.deepEqual(r.total.events, { [A]: 1 })
  assert.equal(Object.values(r.total.other).reduce((a, b) => a + b, 0), 7)
  assert.equal(r.top, null)
  // The whole log: from the first line's minute to its last line.
  const whole = I.buildReport(LOG)
  assert.deepEqual([whole.window.from, whole.lines, whole.total.polls[A].wait], ['2026-11-06T00:29:00.000Z', 16, 3])
  // No lines: no window.
  assert.deepEqual(I.buildReport('').window, { from: null, to: null, minutes: 0, by: null })
  assert.match(I.renderText(I.buildReport('')), /window {2}none: the log has no lines/)
})

test("idle-report: top's samples: TIME is cumulative, so each interval's CPU is its change; the rest are deltas after the first", () => {
  assert.equal(I.topTime('02:36.59'), 156.59)
  assert.equal(I.topTime('1:02:03'), 3723)
  assert.equal(I.topTime('123 hrs'), 442800)
  assert.equal(I.topTime('soon'), null)
  const samples = I.parseTop(TOP())
  assert.deepEqual(samples.map((s) => [s.at, s.pid, s.timeS, s.csw, s.sysbsd, s.idlew, s.power]), [
    ['2026/11/05 18:42:37', 1513, 156.59, 1524558, 6221855, 0, 0],
    ['2026/11/05 18:43:37', 1513, 156.6, 40, 140, 0, 0.2],
    ['2026/11/05 18:44:37', 1513, 156.6, 38, 109, 3, 0.1],
  ])
  assert.deepEqual(I.topDeltas(samples), [
    { at: '2026/11/05 18:43:37', cpuS: 0.01, csw: 40, sysbsd: 140, idlew: 0, power: 0.2 },
    { at: '2026/11/05 18:44:37', cpuS: 0, csw: 38, sysbsd: 109, idlew: 3, power: 0.1 },
  ])
  assert.deepEqual(I.parseTop('PID   TIME     CSW\n1513  02:36.59 12+\n').map((s) => s.csw), [12], 'a mark after a count')
  assert.deepEqual(I.parseTop(''), [])
})

test("idle-report: finds the Claude deck's node process by its script, not an editor's or the Lightroom deck's", () => {
  assert.equal(I.deckPid(PS), 1513)
  assert.equal(I.deckPid(PS.split('\n').filter((l) => !l.includes(' 1513 ')).join('\n')), null)
})

test('idle-report: --live N samples the deck with top for N minutes, then reports that window a minute at a time, with top beside the log', async () => {
  const file = logFile()
  const { code, out, err, calls } = await run(['--log', file, '--live', '2', '--json'])
  assert.equal(code, 0, err)
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ['/bin/ps', ['-axww', '-o', 'pid=,command=']],
    ['/usr/bin/top', ['-l', '3', '-s', '60', '-c', 'd', '-pid', '1513', '-stats', 'pid,time,csw,sysbsd,idlew,power']],
  ])
  assert.ok(calls[1].opts.timeout >= 3 * I.MINUTE_MS, 'top has a time limit past its run')
  assert.match(err, /sampling pid 1513 with top for 2 min/)
  const r = JSON.parse(out)
  assert.deepEqual(r.window, { from: '2026-11-06T00:30:00.000Z', to: '2026-11-06T00:32:00.000Z', minutes: 2, by: '--live 2' })
  assert.deepEqual(r.minutes.map((m) => [m.top.cpuS, m.top.csw, m.top.idlew]), [[0.01, 40, 0], [0, 38, 3]])
  assert.deepEqual(r.top, { pid: 1513, intervals: 2, cpuS: 0.01, cpuPct: 0.008, csw: 78, sysbsd: 249, idlew: 3, power: 0.15 })
  assert.deepEqual([r.total.idle.lines, r.total.polls[A].wait], [2, 2])
  const text = await run(['--log', file, '--live', '2'])
  assert.match(text.out, /^top {5}pid 1513, 2 interval\(s\) of 60 s$/m)
  assert.match(text.out, /^ {10}top {4}cpu 0\.01 s, csw 40, sysbsd 140, idlew 0, power 0\.2$/m)
  assert.match(text.out, /^top {5}cpu 0\.01 s \(0\.008% of a core\), csw 78, sysbsd 249, idlew 3, power 0\.15 on average$/m)
  // A top that printed another pid's rows, or none: no samples, so no deltas.
  const other = JSON.parse((await run(['--log', file, '--live', '2', '--json'], { top: TOP(42) })).out)
  assert.deepEqual([other.top.intervals, other.minutes[0].top], [0, null])
  // No deck: nothing sampled.
  const none = await run(['--log', file, '--live', '2'], { ps: '    1 /sbin/launchd\n' })
  assert.deepEqual([none.code, none.calls.length, none.out], [1, 1, ''])
  assert.match(none.err, /the Claude deck isn't running/)
})

test('idle-report: --last N is the N minutes before now', async () => {
  const { code, out } = await run(['--log', logFile(), '--last', '2', '--json'], { now: T0 + 3 * I.MINUTE_MS })
  assert.equal(code, 0)
  const r = JSON.parse(out)
  assert.deepEqual(r.window, { from: '2026-11-06T00:31:00.000Z', to: '2026-11-06T00:33:00.000Z', minutes: 2, by: '--last 2' })
  assert.deepEqual([r.lines, r.total.idle.lines, r.total.idle.counts.tick, r.total.polls[A].wait], [6, 1, 60, 1])
})

test('idle-report: usage errors exit 2, a log it can\'t read exits 1, and --help exits 0', async () => {
  const file = logFile()
  for (const argv of [['--since', 'x'], ['--last', '0'], ['--last', 'ten'], ['--live', '1.5'], ['--since', '2026-11-06T00:30:00Z', '--last', '5'], ['--live', '2', '--last', '5'], ['--log', ''], ['--nope'], ['stray']]) {
    const r = await run(['--log', file, ...argv])
    assert.equal(r.code, 2, JSON.stringify(argv))
    assert.match(r.err, /^idle-report: .*\n\nusage:/, JSON.stringify(argv))
    assert.deepEqual(r.calls, [], 'nothing run')
  }
  const missing = await run(['--log', path.join(path.dirname(file), 'none.log')])
  assert.deepEqual([missing.code, missing.out], [1, ''])
  assert.match(missing.err, /can't read .*none\.log: ENOENT/)
  const help = await run(['--help'])
  assert.deepEqual([help.code, help.err], [0, ''])
  assert.match(help.out, /^usage: node claude-code\/tools\/idle-report\.mjs/)
})

test('idle-report: the command line, as a process: --since in text and JSON, and the log left as it was', () => {
  const file = logFile()
  const before = fs.readFileSync(file, 'utf8')
  const sh = (...args) => spawnSync(process.execPath, [SCRIPT, '--log', file, '--since', '2026-11-06T00:30:00Z', ...args], { encoding: 'utf8' })
  const json = sh('--json')
  assert.equal(json.status, 0, json.stderr)
  assert.equal(JSON.parse(json.stdout).lines, 15)
  const text = sh()
  assert.equal(text.status, 0, text.stderr)
  for (const line of [
    'window  2026-11-06T00:30:00.000Z to 2026-11-06T00:32:30.001Z, 2.5 min (--since 2026-11-06T00:30:00Z); 15 line(s) in it',
    '00:30:00  IDLE 60 s, cpu 12.5 + 4.5 ms, elu 0.002, rss 61.2 MB',
    '          counts emit 3, reg.scan 60, reg.stat 120',
    '          POLL   local_aaaaaaaa wait 1 at once 1 none 1, local_bbbbbbbb stray 1',
    '00:32:00  no IDLE line',
    'IDLE    2 line(s), 120 s; cpu 20 + 10 ms (0.025% of a core); elu 0.003; rss 60.8 to 61.2 MB, last 60.8',
  ]) assert.ok(text.stdout.split('\n').includes(line), `${line}\n---\n${text.stdout}`)
  assert.match(text.stdout, /^ {8}reg\.stat +240 +120$/m)
  assert.match(text.stdout, /^ {8}local_aaaaaaaa +2 +1 +0 +1 +0$/m)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})
