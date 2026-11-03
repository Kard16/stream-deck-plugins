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

  // A variable the engine won't read fails its test: the gate stays shut when in doubt.
  { what: 'CLAUDECODE unreadable', unreadable: ['CLAUDECODE'], log: [/CLAUDECODE couldn't be read/] },
  { what: 'DECK_TOKEN unreadable', unreadable: ['DECK_TOKEN'], log: [/DECK_TOKEN couldn't be read/] },
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

test('a long value is cut short in the log line', async ($, on) => {
  const w = world(on, { env: desktopWith({ CLAUDE_CODE_TAGS: 'x'.repeat(5000) }) })
  await aTurn($, w)
  expect(w.sent).toEqual([])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/: CLAUDE_CODE_TAGS is set \("x{78}…\)\.$/)
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
    expect(hello?.body).toMatchObject({ v: 1, sid: SID, host: env.CLAUDE_CODE_HOST_SESSION_ID, plugin: '0.2.0' })
    expect(poll?.route).toBe('/v1/next')
    expect(poll?.query).toMatchObject({ sid: SID, host: env.CLAUDE_CODE_HOST_SESSION_ID })
    expect(w.sent).toHaveLength(2)
    expect(w.logs).toEqual([])
  })
}
