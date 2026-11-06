#!/usr/bin/env node
// smoke-check: after the live smoke test (docs/claude-code/smoke-test.md), whether the Claude deck's log holds the
// lines that prove each of its steps, from --since to the log's end, for one session with --host: ok or missing,
// with those lines, and what only the user could see. Then what to look at: each RELEASED … (rule 2), a wrong release
// if the app's dialog was still up, and every warn and error line.
//
// Read only: it reads the deck's logs and the vendored mods API's first line, and writes nothing. Node 24, no
// dependencies.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_LOG, parseLine } from './idle-report.mjs'
import { HOST_PATTERN, vendoredVersion } from './recheck.mjs'

/** The deck's log folder. The SDK starts a new file each time the deck starts: 0 is the newest. */
export const LOG_DIR = path.dirname(DEFAULT_LOG)
const LOG_NAME = /^com\.karimdhanji\.claude\.(\d+)\.log$/

/** How long after a jump its "opened" line, and the session's attach, may come. */
export const JUMP_MS = 5_000
/** How long after the jump that started it a stopped session's hello may come. */
export const HELLO_MS = 120_000
/** How long after a Deny the turn's end may come. */
export const DENY_MS = 60_000
/** A rule 2 release looks wrong when the session reads needs-you within this, with nothing held for it since. */
export const RELAPSE_MS = 5_000

// ---- the lines

const HOST = String.raw`local_[A-Za-z0-9-]{1,64}`
/** A value as the deck's quote() writes it (claude-code/deck/src/util/log.ts): a JSON string, or `none`. */
const QUOTED = String.raw`(?:"(?:[^"\\]|\\.)*"|none)`
const lineKind = (scopes, source) => ({ scopes: new Set(scopes), re: new RegExp(source) })

/**
 * The deck's lines the steps read, each by its scopes and its message, as claude-code/deck/src writes them:
 * plugin.ts (STARTUP, opened), bridge/held.ts (HELD, ANSWER, RELEASED), model/sessions.ts (HELLO, ENDED, EVENT,
 * STATUS, SEEN), bridge/commands.ts (QUEUED), keys/commands.ts (Saved Prompt), slots/jump.ts and sessions/dials.ts
 * (jump), slots/slots.ts (SLOT).
 */
export const LINES = Object.freeze({
  startup: lineKind(['Claude'], String.raw`^STARTUP \{.*\}$`),
  held: lineKind(['Sessions'], String.raw`^HELD #(\d+) (?:tool|ask) ${QUOTED} ${QUOTED} fp (\S+) from (${HOST}); \d+ held$`),
  answer: lineKind(['Sessions'], String.raw`^ANSWER #(\d+) (${QUOTED}): (.+), from (a key press|its session's dial); \d+ held$`),
  released: lineKind(['Sessions'], String.raw`^RELEASED #(\d+) ${QUOTED}: (.+); \d+ held$`),
  hello: lineKind(['Sessions'], String.raw`^HELLO (${HOST}) inst ${QUOTED} plugin ${QUOTED} cc (${QUOTED})(.*)$`),
  ended: lineKind(['Sessions'], String.raw`^ENDED (${HOST}): no registry file lists it any more$`),
  event: lineKind(['Sessions'], String.raw`^EVENT (${HOST}) (\S+)(.*)$`),
  status: lineKind(['Sessions'], String.raw`^STATUS (\S+) (?:\S+ )?→ (\S+)$`),
  seen: lineKind(['Sessions'], String.raw`^SEEN (${HOST}): on screen with Claude in front$`),
  queued: lineKind(['Sessions'], String.raw`^QUEUED (c\d+) prompt \(\d+ characters\) for (${HOST})$`),
  prompt: lineKind(['Keys'], String.raw`^Saved Prompt (c\d+): (done|refused|failed)(?:: .*)?$`),
  jump: lineKind(['Keys', 'Dials'], String.raw`^jump (${HOST}) via (.+?)(?:: ${QUOTED})?$`),
  opened: lineKind(['Jump'], String.raw`^opened claude://code/continue\?session=(${HOST}) in (\d+) ms$`),
  slot: lineKind(['Slots'], String.raw`^SLOT (\S+) ← (${HOST}) \(long press\)(?:, from (\S+), which (?:takes (${HOST})|is empty now)|, in place of (${HOST}))?$`),
})

/** One line of the deck's log, parsed: its time, level, scope and message, its raw text, and its kind with the match. Null without a time. */
export function classify(raw) {
  const line = parseLine(raw)
  if (line === null) return null
  for (const [name, { scopes, re }] of Object.entries(LINES)) {
    if (!scopes.has(line.scope)) continue
    const m = re.exec(line.message)
    if (m) return { ...line, raw, kind: name, m }
  }
  return { ...line, raw, kind: null, m: null }
}

/** A quote()d value back as it was: null for `none`. */
function unquote(q) {
  if (q === 'none') return null
  try {
    return JSON.parse(q)
  } catch {
    return q
  }
}

/**
 * What the steps read, from the lines at or after `since`, each with its time and raw line. The lines before it give
 * the context: which session each held request and command belongs to, and which sessions were running.
 * - A held request's id belongs to the latest HELD with it: ids start at 1 again when the deck restarts.
 * - A session is running from a hello that the registry listed, until its ENDED or the deck's restart. A dying mod's
 *   hello, "the registry doesn't list it yet", doesn't count.
 */
export function collect(text, since) {
  const w = { first: null, last: null, lines: 0, debug: false, starts: [], hellos: [], answers: [], releases: [], held: [], events: [], statuses: [], seen: [], jumps: [], opened: [], slots: [], prompts: [], problems: [] }
  const held = new Map()
  const queued = new Map()
  const running = new Map()
  for (const raw of text.split('\n')) {
    const l = classify(raw)
    if (l === null) continue
    w.first ??= l.t
    w.last = l.t
    const now = l.t >= since
    if (now) {
      w.lines++
      if (l.level === 'debug' || l.level === 'trace') w.debug = true
      if (l.level === 'warn' || l.level === 'error') w.problems.push({ t: l.t, raw })
    }
    const { m, t } = l
    switch (l.kind) {
      case 'startup':
        // A deck that has just started has heard from no session yet.
        running.clear()
        if (now) w.starts.push({ t, raw })
        break
      case 'held': {
        const h = { id: m[1], fp: m[2], host: m[3] }
        held.set(h.id, h)
        if (now) w.held.push({ t, raw, ...h })
        break
      }
      case 'answer': {
        const h = held.get(m[1])
        if (now) w.answers.push({ t, raw, id: m[1], tool: unquote(m[2]), what: m[3], by: m[4] === 'a key press' ? 'key' : 'dial', host: h?.host ?? null, fp: h?.fp ?? null })
        break
      }
      case 'released': {
        const rule = /\(rule (\d)\b/.exec(m[2])
        if (now) w.releases.push({ t, raw, id: m[1], rule: rule ? Number(rule[1]) : null, host: held.get(m[1])?.host ?? null })
        break
      }
      case 'hello': {
        const unlisted = m[3].includes("the registry doesn't list it yet")
        if (!unlisted) running.set(m[1], true)
        if (now) w.hellos.push({ t, raw, host: m[1], cc: unquote(m[2]), unlisted })
        break
      }
      case 'ended':
        running.set(m[1], false)
        break
      case 'event':
        if (now) w.events.push({ t, raw, host: m[1], type: m[2], agent: /\bagent "/.test(m[3]), fp: / fp (\S+)/.exec(m[3])?.[1] ?? null })
        break
      case 'status':
        if (now) w.statuses.push({ t, raw, key: m[1], to: m[2] })
        break
      case 'seen':
        if (now) w.seen.push({ t, raw, host: m[1] })
        break
      case 'queued':
        queued.set(m[1], { host: m[2], t })
        break
      case 'prompt': {
        const q = queued.get(m[1])
        if (now) w.prompts.push({ t, raw, id: m[1], state: m[2], host: q?.host ?? null, queuedAt: q?.t ?? null })
        break
      }
      case 'jump':
        if (now) w.jumps.push({ t, raw, host: m[1], via: m[2], wasRunning: running.get(m[1]) === true })
        break
      case 'opened':
        if (now) w.opened.push({ t, raw, host: m[1], ms: Number(m[2]) })
        break
      case 'slot':
        if (now) w.slots.push({ t, raw, slot: m[1], host: m[2], from: m[3] ?? null, takes: m[4] ?? null, replaced: m[5] ?? null })
        break
    }
  }
  return w
}

// ---- the steps

const hms = (t) => new Date(t).toISOString().slice(11, 23)
const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`)
const after = (a, b, ms) => b.t >= a.t && b.t - a.t <= ms
const ok = (lines, detail) => ({ status: 'ok', lines, detail })
const missing = (detail, lines = []) => ({ status: 'missing', lines, detail })
const DEBUG_NOTE = "; its proof is a debug line, and the window has none: log-level.txt isn't debug"

/** Compares two x.y.z versions: below 0, 0 or above 0; null when either isn't one. */
export function compareVersions(a, b) {
  const p = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const [x, y] = [p(a), p(b)]
  if (x === null || y === null) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * A jump of `jumps` with its "opened" line, and the session's attach, each within JUMP_MS of the press: the app showed
 * it. The first that has both, else why the first fell short.
 */
function jumpProof(w, jumps) {
  let why = null
  for (const j of jumps) {
    const opened = w.opened.find((o) => o.host === j.host && after(j, o, JUMP_MS))
    if (!opened) {
      why ??= missing(`the jump at ${hms(j.t)} has no "opened" line within ${JUMP_MS / 1000} s`, [j.raw])
      continue
    }
    const shown = w.events.find((e) => e.host === j.host && e.type === 'attach' && after(j, e, JUMP_MS))
    if (shown) return ok([j.raw, opened.raw, shown.raw], `opened in ${opened.ms} ms, and the app showed it ${secs(shown.t - j.t)} after the press`)
    why ??= missing(`the jump at ${hms(j.t)} opened in ${opened.ms} ms, but no attach followed within ${JUMP_MS / 1000} s: was the session on screen already?${w.debug ? '' : DEBUG_NOTE}`, [j.raw, opened.raw])
  }
  return why
}

const answerBy = (w, mine, test) => w.answers.find((a) => mine(a.host) && test(a))

/**
 * The steps, as docs/claude-code/smoke-test.md numbers them. `find(w, mine, ctx)` gives ok, with the lines that prove
 * it, or missing, with why. `see` is what only the user can tell, which the log can't.
 */
export const STEPS = Object.freeze([
  {
    n: 1,
    id: 'stopped',
    title: 'a jump starts a stopped session',
    see: 'the app came to the front on that session, and its key lit up within seconds',
    // Any session's: the stopped one is often the user's own. --host doesn't apply.
    find(w) {
      const tries = w.jumps.filter((j) => !j.wasRunning)
      if (tries.length === 0) return missing("no jump to a session that wasn't running: press a slot key that reads Not running")
      let why = null
      for (const j of tries) {
        const opened = w.opened.find((o) => o.host === j.host && after(j, o, JUMP_MS))
        const hello = w.hellos.find((h) => h.host === j.host && !h.unlisted && after(j, h, HELLO_MS))
        if (opened && hello) return ok([j.raw, opened.raw, hello.raw], `opened in ${opened.ms} ms, and its hello came ${secs(hello.t - j.t)} after the press`)
        why ??= missing(`${j.host} wasn't running at the jump at ${hms(j.t)}, but ${opened ? `no hello from it followed within ${HELLO_MS / 1000} s` : `no "opened" line followed within ${JUMP_MS / 1000} s`}`, [j.raw])
      }
      return why
    },
  },
  {
    n: 2,
    id: 'others',
    title: 'a jump from Others',
    see: "the app came to the front on the session, with its own permission dialog up beside the request on the Approve key",
    find(w, mine) {
      const jumps = w.jumps.filter((j) => mine(j.host) && j.via === 'the Others key')
      return jumps.length === 0 ? missing('no jump from the Others key') : jumpProof(w, jumps)
    },
  },
  {
    n: 3,
    id: 'long-press',
    title: 'a long press puts the session on a slot',
    find(w, mine) {
      const placed = w.slots.filter((s) => mine(s.host))
      const s = placed.find((p) => p.from === null) ?? placed[0]
      return s ? ok([s.raw], s.replaced ? `in place of ${s.replaced}` : s.from ? `from ${s.from}` : 'on an empty slot') : missing('no long press put the session on a slot')
    },
  },
  {
    n: 4,
    id: 'dial-allow',
    title: 'an approval on its slot dial',
    see: "the app's permission dialog closed by itself",
    find(w, mine) {
      const a = answerBy(w, mine, (x) => x.by === 'dial' && x.what === 'allow')
      return a ? ok([a.raw], `#${a.id} ${JSON.stringify(a.tool)}`) : missing('no Allow from a slot dial')
    },
  },
  {
    n: 5,
    id: 'question',
    title: 'a question answered on its slot dial',
    see: "the app's question card closed by itself, and Claude read the answer",
    find(w, mine) {
      const a = answerBy(w, mine, (x) => x.by === 'dial' && x.tool === 'AskUserQuestion' && x.what.startsWith('answered '))
      return a ? ok([a.raw], `#${a.id}`) : missing('no AskUserQuestion answered from a slot dial')
    },
  },
  {
    n: 6,
    id: 'plan',
    title: 'a plan approved into Manual on its slot dial',
    see: "the app's plan card closed by itself, and the session left Plan mode",
    find(w, mine) {
      const a = answerBy(w, mine, (x) => x.by === 'dial' && x.what === 'plan approved into default')
      if (a) return ok([a.raw], `#${a.id}, into default, the app's Manual`)
      const other = answerBy(w, mine, (x) => x.tool === 'ExitPlanMode')
      return missing(other ? `the plan's answer was "${other.what}", not "plan approved into default"` : 'no plan approved from a slot dial', other ? [other.raw] : [])
    },
  },
  {
    n: 7,
    id: 'approve-key',
    title: 'an approval on the Approve key',
    find(w, mine) {
      const a = answerBy(w, mine, (x) => x.by === 'key' && x.what === 'allow')
      return a ? ok([a.raw], `#${a.id} ${JSON.stringify(a.tool)}`) : missing('no Allow from a key press')
    },
  },
  {
    n: 8,
    id: 'deny',
    title: 'a Deny, whose interrupt stops the turn',
    see: 'the app marked the turn interrupted, and Claude said nothing more',
    find(w, mine) {
      const denies = w.answers.filter((a) => mine(a.host) && (a.what === 'deny' || a.what === 'plan rejected (deny)'))
      if (denies.length === 0) return missing('no Deny, from a key or a slot dial')
      let why = null
      for (const a of denies) {
        // The denied turn's own end: the session's next turn.end, before any turn.start.
        const next = w.events.find((e) => e.host === a.host && (e.type === 'turn.end' || e.type === 'turn.start') && after(a, e, DENY_MS))
        if (next?.type !== 'turn.end') {
          why ??= missing(`the turn of the Deny at ${hms(a.t)} has no turn.end within ${DENY_MS / 1000} s${next ? ', before the next turn.start' : ''}${w.debug ? '' : DEBUG_NOTE}`, [a.raw])
          continue
        }
        // Another call or request before that end is the turn going on. The denied call's own tool.start can land late.
        const call = w.events.find((e) => e.host === a.host && e.type === 'tool.start' && !e.agent && e.fp !== a.fp && e.t > a.t && e.t < next.t) ?? w.held.find((h) => h.host === a.host && h.t > a.t && h.t < next.t)
        if (call) {
          why ??= missing(`the turn went on after the Deny at ${hms(a.t)}: another call started before its end`, [a.raw, call.raw, next.raw])
          continue
        }
        return ok([a.raw, next.raw], `the turn ended ${secs(next.t - a.t)} later, with no other call`)
      }
      return why
    },
  },
  {
    n: 9,
    id: 'in-app',
    title: 'a request answered in the app, which the deck lets go',
    find(w, mine) {
      const r = w.releases.find((x) => mine(x.host) && x.rule !== null && x.rule <= 3)
      const by = { 1: "the call's end", 2: 'the registry leaving waiting', 3: 'the registry going idle' }
      return r ? ok([r.raw], `#${r.id}, by rule ${r.rule}: ${by[r.rule]}`) : missing('no held request of it released by rule 1, 2 or 3')
    },
  },
  {
    n: 10,
    id: 'slot-jump',
    title: 'a jump from a slot key',
    see: "the Claude app's window came to the front, from another app",
    find(w, mine) {
      const jumps = w.jumps.filter((j) => mine(j.host) && j.via.startsWith('slot key '))
      return jumps.length === 0 ? missing('no jump from a slot key') : jumpProof(w, jumps)
    },
  },
  {
    n: 11,
    id: 'prompt',
    title: 'a Saved Prompt',
    find(w, mine) {
      const done = w.prompts.find((p) => mine(p.host) && p.state === 'done')
      if (done) return ok([done.raw], done.queuedAt === null ? done.id : `${done.id}, done ${secs(done.t - done.queuedAt)} after it was queued`)
      const other = w.prompts.find((p) => mine(p.host))
      return missing(other ? `${other.id} ended ${other.state}` : 'no Saved Prompt for it ended done', other ? [other.raw] : [])
    },
  },
  {
    n: 12,
    id: 'seen',
    title: 'seen, with the session on screen and Claude in front',
    find(w, mine) {
      const s = w.seen.find((x) => mine(x.host))
      return s ? ok([s.raw], 'a turn of its ended while it was on screen with Claude in front') : missing(`no SEEN line${w.debug ? '' : DEBUG_NOTE}`)
    },
  },
  {
    n: 13,
    id: 'swap',
    title: 'a swap between two slots',
    find(w, mine) {
      const swaps = w.slots.filter((s) => s.takes !== null && (mine(s.host) || mine(s.takes)))
      return swaps.length > 0 ? ok(swaps.slice(0, 2).map((s) => s.raw), `${swaps.length} swap(s)`) : missing('no long press that swapped two slots')
    },
  },
  {
    n: 14,
    id: 'version',
    title: "the session's Claude Code version",
    see: "the Setup page's second line showed it after the mode, with the newer mark only if step 14's detail expects one",
    find(w, mine, { vendored }) {
      const h = w.hellos.filter((x) => mine(x.host) && !x.unlisted).at(-1)
      if (!h) return missing('no hello from it in the window')
      if (h.cc === null) return missing('its hello gave no Claude Code version', [h.raw])
      const c = compareVersions(h.cc, vendored)
      const vs =
        vendored === null ? "the vendored reference names no version"
        : c === null ? `the vendored reference is ${vendored}`
        : c > 0 ? `newer than the vendored reference's ${vendored}: expect the mark`
        : c < 0 ? `older than the vendored reference's ${vendored}`
        : 'the vendored reference\'s: expect no mark'
      return ok([h.raw], `${h.cc}, ${vs}`)
    },
  },
])

/**
 * The report on the log `text` from `since` (ms) on: each step, and what to watch. `host` limits the steps to that
 * session's lines, but for step 1's; the watch list is the whole deck's. `vendored` is the vendored mods API's version.
 */
export function buildReport(text, { since, host = null, vendored = null, logs = [] }) {
  const w = collect(text, since)
  const mine = (h) => host === null || h === host
  const steps = STEPS.map(({ n, id, title, see, find }) => ({ n, id, title, see: see ?? null, ...find(w, mine, { vendored }) }))
  const relapse = (r) => {
    if (r.host === null) return null
    const s = w.statuses.find((x) => x.key === r.host && x.to === 'needs-you' && after(r, x, RELAPSE_MS))
    if (!s || w.held.some((h) => h.host === r.host && h.t > r.t && h.t <= s.t)) return null
    return `${r.host} read needs-you ${secs(s.t - r.t)} later with nothing held: was the app's dialog still up?`
  }
  const summary = { ok: steps.filter((s) => s.status === 'ok').length, missing: steps.filter((s) => s.status === 'missing').length }
  const notes = []
  if (w.first !== null && w.first > since) notes.push(`the logs start at ${new Date(w.first).toISOString()}, after --since: older ones have gone`)
  for (const s of w.starts) notes.push(`the deck started at ${new Date(s.t).toISOString()}, in the window: requests it held then went back to the app's dialogs`)
  if (w.lines > 0 && !w.debug) notes.push('no debug line in the window: steps 2, 8, 10 and 12 need the deck at debug (log-level.txt)')
  return {
    logs,
    window: { since: new Date(since).toISOString(), to: w.lines > 0 ? new Date(w.last).toISOString() : null, host, lines: w.lines },
    vendored,
    steps,
    watch: {
      rule2: w.releases.filter((r) => r.rule === 2).map((r) => ({ line: r.raw, host: r.host, hint: relapse(r) })),
      problems: w.problems.map((p) => p.raw),
    },
    notes,
    summary,
    ok: summary.missing === 0,
  }
}

const tilde = (p) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p)

/** The logs read, oldest first: their folder once, when they share one. */
function logsText(logs) {
  if (logs.length === 0) return '(text)'
  const dirs = new Set(logs.map((f) => path.dirname(f)))
  if (logs.length === 1 || dirs.size > 1) return logs.map(tilde).join(', ')
  return `${tilde([...dirs][0])}/ ${logs.map((f) => path.basename(f)).join(', ')}`
}

export function renderText(r) {
  const out = [`log       ${logsText(r.logs)}`]
  const { since, to, lines, host } = r.window
  const span = to === null ? 'no lines' : `to ${to}, ${Math.round((Date.parse(to) - Date.parse(since)) / 6000) / 10} min, ${lines} line(s)`
  out.push(`window    ${since} ${span}; ${host ? `session ${host}` : 'every session'}`)
  out.push(`vendored  ${r.vendored ?? 'unknown'}`)
  for (const note of r.notes) out.push(`note      ${note}`)
  out.push('')
  const pad = ' '.repeat(13)
  for (const s of r.steps) {
    out.push(`${String(s.n).padStart(2)}  ${s.status.padEnd(7)}  ${s.title}`)
    for (const line of s.lines) out.push(`${pad}${line}`)
    out.push(`${pad}${s.detail}`)
  }
  out.push('', 'watch')
  out.push(`  RELEASED … (rule 2): ${r.watch.rule2.length === 0 ? 'none' : r.watch.rule2.length}`)
  for (const x of r.watch.rule2) {
    out.push(`    ${x.line}`)
    if (x.hint) out.push(`      ${x.hint}`)
  }
  out.push(`  warn and error: ${r.watch.problems.length === 0 ? 'none' : r.watch.problems.length}`)
  for (const line of r.watch.problems) out.push(`    ${line}`)
  const see = r.steps.filter((s) => s.see !== null)
  out.push('', 'ask the user')
  for (const s of see) out.push(`${String(s.n).padStart(4)}  ${s.see}`)
  out.push('', `${r.summary.ok} ok, ${r.summary.missing} missing`)
  return `${out.join('\n')}\n`
}

export const renderJson = (r) => `${JSON.stringify(r, null, 2)}\n`

// ---- the logs

/** The first time in a log's text, or null. */
function firstTime(text) {
  for (const raw of text.split('\n', 50)) {
    const l = parseLine(raw)
    if (l !== null) return l.t
  }
  return null
}

/**
 * The deck's logs in `dir` that reach back to `since`: the newest, .0, and the older ones until one starts at or
 * before it, oldest first, each as { file, text }.
 */
export function deckLogs(dir, since, fsys = fs) {
  const names = fsys
    .readdirSync(dir)
    .map((name) => [name, LOG_NAME.exec(name)])
    .filter(([, m]) => m)
    .sort(([, a], [, b]) => Number(a[1]) - Number(b[1]))
    .map(([name]) => name)
  if (names[0] !== 'com.karimdhanji.claude.0.log') throw Object.assign(new Error(`no com.karimdhanji.claude.0.log in ${dir}`), { code: 'ENOENT' })
  const logs = []
  for (const name of names) {
    const file = path.join(dir, name)
    const text = fsys.readFileSync(file, 'utf8')
    logs.unshift({ file, text })
    const first = firstTime(text)
    if (first !== null && first <= since) break
  }
  return logs
}

// ---- the command line

const USAGE = `usage: node claude-code/tools/smoke-check.mjs --since ISO [options]

After the live smoke test (docs/claude-code/smoke-test.md): whether the Claude deck's log has the lines
that prove each of its 14 steps, from --since to the log's end. For each step, ok or missing, with the
lines that prove it or why not, and what only the user can say they saw. Then the lines to look at:
each RELEASED … (rule 2), a wrong release if the app's dialog was still up, and every warn and error.
Read only: it reads the deck's logs and the vendored mods API's first line, and writes nothing.

  --since ISO   where the window starts: when the test began (required)
  --host HOST   only this session's lines prove a step (the throwaway session's local_… id), but for
                step 1's: the stopped session it starts is often yours. The watch list is the deck's.
  --log FILE    this log only (default: the deck's newest, claude-code/deck/com.karimdhanji.claude.sdPlugin/
                logs/com.karimdhanji.claude.0.log, and the older ones in its folder back to --since)
  --json        machine-readable output
  -h, --help    this text

Steps 2, 8, 10 and 12 need the deck at debug (log-level.txt): EVENT and SEEN lines are debug. Times are UTC.
Exit status: 0 when every step's proof is there, 1 when one is missing or the log can't be read, 2 for a
usage error.
`

const OPTIONS = {
  since: { type: 'string' },
  host: { type: 'string' },
  log: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

/** The command line. `deps` stand in for the log folder, the vendored version and the output, for the tests. */
export function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s))
  const err = deps.err ?? ((s) => process.stderr.write(s))
  const usage = (why) => {
    err(`smoke-check: ${why}\n\n${USAGE}`)
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
  if (values.since === undefined) return usage('--since is required: when the test began')
  const since = Date.parse(values.since)
  if (!Number.isFinite(since)) return usage(`--since ${JSON.stringify(values.since)} isn't a time`)
  if (values.host !== undefined && !HOST_PATTERN.test(values.host)) return usage(`--host ${JSON.stringify(values.host)} isn't a session's local_… id`)
  if (values.log === '') return usage('--log needs a file')
  let logs
  try {
    logs = values.log !== undefined ? [{ file: path.resolve(values.log), text: fs.readFileSync(values.log, 'utf8') }] : deckLogs(deps.logDir ?? LOG_DIR, since)
  } catch (e) {
    err(`smoke-check: can't read the deck's log: ${e.message}\n`)
    return 1
  }
  const report = buildReport(logs.map((l) => l.text).join('\n'), {
    since,
    host: values.host ?? null,
    vendored: 'vendored' in deps ? deps.vendored : vendoredVersion(),
    logs: logs.map((l) => l.file),
  })
  out(values.json ? renderJson(report) : renderText(report))
  return report.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
