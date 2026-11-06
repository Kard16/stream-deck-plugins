#!/usr/bin/env node
// deck-install: loads the Claude Code plugin, claude-code/plugin (streamdeck-bridge), into the user's own Claude
// desktop sessions, and takes it out again (docs/claude-code/plan.md, Phase 5, the install route of 2026-11-03); and
// sets a Mac up from a clone of the repository (Phase 8).
// Sessions load a release copy, claude-code/release/streamdeck-bridge/, made from claude-code/plugin as committed (git
// HEAD), so dev edits in the working tree never reach them. Two keys in the env block of ~/.claude/settings.json name
// it: CLAUDE_CODE_PLUGIN_DIRS, a list of absolute paths separated by ':' (claude-code/vendor/mods-api/reference.md,
// Developing one) that holds the copy's, and DECK_TOKEN, the deck's token. A desktop session applies them when it
// starts, and its launch environment wins key by key, so a preset's sandbox session keeps its own dev copy and token.
// A new plugin folder takes effect only when a session starts, and a session that started with the keys keeps them
// until it restarts. CLAUDE_CODE_PLUGIN_DIR_WATCH is never set: even at 0 it changes how desktop sessions hot-reload
// other folders.
//
// Five commands:
// 1. status, the default, read only: whether the copy equals claude-code/plugin at HEAD (what the engine writes into
//    a folder it loads left out), whether both keys hold the right values, whether CLAUDE_CODE_PLUGIN_DIR_WATCH is in
//    env, and whether claude-code/plugin has uncommitted changes. It exits 0 when installed and current.
// 2. release, only from a clean claude-code/plugin: HEAD's copy through `git archive | tar -x` into a temp folder in
//    the release folder, then `plugin validate` on it from the newest Claude Code the app bundles, which new desktop
//    sessions run (newestClaudeCode), with only PATH and a fresh HOME,
//    TMPDIR and CLAUDE_CONFIG_DIR, as recheck.mjs runs it. Only if that passes is the copy swapped in. RELEASE.json
//    goes beside it, and what changed from the previous copy is printed.
// 3. install, given a current copy: makes settings.json when there's none ({}, 0600, and its folder 0700 when that's
//    missing too), or else backs it up (claude-code/release/backups/, 0600). Then it sets DECK_TOKEN and puts the copy
//    in CLAUDE_CODE_PLUGIN_DIRS once: after the folders already there, or in place of another copy of streamdeck-bridge
//    (otherCopy), which a session would load beside it. Every other key, folder and the key order are kept, written
//    atomically with the file's own mode.
// 4. undo: backs up the same way, then removes DECK_TOKEN, and takes the copy and any other copy of streamdeck-bridge
//    out of CLAUDE_CODE_PLUGIN_DIRS, leaving the other folders: the key goes when none is left, and env when that
//    leaves it empty.
// 5. setup, on a new Mac from a clone: a preflight that writes nothing (macOS, Node 24, the Stream Deck app and its
//    link, not running on a first setup, the Claude Code the app bundles, claude-code/deck and claude-code/plugin
//    committed, and release's other refusals that can be known up front); npm ci, unless node_modules carries the
//    stamp of a good npm ci of this package-lock.json, and npm run build in claude-code/deck; streamdeck dev, link
//    unless it's in place, and restart; a wait for the deck's token and its "Bridge: listening" log line; then release
//    unless the copy is current, install and status. It prints each step and its result, and stops at the first that
//    fails. --dry-run runs only the preflight, and says whether each step would run, and why. Every command setup
//    starts, the validator's too, goes through one runner (HOST.run), which the tests replace.
//
// The token is a secret: it's compared and its length counted, never printed, and a JSON parse error, which quotes the
// file, is dropped. Node 24, no dependencies.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HOME = os.homedir()
/** The repository this script is in: by default, the one whose HEAD is released. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The plugin, from the top of the repository, and the name of its release copy. */
export const PLUGIN_PATH = 'claude-code/plugin'
export const PLUGIN_NAME = 'streamdeck-bridge'
/** The deck, from the top of the repository: its npm project, its plugin folder and UUID, and its newest log, which a start begins anew. */
export const DECK_PATH = 'claude-code/deck'
export const DECK_PLUGIN = 'com.karimdhanji.claude.sdPlugin'
export const DECK_UUID = 'com.karimdhanji.claude'
export const DECK_LOG_PATH = `${DECK_PATH}/${DECK_PLUGIN}/logs/${DECK_UUID}.0.log`
/** Where, from the top of the repository, the deck keeps its token (PROTOCOL.md, "The token") and releases go. */
export const TOKEN_PATH = `${DECK_PATH}/${DECK_PLUGIN}/run/token`
export const RELEASE_PATH = 'claude-code/release'
/** Beside the copy, never inside it: commit, time and plugin version of the release. */
export const RELEASE_FILE = 'RELEASE.json'

/** The keys this script sets in settings env, and the one it never sets. */
export const DIRS_KEY = 'CLAUDE_CODE_PLUGIN_DIRS'
export const TOKEN_KEY = 'DECK_TOKEN'
export const WATCH_KEY = 'CLAUDE_CODE_PLUGIN_DIR_WATCH'

/** 32 random bytes as lowercase hex (claude-code/deck/src/bridge/token.ts). The deck replaces a file holding anything else when it starts. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

const VALIDATE_TIMEOUT_MS = 120_000

export const DEFAULTS = Object.freeze({
  settings: path.join(HOME, '.claude', 'settings.json'),
  repo: REPO,
  /** Where the app keeps the Claude Code versions it bundles: `<root>/<version>/<build>/claude.app/Contents/MacOS/claude`. */
  claudeCodeRoot: path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code'),
})

const VERSION_DIR = /^\d+\.\d+\.\d+$/

/** Numeric order of dotted versions: 2.1.40 < 2.1.309 < 2.10.0. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The newest Claude Code the app bundles under `root`, which new desktop sessions run, and so the one a release is
 * validated with: `{version, binary}`, where `binary` is that version's most recently changed executable build, or
 * null when it has none. Null when `root` has no version folder or can't be read. recheck.mjs's findClaudeCode reads
 * the folder the same way, so no version or build folder is written down anywhere to go stale.
 */
export function newestClaudeCode(root = DEFAULTS.claudeCodeRoot) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }
  const versions = names.filter((n) => VERSION_DIR.test(n) && fs.statSync(path.join(root, n), { throwIfNoEntry: false })?.isDirectory()).sort(compareVersions)
  const version = versions.at(-1)
  if (version === undefined) return null
  let binary = null
  let latest = -Infinity
  let builds = []
  try {
    builds = fs.readdirSync(path.join(root, version))
  } catch {}
  for (const build of builds) {
    if (build.startsWith('.')) continue
    const file = path.join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')
    const st = fs.statSync(file, { throwIfNoEntry: false })
    if (st?.isFile() && (st.mode & 0o111) !== 0 && st.mtimeMs > latest) {
      latest = st.mtimeMs
      binary = file
    }
  }
  return { version, binary }
}

/** Temp folders and child processes, so an interrupted run can still remove and stop them. */
const temps = new Set()
const running = new Set()

// ---- small helpers

/** What a command refuses or fails on, said so the user can act on it. main prints the message and exits 1. */
class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message)
}

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p)
const errCode = (err) => err?.code ?? 'error'
const printable = (s, max = 200) => {
  // Control characters, but tabs, read as ?.
  const t = String(s).replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '?')
  return t.length > max ? `${t.slice(0, max)}…` : t
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const firstLine = (s) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined)
const short = (commit) => String(commit).slice(0, 7)

function tempDir(parent, prefix) {
  const dir = fs.mkdtempSync(path.join(parent, prefix))
  temps.add(dir)
  return dir
}

function removeTemp(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  temps.delete(dir)
}

// ---- git

/** git in `repo`. `--no-optional-locks` keeps `git status` from refreshing the index, so status writes nothing there. */
function git(repo, args, { input } = {}) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { input, maxBuffer: 512 * 1024 * 1024 })
  if (r.error) refuse(`can't run git: ${errCode(r.error)}`)
  return r
}

const gitError = (r) => printable(firstLine(r.stderr.toString('utf8')))

/** HEAD's commit in `repo`, which must be the top of a work tree: the plugin's path is taken from there. */
function repoHead(repo) {
  const top = git(repo, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) refuse(`${tilde(repo)} isn't a git repository: ${gitError(top)}`)
  const topDir = top.stdout.toString('utf8').trim()
  if (fs.realpathSync(topDir) !== fs.realpathSync(repo)) refuse(`${tilde(repo)} isn't the top of its repository, ${tilde(topDir)}`)
  const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (head.status !== 0) refuse(`${tilde(repo)} has no commit at HEAD`)
  return head.stdout.toString('utf8').trim()
}

/** `git status --porcelain` for `rel` (claude-code/plugin unless named): one line for each file changed, staged or untracked there. */
function uncommitted(repo, rel = PLUGIN_PATH) {
  const r = git(repo, ['status', '--porcelain', '--', rel])
  if (r.status !== 0) refuse(`git status failed in ${tilde(repo)}: ${gitError(r)}`)
  return r.stdout.toString('utf8').split('\n').filter((l) => l.trim())
}

/** claude-code/plugin at `commit`, as `git archive <commit> claude-code/plugin | tar -x` writes it under `dest`. Returns the plugin's folder there. */
function extract(repo, commit, dest) {
  const archive = git(repo, ['archive', '--format=tar', commit, PLUGIN_PATH])
  if (archive.status !== 0) refuse(`git archive ${short(commit)} ${PLUGIN_PATH} failed in ${tilde(repo)}: ${gitError(archive)}`)
  const untar = spawnSync('tar', ['-x', '-f', '-', '-C', dest], { input: archive.stdout })
  if (untar.error || untar.status !== 0) refuse(`tar -x of ${PLUGIN_PATH} failed: ${untar.error ? errCode(untar.error) : gitError(untar)}`)
  const plugin = path.join(dest, PLUGIN_PATH)
  if (!fs.existsSync(path.join(plugin, '.claude-plugin', 'plugin.json'))) refuse(`${PLUGIN_PATH} at ${short(commit)} has no .claude-plugin/plugin.json`)
  return plugin
}

/**
 * Which of `rels`, paths in a copy of the plugin, git ignores at the same place in claude-code/plugin: the plugin's
 * own .gitignore, the repository's (which has claude-code/plugin/tsconfig.json, .DS_Store and node_modules/) and git's
 * other ignore rules. `--no-index` asks of the patterns alone, as of files that don't exist there.
 */
function ignoredIn(repo, rels) {
  if (rels.length === 0) return new Set()
  const r = git(repo, ['check-ignore', '--no-index', '-z', '--stdin'], { input: rels.map((rel) => `${PLUGIN_PATH}/${rel}\0`).join('') })
  // 0: some are ignored; 1: none is.
  if (r.status !== 0 && r.status !== 1) refuse(`git check-ignore failed in ${tilde(repo)}: ${gitError(r)}`)
  const prefix = `${PLUGIN_PATH}/`
  return new Set(r.stdout.toString('utf8').split('\0').filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)))
}

// ---- file trees

/**
 * What the engine writes into a plugin folder it loads, which a copy from git never holds: the mods API's declarations
 * in .claude-plugin/types/ and a tsconfig.json at the root that extends them (claude-code/vendor/mods-api/reference.md).
 */
export const engineWritten = (rel) => rel === 'tsconfig.json' || rel === '.claude-plugin/types' || rel.startsWith('.claude-plugin/types/')

/** Every file and link under `dir`, what the engine writes left out, by its path from `dir`: `{kind, exec, size}`. Links aren't followed. */
function listTree(dir) {
  const out = new Map()
  const walk = (rel) => {
    for (const name of fs.readdirSync(rel ? path.join(dir, rel) : dir)) {
      const r = rel ? `${rel}/${name}` : name
      if (engineWritten(r)) continue
      const st = fs.lstatSync(path.join(dir, r))
      if (st.isDirectory()) walk(r)
      else out.set(r, { kind: st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', exec: (st.mode & 0o111) !== 0, size: st.size })
    }
  }
  walk('')
  return out
}

function sameEntry(aDir, bDir, rel, a, b) {
  if (a.kind !== b.kind || a.kind === 'other') return false
  if (a.kind === 'link') return fs.readlinkSync(path.join(aDir, rel)) === fs.readlinkSync(path.join(bDir, rel))
  return a.exec === b.exec && a.size === b.size && fs.readFileSync(path.join(aDir, rel)).equals(fs.readFileSync(path.join(bDir, rel)))
}

/**
 * How folder `b` differs from folder `a`, by path: `added` only in b, `removed` only in a, `changed` in both with other
 * bytes, another kind or another executable bit. What the engine writes is left out of both. `files` counts a's.
 */
export function compareTrees(a, b) {
  const ta = listTree(a)
  const tb = listTree(b)
  return {
    added: [...tb.keys()].filter((r) => !ta.has(r)).sort(),
    removed: [...ta.keys()].filter((r) => !tb.has(r)).sort(),
    changed: [...ta.keys()].filter((r) => tb.has(r) && !sameEntry(a, b, r, ta.get(r), tb.get(r))).sort(),
    files: ta.size,
  }
}

const differs = (d) => d.added.length + d.removed.length + d.changed.length > 0

/** One line per path, `labels` naming the added, changed and removed ones; at most `max`. */
function diffLines(d, labels, max = 40) {
  const rows = [...d.added.map((r) => [labels.added, r]), ...d.changed.map((r) => [labels.changed, r]), ...d.removed.map((r) => [labels.removed, r])]
  const w = Math.max(...Object.values(labels).map((l) => l.length))
  const lines = rows.slice(0, max).map(([label, r]) => `    ${label.padEnd(w)}  ${printable(r)}`)
  if (rows.length > max) lines.push(`    … and ${rows.length - max} more`)
  return lines
}

const STATUS_LABELS = { added: 'extra', changed: 'changed', removed: 'missing' }
const RELEASE_LABELS = { added: 'added', changed: 'changed', removed: 'removed' }

function diffCounts(d, labels) {
  return [[d.changed, labels.changed], [d.removed, labels.removed], [d.added, labels.added]].filter(([l]) => l.length).map(([l, label]) => `${l.length} ${label}`).join(', ')
}

/**
 * The release copy against claude-code/plugin at `commit`: `{state, diff}`, the state 'missing', 'not a folder',
 * 'current' or 'stale'. A file only in the copy that git ignores in claude-code/plugin (ignoredIn) is left out too:
 * it's the engine's, or the Finder's, not the plugin's. HEAD's copy is extracted into a temp folder, then removed.
 */
function checkCopy(o, commit) {
  let st
  try {
    st = fs.lstatSync(o.copy)
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' }
    throw err
  }
  if (!st.isDirectory()) return { state: 'not a folder' }
  const tmp = tempDir(os.tmpdir(), 'deck-install-')
  try {
    const diff = compareTrees(extract(o.repo, commit, tmp), o.copy)
    const ignored = ignoredIn(o.repo, diff.added)
    diff.added = diff.added.filter((r) => !ignored.has(r))
    return { state: differs(diff) ? 'stale' : 'current', diff }
  } finally {
    removeTemp(tmp)
  }
}

/** The name and version in a plugin folder's manifest; null where it has none. */
function readManifest(plugin) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'))
    return { name: typeof m?.name === 'string' ? m.name : null, version: typeof m?.version === 'string' ? m.version : null }
  } catch {
    return { name: null, version: null }
  }
}

/** RELEASE.json, or null when there's none or it isn't a JSON object. */
function readRelease(o) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(o.releaseDir, RELEASE_FILE), 'utf8'))
    return isObj(r) ? r : null
  } catch {
    return null
  }
}

const releaseNote = (r) => (r ? `version ${printable(r.version ?? '?', 40)}, released ${printable(r.time ?? '?', 40)} from ${printable(short(r.commit ?? '?'))}` : `no ${RELEASE_FILE}`)

// ---- settings.json and the token

/**
 * Whether a CLAUDE_CODE_PLUGIN_DIRS value names exactly the folder `dir`: one absolute path (`~` allowed, as the engine
 * takes it), the same once links are resolved.
 */
function namesFolder(value, dir) {
  if (typeof value !== 'string' || value === '') return false
  const p = value.replace(/^~(?=$|\/)/, HOME)
  if (!path.isAbsolute(p)) return false
  if (path.resolve(p) === path.resolve(dir)) return true
  try {
    return fs.realpathSync(p) === fs.realpathSync(dir)
  } catch {
    return false
  }
}

/** What separates the folders in a CLAUDE_CODE_PLUGIN_DIRS value: the platform's path-list separator, ':' on macOS. */
const SEP = path.delimiter

/**
 * Whether a CLAUDE_CODE_PLUGIN_DIRS entry, not the release copy, names another copy of this plugin, which a session
 * would load beside the release copy: a folder whose manifest names streamdeck-bridge (the dev copy, the sandbox's
 * link), or, with no manifest there to read, a path ending in streamdeck-bridge, as a release copy left behind where a
 * clone used to be.
 */
function otherCopy(entry) {
  const p = entry.replace(/^~(?=$|\/)/, HOME)
  if (!path.isAbsolute(p)) return false
  const { name } = readManifest(p)
  return name !== null ? name === PLUGIN_NAME : path.basename(p) === PLUGIN_NAME
}

/**
 * A CLAUDE_CODE_PLUGIN_DIRS value, entry by entry, empty ones left out: `{entry, kind}`, the kind 'ours' for an entry
 * naming the release copy `copy`, 'copy' for another copy of the plugin (otherCopy), 'other' for any other folder.
 */
function dirEntries(value, copy) {
  return value.split(SEP).filter((e) => e !== '').map((entry) => ({ entry, kind: namesFolder(entry, copy) ? 'ours' : otherCopy(entry) ? 'copy' : 'other' }))
}

const joinEntries = (entries) => entries.map((e) => e.entry).join(SEP)

/**
 * The CLAUDE_CODE_PLUGIN_DIRS install writes: the other folders as they were, in their order, and the release copy
 * once, where it was first named, else where another copy was first named, else last. Other copies are left out.
 */
function withCopy(entries, copy) {
  const named = entries.some((e) => e.kind === 'ours')
  const out = []
  let placed = false
  for (const { entry, kind } of entries) {
    if (kind === 'other') out.push(entry)
    else if (!placed && (kind === 'ours' || !named)) {
      out.push(kind === 'ours' ? entry : copy)
      placed = true
    }
  }
  if (!placed) out.push(copy)
  return out.join(SEP)
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v)

/** JSON text without the whitespace between tokens, and each string written as JSON.stringify writes it. The text must parse. */
function compact(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += JSON.stringify(JSON.parse(text.slice(i, j + 1)))
      i = j + 1
    } else {
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') out += c
      i++
    }
  }
  return out
}

/**
 * Whether writing `data` back with JSON.stringify changes nothing in the file `raw` but its whitespace: the same keys in
 * the same order, each value written the same way. It doesn't when the file has a key twice (JSON.parse keeps the
 * last), a key that's a whole number (an object puts those first), a number written another way (1.0, 1e3, one past
 * a double's precision), or bytes that aren't UTF-8.
 */
export function rewriteKeeps(raw, data) {
  const text = raw.toString('utf8')
  return Buffer.from(text, 'utf8').equals(raw) && compact(text) === JSON.stringify(data)
}

/**
 * settings.json: `{file, target, raw, mode, data}`, the target being the file a link names, or `{problem}`. A parse
 * error's text is dropped: it quotes the file, which may hold the token.
 */
function loadSettings(file) {
  let target
  try {
    target = fs.realpathSync(file)
  } catch (err) {
    return { problem: err.code === 'ENOENT' ? missingSettings(file) : `can't read ${tilde(file)}: ${errCode(err)}` }
  }
  let raw
  let st
  try {
    st = fs.statSync(target)
    if (!st.isFile()) return { problem: `${tilde(file)} isn't a file` }
    raw = fs.readFileSync(target)
  } catch (err) {
    return { problem: `can't read ${tilde(file)}: ${errCode(err)}` }
  }
  let data
  try {
    data = JSON.parse(raw.toString('utf8'))
  } catch {
    return { problem: `${tilde(file)} isn't valid JSON` }
  }
  if (!isObj(data)) return { problem: `${tilde(file)} is JSON, but not an object` }
  if (Object.hasOwn(data, 'env') && !isObj(data.env)) return { problem: `env in ${tilde(file)} isn't an object` }
  return { file, target, raw, mode: st.mode & 0o7777, data }
}

/** Why there's no settings file at `file`: nothing there, or a link to a file that doesn't exist, as a dotfiles link before its repository is cloned. */
function missingSettings(file) {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return `no settings file at ${tilde(file)}`
  return `${tilde(file)} is a link to ${tilde(path.resolve(path.dirname(file), fs.readlinkSync(file)))}, which doesn't exist`
}

/**
 * Makes settings.json when nothing is at its path: `{}`, 0600 as the token goes in it, in a folder made 0700 when that's
 * missing too. Returns null when something was there, a link included, which loadSettings then reads or says why not;
 * else `{dir}`, whether it made the folder.
 */
function ensureSettings(file) {
  const madeDir = fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }) !== undefined
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o600)
  } catch (err) {
    if (err.code === 'EEXIST') return null
    throw err
  }
  try {
    fs.writeFileSync(fd, '{}\n')
    fs.fchmodSync(fd, 0o600)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return { dir: madeDir }
}

/** A CLAUDE_CODE_PLUGIN_DIRS value as install and undo print it: what it was, or is now. Paths only, never the token. */
const shownDirs = (v) => (v === undefined ? 'not set' : typeof v !== 'string' ? `a ${typeName(v)}` : v === '' ? 'empty' : printable(v, 400))

/** loadSettings for a change: refuses a file it can't change. */
function settingsToChange(o) {
  const s = loadSettings(o.settings)
  if (s.problem) refuse(`${s.problem}, so it's left as it is`)
  return s
}

/** Before a rewrite: refuses one that would change the file elsewhere (rewriteKeeps), unless `force`. */
function checkRewrite(o, s, log) {
  if (rewriteKeeps(s.raw, s.data)) return
  const what = `rewriting ${tilde(o.settings)} would change more than its env: it has a key given twice, a key that's a number, a number JSON writes another way (1.0, 1e3, or one too large to keep), or bytes that aren't UTF-8`
  if (!o.force) refuse(`${what}. Fix that by hand, or pass --force to rewrite it anyway (the backup keeps the original)`)
  log(`  note: ${what}; rewriting it anyway (--force), and the backup keeps the original`)
}

/** The deck's token, the trimmed content of its file, or `{problem}`. Never printed. */
function readToken(file) {
  let token
  try {
    token = fs.readFileSync(file, 'utf8').trim()
  } catch (err) {
    return { problem: `can't read the deck's token at ${tilde(file)}: ${errCode(err)}` }
  }
  if (!TOKEN_PATTERN.test(token)) return { problem: `${tilde(file)} doesn't hold a token the deck takes (64 lowercase hex characters); the deck replaces such a file when it starts` }
  return { token }
}

/** Copies settings.json's bytes, as read, to `<release folder>/backups/settings.<UTC stamp>.json`, 0600: after an install it holds the token. */
function backup(o, s) {
  const dir = path.join(o.releaseDir, 'backups')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // ISO 8601's basic format to the millisecond, 20261103T041530.123Z, so the names sort in the order they were made.
  const stamp = new Date().toISOString().replace(/[-:]/g, '')
  for (let n = 1; ; n++) {
    const file = path.join(dir, `settings.${stamp}${n === 1 ? '' : `-${n}`}.json`)
    let fd
    try {
      fd = fs.openSync(file, 'wx', 0o600)
    } catch (err) {
      if (err.code === 'EEXIST') continue
      throw err
    }
    try {
      fs.writeFileSync(fd, s.raw)
      fs.fchmodSync(fd, 0o600)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return file
  }
}

/**
 * Writes `data` over the settings as 2-space JSON with a trailing newline, atomically: a temp file beside the target
 * with the target's mode, then a rename. A link stays a link. Refuses, writing nothing, when the file changed since it
 * was read: the app writes it too.
 */
function writeSettings(s, data) {
  const dir = path.dirname(s.target)
  const tmp = path.join(dir, `.${path.basename(s.target)}.deck-install-${process.pid}-${randomBytes(4).toString('hex')}`)
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', s.mode)
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fs.fchmodSync(fd, s.mode)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (!fs.readFileSync(s.target).equals(s.raw)) refuse(`${tilde(s.file)} changed while this ran (the app writes it too), so nothing was written: run it again`)
    fs.renameSync(tmp, s.target)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
  }
}

/** Writes a JSON file atomically: a temp file beside it, then a rename. */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function settingsLine(s) {
  return s.target === s.file ? tilde(s.file) : `${tilde(s.file)} (a link to ${tilde(s.target)})`
}

// ---- the mods API's validator

/** Kills a child started by `run` and whatever it started: it leads a process group of its own. */
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

const MAX_OUTPUT = 4 * 1024 * 1024

/** Runs a command to its end, or kills it and what it started at `timeoutMs`: `{code, signal, error, timedOut, out}`, stdout and stderr together. */
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

/**
 * `<binary> plugin validate <plugin>` with nothing of this machine's Claude setup, as recheck.mjs runs it: only PATH
 * from this environment, so neither DECK_TOKEN nor a session's own variables reach it, and a fresh HOME, TMPDIR and
 * CLAUDE_CONFIG_DIR in a temp folder that's removed afterwards. `{ok, why, tail}`: why it failed, and its last lines,
 * with the copy's path read as <new copy>. `runner` runs it: run, or setup's stand-in in the tests.
 */
async function validate(binary, plugin, runner) {
  const tmp = tempDir(os.tmpdir(), 'deck-install-validate-')
  try {
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: path.join(tmp, 'home'),
      TMPDIR: path.join(tmp, 'tmp'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'config'),
      NO_COLOR: '1',
    }
    for (const d of [env.HOME, env.TMPDIR, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(d, { recursive: true })
    const r = await runner(binary, ['plugin', 'validate', plugin], { env, cwd: tmp, timeoutMs: VALIDATE_TIMEOUT_MS })
    // The real paths first: on macOS the temp folder's /var is a link to /private/var, and either can be printed.
    const swaps = [[fs.realpathSync(plugin), '<new copy>'], [plugin, '<new copy>'], [fs.realpathSync(tmp), '<tmp>'], [tmp, '<tmp>']]
    const text = swaps.reduce((s, [from, to]) => s.split(from).join(to), stripAnsi(r.out))
    const tail = text.split('\n').filter((l) => l.trim()).slice(-20).map((l) => printable(l, 300))
    if (r.error) return { ok: false, why: `couldn't run: ${r.error}`, tail }
    if (r.timedOut) return { ok: false, why: `timed out after ${VALIDATE_TIMEOUT_MS / 1000} s`, tail }
    if (r.code !== 0) return { ok: false, why: `failed (exit ${r.code ?? r.signal})`, tail }
    return { ok: true, why: null, tail }
  } finally {
    removeTemp(tmp)
  }
}

// ---- the commands

/** Status: prints what's there, and returns 0 when installed and current, else 1. Reads only, but for a temp copy of HEAD's plugin it removes. */
export function status(o, log) {
  const problems = []

  let commit = null
  try {
    commit = repoHead(o.repo)
    log(`repo: ${tilde(o.repo)}, HEAD ${short(commit)}`)
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    log(`repo: ${err.message}`)
    problems.push("the repository can't be read")
  }

  log(`release copy: ${tilde(o.copy)}`)
  if (commit !== null) {
    try {
      const c = checkCopy(o, commit)
      if (c.state === 'missing') {
        log('  none: run release')
        problems.push('there is no release copy')
      } else if (c.state === 'not a folder') {
        log("  it isn't a folder")
        problems.push("the release copy isn't a folder")
      } else if (c.state === 'current') {
        log(`  current: equals ${PLUGIN_PATH} at HEAD, ${plural(c.diff.files, 'file')}; ${releaseNote(readRelease(o))}`)
      } else {
        log(`  stale: differs from ${PLUGIN_PATH} at HEAD (${diffCounts(c.diff, STATUS_LABELS)}); ${releaseNote(readRelease(o))}`)
        for (const line of diffLines(c.diff, STATUS_LABELS)) log(line)
        problems.push('the release copy is stale: run release')
      }
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      log(`  can't compare it: ${err.message}`)
      problems.push("the release copy can't be compared with HEAD")
    }
  }

  const t = readToken(o.tokenFile)
  log(`deck token: ${tilde(o.tokenFile)}${t.problem ? `: ${t.problem}` : ''}`)

  const s = loadSettings(o.settings)
  if (s.problem) {
    log(`settings: ${s.problem}`)
    problems.push(s.problem)
  } else {
    log(`settings: ${settingsLine(s)}`)
    const env = own(s.data, 'env')
    const dirs = own(env, DIRS_KEY)
    if (dirs === undefined) {
      log(`  ${DIRS_KEY}: not set`)
      problems.push(`${DIRS_KEY} isn't set`)
    } else if (typeof dirs !== 'string') {
      log(`  ${DIRS_KEY}: set to a ${typeName(dirs)}, not a list of folders`)
      problems.push(`${DIRS_KEY} doesn't name the release copy`)
    } else {
      // Problems exactly where install would change the value (withCopy), so status is clean once install has run.
      const entries = dirEntries(dirs, o.copy)
      const ours = entries.filter((e) => e.kind === 'ours').length
      const copies = entries.filter((e) => e.kind === 'copy')
      const others = entries.length - ours - copies.length
      if (ours === 0) {
        log(`  ${DIRS_KEY}: set, but not to the release copy: ${printable(dirs)}`)
        problems.push(`${DIRS_KEY} doesn't name the release copy`)
      } else {
        log(`  ${DIRS_KEY}: set, names the release copy${ours > 1 ? ` ${ours} times` : ''}${others ? `, beside ${plural(others, 'other folder')}` : ''}`)
        if (ours > 1) problems.push(`${DIRS_KEY} names the release copy more than once: run install`)
      }
      for (const c of copies) log(`    and another copy of ${PLUGIN_NAME}, which a session would load too: ${printable(c.entry)}`)
      if (copies.length) problems.push(`${DIRS_KEY} names another copy of ${PLUGIN_NAME}: run install`)
    }
    const token = own(env, TOKEN_KEY)
    if (token === undefined) {
      log(`  ${TOKEN_KEY}: not set`)
      problems.push(`${TOKEN_KEY} isn't set`)
    } else if (t.problem) {
      log(`  ${TOKEN_KEY}: set, but the deck's token can't be read to compare`)
      problems.push(`the deck's token can't be read`)
    } else if (token === t.token) {
      log(`  ${TOKEN_KEY}: set, matches the deck's token`)
    } else {
      log(`  ${TOKEN_KEY}: set, doesn't match the deck's token`)
      problems.push(`${TOKEN_KEY} doesn't match the deck's token`)
    }
    if (own(env, WATCH_KEY) === undefined) log(`  ${WATCH_KEY}: not in env`)
    else {
      log(`  ${WATCH_KEY}: in env, which the route never sets: even at 0 it changes how desktop sessions hot-reload`)
      problems.push(`${WATCH_KEY} is in env`)
    }
  }

  if (commit !== null) {
    try {
      const dirty = uncommitted(o.repo)
      if (dirty.length === 0) log(`${PLUGIN_PATH}: no uncommitted changes`)
      else {
        log(`${PLUGIN_PATH}: uncommitted changes in ${plural(dirty.length, 'file')}, which reach sessions only once committed and released`)
        for (const line of dirty.slice(0, 20)) log(`    ${printable(line)}`)
        if (dirty.length > 20) log(`    … and ${dirty.length - 20} more`)
      }
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      log(`${PLUGIN_PATH}: ${err.message}`)
    }
  }

  log(problems.length ? `not installed and current: ${problems.join('; ')}` : 'installed and current')
  return problems.length ? 1 : 0
}

/** Release: HEAD's plugin into the release folder, validated, then swapped in. Returns 0, or refuses. The validator runs through `host.run` (HOST). */
export async function release(o, log, host = {}) {
  const runner = host.run ?? run
  const commit = repoHead(o.repo)
  const dirty = uncommitted(o.repo)
  if (dirty.length) refuse(`${PLUGIN_PATH} has uncommitted changes, and a release takes only what's committed:\n${dirty.map((l) => `    ${printable(l)}`).join('\n')}`)
  let st = null
  try {
    st = fs.lstatSync(o.copy)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (st !== null && !st.isDirectory()) refuse(`${tilde(o.copy)} isn't a folder: move it away first`)
  const prior = st !== null
  const before = prior ? readRelease(o) : null

  fs.mkdirSync(o.releaseDir, { recursive: true })
  const tmp = tempDir(o.releaseDir, '.release-')
  try {
    const fresh = extract(o.repo, commit, tmp)
    const m = readManifest(fresh)
    log(`release: ${PLUGIN_PATH} at ${short(commit)}, ${printable(m.name ?? '(no name)', 60)} ${printable(m.version ?? '(no version)', 40)}`)
    if (o.skipValidate) log('  plugin validate: skipped (--skip-validate)')
    else {
      const cc = o.claude !== null ? { version: null, binary: o.claude } : newestClaudeCode(o.claudeCodeRoot)
      if (cc === null || cc.binary === null) {
        refuse(`no Claude Code to validate with: ${cc === null ? `no version folder in ${tilde(o.claudeCodeRoot)}` : `no executable claude in ${tilde(path.join(o.claudeCodeRoot, cc.version))}/*/claude.app/Contents/MacOS/`}. Pass --claude FILE, so the release copy stays as it was`)
      }
      const who = cc.version !== null ? `Claude Code ${cc.version}` : tilde(cc.binary)
      const v = await validate(cc.binary, fresh, runner)
      if (!v.ok) refuse(`plugin validate (${who}) ${v.why}, so the release copy stays as it was${v.tail.length ? `:\n${v.tail.map((l) => `    ${l}`).join('\n')}` : ''}`)
      log(`  plugin validate (${who}): passed`)
    }

    // The swap, with nothing awaited between its steps: the old copy aside into the temp folder, the new one in, and
    // the old goes when the temp folder does.
    const old = path.join(tmp, 'previous')
    if (prior) fs.renameSync(o.copy, old)
    try {
      fs.renameSync(fresh, o.copy)
    } catch (err) {
      if (prior) fs.renameSync(old, o.copy)
      throw err
    }
    log(`  in place: ${tilde(o.copy)}`)

    const info = { commit, time: new Date().toISOString(), version: m.version }
    try {
      writeJson(path.join(o.releaseDir, RELEASE_FILE), info)
    } catch (err) {
      refuse(`the new copy is in place, but ${RELEASE_FILE} couldn't be written: ${errCode(err)}`)
    }
    log(`  ${RELEASE_FILE}: commit ${commit}, ${info.time}, version ${printable(info.version ?? 'none', 40)}`)

    if (!prior) log(`No previous copy: ${plural(listTree(o.copy).size, 'file')}, all new.`)
    else {
      const d = compareTrees(old, o.copy)
      const ignored = ignoredIn(o.repo, d.removed)
      d.removed = d.removed.filter((r) => !ignored.has(r))
      const from = before ? ` (released from ${printable(short(before.commit ?? '?'))})` : ''
      if (!differs(d)) log(`No change from the previous copy${from}.`)
      else {
        log(`Changes from the previous copy${from}: ${diffCounts(d, RELEASE_LABELS)}`)
        for (const line of diffLines(d, RELEASE_LABELS, 200)) log(line)
      }
    }
    log('Desktop sessions load it when they next start; running ones keep what they loaded.')
    return 0
  } finally {
    removeTemp(tmp)
  }
}

/**
 * Install: sets DECK_TOKEN, and puts the release copy in CLAUDE_CODE_PLUGIN_DIRS (withCopy), given a current release
 * copy and the deck's token. Makes settings.json when there's none. Returns 0, or refuses.
 */
export function install(o, log) {
  if (o.copy.includes(SEP)) refuse(`the release copy's path, ${tilde(o.copy)}, has a '${SEP}', which separates the folders in ${DIRS_KEY}: clone the repository to a path without one`)
  const commit = repoHead(o.repo)
  const c = checkCopy(o, commit)
  if (c.state === 'missing') refuse(`there's no release copy at ${tilde(o.copy)}: run release first`)
  if (c.state === 'not a folder') refuse(`${tilde(o.copy)} isn't a folder`)
  if (c.state === 'stale') refuse(`the release copy at ${tilde(o.copy)} differs from ${PLUGIN_PATH} at HEAD (${diffCounts(c.diff, STATUS_LABELS)}): run release first`)
  const t = readToken(o.tokenFile)
  if (t.problem) refuse(t.problem)

  log(`install: ${tilde(o.settings)}`)
  const made = ensureSettings(o.settings)
  if (made) log(`  made it, as there was none: {}, 0600${made.dir ? ', and its folder, 0700' : ''}`)
  const s = settingsToChange(o)
  if (s.target !== s.file) log(`  a link to ${tilde(s.target)}, which is what's written`)
  const env = own(s.data, 'env')
  const dirs = own(env, DIRS_KEY)
  if (dirs !== undefined && typeof dirs !== 'string' && !o.force) {
    refuse(`env in ${tilde(o.settings)} has ${DIRS_KEY} set to a ${typeName(dirs)}, not a list of folders. Pass --force to replace it`)
  }
  const entries = typeof dirs === 'string' ? dirEntries(dirs, o.copy) : null
  const dirsNew = entries === null ? o.copy : withCopy(entries, o.copy)
  const dirsOk = entries !== null && dirsNew === joinEntries(entries)
  const tokenNow = own(env, TOKEN_KEY)
  const tokenOk = tokenNow === t.token
  if (own(env, WATCH_KEY) !== undefined) log(`  note: ${WATCH_KEY} is in env. This leaves it, but the route never sets it, and status counts it against the install`)
  if (dirsOk && tokenOk) {
    log(`  already installed: ${DIRS_KEY} names the release copy and ${TOKEN_KEY} matches the deck's token, so nothing was written`)
    return 0
  }
  checkRewrite(o, s, log)

  // A file this run made holds only {}: there's nothing in it to keep.
  const saved = made ? null : backup(o, s)
  if (env === undefined) s.data.env = {}
  if (!dirsOk) s.data.env[DIRS_KEY] = dirsNew
  if (!tokenOk) s.data.env[TOKEN_KEY] = t.token
  writeSettings(s, s.data)

  log(saved ? `  backup: ${tilde(saved)} (0600)` : '  backup: none, as this run made the file')
  log(dirsOk ? `  ${DIRS_KEY}: unchanged, ${shownDirs(dirs)}` : `  ${DIRS_KEY}: was ${shownDirs(dirs)}, now ${shownDirs(dirsNew)}`)
  if (tokenOk) log(`  ${TOKEN_KEY}: already matched the deck's token`)
  else log(`  ${TOKEN_KEY}: set (${t.token.length} characters)${tokenNow === undefined ? '' : ", replacing a value that didn't match the deck's token"}`)
  log('Desktop sessions load the plugin from the release copy when they next start; running ones only once they restart.')
  return 0
}

/**
 * Undo: removes DECK_TOKEN, and takes the release copy and any other copy of the plugin out of CLAUDE_CODE_PLUGIN_DIRS,
 * leaving the other folders as they were; the key goes when none is left, and env when that empties it. Returns 0, or
 * refuses.
 */
export function undo(o, log) {
  log(`undo: ${tilde(o.settings)}`)
  const s = settingsToChange(o)
  if (s.target !== s.file) log(`  a link to ${tilde(s.target)}, which is what's written`)
  const env = own(s.data, 'env')
  const dirs = own(env, DIRS_KEY)
  const entries = typeof dirs === 'string' ? dirEntries(dirs, o.copy) : []
  const kept = entries.filter((e) => e.kind === 'other')
  const gone = entries.filter((e) => e.kind !== 'other')
  const hadToken = own(env, TOKEN_KEY) !== undefined
  if (gone.length === 0 && !hadToken) {
    log(`  nothing to undo: neither the release copy in ${DIRS_KEY} nor ${TOKEN_KEY} is in env, so nothing was written`)
    return 0
  }
  checkRewrite(o, s, log)
  const saved = backup(o, s)
  if (gone.length) {
    if (kept.length) env[DIRS_KEY] = joinEntries(kept)
    else delete env[DIRS_KEY]
  }
  if (hadToken) delete env[TOKEN_KEY]
  const emptied = Object.keys(env).length === 0
  if (emptied) delete s.data.env
  writeSettings(s, s.data)

  log(`  backup: ${tilde(saved)} (0600)`)
  if (gone.length) log(`  ${DIRS_KEY}: was ${shownDirs(dirs)}, now ${kept.length ? shownDirs(joinEntries(kept)) : 'removed'}`)
  else if (dirs !== undefined) log(`  ${DIRS_KEY}: unchanged, ${shownDirs(dirs)}`)
  if (hadToken) log(`  removed ${TOKEN_KEY}`)
  if (emptied) log('  removed env, which held nothing else')
  if (own(env, WATCH_KEY) !== undefined) log(`  left ${WATCH_KEY} in env, which this never sets`)
  log('New desktop sessions start without the plugin; running ones keep it until they restart.')
  return 0
}

// ---- setup

/** The Node major version the deck is built with: mise.toml's, and the deck manifest's Nodejs.Version. */
const NODE_MAJOR = 24
const NPM_CI_TIMEOUT_MS = 600_000
const BUILD_TIMEOUT_MS = 300_000
const STREAMDECK_TIMEOUT_MS = 60_000
/** In the deck's node_modules after a good `npm ci`: the sha256 of the package-lock.json it installed. */
export const LOCK_STAMP = '.deck-install-lock.sha256'
/** The deck's line once its bridge listens: deck src/bridge/server.ts's "listening on", under the scope plugin.ts gives the bridge. */
export const LISTENING = /^\S+ +\w+ +Bridge: listening on (\S+)/

/**
 * What setup takes from this machine, which the tests replace: the one runner every command it starts goes through
 * (release's validator and the preflight's pgrep too), the clock, the platform and the Node running this, the Stream
 * Deck app and the folder it makes for its plugins when it first opens (`streamdeck link` puts its link there), and how
 * long to wait for the deck.
 */
export const HOST = Object.freeze({
  run,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  nodeVersion: process.versions.node,
  execPath: process.execPath,
  streamDeckApp: '/Applications/Elgato Stream Deck.app',
  streamDeckPlugins: path.join(HOME, 'Library', 'Application Support', 'com.elgato.StreamDeck', 'Plugins'),
  waitMs: 90_000,
  pollMs: 500,
})

const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
const isExecutable = (p) => {
  const st = fs.statSync(p, { throwIfNoEntry: false })
  return st?.isFile() === true && (st.mode & 0o111) !== 0
}
const sameFolder = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readStamp = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * setup's first step, which writes nothing but a temp copy of HEAD's plugin it removes, and runs only git, tar and
 * pgrep, which read. `{lines, problems, plan, lock}`: what it found; what stops setup, each saying what to do, with
 * release's refusals that can be known up front; for npm ci, the link and the release, `{skip}` or `{why}` it runs; and
 * the sha256 of package-lock.json.
 */
async function preflight(o, h, deck) {
  const lines = []
  const problems = []
  const plan = {}
  if (h.platform === 'darwin') lines.push('macOS: yes')
  else problems.push(`this is ${h.platform}, and the deck and the Claude app's sessions run on macOS only`)

  if (Number(h.nodeVersion.split('.')[0]) === NODE_MAJOR) lines.push(`Node: ${h.nodeVersion}, ${tilde(h.execPath)}`)
  else problems.push(`this is Node ${h.nodeVersion}, and the deck is built with Node ${NODE_MAJOR}, as mise.toml pins: run \`mise install node\`, then run setup from the top of the clone as \`mise exec node -- node claude-code/install/deck-install.mjs setup\``)

  const link = path.join(h.streamDeckPlugins, DECK_PLUGIN)
  if (!isDir(h.streamDeckApp)) problems.push(`there's no Stream Deck app at ${tilde(h.streamDeckApp)}: install it, open it once and quit it, then run setup again`)
  else if (!isDir(h.streamDeckPlugins)) problems.push(`the Stream Deck app hasn't made its plugins folder, ${tilde(h.streamDeckPlugins)}, which it makes when it first opens: open it once and quit it, then run setup again`)
  else {
    lines.push(`Stream Deck app: ${tilde(h.streamDeckApp)}`)
    if (sameFolder(link, path.join(deck, DECK_PLUGIN))) plan.link = { skip: 'the Stream Deck app links the deck plugin from this folder already' }
    else if (fs.lstatSync(link, { throwIfNoEntry: false })) problems.push(`the Stream Deck app has the deck plugin from another folder, ${tilde(link)}, which streamdeck link won't replace: take it out (claude-code/README.md, When something's off), then run setup again`)
    else {
      plan.link = { why: "the Stream Deck app doesn't have the deck plugin yet" }
      // A first setup. A running app may see developer mode only once it relaunches; setup's restart starts one that isn't.
      // Its process is "Stream Deck", the app's CFBundleExecutable.
      if ((await h.run('/usr/bin/pgrep', ['-x', 'Stream Deck'], { cwd: o.repo, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000 })).code === 0) {
        problems.push("the Stream Deck app is running, and this is the deck's first setup: quit the Stream Deck app, then run setup again. A running app may not see developer mode until it relaunches, and setup's restart starts it with developer mode on and the link in place")
      }
    }
  }

  if (o.claude !== null) {
    if (isExecutable(o.claude)) lines.push(`Claude Code: ${tilde(o.claude)} (--claude)`)
    else problems.push(`--claude names ${tilde(o.claude)}, which isn't an executable file`)
  } else {
    const cc = newestClaudeCode(o.claudeCodeRoot)
    if (cc?.binary) lines.push(`Claude Code the app bundles: ${cc.version}`)
    else problems.push(`the Claude app has no Claude Code in ${tilde(o.claudeCodeRoot)} yet, which its sessions run and release checks the plugin with: install and open the app, start a session in its Code tab once, then run setup again`)
  }

  try {
    const commit = repoHead(o.repo)
    for (const [rel, what] of [[DECK_PATH, 'which setup would build into the deck'], [PLUGIN_PATH, "and a release takes only what's committed"]]) {
      const dirty = uncommitted(o.repo, rel)
      if (dirty.length) problems.push(`${rel} has uncommitted changes, ${what}: commit or stash them, then run setup again\n${dirty.slice(0, 10).map((l) => `      ${printable(l)}`).join('\n')}`)
    }
    const c = checkCopy(o, commit)
    if (c.state === 'not a folder') problems.push(`${tilde(o.copy)} isn't a folder, so a release can't replace it: move it away, then run setup again`)
    else if (c.state === 'current') plan.release = { skip: `the release copy equals ${PLUGIN_PATH} at HEAD, ${short(commit)}` }
    else plan.release = { why: c.state === 'missing' ? `there's no release copy yet; HEAD is ${short(commit)}` : `the release copy, ${releaseNote(readRelease(o))}, differs from ${PLUGIN_PATH} at HEAD, ${short(commit)} (${diffCounts(c.diff, STATUS_LABELS)})` }
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    problems.push(err.message)
  }

  // npm ci only for node_modules missing, or not stamped with this package-lock.json's sha256 by a good npm ci.
  const lock = sha256(path.join(deck, 'package-lock.json'))
  if (!isDir(path.join(deck, 'node_modules'))) plan.npmCi = { why: 'there are no node_modules yet' }
  else if (readStamp(path.join(deck, 'node_modules', LOCK_STAMP)) === lock) plan.npmCi = { skip: `node_modules has package-lock.json's packages: its sha256, ${lock.slice(0, 12)}…, is the last good npm ci's` }
  else plan.npmCi = { why: "package-lock.json isn't the one the last good npm ci installed" }
  return { lines, problems, plan, lock }
}

/** The address in the deck log's newest "Bridge: listening" line stamped at `since` or later; null when there's none. */
function listeningSince(file, since) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return null
  }
  return lines.filter((l) => Date.parse(l.slice(0, l.indexOf(' '))) >= since).map((l) => LISTENING.exec(l)?.[1]).filter(Boolean).at(-1) ?? null
}

/**
 * Setup: from a clone to a working deck, step by step: each step's name, then what it found or did. Skips npm ci, the
 * link and the release when the preflight found them current, and stops at the first step that fails, saying which and
 * why. With `o.dryRun`, only the preflight runs, and each other step says whether it would run, and why. Returns 0, 1
 * for a dry run whose preflight found problems, or refuses.
 */
export async function setup(o, log, host = {}) {
  const h = { ...HOST, ...host }
  const deck = path.join(o.repo, DECK_PATH)
  const deckLog = path.join(o.repo, DECK_LOG_PATH)
  const nodeBin = path.dirname(h.execPath)
  // npm beside the Node that runs this, and Stream Deck's CLI as npm ci installs it, never one fetched by name.
  const npm = fs.existsSync(path.join(nodeBin, 'npm')) ? path.join(nodeBin, 'npm') : 'npm'
  const streamdeck = path.join(deck, 'node_modules', '.bin', 'streamdeck')
  // That Node first on PATH, for the scripts npm runs, and no DECK_TOKEN, which none of them needs.
  const env = { ...process.env, PATH: [nodeBin, process.env.PATH].filter(Boolean).join(SEP) }
  delete env[TOKEN_KEY]
  const sub = (line) => log(`  ${line}`)
  // What stopped a step, refusal or not; a run of 64 hex, a token's shape, is cut, as main cuts it.
  const why = (err) => (err instanceof Refusal ? err.message : `failed: ${errCode(err)}: ${printable(String(err?.message ?? err), 400).replace(/[0-9a-f]{64}/gi, '<64 hex characters>')}`)
  let restartedAt = null

  const command = (cmd, args, timeoutMs) => async () => {
    const r = await h.run(cmd, args, { cwd: deck, env, timeoutMs })
    // A spinner's frames end in \r.
    const out = stripAnsi(r.out ?? '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).map((l) => printable(l, 300).replace(/[0-9a-f]{64}/gi, '<64 hex characters>'))
    const tail = out.length ? `:\n${out.slice(-20).map((l) => `    ${l}`).join('\n')}` : ''
    if (r.error) refuse(`couldn't run ${tilde(cmd)}: ${r.error}`)
    if (r.timedOut) refuse(`timed out after ${timeoutMs / 1000} s${tail}`)
    if (r.code !== 0) refuse(`failed (exit ${r.code ?? r.signal})${tail}`)
    sub(out.length ? `ok: ${out.at(-1)}` : 'ok')
  }

  const waitForDeck = async () => {
    const deadline = h.now() + h.waitMs
    for (;;) {
      const at = readToken(o.tokenFile).problem ? null : listeningSince(deckLog, restartedAt)
      if (at !== null) {
        sub(`ok: the token is there, and the bridge listens on ${printable(at, 60)}`)
        return
      }
      if (h.now() >= deadline) break
      await h.sleep(h.pollMs)
    }
    refuse(`the deck didn't log "Bridge: listening" within ${h.waitMs / 1000} s of the restart: quit and reopen the Stream Deck app, which starts a linked plugin only in developer mode. Its log is ${tilde(deckLog)}`)
  }

  let pf
  // `plan` names the preflight's verdict for a step it can skip.
  const steps = [
    {
      name: 'npm ci',
      what: `the deck's packages, in ${DECK_PATH}`,
      plan: 'npmCi',
      run: async () => {
        await command(npm, ['ci'], NPM_CI_TIMEOUT_MS)()
        fs.mkdirSync(path.join(deck, 'node_modules'), { recursive: true })
        fs.writeFileSync(path.join(deck, 'node_modules', LOCK_STAMP), `${pf.lock}\n`)
      },
    },
    { name: 'npm run build', what: `the deck plugin, in ${DECK_PATH}`, run: command(npm, ['run', 'build'], BUILD_TIMEOUT_MS) },
    { name: 'streamdeck dev', what: "Stream Deck's developer mode, without which a linked plugin doesn't start", run: command(streamdeck, ['dev'], STREAMDECK_TIMEOUT_MS) },
    { name: `streamdeck link ${DECK_PLUGIN}`, what: 'the deck plugin, linked into the Stream Deck app', plan: 'link', run: command(streamdeck, ['link', DECK_PLUGIN], STREAMDECK_TIMEOUT_MS) },
    {
      name: `streamdeck restart ${DECK_UUID}`,
      what: "starts the deck plugin, and the Stream Deck app if it isn't running; a request held on the deck goes back to the app's dialogs",
      run: async () => {
        restartedAt = h.now()
        await command(streamdeck, ['restart', DECK_UUID], STREAMDECK_TIMEOUT_MS)()
      },
    },
    { name: 'wait for the deck', what: `its token, and "Bridge: listening" in its log since the restart, for up to ${h.waitMs / 1000} s`, run: waitForDeck },
    { name: 'release', what: `${PLUGIN_PATH} from HEAD as the release copy`, plan: 'release', run: () => release(o, sub, h) },
    { name: 'install', what: `the release copy and the deck's token in ${tilde(o.settings)}, made when there's none`, run: () => install(o, sub) },
    {
      name: 'status',
      what: 'whether the plugin is installed and current',
      run: () => {
        if (status(o, sub) !== 0) refuse('not installed and current, above')
      },
    },
  ]

  const total = steps.length + 1
  log(o.dryRun ? 'setup, a dry run: the preflight checks, writing nothing; then each step says whether it would run, and why' : `setup: ${tilde(o.repo)}`)
  log(`[1/${total}] preflight: macOS, Node ${NODE_MAJOR}, the Stream Deck app, the Claude Code the Claude app bundles, and the repository`)
  try {
    pf = await preflight(o, h, deck)
  } catch (err) {
    refuse(`stopped at step 1, the preflight: ${why(err)}`)
  }
  for (const line of pf.lines) sub(line)
  for (const problem of pf.problems) sub(`problem: ${problem}`)
  if (pf.problems.length === 0) sub('ok')
  else if (!o.dryRun) refuse(`stopped at step 1, the preflight: ${plural(pf.problems.length, 'problem')}, above. Fix ${pf.problems.length === 1 ? 'it' : 'them'}, then run setup again`)

  for (const [i, step] of steps.entries()) {
    log(`[${i + 2}/${total}] ${step.name}: ${step.what}`)
    const plan = step.plan ? pf.plan[step.plan] : undefined
    if (plan?.skip) {
      sub(`skipped: ${plan.skip}`)
      continue
    }
    if (o.dryRun) {
      sub(plan ? `would run: ${plan.why}` : 'not run: a dry run')
      continue
    }
    if (plan) sub(plan.why)
    try {
      await step.run()
    } catch (err) {
      refuse(`stopped at step ${i + 2}, ${step.name}: ${why(err)}\nFix that, then run setup again.`)
    }
  }

  if (o.dryRun) {
    log(`A dry run: only the preflight ran, and nothing was written.${pf.problems.length ? ' The preflight found problems, above.' : ''}`)
    return pf.problems.length ? 1 : 0
  }
  log('Setup is done. Then:')
  log('  1. Quit the Claude app (Cmd-Q) and open it again: a session loads the plugin when it starts.')
  log(`  2. Start a session in its Code tab, and look for its "Sessions: HELLO ... plugin" line in the deck's log: ${tilde(deckLog)}`)
  log('  3. In the Stream Deck app, place the actions from the Claude Code category: claude-code/README.md, The layout.')
  return 0
}

export const COMMANDS = Object.freeze({ status, release, install, undo, setup })

// ---- the command line

const USAGE = `usage: node claude-code/install/deck-install.mjs [status|release|install|undo|setup] [options]

Loads the Claude Code plugin (${PLUGIN_PATH}, ${PLUGIN_NAME}) into the user's own Claude desktop
sessions, and takes it out again; setup does all it takes on a new Mac, from a clone. Sessions load a
release copy made from git HEAD, which the env block of ~/.claude/settings.json names in
${DIRS_KEY}, a list of folders separated by '${SEP}', beside the deck's token in ${TOKEN_KEY}.
New sessions pick a change up when they start; running ones only once they restart.

  status   the default, read only. Whether the release copy equals ${PLUGIN_PATH} at HEAD, whether
           settings env holds both keys with the right values (the token compared, never printed),
           whether ${WATCH_KEY} is in env, and whether ${PLUGIN_PATH} has
           uncommitted changes. Exits 0 when installed and current, 1 otherwise.
  release  refuses uncommitted changes in ${PLUGIN_PATH}. Copies it from HEAD into the release
           folder, runs \`plugin validate\` on the copy from the newest Claude Code the app bundles, and
           only if that passes swaps it in as ${PLUGIN_NAME}/, with ${RELEASE_FILE} beside it.
  install  needs a current release copy. Makes settings.json when there's none ({}, 0600), else
           backs it up (backups/ in the release folder, 0600). Then sets ${TOKEN_KEY}, and puts the
           release copy in ${DIRS_KEY} once: after the folders already there, or in
           place of another copy of ${PLUGIN_NAME}, which a session would load too.
  undo     backs up settings.json, then removes ${TOKEN_KEY}, and takes the release copy and any other
           copy of ${PLUGIN_NAME} out of ${DIRS_KEY}, leaving the other folders: the key
           goes when none is left, and env when that leaves it empty.
  setup    on a new Mac, from a clone: a preflight (macOS, Node ${NODE_MAJOR}, the Stream Deck app, the Claude
           Code the Claude app bundles, ${DECK_PATH} and ${PLUGIN_PATH} committed), npm ci
           and npm run build in ${DECK_PATH}, streamdeck dev, link and restart, a wait for the
           deck's token and its bridge, then release, install and status. It skips npm ci, the link and
           the release when they're current, and stops at the first step that fails. Run it with mise's
           Node ${NODE_MAJOR} alone: mise exec node -- node claude-code/install/deck-install.mjs setup

  --dry-run           setup: only the preflight, then whether each step would run, and why
  --settings FILE     settings.json (default ${tilde(DEFAULTS.settings)})
  --token-file FILE   the deck's token (default <repo>/${TOKEN_PATH})
  --release-dir DIR   the release folder (default <repo>/${RELEASE_PATH})
  --repo DIR          the repository whose HEAD is released (default this one)
  --claude FILE       the Claude Code binary release validates with (default the newest the app
                      bundles, found in --claude-code-root)
  --claude-code-root DIR
                      the app's bundled Claude Code versions (default ${tilde(DEFAULTS.claudeCodeRoot)})
  --skip-validate     release, and setup's release, without \`plugin validate\`
  --force             install over a ${DIRS_KEY} that isn't text; install or undo on a
                      settings.json a rewrite changes elsewhere (the backup keeps the original)
  -h, --help          this text

Exit status: 0 when done (status: installed and current), 1 when refused or failed (status: not
installed and current), 2 for a usage error.
`

const OPTIONS = {
  settings: { type: 'string' },
  'token-file': { type: 'string' },
  'release-dir': { type: 'string' },
  repo: { type: 'string' },
  claude: { type: 'string' },
  'claude-code-root': { type: 'string' },
  'skip-validate': { type: 'boolean' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

/** The paths and switches the commands take, from the parsed options: the token file and release folder default to the repository's. */
export function resolveOptions(values) {
  const repo = path.resolve(values.repo ?? DEFAULTS.repo)
  const releaseDir = path.resolve(values['release-dir'] ?? path.join(repo, RELEASE_PATH))
  return {
    repo,
    settings: path.resolve(values.settings ?? DEFAULTS.settings),
    tokenFile: path.resolve(values['token-file'] ?? path.join(repo, TOKEN_PATH)),
    releaseDir,
    copy: path.join(releaseDir, PLUGIN_NAME),
    claude: values.claude === undefined ? null : path.resolve(values.claude),
    claudeCodeRoot: path.resolve(values['claude-code-root'] ?? DEFAULTS.claudeCodeRoot),
    skipValidate: Boolean(values['skip-validate']),
    force: Boolean(values.force),
    dryRun: Boolean(values['dry-run']),
  }
}

/** Stops what's running and removes the temp folders, for an interrupted run. */
function stopAll() {
  for (const child of running) killGroup(child)
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
}

/** The command line: `host` is what setup and release take from this machine (HOST), which the tests replace. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}, host = {}) {
  let values
  let positionals
  try {
    ;({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  } catch (err) {
    stderr.write(`deck-install: ${err.message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    stdout.write(USAGE)
    return 0
  }
  const command = positionals[0] ?? 'status'
  if (positionals.length > 1 || !Object.hasOwn(COMMANDS, command)) {
    stderr.write(`deck-install: ${positionals.length > 1 ? `one command at a time, not ${positionals.join(' ')}` : `no command ${command}`}\n\n${USAGE}`)
    return 2
  }
  for (const k of ['settings', 'token-file', 'release-dir', 'repo', 'claude']) {
    if (values[k] === '') {
      stderr.write(`deck-install: --${k} needs a path\n\n${USAGE}`)
      return 2
    }
  }
  if (values['dry-run'] && command !== 'setup') {
    stderr.write(`deck-install: --dry-run goes with setup only\n\n${USAGE}`)
    return 2
  }
  const o = resolveOptions(values)
  const log = (line) => stdout.write(`${line}\n`)
  try {
    return await COMMANDS[command](o, log, host)
  } catch (err) {
    if (err instanceof Refusal) stderr.write(`deck-install ${command}: ${err.message}\n`)
    // Anything else is a bug or the file system. Its message has paths, not file contents, but a run of 64 hex is cut anyway.
    else stderr.write(`deck-install ${command}: failed: ${errCode(err)}: ${printable(String(err?.message ?? err), 400).replace(/[0-9a-f]{64}/gi, '<64 hex characters>')}\n`)
    return 1
  }
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
