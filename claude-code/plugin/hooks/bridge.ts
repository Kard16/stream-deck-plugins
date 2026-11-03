// The mod's side of the bridge (PROTOCOL.md, "Routes", "Commands", "Events", "Failure and recovery"): the hello,
// one ordered outbox for events and results, the long poll for commands, and the retries while the bridge is away.
//
// Nothing here holds up a hook: emit() and result() queue and return, and the sends, the poll and the retries run
// on their own, through the engine's fetch and clock (BridgeHost: register.ts's adapter over `$`, or a test's
// fake). A fetch that rejects, with no answer at all, is followed 100 ms later by a quick hello, quietly: the engine
// abandons a mod's fetches when a turn is interrupted, a deck Deny included, while the bridge is still there, and a
// deck that restarts can be back within those 100 ms, and must hear hello before anything else. So is a poll answered
// 409 hello first: no instance has said hello for the session, as after the deck restarted, or forgot which had
// (release rule 4, or a current instance that stopped polling), while the mod had nothing open to fail. Until the
// request that failed goes through, a failure of that hello, or of what follows it up to 2 s after the hello's
// answer, a second 409 included, is the second failure. Past those 2 s a rejection or a 409 is a first failure again,
// with a quick hello of its own, so a poll the deck held, then abandoned at an Esc or a Deny, gets one. A failed
// request (that second failure, a 5xx, a request the bridge takes and leaves unanswered 35 s) starts an outage: one
// log line, then hello again after 1, 2, 5, 10 and 30 s and every 30 s after that. Once a hello is answered, the poll
// starts again and the queued requests go out in order, a failed one again with its own seq. The outage ends only
// when the request that began it, or began the quick hello it grew from, goes through, so a bridge that answers hello
// and fails that request again doesn't start the waits over. Each hello opens an epoch, and a send or poll left over
// from an older one changes nothing when it settles.

import { whyQuiet, type Read } from './desktop'
import { changed, type DeckEvent, type Settings } from './events'
import { redact } from './redact'

export const BRIDGE_URL = 'http://127.0.0.1:47600'
export const PROTOCOL_VERSION = 1
/** The plugin's version for the hello, kept in step with .claude-plugin/plugin.json: `$.plugin` has none. */
export const PLUGIN_VERSION = '0.2.1'
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000]
/** How long the bridge may hold a poll (PROTOCOL.md, "Rates"). */
export const POLL_WAIT_S = 20
/**
 * `$.http.fetch` has no timeout, so a request still unanswered this long after it was sent counts as failed
 * (PROTOCOL.md, "Failure and recovery"): the bridge is stuck, or the connection went somewhere without saying so.
 * A poll gets 15 s past its wait.
 */
export const STALL_MS = 35_000
/**
 * A fetch that rejects, with no answer at all, is followed this long after by a hello, with no log line and no
 * outage yet, and so is a poll answered 409 hello first. Only a second failure begins that outage: of the hello, or
 * of what follows it until the failed request goes through, up to QUICK_WINDOW_MS after the hello's answer
 * (PROTOCOL.md, "Failure and recovery").
 * - The engine abandons a mod's fetches when a turn is interrupted, a deck Deny included, while the bridge is still
 *   there (ladder step 4).
 * - `streamdeck restart` brought the deck back 85 ms after it stopped (Phase 4), so the failed request sent again on
 *   its own would have been the new deck's first, with no hello and no version check.
 * - A deck asks for a hello with the 409 while no instance has said hello for the session (PROTOCOL.md, "Identity"):
 *   after it restarted, or forgot which had, while the mod had nothing open to fail. After a poll answered within a
 *   second, as at every turn's end, the mod waits out the rest of that second with no request open.
 */
export const RETRY_MS = 100
/**
 * How long after a quick hello's answer a failure is still the second one (PROTOCOL.md, "Failure and recovery"):
 * until the request whose rejection, or 409, asked for that hello goes through, a failure before the answer or up
 * to this long after it, this long included, begins the outage the quick hello held off, and the outage is that
 * request's. A rejection or a 409 that comes later is a first failure again, with a quick hello of its own; any
 * other failure then begins an outage of its own request's.
 * - A poll the deck holds after a quick hello, then abandoned at an Esc or a Deny, as the engine abandons a mod's
 *   fetches at every interrupt, gets a quick hello and not an outage.
 * - A deck that answers each hello and fails what follows it at once, such as a 409 to the poll after every hello,
 *   still meets the outage and its waits.
 * Timed on the host's clock, from the answer.
 */
export const QUICK_WINDOW_MS = 2000
/**
 * A poll answered sooner than this with no command to run, none or only ones it skips, waits out the rest before
 * the next one. The bridge holds a poll until a command comes, the main loop's turn ends or the wait ends. So an
 * early empty answer means a turn ended just after the poll opened, or something is off (two copies of a mod cutting
 * each other's poll short, a confused server), and this keeps the latter from becoming a busy loop.
 */
export const POLL_MIN_MS = 1000
/** Requests kept while the bridge is away; past this the oldest goes. */
export const MAX_QUEUED = 500
/** Command ids remembered since the last hello, so a command delivered twice runs once. */
const MAX_RAN = 200
/** The most of a reason a log line quotes: an error's text, or the version a bridge says it speaks. */
const MAX_REASON = 200
/** The error the bridge answers a poll with, 409, while no instance has said hello for the session. */
const HELLO_FIRST = 'hello first'

export type HttpRequest = { method: string; headers: Record<string, string>; body?: string }
export type HttpAnswer = { status: number; ok: boolean; text: string }
export type Timer = { cancel: () => void }

/** What the bridge needs from the engine. */
export type BridgeHost = {
  fetch: (url: string, init: HttpRequest) => Promise<HttpAnswer>
  /** `$.clock.after`: a mod has no timers of its own. */
  after: (ms: number, fn: () => void) => Timer
  log: (text: string) => void
  /** DECK_TOKEN. */
  token: () => Promise<string | undefined>
  /** CLAUDE_CODE_HOST_SESSION_ID. */
  hostId: () => Promise<string | undefined>
  /** CLAUDE_CODE_ENTRYPOINT, CLAUDECODE, CLAUDE_CODE_CHILD_SESSION and CLAUDE_CODE_TAGS: with the two above, the gate's. */
  entrypoint: () => Promise<string | undefined>
  claudeCode: () => Promise<string | undefined>
  childSession: () => Promise<string | undefined>
  tags: () => Promise<string | undefined>
  sid: () => Promise<string>
  cwd: () => Promise<string>
  model: () => Promise<string>
  version: () => Promise<string>
}

export type ResultState = 'waiting' | 'done' | 'refused' | 'failed'
export type ResultExtra = { error?: string; detail?: string }
export type Command = Record<string, unknown> & { id: string }

export type Bridge = {
  /**
   * Reads the environment, then says hello in a desktop session of its own (desktop.ts). Anywhere else it logs once
   * which of the gate's tests failed, and sends nothing at all.
   */
  start: () => void
  /** Queues an event, which goes out in its turn with the next seq. */
  emit: (event: DeckEvent) => void
  /** Queues a command's result, in the same line as the events. */
  result: (id: string, state: ResultState, extra?: ResultExtra) => void
  /** Sends the settings in `seen` that differ from what the deck was last told. */
  observe: (seen: Settings) => void
  /** A mode command is done: the deck hears the new mode, changed or not. */
  modeSet: (mode: string) => void
  /** Reads the model, as after each turn, and sends it if it changed. */
  checkModel: () => void
  /** Reads the session id again: /clear and resume go on under a new one. */
  sidMayHaveChanged: () => void
}

type Phase = 'new' | 'boot' | 'off' | 'hello' | 'up' | 'down' | 'stopped'
type Outgoing = { path: '/v1/events' | '/v1/result'; body: Record<string, unknown> }
/** Where a request goes out: the hello, the long poll, or the line of events and results. */
type Channel = 'hello' | 'poll' | 'line'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A reason for the log, at most MAX_REASON characters. The token goes before the cut, so the cut can't halve it. */
function clip(text: string, token: string): string {
  const shown = redact(text, token, MAX_REASON)
  return shown.length > MAX_REASON ? `${shown.slice(0, MAX_REASON - 1)}…` : shown
}

function describe(err: unknown, token: string): string {
  return clip(err instanceof Error ? err.message : typeof err === 'string' ? err : 'no reason given', token)
}

async function quiet<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f()
  } catch {
    return undefined
  }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text)
    return isRecord(v) ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the bridge answered a poll 409 hello first: no instance has said hello for the session since the deck
 * restarted or forgot it (PROTOCOL.md, "Identity"). Any other answer that isn't 2xx is a failure.
 */
function asksForHello(res: HttpAnswer): boolean {
  return res.status === 409 && parse(res.text)?.error === HELLO_FIRST
}

/** Whether a queued request is a settings event that tells the deck a model. */
function tellsModel(item: Outgoing): boolean {
  const events = item.body.events
  return Array.isArray(events) && events.some(x => isRecord(x) && x.t === 'settings' && x.model !== undefined)
}

/** A new id each time the module loads, hot reloads included: the deck takes a new one as a restarted mod. */
function newInst(): string {
  try {
    return crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  } catch {
    return Math.random().toString(36).slice(2, 14)
  }
}

export function createBridge(host: BridgeHost, onCommand: (cmd: Command) => void, inst: string = newInst()): Bridge {
  let phase: Phase = 'new'
  /** Bumped by each hello and each failure: a loop of an older epoch stops, and what it hears changes nothing. */
  let epoch = 0
  /** Failures since the outage began, which pick the next wait. */
  let attempt = 0
  /**
   * The channel whose failed request began the outage, and had its one log line; undefined between outages. The
   * outage and its waits end only when that request goes through (PROTOCOL.md, "Failure and recovery"): a hello
   * answered alone ends only an outage a hello began.
   */
  let outage: Channel | undefined
  /**
   * The channel whose rejected fetch, or poll answered 409 hello first, began a quick hello; undefined when none is
   * on, and always while an outage is. While it's on, any failure is the second one, another 409 included: it begins
   * the outage the rejection held off, and that outage is still the rejected request's. It ends when that request
   * goes through, or once more than QUICK_WINDOW_MS have passed since the quick hello's answer (`quickWindow`).
   */
  let quick: Channel | undefined
  /** The timer that ends the quick hello once QUICK_WINDOW_MS have passed since its answer; undefined till then. */
  let quickWindow: Timer | undefined
  let retry: Timer | undefined
  /** The epoch whose sender is working through the queue, or -1. */
  let sending = -1
  let seq = 0
  const queue: Outgoing[] = []
  const ran = new Set<string>()
  const refusals = new Set<string>()
  /** What the deck was last told of the settings, by the hello or a settings event, in the order it hears them. */
  const known: Settings = {}
  const ids = { sid: '', host: '', token: '' }

  const silent = (): boolean => phase === 'off' || phase === 'stopped'
  const stamp = (): { sid: string; host: string; inst: string } => ({ sid: ids.sid, host: ids.host, inst })
  const auth = (): Record<string, string> => ({ authorization: `Bearer ${ids.token}` })
  const nextPath = (): string =>
    `/v1/next?sid=${encodeURIComponent(ids.sid)}&host=${encodeURIComponent(ids.host)}&inst=${encodeURIComponent(inst)}&wait=${POLL_WAIT_S}`

  /** One debug-log line. The token never reaches it, whole or in pieces, even inside an error's text. */
  function say(line: string): void {
    try {
      host.log(redact(line, ids.token))
    } catch {
      // Logging is best effort.
    }
  }

  function timer(ms: number, fn: () => void): Timer | undefined {
    try {
      return host.after(ms, fn)
    } catch {
      return undefined
    }
  }

  /**
   * A hello, event or result, settling `undefined` once it has gone STALL_MS unanswered. An answer that comes after
   * that is ignored: the request counts as failed, and goes again after the next hello. A send whose fetch rejects
   * rejects too, for its caller to hand to rejected().
   */
  async function send(path: string, body: string): Promise<HttpAnswer | undefined> {
    let stalled: (none: undefined) => void = () => {}
    const unanswered = new Promise<undefined>(resolve => {
      stalled = resolve
    })
    const stall = timer(STALL_MS, () => stalled(undefined))
    try {
      const sent = host.fetch(`${BRIDGE_URL}${path}`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body })
      return await Promise.race([sent, unanswered])
    } finally {
      stall?.cancel()
    }
  }

  async function refreshSid(): Promise<void> {
    const sid = await quiet(host.sid)
    if (sid !== undefined && sid !== '') ids.sid = sid
  }

  function start(): void {
    if (phase !== 'new') return
    phase = 'boot'
    void boot()
  }

  /** A variable's value, undefined when it's unset, or null when the engine wouldn't read it. */
  async function variable(read: () => Promise<string | undefined>): Promise<Read> {
    try {
      return await read()
    } catch {
      return null
    }
  }

  /**
   * The gate (PROTOCOL.md, "Desktop sessions only"): hello only from a desktop session of its own with a token.
   * Anywhere else nothing is sent, ever, and the one log line names each test that failed. What the hooks queued
   * meanwhile goes too.
   */
  async function boot(): Promise<void> {
    const [entrypoint, hostId, claudeCode, childSession, tags, token] = await Promise.all(
      [host.entrypoint, host.hostId, host.claudeCode, host.childSession, host.tags, host.token].map(variable),
    )
    // Set first, so the log line hides the token should another variable hold it.
    ids.token = (token ?? '').trim()
    const why = whyQuiet({
      CLAUDE_CODE_ENTRYPOINT: entrypoint,
      CLAUDE_CODE_HOST_SESSION_ID: hostId,
      CLAUDECODE: claudeCode,
      CLAUDE_CODE_CHILD_SESSION: childSession,
      CLAUDE_CODE_TAGS: tags,
      DECK_TOKEN: token,
    })
    if (why.length > 0) {
      phase = 'off'
      queue.length = 0
      say(`This process doesn't talk to the Stream Deck, which is for desktop sessions only: ${why.join('; ')}.`)
      return
    }
    ids.host = hostId ?? ''
    void hello()
  }

  async function hello(): Promise<void> {
    const ep = ++epoch
    phase = 'hello'
    await refreshSid()
    const [cwd, read, cc] = await Promise.all([quiet(host.cwd), quiet(host.model), quiet(host.version)])
    if (ep !== epoch) return
    // The model as it is now, for a deck that restarted, or none when it can't be read (PROTOCOL.md, "Routes"): an
    // older one isn't passed off as now's. `known` takes it only once the hello is answered.
    const model = read !== undefined && read !== '' ? read : undefined
    const body = {
      v: PROTOCOL_VERSION,
      ...stamp(),
      cwd: cwd ?? '',
      ...(model === undefined ? {} : { model }),
      ...(known.mode === undefined ? {} : { mode: known.mode }),
      ...(known.effort === undefined ? {} : { effort: known.effort }),
      plugin: PLUGIN_VERSION,
      cc: cc !== undefined && cc !== '' ? cc : 'unknown',
    }
    let res: HttpAnswer | undefined
    try {
      res = await send('/v1/hello', JSON.stringify(body))
    } catch (err) {
      if (ep === epoch) rejected('hello', err)
      return
    }
    if (ep !== epoch) return
    if (res === undefined) {
      fail('hello', `the hello had no answer after ${STALL_MS / 1000} s`)
      return
    }
    const answer = parse(res.text)
    if (res.ok && answer?.ok === true) {
      connected(ep, model)
      return
    }
    if (answer?.ok === false && (answer.error === 'version' || (answer.v !== undefined && answer.v !== PROTOCOL_VERSION))) {
      stop(answer.v)
      return
    }
    fail('hello', res.ok ? "the hello wasn't answered ok" : `the hello was answered ${res.status}`)
  }

  function connected(ep: number, model: string | undefined): void {
    phase = 'up'
    through('hello')
    // A quick hello answered, whose rejected request has yet to go through: its window opens now.
    if (quick !== undefined) openWindow()
    // A deck that restarted may hand out its command ids again.
    ran.clear()
    // The deck now has the hello's model, or none if it restarted and the hello had none, until a settings event
    // still queued tells it one read before the hello. With none queued it ends on the hello's; either way the model
    // is read again, and sent if it isn't the one the deck ends on.
    if (!queue.some(tellsModel)) known.model = model
    checkModel()
    void poll(ep)
    pump()
  }

  /**
   * A request on `channel` had no answer at all in the current epoch, its fetch rejected; or the poll was answered
   * 409 hello first, no instance having said hello for the session. Unless an outage or a quick hello is on, that's
   * no failure yet (PROTOCOL.md, "Failure and recovery"): the epoch ends quietly, with no log line and the outage's
   * waits untouched, and hello goes RETRY_MS later, ahead of the request, for a deck that restarted or forgot the
   * session meanwhile. Otherwise it fails as any request does, for the reason `why` gives: the second failure after
   * a quick hello, before its answer or within QUICK_WINDOW_MS of it, a second 409 among them; or one more in an
   * outage. A quick hello past its window is over, so a rejection or a 409 after that has a quick hello of its own.
   */
  function rejected(channel: Channel, why: unknown): void {
    if (silent()) return
    if (outage !== undefined || quick !== undefined) {
      fail(channel, describe(why, ids.token))
      return
    }
    quick = channel
    helloAfter(RETRY_MS)
  }

  /**
   * The quick hello's window opens at its answer (QUICK_WINDOW_MS), on the host's clock, and ends the quick hello
   * when it closes. A failure at its last millisecond is still in it, so the timer runs one past: the clock counts
   * whole milliseconds. None is open now: whatever ended the last quick hello closed its window (endQuick()).
   */
  function openWindow(): void {
    quickWindow = timer(QUICK_WINDOW_MS + 1, () => {
      quickWindow = undefined
      endQuick()
    })
  }

  /**
   * The quick hello is over, whatever ended it, and its window with it: a window left open would end the next quick
   * hello early.
   */
  function endQuick(): void {
    quick = undefined
    quickWindow?.cancel()
    quickWindow = undefined
  }

  /**
   * A request on `channel` failed in the current epoch: end the epoch, start an outage with its one log line unless
   * one is on, and hello again after the outage's next wait.
   */
  function fail(channel: Channel, why: string): void {
    if (silent()) return
    if (outage === undefined) {
      // During a quick hello this is the second failure: the outage begins, and it's the rejected request's.
      outage = quick ?? channel
      endQuick()
      say(`The Stream Deck bridge at ${BRIDGE_URL} isn't answering (${why}); retrying in the background.`)
    }
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000
    attempt++
    helloAfter(wait)
  }

  /** Ends the epoch, and says hello again after `wait`. */
  function helloAfter(wait: number): void {
    epoch++
    phase = 'down'
    retry?.cancel()
    retry = timer(wait, () => {
      retry = undefined
      if (phase === 'down') void hello()
    })
  }

  /**
   * A request on `channel` went through in the current epoch. If a rejection there began the quick hello, or a
   * failure there the outage, that's over: the next rejection has a quick hello of its own, and the next outage logs
   * and waits from 1 s again. The line resends its failed request first, so the first line request through after a
   * hello is that one, unless MAX_QUEUED piled up behind it and pushed it out.
   */
  function through(channel: Channel): void {
    if (quick === channel) endQuick()
    if (outage !== channel) return
    outage = undefined
    attempt = 0
  }

  /** The deck speaks another protocol version: say so once, and stay quiet until the plugin reloads. */
  function stop(theirs: unknown): void {
    phase = 'stopped'
    epoch++
    queue.length = 0
    retry?.cancel()
    const version = clip(typeof theirs === 'string' ? theirs : (JSON.stringify(theirs) ?? 'unknown'), ids.token)
    say(`The Stream Deck bridge speaks protocol version ${version} and this plugin ${PROTOCOL_VERSION}, so this session stops talking to it until the plugin reloads.`)
  }

  function enqueue(item: Outgoing): void {
    if (silent()) return
    queue.push(item)
    // The sender checks it still holds the head before taking it off, so dropping the head here is safe.
    if (queue.length > MAX_QUEUED) queue.shift()
    pump()
  }

  function pump(): void {
    if (phase === 'up' && sending !== epoch && queue.length > 0) void drain(epoch)
  }

  /** Sends the queue one request at a time, each after the last one's answer (PROTOCOL.md, "Events"). */
  async function drain(ep: number): Promise<void> {
    sending = ep
    try {
      while (phase === 'up' && ep === epoch) {
        const item = queue[0]
        if (item === undefined) return
        let body: string
        try {
          body = JSON.stringify({ ...stamp(), ...item.body })
        } catch {
          // Not JSON now, nor ever: drop it rather than block the line.
          queue.shift()
          continue
        }
        let res: HttpAnswer | undefined
        try {
          res = await send(item.path, body)
        } catch (err) {
          if (ep === epoch) rejected('line', err)
          return
        }
        if (ep !== epoch) return
        if (res === undefined) {
          fail('line', `${item.path} had no answer after ${STALL_MS / 1000} s`)
          return
        }
        if (res.status >= 500) {
          fail('line', `${item.path} was answered ${res.status}`)
          return
        }
        // 2xx: delivered. Any other answer under 500, such as a 4xx: refused, and it would be refused again, so it's
        // dropped too. Either way the bridge took it and it's off the line: it went through.
        if (queue[0] === item) queue.shift()
        through('line')
        if (!res.ok) refused(item.path, res.status)
      }
    } finally {
      if (sending === ep) sending = -1
    }
  }

  function refused(path: string, status: number): void {
    const key = `${path} ${status}`
    if (refusals.has(key)) return
    refusals.add(key)
    say(`The Stream Deck bridge refused a ${path} request with ${status}; it was dropped.`)
  }

  /**
   * The long poll: one open at a time, again as soon as one answers (PROTOCOL.md, "Commands"). A 2xx answer's
   * commands run. An answer that comes once its epoch has ended changes nothing past its commands, a 409 hello first
   * included: a hello has opened a newer epoch, or is due to. Otherwise an answer of 409 hello first goes the way of
   * a fetch that rejected, through rejected(): a quick hello, or, while one is on (before its answer, or within
   * QUICK_WINDOW_MS of it), the second failure. Any other answer that isn't 2xx is a failure.
   */
  async function poll(ep: number): Promise<void> {
    while (phase === 'up' && ep === epoch) {
      let floorReached: () => void = () => {}
      const floor = new Promise<void>(resolve => {
        floorReached = resolve
      })
      const soon = timer(POLL_MIN_MS, () => floorReached())
      let res: HttpAnswer
      try {
        res = await pollOnce(ep)
      } catch (err) {
        soon?.cancel()
        if (ep === epoch) rejected('poll', err)
        return
      }
      // Commands a poll brought run even when its epoch has ended, a stalled one's too: the deck counts them as in
      // flight.
      const delivered = res.ok ? deliver(res.text) : 0
      if (ep !== epoch || !res.ok) {
        soon?.cancel()
        if (ep !== epoch) return
        if (asksForHello(res)) rejected('poll', `a poll was answered ${res.status} ${HELLO_FIRST}`)
        else fail('poll', `a poll was answered ${res.status}`)
        return
      }
      through('poll')
      if (delivered === 0 && soon !== undefined) await floor
      else soon?.cancel()
    }
  }

  /**
   * One poll in epoch `ep`. Once it has gone STALL_MS unanswered the epoch fails, but the poll still settles with
   * its answer whenever that comes.
   */
  async function pollOnce(ep: number): Promise<HttpAnswer> {
    let answered = false
    const stall = timer(STALL_MS, () => {
      if (!answered && ep === epoch) fail('poll', `a poll had no answer after ${STALL_MS / 1000} s`)
    })
    try {
      return await host.fetch(`${BRIDGE_URL}${nextPath()}`, { method: 'GET', headers: auth() })
    } finally {
      answered = true
      stall?.cancel()
    }
  }

  /** Hands each new command to onCommand, which runs it on its own; answers how many there were. */
  function deliver(text: string): number {
    const cmds = parse(text)?.cmds
    if (!Array.isArray(cmds)) return 0
    let n = 0
    for (const cmd of cmds) {
      // A command without a string id can't be reported on, so it isn't run.
      if (!isRecord(cmd) || typeof cmd.id !== 'string' || ran.has(cmd.id)) continue
      ran.add(cmd.id)
      if (ran.size > MAX_RAN) {
        const oldest = ran.values().next().value
        if (oldest !== undefined) ran.delete(oldest)
      }
      n++
      try {
        onCommand(cmd as Command)
      } catch {
        // onCommand reports its own failures; nothing may stop the poll.
      }
    }
    return n
  }

  function emit(event: DeckEvent): void {
    if (silent()) return
    seq++
    enqueue({ path: '/v1/events', body: { seq, events: [event] } })
  }

  function result(id: string, state: ResultState, extra: ResultExtra = {}): void {
    enqueue({ path: '/v1/result', body: { id, state, ...extra } })
  }

  function observe(seen: Settings): void {
    if (silent()) return
    const diff = changed(known, seen)
    if (diff !== undefined) emit({ t: 'settings', at: Date.now(), ...diff })
  }

  function modeSet(mode: string): void {
    if (silent()) return
    known.mode = mode
    emit({ t: 'settings', at: Date.now(), mode })
  }

  function checkModel(): void {
    if (silent()) return
    void quiet(host.model).then(model => {
      if (model !== undefined) observe({ model })
    })
  }

  function sidMayHaveChanged(): void {
    if (!silent()) void refreshSid()
  }

  return { start, emit, result, observe, modeSet, checkModel, sidMayHaveChanged }
}
