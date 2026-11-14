#!/usr/bin/env node
// smoke-check: after the live smoke test (docs/claude-code/smoke-test.md), whether the Claude deck's log holds the
// lines that prove each of its steps, from --since to the log's end, for one session with --host: ok or missing,
// with those lines, and what only the user could see. Then what to look at: each RELEASED … (rule 2), a wrong release
// if the app's dialog was still up, each wake and what slept, each time the bridge listened again, each device the deck
// took as connected though it had missed its connect, and every warn and error line.
//
// Read only: it reads the deck's logs and claude-code/vendor/checked-version.txt, and writes nothing. Node 24, no
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
/** How long after a device's disconnected line its connected may come, and after that its repaint. */
export const RETURN_MS = 600_000
export const REPAINT_MS = 10_000
/** How long after the dial's Allow the agent's own call may end (step 15). */
export const CALL_END_MS = 60_000

// ---- the lines

const HOST = String.raw`local_[A-Za-z0-9-]{1,64}`
/** A value as the deck's quote() writes it (claude-code/deck/src/util/log.ts): a JSON string, or `none`. */
const QUOTED = String.raw`(?:"(?:[^"\\]|\\.)*"|none)`
const lineKind = (scopes, source) => ({ scopes: new Set(scopes), re: new RegExp(source) })

/**
 * The deck's lines the steps read, each by its scopes and its message, as claude-code/deck/src writes them:
 * plugin.ts (STARTUP, opened, woke up), bridge/held.ts (HELD, ANSWER, RELEASED), model/sessions.ts (HELLO, ENDED,
 * EVENT, STATUS, SEEN, THREADS), bridge/commands.ts (QUEUED), keys/commands.ts (Saved Prompt), slots/jump.ts (jump),
 * slots/slots.ts (SLOT), registry/watcher.ts (a session changed), the Devices scope (model/devices.ts: Device,
 * Repaint, and a device taken as connected) and bridge/server.ts (listening again). Phase 9's lines (THREADS, Device,
 * Repaint, the wake's suffix, listening again and HELD's agent) are the formats the deck and this agreed for
 * docs/claude-code/agents-and-wake.md.
 */
export const LINES = Object.freeze({
  startup: lineKind(['Claude'], String.raw`^STARTUP \{.*\}$`),
  // The agent part only for a request from another loop than the main one (PermissionRequest's agent_id).
  held: lineKind(['Sessions'], String.raw`^HELD #(\d+) (tool|ask) (${QUOTED}) ${QUOTED} fp (\S+) from (${HOST})(?: agent (${QUOTED}))?; \d+ held$`),
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
  // A session's other loops: the info lines when its running leaves 0 (with the newest run's label, if one has a loop
  // in a turn) and comes back to it, and the debug line for every threads event.
  threadsOn: lineKind(['Sessions'], String.raw`^THREADS (${HOST}): (\d+) in a turn(?: \((.+)\))?$`),
  threadsOff: lineKind(['Sessions'], String.raw`^THREADS (${HOST}): none in a turn$`),
  threads: lineKind(['Sessions'], String.raw`^THREADS (${HOST}): running (\d+), runs ?(.*)$`),
  device: lineKind(['Devices'], String.raw`^Device (${QUOTED}) \(([^)]+)\) (connected|disconnected)(?:, ([\d.]+) s after the wake)?$`),
  // A warn: a press from a device the deck had as not connected, so it missed that device's
  // connect. Its `connected` line follows.
  deviceTaken: lineKind(['Devices'], String.raw`^Device (${QUOTED}) \(([^)]+)\): (.+), though the deck had it as not connected; taking it as connected$`),
  repaint: lineKind(['Devices'], String.raw`^Repaint: every key and strip \((device connected|[\d.]+ s after the wake)\)$`),
  // The registry's sessions that changed, at debug: `<pid> <status>` or `<pid> <was> → <now>`, each with how long after
  // its statusUpdatedAt the deck read it, joined by "; ".
  registry: lineKind(['Registry'], String.raw`^a session changed(?:: (.+))?$`),
  // A deck from before Phase 9 says only "woke up: rescanning".
  woke: lineKind(['Claude'], String.raw`^woke up: rescanning(?:; (slept .+|no system sleep))?$`),
  relisten: lineKind(['Bridge'], String.raw`^listening again after the server (closed|errored): (.*)$`),
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

/** The run labels of a THREADS line, `<name> <finished>/<started>` each, comma-separated, as `{name, finished, started}`. */
function runLabels(text) {
  return text
    .split(', ')
    .map((l) => /^(.+) (\d+)\/(\d+)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ name: m[1], finished: Number(m[2]), started: Number(m[3]) }))
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

/** An EVENT line's loop, after its tool and fp: the agent it names, or null for the main loop's. */
const EVENT_AGENT = new RegExp(String.raw` agent (${QUOTED})$`)

/** A registry change line's sessions: `{key, from, to}` each, the status the same on both sides when it didn't change. */
function registryChanges(text) {
  return text
    .split('; ')
    .map((part) => /^(\S+) (no status|\S+)(?: → (no status|\S+))?(?:, read .*)?$/.exec(part))
    .filter(Boolean)
    .map((m) => ({ key: m[1], from: m[2], to: m[3] ?? m[2] }))
}

/**
 * What the steps read, from the lines at or after `since`, each with its time and raw line. The lines before it give
 * the context: which session each held request and command belongs to, and which sessions were running.
 * - A held request's id belongs to the latest HELD with it: ids start at 1 again when the deck restarts.
 * - A session is running from a hello that the registry listed, until its ENDED or the deck's restart. A dying mod's
 *   hello, "the registry doesn't list it yet", doesn't count.
 * - The registry's readings of each pid, `registry`, come from every line, before the window too: what it read last
 *   before a moment in the window counts.
 */
export function collect(text, since) {
  const w = {
    first: null, last: null, lines: 0, debug: false, starts: [], hellos: [], answers: [], releases: [], held: [], events: [], statuses: [], seen: [], jumps: [],
    opened: [], slots: [], prompts: [], threads: [], devices: [], devicesTaken: [], repaints: [], wakes: [], relistens: [], registry: [], problems: [],
  }
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
        const h = { id: m[1], kind: m[2], tool: unquote(m[3]), fp: m[4], host: m[5], agent: m[6] === undefined ? null : unquote(m[6]) }
        held.set(h.id, { ...h, t })
        if (now) w.held.push({ t, raw, ...h })
        break
      }
      case 'answer': {
        const h = held.get(m[1])
        if (now) w.answers.push({ t, raw, id: m[1], tool: unquote(m[2]), what: m[3], by: m[4] === 'a key press' ? 'key' : 'dial', host: h?.host ?? null, fp: h?.fp ?? null, kind: h?.kind ?? null, agent: h?.agent ?? null, heldAt: h?.t ?? null })
        break
      }
      case 'released': {
        const rule = /\(rule (\d)\b/.exec(m[2])
        const h = held.get(m[1])
        if (now) w.releases.push({ t, raw, id: m[1], rule: rule ? Number(rule[1]) : null, host: h?.host ?? null, kind: h?.kind ?? null, heldAt: h?.t ?? null })
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
      case 'event': {
        const agent = EVENT_AGENT.exec(m[3])
        if (now) w.events.push({ t, raw, host: m[1], type: m[2], agent: agent ? unquote(agent[1]) : null, fp: / fp (\S+)/.exec(m[3])?.[1] ?? null })
        break
      }
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
      case 'threadsOn':
        if (now) w.threads.push({ t, raw, host: m[1], running: Number(m[2]), runs: m[3] === undefined ? [] : runLabels(m[3]) })
        break
      case 'threadsOff':
        if (now) w.threads.push({ t, raw, host: m[1], running: 0, runs: [] })
        break
      case 'threads':
        if (now) w.threads.push({ t, raw, host: m[1], running: Number(m[2]), runs: runLabels(m[3]), debug: true })
        break
      case 'device':
        if (now) w.devices.push({ t, raw, name: unquote(m[1]), id: m[2], state: m[3], afterWakeS: m[4] === undefined ? null : Number(m[4]) })
        break
      case 'deviceTaken':
        if (now) w.devicesTaken.push({ t, raw, name: unquote(m[1]), id: m[2], what: m[3] })
        break
      case 'registry':
        for (const c of registryChanges(m[1] ?? '')) w.registry.push({ t, raw, ...c })
        break
      case 'repaint':
        if (now) w.repaints.push({ t, raw, why: m[1] })
        break
      case 'woke':
        if (now) w.wakes.push({ t, raw, slept: m[1] === undefined ? null : m[1] === 'no system sleep' ? false : m[1].slice('slept '.length) })
        break
      case 'relisten':
        if (now) w.relistens.push({ t, raw, after: m[1], reason: m[2] })
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
/** The steps whose proof is a debug line. */
const DEBUG_STEPS = '2, 7, 9, 11, 14 and 15'

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

/** How long after a registry reading the deck may log the request that made it `waiting`: the two race. */
const HELD_SLACK_MS = 1_000

/** Whether the deck held a request from `host` at `t`: held by then, give or take HELD_SLACK_MS, and not yet answered or let go. */
function heldAt(w, host, t) {
  const ended = (h) => [...w.answers, ...w.releases].some((e) => e.id === h.id && e.heldAt === h.t && e.t <= t)
  return w.held.some((h) => h.host === host && h.t <= t + HELD_SLACK_MS && !ended(h))
}

/**
 * Whether the registry stayed `busy` for `pid` from the session's background, `from`, to its other loops' last turn
 * end, `to` (agents-and-wake.md, B3): its last reading at or before `from`, if there's one, says busy, and none after it
 * and before `to` says otherwise. A `waiting` while the deck holds one of the session's requests is busy enough: a
 * workflow agent's Bash asks too, in Manual. Missing with why, or `{ok: true, detail}`.
 */
function registryStayedBusy(w, pid, from, to) {
  const readings = w.registry.filter((r) => r.key === pid)
  if (readings.length === 0) return missing(`no Registry line for pid ${pid}: is it the session's?${w.debug ? '' : DEBUG_NOTE}`, [from.raw])
  const asking = (r) => r.to === 'waiting' && heldAt(w, from.key, r.t)
  const before = readings.filter((r) => r.t <= from.t).at(-1)
  if (before !== undefined && before.to !== 'busy' && !asking(before)) return missing(`the registry read pid ${pid} ${before.to}, not busy, as the session went background`, [before.raw, from.raw])
  const during = readings.filter((r) => r.t > from.t && r.t < to.t)
  const left = during.find((r) => r.to !== 'busy' && !asking(r))
  if (left) return missing(`the registry read pid ${pid} ${left.from} → ${left.to} at ${hms(left.t)}, while only its other loops were in a turn: it didn't stay busy`, [from.raw, left.raw])
  const waits = during.filter((r) => r.to === 'waiting' && r.from !== 'waiting').length
  const but = waits === 0 ? '' : `, but for ${waits === 1 ? 'a wait' : `${waits} waits`} while it held a request of the session's`
  return { ok: true, detail: before === undefined ? `the registry didn't read pid ${pid} leaving busy${but}` : `the registry read pid ${pid} busy throughout${but}` }
}

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
      // The main loop's: step 15's is another loop's.
      const a = answerBy(w, mine, (x) => x.by === 'dial' && x.what === 'allow' && x.agent === null)
      return a ? ok([a.raw], `#${a.id} ${JSON.stringify(a.tool)}`) : missing("no Allow from a slot dial for the main loop's request")
    },
  },
  {
    n: 5,
    id: 'question',
    title: 'a question reads Answer in app, a press jumps, and answering in the app lets it go',
    see: "its strip and the Approve key read Answer in app, and the dial's press brought the session to the front",
    find(w, mine) {
      const asks = w.held.filter((h) => mine(h.host) && h.kind === 'ask' && h.tool === 'AskUserQuestion')
      if (asks.length === 0) return missing('no AskUserQuestion held for it')
      let why = null
      for (const h of asks) {
        // The deck never answers a question (PROTOCOL.md, "Permission requests", Phase 9).
        const answered = w.answers.find((a) => a.id === h.id && a.heldAt === h.t)
        if (answered) {
          why ??= missing(`the deck answered #${h.id}, and it never answers a question`, [h.raw, answered.raw])
          continue
        }
        const released = w.releases.find((r) => r.id === h.id && r.heldAt === h.t && r.rule !== null && r.rule <= 3)
        const jump = w.jumps.find((j) => j.host === h.host && j.via.startsWith('slot dial ') && j.t >= h.t && j.t <= (released?.t ?? Infinity))
        if (!jump) {
          why ??= missing(`no jump from its slot dial while #${h.id} was held`, [h.raw])
          continue
        }
        if (!released) {
          why ??= missing(`#${h.id} wasn't let go by rule 1, 2 or 3 after the jump: was it answered in the app?`, [h.raw, jump.raw])
          continue
        }
        return ok([h.raw, jump.raw, released.raw], `#${h.id}: its dial jumped ${secs(jump.t - h.t)} after it was held, and rule ${released.rule} let it go ${secs(released.t - jump.t)} later`)
      }
      return why
    },
  },
  {
    n: 6,
    id: 'approve-key',
    title: 'an approval on the Approve key',
    find(w, mine) {
      const a = answerBy(w, mine, (x) => x.by === 'key' && x.what === 'allow')
      return a ? ok([a.raw], `#${a.id} ${JSON.stringify(a.tool)}`) : missing('no Allow from a key press')
    },
  },
  {
    n: 7,
    id: 'deny',
    title: 'a Deny, whose interrupt stops the turn',
    see: 'the app marked the turn interrupted, and Claude said nothing more',
    find(w, mine) {
      const denies = w.answers.filter((a) => mine(a.host) && a.what === 'deny')
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
    n: 8,
    id: 'in-app',
    title: 'a request answered in the app, which the deck lets go',
    find(w, mine) {
      // An approval's: step 5's question is let go the same way.
      const r = w.releases.find((x) => mine(x.host) && x.kind === 'tool' && x.rule !== null && x.rule <= 3)
      const by = { 1: "the call's end", 2: 'the registry leaving waiting', 3: 'the registry going idle' }
      return r ? ok([r.raw], `#${r.id}, by rule ${r.rule}: ${by[r.rule]}`) : missing('no held approval of it released by rule 1, 2 or 3')
    },
  },
  {
    n: 9,
    id: 'slot-jump',
    title: 'a jump from a slot key',
    see: "the Claude app's window came to the front, from another app",
    find(w, mine) {
      const jumps = w.jumps.filter((j) => mine(j.host) && j.via.startsWith('slot key '))
      return jumps.length === 0 ? missing('no jump from a slot key') : jumpProof(w, jumps)
    },
  },
  {
    n: 10,
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
    n: 11,
    id: 'seen',
    title: 'seen, with the session on screen and Claude in front',
    find(w, mine) {
      const s = w.seen.find((x) => mine(x.host))
      return s ? ok([s.raw], 'a turn of its ended while it was on screen with Claude in front') : missing(`no SEEN line${w.debug ? '' : DEBUG_NOTE}`)
    },
  },
  {
    n: 12,
    id: 'swap',
    title: 'a swap between two slots',
    find(w, mine) {
      const swaps = w.slots.filter((s) => s.takes !== null && (mine(s.host) || mine(s.takes)))
      return swaps.length > 0 ? ok(swaps.slice(0, 2).map((s) => s.raw), `${swaps.length} swap(s)`) : missing('no long press that swapped two slots')
    },
  },
  {
    n: 13,
    id: 'version',
    title: "the session's Claude Code version",
    see: "the Setup page's second line showed it after the mode, with the newer mark only if step 13's detail expects one",
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
  {
    n: 14,
    id: 'background',
    title: "a workflow and a background subagent: Background, with the run's label",
    see: "the key read Background, blue, with the run's label on its bottom line, and the strip's Agents page listed the agents",
    find(w, mine, { pid }) {
      const ons = w.threads.filter((x) => mine(x.host) && !x.debug && x.running > 0)
      if (ons.length === 0) return missing('no THREADS line saying other loops were in a turn')
      let why = null
      for (const on of ons) {
        // Its own end: the next info line, which says none is in a turn, unless one was lost, as at a deck restart.
        const next = w.threads.find((x) => x.host === on.host && !x.debug && x.t > on.t)
        const off = next?.running === 0 ? next : undefined
        const during = w.threads.filter((x) => x.host === on.host && x.t >= on.t && x.t <= (off?.t ?? Infinity))
        const background = w.statuses.find((x) => x.key === on.host && x.to === 'background' && x.t >= on.t && x.t <= (off?.t ?? Infinity))
        if (!background) {
          why ??= missing(`it never read background while its other loops were in a turn${w.debug ? ': did the main turn end before they did?' : DEBUG_NOTE}`, [on.raw])
          continue
        }
        // The info line names a run only when one has a loop in a turn as running leaves 0; the debug lines name each.
        if (!during.some((x) => x.runs.length > 0)) {
          why ??= missing(`no workflow run's label while its other loops were in a turn${w.debug ? '' : DEBUG_NOTE}`, [on.raw, background.raw])
          continue
        }
        if (!off) {
          why ??= missing('no THREADS line saying none was in a turn any more: did the agents finish?', [on.raw, background.raw])
          continue
        }
        // The newest run, as the last line that names runs has it: with none in a turn, the mod lists the most recent
        // first. B3: its started counts the agent.spawn events that came with its run's id, and its finished the
        // turn ends of those agents that reached the mod, so with none in a turn they're equal.
        const run = during.filter((x) => x.runs.length > 0).at(-1).runs[0]
        const lines = [on.raw, background.raw, off.raw]
        if (run.started === 0) {
          why ??= missing(`the run ${run.name} started no agent: no agent.spawn came with its run's id`, lines)
          continue
        }
        if (run.finished < run.started) {
          why ??= missing(`the run ${run.name} at ${run.finished}/${run.started} last${w.debug ? `, with none in a turn: the turn ends of ${run.started - run.finished} of its agents never reached the mod` : DEBUG_NOTE}`, lines)
          continue
        }
        // B3: the registry stays busy while only the other loops run. The deck's log names a registry file only by its
        // pid, so only --pid ties it to the session.
        const registry = pid === null ? { ok: true, detail: "the registry wasn't checked: give --pid" } : registryStayedBusy(w, pid, background, off)
        if (registry.status === 'missing') {
          why ??= missing(registry.detail, [on.raw, ...registry.lines])
          continue
        }
        return ok(lines, `up to ${Math.max(...during.map((x) => x.running))} in a turn, the run ${run.name} at ${run.finished}/${run.started} last, background for ${secs(off.t - background.t)}; ${registry.detail}`)
      }
      return why
    },
  },
  {
    n: 15,
    id: 'agent-allow',
    title: "a workflow agent's request, allowed on its slot dial",
    see: "the app's dialog for the agent's Bash closed by itself, and the workflow went on",
    find(w, mine) {
      const allowed = w.answers.filter((x) => mine(x.host) && x.agent !== null && x.by === 'dial' && x.what === 'allow')
      if (allowed.length === 0) {
        const h = w.held.find((x) => mine(x.host) && x.agent !== null)
        return missing(h ? `#${h.id}, from agent ${JSON.stringify(h.agent)}, wasn't allowed on its slot dial` : 'no request held from another loop than the main one: no HELD … agent "…"', h ? [h.raw] : [])
      }
      let why = null
      for (const a of allowed) {
        const h = w.held.find((x) => x.id === a.id && x.t === a.heldAt)
        // B3: the request's agent_id is its tool.call's agentId. The mod tags the call's tool.end with that agentId, so
        // the call, by its fp, ends under the agent the request named; rule 1 matches the two (PROTOCOL.md, Held requests).
        const ends = w.events.filter((e) => e.host === a.host && e.type === 'tool.end' && e.fp === a.fp && after(a, e, CALL_END_MS))
        const end = ends.find((e) => e.agent === a.agent)
        if (end) return ok([h?.raw, a.raw, end.raw].filter(Boolean), `#${a.id} ${JSON.stringify(a.tool)}, from agent ${JSON.stringify(a.agent)}, whose call ended ${secs(end.t - a.t)} later under the same agent`)
        const other = ends[0]
        why ??= other
          ? missing(`#${a.id}'s call ended under ${other.agent === null ? 'the main loop' : `agent ${JSON.stringify(other.agent)}`}, not agent ${JSON.stringify(a.agent)}: the request's agent_id isn't its tool.call's agentId, so rule 1 can't let such a request go`, [h?.raw, a.raw, other.raw].filter(Boolean))
          : missing(`no tool.end of #${a.id}'s call (fp ${a.fp}) within ${CALL_END_MS / 1000} s of the Allow${w.debug ? '' : DEBUG_NOTE}`, [h?.raw, a.raw].filter(Boolean))
      }
      return why
    },
  },
  {
    n: 16,
    id: 'device',
    title: 'the deck leaves and comes back, and is repainted in full',
    see: 'the keys went dark, then came back showing the sessions as they are now, not the images from before',
    // The deck's, not a session's: --host doesn't apply.
    find(w) {
      const gone = w.devices.filter((d) => d.state === 'disconnected')
      if (gone.length === 0) return missing('no Device … disconnected line: move the cable away, or let the display sleep')
      let why = null
      for (const d of gone) {
        const back = w.devices.find((x) => x.id === d.id && x.state === 'connected' && after(d, x, RETURN_MS))
        if (!back) {
          why ??= missing(`${d.name ?? 'the device'} left at ${hms(d.t)} and didn't come back within ${RETURN_MS / 60_000} min`, [d.raw])
          continue
        }
        const repaint = w.repaints.find((r) => after(back, r, REPAINT_MS))
        if (!repaint) {
          why ??= missing(`no Repaint within ${REPAINT_MS / 1000} s of its return at ${hms(back.t)}`, [d.raw, back.raw])
          continue
        }
        const wake = w.wakes.filter((x) => x.t >= d.t && x.t <= back.t).at(-1)
        const slept = wake === undefined ? '' : `, after a wake with ${wake.slept === null ? 'no word on what slept' : wake.slept === false ? 'no system sleep' : `${wake.slept} of system sleep`}`
        // A connect the deck took from a press, not from the app: noted, as the watch lists it, not failed.
        const taken = w.devicesTaken.find((x) => x.id === back.id && x.t <= back.t && x.t > d.t)
        const by = taken ? `; the deck took it as connected because ${taken.what}, with no connect from the app` : ''
        return ok([d.raw, back.raw, repaint.raw], `back ${secs(back.t - d.t)} after it left${slept}, and repainted ${secs(repaint.t - back.t)} later (${repaint.why})${by}`)
      }
      return why
    },
  },
])

/**
 * The report on the log `text` from `since` (ms) on: each step, and what to watch. `host` limits the steps to that
 * session's lines, but for step 1's and step 16's; the watch list is the whole deck's. `vendored` is the vendored mods
 * API's version. `pid` is the session's registry file's pid, for step 14's registry check.
 */
export function buildReport(text, { since, host = null, pid = null, vendored = null, logs = [] }) {
  const w = collect(text, since)
  const mine = (h) => host === null || h === host
  const steps = STEPS.map(({ n, id, title, see, find }) => ({ n, id, title, see: see ?? null, ...find(w, mine, { vendored, pid }) }))
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
  if (w.lines > 0 && !w.debug) notes.push(`no debug line in the window: steps ${DEBUG_STEPS} need the deck at debug (log-level.txt)`)
  return {
    logs,
    window: { since: new Date(since).toISOString(), to: w.lines > 0 ? new Date(w.last).toISOString() : null, host, pid, lines: w.lines },
    vendored,
    steps,
    watch: {
      rule2: w.releases.filter((r) => r.rule === 2).map((r) => ({ line: r.raw, host: r.host, hint: relapse(r) })),
      // What woke the deck, and whether the Mac slept (agents-and-wake.md, C4), and each time the bridge listened again
      // after its server closed or errored (C5): nothing has shown that yet.
      wakes: w.wakes.map((x) => ({ line: x.raw, slept: x.slept })),
      relistens: w.relistens.map((x) => x.raw),
      // A device the deck took as connected from a press, so the app's connect never reached it (C1).
      devicesTaken: w.devicesTaken.map((x) => x.raw),
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
  const { since, to, lines, host, pid } = r.window
  const span = to === null ? 'no lines' : `to ${to}, ${Math.round((Date.parse(to) - Date.parse(since)) / 6000) / 10} min, ${lines} line(s)`
  out.push(`window    ${since} ${span}; ${host ? `session ${host}` : 'every session'}${pid ? `, pid ${pid}` : ''}`)
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
  out.push(`  woke up: ${r.watch.wakes.length === 0 ? 'none' : r.watch.wakes.length}`)
  for (const x of r.watch.wakes) out.push(`    ${x.line}`)
  out.push(`  bridge listening again: ${r.watch.relistens.length === 0 ? 'none' : r.watch.relistens.length}`)
  for (const line of r.watch.relistens) out.push(`    ${line}`)
  out.push(`  device taken as connected, its connect missed: ${r.watch.devicesTaken.length === 0 ? 'none' : r.watch.devicesTaken.length}`)
  for (const line of r.watch.devicesTaken) out.push(`    ${line}`)
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
that prove each of its 16 steps, from --since to the log's end. For each step, ok or missing, with the
lines that prove it or why not, and what only the user can say they saw. Then the lines to look at:
each RELEASED … (rule 2), a wrong release if the app's dialog was still up, each wake and what slept,
each time the bridge listened again, each device the deck took as connected, its connect missed, and
every warn and error.
Read only: it reads the deck's logs and claude-code/vendor/checked-version.txt, and writes nothing.

  --since ISO   where the window starts: when the test began (required)
  --host HOST   only this session's lines prove a step (the throwaway session's local_… id), but for
                step 1's, since the stopped session it starts is often yours, and step 16's, the
                device's. The watch list is the deck's.
  --pid PID     the session's pid, the name of its registry file in ~/.claude/sessions: step 14 also
                checks the registry stayed busy while only its other loops ran. Without it, step 14
                says the registry wasn't checked.
  --log FILE    this log only (default: the deck's newest, claude-code/deck/com.karimdhanji.claude.sdPlugin/
                logs/com.karimdhanji.claude.0.log, and the older ones in its folder back to --since)
  --json        machine-readable output
  -h, --help    this text

Steps 2, 7, 9, 11, 14 and 15 need the deck at debug (log-level.txt): EVENT, STATUS and SEEN lines, a
THREADS line for every snapshot, and the Registry's changes are debug.
Times are UTC.
Exit status: 0 when every step's proof is there, 1 when one is missing or the log can't be read, 2 for a
usage error.
`

const OPTIONS = {
  since: { type: 'string' },
  host: { type: 'string' },
  pid: { type: 'string' },
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
  if (values.pid !== undefined && !/^[1-9]\d{0,9}$/.test(values.pid)) return usage(`--pid ${JSON.stringify(values.pid)} isn't a pid`)
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
    pid: values.pid ?? null,
    vendored: 'vendored' in deps ? deps.vendored : vendoredVersion(),
    logs: logs.map((l) => l.file),
  })
  out(values.json ? renderJson(report) : renderText(report))
  return report.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
