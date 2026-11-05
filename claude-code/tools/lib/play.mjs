// Plays a fixture's plugin side against a bridge, standing in for Claude Code and the mod at once, by the
// deck side's rules in PROTOCOL.md ("Fixtures"):
// - `mod` and `engine` lines are skipped: they're for the plugin side's own runner.
// - `plugin` lines are sent in order, `*` values as they are, with the right token and Host unless the line
//   sets them (`$TOKEN` stands for the token, null leaves a header out). Each answer is awaited, except for
//   /v1/permission and /v1/next, which may be held: a later `reply` line checks those, waiting up to 2 s. A mode
//   check, /v1/pretool, is answered at once, and awaited like the rest. Answers to the rest must be 200 or 204
//   unless a `reply` line says otherwise.
// - Lines for /v1/permission and /v1/pretool are Claude Code's, the hooks' input, never the mod's: their bodies
//   are sent as they are, with no inst bound (see uniqueInst below), and their answers, which Claude Code acts on,
//   are held to PROTOCOL.md's bodies (hookAnswerMismatch).
// - `press`, `registry` and `expect` lines go to a driver (drivers.mjs), which presses keys, changes the registry
//   and reads the deck's state itself, or asks a person to press and skips the rest. A driver that skips registry
//   lines skips the replies that hang on them too, and reports them: one that waits on a registry change; one to a
//   poll the deck answers at once only because the registry says busy after the main loop's turn ended; one to a
//   hook's request the deck answered {} at once, though the line expects a decision, as a deck that confirms a hook's
//   session by its registry must when no registry it reads lists the fixture's; a hello's 409, which only a registry
//   that lists the hello's host under another sessionId gives ("Desktop sessions only"); and a poll's 409 hello
//   first, which only a deck that forgot the session gives, as at release rule 4 when a registry line removes its
//   file (Identity). A driver may skip a press too, and the replies to polls that expect a command then go with it:
//   only a press queues one.
// The deck's command ids bind to the fixture's names at their first appearance in a reply. An answer to a
// permission request must also be exactly one of PROTOCOL.md's five, fitting the request it answers, and one to a
// mode check one of its two, whatever its reply line expects, since it's what Claude Code acts on, or an error answer
// when it isn't 2xx. An Answer or an Approve plan must equal the line's body exactly, updatedInput included.

import { performance } from 'node:perf_hooks'

import { hostHeader, send, within } from './client.mjs'
import { ANY, Bindings, commandIdHook, exactMismatch, mismatch, show } from './match.mjs'
import { ALLOW, ASK_TOOLS, DENY, HOOK_ROUTES, MOD_ROUTES, PLAN_MODES, PRE_ALLOW, ROUTES, summary } from './protocol.mjs'

/** A line that didn't go as the fixture says. */
export class PlayFailure extends Error {
  constructor(line, message) {
    super(`line ${line.n} (${line.kind}): ${message}`)
    this.line = line
  }
}

/** Requests that may be held, so the runner doesn't wait for their answers before going on. */
const MAY_HOLD = new Set([ROUTES.permission, ROUTES.next])

/**
 * How soon an answer to one of Claude Code's requests, the hooks', counts as at once, by the time the client measured
 * from sending it to the answer's end. A deck that doesn't confirm the request's session answers it {} at once, after
 * one more reading of its registry at most ("Desktop sessions only"), which takes milliseconds; a press counts only
 * once its request has been on the key for 1 s ("Held requests"). So an answer this soon wasn't a press's, whenever
 * the runner happened to look, and a slower one is checked as it is. Not protocol.mjs's AT_ONCE_MS, the 60 s after a
 * turn's end in which the deck answers a session's polls at once.
 */
export const HOOK_AT_ONCE_MS = 500

/** Claude Code's requests, the hooks', whose answers Claude Code acts on. */
const HOOKS = new Set(HOOK_ROUTES)
/** The mod's requests, which name its inst. */
const MODS = new Set(MOD_ROUTES)
const routeOf = (p) => p.split('?')[0]
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const SKIPPED = new Set(['note', 'mod', 'engine'])

/** Resolves once `promise` settles, either way, or once `ms` have passed, whichever comes first. */
function settledWithin(promise, ms) {
  if (!(ms > 0)) return Promise.resolve()
  let timer
  const passed = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([promise.then(() => {}, () => {}), passed]).finally(() => clearTimeout(timer))
}

/**
 * What Claude Code applies along with a decision: a rewritten tool input, and rules, directories or a mode for the
 * session or a settings file. PROTOCOL.md, "Permission requests", as amended on 2026-11-04 for session keys: the deck
 * sends updatedInput only in an Answer or an Approve plan, and updatedPermissions only in an Approve plan, both in a
 * PermissionRequest's allow; a mode check's answer has neither.
 */
const NEVER_SENT = Object.freeze(['updatedPermissions', 'updatedInput'])

/**
 * What Claude Code reads at the top of any hook's answer: `continue: false` stops the session and
 * `stopReason` says why, `decision: "block"` with a `reason` blocks the event (ClassicResult in
 * claude-code/vendor/mods-api-2.1.309/claude-code.d.ts), and `systemMessage` and `suppressOutput` show and
 * hide text. None of PROTOCOL.md's answers has any of them.
 */
const HOOK_FIELDS = Object.freeze(['continue', 'stopReason', 'decision', 'reason', 'systemMessage', 'suppressOutput'])

/** The first of `keys` anywhere in `v`, as `{at, key, value}`, or null; it doesn't look inside a value `skip` names. */
function findKey(v, keys, at, skip = null) {
  if (v === null || typeof v !== 'object' || v === skip) return null
  for (const [k, x] of Object.entries(v)) {
    const p = Array.isArray(v) ? `${at}[${k}]` : `${at}.${k}`
    if (!Array.isArray(v) && keys.includes(k)) return { at: p, key: k, value: x }
    const found = findKey(x, keys, p, skip)
    if (found) return found
  }
  return null
}

/**
 * NEVER_SENT anywhere it doesn't belong in an answer to `route`, as findKey gives it, or null. In a mode check's answer
 * it belongs nowhere. In a permission request's, an allow's decision is where an Answer or an Approve plan has them,
 * and what's inside its updatedInput is the request's own input, echoed: so an allow's decision is left to the
 * checks of the body it is, and the rest searched.
 */
function misplaced(route, actual) {
  const decision = route === ROUTES.permission && isObject(actual) && isObject(actual.hookSpecificOutput) ? actual.hookSpecificOutput.decision : undefined
  return findKey(actual, NEVER_SENT, 'body', isObject(decision) && decision.behavior === 'allow' ? decision : null)
}

/**
 * Which of PROTOCOL.md's decisions a permission answer's `hookSpecificOutput` is, by its decision: a deny is Deny; an
 * allow with updatedPermissions an Approve plan, with updatedInput alone an Answer, with neither Allow.
 */
function permissionBodyOf(out) {
  const d = isObject(out) ? out.decision : undefined
  if (!isObject(d)) return 'Allow'
  if (d.behavior === 'deny') return 'Deny'
  if (Object.hasOwn(d, 'updatedPermissions')) return 'Approve plan'
  return Object.hasOwn(d, 'updatedInput') ? 'Answer' : 'Allow'
}

/** Each decision's body, exactly: `"*"` stands for the request's own input, which the checks after compare. */
const PERMISSION_BODIES = Object.freeze({
  Allow: ALLOW,
  Deny: DENY,
  Answer: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: ANY } } },
  'Approve plan': { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: ANY, updatedPermissions: ANY } } },
})

/**
 * Why a permission answer's decision, `name`, doesn't fit the request it answers, `request` being the hook's input as
 * the fixture sends it, or null. An Answer goes only to an AskUserQuestion, an Approve plan only to an ExitPlanMode,
 * and Claude Code ignores a plain Allow for either of those: it needs the person for them.
 */
function requestMismatch(name, request) {
  const tool = isObject(request) && typeof request.tool_name === 'string' ? request.tool_name : null
  const at = 'body.hookSpecificOutput.decision'
  const is = tool === null ? 'for no tool' : `for ${tool}`
  if (name === 'Answer' && tool !== 'AskUserQuestion') return `${at}: an Answer goes only to an AskUserQuestion, and this request is ${is} (PROTOCOL.md, "Permission requests")`
  if (name === 'Approve plan' && tool !== 'ExitPlanMode') return `${at}: an Approve plan goes only to an ExitPlanMode, and this request is ${is} (PROTOCOL.md, "Permission requests")`
  if (name === 'Allow' && ASK_TOOLS.includes(tool)) {
    return `${at}: Claude Code ignores a plain Allow for ${tool}, which needs the person: the deck answers one with ${tool === 'AskUserQuestion' ? 'an Answer' : 'an Approve plan'}, a Deny or {}`
  }
  return null
}

/**
 * Why an Answer's updatedInput isn't the request's tool_input exactly as it came with `answers` added, or null
 * (PROTOCOL.md, "Permission requests"): an object from each question's text to its answer, a string, every question
 * with one. Without the request, only its shape is checked.
 */
function answerMismatch(out, request) {
  const at = 'body.hookSpecificOutput.decision.updatedInput'
  const input = out.decision.updatedInput
  if (!isObject(input)) return `${at}: expected the request's tool_input with answers added, got ${show(input)}`
  if (!isObject(input.answers)) return `${at}.answers: expected an object from each question's text to its answer, got ${show(input.answers)}`
  const odd = Object.entries(input.answers).find(([, v]) => typeof v !== 'string')
  if (odd) return `${at}.answers.${odd[0]}: an answer is a string, got ${show(odd[1])}`
  if (request === undefined) return null
  const asked = isObject(request) ? request.tool_input : undefined
  if (!isObject(asked)) return `${at}: the request has no tool_input for an Answer to echo, got ${show(asked)}`
  // Everything but `answers`, which the Answer adds, or replaces should the request have had one.
  const { answers, ...rest } = input
  const askedRest = { ...asked }
  delete askedRest.answers
  const why = exactMismatch(askedRest, rest, at, { wildcard: false })
  if (why) return `${why} (an Answer's updatedInput is the request's tool_input exactly as it came, with answers added)`
  const texts = Array.isArray(asked.questions) ? asked.questions.map((q) => (isObject(q) ? q.question : undefined)) : []
  if (texts.length && texts.every((q) => typeof q === 'string')) {
    const missing = texts.find((q) => !Object.hasOwn(answers, q))
    if (missing !== undefined) return `${at}.answers: no answer for ${show(missing)}, and every question gets one`
    const stray = Object.keys(answers).find((k) => !texts.includes(k))
    if (stray !== undefined) return `${at}.answers.${stray}: none of the request's questions asks it`
  }
  return null
}

/**
 * Why an Approve plan isn't the request's tool_input unchanged with one setMode for the session into one of
 * PLAN_MODES, or null (PROTOCOL.md, "Permission requests"). Without the request, only its shape is checked.
 */
function approvePlanMismatch(out, request) {
  const at = 'body.hookSpecificOutput.decision'
  const d = out.decision
  if (!isObject(d.updatedInput)) return `${at}.updatedInput: expected the request's tool_input, an object, got ${show(d.updatedInput)}`
  const perms = d.updatedPermissions
  if (!Array.isArray(perms) || perms.length !== 1) return `${at}.updatedPermissions: expected one setMode for the session, got ${show(perms)}`
  const why = exactMismatch({ type: 'setMode', mode: ANY, destination: 'session' }, perms[0], `${at}.updatedPermissions[0]`)
  if (why) return `${why} (an Approve plan's updatedPermissions is one setMode, for the session)`
  if (!PLAN_MODES.includes(perms[0].mode)) return `${at}.updatedPermissions[0].mode: expected one of ${PLAN_MODES.join(', ')}, got ${show(perms[0].mode)}`
  if (request === undefined) return null
  const echo = exactMismatch(isObject(request) ? request.tool_input : undefined, d.updatedInput, `${at}.updatedInput`, { wildcard: false })
  return echo && `${echo} (an Approve plan's updatedInput is the request's tool_input, unchanged)`
}

/** Why `actual` has a field that `expected` lacks, at any depth, or null: mismatch() checks the other way. */
function extraField(expected, actual, at, name) {
  if (!isObject(expected) || !isObject(actual)) return null
  for (const k of Object.keys(actual)) {
    const p = `${at}.${k}`
    if (!Object.hasOwn(expected, k)) return `${p}: not in ${name}, got ${show(actual[k])}`
    const why = extraField(expected[k], actual[k], p, name)
    if (why) return why
  }
  return null
}

/**
 * What a 2xx answer to each hook's route may be (PROTOCOL.md, "Permission requests" and "Mode checks"): `names` in
 * words, `decision(out)` the one whose `hookSpecificOutput` an answer that has one must be exactly, as `[name,
 * body]`, `exactly` what that means, `never` how to say a NEVER_SENT field is where it doesn't belong, and for a
 * permission request `request(name, request)` whether the decision fits the request it answers and `input(name, out,
 * request)` whether an Answer's or an Approve plan's own fields are right.
 */
const HOOK_ANSWERS = Object.freeze({
  [ROUTES.permission]: {
    names: 'Allow, Deny, an Answer, an Approve plan or {}',
    decision: (out) => {
      const name = permissionBodyOf(out)
      return [name, PERMISSION_BODIES[name]]
    },
    exactly: 'a decision is Allow, Deny, an Answer or an Approve plan exactly as PROTOCOL.md writes them',
    never: (key) => `the deck sends ${key} only in ${key === 'updatedInput' ? 'an Answer or an Approve plan' : 'an Approve plan'}, in its allow's decision (PROTOCOL.md)`,
    request: requestMismatch,
    input: (name, out, request) => (name === 'Answer' ? answerMismatch(out, request) : name === 'Approve plan' ? approvePlanMismatch(out, request) : null),
  },
  [ROUTES.pretool]: {
    names: "the mode check's allow or {}",
    decision: () => ["the mode check's allow", PRE_ALLOW],
    exactly: 'the bridge never denies or asks in a mode check, and its allow is exactly as PROTOCOL.md writes it',
    never: (key) => `the deck never sends ${key} in a mode check (PROTOCOL.md)`,
    request: () => null,
    input: () => null,
  },
})

/** Whether a permission answer, or a line's expected body, is an Answer or an Approve plan: its decision carries updatedInput or updatedPermissions. */
function carriesInput(body) {
  const d = isObject(body) && isObject(body.hookSpecificOutput) ? body.hookSpecificOutput.decision : undefined
  return isObject(d) && NEVER_SENT.some((k) => Object.hasOwn(d, k))
}

/**
 * Why an answer to one of Claude Code's requests, the hooks', isn't one PROTOCOL.md allows, or null. It holds
 * whatever the reply line expects, since Claude Code acts on the answer: "Transport" exempts these routes from
 * "unknown fields are ignored".
 * - `updatedPermissions` and `updatedInput` are only where PROTOCOL.md puts them: in an Answer's and an Approve plan's
 *   decision, and nowhere in a mode check's answer. A deck that echoed a PermissionRequest's `permission_suggestions`
 *   into a Deny would otherwise add rules to the user's settings at every press, and still pass; one that put
 *   `updatedInput` in a mode check's allow could change the mode the call asks for.
 * - A 2xx answer, the one Claude Code parses, is exactly one of the route's bodies: Allow, Deny, an Answer, an Approve
 *   plan or {} for a permission request, the allow or {} for a mode check. No field of its own, at the top (Claude
 *   Code's own HOOK_FIELDS among them) or inside `hookSpecificOutput`. An Answer's answers are strings; an Approve
 *   plan's updatedPermissions is one setMode for the session, into auto, acceptEdits or default.
 * - With `request`, the hook's input the answer is for (a permission request's): the decision fits it. An Answer goes
 *   only to an AskUserQuestion, with its tool_input exactly as it came plus an answer for every question; an Approve
 *   plan only to an ExitPlanMode, with its tool_input unchanged; and a plain Allow to neither, as Claude Code ignores
 *   it there. A deck that answered a Write with an Answer would rewrite the call it allowed.
 * - Any other is an error answer, which Claude Code doesn't parse: `{"error": "<reason>"}` exactly, as
 *   "Transport" writes it. auth's 405 for `GET /v1/permission` is one.
 */
export function hookAnswerMismatch(route, actual, status = 200, request = undefined) {
  const answers = HOOK_ANSWERS[route]
  if (!answers) throw new Error(`${route} isn't one of the hooks' routes`)
  const stray = misplaced(route, actual)
  if (stray) return `${stray.at}: ${answers.never(stray.key)}, got ${show(stray.value)}`
  if (status < 200 || status > 299) {
    const extra = isObject(actual) ? Object.keys(actual).find((k) => k !== 'error') : undefined
    if (extra !== undefined) return `body.${extra}: not in an error answer, got ${show(actual[extra])} (an error answer is {"error": "<reason>"} exactly)`
    return isObject(actual) && typeof actual.error === 'string' ? null : `body: expected an error answer, {"error": "<reason>"}, got ${show(actual)}`
  }
  if (!isObject(actual)) return `body: expected ${answers.names}, got ${show(actual)}`
  const field = HOOK_FIELDS.find((k) => Object.hasOwn(actual, k))
  if (field) return `body.${field}: Claude Code acts on it, and none of PROTOCOL.md's answers has it, got ${show(actual[field])}`
  const extra = Object.keys(actual).find((k) => k !== 'hookSpecificOutput')
  if (extra !== undefined) return `body.${extra}: not in any of PROTOCOL.md's answers, got ${show(actual[extra])} (an answer is ${answers.names} exactly)`
  if (!Object.hasOwn(actual, 'hookSpecificOutput')) return null
  const out = actual.hookSpecificOutput
  const [name, want] = answers.decision(out)
  if (request !== undefined) {
    const unfit = answers.request(name, request)
    if (unfit) return unfit
  }
  const at = 'body.hookSpecificOutput'
  const why = mismatch(want.hookSpecificOutput, out, { at, skip: [] }) ?? extraField(want.hookSpecificOutput, out, at, name)
  if (why) return `${why} (${answers.exactly})`
  return answers.input(name, out, request)
}

/** hookAnswerMismatch for a permission request, and with `request`, for that request. */
export const permissionAnswerMismatch = (actual, status = 200, request = undefined) => hookAnswerMismatch(ROUTES.permission, actual, status, request)

/**
 * Why a reply's body doesn't match, or null; `expected` is undefined when the reply line gives no body, and
 * `actual` when the answer had none that parses. An answer to a hook's request, with its `status`, must be one
 * PROTOCOL.md allows first (hookAnswerMismatch), for `request`, the hook's input it answers, when that's known. Then:
 * - An expected `{}` for it means no decision, so it fails on an answer that carries one: by the general rule an empty
 *   object would match any answer, an Allow included, and the fixture would pass on the very thing it rules out.
 * - An Answer or an Approve plan, expected or got, must equal the expected body exactly, updatedInput included
 *   (PROTOCOL.md, "Matching"): by the general rule an Allow expected would match an Answer, and an Answer expected one
 *   whose updatedInput has a key of its own, which Claude Code fails as a deny.
 */
export function replyMismatch(route, expected, actual, bindings, status = 200, request = undefined) {
  if (HOOKS.has(route)) {
    const why = hookAnswerMismatch(route, actual, status, request)
    if (why) return why
    if (isObject(expected) && Object.keys(expected).length === 0) {
      return isObject(actual) && !Object.hasOwn(actual, 'hookSpecificOutput') ? null : `body: expected no decision ({}), got ${show(actual)}`
    }
    if (route === ROUTES.permission && expected !== undefined && (carriesInput(expected) || carriesInput(actual))) {
      const exact = exactMismatch(expected, actual, 'body')
      return exact && `${exact} (an Answer or an Approve plan must equal the expected body exactly, updatedInput included)`
    }
  }
  return expected === undefined ? null : mismatch(expected, actual, { at: 'body', hook: commandIdHook(bindings) })
}

/**
 * Why a reply's check hangs on a registry that a driver skipping registry lines can't write, or null. The deck takes
 * a hook's request only from a session its registry confirms, and refuses a hello only from a host its registry lists
 * under another sessionId (PROTOCOL.md, "Desktop sessions only"). No registry such a deck reads lists the fixture's
 * sessions, so it answers their hook requests {} at once, and takes a hello the fixture has refused. `entry` is the
 * labeled request, `want` the reply line, `r` the answer, whose `ms` the client measured: at once is within
 * HOOK_AT_ONCE_MS of sending it.
 */
function hangsOnRegistry(entry, want, r) {
  const decision = isObject(want.body) && Object.hasOwn(want.body, 'hookSpecificOutput')
  const none = r.status === 200 && isObject(r.json) && Object.keys(r.json).length === 0
  const atOnce = Number.isFinite(r.ms) && r.ms <= HOOK_AT_ONCE_MS
  if (HOOKS.has(entry.route) && decision && atOnce && none) {
    return "the deck answered {} at once, as it does for a session its registry doesn't confirm, and this mode skips registry lines: no registry it reads lists the fixture's session"
  }
  if (entry.route === ROUTES.hello && want.status === 409 && r.status === 200 && r.json?.ok === true) {
    return "the deck refuses a hello only from a host its registry lists under another sessionId, and this mode skips registry lines: no registry it reads lists the fixture's host"
  }
  return null
}

/**
 * Plays one parsed fixture (fixtures.mjs). Options:
 * - `url`, `token`: the bridge and its token.
 * - `driver`: againstFake or interactive (drivers.mjs).
 * - `say(text)`: progress lines, for --verbose and for a person.
 * - `replyMs`: how long a reply line waits for a held answer (2 s, PROTOCOL.md); a driver may give longer
 *   after a press (`replyAfterPressMs`), for a person's finger.
 * - `answerMs`: how long it waits for the answers it doesn't let go on without.
 * A driver with `uniqueInst` gets a fresh inst per play, bound to the fixture's (`ia` → `ia-x7k2q9`), in the mod's
 * requests: the mod picks its inst, and a deck that isn't reset between fixtures would otherwise drop a replay's
 * events as retries of the last play's, since each fixture's seq starts at 1 again. Claude Code's requests, the
 * hooks', have no inst, and are sent as they are.
 * Resolves `{name, ok, error?, checked, skipped}`: `skipped` lists `{line, reply, why}` for the replies a driver
 * that skips registry lines or presses can't check, `{line, press, why}` for the presses it skips, and `{line,
 * expect, why}`, with the fields the line expects, for the expect lines it skips. A mismatch ends the fixture and is
 * reported, not thrown.
 */
export async function play(fx, { url, token, driver, say = () => {}, replyMs = 2000, answerMs = 5000 } = {}) {
  const bindings = new Bindings()
  const labeled = new Map()
  const open = new Set()
  let sent = 0
  let lastAction = null
  // Saved Prompt and Mode presses the driver skipped, so commands the fixture expects that no press queued.
  let commandPressesSkipped = 0
  const result = { name: fx.name, ok: true, checked: 0, skipped: [] }
  const ctx = {
    fx, bindings, created: [], say, held: () => heldNow(), skip: (s) => result.skipped.push(s),
    /** Whether command `label` (c1, c2…) can't have been queued: a Saved Prompt or Mode press was skipped, and it isn't bound. */
    unsent: (label) => commandPressesSkipped > 0 && bindings.real('cmd', label) === undefined,
  }
  const tag = Math.random().toString(36).slice(2, 8)
  // The fixture's registry files by pid, as its lines have left them, and the hosts whose main loop's turn has ended
  // with no main-loop turn.start since, by the events the bridge took. From that turn end the deck answers a poll at
  // once while the registry says busy (PROTOCOL.md, "Commands"), which a driver that skips registry lines can't make
  // it say.
  const registry = new Map((fx.setup.registry ?? []).filter(isObject).map((f) => [f.pid, { ...f }]))
  const turnEnded = new Set()
  // The hosts whose registry file a line removed since their mod's last hello: the fixture's deck has forgotten them
  // (release rule 4) and answers their polls 409 hello first (Identity). One that reads another registry hasn't.
  const forgotten = new Set()

  /** Whether the deck answers a poll for `host` at once only because the fixture's registry says busy after its turn end. */
  function atOnceAfterTurnEnd(host) {
    return turnEnded.has(host) && [...registry.values()].some((f) => f.hostSessionId === host && f.status === 'busy')
  }

  /** Follows the main loop's turn ends and starts in an events body the bridge took. */
  function sawEvents(b) {
    if (!isObject(b) || !Array.isArray(b.events)) return
    for (const e of b.events) {
      // PROTOCOL.md, "Events": an agent that isn't a non-empty string counts as none, the main loop's.
      if (!isObject(e) || (typeof e.agent === 'string' && e.agent !== '')) continue
      if (e.t === 'turn.start') turnEnded.delete(b.host)
      else if (e.t === 'turn.end' || e.t === 'failed') turnEnded.add(b.host)
    }
  }

  /** The inst to send for the fixture's: the same one, or a fresh one bound to it. */
  function instFor(name) {
    if (!driver.uniqueInst || typeof name !== 'string') return name
    let real = bindings.real('inst', name)
    if (real === undefined) {
      real = `${name}-${tag}`
      bindings.bind('inst', name, real)
    }
    return real
  }

  /** The labeled permission requests whose answer hasn't come, oldest first. */
  const unanswered = () => [...labeled.values()].filter((e) => e.route === ROUTES.permission && !e.handle.settled)

  /**
   * The permission requests the deck holds, oldest first, as the key would show them: those with no answer
   * HOOK_AT_ONCE_MS after they were sent, by the client's own clock. It waits for that time to pass for each request
   * still within it: an answer by then was given at once, as a deck that doesn't confirm the request's session gives
   * {}, whenever the runner happened to look, and holds nothing for a press.
   */
  async function heldNow() {
    await Promise.all(unanswered().map((e) => settledWithin(e.handle.answer, e.handle.started + HOOK_AT_ONCE_MS - performance.now())))
    return unanswered().map((e) => {
      const b = isObject(e.line.value.body) ? e.line.value.body : {}
      const tool = typeof b.tool_name === 'string' ? b.tool_name : '?'
      return { label: e.line.value.as, host: e.line.value.headers?.['X-Deck-Host'] ?? null, tool, summary: summary(tool, b.tool_input) }
    })
  }

  /** The kind of the next line that does something, past notes and lines for the plugin side. */
  function nextAction(i) {
    for (let j = i + 1; j < fx.lines.length; j++) if (!SKIPPED.has(fx.lines[j].kind)) return fx.lines[j].kind
    return null
  }

  async function sendLine(line) {
    const p = line.value
    const headers = { host: hostHeader(url), authorization: `Bearer ${token}` }
    for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = v === null ? null : String(v).replaceAll('$TOKEN', token)
    const route = routeOf(p.path)
    let target = p.path
    if (driver.uniqueInst && route === ROUTES.next) {
      const u = new URL(p.path, 'http://fixture')
      if (u.searchParams.has('inst')) u.searchParams.set('inst', instFor(u.searchParams.get('inst')))
      target = `${u.pathname}${u.search}`
    }
    let body
    if (p.raw !== undefined) body = p.raw
    else if (p.body !== undefined) {
      const b = structuredClone(p.body)
      // Results name the deck's real id for the command the fixture calls c1, c2…
      if (route === ROUTES.result && isObject(b) && typeof b.id === 'string') b.id = bindings.real('cmd', b.id) ?? b.id
      // Only the mod's requests carry its inst: a field of that name in a hook's input would be Claude Code's.
      if (MODS.has(route) && isObject(b) && typeof b.inst === 'string') b.inst = instFor(b.inst)
      body = JSON.stringify(b)
    }
    const handle = send(url, { method: p.method, path: target, headers, body })
    sent++
    open.add(handle)
    const drop = () => open.delete(handle)
    handle.answer.then(drop, drop)
    const pollHost = route === ROUTES.next ? new URL(p.path, 'http://fixture').searchParams.get('host') : null
    const atOnce = route === ROUTES.next && atOnceAfterTurnEnd(pollHost)
    // `forgotten`: the poll is for a session the fixture's deck has forgotten, and asks for a hello.
    const entry = { line, handle, route, atOnce, forgotten: route === ROUTES.next && forgotten.has(pollHost) }
    if (p.as) labeled.set(p.as, entry)
    // The mod's hello: the fixture's deck has it from now on.
    if (route === ROUTES.hello && isObject(p.body)) forgotten.delete(p.body.host)
    say(`→ ${p.method} ${p.path}${p.as ? ` [${p.as}]` : ''}`)
    if (MAY_HOLD.has(route)) {
      // Let the bridge take it before the next line, so what follows lands after it, as in the fixture.
      await driver.taken(sent)
      return
    }
    let r
    try {
      r = await within(handle.answer, answerMs, `no answer within ${answerMs / 1000} s`)
    } catch (err) {
      throw new PlayFailure(line, `${p.method} ${route}: ${err.message}`)
    }
    if (!(p.as && fx.replied.has(p.as)) && r.status !== 200 && r.status !== 204) {
      throw new PlayFailure(line, `${p.method} ${route} answered ${r.status} ${r.text}`)
    }
    // A mode check's answer is Claude Code's to act on: held to PROTOCOL.md's bodies whether or not a reply line checks it.
    if (HOOKS.has(route)) {
      const why = hookAnswerMismatch(route, r.json, r.status)
      if (why) throw new PlayFailure(line, `${p.method} ${route}: ${why}`)
    }
    if (route === ROUTES.events && (r.status === 200 || r.status === 204)) sawEvents(p.body)
  }

  async function checkReply(line) {
    const { to, status, body } = line.value
    const entry = labeled.get(to)
    const skip = (why, said) => {
      result.skipped.push({ line: line.n, reply: to, why })
      say(`skip: reply ${to}, ${said}`)
    }
    if (driver.skipsRegistry && lastAction === 'registry') {
      // The answer waits on a registry change, and this driver can't make one.
      skip('it waits on a registry change, which this mode skips', 'which waits on the skipped registry change')
      return
    }
    if (driver.skipsRegistry && entry.atOnce) {
      // The deck holds this poll instead: no registry it reads says the session is busy.
      skip('the deck answers it at once only while the registry says busy after the turn ended, and this mode skips registry lines', 'answered at once only while the skipped registry says busy')
      return
    }
    if (driver.skipsRegistry && entry.forgotten && status === 409) {
      // The deck that read the fixture's registry forgot the session when a line removed its file. One that reads
      // another registry never did, and holds the poll of the instance that said hello.
      skip("the deck asks for a hello first only for a session it forgot, as at release rule 4 when the session's registry file goes, and this mode skips registry lines", 'a hello first that only the skipped removal of its registry file brings')
      return
    }
    const cmds = entry.route === ROUTES.next && isObject(body) && Array.isArray(body.cmds) ? body.cmds : []
    if (cmds.some((c) => isObject(c) && ctx.unsent(c.id))) {
      // No command can come: only a press queues one, and the driver skipped it.
      skip('it expects a command that only a Saved Prompt or Mode press queues, and the press was skipped', 'whose command no press queued')
      return
    }
    const waitMs = lastAction === 'press' && driver.replyAfterPressMs ? driver.replyAfterPressMs : replyMs
    let r
    try {
      r = await within(entry.handle.answer, waitMs, `no answer within ${waitMs / 1000} s`)
    } catch (err) {
      throw new PlayFailure(line, `${to}: ${err.message}`)
    }
    // Only an answer that is exactly what such a deck gives, {} or a hello's ok, is skipped: anything else is checked.
    const hangs = driver.skipsRegistry ? hangsOnRegistry(entry, line.value, r) : null
    if (hangs) {
      skip(hangs, entry.route === ROUTES.hello ? 'a refusal only a registry listing its host gives' : "answered {} at once: no registry the deck reads confirms the fixture's session")
      return
    }
    if (r.status !== status) throw new PlayFailure(line, `${to}: status: expected ${status}, got ${r.status} ${r.text}`)
    if (body !== undefined && r.json === undefined) throw new PlayFailure(line, `${to}: expected a JSON body, got ${show(r.text)}`)
    // Checked even when the line gives no body: an answer to a hook's request must still be PROTOCOL.md's, and fit the
    // request it answers, the hook's input as the fixture sent it.
    const sentBody = entry.line.value.raw === undefined && isObject(entry.line.value.body) ? entry.line.value.body : undefined
    const request = entry.route === ROUTES.permission ? sentBody : undefined
    const why = r.json === undefined && !HOOKS.has(entry.route) ? null : replyMismatch(entry.route, body, r.json, bindings, r.status, request)
    if (why) throw new PlayFailure(line, `${to}: ${why}`)
    result.checked++
    say(`✓ reply ${to}: ${status}${r.text ? ` ${r.text.length > 100 ? `${r.text.slice(0, 99)}…` : r.text}` : ''}`)
  }

  try {
    await driver.begin(fx, ctx)
    for (let i = 0; i < fx.lines.length; i++) {
      const line = fx.lines[i]
      switch (line.kind) {
        case 'plugin':
          await sendLine(line)
          lastAction = 'plugin'
          break
        case 'reply':
          await checkReply(line)
          break
        case 'press': {
          const before = result.skipped.length
          await driver.press(line, { ...ctx, replyNext: nextAction(i) === 'reply' })
          const skipped = result.skipped.length > before
          const [key] = Object.keys(line.value)
          if (skipped && (key === 'prompt' || key === 'mode')) commandPressesSkipped++
          // A press the driver skipped gives no reply after it a person's time to come.
          lastAction = skipped ? 'press-skipped' : 'press'
          break
        }
        case 'registry': {
          const { pid, gone, ...fields } = line.value
          const host = registry.get(pid)?.hostSessionId
          if (gone) registry.delete(pid)
          else registry.set(pid, { ...(registry.get(pid) ?? { pid }), ...fields })
          // Release rule 4: no file lists the host any more.
          if (gone && typeof host === 'string' && ![...registry.values()].some((f) => f.hostSessionId === host)) forgotten.add(host)
          await driver.registry(line, ctx)
          lastAction = 'registry'
          break
        }
        case 'expect':
          // True when the driver checked the state itself; one it skipped isn't counted.
          if (await driver.expect(line, ctx)) result.checked++
          break
        default:
          break
      }
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof PlayFailure ? err.message : `stopped: ${err.message}`
  } finally {
    // Whatever is still open goes: the bridge sees its clients close, as when a session ends.
    for (const h of open) h.abort()
    try {
      await driver.end?.(fx, ctx)
    } catch (err) {
      if (result.ok) {
        result.ok = false
        result.error = `cleanup: ${err.message}`
      }
    }
  }
  return result
}
