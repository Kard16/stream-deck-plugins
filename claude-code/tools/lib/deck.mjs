// The fake deck: what the deck plugin knows and does, without the hardware or the Stream Deck SDK
// (claude-code/protocol/PROTOCOL.md, v1). It takes the hook's requests only from sessions the registry confirms,
// holds permission requests and sorts them into kinds, queues commands and hands them to long polls, follows each
// session from the mod's hello and events, applies the release rules, and works out each session's status the way
// the deck shows it.
//
// No I/O here: bridge.mjs feeds it HTTP requests and folder readings, and reads the registry once more when a
// request asks for it (hookNeedsReading, helloNeedsReading). Its clocks and timers are injected, so the tests drive
// it directly. Presses come from the control interface in place of the keys and the Session Slot dials.

import {
  ASK_INPUT_MAX, ASK_TOOLS, AT_ONCE_MS, DENY, DIAL_PLANS, FINAL_STATES, HELLO_FIRST, HOST_PATTERN, IN_FLIGHT_MS, NOT_THIS_SESSION,
  VERSION, answerBody, answerFor, approvePlanBody, fingerprint, joinLabels, summary,
} from './protocol.mjs'

/** A control call, or a mod request, that can't be carried out as asked: bridge.mjs answers it with 400. */
export class BadRequest extends Error {}

/**
 * A hello from a host the registry lists under another sessionId (PROTOCOL.md, "Desktop sessions only"): a `claude`
 * started inside that session, which inherits its host id. bridge.mjs answers it with 409 `{"error": "not this
 * session"}`.
 */
export class NotThisSession extends Error {
  constructor() {
    super(NOT_THIS_SESSION)
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v !== '' ? v : null)
/**
 * A field PROTOCOL.md gives as a string, as sent, or null. Nothing else from a mod's body is kept: a value nested
 * too deep would stop every later state from being written out.
 */
const asString = (v) => (typeof v === 'string' ? v : null)

/**
 * A value from a mod's body for a line people read: JSON, cut short. Nothing about it can throw: one nested too
 * deep to write out is named instead, since a line that threw would fail the request it's about, and the mod
 * would resend it, or lose the rest of its events.
 */
function display(v) {
  let text
  try {
    text = JSON.stringify(v) ?? String(v)
  } catch {
    return 'a value nested too deep to show'
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

const IN_FLIGHT = new Set(['delivered', 'waiting'])
const FINAL = new Set(FINAL_STATES)
const RECENT_KEPT = 50
/** The `surface` of the desktop app's own `attach` and `detach`, the only ones the deck counts (PROTOCOL.md, "Events"). */
const DESKTOP_SURFACE = 'desktop'

// ---- a Session Slot dial's strip ----------------------------------------------------------------------------
//
// PROTOCOL.md, "Held requests", as amended on 2026-11-04 for session keys, and docs/claude-code/session-keys.md, "The
// strip": a held ask request keeps its tool_input, up to ASK_INPUT_MAX of JSON, so its session's dial can show the
// form and echo it back. What the strip shows for a request is worked out once, when it's held: its input doesn't
// change.

/**
 * Why a held ask request's tool_input isn't kept for the dial, or null when it is: its JSON is over ASK_INPUT_MAX
 * bytes (UTF-8, as JSON.stringify writes it), it can't be written out, or there's none. `scrubbed`: the bridge took a
 * run of the token out of it before reading it, as it does every body, so it can't go back as it came.
 */
function notKept(input, scrubbed) {
  if (scrubbed) return "the bridge scrubbed a run of the token out of its tool_input, so it can't echo the input back as it came"
  let text
  try {
    text = JSON.stringify(input)
  } catch {
    return "its tool_input can't be written out"
  }
  if (text === undefined) return 'it has no tool_input'
  const bytes = Buffer.byteLength(text)
  return bytes > ASK_INPUT_MAX ? `its tool_input is ${bytes} bytes of JSON, over the ${ASK_INPUT_MAX} the deck keeps` : null
}

/**
 * An AskUserQuestion's form as the dial reads it: `{questions}`, each `{question, header, multiSelect, labels}`, or
 * `{why}` for one it can't read, which shows "Answer in app". The same rules as the real deck's parseAskForm
 * (claude-code/deck/src/protocol/ask.ts), in its order, and the list PROTOCOL.md's "Held requests" gives: no
 * `questions` array, or an empty one; a question that isn't an object, or whose `question` isn't a non-empty string, or
 * repeats another's (the answers go by it); a `header` that's there and isn't a string, null included; a `multiSelect`
 * that's there and isn't a boolean (a missing one is single-select); `options` that isn't a non-empty array; an option
 * that isn't an object, or whose `label` isn't a non-empty string, or repeats another's of its question; a
 * `description` that's there and isn't a string, null included. Any other field goes back unchanged in the Answer.
 */
function readQuestions(input) {
  if (!isObject(input) || !Array.isArray(input.questions) || input.questions.length === 0) return { why: 'it has no list of questions to read' }
  const questions = []
  for (const [i, q] of input.questions.entries()) {
    const which = `question ${i + 1}`
    if (!isObject(q) || typeof q.question !== 'string' || q.question === '') return { why: `${which} has no text` }
    if (questions.some((x) => x.question === q.question)) return { why: `two questions ask ${display(q.question)}, and the answers go by a question's text` }
    if (q.header !== undefined && typeof q.header !== 'string') return { why: `${which}'s header isn't a string` }
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') return { why: `${which}'s multiSelect isn't a boolean` }
    if (!Array.isArray(q.options) || q.options.length === 0) return { why: `${which} has no options to pick from` }
    const labels = []
    for (const o of q.options) {
      if (!isObject(o) || typeof o.label !== 'string' || o.label === '') return { why: `an option of ${which} has no label` }
      if (labels.includes(o.label)) return { why: `two options of ${which} have the label ${display(o.label)}` }
      if (o.description !== undefined && typeof o.description !== 'string') return { why: `the description of ${which}'s option ${display(o.label)} isn't a string` }
      labels.push(o.label)
    }
    questions.push({ question: q.question, header: q.header ?? null, multiSelect: q.multiSelect === true, labels })
  }
  return { questions }
}

/**
 * A plan's first heading or line, for the strip, as the real deck's planFirstLine reads it
 * (claude-code/deck/src/protocol/ask.ts): `plan` split into lines at \r\n, \n or \r, each with a heading's `#` marks
 * and the spaces before and after them taken off, then trimmed, and the first with text in it, whole. Null when
 * there's no `plan` string, as when Claude wrote no plan file, or no line with text.
 */
function planLine(plan) {
  if (typeof plan !== 'string') return null
  for (const raw of plan.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/^\s*#+\s*/, '').trim()
    if (line !== '') return line
  }
  return null
}

/**
 * What a Session Slot dial's strip shows for a held request, once it's its session's oldest:
 * - `approval` for a tool request, which the dial allows or denies;
 * - `question` for an AskUserQuestion whose form it reads (readQuestions), with its questions and their labels;
 * - `plan` for an ExitPlanMode whose tool_input is an object (`{}`, or `{plan, planFilePath}`), with the plan's first
 *   line (planLine), or null;
 * - `answer-in-app`, with `why`, for an ask request whose tool_input the deck didn't keep or can't read: a press jumps.
 */
function screenOf(kind, tool, input, scrubbed) {
  if (kind !== 'ask') return { screen: 'approval' }
  const why = notKept(input, scrubbed)
  if (why) return { screen: 'answer-in-app', why }
  if (tool === 'ExitPlanMode') {
    return isObject(input) ? { screen: 'plan', plan: planLine(input.plan) } : { screen: 'answer-in-app', why: "its tool_input isn't an object" }
  }
  const form = readQuestions(input)
  return form.why ? { screen: 'answer-in-app', why: form.why } : { screen: 'question', questions: form.questions }
}

/**
 * The answers a dial's picks make on a question screen (PROTOCOL.md, "Permission requests"): every question gets one,
 * a single-select question's its one label as it is, a multi-select one's its labels, at least one, in the order of
 * its options and joined (joinLabels), whatever order they were picked in. `{answers}`, or `{error}` for picks the dial
 * can't make on the strip: for a question it doesn't ask, none for one it does, a label that isn't one of the
 * question's options, or more than one for a single-select question. A label picked twice is picked once.
 */
function answersFrom(questions, picks) {
  const asked = questions.map((q) => q.question)
  const stray = Object.keys(picks).find((k) => !asked.includes(k))
  if (stray !== undefined) return { error: `the strip asks no question ${display(stray)}; it asks ${asked.map(display).join(', ')}` }
  const answers = []
  for (const q of questions) {
    if (!Object.hasOwn(picks, q.question)) return { error: `nothing picked for ${display(q.question)}: every question gets an answer` }
    const picked = new Set(picks[q.question])
    const unknown = [...picked].find((l) => !q.labels.includes(l))
    if (unknown !== undefined) return { error: `${display(q.question)} has no option ${display(unknown)}; its options are ${q.labels.map(display).join(', ')}` }
    if (picked.size === 0) return { error: `nothing picked for ${display(q.question)}: ${q.multiSelect ? 'a multi-select question needs at least one tick' : 'every question gets an answer'}` }
    if (!q.multiSelect && picked.size > 1) return { error: `${display(q.question)} is single-select, and got ${picked.size} picks` }
    const inOrder = q.labels.filter((l) => picked.has(l))
    answers.push([q.question, q.multiSelect ? joinLabels(inOrder) : inOrder[0]])
  }
  // Each question's text as a key of its own, `__proto__` included.
  return { answers: Object.fromEntries(answers) }
}

/**
 * A host id from a request or a registry file (PROTOCOL.md, "Identity"). A value that doesn't match counts as
 * missing: an empty one, or the hook's `$CLAUDE_CODE_HOST_SESSION_ID` when Claude Code didn't fill it in.
 */
const hostValue = (v) => (typeof v === 'string' && HOST_PATTERN.test(v) ? v : null)

/** A registry entry's `statusUpdatedAt`, or null for none: only a number counts, as the deck reads it. */
const statusAt = (f) => (Number.isFinite(f.statusUpdatedAt) ? f.statusUpdatedAt : null)

/**
 * Whether registry file `a` is the one the deck shows for its host rather than `b`, another file that lists the same
 * host: a restarted process whose old file lingers beside its new one. The later `startedAt` wins, as in the real
 * deck. A file without one loses to a file with one, and of two that tie, or both have none, the lower pid wins: the
 * real deck orders the files by start and then pid, and takes a later one only when it started later.
 */
function showsOver(a, b) {
  const sa = Number.isFinite(a.startedAt) ? a.startedAt : null
  const sb = Number.isFinite(b.startedAt) ? b.startedAt : null
  if (sa !== sb) return sb === null || (sa !== null && sa > sb)
  return Number.isFinite(a.pid) && (!Number.isFinite(b.pid) || a.pid < b.pid)
}

function newSession(host) {
  return {
    host,
    /**
     * The latest Claude Code session id its mod came with, and every one: it can change, and the host fallback places
     * a mod's request by any of them (PROTOCOL.md, Identity). The hooks' never count here.
     */
    sid: null,
    sids: new Set(),
    /**
     * The current instance. Only a hello sets it: one from an inst that hasn't said hello for the session before, or
     * any inst's while none is current (PROTOCOL.md, Identity, as amended on 2026-11-03 for Phase 6, round 4). It's
     * null again once the current instance has gone IN_FLIGHT_MS with no poll open and none sent (#armPollGap).
     */
    inst: null,
    /**
     * Every inst that has said hello for the session, newest last by when each was made current. While one is
     * current, a hello from any of the others is no restart and makes nothing current. Kept when the current instance
     * stops polling (#instanceQuiet); forgotten only with the session, at release rule 4 or a reset.
     */
    insts: new Set(),
    /** True once anything has come from its mod: hello, events, a poll or a result. */
    plugin: false,
    hello: null,
    /** The last event `seq` seen, by inst. */
    seq: new Map(),
    /** Unfinished tool calls by `use`, with the order they started in. */
    tools: new Map(),
    toolOrder: 0,
    /**
     * Calls whose tool.start no held request has paired with by fp: under way, or ended while a request of their
     * tool was waiting, which may have been theirs.
     */
    fpCalls: [],
    /**
     * The main loop's current or last turn: its id, did the deck see it end, how, did it fail, when the deck got its
     * turn.start and its turn.end, each as a #seenTick (status rule 3: `startSeen`, `endSeen`), and when it got the
     * turn's last end, a turn.end or failed: by the wall clock for people (`endedAt`), and by the monotonic clock for
     * the polls answered at once (`endedMono`, #afterTurnEnd).
     */
    turn: { id: null, sawEnd: false, lastEnd: null, failed: false, startSeen: null, endSeen: null, endedAt: null, endedMono: null },
    context: null,
    /** The latest model, effort and mode from the plugin: hello, settings events, PermissionRequests. */
    settings: { model: null, effort: null, mode: null },
    /**
     * Where the deck last took each of `settings` from, field by field: 'hello', 'settings' (an event) or 'permission'
     * (a PermissionRequest), or null for none yet. No hello replaces a mode or effort taken from a PermissionRequest; a
     * settings event, or a later PermissionRequest, does (PROTOCOL.md, "The deck's session model", as amended on
     * 2026-11-03 for Phase 6, round 4). The model comes only from hellos and settings events.
     */
    settingsFrom: { model: null, effort: null, mode: null },
    attachAt: null,
    onScreen: false,
    ended: null,
    poll: null,
    /**
     * When the session last had a poll of its current instance's open or answered, by the monotonic clock: when its
     * last open poll ended, or one was answered at once, or else when a hello made its instance current. Null while a
     * poll is open, or before any of these.
     */
    pollEndedAt: null,
    /**
     * Once the session has gone IN_FLIGHT_MS without an open poll: fails its waiting prompts, and has its current
     * instance stop counting (#armPollGap).
     */
    gapTimer: null,
    lastSeen: null,
  }
}

const wire = (c) => ({ id: c.id, t: c.t, text: c.text })

export class FakeDeck {
  #now
  #mono
  #log
  #inFlightMs
  #setTimer
  #clearTimer
  #cmdPrefix

  /** host → session, for every session the bridge has heard from or holds a request for. */
  #sessions = new Map()
  /**
   * host → registry fields: the sessions the deck lists. When two files list one host, the one the deck shows
   * (showsOver).
   */
  #registry = new Map()
  /**
   * host → the session ids its registry files list it with, every file counted, an old one that lingers included:
   * what confirms a hook's request or a hello ("Desktop sessions only"). A file with no sessionId adds none.
   */
  #listed = new Map()
  /**
   * sessionId → host, from the files the deck shows (#registry), one per host: what places a mod's request with no
   * host (#hostFor), as the real deck's #hostForSid looks only at those. A lingering old file's sessionId places none.
   */
  #registryBySid = new Map()
  /**
   * host → when the deck read the session's current status, as a #seenTick: the reading where its `status` or
   * `statusUpdatedAt` last changed, or its first (status rule 3).
   */
  #statusSeen = new Map()
  /** host → the record's fields. */
  #records = new Map()
  /** Held permission requests, oldest first. */
  #held = []
  /**
   * host → the id of the request its Session Slot dial showed last: its session's oldest held request, from when it
   * became the oldest. Kept once the request has gone, so the dial's press for it alerts, until the session's next
   * request is held: a request answered elsewhere makes the press alert only while nothing newer is on the strip
   * (PROTOCOL.md, "Held requests"; dial-next). #heldChanged, dial.
   */
  #dialShown = new Map()
  /** Requests that ended, newest last, so `answer` can say how one ended. */
  #recent = []
  /** Held requests that no tool.start has paired with by fp yet, oldest first. */
  #fpWaiting = []
  /** Orders the fp check's arrivals, requests and tool.starts and ends alike, whatever the clock says. */
  #fpTick = 0
  /** Orders registry readings and main-loop turn.ends as the deck got them, whatever the clock says (status rule 3). */
  #seenTick = 0
  /** id → command, in the order they were queued. */
  #commands = new Map()
  /** A Saved Prompt key's text → the id of the last prompt it queued. */
  #promptKeys = new Map()
  #lastPress = null
  #heldSeq = 0
  #cmdSeq = 0
  #pollSeq = 0

  /**
   * Options: `now` (the wall clock, ms: arrival times, and what people read in the state), `monoNow` (a monotonic
   * clock, ms, as the deck's: the 60 s of polls answered at once after a turn end, and a session's time without an
   * open poll; a wall clock that a time sync moves, or that a fixture runner makes follow the registry's times,
   * mustn't move them), `log(event)` (structured events; `say` is a line for people), `inFlightMs` (how long a
   * delivered command waits for its final result, and a queued one for a poll), `cmdPrefix` (command ids are the
   * prefix and a number: deliberately not the fixtures' `c1`, so the tests exercise binding),
   * `setTimer`/`clearTimer` (relative ms, as setTimeout's).
   */
  constructor({ now = Date.now, monoNow = () => performance.now(), log = () => {}, inFlightMs = IN_FLIGHT_MS, cmdPrefix = 'cmd-', setTimer, clearTimer } = {}) {
    this.#now = now
    this.#mono = monoNow
    this.#log = log
    this.#inFlightMs = inFlightMs
    this.#cmdPrefix = cmdPrefix
    this.#setTimer = setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimer = clearTimer ?? ((t) => clearTimeout(t))
  }

  // ---- sessions ------------------------------------------------------------------------------------------

  #session(host) {
    let s = this.#sessions.get(host)
    if (!s) {
      s = newSession(host)
      this.#sessions.set(host, s)
    }
    return s
  }

  /**
   * The host a mod's request is for: its own `host`, else its `sid` looked up in the registry's shown files, then
   * among every sid and host pair the bridge has seen from mods (PROTOCOL.md, Identity). The hooks' requests are never
   * placed so: only the registry confirms them (#confirmed).
   */
  #hostFor(sid, host) {
    const h = hostValue(host)
    if (h) return h
    const s = str(sid)
    if (!s) return null
    const fromRegistry = this.#registryBySid.get(s)
    if (fromRegistry) return fromRegistry
    for (const x of this.#sessions.values()) if (x.sids.has(s)) return x.host
    return null
  }

  /** A sid the session's mod came with: the latest, and one more pair for the host fallback. */
  #sawSid(s, sid) {
    if (!str(sid)) return
    s.sid = sid
    s.sids.add(sid)
  }

  /**
   * The session a mod request names, marked as having the plugin. Whatever its inst, this changes no instance: only
   * a hello makes an inst current (PROTOCOL.md, Identity, and hello below).
   */
  #touchMod(sid, host) {
    const h = this.#hostFor(sid, host)
    if (!h) return null
    const s = this.#session(h)
    s.plugin = true
    s.lastSeen = this.#now()
    this.#sawSid(s, sid)
    return s
  }

  /**
   * PROTOCOL.md, "Desktop sessions only": the host of a hook's request when the registry, as last read, lists its
   * X-Deck-Host with a sessionId equal to its session_id, in any of its files; else null. Every Claude Code process
   * that reads ~/.claude/settings.json runs the hooks, and a `claude` started inside a desktop session sends that
   * session's host with its own session id, so the header alone proves nothing.
   */
  #confirmed(hostHeader, sessionId) {
    const host = hostValue(hostHeader)
    const sid = str(sessionId)
    if (!host || !sid) return null
    return this.#listed.get(host)?.has(sid) ? host : null
  }

  /**
   * Whether bridge.mjs reads the registry once more before it hands this hook's request over (PROTOCOL.md, "Desktop
   * sessions only"): the latest reading doesn't confirm its session, and another could, since it names a host and a
   * session id.
   */
  hookNeedsReading(hostHeader, body) {
    const b = isObject(body) ? body : {}
    return this.#confirmed(hostHeader, b.session_id) === null && hostValue(hostHeader) !== null && str(b.session_id) !== null
  }

  /**
   * A hook's request from a session the registry doesn't confirm: no decision at once, and nothing held, made or
   * changed, the session's settings included. The process's own permission flow decides.
   */
  #unconfirmed(b, hostHeader, responder) {
    responder.send(200, answerFor('none'))
    const host = hostValue(hostHeader)
    const sid = str(b.session_id)
    const tool = typeof b.tool_name === 'string' ? b.tool_name : ''
    const sids = host ? this.#listed.get(host) : undefined
    const why =
      !host ? 'no host: X-Deck-Host is missing or not a local_ id'
      : !sid ? 'no session_id'
      : !sids ? `the registry doesn't list ${host}`
      : sids.size === 0 ? `the registry lists ${host} without a sessionId`
      : `the registry lists ${host} under another sessionId`
    this.#log({ kind: 'unconfirmed', route: 'permission', host, sid, tool, why, say: `permission request for ${display(tool)} from ${host ?? '(no host)'}: {} at once, nothing held: ${why}` })
    return { kind: 'unconfirmed' }
  }

  /** A mod request that names no session the bridge can place. PROTOCOL.md, Identity: it gets 400. */
  #unplaced(kind) {
    this.#log({ kind, placed: false, say: `${kind} naming no session it can place (no host, and its sid is unknown): 400` })
    throw new BadRequest('the request names no session the bridge can place: give its host (local_…), or a sid the registry knows')
  }

  /**
   * PROTOCOL.md, Identity: a hello from an inst the deck hasn't had a hello from for the session, while another is
   * current, forgets the session's current tool, fails its delivered and waiting commands, and answers the old
   * instance's open poll with no commands, so what's queued from then on waits for the new one. The session's requests
   * still wait for their tool.starts, which the old instance's line may yet bring, or may have lost.
   */
  #modRestarted(s, inst) {
    s.tools.clear()
    for (const c of this.#commands.values()) {
      if (c.host === s.host && IN_FLIGHT.has(c.state)) this.#finish(c, 'failed', { error: 'the mod restarted' })
    }
    this.#endPoll(s, [])
    this.#armPollGap(s)
    this.#log({ kind: 'mod-restart', host: s.host, from: s.inst, to: inst, say: `${s.host}: the mod restarted (inst ${s.inst} → ${inst})` })
    for (const h of this.#fpWaiting) if (h.host === s.host) h.fpRestarted = true
  }

  /** The session's held requests, oldest first. Every one has a host: only a confirmed session's are held. */
  #heldOf(host) {
    return this.#held.filter((h) => h.host === host)
  }

  /**
   * The session's held requests changed: its dial's strip shows its oldest now, if it has one, and that's the request
   * the dial showed last, whether it was held behind the one that went or came after it. With none left, the strip
   * goes back to its pages, and the request it showed last stays, so a press for it alerts until a newer one is held.
   */
  #heldChanged(host) {
    const oldest = this.#heldOf(host)[0]
    if (oldest) this.#dialShown.set(host, oldest.id)
  }

  // ---- POST /v1/hello ------------------------------------------------------------------------------------

  /**
   * PROTOCOL.md, "Desktop sessions only": the hello's host and the sessionIds the registry, as last read, lists it
   * under, when no file lists it with the hello's sid; else null. A hello with no sid is no listed session's. A host
   * the registry doesn't list yet, as a pre-warmed spare's, refuses nothing, and nor does one listed only in files with
   * no sessionId: only another sessionId does. Every file counts, so a host listed in two, a restarted process's old
   * file lingering beside its new one, takes a hello with either's sid.
   */
  #helloConflict(b) {
    const host = this.#hostFor(b.sid, b.host)
    const sids = host ? this.#listed.get(host) : undefined
    if (!sids?.size) return null
    const sid = str(b.sid)
    return sid !== null && sids.has(sid) ? null : { host, listed: [...sids] }
  }

  /**
   * Whether bridge.mjs reads the registry once more before it hands this hello over: the latest reading would refuse
   * it, and a session whose id has just changed, after a /clear say, mustn't be refused on a reading made before.
   */
  helloNeedsReading(body) {
    const b = isObject(body) ? body : {}
    return b.v === VERSION && this.#helloConflict(b) !== null
  }

  /**
   * PROTOCOL.md, Routes, Identity and "Desktop sessions only". A hello on another version is refused first. One from
   * a host the registry lists, in no file with its sid, throws NotThisSession, for a 409, and is taken no further:
   * nothing of it is kept. Any other is taken, a spare's for a host the registry doesn't list yet included.
   *
   * Only a hello makes an inst the session's current one (PROTOCOL.md, Identity, as amended on 2026-11-03 for Phase 6,
   * round 4):
   * - While none is current, any inst's hello: after a reset, after release rule 4, or once the current instance
   *   stopped polling (#instanceQuiet), an inst the deck has had a hello from before included. That's no restart:
   *   nothing is failed or forgotten.
   * - While one is current, the hello of an inst that hasn't said hello for the session before: the mod restarted
   *   (#modRestarted).
   * A hello that makes its inst current takes its cwd and model, and its mode and effort unless the deck took them
   * from a PermissionRequest, each field apart (PROTOCOL.md, "The deck's session model"): a hello's mode and effort
   * are what its mod has already sent or queued as settings, which can be older than a PermissionRequest's, the
   * engine's own at that moment. After a deck restart a PermissionRequest can come before the mod's first hello, and
   * after the 60 s before the hello that makes an instance current again. It's the session's hello in the state, and
   * the inst's time without an open poll starts from it (#armPollGap).
   *
   * The current instance's own hello, said again, takes its cwd and model only (PROTOCOL.md, Identity, as amended on
   * 2026-11-03 for Phase 6), with no restart and nothing else changed: its time without a poll goes on, since a hello
   * isn't a poll (#armPollGap). The mod says one after a fetch that rejected, as when an Esc or a deck Deny abandons
   * its fetches, and in an outage. Its model is the mod's own reading, which the mod takes the deck to have once the
   * hello is answered ok (connected() in claude-code/plugin/hooks/bridge.ts).
   * Its mode and effort are only what the mod has already sent, or queued to send, as settings, while the deck may
   * since have taken a newer one from a PermissionRequest, as after every Deny: so the deck keeps its own.
   *
   * Any other hello, from an inst that said hello before while another is current, or with no inst, is answered ok
   * and changes nothing: its model, mode and effort aren't taken, nor is it the session's hello in the state, as the
   * real deck takes none of it. A replaced instance's late hello would otherwise put back what it last saw, or, as a
   * restart, take the session back from the live mod. Like any mod request it still marks the session as having the
   * plugin, and keeps its sid as a pair.
   */
  hello(body) {
    const b = isObject(body) ? body : {}
    if (b.v !== VERSION) {
      this.#log({ kind: 'hello', ok: false, v: b.v ?? null, say: `hello from ${hostValue(b.host) ?? '?'} on version ${display(b.v)}: refused` })
      return { v: VERSION, ok: false, error: 'version' }
    }
    const conflict = this.#helloConflict(b)
    if (conflict) {
      const inst = str(b.inst)
      this.#log({
        kind: 'hello', ok: false, status: 409, host: conflict.host, inst, sid: str(b.sid), listedSids: conflict.listed,
        say: `hello ${conflict.host} inst ${inst ?? '?'} refused (409): the registry lists ${conflict.host} under another sessionId`,
      })
      throw new NotThisSession()
    }
    const s = this.#touchMod(b.sid, b.host)
    if (!s) this.#unplaced('hello')
    const inst = str(b.inst)
    const [cwd, model, mode, effort, plugin, cc] = [b.cwd, b.model, b.mode, b.effort, b.plugin, b.cc].map(asString)
    // The current instance's hello, said again: taken, with no restart.
    const again = inst !== null && inst === s.inst
    // While one is current, an inst that said hello before doesn't count; while none is, any inst's hello does.
    if (!again && (inst === null || (s.inst !== null && s.insts.has(inst)))) {
      const why = inst === null ? 'no inst' : `an inst that said hello before, while ${s.inst} is current`
      this.#log({
        kind: 'hello', ok: true, current: s.inst, madeCurrent: false, again: false, host: s.host, inst, plugin, cc, model,
        say: `hello ${s.host} inst ${inst ?? '?'} (plugin ${plugin ?? '?'}, cc ${cc ?? '?'}, ${model ?? '?'}), ${why}: answered ok, nothing taken, and ${s.inst === null ? 'no instance is' : `${s.inst} stays`} current`,
      })
      return { v: VERSION, ok: true }
    }
    if (again) {
      // Its cwd and model only: its mode and effort are the mod's last report, which a PermissionRequest's may have
      // overtaken since. A field it leaves out, as a model the mod can't read, is kept.
      s.hello = { ...s.hello, againAt: this.#now(), cwd: str(cwd) ?? s.hello?.cwd ?? null, model: str(model) ?? s.hello?.model ?? null }
      this.#take(s, 'model', model, 'hello')
      this.#log({
        kind: 'hello', ok: true, current: s.inst, madeCurrent: true, again, took: ['cwd', 'model'], host: s.host, inst, plugin, cc, model,
        say: `hello ${s.host} inst ${inst} (plugin ${plugin ?? '?'}, cc ${cc ?? '?'}, ${model ?? '?'}), again from the current instance: its cwd and model taken, its mode and effort not, with no restart`,
      })
      return { v: VERSION, ok: true }
    }
    // An inst the deck has had a hello from before, made current again while none was: no restart.
    const saidBefore = s.insts.has(inst)
    if (s.inst !== null) this.#modRestarted(s, inst)
    // Newest last: the one made current now.
    s.insts.delete(inst)
    s.insts.add(inst)
    s.inst = inst
    s.hello = { at: this.#now(), inst, cwd, model, mode, effort, plugin, cc }
    this.#take(s, 'model', model, 'hello')
    // Its mode and effort, each unless the deck took it from a PermissionRequest, which can be newer. `took` names the
    // fields it may give, as before; `kept`, those it carried that the deck didn't take.
    const took = ['cwd', 'model']
    const kept = []
    for (const [k, v] of [['mode', mode], ['effort', effort]]) {
      if (s.settingsFrom[k] === 'permission') {
        if (str(v)) kept.push(k)
        continue
      }
      took.push(k)
      this.#take(s, k, v, 'hello')
    }
    // A new current instance has had no poll yet: its time without one starts now.
    if (!s.poll) s.pollEndedAt = this.#mono()
    this.#armPollGap(s)
    const notes = [
      saidBefore ? 'an inst that said hello before, made current again with no restart, since none was current' : null,
      kept.length ? `its ${kept.join(' and ')} not taken: the deck took ${kept.length > 1 ? 'them' : 'it'} from a PermissionRequest` : null,
    ].filter(Boolean)
    this.#log({
      kind: 'hello', ok: true, current: s.inst, madeCurrent: true, again, saidBefore, took, kept, host: s.host, inst, plugin, cc, model,
      say: `hello ${s.host} inst ${inst} (plugin ${plugin ?? '?'}, cc ${cc ?? '?'}, ${model ?? '?'})${notes.length ? `: ${notes.join('; ')}` : ''}`,
    })
    return { v: VERSION, ok: true }
  }

  /**
   * One of the session's settings, `k` (model, effort or mode), taken from `from` ('hello', 'settings' or
   * 'permission'), when `v` is a non-empty string; else what the deck had stays, and so does where it came from.
   */
  #take(s, k, v, from) {
    if (!str(v)) return
    s.settings[k] = v
    s.settingsFrom[k] = from
  }

  // ---- POST /v1/events -----------------------------------------------------------------------------------

  /**
   * Taken from any inst of the session's, current or not (PROTOCOL.md, Identity): a replaced instance's late events
   * still say what happened. A `seq` not above the last for its inst is a retry, and dropped.
   */
  events(body) {
    const b = isObject(body) ? body : {}
    const s = this.#touchMod(b.sid, b.host)
    if (!s) this.#unplaced('events')
    if (Number.isFinite(b.seq)) {
      // By the inst as a string, as every inst the deck keeps: any other value would be a key the state can't write.
      const inst = str(b.inst)
      const last = s.seq.get(inst) ?? 0
      if (b.seq <= last) {
        this.#log({ kind: 'events', host: s.host, seq: b.seq, dropped: true, say: `${s.host}: events seq ${b.seq} dropped (last ${last})` })
        return
      }
      s.seq.set(inst, b.seq)
    }
    for (const e of Array.isArray(b.events) ? b.events : []) if (isObject(e)) this.#event(s, e)
  }

  #event(s, e) {
    // The engine's agentId, on a subagent's events. One that isn't a non-empty string counts as none: the main
    // loop's (PROTOCOL.md, "Events").
    const agent = str(e.agent)
    const main = agent === null
    switch (e.t) {
      case 'turn.start':
        if (main) {
          // A new turn: the last one's end no longer has the polls answered at once (#afterTurnEnd). When the deck got
          // its start, as a #seenTick, is what status rule 3's turn.start compares the registry's idle with (#status).
          s.turn = { id: str(e.turn), sawEnd: false, lastEnd: null, failed: false, startSeen: ++this.#seenTick, endSeen: null, endedAt: null, endedMono: null }
          this.#clearMainTools(s)
        }
        this.#fpCallsEnded(s, (c) => c.agent === agent)
        break
      case 'turn.end':
        if (main) {
          // Status rule 4, as the deck reads it: a failed marks only its own turn, so a turn.end for another turn
          // reads done. One it can't tell apart, with no turn id on one side or the other, keeps it.
          const id = str(e.turn)
          const same = id === null || s.turn.id === null || id === s.turn.id
          s.turn = {
            id: id ?? s.turn.id, sawEnd: true, lastEnd: str(e.reason), failed: same && s.turn.failed, startSeen: s.turn.startSeen,
            endSeen: ++this.#seenTick, endedAt: this.#now(), endedMono: this.#mono(),
          }
          this.#clearMainTools(s)
        }
        this.#fpCallsEnded(s, (c) => c.agent === agent)
        break
      case 'failed':
        if (main) {
          s.turn.sawEnd = true
          s.turn.failed = true
          s.turn.endedAt = this.#now()
          s.turn.endedMono = this.#mono()
          this.#clearMainTools(s)
        }
        this.#fpCallsEnded(s, (c) => c.agent === agent)
        break
      case 'tool.start':
        if (str(e.use)) {
          s.tools.set(e.use, { tool: str(e.tool), summary: str(e.summary) ?? str(e.tool), fp: str(e.fp), agent, order: ++s.toolOrder })
        }
        this.#fpFromTool(s, e, agent)
        break
      case 'tool.end':
        if (str(e.use)) {
          s.tools.delete(e.use)
          this.#fpCallsEnded(s, (c) => c.use === e.use)
        }
        if (str(e.fp)) this.#releaseByFp(s, e.fp)
        break
      case 'measure':
        if (isObject(e.context) && Number.isFinite(e.context.percent)) s.context = e.context.percent
        break
      case 'settings':
        // Replaces what the deck had, whichever source it came from, a PermissionRequest included.
        for (const k of ['model', 'mode', 'effort']) this.#take(s, k, e[k], 'settings')
        break
      // PROTOCOL.md, "Events", as amended on 2026-11-04 for session keys: only `surface` `desktop`, the app's own, counts.
      // The mods API sends them per client, so another's, a phone's say, or one with no surface, changes nothing: a
      // phone leaving a session would otherwise take it off a desktop that still shows it.
      case 'attach':
        if (e.surface !== DESKTOP_SURFACE) break
        // When the deck got it: `at` is by the mod's clock.
        s.attachAt = this.#now()
        s.onScreen = true
        break
      case 'detach':
        if (e.surface !== DESKTOP_SURFACE) break
        s.onScreen = false
        break
      case 'end':
        s.ended = str(e.reason) ?? 'end'
        break
      default:
        this.#log({ kind: 'event-unknown', host: s.host, t: e.t ?? null, say: `${s.host}: event of unknown type ${display(e.t)} ignored` })
        return
    }
    this.#log({ kind: 'event', host: s.host, event: e })
    if (main && (e.t === 'turn.end' || e.t === 'failed')) this.#turnEnded(s, e.t)
  }

  #clearMainTools(s) {
    for (const [use, t] of s.tools) if (t.agent === null) s.tools.delete(use)
  }

  /** Release rule 1: the mod reports tool.end with the same fp, from the same session. */
  #releaseByFp(s, fp) {
    const h = this.#heldOf(s.host).find((x) => x.fp === fp)
    if (h) this.#release(h, 1, 'tool.end with the same fp')
  }

  // ---- fingerprints --------------------------------------------------------------------------------------
  //
  // Ladder step 4 compares both sides' fingerprints (PROTOCOL.md, "Fingerprints and summaries"): a held request
  // and the mod's tool.start for the same call should carry the same fp and summary. A request pairs with a call
  // of its session's under way with its tool and fp, whichever of the two comes second. One that finds none waits
  // for as long as it's held: its own tool.start may still be on the mod's line, behind a parallel call of the
  // same tool, on an older inst's line after a restart, or from a background subagent whose call outlasts the
  // main loop's turn. Once it ends with none, it's a mismatch only when it can pair only one way: with the one
  // call of its tool that was under way while it was held and paired with nothing, when no other request of its
  // tool waited beside it, the mod didn't restart meanwhile, and no tool.end with its fp released it (its own
  // tool.start never came). Otherwise it can't tell which call was its own: unpaired.

  /** A held request: pairs with a call of its session's under way with its tool and fp, or waits. */
  #fpFromHeld(h, s) {
    h.fpFrom = ++this.#fpTick
    const c = s?.fpCalls.find((x) => x.end === null && x.tool === h.tool && x.fp === h.fp)
    if (!c) {
      this.#fpWaiting.push(h)
      return
    }
    s.fpCalls.splice(s.fpCalls.indexOf(c), 1)
    this.#fpLog(h, c)
  }

  /** A tool.start: pairs with the session's oldest waiting request that has its tool and fp, or waits as a call. */
  #fpFromTool(s, e, agent) {
    const c = { tool: str(e.tool), fp: str(e.fp), summary: str(e.summary), use: str(e.use), agent, start: ++this.#fpTick, end: null }
    const h = this.#fpWaiting.find((x) => x.host === s.host && x.tool === c.tool && x.fp === c.fp)
    if (!h) {
      s.fpCalls.push(c)
      return
    }
    this.#fpWaiting.splice(this.#fpWaiting.indexOf(h), 1)
    this.#fpLog(h, c)
  }

  /** The session's calls under way that `ended(call)` picks have ended: by their tool.end, or with their loop's turn. */
  #fpCallsEnded(s, ended) {
    const tick = ++this.#fpTick
    for (const c of s.fpCalls) if (c.end === null && ended(c)) c.end = tick
    this.#fpPrune(s)
  }

  /** Forgets the session's calls that ended before every waiting request of their tool arrived: none was theirs. */
  #fpPrune(s) {
    const waiting = this.#fpWaiting.filter((h) => h.host === s.host)
    s.fpCalls = s.fpCalls.filter((c) => c.end === null || waiting.some((h) => h.tool === c.tool && h.fpFrom < c.end))
  }

  /**
   * A held request ended (`why` says how, and `rule` is its release rule, if any). If no tool.start has paired
   * with it, none can now: it's a mismatch when it can pair only one way, else unpaired.
   */
  #fpEnded(h, why, rule) {
    const i = this.#fpWaiting.indexOf(h)
    if (i < 0) return
    this.#fpWaiting.splice(i, 1)
    const s = this.#sessions.get(h.host)
    // A session without the plugin has no tool.starts to compare.
    if (!s?.plugin) return
    const calls = s.fpCalls.filter((c) => c.tool === h.tool && (c.end === null || c.end > h.fpFrom))
    const others = this.#fpWaiting.filter((x) => x.host === s.host && x.tool === h.tool)
    // Whichever call was this one's, the others of its tool can no longer be sure it wasn't theirs.
    for (const x of others) x.fpCrowded = true
    const doubt =
      rule === 1 ? 'a tool.end with its fp released it, so its own tool.start never came'
      : h.fpRestarted ? 'the mod restarted while it was held, so its own tool.start may never come'
      : others.length || h.fpCrowded ? 'another request of its tool waited beside it unpaired'
      : calls.length === 0 ? 'no unpaired call of its tool was under way while it was held'
      : calls.length > 1 ? `${calls.length} unpaired calls of its tool were under way while it was held`
      : null
    if (doubt) {
      this.#fpLog(h, null, { why, doubt, calls })
    } else {
      s.fpCalls.splice(s.fpCalls.indexOf(calls[0]), 1)
      this.#fpLog(h, calls[0], { why })
    }
    this.#fpPrune(s)
  }

  /** Logs the comparison: with `c` the call paired with `h`, or with none when it can't tell which was its own. */
  #fpLog(h, c, { why = null, doubt = null, calls = [] } = {}) {
    const base = { kind: 'fp-check', request: h.id, host: h.host, tool: h.tool, bridgeFp: h.fp, bridgeSummary: h.summary, ...(why ? { why } : {}) }
    if (!c) {
      this.#log({
        ...base, match: null, unpaired: true, doubt, modFp: null, modSummary: null, calls: calls.map(({ fp, summary }) => ({ fp, summary })),
        say: `${h.id} fp unpaired (${h.tool}) as it ended (${why}): no tool.start had its fp, and ${doubt}`,
      })
      return
    }
    const match = h.fp === c.fp
    this.#log({
      ...base, match, modFp: c.fp, modSummary: c.summary,
      say: `${h.id} fp ${match ? 'matches' : `differs: bridge ${h.fp}, mod ${c.fp}`} (${h.tool})`,
    })
  }

  // ---- POST /v1/permission -------------------------------------------------------------------------------

  /**
   * A PermissionRequest (PROTOCOL.md, "Permission requests"), taken only from a session the registry confirms
   * ("Desktop sessions only"): any other gets no decision at once. A confirmed one is sorted into its kind, `ask` or
   * `tool`, and held. `responder` is `{open, send(status, json)}`. An `ask` request keeps its tool_input, up to
   * ASK_INPUT_MAX of JSON, for its session's dial (PROTOCOL.md, "Held requests", as amended on 2026-11-04 for session
   * keys); `inputScrubbed` says the bridge took a run of the token out of the tool_input before the deck read it, so
   * it isn't kept: it can't go back as it came. Returns `{kind, id}` for a held request, `{kind: 'unconfirmed'}`.
   */
  permission({ body, hostHeader, responder, inputScrubbed = false }) {
    const b = isObject(body) ? body : {}
    const host = this.#confirmed(hostHeader, b.session_id)
    if (!host) return this.#unconfirmed(b, hostHeader, responder)
    const tool = typeof b.tool_name === 'string' ? b.tool_name : ''
    const input = b.tool_input
    const sid = b.session_id
    const s = this.#session(host)
    // The engine's own mode and effort at this moment: from now on no hello replaces them, until a settings event or a
    // later PermissionRequest does (PROTOCOL.md, "The deck's session model").
    this.#take(s, 'mode', b.permission_mode, 'permission')
    if (isObject(b.effort)) this.#take(s, 'effort', b.effort.level, 'permission')
    const fp = fingerprint(tool, input)
    const sum = summary(tool, input)
    const kind = ASK_TOOLS.includes(tool) ? 'ask' : 'tool'
    // What its session's dial shows for it, and for an ask request the input it echoes back. A tool request's input
    // isn't kept: its dial sends the keys' Allow or Deny, and a Write can carry a whole file.
    const screen = screenOf(kind, tool, input, inputScrubbed)
    const h = {
      id: `p${++this.#heldSeq}`, host, sid, tool, kind, summary: sum, fp,
      arrived: this.#now(), seenWaiting: false, responder,
      screen, input: screen.screen === 'question' || screen.screen === 'plan' ? input : undefined,
    }
    this.#held.push(h)
    this.#heldChanged(host)
    const dial = screen.screen === 'answer-in-app' ? `; its dial shows Answer in app: ${screen.why}` : ''
    this.#log({ kind: 'held', id: h.id, host, sid, tool, requestKind: kind, summary: sum, fp, dial: screen.screen, say: `${h.id} HELD ${kind} ${host} ${tool}: ${sum} fp ${fp}${dial}` })
    this.#fpFromHeld(h, s)
    return { kind, id: h.id }
  }

  /** Release rule 5: the client closed the connection. */
  clientClosed(id) {
    const h = this.#held.find((x) => x.id === id)
    if (!h) return false
    const why = 'the client closed the connection'
    this.#log({ kind: 'release', id, rule: 5, why, say: `${id} released: the client closed it (rule 5)` })
    this.#end(h, 'client-closed', why)
    return true
  }

  /** A held request ended: `end` says how, and `why` in words. It's no longer held, and its fp check ends with it. */
  #end(h, end, why, extra = {}) {
    const i = this.#held.indexOf(h)
    if (i >= 0) this.#held.splice(i, 1)
    this.#heldChanged(h.host)
    this.#recent.push({ id: h.id, host: h.host, tool: h.tool, kind: h.kind, summary: h.summary, end, ...extra, heldMs: this.#now() - h.arrived })
    if (this.#recent.length > RECENT_KEPT) this.#recent.shift()
    this.#fpEnded(h, why, extra.rule)
  }

  /** Answers a held request with no decision, by release rule `rule`. */
  #release(h, rule, why) {
    const sent = h.responder.open
    if (sent) h.responder.send(200, answerFor('none'))
    this.#log({ kind: 'release', id: h.id, rule, why, sent, say: `${h.id} released with {}: ${why} (rule ${rule})` })
    this.#end(h, sent ? 'released' : 'gone', why, { rule })
  }

  /** Answers a held request: allow, deny or none. False when its client had already gone. */
  #answerHeld(h, decision, by) {
    return this.#answerWith(h, answerFor(decision), decision, by)
  }

  /**
   * Answers a held request with `body`, one of PROTOCOL.md's five: `what` names it ('allow', 'deny', 'none', 'answer'
   * or 'approve plan'), `by` says who ('press', a key; 'dial', its session's dial; 'control', the control route), and
   * `extra` goes in the log and the request's end: an Answer's `answers`, an Approve plan's `mode`. False when its
   * client had already gone.
   */
  #answerWith(h, body, what, by, extra = {}) {
    const sent = h.responder.open
    if (sent) h.responder.send(200, body)
    const mode = extra.mode ? ` into ${extra.mode}` : ''
    this.#log({ kind: 'answered', id: h.id, decision: what, by, sent, ...extra, say: `${h.id} ${sent ? what : `gone before its ${what}`}${mode} (${by})` })
    const from = by === 'press' ? 'a press' : by === 'dial' ? "its session's dial" : 'the control route'
    this.#end(h, sent ? 'answered' : 'gone', `answered ${what}${mode} by ${from}`, { decision: what, by, ...extra })
    return sent
  }

  // ---- GET /v1/next and POST /v1/result -------------------------------------------------------------------

  /**
   * A long poll (PROTOCOL.md, "Commands"). For a session with no current instance, 409 hello first at once.
   * Otherwise it answers at once with what's queued, else holds up to `wait` seconds. A new poll answers the session's
   * older one with no commands, and so does the end of the main loop's turn (#turnEnded). From that turn end, while
   * the registry still says busy, it answers at once with what's queued or nothing (#afterTurnEnd). `responder` is a
   * permission request's, with `cut()` too, which drops the connection with no answer (reset). Returns the poll's id,
   * or null when the poll names no session the bridge can place.
   */
  poll({ sid, host, inst, wait, responder }) {
    const s = this.#touchMod(sid, host)
    if (!s) return null
    const id = ++this.#pollSeq
    if (s.inst === null) {
      // PROTOCOL.md, Identity: a session with no current instance asks for one, whatever the poll's inst. That's
      // after a reset, the deck's restart, after release rule 4 forgot the session, or once its current instance went
      // IN_FLIGHT_MS with no poll open (#instanceQuiet). The mod takes the 409 as a rejected fetch: it says hello about
      // 100 ms later, and polls again. A mod that had no request open then, waiting out its second after a poll answered
      // at once, would otherwise have nothing fail to tell it so, and poll on unheard; and after a deck restart, a live
      // mod whose lingering predecessor's hello landed last would have its polls answered at once for good. The 409
      // never goes to a session with a current instance, so it never displaces one.
      responder.send(409, { error: HELLO_FIRST })
      this.#log({
        kind: 'poll-hello-first', host: s.host, poll: id, inst: str(inst),
        // Once the current instance stops polling, the deck still remembers it: the newest it made current.
        say: `${s.host}: poll from inst ${str(inst) ?? '(none)'} answered 409 hello first: ${s.insts.size > 0 ? `no instance has said hello since ${[...s.insts].at(-1)}, which was current, stopped polling` : 'no instance has said hello for the session'}`,
      })
      return id
    }
    if (str(inst) !== s.inst) {
      // PROTOCOL.md, Identity: only a hello makes an inst current. A poll from any other inst, one replaced since or
      // one that hasn't said hello to this deck (a replaced instance's late poll after a deck restart, say), is
      // answered at once with no commands. It never takes the current one's place or a command, nor does it show
      // that the session's mod is there for a waiting prompt's clock.
      responder.send(200, { cmds: [] })
      this.#log({ kind: 'poll-stale', host: s.host, poll: id, inst: str(inst), current: s.inst })
      return id
    }
    if (s.poll) {
      const old = s.poll.id
      this.#endPoll(s, [])
      this.#log({ kind: 'poll-superseded', host: s.host, poll: old })
    }
    const queued = [...this.#commands.values()].filter((c) => c.host === s.host && c.state === 'queued')
    const afterTurnEnd = this.#afterTurnEnd(s)
    if (queued.length || wait === 0 || afterTurnEnd) {
      // Answered at once: the mod is there, but the session has no open poll again.
      this.#deliver(queued, s)
      responder.send(200, { cmds: queued.map(wire) })
      s.pollEndedAt = this.#mono()
      this.#armPollGap(s)
      if (afterTurnEnd) this.#log({ kind: 'poll-at-once', host: s.host, poll: id, cmds: queued.map((c) => c.id), sinceTurnEndMs: this.#mono() - s.turn.endedMono })
      return id
    }
    const p = { id, responder, inst: s.inst, since: this.#mono(), timer: null }
    p.timer = this.#setTimer(() => {
      if (s.poll === p) this.#endPoll(s, [])
    }, wait * 1000)
    s.poll = p
    s.pollEndedAt = null
    this.#armPollGap(s)
    return id
  }

  pollClosed(id) {
    for (const s of this.#sessions.values()) {
      if (s.poll?.id === id) {
        this.#endPoll(s)
        return true
      }
    }
    return false
  }

  /**
   * PROTOCOL.md, "Commands": the mod reported that the main loop's turn ended, a turn.end or failed without
   * `agent`, so the session's open poll is answered with no commands at once. Claude Code keeps a session busy in
   * the registry until a moment after the turn when the mod has no request open, so a poll held past the turn's end
   * kept the deck showing working for up to 20 s more (Phase 4). The mod polls again, and from now on its polls are
   * answered at once while the registry still says busy (#afterTurnEnd). With no poll open there's nothing to
   * answer: a waiting prompt's time without one still runs from when the last one ended. The report may come from an
   * inst that isn't current, whose events still count: the session's turn has ended all the same, so the poll it
   * answers is the current instance's.
   */
  #turnEnded(s, t) {
    const p = s.poll
    if (!p) return
    this.#endPoll(s, [])
    this.#log({ kind: 'poll-turn-end', host: s.host, poll: p.id, by: t })
  }

  /**
   * PROTOCOL.md, "Commands": after the main loop's turn end answers the open poll, the session's polls are answered
   * at once, with the commands queued for it or none, until the registry stops saying busy, a main-loop turn.start
   * comes, or 60 s pass. A poll the mod opened while its last events were still on its line, a measure after the
   * turn.end say, would otherwise keep the session busy until its wait ran out (Phase 4); answered at once, the mod
   * waits out the rest of its second before the next, and that moment with no request open lets Claude Code turn the
   * session idle. Judged as each poll arrives, by the bridge's latest registry reading and its monotonic clock, as
   * the deck's: a session the registry doesn't list, or lists as anything but busy, has its polls held as usual,
   * and every main-loop turn.end or failed starts the 60 s again. The wall clock plays no part, so neither a time
   * sync nor a fixture runner's clock that follows the registry's times can end the 60 s early or draw them out.
   */
  #afterTurnEnd(s) {
    const at = s.turn.endedMono
    return at !== null && this.#mono() - at < AT_ONCE_MS && this.#registry.get(s.host)?.status === 'busy'
  }

  /** Ends the session's open poll: answered with `cmds` if they're given and its client is still there. */
  #endPoll(s, cmds) {
    const p = s.poll
    if (!p) return
    s.poll = null
    this.#clearTimer(p.timer)
    if (cmds && p.responder.open) p.responder.send(200, { cmds })
    s.pollEndedAt = this.#mono()
    this.#armPollGap(s)
  }

  /**
   * A session's time without an open poll, on the monotonic clock, as the deck times it. A live mod always keeps one
   * open, and a poll answered at once counts as one sent; a poll from an inst that isn't current doesn't count. Once
   * the session has gone IN_FLIGHT_MS without one, from when its last poll ended or a hello made its instance current:
   * - PROTOCOL.md, "Commands": its waiting prompts fail with "no result". A waiting prompt has no 60 s clock of its
   *   own, since the engine holds it until the turn ends (S3).
   * - PROTOCOL.md, Identity, as amended on 2026-11-03 for Phase 6: its current instance stops counting
   *   (#instanceQuiet). A lingering predecessor whose hello landed last after a deck restart is made current, and then
   *   never polls; the live mod's polls, answered at once as an older instance's, don't count. No command delivered to
   *   it outlives this: each delivery ended a poll, so its own 60 s end by now, and every waiting prompt fails now.
   * Called whenever the session's poll, its current instance or its waiting prompts change.
   */
  #armPollGap(s) {
    this.#clearTimer(s.gapTimer)
    s.gapTimer = null
    if (s.poll) return
    const waiting = () => [...this.#commands.values()].filter((c) => c.host === s.host && c.t === 'prompt' && c.state === 'waiting')
    if (s.inst === null && !waiting().length) return
    const expire = () => {
      s.gapTimer = null
      for (const c of waiting()) this.#finish(c, 'failed', { error: 'no result' })
      if (s.inst !== null) this.#instanceQuiet(s)
    }
    const left = (s.pollEndedAt ?? this.#mono()) + this.#inFlightMs - this.#mono()
    if (left <= 0) expire()
    else s.gapTimer = this.#setTimer(expire, left)
  }

  /**
   * PROTOCOL.md, Identity, as amended on 2026-11-03 for Phase 6, round 4: a current instance that has gone
   * IN_FLIGHT_MS with no poll open and none sent stops counting, and that's all. The deck keeps the rest: which
   * instances have said hello, settings and where each came from, held requests, commands, the seqs it has seen, and
   * the main loop's turn, so how it ended still shows and the polls after its end are still answered at once. With no
   * current instance, a prompt press on the session alerts (#cannotSend), while Approve and Deny still answer
   * its held requests (press), as in the real deck. Its mods' polls get 409 hello first (poll), and the first hello
   * after, from any instance, makes that one current, with no restart (hello). From then on the others don't count
   * again: a live predecessor's later hello, after one of its fetches rejects say, changes nothing, where forgetting
   * them made it a restart over the live mod (round 3's review).
   */
  #instanceQuiet(s) {
    const was = s.inst
    const quietMs = s.pollEndedAt === null ? null : this.#mono() - s.pollEndedAt
    s.inst = null
    this.#log({
      kind: 'inst-quiet', host: s.host, inst: was, quietMs,
      say: `${s.host}: inst ${was} has had no poll open for ${this.#inFlightMs / 1000} s, so it no longer counts: the mod's next poll gets 409 hello first, and the next hello, from any instance that said hello before or a new one, makes its own current`,
    })
  }

  #deliver(cmds, s) {
    for (const c of cmds) {
      this.#clearTimer(c.timer)
      c.state = 'delivered'
      c.deliveredAt = this.#now()
      c.inst = s.inst
      c.timer = this.#setTimer(() => {
        if (IN_FLIGHT.has(c.state)) this.#finish(c, 'failed', { error: 'no result' })
      }, this.#inFlightMs)
      this.#log({ kind: 'command', id: c.id, host: c.host, state: 'delivered', inst: s.inst, say: `${c.id} delivered to ${c.host} (inst ${s.inst})` })
    }
  }

  #finish(c, state, { error = null } = {}) {
    this.#clearTimer(c.timer)
    c.timer = null
    c.state = state
    c.error = error
    c.finishedAt = this.#now()
    this.#log({ kind: 'command', id: c.id, host: c.host, state, error, say: `${c.id} ${state}${error ? `: ${error}` : ''}` })
  }

  /**
   * How a command went (PROTOCOL.md, "Commands"). One for an unknown or finished command, from another session, or
   * from an inst other than the one its command was delivered to is ignored: a result with no inst included, as it
   * can't be from that inst. A prompt's `waiting` stops its 60 s clock (see #armPollGap).
   */
  result(body) {
    const b = isObject(body) ? body : {}
    const s = this.#touchMod(b.sid, b.host)
    if (!s) this.#unplaced('result')
    const c = typeof b.id === 'string' ? this.#commands.get(b.id) : undefined
    const id = typeof b.id === 'string' ? b.id : b.id === undefined ? '?' : display(b.id)
    const ignore = (why) => this.#log({ kind: 'result-ignored', id: b.id ?? null, state: b.state ?? null, why, say: `result for ${id} ignored: ${why}` })
    if (!c) return ignore('unknown command')
    if (FINAL.has(c.state)) return ignore(`already ${c.state}`)
    if (c.state === 'queued') return ignore('not delivered yet')
    if (s.host !== c.host) return ignore(`it was for ${c.host}`)
    if (str(b.inst) === null || b.inst !== c.inst) return ignore(`it came from inst ${b.inst === undefined ? '(none)' : display(b.inst)}, and was delivered to ${c.inst}`)
    if (b.state === 'waiting') {
      c.state = 'waiting'
      this.#clearTimer(c.timer)
      c.timer = null
      this.#log({ kind: 'command', id: c.id, host: c.host, state: 'waiting', say: `${c.id} waiting` })
      this.#armPollGap(s)
      return
    }
    if (!FINAL.has(b.state)) return ignore(`unknown state ${display(b.state)}`)
    this.#finish(c, b.state, { error: asString(b.error) })
    this.#armPollGap(s)
  }

  // ---- presses -------------------------------------------------------------------------------------------

  #pressed(p) {
    this.#lastPress = { at: this.#now(), alert: false, jumped: null, ...p }
    const answered = p.answered ? `${p.answered}${p.mode ? ` into ${p.mode}` : ''} ${p.request}` : ''
    const what = p.alert ? `ALERT: ${p.error}` : p.jumped ? `jumps to ${p.jumped}${p.why ? ` (Answer in app: ${p.why})` : ''}` : p.answered ? answered : p.cmd ? `queued ${p.cmd}` : ''
    this.#log({ kind: 'press', ...this.#lastPress, say: `press ${p.key}${p.session ? ` ${p.session}` : ''}: ${what}` })
    return { ok: !p.alert, ...this.#lastPress }
  }

  /**
   * Approve or Deny (PROTOCOL.md, "Held requests"): acts on the oldest held request across sessions. `shown`
   * is the request the key showed when pressed: undefined skips the check, null means it showed none. A
   * `tool` request gets Allow or Deny; on an `ask` request either press jumps and answers nothing. Whether the
   * request's session has a current instance doesn't matter, as in the real deck: only a prompt press needs one
   * (#cannotSend).
   */
  press(key, { shown } = {}) {
    if (key !== 'approve' && key !== 'deny') throw new BadRequest(`no key ${key}`)
    const h = this.#held[0]
    if (!h) return this.#pressed({ key, alert: true, error: 'nothing is held' })
    if (shown !== undefined && shown !== h.id) return this.#pressed({ key, alert: true, error: `the key showed ${shown ?? 'nothing'}; the oldest is ${h.id}` })
    if (!h.responder.open) {
      this.#end(h, 'gone', 'its client had gone')
      return this.#pressed({ key, alert: true, error: `${h.id} had gone` })
    }
    if (h.kind === 'ask') return this.#pressed({ key, request: h.id, jumped: h.host })
    const decision = key === 'approve' ? 'allow' : 'deny'
    this.#answerHeld(h, decision, 'press')
    return this.#pressed({ key, request: h.id, answered: decision })
  }

  /**
   * A Session Slot dial's press (PROTOCOL.md, "Held requests", as amended on 2026-11-04 for session keys), for the
   * request its strip showed last: its session's oldest held request, of any kind. One of
   * - `decision`, allow or deny, for a tool request: the keys' own Allow or Deny;
   * - `picks`, the labels picked for each question by its text, for an AskUserQuestion: the Answer (answersFrom);
   * - `plan`, for an ExitPlanMode: an Approve plan into auto, acceptEdits or default, or `reject`, the keys' Deny,
   *   which stops the turn, so the user says in the app what to change.
   * An ask request whose tool_input the deck didn't keep or can't read shows "Answer in app": any press on it jumps to
   * its session and answers nothing. `shown` is the id of the request the strip showed, as a key's: undefined for the
   * one it showed last, null for none.
   *
   * The keys and the dials answer the same requests, and the first answer wins: a press for a request that has gone,
   * answered by a key or another press, or released, alerts and sends nothing while nothing newer is on the strip, and
   * so does one its strip doesn't take, a decision for a question say, or picks that aren't the question's options.
   * Once the session's next request is held, the strip shows it, and a press acts on that one (dial-next). The deck's
   * 1 s before a press counts, and its 300 ms before a choice does, are off here, as the fixtures' runners turn them
   * off: a press on the control route is a deliberate press on what the strip shows. Whether the session has a current
   * instance doesn't matter, as for Approve and Deny. The fake has no slots: a dial is named by its session.
   */
  dial({ host, picks, decision, plan, shown } = {}) {
    if (typeof host !== 'string' || host === '') throw new BadRequest('host must be a session host (local_…)')
    const given = [['picks', picks], ['decision', decision], ['plan', plan]].filter(([, v]) => v !== undefined).map(([k]) => k)
    if (given.length !== 1) throw new BadRequest(`a dial press has one of picks, decision and plan; got ${given.join(', ') || 'none'}`)
    if (decision !== undefined && decision !== 'allow' && decision !== 'deny') throw new BadRequest('decision must be allow or deny')
    if (plan !== undefined && !DIAL_PLANS.includes(plan)) throw new BadRequest(`plan must be one of ${DIAL_PLANS.join(', ')}`)
    if (picks !== undefined && (!isObject(picks) || !Object.values(picks).every((v) => Array.isArray(v) && v.every((l) => typeof l === 'string')))) {
      throw new BadRequest("picks maps each question's text to a list of the labels picked for it")
    }
    if (shown !== undefined && shown !== null && typeof shown !== 'string') throw new BadRequest('shown must be the id of a request (p3), or null')
    const press = { key: 'dial', session: host }
    const alert = (error, request) => this.#pressed({ ...press, ...(request ? { request } : {}), alert: true, error })
    const target = shown === undefined ? (this.#dialShown.get(host) ?? null) : shown
    if (target === null) return alert(`${host}'s dial has shown no request`)
    const h = this.#held.find((x) => x.id === target)
    if (!h) {
      const ended = this.#recent.findLast((x) => x.id === target)
      return alert(ended ? `${target}, the request the dial showed, has gone (${ended.end})` : `no request ${target}`, target)
    }
    if (h.host !== host) return alert(`${h.id} is ${h.host}'s request, not ${host}'s`, h.id)
    const oldest = this.#heldOf(host)[0]
    if (oldest !== h) return alert(`the dial showed ${h.id}; ${host}'s oldest held request is ${oldest.id}`, h.id)
    if (!h.responder.open) {
      this.#end(h, 'gone', 'its client had gone')
      return alert(`${h.id} had gone`, h.id)
    }
    const { screen } = h.screen
    if (screen === 'answer-in-app') return this.#pressed({ ...press, request: h.id, jumped: host, why: h.screen.why })
    if (screen === 'approval') {
      if (decision === undefined) return alert(`${h.id} is an approval for ${h.tool}: its dial allows or denies it`, h.id)
      this.#answerWith(h, answerFor(decision), decision, 'dial')
      return this.#pressed({ ...press, request: h.id, answered: decision })
    }
    if (screen === 'question') {
      if (picks === undefined) return alert(`${h.id} is a question: its dial answers it with picks`, h.id)
      const r = answersFrom(h.screen.questions, picks)
      if (r.error) return alert(r.error, h.id)
      this.#answerWith(h, answerBody(h.input, r.answers), 'answer', 'dial', { answers: r.answers })
      return this.#pressed({ ...press, request: h.id, answered: 'answer', answers: r.answers })
    }
    if (plan === undefined) return alert(`${h.id} is a plan: its dial approves it into a mode, or rejects it`, h.id)
    if (plan === 'reject') {
      this.#answerWith(h, DENY, 'deny', 'dial')
      return this.#pressed({ ...press, request: h.id, answered: 'deny' })
    }
    this.#answerWith(h, approvePlanBody(h.input, plan), 'approve plan', 'dial', { mode: plan })
    return this.#pressed({ ...press, request: h.id, answered: 'approve plan', mode: plan })
  }

  /**
   * Why the deck can't send to `host`: it isn't listed, nothing has come from its mod, or its mod has no current
   * instance (PROTOCOL.md, "Commands"): none has said hello to this deck, or the last one current stopped polling. A
   * command queued then would wait for a poll that only the current instance's can take, and fail "not delivered" a
   * minute later: the real deck alerts instead.
   */
  #cannotSend(host) {
    if (!this.#registry.has(host)) return `${host} isn't running: the registry doesn't list it`
    const s = this.#sessions.get(host)
    if (!s?.plugin) return `${host} has no plugin: nothing has come from its mod`
    if (s.inst !== null) return null
    // Once the current instance stops polling, the deck still remembers it: the newest it made current.
    const last = [...s.insts].at(-1)
    if (last === undefined) return `${host} has no current instance: no instance of its mod has said hello to this deck, so it can't take commands until one does`
    return `${host} has no current instance: its last, ${last}, has had no poll open for ${this.#inFlightMs / 1000} s, so it can't take commands until an instance of its mod says hello again`
  }

  /**
   * A Saved Prompt key, known by its text: queues a prompt for `host`. PROTOCOL.md, "Commands": while the
   * last prompt the key queued is still queued, delivered or waiting, another press alerts and queues nothing.
   */
  prompt({ host, text }) {
    if (typeof host !== 'string' || host === '') throw new BadRequest('host must be a session host (local_…)')
    if (typeof text !== 'string' || text === '') throw new BadRequest('text must be a non-empty string')
    const last = this.#commands.get(this.#promptKeys.get(text))
    if (last && !FINAL.has(last.state)) {
      return this.#pressed({ key: 'prompt', session: host, alert: true, error: `the key's last prompt, ${last.id} for ${last.host}, is still ${last.state}` })
    }
    const why = this.#cannotSend(host)
    if (why) return this.#pressed({ key: 'prompt', session: host, alert: true, error: why })
    const c = this.#queue(host, { t: 'prompt', text })
    this.#promptKeys.set(text, c.id)
    return this.#pressed({ key: 'prompt', session: host, cmd: c.id })
  }

  #queue(host, fields) {
    const c = {
      id: `${this.#cmdPrefix}${++this.#cmdSeq}`, host, ...fields, state: 'queued', queuedAt: this.#now(),
      deliveredAt: null, finishedAt: null, inst: null, error: null, timer: null,
    }
    this.#commands.set(c.id, c)
    // PROTOCOL.md, "Commands": one that no poll takes in time fails, so a key waiting on it can't stay locked.
    c.timer = this.#setTimer(() => {
      if (c.state === 'queued') this.#finish(c, 'failed', { error: 'not delivered' })
    }, this.#inFlightMs)
    this.#log({ kind: 'command', id: c.id, host, state: 'queued', t: c.t, say: `${c.id} queued for ${host}: ${c.t} ${JSON.stringify(c.text)}` })
    const s = this.#sessions.get(host)
    if (s?.poll && s.poll.responder.open) {
      this.#deliver([c], s)
      this.#endPoll(s, [wire(c)])
    }
    return c
  }

  /**
   * The control interface's own answer to one `tool` request, by id: allow, deny or none. An ask request is
   * refused: only its session's Session Slot dial answers one (dial), with a body made for it, and a key press on it
   * jumps to its session.
   */
  answer({ id, decision }) {
    if (!['allow', 'deny', 'none'].includes(decision)) throw new BadRequest('decision must be allow, deny or none')
    const h = this.#held.find((x) => x.id === id)
    if (!h) {
      const r = this.#recent.findLast((x) => x.id === id)
      return { ok: false, id, error: r ? `${id} already ended (${r.end})` : `no request ${id}` }
    }
    if (h.kind === 'ask') {
      throw new BadRequest(`${id} is an ask request (${h.tool}), which only ${h.host}'s Session Slot dial answers: use dial (POST /control/dial); a key press on it jumps to ${h.host}, and the user answers in the app`)
    }
    const sent = this.#answerHeld(h, decision, 'control')
    const out = { ok: sent, id, decision, kind: h.kind }
    if (!sent) out.error = `${id} had gone`
    return out
  }

  // ---- the registry and the app's records -----------------------------------------------------------------

  /** The hosts the deck lists: registry entries with a hostSessionId, which Code-tab sessions have. */
  get listed() {
    return [...this.#registry.keys()]
  }

  /**
   * A new reading of the registry: the kept fields of every file. Applies release rules 2 to 4, and notes when
   * each session's current status was read, for status rule 3.
   *
   * Two files can list one host: a restarted process whose old file lingers beside its new one. Every file counts for
   * confirming a hook's request or a hello (#listed), so either's sessionId does. What the deck shows, and every rule
   * below, goes by one file per host: the one that started later (showsOver), as in the real deck. A session ends,
   * release rule 4, only when no file lists its host.
   *
   * Release rules 2 and 3 are judged by what the bridge itself saw, as PROTOCOL.md lets a fake bridge. Release
   * rule 2's "held from before that change": the request was held when a reading showed the session `waiting`.
   * Release rule 3: a reading shows the session `idle` and the one before showed it otherwise, so the change came
   * after every request held now arrived. A request is held only for a session the registry confirmed as it came
   * ("Desktop sessions only"), so the reading that releases it is never the session's first. Status rule 3 is
   * judged by what the bridge saw too: a `busy` began before the main loop's last turn.end, and an `idle` before its
   * latest turn.start, when the reading where the session's `status` or `statusUpdatedAt` last changed, or its first,
   * came before the bridge got that turn.end or turn.start (#status). So a rewritten `statusUpdatedAt` is a new
   * status, as it would be by the times, and a new `name` or a missing `statusUpdatedAt` isn't. Comparing arrivals
   * with `statusUpdatedAt` instead would mix the bridge's clock with the registry's, which differ in the fixtures
   * (their times are made up).
   */
  applyRegistry(entries) {
    const next = new Map()
    const listed = new Map()
    const bySid = new Map()
    for (const f of entries) {
      const host = hostValue(f.hostSessionId)
      if (!host) continue
      const other = next.get(host)
      if (!other || showsOver(f, other)) next.set(host, f)
      const sids = listed.get(host) ?? new Set()
      listed.set(host, sids)
      if (str(f.sessionId)) sids.add(f.sessionId)
    }
    // A mod's request with no host is placed only by a shown file's sessionId, as the real deck's #hostForSid looks
    // only at the files it shows; of two shown files that list one sessionId, by the first read.
    for (const [host, f] of next) if (str(f.sessionId) && !bySid.has(f.sessionId)) bySid.set(f.sessionId, host)
    const prev = this.#registry
    this.#registry = next
    this.#listed = listed
    this.#registryBySid = bySid
    // Status rule 3: each session's current status was read now, unless the last reading showed the same status
    // and statusUpdatedAt. One that went missing is no change, as the real deck then takes the busy's first reading.
    const tick = ++this.#seenTick
    const seen = new Map()
    for (const [host, f] of next) {
      const p = prev.get(host)
      const same = p !== undefined && p.status === f.status && (statusAt(f) === null || statusAt(p) === statusAt(f))
      seen.set(host, same ? this.#statusSeen.get(host) : tick)
    }
    this.#statusSeen = seen

    for (const [host, f] of next) {
      const p = prev.get(host)
      if (!p) this.#log({ kind: 'registry', change: 'added', host, fields: f, say: `registry + ${host} ${f.status ?? '?'} ${JSON.stringify(f.name ?? '')}` })
      else if (JSON.stringify(p) !== JSON.stringify(f)) this.#log({ kind: 'registry', change: 'changed', host, from: p, to: f, say: `registry ~ ${host} ${p.status ?? '?'} → ${f.status ?? '?'}` })
    }
    for (const [host, p] of prev) {
      if (next.has(host)) continue
      this.#log({ kind: 'registry', change: 'removed', host, last: p, say: `registry - ${host}` })
      for (const h of this.#heldOf(host)) this.#release(h, 4, 'no registry file lists the session\'s host any more')
      this.#sessionEnded(host)
    }
    for (const [host, f] of next) {
      if (prev.get(host)?.status === 'waiting' && f.status !== 'waiting') {
        const mine = this.#heldOf(host)
        if (mine.length === 1 && mine[0].seenWaiting) this.#release(mine[0], 2, 'the registry shows the session leaving waiting')
      }
    }
    for (const [host, f] of next) {
      const before = prev.get(host)
      if (f.status !== 'idle' || !before || before.status === 'idle') continue
      for (const h of this.#heldOf(host)) this.#release(h, 3, 'the registry shows the session turning idle since it arrived')
    }
    for (const [host, f] of next) {
      if (f.status === 'waiting') for (const h of this.#heldOf(host)) h.seenWaiting = true
    }
    // PROTOCOL.md, "Commands": a reading that turns busy within the 60 s after the main loop's turn end answers the
    // poll held before it did, after a turn shorter than a scan or while the reading still said waiting after a Deny,
    // as that poll would have been answered at once had it come now (#afterTurnEnd).
    for (const [host, f] of next) {
      if (f.status !== 'busy' || prev.get(host)?.status === 'busy') continue
      const s = this.#sessions.get(host)
      if (!s?.poll || !this.#afterTurnEnd(s)) continue
      const p = s.poll
      this.#endPoll(s, [])
      this.#log({ kind: 'poll-turn-end', host, poll: p.id, by: 'busy' })
    }
  }

  /**
   * The rest of release rule 4: the session's commands fail with "the session ended", queued ones included,
   * its open poll gets no commands, and the bridge forgets what it knew of the session, its current instance
   * included. Should the session go on, its file missing from one reading say, its mod's next poll gets 409 hello
   * first (poll), and its hello makes it current again.
   */
  #sessionEnded(host) {
    for (const c of this.#commands.values()) {
      if (c.host === host && !FINAL.has(c.state)) this.#finish(c, 'failed', { error: 'the session ended' })
    }
    const s = this.#sessions.get(host)
    if (!s) return
    this.#endPoll(s, [])
    this.#clearTimer(s.gapTimer)
    this.#sessions.delete(host)
  }

  /** A host's record, read when the session appeared or its file changed; null when it has none. */
  applyRecord(host, record) {
    if (record) this.#records.set(host, record)
    else this.#records.delete(host)
  }

  // ---- views ---------------------------------------------------------------------------------------------

  /** PROTOCOL.md, "The deck's session model": the first status that applies. */
  #status(host) {
    const held = this.#heldOf(host)
    if (held.some((h) => h.kind === 'tool')) return 'approval'
    if (held.some((h) => h.kind === 'ask')) return 'needs-you'
    const reg = this.#registry.get(host)?.status
    if (reg === 'waiting') return 'needs-you'
    const s = this.#sessions.get(host)
    // Rule 3's busy doesn't count when the deck read it before it got the main loop's last turn.end, and that turn
    // ended `aborted` (applyRegistry): the rules after it take the session as idle.
    const stale = reg === 'busy' && s?.turn.lastEnd === 'aborted' && this.#statusSeen.get(host) < s.turn.endSeen
    if (reg === 'busy' && !stale) return 'working'
    // Rule 3's turn.start: the main loop's latest turn has started and not ended, a turn.end or a failed, and the deck
    // read the registry's idle before it got that turn.start. Claude Code writes busy a moment into the turn, and the
    // deck reads the registry once a second. An idle read since, a new one by its status or statusUpdatedAt, means the
    // turn ended unseen: it doesn't count.
    if (reg === 'idle' && s && s.turn.startSeen !== null && !s.turn.sawEnd && this.#statusSeen.get(host) < s.turn.startSeen) return 'working'
    if (reg === 'idle' || reg === undefined || stale) {
      if (s?.turn.failed) return 'failed'
      if (s?.turn.lastEnd === 'aborted') return 'interrupted'
      // Rule 6: the app's own needs-input indicator would show for the record (registry.mjs, needsInput).
      if (this.#records.get(host)?.needsUser) return 'needs-you'
      if (s?.turn.sawEnd) return 'done'
    }
    return 'idle'
  }

  /** The summary of the main loop's latest unfinished tool.start. */
  #doing(host) {
    const s = this.#sessions.get(host)
    if (!s) return null
    let latest = null
    for (const t of s.tools.values()) if (t.agent === null && (latest === null || t.order > latest.order)) latest = t
    return latest?.summary ?? null
  }

  /** The latest from the plugin; with none, the app's record. */
  #settings(host) {
    const s = this.#sessions.get(host)?.settings ?? {}
    const r = this.#records.get(host) ?? {}
    return { model: s.model ?? r.model ?? null, effort: s.effort ?? r.effort ?? null, mode: s.mode ?? r.permissionMode ?? null }
  }

  /**
   * With no dial to pick one, the target is the session most recently on screen in the app: for each, the
   * later of its latest desktop attach, by when the deck got it, and its record's lastFocusedAt.
   */
  #target(hosts) {
    let best = null
    for (const host of hosts) {
      const times = [this.#sessions.get(host)?.attachAt, this.#records.get(host)?.lastFocusedAt].filter(Number.isFinite)
      if (!times.length) continue
      const at = Math.max(...times)
      if (best === null || at > best.at) best = { host, at }
    }
    return best?.host ?? null
  }

  /** What the deck shows, in the shape of the fixtures' `expect` lines (PROTOCOL.md, "Fixtures"). */
  view() {
    const listed = this.listed
    const hosts = new Set(listed)
    for (const host of this.#sessions.keys()) hosts.add(host)
    for (const h of this.#held) hosts.add(h.host)
    const status = {}
    const doing = {}
    const context = {}
    const settings = {}
    for (const host of hosts) {
      status[host] = this.#status(host)
      doing[host] = this.#doing(host)
      context[host] = this.#sessions.get(host)?.context ?? null
      settings[host] = this.#settings(host)
    }
    const now = this.#now()
    return {
      sessions: listed,
      // `dial`: what its session's dial strip shows for it, once it's the session's oldest (screenOf).
      held: this.#held.map((h) => ({ id: h.id, host: h.host, tool: h.tool, kind: h.kind, summary: h.summary, fp: h.fp, ageMs: now - h.arrived, dial: h.screen })),
      status,
      doing,
      context,
      settings,
      cmds: Object.fromEntries([...this.#commands.values()].map((c) => [c.id, c.state])),
      jumped: this.#lastPress?.jumped ?? null,
      alert: this.#lastPress?.alert ?? false,
      target: this.#target(listed),
    }
  }

  /** Everything, for `state` and for reading a run by eye. */
  state() {
    const now = this.#now()
    const sessions = {}
    for (const [host, s] of this.#sessions) {
      sessions[host] = {
        sid: s.sid, inst: s.inst, insts: [...s.insts], plugin: s.plugin, hello: s.hello, lastSeq: Object.fromEntries(s.seq),
        tools: [...s.tools].map(([use, t]) => ({ use, tool: t.tool, summary: t.summary, fp: t.fp, agent: t.agent })),
        turn: s.turn, statusSeen: this.#statusSeen.get(host) ?? null, context: s.context, settings: s.settings, settingsFrom: s.settingsFrom, onScreen: s.onScreen, attachAt: s.attachAt, ended: s.ended,
        poll: s.poll ? { id: s.poll.id, inst: s.poll.inst, openMs: this.#mono() - s.poll.since } : null,
        // How long the session has gone without an open poll, which a current instance may for less than IN_FLIGHT_MS.
        noPollMs: s.poll || s.pollEndedAt === null ? null : this.#mono() - s.pollEndedAt,
        lastSeenMs: s.lastSeen === null ? null : now - s.lastSeen,
      }
    }
    return {
      deck: this.view(),
      sessions,
      registry: Object.fromEntries(this.#registry),
      records: Object.fromEntries(this.#records),
      commands: [...this.#commands.values()].map(({ timer, ...c }) => c),
      recent: this.#recent,
      lastPress: this.#lastPress,
      // host → the request its Session Slot dial showed last, which a dial press with no id is for.
      dials: Object.fromEntries(this.#dialShown),
    }
  }

  // ---- reset and close ------------------------------------------------------------------------------------

  /**
   * Forgets everything but the id counters (command ids stay unique for the bridge's run). Held requests get no
   * decision, so the app's dialogs decide.
   *
   * A reset is the deck restarting while the bridge goes on serving. It cuts each open poll off with no answer
   * (`responder.cut()`), as a deck that restarts drops it: the mod's fetch fails, and it says hello about 100 ms later
   * ("Failure and recovery"). It forgets every inst that said hello, and only a hello makes one current again
   * (PROTOCOL.md, Identity), so a mod that had no poll open, waiting out its second after a poll answered at once,
   * hears 409 hello first at its next poll (poll), and says hello then. At shutdown (`why` 'shutdown') open polls are
   * answered with no commands: the bridge stops listening, so the mod's next request fails all the same.
   */
  reset(why = 'reset') {
    const what = `the bridge was ${why === 'reset' ? 'reset' : 'shut down'}`
    for (const h of [...this.#held]) this.#release(h, why, what)
    for (const s of this.#sessions.values()) {
      this.#clearTimer(s.gapTimer)
      const p = s.poll
      if (!p) continue
      this.#clearTimer(p.timer)
      s.poll = null
      if (!p.responder.open) continue
      if (why !== 'reset') {
        p.responder.send(200, { cmds: [] })
        continue
      }
      p.responder.cut()
      this.#log({ kind: 'poll-cut', host: s.host, poll: p.id, inst: p.inst, why: what })
    }
    for (const c of this.#commands.values()) this.#clearTimer(c.timer)
    this.#fpWaiting = []
    this.#dialShown.clear()
    this.#sessions.clear()
    this.#commands.clear()
    this.#promptKeys.clear()
    this.#registry = new Map()
    this.#listed = new Map()
    this.#registryBySid = new Map()
    this.#statusSeen = new Map()
    this.#records.clear()
    this.#recent = []
    this.#lastPress = null
  }

  /** Shutting down: held requests get no decision, so the app's dialogs decide; open polls get no commands. */
  close() {
    this.reset('shutdown')
  }
}
