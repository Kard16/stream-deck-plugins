// fingerprint.ts against the protocol's vectors (claude-code/protocol/fixtures/vectors.json, copied into
// fixtures.gen.ts). The bridge tests its own implementation against the same list, so the two sides fingerprint
// and summarise a tool call alike.

import { expect, test } from 'claude-code/testing'
import { canonical, fingerprint, summary, toolArgs } from '../hooks/fingerprint'
import { VECTORS } from './fixtures.gen'

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
