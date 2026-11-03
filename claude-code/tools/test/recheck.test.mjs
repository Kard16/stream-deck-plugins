// recheck.mjs against fixtures each test makes in a temp folder: a fake registry with .key files beside it, fake
// records, a small file standing in for app.asar, an Info.plist, a Claude Code root whose binary is a shell script,
// and a git repository holding a plugin. Nothing here reads the real ~/.claude/, the app's folders or the app
// bundle. What it reads of this repository: the deck's sources, for the drift test and the JSON's citations, and
// HEAD's claude-code/plugin for one run of check 5 with the default repository, both read only.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as R from '../recheck.mjs'

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(TOOLS, 'recheck.mjs')
const REPO = path.resolve(TOOLS, '..', '..')
const T0 = 1793600000000

// ---- fixtures

/** A registry entry with every field the deck reads, and some it doesn't. Every value says "secret": none may be printed. */
function session(i, over = {}) {
  return {
    pid: 100 + i, sessionId: `sid-secret-${i}`, hostSessionId: `local_secret-${i}`, name: `Secret title ${i}`, cwd: `/Users/someone/secret-${i}`,
    status: 'idle', statusUpdatedAt: T0 + i, startedAt: T0 - 1000 + i, entrypoint: 'claude-desktop', version: '2.1.309-secret', ...over,
  }
}

/** An app record with every field the deck reads, and some it doesn't. A field set to undefined is left out. */
function record(i, over = {}) {
  return {
    sessionId: `local_secret-${i}`, cliSessionId: `cli-secret-${i}`, title: `Secret record ${i}`, model: 'claude-haiku-5-5', effort: 'low',
    permissionMode: 'default', lastFocusedAt: T0 + i, lastAssistantUuid: `uuid-secret-${i}`, postTurnSummaryFor: `uuid-secret-${i}`,
    postTurnSummary: { status_category: 'completed', status_detail: 'Secret detail', needs_action: 'Secret action' },
    turnWrapUp: { description: 'Secret wrap-up' }, ...over,
  }
}

/** The strings check 4 looks for, as app 4.4212.0's bundle has them. A test blanks one to take it out. */
const PARTS = Object.freeze({
  continueUrl: 'url:"claude://code/continue?session=last&source=desktop_action"',
  continueRoute: 'let e=a.pathname==="/continue"?"code_continue":"code_needs_input",n=a.searchParams.get("session")',
  needsInputUrl: 'url:"claude://code/needs-input?source=desktop_action"',
  needsInputRoute: 'a.pathname==="/needs-input"',
  hostPattern: 'var lmr=/^local_[A-Za-z0-9-]{1,64}$/;',
  modeServer: 'xJi="ccd_session_mgmt"',
  modeTool: 'CJi="set_session_permission_mode"',
})
const asarWith = (over = {}) => Buffer.concat([Buffer.alloc(2048, 0), Buffer.from(Object.values({ ...PARTS, ...over }).join('\n')), Buffer.alloc(2048, 0)])

function plist(version) {
  const v = version === null ? '' : `\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>
\t<string>com.anthropic.claudefordesktop</string>
${v}</dict>
</plist>
`
}

/** What the stand-in binary prints and exits with, for `plugin validate` and `plugin test`. */
const VALIDATE_OK = {
  code: 0,
  lines: [
    '  ❯ ./register.ts hooks: session.start, turn.complete, tool.call',
    '  ❯ ./register.ts calls: $.http.fetch (via adapter), $.mcp.call (via adapter)',
    '✘ Found 2 problems the plugin directory refuses a submission for:',
    '✔ Validation passed',
  ],
}
const VALIDATE_NO_HOOKS = { code: 0, lines: ['✔ Validation passed'] }
const VALIDATE_FAIL = {
  code: 1,
  lines: ['✘ Found 1 error:', '  ❯ modules../register.ts: broken: "session.bogus" is not an event', '✘ Validation failed'],
}
const TEST_OK = { code: 0, lines: ['(pass) one [1.00ms]', '(pass) two [1.00ms]', '', ' 2 pass', ' 0 fail', 'Ran 2 tests across 1 file. [0.10s]'] }
const TEST_NO_SUMMARY = { code: 0, lines: ['done'] }
const TEST_NONE = { code: 0, lines: [' 0 pass', ' 0 fail', 'Ran 0 tests across 0 files. [0.01s]'] }
const TEST_FAIL = {
  code: 1,
  lines: ['(pass) one [1.00ms]', '(fail) a mode command calls the app\'s own tool [2.00ms]', '  AssertionError: expect(received).toEqual()', ' 1 pass', ' 1 fail', 'Ran 2 tests across 1 file. [0.10s]'],
}

const sh = (lines) => lines.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join('\n')

/**
 * A stand-in for Claude Code's binary at `<root>/<version>/<hash>/claude.app/Contents/MacOS/claude`. It says what it was
 * given, refuses to go on with what it mustn't get (DECK_TOKEN, the real HOME, a config folder that isn't fresh, no
 * plugin), then answers as told. `sleep` makes validate hang, for the timeout.
 */
function fakeClaude(f, version, { validate = VALIDATE_OK, test: tests = TEST_OK, sleep = false, hash = 'abc123def456' } = {}) {
  const bin = path.join(f.claudeCodeRoot, version, hash, 'claude.app', 'Contents', 'MacOS', 'claude')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh
echo "args: $1 $2"
echo "plugin: $3"
echo "home: $HOME"
echo "config: $CLAUDE_CONFIG_DIR"
echo "tmpdir: $TMPDIR"
echo "cwd: $(pwd -P)"
echo "marker: $(cat "$3/.claude-plugin/marker" 2>/dev/null)"
if [ -n "$DECK_TOKEN" ]; then echo "error: DECK_TOKEN reached the binary"; exit 9; fi
if [ "$HOME" = ${JSON.stringify(os.homedir())} ]; then echo "error: the real HOME reached the binary"; exit 9; fi
if [ ! -f "$3/.claude-plugin/plugin.json" ]; then echo "error: no plugin at $3"; exit 8; fi
if [ -n "$(ls -A "$CLAUDE_CONFIG_DIR")" ]; then echo "error: CLAUDE_CONFIG_DIR isn't fresh"; exit 7; fi
case "$2" in
validate)
${sleep ? 'sleep 30 &\nwait' : ''}
${sh(validate.lines)}
exit ${validate.code};;
test)
${sh(tests.lines)}
exit ${tests.code};;
esac
echo "error: unexpected arguments"; exit 2
`, { mode: 0o755 })
  return bin
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=recheck test', '-c', 'user.email=recheck@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}

/** A git repository whose HEAD holds claude-code/plugin with `marker` in it; the working tree's marker can differ. */
function pluginRepo(f, { marker = 'head', worktreeMarker, plugin = true } = {}) {
  const repo = path.join(f.root, 'repo')
  const dir = path.join(repo, plugin ? 'claude-code/plugin' : 'claude-code/other')
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.1' }))
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marker'), marker)
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {}, modules: ['./register.ts'] }))
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fixture')
  if (worktreeMarker !== undefined) fs.writeFileSync(path.join(dir, '.claude-plugin', 'marker'), worktreeMarker)
  return repo
}

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
const writeSession = (f, i, value) => writeJson(path.join(f.sessions, `${100 + i}.json`), value)
const writeRecord = (f, i, value, dir = f.orgDir) => {
  fs.mkdirSync(dir, { recursive: true })
  writeJson(path.join(dir, `local_secret-${i}.json`), value)
}

/**
 * A temp root with `sessions` entries in a registry (each with a .key file beside it, holding registry JSON of its
 * own that would change the counts if it were read), their records, a bundle with every string, an Info.plist and a
 * Claude Code root with the stand-in binary for `cc`. Removed after the test.
 */
function fixture(t, { sessions = 3, version = '4.4212.0', cc = ['2.1.309'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const f = {
    root,
    sessions: path.join(root, 'sessions'),
    records: path.join(root, 'records'),
    orgDir: path.join(root, 'records', 'acct-1', 'org-1'),
    asar: path.join(root, 'app.asar'),
    infoPlist: path.join(root, 'Info.plist'),
    claudeCodeRoot: path.join(root, 'cc'),
    tmp: path.join(root, 'tmp'),
  }
  for (const d of [f.sessions, f.orgDir, f.claudeCodeRoot, f.tmp]) fs.mkdirSync(d, { recursive: true })
  for (let i = 1; i <= sessions; i++) {
    writeSession(f, i, session(i))
    writeJson(path.join(f.sessions, `${100 + i}.0a1b2c3d.key`), session(i, { hostSessionId: 'local_secret-from-key', status: 'secret-from-key', name: undefined }))
    writeRecord(f, i, record(i))
  }
  fs.writeFileSync(f.asar, asarWith())
  fs.writeFileSync(f.infoPlist, plist(version))
  for (const v of cc) fakeClaude(f, v)
  return f
}

const paths = (f) => ({ sessions: f.sessions, records: f.records, asar: f.asar, infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot })
const flags = (f) => ['--sessions', f.sessions, '--records', f.records, '--asar', f.asar, '--info-plist', f.infoPlist, '--claude-code-root', f.claudeCodeRoot]
const byId = (rows, id) => rows.find((r) => r.id === id) ?? assert.fail(`no row ${id} in ${rows.map((r) => r.id).join(', ')}`)
const statuses = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.status]))
const tailOf = (row) => row.details.tail.join('\n')

/** Runs recheck.mjs to its end: `{code, out, err}`. A run that outlasts `timeoutMs` is killed and fails the test. */
function cli(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`recheck didn't finish within ${timeoutMs} ms (did it open a pipe?): ${out}${err}`))
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

// ---- 1. versions

test('recheck: versions are ok with 2.1.309 alone, warn when a newer Claude Code is bundled, and fail with none or no app version', async (t) => {
  const f = fixture(t)
  let rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot })
  assert.deepEqual(statuses(rows), { 'versions.app': 'ok', 'versions.claude-code': 'ok' })
  assert.equal(byId(rows, 'versions.app').reason, "Claude.app 4.4212.0, the version the Log's findings were made on")
  assert.match(byId(rows, 'versions.claude-code').reason, /^2\.1\.309, the only one: /)

  // Another app version is still ok: the checks below say what holds. A binary plist reads the same.
  fs.writeFileSync(f.infoPlist, plist('4.5000.1'))
  execFileSync('plutil', ['-convert', 'binary1', f.infoPlist])
  assert.equal(fs.readFileSync(f.infoPlist).subarray(0, 6).toString('latin1'), 'bplist')
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot })
  assert.equal(byId(rows, 'versions.app').status, 'ok')
  assert.match(byId(rows, 'versions.app').reason, /^Claude\.app 4\.5000\.1; the Log's findings were made on 4\.4212\.0/)

  // Newest by number: 2.1.400 beats 2.1.309, and 2.1.40 is older than both.
  fakeClaude(f, '2.1.400')
  fs.mkdirSync(path.join(f.claudeCodeRoot, '2.1.40'))
  fs.mkdirSync(path.join(f.claudeCodeRoot, 'not-a-version'))
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot })
  const cc = byId(rows, 'versions.claude-code')
  assert.equal(cc.status, 'warn')
  assert.match(cc.reason, /^2\.1\.400, the newest of 2\.1\.40, 2\.1\.309, 2\.1\.400; the vendored mods API \(claude-code\/vendor\/mods-api-2\.1\.309\/\)/)
  assert.deepEqual(cc.details.versions, ['2.1.40', '2.1.309', '2.1.400'])
  assert.equal(cc.details.binary, path.join(f.claudeCodeRoot, '2.1.400', 'abc123def456', 'claude.app', 'Contents', 'MacOS', 'claude'))

  // Fails: no Info.plist, one without the version, no version folder, no root.
  fs.rmSync(f.infoPlist)
  fs.rmSync(f.claudeCodeRoot, { recursive: true })
  fs.mkdirSync(f.claudeCodeRoot)
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot })
  assert.deepEqual(statuses(rows), { 'versions.app': 'fail', 'versions.claude-code': 'fail' })
  assert.match(byId(rows, 'versions.app').reason, /^can't read .*Info\.plist: ENOENT$/)
  assert.match(byId(rows, 'versions.claude-code').reason, /^no version folder in /)
  fs.writeFileSync(f.infoPlist, plist(null))
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: path.join(f.root, 'nowhere') })
  assert.match(byId(rows, 'versions.app').reason, /^no CFBundleShortVersionString in /)
  assert.match(byId(rows, 'versions.claude-code').reason, /^can't list .*nowhere: ENOENT$/)
})

test('recheck: versions sort by number, not by text', () => {
  assert.deepEqual(['2.10.0', '2.1.309', '2.1.40', '2.1.312', '10.0.0'].sort(R.compareVersions), ['2.1.40', '2.1.309', '2.1.312', '2.10.0', '10.0.0'])
})

// ---- 2. the registry

test('recheck: the registry is ok when every entry has every field the deck reads, with its type, and counts the known statuses', async (t) => {
  const f = fixture(t)
  writeSession(f, 2, session(2, { status: 'busy' }))
  writeSession(f, 3, session(3, { status: 'waiting' }))
  const { rows, hosts } = await R.checkRegistry(f.sessions)
  assert.deepEqual(rows.map((r) => r.id), ['registry', ...R.REGISTRY_FIELDS.map((s) => `registry.${s.field}`)])
  assert.deepEqual(rows.filter((r) => r.status !== 'ok'), [])
  assert.match(byId(rows, 'registry').reason, /^3 entries in /)
  assert.equal(byId(rows, 'registry.status').reason, '3/3 string: idle 1, busy 1, waiting 1')
  assert.deepEqual(byId(rows, 'registry.status').details.values, { idle: 1, busy: 1, waiting: 1 })
  assert.equal(byId(rows, 'registry.hostSessionId').reason, '3/3 local_ id')
  assert.equal(byId(rows, 'registry.startedAt').reason, '3/3 number')
  assert.deepEqual(hosts.sort(), ['local_secret-1', 'local_secret-2', 'local_secret-3'])
})

test('recheck: a registry field missing from some entries, of another type, or with a status the deck doesn\'t know, warns', async (t) => {
  const f = fixture(t)
  writeSession(f, 1, session(1, { name: undefined, statusUpdatedAt: '1793600000001' }))
  writeSession(f, 2, session(2, { status: 'stalled', hostSessionId: 'session_0123' }))
  writeSession(f, 3, session(3, { cwd: null }))
  const { rows, hosts } = await R.checkRegistry(f.sessions)
  assert.deepEqual(statuses(rows), {
    registry: 'ok',
    'registry.hostSessionId': 'warn',
    'registry.status': 'warn',
    'registry.statusUpdatedAt': 'warn',
    'registry.name': 'warn',
    'registry.sessionId': 'ok',
    'registry.cwd': 'warn',
    'registry.startedAt': 'ok',
  })
  assert.match(byId(rows, 'registry.name').reason, /^2\/3 string; 1 missing\. It's the session's title/)
  assert.match(byId(rows, 'registry.statusUpdatedAt').reason, /^2\/3 number; 1 string\. /)
  assert.match(byId(rows, 'registry.status').reason, /^2\/3 string: idle 2; 1 other status\. /)
  assert.match(byId(rows, 'registry.hostSessionId').reason, /^2\/3 local_ id; 1 other string\. /)
  assert.match(byId(rows, 'registry.cwd').reason, /^2\/3 string; 1 null\. /)
  assert.deepEqual(byId(rows, 'registry.statusUpdatedAt').details.problems, { string: 1 })
  assert.deepEqual(hosts.sort(), ['local_secret-1', 'local_secret-3'], 'only hosts the deck takes')
})

test('recheck: a needed registry field missing from every entry fails; one the deck can do without only warns', async (t) => {
  const f = fixture(t)
  for (const i of [1, 2, 3]) writeSession(f, i, session(i, { hostSessionId: undefined, status: 7, startedAt: undefined }))
  const { rows, hosts } = await R.checkRegistry(f.sessions)
  assert.equal(byId(rows, 'registry.hostSessionId').status, 'fail')
  assert.match(byId(rows, 'registry.hostSessionId').reason, /^0\/3 local_ id; 3 missing\. The deck keys each session by it/)
  assert.equal(byId(rows, 'registry.status').status, 'fail')
  assert.match(byId(rows, 'registry.status').reason, /^0\/3 string; 3 number\. /)
  assert.equal(byId(rows, 'registry.startedAt').status, 'warn')
  assert.match(byId(rows, 'registry.startedAt').reason, /^0\/3 number; 3 missing\. It orders the Sessions dial/)
  assert.deepEqual(hosts, [])
})

test('recheck: a registry folder that can\'t be listed fails, an empty one warns, and entries that don\'t parse are counted', async (t) => {
  const f = fixture(t)
  let { rows } = await R.checkRegistry(path.join(f.root, 'nowhere'))
  assert.deepEqual(statuses(rows), { registry: 'fail' })
  assert.match(rows[0].reason, /^can't list .*nowhere: ENOENT$/)

  const empty = path.join(f.root, 'empty')
  fs.mkdirSync(empty)
  fs.writeFileSync(path.join(empty, '1.0a1b.key'), '{}')
  ;({ rows } = await R.checkRegistry(empty))
  assert.deepEqual(statuses(rows), { registry: 'warn' })
  assert.match(rows[0].reason, /^no entries in .*, so no fields to check/)

  // Half-written, an array, a dotfile and a folder: the first two count as not parsing, the others aren't entries.
  fs.writeFileSync(path.join(f.sessions, '104.json'), '{"name": "Secret half-written", "sta')
  fs.writeFileSync(path.join(f.sessions, '105.json'), '[]')
  fs.writeFileSync(path.join(f.sessions, '.106.json'), '{}')
  fs.mkdirSync(path.join(f.sessions, '107.json'))
  ;({ rows } = await R.checkRegistry(f.sessions))
  assert.equal(byId(rows, 'registry').status, 'warn')
  assert.match(byId(rows, 'registry').reason, /^3 entries in .*; 2 more didn't parse as a JSON object/)
  assert.equal(byId(rows, 'registry.hostSessionId').reason, '3/3 local_ id')

  for (const i of [1, 2, 3]) fs.writeFileSync(path.join(f.sessions, `${100 + i}.json`), 'not json')
  ;({ rows } = await R.checkRegistry(f.sessions))
  assert.deepEqual(statuses(rows), { registry: 'fail' })
  assert.match(rows[0].reason, /^none of 5 entries in .* is a JSON object$/)
})

// ---- 3. the records

test('recheck: the records are ok with every field the deck reads, sparse ones missing from some, and every running session\'s record found', async (t) => {
  const f = fixture(t)
  writeRecord(f, 2, record(2, { turnWrapUp: undefined, postTurnSummary: undefined, postTurnSummaryFor: undefined, lastFocusedAt: undefined, lastAssistantUuid: undefined }))
  writeRecord(f, 3, record(3, { turnWrapUp: { description: '', needsUser: 'Secret question' }, permissionMode: 'acceptEdits' }))
  // A record of a session that isn't running, in a second account/org folder.
  writeRecord(f, 9, record(9, { permissionMode: 'auto' }), path.join(f.records, 'acct-2', 'org-2'))
  // What the deck never opens: a dot folder, a file at the account level, other files beside the records.
  writeRecord(f, 8, record(8, { model: 7 }), path.join(f.records, '.hidden', 'org'))
  fs.writeFileSync(path.join(f.records, 'loose.json'), '{}')
  fs.writeFileSync(path.join(f.orgDir, 'index.idx'), 'x')
  fs.writeFileSync(path.join(f.orgDir, 'other.json'), '{"model": 7}')
  fs.mkdirSync(path.join(f.orgDir, 'local_secret-5'))

  const rows = await R.checkRecords(f.records, ['local_secret-1', 'local_secret-2', 'local_secret-3'])
  assert.deepEqual(rows.filter((r) => r.status !== 'ok'), [])
  assert.deepEqual(rows.map((r) => r.id), ['records', ...R.RECORD_FIELDS.map((s) => `records.${s.field}`), 'records.summary-for-last', 'records.lookup'])
  assert.match(byId(rows, 'records').reason, /^4 records in 2 account\/org folders of /)
  assert.equal(byId(rows, 'records.model').reason, '4/4 non-empty string')
  assert.equal(byId(rows, 'records.permissionMode').reason, '4/4 mode name: default 2, acceptEdits 1, auto 1')
  assert.equal(byId(rows, 'records.postTurnSummary').reason, '3/4 object with a string status_category; 1 without one')
  assert.equal(byId(rows, 'records.turnWrapUp').reason, '3/4 object with a string description; 1 without one')
  assert.equal(byId(rows, 'records.lastFocusedAt').reason, '3/4 number; 1 without one')
  assert.equal(byId(rows, 'records.summary-for-last').reason, '3/3 records with both have them equal')
  assert.equal(byId(rows, 'records.lookup').reason, "3/3 running sessions' records found by their hostSessionId")
})

test('recheck: record fields of another type, a mode the deck has no name for, odd file names or a summary for an older message warn', async (t) => {
  const f = fixture(t)
  writeRecord(f, 1, record(1, { turnWrapUp: { description: 5 }, postTurnSummaryFor: 'uuid-older' }))
  writeRecord(f, 2, record(2, { permissionMode: 'yolo', lastFocusedAt: 'yesterday', postTurnSummaryFor: 'uuid-older' }))
  writeRecord(f, 3, record(3, { title: '', postTurnSummary: { status_category: null }, postTurnSummaryFor: 'uuid-older' }))
  fs.writeFileSync(path.join(f.orgDir, 'local_secret!.json'), '{}')
  fs.writeFileSync(path.join(f.orgDir, 'local_secret-4.json'), '{"title": "Secret half-wri')

  const rows = await R.checkRecords(f.records, ['local_secret-1', 'local_secret-2', 'local_secret-3', 'local_secret-7'])
  assert.deepEqual(statuses(rows), {
    records: 'warn',
    'records.model': 'ok',
    'records.effort': 'ok',
    'records.permissionMode': 'warn',
    'records.postTurnSummary': 'warn',
    'records.postTurnSummaryFor': 'ok',
    'records.lastAssistantUuid': 'ok',
    'records.turnWrapUp': 'warn',
    'records.title': 'warn',
    'records.lastFocusedAt': 'warn',
    'records.summary-for-last': 'warn',
    'records.lookup': 'warn',
  })
  assert.match(byId(rows, 'records').reason, /^3 records in 1 account\/org folder of .*; 1 more didn't parse as a JSON object .*; 1 local_\*\.json whose id the deck's HOST_PATTERN refuses$/)
  assert.match(byId(rows, 'records.permissionMode').reason, /^2\/3 mode name: default 2; 1 mode the deck has no name for\. /)
  assert.match(byId(rows, 'records.turnWrapUp').reason, /^2\/3 object with a string description; 1 object without a string description\. /)
  assert.match(byId(rows, 'records.postTurnSummary').reason, /^2\/3 object with a string status_category; 1 object without a string status_category\. /)
  assert.match(byId(rows, 'records.title').reason, /^2\/3 non-empty string; 1 empty string\. /)
  assert.match(byId(rows, 'records.lastFocusedAt').reason, /^2\/3 number; 1 string\. /)
  assert.match(byId(rows, 'records.summary-for-last').reason, /^0\/3 records with both have them equal\. Status rule 6/)
  assert.match(byId(rows, 'records.lookup').reason, /^3\/4 running sessions' records found/)
})

test('recheck: a needed record field missing from every record fails, as do no records, no folder and no running session\'s record', async (t) => {
  const f = fixture(t)
  for (const i of [1, 2, 3]) writeRecord(f, i, record(i, { model: undefined, postTurnSummary: undefined, title: undefined, turnWrapUp: undefined }))
  let rows = await R.checkRecords(f.records, ['local_secret-8'])
  assert.equal(byId(rows, 'records.model').status, 'fail')
  assert.match(byId(rows, 'records.model').reason, /^0\/3 non-empty string; 3 missing\. The Sessions strip shows it/)
  assert.equal(byId(rows, 'records.postTurnSummary').status, 'fail', 'sparse, but needed: none at all fails')
  assert.match(byId(rows, 'records.postTurnSummary').reason, /^0\/3 object with a string status_category; 3 without one\. Status rule 6/)
  assert.equal(byId(rows, 'records.title').status, 'warn', 'the deck can do without the title')
  assert.equal(byId(rows, 'records.turnWrapUp').status, 'warn', 'nor can it confirm the wrap-up\'s shape')
  assert.equal(byId(rows, 'records.lookup').status, 'fail')
  assert.match(byId(rows, 'records.lookup').reason, /^0\/1 running sessions' records found by their hostSessionId\. The deck reads/)

  rows = await R.checkRecords(path.join(f.root, 'nowhere'), ['local_secret-1'])
  assert.deepEqual(statuses(rows), { records: 'fail' })
  assert.match(rows[0].reason, /^can't list .*nowhere: ENOENT$/)

  fs.rmSync(f.records, { recursive: true })
  fs.mkdirSync(f.orgDir, { recursive: true })
  fs.writeFileSync(path.join(f.orgDir, 'local_bad id.json'), '{}')
  rows = await R.checkRecords(f.records, ['local_secret-1'])
  assert.deepEqual(statuses(rows), { records: 'fail' })
  assert.match(rows[0].reason, /^no local_\*\.json record in 1 account\/org folder of .*; 1 local_\*\.json whose id the deck's HOST_PATTERN refuses$/)

  fs.writeFileSync(path.join(f.orgDir, 'local_secret-1.json'), '"a string"')
  rows = await R.checkRecords(f.records, ['local_secret-1'])
  assert.match(rows[0].reason, /^none of 1 record in 1 account\/org folder of .* is a JSON object/)
})

// ---- 4. the bundle

test('recheck: the bundle is ok with every string, warns when only a corroborating one or a looser pattern is left, and fails when a route or the tool is gone', async (t) => {
  const f = fixture(t)
  let rows = await R.checkBundle(f.asar)
  assert.deepEqual(statuses(rows), { bundle: 'ok', 'bundle.jump': 'ok', 'bundle.needs-input': 'ok', 'bundle.local-id': 'ok', 'bundle.mode-tool': 'ok' })
  assert.equal(byId(rows, 'bundle.jump').reason, 'claude://code/continue?session= ×1, "/continue" ×1')
  assert.equal(byId(rows, 'bundle.local-id').reason, '^local_[A-Za-z0-9-]{1,64}$ ×1')
  assert.match(byId(rows, 'bundle').reason, / 0\.0 MB$/)

  const cases = [
    [{ continueUrl: '' }, 'bundle.jump', 'warn', /^claude:\/\/code\/continue\?session= not found \(found: "\/continue" ×1\)\. The Sessions dial/],
    [{ continueRoute: '' }, 'bundle.jump', 'fail', /^"\/continue" not found \(found: claude:\/\/code\/continue\?session= ×1\)\. /],
    [{ needsInputUrl: '', needsInputRoute: '' }, 'bundle.needs-input', 'warn', /^code\/needs-input not found; "\/needs-input" not found\. S5 found it/],
    [{ hostPattern: 'var lmr=/^local_[A-Za-z0-9_-]{1,128}$/;' }, 'bundle.local-id', 'warn', /^\^local_\[A-Za-z0-9-\]\{1,64\}\$ not found, though \^local_ is \(×1\), so it changed\. The app's route/],
    [{ hostPattern: 'var lmr=/^session_[a-z]+$/;' }, 'bundle.local-id', 'fail', /^\^local_\[A-Za-z0-9-\]\{1,64\}\$ not found\. The app's route ignores/],
    [{ modeTool: 'CJi="set_session_mode"' }, 'bundle.mode-tool', 'fail', /^set_session_permission_mode not found \(found: ccd_session_mgmt ×1\)\. The Mode dial/],
    [{ modeServer: '' }, 'bundle.mode-tool', 'fail', /^ccd_session_mgmt not found/],
  ]
  for (const [over, id, status, reason] of cases) {
    fs.writeFileSync(f.asar, asarWith(over))
    rows = await R.checkBundle(f.asar)
    assert.equal(byId(rows, id).status, status, `${id} with ${JSON.stringify(over)}`)
    assert.match(byId(rows, id).reason, reason)
    for (const other of rows.filter((r) => r.id !== id)) assert.equal(other.status, 'ok', `${other.id} with ${JSON.stringify(over)}`)
  }

  rows = await R.checkBundle(path.join(f.root, 'nowhere.asar'))
  assert.deepEqual(statuses(rows), { bundle: 'fail' })
  assert.match(rows[0].reason, /^can't read .*nowhere\.asar: ENOENT$/)

  assert.equal(R.countHits(Buffer.from('aaaa'), 'aa'), 2, 'hits don\'t overlap')
  assert.equal(R.countHits(Buffer.from('xx"/continue"yy"/continue"'), '"/continue"'), 2)
})

// ---- 5. the mods API

test('recheck: check 5 runs the newest Claude Code\'s plugin validate and plugin test on HEAD\'s plugin: ok, warn and fail', async (t) => {
  const f = fixture(t, { cc: ['2.1.300', '2.1.309'] })
  const repo = pluginRepo(f)
  const run = () => R.checkModsApi({ claudeCodeRoot: f.claudeCodeRoot, repo, tmpRoot: f.tmp })

  let rows = await run()
  assert.deepEqual(statuses(rows), { 'mods.validate': 'ok', 'mods.test': 'ok' })
  assert.equal(byId(rows, 'mods.validate').reason, '2.1.309 passed on claude-code/plugin at HEAD: ./register.ts hooks 3 events and makes 2 $ calls')
  assert.deepEqual(byId(rows, 'mods.validate').details.modules, [{ module: './register.ts', hooks: ['session.start', 'turn.complete', 'tool.call'], calls: ['$.http.fetch', '$.mcp.call'] }])
  assert.equal(byId(rows, 'mods.test').reason, '2.1.309: 2 pass, 0 fail, across 1 file, on claude-code/plugin at HEAD')
  assert.match(tailOf(byId(rows, 'mods.validate')), /^args: plugin validate$/m)
  assert.match(tailOf(byId(rows, 'mods.test')), /^args: plugin test$/m)
  assert.match(tailOf(byId(rows, 'mods.test')), /^plugin: claude-code\/plugin$/m)
  assert.deepEqual(fs.readdirSync(f.tmp), [], 'the temp folder is gone')

  fakeClaude(f, '2.1.309', { validate: VALIDATE_NO_HOOKS, test: TEST_NO_SUMMARY })
  rows = await run()
  assert.deepEqual(statuses(rows), { 'mods.validate': 'warn', 'mods.test': 'warn' })
  assert.equal(byId(rows, 'mods.validate').reason, '2.1.309 passed, but listed no hooks for ./register.ts: did it read the mod?')
  assert.equal(byId(rows, 'mods.test').reason, '2.1.309 exited 0, but its output has no pass count')
  fakeClaude(f, '2.1.309', { test: TEST_NONE })
  assert.equal(byId(await run(), 'mods.test').reason, '2.1.309 exited 0, but no test ran')

  fakeClaude(f, '2.1.309', { validate: VALIDATE_FAIL, test: TEST_FAIL })
  rows = await run()
  assert.deepEqual(statuses(rows), { 'mods.validate': 'fail', 'mods.test': 'fail' })
  assert.equal(byId(rows, 'mods.validate').reason, '2.1.309 failed (exit 1): modules../register.ts: broken: "session.bogus" is not an event')
  assert.equal(byId(rows, 'mods.test').reason, "2.1.309 failed (exit 1): 1 of 2 failed; first: a mode command calls the app's own tool")
  assert.deepEqual(byId(rows, 'mods.test').details.failed, ["a mode command calls the app's own tool"])

  // A failure counted with exit 0 still fails, and a crash says what it printed.
  fakeClaude(f, '2.1.309', { test: { ...TEST_FAIL, code: 0 } })
  rows = await run()
  assert.equal(byId(rows, 'mods.test').status, 'fail')
  assert.equal(byId(rows, 'mods.test').reason, "2.1.309 failed (exit 0): 1 of 2 failed; first: a mode command calls the app's own tool")
  fakeClaude(f, '2.1.309', { test: { code: 3, lines: ['error: the test runner crashed'] } })
  rows = await run()
  assert.equal(byId(rows, 'mods.test').status, 'fail')
  assert.equal(byId(rows, 'mods.test').reason, '2.1.309 failed (exit 3): error: the test runner crashed')
  assert.deepEqual(fs.readdirSync(f.tmp), [])
})

test('recheck: check 5 gives Claude Code a fresh config, HOME and TMPDIR inside a temp folder it then removes, and copies the plugin from HEAD, not the working tree', async (t) => {
  const f = fixture(t)
  const repo = pluginRepo(f, { marker: 'head', worktreeMarker: 'worktree' })
  const rows = await R.checkModsApi({ claudeCodeRoot: f.claudeCodeRoot, repo, tmpRoot: f.tmp })
  assert.deepEqual(statuses(rows), { 'mods.validate': 'ok', 'mods.test': 'ok' })
  for (const what of ['validate', 'test']) {
    const tail = tailOf(byId(rows, `mods.${what}`))
    assert.match(tail, /^marker: head$/m, 'HEAD\'s copy, not the working tree\'s')
    // Each run has folders of its own, inside the one temp folder (shown as <tmp>); the binary refused any that weren't
    // fresh. Its working folder, printed as a physical path (/private/var/…), reads <tmp> too.
    assert.match(tail, new RegExp(`^config: <tmp>/${what}/config$`, 'm'))
    assert.match(tail, new RegExp(`^home: <tmp>/${what}/home$`, 'm'))
    assert.match(tail, new RegExp(`^tmpdir: <tmp>/${what}/tmp$`, 'm'))
    assert.match(tail, new RegExp(`^cwd: <tmp>/${what}$`, 'm'))
  }
  assert.deepEqual(fs.readdirSync(f.tmp), [])
  assert.equal(fs.readFileSync(path.join(repo, 'claude-code/plugin/.claude-plugin/marker'), 'utf8'), 'worktree', 'the working tree is untouched')
})

test('recheck: check 5 fails without a version, a binary, a plugin at HEAD or in time, and works on this repository\'s HEAD', async (t) => {
  const f = fixture(t, { cc: [] })
  const run = (over = {}) => R.checkModsApi({ claudeCodeRoot: f.claudeCodeRoot, repo: REPO, tmpRoot: f.tmp, ...over })
  let rows = await run()
  assert.deepEqual(statuses(rows), { mods: 'fail' })
  assert.match(rows[0].reason, /^no Claude Code version folder in /)
  rows = await run({ claudeCodeRoot: path.join(f.root, 'nowhere') })
  assert.match(rows[0].reason, /^can't list .*nowhere: ENOENT$/)

  fs.mkdirSync(path.join(f.claudeCodeRoot, '2.1.309', 'abc', 'claude.app', 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(f.claudeCodeRoot, '2.1.309', 'abc', 'claude.app', 'Contents', 'MacOS', 'claude'), 'not executable', { mode: 0o644 })
  rows = await run()
  assert.match(rows[0].reason, /^no claude binary at .*2\.1\.309\/\*\/claude\.app\/Contents\/MacOS\/claude$/)

  fakeClaude(f, '2.1.309')
  const other = pluginRepo(f, { plugin: false })
  rows = await run({ repo: other })
  assert.deepEqual(statuses(rows), { mods: 'fail' })
  assert.match(rows[0].reason, /^git archive HEAD claude-code\/plugin in .* failed: /)
  rows = await run({ repo: path.join(f.root, 'not-a-repo') })
  assert.match(rows[0].reason, /^git archive HEAD claude-code\/plugin in .* failed: /)
  assert.deepEqual(fs.readdirSync(f.tmp), [])

  // This repository's own HEAD, read only: the stand-in sees its plugin.json.
  rows = await run()
  assert.deepEqual(statuses(rows), { 'mods.validate': 'ok', 'mods.test': 'ok' })

  // A run past its time is killed with what it started (the stand-in's `sleep` holds the output open).
  fakeClaude(f, '2.1.309', { sleep: true })
  const started = Date.now()
  rows = await run({ timeoutMs: 300 })
  assert.ok(Date.now() - started < 10_000, 'the timeout didn\'t wait for the sleep')
  assert.equal(byId(rows, 'mods.validate').status, 'fail')
  assert.equal(byId(rows, 'mods.validate').reason, 'Claude Code 2.1.309 timed out after 0.3 s')
  assert.deepEqual(fs.readdirSync(f.tmp), [])
})

// ---- privacy

test('recheck: .key files are never opened, by the checks or by the command, and neither is a .json that isn\'t a file', async (t) => {
  const f = fixture(t)
  const calls = []
  const spy = Object.fromEntries(Object.entries(R.nodeFs).map(([name, fn]) => [name, (p, ...rest) => {
    calls.push([name, String(p)])
    return fn(p, ...rest)
  }]))
  const result = await R.recheck({ ...paths(f), skipPlugin: true, fs: spy })
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => c.status !== 'ok')))
  assert.ok(calls.some(([name, p]) => name === 'readFile' && p === path.join(f.sessions, '101.json')), 'the registry was read')
  assert.deepEqual(calls.filter(([, p]) => p.endsWith('.key')), [], 'no call on a .key file')
  assert.equal(byId(result.checks, 'registry.status').reason, '3/3 string: idle 3', 'the .key files\' own statuses were never counted')

  // The command, with every .key file a named pipe: opening one would block it for good. So would reading a pipe
  // named like an entry or a record.
  for (const name of fs.readdirSync(f.sessions).filter((n) => n.endsWith('.key'))) {
    fs.rmSync(path.join(f.sessions, name))
    execFileSync('mkfifo', [path.join(f.sessions, name)])
  }
  execFileSync('mkfifo', [path.join(f.sessions, '555.json')])
  execFileSync('mkfifo', [path.join(f.orgDir, 'local_secret-7.json')])
  const r = await cli([...flags(f), '--skip-plugin'], { env: { HOME: f.root }, timeoutMs: 20_000 })
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /^ok\s+registry\s+3 entries in /m)
})

test('recheck: no value from the registry or the records reaches the output, in the table or in JSON', async (t) => {
  const f = fixture(t)
  // Values the deck doesn't know, and files caught mid-write, whose parse errors would quote them: counted, never shown.
  writeSession(f, 3, session(3, { status: 'secret-status', hostSessionId: 'secret-host' }))
  writeRecord(f, 2, record(2, { permissionMode: 'secret-mode', model: '' }))
  fs.writeFileSync(path.join(f.sessions, '104.json'), '{"name": "Secret half-written", "status": ')
  fs.writeFileSync(path.join(f.orgDir, 'local_secret-8.json'), '{"title": "Secret half-written')
  for (const extra of [[], ['--json']]) {
    const r = await cli([...flags(f), '--skip-plugin', ...extra], { env: { HOME: f.root } })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /registry\.status/)
    assert.doesNotMatch(r.out + r.err, /secret/i)
  }
})

// ---- the command

test('recheck: the command prints a table or JSON, exits 0 when nothing fails and 1 when something does, and 2 for a usage error', async (t) => {
  const f = fixture(t)
  let r = await cli([...flags(f), '--skip-plugin'], { env: { HOME: f.root } })
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /^STATUS\s+CHECK\s+REASON\n/)
  assert.match(r.out, /^ok\s+bundled Claude Code\s+2\.1\.309, the only one/m)
  assert.match(r.out, /^ok\s+registry\.hostSessionId\s+3\/3 local_ id$/m)
  assert.match(r.out, /^ok\s+records: found by host\s+3\/3 running sessions' records found/m)
  assert.match(r.out, /^ok\s+bundle: jump route\s+/m)
  assert.doesNotMatch(r.out, /mods API:/)
  assert.match(r.out, /\n\n27 ok, 0 warn, 0 fail; the mods API check skipped \(--skip-plugin\)\n$/)

  r = await cli([...flags(f), '--skip-plugin', '--json'], { env: { HOME: f.root } })
  assert.equal(r.code, 0)
  const j = JSON.parse(r.out)
  assert.equal(j.ok, true)
  assert.deepEqual(j.summary, { ok: 27, warn: 0, fail: 0 })
  assert.deepEqual(j.skipped, ['mods'])
  assert.equal(j.paths.sessions, '~/sessions', 'paths under HOME read ~')
  assert.deepEqual([...new Set(j.checks.map((c) => c.group))], ['versions', 'registry', 'records', 'bundle'])
  for (const c of j.checks) assert.deepEqual(Object.keys(c).slice(0, 5), ['group', 'id', 'name', 'status', 'reason'])
  assert.equal(byId(j.checks, 'registry.hostSessionId').details.source, `claude-code/deck/src/registry/registry.ts:${lineOf('claude-code/deck/src/registry/registry.ts', 'str(o.hostSessionId)')}`)
  assert.equal(byId(j.checks, 'records.turnWrapUp').details.source, `claude-code/deck/src/records/records.ts:${lineOf('claude-code/deck/src/records/records.ts', 'wrapUp(o.turnWrapUp)')}`)
  assert.deepEqual(byId(j.checks, 'bundle.jump').details.needles[0].sources, [
    `claude-code/deck/src/plugin.ts:${lineOf('claude-code/deck/src/plugin.ts', 'claude://code/continue?session=')}`,
    `docs/claude-code/plan.md:${lineOf('docs/claude-code/plan.md', 'Jump route: `claude://code/continue?session=<local_id>`')}`,
  ])

  // One check failing makes the run fail.
  for (const i of [1, 2, 3]) writeSession(f, i, session(i, { hostSessionId: undefined }))
  r = await cli([...flags(f), '--skip-plugin'], { env: { HOME: f.root } })
  assert.equal(r.code, 1)
  assert.match(r.out, /^fail\s+registry\.hostSessionId\s+0\/3 local_ id; 3 missing\. /m)
  assert.doesNotMatch(r.out, /records: found by host/, 'no hosts, nothing to look up')

  r = await cli(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /^usage: node claude-code\/tools\/recheck\.mjs \[options\]/)
  for (const bad of [['--bogus'], ['extra'], ['--sessions', ''], ['--json=yes']]) {
    r = await cli(bad)
    assert.equal(r.code, 2, `${bad.join(' ')}: ${r.out}${r.err}`)
    assert.match(r.err, /^recheck: /)
  }
})

test('recheck: the command runs check 5 too, keeps DECK_TOKEN from Claude Code and from the output, and leaves no temp folder', async (t) => {
  const f = fixture(t)
  const repo = pluginRepo(f, { marker: 'head', worktreeMarker: 'worktree' })
  const token = 'deck-token-sentinel-0123456789abcdef0123456789abcdef'
  let r = await cli([...flags(f), '--repo', repo, '--json'], { env: { HOME: f.root, TMPDIR: f.tmp, DECK_TOKEN: token } })
  assert.equal(r.code, 0, r.out + r.err)
  const j = JSON.parse(r.out)
  assert.deepEqual(j.skipped, [])
  assert.deepEqual(statuses(j.checks.filter((c) => c.group === 'mods')), { 'mods.validate': 'ok', 'mods.test': 'ok' })
  assert.match(tailOf(byId(j.checks, 'mods.test')), /^marker: head$/m)
  assert.doesNotMatch(r.out + r.err, new RegExp(token.slice(0, 16)))
  assert.deepEqual(fs.readdirSync(f.tmp), [])

  fakeClaude(f, '2.1.309', { test: TEST_FAIL })
  r = await cli([...flags(f), '--repo', repo], { env: { HOME: f.root, TMPDIR: f.tmp } })
  assert.equal(r.code, 1)
  assert.match(r.out, /^fail\s+mods API: plugin test\s+2\.1\.309 failed \(exit 1\): 1 of 2 failed/m)
  assert.match(r.out, /\n28 ok, 0 warn, 1 fail\n$/)
  assert.deepEqual(fs.readdirSync(f.tmp), [])
})

// ---- drift: what recheck looks for is what the deck and the mod use

function lineOf(file, fragment) {
  const i = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').findIndex((l) => l.includes(fragment))
  assert.notEqual(i, -1, `${fragment} isn't in ${file}`)
  return i + 1
}

test('recheck: its field lists and strings are the deck\'s and the mod\'s own, so a change to how they read the app shows here', () => {
  const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8')
  const fieldsRead = (src) => [...new Set([...src.matchAll(/\bo\.(\w+)/g)].map((m) => m[1]))].sort()

  // Every field parseSession and parseRecord/turnCategory read, and no other.
  assert.deepEqual(fieldsRead(read('claude-code/deck/src/registry/registry.ts')), R.REGISTRY_FIELDS.map((s) => s.field).sort())
  const records = read('claude-code/deck/src/records/records.ts')
  assert.deepEqual(fieldsRead(records), R.RECORD_FIELDS.map((s) => s.field).sort())
  for (const inner of ['v.description', 'v.needsUser', 'summary.status_category']) assert.ok(records.includes(inner), inner)
  for (const spec of [...R.REGISTRY_FIELDS, ...R.RECORD_FIELDS]) assert.match(R.cite(spec.reads), /:\d+$/, `${spec.field}: "${spec.reads[1]}" isn't in ${spec.reads[0]}`)
  for (const n of R.BUNDLE_CHECKS.flatMap((c) => c.needles)) {
    for (const s of n.sources) assert.match(R.cite(s), /:\d+$/, `${n.text}: "${s[1]}" isn't in ${s[0]}`)
  }
  assert.ok(read('claude-code/deck/src/registry/registry.ts').includes('return name.endsWith(".json") && !name.startsWith(".");'), 'isSessionFile')

  // The id pattern, the jump route, the mode tool, the mode names and the statuses.
  const wire = read('claude-code/deck/src/protocol/wire.ts')
  assert.equal(/export const HOST_PATTERN = \/(.+)\/;/.exec(wire)?.[1], R.HOST_PATTERN.source)
  assert.equal(byId(R.BUNDLE_CHECKS, 'local-id').needles[0].text, R.HOST_PATTERN.source)
  const modeTool = /export const MODE_TOOL = "([^"]+)";/.exec(wire)?.[1]
  assert.equal(modeTool, 'mcp__ccd_session_mgmt__set_session_permission_mode')
  for (const n of byId(R.BUNDLE_CHECKS, 'mode-tool').needles) assert.ok(modeTool.includes(n.text), n.text)
  assert.ok(read('claude-code/deck/src/plugin.ts').includes('`claude://code/continue?session=${encodeURIComponent(host)}`'))
  assert.equal(byId(R.BUNDLE_CHECKS, 'jump').needles[0].text, 'claude://code/continue?session=')
  const modeNames = /const MODE_NAMES: Record<string, string> = \{([^}]*)\}/.exec(read('claude-code/deck/src/model/format.ts'))?.[1] ?? ''
  assert.deepEqual([...modeNames.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]), [...R.MODE_NAMES])
  const status = read('claude-code/deck/src/model/status.ts')
  for (const s of R.REGISTRY_STATUSES) assert.ok(status.includes(`i.registry === "${s}"`), s)

  // The mod's call, as committed (check 5 runs HEAD's plugin).
  const register = execFileSync('git', ['-C', REPO, 'show', 'HEAD:claude-code/plugin/hooks/register.ts'], { encoding: 'utf8' })
  assert.match(register, /\$\.mcp\.call\('ccd_session_mgmt', 'set_session_permission_mode', \{ session_id: 'self', mode \}\)/)
})
