// A small Bun standalone file table for the tests of claude-code/vendor/refresh.mjs and recheck.mjs, laid out as
// Bun lays out the __BUN,__bun section of Claude Code 2.1.317: an 8-byte length, then the data (each file's contents,
// the names, the table of 52-byte entries, Bun's Offsets and the trailer). Not a test file itself: all.mjs runs only
// *.test.mjs.

import zlib from 'node:zlib'

import { ENTRY, OFFSETS, ROOT_PREFIX, TRAILER } from '../../vendor/refresh.mjs'

/**
 * The section for `files`, `{name: text}` in table order; a name ending `.zst` is stored zstd-packed, as the binary
 * stores the declarations, unless `unpacked` names it. `entryPoint` is the index of the entry point. `entry` is the
 * size of each table entry, which only a test of a format change sets (the extra bytes are zero). `prefix` is where
 * every name starts, or a function of the name that says where it does.
 */
export function bunSection(files, { entryPoint = 0, entry = ENTRY, prefix = ROOT_PREFIX, unpacked = [] } = {}) {
  const parts = []
  let at = 0
  const put = (buf) => {
    const from = at
    parts.push(buf)
    at += buf.length
    return { from, length: buf.length }
  }
  const entries = Object.entries(files).map(([name, text]) => {
    const raw = Buffer.from(text, 'utf8')
    return { name, contents: put(name.endsWith('.zst') && !unpacked.includes(name) ? zlib.zstdCompressSync(raw) : raw) }
  })
  for (const e of entries) e.path = put(Buffer.from(`${typeof prefix === 'function' ? prefix(e.name) : prefix}${e.name}`, 'utf8'))
  const table = Buffer.alloc(entries.length * entry)
  entries.forEach((e, i) => {
    const p = i * entry
    table.writeUInt32LE(e.path.from, p)
    table.writeUInt32LE(e.path.length, p + 4)
    table.writeUInt32LE(e.contents.from, p + 8)
    table.writeUInt32LE(e.contents.length, p + 12)
    // No source map, bytecode or module info; the origin path is the name again, and then the one-byte fields.
    table.writeUInt32LE(e.path.from, p + 40)
    table.writeUInt32LE(e.path.length, p + 44)
    table.writeUInt8(1, p + 48)
    table.writeUInt8(1, p + 49)
  })
  const tableAt = put(table)
  const offsets = Buffer.alloc(OFFSETS)
  offsets.writeBigUInt64LE(BigInt(at), 0)
  offsets.writeUInt32LE(tableAt.from, 8)
  offsets.writeUInt32LE(tableAt.length, 12)
  offsets.writeUInt32LE(entryPoint, 16)
  put(offsets)
  put(TRAILER)
  const data = Buffer.concat(parts)
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(data.length))
  return Buffer.concat([length, data])
}

/** Bytes that stand around the section in a binary: deterministic noise, with Bun's trailer once in it, as the runtime's own code has it. */
export function noise(size, seed = 1) {
  const buf = Buffer.alloc(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    buf[i] = x >>> 24
  }
  if (size > 64) TRAILER.copy(buf, size >> 1)
  return buf
}

/** The mods API's files, as the engine's table names them, with a d.ts, a long form and the six examples. */
export function modsApiFiles({ dts = '// Claude Code function hooks: the plugin API\'s TypeScript declarations.\ntype X = 1;\n', reference = '# Function hooks: the long form\n\nText.\n', examples = {} } = {}) {
  const files = {
    'cli': 'console.log("entry point")\n',
    'claude-code.d.ts-7c62209c.txt.zst': dts,
    'reference-d80c0885.md.zst': reference,
    // Another reference.md, of another skill: refresh takes only the long form.
    'reference-0a1b2c3d.md.zst': '# Some other reference\n',
  }
  for (const [name, text] of Object.entries({
    'band-state.d.ts': 'export type BandState = {}\n',
    'band.tsx': 'export const band = 1\n',
    'pane-state.d.ts': 'export type PaneState = {}\n',
    'pane.test.tsx': 'test("pane", () => {})\n',
    'pane.tsx': 'export const pane = 1\n',
    'tool-call.ts': 'export const call = 1\n',
    ...examples,
  })) {
    if (text !== null) files[`${name}-${name.length.toString(16).padStart(8, 'x')}.txt`] = text
  }
  return files
}
