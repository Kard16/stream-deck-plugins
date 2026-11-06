// deck-install.mjs against fixtures each test makes in a temp folder: a throwaway git repository holding a plugin, a
// token file, a settings.json, a release folder and a stand-in for Claude Code's binary. Every run of the CLI gets them
// all as flags, with HOME and TMPDIR inside the temp folder too, so a flag left out lands there: never on the real
// ~/.claude, the deck's real token or this repository's release folder. After every run, the output is checked for
// the fake tokens and any 8 characters of them, and the fixture's HOME and TMPDIR for anything left behind.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as DI from '../deck-install.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '..', 'deck-install.mjs')

/** A token the deck would take (64 lowercase hex), made of hex words so it's known on sight. */
const TOKEN = 'c0ffee0ddba11facade5ca1ab1edecade0b5e55edbaddadf00dfeedbeefcafe1'
/** Another, for a DECK_TOKEN that's out of date. */
const OLD_TOKEN = 'abad1dea'.repeat(8)

// ---- fixtures

const json = (v) => `${JSON.stringify(v, null, 2)}\n`

/** A settings.json like the user's: many keys, nested objects, arrays, numbers and unicode, and no env. Written as the app writes it. */
const SETTINGS = Object.freeze({
  permissions: { allow: ['Bash(git status)', 'Read(~/notes/**)'], deny: [], defaultMode: 'default' },
  model: 'opus[1m]',
  skillOverrides: { 'docs:docs': 'off', pdf: 'on' },
  statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 0 },
  enabledPlugins: { 'vercel@claude-plugins': true, 'other@market': false },
  extraKnownMarketplaces: { local: { source: { source: 'directory', path: '/Users/someone/market' } } },
  effortLevel: 'max',
  modelSettings: { opus: { thinking: true, budget: 31999, ratio: 0.25, big: 1e21, small: -2.5e-7 } },
  tui: { compact: false, columns: null },
  skipWorkflowUsageWarning: true,
  theme: 'dark',
  remoteControlAtStartup: false,
  inputNeededNotifEnabled: true,
  agentPushNotifEnabled: false,
  skipAutoPermissionPrompt: true,
  autoMode: { enabled: true, note: 'é ✓ 🙂 "quoted" back\\slash\ttab </script>' },
})

/** The plugin at the first commit, by its path in claude-code/plugin: what a first release copies. */
const PLUGIN = Object.freeze({
  '.claude-plugin/plugin.json': json({ name: 'streamdeck-bridge', version: '0.1.0', description: 'fixture' }),
  'hooks/hooks.json': json({ hooks: {}, modules: ['./register.ts'] }),
  'hooks/register.ts': 'export default function register() {}\n',
  'hooks/bridge.ts': 'export const PORT = 47600\n',
  'tests/hooks.test.ts': '// a test\n',
  // The plugin's own ignore file, for something an engine might leave in the folder.
  '.gitignore': 'cache/\n',
})

/** The rest of the repository: its .gitignore is the real one's, as far as the plugin goes. */
const REPO_FILES = Object.freeze({
  '.gitignore': '.DS_Store\nnode_modules/\n**/run/\nclaude-code/plugin/tsconfig.json\nclaude-code/release/\n',
  'claude-code/other/notes.txt': 'not the plugin\n',
})

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
}

/** Every file under `dir`, by its path from there: its content. */
function tree(dir, rel = '') {
  const out = {}
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name
    if (fs.lstatSync(path.join(dir, r)).isDirectory()) Object.assign(out, tree(dir, r))
    else out[r] = fs.readFileSync(path.join(dir, r), 'utf8')
  }
  return out
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=deck-install test', '-c', 'user.email=deck-install@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).toString('utf8')
}

function commitAll(f, message) {
  git(f.repo, 'add', '-A')
  git(f.repo, 'commit', '-q', '-m', message)
  return git(f.repo, 'rev-parse', 'HEAD').trim()
}

/**
 * A temp root holding: HOME and TMPDIR for the CLI, a git repository whose HEAD has the plugin, the deck's token
 * (0600, in a 0700 folder, as the deck makes it), a settings.json (`settings`: an object, a text, or null for none),
 * and the path of a release folder that doesn't exist yet. Removed after the test.
 */
function fixture(t, { settings = SETTINGS } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-install-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const f = {
    root,
    home: path.join(root, 'home'),
    tmp: path.join(root, 'tmp'),
    repo: path.join(root, 'repo'),
    plugin: path.join(root, 'repo', 'claude-code', 'plugin'),
    token: path.join(root, 'deck', 'run', 'token'),
    settings: path.join(root, 'config', 'settings.json'),
    release: path.join(root, 'release'),
    copy: path.join(root, 'release', 'streamdeck-bridge'),
    backups: path.join(root, 'release', 'backups'),
    calls: path.join(root, 'calls.log'),
  }
  for (const d of [f.home, f.tmp, path.dirname(f.settings)]) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.dirname(f.token), { recursive: true, mode: 0o700 })
  fs.writeFileSync(f.token, `${TOKEN}\n`, { mode: 0o600 })
  write(f.repo, REPO_FILES)
  write(f.plugin, PLUGIN)
  git(f.repo, 'init', '-q')
  f.head = commitAll(f, 'the plugin')
  if (settings !== null) fs.writeFileSync(f.settings, typeof settings === 'string' ? settings : json(settings))
  return f
}

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * A stand-in for Claude Code's binary. It notes how it was called in calls.log (its arguments, the names of the
 * variables it got, its HOME, TMPDIR and config folder, whether that folder was empty, and the manifest of the plugin
 * it was given), then prints as `plugin validate` does, naming the plugin's path, and exits with `code`.
 */
function fakeClaude(f, { code = 0 } = {}) {
  const bin = path.join(f.root, 'bin', 'claude')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  const verdict = code === 0
    ? "echo '✔ Validation passed'"
    : "echo '✘ Found 1 error:'\necho '  ❯ hooks/register.ts: the module failed to load'\necho '✘ Validation failed'"
  fs.writeFileSync(bin, `#!/bin/sh
{
  echo "args: $1 $2"
  echo "plugin: $3"
  echo "env: $(env | sed 's/=.*//' | grep -v -x -e PWD -e SHLVL -e _ | sort | tr '\\n' ' ')"
  echo "home: $HOME"
  echo "tmpdir: $TMPDIR"
  echo "config: $CLAUDE_CONFIG_DIR"
  echo "config empty: $([ -z "$(ls -A "$CLAUDE_CONFIG_DIR")" ] && echo yes || echo no)"
  echo "cwd: $(pwd -P)"
  echo "manifest: $(tr -d '\\n' < "$3/.claude-plugin/plugin.json")"
} >> ${shq(f.calls)}
echo "Validating plugin manifest: $3/.claude-plugin/plugin.json"
${verdict}
exit ${code}
`, { mode: 0o755 })
  return bin
}

/** The stand-in's calls, oldest first: one object per call, by the names in calls.log. */
function calls(f) {
  if (!fs.existsSync(f.calls)) return []
  const out = []
  for (const line of fs.readFileSync(f.calls, 'utf8').split('\n')) {
    const m = /^([a-z ]+): (.*)$/.exec(line)
    if (!m) continue
    if (m[1] === 'args') out.push({})
    out.at(-1)[m[1]] = m[2]
  }
  return out
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const modeOf = (file) => fs.statSync(file).mode & 0o777
const backups = (f) => (fs.existsSync(f.backups) ? fs.readdirSync(f.backups).sort().map((n) => path.join(f.backups, n)) : [])
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Fails when `text` holds a token, or any 8 characters in a row of one. */
function assertNoToken(text) {
  for (const token of [TOKEN, OLD_TOKEN]) {
    for (let i = 0; i + 8 <= token.length; i++) {
      const piece = token.slice(i, i + 8)
      if (text.includes(piece)) assert.fail(`the output holds ${piece}, 8 characters of a token:\n${text}`)
    }
  }
}

/** The CLI's environment: this one's, with HOME and TMPDIR in the fixture, no git config of the user's, and DECK_TOKEN set, as in a session after the install. */
function cliEnv(f) {
  const env = { ...process.env, HOME: f.home, TMPDIR: f.tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DECK_TOKEN: TOKEN }
  for (const k of ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_DIR_WATCH', 'CLAUDE_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return env
}

const flags = (f) => ['--settings', f.settings, '--token-file', f.token, '--release-dir', f.release, '--repo', f.repo]

/**
 * Runs deck-install.mjs with `args` and the fixture's four paths (none with `bare`): `{code, out, err, all}`. Fails the
 * test when the output holds a token, or when the run left anything in the fixture's HOME or TMPDIR.
 */
function cli(f, args, { bare = false, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, ...(bare ? [] : flags(f))], { env: cliEnv(f), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`deck-install didn't finish within ${timeoutMs} ms: ${out}${err}`))
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        assertNoToken(out + err)
        assert.deepEqual(fs.readdirSync(f.home), [], `${args[0]} wrote into HOME`)
        assert.deepEqual(fs.readdirSync(f.tmp), [], `${args[0]} left something in TMPDIR`)
      } catch (e) {
        reject(e)
        return
      }
      resolve({ code, out, err, all: out + err })
    })
  })
}

/** cli, which must exit with `code`. */
async function expectCode(f, args, code, opts) {
  const r = await cli(f, args, opts)
  assert.equal(r.code, code, `deck-install ${args.join(' ')} exited ${r.code}, not ${code}:\n${r.all}`)
  return r
}

const releaseFolder = (f) => fs.readdirSync(f.release).sort()

// ---- install and undo

test('install then undo: a settings file with many keys comes back byte for byte, key order and all', async (t) => {
  const f = fixture(t)
  const original = fs.readFileSync(f.settings)
  await expectCode(f, ['release', '--skip-validate'], 0)

  let r = await expectCode(f, ['install'], 0)
  const installed = readJson(f.settings)
  assert.deepEqual(Object.keys(installed), [...Object.keys(SETTINGS), 'env'], 'env goes last, every other key where it was')
  for (const k of Object.keys(SETTINGS)) assert.deepEqual(installed[k], SETTINGS[k], k)
  assert.deepEqual(installed.env, { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN })
  assert.equal(fs.readFileSync(f.settings, 'utf8'), json(installed), '2-space JSON with a trailing newline')
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: set to ${esc(f.copy)}$`, 'm'))
  assert.match(r.out, /^ {2}DECK_TOKEN: set \(64 characters\)$/m)
  assert.equal(backups(f).length, 1)
  assert.deepEqual(fs.readFileSync(backups(f)[0]), original, 'the backup is the file as it was')
  assert.match(path.basename(backups(f)[0]), /^settings\.\d{8}T\d{6}\.\d{3}Z\.json$/)
  assert.match(r.out, new RegExp(`^  backup: ${esc(backups(f)[0])} \\(0600\\)$`, 'm'))

  // Once more: nothing to change, so nothing written, and no backup.
  r = await expectCode(f, ['install'], 0)
  assert.match(r.out, /already installed: .* so nothing was written/)
  assert.equal(backups(f).length, 1)

  r = await expectCode(f, ['undo'], 0)
  assert.deepEqual(fs.readFileSync(f.settings), original, 'undo gives the file back byte for byte')
  assert.match(r.out, /^ {2}removed CLAUDE_CODE_PLUGIN_DIRS, which named the release copy$/m)
  assert.match(r.out, /^ {2}removed DECK_TOKEN$/m)
  assert.match(r.out, /^ {2}removed env, which held nothing else$/m)
  assert.equal(backups(f).length, 2)
  assert.equal(fs.readFileSync(backups(f)[1], 'utf8'), json(installed), 'the second backup is the installed file')

  r = await expectCode(f, ['undo'], 0)
  assert.match(r.out, /nothing to undo: .* so nothing was written/)
  assert.equal(backups(f).length, 2)
})

test('install and undo keep the other keys of an existing env, where they were', async (t) => {
  const withEnv = { model: 'opus', env: { EDITOR: 'vim', HTTPS_PROXY: 'http://proxy.invalid:8080' }, theme: 'dark' }
  const f = fixture(t, { settings: withEnv })
  const original = fs.readFileSync(f.settings)
  await expectCode(f, ['release', '--skip-validate'], 0)

  await expectCode(f, ['install'], 0)
  const installed = readJson(f.settings)
  assert.deepEqual(Object.keys(installed), ['model', 'env', 'theme'], 'env stays in its place')
  assert.deepEqual(Object.entries(installed.env), [['EDITOR', 'vim'], ['HTTPS_PROXY', 'http://proxy.invalid:8080'], ['CLAUDE_CODE_PLUGIN_DIRS', f.copy], ['DECK_TOKEN', TOKEN]])
  let r = await expectCode(f, ['undo'], 0)
  assert.deepEqual(fs.readFileSync(f.settings), original, "undo leaves env with its own keys, as it was")
  assert.doesNotMatch(r.out, /removed env/)

  // A DECK_TOKEN that's out of date is replaced where it is; undo removes it all the same.
  fs.writeFileSync(f.settings, json({ env: { DECK_TOKEN: OLD_TOKEN, EDITOR: 'vim' } }))
  r = await expectCode(f, ['install'], 0)
  assert.match(r.out, /^ {2}DECK_TOKEN: set \(64 characters\), replacing a value that didn't match the deck's token$/m)
  assert.deepEqual(Object.entries(readJson(f.settings).env), [['DECK_TOKEN', TOKEN], ['EDITOR', 'vim'], ['CLAUDE_CODE_PLUGIN_DIRS', f.copy]])
  await expectCode(f, ['undo'], 0)
  assert.deepEqual(readJson(f.settings), { env: { EDITOR: 'vim' } })
})

test('install refuses settings that are not valid JSON, and another CLAUDE_CODE_PLUGIN_DIRS unless --force', async (t) => {
  const f = fixture(t)
  await expectCode(f, ['release', '--skip-validate'], 0)

  // Not JSON: a hand edit that left the token unquoted, which a parse error would quote.
  const broken = `{\n  "model": "opus",\n  "env": {\n    "DECK_TOKEN": ${TOKEN}\n  }\n}\n`
  fs.writeFileSync(f.settings, broken)
  for (const command of ['install', 'undo']) {
    const r = await expectCode(f, [command], 1)
    assert.match(r.err, new RegExp(`${esc(f.settings)} isn't valid JSON, so it's left as it is`))
    assert.equal(fs.readFileSync(f.settings, 'utf8'), broken)
  }

  // JSON, but not what a settings.json holds; and no file at all.
  for (const [text, why] of [['[]\n', /is JSON, but not an object/], ['{\n  "env": "on"\n}\n', /env in .* isn't an object/]]) {
    fs.writeFileSync(f.settings, text)
    const r = await expectCode(f, ['install'], 1)
    assert.match(r.err, why)
    assert.equal(fs.readFileSync(f.settings, 'utf8'), text)
  }
  fs.rmSync(f.settings)
  let r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /no settings file at .*settings\.json, so it's left as it is/)
  assert.equal(fs.existsSync(f.settings), false, 'none is made')
  assert.deepEqual(backups(f), [], 'no backup of a file that was not changed')

  // Another CLAUDE_CODE_PLUGIN_DIRS: refused and left alone; --force replaces it, and says where the old one is.
  const other = json({ model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: '/Users/someone/other-plugins' } })
  fs.writeFileSync(f.settings, other)
  r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /already has CLAUDE_CODE_PLUGIN_DIRS, set to \/Users\/someone\/other-plugins, not the release copy\. Pass --force to replace it/)
  assert.equal(fs.readFileSync(f.settings, 'utf8'), other)
  assert.deepEqual(backups(f), [])
  r = await expectCode(f, ['install', '--force'], 0)
  assert.deepEqual(readJson(f.settings).env, { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN })
  assert.match(r.out, /replacing another value \(--force\)\. The backup keeps the old one/)
  assert.equal(fs.readFileSync(backups(f)[0], 'utf8'), other)

  // A rewrite that would change the file elsewhere: a key given twice, a key that's a number, a number written
  // another way. Refused untouched; --force rewrites it.
  for (const text of ['{\n  "model": "opus",\n  "model": "sonnet"\n}\n', '{\n  "b": 1,\n  "2": 2\n}\n', '{\n  "ratio": 1.0\n}\n']) {
    fs.writeFileSync(f.settings, text)
    r = await expectCode(f, ['install'], 1)
    assert.match(r.err, /would change more than its env: .* pass --force to rewrite it anyway/)
    assert.equal(fs.readFileSync(f.settings, 'utf8'), text)
  }
  const n = backups(f).length
  r = await expectCode(f, ['install', '--force'], 0)
  assert.match(r.out, /rewriting it anyway \(--force\)/)
  assert.deepEqual(readJson(f.settings), { ratio: 1, env: { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN } })
  assert.equal(fs.readFileSync(backups(f)[n], 'utf8'), '{\n  "ratio": 1.0\n}\n')
})

test("install needs a current release copy and a token the deck takes", async (t) => {
  const f = fixture(t)
  const original = fs.readFileSync(f.settings)
  let r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /there's no release copy at .*streamdeck-bridge: run release first/)

  // A commit to the plugin makes the copy stale until the next release.
  await expectCode(f, ['release', '--skip-validate'], 0)
  fs.writeFileSync(path.join(f.plugin, 'hooks', 'register.ts'), 'export default function register() { return 2 }\n')
  commitAll(f, 'a change')
  r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /the release copy at .* differs from claude-code\/plugin at HEAD \(1 changed\): run release first/)
  await expectCode(f, ['release', '--skip-validate'], 0)

  // The token: no file, then a file the deck would replace.
  fs.rmSync(f.token)
  r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /can't read the deck's token at .*token: ENOENT/)
  for (const text of ['not a token\n', `${TOKEN.slice(0, 63)}\n`, `${TOKEN.toUpperCase()}\n`]) {
    fs.writeFileSync(f.token, text)
    r = await expectCode(f, ['install'], 1)
    assert.match(r.err, /doesn't hold a token the deck takes \(64 lowercase hex characters\)/)
  }
  assert.deepEqual(fs.readFileSync(f.settings), original)
  assert.deepEqual(backups(f), [])
})

test("install and undo keep settings.json's mode, write backups 0600, and leave no temp file beside it", async (t) => {
  const f = fixture(t)
  const original = fs.readFileSync(f.settings)
  fs.chmodSync(f.settings, 0o640)
  await expectCode(f, ['release', '--skip-validate'], 0)

  await expectCode(f, ['install'], 0)
  assert.equal(modeOf(f.settings), 0o640)
  await expectCode(f, ['undo'], 0)
  assert.equal(modeOf(f.settings), 0o640)
  assert.deepEqual(fs.readFileSync(f.settings), original)
  assert.deepEqual(fs.readdirSync(path.dirname(f.settings)), ['settings.json'], 'no temp file left beside it')
  assert.equal(backups(f).length, 2)
  for (const b of backups(f)) assert.equal(modeOf(b), 0o600, b)
  assert.equal(modeOf(f.backups), 0o700)

  // A settings.json that's a link: the link stays, and its target is written with its own mode.
  const real = path.join(f.root, 'dotfiles', 'claude-settings.json')
  fs.mkdirSync(path.dirname(real))
  fs.renameSync(f.settings, real)
  fs.symlinkSync(real, f.settings)
  fs.chmodSync(real, 0o600)
  const r = await expectCode(f, ['install'], 0)
  assert.match(r.out, /a link to .*claude-settings\.json, which is what's written/)
  assert.ok(fs.lstatSync(f.settings).isSymbolicLink(), 'still a link')
  assert.deepEqual(readJson(real).env, { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN })
  assert.equal(modeOf(real), 0o600)
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ['claude-settings.json'])
  await expectCode(f, ['undo'], 0)
  assert.ok(fs.lstatSync(f.settings).isSymbolicLink(), 'still a link')
  assert.deepEqual(fs.readFileSync(real), original)
  for (const b of backups(f)) assert.equal(modeOf(b), 0o600, b)
})

// ---- release

test("release refuses uncommitted changes in claude-code/plugin, and copies only what HEAD has there", async (t) => {
  const f = fixture(t)
  const register = path.join(f.plugin, 'hooks', 'register.ts')

  // A change to a tracked file, an untracked file, a staged change: each refused, with no copy made.
  const dirty = [
    ['a change', () => fs.appendFileSync(register, '// edited\n'), 'M claude-code/plugin/hooks/register.ts'],
    ['a new file', () => fs.writeFileSync(path.join(f.plugin, 'hooks', 'new.ts'), 'x\n'), '?? claude-code/plugin/hooks/new.ts'],
    ['a staged change', () => { fs.appendFileSync(register, '// staged\n'); git(f.repo, 'add', '-A') }, 'M  claude-code/plugin/hooks/register.ts'],
  ]
  for (const [what, make, line] of dirty) {
    make()
    const r = await expectCode(f, ['release', '--skip-validate'], 1)
    assert.match(r.err, /claude-code\/plugin has uncommitted changes, and a release takes only what's committed/, what)
    assert.ok(r.err.includes(line), `${what}: ${r.err}`)
    assert.equal(fs.existsSync(f.release), false, `${what}: nothing made`)
    git(f.repo, 'reset', '-q', '--hard', 'HEAD')
    git(f.repo, 'clean', '-q', '-fd')
  }

  // A change elsewhere in the repository doesn't count, and what's outside claude-code/plugin isn't copied.
  fs.appendFileSync(path.join(f.repo, 'claude-code', 'other', 'notes.txt'), 'edited\n')
  const r = await expectCode(f, ['release', '--skip-validate'], 0)
  assert.match(r.out, /^ {2}plugin validate: skipped \(--skip-validate\)$/m)
  assert.match(r.out, /^No previous copy: 6 files, all new\.$/m)
  assert.deepEqual(tree(f.copy), PLUGIN)
  assert.deepEqual(releaseFolder(f), ['RELEASE.json', 'streamdeck-bridge'])
  const info = readJson(path.join(f.release, 'RELEASE.json'))
  assert.deepEqual(Object.keys(info), ['commit', 'time', 'version'])
  assert.equal(info.commit, f.head)
  assert.equal(info.version, '0.1.0')
  assert.ok(Math.abs(Date.parse(info.time) - Date.now()) < 60_000, info.time)
  assert.equal(new Date(info.time).toISOString(), info.time, 'an ISO time')
})

test('release validates with the newest Claude Code the app bundles, found by version and build, unless --claude names one', async (t) => {
  const f = fixture(t)
  const root = path.join(f.root, 'claude-code')
  const bin = fakeClaude(f, { code: 0 })
  const build = (version, name, { executable = true } = {}) => {
    const file = path.join(root, version, name, 'claude.app', 'Contents', 'MacOS', 'claude')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(bin, file)
    fs.chmodSync(file, executable ? 0o755 : 0o644)
    return file
  }

  // No version folder, or none with an executable build: refused, and the copy isn't made.
  fs.mkdirSync(root)
  let r = await expectCode(f, ['release', '--claude-code-root', root], 1)
  assert.match(r.err, /no Claude Code to validate with: no version folder in .*claude-code\. Pass --claude FILE/)
  build('2.1.400', 'abc', { executable: false })
  r = await expectCode(f, ['release', '--claude-code-root', root], 1)
  assert.match(r.err, /no executable claude in .*2\.1\.400\/\*\/claude\.app\/Contents\/MacOS\//)
  assert.equal(fs.existsSync(f.copy), false)
  assert.equal(calls(f).length, 0)

  // By number, 2.1.400 is the newest of 2.1.40, 2.1.309 and 2.1.400, and its executable build is the one used.
  build('2.1.40', 'old')
  build('2.1.309', 'mid')
  const newest = build('2.1.400', 'def')
  fs.mkdirSync(path.join(root, 'not-a-version'))
  r = await expectCode(f, ['release', '--claude-code-root', root], 0)
  assert.match(r.out, /^ {2}plugin validate \(Claude Code 2\.1\.400\): passed$/m)
  assert.deepEqual(DI.newestClaudeCode(root), { version: '2.1.400', binary: newest })
  assert.equal(calls(f).length, 1)

  // --claude wins over the folder.
  r = await expectCode(f, ['release', '--claude', bin, '--claude-code-root', path.join(f.root, 'nowhere')], 0)
  assert.match(r.out, /^ {2}plugin validate \(.*bin\/claude\): passed$/m)
})

test('release keeps the previous copy when plugin validate fails, and swaps when it passes', async (t) => {
  const f = fixture(t)
  const bin = fakeClaude(f, { code: 0 })
  let r = await expectCode(f, ['release', '--claude', bin], 0)
  assert.match(r.out, /^ {2}plugin validate \(.*claude\): passed$/m)

  // What the validator got: the new copy, inside the release folder, and nothing of this machine's setup.
  let c = calls(f)
  assert.equal(c.length, 1)
  assert.equal(c[0].args, 'plugin validate')
  assert.ok(c[0].plugin.startsWith(path.join(f.release, '.release-')), c[0].plugin)
  assert.match(c[0].manifest, /"version": "0\.1\.0"/)
  assert.equal(c[0].env, 'CLAUDE_CONFIG_DIR HOME NO_COLOR PATH TMPDIR ', 'only PATH from here, with its own HOME, TMPDIR and config folder')
  for (const k of ['home', 'tmpdir', 'config', 'cwd']) assert.ok(c[0][k].startsWith(`${f.tmp}/deck-install-validate-`), `${k}: ${c[0][k]}`)
  assert.equal(c[0]['config empty'], 'yes')
  const first = tree(f.copy)
  const firstInfo = readJson(path.join(f.release, 'RELEASE.json'))

  // A commit that changes, adds and removes files, then a validator that fails: the first copy stays.
  write(f.plugin, {
    'hooks/register.ts': 'export default function register() { return 2 }\n',
    'hooks/new.ts': 'export const NEW = 1\n',
    '.claude-plugin/plugin.json': json({ name: 'streamdeck-bridge', version: '0.2.0', description: 'fixture' }),
  })
  fs.rmSync(path.join(f.plugin, 'hooks', 'bridge.ts'))
  const second = commitAll(f, 'the plugin, changed')
  fakeClaude(f, { code: 1 })
  r = await expectCode(f, ['release', '--claude', bin], 1)
  assert.match(r.err, /plugin validate \(.*claude\) failed \(exit 1\), so the release copy stays as it was:/)
  assert.match(r.err, /✘ Validation failed/)
  assert.match(r.err, /Validating plugin manifest: <new copy>\/\.claude-plugin\/plugin\.json/, "the temp copy's path is named, not printed")
  assert.deepEqual(tree(f.copy), first)
  assert.deepEqual(readJson(path.join(f.release, 'RELEASE.json')), firstInfo)
  assert.deepEqual(releaseFolder(f), ['RELEASE.json', 'streamdeck-bridge'], 'no temp folder left')
  r = await expectCode(f, ['release', '--claude', path.join(f.root, 'no-such-claude')], 1)
  assert.match(r.err, /plugin validate \(.*no-such-claude\) failed \(exit 127\)|couldn't run: ENOENT/)
  assert.deepEqual(tree(f.copy), first)

  // A validator that passes: the new copy goes in, with what changed.
  fakeClaude(f, { code: 0 })
  r = await expectCode(f, ['release', '--claude', bin], 0)
  assert.equal(calls(f).length, 3)
  assert.deepEqual(tree(f.copy), tree(f.plugin), 'the copy is the plugin as committed')
  assert.equal(readJson(path.join(f.release, 'RELEASE.json')).commit, second)
  assert.equal(readJson(path.join(f.release, 'RELEASE.json')).version, '0.2.0')
  assert.match(r.out, new RegExp(`^Changes from the previous copy \\(released from ${f.head.slice(0, 7)}\\): 2 changed, 1 removed, 1 added$`, 'm'))
  assert.match(r.out, /^ {4}added {4}hooks\/new\.ts$/m)
  assert.match(r.out, /^ {4}changed {2}\.claude-plugin\/plugin\.json$/m)
  assert.match(r.out, /^ {4}changed {2}hooks\/register\.ts$/m)
  assert.match(r.out, /^ {4}removed {2}hooks\/bridge\.ts$/m)
  assert.deepEqual(releaseFolder(f), ['RELEASE.json', 'streamdeck-bridge'])

  // What the engine and the Finder left in the old copy isn't counted as removed.
  write(f.copy, { '.claude-plugin/types/claude-code/index.d.ts': 'declare const $: unknown\n', 'tsconfig.json': '{}\n', 'cache/x': 'x\n', '.DS_Store': 'x' })
  r = await expectCode(f, ['release', '--claude', bin], 0)
  assert.match(r.out, /^No change from the previous copy \(released from .{7}\)\.$/m)
  assert.equal(fs.existsSync(path.join(f.copy, 'tsconfig.json')), false, 'the new copy is clean')
})

// ---- status

test('status: installed and current whatever the engine writes into the copy; stale when the copy or HEAD moves', async (t) => {
  const f = fixture(t)
  let r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^release copy: .*streamdeck-bridge\n {2}none: run release$/m)
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIRS: not set$/m)
  assert.match(r.out, /^ {2}DECK_TOKEN: not set$/m)
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIR_WATCH: not in env$/m)
  assert.match(r.out, /^claude-code\/plugin: no uncommitted changes$/m)
  assert.match(r.out, /^not installed and current: there is no release copy; CLAUDE_CODE_PLUGIN_DIRS isn't set; DECK_TOKEN isn't set$/m)

  await expectCode(f, ['release', '--skip-validate'], 0)
  await expectCode(f, ['install'], 0)
  r = await expectCode(f, [], 0) // status is the default
  assert.match(r.out, new RegExp(`^ {2}current: equals claude-code/plugin at HEAD, 6 files; version 0\\.1\\.0, released .* from ${f.head.slice(0, 7)}$`, 'm'))
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIRS: set, names the release copy$/m)
  assert.match(r.out, /^ {2}DECK_TOKEN: set, matches the deck's token$/m)
  assert.match(r.out, /^installed and current$/m)

  // What the engine writes into a folder it loads, and what git ignores in claude-code/plugin, isn't the plugin's.
  write(f.copy, {
    '.claude-plugin/types/claude-code/index.d.ts': 'declare const $: unknown\n',
    '.claude-plugin/types/.gitignore': '*\n',
    '.claude-plugin/types/tsconfig.json': '{}\n',
    'tsconfig.json': '{ "extends": "./.claude-plugin/types/tsconfig.json" }\n',
    'cache/state.bin': "ignored by the plugin's own .gitignore\n",
    'hooks/.DS_Store': "ignored by the repository's\n",
  })
  r = await expectCode(f, ['status'], 0)
  assert.match(r.out, /^installed and current$/m)

  // A file changed, one too many, one missing, an executable bit: each makes it stale, and says which.
  const inCopy = (rel) => path.join(f.copy, rel)
  const cases = [
    ['1 changed', /^ {4}changed {2}hooks\/register\.ts$/m, () => fs.appendFileSync(inCopy('hooks/register.ts'), '// edited\n'), () => fs.writeFileSync(inCopy('hooks/register.ts'), PLUGIN['hooks/register.ts'])],
    ['1 extra', /^ {4}extra {4}hooks\/extra\.ts$/m, () => fs.writeFileSync(inCopy('hooks/extra.ts'), 'x\n'), () => fs.rmSync(inCopy('hooks/extra.ts'))],
    ['1 missing', /^ {4}missing {2}hooks\/bridge\.ts$/m, () => fs.rmSync(inCopy('hooks/bridge.ts')), () => fs.writeFileSync(inCopy('hooks/bridge.ts'), PLUGIN['hooks/bridge.ts'])],
    ['1 changed', /^ {4}changed {2}hooks\/bridge\.ts$/m, () => fs.chmodSync(inCopy('hooks/bridge.ts'), 0o755), () => fs.chmodSync(inCopy('hooks/bridge.ts'), 0o644)],
  ]
  for (const [counts, line, make, undoIt] of cases) {
    make()
    r = await expectCode(f, ['status'], 1)
    assert.match(r.out, new RegExp(`^ {2}stale: differs from claude-code/plugin at HEAD \\(${counts}\\);`, 'm'))
    assert.match(r.out, line)
    assert.match(r.out, /^not installed and current: the release copy is stale: run release$/m)
    undoIt()
    await expectCode(f, ['status'], 0)
  }

  // A commit to the plugin makes it stale until the next release; an uncommitted change is only reported.
  fs.appendFileSync(path.join(f.plugin, 'hooks', 'bridge.ts'), 'export const HOST = "127.0.0.1"\n')
  commitAll(f, 'a change')
  r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^ {2}stale: differs from claude-code\/plugin at HEAD \(1 changed\);/m)
  await expectCode(f, ['release', '--skip-validate'], 0)
  fs.appendFileSync(path.join(f.plugin, 'hooks', 'register.ts'), '// mid-edit\n')
  r = await expectCode(f, ['status'], 0)
  assert.match(r.out, /^claude-code\/plugin: uncommitted changes in 1 file, which reach sessions only once committed and released\n {5}M claude-code\/plugin\/hooks\/register\.ts$/m)
  git(f.repo, 'checkout', '-q', '--', '.')

  // A token the deck has replaced.
  fs.writeFileSync(f.token, `${OLD_TOKEN}\n`)
  r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^ {2}DECK_TOKEN: set, doesn't match the deck's token$/m)
  assert.match(r.out, /^not installed and current: DECK_TOKEN doesn't match the deck's token$/m)
  fs.writeFileSync(f.token, `${TOKEN}\n`)

  // CLAUDE_CODE_PLUGIN_DIR_WATCH in env, even at 0, counts against it, and undo leaves it there.
  fs.writeFileSync(f.settings, json({ ...readJson(f.settings), env: { ...readJson(f.settings).env, CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' } }))
  r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIR_WATCH: in env, which the route never sets/m)
  assert.match(r.out, /^not installed and current: CLAUDE_CODE_PLUGIN_DIR_WATCH is in env$/m)
  r = await expectCode(f, ['undo'], 0)
  assert.match(r.out, /left CLAUDE_CODE_PLUGIN_DIR_WATCH in env/)
  assert.deepEqual(readJson(f.settings).env, { CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' })
})

// ---- the token

test('the token never reaches the output: matched, mismatched, installed, replaced, removed or refused', async (t) => {
  assert.match(TOKEN, /^[0-9a-f]{64}$/)
  assert.match(OLD_TOKEN, /^[0-9a-f]{64}$/)
  const f = fixture(t, { settings: { model: 'opus', env: { DECK_TOKEN: OLD_TOKEN } } })
  const outputs = []
  const step = async (args, code) => {
    const r = await expectCode(f, args, code)
    outputs.push(r.all)
    return r
  }

  let r = await step(['status'], 1)
  assert.match(r.out, /^ {2}DECK_TOKEN: set, doesn't match the deck's token$/m)
  await step(['release', '--skip-validate'], 0)
  r = await step(['install'], 0)
  assert.match(r.out, /DECK_TOKEN: set \(64 characters\), replacing a value/)
  r = await step(['status'], 0)
  assert.match(r.out, /^ {2}DECK_TOKEN: set, matches the deck's token$/m)

  // The deck makes a new token: the settings' one is out of date until the next install.
  fs.writeFileSync(f.token, `${OLD_TOKEN}\n`)
  await step(['status'], 1)
  await step(['install'], 0)
  await step(['status'], 0)
  await step(['undo'], 0)

  // Settings with the token unquoted, which a JSON parse error would quote: refused without it.
  fs.writeFileSync(f.settings, `{\n  "model": "opus",\n  "env": {\n    "DECK_TOKEN": ${TOKEN}\n  }\n}\n`)
  for (const command of ['install', 'undo', 'status']) {
    r = await step([command], 1)
    assert.match(r.all, /isn't valid JSON/)
  }

  // The backups hold the token, as they must to give the file back; no output does (cli checks each).
  assert.ok(backups(f).some((b) => fs.readFileSync(b, 'utf8').includes(TOKEN)))
  assert.equal(outputs.length, 11)
  for (const text of outputs) assertNoToken(text)
})

// ---- the command line

test('usage: one known command at most; the defaults come from HOME and --repo; --repo is the top of a repository', async (t) => {
  const f = fixture(t)
  for (const args of [['bogus'], ['status', 'install'], ['--nope'], ['status', '--settings', '']]) {
    const r = await expectCode(f, args, 2, { bare: true })
    assert.match(r.err, /^usage: node claude-code\/install\/deck-install\.mjs/m, args.join(' '))
  }
  let r = await expectCode(f, ['--help'], 0, { bare: true })
  assert.match(r.out, /^usage: /)

  // With only --repo, the settings are HOME's (the fixture's here), and the token and the release folder the repository's.
  r = await expectCode(f, ['status', '--repo', f.repo], 1, { bare: true })
  assert.match(r.out, /^settings: no settings file at ~\/\.claude\/settings\.json$/m)
  assert.ok(r.out.includes(`release copy: ${path.join(f.repo, 'claude-code', 'release', 'streamdeck-bridge')}\n`), r.out)
  assert.ok(r.out.includes(`deck token: ${path.join(f.repo, 'claude-code', 'deck', 'com.karimdhanji.claude.sdPlugin', 'run', 'token')}: can't read`), r.out)

  // A folder inside the repository isn't the repository: claude-code/plugin is found from the top.
  r = await expectCode(f, ['release', '--skip-validate', '--repo', f.plugin, '--release-dir', f.release], 1, { bare: true })
  assert.match(r.err, /isn't the top of its repository/)
  assert.equal(fs.existsSync(f.release), false)
})
