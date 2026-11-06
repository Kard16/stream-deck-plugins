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

/**
 * Claude Code's routes: the permission hook's (PROTOCOL.md, "Parties"). Claude Code acts on its answers, which are
 * exactly the bodies PROTOCOL.md gives, and its bodies are the hook's input, never the mod's: no `inst`, no `seq`.
 * The bridge takes them only from a session the registry confirms ("Desktop sessions only").
 */
export const HOOK_ROUTES = Object.freeze([ROUTES.permission])

/** The mod's routes. Each request names its session with `sid`, `host` and `inst` (PROTOCOL.md, "Routes"). */
export const MOD_ROUTES = Object.freeze([ROUTES.hello, ROUTES.events, ROUTES.next, ROUTES.result])

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
 * and until a main-loop turn.start, for less than this long after it, timed on a monotonic clock as the deck times
 * it: a wall clock that a time sync moves, or a fixture runner's that follows the registry's times, can't end it
 * early or draw it out.
 */
export const AT_ONCE_MS = 60_000

/** The app's `local_…` ids. A host that doesn't match counts as missing, and the sid places the request. */
export const HOST_PATTERN = /^local_[A-Za-z0-9-]{1,64}$/

/**
 * Requests for these are kind ask (PROTOCOL.md, "Permission requests", as amended on 2026-11-04 for session keys):
 * Claude Code needs the person for them, so it ignores a plain Allow and takes an Allow only with updatedInput. Only
 * the session's own Session Slot dial answers one, with an Answer, an Approve plan or a Deny; on the Approve and Deny
 * keys a press jumps to the session.
 */
export const ASK_TOOLS = Object.freeze(['AskUserQuestion', 'ExitPlanMode'])

/**
 * A held ask request keeps its tool_input when its JSON is at most this many bytes, so the dial can show it and echo
 * it back (PROTOCOL.md, "Held requests"). Over that, the dial shows "Answer in app", and a press jumps.
 */
export const ASK_INPUT_MAX = 64 * 1024

/** The modes an Approve plan may leave Plan mode into: Auto, Accept edits, Manual. Never plan or bypassPermissions. */
export const PLAN_MODES = Object.freeze(['auto', 'acceptEdits', 'default'])

/** What a fixture's dial line, or the fake's dial, may do with a plan: approve it into one of PLAN_MODES, or reject it. */
export const DIAL_PLANS = Object.freeze([...PLAN_MODES, 'reject'])

/** A command's final states; a prompt's `waiting` comes before them. */
export const FINAL_STATES = Object.freeze(['done', 'refused', 'failed'])

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v !== null && typeof v === 'object') deepFreeze(v)
  return Object.freeze(o)
}

/**
 * Three of the five answers to a permission request: Allow, Deny and no decision. The other two, the Answer and the
 * Approve plan, carry the request's own tool_input (answerBody, approvePlanBody). The deck sends updatedInput only in
 * those two, and updatedPermissions only in an Approve plan.
 */
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

/**
 * The Answer, for an AskUserQuestion, from its session's dial only (PROTOCOL.md, "Permission requests"): Allow with
 * updatedInput, the request's tool_input exactly as it came with one key added, `answers`, from each question's text
 * to its answer. Claude Code fails an updatedInput that doesn't fit the tool's schema as a deny, so nothing else of
 * the input changes. Its keys are written as their own properties, `__proto__` included.
 */
export function answerBody(input, answers) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...input, answers } } } }
}

/**
 * The Approve plan, for an ExitPlanMode, from its session's dial only (PROTOCOL.md, "Permission requests"): Allow with
 * the request's tool_input unchanged, and one setMode for the session, which leaves Plan mode into `mode`, one of
 * PLAN_MODES. `destination` is always `session`: the others write settings files.
 */
export function approvePlanBody(input, mode) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] },
    },
  }
}

/**
 * A multi-select question's answer (PROTOCOL.md, "Permission requests"): the chosen labels, given in the order of the
 * question's options, joined with ", ", each label that holds ", " or a double quote written as a JSON string, as
 * Claude Code joins its own. A single-select answer is its label as it is, and doesn't come here.
 */
export function joinLabels(labels) {
  return labels.map((l) => (l.includes(', ') || l.includes('"') ? JSON.stringify(l) : l)).join(', ')
}

/** The error a hello gets, with 409, from a host the registry lists under another sessionId ("Desktop sessions only"). */
export const NOT_THIS_SESSION = 'not this session'

/**
 * The error a poll gets, with 409, for a session with no current instance (PROTOCOL.md, Identity): after the deck
 * restarts, forgets the session at release rule 4, or its current instance stops polling. The mod takes it as a
 * rejected fetch, and says hello.
 */
export const HELLO_FIRST = 'hello first'

// ---- fingerprints and summaries (PROTOCOL.md, "Fingerprints and summaries") ----------------------------

export { canonical, fingerprint, fnv1a32, summary } from '../../protocol/make-fixtures.mjs'
