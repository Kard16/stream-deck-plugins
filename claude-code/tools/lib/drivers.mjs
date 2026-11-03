// What fake-claude does with the lines only the deck side can act on: press, registry and expect.
//
// - againstFake: the fake bridge does it all. Presses go to its /control/ routes, registry and records files
//   are written into the folders it reads (only ever fake ones: see checkDir), and expect lines are checked
//   against its state, retried for up to 1 s as PROTOCOL.md allows.
// - interactive: a person at the real deck. Approve and Deny presses are printed for them to make, and registry
//   lines are skipped (the real deck reads the real registry, which nothing here writes). An Approve or Deny press
//   with nothing of fake-claude's held is skipped, so the person never presses on another session's request: a deck
//   that takes the hooks' requests only from sessions its registry confirms answers the fixture's {} at once
//   (PROTOCOL.md, "Desktop sessions only"). Saved Prompt and Mode presses are always skipped: they go to the session
//   picked on the Sessions dial, and no real deck lists a fixture's session, so the dial would be on one of the user's
//   own, and the press would send it the fixture's prompt or mode change. Expect lines are always skipped too: they
//   are the fixture's deck's state, and nothing of a fixture's session shows on a real deck. Each skip is reported.

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
 * The Mac keeps the user's files on a volume mounted at /System/Volumes/Data and firmlinks /Users, /private and the
 * rest into it, so one folder has two real paths: realpath keeps whichever it's given. Paths are compared with that
 * prefix taken off.
 */
const DATA_VOLUME = '/System/Volumes/Data'
const unfirm = (p) => (p === DATA_VOLUME ? '/' : p.startsWith(`${DATA_VOLUME}/`) ? p.slice(DATA_VOLUME.length) : p)

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
    if (inside(unfirm(real), unfirm(realOr(p))) || inside(unfirm(path.resolve(dir)), unfirm(p))) {
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

/**
 * What a person should press, in words: Approve or Deny, the only presses the interactive driver asks for. Saved
 * Prompt and Mode presses are skipped, never described (interactive's press).
 */
export function describePress(press, open) {
  const [key] = Object.keys(press)
  const shown = open.length ? `${open[0].host ?? '?'}: ${open[0].tool} ${open[0].summary}` : 'nothing fake-claude sent'
  switch (key) {
    case 'approve':
      return `press Approve. The key should show the oldest held request: ${shown}.`
    case 'deny':
      return `press Deny. The key should show the oldest held request: ${shown}.`
    default:
      throw new Error(`no press of ${key} is asked of a person`)
  }
}

/**
 * Why the interactive driver skips every expect line. An expect line is the fixture's deck's state, and a real deck
 * shows nothing of a fixture's session: it lists only its registry's sessions, which never include a fixture's, it
 * holds none of the fixture's requests, as it answers their hooks {} at once, and no Saved Prompt or Mode press
 * queues a command of the fixture's. So its sessions, statuses, settings, held requests, commands and keys are
 * about what the deck doesn't show, and a person asked to check them could only report the deck's own sessions.
 */
export const EXPECT_SKIPPED = "a real deck shows nothing of a fixture's session: it lists only its registry's sessions, holds none of the fixture's requests, and has no command of the fixture's, since no Saved Prompt or Mode press is made"

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
      if (sessions.length) ui.show(`The fixture's sessions: ${sessions.join('; ')}. Registry lines are skipped: the deck reads the real registry, so it won't list them, and nothing of them shows on it. Expect lines are skipped too.`)
    },

    /**
     * Gives the deck a moment to take a held request, since there's no control route to ask. Whether it holds one for
     * a press is another matter, which the press decides by play.mjs's HOOK_AT_ONCE_MS (ctx.held).
     */
    async taken() {
      await sleep(100)
    },

    async press(line, ctx) {
      const [key] = Object.keys(line.value)
      if (key === 'prompt' || key === 'mode') {
        // A person is never asked to send a fixture's prompt or mode change: no real deck lists the fixture's
        // session, so the Sessions dial could only be on one of the user's own.
        const what = key === 'prompt' ? 'prompt' : 'mode change'
        ctx.skip({ line: line.n, press: key, why: `a ${key === 'prompt' ? 'Saved Prompt' : 'Mode'} press goes to the session picked on the Sessions dial, and no real deck lists the fixture's session, so it would send the fixture's ${what} to one of your own sessions` })
        ui.show(`skip: press ${key}: it would send the fixture's ${what} to whichever of your own sessions the dial is on`)
        return
      }
      // What fake-claude sent that the deck holds: no answer within HOOK_AT_ONCE_MS of sending it, by fake-claude's own
      // clock, however long the deck's answer at once took to come.
      const open = await ctx.held()
      if ((key === 'approve' || key === 'deny') && open.length === 0) {
        // Approve and Deny act on the oldest held request, whosever it is: with none of fake-claude's held, a press
        // could only land on a real session's.
        ctx.skip({ line: line.n, press: key, why: "nothing fake-claude sent is held, so a press could only land on another session's request: the deck answers the fixture's hook requests {} at once when no registry it reads confirms their session" })
        ui.show(`skip: press ${key}: nothing fake-claude sent is held`)
        return
      }
      ui.show(`PRESS: ${describePress(line.value, open)}`)
      if (ctx.replyNext) ui.show(`  waiting up to ${Math.round(pressTimeoutMs / 1000)} s for the deck's answer…`)
      else await ui.ask('  Press Enter once you have. ')
    },

    async registry(line) {
      ui.show(`skip: registry ${JSON.stringify(line.value)}`)
    },

    /** Skips the line and reports it (EXPECT_SKIPPED): nothing is asked of the person. */
    async expect(line, ctx) {
      ctx.skip({ line: line.n, expect: Object.keys(line.value), why: EXPECT_SKIPPED })
      ui.show(`skip: expect ${JSON.stringify(line.value)}: a real deck shows nothing of a fixture's session`)
      return false
    },

    async end() {},
  }
}
