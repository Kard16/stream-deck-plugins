// Reads the protocol's fixtures (claude-code/protocol/fixtures/*.jsonl) and vectors.json, read only.
//
// A fixture is one JSON object per line, each with one key naming its kind (PROTOCOL.md, "Fixtures"). The
// reader checks the shape the tools rely on, so a typo in a fixture fails here with its line number rather
// than as a puzzling mismatch halfway through a run.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DIAL_PLANS } from './protocol.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The repository root: claude-code/tools/lib is three levels down. */
export const REPO = path.resolve(HERE, '..', '..', '..')
export const FIXTURES_DIR = path.join(REPO, 'claude-code', 'protocol', 'fixtures')

export const KINDS = Object.freeze(['note', 'setup', 'mod', 'engine', 'plugin', 'reply', 'press', 'registry', 'expect'])
/** The keys a press line can name: the Approve and Deny keys, Saved Prompt, Mode, and a Session Slot dial (2026-11-04). */
export const PRESSES = Object.freeze(['approve', 'deny', 'prompt', 'mode', 'dial'])
/** What a dial line does, one of them: picks for a question, a decision for an approval, or a plan's choice. */
export const DIAL_ACTIONS = Object.freeze(['picks', 'decision', 'plan'])

export class FixtureError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The fixture files in `dir`, sorted by name. */
export function fixtureFiles(dir = FIXTURES_DIR) {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .map((n) => path.join(dir, n))
}

/** A fixture's file from its name (`approve`) or a path to it. */
export function resolveFixture(nameOrPath, dir = FIXTURES_DIR) {
  if (nameOrPath.includes('/') || nameOrPath.endsWith('.jsonl')) return path.resolve(nameOrPath)
  return path.join(dir, `${nameOrPath}.jsonl`)
}

/**
 * Parses a fixture's text. Returns `{name, file, notes, setup, lines, replied}`: `lines` holds every line
 * after `setup`, in order, as `{n, kind, value}` with `n` the 1-based line number in the file; `replied` is
 * the set of labels some `reply` line checks.
 */
export function parseFixture(text, file = '<fixture>') {
  const name = path.basename(file, '.jsonl')
  const fail = (n, why) => {
    throw new FixtureError(`${path.basename(file)}:${n}: ${why}`)
  }
  const notes = []
  const lines = []
  const labels = new Set()
  const replied = new Set()
  let setup = null
  text.split('\n').forEach((raw, i) => {
    const n = i + 1
    if (raw.trim() === '') return
    let obj
    try {
      obj = JSON.parse(raw)
    } catch (err) {
      fail(n, `not JSON (${err.message})`)
    }
    if (!isObject(obj)) fail(n, 'not a JSON object')
    const keys = Object.keys(obj)
    if (keys.length !== 1 || !KINDS.includes(keys[0])) fail(n, `a line has one key, one of ${KINDS.join(', ')}; got ${keys.join(', ') || 'none'}`)
    const kind = keys[0]
    const value = obj[kind]
    if (kind === 'note') {
      if (setup === null) notes.push(String(value))
      lines.push({ n, kind, value })
      return
    }
    if (kind === 'setup') {
      if (setup !== null) fail(n, 'a second setup line')
      if (lines.some((l) => l.kind !== 'note')) fail(n, 'setup must be the first line after the notes')
      if (!isObject(value)) fail(n, 'setup must be an object')
      setup = value
      return
    }
    if (setup === null) fail(n, `${kind} before the setup line`)
    if (!isObject(value)) fail(n, `${kind} must be an object`)
    switch (kind) {
      case 'plugin':
        if (typeof value.method !== 'string' || typeof value.path !== 'string') fail(n, 'plugin needs method and path')
        if (value.as !== undefined) {
          if (typeof value.as !== 'string' || value.as === '') fail(n, 'plugin.as must be a non-empty string')
          if (labels.has(value.as)) fail(n, `label ${value.as} used twice`)
          labels.add(value.as)
        }
        if (value.headers !== undefined && !isObject(value.headers)) fail(n, 'plugin.headers must be an object')
        if (value.raw !== undefined && typeof value.raw !== 'string') fail(n, 'plugin.raw must be a string')
        break
      case 'reply':
        if (typeof value.to !== 'string' || !labels.has(value.to)) fail(n, `reply to ${JSON.stringify(value.to)}, which no earlier plugin line is labeled`)
        if (!Number.isInteger(value.status)) fail(n, 'reply.status must be an integer')
        replied.add(value.to)
        break
      case 'press': {
        const k = Object.keys(value)
        if (k.length !== 1 || !PRESSES.includes(k[0])) fail(n, `press has one key, one of ${PRESSES.join(', ')}`)
        const p = value[k[0]]
        if (!isObject(p)) fail(n, `press.${k[0]} must be an object`)
        if ((k[0] === 'prompt' || k[0] === 'mode' || k[0] === 'dial') && typeof p.session !== 'string') fail(n, `press.${k[0]}.session must be a host`)
        if (k[0] === 'prompt' && typeof p.text !== 'string') fail(n, 'press.prompt.text must be a string')
        if (k[0] === 'mode' && typeof p.mode !== 'string') fail(n, 'press.mode.mode must be a string')
        if (k[0] === 'dial') {
          // PROTOCOL.md, "Fixtures": a Session Slot dial's line picks, decides or chooses for its session's request.
          const what = DIAL_ACTIONS.filter((a) => p[a] !== undefined)
          if (what.length !== 1) fail(n, `press.dial has one of ${DIAL_ACTIONS.join(', ')}; got ${what.join(', ') || 'none'}`)
          if (p.decision !== undefined && p.decision !== 'allow' && p.decision !== 'deny') fail(n, 'press.dial.decision must be allow or deny')
          if (p.plan !== undefined && !DIAL_PLANS.includes(p.plan)) fail(n, `press.dial.plan must be one of ${DIAL_PLANS.join(', ')}`)
          if (p.picks !== undefined && (!isObject(p.picks) || !Object.values(p.picks).every((v) => Array.isArray(v) && v.every((l) => typeof l === 'string')))) {
            fail(n, "press.dial.picks maps each question's text to the labels picked for it")
          }
        }
        break
      }
      case 'registry':
        if (!Number.isInteger(value.pid)) fail(n, 'registry.pid must be an integer')
        break
      case 'mod':
        if (typeof value.on !== 'string') fail(n, 'mod.on must be a string')
        break
      case 'engine':
        if (typeof value.call !== 'string') fail(n, 'engine.call must be a string')
        break
      default:
        break
    }
    lines.push({ n, kind, value })
  })
  if (setup === null) throw new FixtureError(`${path.basename(file)}: no setup line`)
  return { name, file, notes, setup, lines, replied }
}

/** Reads and parses a fixture by name or path. */
export function readFixture(nameOrPath, dir = FIXTURES_DIR) {
  const file = resolveFixture(nameOrPath, dir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new FixtureError(`can't read fixture ${nameOrPath}: ${err.code ?? err.message}`)
  }
  return parseFixture(text, file)
}

/** fixtures/vectors.json: `[{tool, input, canonical, fp, summary}]`. */
export function readVectors(dir = FIXTURES_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'))
}
