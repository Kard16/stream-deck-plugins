#!/usr/bin/env node
// idle-report: what the Claude deck did while idle, from its log (docs/claude-code/hardening.md, A1), per minute and
// in total:
// - the deck's IDLE lines, one a minute at debug (claude-code/deck/src/util/idle.ts): the CPU time, the event loop's
//   use, the memory, and its counts of scans, stats, folder walks, lsappinfo spawns, emits, views, polls, sends to
//   the Stream Deck app and ticks;
// - the POLL lines per session, by how each poll was answered; the EVENT lines per session; and the other lines by
//   kind.
// With --live N it also samples the deck's node process with top for N minutes, and reports that window.
//
// Read only: it reads the log and runs ps and top, and writes nothing. Node 24, no dependencies.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_LOG = path.join(REPO, 'claude-code', 'deck', 'com.karimdhanji.claude.sdPlugin', 'logs', 'com.karimdhanji.claude.0.log')
export const MINUTE_MS = 60_000
/** The Claude deck's node process runs this script: `ps` shows it in the process's command line. */
export const DECK_SCRIPT = 'com.karimdhanji.claude.sdPlugin/bin/plugin.js'
/** What top samples, for --live: `-c d` makes CSW, SYSBSD and IDLEW deltas after the first sample; TIME stays cumulative. */
export const TOP_STATS = 'pid,time,csw,sysbsd,idlew,power'

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const bump = (obj, key, n = 1) => {
  obj[key] = (obj[key] ?? 0) + n
}
const sortedKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
const iso = (t) => new Date(t).toISOString()

// ---- the log

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (ERROR|WARN|INFO|DEBUG|TRACE) +(.*)$/

/** One line of the deck's log: its time, level, scope and message. Null for a line that doesn't start with a time, a stack trace's say. */
export function parseLine(line) {
  const m = LINE.exec(line)
  if (!m) return null
  const scoped = /^([^\s:]+): (.*)$/.exec(m[3])
  return { t: Date.parse(m[1]), level: m[2].toLowerCase(), scope: scoped ? scoped[1] : '', message: scoped ? scoped[2] : m[3] }
}

/**
 * How the deck answered a poll, by its POLL line's words (claude-code/deck/src/model/sessions.ts, `next` and
 * #answerPoll): held (`wait N s`); at once in the 60 s after the main loop's turn ends, or after the session's other
 * loops' running drops to 0 (`answered at once`); at once for an instance that isn't the current one (`not the current
 * one`); or a held one answered with none (`answered with none`) at a turn's end or failure, when the registry turns
 * busy after one, or when the other loops' running drops to 0 with the main loop out of its turn (Phase 9). In this
 * order: a stray's line says "answered with none" too.
 */
export const POLL_KINDS = Object.freeze([
  ['wait', /^wait \d+ s$/],
  ['atOnce', /^answered at once\b/],
  ['stray', /\bnot the current one\b/],
  ['none', /^answered with none\b/],
])
export const POLL_LABELS = Object.freeze({ wait: 'wait', atOnce: 'at once', stray: 'stray', none: 'none', other: 'other' })
const emptyPolls = () => ({ wait: 0, atOnce: 0, stray: 0, none: 0, other: 0 })

/** A word of a line, made general for the tally of other kinds: hosts, quoted text, numbers and a `key=`'s value stand for any. */
const general = (word) =>
  word
    .replace(/=.*/, '=…')
    .replace(/local_[A-Za-z0-9-]+/g, '<host>')
    .replace(/"[^"]*"?/g, '"…"')
    .replace(/\d+(\.\d+)?/g, 'N')
    .slice(0, 24)

/**
 * A line's kind for the tally of other lines: its scope and its leading capitals (`STATUS`, `HELLO FIRST`), else its
 * first two words made general, or only the first when that's a `key=value`.
 */
export function otherKind(scope, message) {
  const caps = /^[A-Z][A-Z_]+(?: [A-Z][A-Z_]+)*(?= |$)/.exec(message)?.[0]
  const words = message.split(' ')
  const kind = caps ?? words.slice(0, words[0]?.includes('=') ? 1 : 2).map(general).join(' ')
  return scope ? `${scope} ${kind}` : kind
}

/** What a parsed line is: `idle`, with the IDLE line's JSON; `poll`, with its host and kind; `event`, with its host; or `other`, with its kind. */
export function classify({ scope, message }) {
  if (message.startsWith('IDLE ')) {
    try {
      const idle = JSON.parse(message.slice('IDLE '.length))
      if (idle !== null && typeof idle === 'object' && !Array.isArray(idle)) return { kind: 'idle', idle }
    } catch {}
    return { kind: 'other', what: `${scope} IDLE unreadable` }
  }
  const poll = /^POLL (\S+) (.*)$/.exec(message)
  if (poll) return { kind: 'poll', host: poll[1], poll: POLL_KINDS.find(([, re]) => re.test(poll[2]))?.[0] ?? 'other' }
  const event = /^EVENT (\S+)/.exec(message)
  if (event) return { kind: 'event', host: event[1] }
  return { kind: 'other', what: otherKind(scope, message) }
}

/** IDLE lines added up: seconds, CPU and counts summed, the event loop's use weighted by seconds, the memory's range and last. */
function addIdle(acc, line) {
  const a = acc ?? { lines: 0, s: 0, userMs: 0, sysMs: 0, elu: 0, rssMB: null, rssMinMB: null, rssMaxMB: null, counts: {} }
  const s = num(line.s)
  a.elu = a.s + s > 0 ? (a.elu * a.s + num(line.elu) * s) / (a.s + s) : 0
  a.lines += line.lines ?? 1
  a.s += s
  a.userMs += num(line.userMs)
  a.sysMs += num(line.sysMs)
  const rss = typeof line.rssMB === 'number' ? line.rssMB : null
  if (rss !== null) {
    a.rssMB = rss
    a.rssMinMB = Math.min(a.rssMinMB ?? rss, line.rssMinMB ?? rss)
    a.rssMaxMB = Math.max(a.rssMaxMB ?? rss, line.rssMaxMB ?? rss)
  }
  for (const [kind, n] of Object.entries(line.counts ?? {})) if (typeof n === 'number') bump(a.counts, kind, n)
  return a
}

/** An IDLE sum as reported: rounded, its counts sorted, and with what it took of one core. */
function idleOut(a) {
  if (a === null) return null
  return {
    lines: a.lines,
    s: round(a.s, 1),
    userMs: round(a.userMs, 1),
    sysMs: round(a.sysMs, 1),
    cpuPct: a.s > 0 ? round(((a.userMs + a.sysMs) / (a.s * 1000)) * 100, 3) : null,
    elu: round(a.elu, 4),
    rssMB: a.rssMB,
    rssMinMB: a.rssMinMB,
    rssMaxMB: a.rssMaxMB,
    counts: sortedKeys(a.counts),
  }
}

// ---- top

/** top's TIME in seconds: `02:36.59` (minutes, seconds, hundredths), `1:02:03` (hours, minutes, seconds) or `123 hrs`; null for anything else. */
export function topTime(text) {
  let m = /^(\d+):(\d{2})\.(\d{2})$/.exec(text ?? '')
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100
  m = /^(\d+):(\d{2}):(\d{2})$/.exec(text ?? '')
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  m = /^(\d+) ?hrs$/.exec(text ?? '')
  return m ? Number(m[1]) * 3600 : null
}

/** A count from top: digits, without a sign or mark top may put after them; null when there are none. */
const topCount = (v) => (/^\d+(\.\d+)?/.test(v ?? '') ? Number(/^\d+(\.\d+)?/.exec(v)[0]) : null)

/**
 * `top -l N -stats …` for one pid: each sample's time as top printed it (local), and its row by the header's columns.
 * TIME stays cumulative; with `-c d`, CSW, SYSBSD and IDLEW are counts since the sample before, except in the first.
 */
export function parseTop(text) {
  const samples = []
  let at = null
  let header = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(line)) at = line
    const cols = line.split(/\s+/)
    if (cols[0] === 'PID') header = cols.map((c) => c.toLowerCase())
    else if (header && /^\d+$/.test(cols[0])) {
      const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]))
      samples.push({ at, pid: Number(row.pid), timeS: topTime(row.time), csw: topCount(row.csw), sysbsd: topCount(row.sysbsd), idlew: topCount(row.idlew), power: topCount(row.power) })
      header = null
    }
  }
  return samples
}

/** Each interval after top's first sample, which is cumulative: CPU seconds from TIME's change, and the rest as top gave them. */
export function topDeltas(samples) {
  const out = []
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]]
    out.push({ at: b.at, cpuS: a.timeS !== null && b.timeS !== null ? round(b.timeS - a.timeS, 2) : null, csw: b.csw, sysbsd: b.sysbsd, idlew: b.idlew, power: b.power })
  }
  return out
}

/** top's intervals added up: CPU seconds, context switches, BSD syscalls and idle wakeups summed, power averaged. */
function topTotal(deltas, intervalS) {
  const sum = (k) => round(deltas.reduce((n, d) => n + num(d[k]), 0), 2)
  const cpuS = sum('cpuS')
  return {
    intervals: deltas.length,
    cpuS,
    cpuPct: deltas.length > 0 ? round((cpuS / (deltas.length * intervalS)) * 100, 3) : null,
    csw: sum('csw'),
    sysbsd: sum('sysbsd'),
    idlew: sum('idlew'),
    power: deltas.length > 0 ? round(sum('power') / deltas.length, 2) : null,
  }
}

/** The Claude deck's node process in `ps -axww -o pid=,command=`'s output: its pid, or null when it isn't running. */
export function deckPid(psOutput) {
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && /(^|\/)node\s/.test(m[2]) && m[2].includes(DECK_SCRIPT)) return Number(m[1])
  }
  return null
}

// ---- the report

/**
 * The report on the log's lines in [from, to): per minute from `from`, and in total. Without `from`, the window starts
 * at the first line's minute; without `to`, it ends with the log's last line. An IDLE line covers the `s` seconds
 * before it, so it counts in the minute that holds the middle of them. `top`, for --live: the pid and each interval's
 * deltas, the first interval being the window's first minute. `by` says how the window was chosen.
 */
export function buildReport(text, { log = null, from = null, to = null, by = null, top = null } = {}) {
  const lines = []
  for (const raw of text.split('\n')) {
    const line = parseLine(raw)
    if (line === null) continue
    const c = classify(line)
    lines.push({ at: c.kind === 'idle' ? line.t - num(c.idle.s) * 500 : line.t, t: line.t, c })
  }
  let [first, last] = [Infinity, -Infinity]
  for (const { at, t } of lines) [first, last] = [Math.min(first, at), Math.max(last, t)]
  const start = from ?? (lines.length > 0 ? Math.floor(first / MINUTE_MS) * MINUTE_MS : null)
  const end = start === null ? null : Math.max(start, to ?? (lines.length > 0 ? last + 1 : start))
  const n = start === null ? 0 : Math.ceil((end - start) / MINUTE_MS)
  const minutes = Array.from({ length: n }, (_, i) => ({ start: start + i * MINUTE_MS, idle: null, polls: {}, events: {}, other: {} }))
  const total = { idle: null, polls: {}, events: {}, other: {} }
  let inWindow = 0
  for (const { at, c } of lines) {
    if (at < start || at >= end) continue
    inWindow++
    for (const into of [minutes[Math.floor((at - start) / MINUTE_MS)], total]) {
      if (c.kind === 'idle') into.idle = addIdle(into.idle, c.idle)
      else if (c.kind === 'poll') (into.polls[c.host] ??= emptyPolls())[c.poll]++
      else if (c.kind === 'event') bump(into.events, c.host)
      else bump(into.other, c.what)
    }
  }
  const deltas = top?.deltas ?? []
  const idle = idleOut(total.idle)
  return {
    log,
    window: { from: start === null ? null : iso(start), to: end === null ? null : iso(end), minutes: start === null ? 0 : round((end - start) / MINUTE_MS, 1), by },
    lines: inWindow,
    minutes: minutes.map((m, i) => ({
      start: iso(m.start),
      idle: idleOut(m.idle),
      polls: sortedKeys(m.polls),
      events: sortedKeys(m.events),
      other: sortedKeys(m.other),
      ...(top ? { top: deltas[i] ?? null } : {}),
    })),
    total: {
      idle: idle === null ? null : { ...idle, perMinute: idle.s > 0 ? Object.fromEntries(Object.entries(idle.counts).map(([k, v]) => [k, round(v / (idle.s / 60), 1)])) : {} },
      polls: sortedKeys(total.polls),
      events: sortedKeys(total.events),
      other: Object.fromEntries(Object.entries(total.other).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))),
    },
    top: top ? { pid: top.pid, ...topTotal(deltas.slice(0, n), MINUTE_MS / 1000) } : null,
  }
}

/** A session's host, short: `local_` and its first 8 characters. */
const short = (host) => (host.length > 14 ? host.slice(0, 14) : host)
const list = (obj, fmt = (k, v) => `${k} ${v}`) =>
  Object.entries(obj)
    .map(([k, v]) => fmt(k, v))
    .join(', ')
const pollText = (polls) =>
  list(polls, (host, p) => `${short(host)} ${Object.entries(p).filter(([, v]) => v > 0).map(([k, v]) => `${POLL_LABELS[k]} ${v}`).join(' ')}`)
const idleText = (i) => (i === null ? 'no IDLE line' : `IDLE ${i.s} s, cpu ${i.userMs} + ${i.sysMs} ms, elu ${i.elu}, rss ${i.rssMB ?? '?'} MB${i.lines > 1 ? ` (${i.lines} lines)` : ''}`)
const topText = (d) => (d === null ? 'no sample' : `cpu ${d.cpuS ?? '?'} s, csw ${d.csw ?? '?'}, sysbsd ${d.sysbsd ?? '?'}, idlew ${d.idlew ?? '?'}, power ${d.power ?? '?'}`)

export function renderText(r) {
  const out = [`log     ${r.log ?? '(text)'}`]
  if (r.window.from === null) return `${[...out, 'window  none: the log has no lines'].join('\n')}\n`
  out.push(`window  ${r.window.from} to ${r.window.to}, ${r.window.minutes} min${r.window.by ? ` (${r.window.by})` : ''}; ${r.lines} line(s) in it`)
  if (r.top) out.push(`top     pid ${r.top.pid}, ${r.top.intervals} interval(s) of 60 s`)
  out.push('', 'per minute (UTC)')
  const pad = ' '.repeat(10)
  for (const m of r.minutes) {
    out.push(`${m.start.slice(11, 19)}  ${idleText(m.idle)}`)
    if (m.idle && Object.keys(m.idle.counts).length > 0) out.push(`${pad}counts ${list(m.idle.counts)}`)
    if (Object.keys(m.polls).length > 0) out.push(`${pad}POLL   ${pollText(m.polls)}`)
    if (Object.keys(m.events).length > 0) out.push(`${pad}EVENT  ${list(m.events, (h, v) => `${short(h)} ${v}`)}`)
    if (Object.keys(m.other).length > 0) out.push(`${pad}other  ${list(m.other)}`)
    if ('top' in m) out.push(`${pad}top    ${topText(m.top)}`)
  }
  const t = r.total
  out.push('', 'total')
  if (t.idle === null) out.push('IDLE    none: at debug the deck logs one a minute (log-level.txt)')
  else {
    out.push(`IDLE    ${t.idle.lines} line(s), ${t.idle.s} s; cpu ${t.idle.userMs} + ${t.idle.sysMs} ms (${t.idle.cpuPct ?? '?'}% of a core); elu ${t.idle.elu}; rss ${t.idle.rssMinMB ?? '?'} to ${t.idle.rssMaxMB ?? '?'} MB, last ${t.idle.rssMB ?? '?'}`)
    const w = Math.max(5, ...Object.keys(t.idle.counts).map((k) => k.length))
    out.push(`counts  ${'kind'.padEnd(w)}  ${'total'.padStart(8)}  ${'a min'.padStart(8)}`)
    for (const [k, v] of Object.entries(t.idle.counts)) out.push(`        ${k.padEnd(w)}  ${String(v).padStart(8)}  ${String(t.idle.perMinute[k] ?? '').padStart(8)}`)
  }
  const kinds = Object.keys(emptyPolls())
  out.push(`POLL    ${'session'.padEnd(14)}  ${kinds.map((k) => POLL_LABELS[k].padStart(7)).join('  ')}`)
  for (const [host, p] of Object.entries(t.polls)) out.push(`        ${short(host).padEnd(14)}  ${kinds.map((k) => String(p[k]).padStart(7)).join('  ')}`)
  if (Object.keys(t.polls).length === 0) out.push('        none')
  out.push(`EVENT   ${Object.keys(t.events).length === 0 ? 'none' : list(t.events, (h, v) => `${short(h)} ${v}`)}`)
  out.push(`other   ${Object.keys(t.other).length === 0 ? 'none' : ''}`.trimEnd())
  for (const [k, v] of Object.entries(t.other)) out.push(`        ${String(v).padStart(6)}  ${k}`)
  if (r.top) out.push(`top     cpu ${r.top.cpuS} s (${r.top.cpuPct ?? '?'}% of a core), csw ${r.top.csw}, sysbsd ${r.top.sysbsd}, idlew ${r.top.idlew}, power ${r.top.power ?? '?'} on average`)
  return `${out.join('\n')}\n`
}

export const renderJson = (r) => `${JSON.stringify(r, null, 2)}\n`

// ---- the command line

const USAGE = `usage: node claude-code/tools/idle-report.mjs [options]

What the Claude deck did while idle, from its log, per minute and in total: its IDLE lines (one a minute
at debug: CPU, event loop, memory, and its counts of scans, stats, walks, lsappinfo spawns, emits,
views, polls, sends and ticks), its POLL lines per session by kind (wait, at once, stray, none), its
EVENT lines per session, and the other lines by kind. Read only: it reads the log, runs ps and top, and
writes nothing.

  --log FILE   the deck's log (default claude-code/deck/com.karimdhanji.claude.sdPlugin/logs/
               com.karimdhanji.claude.0.log)
  --since ISO  from this time to the log's end
  --last N     the N minutes before now
  --live N     sample the deck's node process with top for N minutes (it takes that long), then report
               that window: top's CPU time, context switches, BSD syscalls, idle wakeups and power,
               a minute at a time, beside the log's
  --json       machine-readable output
  -h, --help   this text

Without --since, --last or --live, the whole log. Times in the log, and here, are UTC.
Exit status: 0 when it reported, 1 when the log can't be read or the deck isn't running (--live), 2 for
a usage error.
`

const OPTIONS = {
  log: { type: 'string' },
  since: { type: 'string' },
  last: { type: 'string' },
  live: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

const execFileP = promisify(execFile)

/**
 * The command line. `deps` stand in for the clock, ps and top, and the output, for the tests: `now()`, `run(file,
 * args, opts)` resolving to `{ stdout }`, `out(text)` and `err(text)`.
 */
export async function main(argv, deps = {}) {
  const now = deps.now ?? Date.now
  const run = deps.run ?? ((file, args, opts) => execFileP(file, args, { maxBuffer: 64 << 20, ...opts }))
  const out = deps.out ?? ((s) => process.stdout.write(s))
  const err = deps.err ?? ((s) => process.stderr.write(s))
  const usage = (why) => {
    err(`idle-report: ${why}\n\n${USAGE}`)
    return 2
  }
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }))
  } catch (e) {
    return usage(e.message)
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (['since', 'last', 'live'].filter((k) => values[k] !== undefined).length > 1) return usage('give one of --since, --last and --live')
  if (values.log === '') return usage('--log needs a file')
  const minutesOf = (k) => (/^\d+(\.\d+)?$/.test(values[k]) && Number(values[k]) > 0 ? Number(values[k]) : null)
  const window = { from: null, to: null, by: null }
  let top = null
  if (values.since !== undefined) {
    window.from = Date.parse(values.since)
    if (!Number.isFinite(window.from)) return usage(`--since ${JSON.stringify(values.since)} isn't a time`)
    window.by = `--since ${values.since}`
  } else if (values.last !== undefined) {
    const n = minutesOf('last')
    if (n === null) return usage('--last needs a number of minutes above 0')
    window.to = now()
    window.from = window.to - n * MINUTE_MS
    window.by = `--last ${values.last}`
  } else if (values.live !== undefined) {
    const n = minutesOf('live')
    if (n === null || !Number.isInteger(n)) return usage('--live needs a whole number of minutes above 0')
    let pid
    try {
      pid = deckPid((await run('/bin/ps', ['-axww', '-o', 'pid=,command='])).stdout)
    } catch (e) {
      err(`idle-report: ps failed: ${e.message}\n`)
      return 1
    }
    if (pid === null) {
      err(`idle-report: the Claude deck isn't running: no node process runs ${DECK_SCRIPT}\n`)
      return 1
    }
    err(`idle-report: sampling pid ${pid} with top for ${n} min\n`)
    window.from = now()
    window.to = window.from + n * MINUTE_MS
    window.by = `--live ${n}`
    try {
      const { stdout } = await run('/usr/bin/top', ['-l', String(n + 1), '-s', '60', '-c', 'd', '-pid', String(pid), '-stats', TOP_STATS], { timeout: (n + 2) * MINUTE_MS })
      top = { pid, deltas: topDeltas(parseTop(stdout).filter((s) => s.pid === pid)) }
    } catch (e) {
      err(`idle-report: top failed: ${e.message}\n`)
      return 1
    }
  }
  const file = path.resolve(values.log ?? DEFAULT_LOG)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    err(`idle-report: can't read ${file}: ${e.code ?? e.message}\n`)
    return 1
  }
  const report = buildReport(text, { log: file, ...window, top })
  out(values.json ? renderJson(report) : renderText(report))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
