// PROTOCOL.md's matching rules for fixtures ("Fixtures", "Matching"), shared by the tools:
//
// - Every field of an expected object must be present and equal; extra fields are allowed.
// - "*" matches any value that's there.
// - Arrays match when they have the same length and each element matches, in order.
// - `at` is never compared.
// - A path with a query matches when the route is equal and each listed parameter is present and equal.
// - Names a fixture gives to values the other side picks bind at their first appearance and hold from then
//   on: the deck's command ids ("c1", "c2"…), the mod's inst. See Bindings.
//
// Every check returns null for a match, or a short reason naming where it differed.

export const ANY = '*'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A value for a reason: JSON, cut short. */
export function show(v) {
  if (v === undefined) return 'nothing'
  const s = JSON.stringify(v)
  return s.length > 120 ? `${s.slice(0, 119)}…` : s
}

const where = (at) => at || 'the value'

/**
 * Why `actual` doesn't match `expected`, or null. Options:
 * - `at`: the path to start reasons from (`body`, `held`…).
 * - `skip`: keys never compared, at any depth. Default `["at"]`.
 * - `hook(at, expected, actual)`: consulted for every value first; it returns undefined to apply the rules
 *   above, or null or a reason to decide. Command-id binding plugs in here.
 */
export function mismatch(expected, actual, opts = {}) {
  const skip = new Set(opts.skip ?? ['at'])
  return walk(expected, actual, opts.at ?? '', skip, opts.hook)
}

function walk(e, a, at, skip, hook) {
  if (hook) {
    const r = hook(at, e, a)
    if (r !== undefined) return r
  }
  if (e === ANY) return a === undefined ? `${where(at)}: missing` : null
  if (Array.isArray(e)) {
    if (!Array.isArray(a)) return `${where(at)}: expected a list of ${e.length}, got ${show(a)}`
    if (a.length !== e.length) return `${where(at)}: expected ${e.length} item(s), got ${a.length}: ${show(a)}`
    for (let i = 0; i < e.length; i++) {
      const r = walk(e[i], a[i], `${at}[${i}]`, skip, hook)
      if (r) return r
    }
    return null
  }
  if (isObject(e)) {
    if (!isObject(a)) return `${where(at)}: expected an object, got ${show(a)}`
    for (const k of Object.keys(e)) {
      if (skip.has(k)) continue
      const p = at ? `${at}.${k}` : k
      if (!Object.hasOwn(a, k)) return `${p}: missing (expected ${show(e[k])})`
      const r = walk(e[k], a[k], p, skip, hook)
      if (r) return r
    }
    return null
  }
  return e === a ? null : `${where(at)}: expected ${show(e)}, got ${show(a)}`
}

export const matches = (expected, actual, opts) => mismatch(expected, actual, opts) === null

/**
 * Why a request's path doesn't match a fixture's, or null: the route must be equal, and each parameter the
 * fixture lists present and equal ("*" for any value); other parameters may be there too.
 */
export function pathMismatch(expected, actual) {
  const e = new URL(expected, 'http://fixture')
  const a = new URL(actual, 'http://fixture')
  if (e.pathname !== a.pathname) return `route: expected ${e.pathname}, got ${a.pathname}`
  for (const [k, v] of e.searchParams) {
    if (!a.searchParams.has(k)) return `query ${k}: missing (expected ${v})`
    if (v !== ANY && a.searchParams.get(k) !== v) return `query ${k}: expected ${v}, got ${a.searchParams.get(k)}`
  }
  return null
}

/**
 * Names a fixture uses for values the other side picks, bound to the real values at their first appearance:
 * kind `cmd` for the deck's command ids, `inst` for the mod's. Binding is one to one in each kind.
 */
export class Bindings {
  #byName = new Map()
  #byReal = new Map()

  /** Binds `name` to `real`, or checks it against an earlier binding. Returns null or a reason. */
  bind(kind, name, real) {
    if (real === undefined) return `${kind} ${name}: missing`
    const nk = `${kind}\0${name}`
    const rk = `${kind}\0${JSON.stringify(real)}`
    if (this.#byName.has(nk)) {
      const bound = this.#byName.get(nk)
      return bound === real ? null : `${kind} ${name} is ${show(bound)} since its first appearance, got ${show(real)}`
    }
    if (this.#byReal.has(rk)) return `${kind} ${show(real)} is already ${this.#byReal.get(rk)}, not ${name}`
    this.#byName.set(nk, real)
    this.#byReal.set(rk, name)
    return null
  }

  /** The real value bound to `name`, or undefined. */
  real(kind, name) {
    return this.#byName.get(`${kind}\0${name}`)
  }
}

/** A `hook` for mismatch() that binds command ids in a poll's answer (`cmds[i].id`). */
export function commandIdHook(bindings) {
  return (at, e, a) => {
    if (typeof e !== 'string' || e === ANY || !/(^|\.)cmds\[\d+\]\.id$/.test(at)) return undefined
    return bindings.bind('cmd', e, a)
  }
}

/**
 * Why the deck's state doesn't match an `expect` line, or null. `deck` is the fake bridge's view
 * (`GET /control/state` → `deck`). `commandId(label)` gives the deck's id for a fixture's command label.
 *
 * `sessions` is exact in any order; `held` is an exact list of partial objects; `status`, `doing`,
 * `context` and `settings` are partial maps by host; `cmds` maps labels to states; `jumped` and `alert` are
 * values. An unknown field fails, so a typo in a fixture can't pass.
 */
export function expectMismatch(expected, deck, { commandId = (label) => label } = {}) {
  for (const [key, want] of Object.entries(expected)) {
    let r = null
    switch (key) {
      case 'sessions': {
        const got = [...(deck.sessions ?? [])].sort()
        const w = [...want].sort()
        if (JSON.stringify(got) !== JSON.stringify(w)) r = `sessions: expected ${show(w)}, got ${show(got)}`
        break
      }
      case 'held':
      case 'status':
      case 'doing':
      case 'context':
      case 'settings':
      case 'jumped':
      case 'alert':
        r = mismatch(want, deck[key], { at: key })
        break
      case 'cmds':
        for (const [label, state] of Object.entries(want)) {
          const id = commandId(label)
          if (id === undefined) {
            r = `cmds.${label}: no command of the deck's is bound to ${label}`
            break
          }
          r = mismatch(state, deck.cmds?.[id], { at: `cmds.${label} (${id})` })
          if (r) break
        }
        break
      default:
        r = `unknown expect field ${key}`
    }
    if (r) return r
  }
  return null
}
