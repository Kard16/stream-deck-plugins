// The session's other loops in the threads event (PROTOCOL.md, "Events", threads; threads.ts), and what the mod no
// longer sends of them: their kinds and descriptions, what each is doing, the workflow runs and their counts, the caps
// and the order, when a snapshot goes, and again after a hello. The clock is the kit's mock, so the second between
// sends is exact.

import type { AgentSpawnInput } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { RETRY_MS, STALL_MS } from '../hooks/bridge'
import type { DeckEvent } from '../hooks/events'
import { createThreads, MAX_AGENTS, THREADS_MS, type Snapshot } from '../hooks/threads'
import { DESKTOP_ENV, MODEL, START, world } from './world'

type World = ReturnType<typeof world>

/** An agent.spawn's input as the engine raises it: a foreground subagent, unless the test says otherwise. */
const spawning = (e: Partial<AgentSpawnInput>): AgentSpawnInput => ({
  tool_use_id: 'u1',
  prompt: 'Do the task.',
  description: '',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: MODEL,
  background: false,
  fork: false,
  ...e,
})

const run = (runId: string) => ({ workflow: { runId, agentIndex: 1 } })

/** An agent starts as the engine starts one: its spawn, which the world answers with the next id (a1, a2...), then its turn. */
async function begin($: Engine, e: Partial<AgentSpawnInput> = {}): Promise<string> {
  const id = (await $.agent.spawn(spawning(e))).agentId ?? ''
  await $.turn.start({ text: 'Do the task.', turnId: `${id}-t1`, agentId: id })
  return id
}

/** An agent's turn ends. */
const end = ($: Engine, id: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: `${id}-t1`, reason, agentId: id })

/** The threads the mod sent, without `t` and `at`. */
const sent = (w: World): Snapshot[] =>
  w
    .events()
    .map(x => x.event)
    .filter(x => x.t === 'threads')
    .map(({ t: _t, at: _at, ...snapshot }) => snapshot)

/** The snapshot the deck holds: the last one sent. */
const latest = (w: World) => sent(w).at(-1)

/** The clock's time each threads went. */
const times = (w: World) => w.to('/v1/events').filter(r => r.body.events[0].t === 'threads').map(r => r.at)

async function session($: Engine, on: Parameters<typeof world>[0]): Promise<World> {
  const w = world(on)
  await $.session.start(START)
  await w.settle()
  return w
}

test("a loop's kind comes from its spawn, in the protocol's order, and one the mod saw no spawn for is other", async ($, on) => {
  const w = await session($, on)
  // Each also has every flag the kinds after it test, so the order shows.
  await begin($, { description: 'w', ...run('wf_1'), isTeammate: true, fork: true, background: true })
  await begin($, { description: 't', isTeammate: true, fork: true, background: true })
  await begin($, { description: 'f', fork: true, background: true })
  await begin($, { description: 'b', background: true })
  await begin($, { description: 's' })
  await $.turn.start({ text: '', turnId: 'x-t1', agentId: 'x' })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.agents).toEqual([
    { kind: 'other', desc: '', doing: '' },
    { kind: 'subagent', desc: 's', doing: '' },
    { kind: 'background', desc: 'b', doing: '' },
    { kind: 'fork', desc: 'f', doing: '' },
    { kind: 'teammate', desc: 't', doing: '' },
    { kind: 'workflow', desc: 'w', doing: '', run: 'wf_1' },
  ])
})

test('agents lists up to 8 of the loops in a turn, the most recently started first, and running counts them all', async ($, on) => {
  const w = await session($, on)
  const ids: string[] = []
  for (let i = 1; i <= MAX_AGENTS + 1; i++) ids.push(await begin($, { description: `agent ${i}` }))
  // The fifth's turn ends, and it starts another: now it's the most recently started.
  const fifth = ids[4] ?? ''
  await end($, fifth)
  await $.turn.start({ text: 'Again.', turnId: `${fifth}-t2`, agentId: fifth })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.running).toBe(9)
  expect(latest(w)?.agents.map(a => a.desc)).toEqual(['agent 5', 'agent 9', 'agent 8', 'agent 7', 'agent 6', 'agent 4', 'agent 3', 'agent 2'])
})

test('runs lists up to 3 workflow runs: those with a loop in a turn first, then the most recently started', async ($, on) => {
  const w = await session($, on)
  await begin($, run('wf_1'))
  for (const id of ['wf_2', 'wf_3', 'wf_4']) await end($, await begin($, run(id)))
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.runs).toEqual([
    { run: 'wf_1', name: 'workflow', started: 1, finished: 0, failed: 0, open: 1 },
    { run: 'wf_4', name: 'workflow', started: 1, finished: 1, failed: 0, open: 0 },
    { run: 'wf_3', name: 'workflow', started: 1, finished: 1, failed: 0, open: 0 },
  ])
})

test("desc is the spawn's description, else its subagent type, at most 60 characters", async ($, on) => {
  const w = await session($, on)
  await begin($, { description: 'd'.repeat(60) })
  await begin($, { description: `${'e'.repeat(59)}xy` })
  await begin($, { description: '', subagentType: 'Explore' })
  await begin($, { description: '', subagentType: '' })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.agents.map(a => a.desc)).toEqual(['', 'Explore', `${'e'.repeat(59)}…`, 'd'.repeat(60)])
})

test("the main loop's Workflow result names its run, after the call's tool.end: workflowName, else the call's name input, else workflow; another loop's call or a result with no runId names none", async ($, on) => {
  const w = await session($, on)
  const results: Record<string, unknown> = {
    u1: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'review' },
    u2: { status: 'async_launched', taskId: 't2', runId: 'wf_2' },
    u3: { status: 'async_launched', taskId: 't3', runId: 'wf_3' },
    u4: { status: 'async_launched', taskId: 't4', runId: 'wf_4', workflowName: 'nested' },
    u5: { status: 'remote_launched', taskId: 't5', sessionUrl: 'https://claude.ai/code/x' },
  }
  w.engine.tool = e => ({ result: results[String(e.tool_use_id)] })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u1', script: 'review' })
  await w.settle()
  expect(w.events().map(x => x.event.t)).toEqual(['tool.start', 'tool.end', 'threads'])
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u2', name: 'nightly' })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u3', script: 'unnamed' })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u4', agentId: 'a9', script: 'nested' })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u5', name: 'remote' })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.runs.map(r => [r.run, r.name])).toEqual([
    ['wf_3', 'workflow'],
    ['wf_2', 'nightly'],
    ['wf_1', 'review'],
  ])
})

test('an agent whose runId no Workflow result named starts a run named workflow, until a result names it', async ($, on) => {
  const w = await session($, on)
  w.engine.tool = () => ({ result: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'review' } })
  await begin($, run('wf_1'))
  await w.settle()
  expect(latest(w)?.runs).toEqual([{ run: 'wf_1', name: 'workflow', started: 1, finished: 0, failed: 0, open: 0 }])
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u1', script: 'review' })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.runs).toEqual([{ run: 'wf_1', name: 'review', started: 1, finished: 0, failed: 0, open: 1 }])
})

test("a run counts its agents' spawns as started, their turns' ends as finished, and those that end in an error or a refusal as failed", async ($, on) => {
  const w = await session($, on)
  const ids: string[] = []
  for (let i = 0; i < 5; i++) ids.push(await begin($, run('wf_1')))
  const [answered = '', aborted = '', errored = '', refused = ''] = ids
  await end($, answered, 'answer')
  await end($, aborted, 'aborted')
  await end($, errored, 'error')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `${refused}-t1`, reason: 'refusal', refusal: { category: null, explanation: null }, agentId: refused })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.runs).toEqual([{ run: 'wf_1', name: 'workflow', started: 5, finished: 4, failed: 2, open: 1 }])
})

test("a loop whose turn.start the mod didn't hear isn't in a turn: its calls change nothing in threads, though their tool.end goes out, and its end still counts for its run", async ($, on) => {
  const w = await session($, on)
  // The spawn is heard and the start isn't, as when the spawn was nested in the hook (the d.ts, turn.complete).
  const id = (await $.agent.spawn(spawning(run('wf_1')))).agentId ?? ''
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u1', agentId: id, pattern: 'Device' })
  await w.clock.advance(THREADS_MS)
  await end($, id)
  await w.settle()
  expect(w.events().map(x => x.event.t)).toEqual(['threads', 'tool.end', 'threads'])
  expect(sent(w)).toEqual([
    { running: 0, agents: [], runs: [{ run: 'wf_1', name: 'workflow', started: 1, finished: 0, failed: 0, open: 0 }] },
    { running: 0, agents: [], runs: [{ run: 'wf_1', name: 'workflow', started: 1, finished: 1, failed: 0, open: 0 }] },
  ])
  expect(times(w)).toEqual([0, THREADS_MS])
})

test("doing is a loop's latest tool call, as <tool>: <summary>, or the summary alone when it says no more than the tool", async ($, on) => {
  const w = await session($, on)
  const [a, b, c, d] = [await begin($, { description: 'a' }), await begin($, { description: 'b' }), await begin($, { description: 'c' }), await begin($, { description: 'd' })]
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', agentId: a, command: 'npm test' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', agentId: a, file_path: '/sandbox/notes.md' })
  // An MCP tool's summary names the tool.
  await $.tool.call({ tool: 'mcp__linear__create_issue', tool_use_id: 'u3', agentId: b, title: 'Deck drops' })
  // A tool with no summary rule: its summary is its name, cut to 40 when it's longer, and doing is that alone.
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'u4', agentId: c, todos: [] })
  const long = 'AnExtraordinarilyLongCustomToolNameOfFortyFiveCh'
  await $.tool.call({ tool: long, tool_use_id: 'u5', agentId: d })
  // ExitPlanMode's rule fixes its summary, whatever the plan: it stands alone too.
  const e = await begin($, { description: 'e' })
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'u6', agentId: e, plan: 'Do it.' })
  await w.clock.advance(THREADS_MS)
  expect(latest(w)?.agents.map(x => [x.desc, x.doing])).toEqual([
    ['e', 'Plan ready'],
    ['d', `${long.slice(0, 39)}…`],
    ['c', 'TodoWrite'],
    ['b', 'create issue'],
    ['a', 'Read: notes.md'],
  ])
})

test("doing shows another loop's call while it runs, before its tool.end, as a long Bash does", async ($, on) => {
  const w = await session($, on)
  const a = await begin($, { description: 'tests' })
  let finish = (): void => {}
  w.engine.tool = () =>
    new Promise(resolve => {
      finish = () => resolve({ result: 'ran' })
    })
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'u1', agentId: a, command: 'npm test' })
  await w.clock.advance(THREADS_MS)
  expect(w.events().map(x => x.event.t)).toEqual(['threads', 'threads'])
  expect(latest(w)?.agents).toEqual([{ kind: 'subagent', desc: 'tests', doing: 'Bash: npm test' }])
  finish()
  await call
  await w.settle()
  expect(w.events().map(x => x.event.t)).toEqual(['threads', 'threads', 'tool.end'])
})

test('threads goes when the picture changes, at most once a second: the first change after a quiet second at once, and the rest of that second as one event when it is up, as things then stand', async ($, on) => {
  const w = await session($, on)
  const a = await begin($, { description: 'a' })
  const b = await begin($, { description: 'b' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', agentId: b, command: 'ls' })
  await w.clock.advance(400)
  await end($, a)
  await w.settle()
  expect(times(w)).toEqual([0])
  await w.clock.advance(600)
  expect(sent(w)).toEqual([
    { running: 1, agents: [{ kind: 'subagent', desc: 'a', doing: '' }], runs: [] },
    { running: 1, agents: [{ kind: 'subagent', desc: 'b', doing: 'Bash: ls' }], runs: [] },
  ])
  expect(times(w)).toEqual([0, 1000])
  // A change undone within the next second leaves nothing to send when it's up, and that second ends quiet.
  await end($, await begin($, { description: 'c' }))
  await w.clock.advance(1000)
  expect(times(w)).toEqual([0, 1000])
  // So the next change goes at once.
  await w.clock.advance(500)
  await end($, b)
  await w.settle()
  expect(times(w)).toEqual([0, 1000, 2500])
  expect(latest(w)).toEqual({ running: 0, agents: [], runs: [] })
})

test("before the main loop's turn.end or failed, the mod sends what threads holds back, so the deck knows whether work goes on; another loop's end or failed doesn't", async ($, on) => {
  const w = await session($, on)
  const kinds = () => w.events().map(x => x.event.t)
  await $.turn.start({ text: 'Fan out.', turnId: 't1' })
  const a = await begin($, { description: 'logs' })
  await begin($, { description: 'web' })
  await $.classic.StopFailure({ error: 'overloaded', agent_id: a })
  await end($, a, 'error')
  await w.settle()
  expect(kinds()).toEqual(['turn.start', 'threads', 'failed'])
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
  expect(kinds()).toEqual(['turn.start', 'threads', 'failed', 'threads', 'turn.end'])
  expect(latest(w)?.agents).toEqual([{ kind: 'subagent', desc: 'web', doing: '' }])
  // What was held went, so nothing goes when the second is up.
  await w.clock.advance(THREADS_MS)
  expect(sent(w)).toHaveLength(2)

  // The same before the main loop's failed, a turn that died on an API error.
  await $.turn.start({ text: 'Again.', turnId: 't2' })
  await begin($, { description: 'more' })
  await begin($, { description: 'most' })
  await $.classic.StopFailure({ error: 'overloaded' })
  await w.settle()
  expect(kinds().slice(5)).toEqual(['turn.start', 'threads', 'threads', 'failed'])
  expect(latest(w)?.running).toBe(3)
})

test('a threads the flush sends starts a second of its own: a change 800 ms after it waits for that second to end', async ($, on) => {
  const w = await session($, on)
  await $.turn.start({ text: 'Fan out.', turnId: 't1' })
  // At 0 the first goes at once, and its second runs to 1000. At 400 a change waits, and the turn's end sends it.
  const a = await begin($, { description: 'a' })
  await w.clock.advance(400)
  await begin($, { description: 'b' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
  expect(times(w)).toEqual([0, 400])
  // So the second runs from 400 to 1400: a change at 1200 waits for its end.
  await w.clock.advance(800)
  await end($, a)
  await w.settle()
  expect(times(w)).toEqual([0, 400])
  await w.clock.advance(200)
  expect(times(w)).toEqual([0, 400, 1400])
})

test("another loop's turn.start, tool.start and turn.end don't go on the line; its tool.end and failed do", async ($, on) => {
  const w = await session($, on)
  await $.turn.start({ text: 'Look around.', turnId: 's-t1', agentId: 's' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', agentId: 's', file_path: '/sandbox/notes.md' })
  await $.classic.StopFailure({ error: 'overloaded', agent_id: 's' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's-t1', reason: 'error', agentId: 's' })
  await w.clock.advance(THREADS_MS)
  expect(w.events().map(x => [x.event.t, x.event.agent])).toEqual([
    ['threads', undefined],
    ['tool.end', 's'],
    ['failed', 's'],
    ['threads', undefined],
  ])
  expect(w.events().map(x => x.seq)).toEqual([1, 2, 3, 4])
})

test('a mod that loads mid-session starts with an empty picture: a loop it heard no start of changes nothing, and it sends no threads until something does', async ($, on) => {
  const w = await session($, on)
  // A subagent at work since before the mod loaded.
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u1', agentId: 'old', pattern: 'Device' })
  await end($, 'old')
  await w.clock.advance(THREADS_MS)
  expect(w.events().map(x => x.event.t)).toEqual(['tool.end'])
  // A loop it hears start shows, as other: the mod saw no spawn for it.
  await $.turn.start({ text: '', turnId: 'new-t1', agentId: 'new' })
  await w.settle()
  expect(sent(w)).toEqual([{ running: 1, agents: [{ kind: 'other', desc: '', doing: '' }], runs: [] }])
})

test('agent.spawn passes through: the caller gets what the engine answered, a deny included, and a spawn that started no agent shows nothing', async ($, on) => {
  const w = await session($, on)
  w.engine.spawn = () => ({ model: 'claude-opus-5-5', agentId: 'x1', teammateId: 'scout@team' })
  expect(await $.agent.spawn(spawning({ description: 'scout', isTeammate: true, background: true }))).toEqual({
    model: 'claude-opus-5-5',
    agentId: 'x1',
    teammateId: 'scout@team',
  })
  w.engine.spawn = () => ({ deny: 'no more agents' })
  expect(await $.agent.spawn(spawning(run('wf_1')))).toEqual({ deny: 'no more agents' })
  await w.clock.advance(THREADS_MS)
  expect(sent(w)).toEqual([])
  // The teammate's turn: it shows as its spawn said, and the denied spawn's run shows nowhere.
  await $.turn.start({ text: 'Scout.', turnId: 'x1-t1', agentId: 'x1' })
  await w.settle()
  expect(sent(w)).toEqual([{ running: 1, agents: [{ kind: 'teammate', desc: 'scout', doing: '' }], runs: [] }])
  expect(w.logs).toEqual([])
})

test('a spawn that fails beneath the mod fails for its caller too: the hook passes the rejection on, and nothing goes on the line or into threads', async ($, on) => {
  const w = await session($, on)
  w.engine.spawn = () => {
    throw new Error('no room for another agent')
  }
  // The kit skips a hook beneath that throws, so the spawn rejects with what lies beneath that: the kit's own error.
  await expect($.agent.spawn(spawning({ description: 'x', ...run('wf_1') }))).rejects.toThrow()
  await w.clock.advance(THREADS_MS)
  expect(w.events()).toEqual([])
  // An agent's turn shows alone: the failed spawn left no run.
  await $.turn.start({ text: 'Scout.', turnId: 'y-t1', agentId: 'y' })
  await w.settle()
  expect(sent(w)).toEqual([{ running: 1, agents: [{ kind: 'other', desc: '', doing: '' }], runs: [] }])
})

test('in a process the bridge never talks from, threads sets no timer, as the bridge sets none, even for a change heard before the bridge has read the environment', async ($, on) => {
  // The world's mock clock answers clock.after; a hook matched to the second, beside it, sees each such timer.
  const timers: number[] = []
  on('clock.after', { ms: THREADS_MS }, (_$, e, next) => {
    timers.push(e.ms)
    return next(e)
  })
  const w = world(on, { env: { ...DESKTOP_ENV, DECK_TOKEN: '' } })
  // The first hook to run is an agent's turn.start, as after the mod reloads mid-session: the bridge starts there,
  // and reads the environment after the change.
  await $.turn.start({ text: 'Do the task.', turnId: 'x-t1', agentId: 'x' })
  await w.settle()
  await begin($, run('wf_1'))
  await begin($)
  await w.clock.advance(THREADS_MS)
  expect({ timers, sent: w.sent }).toEqual({ timers: [], sent: [] })
})

/** The snapshot while one subagent, `tests`, is in a turn, before its first call. */
const TESTS: Snapshot = { running: 1, agents: [{ kind: 'subagent', desc: 'tests', doing: '' }], runs: [] }

test('after each hello the deck answers, the snapshot goes again, after it: a deck that restarted lost it, and an agent busy on one long call changes nothing for minutes', async ($, on) => {
  const w = await session($, on)
  await begin($, { description: 'tests' })
  await w.clock.advance(5000)
  // The deck restarts: the poll it held drops, and the quick hello 100 ms later is answered.
  w.drop()
  await w.clock.advance(RETRY_MS)
  await w.settle()
  expect(sent(w)).toEqual([TESTS, TESTS])
  expect(times(w)).toEqual([0, 5100])
  expect(w.events().map(x => x.seq)).toEqual([1, 2])
  expect(w.sent.filter(r => r.at === 5100).map(r => r.route)).toEqual(['/v1/hello', '/v1/next', '/v1/events'])
  // It goes once: when its second is up, nothing has changed, so nothing goes.
  await w.clock.advance(THREADS_MS)
  expect(times(w)).toEqual([0, 5100])
})

test('a hello sends no threads while the picture has been empty since the mod loaded, no loop in a turn and no run, and does once it has had a run alone', async ($, on) => {
  const w = await session($, on)
  // A spawn that started no agent, and a call from a loop the mod heard no start of, leave the picture empty.
  w.engine.spawn = () => ({ deny: 'no more agents' })
  await $.agent.spawn(spawning({ description: 'x' }))
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u1', agentId: 'old', pattern: 'Device' })
  w.drop()
  await w.clock.advance(RETRY_MS)
  await w.settle()
  expect(w.to('/v1/hello')).toHaveLength(2)
  expect(w.events().map(x => x.event.t)).toEqual(['tool.end'])
  // A Workflow result names a run, with no loop of it ever in a turn: that goes, and again after the next hello.
  w.engine.tool = () => ({ result: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'review' } })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u2', script: 'review' })
  await w.clock.advance(5000)
  w.drop()
  await w.clock.advance(RETRY_MS)
  await w.settle()
  expect(w.to('/v1/hello')).toHaveLength(3)
  const review: Snapshot = { running: 0, agents: [], runs: [{ run: 'wf_1', name: 'review', started: 0, finished: 0, failed: 0, open: 0 }] }
  expect(sent(w)).toEqual([review, review])
})

test('the snapshot a hello sends again keeps to once a second: within a second of the last, it goes when that second is up', async ($, on) => {
  const w = await session($, on)
  await begin($, { description: 'tests' })
  await w.clock.advance(200)
  w.drop()
  await w.clock.advance(RETRY_MS)
  await w.settle()
  expect(w.to('/v1/hello')).toHaveLength(2)
  expect(times(w)).toEqual([0])
  await w.clock.advance(700)
  expect(times(w)).toEqual([0, 1000])
  expect(sent(w)).toEqual([TESTS, TESTS])
})

test('from a failed request until the next answered hello, no threads is queued: the one after that hello stands for them, an empty one included', async ($, on) => {
  const w = await session($, on)
  const a = await begin($, { description: 'a' })
  // The deck stops, and restarts: the poll drops, and the quick hello 100 ms later is refused, which begins an
  // outage: hello again 1, 2 and 5 s after each refusal.
  w.bridge.mode = 'down'
  w.drop()
  await w.clock.advance(RETRY_MS)
  // Meanwhile the main loop's turn starts, another agent starts and calls a tool, and both agents end, a second apart.
  await $.turn.start({ text: 'More.', turnId: 't1' })
  const b = await begin($, { description: 'b' })
  await w.clock.advance(1000)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', agentId: b, command: 'npm test' })
  await w.clock.advance(1000)
  await end($, a)
  await w.clock.advance(1000)
  await end($, b)
  expect(w.to('/v1/hello').map(r => r.at)).toEqual([0, 100, 1100, 3100])
  // The deck is back for the hello at 8100: what was queued goes, then the snapshot as it stands.
  w.bridge.mode = 'up'
  await w.clock.advance(5000)
  await w.settle()
  expect(w.events().map(x => [x.seq, x.event.t])).toEqual([
    [1, 'threads'],
    [2, 'turn.start'],
    [3, 'tool.end'],
    [4, 'threads'],
  ])
  expect(latest(w)).toEqual({ running: 0, agents: [], runs: [] })
  expect(times(w)).toEqual([0, 8100])
})

test('while a hello waits on a deck that took it and hangs, no threads is queued either: one goes after the hello that is answered', async ($, on) => {
  const w = await session($, on)
  const a = await begin($, { description: 'a' })
  // The deck hangs: the poll drops, and the quick hello 100 ms later is taken and never answered (PROTOCOL.md, Failure
  // and recovery: a deck that hangs). Meanwhile other agents start and end, a second apart.
  w.bridge.mode = 'hang'
  w.drop()
  await w.clock.advance(RETRY_MS)
  const b = await begin($, { description: 'b' })
  await w.clock.advance(1000)
  await begin($, { description: 'c' })
  await w.clock.advance(1000)
  await end($, a)
  await w.clock.advance(1000)
  await end($, b)
  // The deck is back by the time that hello stalls and the next goes.
  w.bridge.mode = 'up'
  await w.clock.advance(STALL_MS + 30_000)
  await w.settle()
  expect(w.events().filter(x => x.event.t === 'threads')).toHaveLength(2)
  expect(latest(w)).toEqual({ running: 1, agents: [{ kind: 'subagent', desc: 'c', doing: '' }], runs: [] })
})

test('nothing goes before the first answered hello: a change heard as the mod loads, before the bridge has read the environment, goes once that hello is answered, and once', async ($, on) => {
  const w = world(on)
  // The first hook to run is an agent's turn.start, as after the mod reloads mid-session.
  await $.turn.start({ text: 'Do the task.', turnId: 'x-t1', agentId: 'x' })
  await w.settle()
  await w.clock.advance(THREADS_MS)
  expect(w.sent.map(r => r.route)).toEqual(['/v1/hello', '/v1/next', '/v1/events'])
  expect(sent(w)).toEqual([{ running: 1, agents: [{ kind: 'other', desc: '', doing: '' }], runs: [] }])
})

test("if the engine won't set a timer, each change goes at once, and the hook that made it goes on", () => {
  const sent: DeckEvent[] = []
  const threads = createThreads({
    after: () => {
      throw new Error('no timers here')
    },
    emit: event => sent.push(event),
    up: () => true,
  })
  threads.turnStarted('a1')
  threads.turnStarted('a2')
  threads.flush()
  expect(sent.map(x => x.running)).toEqual([1, 2])
})
