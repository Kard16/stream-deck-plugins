// claude-code/vendor/refresh.mjs on small synthetic Bun file tables (bun-table.mjs), in memory and through the command
// with HOME pointed at a temp folder, so refresh's root is a fake bundled Claude Code. Nothing here reads the real
// binaries or the app's folders; recheck.mjs's check 8 compares the vendored copy with the real binary.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as F from '../../vendor/refresh.mjs'
import { vendoredVersion } from '../recheck.mjs'
import { bunSection, modsApiFiles, noise } from './bun-table.mjs'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'refresh.mjs')

/** A binary: noise, the section, noise; and where the section is. */
function binary(files, opts) {
  const before = noise(4096, 7)
  const section = bunSection(files, opts)
  return { buf: Buffer.concat([before, section, noise(1500, 11)]), offset: before.length, size: section.length }
}

const names = (files) => files.map((f) => f.name)

test('refresh: the file table is found by its own trailer, past the noise around it, and every file reads back', () => {
  const files = modsApiFiles()
  const b = binary(files, { entryPoint: 0 })
  assert.deepEqual(F.findSection(b.buf), { offset: b.offset, size: b.size }, 'where the section is, though Bun\'s trailer is in the noise too')
  const table = F.fileTable(b.buf)
  assert.deepEqual(names(table), Object.keys(files))
  for (const f of table) assert.equal(f.read(), files[f.name], f.name)
  // A packed file is unpacked; its size is what the table holds.
  const dts = table.find((f) => f.name.startsWith('claude-code.d.ts-'))
  assert.notEqual(dts.size, Buffer.byteLength(files[dts.name]))
  assert.deepEqual(names(F.readFileTable(b.buf, { offset: b.offset, size: b.size })), Object.keys(files))
})

test('refresh: a wrong section offset or size is refused, never read as a table', () => {
  const b = binary(modsApiFiles())
  for (const [offset, size] of [
    [b.offset - 8, b.size],
    [b.offset - 1, b.size],
    [b.offset + 1, b.size],
    [b.offset + 8, b.size - 8],
    [b.offset, b.size - 1],
    [0, b.size],
    [b.offset, b.buf.length],
    [-1, b.size],
  ]) {
    assert.throws(() => F.readFileTable(b.buf, { offset, size }), F.BunFormatError, `offset ${offset}, size ${size}`)
  }
  // The error says where it looked, and that the format may have changed.
  assert.throws(() => F.readFileTable(b.buf, { offset: b.offset + 8, size: b.size - 8 }), /^BunFormatError: the __bun section at \d+ \(\d+ bytes\): .*, so the file table is not where Bun keeps it, or Bun changed its format$/)
})

test('refresh: a table laid out otherwise is refused: a broken length or byte count, entries of another size, names elsewhere, no entry point', () => {
  const files = modsApiFiles()
  const broken = (edit) => {
    const b = binary(files)
    edit(b)
    return b
  }
  // The length or the byte count off by one: the trailer then agrees with neither, so there's no table to find.
  for (const edit of [
    (b) => b.buf.writeBigUInt64LE(b.buf.readBigUInt64LE(b.offset) + 1n, b.offset),
    (b) => {
      const at = b.offset + b.size - F.TRAILER.length - F.OFFSETS
      b.buf.writeBigUInt64LE(b.buf.readBigUInt64LE(at) - 1n, at)
    },
  ]) {
    const b = broken(edit)
    assert.equal(F.findSection(b.buf), null)
    assert.throws(() => F.fileTable(b.buf), /^BunFormatError: no Bun file table: no trailer whose byte count and length agree/)
    assert.throws(() => F.readFileTable(b.buf, { offset: b.offset, size: b.size }), F.BunFormatError)
  }
  // Bun grew its entries to 56 bytes, keeps its files somewhere else, or lost its entry point.
  for (const [opts, why] of [
    [{ entry: 56 }, /isn't whole entries of 52 bytes/],
    [{ prefix: 'B:/~BUN/root/' }, /its entry point, file 0, isn't under \/\$bunfs\/root\//],
    [{ prefix: (name) => (name === 'cli' ? '/$bunfs/other/' : F.ROOT_PREFIX) }, /its entry point, file 0, isn't under \/\$bunfs\/root\//],
    [{ entryPoint: Object.keys(files).length }, /its entry point, \d+, isn't one of its \d+ files/],
  ]) {
    const b = binary(files, opts)
    assert.throws(() => F.fileTable(b.buf), why, JSON.stringify(opts))
  }
  assert.throws(() => F.fileTable(noise(9000)), /^BunFormatError: no Bun file table/)
  assert.throws(() => F.fileTable(Buffer.from('#!/bin/sh\necho hi\n')), /^BunFormatError: no Bun file table/)
})

test('refresh: what it writes is the d.ts with the engine\'s first line, the long form and the six examples', () => {
  const table = F.fileTable(binary(modsApiFiles()).buf)
  const out = F.modsApi(table, '2.1.400')
  assert.deepEqual(Object.keys(out), ['claude-code.d.ts', 'reference.md', ...F.EXAMPLES.map((e) => `examples/${e}`)])
  assert.equal(out['reference.md'], '# Function hooks: the long form\n\nText.\n', 'the long form, not the other skill\'s reference')
  assert.equal(out['examples/tool-call.ts'], 'export const call = 1\n')
})

test('refresh: a changed first line of the d.ts is caught: it is the engine\'s, and recheck reads the version back from it', (t) => {
  const dts = '// Claude Code function hooks: the plugin API\'s TypeScript declarations.\ntype X = 1;\n'
  const out = F.modsApi(F.fileTable(binary(modsApiFiles({ dts })).buf), '2.1.400')
  // The engine's coreDeclarationsOf: `// Written by Claude Code ${version}.\n${declarations}\n`.
  assert.equal(F.firstLine('2.1.400'), '// Written by Claude Code 2.1.400.')
  assert.equal(out['claude-code.d.ts'], `// Written by Claude Code 2.1.400.\n${dts}\n`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'claude-code.d.ts'), out['claude-code.d.ts'])
  assert.equal(vendoredVersion(path.join(dir, 'claude-code.d.ts')), '2.1.400', 'recheck\'s check 1 reads the version refresh wrote')
})

test('refresh: a file of another name doesn\'t refuse the table, but one refresh takes must be under /$bunfs/root/, and unpack', () => {
  const files = { ...modsApiFiles(), 'odd.asset': 'an asset Bun keeps elsewhere' }
  const odd = F.fileTable(binary(files, { prefix: (name) => (name === 'odd.asset' ? '' : F.ROOT_PREFIX) }).buf)
  assert.deepEqual(odd.filter((f) => !f.rooted).map((f) => f.name), ['odd.asset'])
  assert.deepEqual(Object.keys(F.modsApi(odd, '2.1.400')).length, 8)
  const dts = 'claude-code.d.ts-7c62209c.txt.zst'
  const outside = F.fileTable(binary(files, { prefix: (name) => (name === dts ? '' : F.ROOT_PREFIX) }).buf)
  assert.throws(() => F.modsApi(outside, '2.1.400'), /^BunFormatError: claude-code\.d\.ts, claude-code\.d\.ts-7c62209c\.txt\.zst, isn't under \/\$bunfs\/root\/, so Bun changed its format$/)
  const packedOtherwise = F.fileTable(binary(files, { unpacked: [dts] }).buf)
  assert.throws(() => F.modsApi(packedOtherwise, '2.1.400'), /^BunFormatError: claude-code\.d\.ts-7c62209c\.txt\.zst can't be unpacked \(.*\), so Bun changed how it packs a file$/)
})

test('refresh: a missing file, or two of one, is refused, naming it', () => {
  const refuse = (files, why) => assert.throws(() => F.modsApi(F.fileTable(binary(files).buf), '2.1.400'), (err) => err instanceof F.RefreshError && !(err instanceof F.BunFormatError) && why.test(err.message), String(why))
  const all = modsApiFiles()
  const without = (pattern) => Object.fromEntries(Object.entries(all).filter(([name]) => !pattern.test(name)))
  refuse(without(/^claude-code\.d\.ts-/), /^expected one claude-code\.d\.ts, found 0$/)
  refuse({ ...all, 'claude-code.d.ts-00000000.txt': 'declare const x: 1\n' }, /^expected one claude-code\.d\.ts, found 2: claude-code\.d\.ts-7c62209c\.txt\.zst, claude-code\.d\.ts-00000000\.txt$/)
  refuse(without(/^reference-d80c0885/), /^expected one reference\.md, found 0$/)
  refuse({ ...all, 'reference-feedf00d.md': '# Function hooks: the long form\n\nAnother.\n' }, /^expected one reference\.md, found 2: /)
  refuse(modsApiFiles({ examples: { 'tool-call.ts': null } }), /^expected one tool-call\.ts, found 0$/)
  refuse({ ...all, 'band.tsx-feedf00d.txt': 'export const band = 2\n' }, /^expected one band\.tsx, found 2: band\.tsx-xxxxxxx8\.txt, band\.tsx-feedf00d\.txt$/)
})

/** A HOME whose Claude Code root bundles `versions`, each a binary with `files`, and an out folder already there. */
function fakeHome(t, versions) {
  // The real path, as the command's working folder reports it (/private/var/…), so its relative paths read short.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-home-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  for (const [version, buf] of Object.entries(versions)) {
    const bin = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code', version, 'abc123', 'claude.app', 'Contents', 'MacOS', 'claude')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, buf, { mode: 0o755 })
  }
  const out = path.join(home, 'out', 'mods-api')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'claude-code.d.ts'), '// Written by Claude Code 2.1.300.\nold\n')
  return { home, out }
}

test('refresh: versions sort by number, not by text', () => {
  assert.deepEqual(['2.10.0', '2.1.309', '2.1.40', '2.1.312', '10.0.0'].sort(F.compareVersions), ['2.1.40', '2.1.309', '2.1.312', '2.10.0', '10.0.0'])
})

test('refresh: findBinary takes the newest version, or the one asked for, and of its builds the most recently changed executable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = (version, build, { mode = 0o755, mtime = 1000 } = {}) => {
    const file = path.join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'x', { mode })
    fs.utimesSync(file, mtime, mtime)
    return file
  }
  const older = bin('2.1.309', 'aaa', { mtime: 1000 })
  const newer = bin('2.1.309', 'bbb', { mtime: 2000 })
  // Newer still, but not executable, or a dot build: neither counts.
  bin('2.1.309', 'ccc', { mtime: 3000, mode: 0o644 })
  bin('2.1.309', '.ddd', { mtime: 4000 })
  bin('2.1.40', 'aaa')
  fs.writeFileSync(path.join(root, '2.1.999'), 'a file, not a version folder')
  fs.mkdirSync(path.join(root, 'not-a-version'))
  assert.deepEqual(F.bundledVersions(root), ['2.1.40', '2.1.309'])
  assert.deepEqual(F.findBinary(undefined, root), { version: '2.1.309', binary: newer })
  assert.equal(F.findBinary('2.1.40', root).version, '2.1.40')
  fs.chmodSync(newer, 0o644)
  assert.equal(F.findBinary(undefined, root).binary, older)
  assert.throws(() => F.findBinary('2.1.999', root), /^RefreshError: no Claude Code 2\.1\.999 in .* \(it has 2\.1\.40, 2\.1\.309\)$/)
  fs.chmodSync(older, 0o644)
  assert.throws(() => F.findBinary(undefined, root), /^RefreshError: no claude binary in .*2\.1\.309\/\*\/claude\.app\/Contents\/MacOS\/$/)
  assert.throws(() => F.bundledVersions(path.join(root, 'nowhere')), (err) => err instanceof F.RefreshError && err.code === 'ENOENT')
})

const run = (home, args, cwd = home) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8', cwd })

test('refresh: the command writes the newest bundled version\'s files, or refuses and leaves the old copy whole', (t) => {
  const good = binary(modsApiFiles()).buf
  const { home, out } = fakeHome(t, { '2.1.300': binary(modsApiFiles({ dts: 'old\n' })).buf, '2.1.400': good })
  let r = run(home, ['--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^refresh: out\/mods-api from Claude Code 2\.1\.400 \(.*2\.1\.400\/abc123\/claude\.app\/Contents\/MacOS\/claude\)\n {2}changed: claude-code\.d\.ts, reference\.md, examples\/band-state\.d\.ts/)
  const expected = F.modsApi(F.fileTable(good), '2.1.400')
  for (const [rel, text] of Object.entries(expected)) assert.equal(fs.readFileSync(path.join(out, rel), 'utf8'), text, rel)
  r = run(home, ['--out', out])
  assert.match(r.stdout, /\n {2}no change\n$/)

  // Refused: an example missing, a table Bun no longer lays out so, a version not bundled. Nothing is written.
  const before = fs.readFileSync(path.join(out, 'claude-code.d.ts'), 'utf8')
  const broken = fakeHome(t, { '2.1.400': binary(modsApiFiles({ examples: { 'pane.tsx': null } })).buf })
  r = run(broken.home, ['--out', broken.out])
  assert.equal(r.status, 1)
  assert.equal(r.stderr, 'refresh: expected one pane.tsx, found 0\n')
  assert.equal(fs.readFileSync(path.join(broken.out, 'claude-code.d.ts'), 'utf8'), '// Written by Claude Code 2.1.300.\nold\n', 'the old copy is whole')
  assert.deepEqual(fs.readdirSync(path.dirname(broken.out)), ['mods-api'], 'no temp folder is left')
  const unpackable = fakeHome(t, { '2.1.400': binary(modsApiFiles(), { unpacked: ['reference-d80c0885.md.zst'] }).buf })
  r = run(unpackable.home, ['--out', unpackable.out])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^refresh: reference-d80c0885\.md\.zst can't be unpacked \(.*\), so Bun changed how it packs a file\n$/)
  const noTable = fakeHome(t, { '2.1.400': Buffer.concat([Buffer.from('#!/bin/sh\n'), noise(5000)]) })
  r = run(noTable.home, ['--out', noTable.out])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^refresh: no Bun file table: /)
  r = run(home, ['--version', '2.1.999', '--out', out])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^refresh: no Claude Code 2\.1\.999 in .* \(it has 2\.1\.300, 2\.1\.400\)\n$/)
  assert.equal(fs.readFileSync(path.join(out, 'claude-code.d.ts'), 'utf8'), before)
  r = run(path.join(home, 'nowhere'), ['--out', out], home)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^refresh: can't list .*nowhere\/Library\/Application Support\/Claude\/claude-code: ENOENT\n$/)

  // An older version on request.
  r = run(home, ['--version', '2.1.300', '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(path.join(out, 'claude-code.d.ts'), 'utf8'), '// Written by Claude Code 2.1.300.\nold\n\n')
})
