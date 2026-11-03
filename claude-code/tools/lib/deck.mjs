// The fake deck: what the deck plugin knows and does, without the hardware or the Stream Deck SDK
// (claude-code/protocol/PROTOCOL.md, v1). It holds permission requests and sorts them into kinds, queues
// commands and hands them to long polls, follows each session from the mod's hello and events, applies the
// release rules, and works out each session's status the way the deck shows it.
//
// No I/O here: bridge.mjs feeds it HTTP requests and folder readings, and its clock and timers are injected,
// so the tests drive it directly. Presses come from the control interface in place of the keys.

import { ASK_TOOLS, AT_ONCE_MS, FINAL_STATES, HOST_PATTERN, IN_FLIGHT_MS, MODE_TOOL, MODES, VERSION, answerFor, fingerprint, summary } from './protocol.mjs'

/** A control call, or a mod request, that can't be carried out as asked: bridge.mjs answers it with 400. */
export class BadRequest extends Error {}

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

/**
 * A host id from a request or a registry file (PROTOCOL.md, "Identity"). A value that doesn't match counts as
 * missing: an empty one, or the hook's `$CLAUDE_CODE_HOST_SESSION_ID` when Claude Code didn't fill it in.
 */
const hostValue = (v) => (typeof v === 'string' && HOST_PATTERN.test(v) ? v : null)

/** A registry entry's `statusUpdatedAt`, or null for none: only a number counts, as the deck reads it. */
const statusAt = (f) => (Number.isFinite(f.statusUpdatedAt) ? f.statusUpdatedAt : null)

function newSession(host) {
  return {
    host,
    /** The latest Claude Code session id, and every one its mod and its PermissionRequests have come with: it can change. */
    sid: null,
    sids: new Set(),
    inst: null,
    /** Every inst seen for the session: one seen before doesn't count as a restart again. */
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
     * turn.end, as a #seenTick (status rule 3), and when it got the turn's last end, a turn.end or failed, by its
     * clock (#afterTurnEnd).
     */
    turn: { id: null, sawEnd: false, lastEnd: null, failed: false, endSeen: null, endedAt: null },
    context: null,
    /** The latest model, effort and mode from the plugin: hello, settings events, PermissionRequests. */
    settings: { model: null, effort: null, mode: null },
    attachAt: null,
    onScreen: false,
    ended: null,
    poll: null,
    /** When the session's last open poll ended, or null while one is open or before its first. */
    pollEndedAt: null,
    /** Fails the session's waiting prompts once it has gone IN_FLIGHT_MS without an open poll. */
    gapTimer: null,
    lastSeen: null,
  }
}

const wire = (c) => (c.t === 'prompt' ? { id: c.id, t: c.t, text: c.text } : { id: c.id, t: c.t, mode: c.mode })

export class FakeDeck {
  #now
  #log
  #inFlightMs
  #setTimer
  #clearTimer
  #cmdPrefix

  /** host → session, for every session the bridge has heard from or holds a request for. */
  #sessions = new Map()
  /** host → registry fields: the sessions the deck lists. */
  #registry = new Map()
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
   * Options: `now` (ms clock), `log(event)` (structured events; `say` is a line for people), `inFlightMs`
   * (how long a delivered command waits for its final result, and a queued one for a poll), `cmdPrefix`
   * (command ids are the prefix and a number: deliberately not the fixtures' `c1`, so the tests exercise
   * binding), `setTimer`/`clearTimer`.
   */
  constructor({ now = Date.now, log = () => {}, inFlightMs = IN_FLIGHT_MS, cmdPrefix = 'cmd-', setTimer, clearTimer } = {}) {
    this.#now = now
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
   * The host a request is for: its own `host`, else its `sid` looked up in the registry, then among every sid and
   * host pair the bridge has seen from mods and hooks (PROTOCOL.md, Identity).
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

  /** A sid the session's mod or hook came with: the latest, and one more pair for the host fallback. */
  #sawSid(s, sid) {
    if (!str(sid)) return
    s.sid = sid
    s.sids.add(sid)
  }

  /**
   * The session a mod request names, marked as having the plugin. A new inst means the mod restarted; one
   * seen before for the session, a late request from an instance already replaced, doesn't count again.
   */
  #touchMod(sid, host, inst) {
    const h = this.#hostFor(sid, host)
    if (!h) return null
    const s = this.#session(h)
    s.plugin = true
    s.lastSeen = this.#now()
    this.#sawSid(s, sid)
    if (str(inst) && !s.insts.has(inst)) {
      if (s.inst !== null) this.#modRestarted(s, inst)
      s.insts.add(inst)
      s.inst = inst
    }
    return s
  }

  /** A mod request that names no session the bridge can place. PROTOCOL.md, Identity: it gets 400. */
  #unplaced(kind) {
    this.#log({ kind, placed: false, say: `${kind} naming no session it can place (no host, and its sid is unknown): 400` })
    throw new BadRequest('the request names no session the bridge can place: give its host (local_…), or a sid the registry knows')
  }

  /**
   * PROTOCOL.md, Identity: a new inst forgets the session's current tool, fails its delivered and waiting
   * commands, and answers the old instance's open poll with no commands, so what's queued from then on waits for
   * the new one. The session's requests still wait for their tool.starts, which the old instance's line may yet
   * bring, or may have lost.
   */
  #modRestarted(s, inst) {
    s.tools.clear()
    for (const c of this.#commands.values()) {
      if (c.host === s.host && IN_FLIGHT.has(c.state)) this.#finish(c, 'failed', { error: 'the mod restarted' })
    }
    this.#endPoll(s, [])
    this.#armPollGap(s)
    this.#log({ kind: 'mod-restart', host: s.host, from: s.inst, to: inst, say: `${s.host}: the mod restarted (inst ${s.inst} → ${inst})` })
    for (const h of this.#fpWaiting) if (this.#isOf(h, s.host, s.sid)) h.fpRestarted = true
  }

  #heldOf(host, sid = this.#registry.get(host)?.sessionId) {
    return this.#held.filter((h) => this.#isOf(h, host, sid))
  }

  /** Whether held request `h` is the session's: by its host, or by its sid when it came without one. */
  #isOf(h, host, sid) {
    return (host !== null && h.host === host) || (h.host === null && Boolean(str(sid)) && h.sid === sid)
  }

  // ---- POST /v1/hello ------------------------------------------------------------------------------------

  hello(body) {
    const b = isObject(body) ? body : {}
    if (b.v !== VERSION) {
      this.#log({ kind: 'hello', ok: false, v: b.v ?? null, say: `hello from ${hostValue(b.host) ?? '?'} on version ${display(b.v)}: refused` })
      return { v: VERSION, ok: false, error: 'version' }
    }
    const s = this.#touchMod(b.sid, b.host, b.inst)
    if (!s) this.#unplaced('hello')
    const [cwd, model, mode, effort, plugin, cc] = [b.cwd, b.model, b.mode, b.effort, b.plugin, b.cc].map(asString)
    s.hello = { at: this.#now(), cwd, model, mode, effort, plugin, cc }
    for (const k of ['model', 'mode', 'effort']) if (str(b[k])) s.settings[k] = b[k]
    this.#log({ kind: 'hello', ok: true, host: s.host, inst: s.inst, plugin, cc, model, say: `hello ${s.host} inst ${s.inst} (plugin ${plugin ?? '?'}, cc ${cc ?? '?'}, ${model ?? '?'})` })
    return { v: VERSION, ok: true }
  }

  // ---- POST /v1/events -----------------------------------------------------------------------------------

  events(body) {
    const b = isObject(body) ? body : {}
    const s = this.#touchMod(b.sid, b.host, b.inst)
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
          // A new turn: the last one's end no longer has the polls answered at once (#afterTurnEnd).
          s.turn = { id: str(e.turn), sawEnd: false, lastEnd: null, failed: false, endSeen: null, endedAt: null }
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
          s.turn = { id: id ?? s.turn.id, sawEnd: true, lastEnd: str(e.reason), failed: same && s.turn.failed, endSeen: ++this.#seenTick, endedAt: this.#now() }
          this.#clearMainTools(s)
        }
        this.#fpCallsEnded(s, (c) => c.agent === agent)
        break
      case 'failed':
        if (main) {
          s.turn.sawEnd = true
          s.turn.failed = true
          s.turn.endedAt = this.#now()
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
        for (const k of ['model', 'mode', 'effort']) if (str(e[k])) s.settings[k] = e[k]
        break
      case 'attach':
        // When the deck got it: `at` is by the mod's clock.
        s.attachAt = this.#now()
        s.onScreen = true
        break
      case 'detach':
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
    const h = this.#heldOf(s.host, s.sid).find((x) => x.fp === fp)
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
    const h = this.#fpWaiting.find((x) => this.#isOf(x, s.host, s.sid) && x.tool === c.tool && x.fp === c.fp)
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
    const waiting = this.#fpWaiting.filter((h) => this.#isOf(h, s.host, s.sid))
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
    const s = [...this.#sessions.values()].find((x) => this.#isOf(h, x.host, x.sid))
    // A session without the plugin has no tool.starts to compare.
    if (!s?.plugin) return
    const calls = s.fpCalls.filter((c) => c.tool === h.tool && (c.end === null || c.end > h.fpFrom))
    const others = this.#fpWaiting.filter((x) => this.#isOf(x, s.host, s.sid) && x.tool === h.tool)
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
   * Sorts a PermissionRequest into its kind (PROTOCOL.md, "Permission requests"). A `mode` request is
   * allowed at once; `ask` and `tool` requests are held. `responder` is `{open, send(status, json)}`.
   * Returns `{kind, id}` for a held request, `{kind: 'mode', cmd}` for one answered.
   */
  permission({ body, hostHeader, responder }) {
    const b = isObject(body) ? body : {}
    const tool = typeof b.tool_name === 'string' ? b.tool_name : ''
    const input = b.tool_input
    const sid = str(b.session_id)
    const host = this.#hostFor(sid, hostHeader)
    const s = host ? this.#session(host) : null
    if (s) {
      this.#sawSid(s, sid)
      if (str(b.permission_mode)) s.settings.mode = b.permission_mode
      if (isObject(b.effort) && str(b.effort.level)) s.settings.effort = b.effort.level
    }
    const fp = fingerprint(tool, input)
    const sum = summary(tool, input)

    if (tool === MODE_TOOL && isObject(input) && input.session_id === 'self' && s) {
      const cmd = this.#modeInFlight(s, input.mode)
      if (cmd) {
        // One press, one allowance: the request this command raised. A second one is an ordinary request.
        cmd.allowedRequest = true
        responder.send(200, answerFor('allow'))
        this.#log({ kind: 'mode-allowed', host, cmd: cmd.id, mode: input.mode, fp, say: `${host}: mode ${input.mode} allowed at once (${cmd.id} in flight)` })
        return { kind: 'mode', cmd: cmd.id }
      }
    }

    const kind = ASK_TOOLS.includes(tool) ? 'ask' : 'tool'
    const h = {
      id: `p${++this.#heldSeq}`, host, sid, tool, kind, summary: sum, fp,
      arrived: this.#now(), seenWaiting: false, responder,
    }
    this.#held.push(h)
    this.#log({ kind: 'held', id: h.id, host, sid, tool, requestKind: kind, summary: sum, fp, say: `${h.id} HELD ${kind} ${host ?? `(no host, sid ${sid ?? '?'})`} ${tool}: ${sum} fp ${fp}` })
    this.#fpFromHeld(h, s)
    return { kind, id: h.id }
  }

  #modeInFlight(s, mode) {
    for (const c of this.#commands.values()) {
      if (c.host === s.host && c.t === 'mode' && IN_FLIGHT.has(c.state) && c.mode === mode && !c.allowedRequest) return c
    }
    return null
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
    const sent = h.responder.open
    if (sent) h.responder.send(200, answerFor(decision))
    this.#log({ kind: 'answered', id: h.id, decision, by, sent, say: `${h.id} ${sent ? decision : `gone before its ${decision}`} (${by})` })
    this.#end(h, sent ? 'answered' : 'gone', `answered ${decision} by ${by === 'press' ? 'a press' : 'the control route'}`, { decision, by })
    return sent
  }

  // ---- GET /v1/next and POST /v1/result -------------------------------------------------------------------

  /**
   * A long poll (PROTOCOL.md, "Commands"). Answers at once with what's queued, else holds up to `wait`
   * seconds. A new poll answers the session's older one with no commands, and so does the end of the main
   * loop's turn (#turnEnded). From that turn end, while the registry still says busy, it answers at once with
   * what's queued or nothing (#afterTurnEnd). Returns the poll's id, or null when the poll names no session the
   * bridge can place.
   */
  poll({ sid, host, inst, wait, responder }) {
    const s = this.#touchMod(sid, host, inst)
    if (!s) return null
    const id = ++this.#pollSeq
    if (str(inst) !== s.inst) {
      // PROTOCOL.md, Identity: a poll from an inst other than the session's newest, one already replaced, is
      // answered at once with no commands. It never takes the newest one's place or a command, nor does it show
      // that the session's mod is there for a waiting prompt's clock.
      responder.send(200, { cmds: [] })
      this.#log({ kind: 'poll-stale', host: s.host, poll: id, inst: str(inst), newest: s.inst })
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
      s.pollEndedAt = this.#now()
      this.#armPollGap(s)
      if (afterTurnEnd) this.#log({ kind: 'poll-at-once', host: s.host, poll: id, cmds: queued.map((c) => c.id), sinceTurnEndMs: this.#now() - s.turn.endedAt })
      return id
    }
    const p = { id, responder, inst: s.inst, since: this.#now(), timer: null }
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
   * inst seen before, whose events still count: the session's turn has ended all the same, so the poll it answers is
   * the newest instance's.
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
   * session idle. Judged as each poll arrives, by the bridge's latest registry reading and its own clock: a session
   * the registry doesn't list, or lists as anything but busy, has its polls held as usual, and every main-loop
   * turn.end or failed starts the 60 s again.
   */
  #afterTurnEnd(s) {
    const at = s.turn.endedAt
    return at !== null && this.#now() - at < AT_ONCE_MS && this.#registry.get(s.host)?.status === 'busy'
  }

  /** Ends the session's open poll: answered with `cmds` if they're given and its client is still there. */
  #endPoll(s, cmds) {
    const p = s.poll
    if (!p) return
    s.poll = null
    this.#clearTimer(p.timer)
    if (cmds && p.responder.open) p.responder.send(200, { cmds })
    s.pollEndedAt = this.#now()
    this.#armPollGap(s)
  }

  /**
   * PROTOCOL.md, "Commands": a waiting prompt has no 60 s clock of its own, since the engine holds it until
   * the turn ends (S3). It fails with "no result" once its session has gone IN_FLIGHT_MS without an open
   * poll, as a live mod always keeps one open. Called whenever the session's poll or its waiting prompts change.
   */
  #armPollGap(s) {
    this.#clearTimer(s.gapTimer)
    s.gapTimer = null
    if (s.poll) return
    const waiting = () => [...this.#commands.values()].filter((c) => c.host === s.host && c.t === 'prompt' && c.state === 'waiting')
    if (!waiting().length) return
    const expire = () => {
      s.gapTimer = null
      for (const c of waiting()) this.#finish(c, 'failed', { error: 'no result' })
    }
    const left = (s.pollEndedAt ?? this.#now()) + this.#inFlightMs - this.#now()
    if (left <= 0) expire()
    else s.gapTimer = this.#setTimer(expire, left)
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

  #finish(c, state, { error = null, detail = null } = {}) {
    this.#clearTimer(c.timer)
    c.timer = null
    c.state = state
    c.error = error
    c.detail = detail
    c.finishedAt = this.#now()
    this.#log({ kind: 'command', id: c.id, host: c.host, state, error, say: `${c.id} ${state}${error ? `: ${error}` : ''}` })
  }

  /**
   * How a command went. One for an unknown or finished command, or from another session, is ignored. A
   * prompt's `waiting` stops its 60 s clock (see #armPollGap); a mode command keeps it even after a stray one,
   * which bounds how long the mode rule can allow a change.
   */
  result(body) {
    const b = isObject(body) ? body : {}
    const s = this.#touchMod(b.sid, b.host, b.inst)
    if (!s) this.#unplaced('result')
    const c = typeof b.id === 'string' ? this.#commands.get(b.id) : undefined
    const id = typeof b.id === 'string' ? b.id : b.id === undefined ? '?' : display(b.id)
    const ignore = (why) => this.#log({ kind: 'result-ignored', id: b.id ?? null, state: b.state ?? null, why, say: `result for ${id} ignored: ${why}` })
    if (!c) return ignore('unknown command')
    if (FINAL.has(c.state)) return ignore(`already ${c.state}`)
    if (c.state === 'queued') return ignore('not delivered yet')
    if (s.host !== c.host) return ignore(`it was for ${c.host}`)
    if (b.state === 'waiting') {
      c.state = 'waiting'
      if (c.t === 'prompt') {
        this.#clearTimer(c.timer)
        c.timer = null
      }
      this.#log({ kind: 'command', id: c.id, host: c.host, state: 'waiting', say: `${c.id} waiting` })
      this.#armPollGap(s)
      return
    }
    if (!FINAL.has(b.state)) return ignore(`unknown state ${display(b.state)}`)
    this.#finish(c, b.state, { error: asString(b.error), detail: asString(b.detail) })
    this.#armPollGap(s)
  }

  // ---- presses -------------------------------------------------------------------------------------------

  #pressed(p) {
    this.#lastPress = { at: this.#now(), alert: false, jumped: null, ...p }
    const what = p.alert ? `ALERT: ${p.error}` : p.jumped ? `jumps to ${p.jumped}` : p.answered ? `${p.answered} ${p.request}` : p.cmd ? `queued ${p.cmd}` : ''
    this.#log({ kind: 'press', ...this.#lastPress, say: `press ${p.key}${p.session ? ` ${p.session}` : ''}: ${what}` })
    return { ok: !p.alert, ...this.#lastPress }
  }

  /**
   * Approve or Deny (PROTOCOL.md, "Held requests"): acts on the oldest held request across sessions. `shown`
   * is the request the key showed when pressed: undefined skips the check, null means it showed none. A
   * `tool` request gets Allow or Deny; on an `ask` request either press jumps and answers nothing.
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

  /** Why the deck can't send to `host`: it isn't listed, or nothing has come from its mod. */
  #cannotSend(host) {
    if (!this.#registry.has(host)) return `${host} isn't running: the registry doesn't list it`
    if (!this.#sessions.get(host)?.plugin) return `${host} has no plugin: nothing has come from its mod`
    return null
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

  /** The Mode dial or key: queues a mode change for `host`. */
  mode({ host, mode }) {
    if (typeof host !== 'string' || host === '') throw new BadRequest('host must be a session host (local_…)')
    if (!MODES.includes(mode)) throw new BadRequest(`mode must be one of ${MODES.join(', ')}`)
    const why = this.#cannotSend(host)
    if (why) return this.#pressed({ key: 'mode', session: host, alert: true, error: why })
    const c = this.#queue(host, { t: 'mode', mode })
    return this.#pressed({ key: 'mode', session: host, cmd: c.id })
  }

  #queue(host, fields) {
    const c = {
      id: `${this.#cmdPrefix}${++this.#cmdSeq}`, host, ...fields, state: 'queued', queuedAt: this.#now(),
      deliveredAt: null, finishedAt: null, inst: null, error: null, detail: null, allowedRequest: false, timer: null,
    }
    this.#commands.set(c.id, c)
    // PROTOCOL.md, "Commands": one that no poll takes in time fails, so a key waiting on it can't stay locked.
    c.timer = this.#setTimer(() => {
      if (c.state === 'queued') this.#finish(c, 'failed', { error: 'not delivered' })
    }, this.#inFlightMs)
    this.#log({ kind: 'command', id: c.id, host, state: 'queued', t: c.t, say: `${c.id} queued for ${host}: ${c.t} ${c.t === 'prompt' ? JSON.stringify(c.text) : c.mode}` })
    const s = this.#sessions.get(host)
    if (s?.poll && s.poll.responder.open) {
      this.#deliver([c], s)
      this.#endPoll(s, [wire(c)])
    }
    return c
  }

  /**
   * The control interface's own answer to one `tool` request, by id: allow, deny or none. An ask request is
   * refused, as the deck never answers one: a press on it jumps to its session instead.
   */
  answer({ id, decision }) {
    if (!['allow', 'deny', 'none'].includes(decision)) throw new BadRequest('decision must be allow, deny or none')
    const h = this.#held.find((x) => x.id === id)
    if (!h) {
      const r = this.#recent.findLast((x) => x.id === id)
      return { ok: false, id, error: r ? `${id} already ended (${r.end})` : `no request ${id}` }
    }
    if (h.kind === 'ask') {
      throw new BadRequest(`${id} is an ask request (${h.tool}), which the deck never answers: a press on it jumps to ${h.host ?? 'its session'} instead, and the user answers in the app`)
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
   * Release rules 2 and 3 are judged by what the bridge itself saw, as PROTOCOL.md lets a fake bridge. Release
   * rule 2's "held from before that change": the request was held when a reading showed the session `waiting`.
   * Release rule 3: a reading shows the session `idle` and the one before showed it otherwise, so the change came
   * after every request held now arrived; a session's first reading is no change. Status rule 3 is judged by what
   * the bridge saw too: a `busy` began before the main loop's last turn.end when the reading where the session's
   * `status` or `statusUpdatedAt` last changed, or its first, came before the bridge got that turn.end (#status).
   * So a rewritten `statusUpdatedAt` is a new `busy`, as it would be by the times, and a new `name` or a missing
   * `statusUpdatedAt` isn't. Comparing arrivals with `statusUpdatedAt` instead would mix the bridge's clock with
   * the registry's, which differ in the fixtures (their times are made up).
   */
  applyRegistry(entries) {
    const next = new Map()
    const bySid = new Map()
    for (const f of entries) {
      const host = hostValue(f.hostSessionId)
      if (!host) continue
      next.set(host, f)
      if (str(f.sessionId)) bySid.set(f.sessionId, host)
    }
    const prev = this.#registry
    this.#registry = next
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
    // A request held without a host: the registry, or a sid and host pair seen since it came, may place it now.
    for (const h of this.#held) if (h.host === null && h.sid) h.host = this.#hostFor(h.sid, null)

    for (const [host, f] of next) {
      const p = prev.get(host)
      if (!p) this.#log({ kind: 'registry', change: 'added', host, fields: f, say: `registry + ${host} ${f.status ?? '?'} ${JSON.stringify(f.name ?? '')}` })
      else if (JSON.stringify(p) !== JSON.stringify(f)) this.#log({ kind: 'registry', change: 'changed', host, from: p, to: f, say: `registry ~ ${host} ${p.status ?? '?'} → ${f.status ?? '?'}` })
    }
    for (const [host, p] of prev) {
      if (next.has(host)) continue
      this.#log({ kind: 'registry', change: 'removed', host, last: p, say: `registry - ${host}` })
      for (const h of this.#heldOf(host, p.sessionId)) this.#release(h, 4, 'the session\'s registry file disappeared')
      this.#sessionEnded(host)
    }
    for (const [host, f] of next) {
      if (prev.get(host)?.status === 'waiting' && f.status !== 'waiting') {
        const mine = this.#heldOf(host, f.sessionId)
        if (mine.length === 1 && mine[0].seenWaiting) this.#release(mine[0], 2, 'the registry shows the session leaving waiting')
      }
    }
    for (const [host, f] of next) {
      const before = prev.get(host)
      if (f.status !== 'idle' || !before || before.status === 'idle') continue
      for (const h of this.#heldOf(host, f.sessionId)) this.#release(h, 3, 'the registry shows the session turning idle since it arrived')
    }
    for (const [host, f] of next) {
      if (f.status === 'waiting') for (const h of this.#heldOf(host, f.sessionId)) h.seenWaiting = true
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
   * its open poll gets no commands, and the bridge forgets what it knew of the session.
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
   * later of its latest attach, by when the deck got it, and its record's lastFocusedAt.
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
    for (const h of this.#held) if (h.host) hosts.add(h.host)
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
      held: this.#held.map((h) => ({ id: h.id, host: h.host, tool: h.tool, kind: h.kind, summary: h.summary, fp: h.fp, ageMs: now - h.arrived })),
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
        sid: s.sid, inst: s.inst, plugin: s.plugin, hello: s.hello, lastSeq: Object.fromEntries(s.seq),
        tools: [...s.tools].map(([use, t]) => ({ use, tool: t.tool, summary: t.summary, fp: t.fp, agent: t.agent })),
        turn: s.turn, statusSeen: this.#statusSeen.get(host) ?? null, context: s.context, settings: s.settings, onScreen: s.onScreen, attachAt: s.attachAt, ended: s.ended,
        poll: s.poll ? { id: s.poll.id, inst: s.poll.inst, openMs: now - s.poll.since } : null,
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
    }
  }

  // ---- reset and close ------------------------------------------------------------------------------------

  /** Forgets everything but the id counters (command ids stay unique for the bridge's run). */
  reset(why = 'reset') {
    const what = `the bridge was ${why === 'reset' ? 'reset' : 'shut down'}`
    for (const h of [...this.#held]) this.#release(h, why, what)
    for (const s of this.#sessions.values()) {
      this.#clearTimer(s.gapTimer)
      if (!s.poll) continue
      this.#clearTimer(s.poll.timer)
      if (s.poll.responder.open) s.poll.responder.send(200, { cmds: [] })
      s.poll = null
    }
    for (const c of this.#commands.values()) this.#clearTimer(c.timer)
    this.#fpWaiting = []
    this.#sessions.clear()
    this.#commands.clear()
    this.#promptKeys.clear()
    this.#registry = new Map()
    this.#registryBySid = new Map()
    this.#statusSeen = new Map()
    this.#records.clear()
    this.#recent = []
    this.#lastPress = null
  }

  /** Shutting down: held requests get no decision, so the app's dialogs decide; polls get no commands. */
  close() {
    this.reset('shutdown')
  }
}
