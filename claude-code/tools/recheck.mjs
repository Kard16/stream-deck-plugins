#!/usr/bin/env node
// recheck: after a Claude app update, says whether the undocumented internals the deck and the plugin rely on
// still hold (docs/claude-code/plan.md, Phase 6; what each one is and how it was found is in the plan's Log,
// S0–S5). Six checks:
// 1. Versions: the app's, from its Info.plist, and the Claude Code versions it bundles. It warns when the newest
//    isn't CHECKED_CC_VERSION, the one claude-code/vendor/mods-api-2.1.309/ and these checks are for.
// 2. The session registry, ~/.claude/sessions/*.json: every field the deck reads (REGISTRY_FIELDS), by type.
// 3. The app's session records, claude-code-sessions/<account>/<org>/local_*.json: the same (RECORD_FIELDS),
//    and whether each running session's record is found by its id, as the deck finds it.
// 4. The app bundle, app.asar, scanned with Buffer.indexOf: the jump route, the needs-input route, the local_
//    id pattern, the mode tool, and the record loader's summary fields and, just after them, its is_noteworthy check
//    (BUNDLE_CHECKS).
// 5. The mods API: the newest bundled Claude Code's `plugin validate` and `plugin test` on claude-code/plugin as
//    committed (git HEAD, since the working tree may be mid-edit), with a fresh CLAUDE_CONFIG_DIR and HOME.
// 6. The engine's words: how the newest bundled Claude Code words a $.mcp.call it refuses, which the mod reads to
//    report a refused mode change (ENGINE_CHECKS).
//
// Read only. It writes nothing outside a temp folder it removes, never opens the registry's .key files or a
// transcript, never reads the deck's token, and prints field names and counts, never a value from the
// registry or the records: they hold session titles and summaries. Node 24, no dependencies.
//
// Checks 4 and 6 find strings, not behaviour: after an update, still try one jump and one mode change on the deck.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

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
})

/** The Claude Code version the vendored mods API reference (claude-code/vendor/mods-api-2.1.309/) and these checks are for. */
export const CHECKED_CC_VERSION = '2.1.309'
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
const COMMANDS_TS = 'claude-code/plugin/hooks/commands.ts'

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
    why: 'It orders the Sessions dial; without it the order goes by pid.',
    check: aNumber,
  },
])

/**
 * Every record field the deck reads: parseRecord and turnCategory, claude-code/deck/src/records/records.ts:45-90. As
 * above, plus `presence`: an `always` field should be in every record, so one missing from some warns; a `sparse` one
 * comes only once a session has had a turn or a wrap-up, so records without it are fine, and only its type counts.
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
    why: "The Sessions and Mode strips show it for a session whose mod hasn't reported a mode (names in format.ts).",
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
 * `fail` for the deck's own route or tool, `warn` where the absence alone doesn't prove a change. A `looser` needle
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
    why: "The Sessions dial, the Session key and a question's key open claude://code/continue?session=<local_ id>.",
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
    id: 'mode-tool', name: 'mode tool',
    why: "The Mode dial and key change a session's mode through the mod's $.mcp.call to this server and tool.",
    needles: [
      // The deck's MODE_TOOL is mcp__ccd_session_mgmt__set_session_permission_mode, the name the app's tool has in a
      // PermissionRequest (S4 finished); the mod calls $.mcp.call('ccd_session_mgmt', 'set_session_permission_mode', …)
      // (claude-code/plugin/hooks/register.ts:40).
      { text: 'ccd_session_mgmt', ifMissing: 'fail', sources: [[`${DECK}/protocol/wire.ts`, 'export const MODE_TOOL'], [PLAN, 'tool_name: mcp__ccd_session_mgmt__set_session_permission_mode']] },
      { text: 'set_session_permission_mode', ifMissing: 'fail', sources: [[`${DECK}/protocol/wire.ts`, 'export const MODE_TOOL'], [PLAN, 'tool_name: mcp__ccd_session_mgmt__set_session_permission_mode']] },
    ],
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
])

/**
 * What the mod reads from the engine's own words, in the newest bundled Claude Code's binary, which embeds its
 * JavaScript. 2.1.309 refuses a `$.mcp.call` with `${s.plugin}: $.mcp.call(${e}, ${n}) refused: ${q.deny}`, the server
 * and the tool between the parentheses; the mod finds `$.mcp.call(ccd_session_mgmt, set_session_permission_mode)
 * refused: ` in a rejection's message to report a mode change the engine refused as `refused`, with its reason
 * (refusalOf, claude-code/plugin/hooks/commands.ts; PROTOCOL.md, Commands). Worded otherwise, the mod reports it
 * `failed`, with the whole message, which the deck shows as it shows `refused`: so a change only warns. `template` is
 * the shape found after each `text`, in at most `within` bytes.
 */
export const ENGINE_CHECKS = Object.freeze([
  {
    id: 'mcp-refused', name: 'refused $.mcp.call',
    why: "The mod reports a mode change the engine refuses as refused, with the engine's reason, by finding these words in the rejection (refusalOf in claude-code/plugin/hooks/commands.ts); worded otherwise, it reports failed, with the whole message.",
    text: '$.mcp.call(',
    template: /^\$\.mcp\.call\(\$\{[\w$.]{1,40}\}, \$\{[\w$.]{1,40}\}\) refused: \$\{/,
    refused: ') refused: ',
    within: 120,
    sources: [[COMMANDS_TS, 'const MODE_CALL_REFUSED = '], [PROTOCOL, '`$.mcp.call(<server>, <tool>) refused: <reason>` in 2.1.309']],
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

/** Numeric order of dotted versions: 2.1.40 < 2.1.309 < 2.10.0. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const VERSION_DIR = /^\d+\.\d+\.\d+$/

/**
 * The bundled Claude Code versions under `root` (`<root>/<version>/<hash>/claude.app/Contents/MacOS/claude`), oldest
 * first, the newest, and the newest's binary: the most recently changed one when there are several.
 */
export async function findClaudeCode(root, { fs: fsys = nodeFs } = {}) {
  let names
  try {
    names = await fsys.readdir(root)
  } catch (err) {
    return { error: errCode(err), versions: [], newest: null, binary: null }
  }
  const versions = []
  for (const name of names) if (VERSION_DIR.test(name) && (await isDir(fsys, path.join(root, name)))) versions.push(name)
  versions.sort(compareVersions)
  const newest = versions.at(-1) ?? null
  let binary = null
  if (newest !== null) {
    let hashes = []
    try {
      hashes = await fsys.readdir(path.join(root, newest))
    } catch {}
    let latest = -Infinity
    for (const hash of hashes) {
      if (hash.startsWith('.')) continue
      const file = path.join(root, newest, hash, 'claude.app', 'Contents', 'MacOS', 'claude')
      try {
        const st = await fsys.stat(file)
        if (st.isFile() && (st.mode & 0o111) !== 0 && st.mtimeMs > latest) {
          latest = st.mtimeMs
          binary = file
        }
      } catch {}
    }
  }
  return { error: null, versions, newest, binary }
}

/** CFBundleShortVersionString from an Info.plist, XML or binary; null when it has none. */
export async function readAppVersion(file, { fs: fsys = nodeFs } = {}) {
  const buf = await fsys.readFile(file)
  let v = null
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    const r = spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', file], { encoding: 'utf8' })
    if (r.status === 0) v = r.stdout.trim()
  } else {
    const m = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(buf.toString('utf8'))
    if (m) v = m[1].trim()
  }
  return v ? printable(v, 40) : null
}

export async function checkVersions({ infoPlist = DEFAULTS.infoPlist, claudeCodeRoot = DEFAULTS.claudeCodeRoot, fs: fsys = nodeFs } = {}) {
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

  const cc = await findClaudeCode(claudeCodeRoot, { fs: fsys })
  const details = { versions: cc.versions, newest: cc.newest, binary: cc.binary, checkedVersion: CHECKED_CC_VERSION }
  if (cc.error) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'fail', `can't list ${tilde(claudeCodeRoot)}: ${cc.error}`, details))
  else if (cc.newest === null) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'fail', `no version folder in ${tilde(claudeCodeRoot)}`, details))
  else {
    const others = cc.versions.length === 1 ? 'the only one' : `the newest of ${cc.versions.join(', ')}`
    if (cc.newest === CHECKED_CC_VERSION) rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'ok', `${cc.newest}, ${others}: the version the vendored mods API and these checks are for`, details))
    else rows.push(row(G, 'versions.claude-code', 'bundled Claude Code', 'warn', `${cc.newest}, ${others}; the vendored mods API (claude-code/vendor/mods-api-${CHECKED_CC_VERSION}/), CLAUDE.md's commands and these checks are for ${CHECKED_CC_VERSION}`, details))
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
  const sparse = spec.presence === 'sparse'
  const none = spec.need === 'required' ? 'fail' : 'warn'
  let status
  if (good === 0) status = none
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
    const needles = spec.needles.map((n) => {
      const spans = n.after ? spansAfter(buf, n.after) : null
      const hits = countHits(buf, n.text, spans)
      const looserHits = hits === 0 && n.looser ? countHits(buf, n.looser, spans) : null
      // Where it must be, as people read it, and how often it's in the bundle elsewhere when it isn't there.
      const where = n.after ? ` within ${n.after.within} bytes after ${n.after.what}` : ''
      const elsewhere = n.after && hits === 0 ? countHits(buf, n.text) : null
      const status = hits ? 'ok' : looserHits ? 'warn' : n.ifMissing
      return {
        text: n.text, hits, ...(n.after ? { after: n.after.what, within: n.after.within, anchors: spans.length, elsewhere } : {}),
        ...(n.looser ? { looser: n.looser, looserHits } : {}), ifMissing: n.ifMissing, status, where, sources: n.sources.map(cite),
      }
    })
    const status = worst(needles.map((n) => n.status))
    let reason
    if (status === 'ok') reason = needles.map((n) => `${n.text} ×${n.hits}${n.where}`).join(', ')
    else {
      const gone = needles.filter((n) => n.status !== 'ok').map((n) => {
        let s = `${n.text} not found${n.where}`
        if (n.elsewhere) s += `, only elsewhere in the bundle (×${n.elsewhere})`
        if (n.looserHits) s += `, though ${n.looser} is (×${n.looserHits}), so it changed`
        return s
      })
      const there = needles.filter((n) => n.status === 'ok').map((n) => `${n.text} ×${n.hits}${n.where}`)
      reason = `${gone.join('; ')}${there.length ? ` (found: ${there.join(', ')})` : ''}. ${spec.why}`
    }
    rows.push(row(G, `bundle.${spec.id}`, `bundle: ${spec.name}`, status, reason, { needles: needles.map(({ where, ...n }) => n) }))
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
  const cc = await findClaudeCode(claudeCodeRoot, { fs: fsys })
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

// ---- 6. the engine's words

/**
 * How often `spec.text` occurs in `buf`, and what follows it, read as Latin-1, in at most `spec.within` bytes:
 * `template`, the engine's own shape; `near`, `spec.refused` in another shape; and `all` of them.
 */
export function engineHits(buf, spec) {
  const needle = Buffer.from(spec.text, 'utf8')
  const hits = { all: 0, template: 0, near: 0 }
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + needle.length)) {
    hits.all++
    const after = buf.subarray(i, i + spec.within).toString('latin1')
    if (spec.template.test(after)) hits.template++
    else if (after.includes(spec.refused)) hits.near++
  }
  return hits
}

/**
 * Check 6: the newest bundled Claude Code's binary, which embeds the engine's JavaScript, scanned for the words the
 * mod reads (ENGINE_CHECKS). Read only, and fast: no process is run.
 */
export async function checkEngine({ claudeCodeRoot = DEFAULTS.claudeCodeRoot, fs: fsys = nodeFs } = {}) {
  const G = 'engine'
  const cc = await findClaudeCode(claudeCodeRoot, { fs: fsys })
  if (cc.error) return [row(G, 'engine', 'engine', 'fail', `can't list ${tilde(claudeCodeRoot)}: ${cc.error}`)]
  if (cc.newest === null) return [row(G, 'engine', 'engine', 'fail', `no Claude Code version folder in ${tilde(claudeCodeRoot)}`)]
  if (cc.binary === null) return [row(G, 'engine', 'engine', 'fail', `no claude binary at ${tilde(path.join(claudeCodeRoot, cc.newest))}/*/claude.app/Contents/MacOS/claude`)]
  let buf
  try {
    buf = await fsys.readFile(cc.binary)
  } catch (err) {
    return [row(G, 'engine', 'engine', 'fail', `can't read ${tilde(cc.binary)}: ${errCode(err)}`)]
  }
  const rows = [row(G, 'engine', 'engine', 'ok', `Claude Code ${cc.newest}, ${(buf.length / 1e6).toFixed(1)} MB`, { version: cc.newest, binary: cc.binary, bytes: buf.length })]
  for (const spec of ENGINE_CHECKS) {
    const hits = engineHits(buf, spec)
    const shape = `${spec.text}<server>, <tool>${spec.refused}<reason>`
    let status = 'ok'
    let reason = `${shape} ×${hits.template}, as the mod reads it`
    if (!hits.template) {
      status = 'warn'
      reason = hits.near
        ? `${shape} not found, though ${spec.text}…${spec.refused.trim()} is (×${hits.near}), so it changed. ${spec.why}`
        : `${shape} not found${hits.all ? ` (found: ${spec.text} ×${hits.all})` : ''}. ${spec.why}`
    }
    rows.push(row(G, `engine.${spec.id}`, `engine: ${spec.name}`, status, reason, { version: cc.newest, text: spec.text, template: spec.template.source, ...hits, sources: spec.sources.map(cite) }))
  }
  return rows
}

// ---- all of it

/** Runs the checks in order. `paths` overrides DEFAULTS; `skipPlugin` leaves out check 5. */
export async function recheck({ skipPlugin = false, fs: fsys = nodeFs, tmpRoot, timeoutMs, ...overrides } = {}) {
  const paths = { ...DEFAULTS, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) }
  const checks = []
  checks.push(...(await checkVersions({ infoPlist: paths.infoPlist, claudeCodeRoot: paths.claudeCodeRoot, fs: fsys })))
  const registry = await checkRegistry(paths.sessions, { fs: fsys })
  checks.push(...registry.rows)
  checks.push(...(await checkRecords(paths.records, registry.hosts, { fs: fsys })))
  checks.push(...(await checkBundle(paths.asar, { fs: fsys })))
  const skipped = []
  if (skipPlugin) skipped.push('mods')
  else checks.push(...(await checkModsApi({ claudeCodeRoot: paths.claudeCodeRoot, repo: paths.repo, tmpRoot, timeoutMs, fs: fsys })))
  checks.push(...(await checkEngine({ claudeCodeRoot: paths.claudeCodeRoot, fs: fsys })))
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
hold (docs/claude-code/plan.md, Phase 6). Read only: it writes nothing outside a temp folder it removes,
never opens the registry's .key files or a transcript, and prints field names and counts, never a value
from the registry or the records.

  1. Versions: the app's, from its Info.plist, and the Claude Code versions it bundles. Warns when the
     newest isn't ${CHECKED_CC_VERSION}, which the vendored mods API reference and these checks are for.
  2. The session registry: each field the deck reads, by type, over the running sessions.
  3. The app's session records: the same, and whether each running session's record is found by its id.
  4. The app bundle: the jump route, the needs-input route, the local_ id pattern, the mode tool, and
     the record loader's summary fields and, just after them, its is_noteworthy check, which status
     rule 6 relies on.
  5. The mods API: the newest bundled Claude Code's \`plugin validate\` and \`plugin test\` on
     ${PLUGIN_PATH} as committed (git HEAD), with a fresh CLAUDE_CONFIG_DIR and HOME. About 5 s.
  6. The engine's words: how the newest bundled Claude Code words a refused $.mcp.call, which the
     mod reads to report a refused mode change.

  --sessions DIR          the session registry (default ${tilde(DEFAULTS.sessions)})
  --records DIR           the app's session records (default ${tilde(DEFAULTS.records)})
  --asar FILE             the app bundle (default ${DEFAULTS.asar})
  --info-plist FILE       the app's Info.plist (default ${DEFAULTS.infoPlist})
  --claude-code-root DIR  the bundled Claude Code versions (default ${tilde(DEFAULTS.claudeCodeRoot)})
  --repo DIR              the repository whose HEAD's ${PLUGIN_PATH} check 5 runs on (default this one)
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
  for (const k of ['sessions', 'records', 'asar', 'info-plist', 'claude-code-root', 'repo']) {
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
