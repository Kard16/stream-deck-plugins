// The fake deck: what the deck plugin knows and does, without the hardware or the Stream Deck SDK
// (claude-code/protocol/PROTOCOL.md, v1). It holds permission requests and sorts them into kinds, queues
// commands and hands them to long polls, follows each session from the mod's hello and events, applies the
// release rules, and works out each session's status the way the deck shows it.
//
// No I/O here: bridge.mjs feeds it HTTP requests and folder readings, and its clock and timers are injected,
// so the tests drive it directly. Presses come from the control interface in place of the keys.

import { ASK_TOOLS, FINAL_STATES, IN_FLIGHT_MS, MODE_TOOL, MODES, VERSION, answerFor, fingerprint, summary } from './protocol.mjs'

/** A control call that can't be carried out as asked: bridge.mjs answers it with 400. */
export class BadRequest extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v !== '' ? v : null)
const IN_FLIGHT = new Set(['delivered', 'waiting'])
const FINAL = new Set(FINAL_STATES)
const RECENT_KEPT = 50

/**
 * A host id from a request. A value that starts with `$` is a variable Claude Code didn't interpolate (the
 * hook's `$CLAUDE_CODE_HOST_SESSION_ID` when the session lacks it), so it counts as missing.
 */
const hostValue = (v) => {
  const s = str(typeof v === 'string' ? v.trim() : v)
  return s && !s.startsWith('$') ? s : null
}

function newSession(host) {
  return {
    host,
    sid: null,
    inst: null,
    /** True once anything has come from its mod: hello, events, a poll or a result. */
    plugin: false,
    hello: null,
    /** The last event `seq` seen, by inst. */
    seq: new Map(),
    /** Unfinished tool calls by `use`, with the order they started in. */
    tools: new Map(),
    toolOrder: 0,
    /** The main loop's current or last turn: did the deck see it end, how, and did it fail. */
    turn: { sawEnd: false, lastEnd: null, failed: false },
    context: null,
    /** The latest model, effort and mode from the plugin: hello, settings events, PermissionRequests. */
    settings: { model: null, effort: null, mode: null },
    attachAt: null,
    onScreen: false,
    ended: null,
    poll: null,
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
  /** host → the record's fields. */
  #records = new Map()
  /** Held permission requests, oldest first. */
  #held = []
  /** Requests that ended, newest last, so `answer` can say how one ended. */
  #recent = []
  /** id → command, in the order they were queued. */
  #commands = new Map()
  #lastPress = null
  #heldSeq = 0
  #cmdSeq = 0
  #pollSeq = 0

  /**
   * Options: `now` (ms clock), `log(event)` (structured events; `say` is a line for people), `inFlightMs`
   * (how long a delivered command waits for its final result), `cmdPrefix` (command ids are the prefix and a
   * number: deliberately not the fixtures' `c1`, so the tests exercise binding), `setTimer`/`clearTimer`.
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

  /** The host a request is for: its own `host`, else its `sid` looked up in the registry, then in the mods'. */
  #hostFor(sid, host) {
    const h = hostValue(host)
    if (h) return h
    const s = str(sid)
    if (!s) return null
    const fromRegistry = this.#registryBySid.get(s)
    if (fromRegistry) return fromRegistry
    for (const x of this.#sessions.values()) if (x.sid === s) return x.host
    return null
  }

  /** The session a mod request names, marked as having the plugin. A new inst means the mod restarted. */
  #touchMod(sid, host, inst) {
    const h = this.#hostFor(sid, host)
    if (!h) return null
    const s = this.#session(h)
    s.plugin = true
    s.lastSeen = this.#now()
    if (str(sid)) s.sid = sid
    if (str(inst) && s.inst !== inst) {
      if (s.inst !== null) this.#modRestarted(s, inst)
      s.inst = inst
    }
    return s
  }

  /** PROTOCOL.md, Identity: a new inst forgets the session's current tool and its in-flight commands. */
  #modRestarted(s, inst) {
    s.tools.clear()
    for (const c of this.#commands.values()) {
      if (c.host === s.host && IN_FLIGHT.has(c.state)) this.#finish(c, 'failed', { error: 'the mod restarted before its result' })
    }
    this.#log({ kind: 'mod-restart', host: s.host, from: s.inst, to: inst, say: `${s.host}: the mod restarted (inst ${s.inst} → ${inst})` })
  }

  #heldOf(host, sid = this.#registry.get(host)?.sessionId) {
    return this.#held.filter((h) => (host !== null && h.host === host) || (h.host === null && str(sid) && h.sid === sid))
  }

  // ---- POST /v1/hello ------------------------------------------------------------------------------------

  hello(body) {
    const b = isObject(body) ? body : {}
    if (b.v !== VERSION) {
      this.#log({ kind: 'hello', ok: false, v: b.v ?? null, say: `hello from ${hostValue(b.host) ?? '?'} on version ${JSON.stringify(b.v)}: refused` })
      return { v: VERSION, ok: false, error: 'version' }
    }
    const s = this.#touchMod(b.sid, b.host, b.inst)
    if (!s) {
      this.#log({ kind: 'hello', ok: true, placed: false, say: 'hello naming no session it can place (no host, and its sid is unknown)' })
      return { v: VERSION, ok: true }
    }
    s.hello = { at: this.#now(), cwd: b.cwd ?? null, model: b.model ?? null, mode: b.mode ?? null, effort: b.effort ?? null, plugin: b.plugin ?? null, cc: b.cc ?? null }
    for (const k of ['model', 'mode', 'effort']) if (str(b[k])) s.settings[k] = b[k]
    this.#log({ kind: 'hello', ok: true, host: s.host, inst: s.inst, plugin: b.plugin ?? null, cc: b.cc ?? null, model: b.model ?? null, say: `hello ${s.host} inst ${s.inst} (plugin ${b.plugin ?? '?'}, cc ${b.cc ?? '?'}, ${b.model ?? '?'})` })
    return { v: VERSION, ok: true }
  }

  // ---- POST /v1/events -----------------------------------------------------------------------------------

  events(body) {
    const b = isObject(body) ? body : {}
    const s = this.#touchMod(b.sid, b.host, b.inst)
    if (!s) {
      this.#log({ kind: 'events', placed: false, say: 'events naming no session it can place: dropped' })
      return
    }
    if (Number.isFinite(b.seq)) {
      const last = s.seq.get(b.inst) ?? 0
      if (b.seq <= last) {
        this.#log({ kind: 'events', host: s.host, seq: b.seq, dropped: true, say: `${s.host}: events seq ${b.seq} dropped (last ${last})` })
        return
      }
      s.seq.set(b.inst, b.seq)
    }
    for (const e of Array.isArray(b.events) ? b.events : []) if (isObject(e)) this.#event(s, e)
  }

  #event(s, e) {
    const main = e.agent === undefined || e.agent === null
    switch (e.t) {
      case 'turn.start':
        if (main) {
          s.turn = { sawEnd: false, lastEnd: null, failed: false }
          this.#clearMainTools(s)
        }
        break
      case 'turn.end':
        if (main) {
          s.turn.sawEnd = true
          s.turn.lastEnd = str(e.reason)
          this.#clearMainTools(s)
        }
        break
      case 'failed':
        s.turn.sawEnd = true
        s.turn.failed = true
        this.#clearMainTools(s)
        break
      case 'tool.start':
        if (str(e.use)) {
          s.tools.set(e.use, { tool: str(e.tool), summary: str(e.summary) ?? str(e.tool), fp: str(e.fp), agent: e.agent ?? null, order: ++s.toolOrder })
        }
        this.#fpCheckFromTool(s, e)
        break
      case 'tool.end':
        if (str(e.use)) s.tools.delete(e.use)
        if (str(e.fp)) this.#releaseByFp(s, e.fp)
        break
      case 'measure':
        if (isObject(e.context) && Number.isFinite(e.context.percent)) s.context = e.context.percent
        break
      case 'settings':
        for (const k of ['model', 'mode', 'effort']) if (str(e[k])) s.settings[k] = e[k]
        break
      case 'attach':
        s.attachAt = Number.isFinite(e.at) ? e.at : this.#now()
        s.onScreen = true
        break
      case 'detach':
        s.onScreen = false
        break
      case 'end':
        s.ended = str(e.reason) ?? 'end'
        break
      default:
        this.#log({ kind: 'event-unknown', host: s.host, t: e.t ?? null, say: `${s.host}: event of unknown type ${JSON.stringify(e.t)} ignored` })
        return
    }
    this.#log({ kind: 'event', host: s.host, event: e })
  }

  #clearMainTools(s) {
    for (const [use, t] of s.tools) if (t.agent === null) s.tools.delete(use)
  }

  /** Release rule 1: the mod reports tool.end with the same fp, from the same session. */
  #releaseByFp(s, fp) {
    const h = this.#heldOf(s.host, s.sid).find((x) => x.fp === fp)
    if (h) this.#release(h, 1, 'tool.end with the same fp')
  }

  /**
   * Ladder step 4 compares both sides' fingerprints (PROTOCOL.md, "Fingerprints and summaries"). A held
   * request and the mod's tool.start for the same tool in the same session should carry the same fp and
   * summary; whichever comes second logs the comparison.
   */
  #fpCheck(h, t) {
    h.fpChecked = true
    const match = h.fp === t.fp
    this.#log({
      kind: 'fp-check', request: h.id, host: h.host, tool: h.tool, match,
      bridgeFp: h.fp, modFp: t.fp ?? null, bridgeSummary: h.summary, modSummary: t.summary ?? null,
      say: `${h.id} fp ${match ? 'matches' : `differs: bridge ${h.fp}, mod ${t.fp}`} (${h.tool})`,
    })
  }

  #fpCheckFromTool(s, e) {
    const h = this.#heldOf(s.host, s.sid).find((x) => !x.fpChecked && x.tool === e.tool)
    if (h) this.#fpCheck(h, { fp: str(e.fp), summary: str(e.summary) })
  }

  #fpCheckFromHeld(h, s) {
    if (!s) return
    let latest = null
    for (const t of s.tools.values()) if (t.tool === h.tool && (latest === null || t.order > latest.order)) latest = t
    if (latest) this.#fpCheck(h, latest)
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
      if (sid) s.sid = sid
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
      arrived: this.#now(), seenWaiting: false, fpChecked: false, responder,
    }
    this.#held.push(h)
    this.#log({ kind: 'held', id: h.id, host, sid, tool, requestKind: kind, summary: sum, fp, say: `${h.id} HELD ${kind} ${host ?? `(no host, sid ${sid ?? '?'})`} ${tool}: ${sum} fp ${fp}` })
    this.#fpCheckFromHeld(h, s)
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
    this.#end(h, 'client-closed')
    this.#log({ kind: 'release', id, rule: 5, why: 'the client closed the connection', say: `${id} released: the client closed it (rule 5)` })
    return true
  }

  #end(h, end, extra = {}) {
    const i = this.#held.indexOf(h)
    if (i >= 0) this.#held.splice(i, 1)
    this.#recent.push({ id: h.id, host: h.host, tool: h.tool, kind: h.kind, summary: h.summary, end, ...extra, heldMs: this.#now() - h.arrived })
    if (this.#recent.length > RECENT_KEPT) this.#recent.shift()
  }

  /** Answers a held request with no decision, by release rule `rule`. */
  #release(h, rule, why) {
    const sent = h.responder.open
    if (sent) h.responder.send(200, answerFor('none'))
    this.#end(h, sent ? 'released' : 'gone', { rule })
    this.#log({ kind: 'release', id: h.id, rule, why, sent, say: `${h.id} released with {}: ${why} (rule ${rule})` })
  }

  /** Answers a held request: allow, deny or none. False when its client had already gone. */
  #answerHeld(h, decision, by) {
    const sent = h.responder.open
    if (sent) h.responder.send(200, answerFor(decision))
    this.#end(h, sent ? 'answered' : 'gone', { decision, by })
    this.#log({ kind: 'answered', id: h.id, decision, by, sent, say: `${h.id} ${sent ? decision : `gone before its ${decision}`} (${by})` })
    return sent
  }

  // ---- GET /v1/next and POST /v1/result -------------------------------------------------------------------

  /**
   * A long poll (PROTOCOL.md, "Commands"). Answers at once with what's queued, else holds up to `wait`
   * seconds. A new poll answers the session's older one with no commands. Returns the poll's id, or null
   * when the poll names no session the bridge can place.
   */
  poll({ sid, host, inst, wait, responder }) {
    const s = this.#touchMod(sid, host, inst)
    if (!s) return null
    if (s.poll) {
      const old = s.poll
      s.poll = null
      this.#clearTimer(old.timer)
      if (old.responder.open) old.responder.send(200, { cmds: [] })
      this.#log({ kind: 'poll-superseded', host: s.host, poll: old.id })
    }
    const id = ++this.#pollSeq
    const queued = [...this.#commands.values()].filter((c) => c.host === s.host && c.state === 'queued')
    if (queued.length) {
      this.#deliver(queued, s)
      responder.send(200, { cmds: queued.map(wire) })
      return id
    }
    if (wait === 0) {
      responder.send(200, { cmds: [] })
      return id
    }
    const p = { id, responder, inst: s.inst, since: this.#now(), timer: null }
    p.timer = this.#setTimer(() => {
      if (s.poll === p) s.poll = null
      if (p.responder.open) p.responder.send(200, { cmds: [] })
    }, wait * 1000)
    s.poll = p
    return id
  }

  pollClosed(id) {
    for (const s of this.#sessions.values()) {
      if (s.poll?.id === id) {
        this.#clearTimer(s.poll.timer)
        s.poll = null
        return true
      }
    }
    return false
  }

  #deliver(cmds, s) {
    for (const c of cmds) {
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

  /** How a command went. One for an unknown or finished command, or from another session, is ignored. */
  result(body) {
    const b = isObject(body) ? body : {}
    const s = this.#touchMod(b.sid, b.host, b.inst)
    const c = typeof b.id === 'string' ? this.#commands.get(b.id) : undefined
    const ignore = (why) => this.#log({ kind: 'result-ignored', id: b.id ?? null, state: b.state ?? null, why, say: `result for ${b.id ?? '?'} ignored: ${why}` })
    if (!c) return ignore('unknown command')
    if (FINAL.has(c.state)) return ignore(`already ${c.state}`)
    if (c.state === 'queued') return ignore('not delivered yet')
    if (!s || s.host !== c.host) return ignore(`it was for ${c.host}`)
    if (b.state === 'waiting') {
      c.state = 'waiting'
      this.#log({ kind: 'command', id: c.id, host: c.host, state: 'waiting', say: `${c.id} waiting` })
      return
    }
    if (FINAL.has(b.state)) return this.#finish(c, b.state, { error: b.error ?? null, detail: b.detail ?? null })
    ignore(`unknown state ${JSON.stringify(b.state)}`)
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
      this.#end(h, 'gone')
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

  /** A Saved Prompt key: queues a prompt for `host`. */
  prompt({ host, text }) {
    if (typeof host !== 'string' || host === '') throw new BadRequest('host must be a session host (local_…)')
    if (typeof text !== 'string' || text === '') throw new BadRequest('text must be a non-empty string')
    const why = this.#cannotSend(host)
    if (why) return this.#pressed({ key: 'prompt', session: host, alert: true, error: why })
    const c = this.#queue(host, { t: 'prompt', text })
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
    this.#log({ kind: 'command', id: c.id, host, state: 'queued', t: c.t, say: `${c.id} queued for ${host}: ${c.t} ${c.t === 'prompt' ? JSON.stringify(c.text) : c.mode}` })
    const s = this.#sessions.get(host)
    if (s?.poll && s.poll.responder.open) {
      const p = s.poll
      s.poll = null
      this.#clearTimer(p.timer)
      this.#deliver([c], s)
      p.responder.send(200, { cmds: [wire(c)] })
    }
    return c
  }

  /** The control interface's own answer to one request, by id: allow, deny or none. */
  answer({ id, decision }) {
    if (!['allow', 'deny', 'none'].includes(decision)) throw new BadRequest('decision must be allow, deny or none')
    const h = this.#held.find((x) => x.id === id)
    if (!h) {
      const r = this.#recent.findLast((x) => x.id === id)
      return { ok: false, id, error: r ? `${id} already ended (${r.end})` : `no request ${id}` }
    }
    const sent = this.#answerHeld(h, decision, 'control')
    const out = { ok: sent, id, decision, kind: h.kind }
    if (!sent) out.error = `${id} had gone`
    if (h.kind === 'ask') out.note = 'the deck itself never answers ask requests'
    return out
  }

  // ---- the registry and the app's records -----------------------------------------------------------------

  /** The hosts the deck lists: registry entries with a hostSessionId, which Code-tab sessions have. */
  get listed() {
    return [...this.#registry.keys()]
  }

  /**
   * A new reading of the registry: the kept fields of every file. Applies release rules 2 to 4.
   *
   * Rule 2's "held from before that change" is judged by what the bridge itself saw: the request was held
   * when a reading showed the session `waiting`. Comparing its arrival with `statusUpdatedAt` instead would
   * mix the bridge's clock with the registry's, which differ in the fixtures (their times are made up).
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
    for (const h of this.#held) if (h.host === null && h.sid && bySid.has(h.sid)) h.host = bySid.get(h.sid)

    for (const [host, f] of next) {
      const p = prev.get(host)
      if (!p) this.#log({ kind: 'registry', change: 'added', host, fields: f, say: `registry + ${host} ${f.status ?? '?'} ${JSON.stringify(f.name ?? '')}` })
      else if (JSON.stringify(p) !== JSON.stringify(f)) this.#log({ kind: 'registry', change: 'changed', host, from: p, to: f, say: `registry ~ ${host} ${p.status ?? '?'} → ${f.status ?? '?'}` })
    }
    for (const [host, p] of prev) {
      if (next.has(host)) continue
      this.#log({ kind: 'registry', change: 'removed', host, last: p, say: `registry - ${host}` })
      for (const h of this.#heldOf(host, p.sessionId)) this.#release(h, 4, 'the session\'s registry file disappeared')
    }
    for (const [host, f] of next) {
      if (prev.get(host)?.status === 'waiting' && f.status !== 'waiting') {
        const mine = this.#heldOf(host, f.sessionId)
        if (mine.length === 1 && mine[0].seenWaiting) this.#release(mine[0], 2, 'the registry shows the session leaving waiting')
      }
    }
    for (const [host, f] of next) {
      if (f.status !== 'idle' || !Number.isFinite(f.statusUpdatedAt)) continue
      for (const h of this.#heldOf(host, f.sessionId)) {
        if (f.statusUpdatedAt > h.arrived) this.#release(h, 3, 'the registry shows the session idle since after it arrived')
      }
    }
    for (const [host, f] of next) {
      if (f.status === 'waiting') for (const h of this.#heldOf(host, f.sessionId)) h.seenWaiting = true
    }
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
    if (reg === 'busy') return 'working'
    if (reg === 'idle' || reg === undefined) {
      const s = this.#sessions.get(host)
      if (s?.turn.failed) return 'failed'
      if (s?.turn.lastEnd === 'aborted') return 'interrupted'
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

  /** With no dial to pick one, the target is the session most recently on screen: the latest attach, else the records' lastFocusedAt. */
  #target(hosts) {
    let best = null
    for (const host of hosts) {
      const at = this.#sessions.get(host)?.attachAt
      if (Number.isFinite(at) && (best === null || at > best.at)) best = { host, at }
    }
    if (best) return best.host
    for (const host of hosts) {
      const at = this.#records.get(host)?.lastFocusedAt
      if (Number.isFinite(at) && (best === null || at > best.at)) best = { host, at }
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
        turn: s.turn, context: s.context, settings: s.settings, onScreen: s.onScreen, attachAt: s.attachAt, ended: s.ended,
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
    for (const h of [...this.#held]) this.#release(h, why, `the bridge was ${why === 'reset' ? 'reset' : 'shut down'}`)
    for (const s of this.#sessions.values()) {
      if (!s.poll) continue
      this.#clearTimer(s.poll.timer)
      if (s.poll.responder.open) s.poll.responder.send(200, { cmds: [] })
      s.poll = null
    }
    for (const c of this.#commands.values()) this.#clearTimer(c.timer)
    this.#sessions.clear()
    this.#commands.clear()
    this.#registry = new Map()
    this.#registryBySid = new Map()
    this.#records.clear()
    this.#recent = []
    this.#lastPress = null
  }

  /** Shutting down: held requests get no decision, so the app's dialogs decide; polls get no commands. */
  close() {
    this.reset('shutdown')
  }
}
