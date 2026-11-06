// sync-fixtures.mjs --check, run on copies of the files it reads, laid out as in claude-code/, each copy changed one
// way. The copies go in the system's temp folder: nothing here writes into the plugin's folder or the protocol's.
//
//   mise exec -- node --test claude-code/plugin-tsc/sync-fixtures.test.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** claude-code/, which the copies are made from. */
const CC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
/** What the script reads, relative to claude-code/. */
const READS = [
  'plugin-tsc/sync-fixtures.mjs',
  'protocol/PROTOCOL.md',
  'protocol/fixtures',
  'plugin/hooks/hooks.json',
  'plugin/hooks/bridge.ts',
  'plugin/.claude-plugin/plugin.json',
  'plugin/tests/fixtures.gen.ts',
]
const HOOKS = 'plugin/hooks/hooks.json'
const MANIFEST = 'plugin/.claude-plugin/plugin.json'

/** A copy of what the script reads, in a temp folder removed after `t`. */
function copy(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-fixtures-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const p of READS) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    fs.cpSync(path.join(CC, p), path.join(root, p), { recursive: true })
  }
  return root
}

/** The copy's script, run with --check: its exit status and what it printed. */
function check(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'plugin-tsc', 'sync-fixtures.mjs'), '--check'], { cwd: root, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** Rewrites one of the copy's JSON files as `change` returns it, handed the file parsed. */
function edit(root, file, change) {
  const p = path.join(root, file)
  fs.writeFileSync(p, `${JSON.stringify(change(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2)}\n`)
}

/** `v` with every object's keys in the opposite order. */
const reversed = (v) =>
  Array.isArray(v) ? v.map(reversed) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v

/** A hook of the kind the checks keep out: a tool call waits up to 600 s on the deck, and is blocked while it's down. */
const BLOCKING = { type: 'http', url: 'http://127.0.0.1:47600/v1/permission', timeout: 600, onFailure: 'block' }

test('the files as they are pass all four checks', (t) => {
  const r = check(copy(t))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /fixtures\.gen\.ts matches the \d+ fixtures and vectors\.json/)
  assert.match(r.stdout, /hooks\.json matches PROTOCOL\.md's block/)
  assert.match(r.stdout, /plugin\.json only describes the plugin: /)
  assert.match(r.stdout, /plugin\.json's version, [^,]+, is bridge\.ts's PLUGIN_VERSION/)
})

test("hooks.json may be laid out any way, its keys in any order: it's the hooks parsed that are checked", (t) => {
  const root = copy(t)
  const p = path.join(root, HOOKS)
  fs.writeFileSync(p, JSON.stringify(reversed(JSON.parse(fs.readFileSync(p, 'utf8')))))
  const r = check(root)
  assert.equal(r.status, 0, r.stderr)
})

test("hooks.json other than PROTOCOL.md's block fails, saying where", async (t) => {
  const permission = (h) => h.hooks.PermissionRequest[0]
  const cases = [
    ['the permission hook blocking while the bridge is down', (h) => (permission(h).hooks[0].onFailure = 'block'), 'hooks.PermissionRequest[0].hooks[0].onFailure'],
    ['a hook added', (h) => (h.hooks.PostToolUse = [{ hooks: [BLOCKING] }]), 'hooks.PostToolUse'],
  ]
  for (const [name, change, at] of cases) {
    await t.test(name, (tt) => {
      const root = copy(tt)
      edit(root, HOOKS, (h) => {
        change(h)
        return h
      })
      const r = check(root)
      assert.equal(r.status, 1, r.stdout)
      assert.ok(r.stderr.includes(`hooks.json isn't PROTOCOL.md's block under "The plugin's hooks.json": at ${at},`), r.stderr)
    })
  }
})

test('plugin.json with a key beyond those that describe the plugin fails, naming it: its hooks would load beside hooks.json', async (t) => {
  const matchers = { PreToolUse: [{ matcher: '*', hooks: [BLOCKING] }] }
  const cases = [
    ['hooks written in', { hooks: matchers }, '"hooks"'],
    ['a path to another hooks file', { hooks: './hooks/more.json' }, '"hooks"'],
    ['a list of both', { hooks: ['./hooks/more.json', matchers] }, '"hooks"'],
    ['an MCP server', { mcpServers: { more: { command: 'node', args: ['more.mjs'] } } }, '"mcpServers"'],
    ['another plugin, and commands', { dependencies: ['other-plugin'], commands: ['./commands/go.md'] }, '"dependencies", "commands"'],
  ]
  for (const [name, added, named] of cases) {
    await t.test(name, (tt) => {
      const root = copy(tt)
      edit(root, MANIFEST, (m) => ({ ...m, ...added }))
      const r = check(root)
      assert.equal(r.status, 1, r.stdout)
      assert.ok(r.stderr.includes(`plugin.json has ${named}, beyond the keys that only describe the plugin`), r.stderr)
      // The rest still passes: hooks.json and the version are as they were.
      assert.match(r.stdout, /hooks\.json matches PROTOCOL\.md's block/)
      assert.match(r.stdout, /is bridge\.ts's PLUGIN_VERSION/)
    })
  }
  await t.test("one that isn't an object", (tt) => {
    const root = copy(tt)
    edit(root, MANIFEST, (m) => [m])
    const r = check(root)
    assert.equal(r.status, 1, r.stdout)
    assert.ok(r.stderr.includes("plugin.json isn't a JSON object"), r.stderr)
  })
})

test('plugin.json may say more about the plugin: a license, keywords, a homepage', (t) => {
  const root = copy(t)
  edit(root, MANIFEST, (m) => ({ ...m, license: 'MIT', keywords: ['stream-deck'], homepage: 'https://example.com/streamdeck-bridge' }))
  const r = check(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /plugin\.json only describes the plugin: .*license, keywords, homepage/)
})

test("plugin.json's version other than the hello's fails", (t) => {
  const root = copy(t)
  edit(root, MANIFEST, (m) => ({ ...m, version: '0.1.0' }))
  const r = check(root)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /plugin\.json's version is "0\.1\.0", but bridge\.ts's PLUGIN_VERSION, which the hello sends, is "/)
})

test("a fixtures.gen.ts that isn't the fixtures' copy fails", (t) => {
  const root = copy(t)
  fs.appendFileSync(path.join(root, 'plugin/tests/fixtures.gen.ts'), '// edited by hand\n')
  const r = check(root)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stderr, /fixtures\.gen\.ts is out of date with claude-code\/protocol\/fixtures\/: run this script without --check/)
})
