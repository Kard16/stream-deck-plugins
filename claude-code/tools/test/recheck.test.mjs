// recheck.mjs against fixtures each test makes in a temp folder: a fake registry with .key files beside it, fake
// records, a small file standing in for app.asar, an Info.plist, a Claude Code root whose binary is a shell script
// with a small Bun file table after it, a vendored mods API made from that table, a stand-in for lsappinfo, and a git
// repository holding a plugin. Nothing here reads the real ~/.claude/, the app's folders, the app bundle or the
// bundled binaries, and nothing runs the real lsappinfo. What it reads of this repository: the deck's and the mod's
// sources and the plugin's type-check files, for the drift test and the JSON's citations, and HEAD's claude-code/plugin
// for one run of check 5 with the default repository, all read only.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as F from '../../vendor/refresh.mjs'
import { SUMMARY_FIELDS, validSummary } from '../lib/registry.mjs'
import * as R from '../recheck.mjs'
import { bunSection, modsApiFiles } from './bun-table.mjs'

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
    turnWrapUp: { description: 'Secret wrap-up' }, isArchived: false, lastActivityAt: T0 + 10 + i, cwd: `/Users/someone/secret-${i}`, ...over,
  }
}

/** The strings check 4 looks for, as app 4.4212.0's bundle has them, in its order. A test blanks one to take it out. */
const PARTS = Object.freeze({
  continueUrl: 'url:"claude://code/continue?session=last&source=desktop_action"',
  continueRoute: 'let e=a.pathname==="/continue"?"code_continue":"code_needs_input",n=a.searchParams.get("session")',
  needsInputUrl: 'url:"claude://code/needs-input?source=desktop_action"',
  needsInputRoute: 'a.pathname==="/needs-input"',
  hostPattern: 'var lmr=/^local_[A-Za-z0-9-]{1,64}$/;',
  summaryFields: 'var wM=["title","description","status_category","status_detail","recent_action","needs_action","summarizes_uuid"];',
  // The record loader's OM, just after the list it walks: 523 bytes after it in 4.4212.0.
  noteworthy: 'if(t.is_noteworthy!==void 0){if(typeof t.is_noteworthy!="boolean")return;n.is_noteworthy=t.is_noteworthy}',
  // The app's other summary validator, 14 MB on in 4.4212.0: the same check, which isn't the loader's.
  otherValidator: `${' '.repeat(16_384)}e.needs_action!==void 0&&typeof e.needs_action!="string"||e.is_noteworthy!==void 0&&typeof e.is_noteworthy!="boolean"||e.summarizes_uuid!==void 0&&typeof e.summarizes_uuid!="string")`,
  // App 4.23118.0's session environment: its entrypoint, and its host id.
  desktopEntrypoint: 'var ILa=["claude-desktop","claude-desktop-3p"];function LLa(e){return e==="3p"?"claude-desktop-3p":"claude-desktop"}',
  desktopHost: 'return d.CLAUDE_CODE_HOST_SESSION_ID=n,delete d[m.s],{env:d,secrets:f}',
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
    '  ❯ ./register.ts calls: $.http.fetch (via adapter), $.prompt.submit (via adapter)',
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
  lines: ['(pass) one [1.00ms]', '(fail) a prompt is submitted as the user\'s words [2.00ms]', '  AssertionError: expect(received).toEqual()', ' 1 pass', ' 1 fail', 'Ran 2 tests across 1 file. [0.10s]'],
}

const sh = (lines) => lines.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join('\n')

/** The engine's JS check 6 looks for, as 2.1.317's has it, each in a file of its own. A test blanks or changes one. */
const ENGINE_JS = Object.freeze({
  registry: 'function LEe(h){let x=Bqo(h);if(x!==void 0)return{status:"waiting",waitingFor:x,working:!1};return{status:h.isLoading||h.delegatedActive?"busy":"idle",waitingFor:void 0,working:h.isQueryActive}}',
  desktop: 'var Stn=new Set(["claude-desktop","claude-desktop-3p"]);function eHe(){let e=cp();return e!==void 0&&Stn.has(e)&&!n().childSession}function p$(){return eHe()&&!_P()}',
  children: 'function Qot(e){let n={CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:e.sessionId,CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_PID:String(process.pid)};return n}',
  shell: 'Qxr(e,["-c","-l",Z],{env:{...Wo(),SHELL:e,GIT_EDITOR:"true",CLAUDECODE:"1"}})',
})

/** The fake binary's file table: the mods API's files, then ENGINE_JS's files, `js` over them, and `files` besides. */
function engineFiles({ js = {}, dts, mods = {}, files: more = {} } = {}) {
  const files = modsApiFiles({ dts, ...mods })
  for (const [part, text] of Object.entries({ ...ENGINE_JS, ...js })) if (text !== null) files[`chunk-${part}.js`] = text
  return Object.assign(files, more)
}

/**
 * A stand-in for Claude Code's binary at `<root>/<version>/<hash>/claude.app/Contents/MacOS/claude`. It says what it was
 * given, refuses to go on with what it mustn't get (DECK_TOKEN, the real HOME, a config folder that isn't fresh, no
 * plugin), then answers as told. `sleep` makes validate hang, for the timeout. After its last line comes a Bun file
 * table of `table` (engineFiles()), laid out with `tableOpts` (bun-table.mjs), which the shell never reads, or nothing
 * when `table` is null.
 */
function fakeClaude(f, version, { validate = VALIDATE_OK, test: tests = TEST_OK, sleep = false, hash = 'abc123def456', table = engineFiles(), tableOpts = {} } = {}) {
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
  if (table !== null) fs.appendFileSync(bin, bunSection(table, tableOpts))
  return bin
}

/** A stand-in for lsappinfo: `front` prints `front`, `info -only bundleid <that ASN>` prints `info`; `code` is how both exit. */
function fakeLsappinfo(f, { front = 'ASN:0x0-0x2002:', info = '"CFBundleIdentifier"="com.apple.loginwindow"', code = 0, sleep = false } = {}) {
  fs.writeFileSync(f.lsappinfo, `#!/bin/sh
${sleep ? 'exec sleep 30' : ''}
case "$1" in
front) printf '%s\\n' ${JSON.stringify(front)}; exit ${code};;
info) if [ "$2 $3 $4" = ${JSON.stringify(`-only bundleid ${front.trim()}`)} ]; then printf '%s\\n' ${JSON.stringify(info)}; exit ${code}; fi;;
esac
echo "error: unexpected arguments: $*"; exit 2
`, { mode: 0o755 })
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
    vendoredDir: path.join(root, 'mods-api'),
    vendored: path.join(root, 'mods-api', 'claude-code.d.ts'),
    lsappinfo: path.join(root, 'lsappinfo'),
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
  writeVendored(f, '2.1.309')
  fakeLsappinfo(f)
  return f
}

/** claude-code/vendor/mods-api/ as refresh.mjs makes it for `version` from the default fake binary's table. */
function writeVendored(f, version) {
  fs.rmSync(f.vendoredDir, { recursive: true, force: true })
  const section = bunSection(engineFiles())
  for (const [rel, text] of Object.entries(F.modsApi(F.readFileTable(section, { offset: 0, size: section.length }), version))) {
    fs.mkdirSync(path.dirname(path.join(f.vendoredDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(f.vendoredDir, rel), text)
  }
}

const paths = (f) => ({ sessions: f.sessions, records: f.records, asar: f.asar, infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot, vendored: f.vendored, lsappinfo: f.lsappinfo })
const flags = (f) => ['--sessions', f.sessions, '--records', f.records, '--asar', f.asar, '--info-plist', f.infoPlist, '--claude-code-root', f.claudeCodeRoot, '--vendored', f.vendored, '--lsappinfo', f.lsappinfo]
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
  let rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot, checkedVersion: '2.1.309' })
  assert.deepEqual(statuses(rows), { 'versions.app': 'ok', 'versions.claude-code': 'ok' })
  assert.equal(byId(rows, 'versions.app').reason, "Claude.app 4.4212.0, the version the Log's findings were made on")
  assert.match(byId(rows, 'versions.claude-code').reason, /^2\.1\.309, the only one: /)

  // Another app version is still ok: the checks below say what holds. A binary plist reads the same.
  fs.writeFileSync(f.infoPlist, plist('4.5000.1'))
  execFileSync('plutil', ['-convert', 'binary1', f.infoPlist])
  assert.equal(fs.readFileSync(f.infoPlist).subarray(0, 6).toString('latin1'), 'bplist')
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot, checkedVersion: '2.1.309' })
  assert.equal(byId(rows, 'versions.app').status, 'ok')
  assert.match(byId(rows, 'versions.app').reason, /^Claude\.app 4\.5000\.1; the Log's findings were made on 4\.4212\.0/)

  // Newest by number: 2.1.400 beats 2.1.309, and 2.1.40 is older than both.
  fakeClaude(f, '2.1.400')
  fs.mkdirSync(path.join(f.claudeCodeRoot, '2.1.40'))
  fs.mkdirSync(path.join(f.claudeCodeRoot, 'not-a-version'))
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot, checkedVersion: '2.1.309' })
  const cc = byId(rows, 'versions.claude-code')
  assert.equal(cc.status, 'warn')
  assert.match(cc.reason, /^2\.1\.400, the newest of 2\.1\.40, 2\.1\.309, 2\.1\.400; the vendored mods API \(claude-code\/vendor\/mods-api\/\) and these checks are for 2\.1\.309: run claude-code\/vendor\/refresh\.mjs/)
  assert.deepEqual(cc.details.versions, ['2.1.40', '2.1.309', '2.1.400'])
  assert.equal(cc.details.binary, path.join(f.claudeCodeRoot, '2.1.400', 'abc123def456', 'claude.app', 'Contents', 'MacOS', 'claude'))

  // Fails: no Info.plist, one without the version, no version folder, no root.
  fs.rmSync(f.infoPlist)
  fs.rmSync(f.claudeCodeRoot, { recursive: true })
  fs.mkdirSync(f.claudeCodeRoot)
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot, checkedVersion: '2.1.309' })
  assert.deepEqual(statuses(rows), { 'versions.app': 'fail', 'versions.claude-code': 'fail' })
  assert.match(byId(rows, 'versions.app').reason, /^can't read .*Info\.plist: ENOENT$/)
  assert.match(byId(rows, 'versions.claude-code').reason, /^no version folder in /)
  fs.writeFileSync(f.infoPlist, plist(null))
  rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: path.join(f.root, 'nowhere'), checkedVersion: '2.1.309' })
  assert.match(byId(rows, 'versions.app').reason, /^no CFBundleShortVersionString in /)
  assert.match(byId(rows, 'versions.claude-code').reason, /^can't list .*nowhere: ENOENT$/)
})

test('recheck: the checked version is the one the vendored d.ts names on its first line, and check 1 fails without one', async (t) => {
  const f = fixture(t)
  const file = path.join(f.root, 'probe.d.ts')
  fs.writeFileSync(file, '// Written by Claude Code 2.1.400.\n// Claude Code function hooks\n')
  assert.equal(R.vendoredVersion(file), '2.1.400')
  for (const head of ['// Claude Code function hooks\n', '// Written by Claude Code 2.1.400\n', '// Written by Claude Code two.\n', '']) {
    fs.writeFileSync(file, head)
    assert.equal(R.vendoredVersion(file), null, JSON.stringify(head))
  }
  assert.equal(R.vendoredVersion(path.join(f.root, 'missing.d.ts')), null)

  // The repository's own: CHECKED_CC_VERSION is what its first line says, so a refresh moves it.
  const first = fs.readFileSync(R.VENDORED_DTS, 'utf8').split('\n', 1)[0]
  assert.equal(first, `// Written by Claude Code ${R.CHECKED_CC_VERSION}.`)

  const rows = await R.checkVersions({ infoPlist: f.infoPlist, claudeCodeRoot: f.claudeCodeRoot, checkedVersion: null })
  assert.equal(byId(rows, 'versions.claude-code').status, 'fail')
  assert.match(byId(rows, 'versions.claude-code').reason, /^2\.1\.309 bundled, but claude-code\/vendor\/mods-api\/claude-code\.d\.ts is missing or its first line names no version: run claude-code\/vendor\/refresh\.mjs$/)
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
  assert.match(byId(rows, 'registry.startedAt').reason, /^0\/3 number; 3 missing\. The slots fill with the newest first/)
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
  writeRecord(f, 1, record(1, { turnWrapUp: { description: 5 }, postTurnSummaryFor: 'uuid-older', isArchived: 'no' }))
  writeRecord(f, 2, record(2, { permissionMode: 'yolo', lastFocusedAt: 'yesterday', postTurnSummaryFor: 'uuid-older', cwd: '' }))
  writeRecord(f, 3, record(3, { title: '', postTurnSummary: { status_category: null }, postTurnSummaryFor: 'uuid-older', lastActivityAt: undefined }))
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
    'records.isArchived': 'warn',
    'records.lastActivityAt': 'warn',
    'records.cwd': 'warn',
    // Rare: in no record here, which is how the app writes them most of the time.
    'records.backgroundTaskSuggestions': 'ok',
    'records.spawnedFrom': 'ok',
    'records.lineageDetached': 'ok',
    'records.summary-for-last': 'warn',
    'records.lookup': 'warn',
  })
  // Phase 7's: a slot's archive, the seen fallback after a deck restart, and a slotted session's project.
  assert.match(byId(rows, 'records.isArchived').reason, /^2\/3 boolean; 1 string\. A Session Slot keeps its session/)
  assert.match(byId(rows, 'records.lastActivityAt').reason, /^2\/3 number; 1 missing\. With no turn end seen/, 'in every record: one without it warns')
  assert.match(byId(rows, 'records.cwd').reason, /^2\/3 non-empty string; 1 empty string\. The project/)
  assert.match(byId(rows, 'records').reason, /^3 records in 1 account\/org folder of .*; 1 more didn't parse as a JSON object .*; 1 local_\*\.json whose id the deck's HOST_PATTERN refuses$/)
  assert.match(byId(rows, 'records.permissionMode').reason, /^2\/3 mode name: default 2; 1 mode the deck has no name for\. /)
  assert.match(byId(rows, 'records.turnWrapUp').reason, /^2\/3 object with a string description; 1 object without a string description\. /)
  assert.match(byId(rows, 'records.postTurnSummary').reason, /^2\/3 object with a string status_category; 1 object the app's loader drops\. /)
  assert.match(byId(rows, 'records.title').reason, /^2\/3 non-empty string; 1 empty string\. /)
  assert.match(byId(rows, 'records.lastFocusedAt').reason, /^2\/3 number; 1 string\. /)
  assert.match(byId(rows, 'records.summary-for-last').reason, /^0\/3 records with both have them equal\. Status rule 6/)
  assert.match(byId(rows, 'records.lookup').reason, /^3\/4 running sessions' records found/)
})

test('recheck: the rare fields of threads and task cards are ok in no record, and warn only when one is of another type (PROTOCOL.md\'s 2026-11-08 amendment)', async (t) => {
  const f = fixture(t, { sessions: 0 })
  const card = { id: 'task_f25ae22d', title: 'Doc 40 T1', createdAt: 1 }
  const from = { sessionId: 'local_secret-1', taskId: 'task_f25ae22d', sideSession: true }
  writeRecord(f, 1, record(1, { backgroundTaskSuggestions: [card], spawnedFrom: from, lineageDetached: false }))
  writeRecord(f, 2, record(2))
  let rows = await R.checkRecords(f.records, [])
  for (const field of ['backgroundTaskSuggestions', 'spawnedFrom', 'lineageDetached']) assert.equal(byId(rows, `records.${field}`).status, 'ok', field)
  assert.equal(byId(rows, 'records.spawnedFrom').reason, '1/2 object with a string sessionId and a boolean sideSession; 1 without one')
  writeRecord(f, 3, record(3, { backgroundTaskSuggestions: [{ title: 'no id' }], spawnedFrom: { sessionId: 'local_secret-1', sideSession: 'yes' }, lineageDetached: 'no' }))
  rows = await R.checkRecords(f.records, [])
  assert.match(byId(rows, 'records.backgroundTaskSuggestions').reason, /^1\/3 array of cards with a string id; 1 without one, 1 array with a card without a string id\. Status rules 2 and 6/)
  assert.match(byId(rows, 'records.spawnedFrom').reason, /^1\/3 object .*; 1 without one, 1 object without a boolean sideSession\. Status rule 9/)
  assert.equal(byId(rows, 'records.lineageDetached').status, 'warn')
  // Only of the wrong type, and in no record of the right one: still a warn.
  fs.rmSync(path.join(f.orgDir, 'local_secret-1.json'))
  rows = await R.checkRecords(f.records, [])
  assert.equal(byId(rows, 'records.backgroundTaskSuggestions').status, 'warn')
})

test('recheck: a record\'s summary counts only as the app\'s loader keeps it, as status rule 6 reads it: one the loader drops warns', async (t) => {
  // PROTOCOL.md, status rule 6, as amended for Phase 6: the loader (its OM) keeps a summary whose seven fields are each
  // missing or a string and whose is_noteworthy is missing or a boolean. Other fields don't matter.
  const f = fixture(t, { sessions: 0 })
  const summaries = [
    { status_category: 'need_input', is_noteworthy: true, extra: 7 },
    { status_category: 'need_input', is_noteworthy: 'yes' },
    { status_category: 'need_input', status_detail: null },
    { status_category: 'need_input', summarizes_uuid: 7 },
    { title: 'Kept, with no category' },
    ['need_input'],
  ]
  summaries.forEach((postTurnSummary, i) => writeRecord(f, i + 1, record(i + 1, { postTurnSummary })))
  const row = byId(await R.checkRecords(f.records, []), 'records.postTurnSummary')
  assert.equal(row.status, 'warn')
  assert.match(row.reason, /^1\/6 object with a string status_category; 3 object the app's loader drops, 1 object without a string status_category, 1 array\. Status rule 6/)
  // The same reading as the fake deck's, which plays the fixtures' records (claude-code/tools/lib/registry.mjs).
  for (const s of [...summaries, null, 'blocked', {}, { is_noteworthy: false }, { needs_action: 'x', recent_action: 'y' }]) {
    assert.equal(R.summaryDropped(s) === null, validSummary(s) !== null, JSON.stringify(s))
  }
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

test('recheck: the bundle is ok with every string, warns when only a corroborating one or a looser pattern is left, and fails when one the deck or the mod needs is gone', async (t) => {
  const f = fixture(t)
  let rows = await R.checkBundle(f.asar)
  assert.deepEqual(statuses(rows), { bundle: 'ok', 'bundle.jump': 'ok', 'bundle.needs-input': 'ok', 'bundle.local-id': 'ok', 'bundle.summary-loader': 'ok', 'bundle.desktop-env': 'ok' })
  assert.equal(byId(rows, 'bundle.desktop-env').reason, '?"claude-desktop-3p":"claude-desktop" ×1, .CLAUDE_CODE_HOST_SESSION_ID= ×1')
  assert.equal(byId(rows, 'bundle.jump').reason, 'claude://code/continue?session= ×1, "/continue" ×1')
  assert.equal(byId(rows, 'bundle.local-id').reason, '^local_[A-Za-z0-9-]{1,64}$ ×1')
  // The validator's is_noteworthy check, far from the list, doesn't count.
  assert.equal(byId(rows, 'bundle.summary-loader').reason, '["title","description","status_category","status_detail","recent_action","needs_action","summarizes_uuid"] ×1, is_noteworthy!="boolean" ×1 within 2048 bytes after the field list')
  assert.deepEqual(
    byId(rows, 'bundle.summary-loader').details.needles.map(({ text, hits, after, within, anchors, elsewhere, status }) => ({ text, hits, after, within, anchors, elsewhere, status })),
    [
      { text: JSON.stringify(SUMMARY_FIELDS), hits: 1, after: undefined, within: undefined, anchors: undefined, elsewhere: undefined, status: 'ok' },
      { text: 'is_noteworthy!="boolean"', hits: 1, after: 'the field list', within: 2048, anchors: 1, elsewhere: null, status: 'ok' },
    ],
  )
  assert.match(byId(rows, 'bundle').reason, / 0\.0 MB$/)

  const cases = [
    [{ continueUrl: '' }, 'bundle.jump', 'warn', /^claude:\/\/code\/continue\?session= not found \(found: "\/continue" ×1\)\. The slot keys and dials/],
    [{ continueRoute: '' }, 'bundle.jump', 'fail', /^"\/continue" not found \(found: claude:\/\/code\/continue\?session= ×1\)\. /],
    [{ needsInputUrl: '', needsInputRoute: '' }, 'bundle.needs-input', 'warn', /^code\/needs-input not found; "\/needs-input" not found\. S5 found it/],
    [{ hostPattern: 'var lmr=/^local_[A-Za-z0-9_-]{1,128}$/;' }, 'bundle.local-id', 'warn', /^\^local_\[A-Za-z0-9-\]\{1,64\}\$ not found, though \^local_ is \(×1\), so it changed\. The app's route/],
    [{ hostPattern: 'var lmr=/^session_[a-z]+$/;' }, 'bundle.local-id', 'fail', /^\^local_\[A-Za-z0-9-\]\{1,64\}\$ not found\. The app's route ignores/],
    // The loader's list with a field more: the pair is still there, so it changed. Its check is looked for after the pair.
    [{ summaryFields: 'var wM=["title","description","status_category","status_detail","recent_action","needs_action","summarizes_uuid","priority"];' }, 'bundle.summary-loader', 'warn', /^\["title",.*"summarizes_uuid"\] not found, though "status_category","status_detail" is \(×1\), so it changed \(found: is_noteworthy!="boolean" ×1 within 2048 bytes after the field list\)\. Status rule 6 reads/],
    // Its fields kept in another order, or gone: there's no list to look after.
    [{ summaryFields: 'var wM=["status_detail","title","status_category"];' }, 'bundle.summary-loader', 'fail', /^\["title",.*"summarizes_uuid"\] not found; is_noteworthy!="boolean" not found within 2048 bytes after the field list, only elsewhere in the bundle \(×2\)\. Status rule 6 reads/],
    // OM no longer checks is_noteworthy as a boolean, though it still copies it, as the review took it out of the app's
    // own bundle: the validator's check, still there, doesn't make it ok.
    [{ noteworthy: 'if(t.is_noteworthy!==void 0){n.is_noteworthy=t.is_noteworthy}' }, 'bundle.summary-loader', 'warn', /^is_noteworthy!="boolean" not found within 2048 bytes after the field list, only elsewhere in the bundle \(×1\), though is_noteworthy is \(×3\), so it changed \(found: \["title",/],
    [{ noteworthy: 'n.is_noteworthy=t.is_noteworthy===!0' }, 'bundle.summary-loader', 'warn', /^is_noteworthy!="boolean" not found within 2048 bytes after the field list, only elsewhere in the bundle \(×1\), though is_noteworthy is \(×2\), so it changed \(found: \["title",/],
    // OM no longer reads is_noteworthy at all.
    [{ noteworthy: '' }, 'bundle.summary-loader', 'fail', /^is_noteworthy!="boolean" not found within 2048 bytes after the field list, only elsewhere in the bundle \(×1\) \(found: \["title",/],
    // Its check moved away from the list: the check can't tell it's still the loader's, so it fails, for a look.
    [{ noteworthy: `${' '.repeat(2048)}${PARTS.noteworthy}` }, 'bundle.summary-loader', 'fail', /^is_noteworthy!="boolean" not found within 2048 bytes after the field list, only elsewhere in the bundle \(×2\) \(found: \["title",/],
    // The app gives its sessions their entrypoint another way: the name is still there, so it changed. Or a new name.
    [{ desktopEntrypoint: 'var ILa=new Map([["3p","claude-desktop-3p"]]);function LLa(e){return ILa.get(e)??"claude-desktop"}' }, 'bundle.desktop-env', 'warn', /^\?"claude-desktop-3p":"claude-desktop" not found, though "claude-desktop-3p" is \(×1\), so it changed \(found: \.CLAUDE_CODE_HOST_SESSION_ID= ×1\)\. The mod talks to the bridge only from a desktop session/],
    [{ desktopEntrypoint: 'function LLa(e){return e==="3p"?"claude-app-3p":"claude-app"}' }, 'bundle.desktop-env', 'fail', /^\?"claude-desktop-3p":"claude-desktop" not found \(found: \.CLAUDE_CODE_HOST_SESSION_ID= ×1\)\. /],
    // The host id set in an object instead, or not at all.
    [{ desktopHost: 'return{...d,CLAUDE_CODE_HOST_SESSION_ID:n}' }, 'bundle.desktop-env', 'warn', /^\.CLAUDE_CODE_HOST_SESSION_ID= not found, though CLAUDE_CODE_HOST_SESSION_ID is \(×1\), so it changed/],
    [{ desktopHost: 'return{...d}' }, 'bundle.desktop-env', 'fail', /^\.CLAUDE_CODE_HOST_SESSION_ID= not found \(found: \?"claude-desktop-3p":"claude-desktop" ×1\)\. /],
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
  // With spans, only the hits wholly inside one; spans after the first anchor text the bundle has.
  assert.equal(R.countHits(Buffer.from('ab-xy-xy'), 'xy', [[2, 5]]), 1)
  assert.equal(R.countHits(Buffer.from('ab-xy'), 'xy', [[2, 4]]), 0, 'one that runs past the span')
  assert.equal(R.countHits(Buffer.from('xy'), 'xy', []), 0)
  assert.deepEqual(R.spansAfter(Buffer.from('ab-cd-ab'), { texts: ['zz', 'ab'], within: 3 }), [[2, 5], [8, 11]])
  assert.deepEqual(R.spansAfter(Buffer.from('ab-cd-ab'), { texts: ['cd', 'ab'], within: 2 }), [[5, 7]])
  assert.deepEqual(R.spansAfter(Buffer.from('nothing'), { texts: ['zz'], within: 3 }), [])
})

// ---- 5. the mods API

test('recheck: check 5 runs the newest Claude Code\'s plugin validate and plugin test on HEAD\'s plugin: ok, warn and fail', async (t) => {
  const f = fixture(t, { cc: ['2.1.300', '2.1.309'] })
  const repo = pluginRepo(f)
  const run = () => R.checkModsApi({ claudeCodeRoot: f.claudeCodeRoot, repo, tmpRoot: f.tmp })

  let rows = await run()
  assert.deepEqual(statuses(rows), { 'mods.validate': 'ok', 'mods.test': 'ok' })
  assert.equal(byId(rows, 'mods.validate').reason, '2.1.309 passed on claude-code/plugin at HEAD: ./register.ts hooks 3 events and makes 2 $ calls')
  assert.deepEqual(byId(rows, 'mods.validate').details.modules, [{ module: './register.ts', hooks: ['session.start', 'turn.complete', 'tool.call'], calls: ['$.http.fetch', '$.prompt.submit'] }])
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
  assert.equal(byId(rows, 'mods.test').reason, "2.1.309 failed (exit 1): 1 of 2 failed; first: a prompt is submitted as the user's words")
  assert.deepEqual(byId(rows, 'mods.test').details.failed, ["a prompt is submitted as the user's words"])

  // A failure counted with exit 0 still fails, and a crash says what it printed.
  fakeClaude(f, '2.1.309', { test: { ...TEST_FAIL, code: 0 } })
  rows = await run()
  assert.equal(byId(rows, 'mods.test').status, 'fail')
  assert.equal(byId(rows, 'mods.test').reason, "2.1.309 failed (exit 0): 1 of 2 failed; first: a prompt is submitted as the user's words")
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

// ---- 6. the engine

/** Check 6's rows from the file table, as the default fake binary has it. */
const TABLE_ROWS = { 'engine.registry-status': 'ok', 'engine.desktop-gate': 'ok' }

test('recheck: check 6 reads the newest bundled Claude Code\'s binary, and fails with no root or no binary that runs', async (t) => {
  // Only the newest is read.
  const f = fixture(t, { cc: ['2.1.300', '2.1.309'] })
  const run = (claudeCodeRoot = f.claudeCodeRoot) => R.checkEngine({ claudeCodeRoot })
  let rows = await run()
  assert.deepEqual(statuses(rows), { engine: 'ok', ...TABLE_ROWS })
  assert.match(byId(rows, 'engine').reason, /^Claude Code 2\.1\.309, 0\.0 MB$/)
  assert.equal(byId(rows, 'engine').details.binary, path.join(f.claudeCodeRoot, '2.1.309', 'abc123def456', 'claude.app', 'Contents', 'MacOS', 'claude'))

  // No root, or no binary that runs: fail.
  assert.match((await run(path.join(f.root, 'nowhere')))[0].reason, /^can't list .*nowhere: ENOENT$/)
  const empty = path.join(f.root, 'empty-cc')
  fs.mkdirSync(path.join(empty, '2.1.309', 'abc', 'claude.app', 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(empty, '2.1.309', 'abc', 'claude.app', 'Contents', 'MacOS', 'claude'), 'not executable', { mode: 0o644 })
  rows = await run(empty)
  assert.deepEqual(statuses(rows), { engine: 'fail' })
  assert.match(rows[0].reason, /^no claude binary at .*2\.1\.309\/\*\/claude\.app\/Contents\/MacOS\/claude$/)
})

test('recheck: check 6 finds in the engine\'s JS where it sets the registry\'s statuses and its own desktop test, each in the file it\'s in, and warns or fails as they change', async (t) => {
  const f = fixture(t)
  const ids = ['engine.registry-status', 'engine.desktop-gate']
  const run = async () => (await R.checkEngine({ claudeCodeRoot: f.claudeCodeRoot })).filter((r) => ids.includes(r.id))
  let rows = await run()
  assert.deepEqual(statuses(rows), { 'engine.registry-status': 'ok', 'engine.desktop-gate': 'ok' })
  assert.equal(byId(rows, 'engine.registry-status').reason, 'status:"waiting",waitingFor: ×1, "idle" ×1 within 200 bytes after the waiting status, "busy" ×1 within 200 bytes after the waiting status')
  assert.equal(byId(rows, 'engine.desktop-gate').reason, '["claude-desktop","claude-desktop-3p"] ×1, childSession ×1 within 160 bytes after the desktop entrypoints, CLAUDECODE:"1" ×2, CLAUDE_CODE_CHILD_SESSION:"1" ×1 within 120 bytes after CLAUDECODE:"1"')
  assert.equal(byId(rows, 'engine.desktop-gate').details.files, Object.keys(engineFiles()).filter((n) => R.isSearched({ name: n })).length)

  const away = ENGINE_JS.registry.replace('?"busy":"idle"', '?Q:"idle"')
  const cases = [
    [{ registry: ENGINE_JS.registry.replace('status:"waiting"', 'status:"blocked"') }, 'engine.registry-status', 'warn', /^status:"waiting",waitingFor: not found; "idle" not found within 200 bytes after the waiting status, only elsewhere in its files \(×1\); "busy" not found within 200 bytes after the waiting status, only elsewhere in its files \(×1\)\. The deck's status starts from/],
    [{ registry: ENGINE_JS.registry.replace('?"busy":"idle"', '?"working":"idle"') }, 'engine.registry-status', 'warn', /^"busy" not found within 200 bytes after the waiting status \(found: status:"waiting",waitingFor: ×1, "idle" ×1 within 200 bytes after the waiting status\)\. /],
    // Far from where the engine sets the others, or in another file: not where it sets them.
    [{ registry: `${away};var Q=${' '.repeat(300)}"busy"` }, 'engine.registry-status', 'warn', /^"busy" not found within 200 bytes after the waiting status, only elsewhere in its files \(×1\) \(found: /],
    [{ registry: away, other: 'var Q="busy"' }, 'engine.registry-status', 'warn', /^"busy" not found within 200 bytes after the waiting status, only elsewhere in its files \(×1\) \(found: /],
    // A third desktop entrypoint: the list changed, and childSession has no list to follow.
    [{ desktop: ENGINE_JS.desktop.replace('"claude-desktop-3p"]', '"claude-desktop-3p","claude-desktop-ent"]') }, 'engine.desktop-gate', 'warn', /^\["claude-desktop","claude-desktop-3p"\] not found, though "claude-desktop-3p" is \(×1\), so it changed; childSession not found within 160 bytes after the desktop entrypoints, only elsewhere in its files \(×1\) \(found: CLAUDECODE/],
    [{ desktop: ENGINE_JS.desktop.replaceAll('claude-desktop', 'claude-app') }, 'engine.desktop-gate', 'fail', /^\["claude-desktop","claude-desktop-3p"\] not found; childSession not found within 160 bytes after the desktop entrypoints, only elsewhere in its files \(×1\) \(found: CLAUDECODE:"1" ×2, .*\)\. The mod talks to the bridge only from a desktop session/],
    [{ desktop: ENGINE_JS.desktop.replace('&&!n().childSession', '') }, 'engine.desktop-gate', 'warn', /^childSession not found within 160 bytes after the desktop entrypoints \(found: /],
    // What the engine starts is no longer marked as its child.
    [{ children: ENGINE_JS.children.replace('CLAUDE_CODE_CHILD_SESSION:"1",', '') }, 'engine.desktop-gate', 'warn', /^CLAUDE_CODE_CHILD_SESSION:"1" not found within 120 bytes after CLAUDECODE:"1" \(found: /],
    [{ children: null, shell: null }, 'engine.desktop-gate', 'warn', /^CLAUDECODE:"1" not found; CLAUDE_CODE_CHILD_SESSION:"1" not found within 120 bytes after CLAUDECODE:"1" \(found: /],
  ]
  for (const [js, id, status, reason] of cases) {
    fakeClaude(f, '2.1.309', { table: engineFiles({ js }) })
    rows = await run()
    assert.equal(byId(rows, id).status, status, String(reason))
    assert.match(byId(rows, id).reason, reason)
    for (const other of rows.filter((r) => r.id !== id)) assert.equal(other.status, 'ok', `${other.id} with ${reason}`)
  }

  // Every file is searched but packed ones, native addons and assets: a chunk named otherwise counts; the same text in
  // one of those, stored unpacked, doesn't.
  fakeClaude(f, '2.1.309', { table: engineFiles({ js: { registry: null }, files: { 'chunk-registry.mjs': ENGINE_JS.registry } }) })
  assert.equal(byId(await run(), 'engine.registry-status').status, 'ok')
  const skipped = { 'desktop.js.zst': ENGINE_JS.desktop, 'desktop.node': ENGINE_JS.desktop, 'desktop.woff2.asset': ENGINE_JS.desktop }
  fakeClaude(f, '2.1.309', { table: engineFiles({ js: { desktop: null }, files: skipped }), tableOpts: { unpacked: ['desktop.js.zst'] } })
  rows = await run()
  assert.equal(byId(rows, 'engine.desktop-gate').status, 'fail')
  assert.match(byId(rows, 'engine.desktop-gate').reason, /^\["claude-desktop","claude-desktop-3p"\] not found; childSession not found within 160 bytes after the desktop entrypoints \(found: /)
})

test('recheck: check 6 fails in one row, in place of the table\'s checks, when the newest binary\'s file table can\'t be read', async (t) => {
  const f = fixture(t)
  for (const [opts, why] of [[{ table: null }, /no Bun file table: no trailer whose byte count and length agree/], [{ tableOpts: { entry: 56 } }, /isn't whole entries of 52 bytes/]]) {
    fakeClaude(f, '2.1.309', opts)
    const rows = await R.checkEngine({ claudeCodeRoot: f.claudeCodeRoot })
    assert.deepEqual(statuses(rows), { engine: 'ok', 'engine.table': 'fail' })
    assert.match(byId(rows, 'engine.table').reason, /^Claude Code 2\.1\.309's file table can't be read \(.*\), so its registry statuses and desktop gate can't be checked$/)
    assert.match(byId(rows, 'engine.table').reason, why)
  }
  // Any error reading it, not Bun's format's alone, is that row, not a stack trace.
  fakeClaude(f, '2.1.309')
  const binaries = { read: (file) => fs.promises.readFile(file), table: () => Promise.reject(new Error('zstd: unknown frame descriptor')) }
  let rows = await R.checkEngine({ claudeCodeRoot: f.claudeCodeRoot, binaries })
  assert.match(byId(rows, 'engine.table').reason, /^Claude Code 2\.1\.309's file table can't be read \(zstd: unknown frame descriptor\), so /)

  // A table with no file it searches warns in their place.
  fakeClaude(f, '2.1.309', { table: { 'a.js.zst': 'x', 'b.node': ENGINE_JS.desktop, 'c.asset': ENGINE_JS.registry } })
  rows = await R.checkEngine({ claudeCodeRoot: f.claudeCodeRoot })
  assert.deepEqual(statuses(rows), { engine: 'ok', 'engine.js': 'warn' })
  assert.equal(byId(rows, 'engine.js').reason, "Claude Code 2.1.309's file table has no file to search but packed ones (.zst), native addons (.node) and assets (.asset), so its registry statuses and desktop gate can't be checked")
})

test('recheck: check 7 runs lsappinfo as the deck does and reads its answers as front.ts does: ok, warn with no app or bundle id in front, fail with another shape', async (t) => {
  const f = fixture(t)
  const run = (over = {}) => R.checkSeen({ lsappinfo: f.lsappinfo, infoPlist: f.infoPlist, ...over })
  let rows = await run()
  assert.deepEqual(statuses(rows), { 'seen.lsappinfo': 'ok', 'seen.bundle-id': 'ok' })
  assert.equal(byId(rows, 'seen.lsappinfo').reason, "front gave an ASN and info -only bundleid another app's bundle id, as the deck reads them")
  assert.equal(byId(rows, 'seen.lsappinfo').details.claudeInFront, false)
  assert.equal(byId(rows, 'seen.bundle-id').reason, "com.anthropic.claudefordesktop, as the deck's seen check compares the app in front with")
  fakeLsappinfo(f, { info: '"CFBundleIdentifier"="com.anthropic.claudefordesktop"' })
  assert.equal(byId(await run(), 'seen.lsappinfo').reason, "front gave an ASN and info -only bundleid Claude's bundle id, as the deck reads them")

  const cases = [
    [{ front: '[ NULL ]' }, 'warn', /^lsappinfo front named no app \(`\[ NULL \]`\), so its answer's shape can't be checked: run again with an app in front$/],
    [{ info: '"CFBundleIdentifier"=[ NULL ]' }, 'warn', /^the app in front has no bundle id \(`"CFBundleIdentifier"=\[ NULL \]`\), so the answer's shape can't be checked/],
    // As `lsappinfo find` answers, with the app's name: another shape, printed with its values blanked.
    [{ front: 'ASN:0x0-0x2002-"loginwindow":' }, 'fail', /^lsappinfo front answered `ASN:0x…-0x…-"…":`, which the deck doesn't read as ASN:0x…-0x…:\. The deck's seen check asks `lsappinfo front`/],
    [{ front: 'loginwindow Ghostty' }, 'fail', /^lsappinfo front answered `… …`, which the deck doesn't read/],
    [{ info: 'bundleID="com.apple.loginwindow"' }, 'fail', /^lsappinfo info -only bundleid answered `bundleID="…"`, which the deck doesn't read as "CFBundleIdentifier"="…"\. /],
    [{ code: 1 }, 'fail', /lsappinfo front failed: exit 1\. The deck's seen check/],
  ]
  for (const [over, status, reason] of cases) {
    fakeLsappinfo(f, over)
    rows = await run()
    assert.equal(byId(rows, 'seen.lsappinfo').status, status, JSON.stringify(over))
    assert.match(byId(rows, 'seen.lsappinfo').reason, reason)
    assert.doesNotMatch(JSON.stringify(rows), /loginwindow|Ghostty|com\.apple/, "no other app's name or bundle id is printed")
    assert.equal(byId(rows, 'seen.bundle-id').status, 'ok')
  }
  rows = await run({ lsappinfo: path.join(f.root, 'nowhere') })
  assert.match(byId(rows, 'seen.lsappinfo').reason, /nowhere front failed: ENOENT\. /)
  fakeLsappinfo(f, { sleep: true })
  const started = Date.now()
  rows = await run({ timeoutMs: 300 })
  assert.ok(Date.now() - started < 10_000, 'killed at its timeout')
  assert.match(byId(rows, 'seen.lsappinfo').reason, /lsappinfo front failed: no answer in 300 ms\. /)

  // A shape blanks every value, quoted or not, in any script; it keeps the keys and NULL.
  assert.equal(R.shapeOf('ASN:0x0-0x2002-"loginwindow":\n'), 'ASN:0x…-0x…-"…":')
  assert.equal(R.shapeOf('"CFBundleIdentifier"="com.apple.Safari"'), '"CFBundleIdentifier"="…"')
  assert.equal(R.shapeOf('Café 2 [ NULL ]'), '… … [ NULL ]')
})

test('recheck: check 7 fails when the app\'s bundle id isn\'t the one the deck compares the app in front with', async (t) => {
  const f = fixture(t)
  const run = () => R.checkSeen({ lsappinfo: f.lsappinfo, infoPlist: f.infoPlist })
  fs.writeFileSync(f.infoPlist, plist('4.5000.1').replace('com.anthropic.claudefordesktop', 'com.anthropic.claude'))
  execFileSync('plutil', ['-convert', 'binary1', f.infoPlist])
  const rows = await run()
  assert.equal(byId(rows, 'seen.bundle-id').status, 'fail')
  assert.match(byId(rows, 'seen.bundle-id').reason, /^Claude\.app's bundle id is com\.anthropic\.claude\. The deck counts Claude as in front only when the app in front has the bundle id com\.anthropic\.claudefordesktop \(CLAUDE_BUNDLE_ID in claude-code\/deck\/src\/model\/front\.ts\)/)
  fs.writeFileSync(f.infoPlist, plist('4.5000.1').replace(/\t<key>CFBundleIdentifier<\/key>\n\t<string>[^<]*<\/string>\n/, ''))
  assert.match(byId(await run(), 'seen.bundle-id').reason, /^no CFBundleIdentifier in .*Info\.plist\. /)
  fs.rmSync(f.infoPlist)
  assert.match(byId(await run(), 'seen.bundle-id').reason, /^can't read .*Info\.plist: ENOENT$/)
})

test('recheck: check 8 is ok when the vendored mods API is what refresh.mjs makes from the version it names, and warns, naming the files, when it differs', async (t) => {
  const f = fixture(t, { cc: ['2.1.309', '2.1.400'] })
  const run = () => R.checkVendored({ vendored: f.vendored, claudeCodeRoot: f.claudeCodeRoot })
  let rows = await run()
  assert.deepEqual(statuses(rows), { 'vendor.mods-api': 'ok' })
  assert.match(rows[0].reason, /mods-api is what refresh\.mjs makes from Claude Code 2\.1\.309's file table, 8 files$/)
  // A file of another name, an asset Bun keeps elsewhere, changes nothing.
  fakeClaude(f, '2.1.309', { table: { ...engineFiles(), 'odd.asset': 'x' }, tableOpts: { prefix: (name) => (name === 'odd.asset' ? '' : F.ROOT_PREFIX) } })
  assert.equal((await run())[0].status, 'ok')
  // The version the d.ts names, not the newest: 2.1.400's table is another.
  fakeClaude(f, '2.1.400', { table: engineFiles({ dts: 'other\n' }) })
  assert.equal((await run())[0].status, 'ok')

  fs.appendFileSync(path.join(f.vendoredDir, 'reference.md'), 'A local edit.\n')
  fs.rmSync(path.join(f.vendoredDir, 'examples', 'pane.tsx'))
  fs.writeFileSync(path.join(f.vendoredDir, 'notes.md'), 'Mine.\n')
  fs.writeFileSync(path.join(f.vendoredDir, '.DS_Store'), '')
  rows = await run()
  assert.equal(rows[0].status, 'warn')
  assert.match(rows[0].reason, /mods-api isn't what refresh\.mjs makes from Claude Code 2\.1\.309: reference\.md differs; examples\/pane\.tsx is missing; notes\.md isn't in the binary's\. `node claude-code\/vendor\/refresh\.mjs --version 2\.1\.309` and git diff show how$/)
  assert.deepEqual([rows[0].details.changed, rows[0].details.missing, rows[0].details.extra], [['reference.md'], ['examples/pane.tsx'], ['notes.md']])

  // Its first line names 2.1.400: then it's 2.1.400's declarations it's held to.
  writeVendored(f, '2.1.400')
  rows = await run()
  assert.match(rows[0].reason, /isn't what refresh\.mjs makes from Claude Code 2\.1\.400: claude-code\.d\.ts differs\. /)

})

test('recheck: check 8 fails when the binary\'s file table can\'t be read, and warns when refresh.mjs would refuse it or the version isn\'t bundled', async (t) => {
  const f = fixture(t)
  const run = () => R.checkVendored({ vendored: f.vendored, claudeCodeRoot: f.claudeCodeRoot })
  fakeClaude(f, '2.1.309', { table: null })
  let rows = await run()
  assert.deepEqual(statuses(rows), { 'vendor.mods-api': 'fail' })
  assert.match(rows[0].reason, /^Claude Code 2\.1\.309's file table can't be read: no Bun file table: no trailer whose byte count and length agree, so it isn't a Bun standalone binary, or Bun changed its format\. refresh\.mjs can't rebuild .*mods-api from it$/)
  fakeClaude(f, '2.1.309', { tableOpts: { prefix: 'B:/~BUN/root/' } })
  assert.match((await run())[0].reason, /^Claude Code 2\.1\.309's file table can't be read: the __bun section at \d+ \(\d+ bytes\): its entry point, file 0, isn't under \/\$bunfs\/root\/, so the file table is not where Bun keeps it, or Bun changed its format\. /)
  // A file refresh.mjs takes that can't be unpacked, or isn't under /$bunfs/root/: the table can't be read for it.
  fakeClaude(f, '2.1.309', { tableOpts: { unpacked: ['reference-d80c0885.md.zst'] } })
  rows = await run()
  assert.deepEqual(statuses(rows), { 'vendor.mods-api': 'fail' })
  assert.match(rows[0].reason, /^Claude Code 2\.1\.309's file table can't be read: reference-d80c0885\.md\.zst can't be unpacked \(.*\), so Bun changed how it packs a file\. /)
  fakeClaude(f, '2.1.309', { tableOpts: { prefix: (name) => (name.startsWith('band.tsx-') ? '' : F.ROOT_PREFIX) } })
  rows = await run()
  assert.deepEqual(statuses(rows), { 'vendor.mods-api': 'fail' })
  assert.match(rows[0].reason, /^Claude Code 2\.1\.309's file table can't be read: band\.tsx, band\.tsx-xxxxxxx8\.txt, isn't under \/\$bunfs\/root\/, so Bun changed its format\. /)

  // Readable, but missing a file, or with two of one: refresh.mjs would refuse it.
  fakeClaude(f, '2.1.309', { table: engineFiles({ mods: { examples: { 'pane.tsx': null } } }) })
  rows = await run()
  assert.deepEqual(statuses(rows), { 'vendor.mods-api': 'warn' })
  assert.equal(rows[0].reason, "Claude Code 2.1.309's file table reads, but refresh.mjs would refuse it: expected one pane.tsx, found 0; the format or the skill changed")
  fakeClaude(f, '2.1.309', { table: { ...engineFiles(), 'claude-code.d.ts-feedf00d.txt': 'declare const x: 1\n' } })
  assert.match((await run())[0].reason, /would refuse it: expected one claude-code\.d\.ts, found 2: /)

  // Not bundled any more, or no version to look for.
  fakeClaude(f, '2.1.309')
  writeVendored(f, '2.1.200')
  rows = await run()
  assert.equal(rows[0].status, 'warn')
  assert.match(rows[0].reason, /mods-api is for Claude Code 2\.1\.200, which isn't bundled any more \(2\.1\.309\), so it can't be compared: run claude-code\/vendor\/refresh\.mjs$/)
  fs.writeFileSync(f.vendored, '// Claude Code function hooks\n')
  rows = await run()
  assert.equal(rows[0].status, 'warn')
  assert.match(rows[0].reason, /mods-api\/claude-code\.d\.ts is missing or its first line names no version, so there's no binary to compare it with: run claude-code\/vendor\/refresh\.mjs$/)
  writeVendored(f, '2.1.309')
  rows = await R.checkVendored({ vendored: f.vendored, claudeCodeRoot: path.join(f.root, 'nowhere') })
  assert.deepEqual(statuses(rows), { 'vendor.mods-api': 'fail' })
  assert.match(rows[0].reason, /^can't list .*nowhere: ENOENT$/)
})

test('recheck: checks 6 and 8 read a bundled binary once between them', async (t) => {
  const f = fixture(t)
  const reads = []
  const spy = { ...R.nodeFs, readFile: (p, ...rest) => (reads.push(String(p)), R.nodeFs.readFile(p, ...rest)) }
  const result = await R.recheck({ ...paths(f), skipPlugin: true, fs: spy })
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => c.status !== 'ok')))
  const bin = path.join(f.claudeCodeRoot, '2.1.309', 'abc123def456', 'claude.app', 'Contents', 'MacOS', 'claude')
  assert.deepEqual(reads.filter((p) => p === bin), [bin], 'the newest binary, the one the vendored d.ts names too, read once')
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
  assert.match(r.out, /^ok\s+bundle: summary loader\s+/m)
  assert.match(r.out, /^ok\s+engine: registry statuses\s+/m)
  assert.match(r.out, /\n\n40 ok, 0 warn, 0 fail; the mods API check skipped \(--skip-plugin\)\n$/)

  r = await cli([...flags(f), '--skip-plugin', '--json'], { env: { HOME: f.root } })
  assert.equal(r.code, 0)
  const j = JSON.parse(r.out)
  assert.equal(j.ok, true)
  assert.deepEqual(j.summary, { ok: 40, warn: 0, fail: 0 })
  assert.deepEqual(j.skipped, ['mods'])
  assert.equal(j.paths.sessions, '~/sessions', 'paths under HOME read ~')
  assert.deepEqual([...new Set(j.checks.map((c) => c.group))], ['versions', 'registry', 'records', 'bundle', 'engine', 'seen', 'vendor'])
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
  assert.match(r.out, /\n41 ok, 0 warn, 1 fail\n$/)
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

  // The id pattern, the jump route, the mode names and the statuses.
  const wire = read('claude-code/deck/src/protocol/wire.ts')
  assert.equal(/export const HOST_PATTERN = \/(.+)\/;/.exec(wire)?.[1], R.HOST_PATTERN.source)
  assert.equal(byId(R.BUNDLE_CHECKS, 'local-id').needles[0].text, R.HOST_PATTERN.source)
  assert.ok(read('claude-code/deck/src/plugin.ts').includes('`claude://code/continue?session=${encodeURIComponent(host)}`'))
  assert.equal(byId(R.BUNDLE_CHECKS, 'jump').needles[0].text, 'claude://code/continue?session=')
  const modeNames = /const MODE_NAMES: Record<string, string> = \{([^}]*)\}/.exec(read('claude-code/deck/src/model/format.ts'))?.[1] ?? ''
  assert.deepEqual([...modeNames.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]), [...R.MODE_NAMES])
  const status = read('claude-code/deck/src/model/status.ts')
  for (const s of R.REGISTRY_STATUSES) assert.ok(status.includes(`i.registry === "${s}"`), s)

  // The summary loader's fields: the list check 4 looks for in the bundle, and the one the fake deck's rule 6 reads. Its
  // is_noteworthy check is looked for after that list, or after the list's own looser pair.
  assert.deepEqual([...R.SUMMARY_FIELDS], [...SUMMARY_FIELDS])
  const [list, noteworthy] = byId(R.BUNDLE_CHECKS, 'summary-loader').needles
  assert.equal(list.text, JSON.stringify(SUMMARY_FIELDS))
  assert.deepEqual(noteworthy.after, { what: 'the field list', texts: [list.text, list.looser], within: R.LOADER_SPAN })

  // The engine's JS: where it sets the deck's statuses, waiting first; and the gate, as committed, whose entrypoints are
  // the engine's own list and the app's, reading the variables the checks find the app and the engine setting.
  for (const n of R.ENGINE_JS_CHECKS.flatMap((c) => c.needles)) {
    for (const s of n.sources) assert.match(R.cite(s), /:\d+$/, `${n.text}: "${s[1]}" isn't in ${s[0]}`)
  }
  assert.deepEqual(byId(R.ENGINE_JS_CHECKS, 'registry-status').needles.map((n) => n.text), ['status:"waiting",waitingFor:', ...R.REGISTRY_STATUSES.filter((s) => s !== 'waiting').map((s) => `"${s}"`)])
  const desktop = execFileSync('git', ['-C', REPO, 'show', 'HEAD:claude-code/plugin/hooks/desktop.ts'], { encoding: 'utf8' })
  const entry = /export const DESKTOP_ENTRYPOINTS: readonly string\[\] = \[([^\]]*)\]/.exec(desktop)?.[1] ?? ''
  assert.deepEqual([...entry.matchAll(/'([^']+)'/g)].map((m) => m[1]), [...R.DESKTOP_ENTRYPOINTS])
  assert.equal(byId(R.ENGINE_JS_CHECKS, 'desktop-gate').needles[0].text, JSON.stringify(R.DESKTOP_ENTRYPOINTS))
  assert.equal(byId(R.BUNDLE_CHECKS, 'desktop-env').needles[0].text, `?"${R.DESKTOP_ENTRYPOINTS[1]}":"${R.DESKTOP_ENTRYPOINTS[0]}"`)
  for (const v of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']) assert.match(desktop, new RegExp(`env\\.${v}\\b`), v)

  // Check 7 runs what the deck's seen check runs, asks what it asks, and reads the answers with its patterns.
  const front = read(R.FRONT_TS)
  assert.ok(front.includes(`export const LSAPPINFO = "${R.DEFAULTS.lsappinfo}";`), 'LSAPPINFO')
  assert.ok(front.includes(`export const CLAUDE_BUNDLE_ID = "${R.CLAUDE_BUNDLE_ID}";`), 'CLAUDE_BUNDLE_ID')
  assert.ok(front.includes(`return ${R.FRONT_ASN}.test(asn) ? asn : null;`), `parseFrontAsn reads ${R.FRONT_ASN}`)
  assert.ok(front.includes(`return ${R.FRONT_BUNDLE_ID}.exec(stdout)?.[1] ?? null;`), `parseBundleId reads ${R.FRONT_BUNDLE_ID}`)
  for (const ask of ['run(["front"])', 'run(["info", "-only", "bundleid", asn])']) assert.ok(front.includes(ask), ask)

  // The hook's contract, which the plugin's type check holds to the engine's declarations: it reads the fields the
  // bridge reads, effort by its level, and sends the Deny the deck sends. The Approve plan's modes went in Phase 9.
  const contract = read('claude-code/plugin-tsc/hook-contract.ts')
  const bodyFields = [...new Set([...wire.matchAll(/\bbody\.(\w+)(?:\.(\w+))?/g)].map((m) => (m[2] ? `${m[1]}.${m[2]}` : m[1])))].filter((n) => n !== 'effort')
  const contractFields = [...contract.matchAll(/\binput\.(\w+)(?:\?\.(\w+))?/g)].map((m) => (m[2] ? `${m[1]}.${m[2]}` : m[1]))
  assert.deepEqual(contractFields.toSorted(), bodyFields.toSorted())
  assert.ok(contract.includes(`message: '${/export const DENY_MESSAGE = "([^"]+)";/.exec(wire)?.[1]}', interrupt: true`), "the deck's Deny")
  assert.ok(read('claude-code/plugin-tsc/tsconfig.json').includes('"hook-contract.ts"'), 'the plugin\'s type check takes it')
})

test('recheck: it cites the deck\'s wire.ts by name, not by line, and each name it cites is there', () => {
  // wire.ts grew past the lines recheck.mjs once cited (:49 for HOST_PATTERN, :51 for asHost). A name holds when lines move.
  const text = fs.readFileSync(SCRIPT, 'utf8')
  const wire = fs.readFileSync(path.join(REPO, 'claude-code', 'deck', 'src', 'protocol', 'wire.ts'), 'utf8')
  assert.deepEqual(text.match(/wire\.ts:\d+/g) ?? [], [], 'no line numbers into wire.ts')
  // A name can follow on the comment's next line.
  const named = [...text.matchAll(/wire\.ts's\s+(?:\*\s+)?(\w+)/g)].map((m) => m[1])
  assert.deepEqual(named.toSorted(), ['HOST_PATTERN', 'asHost'])
  for (const name of named) assert.match(wire, new RegExp(`^export (const|function) ${name}\\b`, 'm'), name)
})
