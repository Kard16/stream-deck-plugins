#!/usr/bin/env node
// doctor: for when the Stream Deck stops responding (docs/claude-code/agents-and-wake.md, C6). Run it before
// re-plugging anything. It says whether macOS sees a Stream Deck on USB now, whether the Stream Deck app is running and
// what its log says of the device, the Claude deck plugin's own Device, wake and Bridge lines, and macOS's sleep and
// wake history, over the last --hours; then what to try.
//
// Read only: it runs ioreg, ps and pmset, reads the two logs, and writes nothing. Of other apps it prints only what
// the verdict needs: Elgato's devices, the Stream Deck app's pid and its device and suspend lines, and no serial
// number. Each source is read by a pure function below, so the tests feed it saved outputs; a source it can't read,
// or a command that takes over 30 s, is said so, and the rest still reported. Node 24, no dependencies.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { parseLine } from './idle-report.mjs'
import { LOG_DIR, deckLogs } from './smoke-check.mjs'

/** Elgato's USB vendor id, 0x0fd9. */
export const ELGATO = 4057
/** The Stream Deck +'s USB product id, 0x0084: this repo's deck, known by it whatever its name reads. */
export const STREAM_DECK_PLUS = 132
export const DEFAULT_HOURS = 12
/** Each section shows at most this many lines, the newest. */
export const MAX_LINES = 40
/** How long a command may take: a wedged USB or power daemon, the state doctor is for, can hang ioreg or pmset. */
export const COMMAND_MS = 30_000
export const COMMANDS = Object.freeze({
  ioreg: ['/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w0']],
  ps: ['/bin/ps', ['-axww', '-o', 'pid=,command=']],
  pmset: ['/usr/bin/pmset', ['-g', 'log']],
})
/** The Stream Deck app's logs: the running app's, and the one before, which a restart of the app rotates it to. */
export const streamDeckLogs = (home = os.homedir()) => ['StreamDeck.log', 'StreamDeck.1.log'].map((n) => path.join(home, 'Library', 'Logs', 'ElgatoStreamDeck', n))

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')

// ---- 1. USB: ioreg -p IOUSB -l -w0

const number = (v) => (/^0x[0-9a-f]+$/i.test(v) ? Number.parseInt(v, 16) : Number(v))

/** Whether an Elgato device is a Stream Deck: by `Stream Deck` in its product name, or by the Stream Deck +'s product id. */
export const isStreamDeck = ({ name, product }) => /\bStream ?Deck\b/i.test(name) || product === STREAM_DECK_PLUS

/**
 * The Elgato devices in ioreg's USB plane: each entry starts `+-o <name>@<location>  <class …>` and its properties
 * follow as `"key" = value`. A device is Elgato's by its idVendor, and named by its USB product name. `deck` says
 * whether it's a Stream Deck: Elgato makes microphones, cameras and capture cards too.
 */
export function parseIoreg(text) {
  const entries = []
  for (const line of text.split('\n')) {
    const head = /^[\s|]*\+-o (.+?)(?:@[0-9a-fA-F]+)?\s+<class (\w+)/.exec(line)
    if (head) {
      entries.push({ name: head[1], props: {} })
      continue
    }
    const prop = /^[\s|]*"([^"]+)" = (.*)$/.exec(line)
    if (prop && entries.length) entries.at(-1).props[prop[1]] = prop[2].trim()
  }
  return entries
    .filter((e) => e.props.idVendor !== undefined && number(e.props.idVendor) === ELGATO)
    .map((e) => {
      const quoted = (e.props['USB Product Name'] ?? e.props.kUSBProductString ?? '').replace(/^"|"$/g, '')
      const device = { name: quoted || e.name, product: number(e.props.idProduct ?? 'NaN') }
      return { ...device, deck: isStreamDeck(device) }
    })
}

// ---- 2. The Stream Deck app: ps, and its log

/** The Stream Deck app's pid in `ps -axww -o pid=,command=`'s output, or null when it isn't running. */
export function appPid(text) {
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && /\.app\/Contents\/MacOS\/Stream Deck(?: |$)/.test(m[2])) return Number(m[1])
  }
  return null
}

const SD_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})\s+(\d+)-\d+\s+(\S+)\s+\w{3}\s+(.*)$/
const UNIT = String.raw`@\(\d+\)\[(\d+)\/(\d+)\/[^\]]*\]`

/**
 * What the Stream Deck app's log says of the deck, as `{t, kind, text}` in its order, the serial left out: the app
 * starting, its session suspending (display sleep or lock: it turns the deck off) and resuming, a unit of Elgato's
 * added and its status changing, a key read finding it gone, and the Claude deck plugin connecting and stopping. Lines
 * look like `2026-11-05T21:36:41.298-06:00  27296-6718578 DeviceManager  inf CORE  device status changed
 * @(1)[4057/132/<serial>]: connected`, the app's pid and a thread after the time. A start writes a dozen and more
 * lines from `int main(`, so the app started once for each pid that writes one.
 */
export function parseStreamDeckLog(text) {
  const out = []
  const started = new Set()
  for (const line of text.split('\n')) {
    const m = SD_LINE.exec(line)
    if (!m) continue
    const t = Date.parse(m[1])
    const [, , pid, part, rest] = m
    const add = (kind, what) => out.push({ t, kind, text: what })
    let x
    if (part === 'StreamDeck' && /\bint main\(/.test(rest)) {
      if (!started.has(pid)) add('start', 'the Stream Deck app started')
      started.add(pid)
      continue
    }
    if (/Session -> suspend$/.test(rest)) add('suspend', 'Session -> suspend: the app turned the deck off, at a display sleep or lock')
    else if (/Session -> resume$/.test(rest)) add('resume', 'Session -> resume')
    else if ((x = new RegExp(`ADDED\\s+unit ${UNIT} waiting is over, reason to report now: (\\S+)`).exec(rest)) && Number(x[1]) === ELGATO) add('added', `ADDED unit ${x[1]}/${x[2]} (${x[3]})`)
    else if ((x = new RegExp(`device status changed ${UNIT}: (connected|disconnected)$`).exec(rest)) && Number(x[1]) === ELGATO) add(x[3], `device ${x[1]}/${x[2]} ${x[3]}`)
    else if (/Read Keys\s+Returns: DISCONNECTED$/.test(rest)) add('read-failed', 'Read Keys returns DISCONNECTED')
    else if ((x = /\[com\.karimdhanji\.claude\] (Plugin connected|Plugin finished|Process stopped \([^)]*\))/.exec(rest))) add('plugin', `Claude deck plugin: ${x[1]}`)
  }
  return out
}

/**
 * Whether the app sees the deck now, by the running app's own log: the latest of its device connecting (yes), and its
 * device disconnecting or its session suspending (no). Null with no such line. A resume alone changes nothing: the
 * device comes back about 5 s after it, or doesn't.
 */
export function appSees(events) {
  const last = events.filter((e) => e.kind === 'connected' || e.kind === 'disconnected' || e.kind === 'suspend').at(-1)
  return last === undefined ? null : { sees: last.kind === 'connected', since: last.t, text: last.text }
}

// ---- 3. The Claude deck plugin's log

/** The Claude deck's lines a drop is read by: every Devices line, its wake lines, and the Bridge's at info and above. */
export function deckLines(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const l = parseLine(raw)
    if (l === null) continue
    const keep = l.scope === 'Devices' || (l.scope === 'Claude' && l.message.startsWith('woke up')) || (l.scope === 'Bridge' && l.level !== 'debug' && l.level !== 'trace')
    if (keep) out.push({ t: l.t, text: `${l.scope}: ${l.message}` })
  }
  return out
}

// ---- 4. macOS's sleep and wake: pmset -g log

/**
 * The Sleep, Wake and DarkWake lines of `pmset -g log`, each `2026-11-06 23:10:12 -0600 Sleep <padding, a tab>
 * Entering Sleep state due to 'Idle Sleep': …`. Types that only start alike, as "Wake Requests", aren't these.
 */
export function parsePmset(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (Sleep|Wake|DarkWake)(?:\t|\s{2,})\s*(.*?)\s*$/.exec(line)
    if (m) out.push({ t: Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`), text: `${m[5]}: ${m[6]}` })
  }
  return out
}

// ---- 5. The verdict

/**
 * What to try, from whether macOS sees a deck on USB (`usb`) and whether the Stream Deck app does (`app`), each true,
 * false or null for unknown, and whether the app is running (`running`, the same). macOS not seeing it is below the
 * app, the cable or the monitor's hub, whatever the app says; macOS seeing it and the app not is the app, to open when
 * it isn't running, else to quit and open again; both seeing it is live.
 */
export function verdict(usb, app, running = null) {
  const hub = "the USB link, the Thunderbolt cable or the monitor's USB hub. Try the monitor's input, away and back, or its power, off and on; then re-plug the cable"
  const reopen = 'quit the Stream Deck app and open it again'
  const appNot = running === false ? "the Stream Deck app isn't running: open it" : `the Stream Deck app doesn't: ${reopen}`
  if (usb === false) return { code: 'usb', text: `macOS doesn't see a Stream Deck on USB: ${hub}.` }
  if (usb === true && app === false) return { code: 'app', text: `macOS sees the deck, and ${appNot}.` }
  if (usb === true && app === true) return { code: 'live', text: 'macOS and the Stream Deck app both see the deck: it should be live. If its keys still look stale, send this output.' }
  if (usb === true) return { code: 'app', text: `macOS sees the deck, and what the Stream Deck app sees isn't known: if the keys look stale, ${reopen}.` }
  if (app === false) return { code: 'app', text: `Whether macOS sees the deck isn't known, and ${appNot}. If that doesn't bring it back, re-plug the cable.` }
  if (app === true) return { code: 'live', text: "Whether macOS sees the deck isn't known, and the Stream Deck app does: it should be live. If its keys still look stale, send this output." }
  return { code: 'unknown', text: "Neither macOS's view nor the Stream Deck app's could be read: send this output." }
}

// ---- the report

/**
 * The report from what each source gave: `{text}` or `{error}`, the Stream Deck app's log with `current` too, the
 * running app's own, and the deck's with its `files`. `since` is the window's start (ms). The app's view of the deck
 * comes from `current`, whatever its age; the lines shown are the window's.
 */
export function buildReport(src, { since, hours }) {
  const inWindow = (list) => list.filter((e) => e.t >= since)
  // Every Elgato device is listed, and only a Stream Deck counts as the deck.
  const devices = src.ioreg.error ? [] : parseIoreg(src.ioreg.text)
  const usb = { sees: src.ioreg.error ? null : devices.some((d) => d.deck), devices, error: src.ioreg.error ?? null }
  const pid = src.ps.error ? null : appPid(src.ps.text)
  const app = { running: src.ps.error ? null : pid !== null, pid, sees: null, why: null, events: [], error: src.ps.error ?? null, logError: src.sdLog.error ?? null }
  if (!src.sdLog.error) {
    app.events = inWindow(parseStreamDeckLog(src.sdLog.text))
    const view = appSees(parseStreamDeckLog(src.sdLog.current))
    if (view) [app.sees, app.why] = [view.sees, `${view.text}, at ${iso(view.since)}, its log's last word on it`]
  }
  if (app.running === false) [app.sees, app.why] = [false, "the Stream Deck app isn't running"]
  const deck = src.deckLog.error ? { lines: [], error: src.deckLog.error } : { lines: inWindow(deckLines(src.deckLog.text)), files: src.deckLog.files }
  const sleep = src.pmset.error ? { events: [], error: src.pmset.error } : { events: inWindow(parsePmset(src.pmset.text)) }
  return { window: { since: iso(since), hours }, usb, app, deck, sleep, verdict: verdict(usb.sees, app.sees, app.running) }
}

const tilde = (p) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p)

/** A section's lines, the newest MAX_LINES, each with its time. */
function listed(events, none) {
  if (events.length === 0) return [`   ${none}`]
  const cut = events.length - MAX_LINES
  return [...(cut > 0 ? [`   … ${cut} earlier line(s)`] : []), ...events.slice(Math.max(cut, 0)).map((e) => `   ${iso(e.t)}  ${e.text}`)]
}

export function renderText(r) {
  const out = [`doctor: the last ${r.window.hours} h, from ${r.window.since}; times are UTC`, '']
  const usb = r.usb.error ? `can't tell: ${r.usb.error}`
    : r.usb.sees ? 'macOS sees a Stream Deck now'
    : r.usb.devices.length > 0 ? `macOS sees no Stream Deck on USB now, only other Elgato devices`
    : `macOS sees no Elgato device (vendor ${ELGATO}, 0x0fd9) on USB now`
  out.push(`1. USB: ${usb}`)
  for (const d of r.usb.devices) out.push(`   ${d.name} (${ELGATO}/${d.product})${d.deck ? '' : ', not a Stream Deck'}`)
  out.push('')
  const running = r.app.error ? `can't tell whether it's running: ${r.app.error}` : r.app.running ? `running, pid ${r.app.pid}` : 'not running'
  out.push(`2. The Stream Deck app: ${running}`)
  out.push(`   Does it see the deck? ${r.app.sees === null ? `can't tell: ${r.app.logError ?? 'its log says nothing of a device'}` : `${r.app.sees ? 'yes' : 'no'}: ${r.app.why}`}`)
  if (!r.app.logError) out.push(...listed(r.app.events, 'nothing in its log in the window'))
  out.push('')
  out.push(`3. The Claude deck plugin's Device, woke up and Bridge lines${r.deck.files ? ` (${r.deck.files.map(tilde).join(', ')})` : ''}`)
  out.push(...(r.deck.error ? [`   can't read its log: ${r.deck.error}`] : listed(r.deck.lines, 'none in the window')))
  out.push('')
  out.push("4. macOS's sleep and wake (pmset -g log: Sleep, Wake and DarkWake)")
  out.push(...(r.sleep.error ? [`   can't tell: ${r.sleep.error}`] : listed(r.sleep.events, 'none in the window')))
  out.push('', `5. Verdict: ${r.verdict.text}`)
  return `${out.join('\n')}\n`
}

// ---- the command line

const USAGE = `usage: node claude-code/tools/doctor.mjs [--hours N]

For when the Stream Deck stops responding: run it before re-plugging anything. It says
  1. whether macOS sees a Stream Deck on USB now (ioreg, Elgato's vendor id ${ELGATO});
  2. whether the Stream Deck app is running, and its log's device, suspend, resume and plugin lines;
  3. the Claude deck plugin's Device, woke up and Bridge lines;
  4. macOS's sleep and wake history (pmset -g log: Sleep, Wake and DarkWake);
  5. what to try: the cable or the monitor's hub, the Stream Deck app, or nothing, it should be live.
Read only: it runs ioreg, ps and pmset, each for ${COMMAND_MS / 1000} s at most, reads the two logs, and writes nothing.

  --hours N    the window, the last N hours (default ${DEFAULT_HOURS})
  -h, --help   this text

Times are UTC. Exit status: 0 when it reported, 2 for a usage error.
`

const OPTIONS = { hours: { type: 'string' }, help: { type: 'boolean', short: 'h' } }

const execFileP = promisify(execFile)

/** Why a command or a file failed, in a few words. */
const failure = (e) => (e.code === 'ENOENT' && e.path ? `${tilde(e.path)} isn't there` : e.stderr?.toString().trim().split('\n')[0] || e.message || String(e))

/**
 * The command line. `deps` stand in for the clock, the commands and the folders, for the tests: `now()`, `run(file,
 * args, {timeoutMs})` resolving to `{stdout}`, `commandMs` (each command's time limit, COMMAND_MS), `home` (the Stream
 * Deck app's logs are under it), `logDir` (the Claude deck's logs), `out` and `err`. A command that takes longer is that
 * source's error, and the rest is reported all the same: its process is killed, and doctor doesn't wait for it.
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s))
  const err = deps.err ?? ((s) => process.stderr.write(s))
  const now = deps.now ?? Date.now
  const commandMs = deps.commandMs ?? COMMAND_MS
  const run = deps.run ?? ((file, args, { timeoutMs }) => execFileP(file, args, { maxBuffer: 256 << 20, timeout: timeoutMs, killSignal: 'SIGKILL' }))
  const readFile = (p) => fs.readFileSync(p, 'utf8')
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }))
  } catch (e) {
    err(`doctor: ${e.message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  const hours = values.hours === undefined ? DEFAULT_HOURS : Number(values.hours)
  if (!(hours > 0) || !Number.isFinite(hours)) {
    err(`doctor: --hours must be a number of hours above 0\n\n${USAGE}`)
    return 2
  }
  const since = now() - hours * 3_600_000
  const command = async (name) => {
    const [file, args] = COMMANDS[name]
    const late = `${path.basename(file)} timed out after ${commandMs / 1000} s`
    let timer
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ error: late }), commandMs)
    })
    const ran = (async () => {
      try {
        return { text: (await run(file, args, { timeoutMs: commandMs })).stdout.toString() }
      } catch (e) {
        // execFile's own timeout kills the process with SIGKILL, and says so.
        return { error: e?.killed && e.signal === 'SIGKILL' ? late : `${path.basename(file)} failed: ${failure(e)}` }
      }
    })()
    try {
      return await Promise.race([ran, limit])
    } finally {
      clearTimeout(timer)
    }
  }
  const [ioreg, ps, pmset] = await Promise.all([command('ioreg'), command('ps'), command('pmset')])
  // The running app's log, and the one before it, which a restart of the app leaves the window's start in.
  let sdLog
  const [current, previous] = streamDeckLogs(deps.home)
  try {
    const text = readFile(current)
    let before = ''
    try {
      before = readFile(previous)
    } catch {}
    sdLog = { text: `${before}\n${text}`, current: text }
  } catch (e) {
    sdLog = { error: `can't read ${tilde(current)}: ${failure(e)}` }
  }
  let deckLog
  try {
    const logs = deckLogs(deps.logDir ?? LOG_DIR, since)
    deckLog = { text: logs.map((l) => l.text).join('\n'), files: logs.map((l) => l.file) }
  } catch (e) {
    deckLog = { error: failure(e) }
  }
  out(renderText(buildReport({ ioreg, ps, pmset, sdLog, deckLog }, { since, hours })))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
