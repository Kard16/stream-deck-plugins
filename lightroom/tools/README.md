# Lightroom tools

Developer tools for the Lightroom side, built on protocol v1 (`lightroom/protocol/PROTOCOL.md`). They use Node 24 with no npm dependencies.

Run every command from the repo root through `mise exec --`, because the shell's bare `node` is 22.

| Tool | What it does |
|---|---|
| `mock-lr/` | A mock Lightroom that speaks v1 over real sockets and copies the quirks measured on 15.3 |
| `fixtures/run.mjs` | Runs the 21 fixture conversations against the mock |
| `fake-deck/` | A scriptable fake deck, for driving the real Lua plugin (verification ladder step 4) |
| `latency/latency.mjs` | The S2 latency harness, ported to v1 |
| `integration/deck-vs-mock.mjs` | The real Stream Deck plugin bundle against the mock (verification ladder step 5) |
| `lib/` | The shared client, fixture reader, matcher, clocks and constants |

## Tests

```
mise exec -- node --test lightroom/tools/
```

This runs about 180 tests in roughly 60 s, all on ephemeral ports:
- the matcher;
- all 21 fixtures, on the manual clock and the real clock;
- `smoke.json` against the mock, including the main catalog with the guard off, several photos selected, Auto Advance on, and a photo change it hasn't heard of before its cleanup;
- a short latency run, its refusals, and photo changes mid-run;
- the mock's quirks, recovered from by the pair rule and the heartbeat;
- the protocol rules the fixtures can't check:
  - no `vals` outside Develop;
  - gestures ending on a photo change, on leaving Develop and at shutdown;
  - stale gestures, including a `set` that reaches a photo change before the poll, and a stale g forgotten on a new gesture or a greeting;
  - `ph` on `set` and `reset`: a wrong one changes nothing, not even an open gesture, and makes the set's g stale; it's wrong with no target photo too; one that isn't a string is a field error; without `ph`, or with `null`, nothing is checked; a `set` for a gesture the photo moved away from ends that gesture before its `ph` is checked;
  - the target photo read again after a switch to Develop: another photo picked during the switch makes a `set` or `reset` stale, with or without `ph`, and the set's g stale too; a lock the poll read meanwhile is `err locked`; either way only the module changes;
  - locked photos: `state.locked` and `err locked` go by the poll's reading for the target photo, so a write lands before the poll reads a lock; a reading counts only for the photo it was taken for, either way, and only the target counts when several photos are selected; `nav`'s own `state` reads the lock too; `flag` isn't checked;
  - the order of checks for writes, and `reload` refused outside the test catalog;
  - unknown watched params found on entering Develop;
  - `vals` after a gesture only when its value changed, and after a preset that changes sliders;
  - no `g` in a reset's `ack`;
  - `vals` at most 20 a second;
- the control calls for deck scenarios (see [Deck scenarios](#deck-scenarios));
- the CLIs.

A test fails if the mock logs an error, that is, an exception it caught in its poll, observer, timers or socket hooks.

Node 24 runs a directory given to `--test` as a module. So `package.json`'s `main` points at `tests/all.mjs`, which imports every `tests/*.test.mjs`. To run the files in parallel processes instead, use `node --test 'lightroom/tools/tests/*.test.mjs'`.

## Mock Lightroom

```
mise exec -- node lightroom/tools/mock-lr/cli.mjs --ports 59780,59781 [--scenario file.json] [--set-ms N] [--quiet|--verbose]
```

**Ports.** They default to DeckBridge's own 58780/58781, so the mock can stand in for Lightroom. Lightroom has to be quit first. If the ports are taken, the mock exits 2 with "is Lightroom running?". `--ports 0,0` picks free ports, and the banner prints them.

**Default scenario.** `mock-lr/default-scenario.json` opens the test catalog in Develop, with:
- 10 photos: ARW raws, a DNG and two JPEGs, with flags, ratings and labels. Photo 107 is locked, so presets skip it, and `set` and `reset` on it get `err locked`.
- 6 presets. Four are the profile-only "Cobalt Classic Chrome", "Cobalt Classic Neg", "Cobalt Eterna" and "Cobalt Acros", in Deck Profiles. The last two, "Punchy" and "Soft Matte", change sliders.

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
  - A `set` or `reset` whose `ph` isn't the target photo gets `err stale` and changes nothing, an open gesture included. The `set`'s g is stale from then on. `ph` is compared with the target photo as it is when the command arrives, not the one the poll last saw, so it catches a photo change the poll hasn't noticed yet. A `ph` that isn't a string is `bad`. Without `ph`, or with `null`, which the plugin's JSON decoder drops, nothing is checked.
  - The poll reads whether the target photo is locked. `state.locked` and the `err locked` that `set` and `reset` get go by that reading, as the plugin's do. So a write still lands before the poll reads a new lock, and a photo the poll hasn't read yet counts as unlocked. `flag` isn't checked, and presets check each photo as they apply.
  - Writes are checked in PROTOCOL.md's order: fields (`ph` included), the guard, a stale gesture or photo, a locked photo, the switch to Develop and, after one, the target photo again, then the photo and the param.
  - A `set` or `reset` that made Lightroom switch to Develop reads the target photo again once it's there, as the plugin does. If the user picked another photo while Lightroom switched, the command gets `err stale`, with or without `ph`, and a `set`'s g is stale from then on. If it's the same photo but the lock reading now says locked, the command gets `err locked`. Either way nothing changes but the module. The mock reads the state, the lock included, as the switch lands, so its reading is never older than the switch; the plugin goes by its latest poll's, up to 200 ms older.
  - A module switch the plugin asks for can take a while (`moduleDelayMs`, 0 by default). The handler waits for it up to 1 s, the plugin's `Config.MODULE_SECS`, and then answers `err noDevelop` (or `failed` for Library). The switch still lands, and the poll reports it. While a handler waits, every command but `ping` queues behind it, as in the plugin's dispatch queue, and a line the plugin can't route gets its `err` at once. A command for the module Lightroom is already in asks for no switch and answers at once, so a switch still on its way elsewhere lands all the same.
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
- `catalog`: open this catalog instead of the scenario's.
- `clock`: `'real'` (the default) or `'manual'`.
- `log(kind, text)`.
- `setCostMs`: each `set` takes this long, and later lines wait.

`control` methods:

| Method | Does |
|---|---|
| `setup(s)` | Replaces Lightroom's whole state from a fixture setup |
| `user(a)` | Applies a fixture user line: `photo`, `selected`, `module`, `edit` or `locked`. The mock also takes `flag`, `rating` and `label`. |
| `expect(e)` | Checks a fixture expect line and returns `{ ok, errors }` |
| `state()` | A snapshot: photos, values, gesture, `staleG`, `lockRead` (the poll's latest lock reading), history (one entry per history step), clients, and the settings below |
| `step()` | One 200 ms poll step |
| `advance(ms)` | Lets time pass. The manual clock moves in 200 ms poll steps; the real clock just waits. |
| `holdPoll(ms)` | The poll reads nothing for `ms`, so a photo or module change the user makes stays unnoticed that long. A command or the observer can still make the mock read the state. `holdPoll(0)` ends it. |
| `nextPoll()` | Resolves just after the next poll has run |
| `pause(ms)`, `stale()`, `close(which)` | The socket quirks above |
| `delayEvents(ms)` | Events reach the deck `ms` after Lightroom sends them, in order, on either clock. `delayEvents(0)` sends new ones at once again, after any still on their way. |
| `relaunch({ downMs, catalog })` | Quits and relaunches. On the manual clock the downtime needs `advance()`. |
| `busy(ms)` | Makes the catalog busy for `ms` |
| `options({ autoAdvance, guard, setCostMs, lock: { id: bool }, protocolVersion, moduleDelayMs, moduleWaitMs })` | Changes those settings. `protocolVersion` is the `v` that `hello` says, 1 by default. `moduleDelayMs` is how long a module switch the plugin asks for takes to land, 0 by default; `moduleWaitMs` is how long its handlers wait for one, 1000 by default. `setCostMs`, `protocolVersion`, `moduleDelayMs` and `moduleWaitMs` last across `setup()` and relaunches. |
| `waitClients()`, `clients()`, `evtWritten()` | Show what the deck side is connected to, and how many events were sent |

The mock adds its own setup fields beyond the fixture setup:
- `guard`
- `view`
- per photo: `defaults` (as-shot values for `reset`), `locked` and `applied`
- per preset: `values`, the sliders it changes

### Deck scenarios

What the deck-vs-mock scenarios can ask of the mock, beyond the fixture lines:
- **Locking and unlocking photos.** `user({ locked: [id] })` locks exactly those photos, and `user({ locked: [] })` unlocks them all. `options({ lock: { [id]: true } })` changes one photo. The mock acts on a lock at its next poll, within 200 ms: `state.locked` changes then, and `set` and `reset` get `err locked` from then on. A write that arrives before that poll still lands, as in Lightroom.
- **A set sent before `state.locked` reaches the deck.** The poll sends `state.locked` as it reads the lock, so a set meets `err locked` only if the deck sends it while that state is on its way, a window of a fraction of a ms. `delayEvents(300)` widens it to 300 ms. Lock the photo, wait for `nextPoll()`, then turn a dial: the deck gets `state.locked` and then `err locked`, 300 ms late, in that order.
- **A photo change the mock notices only at its next poll.** `user({ photo })` already works this way; the window is up to 200 ms. For a longer one, call `holdPoll(ms)` first. Then `user({ photo })`, and a dial turned in the window sends a `set` with the old photo's `ph`, which gets `err stale`. If an open gesture ends, the mock's observer sends the new photo's state at once, as the plugin's does.
- **Another catalog.** `startMock({ catalog })` starts there, and `relaunch({ catalog })` moves there mid-run. With the guard on, as it is unless `options({ guard: false })`, `hello.writable` is false outside the test catalog. `set`, `reset`, `flag` and `preset` then get `err guard`, with at most one bezel every 5 s (`state().bezels`), and `reload` answers `ok: false`.
- **A version mismatch.** `options({ protocolVersion: 2 })` makes the next `hello` say v 2: the greeting on the next connect, or the answer to a `hello`. Everything else stays v1.
- **A preset that changes sliders.** The default scenario's "Punchy" (`9D1E2F3A4B5C6D7E8F90A1B2C3D4E5F6`) sets Contrast 25, Vibrance 20 and Clarity 10, and "Soft Matte" sets Contrast -20, Blacks 25 and Saturation -10. Applied to the target photo in Develop, the observer sends `vals` with the watched sliders that changed. A scenario's own preset gets a `values` object.
- **A slow module switch.** `options({ moduleDelayMs })` delays every switch the plugin asks for: `module`, and the switch to Develop for `set`, `reset` and `view`. When the switch lands within the 1 s wait, the command answers then. When it takes longer, the command gets `err noDevelop` at 1 s, so the deck drops its held ticks on that `err`. For the deck's own 2 s drop of held ticks, Lightroom must answer nothing at all, so raise the wait above the delay too: `options({ moduleDelayMs: 2500, moduleWaitMs: 3000 })`. The answer then comes at 2.5 s, as `state`, `ranges` and `vals`.

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
- `send`, `raw`. Give `set` and `reset` a `ph`, as the deck does: the photo their values came from, such as one saved from a `state`.
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
3. One Exposure gesture: +0.1 and back, then `done`. Each `set` carries `ph`, the photo the script read Exposure from, so Lightroom refuses it as stale on any other photo. That includes cleanup's `set`, after a photo change the script hasn't heard of.
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

Verification ladder step 5: the deck plugin's built bundle against the mock, to find where the two tracks read `PROTOCOL.md` differently. It isn't part of `node --test`. It needs `lightroom/deck`'s `bin/plugin.js` (`npm run build` there) and its `node_modules`, for `ws`. A run takes about 70 s, and everything binds ephemeral ports.

How it runs:
- It copies the `.sdPlugin` folder to a temp folder, so the real plugin's logs stay untouched. The copy gets a `log-level.txt` saying `debug`, so the log checks see the plugin's debug lines too.
- It runs `bin/plugin.js` with the deck's `scripts/smoke-guard.mjs` preloaded, so the plugin can't reach 58780/58781.
- A fake Stream Deck app, after the deck's `smoke.mjs`, plays dial and key input.
- `startMock` runs on the real clock, and the plugin gets its ports through `DECKBRIDGE_CMD_PORT` and `DECKBRIDGE_EVT_PORT`.

What it checks: the mock's state, and what the plugin sends the app. The numbers are the script's sections, which its ok and FAIL lines and its checks refer to.
1. The four dials and eight keys appear, and the plugin says hello and watches the 13 bank params.
2. Turns.
3. Fine turns, press and long-touch resets, and the banks.
4. Pick, Reject, Unflag with advance; Next and Previous, including a JPEG; Before/After; Apply Preset.
5. A mouse edit reaching its strip.
6. A user's photo change mid-gesture, while ticks keep coming, so Lightroom's `err stale` comes first. Section 6b does the same while the dial rests, so the deck's `state` comes first.
7. A turn in Library.
8. A relaunch, a stale event socket, a paused Lightroom, and Lightroom going away and coming back.
9. The `ph` race. The user moves to another photo while the mock's poll is held (`holdPoll`), and the deck turns, then presses, before it hears. The `set` and the `reset` carry the old photo and get `err stale`. Nothing lands on either photo, and the turns held meanwhile go out with the new photo.
10. Locked photos:
    - A lock mid-turn ends the turn with `done`.
    - While `state.locked` is true, the strips say Locked. Turns, presses, push + turn and long touches send nothing and alert once per burst, and a turn in Library sends no `module`. Taps still change banks.
    - Unlocking brings everything back.
    - With `delayEvents(300)`, sets cross `state.locked` on the wire and get `err locked`: one alert, one `done`.
11. Read-only: a relaunch into another catalog, so `hello.writable` is false. The one `set` per burst, a reset, Pick and Apply Preset each get `err guard` and an alert. Then back to the test catalog.
12. A version mismatch, with `options({ protocolVersion: 2 })` and a reconnect. The strips say Mismatch, inputs alert, and only `hello` and `ping` go out until v1 is back.
13. Two dials turned at once.
14. Clamping at both ends of Exposure's range.
15. Presets that change sliders. One is applied just after a turn's `done`, so its `vals` arrive in the deck's echo window.
16. Held ticks dropped after 2 s outside Develop, while the switch to Develop takes 2.5 s (`moduleDelayMs`).
17. For the whole session:
    - every command is valid (the deck's `validate.ts`), and every `set` and `reset` carries `ph`, the photo of the latest `state`;
    - the rates for `set`, `ping`, strip updates and `vals`;
    - one `done` per gesture, except where `stale`, `locked` or the guard says otherwise;
    - `err` and alerts only where a step expects them;
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
- Every `set` carries that photo as `ph`, as the deck's do, so Lightroom refuses one that reaches another photo, even before a `state` says the photo changed.
- A `state` naming another photo, or a `set` refused as stale, stops the bursts at once.
- Before each burst, and before putting the value back, it asks for a fresh `state` with `hello`. Each burst starts a new gesture, and Lightroom puts a new gesture on whatever photo is the target. The states Lightroom pushes come from its 200 ms poll, so they can be behind.
- If Lightroom is on another photo by then, it skips the restore, prints "can't put back Exposure 0.35 on 101 (DSC01241.ARW): Lightroom is on 102 (DSC01242.ARW) now", and exits 1.
- Leaks count from a burst's first `ack`. The fresh greeting's `vals` arrive before it, and Lightroom sent them before the gesture began.
