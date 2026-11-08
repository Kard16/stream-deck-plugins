// doctor.mjs on saved outputs written by hand in the shapes the real ones have: ioreg's USB plane with and without an
// Elgato device, ps, the Stream Deck app's log (its shape from this Mac's, with a made-up serial), the Claude deck's log,
// and pmset's log. Nothing here runs ioreg, ps or pmset, or reads this Mac's logs: main() gets a stand-in for the
// commands, and temp folders for the logs.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import * as D from '../doctor.mjs'

const SERIAL = 'A00XX0000000AA'

/** ioreg -p IOUSB -l -w0 with the deck behind the monitor's hub, cut to the properties that matter, plus a few. */
const IOREG_DECK = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 32>
  +-o AppleT6000USBXHCI@00000000  <class AppleT6000USBXHCI, id 0x100000331, registered, matched, active, busy 0 (0 ms), retain 63>
  | +-o USB2.0 Hub@00100000  <class IOUSBHostDevice, id 0x1000ac2f1, registered, matched, active, busy 0 (0 ms), retain 26>
  | | {
  | |   "sessionID" = 2398429384729
  | |   "idProduct" = 21297
  | |   "USB Product Name" = "USB2.0 Hub"
  | |   "idVendor" = 3141
  | |   "USB Vendor Name" = "Dell Inc."
  | | }
  | |
  | +-o Stream Deck +@00140000  <class IOUSBHostDevice, id 0x1000ac412, registered, matched, active, busy 0 (0 ms), retain 30>
  |     {
  |       "sessionID" = 2398432897421
  |       "USB Product Name" = "Stream Deck +"
  |       "idProduct" = 132
  |       "USB Serial Number" = "${SERIAL}"
  |       "IOCFPlugInTypes" = {"9dc7b780-9ec0-11d4-a54f-000a27052861"="IOUSBFamily.kext/Contents/PlugIns/IOUSBLib.bundle"}
  |       "idVendor" = 4057
  |       "USB Vendor Name" = "Elgato"
  |       "kUSBProductString" = "Stream Deck +"
  |     }
  |
  +-o AppleT6000USBXHCI@01000000  <class AppleT6000USBXHCI, id 0x100000342, registered, matched, active, busy 0 (0 ms), retain 58>
`
/** The same with the deck gone: the hub alone, and a keyboard of another maker's. */
const IOREG_NONE = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 32>
  +-o AppleT6000USBXHCI@00000000  <class AppleT6000USBXHCI, id 0x100000331, registered, matched, active, busy 0 (0 ms), retain 63>
  | +-o USB2.0 Hub@00100000  <class IOUSBHostDevice, id 0x1000ac2f1, registered, matched, active, busy 0 (0 ms), retain 26>
  | | {
  | |   "idProduct" = 21297
  | |   "USB Product Name" = "USB2.0 Hub"
  | |   "idVendor" = 3141
  | | }
  | |
  | +-o Magic Keyboard@00130000  <class IOUSBHostDevice, id 0x1000ac400, registered, matched, active, busy 0 (0 ms), retain 22>
  |     {
  |       "idProduct" = 615
  |       "USB Product Name" = "Magic Keyboard"
  |       "idVendor" = 1452
  |     }
`

const PS_APP = `    1 /sbin/launchd
  612 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
27296 /Applications/Elgato Stream Deck.app/Contents/MacOS/Stream Deck
27301 /Applications/Elgato Stream Deck.app/Contents/Helpers/node24/node --no-warnings plugin.js -port 28196
`
const PS_NONE = `    1 /sbin/launchd
  612 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
`

/**
 * A start of the Stream Deck app as its log has it, cut short: a dozen and more lines from `int main(`, the banner
 * between them, and lines from `main(` that aren't `int main(`. One start. `pid` is the app's.
 */
const sdStart = (day, pid) => [
  `${day}T07:10:00.000-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             `,
  '',
  '================================================================================',
  '    APPLICATION             Elgato Stream Deck',
  '    VERSION                 7.6.1 (23033)',
  '--------------------------------------------------------------------------------',
  `    LOG SESSION STARTED     ${day} 07:10:00 -0600`,
  '--------------------------------------------------------------------------------',
  '',
  `${day}T07:10:00.001-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Using preferences from /Users/x/Library/Preferences/com.elgato.StreamDeck.plist`,
  `${day}T07:10:00.002-06:00  ${pid}-3906561 Sentry                        inf virtual void ESDSentry::start()                    Start crash reporting:`,
  ' app: Stream Deck',
  `${day}T07:10:00.050-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Application was upgraded from '7.6.0.23012' to '7.6.1.23033'`,
  `${day}T07:10:00.234-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Compiled with Qt 6.11.1 ; SSL: Secure Transport, macOS Tahoe (26.6.2)`,
  `${day}T07:10:00.234-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Start Stream Deck App -> Version: 7.6.1.23033`,
  `${day}T07:10:00.263-06:00  ${pid}-3906561 StreamDeck                    inf auto main(int, char **)::(anonymous class)::operat Using existing ProfilesV3`,
  `${day}T07:10:00.287-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Check loaded data integrity`,
  `${day}T07:10:00.288-06:00  ${pid}-3906561 DeviceManager                 inf CORE                                               bootstrapping`,
  `${day}T07:10:00.298-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Use production environment for marketplace`,
  `${day}T07:10:01.024-06:00  ${pid}-3906561 StreamDeck                    inf int main(int, char **)                             Application event loop start`,
]

/** The Stream Deck app's log, in its own columns and its local time: started, the deck on, a lock, the unlock, and no deck back. */
const SD_LOG = [
  ...sdStart('2026-11-07', 27296),
  `2026-11-07T07:10:06.390-06:00  27296-3906897 DeviceHIDNotifier             inf ADDED                                              unit @(1)[4057/132/${SERIAL}] waiting is over, reason to report now: expired`,
  `2026-11-07T07:10:06.400-06:00  27296-3907279 DeviceManager                 inf CORE                                               device status changed @(1)[4057/132/${SERIAL}]: connected`,
  `2026-11-07T07:10:06.401-06:00  27296-3906561 ESDAppController              inf void ESDAppController::onDeviceStatusChanged(esd:: Device connected, id: @(1)[4057/132/${SERIAL}], serial number: ${SERIAL}, firmware version: 2.0.3.9, bcdDevice: 1.30`,
  '2026-11-07T07:10:08.000-06:00  27296-3906561 SDK                           inf void ESDCustomPlugin::onSessionConnected()         [com.karimdhanji.claude] Plugin connected',
  '2026-11-07T07:10:08.100-06:00  27296-3906561 SDK                           inf void ESDCustomPlugin::onSessionConnected()         [com.elgato.cpu] Plugin connected',
  '2026-11-07T08:24:21.112-06:00  27296-3906561 ESDBootstrap_UserSession      inf auto ESDBootstrap_UserSession::init()::(anonymous  Session -> suspend',
  '2026-11-07T08:24:21.112-06:00  27296-3906561 DeviceManager                 inf CORE                                               suspending',
  `2026-11-07T08:24:21.114-06:00  27296-6718578 DeviceManager                 inf CORE                                               device status changed @(1)[4057/132/${SERIAL}]: disconnected`,
  '2026-11-07T09:09:55.874-06:00  27296-3906561 ESDBootstrap_UserSession      inf auto ESDBootstrap_UserSession::init()::(anonymous  Session -> resume',
  `2026-11-07T09:30:01.000-06:00  27296-4628457 DeviceComm                    err [${SERIAL}]: Read Keys                        Returns: DISCONNECTED`,
  // Another maker's device, through the same app: not Elgato's.
  '2026-11-07T09:31:00.000-06:00  27296-4628457 DeviceManager                 inf CORE                                               device status changed @(1)[6940/7000/ZZZZ]: connected',
  '2026-11-07T09:40:00.000-06:00  27296-3906561 SDK                           war void ESDNativeRuntime::logProcessTermination(int,  [com.karimdhanji.claude] Process stopped (terminated)',
].join('\n')

/**
 * The Claude deck's log: its device leaving, a wake, the bridge listening again, the deck taking the device as
 * connected when a press came from it, twice, as it had missed its connect, and lines
 * doctor leaves out.
 */
const DECK_LOG = [
  '2026-11-07T13:10:08.500Z INFO  Claude: STARTUP {"pid":1,"log":"info"}',
  '2026-11-07T13:10:09.000Z INFO  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) connected',
  '2026-11-07T14:24:21.200Z INFO  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) disconnected',
  '2026-11-07T15:09:56.000Z INFO  Claude: woke up: rescanning; no system sleep',
  '2026-11-07T15:09:56.100Z DEBUG Bridge: REQ 204 POST "/v1/events"',
  '2026-11-07T15:09:56.200Z INFO  Bridge: listening again after the server closed: socket hang up',
  '2026-11-07T15:09:57.000Z DEBUG Sessions: POLL local_x wait 20 s',
  '2026-11-07T15:10:00.000Z INFO  Sessions: HELLO local_x inst "a" plugin "0.4.0" cc "2.1.317"',
  '2026-11-07T15:12:00.000Z WARN  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718): a press came from it, though the deck had it as not connected; taking it as connected',
  '2026-11-07T15:12:00.001Z INFO  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) connected',
  '2026-11-07T15:20:00.000Z INFO  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) disconnected',
  '2026-11-07T15:21:00.000Z WARN  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718): a press came from it, though the deck had it as not connected; taking it as connected',
].join('\n')

/** pmset -g log: a sleep, a maintenance wake and back, the wake, and the types around them that aren't these. */
const PMSET = [
  '2026-11-07 08:24:30 -0600 Sleep               \tEntering Sleep state due to \'Idle Sleep\':TCPKeepAlive=active Using AC (Charge:100%) 2 secs    ',
  '2026-11-07 08:54:30 -0600 DarkWake            \tDarkWake from Deep Idle [CDNVA] : due to EC.RTC (Maintenance)/Maintenance Using AC (Charge:100%) 45 secs',
  '2026-11-07 08:55:15 -0600 Sleep               \tEntering Sleep state due to \'Maintenance Sleep\':TCPKeepAlive=active Using AC (Charge:100%) 2 secs',
  '2026-11-07 09:09:54 -0600 Wake                \tWake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open Using AC (Charge:100%)          ',
  '2026-11-07 09:09:54 -0600 Wake Requests       \t[*process=mDNSResponder request=Maintenance deltaSecs=7200 wakeAt=2026-11-07 11:09:54]',
  '2026-11-07 09:09:55 -0600 Kernel Client Acks  \tDelays to Sleep notifications: [AppleGraphicsPowerManagement driver is slow(msg: SetState to 0)(171 ms)]',
  '2026-11-07 09:10:00 -0600 Assertions          \tPID 27296(Stream Deck) Created PreventUserIdleSystemSleep "x" 00:00:00  id:0x0x1 [System: PrevIdle DeclUser kDisp]',
  '2026-11-06 20:00:00 -0600 Sleep               \tEntering Sleep state due to \'Idle Sleep\' Using AC 2 secs',
].join('\n')

const NOW = Date.parse('2026-11-07T16:00:00Z')

test('doctor: ioreg, an Elgato device by its vendor id with its product name, and none when only other makers\' are there', () => {
  assert.deepEqual(D.parseIoreg(IOREG_DECK), [{ name: 'Stream Deck +', product: 132, deck: true }])
  assert.deepEqual(D.parseIoreg(IOREG_NONE), [])
  // The vendor written in hex, and a device with no product name: named by its entry.
  const hex = IOREG_DECK.replace('"idVendor" = 4057', '"idVendor" = 0xfd9').replace('"USB Product Name" = "Stream Deck +"', '').replace('"kUSBProductString" = "Stream Deck +"', '')
  assert.deepEqual(D.parseIoreg(hex), [{ name: 'Stream Deck +', product: 132, deck: true }])
  assert.deepEqual(D.parseIoreg(''), [])
})

/** ioreg with an Elgato microphone on the hub, and no Stream Deck: Elgato's vendor id, product 0x0070. */
const IOREG_WAVE = IOREG_NONE.replace('Magic Keyboard@00130000', 'Wave:3@00130000').replace('"idProduct" = 615', '"idProduct" = 112').replace('"USB Product Name" = "Magic Keyboard"', '"USB Product Name" = "Wave:3"').replace('"idVendor" = 1452', '"idVendor" = 4057')

test("doctor: only a Stream Deck counts as the deck, by its product name or the Stream Deck +'s product id; Elgato's other devices are listed, and count for nothing", () => {
  assert.deepEqual(D.parseIoreg(IOREG_WAVE), [{ name: 'Wave:3', product: 112, deck: false }])
  // Beside the deck: both are listed, and the deck is the one.
  const both = `${IOREG_DECK}${IOREG_WAVE.split('\n').slice(4).join('\n')}`
  assert.deepEqual(D.parseIoreg(both).map((d) => [d.name, d.deck]), [['Stream Deck +', true], ['Wave:3', false]])
  for (const [device, deck] of [[{ name: 'Stream Deck XL', product: 108 }, true], [{ name: 'Stream Deck Pedal', product: 134 }, true], [{ name: 'StreamDeck', product: 0 }, true], [{ name: 'IOUSBHostDevice', product: 132 }, true], [{ name: 'Cam Link 4K', product: 102 }, false], [{ name: 'Wave:3', product: 112 }, false]]) {
    assert.equal(D.isStreamDeck(device), deck, device.name)
  }
  const report = (ioreg) => D.buildReport({ ioreg: { text: ioreg }, ps: { text: PS_APP }, pmset: { text: '' }, sdLog: { text: '', current: '' }, deckLog: { text: '', files: [] } }, { since: 0, hours: 12 })
  const wave = report(IOREG_WAVE)
  assert.equal(wave.usb.sees, false)
  assert.equal(wave.verdict.code, 'usb')
  const lines = D.renderText(wave).split('\n')
  assert.ok(lines.includes('1. USB: macOS sees no Stream Deck on USB now, only other Elgato devices'), D.renderText(wave))
  assert.ok(lines.includes('   Wave:3 (4057/112), not a Stream Deck'))
  const two = D.renderText(report(both)).split('\n')
  assert.ok(two.includes('1. USB: macOS sees a Stream Deck now'))
  assert.ok(two.includes('   Stream Deck + (4057/132)') && two.includes('   Wave:3 (4057/112), not a Stream Deck'))
})

test("doctor: ps, the Stream Deck app's pid by its executable, not its plugins' node", () => {
  assert.equal(D.appPid(PS_APP), 27296)
  assert.equal(D.appPid(PS_NONE), null)
  assert.equal(D.appPid('27301 /Applications/Elgato Stream Deck.app/Contents/Helpers/node24/node plugin.js\n'), null)
})

test("doctor: the Stream Deck app's log, its device, suspend, resume and plugin lines, Elgato's only and with no serial", () => {
  const events = D.parseStreamDeckLog(SD_LOG)
  assert.deepEqual(events.map((e) => [new Date(e.t).toISOString(), e.kind, e.text]), [
    ['2026-11-07T13:10:00.000Z', 'start', 'the Stream Deck app started'],
    ['2026-11-07T13:10:06.390Z', 'added', 'ADDED unit 4057/132 (expired)'],
    ['2026-11-07T13:10:06.400Z', 'connected', 'device 4057/132 connected'],
    ['2026-11-07T13:10:08.000Z', 'plugin', 'Claude deck plugin: Plugin connected'],
    ['2026-11-07T14:24:21.112Z', 'suspend', 'Session -> suspend: the app turned the deck off, at a display sleep or lock'],
    ['2026-11-07T14:24:21.114Z', 'disconnected', 'device 4057/132 disconnected'],
    ['2026-11-07T15:09:55.874Z', 'resume', 'Session -> resume'],
    ['2026-11-07T15:30:01.000Z', 'read-failed', 'Read Keys returns DISCONNECTED'],
    ['2026-11-07T15:40:00.000Z', 'plugin', 'Claude deck plugin: Process stopped (terminated)'],
  ])
  assert.ok(!JSON.stringify(events).includes(SERIAL), 'no serial')
  // One start each time the app starts, by its pid, though each start writes many lines from `int main(`: the log
  // before a restart of the app, and the running app's.
  const restarted = D.parseStreamDeckLog([...sdStart('2026-11-06', 1001), ...sdStart('2026-11-07', 27296)].join('\n')).filter((e) => e.kind === 'start')
  assert.deepEqual(restarted.map((e) => new Date(e.t).toISOString()), ['2026-11-06T13:10:00.000Z', '2026-11-07T13:10:00.000Z'])
  // The app's view: its last word on the deck, a resume alone saying nothing.
  assert.deepEqual(D.appSees(events), { sees: false, since: Date.parse('2026-11-07T14:24:21.114Z'), text: 'device 4057/132 disconnected' })
  const back = D.parseStreamDeckLog(`${SD_LOG}\n2026-11-07T09:45:00.000-06:00  27296-1 DeviceManager                 inf CORE                                               device status changed @(1)[4057/132/${SERIAL}]: connected`)
  assert.equal(D.appSees(back).sees, true)
  const suspended = events.filter((e) => e.kind !== 'disconnected' && e.t <= Date.parse('2026-11-07T14:24:21.112Z'))
  assert.equal(D.appSees(suspended).sees, false, 'a suspend turns the deck off')
  assert.equal(D.appSees([]), null)
})

test("doctor: the Claude deck's log, its Device lines, its wakes and the Bridge's at info and above", () => {
  assert.deepEqual(D.deckLines(DECK_LOG).map((l) => [new Date(l.t).toISOString(), l.text]), [
    ['2026-11-07T13:10:09.000Z', 'Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) connected'],
    ['2026-11-07T14:24:21.200Z', 'Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) disconnected'],
    ['2026-11-07T15:09:56.000Z', 'Claude: woke up: rescanning; no system sleep'],
    ['2026-11-07T15:09:56.200Z', 'Bridge: listening again after the server closed: socket hang up'],
    // The deck missed the device's connect: the warn lines are Device lines too.
    ['2026-11-07T15:12:00.000Z', 'Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718): a press came from it, though the deck had it as not connected; taking it as connected'],
    ['2026-11-07T15:12:00.001Z', 'Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) connected'],
    ['2026-11-07T15:20:00.000Z', 'Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718) disconnected'],
    ['2026-11-07T15:21:00.000Z', 'Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718): a press came from it, though the deck had it as not connected; taking it as connected'],
  ])
})

test("doctor: pmset's log, its Sleep, Wake and DarkWake lines only, by its own time zone", () => {
  assert.deepEqual(D.parsePmset(PMSET).map((e) => [new Date(e.t).toISOString(), e.text]), [
    ['2026-11-07T14:24:30.000Z', "Sleep: Entering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:100%) 2 secs"],
    ['2026-11-07T14:54:30.000Z', 'DarkWake: DarkWake from Deep Idle [CDNVA] : due to EC.RTC (Maintenance)/Maintenance Using AC (Charge:100%) 45 secs'],
    ['2026-11-07T14:55:15.000Z', "Sleep: Entering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using AC (Charge:100%) 2 secs"],
    ['2026-11-07T15:09:54.000Z', 'Wake: Wake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open Using AC (Charge:100%)'],
    ['2026-11-07T02:00:00.000Z', "Sleep: Entering Sleep state due to 'Idle Sleep' Using AC 2 secs"],
  ])
})

test("doctor: the verdict, by whether macOS sees the deck and whether the Stream Deck app does, each yes, no or unknown", () => {
  // agents-and-wake.md, C6: macOS doesn't see it, the link or the hub; it does and the app doesn't, the app; both, live.
  const matrix = [
    [false, false, 'usb'], [false, true, 'usb'], [false, null, 'usb'],
    [true, false, 'app'], [true, true, 'live'], [true, null, 'app'],
    [null, false, 'app'], [null, true, 'live'], [null, null, 'unknown'],
  ]
  for (const [usb, app, code] of matrix) {
    for (const running of [true, false, null]) assert.equal(D.verdict(usb, app, running).code, code, `usb ${usb}, app ${app}, running ${running}`)
  }
  assert.equal(D.verdict(false, true).text, "macOS doesn't see a Stream Deck on USB: the USB link, the Thunderbolt cable or the monitor's USB hub. Try the monitor's input, away and back, or its power, off and on; then re-plug the cable.")
  assert.equal(D.verdict(true, false).text, "macOS sees the deck, and the Stream Deck app doesn't: quit the Stream Deck app and open it again.")
  assert.equal(D.verdict(true, false, true).text, D.verdict(true, false).text)
  // An app that isn't running is to open, not to quit.
  assert.equal(D.verdict(true, false, false).text, "macOS sees the deck, and the Stream Deck app isn't running: open it.")
  assert.equal(D.verdict(null, false, false).text, "Whether macOS sees the deck isn't known, and the Stream Deck app isn't running: open it. If that doesn't bring it back, re-plug the cable.")
  assert.match(D.verdict(false, false, false).text, /^macOS doesn't see a Stream Deck on USB: /)
  assert.equal(D.verdict(true, true).text, 'macOS and the Stream Deck app both see the deck: it should be live. If its keys still look stale, send this output.')
  assert.match(D.verdict(true, null).text, /what the Stream Deck app sees isn't known: if the keys look stale, quit the Stream Deck app and open it again\.$/)
  assert.match(D.verdict(null, false).text, /If that doesn't bring it back, re-plug the cable\.$/)
  assert.match(D.verdict(null, null).text, /send this output\.$/)
})

/** A temp home with the Stream Deck app's logs, and a folder with the Claude deck's; both removed after `t`. */
function folders(t, { sd = SD_LOG, sdBefore = null, deck = DECK_LOG } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const logs = path.join(home, 'Library', 'Logs', 'ElgatoStreamDeck')
  fs.mkdirSync(logs, { recursive: true })
  if (sd !== null) fs.writeFileSync(path.join(logs, 'StreamDeck.log'), sd)
  if (sdBefore !== null) fs.writeFileSync(path.join(logs, 'StreamDeck.1.log'), sdBefore)
  const logDir = path.join(root, 'deck-logs')
  fs.mkdirSync(logDir)
  if (deck !== null) fs.writeFileSync(path.join(logDir, 'com.karimdhanji.claude.0.log'), deck)
  return { root, home, logDir }
}

/**
 * main() with the commands, the clock and the output stood in for: `outputs` by command name, an Error to fail it, or
 * a promise to answer with. `limits` has each command's time limit as main gave it.
 */
async function doctor(argv, { home, logDir, outputs = {}, commandMs }) {
  let out = ''
  let err = ''
  const ran = []
  const limits = []
  const run = async (file, args, opts) => {
    const name = Object.keys(D.COMMANDS).find((k) => D.COMMANDS[k][0] === file)
    ran.push([file, ...args])
    limits.push(opts?.timeoutMs)
    const o = outputs[name]
    if (o instanceof Error) throw o
    if (o instanceof Promise) return o
    return { stdout: o ?? '' }
  }
  const code = await D.main(argv, { now: () => NOW, run, home, logDir, commandMs, out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err, ran, limits }
}

const ALL = { ioreg: IOREG_DECK, ps: PS_APP, pmset: PMSET }

test('doctor: the whole report, each source in the window, then the verdict', async (t) => {
  const f = folders(t)
  const r = await doctor([], { ...f, outputs: ALL })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.ran, Object.values(D.COMMANDS).map(([file, args]) => [file, ...args]), 'ioreg -p IOUSB -l -w0, ps and pmset -g log')
  const lines = r.out.split('\n')
  for (const want of [
    'doctor: the last 12 h, from 2026-11-07T04:00:00Z; times are UTC',
    '1. USB: macOS sees a Stream Deck now',
    '   Stream Deck + (4057/132)',
    '2. The Stream Deck app: running, pid 27296',
    "   Does it see the deck? no: device 4057/132 disconnected, at 2026-11-07T14:24:21Z, its log's last word on it",
    '   2026-11-07T14:24:21Z  Session -> suspend: the app turned the deck off, at a display sleep or lock',
    '   2026-11-07T15:30:01Z  Read Keys returns DISCONNECTED',
    `3. The Claude deck plugin's Device, woke up and Bridge lines (${path.join(f.logDir, 'com.karimdhanji.claude.0.log')})`,
    '   2026-11-07T15:09:56Z  Claude: woke up: rescanning; no system sleep',
    '   2026-11-07T15:12:00Z  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718): a press came from it, though the deck had it as not connected; taking it as connected',
    '   2026-11-07T15:21:00Z  Devices: Device "Stream Deck +" (7649d20de0e42bd46f0da00edaec8718): a press came from it, though the deck had it as not connected; taking it as connected',
    "4. macOS's sleep and wake (pmset -g log: Sleep, Wake and DarkWake)",
    '   2026-11-07T15:09:54Z  Wake: Wake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open Using AC (Charge:100%)',
    "5. Verdict: macOS sees the deck, and the Stream Deck app doesn't: quit the Stream Deck app and open it again.",
  ]) assert.ok(lines.includes(want), `${want}\n---\n${r.out}`)
  // The night before the window isn't in it; no serial, no other device or plugin, no other process.
  assert.ok(!r.out.includes('2026-11-07T02:00:00Z'))
  for (const never of [SERIAL, 'USB2.0 Hub', 'com.elgato.cpu', 'Finder', 'node24', 'Wake Requests', 'Assertions', 'HELLO']) assert.ok(!r.out.includes(never), never)
  // One start of the app, though its start wrote many lines from `int main(`.
  assert.equal(lines.filter((l) => l.endsWith('the Stream Deck app started')).length, 1, r.out)
  // Each command has COMMAND_MS.
  assert.deepEqual(r.limits, [D.COMMAND_MS, D.COMMAND_MS, D.COMMAND_MS])
})

test('doctor: a command that takes too long is that source\'s error, and the rest is reported without waiting for it', async (t) => {
  const f = folders(t)
  // pmset never answers; ioreg's execFile ran out of time and killed it.
  const killed = Object.assign(new Error('Command failed: /usr/sbin/ioreg -p IOUSB -l -w0'), { killed: true, signal: 'SIGKILL', code: null })
  let timer
  const waited = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), 5_000)
  })
  const r = await Promise.race([doctor([], { ...f, commandMs: 50, outputs: { ioreg: killed, ps: PS_APP, pmset: new Promise(() => {}) } }), waited])
  clearTimeout(timer)
  assert.notEqual(r, null, 'it was still waiting for pmset after 5 s')
  assert.equal(r.code, 0)
  assert.deepEqual(r.limits, [50, 50, 50])
  const lines = r.out.split('\n')
  for (const want of [
    "1. USB: can't tell: ioreg timed out after 0.05 s",
    '2. The Stream Deck app: running, pid 27296',
    "   can't tell: pmset timed out after 0.05 s",
    "5. Verdict: Whether macOS sees the deck isn't known, and the Stream Deck app doesn't: quit the Stream Deck app and open it again. If that doesn't bring it back, re-plug the cable.",
  ]) assert.ok(lines.includes(want), `${want}\n---\n${r.out}`)
  // A command that answers in time is read as before.
  const fine = await doctor([], { ...f, commandMs: 5_000, outputs: { ...ALL, pmset: new Promise((resolve) => setTimeout(() => resolve({ stdout: PMSET }), 20)) } })
  assert.ok(fine.out.includes('   2026-11-07T15:09:54Z  Wake: Wake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open Using AC (Charge:100%)'), fine.out)
})

test("doctor: --hours sets the window, and a restart of the app leaves the window's start in its log before", async (t) => {
  const f = folders(t, { sdBefore: '2026-11-07T05:00:00.000-06:00  1-2 DeviceManager                 inf CORE                                               device status changed @(1)[4057/132/X]: disconnected' })
  let r = await doctor(['--hours', '1'], { ...f, outputs: ALL })
  assert.match(r.out, /^doctor: the last 1 h, from 2026-11-07T15:00:00Z; times are UTC$/m)
  assert.ok(!r.out.includes('Session -> suspend'), 'before the hour')
  assert.ok(r.out.includes('   2026-11-07T15:40:00Z  Claude deck plugin: Process stopped (terminated)'))
  r = await doctor(['--hours', '24'], { ...f, outputs: ALL })
  assert.ok(r.out.includes('   2026-11-07T11:00:00Z  device 4057/132 disconnected'), 'the log before, in the window')
  assert.ok(r.out.includes("Does it see the deck? no: device 4057/132 disconnected, at 2026-11-07T14:24:21Z, its log's last word on it"), "the running app's own log says what it sees")
})

test("doctor: the verdict from the sources: no deck on USB, the app not running, and both seeing it", async (t) => {
  const f = folders(t)
  let r = await doctor([], { ...f, outputs: { ...ALL, ioreg: IOREG_NONE } })
  assert.match(r.out, /^1\. USB: macOS sees no Elgato device \(vendor 4057, 0x0fd9\) on USB now$/m)
  assert.match(r.out, /^5\. Verdict: macOS doesn't see a Stream Deck on USB: /m)
  r = await doctor([], { ...f, outputs: { ...ALL, ps: PS_NONE } })
  assert.match(r.out, /^2\. The Stream Deck app: not running$/m)
  assert.match(r.out, /^ {3}Does it see the deck\? no: the Stream Deck app isn't running$/m)
  assert.match(r.out, /^5\. Verdict: macOS sees the deck, and the Stream Deck app isn't running: open it\.$/m)
  const live = folders(t, { sd: `${SD_LOG}\n2026-11-07T09:45:00.000-06:00  27296-1 DeviceManager                 inf CORE                                               device status changed @(1)[4057/132/${SERIAL}]: connected` })
  r = await doctor([], { ...live, outputs: ALL })
  assert.match(r.out, /^5\. Verdict: macOS and the Stream Deck app both see the deck: it should be live\./m)
})

test("doctor: a command or a log it can't have is said so, and the rest is still reported", async (t) => {
  const f = folders(t, { sd: null, deck: null })
  const missing = (file) => Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT', path: file })
  const failed = Object.assign(new Error('Command failed: /usr/bin/pmset -g log'), { code: 1, stderr: 'pmset: no log\n' })
  const r = await doctor([], { ...f, outputs: { ioreg: missing('/usr/sbin/ioreg'), ps: PS_APP, pmset: failed } })
  assert.equal(r.code, 0)
  const lines = r.out.split('\n')
  for (const want of [
    "1. USB: can't tell: ioreg failed: /usr/sbin/ioreg isn't there",
    '2. The Stream Deck app: running, pid 27296',
    `   Does it see the deck? can't tell: can't read ${path.join(f.home, 'Library', 'Logs', 'ElgatoStreamDeck', 'StreamDeck.log')}: ${path.join(f.home, 'Library', 'Logs', 'ElgatoStreamDeck', 'StreamDeck.log')} isn't there`,
    `   can't read its log: no com.karimdhanji.claude.0.log in ${f.logDir}`,
    "   can't tell: pmset failed: pmset: no log",
    "5. Verdict: Neither macOS's view nor the Stream Deck app's could be read: send this output.",
  ]) assert.ok(lines.includes(want), `${want}\n---\n${r.out}`)
  // ps failing too: whether the app runs isn't known either.
  const none = await doctor([], { ...f, outputs: { ioreg: IOREG_DECK, ps: missing('/bin/ps'), pmset: PMSET } })
  assert.match(none.out, /^2\. The Stream Deck app: can't tell whether it's running: ps failed: \/bin\/ps isn't there$/m)
  assert.match(none.out, /^5\. Verdict: macOS sees the deck, and what the Stream Deck app sees isn't known/m)
})

test('doctor: it writes nothing, and a section shows its newest lines only', async (t) => {
  const many = Array.from({ length: D.MAX_LINES + 5 }, (_, i) => `2026-11-07T15:${String(i).padStart(2, '0')}:00.000Z INFO  Devices: Repaint: every key and strip (device connected)`).join('\n')
  const f = folders(t, { deck: many })
  const snapshot = () => fs.readdirSync(f.root, { recursive: true }).sort().map((p) => [p, fs.statSync(path.join(f.root, p)).mtimeMs])
  const before = snapshot()
  const r = await doctor([], { ...f, outputs: ALL })
  assert.deepEqual(snapshot(), before)
  assert.ok(r.out.includes('   … 5 earlier line(s)'), r.out)
  assert.ok(r.out.includes('   2026-11-07T15:44:00Z  Devices: Repaint: every key and strip (device connected)'))
  assert.ok(!r.out.includes('2026-11-07T15:04:00Z'))
})

test('doctor: usage errors exit 2, and --help exits 0, before anything runs', async (t) => {
  const f = folders(t)
  for (const argv of [['--hours', '0'], ['--hours', 'x'], ['--hours=-3'], ['--hours', 'Infinity'], ['--nope'], ['stray']]) {
    const r = await doctor(argv, { ...f, outputs: ALL })
    assert.deepEqual([r.code, r.out, r.ran], [2, '', []], JSON.stringify(argv))
    assert.match(r.err, /^doctor: .*\n\nusage:/, JSON.stringify(argv))
  }
  const help = await doctor(['--help'], { ...f, outputs: ALL })
  assert.deepEqual([help.code, help.err, help.ran], [0, '', []])
  assert.match(help.out, /^usage: node claude-code\/tools\/doctor\.mjs \[--hours N\]/)
})
