// deck-install.mjs against fixtures each test makes in a temp folder: a throwaway git repository holding a plugin, a
// token file, a settings.json, a release folder and a stand-in for Claude Code's binary. Every run of the CLI gets them
// all as flags, with HOME and TMPDIR inside the temp folder too, so a flag left out lands there: never on the real
// ~/.claude, the deck's real token or this repository's release folder. After every run, the output is checked for
// the fake tokens and any 8 characters of them, and the fixture's HOME and TMPDIR for anything left behind.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was not set, now ${esc(f.copy)}$`, 'm'))
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
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(f.copy)}, now removed$`, 'm'))
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

test("install refuses settings that are not valid JSON, and a CLAUDE_CODE_PLUGIN_DIRS that isn't text unless --force", async (t) => {
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

  // JSON, but not what a settings.json holds.
  for (const [text, why] of [['[]\n', /is JSON, but not an object/], ['{\n  "env": "on"\n}\n', /env in .* isn't an object/]]) {
    fs.writeFileSync(f.settings, text)
    const r = await expectCode(f, ['install'], 1)
    assert.match(r.err, why)
    assert.equal(fs.readFileSync(f.settings, 'utf8'), text)
  }
  assert.deepEqual(backups(f), [], 'no backup of a file that was not changed')

  // A CLAUDE_CODE_PLUGIN_DIRS that isn't a list of folders: refused and left alone; --force replaces it, and says
  // where the old one is. undo leaves such a value as it is.
  const other = json({ model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: ['/Users/someone/other-plugins'] } })
  fs.writeFileSync(f.settings, other)
  let r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIRS: set to a list, not a list of folders$/m)
  r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /has CLAUDE_CODE_PLUGIN_DIRS set to a list, not a list of folders\. Pass --force to replace it/)
  assert.equal(fs.readFileSync(f.settings, 'utf8'), other)
  assert.deepEqual(backups(f), [])
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: true, DECK_TOKEN: TOKEN } }))
  r = await expectCode(f, ['undo'], 0)
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIRS: unchanged, a boolean$/m)
  assert.deepEqual(readJson(f.settings), { env: { CLAUDE_CODE_PLUGIN_DIRS: true } })
  fs.writeFileSync(f.settings, other)
  const n0 = backups(f).length
  r = await expectCode(f, ['install', '--force'], 0)
  assert.deepEqual(readJson(f.settings).env, { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN })
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was a list, now ${esc(f.copy)}$`, 'm'))
  assert.equal(fs.readFileSync(backups(f)[n0], 'utf8'), other)

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

test('install makes settings.json when there is none: {}, 0600, and its folder 0700 when that is missing too', async (t) => {
  const f = fixture(t, { settings: null })
  let r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /there's no release copy/)
  assert.equal(fs.existsSync(f.settings), false, 'a refused install makes nothing')
  await expectCode(f, ['release', '--skip-validate'], 0)

  // No file, in a folder that's there: the file is made, and the folder is left as it was.
  const folderMode = modeOf(path.dirname(f.settings))
  r = await expectCode(f, ['install'], 0)
  assert.match(r.out, /^ {2}made it, as there was none: \{\}, 0600$/m)
  assert.match(r.out, /^ {2}backup: none, as this run made the file$/m)
  assert.equal(modeOf(f.settings), 0o600)
  assert.equal(modeOf(path.dirname(f.settings)), folderMode)
  assert.deepEqual(readJson(f.settings), { env: { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN } })
  assert.deepEqual(backups(f), [])
  await expectCode(f, ['status'], 0)
  r = await expectCode(f, ['undo'], 0)
  assert.equal(fs.readFileSync(f.settings, 'utf8'), '{}\n', 'undo leaves {}')
  assert.equal(modeOf(f.settings), 0o600)
  assert.equal(backups(f).length, 1, 'undo backs up the file it changes')

  // No folder either, as ~/.claude on a Mac where Claude Code hasn't run yet: both are made.
  const settings = path.join(f.root, 'newhome', '.claude', 'settings.json')
  fs.mkdirSync(path.join(f.root, 'newhome'))
  const at = (command) => [command, '--settings', settings, '--token-file', f.token, '--release-dir', f.release, '--repo', f.repo]
  r = await expectCode(f, at('install'), 0, { bare: true })
  assert.match(r.out, /^ {2}made it, as there was none: \{\}, 0600, and its folder, 0700$/m)
  assert.equal(modeOf(path.dirname(settings)), 0o700)
  assert.equal(modeOf(settings), 0o600)
  assert.deepEqual(readJson(settings), { env: { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN } })
  await expectCode(f, at('status'), 0, { bare: true })

  // A link to a file that isn't there, as a dotfiles link before its repository is cloned: refused, and nothing made.
  fs.rmSync(f.settings)
  fs.symlinkSync(path.join(f.root, 'dotfiles', 'claude', 'settings.json'), f.settings)
  r = await expectCode(f, ['install'], 1)
  assert.match(r.err, /settings\.json is a link to .*dotfiles\/claude\/settings\.json, which doesn't exist, so it's left as it is$/m)
  r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^settings: .*settings\.json is a link to .*dotfiles\/claude\/settings\.json, which doesn't exist$/m)
  assert.equal(fs.existsSync(path.join(f.root, 'dotfiles')), false)
})

test('install adds the release copy to the folders already in CLAUDE_CODE_PLUGIN_DIRS, once, and undo takes out only it', async (t) => {
  const f = fixture(t)
  await expectCode(f, ['release', '--skip-validate'], 0)
  const a = '/Users/someone/plugins/a'
  const b = '~/plugins/b'
  for (const before of [a, `${a}:${b}`]) {
    const text = json({ model: 'opus', env: { EDITOR: 'vim', CLAUDE_CODE_PLUGIN_DIRS: before } })
    fs.writeFileSync(f.settings, text)
    let r = await expectCode(f, ['status'], 1)
    assert.match(r.out, new RegExp(`^ {2}CLAUDE_CODE_PLUGIN_DIRS: set, but not to the release copy: ${esc(before)}$`, 'm'))
    r = await expectCode(f, ['install'], 0)
    assert.deepEqual(Object.entries(readJson(f.settings).env), [['EDITOR', 'vim'], ['CLAUDE_CODE_PLUGIN_DIRS', `${before}:${f.copy}`], ['DECK_TOKEN', TOKEN]])
    assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(before)}, now ${esc(`${before}:${f.copy}`)}$`, 'm'))
    r = await expectCode(f, ['status'], 0)
    assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIRS: set, names the release copy, beside (1 other folder|2 other folders)$/m)
    r = await expectCode(f, ['install'], 0)
    assert.match(r.out, /already installed: .* so nothing was written/)
    r = await expectCode(f, ['undo'], 0)
    assert.equal(fs.readFileSync(f.settings, 'utf8'), text, 'undo takes out the release copy alone: the file comes back byte for byte')
    assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(`${before}:${f.copy}`)}, now ${esc(before)}$`, 'm'))
  }

  // Named already, among others: nothing to change. Named twice: once, where it was first.
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${a}:${f.copy}:${b}`, DECK_TOKEN: TOKEN } }))
  let r = await expectCode(f, ['install'], 0)
  assert.match(r.out, /already installed/)
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${f.copy}:${a}:${f.copy}`, DECK_TOKEN: TOKEN } }))
  r = await expectCode(f, ['status'], 1)
  assert.match(r.out, /^ {2}CLAUDE_CODE_PLUGIN_DIRS: set, names the release copy 2 times, beside 1 other folder$/m)
  r = await expectCode(f, ['install'], 0)
  assert.equal(readJson(f.settings).env.CLAUDE_CODE_PLUGIN_DIRS, `${f.copy}:${a}`)
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(`${f.copy}:${a}:${f.copy}`)}, now ${esc(`${f.copy}:${a}`)}$`, 'm'))
  await expectCode(f, ['status'], 0)

  // Empty entries don't count, and an empty value names no folder; undo drops the key once nothing's left in it.
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${a}::${f.copy}:`, DECK_TOKEN: TOKEN } }))
  await expectCode(f, ['status'], 0)
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: '', DECK_TOKEN: TOKEN } }))
  r = await expectCode(f, ['install'], 0)
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was empty, now ${esc(f.copy)}$`, 'm'))
  r = await expectCode(f, ['undo'], 0)
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(f.copy)}, now removed$`, 'm'))
  assert.deepEqual(readJson(f.settings), {})

  // A release folder whose path has the separator: refused, as the list can't hold it.
  const colon = path.join(f.root, 're:lease')
  const at = (command, ...more) => [command, ...more, '--settings', f.settings, '--token-file', f.token, '--release-dir', colon, '--repo', f.repo]
  await expectCode(f, at('release', '--skip-validate'), 0, { bare: true })
  r = await expectCode(f, at('install'), 1, { bare: true })
  assert.match(r.err, /the release copy's path, .*re:lease\/streamdeck-bridge, has a ':', which separates the folders in CLAUDE_CODE_PLUGIN_DIRS: clone the repository to a path without one/)
  assert.deepEqual(readJson(f.settings), {})
})

test('install puts the release copy in place of another copy of streamdeck-bridge, and undo takes out both', async (t) => {
  const f = fixture(t)
  await expectCode(f, ['release', '--skip-validate'], 0)
  const a = '/Users/someone/plugins/a'
  // A release copy left where an old clone was, gone, so known by its name; and the dev copy, known by its manifest.
  const old = '/Users/someone/old-clone/claude-code/release/streamdeck-bridge'
  // A folder of that name whose manifest names another plugin is that plugin.
  const namesake = path.join(f.root, 'elsewhere', 'streamdeck-bridge')
  write(namesake, { '.claude-plugin/plugin.json': json({ name: 'someone-elses' }) })
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${a}:${old}:${namesake}:${f.plugin}`, DECK_TOKEN: TOKEN } }))
  let r = await expectCode(f, ['status'], 1)
  for (const copy of [old, f.plugin]) assert.match(r.out, new RegExp(`^ {4}and another copy of streamdeck-bridge, which a session would load too: ${esc(copy)}$`, 'm'))
  assert.doesNotMatch(r.out, new RegExp(`load too: ${esc(namesake)}`))
  assert.match(r.out, /^not installed and current: CLAUDE_CODE_PLUGIN_DIRS doesn't name the release copy; CLAUDE_CODE_PLUGIN_DIRS names another copy of streamdeck-bridge: run install$/m)
  r = await expectCode(f, ['install'], 0)
  assert.equal(readJson(f.settings).env.CLAUDE_CODE_PLUGIN_DIRS, `${a}:${f.copy}:${namesake}`, "in the first copy's place")
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(`${a}:${old}:${namesake}:${f.plugin}`)}, now ${esc(`${a}:${f.copy}:${namesake}`)}$`, 'm'))
  await expectCode(f, ['status'], 0)

  // Beside the release copy, another copy just goes, and the release copy stays where it was.
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${old}:${a}:${f.copy}`, DECK_TOKEN: TOKEN } }))
  await expectCode(f, ['install'], 0)
  assert.equal(readJson(f.settings).env.CLAUDE_CODE_PLUGIN_DIRS, `${a}:${f.copy}`)

  // undo takes out the release copy and another copy, and keeps the rest; with only another copy, it takes that out.
  fs.writeFileSync(f.settings, json({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${f.copy}:${old}:${a}`, DECK_TOKEN: TOKEN } }))
  r = await expectCode(f, ['undo'], 0)
  assert.deepEqual(readJson(f.settings), { env: { CLAUDE_CODE_PLUGIN_DIRS: a } })
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(`${f.copy}:${old}:${a}`)}, now ${esc(a)}$`, 'm'))
  fs.writeFileSync(f.settings, json({ model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: old } }))
  r = await expectCode(f, ['undo'], 0)
  assert.deepEqual(readJson(f.settings), { model: 'opus' })
  assert.match(r.out, new RegExp(`^  CLAUDE_CODE_PLUGIN_DIRS: was ${esc(old)}, now removed$`, 'm'))
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

// ---- setup

/**
 * setup's fixture: fixture's, without settings.json or its folder; the deck's npm project in the repository, committed,
 * without its token, log or node_modules yet; the Stream Deck app and its plugins folder, without the link; and a
 * Claude Code the Claude app bundles, all in the temp root. setup takes the token and the log from the repository, as
 * on a Mac.
 */
function setupFixture(t) {
  const f = fixture(t, { settings: null })
  f.settings = path.join(f.root, 'newhome', '.claude', 'settings.json')
  fs.mkdirSync(path.join(f.root, 'newhome'))
  f.deck = path.join(f.repo, 'claude-code', 'deck')
  f.lock = path.join(f.deck, 'package-lock.json')
  f.stamp = path.join(f.deck, 'node_modules', '.deck-install-lock.sha256')
  f.deckToken = path.join(f.deck, 'com.karimdhanji.claude.sdPlugin', 'run', 'token')
  f.deckLog = path.join(f.deck, 'com.karimdhanji.claude.sdPlugin', 'logs', 'com.karimdhanji.claude.0.log')
  write(f.deck, {
    // As the deck's own: its build and logs stay out of git, so a run leaves the folder committed.
    '.gitignore': '*.sdPlugin/bin/\n*.sdPlugin/logs/\n',
    'package.json': json({ name: 'claude-deck', private: true }),
    'package-lock.json': json({ name: 'claude-deck', lockfileVersion: 3 }),
    'com.karimdhanji.claude.sdPlugin/manifest.json': json({ UUID: 'com.karimdhanji.claude' }),
  })
  commitAll(f, 'the deck')
  f.streamDeckApp = path.join(f.root, 'Applications', 'Elgato Stream Deck.app')
  fs.mkdirSync(f.streamDeckApp, { recursive: true })
  f.streamDeckPlugins = path.join(f.root, 'StreamDeck', 'Plugins')
  fs.mkdirSync(f.streamDeckPlugins, { recursive: true })
  f.link = path.join(f.streamDeckPlugins, 'com.karimdhanji.claude.sdPlugin')
  f.claudeCodeRoot = path.join(f.root, 'claude-code-root')
  f.claudeCode = path.join(f.claudeCodeRoot, '2.1.317', 'b1', 'claude.app', 'Contents', 'MacOS', 'claude')
  fs.mkdirSync(path.dirname(f.claudeCode), { recursive: true })
  // Never run: the runner answers for it.
  fs.writeFileSync(f.claudeCode, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  return f
}

/** What the deck does when it starts, in the fixture: its token, 0600, then a fresh log with its bridge's listening line, at `at`. */
function deckStarts(f, at) {
  fs.mkdirSync(path.dirname(f.deckToken), { recursive: true, mode: 0o700 })
  fs.writeFileSync(f.deckToken, `${TOKEN}\n`, { mode: 0o600 })
  fs.mkdirSync(path.dirname(f.deckLog), { recursive: true })
  fs.writeFileSync(f.deckLog, `${new Date(at).toISOString()} INFO  Bridge: listening on 127.0.0.1:47600\n`)
}

const START = Date.parse('2026-11-05T12:00:00.000Z')
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const head = (f) => git(f.repo, 'rev-parse', 'HEAD').trim().slice(0, 7)

/**
 * setup's machine, in the fixture: the Stream Deck app, `running` or not; a clock that moves only when setup sleeps;
 * and a runner that notes each call, by its name as a person would type it, and answers as the real command would:
 * npm ci makes node_modules, streamdeck link makes the link, streamdeck restart starts the deck (deckStarts) as `deck`
 * says ('starts', 'late' 5 s on, or 'nothing'), and plugin validate passes. `fail` names a call that exits 1,
 * printing an error and, but for the validator, the token.
 */
function fakeHost(f, { fail = null, deck = 'starts' } = {}) {
  const host = {
    calls: [],
    running: false,
    t: START,
    lateAt: null,
    now: () => host.t,
    async sleep(ms) {
      host.t += ms
      if (host.lateAt !== null && host.t >= host.lateAt) {
        deckStarts(f, host.t)
        host.lateAt = null
      }
    },
    platform: 'darwin',
    nodeVersion: '24.22.2',
    execPath: path.join(f.root, 'node', 'bin', 'node'),
    streamDeckApp: f.streamDeckApp,
    streamDeckPlugins: f.streamDeckPlugins,
    waitMs: 90_000,
    pollMs: 500,
    async run(cmd, args, { cwd, env }) {
      const name = path.basename(cmd)
      const label = [name, ...(name === 'claude' ? args.slice(0, 2) : args)].join(' ')
      host.calls.push({ label, cmd, cwd, env })
      const answer = (code, out) => ({ code, signal: null, error: null, timedOut: false, out })
      if (label === fail) return answer(1, `npm error ${label} broke\n${name === 'claude' ? '' : `npm error at ${TOKEN}\n`}`)
      if (label === PGREP) return host.running ? answer(0, '27296\n') : answer(1, '')
      if (label === 'npm ci') fs.mkdirSync(path.join(f.deck, 'node_modules'), { recursive: true })
      if (label === 'streamdeck link com.karimdhanji.claude.sdPlugin') fs.symlinkSync(path.join(f.deck, 'com.karimdhanji.claude.sdPlugin'), f.link)
      if (label === 'streamdeck restart com.karimdhanji.claude') {
        if (deck === 'starts') deckStarts(f, host.t)
        else if (deck === 'late') host.lateAt = host.t + 5000
      }
      return answer(0, `\x1b[32m✔\x1b[39m ${label}\n`)
    },
  }
  return host
}

/** setup through main, in this process, with `host` for the machine and every path in the fixture: `{code, out, err, all}`. Fails the test when the output holds a token. */
async function runSetup(f, host, more = []) {
  let out = ''
  let err = ''
  const args = ['setup', ...more, '--settings', f.settings, '--release-dir', f.release, '--repo', f.repo, '--claude-code-root', f.claudeCodeRoot]
  const code = await DI.main(args, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } }, host)
  assertNoToken(out + err)
  return { code, out, err, all: out + err }
}

const PGREP = 'pgrep -x Stream Deck'
const COMMAND_CALLS = ['npm ci', 'npm run build', 'streamdeck dev', 'streamdeck link com.karimdhanji.claude.sdPlugin', 'streamdeck restart com.karimdhanji.claude']
const STEPS = ['preflight', ...COMMAND_CALLS, 'wait for the deck', 'release', 'install', 'status']
/** setup's step headers, as `<number> <name>`. */
const headers = (out) => [...out.matchAll(/^\[(\d+)\/10\] ([^:]+):/gm)].map((m) => `${m[1]} ${m[2]}`)
const ALL_HEADERS = STEPS.map((name, i) => `${i + 1} ${name}`)
/** What setup says under step `name`, on the line after its header. */
const under = (name, said) => new RegExp(`^\\[\\d+/10\\] ${esc(name)}: .*\\n {2}${said}$`, 'm')

test('setup runs its steps in order on a new Mac, and when run again skips npm ci, the link and the release while they are current', async (t) => {
  const f = setupFixture(t)
  const host = fakeHost(f)
  // As in a session after the install, where setup's commands mustn't get it.
  const saved = process.env.DECK_TOKEN
  process.env.DECK_TOKEN = TOKEN
  t.after(() => (saved === undefined ? delete process.env.DECK_TOKEN : (process.env.DECK_TOKEN = saved)))

  let r = await runSetup(f, host)
  assert.equal(r.code, 0, r.all)
  assert.deepEqual(headers(r.out), ALL_HEADERS)
  assert.deepEqual(host.calls.map((c) => c.label), [PGREP, ...COMMAND_CALLS, 'claude plugin validate'], "pgrep first, as there's no link yet")
  for (const c of host.calls.slice(1, 6)) {
    assert.equal(c.cwd, f.deck, c.label)
    assert.equal(c.env.PATH.split(':')[0], path.join(f.root, 'node', 'bin'), `${c.label}: the Node that runs setup comes first on PATH`)
    assert.equal(c.env.DECK_TOKEN, undefined, `${c.label}: no DECK_TOKEN`)
  }
  assert.equal(host.calls[1].cmd, 'npm', "npm from PATH, as there's none beside that Node")
  for (const c of host.calls.slice(3, 6)) assert.equal(c.cmd, path.join(f.deck, 'node_modules', '.bin', 'streamdeck'), 'the CLI npm ci installed, never one fetched by name')
  assert.equal(host.calls[6].cmd, f.claudeCode, 'release validates with the Claude Code the app bundles')
  for (const line of ['macOS: yes', `Node: 24.22.2, ${path.join(f.root, 'node', 'bin', 'node')}`, `Stream Deck app: ${f.streamDeckApp}`, 'Claude Code the app bundles: 2.1.317']) {
    assert.ok(r.out.includes(`\n  ${line}\n`), `the preflight says ${line}:\n${r.out}`)
  }
  assert.match(r.out, under('npm ci', 'there are no node_modules yet\\n {2}ok: ✔ npm ci'), "why it runs, then the command's last line, its colours taken out")
  assert.match(r.out, under('streamdeck link com.karimdhanji.claude.sdPlugin', "the Stream Deck app doesn't have the deck plugin yet"))
  assert.match(r.out, /^ {2}ok: the token is there, and the bridge listens on 127\.0\.0\.1:47600$/m)
  assert.match(r.out, under('release', `there's no release copy yet; HEAD is ${head(f)}`))
  assert.match(r.out, /^ {4}plugin validate \(Claude Code 2\.1\.317\): passed$/m)
  assert.match(r.out, /^ {2}installed and current$/m)
  assert.match(r.out, /^ {2}2\. Start a session in its Code tab, and look for its "Sessions: HELLO \.\.\. plugin" line/m)
  assert.deepEqual(readJson(f.settings), { env: { CLAUDE_CODE_PLUGIN_DIRS: f.copy, DECK_TOKEN: TOKEN } })
  assert.equal(modeOf(f.settings), 0o600)
  assert.equal(modeOf(path.dirname(f.settings)), 0o700)
  assert.equal(fs.readFileSync(f.stamp, 'utf8'), `${sha256(f.lock)}\n`, "a good npm ci stamps package-lock.json's sha256")

  // Again, a minute on: only build, dev and restart run, and nothing is written to settings.
  const settings = fs.readFileSync(f.settings)
  host.calls.length = 0
  host.t += 60_000
  r = await runSetup(f, host)
  assert.equal(r.code, 0, r.all)
  assert.deepEqual(headers(r.out), ALL_HEADERS)
  assert.deepEqual(host.calls.map((c) => c.label), ['npm run build', 'streamdeck dev', 'streamdeck restart com.karimdhanji.claude'])
  assert.match(r.out, under('npm ci', `skipped: node_modules has package-lock\\.json's packages: its sha256, ${sha256(f.lock).slice(0, 12)}…, is the last good npm ci's`))
  assert.match(r.out, under('streamdeck link com.karimdhanji.claude.sdPlugin', 'skipped: the Stream Deck app links the deck plugin from this folder already'))
  assert.match(r.out, under('release', `skipped: the release copy equals claude-code/plugin at HEAD, ${head(f)}`))
  assert.match(r.out, /^ {4}already installed: .* so nothing was written$/m)
  assert.deepEqual(fs.readFileSync(f.settings), settings)
  assert.deepEqual(backups(f), [])

  // A new package-lock.json, or no node_modules: npm ci runs again, and stamps the lock it installed.
  const changes = [
    ["package-lock.json isn't the one the last good npm ci installed", () => (fs.appendFileSync(f.lock, '\n'), commitAll(f, 'a new lock'))],
    ['there are no node_modules yet', () => fs.rmSync(path.join(f.deck, 'node_modules'), { recursive: true })],
  ]
  for (const [why, change] of changes) {
    change()
    host.calls.length = 0
    host.t += 60_000
    r = await runSetup(f, host)
    assert.equal(r.code, 0, r.all)
    assert.equal(host.calls[0].label, 'npm ci', why)
    assert.match(r.out, under('npm ci', esc(why)))
    assert.equal(fs.readFileSync(f.stamp, 'utf8'), `${sha256(f.lock)}\n`, why)
  }
})

test('setup stops at the first step that fails, with any error, says which and why, and runs nothing after it', async (t) => {
  const calls = [...COMMAND_CALLS, 'claude plugin validate']
  for (const [i, call] of calls.entries()) {
    const step = call === 'claude plugin validate' ? 'release' : call
    const number = STEPS.indexOf(step) + 1
    const f = setupFixture(t)
    const host = fakeHost(f, { fail: call })
    const r = await runSetup(f, host)
    assert.equal(r.code, 1, `${call}:\n${r.all}`)
    assert.deepEqual(host.calls.map((c) => c.label), [PGREP, ...calls.slice(0, i + 1)], `${call}: nothing after it runs`)
    assert.equal(headers(r.out).at(-1), `${number} ${step}`, `${call}: no step after it starts`)
    assert.match(r.err, new RegExp(`^deck-install setup: stopped at step ${number}, ${esc(step)}: .*failed \\(exit 1\\)`, 'm'), call)
    assert.match(r.err, new RegExp(`^ {4}npm error ${esc(call)} broke$`, 'm'), `${call}: the end of its output`)
    assert.match(r.err, /^Fix that, then run setup again\.$/m)
    assert.equal(fs.existsSync(f.stamp), i > 0, `${call}: a stamp only after a good npm ci`)
    assert.equal(fs.existsSync(f.settings), false, `${call}: no settings.json`)
    assert.equal(fs.existsSync(f.copy), false, `${call}: no release copy`)
  }

  // Errors that aren't refusals: no package-lock.json for the preflight, and ~/.claude a link to a dotfiles folder
  // that isn't cloned yet, so install can't make settings.json.
  let f = setupFixture(t)
  fs.rmSync(f.lock)
  let r = await runSetup(f, fakeHost(f))
  assert.match(r.err, /^deck-install setup: stopped at step 1, the preflight: failed: ENOENT: .*package-lock\.json/m)
  f = setupFixture(t)
  fs.symlinkSync(path.join(f.root, 'dotfiles', 'claude'), path.dirname(f.settings))
  r = await runSetup(f, fakeHost(f))
  assert.equal(r.code, 1, r.all)
  assert.match(r.err, /^deck-install setup: stopped at step 9, install: failed: ENOENT: .*\nFix that, then run setup again\.$/m)
})

test("setup's preflight finds what would stop it, says what to do, and stops before anything but pgrep runs", async (t) => {
  const cases = [
    ['not macOS', (f, h) => (h.platform = 'linux'), /this is linux, and the deck and the Claude app's sessions run on macOS only/],
    ['Node 22', (f, h) => (h.nodeVersion = '22.12.0'), /this is Node 22\.12\.0, .*: run `mise install node`, then run setup from the top of the clone as `mise exec node -- node claude-code\/install\/deck-install\.mjs setup`/],
    ['no Stream Deck app', (f) => fs.rmSync(f.streamDeckApp, { recursive: true }), /there's no Stream Deck app at .*Elgato Stream Deck\.app: install it, open it once and quit it, then run setup again/],
    ['a Stream Deck app never opened', (f) => fs.rmSync(f.streamDeckPlugins, { recursive: true }), /the Stream Deck app hasn't made its plugins folder, .*StreamDeck\/Plugins, .*: open it once and quit it, then run setup again/],
    ['the Stream Deck app running, on a first setup', (f, h) => (h.running = true), /the Stream Deck app is running, and this is the deck's first setup: quit the Stream Deck app, then run setup again\. /],
    ['the deck plugin from another folder', (f) => fs.symlinkSync(path.join(f.root, 'old-clone', 'com.karimdhanji.claude.sdPlugin'), f.link), /the Stream Deck app has the deck plugin from another folder, .*, which streamdeck link won't replace: take it out .*, then run setup again/],
    ['no Claude Code yet', (f) => fs.rmSync(f.claudeCodeRoot, { recursive: true }), /the Claude app has no Claude Code in .*claude-code-root yet, .*: install and open the app, start a session in its Code tab once, then run setup again/],
    ['unfinished deck code', (f) => fs.appendFileSync(path.join(f.deck, 'package.json'), '\n'), /claude-code\/deck has uncommitted changes, which setup would build into the deck: commit or stash them, then run setup again\n +M claude-code\/deck\/package\.json/],
    ['an unfinished plugin', (f) => fs.writeFileSync(path.join(f.plugin, 'hooks', 'new.ts'), 'x\n'), /claude-code\/plugin has uncommitted changes, and a release takes only what's committed: .*\n +\?\? claude-code\/plugin\/hooks\/new\.ts/],
    ['a release copy that is no folder', (f) => (fs.mkdirSync(f.release), fs.writeFileSync(f.copy, 'x\n')), /.*release\/streamdeck-bridge isn't a folder, so a release can't replace it: move it away, then run setup again/],
  ]
  for (const [what, make, why] of cases) {
    const f = setupFixture(t)
    const host = fakeHost(f)
    make(f, host)
    const r = await runSetup(f, host)
    assert.equal(r.code, 1, `${what}:\n${r.all}`)
    assert.match(r.out, new RegExp(`^ {2}problem: ${why.source}`, 'm'), what)
    assert.match(r.err, /^deck-install setup: stopped at step 1, the preflight: 1 problem, above\. Fix it, then run setup again$/m, what)
    assert.deepEqual(headers(r.out), ['1 preflight'], `${what}: no step after it`)
    assert.ok(host.calls.every((c) => c.label === PGREP), `${what}: nothing runs but pgrep`)
  }

  // Every problem at once.
  const f = setupFixture(t)
  const host = fakeHost(f)
  host.platform = 'linux'
  fs.rmSync(f.claudeCodeRoot, { recursive: true })
  const r = await runSetup(f, host)
  assert.equal((r.out.match(/^ {2}problem: /gm) ?? []).length, 2, r.out)
  assert.match(r.err, /stopped at step 1, the preflight: 2 problems, above\. Fix them, then run setup again/)
})

test('setup waits for the deck to log its bridge listening since the restart, and says what to do when it does not', async (t) => {
  // It comes up a while after the restart: setup waits for it, and no longer, then goes on.
  let f = setupFixture(t)
  let host = fakeHost(f, { deck: 'late' })
  let r = await runSetup(f, host)
  assert.equal(r.code, 0, r.all)
  assert.equal(host.t - START, 5000)

  // Nothing comes up: it waits the whole time, then says to relaunch the Stream Deck app, and goes no further.
  f = setupFixture(t)
  host = fakeHost(f, { deck: 'nothing' })
  r = await runSetup(f, host)
  assert.equal(r.code, 1, r.all)
  assert.equal(host.t - START, 90_000)
  assert.match(r.err, /^deck-install setup: stopped at step 7, wait for the deck: the deck didn't log "Bridge: listening" within 90 s of the restart: quit and reopen the Stream Deck app, which starts a linked plugin only in developer mode\. Its log is .*logs\/com\.karimdhanji\.claude\.0\.log\nFix that, then run setup again\.$/m)
  assert.deepEqual(host.calls.map((c) => c.label), [PGREP, ...COMMAND_CALLS])
  assert.equal(fs.existsSync(path.dirname(f.settings)), false)

  // A token and a listening line from before the restart are the deck that was: they don't count.
  f = setupFixture(t)
  host = fakeHost(f, { deck: 'nothing' })
  deckStarts(f, START - 1)
  r = await runSetup(f, host)
  assert.equal(r.code, 1, r.all)
  assert.match(r.err, /stopped at step 7, wait for the deck: the deck didn't log "Bridge: listening" within 90 s of the restart/)
})

test('setup --dry-run runs only the preflight, and says whether each step would run, and why', async (t) => {
  const f = setupFixture(t)
  const host = fakeHost(f)
  const run = host.run
  const dry = async (cmd, ...rest) => (path.basename(cmd) === 'pgrep' ? run(cmd, ...rest) : assert.fail(`a dry run ran ${cmd}`))
  host.run = dry
  let r = await runSetup(f, host, ['--dry-run'])
  assert.equal(r.code, 0, r.all)
  assert.match(r.out, /^setup, a dry run: /)
  assert.deepEqual(headers(r.out), ALL_HEADERS)
  assert.match(r.out, under('npm ci', 'would run: there are no node_modules yet'))
  assert.match(r.out, under('npm run build', 'not run: a dry run'))
  assert.match(r.out, under('streamdeck link com.karimdhanji.claude.sdPlugin', "would run: the Stream Deck app doesn't have the deck plugin yet"))
  assert.match(r.out, under('release', `would run: there's no release copy yet; HEAD is ${head(f)}`))
  assert.match(r.out, /^A dry run: only the preflight ran, and nothing was written\.$/m)
  for (const p of [path.dirname(f.settings), f.release, path.dirname(f.deckToken), path.dirname(f.deckLog), path.join(f.deck, 'node_modules'), f.link]) {
    assert.equal(fs.existsSync(p), false, `${p} isn't made`)
  }

  // After a setup, a commit to the plugin: the release would run, as the copy is stale, and says from which commit.
  host.run = run
  assert.equal((await runSetup(f, host)).code, 0)
  const released = head(f)
  fs.appendFileSync(path.join(f.plugin, 'hooks', 'bridge.ts'), '// changed\n')
  commitAll(f, 'a change')
  host.run = dry
  r = await runSetup(f, host, ['--dry-run'])
  assert.equal(r.code, 0, r.all)
  assert.match(r.out, under('release', `would run: the release copy, version 0\\.1\\.0, released \\S+ from ${released}, differs from claude-code/plugin at HEAD, ${head(f)} \\(1 changed\\)`))
  assert.match(r.out, under('npm ci', 'skipped: .*'))
  assert.match(r.out, under('streamdeck link com.karimdhanji.claude.sdPlugin', 'skipped: .*'))

  // With a preflight problem: every step still, and exit 1.
  host.platform = 'linux'
  r = await runSetup(f, host, ['--dry-run'])
  assert.equal(r.code, 1, r.all)
  assert.deepEqual(headers(r.out), ALL_HEADERS)
  assert.match(r.out, /^A dry run: only the preflight ran, and nothing was written\. The preflight found problems, above\.$/m)

  // --dry-run goes with setup alone.
  r = await expectCode(f, ['install', '--dry-run'], 2)
  assert.match(r.err, /^deck-install: --dry-run goes with setup only$/m)
})

test("the deck logs the line setup waits for: plugin.ts gives the bridge its scope, and server.ts says it's listening", () => {
  const src = path.resolve(HERE, '..', '..', 'deck', 'src')
  const scope = /new BridgeServer\(\{.*\blog: scope\("(\w+)"\)/.exec(fs.readFileSync(path.join(src, 'plugin.ts'), 'utf8'))?.[1]
  const said = /log\.info\(`(listening on )\$\{/.exec(fs.readFileSync(path.join(src, 'bridge', 'server.ts'), 'utf8'))?.[1]
  assert.equal(scope, 'Bridge', "plugin.ts logs the bridge under the scope setup's wait matches")
  assert.equal(said, 'listening on ', "server.ts's line, as setup's wait matches it")
  assert.equal(DI.LISTENING.exec(`2026-11-05T12:00:00.000Z INFO  ${scope}: ${said}127.0.0.1:47600`)?.[1], '127.0.0.1:47600')
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
