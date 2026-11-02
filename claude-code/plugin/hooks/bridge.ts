// The mod's side of the bridge (PROTOCOL.md, "Routes", "Commands", "Events", "Failure and recovery"): the hello,
// one ordered outbox for events and results, the long poll for commands, and the retries while the bridge is away.
//
// Nothing here holds up a hook: emit() and result() queue and return, and the sends, the poll and the retries run
// on their own, through the engine's fetch and clock (BridgeHost: register.ts's adapter over `$`, or a test's
// fake). A fetch that rejects, with no answer at all, goes once more 100 ms later and quietly: the engine abandons a
// mod's fetches when a turn is interrupted, a deck Deny included, while the bridge is still there. A failed request
// (a second rejection, a 5xx, a request the bridge takes and leaves unanswered 35 s) starts an outage: one log line,
// then hello again after 1, 2, 5, 10 and 30 s and every 30 s after that. Once a hello is answered, the poll starts
// again and the queued requests go out in order, a failed one again with its own seq. The outage ends only when
// the request that began it goes through, so a bridge that answers hello and fails that request again doesn't start
// the waits over. Each hello opens an epoch, and a send or poll left over from an older one changes nothing when it
// settles.

import { changed, type DeckEvent, type Settings } from './events'

export const BRIDGE_URL = 'http://127.0.0.1:47600'
export const PROTOCOL_VERSION = 1
/** The plugin's version for the hello, kept in step with .claude-plugin/plugin.json: `$.plugin` has none. */
export const PLUGIN_VERSION = '0.1.0'
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
 * A fetch that rejects, with no answer at all, goes once more this long after, with no hello and no log line, and
 * only the second one's failure counts (PROTOCOL.md, "Failure and recovery"). The engine abandons a mod's fetches
 * when a turn is interrupted, a deck Deny included, while the bridge is still there (ladder step 4).
 */
export const RETRY_MS = 100
/**
 * A poll answered sooner than this with no command to run, none or only ones it skips, waits out the rest before
 * the next one. The bridge holds a poll until a command comes or the wait ends, so an early empty answer means
 * something is off (two copies of a mod cutting each other's poll short, a confused server), and this keeps it from
 * becoming a busy loop.
 */
export const POLL_MIN_MS = 1000
/** Requests kept while the bridge is away; past this the oldest goes. */
export const MAX_QUEUED = 500
/** Command ids remembered since the last hello, so a command delivered twice runs once. */
const MAX_RAN = 200
/** The most of a reason a log line quotes: an error's text, or the version a bridge says it speaks. */
const MAX_REASON = 200
/** A piece of the token this long or longer is hidden wherever it is: a text cut short can end in one. */
const TOKEN_RUN = 8

export type HttpRequest = { method: string; headers: Record<string, string>; body?: string }
export type HttpAnswer = { status: number; ok: boolean; text: string }
export type Timer = { cancel: () => void }

/** What the bridge needs from the engine. */
export type BridgeHost = {
  fetch: (url: string, init: HttpRequest) => Promise<HttpAnswer>
  /** `$.clock.after`: a mod has no timers of its own. */
  after: (ms: number, fn: () => void) => Timer
  log: (text: string) => void
  token: () => Promise<string | undefined>
  hostId: () => Promise<string | undefined>
  sid: () => Promise<string>
  cwd: () => Promise<string>
  model: () => Promise<string>
  version: () => Promise<string>
}

export type ResultState = 'waiting' | 'done' | 'refused' | 'failed'
export type ResultExtra = { error?: string; detail?: string }
export type Command = Record<string, unknown> & { id: string }

export type Bridge = {
  /** Reads the token and the host id, then says hello; with no token, logs that once and stays quiet. */
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

/**
 * `text` with the token in it put as `<token>`, and with it every run of TOKEN_RUN or more of the token's
 * characters, such as the start of one in a text the engine had already cut short. With `max`, it stops once it
 * has more than that many characters to give back, so a long text costs no more than a short one.
 */
function redact(text: string, token: string, max = Number.POSITIVE_INFINITY): string {
  if (token === '') return text
  // A token shorter than a run is hidden only whole.
  const least = Math.min(TOKEN_RUN, token.length)
  let out = ''
  let copied = 0
  let i = 0
  while (i < text.length && out.length + i - copied <= max) {
    const n = runAt(text, i, token)
    if (n >= least) {
      out += `${text.slice(copied, i)}<token>`
      i += n
      copied = i
    } else i++
  }
  return out + text.slice(copied, i)
}

/** The length of the longest piece of `token` that `text` holds from `at` on. */
function runAt(text: string, at: number, token: string): number {
  let best = 0
  for (let j = 0; j + best < token.length; j++) {
    let n = 0
    while (at + n < text.length && j + n < token.length && text[at + n] === token[j + n]) n++
    if (n > best) best = n
  }
  return best
}

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
   * `once()`, and once more RETRY_MS after it rejects, with no hello and no log line, so that only a second rejection
   * rejects. An answer of any status, or a stall, counts as it comes. The second try starts from the timer, as the
   * backoff's hellos do, apart from whatever the engine abandoned the first with; when epoch `ep` has ended by then,
   * nothing goes out and the first rejection stands.
   */
  function twice<T>(ep: number, once: () => Promise<T>): Promise<T> {
    return once().catch(
      (err: unknown) =>
        new Promise<T>((resolve, reject) => {
          const again = (): void => {
            if (ep === epoch) once().then(resolve, reject)
            else reject(err)
          }
          if (timer(RETRY_MS, again) === undefined) again()
        }),
    )
  }

  /**
   * A hello, event or result in epoch `ep`, settling `undefined` once it has gone STALL_MS unanswered. An answer
   * that comes after that is ignored: the request counts as failed, and goes again after the next hello. A send that
   * rejects goes once more (twice()), with a STALL_MS of its own.
   */
  function send(path: string, body: string, ep: number): Promise<HttpAnswer | undefined> {
    return twice(ep, async () => {
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
    })
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

  async function boot(): Promise<void> {
    ids.token = ((await quiet(host.token)) ?? '').trim()
    ids.host = (await quiet(host.hostId)) ?? ''
    if (ids.token === '') {
      phase = 'off'
      queue.length = 0
      say("DECK_TOKEN isn't set, so this session doesn't talk to the Stream Deck.")
      return
    }
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
      res = await send('/v1/hello', JSON.stringify(body), ep)
    } catch (err) {
      if (ep === epoch) fail('hello', describe(err, ids.token))
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
   * A request on `channel` failed in the current epoch: end the epoch, start an outage with its one log line unless
   * one is on, and hello again after the outage's next wait.
   */
  function fail(channel: Channel, why: string): void {
    if (silent()) return
    epoch++
    phase = 'down'
    if (outage === undefined) {
      outage = channel
      say(`The Stream Deck bridge at ${BRIDGE_URL} isn't answering (${why}); retrying in the background.`)
    }
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000
    attempt++
    retry?.cancel()
    retry = timer(wait, () => {
      retry = undefined
      if (phase === 'down') void hello()
    })
  }

  /**
   * A request on `channel` went through in the current epoch. If a failure there began the outage, the outage is
   * over, and the next one logs and waits from 1 s again. The line resends its failed request first, so the first
   * line request through after a hello is that one, unless MAX_QUEUED piled up behind it and pushed it out.
   */
  function through(channel: Channel): void {
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
          res = await send(item.path, body, ep)
        } catch (err) {
          if (ep === epoch) fail('line', describe(err, ids.token))
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

  /** The long poll: one open at a time, again as soon as one answers (PROTOCOL.md, "Commands"). */
  async function poll(ep: number): Promise<void> {
    while (phase === 'up' && ep === epoch) {
      let floorReached: () => void = () => {}
      const floor = new Promise<void>(resolve => {
        floorReached = resolve
      })
      const soon = timer(POLL_MIN_MS, () => floorReached())
      let res: HttpAnswer
      try {
        res = await twice(ep, () => pollOnce(ep))
      } catch (err) {
        soon?.cancel()
        if (ep === epoch) fail('poll', describe(err, ids.token))
        return
      }
      // Commands a poll brought run even when its epoch has ended, a stalled one's too: the deck counts them as in
      // flight.
      const delivered = res.ok ? deliver(res.text) : 0
      if (ep !== epoch || !res.ok) {
        soon?.cancel()
        if (ep === epoch) fail('poll', `a poll was answered ${res.status}`)
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
