// Writes fixtures/*.jsonl and fixtures/vectors.json, and holds the reference implementation of the
// protocol's fingerprint and summary (PROTOCOL.md, "Fingerprints and summaries"). Edit the fixtures here,
// never the generated files.
//
//   mise exec -- node claude-code/protocol/make-fixtures.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// ---- reference implementation -------------------------------------------------

/** JSON with no spaces and sorted keys; undefined values left out of objects. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort().filter((k) => v[k] !== undefined)
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** FNV-1a over UTF-16 code units. */
export function fnv1a32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

export const fingerprint = (tool, input) => fnv1a32(`${tool}\n${canonical(input)}`).toString(16).padStart(8, '0')

const MAX = 40
const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s)
const str = (v) => (typeof v === 'string' && v !== '' ? v : null)
const lastSegment = (p) => p.split('/').filter((x) => x !== '').at(-1) ?? null

function hostOf(url) {
  const i = url.indexOf('://')
  if (i < 0) return null
  let rest = url.slice(i + 3)
  const end = rest.search(/[/?#]/)
  if (end >= 0) rest = rest.slice(0, end)
  rest = rest.slice(rest.lastIndexOf('@') + 1).replace(/:\d*$/, '')
  return rest === '' ? null : rest
}

export function summary(tool, input) {
  const i = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  let s = null
  switch (tool) {
    case 'Bash': {
      const c = str(i.command)
      s = c === null ? null : str(c.split('\n')[0].trim())
      break
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const p = str(i.file_path)
      s = p === null ? null : lastSegment(p)
      break
    }
    case 'NotebookEdit': {
      const p = str(i.notebook_path)
      s = p === null ? null : lastSegment(p)
      break
    }
    case 'Glob':
    case 'Grep':
      s = str(i.pattern)
      break
    case 'WebFetch': {
      const u = str(i.url)
      s = u === null ? null : hostOf(u)
      break
    }
    case 'WebSearch':
      s = str(i.query)
      break
    case 'Agent':
    case 'Task':
      s = str(i.description) ?? str(i.subagent_type)
      break
    case 'AskUserQuestion':
      s = Array.isArray(i.questions) ? str(i.questions[0]?.question) : null
      break
    case 'ExitPlanMode':
      s = 'Plan ready'
      break
    default:
      if (tool.startsWith('mcp__')) {
        const name = tool.split('__').slice(2).join('__')
        s = name === '' ? null : name.replaceAll('_', ' ')
      }
  }
  return cut(s ?? tool)
}

// ---- vectors -------------------------------------------------------------------

const VECTORS = [
  ['Write', { file_path: '/Users/me/sandbox/s4.txt', content: 'four' }],
  ['Bash', { command: 'rm -rf build', description: 'Remove the build folder' }],
  ['Bash', { command: '  npm run build && npm test -- --reporter spec --bail\necho done', description: 'Build and test' }],
  ['Bash', { command: '\n  ls' }],
  ['Read', { file_path: '/Users/me/sandbox/notes.md', limit: 50 }],
  ['Edit', { file_path: 'relative/dir/', old_string: 'a', new_string: 'b' }],
  ['NotebookEdit', { notebook_path: '/n/analysis.ipynb', new_source: 'x = 1' }],
  ['Grep', { pattern: 'TODO|FIXME', path: 'src', output_mode: 'content' }],
  ['Glob', { pattern: '**/*.ts' }],
  ['WebFetch', { url: 'https://user:pw@docs.example.com:8443/path?q=1#top', prompt: 'Summarise' }],
  ['WebFetch', { url: 'not a url', prompt: 'x' }],
  ['WebSearch', { query: 'stream deck plus touch strip layout' }],
  ['Agent', { description: 'Find the bridge code', subagent_type: 'Explore', prompt: 'Look in claude-code/' }],
  ['Task', { subagent_type: 'general-purpose', prompt: 'x' }],
  ['AskUserQuestion', { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red', description: 'Red' }, { label: 'Blue', description: 'Blue' }], multiSelect: false }] }],
  ['ExitPlanMode', { plan: 'Create s7.txt containing: seven.' }],
  ['mcp__ccd_session_mgmt__set_session_permission_mode', { session_id: 'self', mode: 'acceptEdits' }],
  ['mcp__plugin_vercel_vercel__get_project', { projectId: 'p1' }],
  ['SomeNewTool', { x: 1 }],
  ['Write', { file_path: '/tmp/café ☕.txt', content: 'é\u0000"quoted"\n' }],
  ['Custom', { b: 1, a: { d: [1, { z: 2, y: 3 }], c: null }, e: [true, false, 1.5, -0, 'x'] }],
  ['Write', { file_path: '/Users/me/sandbox/a-file-name-that-is-much-longer-than-forty-characters.md', content: '' }],
]

const vectors = VECTORS.map(([tool, input]) => ({ tool, input, canonical: canonical(input), fp: fingerprint(tool, input), summary: summary(tool, input) }))

// ---- fixtures ------------------------------------------------------------------

const CWD = '/Users/me/sandbox'
const MODEL = 'claude-haiku-5-5'
const T0 = 1793600000000
const A = { sid: '3fa86955-0000-4000-8000-00000000000a', host: 'local_test-a', inst: 'ia', pid: 101, name: 'Deck test A' }
const B = { sid: '3fa86955-0000-4000-8000-00000000000b', host: 'local_test-b', inst: 'ib', pid: 102, name: 'Deck test B' }

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
const DENY = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from the Stream Deck.', interrupt: true } } }
const MODE_TOOL = 'mcp__ccd_session_mgmt__set_session_permission_mode'

const note = (text) => ({ note: text })

function setup(sessions = [A], status = {}) {
  return {
    setup: {
      session: { sid: A.sid, host: A.host, model: MODEL, cwd: CWD, token: 'fixture-token' },
      registry: sessions.map((s) => ({ pid: s.pid, sessionId: s.sid, hostSessionId: s.host, name: s.name, cwd: CWD, status: status[s.host] ?? 'idle', statusUpdatedAt: T0 })),
      records: Object.fromEntries(sessions.map((s) => [s.host, { model: MODEL, effort: 'low', permissionMode: 'default', lastFocusedAt: T0 }])),
    },
  }
}

/** One session's side of a conversation: its event seq and clock. */
function session(S) {
  let seq = 0
  let t = T0
  return {
    ev: (event) => ({ plugin: { method: 'POST', path: '/v1/events', body: { sid: S.sid, host: S.host, inst: S.inst, seq: ++seq, events: [{ ...event, at: (t += 100) }] } } }),
    result: (id, state, extra = {}) => ({ plugin: { method: 'POST', path: '/v1/result', body: { sid: S.sid, host: S.host, inst: S.inst, id, state, ...extra } } }),
    next: (as) => ({ plugin: { as, method: 'GET', path: `/v1/next?sid=${S.sid}&host=${S.host}&inst=${S.inst}&wait=20` } }),
    hello: () => [
      { mod: { on: 'session.start', e: { cwd: CWD, surface: null, isInteractive: false } } },
      { plugin: { as: 'h', method: 'POST', path: '/v1/hello', body: { v: 1, sid: S.sid, host: S.host, inst: S.inst, cwd: CWD, model: MODEL, plugin: '*', cc: '*' } } },
      { reply: { to: 'h', status: 200, body: { v: 1, ok: true } } },
      { plugin: { as: 'n1', method: 'GET', path: `/v1/next?sid=${S.sid}&host=${S.host}&inst=${S.inst}&wait=20` } },
    ],
    permission: (as, tool, input, extra = {}) => ({
      plugin: {
        as,
        method: 'POST',
        path: '/v1/permission',
        headers: { 'X-Deck-Host': S.host },
        body: {
          session_id: S.sid,
          transcript_path: `/Users/me/.claude/projects/-Users-me-sandbox/${S.sid}.jsonl`,
          cwd: CWD,
          hook_event_name: 'PermissionRequest',
          tool_name: tool,
          tool_input: input,
          permission_mode: 'default',
          effort: { level: 'low' },
          prompt_id: 'prompt-1',
          ...extra,
        },
      },
    }),
    registry: (fields) => ({ registry: { pid: S.pid, ...fields } }),
    turn: (turnId, text) => ({ mod: { on: 'turn.start', e: { turnId, text } } }),
    turnEnd: (turnId, reason = 'answer') => ({ mod: { on: 'turn.complete', e: { turnId, reason, isAborted: reason === 'aborted', durationMs: 2400, answer: reason === 'aborted' ? '' : 'Done.' } } }),
    tool: (tool, use, input, result = { isError: false }) => ({ mod: { on: 'tool.call', e: { tool, tool_use_id: use, ...input }, result } }),
  }
}

const toolStart = (tool, use, input) => ({ t: 'tool.start', tool, use, summary: summary(tool, input), fp: fingerprint(tool, input) })
const toolEnd = (tool, use, input, extra = { ok: true }) => ({ t: 'tool.end', tool, use, fp: fingerprint(tool, input), ...extra })
const held = (S, tool, input, kind = 'tool') => ({ host: S.host, tool, kind, summary: summary(tool, input) })
const reply = (to, body, status = 200) => ({ reply: { to, status, ...(body === undefined ? {} : { body }) } })

const fixtures = {}

{
  const a = session(A)
  fixtures.hello = [
    note('The mod loads, says hello and opens its long poll. Nothing is queued, so the poll stays open.'),
    setup(),
    ...a.hello(),
    { expect: { sessions: [A.host], status: { [A.host]: 'idle' }, settings: { [A.host]: { model: MODEL } } } },
  ]
}

{
  const a = session(A)
  const read = { file_path: `${CWD}/notes.md` }
  fixtures.status = [
    note('A turn that reads a file. The deck shows working with the file name, then done, with the context %.'),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Summarise notes.md'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    a.tool('Read', 'u1', read),
    a.ev(toolStart('Read', 'u1', read)),
    { expect: { status: { [A.host]: 'working' }, doing: { [A.host]: 'notes.md' } } },
    a.ev(toolEnd('Read', 'u1', read)),
    { mod: { on: 'session.measure', e: { changed: ['context'], context: { tokens: 120000, window: 1000000, percent: 12 } } } },
    a.ev({ t: 'measure', context: { percent: 12, tokens: 120000, window: 1000000 } }),
    a.turnEnd('t1'),
    a.ev({ t: 'turn.end', turn: 't1', reason: 'answer' }),
    a.registry({ status: 'idle', statusUpdatedAt: T0 + 5000 }),
    { expect: { status: { [A.host]: 'done' }, context: { [A.host]: 12 }, doing: { [A.host]: null } } },
  ]
}

{
  const a = session(A)
  const write = { file_path: `${CWD}/s4.txt`, content: 'four' }
  fixtures.approve = [
    note('The Write needs permission. The Approve key shows it, and a press allows it. The tool then runs and ends.'),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Create s4.txt'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    a.tool('Write', 'u2', write),
    a.ev(toolStart('Write', 'u2', write)),
    a.permission('p1', 'Write', write, { permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 2000 }),
    { expect: { held: [held(A, 'Write', write)], status: { [A.host]: 'approval' }, settings: { [A.host]: { mode: 'default', effort: 'low' } } } },
    { press: { approve: {} } },
    reply('p1', ALLOW),
    { expect: { held: [] } },
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 3000 }),
    a.ev(toolEnd('Write', 'u2', write)),
    a.turnEnd('t1'),
    a.ev({ t: 'turn.end', turn: 't1', reason: 'answer' }),
    a.registry({ status: 'idle', statusUpdatedAt: T0 + 4000 }),
    { expect: { status: { [A.host]: 'done' } } },
  ]
}

{
  const a = session(A)
  const bash = { command: 'rm -rf build', description: 'Remove the build folder' }
  fixtures.deny = [
    note('The Bash call needs permission, and a press on Deny refuses it. The turn stops; the engine still reports reason answer, as S2 saw. The refusal reaches the mod as an errored result (ladder step 4), so its tool.end has ok false and no denied.'),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Clean up'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    a.tool('Bash', 'u3', bash, { isError: true, text: "The user doesn't want to proceed with this tool use. The tool use was rejected." }),
    a.ev(toolStart('Bash', 'u3', bash)),
    a.permission('p1', 'Bash', bash),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 2000 }),
    { expect: { held: [held(A, 'Bash', bash)], status: { [A.host]: 'approval' } } },
    { press: { deny: {} } },
    reply('p1', DENY),
    a.ev(toolEnd('Bash', 'u3', bash, { ok: false })),
    a.turnEnd('t1'),
    a.ev({ t: 'turn.end', turn: 't1', reason: 'answer' }),
    a.registry({ status: 'idle', statusUpdatedAt: T0 + 4000 }),
    { expect: { held: [], status: { [A.host]: 'done' } } },
  ]
}

{
  const a = session(A)
  const write = { file_path: `${CWD}/s5.txt`, content: 'five' }
  fixtures['answered-in-app'] = [
    note("The user answers the Write's dialog in the app. The hook's request stays open (S2) until the tool's end, whose fingerprint matches, releases it with no decision."),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Create s5.txt'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    a.tool('Write', 'u4', write),
    a.ev(toolStart('Write', 'u4', write)),
    a.permission('p1', 'Write', write),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 2000 }),
    { expect: { held: [held(A, 'Write', write)] } },
    a.ev(toolEnd('Write', 'u4', write)),
    reply('p1', {}),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 3000 }),
    { expect: { held: [], status: { [A.host]: 'working' } } },
  ]
}

{
  const a = session(A)
  const bash = { command: 'npm test', description: 'Run the tests' }
  fixtures['answered-in-app-registry'] = [
    note('The user allows a long-running command in the app. Its end comes much later, so the registry leaving waiting releases the request first: it was the only one the session had.'),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Run the tests'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    a.tool('Bash', 'u5', bash),
    a.ev(toolStart('Bash', 'u5', bash)),
    a.permission('p1', 'Bash', bash),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 2000 }),
    { expect: { held: [held(A, 'Bash', bash)] } },
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 3000 }),
    reply('p1', {}),
    { expect: { held: [], status: { [A.host]: 'working' }, doing: { [A.host]: 'npm test' } } },
    a.ev(toolEnd('Bash', 'u5', bash)),
  ]
}

{
  const a = session(A)
  const b = session(B)
  const write = { file_path: `${CWD}/s6.txt`, content: 'six' }
  const bash = { command: 'make', description: 'Build' }
  fixtures['two-held'] = [
    note('Two sessions wait at once. Approve answers the oldest across sessions, then the next. There are no mod lines, so the plugin side skips this fixture.'),
    setup([A, B], { [A.host]: 'busy', [B.host]: 'busy' }),
    a.permission('p1', 'Write', write),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 1000 }),
    { expect: { held: [held(A, 'Write', write)] } },
    b.permission('p2', 'Bash', bash),
    b.registry({ status: 'waiting', statusUpdatedAt: T0 + 2000 }),
    { expect: { held: [held(A, 'Write', write), held(B, 'Bash', bash)], status: { [A.host]: 'approval', [B.host]: 'approval' } } },
    { press: { approve: {} } },
    reply('p1', ALLOW),
    { expect: { held: [held(B, 'Bash', bash)] } },
    { press: { approve: {} } },
    reply('p2', ALLOW),
    { expect: { held: [] } },
  ]
}

{
  const a = session(A)
  const ask = { questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red', description: 'Red' }, { label: 'Blue', description: 'Blue' }], multiSelect: false }] }
  fixtures['needs-you'] = [
    note('AskUserQuestion is held for display only. A press jumps to the session and answers nothing. The user answers in the app, and the tool\'s end releases the request.'),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Ask me a question'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    a.tool('AskUserQuestion', 'u6', ask),
    a.ev(toolStart('AskUserQuestion', 'u6', ask)),
    a.permission('p1', 'AskUserQuestion', ask),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 2000 }),
    { expect: { held: [held(A, 'AskUserQuestion', ask, 'ask')], status: { [A.host]: 'needs-you' } } },
    { press: { approve: {} } },
    { expect: { jumped: A.host, held: [held(A, 'AskUserQuestion', ask, 'ask')] } },
    a.ev(toolEnd('AskUserQuestion', 'u6', ask)),
    reply('p1', {}),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 3000 }),
    { expect: { held: [], status: { [A.host]: 'working' } } },
  ]
}

{
  const a = session(A)
  const text = 'Run the tests and report.'
  fixtures.prompt = [
    note("A Saved Prompt key sends text to an idle session. The poll delivers it, the mod submits it as the user's message, and reports waiting, then done."),
    setup(),
    ...a.hello(),
    { press: { prompt: { session: A.host, text } } },
    reply('n1', { cmds: [{ id: 'c1', t: 'prompt', text }] }),
    { engine: { call: 'prompt.submit', args: { text, asUser: true }, returns: { text, origin: { kind: 'plugin', name: 'streamdeck-bridge', asUser: true } } } },
    a.result('c1', 'waiting'),
    a.next('n2'),
    a.result('c1', 'done'),
    { expect: { cmds: { c1: 'done' } } },
  ]
}

{
  const a = session(A)
  const text = 'Carry on.'
  const why = 'the session was stopped and nobody has sent input since'
  fixtures['prompt-refused'] = [
    note('After the user pressed Esc, the engine drops prompts from the mod until the user types in the session (S2). The Saved Prompt key shows refused. Claude Code keeps the session busy for seconds after the Esc (Phase 4), so the deck shows interrupted from the turn.end, before the registry goes idle.'),
    setup(),
    ...a.hello(),
    a.turn('t1', 'Write a long story'),
    a.ev({ t: 'turn.start', turn: 't1' }),
    a.registry({ status: 'busy', statusUpdatedAt: T0 + 1000 }),
    { expect: { status: { [A.host]: 'working' } } },
    a.turnEnd('t1', 'aborted'),
    a.ev({ t: 'turn.end', turn: 't1', reason: 'aborted' }),
    { expect: { status: { [A.host]: 'interrupted' } } },
    a.registry({ status: 'idle', statusUpdatedAt: T0 + 9000 }),
    { expect: { status: { [A.host]: 'interrupted' } } },
    { press: { prompt: { session: A.host, text } } },
    reply('n1', { cmds: [{ id: 'c1', t: 'prompt', text }] }),
    { engine: { call: 'prompt.submit', args: { text, asUser: true }, returns: { drop: why } } },
    a.result('c1', 'waiting'),
    a.next('n2'),
    a.result('c1', 'refused', { error: `dropped: ${why}` }),
    { expect: { cmds: { c1: 'refused' } } },
  ]
}

{
  const a = session(A)
  const input = { session_id: 'self', mode: 'acceptEdits' }
  const text = 'This session now runs in Accept edits mode (acceptEdits), from Manual ("default") to Accept edits (acceptEdits). It applies to the rest of this turn and every turn after it.'
  fixtures['mode-raise'] = [
    note("One press raises the session to Accept edits. The mod calls the app's mode tool, the app raises a PermissionRequest for it, and the bridge allows that at once because the change is in flight (the user's answer after S4)."),
    setup(),
    ...a.hello(),
    { press: { mode: { session: A.host, mode: 'acceptEdits' } } },
    reply('n1', { cmds: [{ id: 'c1', t: 'mode', mode: 'acceptEdits' }] }),
    { engine: { call: 'mcp.call', args: { server: 'ccd_session_mgmt', tool: 'set_session_permission_mode', args: input }, returns: { content: [{ type: 'text', text }], isError: false } } },
    a.permission('p1', MODE_TOOL, input, { mcp_server: 'ccd_session_mgmt' }),
    reply('p1', ALLOW),
    { expect: { held: [] } },
    a.next('n2'),
    a.result('c1', 'done', { detail: '*' }),
    a.ev({ t: 'settings', mode: 'acceptEdits' }),
    { expect: { cmds: { c1: 'done' }, settings: { [A.host]: { mode: 'acceptEdits' } } } },
  ]
}

{
  const a = session(A)
  const input = { session_id: 'self', mode: 'acceptEdits' }
  fixtures['mode-not-ours'] = [
    note("A PermissionRequest for the app's mode tool with no mode command in flight, as when Claude calls the tool itself, is an ordinary tool request: held, and never allowed by the bridge on its own. No mod lines: the plugin side skips this fixture."),
    setup([A], { [A.host]: 'busy' }),
    a.permission('p1', MODE_TOOL, input, { mcp_server: 'ccd_session_mgmt' }),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 1000 }),
    { expect: { held: [held(A, MODE_TOOL, input)], status: { [A.host]: 'approval' } } },
    { press: { deny: {} } },
    reply('p1', DENY),
    { expect: { held: [] } },
  ]
}

{
  const a = session(A)
  const write = { file_path: `${CWD}/s8.txt`, content: 'eight' }
  fixtures['session-gone'] = [
    note('The session ends while a request is held. Its registry file disappears, and the bridge releases the request with no decision. No mod lines: the plugin side skips this fixture.'),
    setup([A], { [A.host]: 'busy' }),
    a.permission('p1', 'Write', write),
    a.registry({ status: 'waiting', statusUpdatedAt: T0 + 1000 }),
    { expect: { held: [held(A, 'Write', write)] } },
    a.registry({ gone: true }),
    reply('p1', {}),
    { expect: { held: [], sessions: [] } },
  ]
}

{
  const body = { sid: A.sid, host: A.host, inst: A.inst, seq: 1, events: [{ t: 'turn.start', turn: 't1', at: T0 }] }
  const post = (as, headers, extra = { body }) => ({ plugin: { as, method: 'POST', path: '/v1/events', headers, ...extra } })
  fixtures.auth = [
    note('Requests without the right Host or token, or for routes that do not exist, are refused before anything else. In headers, $TOKEN stands for the right token and null leaves a header out. No mod lines: the plugin side skips this fixture.'),
    setup(),
    post('a1', { Authorization: 'Bearer wrong-token' }),
    reply('a1', { error: '*' }, 401),
    post('a2', { Authorization: null }),
    reply('a2', { error: '*' }, 401),
    post('a3', { Host: 'evil.example:47600', Authorization: 'Bearer $TOKEN' }),
    reply('a3', { error: '*' }, 403),
    post('a4', { Host: 'evil.example:47600', Authorization: 'Bearer wrong-token' }),
    reply('a4', { error: '*' }, 403),
    { plugin: { as: 'a5', method: 'GET', path: '/v1/nope' } },
    reply('a5', { error: '*' }, 404),
    { plugin: { as: 'a6', method: 'GET', path: '/v1/permission' } },
    reply('a6', { error: '*' }, 405),
    post('a7', undefined, { raw: 'not json' }),
    reply('a7', { error: '*' }, 400),
  ]
}

// ---- write ---------------------------------------------------------------------

// Only when run, so tools can import the reference implementation without rewriting the fixtures.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true })
  for (const name of fs.readdirSync(OUT)) if (name.endsWith('.jsonl')) fs.rmSync(path.join(OUT, name))
  for (const [name, lines] of Object.entries(fixtures)) {
    const text = lines.map((l) => JSON.stringify(l, (k, v) => (v === undefined ? undefined : v))).join('\n') + '\n'
    fs.writeFileSync(path.join(OUT, `${name}.jsonl`), text)
  }
  fs.writeFileSync(path.join(OUT, 'vectors.json'), JSON.stringify(vectors, null, 2) + '\n')
  console.log(`${Object.keys(fixtures).length} fixtures and ${vectors.length} vectors in ${path.relative(process.cwd(), OUT)}`)
}
