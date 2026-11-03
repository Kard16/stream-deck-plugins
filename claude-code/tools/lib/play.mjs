// Plays a fixture's plugin side against a bridge, standing in for Claude Code and the mod at once, by the
// deck side's rules in PROTOCOL.md ("Fixtures"):
// - `mod` and `engine` lines are skipped: they're for the plugin side's own runner.
// - `plugin` lines are sent in order, `*` values as they are, with the right token and Host unless the line
//   sets them (`$TOKEN` stands for the token, null leaves a header out). Each answer is awaited, except for
//   /v1/permission and /v1/next, which may be held: a later `reply` line checks those, waiting up to 2 s.
//   Answers to the rest must be 200 or 204 unless a `reply` line says otherwise.
// - `press`, `registry` and `expect` lines go to a driver (drivers.mjs), which knows how to press keys, change
//   the registry and read the deck's state, or to ask a person to. A driver that skips registry lines skips the
//   replies that hang on them too, and reports them: one that waits on a registry change, and one to a poll the
//   deck answers at once only because the registry says busy after the main loop's turn ended.
// The deck's command ids bind to the fixture's names at their first appearance in a reply. An answer to a
// permission request must also be exactly one of PROTOCOL.md's three, whatever its reply line expects, since
// it's what Claude Code acts on, or an error answer when it isn't 2xx (permissionAnswerMismatch).

import { hostHeader, send, within } from './client.mjs'
import { Bindings, commandIdHook, mismatch, show } from './match.mjs'
import { ALLOW, DENY, ROUTES, summary } from './protocol.mjs'

/** A line that didn't go as the fixture says. */
export class PlayFailure extends Error {
  constructor(line, message) {
    super(`line ${line.n} (${line.kind}): ${message}`)
    this.line = line
  }
}

/** Requests that may be held, so the runner doesn't wait for their answers before going on. */
const MAY_HOLD = new Set([ROUTES.permission, ROUTES.next])
const routeOf = (p) => p.split('?')[0]
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const SKIPPED = new Set(['note', 'mod', 'engine'])

/**
 * What Claude Code applies along with a PermissionRequest decision: a rewritten tool input, and rules,
 * directories or a mode for the session or a settings file. PROTOCOL.md: the deck never sends either.
 */
const NEVER_SENT = Object.freeze(['updatedPermissions', 'updatedInput'])

/**
 * What Claude Code reads at the top of any hook's answer: `continue: false` stops the session and
 * `stopReason` says why, `decision: "block"` with a `reason` blocks the event (ClassicResult in
 * claude-code/vendor/mods-api-2.1.309/claude-code.d.ts), and `systemMessage` and `suppressOutput` show and
 * hide text. None of PROTOCOL.md's answers has any of them.
 */
const HOOK_FIELDS = Object.freeze(['continue', 'stopReason', 'decision', 'reason', 'systemMessage', 'suppressOutput'])

/** The first of `keys` anywhere in `v`, as `{at, key, value}`, or null. */
function findKey(v, keys, at) {
  if (v === null || typeof v !== 'object') return null
  for (const [k, x] of Object.entries(v)) {
    const p = Array.isArray(v) ? `${at}[${k}]` : `${at}.${k}`
    if (!Array.isArray(v) && keys.includes(k)) return { at: p, key: k, value: x }
    const found = findKey(x, keys, p)
    if (found) return found
  }
  return null
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
 * Why an answer to a permission request isn't one PROTOCOL.md allows, or null. It holds whatever the reply line
 * expects, since Claude Code acts on the answer: "Transport" exempts it from "unknown fields are ignored".
 * - `updatedPermissions` and `updatedInput` are nowhere in it. A deck that echoed the request's
 *   `permission_suggestions` would otherwise raise the session's mode, or add rules to the user's settings,
 *   at every press, and still pass.
 * - A 2xx answer, the one Claude Code parses, is Allow, Deny or {} exactly: no field of its own, at the top
 *   (Claude Code's own HOOK_FIELDS among them) or inside `hookSpecificOutput`.
 * - Any other is an error answer, which Claude Code doesn't parse: `{"error": "<reason>"}` exactly, as
 *   "Transport" writes it. auth's 405 for `GET /v1/permission` is one.
 */
export function permissionAnswerMismatch(actual, status = 200) {
  const stray = findKey(actual, NEVER_SENT, 'body')
  if (stray) return `${stray.at}: the deck never sends ${stray.key} (PROTOCOL.md), got ${show(stray.value)}`
  if (status < 200 || status > 299) {
    const extra = isObject(actual) ? Object.keys(actual).find((k) => k !== 'error') : undefined
    if (extra !== undefined) return `body.${extra}: not in an error answer, got ${show(actual[extra])} (an error answer is {"error": "<reason>"} exactly)`
    return isObject(actual) && typeof actual.error === 'string' ? null : `body: expected an error answer, {"error": "<reason>"}, got ${show(actual)}`
  }
  if (!isObject(actual)) return `body: expected Allow, Deny or {}, got ${show(actual)}`
  const field = HOOK_FIELDS.find((k) => Object.hasOwn(actual, k))
  if (field) return `body.${field}: Claude Code acts on it, and none of PROTOCOL.md's answers has it, got ${show(actual[field])}`
  const extra = Object.keys(actual).find((k) => k !== 'hookSpecificOutput')
  if (extra !== undefined) return `body.${extra}: not in any of PROTOCOL.md's answers, got ${show(actual[extra])} (an answer is Allow, Deny or {} exactly)`
  if (!Object.hasOwn(actual, 'hookSpecificOutput')) return null
  const out = actual.hookSpecificOutput
  const [name, want] = out?.decision?.behavior === 'deny' ? ['Deny', DENY] : ['Allow', ALLOW]
  const at = 'body.hookSpecificOutput'
  const why = mismatch(want.hookSpecificOutput, out, { at, skip: [] }) ?? extraField(want.hookSpecificOutput, out, at, name)
  return why && `${why} (a decision is Allow or Deny exactly as PROTOCOL.md writes them)`
}

/**
 * Why a reply's body doesn't match, or null; `expected` is undefined when the reply line gives no body, and
 * `actual` when the answer had none that parses. An answer to a permission request, with its `status`, must be
 * one PROTOCOL.md allows first (permissionAnswerMismatch). Then an expected `{}` for it means no decision, so it
 * fails on an answer that carries one: by the general rule an empty object would match any answer, an Allow
 * included, and the fixture would pass on the very thing it rules out.
 */
export function replyMismatch(route, expected, actual, bindings, status = 200) {
  if (route === ROUTES.permission) {
    const why = permissionAnswerMismatch(actual, status)
    if (why) return why
    if (isObject(expected) && Object.keys(expected).length === 0) {
      return isObject(actual) && !Object.hasOwn(actual, 'hookSpecificOutput') ? null : `body: expected no decision ({}), got ${show(actual)}`
    }
  }
  return expected === undefined ? null : mismatch(expected, actual, { at: 'body', hook: commandIdHook(bindings) })
}

/**
 * Plays one parsed fixture (fixtures.mjs). Options:
 * - `url`, `token`: the bridge and its token.
 * - `driver`: againstFake or interactive (drivers.mjs).
 * - `say(text)`: progress lines, for --verbose and for a person.
 * - `replyMs`: how long a reply line waits for a held answer (2 s, PROTOCOL.md); a driver may give longer
 *   after a press (`replyAfterPressMs`), for a person's finger.
 * - `answerMs`: how long it waits for the answers it doesn't let go on without.
 * A driver with `uniqueInst` gets a fresh inst per play, bound to the fixture's (`ia` → `ia-x7k2q9`): the mod
 * picks its inst, and a deck that isn't reset between fixtures would otherwise drop a replay's events as
 * retries of the last play's, since each fixture's seq starts at 1 again.
 * Resolves `{name, ok, error?, checked, skipped, notes}`; a mismatch ends the fixture and is reported, not thrown.
 */
export async function play(fx, { url, token, driver, say = () => {}, replyMs = 2000, answerMs = 5000 } = {}) {
  const bindings = new Bindings()
  const labeled = new Map()
  const open = new Set()
  let sent = 0
  let lastAction = null
  const result = { name: fx.name, ok: true, checked: 0, skipped: [], notes: [] }
  const ctx = { fx, bindings, created: [], notes: result.notes, say, open: () => openHeld() }
  const tag = Math.random().toString(36).slice(2, 8)
  // The fixture's registry files by pid, as its lines have left them, and the hosts whose main loop's turn has ended
  // with no main-loop turn.start since, by the events the bridge took. From that turn end the deck answers a poll at
  // once while the registry says busy (PROTOCOL.md, "Commands"), which a driver that skips registry lines can't make
  // it say.
  const registry = new Map((fx.setup.registry ?? []).filter(isObject).map((f) => [f.pid, { ...f }]))
  const turnEnded = new Set()

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

  /** The permission requests still waiting for an answer, oldest first, as the key would show them. */
  function openHeld() {
    return [...labeled.values()]
      .filter((e) => e.route === ROUTES.permission && !e.handle.settled)
      .map((e) => {
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
      if (isObject(b) && typeof b.inst === 'string') b.inst = instFor(b.inst)
      body = JSON.stringify(b)
    }
    const handle = send(url, { method: p.method, path: target, headers, body })
    sent++
    open.add(handle)
    const drop = () => open.delete(handle)
    handle.answer.then(drop, drop)
    const atOnce = route === ROUTES.next && atOnceAfterTurnEnd(new URL(p.path, 'http://fixture').searchParams.get('host'))
    if (p.as) labeled.set(p.as, { line, handle, route, atOnce })
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
    if (route === ROUTES.events && (r.status === 200 || r.status === 204)) sawEvents(p.body)
  }

  async function checkReply(line) {
    const { to, status, body } = line.value
    const entry = labeled.get(to)
    if (driver.skipsRegistry && lastAction === 'registry') {
      // The answer waits on a registry change, and this driver can't make one.
      result.skipped.push({ line: line.n, reply: to, why: 'it waits on a registry change, which this mode skips' })
      say(`skip: reply ${to}, which waits on the skipped registry change`)
      return
    }
    if (driver.skipsRegistry && entry.atOnce) {
      // The deck holds this poll instead: no registry it reads says the session is busy.
      result.skipped.push({ line: line.n, reply: to, why: 'the deck answers it at once only while the registry says busy after the turn ended, and this mode skips registry lines' })
      say(`skip: reply ${to}, answered at once only while the skipped registry says busy`)
      return
    }
    const waitMs = lastAction === 'press' && driver.replyAfterPressMs ? driver.replyAfterPressMs : replyMs
    let r
    try {
      r = await within(entry.handle.answer, waitMs, `no answer within ${waitMs / 1000} s`)
    } catch (err) {
      throw new PlayFailure(line, `${to}: ${err.message}`)
    }
    if (r.status !== status) throw new PlayFailure(line, `${to}: status: expected ${status}, got ${r.status} ${r.text}`)
    if (body !== undefined && r.json === undefined) throw new PlayFailure(line, `${to}: expected a JSON body, got ${show(r.text)}`)
    // Checked even when the line gives no body: an answer to a permission request must still be PROTOCOL.md's.
    const why = r.json === undefined && entry.route !== ROUTES.permission ? null : replyMismatch(entry.route, body, r.json, bindings, r.status)
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
        case 'press':
          await driver.press(line, { ...ctx, replyNext: nextAction(i) === 'reply' })
          lastAction = 'press'
          break
        case 'registry': {
          const { pid, gone, ...fields } = line.value
          if (gone) registry.delete(pid)
          else registry.set(pid, { ...(registry.get(pid) ?? { pid }), ...fields })
          await driver.registry(line, ctx)
          lastAction = 'registry'
          break
        }
        case 'expect':
          // True when the driver checked the state itself; a person's look isn't counted.
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
