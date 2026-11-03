// The deck's commands (PROTOCOL.md, "Commands"), each reported through /v1/result.
//
// - prompt: submitted as the user's own words. It reports `waiting` once the engine has it, which holds it until
//   the session is idle (S3), then `done` when it entered, or `refused` with the engine's reason when it was
//   dropped, as after the user pressed Esc (S2).
// - mode: the app's own mode tool for this session. Before the call runs, the mode hook (PreToolUse, hooks.json)
//   asks the bridge, which allows it because this change is in flight, so the auto-mode classifier never judges it
//   (PROTOCOL.md, "Mode checks"). A raise then brings up the app's approval as a PermissionRequest, which the bridge
//   allows as kind mode (S4); a change that doesn't raise brings none. `done` carries the app's text, and the deck
//   then hears the new mode as a settings event; `refused` carries the tool's text. A session started before its
//   plugin had the mode hook doesn't get it from a hot reload: there a change from Auto is refused or never
//   answered, and the deck fails it after 60 s.
//
// A call that throws is `failed`, with its message, as is a command this plugin won't run: an unknown type, a
// prompt with no text, or a mode outside the four the deck may set.

import type { ResultExtra, ResultState } from './bridge'

export type CommandHost = {
  /** `$.prompt.submit` as the user's words: resolves once the prompt entered, or with the engine's reason not to. */
  submit: (text: string) => Promise<{ drop?: string }>
  /** `set_session_permission_mode` for this session: the tool's text, and whether it refused. */
  setMode: (mode: string) => Promise<{ isError: boolean; text: string }>
}

export type CommandOut = {
  result: (id: string, state: ResultState, extra?: ResultExtra) => void
  modeSet: (mode: string) => void
}

/** The app's Manual, Accept edits, Plan and Auto. Never bypassPermissions. */
export const MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'auto']

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
  const r = await host.setMode(mode)
  if (r.isError) {
    out.result(id, 'refused', { error: r.text === '' ? 'the app refused the mode change' : r.text })
    return
  }
  out.result(id, 'done', { detail: r.text })
  out.modeSet(mode)
}
