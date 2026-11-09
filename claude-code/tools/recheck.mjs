#!/usr/bin/env node
// recheck: after a Claude app update, says whether the undocumented internals the deck and the plugin rely on
// still hold (docs/claude-code/plan.md, Phase 6; how each was found is in the plan's Log, S0–S5). USAGE below
// (`--help`) says what each of its eight checks reads and when it warns or fails; the specs and the comments beside
// them say why. Read only: see USAGE. Node 24, no dependencies.

import { execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import * as refresh from '../vendor/refresh.mjs'

const HOME = os.homedir()
/** The repository this script is in: the deck's sources (for citations) and, by default, the plugin at HEAD. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = '/Applications/Claude.app'

export const DEFAULTS = Object.freeze({
  sessions: path.join(HOME, '.claude', 'sessions'),
  records: path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  asar: path.join(APP, 'Contents', 'Resources', 'app.asar'),
  infoPlist: path.join(APP, 'Contents', 'Info.plist'),
  claudeCodeRoot: path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code'),
  repo: REPO,
  /** The vendored mods API reference, which claude-code/vendor/refresh.mjs makes from a bundled Claude Code. */
  vendored: path.join(REPO, 'claude-code', 'vendor', 'mods-api', 'claude-code.d.ts'),
  /** What the deck's "seen" check runs: front.ts's LSAPPINFO, which the drift test holds this to. */
  lsappinfo: '/usr/bin/lsappinfo',
})

export const VENDORED_DTS = DEFAULTS.vendored

/**
 * The Claude Code version the vendored mods API reference and these checks are for: the one its declarations' first
 * line names (`// Written by Claude Code <version>.`), so a refresh moves it and nothing else has to. Null when the
 * file is missing or its first line says no version, which check 1 reports.
 */
export function vendoredVersion(file = VENDORED_DTS) {
  let head
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(80)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, 80, 0)).toString('utf8').split('\n', 1)[0]
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  return /^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\.$/.exec(head)?.[1] ?? null
}

export const CHECKED_CC_VERSION = vendoredVersion()
/** The app version the Log's findings were made on (docs/claude-code/plan.md, kickoff and S5). */
export const FINDINGS_APP_VERSION = '4.4212.0'
/** The plugin check 5 runs on, from the repository's HEAD. */
export const PLUGIN_PATH = 'claude-code/plugin'

/**
 * The app's `local_…` ids, as its `claude://code/continue` route accepts them: claude-code/deck/src/protocol/wire.ts's
 * HOST_PATTERN and plan.md S5. The deck reads a registry hostSessionId only when it matches (wire.ts's asHost), and
 * opens only `<host>.json` records whose host does (records.ts:119).
 */
export const HOST_PATTERN = /^local_[A-Za-z0-9-]{1,64}$/

/** The registry statuses the deck knows (registry.ts:16, status.ts:37-42); any other reads as idle. */
export const REGISTRY_STATUSES = Object.freeze(['idle', 'busy', 'waiting'])

/** The modes the deck has a name for (claude-code/deck/src/model/format.ts:4-11); any other shows as it is. */
export const MODE_NAMES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'])

const DECK = 'claude-code/deck/src'
const REGISTRY_TS = `${DECK}/registry/registry.ts`
const RECORDS_TS = `${DECK}/records/records.ts`
const PROTOCOL = 'claude-code/protocol/PROTOCOL.md'
const DESKTOP_TS = 'claude-code/plugin/hooks/desktop.ts'
const STATUS_TS = `${DECK}/model/status.ts`
/** The deck's "seen" check, whose two answers check 7 reads as it does. */
export const FRONT_TS = `${DECK}/model/front.ts`

/**
 * How front.ts reads lsappinfo's two answers, and the bundle id it compares the app in front with: its parseFrontAsn's
 * and parseBundleId's patterns and its CLAUDE_BUNDLE_ID, copied, as the drift test holds them to its text.
 */
export const FRONT_ASN = /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i
export const FRONT_BUNDLE_ID = /"CFBundleIdentifier"="([^"]*)"/
export const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop'

/**
 * The post-turn summary's fields that the app's record loader keeps only when each is missing or a string, in the
 * order app 4.4212.0 lists them (its `OM` walks the list; PROTOCOL.md, status rule 6). claude-code/tools/lib/
 * registry.mjs's SUMMARY_FIELDS is the same list, which the tests hold it to.
 */
export const SUMMARY_FIELDS = Object.freeze(['title', 'description', 'status_category', 'status_detail', 'recent_action', 'needs_action', 'summarizes_uuid'])

/**
 * Why the app's record loader drops a post-turn summary, or null when it keeps it: its `OM`. Not an object, an array,
 * a listed field that's there and not a string (null included), or an is_noteworthy that's there and not a boolean.
 */
export function summaryDropped(v) {
  if (!isObj(v)) return kind(v)
  for (const f of SUMMARY_FIELDS) if (v[f] !== undefined && typeof v[f] !== 'string') return "object the app's loader drops"
  if (v.is_noteworthy !== undefined && typeof v.is_noteworthy !== 'boolean') return "object the app's loader drops"
  return null
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const isObj = (v) => kind(v) === 'object'
/** Each `check` returns null when the deck can use the value, else a short name for what it is instead. */
const aString = (v) => (typeof v === 'string' ? null : kind(v))
const aNonEmptyString = (v) => (typeof v !== 'string' ? kind(v) : v === '' ? 'empty string' : null)
const aNumber = (v) => (typeof v !== 'number' ? kind(v) : Number.isFinite(v) ? null : 'non-finite number')

/**
 * Every registry field the deck reads: parseSession, claude-code/deck/src/registry/registry.ts:56-67. `reads` is the
 * code that reads it (the file and a fragment of the line), so the JSON output cites it and the tests can tell when
 * the deck's reading changes. `need`: a required field fails when no entry has it; an optional one, which the deck
 * can do without, only warns. Both warn when some entries lack it.
 */
export const REGISTRY_FIELDS = Object.freeze([
  {
    field: 'hostSessionId', expect: 'local_ id', need: 'required', reads: [REGISTRY_TS, 'hostSessionId: str(o.hostSessionId)'],
    why: "The deck keys each session by it: jumps, the app's records and the bridge's reports all go by it.",
    check: (v) => (typeof v !== 'string' ? kind(v) : HOST_PATTERN.test(v) ? null : 'other string'),
  },
  {
    field: 'status', expect: 'string', values: REGISTRY_STATUSES, need: 'required', reads: [REGISTRY_TS, 'status: str(o.status)'],
    why: "Every session's status on the deck starts from it: idle, busy or waiting.",
    check: (v) => (typeof v !== 'string' ? kind(v) : REGISTRY_STATUSES.includes(v) ? null : 'other status'),
  },
  {
    field: 'statusUpdatedAt', expect: 'number', need: 'optional', reads: [REGISTRY_TS, 'statusUpdatedAt: num(o.statusUpdatedAt)'],
    why: 'Status rule 3 and release rules 2 and 3 time by it; without it the deck goes by its own readings.',
    check: aNumber,
  },
  {
    field: 'name', expect: 'string', need: 'optional', reads: [REGISTRY_TS, 'name: str(o.name)'],
    why: "It's the session's title; without it the deck shows the record's title.",
    check: aString,
  },
  {
    field: 'sessionId', expect: 'string', need: 'optional', reads: [REGISTRY_TS, 'sessionId: str(o.sessionId)'],
    why: 'It places a held request that came without a host.',
    check: aString,
  },
  {
    field: 'cwd', expect: 'string', need: 'optional', reads: [REGISTRY_TS, 'cwd: str(o.cwd)'],
    why: "Its folder name is the title's last fallback.",
    check: aString,
  },
  {
    field: 'startedAt', expect: 'number', need: 'optional', reads: [REGISTRY_TS, 'startedAt: num(o.startedAt)'],
    why: 'The slots fill with the newest first, and of two files for one host the later shows; without it the order goes by pid.',
    check: aNumber,
  },
])

/**
 * Every record field the deck reads: parseRecord and turnCategory, claude-code/deck/src/records/records.ts:45-90. As
 * above, plus `presence`: an `always` field should be in every record, so one missing from some warns; a `sparse` one
 * comes only once a session has had a turn or a wrap-up, so records without it are fine, and only its type counts; a
 * `rare` one comes only in some sessions some of the time, so it may be in no record at all, and only its type counts.
 */
export const RECORD_FIELDS = Object.freeze([
  {
    field: 'model', expect: 'non-empty string', need: 'required', presence: 'always', reads: [RECORDS_TS, 'model: str(o.model, 80)'],
    why: "The Sessions strip shows it for a session whose mod hasn't reported a model.",
    check: aNonEmptyString,
  },
  {
    field: 'effort', expect: 'non-empty string', need: 'required', presence: 'always', reads: [RECORDS_TS, 'effort: str(o.effort, 40)'],
    why: "The Sessions strip shows it for a session whose mod hasn't reported an effort.",
    check: aNonEmptyString,
  },
  {
    field: 'permissionMode', expect: 'mode name', values: MODE_NAMES, need: 'required', presence: 'always', reads: [RECORDS_TS, 'permissionMode: str(o.permissionMode, 40)'],
    why: "A Session Slot's strip shows it for a session whose mod hasn't reported a mode (names in format.ts).",
    check: (v) => aNonEmptyString(v) ?? (MODE_NAMES.includes(v) ? null : 'mode the deck has no name for'),
  },
  {
    // The deck reads a summary only as the app's loader keeps it (PROTOCOL.md, status rule 6), so one the loader drops
    // counts as no summary.
    field: 'postTurnSummary', expect: 'object with a string status_category', need: 'required', presence: 'sparse', reads: [RECORDS_TS, '(o.postTurnSummary)'],
    why: "Status rule 6, the app's own needs-input indicator, reads its status_category, from a summary the app's loader keeps.",
    check: (v) => summaryDropped(v) ?? (typeof v.status_category === 'string' ? null : 'object without a string status_category'),
  },
  {
    field: 'postTurnSummaryFor', expect: 'string', need: 'required', presence: 'sparse', reads: [RECORDS_TS, 'typeof o.postTurnSummaryFor === "string"'],
    why: 'Status rule 6 counts a summary only when this equals lastAssistantUuid.',
    check: aString,
  },
  {
    field: 'lastAssistantUuid', expect: 'string', need: 'required', presence: 'sparse', reads: [RECORDS_TS, 'o.postTurnSummaryFor === o.lastAssistantUuid'],
    why: 'Status rule 6 counts a summary only when postTurnSummaryFor equals this.',
    check: aString,
  },
  {
    field: 'turnWrapUp', expect: 'object with a string description', need: 'optional', presence: 'sparse', reads: [RECORDS_TS, 'wrapUp(o.turnWrapUp)'],
    why: "Status rule 6: a valid wrap-up recasts the summary's category, as the app's loader keeps it.",
    check: (v) => {
      if (!isObj(v)) return kind(v)
      if (typeof v.description !== 'string') return 'object without a string description'
      return v.needsUser === undefined || typeof v.needsUser === 'string' ? null : 'object whose needsUser is no string'
    },
  },
  {
    field: 'title', expect: 'non-empty string', need: 'optional', presence: 'always', reads: [RECORDS_TS, 'title: str(o.title)'],
    why: 'The title when the registry has no name.',
    check: aNonEmptyString,
  },
  {
    // Sparse: a session that has never been on screen has none (seen on this Mac, 2026-11-02).
    field: 'lastFocusedAt', expect: 'number', need: 'optional', presence: 'sparse', reads: [RECORDS_TS, 'lastFocusedAt: time(o.lastFocusedAt)'],
    why: 'Until a session is picked on the dial, the target is the one last on screen, by this or the mod\'s attach.',
    check: aNumber,
  },
  // Phase 7, session keys (docs/claude-code/session-keys.md): in every one of this Mac's records on 2026-11-04.
  {
    field: 'isArchived', expect: 'boolean', need: 'optional', presence: 'always', reads: [RECORDS_TS, 'isArchived: o.isArchived === true'],
    why: 'A Session Slot keeps its session until the app\'s record says it\'s archived; without it, only a long press or a record gone frees the slot.',
    check: (v) => (typeof v === 'boolean' ? null : kind(v)),
  },
  {
    field: 'lastActivityAt', expect: 'number', need: 'optional', presence: 'always', reads: [RECORDS_TS, 'lastActivityAt: time(o.lastActivityAt)'],
    why: 'With no turn end seen since a deck restart, an idle session counts as not seen when this is later than lastFocusedAt.',
    check: aNumber,
  },
  {
    field: 'cwd', expect: 'non-empty string', need: 'optional', presence: 'always', reads: [RECORDS_TS, 'cwd: str(o.cwd'],
    why: 'The project, its last segment, of a slotted session the registry doesn\'t list.',
    check: aNonEmptyString,
  },
  // 2026-11-08, threads and task cards (PROTOCOL.md's amendment), from app 4.23118.0. Rare: cards are there only while
  // they wait for the user, the link only in a session another one started, and lineageDetached in none on this Mac.
  {
    field: 'backgroundTaskSuggestions', expect: 'array of cards with a string id', need: 'optional', presence: 'rare', reads: [RECORDS_TS, 'Array.isArray(o.backgroundTaskSuggestions)'],
    why: "Status rules 2 and 6: while a session's cards wait for the user, a blocked summary stands, and an offer card reads Needs you. Without them the deck reads Done, as the app does.",
    check: (v) => (!Array.isArray(v) ? kind(v) : v.every((c) => isObj(c) && typeof c.id === 'string') ? null : 'array with a card without a string id'),
  },
  {
    field: 'spawnedFrom', expect: 'object with a string sessionId and a boolean sideSession', need: 'optional', presence: 'rare', reads: [RECORDS_TS, 'const from = o.spawnedFrom'],
    why: "Status rule 9: a session another started is that session's thread, which keeps it in the background while unfinished. Without it, threads show only on their own.",
    check: (v) => (!isObj(v) ? kind(v) : typeof v.sessionId !== 'string' ? 'object without a string sessionId' : typeof v.sideSession !== 'boolean' ? 'object without a boolean sideSession' : null),
  },
  {
    field: 'lineageDetached', expect: 'boolean', need: 'optional', presence: 'rare', reads: [RECORDS_TS, 'o.lineageDetached === true'],
    why: 'A thread the user detached from its parent no longer counts for it (status rule 9).',
    check: (v) => (typeof v === 'boolean' ? null : kind(v)),
  },
])

/**
 * The record loader's summary fields as the app's bundle lists them (`var wM=[…];` in app 4.4212.0), and a pair of them
 * that a list with a field more still has. Both are in that bundle once, in that list.
 */
const SUMMARY_LIST = JSON.stringify(SUMMARY_FIELDS)
const SUMMARY_PAIR = '"status_category","status_detail"'
/**
 * How far after the loader's field list its is_noteworthy check may begin, in bytes: 523 in app 4.4212.0, where the
 * same check in the app's other summary validator is 14 MB on.
 */
export const LOADER_SPAN = 2048

/**
 * What the deck and the mod use from the app's code, as strings in app.asar. Each needle says how bad its absence is:
 * `fail` for one the deck or the mod needs, `warn` where the absence alone doesn't prove a change. A `looser` needle
 * found in place of a missing one turns its fail into a warn: the thing is there, changed. A needle with `after`
 * counts only where it lies wholly in the `within` bytes after an occurrence of the first of `after.texts` that the
 * bundle has, and so does its looser one: the same words elsewhere are another piece of code. `sources` are where the
 * needle comes from (a file and a fragment of its line), cited with their line in the JSON output.
 */
const PLAN = 'docs/claude-code/plan.md'
const S5_JUMP = [PLAN, 'Jump route: `claude://code/continue?session=<local_id>`']
export const BUNDLE_CHECKS = Object.freeze([
  {
    id: 'jump', name: 'jump route',
    why: "The slot keys and dials, Others and a question's key open claude://code/continue?session=<local_ id>.",
    needles: [
      // What the deck opens, and the URL the app builds for its own desktop actions; the Dock menu and Spotlight
      // build the same route (S5).
      { text: 'claude://code/continue?session=', ifMissing: 'warn', sources: [[`${DECK}/plugin.ts`, 'claude://code/continue?session='], S5_JUMP] },
      // The app's claude://code handler matches the path /continue, then reads its session parameter (S5).
      { text: '"/continue"', ifMissing: 'fail', sources: [S5_JUMP] },
    ],
  },
  {
    id: 'needs-input', name: 'needs-input route',
    why: 'S5 found it for a "needs you" jump; the deck doesn\'t use it yet.',
    needles: [
      { text: 'code/needs-input', ifMissing: 'warn', sources: [[PLAN, 'claude://code/needs-input'], [PLAN, 'only `code/new`, `code/needs-input` and `code/continue`']] },
      { text: '"/needs-input"', ifMissing: 'warn', sources: [[PLAN, 'claude://code/needs-input']] },
    ],
  },
  {
    id: 'local-id', name: 'local_ id pattern',
    why: "The app's route ignores an id that doesn't match it, and the deck's HOST_PATTERN (claude-code/deck/src/protocol/wire.ts) must take the same ids.",
    needles: [{ text: HOST_PATTERN.source, ifMissing: 'fail', looser: '^local_', sources: [[`${DECK}/protocol/wire.ts`, 'export const HOST_PATTERN'], [PLAN, "An id that doesn't match `^local_"]] }],
  },
  {
    id: 'summary-loader', name: 'summary loader',
    why: "Status rule 6 reads a record's postTurnSummary only as the app's loader keeps it: these seven fields each missing or a string, and is_noteworthy missing or a boolean (PROTOCOL.md, status rule 6).",
    needles: [
      // App 4.4212.0's record loader: `var wM=[…];` and its OM, which keeps a summary only when each of these is missing
      // or a string. A list with a field more or less no longer matches the deck's, though the pair is still there.
      { text: SUMMARY_LIST, ifMissing: 'fail', looser: SUMMARY_PAIR, sources: [[PROTOCOL, '**A valid summary** is a `postTurnSummary` object']] },
      // OM's `if(typeof t.is_noteworthy!="boolean")return;`, which follows the list it walks. Only there: the app's other
      // summary validator has the same words, and still would were OM to stop checking. After the pair when the list
      // changed, so the check is still looked for where the loader is.
      {
        text: 'is_noteworthy!="boolean"', ifMissing: 'fail', looser: 'is_noteworthy',
        after: { what: 'the field list', texts: [SUMMARY_LIST, SUMMARY_PAIR], within: LOADER_SPAN },
        sources: [[PROTOCOL, 'whose `is_noteworthy` is missing or a boolean']],
      },
    ],
  },
  {
    id: 'desktop-env', name: 'desktop session env',
    why: "The mod talks to the bridge only from a desktop session of its own (claude-code/plugin/hooks/desktop.ts): one the app started with CLAUDE_CODE_ENTRYPOINT claude-desktop or claude-desktop-3p and its local_ id in CLAUDE_CODE_HOST_SESSION_ID, which the hooks send as X-Deck-Host. Named otherwise, the mod stays quiet in every session. This finds the body of the app's mapper from account type to entrypoint and its host id assignment, not that the mapper's result is what the session gets as CLAUDE_CODE_ENTRYPOINT: the smoke test's hello shows that.",
    needles: [
      // App 4.23118.0 gives a session `CLAUDE_CODE_ENTRYPOINT:LLa(n.type)`, with
      // `function LLa(e){return e==="3p"?"claude-desktop-3p":"claude-desktop"}`.
      { text: '?"claude-desktop-3p":"claude-desktop"', ifMissing: 'fail', looser: '"claude-desktop-3p"', sources: [[DESKTOP_TS, 'export const DESKTOP_ENTRYPOINTS']] },
      // And `d.CLAUDE_CODE_HOST_SESSION_ID=n` in the same environment.
      { text: '.CLAUDE_CODE_HOST_SESSION_ID=', ifMissing: 'fail', looser: 'CLAUDE_CODE_HOST_SESSION_ID', sources: [[DESKTOP_TS, 'const host = env.CLAUDE_CODE_HOST_SESSION_ID']] },
    ],
  },
])

/** CLAUDE_CODE_ENTRYPOINT in the app's own sessions (claude-code/plugin/hooks/desktop.ts, DESKTOP_ENTRYPOINTS). */
export const DESKTOP_ENTRYPOINTS = Object.freeze(['claude-desktop', 'claude-desktop-3p'])
const DESKTOP_SET = JSON.stringify(DESKTOP_ENTRYPOINTS)
const WAITING = 'status:"waiting",waitingFor:'
const AFTER_WAITING = { what: 'the waiting status', texts: [WAITING], within: 200 }
const CHILD_ENV = 'CLAUDECODE:"1"'

/**
 * What the deck and the mod rely on in the engine's JavaScript, in the newest bundled Claude Code's file table, as
 * BUNDLE_CHECKS' needles are in app.asar: every file in it is searched apart (isSearched), and an `after` counts in the
 * file its anchor is in. Its code is minified, so the needles are literals and property names, never the engine's own
 * names.
 */
export const ENGINE_JS_CHECKS = Object.freeze([
  {
    id: 'registry-status', name: 'registry statuses',
    why: "The deck's status starts from each session's registry status (claude-code/deck/src/model/status.ts): waiting while a dialog waits on the person, else busy or idle, and any other reads as idle. Check 2 counts what the running sessions have now; this is where the engine sets all three.",
    needles: [
      // 2.1.317: `if(x!==void 0)return{status:"waiting",waitingFor:x,working:!1};return{status:h.isLoading||h.delegatedActive?"busy":"idle",…}`.
      { text: WAITING, ifMissing: 'warn', sources: [[STATUS_TS, 'i.registry === "waiting"']] },
      ...REGISTRY_STATUSES.filter((s) => s !== 'waiting').map((s) => ({ text: `"${s}"`, ifMissing: 'warn', after: AFTER_WAITING, sources: [[STATUS_TS, `i.registry === "${s}"`]] })),
    ],
  },
  {
    id: 'desktop-gate', name: 'desktop gate',
    why: "The mod talks to the bridge only from a desktop session of its own (claude-code/plugin/hooks/desktop.ts), as the engine's own test for one has it: CLAUDE_CODE_ENTRYPOINT one of DESKTOP_ENTRYPOINTS, in a process no other Claude Code started, which the engine marks with CLAUDECODE and CLAUDE_CODE_CHILD_SESSION. Changed, the mod talks from processes the engine doesn't count as desktop sessions, or stays quiet in those it does.",
    needles: [
      // 2.1.317: `var Stn=new Set(["claude-desktop","claude-desktop-3p"]);function eHe(){let e=cp();return e!==void 0&&Stn.has(e)&&!n().childSession}`.
      { text: DESKTOP_SET, ifMissing: 'fail', looser: '"claude-desktop-3p"', sources: [[DESKTOP_TS, 'export const DESKTOP_ENTRYPOINTS']] },
      { text: 'childSession', ifMissing: 'warn', after: { what: 'the desktop entrypoints', texts: [DESKTOP_SET], within: 160 }, sources: [[DESKTOP_TS, "['CLAUDE_CODE_CHILD_SESSION', env.CLAUDE_CODE_CHILD_SESSION]"]] },
      // The environment it gives what it starts: `{CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:e.sessionId,CLAUDE_CODE_CHILD_SESSION:"1",…}`.
      { text: CHILD_ENV, ifMissing: 'warn', sources: [[DESKTOP_TS, "['CLAUDECODE', env.CLAUDECODE]"]] },
      { text: 'CLAUDE_CODE_CHILD_SESSION:"1"', ifMissing: 'warn', after: { what: CHILD_ENV, texts: [CHILD_ENV], within: 120 }, sources: [[DESKTOP_TS, "['CLAUDE_CODE_CHILD_SESSION', env.CLAUDE_CODE_CHILD_SESSION]"]] },
    ],
  },
])

/** The file-system calls the checks make, so tests can watch them. */
export const nodeFs = Object.freeze({
  readdir: (p) => fsp.readdir(p),
  lstat: (p) => fsp.lstat(p),
  stat: (p) => fsp.stat(p),
  readFile: (p, encoding) => fsp.readFile(p, encoding),
})

/** Temp folders and child processes, so an interrupted run can still remove and stop them. */
const temps = new Set()
const running = new Set()

// ---- small helpers

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p)
const errCode = (err) => err?.code ?? 'error'
const printable = (s, max = 200) => {
  // Control characters, but tabs, read as ?.
  const t = String(s).replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '?')
  return t.length > max ? `${t.slice(0, max)}…` : t
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function row(group, id, name, status, reason, details) {
  return details === undefined ? { group, id, name, status, reason } : { group, id, name, status, reason, details }
}

const WORSE = { ok: 0, warn: 1, fail: 2 }
const worst = (statuses) => statuses.reduce((a, b) => (WORSE[b] > WORSE[a] ? b : a), 'ok')

const sourceCache = new Map()
/** `file:line` of the line holding `fragment`, from this repository's working tree; `file` alone when it's not found. */
export function cite([file, fragment]) {
  if (!sourceCache.has(file)) {
    try {
      sourceCache.set(file, fs.readFileSync(path.join(REPO, file), 'utf8').split('\n'))
    } catch {
      sourceCache.set(file, [])
    }
  }
  const i = sourceCache.get(file).findIndex((l) => l.includes(fragment))
  return i === -1 ? file : `${file}:${i + 1}`
}

/**
 * A JSON object from a file: the object, null when it can't be read or doesn't parse as one, or undefined when it's
 * gone or isn't a regular file (a link, a folder, a pipe), which is never opened. A parse error's text is dropped,
 * since it quotes the file.
 */
async function readObject(fsys, file) {
  try {
    if (!(await fsys.lstat(file)).isFile()) return undefined
    const o = JSON.parse(await fsys.readFile(file, 'utf8'))
    return isObj(o) ? o : null
  } catch (err) {
    return err?.code === 'ENOENT' ? undefined : null
  }
}

async function isDir(fsys, p) {
  try {
    return (await fsys.lstat(p)).isDirectory()
  } catch {
    return false
  }
}

// ---- 1. versions

/**
 * The bundled Claude Code versions under `root`, oldest first, the newest, and the binary of the newest, or of
 * `version` when it's given and bundled, `<root>/<version>/<build>/claude.app/Contents/MacOS/claude`. They're
 * refresh.mjs's bundledVersions and findBinary, so recheck and refresh find the same build. `error` is why `root`
 * can't be listed.
 */
export async function findClaudeCode(root, { version } = {}) {
  let versions
  try {
    versions = refresh.bundledVersions(root)
  } catch (err) {
    return { error: err.code ?? 'error', versions: [], newest: null, binary: null }
  }
  const newest = versions.at(-1) ?? null
  const which = version ?? newest
  let binary = null
  if (which !== null && versions.includes(which)) {
    try {
      binary = refresh.findBinary(which, root).binary
    } catch (err) {
      if (!(err instanceof refresh.RefreshError)) throw err
    }
  }
  return { error: null, versions, newest, binary }
}

/**
 * The bundled binaries a run reads, each read once however many checks want it (check 6 the newest, check 8 the
 * vendored version's, often the same one, some 300 MB), and each one's file table, read by refresh.mjs's reader:
 * `{files}`, or `{error}` with whatever the reader threw. A read of the binary that fails rejects.
 */
export function binaryCache(fsys = nodeFs) {
  const bufs = new Map()
  const tables = new Map()
  const read = (file) => {
    if (!bufs.has(file)) bufs.set(file, Promise.resolve().then(() => fsys.readFile(file)))
    return bufs.get(file)
  }
  const table = (file) => {
    if (!tables.has(file)) {
      tables.set(file, read(file).then((buf) => {
        try {
          return { files: refresh.fileTable(buf) }
        } catch (err) {
          return { error: err }
        }
      }))
    }
    return tables.get(file)
  }
  return { read, table, clear: () => (bufs.clear(), tables.clear()) }
}

/** A string `key` from an Info.plist, XML or binary; null when it has none. */
export async function readPlistString(file, key, { fs: fsys = nodeFs } = {}) {
  const buf = await fsys.readFile(file)
  let v = null
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    const r = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' })
    if (r.status === 0) v = r.stdout.trim()
  } else {
    const m = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(buf.toString('utf8'))
    if (m) v = m[1].trim()
  }
  return v ? printable(v, 80) : null
}

/** CFBundleShortVersionString from an Info.plist, XML or binary; null when it has none. */
export async function readAppVersion(file, { fs: fsys = nodeFs } = {}) {
  const v = await readPlistString(file, 'CFBundleShortVersionString', { fs: fsys })
  return v === null ? null : printable(v, 40)
}

export async function checkVersions({ infoPlist = DEFAULTS.infoPlist, claudeCodeRoot = DEFAULTS.claudeCodeRoot, checkedVersion = CHECKED_CC_VERSION, fs: fsys = nodeFs } = {}) {
  const G = 'versions'
  const rows = []
  try {
    const v = await readAppVersion(infoPlist, { fs: fsys })
    if (v === null) rows.push(row(G, 'versions.app', 'app version', 'fail', `no CFBundleShortVersionString in ${tilde(infoPlist)}`))
    else {
      const note = v === FINDINGS_APP_VERSION ? ', the version the Log\'s findings were made on' : `; the Log's findings were made on ${FINDINGS_APP_VERSION}, so the checks below are what holds now`
      rows.push(row(G, 'versions.app', 'app version', 'ok', `Claude.app ${v}${note}`, { version: v, findingsVersion: FINDINGS_APP_VERSION }))
    }
  } catch (err) {
    rows.push(row(G, 'versions.app', 'app version', 'fail', `can't read ${tilde(infoPlist)}: ${errCode(err)}`))
  }

  const cc = await findClaudeCode(claudeCodeRoot)
  const details = { versions: cc.versions, newest: cc.newest, binary: cc.binary, checkedVersion }
  if (cc.error) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'fail', `can't list ${tilde(claudeCodeRoot)}: ${cc.error}`, details))
  else if (cc.newest === null) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'fail', `no version folder in ${tilde(claudeCodeRoot)}`, details))
  else if (checkedVersion === null) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'fail', `${cc.newest} bundled, but claude-code/vendor/mods-api/claude-code.d.ts is missing or its first line names no version: run claude-code/vendor/refresh.mjs`, details))
  else {
    const others = cc.versions.length === 1 ? 'the only one' : `the newest of ${cc.versions.join(', ')}`
    if (cc.newest === checkedVersion) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'ok', `${cc.newest}, ${others}: the version the vendored mods API and these checks are for`, details))
    else rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'warn', `${cc.newest}, ${others}; the vendored mods API (claude-code/vendor/mods-api/) and these checks are for ${checkedVersion}: run claude-code/vendor/refresh.mjs, then the plugin's type check and this again`, details))
  }
  return rows
}

// ---- 2 and 3. fields, in the registry and the records

/**
 * One row per field: how many of `objs` have it with the type the deck reads, how many lack it, and what the rest
 * hold instead (a type, or a value the deck doesn't know). Values themselves are never kept, only the counts of the
 * known ones in `spec.values`.
 */
export function fieldRow(group, spec, objs) {
  const total = objs.length
  let good = 0
  let missing = 0
  const problems = {}
  const values = spec.values ? {} : undefined
  for (const o of objs) {
    if (!Object.hasOwn(o, spec.field)) {
      missing++
      continue
    }
    const v = o[spec.field]
    const problem = spec.check(v)
    if (problem === null) {
      good++
      if (values && spec.values.includes(v)) values[v] = (values[v] ?? 0) + 1
    } else problems[problem] = (problems[problem] ?? 0) + 1
  }
  const bad = total - good - missing
  const sparse = spec.presence === 'sparse' || spec.presence === 'rare'
  const none = spec.need === 'required' ? 'fail' : 'warn'
  let status
  // A rare field in no record is as the app writes it most of the time; only one of the wrong type warns.
  if (good === 0) status = spec.presence === 'rare' && bad === 0 ? 'ok' : none
  else if (sparse) status = bad > 0 ? 'warn' : 'ok'
  else status = good === total ? 'ok' : 'warn'

  let reason = `${good}/${total} ${spec.expect}`
  if (values && Object.keys(values).length) reason += `: ${spec.values.filter((v) => values[v]).map((v) => `${v} ${values[v]}`).join(', ')}`
  const rest = []
  if (missing) rest.push(sparse ? `${missing} without one` : `${missing} missing`)
  for (const [what, n] of Object.entries(problems)) rest.push(`${n} ${what}`)
  if (rest.length) reason += `; ${rest.join(', ')}`
  if (status !== 'ok') reason += `. ${spec.why}`

  return row(group, `${group}.${spec.field}`, `${group}.${spec.field}`, status, reason, {
    field: spec.field,
    expect: spec.expect,
    need: spec.need,
    presence: spec.presence ?? 'always',
    total,
    good,
    missing,
    problems,
    ...(values ? { values } : {}),
    source: cite(spec.reads),
  })
}

/** Registry files are `<pid>.json`, as the deck takes them (registry.ts:42-44). The `<pid>.<hash>.key` beside each is never opened. */
export const isSessionFile = (name) => name.endsWith('.json') && !name.startsWith('.')

/** Check 2. Returns the rows, and the hosts of the running sessions for check 3's lookup. */
export async function checkRegistry(dir = DEFAULTS.sessions, { fs: fsys = nodeFs } = {}) {
  const G = 'registry'
  let names
  try {
    names = await fsys.readdir(dir)
  } catch (err) {
    return { rows: [row(G, 'registry', 'registry', 'fail', `can't list ${tilde(dir)}: ${errCode(err)}`)], hosts: [] }
  }
  const objs = []
  let unparsed = 0
  for (const name of names.filter(isSessionFile).sort()) {
    const o = await readObject(fsys, path.join(dir, name))
    if (o === null) unparsed++
    else if (o !== undefined) objs.push(o)
  }
  const where = `in ${tilde(dir)}`
  const counts = { entries: objs.length, unparsed }
  if (objs.length === 0 && unparsed === 0) {
    return { rows: [row(G, 'registry', 'registry', 'warn', `no entries ${where}, so no fields to check: open a session in the Claude app's Code tab and run again`, counts)], hosts: [] }
  }
  if (objs.length === 0) {
    return { rows: [row(G, 'registry', 'registry', 'fail', `none of ${plural(unparsed, 'entry', 'entries')} ${where} is a JSON object`, counts)], hosts: [] }
  }
  const rows = [
    unparsed
      ? row(G, 'registry', 'registry', 'warn', `${plural(objs.length, 'entry', 'entries')} ${where}; ${unparsed} more didn't parse as a JSON object (caught mid-write?)`, counts)
      : row(G, 'registry', 'registry', 'ok', `${plural(objs.length, 'entry', 'entries')} ${where}`, counts),
  ]
  for (const spec of REGISTRY_FIELDS) rows.push(fieldRow(G, spec, objs))
  const hosts = [...new Set(objs.map((o) => o.hostSessionId).filter((h) => typeof h === 'string' && HOST_PATTERN.test(h)))]
  return { rows, hosts }
}

/**
 * Check 3. The records are `<root>/<account>/<org>/<host>.json`; the deck looks for a session's in every such folder,
 * skipping names that start with a dot (records.ts:141-176). Only names whose id matches HOST_PATTERN are opened, as
 * the deck opens only those. `hosts` are the registry's, for the lookup row.
 */
export async function checkRecords(root = DEFAULTS.records, hosts = [], { fs: fsys = nodeFs } = {}) {
  const G = 'records'
  let accounts
  try {
    accounts = await fsys.readdir(root)
  } catch (err) {
    return [row(G, 'records', 'records', 'fail', `can't list ${tilde(root)}: ${errCode(err)}`)]
  }
  const found = []
  let folders = 0
  let offPattern = 0
  for (const account of accounts.sort()) {
    if (account.startsWith('.') || !(await isDir(fsys, path.join(root, account)))) continue
    let orgs
    try {
      orgs = await fsys.readdir(path.join(root, account))
    } catch {
      continue
    }
    for (const org of orgs.sort()) {
      const dir = path.join(root, account, org)
      if (org.startsWith('.') || !(await isDir(fsys, dir))) continue
      folders++
      let names
      try {
        names = await fsys.readdir(dir)
      } catch {
        continue
      }
      for (const name of names.sort()) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue
        const id = name.slice(0, -'.json'.length)
        if (HOST_PATTERN.test(id)) found.push({ id, file: path.join(dir, name) })
        else offPattern++
      }
    }
  }
  const objs = []
  const ids = new Set()
  let unparsed = 0
  for (const { id, file } of found) {
    const o = await readObject(fsys, file)
    if (o === null) unparsed++
    else if (o !== undefined) {
      objs.push(o)
      ids.add(id)
    }
  }
  const where = `in ${plural(folders, 'account/org folder')} of ${tilde(root)}`
  const counts = { records: objs.length, unparsed, offPattern, folders }
  const off = offPattern ? `; ${offPattern} local_*.json whose id the deck's HOST_PATTERN refuses` : ''
  if (objs.length === 0) {
    const what = unparsed ? `none of ${plural(unparsed, 'record')} ${where} is a JSON object` : `no local_*.json record ${where}`
    return [row(G, 'records', 'records', 'fail', `${what}${off}`, counts)]
  }
  const rows = []
  const extra = `${unparsed ? `; ${unparsed} more didn't parse as a JSON object (caught mid-write?)` : ''}${off}`
  rows.push(row(G, 'records', 'records', extra ? 'warn' : 'ok', `${plural(objs.length, 'record')} ${where}${extra}`, counts))
  for (const spec of RECORD_FIELDS) rows.push(fieldRow(G, spec, objs))

  // Status rule 6 counts a record by its summary only when the summary is for its last assistant message (records.ts:60).
  const both = objs.filter((o) => typeof o.postTurnSummaryFor === 'string' && typeof o.lastAssistantUuid === 'string')
  if (both.length) {
    const equal = both.filter((o) => o.postTurnSummaryFor === o.lastAssistantUuid).length
    const status = equal ? 'ok' : 'warn'
    let reason = `${equal}/${both.length} records with both have them equal`
    if (!equal) reason += '. Status rule 6 counts a summary only for the last message, so it now counts none: has one of them changed meaning?'
    rows.push(row(G, 'records.summary-for-last', 'records: summary for the last message', status, reason, { both: both.length, equal, source: cite([RECORDS_TS, 'o.postTurnSummaryFor === o.lastAssistantUuid']) }))
  }

  // The deck finds a running session's record by the registry's hostSessionId (records.ts:119, 169-176).
  if (hosts.length) {
    const have = hosts.filter((h) => ids.has(h)).length
    const status = have === hosts.length ? 'ok' : have === 0 ? 'fail' : 'warn'
    let reason = `${have}/${hosts.length} running sessions' records found by their hostSessionId`
    if (status !== 'ok') reason += ". The deck reads a session's record from <account>/<org>/<hostSessionId>.json: titles, model, effort, mode and rule 6 need it."
    rows.push(row(G, 'records.lookup', 'records: found by host', status, reason, { running: hosts.length, found: have, source: cite([RECORDS_TS, 'path.join(folder, `${host}.json`)']) }))
  }
  return rows
}

// ---- 4. the app bundle

/**
 * How many times `text` occurs in `buf`, without overlaps; with `spans`, `[from, to)` byte ranges, only the times it
 * lies wholly inside one of them.
 */
export function countHits(buf, text, spans = null) {
  const needle = Buffer.from(text, 'utf8')
  let n = 0
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + needle.length)) {
    if (spans === null || spans.some(([from, to]) => i >= from && i + needle.length <= to)) n++
  }
  return n
}

/**
 * Where a needle with `after` counts: the `within` bytes after each occurrence of the first of `after.texts` that `buf`
 * has, as `[from, to)` ranges. None when it has none of them.
 */
export function spansAfter(buf, after) {
  for (const text of after.texts) {
    const needle = Buffer.from(text, 'utf8')
    const spans = []
    for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + needle.length)) spans.push([i + needle.length, i + needle.length + after.within])
    if (spans.length) return spans
  }
  return []
}

/**
 * A BUNDLE_CHECKS-shaped spec over `bufs`, each searched apart (the bundle alone, or each of the engine's JS files):
 * every needle's hits, where its `after` lets it count, its looser one's, its status, and the row's status and
 * reason. An `after` anchors on the first of its texts that any of `bufs` has, in each file that has it. `what` is
 * where the needles were looked for, for a needle found only outside its span.
 */
export function evalNeedles(bufs, spec, what = 'the bundle') {
  const needles = spec.needles.map((n) => {
    let spans = null
    if (n.after) {
      const anchor = n.after.texts.find((text) => bufs.some((b) => b.includes(text)))
      spans = bufs.map((b) => (anchor === undefined ? [] : spansAfter(b, { texts: [anchor], within: n.after.within })))
    }
    const count = (text, within = spans) => bufs.reduce((sum, b, i) => sum + countHits(b, text, within ? within[i] : null), 0)
    const hits = count(n.text)
    const looserHits = hits === 0 && n.looser ? count(n.looser) : null
    // Where it must be, as people read it, and how often it's elsewhere when it isn't there.
    const where = n.after ? ` within ${n.after.within} bytes after ${n.after.what}` : ''
    const elsewhere = n.after && hits === 0 ? count(n.text, null) : null
    const status = hits ? 'ok' : looserHits ? 'warn' : n.ifMissing
    return {
      text: n.text, hits, ...(n.after ? { after: n.after.what, within: n.after.within, anchors: spans.reduce((s, x) => s + x.length, 0), elsewhere } : {}),
      ...(n.looser ? { looser: n.looser, looserHits } : {}), ifMissing: n.ifMissing, status, where, sources: n.sources.map(cite),
    }
  })
  const status = worst(needles.map((n) => n.status))
  let reason
  if (status === 'ok') reason = needles.map((n) => `${n.text} ×${n.hits}${n.where}`).join(', ')
  else {
    const gone = needles.filter((n) => n.status !== 'ok').map((n) => {
      let s = `${n.text} not found${n.where}`
      if (n.elsewhere) s += `, only elsewhere in ${what} (×${n.elsewhere})`
      if (n.looserHits) s += `, though ${n.looser} is (×${n.looserHits}), so it changed`
      return s
    })
    const there = needles.filter((n) => n.status === 'ok').map((n) => `${n.text} ×${n.hits}${n.where}`)
    reason = `${gone.join('; ')}${there.length ? ` (found: ${there.join(', ')})` : ''}. ${spec.why}`
  }
  return { status, reason, needles: needles.map(({ where, ...n }) => n) }
}

export async function checkBundle(file = DEFAULTS.asar, { fs: fsys = nodeFs } = {}) {
  const G = 'bundle'
  let buf
  try {
    buf = await fsys.readFile(file)
  } catch (err) {
    return [row(G, 'bundle', 'app bundle', 'fail', `can't read ${tilde(file)}: ${errCode(err)}`)]
  }
  const rows = [row(G, 'bundle', 'app bundle', 'ok', `${tilde(file)}, ${(buf.length / 1e6).toFixed(1)} MB`, { bytes: buf.length })]
  for (const spec of BUNDLE_CHECKS) {
    const { status, reason, needles } = evalNeedles([buf], spec)
    rows.push(row(G, `bundle.${spec.id}`, `bundle: ${spec.name}`, status, reason, { needles }))
  }
  return rows
}

// ---- 5. the mods API

const MAX_OUTPUT = 4 * 1024 * 1024
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')

/** Kills a child started by `run` and whatever it started: it leads a process group of its own. */
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Runs a command to its end, or kills it, and what it started, at `timeoutMs`: `{code, signal, error, timedOut, out}`
 * with stdout and stderr together. It runs in a process group of its own, so a grandchild holding the output open
 * dies with it.
 */
function run(cmd, args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let out = ''
    let timedOut = false
    let child
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (err) {
      resolve({ code: null, signal: null, error: errCode(err), timedOut, out })
      return
    }
    running.add(child)
    const add = (d) => {
      if (out.length < MAX_OUTPUT) out += d
    }
    child.stdout.setEncoding('utf8').on('data', add)
    child.stderr.setEncoding('utf8').on('data', add)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child)
    }, timeoutMs)
    const done = (result) => {
      clearTimeout(timer)
      running.delete(child)
      resolve(result)
    }
    child.on('error', (err) => done({ code: null, signal: null, error: errCode(err), timedOut, out }))
    child.on('close', (code, signal) => done({ code, signal, error: null, timedOut, out }))
  })
}

/** Copies PLUGIN_PATH as committed into `dest`: `git archive HEAD claude-code/plugin | tar -x -C dest`. Null, or what went wrong. */
function copyPluginFromHead(repo, dest) {
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD', PLUGIN_PATH], { maxBuffer: 512 * 1024 * 1024 })
  if (archive.error) return `can't run git: ${errCode(archive.error)}`
  if (archive.status !== 0) return `git archive HEAD ${PLUGIN_PATH} in ${tilde(repo)} failed: ${printable(firstLine(archive.stderr.toString('utf8')))}`
  const untar = spawnSync('tar', ['-x', '-f', '-', '-C', dest], { input: archive.stdout })
  if (untar.error || untar.status !== 0) return `tar -x of HEAD's ${PLUGIN_PATH} failed: ${untar.error ? errCode(untar.error) : printable(firstLine(untar.stderr.toString('utf8')))}`
  if (!fs.existsSync(path.join(dest, PLUGIN_PATH, '.claude-plugin', 'plugin.json'))) return `HEAD has no ${PLUGIN_PATH}/.claude-plugin/plugin.json`
  return null
}

const firstLine = (s) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

/** The modules the plugin's hooks.json names, which `plugin validate` should list with their hooks. */
function hookModules(plugin) {
  try {
    const modules = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).modules
    return Array.isArray(modules) ? modules.filter((m) => typeof m === 'string') : []
  } catch {
    return []
  }
}

/** The comma-separated list after `marker` on its line of `text` (`./register.ts hooks: a, b`), or null. */
function listAfter(text, marker) {
  const line = text.split('\n').find((l) => l.includes(marker))
  if (line === undefined) return null
  return line.slice(line.indexOf(marker) + marker.length).split(',').map((s) => s.replace(/\(via adapter\)/, '').trim()).filter(Boolean)
}

/** The line that says what failed: the first under "✘ Found N error(s)", else the first with an error mark, else the last. */
function firstProblem(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const found = lines.findIndex((l) => /^✘ Found \d+ errors?/.test(l))
  if (found !== -1 && lines[found + 1]) return printable(lines[found + 1].replace(/^❯\s*/, ''))
  const marked = lines.find((l) => (l.startsWith('✘') || /\berror\b/i.test(l)) && !/plugin directory/.test(l))
  return printable(marked ?? lines.at(-1) ?? 'no output')
}

const tail = (text, n = 20) => text.split('\n').filter((l) => l.trim()).slice(-n).map((l) => printable(l, 300))

/**
 * Runs `claude plugin <what> <plugin>` with nothing of this machine's Claude setup: a fresh CLAUDE_CONFIG_DIR, HOME and
 * TMPDIR inside `tmp`, the working folder there too, and only PATH from this environment, so neither DECK_TOKEN nor a
 * session's own variables reach it. Paths in its output read `claude-code/plugin` and `<tmp>`.
 */
async function runClaude(binary, what, plugin, tmp, timeoutMs) {
  const dir = path.join(tmp, what)
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(dir, 'home'),
    TMPDIR: path.join(dir, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
    NO_COLOR: '1',
  }
  for (const d of [env.HOME, env.TMPDIR, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(d, { recursive: true })
  const r = await run(binary, ['plugin', what, plugin], { env, cwd: dir, timeoutMs })
  // The real path first: on macOS the temp folder's /var is a link to /private/var, and either can be printed.
  const real = fs.realpathSync(tmp)
  const swaps = [[path.join(real, path.relative(tmp, plugin)), PLUGIN_PATH], [plugin, PLUGIN_PATH], [real, '<tmp>'], [tmp, '<tmp>']]
  r.out = swaps.reduce((s, [from, to]) => s.split(from).join(to), stripAnsi(r.out))
  return r
}

function failedRun(version, r, timeoutMs) {
  if (r.error) return `couldn't run Claude Code ${version}: ${r.error}`
  if (r.timedOut) return `Claude Code ${version} timed out after ${timeoutMs / 1000} s`
  return null
}

function validateRow(version, r, modules, timeoutMs) {
  const id = 'mods.validate'
  const name = 'mods API: plugin validate'
  const details = { version, exitCode: r.code, signal: r.signal, tail: tail(r.out) }
  const broke = failedRun(version, r, timeoutMs)
  if (broke) return row('mods', id, name, 'fail', broke, details)
  if (r.code !== 0) return row('mods', id, name, 'fail', `${version} failed (exit ${r.code ?? r.signal}): ${firstProblem(r.out)}`, details)
  const listed = modules.map((m) => ({ module: m, hooks: listAfter(r.out, `${m} hooks: `), calls: listAfter(r.out, `${m} calls: `) }))
  details.modules = listed
  const unread = listed.filter((l) => l.hooks === null).map((l) => l.module)
  if (unread.length) return row('mods', id, name, 'warn', `${version} passed, but listed no hooks for ${unread.join(', ')}: did it read the mod?`, details)
  const what = listed.map((l) => `${l.module} hooks ${plural(l.hooks.length, 'event')} and makes ${plural(l.calls?.length ?? 0, '$ call')}`)
  return row('mods', id, name, 'ok', `${version} passed on ${PLUGIN_PATH} at HEAD${what.length ? `: ${what.join('; ')}` : ''}`, details)
}

function testRow(version, r, timeoutMs) {
  const id = 'mods.test'
  const name = 'mods API: plugin test'
  const count = (re) => {
    const m = re.exec(r.out)
    return m ? Number(m[1]) : null
  }
  const pass = count(/^\s*(\d+) pass\b/m)
  const failCount = count(/^\s*(\d+) fail\b/m)
  const files = count(/Ran \d+ tests? across (\d+) files?/)
  const failed = [...r.out.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?\s*$/gm)].map((m) => printable(m[1], 120))
  const details = { version, exitCode: r.code, signal: r.signal, pass, fail: failCount, files, failed: failed.slice(0, 20), tail: tail(r.out) }
  const broke = failedRun(version, r, timeoutMs)
  if (broke) return row('mods', id, name, 'fail', broke, details)
  if (r.code !== 0 || failCount > 0) {
    const counted = failCount !== null ? `${failCount} of ${(pass ?? 0) + failCount} failed` : firstProblem(r.out)
    return row('mods', id, name, 'fail', `${version} failed (exit ${r.code ?? r.signal}): ${counted}${failed.length ? `; first: ${failed[0]}` : ''}`, details)
  }
  if (pass === null) return row('mods', id, name, 'warn', `${version} exited 0, but its output has no pass count`, details)
  if (pass === 0) return row('mods', id, name, 'warn', `${version} exited 0, but no test ran`, details)
  return row('mods', id, name, 'ok', `${version}: ${pass} pass, 0 fail${files !== null ? `, across ${plural(files, 'file')}` : ''}, on ${PLUGIN_PATH} at HEAD`, details)
}

/**
 * Check 5: the newest bundled Claude Code's `plugin validate` and `plugin test` on PLUGIN_PATH as committed in `repo`,
 * in a temp folder under `tmpRoot` that's removed afterwards.
 */
export async function checkModsApi({ claudeCodeRoot = DEFAULTS.claudeCodeRoot, repo = DEFAULTS.repo, tmpRoot = os.tmpdir(), timeoutMs = 180_000, fs: fsys = nodeFs } = {}) {
  const cc = await findClaudeCode(claudeCodeRoot)
  if (cc.error) return [row('mods', 'mods', 'mods API', 'fail', `can't list ${tilde(claudeCodeRoot)}: ${cc.error}`)]
  if (cc.newest === null) return [row('mods', 'mods', 'mods API', 'fail', `no Claude Code version folder in ${tilde(claudeCodeRoot)}`)]
  if (cc.binary === null) return [row('mods', 'mods', 'mods API', 'fail', `no claude binary at ${tilde(path.join(claudeCodeRoot, cc.newest))}/*/claude.app/Contents/MacOS/claude`)]
  let tmp
  try {
    tmp = fs.mkdtempSync(path.join(tmpRoot, 'recheck-'))
  } catch (err) {
    return [row('mods', 'mods', 'mods API', 'fail', `can't make a temp folder in ${tilde(tmpRoot)}: ${errCode(err)}`)]
  }
  temps.add(tmp)
  try {
    const copy = path.join(tmp, 'head')
    fs.mkdirSync(copy)
    const why = copyPluginFromHead(repo, copy)
    if (why) return [row('mods', 'mods', 'mods API', 'fail', why)]
    const plugin = path.join(copy, PLUGIN_PATH)
    const modules = hookModules(plugin)
    const validate = await runClaude(cc.binary, 'validate', plugin, tmp, timeoutMs)
    const tests = await runClaude(cc.binary, 'test', plugin, tmp, timeoutMs)
    return [validateRow(cc.newest, validate, modules, timeoutMs), testRow(cc.newest, tests, timeoutMs)]
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    temps.delete(tmp)
  }
}

// ---- 6. the engine

/**
 * The files of a file table check 6 searches: all but those packed (`.zst`), native addons (`.node`) and assets
 * (`.asset`), so a chunk named otherwise than `.js` still counts.
 */
export const isSearched = (f) => !/\.(zst|node|asset)$/.test(f.name)

/**
 * Check 6: the newest bundled Claude Code's binary, which embeds the engine's JavaScript: its file table, read by
 * refresh.mjs's reader, searched for ENGINE_JS_CHECKS. When the table can't be read, or has no file to search, one row
 * says so in their place. Read only, and fast: no process is run.
 */
export async function checkEngine({ claudeCodeRoot = DEFAULTS.claudeCodeRoot, fs: fsys = nodeFs, binaries = binaryCache(fsys) } = {}) {
  const G = 'engine'
  const cc = await findClaudeCode(claudeCodeRoot)
  if (cc.error) return [row(G, 'engine', 'engine', 'fail', `can't list ${tilde(claudeCodeRoot)}: ${cc.error}`)]
  if (cc.newest === null) return [row(G, 'engine', 'engine', 'fail', `no Claude Code version folder in ${tilde(claudeCodeRoot)}`)]
  if (cc.binary === null) return [row(G, 'engine', 'engine', 'fail', `no claude binary at ${tilde(path.join(claudeCodeRoot, cc.newest))}/*/claude.app/Contents/MacOS/claude`)]
  let buf
  try {
    buf = await binaries.read(cc.binary)
  } catch (err) {
    return [row(G, 'engine', 'engine', 'fail', `can't read ${tilde(cc.binary)}: ${errCode(err)}`)]
  }
  const rows = [row(G, 'engine', 'engine', 'ok', `Claude Code ${cc.newest}, ${(buf.length / 1e6).toFixed(1)} MB`, { version: cc.newest, binary: cc.binary, bytes: buf.length })]
  const checks = ENGINE_JS_CHECKS.map((c) => c.name).join(' and ')
  let table
  try {
    table = await binaries.table(cc.binary)
  } catch (err) {
    table = { error: err }
  }
  if (table.error) {
    rows.push(row(G, 'engine.table', 'engine: file table', 'fail', `Claude Code ${cc.newest}'s file table can't be read (${printable(table.error?.message ?? String(table.error))}), so its ${checks} can't be checked`, { version: cc.newest }))
    return rows
  }
  const searched = table.files.filter(isSearched).map((f) => f.contents)
  if (searched.length === 0) {
    rows.push(row(G, 'engine.js', 'engine: JS', 'warn', `Claude Code ${cc.newest}'s file table has no file to search but packed ones (.zst), native addons (.node) and assets (.asset), so its ${checks} can't be checked`, { version: cc.newest, files: table.files.length }))
    return rows
  }
  for (const spec of ENGINE_JS_CHECKS) {
    const { status, reason, needles } = evalNeedles(searched, spec, 'its files')
    rows.push(row(G, `engine.${spec.id}`, `engine: ${spec.name}`, status, reason, { version: cc.newest, files: searched.length, needles }))
  }
  return rows
}

// ---- 7. seen

/** Runs `file` with `args`, no shell, for at most `timeoutMs`, then kills it: `{code, out, error}` with stdout alone. */
function runFile(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && typeof err.code !== 'number') resolve({ code: null, out: String(stdout ?? ''), error: err.killed ? `no answer in ${timeoutMs} ms` : errCode(err) })
      else resolve({ code: err ? err.code : 0, out: String(stdout ?? ''), error: null })
    })
  })
}

/** `lsappinfo front`'s answer, `ASN:0x0-0x620620:`, as front.ts's parseFrontAsn reads it; null for anything else. */
export function parseFrontAsn(stdout) {
  const asn = stdout.trim()
  return FRONT_ASN.test(asn) ? asn : null
}

/** `lsappinfo info -only bundleid <asn>`'s bundle id, as front.ts's parseBundleId reads it; null for `[ NULL ]` or anything else. */
export const parseBundleId = (stdout) => FRONT_BUNDLE_ID.exec(stdout)?.[1] ?? null

/** Words of lsappinfo's answers that name no app: its keys, and NULL. */
const LSAPPINFO_WORDS = new Set(['ASN', 'NULL', 'CFBundleIdentifier', 'bundleID'])

/**
 * An lsappinfo answer's shape, for a reason: every value blanked, quoted or not, `"…"`, `0x…` and `…`, so no app's name
 * or bundle id is ever printed; its keys, punctuation and spacing kept.
 */
export function shapeOf(stdout) {
  return printable(stdout.trim(), 120).replace(/"([^"]*)"|0x[0-9a-f]+|[\p{L}\p{N}_.]+/giu, (t, quoted) => {
    if (quoted !== undefined) return LSAPPINFO_WORDS.has(quoted) ? t : '"…"'
    if (/^0x/i.test(t)) return '0x…'
    return LSAPPINFO_WORDS.has(t) ? t : '…'
  })
}

const NULL_ANSWER = /^\s*\[ NULL \]\s*$/

/** The row for lsappinfo's two answers, asked as the deck asks them (lsappinfoCheck in front.ts) and read as it reads them. */
async function lsappinfoRow(G, lsappinfo, timeoutMs) {
  const id = 'seen.lsappinfo'
  const name = 'seen: lsappinfo'
  const why = `The deck's seen check asks \`lsappinfo front\`, then \`lsappinfo info -only bundleid <asn>\`, and reads both so (${FRONT_TS}); an answer it can't read counts as Claude not in front, so a finished session stays unseen until it's pressed.`
  const details = { lsappinfo: tilde(lsappinfo), source: cite([FRONT_TS, 'export function parseFrontAsn']) }
  const first = await runFile(lsappinfo, ['front'], timeoutMs)
  if (first.error || first.code !== 0) return row(G, id, name, 'fail', `${tilde(lsappinfo)} front failed: ${first.error ?? `exit ${first.code}`}. ${why}`, details)
  const asn = parseFrontAsn(first.out)
  if (asn === null) {
    if (first.out.trim() === '' || NULL_ANSWER.test(first.out)) return row(G, id, name, 'warn', `lsappinfo front named no app (\`${shapeOf(first.out)}\`), so its answer's shape can't be checked: run again with an app in front`, details)
    return row(G, id, name, 'fail', `lsappinfo front answered \`${shapeOf(first.out)}\`, which the deck doesn't read as ASN:0x…-0x…:. ${why}`, details)
  }
  const second = await runFile(lsappinfo, ['info', '-only', 'bundleid', asn], timeoutMs)
  if (second.error || second.code !== 0) return row(G, id, name, 'fail', `${tilde(lsappinfo)} info -only bundleid failed: ${second.error ?? `exit ${second.code}`}. ${why}`, details)
  const bundle = parseBundleId(second.out)
  if (bundle === null) {
    if (/\[ NULL \]/.test(second.out)) return row(G, id, name, 'warn', `the app in front has no bundle id (\`${shapeOf(second.out)}\`), so the answer's shape can't be checked: run again with another app in front`, details)
    return row(G, id, name, 'fail', `lsappinfo info -only bundleid answered \`${shapeOf(second.out)}\`, which the deck doesn't read as "CFBundleIdentifier"="…". ${why}`, details)
  }
  // Another app's bundle id says what the person has open, so only whether it's Claude's is said.
  const claude = bundle === CLAUDE_BUNDLE_ID
  return row(G, id, name, 'ok', `front gave an ASN and info -only bundleid ${claude ? "Claude's" : "another app's"} bundle id, as the deck reads them`, { ...details, claudeInFront: claude })
}

/**
 * Check 7: what the deck's "seen" check relies on (claude-code/deck/src/model/front.ts): lsappinfo's two answers, asked
 * as the deck asks them and read as it reads them (FRONT_ASN, FRONT_BUNDLE_ID); and the app's bundle id, from its
 * Info.plist, which the deck compares the app in front with (CLAUDE_BUNDLE_ID).
 */
export async function checkSeen({ lsappinfo = DEFAULTS.lsappinfo, infoPlist = DEFAULTS.infoPlist, timeoutMs = 2000, fs: fsys = nodeFs } = {}) {
  const G = 'seen'
  const rows = [await lsappinfoRow(G, lsappinfo, timeoutMs)]
  const id = 'seen.bundle-id'
  const name = "seen: Claude's bundle id"
  const details = { expect: CLAUDE_BUNDLE_ID, source: cite([FRONT_TS, 'export const CLAUDE_BUNDLE_ID']) }
  let bundle
  try {
    bundle = await readPlistString(infoPlist, 'CFBundleIdentifier', { fs: fsys })
  } catch (err) {
    rows.push(row(G, id, name, 'fail', `can't read ${tilde(infoPlist)}: ${errCode(err)}`, details))
    return rows
  }
  const why = `The deck counts Claude as in front only when the app in front has the bundle id ${CLAUDE_BUNDLE_ID} (CLAUDE_BUNDLE_ID in ${FRONT_TS}), so with another one a finished session is never marked seen.`
  if (bundle === null) rows.push(row(G, id, name, 'fail', `no CFBundleIdentifier in ${tilde(infoPlist)}. ${why}`, details))
  else if (bundle !== CLAUDE_BUNDLE_ID) rows.push(row(G, id, name, 'fail', `Claude.app's bundle id is ${bundle}. ${why}`, { ...details, bundle }))
  else rows.push(row(G, id, name, 'ok', `${bundle}, as the deck's seen check compares the app in front with`, { ...details, bundle }))
  return rows
}

// ---- 8. the vendored reference

/** Every file under `dir`, as a relative path with `/`, skipping names that start with a dot. */
async function filesUnder(fsys, dir, rel = '') {
  const out = []
  for (const name of (await fsys.readdir(path.join(dir, rel))).sort()) {
    if (name.startsWith('.')) continue
    const p = rel ? `${rel}/${name}` : name
    const st = await fsys.lstat(path.join(dir, p))
    if (st.isDirectory()) out.push(...(await filesUnder(fsys, dir, p)))
    else out.push(p)
  }
  return out
}

/**
 * Check 8: claude-code/vendor/mods-api/, the folder `vendored` is in, against what refresh.mjs makes, in memory, from
 * the binary of the version that file's first line names. ok when every file is the same; warn when they differ,
 * naming the files, that version isn't bundled, or refresh.mjs would refuse it; fail when the binary's file table, or
 * a file of it refresh.mjs takes, can't be read, which means Bun changed its format.
 */
export async function checkVendored({ vendored = DEFAULTS.vendored, claudeCodeRoot = DEFAULTS.claudeCodeRoot, fs: fsys = nodeFs, binaries = binaryCache(fsys) } = {}) {
  const G = 'vendor'
  const id = 'vendor.mods-api'
  const name = 'vendored mods API'
  const dir = path.dirname(vendored)
  const shown = path.relative(REPO, dir).startsWith('..') ? tilde(dir) : path.relative(REPO, dir)
  const one = (status, reason, details) => [row(G, id, name, status, reason, details)]
  const version = vendoredVersion(vendored)
  if (version === null) return one('warn', `${shown}/claude-code.d.ts is missing or its first line names no version, so there's no binary to compare it with: run claude-code/vendor/refresh.mjs`)
  const cc = await findClaudeCode(claudeCodeRoot, { version })
  if (cc.error) return one('fail', `can't list ${tilde(claudeCodeRoot)}: ${cc.error}`)
  if (!cc.versions.includes(version)) return one('warn', `${shown} is for Claude Code ${version}, which isn't bundled any more (${cc.versions.join(', ') || 'none'}), so it can't be compared: run claude-code/vendor/refresh.mjs`, { version, versions: cc.versions })
  if (cc.binary === null) return one('fail', `no claude binary at ${tilde(path.join(claudeCodeRoot, version))}/*/claude.app/Contents/MacOS/claude`, { version })
  let table
  try {
    table = await binaries.table(cc.binary)
  } catch (err) {
    return one('fail', `can't read ${tilde(cc.binary)}: ${errCode(err)}`, { version })
  }
  const unreadable = (err) => one('fail', `Claude Code ${version}'s file table can't be read: ${printable(err?.message ?? String(err))}. refresh.mjs can't rebuild ${shown} from it`, { version, binary: cc.binary })
  if (table.error) return unreadable(table.error)
  let expected
  try {
    expected = refresh.modsApi(table.files, version)
  } catch (err) {
    if (!(err instanceof refresh.RefreshError) || err instanceof refresh.BunFormatError) return unreadable(err)
    return one('warn', `Claude Code ${version}'s file table reads, but refresh.mjs would refuse it: ${printable(err.message)}; the format or the skill changed`, { version })
  }
  const changed = []
  const missing = []
  for (const [rel, text] of Object.entries(expected)) {
    let have
    try {
      have = await fsys.readFile(path.join(dir, rel), 'utf8')
    } catch {
      missing.push(rel)
      continue
    }
    if (have !== text) changed.push(rel)
  }
  let extra = []
  try {
    extra = (await filesUnder(fsys, dir)).filter((rel) => !Object.hasOwn(expected, rel))
  } catch {}
  const details = { version, binary: cc.binary, files: Object.keys(expected).length, changed, missing, extra }
  const differ = [
    ...(changed.length ? [`${changed.join(', ')} ${changed.length === 1 ? 'differs' : 'differ'}`] : []),
    ...(missing.length ? [`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`] : []),
    ...(extra.length ? [`${extra.join(', ')} ${extra.length === 1 ? "isn't" : "aren't"} in the binary's`] : []),
  ]
  if (differ.length) return one('warn', `${shown} isn't what refresh.mjs makes from Claude Code ${version}: ${differ.join('; ')}. \`node claude-code/vendor/refresh.mjs --version ${version}\` and git diff show how`, details)
  return one('ok', `${shown} is what refresh.mjs makes from Claude Code ${version}'s file table, ${plural(Object.keys(expected).length, 'file')}`, details)
}

// ---- all of it

/** Runs the checks in order. `paths` overrides DEFAULTS; `skipPlugin` leaves out check 5. */
export async function recheck({ skipPlugin = false, fs: fsys = nodeFs, tmpRoot, timeoutMs, ...overrides } = {}) {
  const paths = { ...DEFAULTS, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) }
  const checks = []
  checks.push(...(await checkVersions({ infoPlist: paths.infoPlist, claudeCodeRoot: paths.claudeCodeRoot, checkedVersion: vendoredVersion(paths.vendored), fs: fsys })))
  const registry = await checkRegistry(paths.sessions, { fs: fsys })
  checks.push(...registry.rows)
  checks.push(...(await checkRecords(paths.records, registry.hosts, { fs: fsys })))
  checks.push(...(await checkBundle(paths.asar, { fs: fsys })))
  const skipped = []
  if (skipPlugin) skipped.push('mods')
  else checks.push(...(await checkModsApi({ claudeCodeRoot: paths.claudeCodeRoot, repo: paths.repo, tmpRoot, timeoutMs, fs: fsys })))
  // Checks 6 and 8 read the bundled binaries, each once.
  const binaries = binaryCache(fsys)
  try {
    checks.push(...(await checkEngine({ claudeCodeRoot: paths.claudeCodeRoot, fs: fsys, binaries })))
    checks.push(...(await checkSeen({ lsappinfo: paths.lsappinfo, infoPlist: paths.infoPlist, fs: fsys })))
    checks.push(...(await checkVendored({ vendored: paths.vendored, claudeCodeRoot: paths.claudeCodeRoot, fs: fsys, binaries })))
  } finally {
    binaries.clear()
  }
  const summary = { ok: 0, warn: 0, fail: 0 }
  for (const c of checks) summary[c.status]++
  return { ok: summary.fail === 0, summary, skipped, paths, checks }
}

function summaryLine(result) {
  const { ok, warn, fail } = result.summary
  return `${ok} ok, ${warn} warn, ${fail} fail${result.skipped.includes('mods') ? '; the mods API check skipped (--skip-plugin)' : ''}`
}

export function renderTable(result) {
  const w = Math.max(5, ...result.checks.map((c) => c.name.length))
  const lines = [`${'STATUS'.padEnd(6)}  ${'CHECK'.padEnd(w)}  REASON`]
  let group = null
  for (const c of result.checks) {
    if (group !== null && c.group !== group) lines.push('')
    group = c.group
    lines.push(`${c.status.padEnd(6)}  ${c.name.padEnd(w)}  ${c.reason}`)
  }
  lines.push('', summaryLine(result))
  return `${lines.join('\n')}\n`
}

export function renderJson(result) {
  return `${JSON.stringify({ ...result, paths: Object.fromEntries(Object.entries(result.paths).map(([k, v]) => [k, tilde(v)])) }, null, 2)}\n`
}

// ---- the command line

const USAGE = `usage: node claude-code/tools/recheck.mjs [options]

After a Claude app update, says whether the undocumented internals the deck and the plugin rely on still
hold (docs/claude-code/plan.md, Phase 6): one row per check, ok, warn or fail, with a reason.

  1. Versions: the app's, from its Info.plist, and the Claude Code versions it bundles. Warns when the
     newest isn't ${CHECKED_CC_VERSION}, the version the first line of the vendored mods API's d.ts names,
     so the one these checks are for: then run claude-code/vendor/refresh.mjs.
  2. The session registry: each field the deck reads, by type, over the running sessions, with the
     statuses they have. A field no entry has fails when the deck needs it; one some lack warns.
  3. The app's session records: the same, a summary the app's loader drops counting as none, and
     whether each running session's record is found by its host, as the deck finds it.
  4. The app bundle, app.asar: the jump and needs-input routes, the local_ id pattern, the record
     loader's summary fields with its is_noteworthy check within 2048 bytes after them (status rule
     6), and the body of the app's mapper to the entrypoint the mod's gate reads, with the host id's
     assignment. A string found only in another form warns; one the deck needs, gone, fails.
  5. The mods API: the newest bundled Claude Code's \`plugin validate\` and \`plugin test\` on
     ${PLUGIN_PATH} as committed (git HEAD), with a fresh CLAUDE_CONFIG_DIR and HOME. About 5 s.
  6. The engine, the newest bundled Claude Code: in every file of its table but packed ones, native
     addons and assets, read with refresh.mjs's reader, where it sets the registry's statuses (a
     change warns) and its own desktop session test, which the mod's gate copies (its entrypoints
     gone fails). A table it can't read fails.
  7. Seen: runs ${DEFAULTS.lsappinfo} front, then info -only bundleid, as the deck's seen check does, and
     reads both as front.ts does: another shape fails, no app in front warns, and it never prints
     another app's name or bundle id. Then Claude.app's bundle id, against the one the deck compares
     the app in front with.
  8. The vendored reference: claude-code/vendor/mods-api/ against what refresh.mjs makes, in memory,
     from the binary of the version its d.ts names. A file that differs warns, naming it; a table it
     can't read fails, as Bun changed its format.

The PermissionRequest hook's input and answers are held to the engine's declarations by the plugin's
type check (claude-code/plugin-tsc/hook-contract.ts), not here. Checks 4 and 6 find strings, not
behaviour: after an update, also run the smoke test (docs/claude-code/smoke-test.md).

Read only: it writes nothing outside a temp folder it removes, never opens the registry's .key files or
a transcript, never reads the deck's token, and prints field names and counts, never a value from the
registry or the records.

  --sessions DIR          the session registry (default ${tilde(DEFAULTS.sessions)})
  --records DIR           the app's session records (default ${tilde(DEFAULTS.records)})
  --asar FILE             the app bundle (default ${DEFAULTS.asar})
  --info-plist FILE       the app's Info.plist (default ${DEFAULTS.infoPlist})
  --claude-code-root DIR  the bundled Claude Code versions (default ${tilde(DEFAULTS.claudeCodeRoot)})
  --repo DIR              the repository whose HEAD's ${PLUGIN_PATH} check 5 runs on (default this one)
  --vendored FILE         the vendored mods API d.ts, whose first line names the version checks 1 and 8
                          expect; check 8 compares its folder (default claude-code/vendor/mods-api/claude-code.d.ts)
  --lsappinfo FILE        what check 7 runs (default ${DEFAULTS.lsappinfo})
  --skip-plugin           skip check 5
  --json                  machine-readable output
  -h, --help              this text

Exit status: 0 when no check fails, 1 when one does, 2 for a usage error.
`

const OPTIONS = {
  sessions: { type: 'string' },
  records: { type: 'string' },
  asar: { type: 'string' },
  'info-plist': { type: 'string' },
  'claude-code-root': { type: 'string' },
  vendored: { type: 'string' },
  lsappinfo: { type: 'string' },
  repo: { type: 'string' },
  'skip-plugin': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

/** Stops what's running and removes the temp folders, for an interrupted run. */
function stopAll() {
  for (const child of running) killGroup(child)
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
}

export async function main(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }))
  } catch (err) {
    process.stderr.write(`recheck: ${err.message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  for (const k of ['sessions', 'records', 'asar', 'info-plist', 'claude-code-root', 'repo', 'vendored', 'lsappinfo']) {
    if (values[k] === '') {
      process.stderr.write(`recheck: --${k} needs a path\n\n${USAGE}`)
      return 2
    }
  }
  const p = (v) => (v === undefined ? undefined : path.resolve(v))
  const result = await recheck({
    sessions: p(values.sessions),
    records: p(values.records),
    asar: p(values.asar),
    infoPlist: p(values['info-plist']),
    claudeCodeRoot: p(values['claude-code-root']),
    repo: p(values.repo),
    vendored: p(values.vendored),
    lsappinfo: p(values.lsappinfo),
    skipPlugin: Boolean(values['skip-plugin']),
  })
  process.stdout.write(values.json ? renderJson(result) : renderTable(result))
  return result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      stopAll()
      process.exit(code)
    })
  }
  process.exitCode = await main(process.argv.slice(2))
}
