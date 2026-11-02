// What fake-claude does with the lines only the deck side can act on: press, registry and expect.
//
// - againstFake: the fake bridge does it all. Presses go to its /control/ routes, registry and records files
//   are written into the folders it reads (only ever fake ones: see checkDir), and expect lines are checked
//   against its state, retried for up to 1 s as PROTOCOL.md allows.
// - interactive: a person does it on the real deck. Presses are printed for them to make, registry lines
//   are skipped (the real deck reads the real registry, which nothing here writes), and expect lines are
//   shown for them to check by eye.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { controlClient } from './client.mjs'
import { expectMismatch } from './match.mjs'
import { PlayFailure } from './play.mjs'
import { SAFE_HOST } from './registry.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The homes whose Claude folders are protected: $HOME's, and the account's own from the user database, which
 * a $HOME pointed elsewhere doesn't move.
 */
function homes() {
  const out = [os.homedir()]
  try {
    out.push(os.userInfo().homedir)
  } catch {}
  return [...new Set(out.filter(Boolean))]
}

/** The Claude app's own folders. Fixture files are never written inside them. */
export const PROTECTED = Object.freeze(homes().flatMap((home) => [path.join(home, '.claude'), path.join(home, 'Library', 'Application Support', 'Claude')]))

const inside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * The real path, by the system's own realpath: on a case-insensitive volume it also gives each name its case on
 * disk, so `~/.CLAUDE` compares as `~/.claude`, which Node's own realpathSync doesn't do. The path as it is
 * when it doesn't exist.
 */
const realOr = (p) => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/** A folder fake-claude may write fixture files into: one that exists and isn't, or isn't in, the app's. */
export function checkDir(dir, what) {
  let real
  try {
    real = fs.realpathSync.native(dir)
  } catch {
    throw new Error(`the fake bridge's ${what} folder ${dir} doesn't exist: start it with --${what}-dir set to an empty folder`)
  }
  for (const p of PROTECTED) {
    if (inside(real, realOr(p)) || inside(path.resolve(dir), p)) {
      throw new Error(`won't write fixture files into ${dir}, inside ${p}: start the fake bridge with --registry-dir and --records-dir set to empty folders of its own`)
    }
  }
  return real
}

/** The JSON files under `dir`, down to `depth` folders (the records' `<account>/<org>/<host>.json` is 3). */
function jsonFiles(dir, depth) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) out.push(e.name)
    else if (e.isDirectory() && depth > 1) out.push(...jsonFiles(path.join(dir, e.name), depth - 1).map((f) => path.join(e.name, f)))
  }
  return out
}

/** Writes JSON beside the file and renames it into place, so a reading never sees half of it. */
function writeJson(file, obj) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`)
  fs.renameSync(tmp, file)
}

/** The deck's id for a command label: bound at a reply, else the label's place among the presses' commands. */
function commandId(label, ctx) {
  const bound = ctx.bindings.real('cmd', label)
  if (bound !== undefined) return bound
  const m = /^c(\d+)$/.exec(label)
  return m ? ctx.created[Number(m[1]) - 1] : undefined
}

/** Plays fixtures against the fake bridge at `url`, through its control routes. */
export function againstFake({ url, token, expectMs = 1000, takenMs = 2000 }) {
  const control = controlClient(url, token)
  let dirs = null
  const written = new Set()
  const madeDirs = []
  const registry = new Map()

  async function call(method, route, body) {
    const r = await control.call(method, route, body)
    if (r.status >= 400) throw new Error(`${route} answered ${r.status}: ${JSON.stringify(r.json)}`)
    return r.json
  }

  function removeWritten() {
    for (const f of written) fs.rmSync(f, { force: true })
    written.clear()
    registry.clear()
    // Only the folders it made, deepest first, and only once they're empty.
    for (const d of madeDirs.splice(0).reverse()) {
      try {
        fs.rmdirSync(d)
      } catch {}
    }
  }

  function writeRegistry(fields) {
    const file = path.join(dirs.registry, `${fields.pid}.json`)
    writeJson(file, fields)
    written.add(file)
    registry.set(fields.pid, fields)
  }

  function writeRecord(host, record) {
    if (!SAFE_HOST.test(host)) throw new Error(`a record for ${JSON.stringify(host)}, which isn't a host id`)
    let dir = dirs.records
    for (const part of ['fixture-account', 'fixture-org']) {
      dir = path.join(dir, part)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir)
        madeDirs.push(dir)
      }
      // Each folder by its real path too, before anything goes in it: a link in the records folder can't lead
      // into the app's.
      checkDir(dir, 'records')
    }
    const file = path.join(dir, `${host}.json`)
    writeJson(file, record)
    written.add(file)
  }

  return {
    name: 'against-fake',

    async begin(fx) {
      const state = await call('GET', '/control/state')
      dirs = { registry: checkDir(state.dirs.registry, 'registry'), records: checkDir(state.dirs.records, 'records') }
      removeWritten()
      // With its own files gone, anything left is someone else's: perhaps the app's, reached some other way.
      for (const [what, depth] of [['registry', 1], ['records', 3]]) {
        const foreign = jsonFiles(dirs[what], depth)
        if (foreign.length) throw new Error(`the fake bridge's ${what} folder ${dirs[what]} holds files fake-claude didn't write (${foreign.join(', ')}): give it an empty one`)
      }
      await call('POST', '/control/reset')
      for (const entry of fx.setup.registry ?? []) writeRegistry({ ...entry })
      for (const [host, record] of Object.entries(fx.setup.records ?? {})) writeRecord(host, record)
      await call('POST', '/control/rescan')
    },

    /** Waits until the bridge has taken `sent` requests since the reset: held, queued or answered. */
    async taken(sent) {
      const deadline = Date.now() + takenMs
      for (;;) {
        const { taken } = await call('GET', '/control/taken')
        if (taken >= sent) return
        if (Date.now() >= deadline) throw new Error(`the bridge took ${taken} of ${sent} requests within ${takenMs / 1000} s`)
        await sleep(5)
      }
    },

    async press(line, ctx) {
      const [key] = Object.keys(line.value)
      const p = line.value[key]
      const r =
        key === 'prompt' ? await call('POST', '/control/prompt', { host: p.session, text: p.text })
        : key === 'mode' ? await call('POST', '/control/mode', { host: p.session, mode: p.mode })
        : await call('POST', `/control/${key}`, {})
      if (r.cmd) ctx.created.push(r.cmd)
      ctx.say(`press ${key}: ${r.alert ? `alert (${r.error})` : r.cmd ? `queued ${r.cmd}` : r.jumped ? `jumped to ${r.jumped}` : `${r.answered} ${r.request}`}`)
    },

    async registry(line, ctx) {
      const { pid, gone, ...fields } = line.value
      const file = path.join(dirs.registry, `${pid}.json`)
      if (gone) {
        fs.rmSync(file, { force: true })
        registry.delete(pid)
      } else {
        writeRegistry({ ...(registry.get(pid) ?? { pid }), ...fields })
      }
      // Lets the bridge's reading see the change before the next line, as the deck side's runner must.
      await call('POST', '/control/rescan')
      ctx.say(`registry ${pid}: ${gone ? 'gone' : JSON.stringify(fields)}`)
    },

    async expect(line, ctx) {
      const deadline = Date.now() + expectMs
      for (;;) {
        const state = await call('GET', '/control/state')
        const why = expectMismatch(line.value, state.deck, { commandId: (label) => commandId(label, ctx) })
        if (!why) {
          ctx.say(`✓ expect ${JSON.stringify(line.value)}`)
          return true
        }
        if (Date.now() >= deadline) throw new PlayFailure(line, `expect: ${why}`)
        await sleep(20)
      }
    },

    async end() {
      if (dirs) removeWritten()
    },
  }
}

// ---- interactive -----------------------------------------------------------------------------------------

/** A person at a terminal: `show(text)` prints, `ask(question)` resolves to their line ('' at the end of input). */
export function terminalUi({ input = process.stdin, output = process.stdout } = {}) {
  let rl = null
  let ended = false
  const lines = []
  const waiting = []
  const start = () => {
    if (rl) return
    rl = readline.createInterface({ input, terminal: false })
    rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)))
    rl.on('close', () => {
      ended = true
      while (waiting.length) waiting.shift()('')
    })
  }
  return {
    show: (text) => output.write(`${text}\n`),
    ask(question) {
      start()
      output.write(question)
      if (lines.length) return Promise.resolve(lines.shift())
      if (ended) return Promise.resolve('')
      return new Promise((resolve) => waiting.push(resolve))
    },
    close: () => rl?.close(),
  }
}

/** What a person should press, in words. */
export function describePress(press, open) {
  const [key] = Object.keys(press)
  const p = press[key]
  const shown = open.length ? `${open[0].host ?? '?'}: ${open[0].tool} ${open[0].summary}` : 'nothing fake-claude sent'
  switch (key) {
    case 'approve':
      return `press Approve. The key should show the oldest held request: ${shown}.`
    case 'deny':
      return `press Deny. The key should show the oldest held request: ${shown}.`
    case 'prompt':
      return `pick ${p.session} on the Sessions dial, then press a Saved Prompt key whose text is ${JSON.stringify(p.text)}.`
    case 'mode':
      return `pick ${p.session} on the Sessions dial, then set its mode to ${p.mode} with the Mode dial or key.`
    default:
      return `press ${key}: ${JSON.stringify(p)}`
  }
}

const KEY_STATES = { queued: 'waiting', delivered: 'waiting', waiting: 'waiting', done: 'sent', refused: 'refused', failed: 'refused' }

/** What a person should see on the deck for an `expect` line, one sentence per field. */
export function describeExpect(expected) {
  const out = []
  for (const [key, want] of Object.entries(expected)) {
    switch (key) {
      case 'sessions':
        out.push(want.length ? `the Sessions dial lists ${want.join(', ')} (the real registry decides this one)` : 'the Sessions dial lists none of the fixture\'s sessions')
        break
      case 'held':
        out.push(want.length ? `${want.length} request(s) held; the Approve key shows ${want[0].host}: ${want[0].tool} ${want[0].summary}${want[0].kind === 'ask' ? ' (needs you)' : ''}` : 'nothing held: the Approve and Deny keys are idle')
        break
      case 'status':
        for (const [host, s] of Object.entries(want)) out.push(`${host} shows ${s}`)
        break
      case 'doing':
        for (const [host, s] of Object.entries(want)) out.push(s === null ? `${host} shows no current tool` : `${host} is working on ${s}`)
        break
      case 'context':
        for (const [host, n] of Object.entries(want)) out.push(`${host} shows ${n}% context`)
        break
      case 'settings':
        for (const [host, s] of Object.entries(want)) out.push(`${host} shows ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(', ')}`)
        break
      case 'cmds':
        for (const [label, s] of Object.entries(want)) out.push(`the key that sent ${label} shows ${KEY_STATES[s] ?? s} (${s})`)
        break
      case 'jumped':
        out.push(`Claude came forward on ${want} (an id the app doesn't know lands on the Code home)`)
        break
      case 'alert':
        out.push(want ? 'the key showed an alert' : 'the key showed no alert')
        break
      default:
        out.push(`${key}: ${JSON.stringify(want)}`)
    }
  }
  return out
}

/** Plays fixtures with a person at the real deck. */
export function interactive({ ui = terminalUi(), pressTimeoutMs = 300_000 } = {}) {
  return {
    name: 'interactive',
    skipsRegistry: true,
    /** The real deck isn't reset between fixtures: each play's mod is a new instance, as after a reload. */
    uniqueInst: true,
    replyAfterPressMs: pressTimeoutMs,

    async begin(fx) {
      ui.show(`\n=== ${fx.name}`)
      for (const note of fx.notes) ui.show(note)
      const sessions = (fx.setup.registry ?? []).map((r) => `${r.hostSessionId} "${r.name ?? ''}" (${r.status ?? '?'})`)
      if (sessions.length) ui.show(`The fixture's sessions: ${sessions.join('; ')}. Registry lines are skipped: the deck reads the real registry, so it won't list them, and what it shows about them can differ.`)
    },

    /** Gives the deck a moment to take a held request, since there's no control route to ask. */
    async taken() {
      await sleep(100)
    },

    async press(line, ctx) {
      ui.show(`PRESS: ${describePress(line.value, ctx.open())}`)
      if (ctx.replyNext) ui.show(`  waiting up to ${Math.round(pressTimeoutMs / 1000)} s for the deck's answer…`)
      else await ui.ask('  Press Enter once you have. ')
    },

    async registry(line) {
      ui.show(`skip: registry ${JSON.stringify(line.value)}`)
    },

    async expect(line, ctx) {
      ui.show('CHECK on the deck:')
      for (const s of describeExpect(line.value)) ui.show(`  - ${s}`)
      const saw = (await ui.ask('  Enter if it matches, or type what you see and Enter: ')).trim()
      if (saw) ctx.notes.push({ line: line.n, expected: line.value, saw })
      return false
    },

    async end() {},
  }
}
