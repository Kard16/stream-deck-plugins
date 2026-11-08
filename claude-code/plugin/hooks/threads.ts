// The session's other loops, "threads" (PROTOCOL.md, "Events", threads; docs/claude-code/agents-and-wake.md, B1):
// subagents, teammates, forks and workflow agents, as the mod's hooks observe them, never changing what they do.
// - agent.spawn: a started agent's id, what next(e) resolved to, with its kind, description and workflow run.
// - turn.start and turn.complete with agentId: which loops are in a turn now, and how each run's agents ended.
// - tool.call in another loop: what each loop in a turn is doing.
// - the main loop's Workflow call: the name of the run its result names.
//
// The deck gets the picture as a snapshot, the `threads` event, when it changes, and at most once a second
// (PROTOCOL.md, "Rates"): the first change after a quiet second goes at once, later changes in that second as one
// event when the second is up, as things then stand. register.ts flushes what's held before a main-loop turn.end or
// failed, so the deck knows at the turn's end whether work goes on. A mod that reloads starts with an empty picture,
// and sends nothing until it changes.
//
// A snapshot goes on the bridge's line only while it's up: from a failed request until the next answered hello none
// is queued, nor before the first. After each hello the deck answers, the snapshot goes again, still at most once a
// second, unless the picture has been empty since the mod loaded: the deck may have restarted and lost it, an agent
// busy on one long call changes nothing for minutes, and it stands for the snapshots not queued meanwhile. In a
// process the bridge never talks from, the line never comes up, so nothing is made, sent or timed.

import type { Timer } from './bridge'
import type { DeckEvent, ToolCallSeen } from './events'
import { summary } from './fingerprint'

/** At most one threads event a second (PROTOCOL.md, "Rates"). */
export const THREADS_MS = 1000
/** How many loops in a turn, and workflow runs, a snapshot lists (PROTOCOL.md, "Events", threads). */
export const MAX_AGENTS = 8
export const MAX_RUNS = 3
/** The longest `desc` or `doing`: a longer one is cut to one fewer, then `…`, as a summary is cut. */
const MAX_TEXT = 60

export type Kind = 'workflow' | 'teammate' | 'fork' | 'background' | 'subagent' | 'other'
export type ThreadAgent = { kind: Kind; desc: string; doing: string; run?: string }
export type ThreadRun = { run: string; name: string; started: number; finished: number; failed: number; open: number }
export type Snapshot = { running: number; agents: ThreadAgent[]; runs: ThreadRun[] }

export type ThreadsHost = {
  /** `$.clock.after`, which times the second after each send. */
  after: (ms: number, fn: () => void) => Timer
  /** The bridge's line, with the events' seq and order. */
  emit: (event: DeckEvent) => void
  /**
   * Whether the line is up: a hello answered, and no request failed since. While it isn't, nothing is made, sent or
   * timed, and the next answered hello's snapshot stands for what changed meanwhile.
   */
  up: () => boolean
}

export type Threads = {
  /** An agent.spawn's input, and the id of the agent it started (undefined when it started none). */
  spawned: (e: Readonly<Record<string, unknown>>, agentId: unknown) => void
  turnStarted: (agentId: string) => void
  turnEnded: (agentId: string, reason: unknown) => void
  /** Another loop's tool call. */
  called: (call: ToolCallSeen) => void
  /** The main loop's Workflow call: its result's `result`, and the call's `name` input. */
  workflow: (result: unknown, name: unknown) => void
  /** Sends the snapshot held back, if any: before a main-loop turn.end or failed. */
  flush: () => void
  /** The deck answered a hello: the snapshot goes again, unless the picture has been empty since the mod loaded. */
  hello: () => void
}

type Loop = { kind: Kind; desc: string; run?: string }
type Run = { name: string; started: number; finished: number; failed: number }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const cut = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)

/** The spawn's kind, in the protocol's order: a workflow agent may run in the background too. */
function kindOf(e: Readonly<Record<string, unknown>>): Kind {
  if (isRecord(e.workflow)) return 'workflow'
  if (e.isTeammate === true) return 'teammate'
  if (e.fork === true) return 'fork'
  if (e.background === true) return 'background'
  return 'subagent'
}

/**
 * `<tool>: <summary>`, or the summary alone when it would read the same without the call's arguments: an MCP tool's,
 * which names the tool; one with no summary rule, which is the tool's name (`TodoWrite`, not `TodoWrite: TodoWrite`);
 * and ExitPlanMode's `Plan ready`, which its rule fixes.
 */
const doingOf = (c: ToolCallSeen): string => cut(c.summary === summary(c.tool, {}) ? c.summary : `${c.tool}: ${c.summary}`)

const EMPTY: Snapshot = { running: 0, agents: [], runs: [] }

export function createThreads(host: ThreadsHost): Threads {
  /** What each agent's spawn said, by agent id. */
  const loops = new Map<string, Loop>()
  /** The loops in a turn now, each with what it's doing, in the order their turns started. */
  const turns = new Map<string, string>()
  /** The workflow runs, by run id, in the order the mod first heard of each. */
  const runs = new Map<string, Run>()
  /** The snapshot last sent: a mod that loads starts from the empty one, so it sends nothing until that changes. */
  let sent = JSON.stringify(EMPTY)
  /** The second after a send: changes in it wait for its end. */
  let second: Timer | undefined
  /** Whether the picture has had a loop in a turn, or a run, since the mod loaded: until it has, a hello sends none. */
  let anything = false
  /** Whether the next send goes though its snapshot is the one last sent: a hello asked for it again. */
  let again = false

  function snapshot(): Snapshot {
    const open = new Map<string, number>()
    for (const id of turns.keys()) {
      const run = loops.get(id)?.run
      if (run !== undefined) open.set(run, (open.get(run) ?? 0) + 1)
    }
    const agents = [...turns]
      .reverse()
      .slice(0, MAX_AGENTS)
      .map(([id, doing]): ThreadAgent => {
        const loop = loops.get(id)
        return { kind: loop?.kind ?? 'other', desc: loop?.desc ?? '', doing, ...(loop?.run === undefined ? {} : { run: loop.run }) }
      })
    // The most recent first, then those with a loop in a turn ahead of the rest: the sort keeps the order within each.
    const listed = [...runs]
      .reverse()
      .map(([run, r]): ThreadRun => ({ run, name: r.name, started: r.started, finished: r.finished, failed: r.failed, open: open.get(run) ?? 0 }))
      .sort((a, b) => Number(b.open > 0) - Number(a.open > 0))
      .slice(0, MAX_RUNS)
    return { running: turns.size, agents, runs: listed }
  }

  /**
   * Sends the snapshot, if the line is up and it isn't the one last sent or a hello asked for it again, and holds
   * later changes for a second.
   */
  function send(): void {
    if (!host.up()) return
    const now = snapshot()
    const text = JSON.stringify(now)
    if (text === sent && !again) return
    sent = text
    again = false
    host.emit({ t: 'threads', at: Date.now(), ...now })
    second?.cancel()
    try {
      second = host.after(THREADS_MS, () => {
        second = undefined
        send()
      })
    } catch {
      second = undefined
    }
  }

  /** The first change after a quiet second goes at once; one within the second waits for its end. */
  function changed(): void {
    if (turns.size > 0 || runs.size > 0) anything = true
    if (second === undefined) send()
  }

  /** A run by its id, named `workflow` until a Workflow result names it. */
  function runOf(id: string): Run {
    let run = runs.get(id)
    if (run === undefined) {
      run = { name: 'workflow', started: 0, finished: 0, failed: 0 }
      runs.set(id, run)
    }
    return run
  }

  return {
    spawned(e, agentId) {
      // A spawn that started no agent of this session (a deny, a remote workflow agent) has no loop to show.
      const id = str(agentId)
      if (id === undefined) return
      const run = isRecord(e.workflow) ? str(e.workflow.runId) : undefined
      loops.set(id, { kind: kindOf(e), desc: cut(str(e.description) ?? str(e.subagentType) ?? ''), ...(run === undefined ? {} : { run }) })
      if (run !== undefined) runOf(run).started++
      changed()
    },
    turnStarted(agentId) {
      // A loop's end always follows its start (the d.ts, turn.complete), and takes it out: it goes in again last.
      turns.set(agentId, '')
      changed()
    },
    turnEnded(agentId, reason) {
      // Every end counts for the agent's run, though the mod may not have heard the start (the d.ts, turn.complete).
      const run = loops.get(agentId)?.run
      const r = run === undefined ? undefined : runs.get(run)
      if (r !== undefined) {
        r.finished++
        if (reason === 'error' || reason === 'refusal') r.failed++
      }
      turns.delete(agentId)
      changed()
    },
    called(call) {
      // A loop whose turn.start the mod didn't hear isn't in a turn for it: its calls change nothing here.
      if (call.agent === undefined || !turns.has(call.agent)) return
      turns.set(call.agent, doingOf(call))
      changed()
    },
    workflow(result, name) {
      if (!isRecord(result)) return
      const id = str(result.runId)
      if (id === undefined) return
      runOf(id).name = str(result.workflowName) ?? str(name) ?? 'workflow'
      changed()
    },
    flush() {
      if (second !== undefined) send()
    },
    hello() {
      if (!anything) return
      again = true
      if (second === undefined) send()
    },
  }
}
