// The deck's commands (PROTOCOL.md, "Commands"), each reported through /v1/result.
//
// - prompt: submitted as the user's own words. It reports `waiting` once the engine has it, which holds it until
//   the session is idle (S3), then `done` when it entered, or `refused` with the engine's reason when it was
//   dropped, as after the user pressed Esc (S2).
// - mode: the app's own mode tool for this session. Before the call runs, the mode hook (PreToolUse, hooks.json)
//   asks the bridge, which allows it because this change is in flight, so the auto-mode classifier never judges it
//   (PROTOCOL.md, "Mode checks"). A raise then brings up the app's approval as a PermissionRequest, which the bridge
//   allows as kind mode (S4); a change that doesn't raise brings none. `done` carries the app's text, and the deck
//   then hears the new mode as a settings event. `refused` carries the tool's text when the tool says no, or the
//   engine's reason when it refuses the call itself (refusalOf()). A session started before its plugin had the mode
//   hook doesn't get it from a hot reload, and there a change from Auto goes one of two ways (PROTOCOL.md,
//   "Commands"). The auto-mode classifier may refuse it at once, and this reports it at once, as `refused` with the
//   classifier's reason: in Phase 4 the engine refused the call in 14 ms ("The server-side auto mode classifi…").
//   Or nothing ever answers it (the Auto spike, 2026-11-03), and the deck fails it 60 s after delivery with
//   "no result".
//
// A call that throws for any other reason is `failed`, with its message, as is a command this plugin won't run: an
// unknown type, a prompt with no text, or a mode outside the four the deck may set.

import type { ResultExtra, ResultState } from './bridge'

export type CommandHost = {
  /** `$.prompt.submit` as the user's words: resolves once the prompt entered, or with the engine's reason not to. */
  submit: (text: string) => Promise<{ drop?: string }>
  /**
   * `set_session_permission_mode` for this session: the tool's text, and whether it refused. Rejects when the call
   * doesn't run, the engine's refusal of it included (refusalOf()).
   */
  setMode: (mode: string) => Promise<{ isError: boolean; text: string }>
}

export type CommandOut = {
  result: (id: string, state: ResultState, extra?: ResultExtra) => void
  modeSet: (mode: string) => void
}

/** The app's Manual, Accept edits, Plan and Auto. Never bypassPermissions. */
export const MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'auto']

/**
 * Claude Code 2.1.309's words when it refuses the mode tool's call, as the auto-mode classifier did from Auto in
 * Phase 4: a `$.mcp.call` whose call the engine denies rejects with `<plugin>: $.mcp.call(<server>, <tool>) refused:
 * <reason>`, the server and tool as register.ts's adapter names them. Phase 4's deck log has these words.
 */
const MODE_CALL_REFUSED = '$.mcp.call(ccd_session_mgmt, set_session_permission_mode) refused: '

/**
 * The reason, when `err` is the engine refusing the mode tool's call; undefined for any other error, such as no
 * connected tool or no result, which the engine words otherwise. The mods API has no typed refusal, so this reads
 * the engine's words. Should a later version word it otherwise, a refusal comes out `failed`, with its whole
 * message, which the deck shows as it does `refused`.
 */
function refusalOf(err: unknown): string | undefined {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const at = text.indexOf(MODE_CALL_REFUSED)
  return at < 0 ? undefined : text.slice(at + MODE_CALL_REFUSED.length)
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'the call failed without a reason'
}

/** Runs one command and reports how it went. Never rejects. */
export async function runCommand(cmd: Record<string, unknown>, host: CommandHost, out: CommandOut): Promise<void> {
  const id = cmd.id
  if (typeof id !== 'string') return
  try {
    if (cmd.t === 'prompt') await prompt(id, cmd.text, host, out)
    else if (cmd.t === 'mode') await mode(id, cmd.mode, host, out)
    else out.result(id, 'failed', { error: `this plugin runs no command of type ${JSON.stringify(cmd.t ?? null)}` })
  } catch (err) {
    try {
      out.result(id, 'failed', { error: errorText(err) })
    } catch {
      // Reporting only queues; nothing else is left to try.
    }
  }
}

async function prompt(id: string, text: unknown, host: CommandHost, out: CommandOut): Promise<void> {
  if (typeof text !== 'string' || text.trim() === '') {
    out.result(id, 'failed', { error: 'the prompt has no text' })
    return
  }
  const entered = host.submit(text)
  out.result(id, 'waiting')
  const r = await entered
  if (r.drop !== undefined) out.result(id, 'refused', { error: `dropped: ${r.drop}` })
  else out.result(id, 'done')
}

async function mode(id: string, mode: unknown, host: CommandHost, out: CommandOut): Promise<void> {
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    out.result(id, 'failed', { error: `the deck may set the mode to ${MODES.join(', ')}, not ${JSON.stringify(mode ?? null)}` })
    return
  }
  let r: { isError: boolean; text: string }
  try {
    r = await host.setMode(mode)
  } catch (err) {
    const why = refusalOf(err)
    if (why === undefined) throw err
    out.result(id, 'refused', { error: why.trim() === '' ? 'the engine refused the mode change' : why })
    return
  }
  if (r.isError) {
    out.result(id, 'refused', { error: r.text === '' ? 'the app refused the mode change' : r.text })
    return
  }
  out.result(id, 'done', { detail: r.text })
  out.modeSet(mode)
}
