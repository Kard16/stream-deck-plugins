// The gate (PROTOCOL.md, "Desktop sessions only"). Every Claude Code process that reads ~/.claude/settings.json runs
// the mod, and only a desktop session of its own with a token talks to the bridge. Anywhere else the mod sends
// nothing at all, not one fetch, logs once which of the gate's tests failed, and passes every hook through.

import { expect, test, type Engine } from 'claude-code/testing'
import { DESKTOP_ENV, HOST, SID, START, TOKEN, world } from './world'

type World = ReturnType<typeof world>

/** DESKTOP_ENV with `changes` over it: a string sets the variable, undefined unsets it. */
function desktopWith(changes: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { ...DESKTOP_ENV }
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return env
}

/** A turn's worth of hooks, each passed straight through, then two minutes for anything the mod might send late. */
async function aTurn($: Engine, w: World): Promise<void> {
  expect(await $.session.start(START)).toEqual({ cwd: '/sandbox' })
  await w.settle()
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 120, rows: 40 } })
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'default', effort: { level: 'low' } })
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/sandbox/notes.md' })).toEqual({ result: 'ran' })
  await $.session.measure({ changed: ['context'], context: { tokens: 90_000, window: 1_000_000, percent: 9 }, rateLimits: [] })
  await $.classic.Stop({ stop_hook_active: false, permission_mode: 'acceptEdits', effort: { level: 'low' } })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
  await w.clock.advance(120_000)
}

/** A process the mod stays quiet in: what it is, its environment over a desktop session's, and what the log names. */
type Quiet = { what: string; env?: Readonly<Record<string, string | undefined>>; unreadable?: readonly string[]; log: readonly RegExp[] }

const NOT_DESKTOP = /, not claude-desktop or claude-desktop-3p/
const NOT_HOST = /, not a desktop session's local_… id/

const QUIET: readonly Quiet[] = [
  // CLAUDE_CODE_ENTRYPOINT is claude-desktop or claude-desktop-3p.
  { what: 'no CLAUDE_CODE_ENTRYPOINT', env: { CLAUDE_CODE_ENTRYPOINT: undefined }, log: [/CLAUDE_CODE_ENTRYPOINT isn't set/] },
  { what: 'an empty CLAUDE_CODE_ENTRYPOINT', env: { CLAUDE_CODE_ENTRYPOINT: '' }, log: [/CLAUDE_CODE_ENTRYPOINT is ""/, NOT_DESKTOP] },
  { what: 'a terminal session (entrypoint cli)', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, log: [/CLAUDE_CODE_ENTRYPOINT is "cli"/, NOT_DESKTOP] },
  { what: 'a claude -p run through the SDK (entrypoint sdk-ts)', env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, log: [/CLAUDE_CODE_ENTRYPOINT is "sdk-ts"/] },
  { what: 'a VS Code session (entrypoint claude-vscode)', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, log: [/CLAUDE_CODE_ENTRYPOINT is "claude-vscode"/] },
  { what: 'a Cowork session (entrypoint local-agent), which the engine trusts and the protocol doesn\'t', env: { CLAUDE_CODE_ENTRYPOINT: 'local-agent' }, log: [/CLAUDE_CODE_ENTRYPOINT is "local-agent"/] },
  { what: 'an entrypoint with a stray space', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop ' }, log: [/CLAUDE_CODE_ENTRYPOINT is "claude-desktop "/] },
  // The entrypoint's case counts.
  { what: 'an entrypoint in another case (Claude-Desktop)', env: { CLAUDE_CODE_ENTRYPOINT: 'Claude-Desktop' }, log: [/: CLAUDE_CODE_ENTRYPOINT is "Claude-Desktop", not claude-desktop or claude-desktop-3p\.$/] },
  { what: 'an entrypoint in capitals (CLAUDE-DESKTOP)', env: { CLAUDE_CODE_ENTRYPOINT: 'CLAUDE-DESKTOP' }, log: [/: CLAUDE_CODE_ENTRYPOINT is "CLAUDE-DESKTOP", not claude-desktop or claude-desktop-3p\.$/] },
  { what: 'a third-party entrypoint in another case (claude-desktop-3P)', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3P' }, log: [/: CLAUDE_CODE_ENTRYPOINT is "claude-desktop-3P", not claude-desktop or claude-desktop-3p\.$/] },

  // CLAUDE_CODE_HOST_SESSION_ID matches ^local_[A-Za-z0-9-]{1,64}$.
  { what: 'no CLAUDE_CODE_HOST_SESSION_ID', env: { CLAUDE_CODE_HOST_SESSION_ID: undefined }, log: [/CLAUDE_CODE_HOST_SESSION_ID isn't set/] },
  { what: 'an empty host id', env: { CLAUDE_CODE_HOST_SESSION_ID: '' }, log: [/CLAUDE_CODE_HOST_SESSION_ID is ""/, NOT_HOST] },
  { what: 'a host id Claude Code didn\'t fill in', env: { CLAUDE_CODE_HOST_SESSION_ID: '$CLAUDE_CODE_HOST_SESSION_ID' }, log: [/is "\$CLAUDE_CODE_HOST_SESSION_ID"/, NOT_HOST] },
  { what: 'a host id with nothing after local_', env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_' }, log: [/is "local_"/, NOT_HOST] },
  { what: 'a host id 65 characters after local_', env: { CLAUDE_CODE_HOST_SESSION_ID: `local_${'a'.repeat(65)}` }, log: [NOT_HOST] },
  { what: 'a host id with an underscore after local_', env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_test_1' }, log: [/is "local_test_1"/, NOT_HOST] },
  { what: 'a host id with a trailing newline', env: { CLAUDE_CODE_HOST_SESSION_ID: `${HOST}\n` }, log: [/is "local_test-1\\n"/, NOT_HOST] },
  { what: 'a host id with a leading space', env: { CLAUDE_CODE_HOST_SESSION_ID: ` ${HOST}` }, log: [/is " local_test-1"/, NOT_HOST] },
  { what: 'a remote session\'s id', env: { CLAUDE_CODE_HOST_SESSION_ID: 'remote_test-1' }, log: [/is "remote_test-1"/, NOT_HOST] },

  // CLAUDECODE, CLAUDE_CODE_CHILD_SESSION and CLAUDE_CODE_TAGS are unset or empty.
  { what: 'CLAUDECODE set', env: { CLAUDECODE: '1' }, log: [/CLAUDECODE is set \("1"\)/] },
  { what: 'CLAUDE_CODE_CHILD_SESSION set', env: { CLAUDE_CODE_CHILD_SESSION: '1' }, log: [/CLAUDE_CODE_CHILD_SESSION is set \("1"\)/] },
  { what: 'a side chat the app forked from a preset session (CLAUDE_CODE_TAGS set)', env: { CLAUDE_CODE_TAGS: 'recap' }, log: [/CLAUDE_CODE_TAGS is set \("recap"\)/] },
  {
    what: 'a claude started inside a desktop session, with its host id',
    env: { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' },
    log: [/CLAUDECODE is set \("1"\); CLAUDE_CODE_CHILD_SESSION is set \("1"\)\.$/],
  },
  // Only the empty string is empty: a space or a 0 is set.
  { what: 'CLAUDECODE a space', env: { CLAUDECODE: ' ' }, log: [/: CLAUDECODE is set \(" "\)\.$/] },
  { what: 'CLAUDECODE 0', env: { CLAUDECODE: '0' }, log: [/: CLAUDECODE is set \("0"\)\.$/] },
  { what: 'CLAUDE_CODE_CHILD_SESSION a space', env: { CLAUDE_CODE_CHILD_SESSION: ' ' }, log: [/: CLAUDE_CODE_CHILD_SESSION is set \(" "\)\.$/] },
  { what: 'CLAUDE_CODE_CHILD_SESSION 0', env: { CLAUDE_CODE_CHILD_SESSION: '0' }, log: [/: CLAUDE_CODE_CHILD_SESSION is set \("0"\)\.$/] },
  { what: 'CLAUDE_CODE_TAGS a space', env: { CLAUDE_CODE_TAGS: ' ' }, log: [/: CLAUDE_CODE_TAGS is set \(" "\)\.$/] },
  { what: 'CLAUDE_CODE_TAGS 0', env: { CLAUDE_CODE_TAGS: '0' }, log: [/: CLAUDE_CODE_TAGS is set \("0"\)\.$/] },

  // DECK_TOKEN is set.
  { what: 'no DECK_TOKEN', env: { DECK_TOKEN: undefined }, log: [/DECK_TOKEN isn't set/] },
  { what: 'an empty DECK_TOKEN', env: { DECK_TOKEN: '' }, log: [/DECK_TOKEN isn't set/] },
  { what: 'a blank DECK_TOKEN', env: { DECK_TOKEN: '  \n' }, log: [/DECK_TOKEN isn't set/] },

  // Everything a terminal session fails, in the protocol's order, in the one line.
  {
    what: 'a terminal session with no token',
    env: { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_HOST_SESSION_ID: undefined, DECK_TOKEN: undefined },
    log: [/: CLAUDE_CODE_ENTRYPOINT is "cli", not claude-desktop or claude-desktop-3p; CLAUDE_CODE_HOST_SESSION_ID isn't set; DECK_TOKEN isn't set\.$/],
  },

  // A variable the engine won't read fails its test, and the line says so: the gate stays shut when in doubt.
  { what: 'CLAUDE_CODE_ENTRYPOINT unreadable', unreadable: ['CLAUDE_CODE_ENTRYPOINT'], log: [/: CLAUDE_CODE_ENTRYPOINT couldn't be read\.$/] },
  { what: 'CLAUDE_CODE_HOST_SESSION_ID unreadable', unreadable: ['CLAUDE_CODE_HOST_SESSION_ID'], log: [/: CLAUDE_CODE_HOST_SESSION_ID couldn't be read\.$/] },
  { what: 'CLAUDECODE unreadable', unreadable: ['CLAUDECODE'], log: [/: CLAUDECODE couldn't be read\.$/] },
  { what: 'CLAUDE_CODE_CHILD_SESSION unreadable', unreadable: ['CLAUDE_CODE_CHILD_SESSION'], log: [/: CLAUDE_CODE_CHILD_SESSION couldn't be read\.$/] },
  { what: 'CLAUDE_CODE_TAGS unreadable', unreadable: ['CLAUDE_CODE_TAGS'], log: [/: CLAUDE_CODE_TAGS couldn't be read\.$/] },
  { what: 'DECK_TOKEN unreadable', unreadable: ['DECK_TOKEN'], log: [/: DECK_TOKEN couldn't be read\.$/] },
]

for (const q of QUIET) {
  test(`quiet in ${q.what}: no fetch at all, one log line naming the test, and every hook passed through`, async ($, on) => {
    const w = world(on, { env: desktopWith(q.env ?? {}), unreadable: q.unreadable ?? [] })
    await aTurn($, w)
    expect(w.sent).toEqual([])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toMatch(/^This process doesn't talk to the Stream Deck, which is for desktop sessions only: /)
    for (const named of q.log) expect(w.logs[0]).toMatch(named)
  })
}

test('the log line hides the token, even inside another variable', async ($, on) => {
  const w = world(on, { env: desktopWith({ CLAUDE_CODE_TAGS: `fork ${TOKEN} recap` }) })
  await aTurn($, w)
  expect(w.sent).toEqual([])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/CLAUDE_CODE_TAGS is set \("fork <token> recap"\)/)
  expect(w.logs[0]?.includes(TOKEN)).toBe(false)
})

test('a token holding characters JSON escapes, quotes and backslashes, is hidden before the value is quoted: neither it nor its escaped form reaches the log', async ($, on) => {
  // Escaped, it has no run of 8 characters in common with the token, so a value quoted first would hide nothing.
  const token = 'a"b\\c"d\\e"f\\g"h'
  const escaped = JSON.stringify(token).slice(1, -1)
  const w = world(on, { env: desktopWith({ DECK_TOKEN: token, CLAUDE_CODE_TAGS: `fork ${token} recap` }) })
  await aTurn($, w)
  expect(w.sent).toEqual([])
  expect(w.logs).toHaveLength(1)
  const line = w.logs[0] ?? ''
  expect(line).toMatch(/: CLAUDE_CODE_TAGS is set \("fork <token> recap"\)\.$/)
  expect(line.includes(token)).toBe(false)
  expect(line.includes(escaped)).toBe(false)
})

test('a long value is cut short in the log line', async ($, on) => {
  const w = world(on, { env: desktopWith({ CLAUDE_CODE_TAGS: 'x'.repeat(5000) }) })
  await aTurn($, w)
  expect(w.sent).toEqual([])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/: CLAUDE_CODE_TAGS is set \("x{78}…\)\.$/)
})

test("a token across a value's 80-character cut is hidden before the cut: no piece of it reaches the log", async ($, on) => {
  // The quoted value is cut to its first 79 characters, the quote and 78 of the value. The token starts at the
  // value's 74th, so a cut made first would leave its first 5 characters, too few to be known as the token's.
  const filler = 'x'.repeat(73)
  const w = world(on, { env: desktopWith({ CLAUDE_CODE_TAGS: `${filler}${TOKEN} and on` }) })
  await aTurn($, w)
  expect(w.sent).toEqual([])
  expect(w.logs).toHaveLength(1)
  const line = w.logs[0] ?? ''
  expect(line).toMatch(/: CLAUDE_CODE_TAGS is set \("x{73}<toke…\)\.$/)
  for (let i = 0; i + 5 <= TOKEN.length; i++) expect(line).not.toContain(TOKEN.slice(i, i + 5))
})

/** A desktop session of its own: what it is, and its environment over DESKTOP_ENV. */
type Talks = { what: string; env: Readonly<Record<string, string | undefined>> }

const TALKS: readonly Talks[] = [
  { what: 'a desktop session (entrypoint claude-desktop)', env: {} },
  { what: 'a desktop session on a third-party provider (entrypoint claude-desktop-3p)', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p' } },
  { what: 'a desktop session with CLAUDECODE, CLAUDE_CODE_CHILD_SESSION and CLAUDE_CODE_TAGS empty', env: { CLAUDECODE: '', CLAUDE_CODE_CHILD_SESSION: '', CLAUDE_CODE_TAGS: '' } },
  { what: 'a desktop session whose host id has 64 characters after local_', env: { CLAUDE_CODE_HOST_SESSION_ID: `local_${'Ab9-'.repeat(16)}` } },
  { what: 'a desktop session whose host id has one character after local_', env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_-' } },
]

for (const t of TALKS) {
  test(`${t.what} says hello, with its host id, then polls; nothing logged`, async ($, on) => {
    const env = desktopWith(t.env)
    const w = world(on, { env })
    await $.session.start(START)
    await w.settle()
    const [hello, poll] = w.sent
    expect(hello?.route).toBe('/v1/hello')
    expect(hello?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(hello?.body).toMatchObject({ v: 1, sid: SID, host: env.CLAUDE_CODE_HOST_SESSION_ID, plugin: '0.3.0' })
    expect(poll?.route).toBe('/v1/next')
    expect(poll?.query).toMatchObject({ sid: SID, host: env.CLAUDE_CODE_HOST_SESSION_ID })
    expect(w.sent).toHaveLength(2)
    expect(w.logs).toEqual([])
  })
}
