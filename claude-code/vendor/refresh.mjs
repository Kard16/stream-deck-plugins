#!/usr/bin/env node
// Rebuilds claude-code/vendor/mods-api/ from a Claude Code binary the Claude app bundles: the mods API's
// declarations (claude-code.d.ts) and the plugin-authoring skill's long form (reference.md) and examples, exactly as
// that version ships them. Read only on the binary, so it never loads the skill or arms a session's mods folder.
//
// The folder is Anthropic's text, so git ignores it: each Mac that needs it makes its own, with this. What git keeps
// is checked-version.txt, beside the folder: the declarations' first line, which names the Claude Code version the
// repo was checked against. This writes it with the folder, and the deck reads it (deck/src/model/versions.ts).
//
//   node claude-code/vendor/refresh.mjs                  the newest bundled version
//   node claude-code/vendor/refresh.mjs --version 2.1.309
//   node claude-code/vendor/refresh.mjs --out DIR        somewhere else, to compare
//
// Where each file comes from, in the binary's __BUN,__bun section, a Bun standalone file table. The section says
// where it is itself: it starts with its length, and ends with Bun's Offsets and trailer, whose byte count reaches back
// to that start; findSection reads it so, and readFileTable refuses a table that isn't laid out that way.
// - claude-code.d.ts: `claude-code.d.ts-<hash>.txt.zst`, zstd. The engine writes the same text beside a mod it
//   loads, as .claude-plugin/types/claude-code/index.d.ts, with one line first: `// Written by Claude Code <version>.`
//   This file adds that line too, so the two are byte for byte the same, and the line says which version this is.
//   The built-in tools' input types aren't in it: the engine makes them per session from the tools that session has.
//   2.1.309 appended them to this file; 2.1.317 writes them beside it, in types/claude-code-tools/index.d.ts. The mod
//   type-checks without them.
// - reference.md: `reference-<hash>.md.zst`, the one that starts `# Function hooks: the long form`.
// - examples/<name>: `<name>-<hash>.txt`, for each name in EXAMPLES.
// It refuses, and writes nothing, when one of them is missing, there are two, or one can't be read: the format or the
// skill changed, and a person has to look. After a refresh: the plugin's type check against the new declarations,
// which holds the deck's hook answers to them too (claude-code/plugin-tsc/hook-contract.ts), then recheck.mjs
// (CLAUDE.md, Commands). recheck.mjs imports the reader below to compare the vendored copy with the binary, and
// findBinary, so the two pick the same build.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
export const EXAMPLES = Object.freeze(['band-state.d.ts', 'band.tsx', 'pane-state.d.ts', 'pane.test.tsx', 'pane.tsx', 'tool-call.ts'])
/** The file git keeps, beside mods-api/: the declarations' first line, so the version the repo was checked against. */
export const MARKER = 'checked-version.txt'
/** A bundled version's folder name. */
export const VERSION_DIR = /^\d+\.\d+\.\d+$/
export const TRAILER = Buffer.from('\n---- Bun! ----\n')
/** One file's entry in the table: six string pointers (name, contents, sourcemap, bytecode, module info, origin) and four one-byte fields. */
export const ENTRY = 52
/** Bun's Offsets, just before the trailer: the byte count (u64), the table's pointer, the entry point's index, the exec argv's pointer and flags. */
export const OFFSETS = 32
/** Where every file's name starts. */
export const ROOT_PREFIX = '/$bunfs/root/'

/** Why refresh can't go on; a person has to look. */
export class RefreshError extends Error {
  name = 'RefreshError'
}
/** The file table isn't laid out as Bun lays it out: not where it should be, or Bun changed its format. */
export class BunFormatError extends RefreshError {
  name = 'BunFormatError'
}

/** The first line of the declarations, as the engine writes it beside a mod (its coreDeclarationsOf). */
export const firstLine = (version) => `// Written by Claude Code ${version}.`

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

/**
 * The Claude Code versions bundled in `root`, oldest first: its folders named like 2.1.317. RefreshError when it can't
 * be listed, with the system's `code`.
 */
export function bundledVersions(root = ROOT) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    throw Object.assign(new RefreshError(`can't list ${root}: ${err.code ?? err.message}`), { code: err.code })
  }
  return entries.filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => e.name).sort(compareVersions)
}

/**
 * The version (the newest bundled, or `want`) and its binary, `<root>/<version>/<build>/claude.app/Contents/MacOS/claude`:
 * of its builds' executables, the most recently changed; builds whose names start with a dot don't count. recheck.mjs
 * finds every binary it reads or runs with this too.
 */
export function findBinary(want, root = ROOT) {
  const versions = bundledVersions(root)
  const version = want ?? versions.at(-1)
  if (version === undefined || !versions.includes(version)) throw new RefreshError(`no Claude Code ${want ?? ''} in ${root} (it has ${versions.join(', ') || 'none'})`)
  let builds = []
  try {
    builds = fs.readdirSync(path.join(root, version))
  } catch {}
  let binary = null
  let latest = -Infinity
  for (const build of builds) {
    if (build.startsWith('.')) continue
    const file = path.join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')
    const st = fs.statSync(file, { throwIfNoEntry: false })
    if (st?.isFile() && (st.mode & 0o111) !== 0 && st.mtimeMs > latest) {
      latest = st.mtimeMs
      binary = file
    }
  }
  if (binary === null) throw new RefreshError(`no claude binary in ${path.join(root, version)}/*/claude.app/Contents/MacOS/`)
  return { version, binary }
}

/**
 * Where the __BUN,__bun section is in `buf`, a whole binary, read off the section itself: a trailer whose Offsets'
 * byte count reaches back to a length that ends just after it. The last such trailer, of the last few; null when none
 * agrees. On 2.1.309 and 2.1.317 it's where `otool -l` puts the section, offset and size alike.
 */
export function findSection(buf) {
  let t = buf.lastIndexOf(TRAILER)
  for (let tries = 0; t !== -1 && tries < 8; tries++) {
    if (t >= OFFSETS + 8) {
      const byteCount = buf.readBigUInt64LE(t - OFFSETS)
      if (byteCount <= BigInt(t - OFFSETS - 8)) {
        const data = t - OFFSETS - Number(byteCount)
        const len = buf.readBigUInt64LE(data - 8)
        if (len === BigInt(t + TRAILER.length - data)) return { offset: data - 8, size: 8 + Number(len) }
      }
    }
    t = t === 0 ? -1 : buf.lastIndexOf(TRAILER, t - 1)
  }
  return null
}

/**
 * Each file in the table of the section at `offset`, `size` bytes long, in `buf`: its name, without `/$bunfs/root/`
 * where it has it (`rooted`), its size, and a reader of its contents, unpacked when its name ends `.zst`. Pointers
 * count from the section's data, after its 8-byte length. Throws BunFormatError unless the section is laid out as Bun
 * lays it out: its length fits, the trailer ends it, the byte count reaches its start, the table and every name lie
 * inside it, and the entry point is one of the files, under /$bunfs/root/. So a section read at the wrong offset is
 * refused, and one oddly named file isn't; the reader refuses a file it can't unpack, and only() one it takes that
 * isn't under /$bunfs/root/.
 */
export function readFileTable(buf, { offset, size }) {
  const at = `the __bun section at ${offset} (${size} bytes)`
  const bad = (why) => {
    throw new BunFormatError(`${at}: ${why}, so the file table is not where Bun keeps it, or Bun changed its format`)
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 8 + OFFSETS + TRAILER.length || offset + size > buf.length) bad('it lies outside the file')
  const len = buf.readBigUInt64LE(offset)
  if (len > BigInt(size - 8) || len < BigInt(OFFSETS + TRAILER.length)) bad(`its length, ${len}, doesn't fit it`)
  const data = buf.subarray(offset + 8, offset + 8 + Number(len))
  if (!data.subarray(data.length - TRAILER.length).equals(TRAILER)) bad("Bun's trailer doesn't end it")
  const o = data.length - TRAILER.length - OFFSETS
  if (data.readBigUInt64LE(o) !== BigInt(o)) bad(`its byte count, ${data.readBigUInt64LE(o)}, isn't ${o}`)
  const tableAt = data.readUInt32LE(o + 8)
  const tableLen = data.readUInt32LE(o + 12)
  if (tableLen === 0 || tableLen % ENTRY !== 0 || tableAt + tableLen > o) bad(`its table, ${tableLen} bytes at ${tableAt}, isn't whole entries of ${ENTRY} bytes inside it`)
  const count = tableLen / ENTRY
  const entryPoint = data.readUInt32LE(o + 16)
  if (entryPoint >= count) bad(`its entry point, ${entryPoint}, isn't one of its ${count} files`)
  const span = (q, what) => {
    const from = data.readUInt32LE(q)
    const length = data.readUInt32LE(q + 4)
    if (from + length > o) bad(`${what} lies past its data`)
    return data.subarray(from, from + length)
  }
  const files = []
  for (let i = 0; i < count; i++) {
    const p = tableAt + i * ENTRY
    const full = span(p, `file ${i}'s name`).toString('utf8')
    const rooted = full.startsWith(ROOT_PREFIX)
    if (i === entryPoint && !rooted) bad(`its entry point, file ${i}, isn't under ${ROOT_PREFIX}`)
    const name = rooted ? full.slice(ROOT_PREFIX.length) : full
    const contents = span(p + 8, `file ${i}'s contents`)
    const read = () => {
      if (!name.endsWith('.zst')) return contents.toString('utf8')
      try {
        return zlib.zstdDecompressSync(contents).toString('utf8')
      } catch (err) {
        throw new BunFormatError(`${name} can't be unpacked (${err.message}), so Bun changed how it packs a file`)
      }
    }
    files.push({ name, rooted, size: contents.length, contents, read })
  }
  return files
}

/** The file table of `buf`, a whole binary, found by findSection; BunFormatError when it has none. */
export function fileTable(buf) {
  const section = findSection(buf)
  if (section === null) throw new BunFormatError("no Bun file table: no trailer whose byte count and length agree, so it isn't a Bun standalone binary, or Bun changed its format")
  return readFileTable(buf, section)
}

/**
 * The one file whose name matches and whose text passes `test`; RefreshError on none or several, and BunFormatError
 * when it isn't under /$bunfs/root/, where Bun keeps every file of its own.
 */
export function only(files, what, nameTest, textTest = () => true) {
  const hits = files.filter((f) => nameTest.test(f.name)).map((f) => ({ name: f.name, rooted: f.rooted, text: f.read() })).filter((f) => textTest(f.text))
  if (hits.length !== 1) throw new RefreshError(`expected one ${what}, found ${hits.length}${hits.length ? `: ${hits.map((h) => h.name).join(', ')}` : ''}`)
  if (!hits[0].rooted) throw new BunFormatError(`${what}, ${hits[0].name}, isn't under ${ROOT_PREFIX}, so Bun changed its format`)
  return hits[0]
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What refresh writes for `version` from its file table, by path under mods-api/: the declarations with the engine's
 * first line, the long form and the examples. RefreshError when one of them is missing or there are two;
 * BunFormatError when one can't be read (only(), readFileTable).
 */
export function modsApi(files, version) {
  const dts = only(files, 'claude-code.d.ts', /^claude-code\.d\.ts-[^/]*\.txt(\.zst)?$/)
  const reference = only(files, 'reference.md', /^reference-[^/]*\.md(\.zst)?$/, (t) => t.startsWith('# Function hooks: the long form'))
  const examples = EXAMPLES.map((name) => ({ ...only(files, name, new RegExp(`^${escape(name)}-[^/]*\\.txt$`)), name }))
  // The engine writes the declarations between its first line and a blank last line (where 2.1.309 put the tools'
  // input types), so the file it lays beside a mod and this one are the same bytes.
  const out = { 'claude-code.d.ts': `${firstLine(version)}\n${dts.text}\n`, 'reference.md': reference.text }
  for (const e of examples) out[`examples/${e.name}`] = e.text
  return out
}

function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    return
  }
  const out = path.resolve(values.out ?? path.join(HERE, 'mods-api'))
  const { version, binary } = findBinary(values.version)
  const next = modsApi(fileTable(fs.readFileSync(binary)), version)

  // Written to a temp folder beside the target, then swapped in, so a failure leaves the old copy whole.
  const tmp = fs.mkdtempSync(path.join(path.dirname(out), '.mods-api-'))
  for (const [rel, text] of Object.entries(next)) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), text)
  }
  const before = (rel) => {
    try {
      return fs.readFileSync(path.join(out, rel), 'utf8')
    } catch {
      return null
    }
  }
  const changed = Object.entries(next).filter(([rel, text]) => before(rel) !== text).map(([rel]) => rel)
  fs.rmSync(out, { recursive: true, force: true })
  fs.renameSync(tmp, out)
  console.log(`refresh: ${path.relative(process.cwd(), out) || out} from Claude Code ${version} (${binary})`)
  console.log(changed.length ? `  changed: ${changed.join(', ')}` : '  no change')
  // The marker goes only with the repo's own copy: a copy made somewhere else, to compare, says nothing of the repo.
  if (values.out === undefined) {
    const marker = path.join(HERE, MARKER)
    const line = `${firstLine(version)}\n`
    let had = null
    try {
      had = fs.readFileSync(marker, 'utf8')
    } catch {}
    if (had !== line) fs.writeFileSync(marker, line)
    console.log(`  ${MARKER}: ${had === line ? 'no change' : `now ${version}`}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    if (!(err instanceof RefreshError)) throw err
    console.error(`refresh: ${err.message}`)
    process.exit(1)
  }
}
