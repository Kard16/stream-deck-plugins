// fingerprint.ts against the protocol's vectors (claude-code/protocol/fixtures/vectors.json, copied into
// fixtures.gen.ts), and canonical() against the reference's recursion. The bridge tests its own implementation
// against the same list, so the two sides fingerprint and summarise a tool call alike.

import { expect, test } from 'claude-code/testing'
import { canonical, fingerprint, summary, toolArgs } from '../hooks/fingerprint'
import { VECTORS } from './fixtures.gen'

/** canonical() as make-fixtures.mjs writes it, recursion and all: the text the mod's must match. */
function reference(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : reference(x))).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).sort().filter(k => o[k] !== undefined)
    return `{${keys.map(k => `${JSON.stringify(k)}:${reference(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** Numbers in [0, 1) from a seed, the same on every run (mulberry32). */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KEYS = ['a', 'B', 'b', '', '10', '9', 'é', 'z\u0000', '\u{1F600}', 'a"b', 'constructor', 'x\ny']
const LEAVES: readonly unknown[] = [null, true, false, 0, -0, 1.5, -12, 1e21, Number.NaN, Number.POSITIVE_INFINITY, '', 'text', 'line\nbreak', '"quoted"', ' ', '\ud800', undefined]

/** A JSON-like value up to `depth` deep, with undefined among its leaves, as a tool call's input may hold. */
function generate(next: () => number, depth: number): unknown {
  const pick = (n: number): number => Math.floor(next() * n)
  const kind = next()
  if (depth === 0 || kind < 0.4) return LEAVES[pick(LEAVES.length)]
  if (kind < 0.7) return Array.from({ length: pick(4) }, () => generate(next, depth - 1))
  const o: Record<string, unknown> = {}
  for (let n = pick(5); n > 0; n--) o[KEYS[pick(KEYS.length)] ?? 'a'] = generate(next, depth - 1)
  return o
}

test("canonical() writes what the reference's recursion writes, for 2,000 generated inputs", () => {
  const next = random(20_261_101)
  const wrong: string[] = []
  for (let i = 0; i < 2000; i++) {
    const input = { v: generate(next, 5) }
    if (canonical(input) !== reference(input)) wrong.push(`${canonical(input)}, not ${reference(input)}`)
  }
  expect(wrong).toEqual([])
})

test('canonical() writes an input nested 20,000 deep: it keeps a stack of its own', () => {
  let deep: unknown = 1
  for (let i = 0; i < 10_000; i++) deep = [{ b: deep, a: undefined }]
  expect(canonical(deep)).toBe(`${'[{"b":'.repeat(10_000)}1${'}]'.repeat(10_000)}`)
})

test(`canonical JSON, fingerprint and summary match all ${VECTORS.length} vectors`, () => {
  const wrong: string[] = []
  for (const v of VECTORS) {
    const name = `${v.tool} ${JSON.stringify(v.input).slice(0, 60)}`
    const c = canonical(v.input)
    const fp = fingerprint(v.tool, v.input)
    const s = summary(v.tool, v.input)
    if (c !== v.canonical) wrong.push(`${name}: canonical ${c}, not ${v.canonical}`)
    if (fp !== v.fp) wrong.push(`${name}: fp ${fp}, not ${v.fp}`)
    if (s !== v.summary) wrong.push(`${name}: summary ${JSON.stringify(s)}, not ${JSON.stringify(v.summary)}`)
  }
  expect(wrong).toEqual([])
  expect(VECTORS.length).toBeGreaterThan(0)
})

test("a tool call's fingerprint leaves out tool.call's own keys, as the PermissionRequest's tool_input has none", () => {
  const input = { file_path: '/Users/me/sandbox/s4.txt', content: 'four' }
  const vector = VECTORS.find(v => v.tool === 'Write' && canonical(v.input) === canonical(input))
  expect(vector).toBeDefined()
  const e = {
    tool: 'Write',
    tool_use_id: 'toolu_01',
    agentId: 'agent-1',
    consent: 'The user pressed "1: Yes"',
    requestMeta: { 'anthropic/sources': '[]' },
    ...input,
  }
  expect(toolArgs(e)).toEqual(input)
  expect(fingerprint('Write', toolArgs(e))).toBe(vector?.fp)
  expect(summary('Write', toolArgs(e))).toBe('s4.txt')
})

test('summaries of what the vectors leave out: missing fields, wrong types and odd URLs fall back to the tool name', () => {
  expect(summary('Bash', {})).toBe('Bash')
  expect(summary('Bash', { command: 42 })).toBe('Bash')
  expect(summary('Bash', { command: '   \nls' })).toBe('Bash')
  expect(summary('Read', { file_path: '/' })).toBe('Read')
  expect(summary('WebFetch', { url: 'https://example.com' })).toBe('example.com')
  expect(summary('WebFetch', { url: 'https://:8443/x' })).toBe('WebFetch')
  expect(summary('AskUserQuestion', { questions: [] })).toBe('AskUserQuestion')
  expect(summary('AskUserQuestion', { questions: ['not an object'] })).toBe('AskUserQuestion')
  expect(summary('mcp__server__', {})).toBe('mcp__server__')
  expect(summary('mcp__a__b__c', {})).toBe('b  c')
  expect(summary('Bash', null)).toBe('Bash')
  expect(summary('x'.repeat(41), {})).toBe(`${'x'.repeat(39)}…`)
  expect(canonical({ b: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}')
})
