// The bridge protocol's constants, and its fingerprint and summary (claude-code/protocol/PROTOCOL.md, v1).
//
// canonical, fnv1a32, fingerprint and summary are the reference implementation's own, imported from
// claude-code/protocol/make-fixtures.mjs, which writes the fixtures only when it's run. test/protocol.test.mjs
// checks them against fixtures/vectors.json, so vectors the generator wasn't rerun for show there.

export const VERSION = 1

/** The bridge's routes. Everything else under the server is 404. */
export const ROUTES = Object.freeze({
  permission: '/v1/permission',
  hello: '/v1/hello',
  events: '/v1/events',
  next: '/v1/next',
  result: '/v1/result',
})

/** The method each route takes; any other gets 405. */
export const ROUTE_METHODS = Object.freeze({
  [ROUTES.permission]: 'POST',
  [ROUTES.hello]: 'POST',
  [ROUTES.events]: 'POST',
  [ROUTES.next]: 'GET',
  [ROUTES.result]: 'POST',
})

/** Bodies above this get 413. */
export const MAX_BODY = 8 * 1024 * 1024

/** The long poll's `wait`, in seconds: 0 answers at once, and 20 is both the default and the most. */
export const MAX_WAIT_S = 20

/**
 * A delivered command with no result this long after delivery counts as failed, "no result". A prompt's
 * `waiting` stops that clock; a waiting prompt fails the same way once its session has gone this long without
 * an open poll. A queued command that no poll takes this long after it was queued fails too, "not delivered".
 */
export const IN_FLIGHT_MS = 60_000

/**
 * From the main loop's turn end, the deck answers the session's polls at once, while the registry still says busy
 * and until a main-loop turn.start, for less than this long after it.
 */
export const AT_ONCE_MS = 60_000

/** The app's `local_…` ids. A host that doesn't match counts as missing, and the sid places the request. */
export const HOST_PATTERN = /^local_[A-Za-z0-9-]{1,64}$/

/** The app's own tool that changes a session's mode. The deck's mode command calls it for `self`. */
export const MODE_TOOL = 'mcp__ccd_session_mgmt__set_session_permission_mode'

/** Requests for these are held for display only: the deck never answers them, and a press jumps. */
export const ASK_TOOLS = Object.freeze(['AskUserQuestion', 'ExitPlanMode'])

/** The modes a mode command may ask for. Never bypassPermissions. */
export const MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto'])

/** A command's final states; `waiting` comes before them, and only for prompts. */
export const FINAL_STATES = Object.freeze(['done', 'refused', 'failed'])

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v !== null && typeof v === 'object') deepFreeze(v)
  return Object.freeze(o)
}

/** The three answers to a permission request. The deck never sends updatedPermissions or updatedInput. */
export const ALLOW = deepFreeze({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
export const DENY = deepFreeze({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'Denied from the Stream Deck.', interrupt: true },
  },
})
export const NO_DECISION = deepFreeze({})

/** The answer for `allow`, `deny` or `none` (no decision). */
export function answerFor(decision) {
  if (decision === 'allow') return ALLOW
  if (decision === 'deny') return DENY
  if (decision === 'none') return NO_DECISION
  throw new Error(`no answer for ${decision}`)
}

// ---- fingerprints and summaries (PROTOCOL.md, "Fingerprints and summaries") ----------------------------

export { canonical, fingerprint, fnv1a32, summary } from '../../protocol/make-fixtures.mjs'
