// The bridge protocol's constants, and its fingerprint and summary (claude-code/protocol/PROTOCOL.md, v1).
//
// canonical, fnv1a32, fingerprint and summary are copies of the reference implementation in
// claude-code/protocol/make-fixtures.mjs, not imports of it: that file rewrites the fixtures as soon as it's
// loaded. test/protocol.test.mjs checks the copies against fixtures/vectors.json, so a drift shows there.

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

/** Bodies above this get 413. */
export const MAX_BODY = 8 * 1024 * 1024

/** The long poll's `wait`, in seconds: 0 answers at once, and 20 is both the default and the most. */
export const MAX_WAIT_S = 20

/** A command answered to a poll is in flight this long at most; then it counts as failed, "no result". */
export const IN_FLIGHT_MS = 60_000

/** The app's own tool that changes a session's mode. The deck's mode command calls it for `self`. */
export const MODE_TOOL = 'mcp__ccd_session_mgmt__set_session_permission_mode'

/** Requests for these are held for display only: the deck never answers them, and a press jumps. */
export const ASK_TOOLS = Object.freeze(['AskUserQuestion', 'ExitPlanMode'])

/** The modes a mode command may ask for. Never bypassPermissions. */
export const MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto'])

/** A command's final states; `waiting` comes before them, and only for prompts. */
export const FINAL_STATES = Object.freeze(['done', 'refused', 'failed'])

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v !== null && typeof v === 'object') deepFreeze(v)
  return Object.freeze(o)
}

/** The three answers to a permission request. The deck never sends updatedPermissions or updatedInput. */
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

// ---- fingerprints and summaries (PROTOCOL.md, "Fingerprints and summaries") ----------------------------

/** JSON with no spaces and sorted keys; undefined values left out of objects. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort().filter((k) => v[k] !== undefined)
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** FNV-1a over UTF-16 code units. */
export function fnv1a32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

export const fingerprint = (tool, input) => fnv1a32(`${tool}\n${canonical(input)}`).toString(16).padStart(8, '0')

const MAX = 40
const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s)
const str = (v) => (typeof v === 'string' && v !== '' ? v : null)
const lastSegment = (p) => p.split('/').filter((x) => x !== '').at(-1) ?? null

function hostOf(url) {
  const i = url.indexOf('://')
  if (i < 0) return null
  let rest = url.slice(i + 3)
  const end = rest.search(/[/?#]/)
  if (end >= 0) rest = rest.slice(0, end)
  rest = rest.slice(rest.lastIndexOf('@') + 1).replace(/:\d*$/, '')
  return rest === '' ? null : rest
}

/** What the deck shows for a call: at most 40 UTF-16 code units. */
export function summary(tool, input) {
  const i = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  let s = null
  switch (tool) {
    case 'Bash': {
      const c = str(i.command)
      s = c === null ? null : str(c.split('\n')[0].trim())
      break
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const p = str(i.file_path)
      s = p === null ? null : lastSegment(p)
      break
    }
    case 'NotebookEdit': {
      const p = str(i.notebook_path)
      s = p === null ? null : lastSegment(p)
      break
    }
    case 'Glob':
    case 'Grep':
      s = str(i.pattern)
      break
    case 'WebFetch': {
      const u = str(i.url)
      s = u === null ? null : hostOf(u)
      break
    }
    case 'WebSearch':
      s = str(i.query)
      break
    case 'Agent':
    case 'Task':
      s = str(i.description) ?? str(i.subagent_type)
      break
    case 'AskUserQuestion':
      s = Array.isArray(i.questions) ? str(i.questions[0]?.question) : null
      break
    case 'ExitPlanMode':
      s = 'Plan ready'
      break
    default:
      if (tool.startsWith('mcp__')) {
        const name = tool.split('__').slice(2).join('__')
        s = name === '' ? null : name.replaceAll('_', ' ')
      }
  }
  return cut(s ?? tool)
}
