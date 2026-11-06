// The deck's commands (PROTOCOL.md, "Commands"), each reported through /v1/result.
//
// - prompt: submitted as the user's own words. It reports `waiting` once the engine has it, which holds it until
//   the session is idle (S3), then `done` when it entered, or `refused` with the engine's reason when it was
//   dropped, as after the user pressed Esc (S2).
//
// There are no mode, model or effort commands: the deck shows them and never changes them. A call that throws is
// `failed`, with its message, as is a command this plugin won't run: a type it doesn't know, `mode` included, or a
// prompt with no text.

import type { ResultExtra, ResultState } from './bridge'

export type CommandHost = {
  /** `$.prompt.submit` as the user's words: resolves once the prompt entered, or with the engine's reason not to. */
  submit: (text: string) => Promise<{ drop?: string }>
}

export type CommandOut = {
  result: (id: string, state: ResultState, extra?: ResultExtra) => void
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
