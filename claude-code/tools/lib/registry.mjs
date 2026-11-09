// Reads the two folders the deck merges with what the bridge hears (PROTOCOL.md, "The deck's session
// model"), read only:
// - the session registry, `<dir>/<pid>.json`, one file per running session. The `.key` files beside them are
//   never opened: only names ending in `.json` are read.
// - the app's session records, `<dir>/<account>/<org>/<host>.json`.
// Both are undocumented, so missing fields are tolerated and only the fields the deck uses are kept.

import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The registry fields the deck uses; anything else in the file is dropped. `startedAt` picks the file the deck shows
 * when two list one host, a restarted process's old file lingering beside its new one.
 */
export const REGISTRY_FIELDS = Object.freeze(['pid', 'sessionId', 'hostSessionId', 'name', 'cwd', 'status', 'statusUpdatedAt', 'startedAt'])

/** A host id safe to put in a file name: the app's ids are `local_` plus a UUID. */
export const SAFE_HOST = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function pick(obj, fields) {
  const out = {}
  for (const k of fields) if (Object.hasOwn(obj, k)) out[k] = obj[k]
  return out
}

/**
 * Reads every `<pid>.json` in the registry folder (PROTOCOL.md, "The deck's session model"). Returns `{ok, missing?,
 * entries, unreadable}`: `entries` maps file name to the kept fields. A file that doesn't parse is most likely
 * half-written, so its last good reading from `previous` stands in for it, and one with none is left out.
 * - A folder that doesn't exist (ENOENT) is no sessions: `ok`, with `missing` and no entries.
 * - `ok` is false when the folder can't be listed for any other reason (EACCES, ENOTDIR…): the caller then keeps
 *   its last reading, rather than taking every session for ended.
 */
export async function readRegistry(dir, previous = new Map()) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, missing: true, entries: new Map(), unreadable: [] }
    return { ok: false, error: err?.code ?? String(err), entries: previous, unreadable: [] }
  }
  const entries = new Map()
  const unreadable = []
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    try {
      const obj = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))
      if (!isObject(obj)) throw new Error('not a JSON object')
      entries.set(name, pick(obj, REGISTRY_FIELDS))
    } catch (err) {
      // Gone between the listing and the read: it simply isn't there any more.
      if (err.code === 'ENOENT') continue
      unreadable.push(name)
      if (previous.has(name)) entries.set(name, previous.get(name))
    }
  }
  return { ok: true, entries, unreadable }
}

async function dirs(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

/** The record file for `host`, `<dir>/<account>/<org>/<host>.json`, or null. */
export async function findRecord(dir, host) {
  if (typeof host !== 'string' || !SAFE_HOST.test(host)) return null
  for (const account of await dirs(dir)) {
    for (const org of await dirs(path.join(dir, account))) {
      const file = path.join(dir, account, org, `${host}.json`)
      try {
        if ((await fsp.stat(file)).isFile()) return file
      } catch {}
    }
  }
  return null
}

/** A file's identity for "has it changed": inode, mtime and size. */
export async function signature(file) {
  try {
    const st = await fsp.stat(file)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/**
 * The post-turn summary's fields that the app's record loader keeps only when each is missing or a string: app
 * 4.4212.0's list, which its `OM` walks. recheck.mjs looks for this very list in the app's bundle.
 */
export const SUMMARY_FIELDS = Object.freeze(['title', 'description', 'status_category', 'status_detail', 'recent_action', 'needs_action', 'summarizes_uuid'])

/**
 * A `postTurnSummary` as the app's record loader keeps it (its `OM`; PROTOCOL.md, status rule 6), or null for one
 * it drops: an object, not an array, whose SUMMARY_FIELDS are each missing or a string, and whose `is_noteworthy` is
 * missing or a boolean. `null` is neither. Other fields don't matter: the loader leaves them out.
 */
export function validSummary(v) {
  if (!isObject(v)) return null
  for (const k of SUMMARY_FIELDS) if (v[k] !== undefined && typeof v[k] !== 'string') return null
  if (v.is_noteworthy !== undefined && typeof v.is_noteworthy !== 'boolean') return null
  return v
}

/**
 * Whether the app's own needs-input indicator would show for a record (PROTOCOL.md, status rule 6): app
 * 4.4212.0's `_D`, with its `Dw` and the record loader's `OM` and `jM`.
 * - A valid summary is one the loader keeps (validSummary). It drops any other.
 * - A valid wrap-up is a `turnWrapUp` object with a string `description`, empty or not, and a `needsUser` that's
 *   missing or a string. The loader drops any other.
 * - The record counts only with a valid wrap-up, or a summary of its last assistant message: a
 *   `postTurnSummaryFor` equal to its `lastAssistantUuid`. Both are ids, which the loader keeps only as strings.
 * - The turn's category is the valid summary's `status_category`, or none. A valid wrap-up recasts it: `failed`
 *   stays `failed`; otherwise one with a `needsUser`, even an empty one, makes it `blocked`, and one without turns
 *   `blocked` and `need_input` into `review_ready`.
 * - The indicator shows for `blocked` and `need_input`.
 */
export function needsInput(record) {
  const wrapUp = record.turnWrapUp
  const valid = isObject(wrapUp) && typeof wrapUp.description === 'string' && (wrapUp.needsUser === undefined || typeof wrapUp.needsUser === 'string')
  const forLast = typeof record.postTurnSummaryFor === 'string' && record.postTurnSummaryFor === record.lastAssistantUuid
  if (!valid && !forLast) return false
  let category = validSummary(record.postTurnSummary)?.status_category
  if (valid && category !== 'failed') {
    if (wrapUp.needsUser !== undefined) category = 'blocked'
    // While cards wait for the user, they're the turn's ask: the summary's own category stands (2026-11-08).
    else if ((category === 'blocked' || category === 'need_input') && waitingCards(record).length === 0) category = 'review_ready'
  }
  return category === 'blocked' || category === 'need_input'
}

/**
 * The session cards waiting for the user (PROTOCOL.md's 2026-11-08 amendment): `backgroundTaskSuggestions` entries that
 * are objects with a string `id`, an accepted offer left out, which waits for its brief.
 */
export function waitingCards(record) {
  const cards = record.backgroundTaskSuggestions
  return Array.isArray(cards) ? cards.filter((c) => isObject(c) && typeof c.id === 'string' && c.accepted !== true) : []
}

/**
 * The session a record's session is a thread of (PROTOCOL.md's 2026-11-08 amendment): `spawnedFrom.sessionId` when
 * another session started it, not the user's own side chat, nor one detached. Null for any other.
 */
export function parentOf(record) {
  const from = record.spawnedFrom
  if (!isObject(from) || from.sideSession !== true || from.btw === true || from.userFork === true || record.lineageDetached === true) return null
  return typeof from.sessionId === 'string' && /^local_[A-Za-z0-9-]{1,64}$/.test(from.sessionId) ? from.sessionId : null
}

/**
 * The fields the deck uses from a record, or null when it can't be read. The app's summaries and wrap-ups are
 * text about the user's work, so only whether the last turn needs the user is kept: whether the app's own
 * needs-input indicator would show (needsInput).
 */
export async function readRecord(file) {
  let obj
  try {
    obj = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!isObject(obj)) return null
  const out = pick(obj, ['model', 'effort', 'permissionMode', 'lastFocusedAt'])
  out.needsUser = needsInput(obj)
  // 2026-11-08: an offer card waiting (status rule 2), and the session this one is a thread of (rule 9).
  out.offer = waitingCards(obj).some((c) => c.offer === true)
  out.parent = parentOf(obj)
  out.archived = obj.isArchived === true
  return out
}
