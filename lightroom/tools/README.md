# Lightroom tools

Developer tools for the Lightroom side, built on protocol v1 (`lightroom/protocol/PROTOCOL.md`). They use Node 24 with no npm dependencies.

Run every command from the repo root through `mise exec --`, because the shell's bare `node` is 22.

| Tool | What it does |
|---|---|
| `mock-lr/` | A mock Lightroom that speaks v1 over real sockets and copies the quirks measured on 15.3 |
| `fixtures/run.mjs` | Runs the 19 fixture conversations against the mock |
| `fake-deck/` | A scriptable fake deck, for driving the real Lua plugin (verification ladder step 4) |
| `latency/latency.mjs` | The S2 latency harness, ported to v1 |
| `integration/deck-vs-mock.mjs` | The real Stream Deck plugin bundle against the mock (verification ladder step 5) |
| `lib/` | The shared client, fixture reader, matcher, clocks and constants |

## Tests

```
mise exec -- node --test lightroom/tools/
```

This runs about 150 tests in roughly 50 s, all on ephemeral ports:
- the matcher;
- all 19 fixtures, on the manual clock and the real clock;
- `smoke.json` against the mock, including the main catalog with the guard off, several photos selected and Auto Advance on;
- a short latency run, its refusals, and photo changes mid-run;
- the mock's quirks, recovered from by the pair rule and the heartbeat;
- the protocol rules the fixtures can't check:
  - no `vals` outside Develop;
  - gestures ending on a photo change, on leaving Develop and at shutdown;
  - stale gestures, including a `set` that reaches a photo change before the poll, and a stale g forgotten on a new gesture or a greeting;
  - the order of checks for writes, and `reload` refused outside the test catalog;
  - unknown watched params found on entering Develop;
  - `vals` after a gesture only when its value changed;
  - no `g` in a reset's `ack`;
  - `vals` at most 20 a second;
- the CLIs.

A test fails if the mock logs an error, that is, an exception it caught in its poll, observer, timers or socket hooks.

Node 24 runs a directory given to `--test` as a module. So `package.json`'s `main` points at `tests/all.mjs`, which imports every `tests/*.test.mjs`. To run the files in parallel processes instead, use `node --test 'lightroom/tools/tests/*.test.mjs'`.

## Mock Lightroom

```
mise exec -- node lightroom/tools/mock-lr/cli.mjs --ports 59780,59781 [--scenario file.json] [--set-ms N] [--quiet|--verbose]
```

**Ports.** They default to DeckBridge's own 58780/58781, so the mock can stand in for Lightroom. Lightroom has to be quit first. If the ports are taken, the mock exits 2 with "is Lightroom running?". `--ports 0,0` picks free ports, and the banner prints them.

**Default scenario.** `mock-lr/default-scenario.json` opens the test catalog in Develop, with:
- 10 photos: ARW raws, a DNG and two JPEGs, with flags, ratings and labels. Photo 107 is locked, so presets skip it.
- 6 presets. Four are the profile-only "Cobalt Classic Chrome", "Cobalt Classic Neg", "Cobalt Eterna" and "Cobalt Acros", in Deck Profiles.

**REPL.** Type `help` on stdin. The commands are user actions in Lightroom:
- `photo <id>`, `select [<id> ...]`, `edit Exposure 0.8 Contrast -12`, `module <name>`
- `flag pick|reject|none`, `rating <0-5>`, `label <color>`
- `autoadvance on|off`, `lock <id> [on|off]`, `busy <secs>`, `guard on|off`
- `catalog <path>`: relaunches with that catalog, as Lightroom does
- `pause <secs>`: an open menu, with no ok, no reads and no events
- `stale`: events vanish until the cmd socket closes
- `close [cmd|evt|both]`: Lightroom closes the connection by itself
- `quit-and-relaunch [secs]` and `reload-plugin`: a new `inst` and an empty watch list
- `state`, `exit`

**Quirks.** The mock copies what spike runs 1 and 2 measured on 15.3:
- **Sockets:**
  - The cmd socket answers every line with `ok`.
  - The send socket never notices a client dropping only the evt connection. It keeps writing into the dead socket. A new evt connection waits, unserved, until the cmd socket closes, and only then is the sender recreated.
  - A new cmd client replaces the old one.
- **Develop:**
  - The observer is silent during a tracked gesture and fires once, about 4 ms after `stopTracking`.
  - A 200 ms poll diffs state and the watched values, leaving out the tracked param.
  - `vals` go out at most 20 a second, like the plugin's. That includes the full set owed after `hello`, `watch`, entering Develop and a photo change, which waits until 50 ms after the last `vals`.
  - Ranges depend on the file format.
  - Gestures end on `done`, on another `p` or `g`, after 2 s without a `set`, on a disconnect, on a photo change, on leaving Develop and at shutdown. After one ends, `vals` carry its final value only if that changed.
  - The mock learns of the user's photo and module changes, and of Lightroom's own Auto Advance, only from its 200 ms poll, so a `set` can reach such a change first. The plugin also hears of a photo change in Develop from the adjustment observer, within milliseconds, so the mock hits the `stale` path far more often than Lightroom does. That suits testing; it isn't a model of Lightroom's timing.
  - A gesture belongs to the photo it started on. Once the photo or module changes under it, its later `set`s get `err stale` and change nothing. The deck's `nav` and a flag's `advance` end it as stale too, even at an end of the filmstrip where nothing moves, as the plugin does. The stale g is forgotten when the next gesture starts or a client is greeted.
  - Writes are checked in PROTOCOL.md's order: fields, the guard, a stale gesture, the switch to Develop, then the photo and the param.
  - `watch` drops unknown params once Lightroom is in Develop with a photo, since that's where `getRange` works. The `err bad` carries the watch's `id`.
  - `set` values are clamped.
  - The guard compares the catalog path without case.
  - Presets skip locked photos. A busy catalog answers `err busy` after 3 s.
  - `reload` takes the modules the plugin hot-reloads (`Reload.MODULES` in `Reload.lua`). It answers `ok` false for any other name, and outside the test catalog while the guard is on, as the plugin does.

**From code**, the way Track B's tests can use it:

```js
import { startMock } from '../../tools/mock-lr/index.mjs';
const { cmdPort, evtPort, control, stop } = await startMock({ cmdPort: 0, evtPort: 0, clock: 'manual', scenario });
```

`startMock` options:
- `cmdPort` and `evtPort` (or `ports: [a, b]`). They default to 58780/58781; 0 picks a free port.
- `scenario`: a fixture `setup` object. It defaults to the default scenario.
- `clock`: `'real'` (the default) or `'manual'`.
- `log(kind, text)`.
- `setCostMs`: each `set` takes this long, and later lines wait.

`control` methods:

| Method | Does |
|---|---|
| `setup(s)` | Replaces Lightroom's whole state from a fixture setup |
| `user(a)` | Applies a fixture user line: `photo`, `selected`, `module` or `edit`. The mock also takes `flag`, `rating` and `label`. |
| `expect(e)` | Checks a fixture expect line and returns `{ ok, errors }` |
| `state()` | A snapshot: photos, values, gesture, `staleG`, history (one entry per history step), clients |
| `step()` | One 200 ms poll step |
| `advance(ms)` | Lets time pass. The manual clock moves in 200 ms poll steps; the real clock just waits. |
| `pause(ms)`, `stale()`, `close(which)` | The socket quirks above |
| `relaunch({ downMs, catalog })` | Quits and relaunches. On the manual clock the downtime needs `advance()`. |
| `busy(ms)` | Makes the catalog busy for `ms` |
| `options({ autoAdvance, guard, setCostMs, lock: { id: bool } })` | Changes those settings |
| `waitClients()`, `clients()`, `evtWritten()` | Show what the deck side is connected to, and how many events were sent |

The mock adds its own setup fields beyond the fixture setup:
- `guard`
- `view`
- per photo: `defaults` (as-shot values for `reset`), `locked` and `applied`
- per preset: `values`, the sliders it changes

## Fixture runner

```
mise exec -- node lightroom/tools/fixtures/run.mjs [--clock manual|real|both] [--concurrency N] [file.jsonl ...]
```

It runs every fixture in `lightroom/protocol/fixtures`, or the files given, by the rules in PROTOCOL.md's Fixtures section:
- Each fixture gets a fresh mock on ephemeral ports.
- The runner connects both sockets and throws away the greeting.
- `deck` and `raw` lines go over the cmd socket. `setup`, `user` and `expect` lines go through the control API.
- With the manual clock (the default), the runner owns time. After every `deck`, `raw` and `user` line it moves 200 ms and runs the poll once. `wait` moves in 200 ms steps.
- Messages left over at the end must be allowed extras too.
- A fixture also fails if the mock logs an error, or writes anything but `ok` on the cmd socket.

It exits 1 if any fixture fails, printing the line and the reason.

## Fake deck

```
mise exec -- node lightroom/tools/fake-deck/fake-deck.mjs <script.json> [--ports cmd,evt] [--timeout ms] [--connect-ms ms] [--quiet]
```

The ports default to 58780/58781, which is DeckBridge in Lightroom. The fake deck:
1. connects with the shared client (pair rule, backoff, ok draining, heartbeat);
2. throws away the greeting;
3. runs the steps and prints a step log;
4. exits 0 on a pass, 1 on a failure or when Lightroom can't be reached, and 2 on a bad script.

Steps:
- `send`, `raw`
- `expect`, with `timeout`, `save` and `hint`. It uses the fixture matcher, plus `{"$not": …}` and `{"$type": …}`.
- `never`, `wait`, `drain`, `log`, `let`, `fail`
- `when` on any step
- a `cleanup` list that always runs

The header of `fake-deck.mjs` lists the expressions. Times (`timeoutMs`, `timeout`, `wait`, `drain`, `--timeout`, `--connect-ms`) must be numbers, or the script exits 2.

**A script's `catalog`** names the only catalog it may write to, whatever Lightroom's guard says. Paths compare without case, like the guard's:
- The run fails at connect if Lightroom's greeting names another catalog.
- An `expect` that matches a `hello` naming another catalog fails.
- `set`, `reset`, `flag` and `preset` are refused unless the latest `hello` since the sockets came up names it. That covers a relaunch into another catalog mid-run, and the cleanup.

Anything Lightroom writes on the cmd socket other than `ok` fails the next `expect` or `drain`.

**`fake-deck/smoke.json`** is the live check against the real plugin. Its `catalog` is the test catalog, so it never writes anywhere else, even with the guard off.
1. hello, expecting `writable` true, then a state with exactly one photo selected.
2. Develop, then watch the 13 bank params and expect ranges and vals.
3. One Exposure gesture: +0.1 and back, then `done`.
4. `nav next`, then `prev`.
5. `view before`, then `after`.
6. `presets`.
7. `flag pick`, then `none`, then the photo's own flag again. After each flag it waits 500 ms, and fails before writing again if Lightroom moved to another photo.
8. `ping`.

It leaves the photo as it found it. Cleanup puts back Exposure, the flag, the photo and the module after a failure, and writes only while Lightroom is back on the starting photo. If Lightroom's own Auto Advance moves on after the cleanup's flag, cleanup goes back with `nav prev`.

Before running it against Lightroom:
- Open the test catalog.
- Select exactly one photo, not the last in the filmstrip. With Auto Sync on, Lightroom copies a dial edit to every selected photo (spike S5), so the script refuses more than one.
- Turn off Lightroom's own Auto Advance. If it's on, the script stops after the first flag and puts the photo back.
- Stop the Stream Deck plugin. Lightroom serves one client at a time.

## Deck vs mock

```
mise exec -- node lightroom/tools/integration/deck-vs-mock.mjs [--keep]
```

Verification ladder step 5: the deck plugin's built bundle against the mock, to find where the two tracks read `PROTOCOL.md` differently. It isn't part of `node --test`. It needs `lightroom/deck`'s `bin/plugin.js` (`npm run build` there) and its `node_modules`, for `ws`. A run takes about 35 s, and everything binds ephemeral ports.

How it runs:
- It copies the `.sdPlugin` folder to a temp folder, so the real plugin's logs stay untouched.
- It runs `bin/plugin.js` with the deck's `scripts/smoke-guard.mjs` preloaded, so the plugin can't reach 58780/58781.
- A fake Stream Deck app, after the deck's `smoke.mjs`, plays dial and key input.
- `startMock` runs on the real clock, and the plugin gets its ports through `DECKBRIDGE_CMD_PORT` and `DECKBRIDGE_EVT_PORT`.

What it checks: the mock's state, and what the plugin sends the app.
1. The four dials and seven keys appear, and the plugin says hello and watches the 13 bank params.
2. Turns, fine turns, press and long-touch resets, and the banks.
3. Pick, Reject, Unflag with advance; Next and Previous, including a JPEG; Before/After; Apply Preset.
4. A mouse edit reaching its strip.
5. A user's photo change mid-gesture, both ways round: Lightroom's `err stale` first, and the deck's `state` first.
6. A turn in Library.
7. A relaunch, a stale event socket, a paused Lightroom, and Lightroom going away and coming back.
8. For the whole session:
   - every command is valid (the deck's `validate.ts`);
   - the rates for `set`, `ping`, strip updates and `vals`;
   - one `done` per gesture;
   - no `err` beyond the expected `stale`;
   - no alert;
   - nothing unexpected in the plugin's log.

It prints one ok/FAIL line per check, and the tails of the plugin's and the mock's logs on a failure. It exits 0 when every check passes, 1 when one fails, and 2 when it can't start. `--keep` keeps the temp folder, with the plugin's log and `conversation.jsonl`: every command, event and app message, in order.

## Latency harness

```
mise exec -- node lightroom/tools/latency/latency.mjs --mock [--mock-set-ms N] [--rates 15,30,60] [--burst-ms 5000] [--gap-ms 1500] [--param Exposure] [--json out.json]
mise exec -- node lightroom/tools/latency/latency.mjs --ports 58780,58781 ...    # the real Lightroom, later
```

Each rate is one gesture `g`: `set {p, v, g}` at that rate for the burst, then `done`. Acks are matched to sets in order, because v1 acks carry no sequence number.

For each rate it reports:
- ack latency: median, p95 and max
- the `ok` latency and send drift
- backlog: the median ack latency in the last window minus the first. A `!` marks a growing backlog.
- drain: the last set to the last ack, and `done` to the observer's vals
- leaks: vals carrying the tracked param during the gesture
- errors

It reads the value first and puts it back at the end. `--mock-set-ms 30` makes a slow Lightroom, to see a backlog grow.

It writes only to the test catalog, with exactly one photo selected, whatever the guard says, and it stops writing if a `hello` from another plugin instance or catalog arrives mid-run. Against the real Lightroom (`--ports`), rates go up to 60 a second, the most spike S2 measured; faster ones need `--mock`. It exits 1 on missing or mismatched acks, errors, leaks, or a value not put back, and 2 on bad arguments.

It also writes only to the photo it started on:
- A `state` naming another photo, or a `set` refused as stale, stops the bursts at once.
- Before each burst, and before putting the value back, it asks for a fresh `state` with `hello`. Each burst starts a new gesture, and Lightroom puts a new gesture on whatever photo is the target. The states Lightroom pushes come from its 200 ms poll, so they can be behind.
- If Lightroom is on another photo by then, it skips the restore, prints "can't put back Exposure 0.35 on 101 (DSC01241.ARW): Lightroom is on 102 (DSC01242.ARW) now", and exits 1.
- Leaks count from a burst's first `ack`. The fresh greeting's `vals` arrive before it, and Lightroom sent them before the gesture began.
