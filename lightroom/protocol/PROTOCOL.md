# DeckBridge protocol, version 1

The wire protocol between the Lua plugin inside Lightroom Classic (`lightroom/lua/DeckBridge.lrdevplugin`) and the Stream Deck plugin (`lightroom/deck`). Frozen on 2026-10-31 from the Phase 1 spike results in `docs/lightroom/plan.md`.

Changes go through the main thread. A change that breaks either side bumps `v`.

Contents: [Transport](#transport) · [Connection lifecycle](#connection-lifecycle) · [Commands](#commands-deck--lightroom) · [Events](#events-lightroom--deck) · [Develop values](#develop-values) · [Guard](#guard) · [Errors](#errors) · [Rates](#rates) · [Fixtures](#fixtures)

## Transport

- Lightroom listens on two localhost ports, because each `LrSocket` is one-way:
  - **58780**, `mode = 'receive'`: commands from the deck.
  - **58781**, `mode = 'send'`: events to the deck.
  - Never 58763/58764: MIDI2LR and lightroom-mcp use them.
- The deck is the client and connects to both.
- **Framing:** one JSON object per line, ending in `\n`, UTF-8. Every message has a type field `t`. Unknown fields are ignored, so either side can add fields without a version bump.
- **`ok` lines:** Lightroom's receive socket writes the line `ok` back for every line it receives. The deck must keep reading the command socket and discard these. They aren't JSON and aren't replies, but their timing shows whether Lightroom is taking lines at all (see [Heartbeat](#heartbeat)).
- **The pair rule:** when either socket closes, errors or fails to connect, the deck closes the other one too and reconnects both. Lightroom's send socket never notices a client leaving, and only the receive socket's close tells it to recreate the sender. A deck that keeps one socket open after losing the other leaves Lightroom writing into a dead connection.
- **Backoff:** reconnect after 250 ms, doubling to at most 2 s, forever. macOS 26 can refuse localhost connections for minutes after a reboot, and Lightroom may simply not be running.

## Connection lifecycle

1. The deck connects both sockets and sends `hello`.
2. Lightroom answers on the event socket with `hello`, then `state`. In Develop, and only if some params are watched, it adds `ranges` and `vals` for them. It sends the same sequence whenever a client connects to the event socket. The watch list belongs to the plugin instance, not the connection, so it survives a reconnect but not a reload.
3. The deck sends `watch` with the params it shows. Lightroom answers with `ranges` and `vals` when in Develop.
4. From then on Lightroom pushes `state`, `ranges` and `vals` as things change, and answers commands.

**There's no goodbye.** Lightroom closes plugin sockets before its shutdown hooks run, so any disconnect means "offline". Lightroom also closes connections on its own sometimes, for example around its menus and the Plug-in Manager; the deck just reconnects.

**A new `inst` in `hello`** means the plugin was reloaded or Lightroom relaunched. The deck drops its cached values and ranges, keeps its banks, and sends `watch` again.

**Version check:** if `hello.v` isn't 1, the deck shows a version mismatch and sends nothing but `hello` and `ping`.

### Heartbeat

- The deck sends `ping` every 2 s. Lightroom answers `pong`.
- No event at all for 6 s, while Lightroom still answers each line with `ok` within 1.5 s, means the event socket is stale. The deck reconnects both sockets.
- If the `ok`s stop too, Lightroom is paused by an open menu, dialog or the Plug-in Manager: its plugin tasks pause, and it stops taking lines. The deck shows "Lightroom busy" and waits instead of reconnecting.

## Commands (deck → Lightroom)

Any command may carry an integer `id`. Replies to it (`pong`, `presets`, `applied`, `reloaded`, and `err`) carry the same `id`. "Guarded" means the command is a write and goes through the [Guard](#guard).

| `t` | Fields | Lightroom does | Reply |
|---|---|---|---|
| `hello` | `v: 1`, `client`, `ver` | Sends `hello`, `state`, then `ranges` and `vals` if in Develop | (those events) |
| `ping` | `id` | Nothing | `pong {id, lt}` |
| `watch` | `ps: [param]` | Replaces the watched params. Watching costs about 0.006 ms per param per read, so the deck watches every param in its banks, not just the visible four. An unknown param is dropped from the list, with `err {code: "bad"}`. | `ranges`, `vals` (Develop only) |
| `set` | `p`, `v`, `g` | Guarded. Switches to Develop if needed. Starts a gesture on `p` (see [Gestures](#gestures)), clamps `v` to `getRange(p)`, then `setValue(p, v)`. A `p` that `getRange` rejects, or a `v` that isn't a number, gets `err {code: "bad"}`. | `ack {p, v, g}`, where `v` is `getValue(p)` straight after the set |
| `done` | `g` (optional) | Ends the gesture: `stopTracking()`. Lightroom's observer then fires, and `vals` carries the final value. | none |
| `reset` | `p` | Guarded. Switches to Develop if needed, ends any gesture, `resetToDefault(p)`. | `ack {p, v}` with the value after the reset |
| `module` | `v`: `"develop"` or `"library"` | `switchToModule(v)` | `state` once the module has changed; in Develop, `ranges` and `vals` too |
| `flag` | `v`: `"pick"`, `"reject"` or `"none"`; `advance` (bool, default false) | Guarded. `LrSelection.flagAsPick`, `flagAsReject` or `removeFlag`. With `advance`, waits 150 ms and calls `nextPhoto()` unless the target photo already changed, which means Lightroom's own Auto Advance moved on. | `state` |
| `nav` | `v`: `"next"` or `"prev"` | `LrSelection.nextPhoto()` or `previousPhoto()` | `state` |
| `view` | `v`: `"before"` or `"after"` | Switches to Develop if needed, then `showView('develop_before')` or `showView('develop_loupe')`. The Before/After key sends `before` on key down and `after` on key up. | none |
| `presets` | `id` | Lists every Develop preset | `presets {id, items}` |
| `preset` | `id`, `uuid` | Guarded. Applies the preset to every photo in `getTargetPhotos()`, in one `withWriteAccessDo` with `{timeout = 3}`. Does nothing when `getTargetPhoto()` is nil. Skips photos whose `isAvailableForEditing()` is false and counts them. | `applied {id, uuid, n, locked}` |
| `reload` | `id`, `mods` (optional list) | Development only. Re-reads the named modules from disk with `loadstring` and swaps them in, without the user clicking Reload Plug-in. Without `mods`, it reloads every reloadable module. The socket server and shared state never reload. | `reloaded {id, mods, ok, msg}` |

Params are `LrDevelopController` parameter names, for example `Exposure`, not the `Exposure2012` names of develop settings.

## Events (Lightroom → deck)

| `t` | Fields | When |
|---|---|---|
| `hello` | `v: 1`, `lr` (version string), `catalog` (file name), `path` (full `.lrcat` path), `guard` (`"on"` or `"off"`), `writable` (bool), `inst` (random id, new on every plugin load) | On every connect to the event socket, and in answer to `hello` |
| `state` | `module`, `photo` (`localIdentifier` as a string, or null), `file` (file name or null), `flag` (-1, 0, 1), `rating` (0–5), `label` (`"red"`, `"yellow"`, `"green"`, `"blue"`, `"purple"` or `"none"`), `sel` (number of target photos) | After `hello`, and whenever a field changes, from a 200 ms poll |
| `ranges` | `ranges: {param: [min, max]}` | In Develop: after `hello`, after `watch`, on entering Develop, on every photo change. Ranges depend on the file type. |
| `vals` | `vals: {param: number}` | In Develop: the changed watched params, from the adjustment observer and a 200 ms value poll, diffed against what was last sent. All watched params after `hello`, after `watch`, on entering Develop and on every photo change. Never outside Develop. |
| `ack` | `p`, `v`, `g` (absent after `reset`) | Answers `set` and `reset` |
| `presets` | `id`, `items: [{uuid, name, folder}]` | Answers `presets` |
| `applied` | `id`, `uuid`, `n` (photos changed), `locked` (photos skipped) | Answers `preset` |
| `reloaded` | `id`, `mods`, `ok`, `msg` | Answers `reload` |
| `pong` | `id`, `lt` (`LrDate.currentTime()`, seconds) | Answers `ping` |
| `err` | `id` (if the command had one), `cmd` (the command's `t`, if known), `code`, `msg` | See [Errors](#errors) |

## Develop values

**Values** are what `LrDevelopController.getValue` returns:
- Exposure is in EV.
- Temperature is in Kelvin for raw and DNG files, but -100..100 for JPEG and other rendered files.
- Everything else is in slider units.

The deck rounds before sending: Exposure to 0.01, everything else to whole numbers. `setValue` clamps nothing, so Lightroom clamps `set.v` to the param's range first.

**Ranges** come only from `getRange` in Develop, and the deck clamps its own values to them. Ranges measured on the user's raws (2026-10-31):

| Param | Range on raw |
|---|---|
| Temperature | 2000 … 50000 (K) |
| Tint | -150 … 150 |
| Exposure | -5 … 5 |
| Every other bank param | -100 … 100 |

**Outside Develop** there are no values, because `LrDevelopController` only works in Develop. The deck keeps showing the last values, dimmed. A dial turn sends `module {v: "develop"}` first. The deck holds the ticks until `vals` for the new photo arrive, then applies them. If nothing arrives within 2 s, it drops them.

### Gestures

Spike S2 showed that a gesture must be tracked to become a history step, and that Lightroom's observer stays silent during a tracked gesture.

- **The deck** numbers its gestures `g`: one gesture is one burst of turning on one dial. It sends `set` with the latest absolute value at most 30 times a second per param, and `done` 800 ms after the last tick, or on dial-up after push-and-turn.
- **Lightroom** treats a `set` whose `p` or `g` differs from the current gesture as a new gesture: `stopTracking()` on the old one, then `startTracking(p)`. If no `set` arrives for 2 s, or the client disconnects, Lightroom ends the gesture itself, as if `done` had arrived.
- **Echoes:** while a gesture tracks `p`, Lightroom leaves `p` out of `vals`; the deck owns that value. The deck also ignores `vals` for `p` until 300 ms after it sent `done`.
- One gesture makes one history step.

## Guard

While `Config.GUARD` is true, writes only go through when the active catalog's path is `/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat`, compared without case. Only the user turns the guard off.

- **Writes:** `set`, `reset`, `flag` and `preset`.
- **A refused write** gets `err {code: "guard"}`. Lightroom also shows a bezel saying why, at most every 5 s, and the deck shows an alert on the key or dial that sent it.
- **`hello.writable`** says up front whether writes will go through.

## Errors

`err {id, cmd, code, msg}`. `msg` is for logs. The deck acts on `code`:

| `code` | Meaning |
|---|---|
| `guard` | Writes are off: the test catalog isn't open |
| `bad` | Bad JSON, a missing or wrong-typed field, or an unknown param or value |
| `unknown` | Unknown command type |
| `noDevelop` | Couldn't switch to Develop |
| `noPhoto` | No target photo |
| `notFound` | No preset with that `uuid` |
| `busy` | The catalog was busy; `withWriteAccessDo` timed out |
| `failed` | The handler raised an error; `msg` has it |

## Rates

| What | Limit |
|---|---|
| `set` | At most 30 a second per param, latest value only |
| `ping` | Every 2 s |
| `vals` | At most 20 a second |
| `state` | On change, from a 200 ms poll |
| Strip updates (deck internal) | At most 15 a second per dial, only the changed layout keys |

Spike S2 measured `set` at 60 a second on a 47.7 MB raw: about 1 ms in Lightroom, ack p95 3 ms or less, no backlog.

## Fixtures

`fixtures/*.jsonl` are example conversations, each a contract both sides test against. Every line is one JSON object:

| Line | Meaning |
|---|---|
| `{"note": "…"}` | Ignored |
| `{"setup": {…}}` | First line: Lightroom's state before the conversation (see below) |
| `{"deck": {…}}` | A message the deck sends. A Lightroom implementation receives it. |
| `{"raw": "…"}` | A raw line the deck sends, for malformed input |
| `{"lr": {…}}` | A message Lightroom must send next |
| `{"never": {…}}` | Until the next `lr` line is matched, Lightroom must not send a message matching this |
| `{"user": {…}}` | Something the user does in Lightroom. Offline runners apply it to their fake Lightroom: `{"photo": "102"}` makes that photo the only selected one and the target, `{"module": "library"}` switches modules, `{"edit": {"Exposure": 0.5}}` is a mouse edit on the target photo, and `{"selected": ["101", "102"]}` changes the selection, with the first id as the target. An empty `selected` leaves no target photo. |
| `{"wait": ms}` | Lets time pass, for example for the 2 s gesture timeout |
| `{"expect": {…}}` | Lightroom's state must now be this. Offline runners check whichever fields they model: `values` (`{photo: {param: v}}`), `flags` (`{photo: flag}`), `target`, `module`, `view` (`"before"` or `"loupe"`), `tracking` (false when no gesture is open), `applied` (`{photo: [uuid]}`). |

**Running a fixture:**
- The runner connects both sockets, throws away whatever Lightroom sends on connect, then plays the lines in order.
- Offline runners own the clock. After every `deck`, `raw` and `user` line they advance it 200 ms and run Lightroom's poll once. A `wait` advances it in 200 ms poll steps.

**Matching `lr` lines:**
- Expected messages are matched in order. Between two of them, an implementation may send extra `state`, `vals`, `ranges` or `pong` messages that don't match the next expected line. Any other unexpected message fails the fixture.
- Every field in an expected message must be present and equal; extra fields are allowed.
- `"*"` matches any value. Numbers match within 1e-6.
- Arrays match when they have the same length and each element matches, in order.
- In `vals` and `ranges`, the expected keys must be present; others may be too.
- Fixtures only assert orderings Lightroom guarantees. For example, the observer's `vals` after a gesture ends arrives a few ms later and can land before or after the next `ack`, so fixtures check the outcome with `expect` instead.

**`setup`** fields, all optional:
- `catalog`: catalog path; defaults to the test catalog.
- `module`: defaults to `"develop"`.
- `photos`: list of `{id, file, fmt, flag, rating, label, values}`. `fmt` is `"RAW"`, `"DNG"` or `"JPG"`; `values` holds the controller values for that photo.
- `target`: id of the target photo; defaults to the first.
- `selected`: ids of the target photos; defaults to `[target]`.
- `ranges`: `{fmt: {param: [min, max]}}`; defaults to the measured raw ranges for `RAW` and `DNG`, with -100..100 Temperature and Tint for `JPG`.
- `presets`: list of `{uuid, name, folder}`.
- `autoAdvance`: whether Lightroom's own Auto Advance is on; defaults to false.
- `watch`: the watched params at the start; defaults to none.

Every runner reads the same files: the Lua unit tests with stubbed `Lr*` modules, the mock Lightroom in `lightroom/tools`, and the deck plugin's tests. The deck's tests feed the `lr` lines in and check the deck's model and outgoing commands.
