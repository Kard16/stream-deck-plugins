#!/usr/bin/env node
// Rebuilds claude-code/vendor/mods-api/ from a Claude Code binary the Claude app bundles: the mods API's
// declarations (claude-code.d.ts) and the plugin-authoring skill's long form (reference.md) and examples, exactly as
// that version ships them. Read only on the binary, so it never loads the skill or arms a session's mods folder.
//
//   node claude-code/vendor/refresh.mjs                  the newest bundled version
//   node claude-code/vendor/refresh.mjs --version 2.1.309
//   node claude-code/vendor/refresh.mjs --out DIR        somewhere else, to compare
//
// Where each file comes from, in the binary's __BUN,__bun section (`otool -l` gives its offset and size), a Bun
// standalone file table:
// - claude-code.d.ts: `claude-code.d.ts-<hash>.txt.zst`, zstd. The engine writes the same text beside a mod it
//   loads, as .claude-plugin/types/claude-code/index.d.ts, with one line first: `// Written by Claude Code <version>.`
//   This file adds that line too, so the two are byte for byte the same, and the line says which version this is.
//   The built-in tools' input types aren't in it: the engine makes them per session from the tools that session has.
//   2.1.309 appended them to this file; 2.1.317 writes them beside it, in types/claude-code-tools/index.d.ts. The mod
//   type-checks without them.
// - reference.md: `reference-<hash>.md.zst`, the one that starts `# Function hooks: the long form`.
// - examples/<name>: `<name>-<hash>.txt`, for each name in EXAMPLES.
// It refuses, and writes nothing, when one of them is missing or there are two: the format or the skill changed, and
// a person has to look. After a refresh: the plugin's type check against the new declarations, then recheck.mjs
// (CLAUDE.md, Commands).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
const EXAMPLES = ['band-state.d.ts', 'band.tsx', 'pane-state.d.ts', 'pane.test.tsx', 'pane.tsx', 'tool-call.ts']
const VERSION_DIR = /^\d+\.\d+\.\d+$/
const TRAILER = Buffer.from('\n---- Bun! ----\n')
const ENTRY = 52

const fail = (why) => {
  console.error(`refresh: ${why}`)
  process.exit(1)
}

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

/** The version (the newest bundled, or `want`) and its binary: of several builds, the most recently changed. */
function findBinary(want) {
  const versions = fs.readdirSync(ROOT).filter((n) => VERSION_DIR.test(n)).sort(compareVersions)
  const version = want ?? versions.at(-1)
  if (version === undefined || !versions.includes(version)) fail(`no Claude Code ${want ?? ''} in ${ROOT} (it has ${versions.join(', ') || 'none'})`)
  let binary = null
  let latest = -Infinity
  for (const build of fs.readdirSync(path.join(ROOT, version))) {
    const file = path.join(ROOT, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')
    const st = fs.statSync(file, { throwIfNoEntry: false })
    if (st?.isFile() && st.mtimeMs > latest) {
      latest = st.mtimeMs
      binary = file
    }
  }
  if (binary === null) fail(`no claude binary in ${path.join(ROOT, version)}/*/claude.app/Contents/MacOS/`)
  return { version, binary }
}

/** The __BUN,__bun section's file offset and size, from `otool -l`. */
function bunSection(binary) {
  const r = spawnSync('/usr/bin/otool', ['-l', binary], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) fail(`otool -l failed: ${(r.stderr || '').trim()}`)
  const lines = r.stdout.split('\n')
  const at = lines.findIndex((l) => /^\s*sectname __bun$/.test(l))
  if (at < 0) fail('no __bun section: is this a Bun standalone binary?')
  const field = (name) => {
    const line = lines.slice(at, at + 8).find((l) => new RegExp(`^\\s*${name} `).test(l))
    if (!line) fail(`the __bun section has no ${name}`)
    return Number(line.trim().split(/\s+/)[1])
  }
  return { offset: field('offset'), size: field('size') }
}

/** Each file in the section's table, by its name without `/$bunfs/root/`, with a lazy reader of its contents. */
function fileTable(binary) {
  const { offset, size } = bunSection(binary)
  const buf = fs.readFileSync(binary).subarray(offset, offset + size)
  const t = buf.lastIndexOf(TRAILER)
  if (t < 32) fail('no Bun trailer in the __bun section')
  const base = 8
  const modOff = buf.readUInt32LE(t - 32 + 8)
  const modLen = buf.readUInt32LE(t - 32 + 12)
  if (modLen % ENTRY !== 0 || base + modOff + modLen > buf.length) fail('the file table is not where Bun keeps it: the format changed')
  const files = []
  for (let i = 0; i < modLen / ENTRY; i++) {
    const p = base + modOff + i * ENTRY
    const span = (q) => buf.subarray(base + buf.readUInt32LE(q), base + buf.readUInt32LE(q) + buf.readUInt32LE(q + 4))
    const name = span(p).toString('utf8').replace(/^\/\$bunfs\/root\//, '')
    files.push({ name, read: () => (name.endsWith('.zst') ? zlib.zstdDecompressSync(span(p + 8)) : Buffer.from(span(p + 8))).toString('utf8') })
  }
  return files
}

/** The one file whose name matches and whose text passes `test`; fails on none or several. */
function only(files, what, nameTest, textTest = () => true) {
  const hits = files.filter((f) => nameTest.test(f.name)).map((f) => ({ name: f.name, text: f.read() })).filter((f) => textTest(f.text))
  if (hits.length !== 1) fail(`expected one ${what}, found ${hits.length}${hits.length ? `: ${hits.map((h) => h.name).join(', ')}` : ''}`)
  return hits[0]
}

const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
if (values.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}
const out = path.resolve(values.out ?? path.join(HERE, 'mods-api'))
const { version, binary } = findBinary(values.version)
const files = fileTable(binary)
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dts = only(files, 'claude-code.d.ts', /^claude-code\.d\.ts-[^/]*\.txt(\.zst)?$/)
const reference = only(files, 'reference.md', /^reference-[^/]*\.md(\.zst)?$/, (t) => t.startsWith('# Function hooks: the long form'))
const examples = EXAMPLES.map((name) => ({ ...only(files, name, new RegExp(`^${escape(name)}-[^/]*\\.txt$`)), name }))

// Written to a temp folder beside the target, then swapped in, so a failure leaves the old copy whole.
// The engine writes the declarations between its first line and a blank last line (where 2.1.309 put the tools'
// input types), so the file it lays beside a mod and this one are the same bytes.
const next = { 'claude-code.d.ts': `// Written by Claude Code ${version}.\n${dts.text}\n`, 'reference.md': reference.text }
for (const e of examples) next[path.join('examples', e.name)] = e.text
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
