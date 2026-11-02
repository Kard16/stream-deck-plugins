// The deck's events (PROTOCOL.md, "Events"), made from what the engine hands the mod's hooks. Pure: register.ts
// calls these and gives the results to the bridge. Every event carries `t` and `at` (the mod's clock), and a
// subagent's carry `agent`, the engine's agentId; the main loop's carry none.

import type {
  SessionAttachInput,
  SessionDetachInput,
  SessionEndInput,
  SessionMeasureInput,
  TurnCompleteInput,
  TurnStartInput,
} from 'claude-code'
import { fingerprint, summary, toolArgs } from './fingerprint'

export type DeckEvent = { t: string; at: number; [field: string]: unknown }

/** The session's model, permission mode and effort level, as far as the mod has seen them. */
export type Settings = { model?: string; mode?: string; effort?: string }

const now = (): number => Date.now()

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** `{ agent }` for a subagent's loop, nothing for the main loop's. */
const loop = (agentId: unknown): { agent?: string } => {
  const agent = text(agentId)
  return agent === undefined ? {} : { agent }
}

/** A tool call as both of its events name it. */
export type ToolCallSeen = { tool: string; use: string; agent?: string; fp: string; summary: string }

/** Reads tool.call's `e`: the tool, its use id and loop, and the fingerprint and summary of its arguments. */
export function toolCall(e: Record<string, unknown>): ToolCallSeen | undefined {
  const tool = text(e.tool)
  if (tool === undefined) return undefined
  const args = toolArgs(e)
  return { tool, use: text(e.tool_use_id) ?? '', ...loop(e.agentId), fp: fingerprint(tool, args), summary: summary(tool, args) }
}

export const toolStart = (c: ToolCallSeen): DeckEvent => ({
  t: 'tool.start',
  at: now(),
  tool: c.tool,
  use: c.use,
  ...loop(c.agent),
  summary: c.summary,
  fp: c.fp,
})

/**
 * What `next(e)` settled to: the tool ran (`ok` false if it reported an error), or was refused (`denied` holds
 * the reason). `undefined` when `next` itself rejected, which ends the call too.
 */
export function toolEnd(c: ToolCallSeen, ran: { deny?: string; isError?: boolean } | undefined): DeckEvent {
  const denied = typeof ran?.deny === 'string' ? ran.deny : undefined
  return {
    t: 'tool.end',
    at: now(),
    tool: c.tool,
    use: c.use,
    ...loop(c.agent),
    fp: c.fp,
    ok: ran !== undefined && denied === undefined && ran.isError !== true,
    ...(denied === undefined ? {} : { denied }),
  }
}

export const turnStart = (e: TurnStartInput): DeckEvent => ({ t: 'turn.start', at: now(), turn: e.turnId, ...loop(e.agentId) })

/** `reason` as the engine gives it: `answer`, also after the deck's Deny; `aborted` after Esc (S2). */
export const turnEnd = (e: TurnCompleteInput): DeckEvent => ({
  t: 'turn.end',
  at: now(),
  turn: e.turnId,
  ...loop(e.agentId),
  reason: e.reason,
})

/**
 * Context use, when it or the cost moved. A measurement that only moved a rate-limit window says nothing the
 * deck shows, so it isn't sent. Figures the engine doesn't have yet (`percent` before the first response) are
 * left out, as it leaves them out.
 */
export function measure(e: SessionMeasureInput): DeckEvent | undefined {
  const changed: readonly string[] | undefined = Array.isArray(e.changed) ? e.changed : undefined
  if (changed !== undefined && !changed.includes('context') && !changed.includes('cost')) return undefined
  const { percent, tokens, window } = e.context
  return { t: 'measure', at: now(), context: { percent, tokens, window }, ...(e.cost === undefined ? {} : { cost: e.cost }) }
}

export const attach = (e: SessionAttachInput): DeckEvent => ({ t: 'attach', at: now(), surface: e.surface })

export const detach = (e: SessionDetachInput): DeckEvent => ({ t: 'detach', at: now(), surface: e.surface })

export const end = (e: SessionEndInput): DeckEvent => ({ t: 'end', at: now(), reason: e.reason })

/** classic.StopFailure: the turn died on an API error, whose kind (`rate_limit`, `overloaded`...) is `error`. */
export function failed(e: { error?: unknown; agent_id?: unknown }): DeckEvent {
  const error = text(e.error)
  return { t: 'failed', at: now(), ...(error === undefined ? {} : { error }), ...loop(e.agent_id) }
}

/**
 * The permission mode and effort level a classic hook's input carries (BaseHookInput in the d.ts). Only the main
 * loop's count: a subagent may run with a mode and effort of its own.
 */
export function settingsOf(e: { permission_mode?: unknown; effort?: { level?: unknown }; agent_id?: unknown }): Settings {
  if (e.agent_id !== undefined) return {}
  const mode = text(e.permission_mode)
  const effort = text(e.effort?.level)
  return { ...(mode === undefined ? {} : { mode }), ...(effort === undefined ? {} : { effort }) }
}

/**
 * The fields of `seen` that differ from `known`, which takes them on; undefined when none do. The deck hears only
 * the fields that changed.
 */
export function changed(known: Settings, seen: Settings): Settings | undefined {
  const out: Settings = {}
  for (const k of ['model', 'mode', 'effort'] as const) {
    const v = text(seen[k])
    if (v !== undefined && v !== known[k]) {
      out[k] = v
      known[k] = v
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}
