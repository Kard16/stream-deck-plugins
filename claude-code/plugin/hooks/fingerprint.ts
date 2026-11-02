// A tool call's fingerprint and summary (PROTOCOL.md, "Fingerprints and summaries"). The bridge works out the
// same two from a PermissionRequest's tool_name and tool_input: the fingerprint lets this session's tool.end
// release the held request it was for, and the summary is what the deck shows. A port of the reference in
// claude-code/protocol/make-fixtures.mjs; tests/vectors.test.ts holds it to vectors.json.

/** JSON with no spaces and keys sorted by UTF-16 code units; undefined values left out of objects. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).sort().filter(k => o[k] !== undefined)
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** FNV-1a, 32 bits, over UTF-16 code units. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** `fnv1a32(tool + "\n" + canonical(input))`, as 8 lowercase hex digits. */
export const fingerprint = (tool: string, input: unknown): string =>
  fnv1a32(`${tool}\n${canonical(input)}`).toString(16).padStart(8, '0')

const MAX = 40
const cut = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const lastSegment = (p: string): string | null => p.split('/').filter(x => x !== '').at(-1) ?? null

/** The text after `://` up to the next `/`, `?` or `#`, without any `user@` or `:port`. */
function hostOf(url: string): string | null {
  const i = url.indexOf('://')
  if (i < 0) return null
  let rest = url.slice(i + 3)
  const end = rest.search(/[/?#]/)
  if (end >= 0) rest = rest.slice(0, end)
  rest = rest.slice(rest.lastIndexOf('@') + 1).replace(/:\d*$/, '')
  return rest === '' ? null : rest
}

/** What the deck shows for a call: at most 40 UTF-16 code units, the tool's name when nothing better fits. */
export function summary(tool: string, input: unknown): string {
  const i = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  let s: string | null = null
  switch (tool) {
    case 'Bash': {
      const c = str(i.command)
      s = c === null ? null : str((c.split('\n')[0] ?? '').trim())
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
    case 'AskUserQuestion': {
      const first: unknown = Array.isArray(i.questions) ? i.questions[0] : undefined
      s = first !== null && typeof first === 'object' ? str((first as Record<string, unknown>).question) : null
      break
    }
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

/**
 * The keys of tool.call's `e` that aren't the tool's arguments: `tool`, `tool_use_id` and `consent`
 * (`ToolCallReserved` in the vendored d.ts), the loop's `agentId`, and `requestMeta`, which a hook sets for an
 * MCP server's request. The PermissionRequest's tool_input has none of them.
 */
const RESERVED: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

/** The tool's arguments, which tool.call's `e` spreads beside the reserved keys (`e.command` for Bash). */
export function toolArgs(e: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) args[k] = v
  return args
}
