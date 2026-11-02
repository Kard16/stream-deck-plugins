// The mod's side of the bridge (PROTOCOL.md, "Routes", "Commands", "Events", "Failure and recovery"): the hello,
// one ordered outbox for events and results, the long poll for commands, and the retries while the bridge is away.
//
// Nothing here holds up a hook: emit() and result() queue and return, and the sends, the poll and the retries run
// on their own, through the engine's fetch and clock (BridgeHost: register.ts's adapter over `$`, or a test's
// fake). A failed request (no answer, a 5xx, a poll the bridge leaves hanging) starts an outage: one log line,
// then hello again after 1, 2, 5, 10 and 30 s and every 30 s after that. Once a hello is answered, the poll
// starts again and the queued requests go out in order, a failed one again with its own seq. Each hello opens an
// epoch, and a send or poll left over from an older one changes nothing when it settles.

import { changed, type DeckEvent, type Settings } from './events'

export const BRIDGE_URL = 'http://127.0.0.1:47600'
export const PROTOCOL_VERSION = 1
/** The plugin's version for the hello, kept in step with .claude-plugin/plugin.json: `$.plugin` has none. */
export const PLUGIN_VERSION = '0.1.0'
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000]
/** How long the bridge may hold a poll (PROTOCOL.md, "Rates"). */
export const POLL_WAIT_S = 20
/**
 * `$.http.fetch` has no timeout, so a poll still unanswered this long after the bridge should have answered it
 * counts as a failed request: the bridge is stuck, or the connection went somewhere without saying so.
 */
export const POLL_STALL_MS = (POLL_WAIT_S + 15) * 1000
/**
 * A poll answered empty sooner than this waits out the rest before the next one. The bridge holds a poll until a
 * command comes or the wait ends, so an early empty answer means something is off (two copies of a mod cutting
 * each other's poll short, a confused server), and this keeps it from becoming a busy loop.
 */
export const POLL_MIN_MS = 1000
/** Requests kept while the bridge is away; past this the oldest goes. */
export const MAX_QUEUED = 500
/** Command ids remembered since the last hello, so a command delivered twice runs once. */
const MAX_RAN = 200

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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function describe(err: unknown): string {
  const s = err instanceof Error ? err.message : typeof err === 'string' ? err : 'no reason given'
  return s.length > 200 ? `${s.slice(0, 199)}…` : s
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
  /** Failures since the last answered hello, which pick the next wait. */
  let attempt = 0
  /** Whether this outage has had its log line. */
  let logged = false
  let retry: Timer | undefined
  /** The epoch whose sender is working through the queue, or -1. */
  let sending = -1
  let seq = 0
  const queue: Outgoing[] = []
  const ran = new Set<string>()
  const refusals = new Set<string>()
  /** What the deck was last told of the settings, by the hello or a settings event. */
  const known: Settings = {}
  const ids = { sid: '', host: '', token: '' }

  const silent = (): boolean => phase === 'off' || phase === 'stopped'
  const stamp = (): { sid: string; host: string; inst: string } => ({ sid: ids.sid, host: ids.host, inst })
  const auth = (): Record<string, string> => ({ authorization: `Bearer ${ids.token}` })
  const nextPath = (): string =>
    `/v1/next?sid=${encodeURIComponent(ids.sid)}&host=${encodeURIComponent(ids.host)}&inst=${encodeURIComponent(inst)}&wait=${POLL_WAIT_S}`

  /** One debug-log line. The token never reaches it, even inside an error's text. */
  function say(line: string): void {
    try {
      host.log(ids.token === '' ? line : line.split(ids.token).join('<token>'))
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

  function send(path: string, body: string): Promise<HttpAnswer> {
    return host.fetch(`${BRIDGE_URL}${path}`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body })
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
    const [cwd, model, cc] = await Promise.all([quiet(host.cwd), quiet(host.model), quiet(host.version)])
    if (ep !== epoch) return
    if (model !== undefined && model !== '') known.model = model
    const body = {
      v: PROTOCOL_VERSION,
      ...stamp(),
      cwd: cwd ?? '',
      ...(known.model === undefined ? {} : { model: known.model }),
      ...(known.mode === undefined ? {} : { mode: known.mode }),
      ...(known.effort === undefined ? {} : { effort: known.effort }),
      plugin: PLUGIN_VERSION,
      cc: cc ?? 'unknown',
    }
    let res: HttpAnswer
    try {
      res = await send('/v1/hello', JSON.stringify(body))
    } catch (err) {
      if (ep === epoch) fail(describe(err))
      return
    }
    if (ep !== epoch) return
    const answer = parse(res.text)
    if (res.ok && answer?.ok === true) {
      connected(ep)
      return
    }
    if (answer?.ok === false && (answer.error === 'version' || (typeof answer.v === 'number' && answer.v !== PROTOCOL_VERSION))) {
      stop(answer.v)
      return
    }
    fail(res.ok ? "the hello wasn't answered ok" : `the hello was answered ${res.status}`)
  }

  function connected(ep: number): void {
    phase = 'up'
    attempt = 0
    logged = false
    // A deck that restarted may hand out its command ids again.
    ran.clear()
    void poll(ep)
    pump()
  }

  /** A request failed in the current epoch: end the epoch, log once per outage, and hello again after a wait. */
  function fail(why: string): void {
    if (silent()) return
    epoch++
    phase = 'down'
    if (!logged) {
      logged = true
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

  /** The deck speaks another protocol version: say so once, and stay quiet until the plugin reloads. */
  function stop(theirs: unknown): void {
    phase = 'stopped'
    epoch++
    queue.length = 0
    retry?.cancel()
    say(`The Stream Deck bridge speaks protocol version ${String(theirs ?? 'unknown')} and this plugin ${PROTOCOL_VERSION}, so this session stops talking to it until the plugin reloads.`)
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
        let res: HttpAnswer
        try {
          res = await send(item.path, body)
        } catch (err) {
          if (ep === epoch) fail(describe(err))
          return
        }
        if (ep !== epoch) return
        if (res.status >= 500) {
          fail(`${item.path} was answered ${res.status}`)
          return
        }
        // 2xx: delivered. 4xx: refused, and it would be refused again, so it's dropped too.
        if (queue[0] === item) queue.shift()
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
      let answered = false
      const stall = timer(POLL_STALL_MS, () => {
        if (!answered && ep === epoch) fail(`a poll had no answer after ${POLL_STALL_MS / 1000} s`)
      })
      let floorReached: () => void = () => {}
      const floor = new Promise<void>(resolve => {
        floorReached = resolve
      })
      const soon = timer(POLL_MIN_MS, () => floorReached())
      let res: HttpAnswer
      try {
        res = await host.fetch(`${BRIDGE_URL}${nextPath()}`, { method: 'GET', headers: auth() })
      } catch (err) {
        answered = true
        stall?.cancel()
        soon?.cancel()
        if (ep === epoch) fail(describe(err))
        return
      }
      answered = true
      stall?.cancel()
      // Commands a poll brought run even when its epoch has ended: the deck counts them as in flight.
      const delivered = res.ok ? deliver(res.text) : 0
      if (ep !== epoch || !res.ok) {
        soon?.cancel()
        if (ep === epoch) fail(`a poll was answered ${res.status}`)
        return
      }
      if (delivered === 0 && soon !== undefined) await floor
      else soon?.cancel()
    }
  }

  /** Hands each new command to onCommand, which runs it on its own; answers how many there were. */
  function deliver(text: string): number {
    const cmds = parse(text)?.cmds
    if (!Array.isArray(cmds)) return 0
    let n = 0
    for (const cmd of cmds) {
      // A command without an id can't be reported on, so it isn't run.
      if (!isRecord(cmd) || typeof cmd.id !== 'string' || cmd.id === '' || ran.has(cmd.id)) continue
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
