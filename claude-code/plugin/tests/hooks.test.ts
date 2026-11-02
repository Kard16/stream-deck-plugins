// What the mod's hooks report and how its commands run (PROTOCOL.md, "Routes", "Commands", "Events"), beyond
// what the fixtures cover: subagents, errors, settings, the other events, and commands that go wrong.

import { expect, test } from 'claude-code/testing'
import { fingerprint } from '../hooks/fingerprint'
import { HOST, MODEL, SID, START, world } from './world'

test('hello goes first, with the ids, cwd, model and versions; then one poll, with wait=20', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  const [hello, poll] = w.sent
  expect(hello?.method).toBe('POST')
  expect(hello?.route).toBe('/v1/hello')
  expect(hello?.headers['content-type']).toBe('application/json')
  expect(hello?.body).toEqual({
    v: 1,
    sid: SID,
    host: HOST,
    inst: expect.any(String),
    cwd: '/sandbox',
    model: MODEL,
    plugin: '0.1.0',
    cc: '2.1.309',
  })
  expect(poll?.method).toBe('GET')
  expect(poll?.route).toBe('/v1/next')
  expect(poll?.query).toEqual({ sid: SID, host: HOST, inst: hello?.body.inst, wait: '20' })
  expect(w.sent).toHaveLength(2)
})

test('hello says cc "unknown" when the engine gives no version', async ($, on) => {
  const w = world(on)
  w.session.version = ''
  await $.session.start(START)
  await w.settle()
  expect(w.to('/v1/hello')[0]?.body.cc).toBe('unknown')
})

test('without CLAUDE_CODE_HOST_SESSION_ID the mod still talks, with host empty, and the bridge looks the sid up', async ($, on) => {
  const w = world(on, { env: { DECK_TOKEN: 'tok-only' } })
  await $.session.start(START)
  await w.settle()
  expect(w.to('/v1/hello')[0]?.body).toMatchObject({ sid: SID, host: '' })
  expect(w.to('/v1/next')[0]?.query).toMatchObject({ sid: SID, host: '' })
})

test('an input the mod can\'t read costs it its event, never the hook', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  // No context: the measure can't be built, and the engine's own result still comes back.
  const odd = { changed: ['context'] } as unknown as Parameters<typeof $.session.measure>[0]
  expect(await $.session.measure(odd)).toEqual({ changed: ['context'] })
  await w.settle()
  expect(w.to('/v1/events')).toHaveLength(0)
  expect(w.logs).toEqual([])
})

test('tool calls report start and end: a subagent\'s carry its id, an error ends ok false, a refusal carries its reason', async ($, on) => {
  const w = world(on)
  const refusal = "The user doesn't want to proceed with this tool use."
  w.engine.tool = e =>
    e.tool_use_id === 'u2' ? { result: 'Exit code 1', isError: true } : e.tool_use_id === 'u3' ? { deny: refusal } : { result: 'ok' }
  await $.session.start(START)
  await w.settle()
  const read = { file_path: '/sandbox/notes.md' }
  const bash = { command: 'false\necho never', description: 'Fail' }
  const write = { file_path: '/sandbox/s9.txt', content: 'nine' }
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', ...read })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', agentId: 'agent-7', ...bash })
  await $.tool.call({ tool: 'Write', tool_use_id: 'u3', ...write })
  await w.settle()
  const any = expect.any(Number)
  expect(w.events().map(x => x.event)).toEqual([
    { t: 'tool.start', at: any, tool: 'Read', use: 'u1', summary: 'notes.md', fp: fingerprint('Read', read) },
    { t: 'tool.end', at: any, tool: 'Read', use: 'u1', fp: fingerprint('Read', read), ok: true },
    { t: 'tool.start', at: any, tool: 'Bash', use: 'u2', agent: 'agent-7', summary: 'false', fp: fingerprint('Bash', bash) },
    { t: 'tool.end', at: any, tool: 'Bash', use: 'u2', agent: 'agent-7', fp: fingerprint('Bash', bash), ok: false },
    { t: 'tool.start', at: any, tool: 'Write', use: 'u3', summary: 's9.txt', fp: fingerprint('Write', write) },
    { t: 'tool.end', at: any, tool: 'Write', use: 'u3', fp: fingerprint('Write', write), ok: false, denied: refusal },
  ])
  expect(w.events().map(x => x.seq)).toEqual([1, 2, 3, 4, 5, 6])
})

test('a tool call\'s result reaches the session as the engine gave it', async ($, on) => {
  const w = world(on)
  w.engine.tool = () => ({ result: { stdout: 'a\nb', stderr: '', interrupted: false } })
  await $.session.start(START)
  await w.settle()
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' })).toEqual({
    result: { stdout: 'a\nb', stderr: '', interrupted: false },
  })
})

test('settings: mode and effort from the main loop\'s classic hooks, the model after each main turn, and only what changed', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'default', effort: { level: 'low' } })
  await $.classic.PostToolUse({
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'u1',
    permission_mode: 'default',
    effort: { level: 'low' },
  })
  await $.classic.Stop({ stop_hook_active: false, permission_mode: 'acceptEdits', effort: { level: 'low' } })
  // A subagent's mode and effort are its own, not the session's.
  await $.classic.PostToolUseFailure({
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'u2',
    error: 'Exit code 1',
    permission_mode: 'plan',
    effort: { level: 'max' },
    agent_id: 'agent-7',
  })
  await $.classic.StopFailure({ error: 'rate_limit', permission_mode: 'acceptEdits', effort: { level: 'high' } })
  w.session.model = 'claude-sonnet-5-5'
  // A subagent's turn doesn't ask for the model; the main loop's does.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't-sub', reason: 'answer', agentId: 'agent-7' })
  await w.settle()
  expect(w.settings()).toEqual([{ mode: 'default', effort: 'low' }, { mode: 'acceptEdits' }, { effort: 'high' }])
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await w.settle()
  expect(w.settings()).toEqual([{ mode: 'default', effort: 'low' }, { mode: 'acceptEdits' }, { effort: 'high' }, { model: 'claude-sonnet-5-5' }])
})

test('turns, failures, attach, detach, measure and end become events; a measurement of rate limits alone is not sent', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 120, rows: 40 } })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.start({ text: 'look around', turnId: 't-sub', agentId: 'agent-7' })
  await $.turn.complete({ answer: 'found it', durationMs: 9, isAborted: false, turnId: 't-sub', reason: 'answer', agentId: 'agent-7' })
  await $.classic.StopFailure({ error: 'overloaded', error_details: '529 Overloaded' })
  await $.turn.complete({ answer: '', durationMs: 9, isAborted: false, turnId: 't1', reason: 'error' })
  await $.session.measure({ changed: ['rateLimits'], context: { window: 1_000_000 }, rateLimits: [] })
  await $.session.measure({ changed: ['context', 'cost'], context: { tokens: 90_000, window: 1_000_000, percent: 9 }, rateLimits: [], cost: { usd: 0.03 } })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 3, isAborted: true, turnId: 't2', reason: 'aborted' })
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
  await w.settle()
  const any = expect.any(Number)
  expect(w.events().map(x => x.event)).toEqual([
    { t: 'attach', at: any, surface: 'desktop' },
    { t: 'turn.start', at: any, turn: 't1' },
    { t: 'turn.start', at: any, turn: 't-sub', agent: 'agent-7' },
    { t: 'turn.end', at: any, turn: 't-sub', agent: 'agent-7', reason: 'answer' },
    { t: 'failed', at: any, error: 'overloaded' },
    { t: 'turn.end', at: any, turn: 't1', reason: 'error' },
    { t: 'measure', at: any, context: { percent: 9, tokens: 90_000, window: 1_000_000 }, cost: { usd: 0.03 } },
    { t: 'turn.start', at: any, turn: 't2' },
    { t: 'turn.end', at: any, turn: 't2', reason: 'aborted' },
    { t: 'detach', at: any, surface: 'desktop' },
    { t: 'end', at: any, reason: 'prompt_input_exit' },
  ])
})

test("measure carries the context's percent, tokens and window and the cost's usd, and nothing else the engine puts there", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  type Measure = Parameters<typeof $.session.measure>[0]
  // Before the first response the engine has the window alone.
  await $.session.measure({ changed: ['context'], context: { window: 1_000_000 }, rateLimits: [] })
  const extra = { changed: ['context', 'cost'], context: { tokens: 90_000, window: 1_000_000, percent: 9, cached: 4 }, rateLimits: [], cost: { usd: 0.03, currency: 'USD' } }
  await $.session.measure(extra as unknown as Measure)
  await w.settle()
  const any = expect.any(Number)
  expect(w.events().map(x => x.event)).toEqual([
    { t: 'measure', at: any, context: { window: 1_000_000 } },
    { t: 'measure', at: any, context: { percent: 9, tokens: 90_000, window: 1_000_000 }, cost: { usd: 0.03 } },
  ])
})

test('after a /clear, requests carry the new session id', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  w.session.sid = '3fa86955-0000-4000-8000-0000000000bb'
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
  await w.settle()
  await $.turn.start({ text: 'fresh start', turnId: 't1' })
  await w.settle()
  const turn = w.to('/v1/events').find(r => r.body.events[0].t === 'turn.start')
  expect(turn?.body.sid).toBe('3fa86955-0000-4000-8000-0000000000bb')
  expect(turn?.body.host).toBe(HOST)
})

test('a prompt reports waiting, then done; one the engine drops is refused with its reason', async ($, on) => {
  const submitted: string[] = []
  const why = 'the session was stopped and nobody has sent input since'
  const w = world(on, {
    submit: text => {
      submitted.push(text)
      return text === 'Carry on.' ? why : undefined
    },
  })
  await $.session.start(START)
  await w.settle()
  w.deliver([
    { id: 'c1', t: 'prompt', text: 'Run the tests and report.' },
    { id: 'c2', t: 'prompt', text: 'Carry on.' },
  ])
  await w.settle()
  expect(submitted).toEqual(['Run the tests and report.', 'Carry on.'])
  const results = w.results()
  expect(results.filter(r => r.id === 'c1')).toEqual([{ id: 'c1', state: 'waiting' }, { id: 'c1', state: 'done' }])
  expect(results.filter(r => r.id === 'c2')).toEqual([
    { id: 'c2', state: 'waiting' },
    { id: 'c2', state: 'refused', error: `dropped: ${why}` },
  ])
  // The mod polled again as soon as the commands came.
  expect(w.to('/v1/next')).toHaveLength(2)
})

test('commands the mod won\'t run fail with the reason; one without an id is skipped; an id delivered twice runs once', async ($, on) => {
  const submitted: string[] = []
  const w = world(on, {
    submit: text => {
      submitted.push(text)
      return undefined
    },
  })
  await $.session.start(START)
  await w.settle()
  w.deliver([
    { id: 'c1', t: 'prompt', text: '   ' },
    { id: 'c2', t: 'model', model: 'opus' },
    { t: 'prompt', text: 'no id' },
    { id: 'c3', t: 'mode', mode: 'bypassPermissions' },
    { id: 'c4', t: 'prompt', text: 'Only once.' },
  ])
  await w.settle()
  w.deliver([{ id: 'c4', t: 'prompt', text: 'Only once.' }])
  await w.settle()
  expect(submitted).toEqual(['Only once.'])
  const results = w.results()
  expect(results.filter(r => r.id === 'c1')).toEqual([{ id: 'c1', state: 'failed', error: 'the prompt has no text' }])
  expect(results.filter(r => r.id === 'c2')).toEqual([{ id: 'c2', state: 'failed', error: expect.stringMatching(/no command of type "model"/) }])
  expect(results.filter(r => r.id === 'c3')).toEqual([{ id: 'c3', state: 'failed', error: expect.stringMatching(/not "bypassPermissions"/) }])
  expect(results.filter(r => r.id === 'c4')).toEqual([{ id: 'c4', state: 'waiting' }, { id: 'c4', state: 'done' }])
  expect(results).toHaveLength(5)
})

test('a command whose id is the empty string still has a string id: it runs and is reported on', async ($, on) => {
  const submitted: string[] = []
  const w = world(on, {
    submit: text => {
      submitted.push(text)
      return undefined
    },
  })
  await $.session.start(START)
  await w.settle()
  w.deliver([{ id: '', t: 'prompt', text: 'Nameless.' }])
  await w.settle()
  expect(submitted).toEqual(['Nameless.'])
  expect(w.results()).toEqual([
    { id: '', state: 'waiting' },
    { id: '', state: 'done' },
  ])
})

test("a mode command calls the app's own tool for this session: done with its text, then settings; refused with the tool's text; failed when the call throws", async ($, on) => {
  const calls: unknown[] = []
  const w = world(on, {
    mcp: e => {
      calls.push(e)
      if (e.args.mode === 'plan') {
        return { value: { content: [{ type: 'text', text: 'Refused: this session is waiting for the user to answer a request.' }], isError: true } }
      }
      if (e.args.mode === 'auto') return { deny: 'the engine refused the call' }
      return { value: { content: [{ type: 'text', text: 'This session now runs in Accept edits mode.' }], isError: false } }
    },
  })
  await $.session.start(START)
  await w.settle()
  w.deliver([{ id: 'c1', t: 'mode', mode: 'acceptEdits' }])
  await w.settle()
  w.deliver([{ id: 'c2', t: 'mode', mode: 'plan' }])
  await w.settle()
  w.deliver([{ id: 'c3', t: 'mode', mode: 'auto' }])
  await w.settle()
  expect(calls).toEqual([
    { server: 'ccd_session_mgmt', tool: 'set_session_permission_mode', args: { session_id: 'self', mode: 'acceptEdits' } },
    { server: 'ccd_session_mgmt', tool: 'set_session_permission_mode', args: { session_id: 'self', mode: 'plan' } },
    { server: 'ccd_session_mgmt', tool: 'set_session_permission_mode', args: { session_id: 'self', mode: 'auto' } },
  ])
  expect(w.results()).toEqual([
    { id: 'c1', state: 'done', detail: 'This session now runs in Accept edits mode.' },
    { id: 'c2', state: 'refused', error: 'Refused: this session is waiting for the user to answer a request.' },
    { id: 'c3', state: 'failed', error: expect.stringMatching(/the engine refused the call/) },
  ])
  // Mode commands skip waiting; a done one is followed by the new mode.
  expect(w.settings()).toEqual([{ mode: 'acceptEdits' }])
  const order = w.sent.filter(r => r.route !== '/v1/next').map(r => (r.route === '/v1/events' ? r.body.events[0].t : r.body.state ?? r.route))
  expect(order).toEqual(['/v1/hello', 'done', 'settings', 'refused', 'failed'])
})
