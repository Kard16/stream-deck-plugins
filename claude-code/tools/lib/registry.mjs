// Reads the two folders the deck merges with what the bridge hears (PROTOCOL.md, "The deck's session
// model"), read only:
// - the session registry, `<dir>/<pid>.json`, one file per running session. The `.key` files beside them are
//   never opened: only names ending in `.json` are read.
// - the app's session records, `<dir>/<account>/<org>/<host>.json`.
// Both are undocumented, so missing fields are tolerated and only the fields the deck uses are kept.

import fsp from 'node:fs/promises'
import path from 'node:path'

/** The registry fields the deck uses; anything else in the file is dropped. */
export const REGISTRY_FIELDS = Object.freeze(['pid', 'sessionId', 'hostSessionId', 'name', 'cwd', 'status', 'statusUpdatedAt'])

/** A host id safe to put in a file name: the app's ids are `local_` plus a UUID. */
export const SAFE_HOST = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function pick(obj, fields) {
  const out = {}
  for (const k of fields) if (Object.hasOwn(obj, k)) out[k] = obj[k]
  return out
}

/**
 * Reads every `<pid>.json` in the registry folder. Returns `{ok, entries, unreadable}`: `entries` maps file
 * name to the kept fields. A file that doesn't parse is most likely half-written, so its last good reading
 * from `previous` stands in for it. `ok` is false when the folder itself can't be read: the caller then
 * keeps what it had, rather than taking every session for ended.
 */
export async function readRegistry(dir, previous = new Map()) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    return { ok: false, error: err.code ?? String(err), entries: previous, unreadable: [] }
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
 * The fields the deck uses from a record, or null when it can't be read. The app's summaries are text about
 * the user's work, so only their needs-the-user flags are kept.
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
  out.needsUser = obj.turnWrapUp?.needsUser === true || obj.postTurnSummary?.needs_action === true
  return out
}
