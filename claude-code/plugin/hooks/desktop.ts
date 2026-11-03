// Which Claude Code processes the mod talks to the bridge from (PROTOCOL.md, "Desktop sessions only"). From Phase 5
// the plugin is in ~/.claude/settings.json, so every Claude Code process on this Mac that reads it runs the mod:
// terminal and VS Code sessions and `claude -p` runs, with no host id; a `claude` started inside a desktop session,
// which inherits the session's entrypoint and host id, with CLAUDECODE and CLAUDE_CODE_CHILD_SESSION set; the side
// chats and recaps the app forks from a preset session, which carry its host id and a CLAUDE_CODE_TAGS; and the
// app's pre-warmed spares, which run the mod with the host id of the session they'll become.
//
// Only a desktop session of its own talks to the bridge: the engine's own test for trusting a host id (`dp()` and
// `_M()` in 2.1.309), plus the forks' tags, plus a token to talk with. A spare passes, and talks as the session it
// will become. Anywhere else the mod sends nothing at all. The hooks in hooks.json can't be gated like this, so the
// bridge checks their requests against the registry instead.

/** A desktop session's host id, the app's `local_…` id (PROTOCOL.md, "Identity"). */
export const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/

/** CLAUDE_CODE_ENTRYPOINT in the app's own sessions. */
export const DESKTOP_ENTRYPOINTS: readonly string[] = ['claude-desktop', 'claude-desktop-3p']

/** A variable as `$.env.get` answered: its value, undefined when it's unset, or null when the read itself failed. */
export type Read = string | undefined | null

/** The variables the gate reads. */
export type GateEnv = {
  CLAUDE_CODE_ENTRYPOINT: Read
  CLAUDE_CODE_HOST_SESSION_ID: Read
  CLAUDECODE: Read
  CLAUDE_CODE_CHILD_SESSION: Read
  CLAUDE_CODE_TAGS: Read
  DECK_TOKEN: Read
}

/** The most of a variable's value the log quotes. */
const MAX_SHOWN = 80

/** A value for the log, quoted and cut short. Never the token's: DECK_TOKEN's value is never shown. */
function shown(value: string): string {
  const quoted = JSON.stringify(value)
  return quoted.length > MAX_SHOWN ? `${quoted.slice(0, MAX_SHOWN - 1)}…` : quoted
}

/**
 * Why the mod stays quiet in this process: each of the gate's tests it fails, worded for the log, in the protocol's
 * order. None for a desktop session of its own with a token. A variable whose read failed fails its test, so the
 * gate stays shut when in doubt.
 */
export function whyQuiet(env: GateEnv): string[] {
  const why: string[] = []

  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT
  if (entrypoint === null) why.push("CLAUDE_CODE_ENTRYPOINT couldn't be read")
  else if (entrypoint === undefined) why.push("CLAUDE_CODE_ENTRYPOINT isn't set")
  else if (!DESKTOP_ENTRYPOINTS.includes(entrypoint)) {
    why.push(`CLAUDE_CODE_ENTRYPOINT is ${shown(entrypoint)}, not claude-desktop or claude-desktop-3p`)
  }

  const host = env.CLAUDE_CODE_HOST_SESSION_ID
  if (host === null) why.push("CLAUDE_CODE_HOST_SESSION_ID couldn't be read")
  else if (host === undefined) why.push("CLAUDE_CODE_HOST_SESSION_ID isn't set")
  else if (!HOST_ID.test(host)) why.push(`CLAUDE_CODE_HOST_SESSION_ID is ${shown(host)}, not a desktop session's local_… id`)

  // Set inside another Claude Code process, or in a fork the app made: unset or empty is the only pass.
  const inherited: readonly [string, Read][] = [
    ['CLAUDECODE', env.CLAUDECODE],
    ['CLAUDE_CODE_CHILD_SESSION', env.CLAUDE_CODE_CHILD_SESSION],
    ['CLAUDE_CODE_TAGS', env.CLAUDE_CODE_TAGS],
  ]
  for (const [name, value] of inherited) {
    if (value === null) why.push(`${name} couldn't be read`)
    else if (value !== undefined && value !== '') why.push(`${name} is set (${shown(value)})`)
  }

  // The token is the trimmed value (PROTOCOL.md, "Transport"), so a blank one is none.
  const token = env.DECK_TOKEN
  if (token === null) why.push("DECK_TOKEN couldn't be read")
  else if (token === undefined || token.trim() === '') why.push("DECK_TOKEN isn't set")

  return why
}
