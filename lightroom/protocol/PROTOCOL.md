# DeckBridge protocol, version 1

The wire protocol between the Lua plugin inside Lightroom Classic (`lightroom/lua/DeckBridge.lrdevplugin`) and the Stream Deck plugin (`lightroom/deck`). Frozen on 2026-10-31 from the Phase 1 spike results in `docs/lightroom/plan.md`. Amended the same day with what the three Phase 3 tracks found; [Amendments](#amendments) lists the changes.

Changes go through the main thread. A change that breaks either side bumps `v`.

Contents: [Transport](#transport) · [Connection lifecycle](#connection-lifecycle) · [Commands](#commands-deck--lightroom) · [Events](#events-lightroom--deck) · [Develop values](#develop-values) · [Guard](#guard) · [Errors](#errors) · [Rates](#rates) · [Fixtures](#fixtures) · [Amendments](#amendments)

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
2. Lightroom answers on the event socket with `hello`, then `state`. In Develop with a target photo, and only if some params are watched, it adds `ranges` and `vals` for them. It sends the same sequence whenever a client connects to the event socket. The watch list belongs to the plugin instance, not the connection, so it survives a reconnect but not a reload.
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
| `hello` | `v: 1`, `client`, `ver` | Sends `hello`, `state`, then `ranges` and `vals` as in lifecycle step 2. A deck `v` other than 1 still gets Lightroom's v1 `hello`, and is logged. | (those events) |
| `ping` | `id` | Nothing | `pong {id, lt}` |
| `watch` | `ps: [param]` | Replaces the watched params. Watching costs about 0.006 ms per param per read, so the deck watches every param in its banks, not just the visible four. An unknown param is dropped from the list, with `err {code: "bad"}` carrying the watch's `id`. `getRange` only works in Develop, so outside it Lightroom checks the list on entering Develop and sends that `err` then, still with the watch's `id`. Entries that aren't strings are dropped with `err bad` at once. | `ranges`, `vals` (Develop only) |
| `set` | `p`, `v`, `g` (all required) | Guarded. Switches to Develop if needed. Starts a gesture on `p` (see [Gestures](#gestures)), clamps `v` to `getRange(p)`, then `setValue(p, v)`. A missing `p`, a `v` or `g` that isn't a number, or a `p` that `getRange` rejects gets `err {code: "bad"}`. A set for a gesture that ended when the photo or module changed gets `err {code: "stale"}` and changes nothing, not even the module. | `ack {p, v, g}`, where `v` is `getValue(p)` straight after the set |
| `done` | `g` (optional) | Ends the gesture: `stopTracking()`. Lightroom's observer then fires, and `vals` carries the final value if it differs from the last value Lightroom sent for `p`. A `done` whose `g` isn't the open gesture's is late and ignored; one without `g` ends whatever gesture is open. | none |
| `reset` | `p` | Guarded. Switches to Develop if needed, ends any gesture, `resetToDefault(p)`. | `ack {p, v}` with the value after the reset |
| `module` | `v`: `"develop"` or `"library"` | `switchToModule(v)` | `state` once the module has changed, and also when Lightroom is already there; in Develop, `ranges` and every watched value too |
| `flag` | `v`: `"pick"`, `"reject"` or `"none"`; `advance` (bool, default false) | Guarded. `LrSelection.flagAsPick`, `flagAsReject` or `removeFlag`. With `advance`, waits 150 ms and calls `nextPhoto()` unless the target photo already changed, which means Lightroom's own Auto Advance moved on. | `state`, even when nothing changed. With `advance`, the `state` after the move always comes, preceded by one when the flag changed. |
| `nav` | `v`: `"next"` or `"prev"` | `LrSelection.nextPhoto()` or `previousPhoto()` | `state`, even at either end of the filmstrip |
| `view` | `v`: `"before"` or `"after"` | Switches to Develop if needed, then `showView('develop_before')` or `showView('develop_loupe')`. The Before/After key sends `before` on key down and `after` on key up. | none |
| `presets` | `id` | Lists every Develop preset | `presets {id, items}` |
| `preset` | `id`, `uuid` | Guarded. Applies the preset to every photo in `getTargetPhotos()`, in one `withWriteAccessDo` with `{timeout = 3}`. Does nothing when `getTargetPhoto()` is nil. Skips photos whose `isAvailableForEditing()` is false and counts them; a photo the apply fails on counts as locked too. | `applied {id, uuid, n, locked}` |
| `reload` | `id`, `mods` (optional list of names) | Development only. Re-reads the named modules from disk with `loadstring` and swaps them in, without the user clicking Reload Plug-in. Without `mods`, it reloads every reloadable module. Every module loads before any is swapped in, so one broken file changes nothing. The socket server, shared state, `Config` and `Guard` never reload. Answers `ok: false` and changes nothing while writes would be refused (see [Guard](#guard)), when a name isn't reloadable, or when reload is switched off in `Config`. | `reloaded {id, mods, ok, msg}`: `mods` lists the requested modules, or every reloadable one; `msg` says what happened |

Params are `LrDevelopController` parameter names, for example `Exposure`, not the `Exposure2012` names of develop settings.

## Events (Lightroom → deck)

| `t` | Fields | When |
|---|---|---|
| `hello` | `v: 1`, `lr` (version string), `catalog` (file name), `path` (full `.lrcat` path), `guard` (`"on"` or `"off"`), `writable` (bool), `inst` (random id, new on every plugin load; always present) | On every connect to the event socket, and in answer to `hello` |
| `state` | `module`, `photo` (`localIdentifier` as a string, or null), `file` (file name or null), `flag` (-1, 0, 1), `rating` (0–5), `label` (`"red"`, `"yellow"`, `"green"`, `"blue"`, `"purple"` or `"none"`), `sel` (number of target photos; 0 when there is no target photo, although `getTargetPhotos()` then returns the whole filmstrip) | After `hello`, and whenever a field changes: from a 200 ms poll, and in Develop also within milliseconds of a photo change, through the adjustment observer |
| `ranges` | `ranges: {param: [min, max]}` | In Develop: after `hello`, after `watch`, on entering Develop, on every photo change. Ranges depend on the file type. A range Lightroom can't read yet, for example while Develop is still loading the photo, follows in a later `ranges`. |
| `vals` | `vals: {param: number}` | In Develop: the changed watched params, from the adjustment observer and a 200 ms value poll, diffed against what was last sent. All watched params after `hello`, after `watch`, on entering Develop and on every photo change, except the param of an open gesture. A value Lightroom can't read yet follows in a later `vals`, so these can arrive in parts. Never outside Develop. |
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

**Outside Develop** there are no values, because `LrDevelopController` only works in Develop. The deck keeps showing the last values, dimmed. A dial turn sends `module {v: "develop"}` first. The deck holds the ticks until `ranges` and `vals` for the new photo arrive, then applies them. If nothing arrives within 2 s, it drops them. After any photo change, too, a param's turns wait for that photo's range and value.

### Gestures

Spike S2 showed that a gesture must be tracked to become a history step, and that Lightroom's observer stays silent during a tracked gesture.

- **The deck** numbers its gestures `g`: one gesture is one burst of turning on one dial. It sends `set` with the latest absolute value at most 30 times a second per param, and `done` 800 ms after the last tick, or on dial-up after push-and-turn. A restarted deck may number from 1 again.
- **Lightroom** treats a `set` whose `p` or `g` differs from the current gesture as a new gesture: `stopTracking()` on the old one, then `startTracking(p)`. Lightroom also ends the gesture itself, as if `done` had arrived, when:
  - no `set` arrives for 2 s;
  - the client disconnects;
  - the target photo changes, through the user or Lightroom's own Auto Advance;
  - the deck sends `nav`, or a flag's `advance` moves on, even at an end of the filmstrip where nothing moves;
  - Develop is left;
  - the plugin shuts down.
- **A gesture belongs to the photo it started on.** When Lightroom ends a gesture for one of the photo or module reasons above, later `set`s with that `g` carry values the deck worked out for the old photo. Lightroom refuses each one with `err {code: "stale"}`, and it switches no module and changes no value. It also catches a photo change that a `set` reaches before the poll does. Lightroom forgets the stale `g` when the next gesture starts or a client connects.
- **The deck on `stale`:**
  - It ends that gesture without sending `done`, and raises no alert.
  - If it hasn't yet seen `state` for the new photo, it holds turns, as it does before its own `nav`. The hold lasts until it has `state`, `ranges` and `vals` for the new photo, or until 500 ms pass. It also ends any other open gesture, since that one started from the old photo's values too.
  - If it has already seen that `state`, it ended its gestures there, as on any photo change. The `done` it sent then is late, and Lightroom ignores it.
  - Either way, the next turn starts a new `g` from the new photo's values.
- **Not covered yet:** a new gesture that starts in the few milliseconds between a photo change in Lightroom and the deck receiving its `state`. Its first `set` still uses the old photo's value. Closing this gap would need `set` to carry the photo the deck worked from; that's a Phase 6 hardening item.
- **Echoes:** while a gesture tracks `p`, Lightroom leaves `p` out of `vals`, even in a push of every watched value; the deck owns that value. For 300 ms after the deck sends `done`, it holds any `vals` for `p` instead of applying them, then applies the latest one when the window closes; if none came, it keeps the last `ack`'s value. Lightroom only resends values that changed, so a `vals` discarded in that window would never come again.
- One gesture makes one history step.

## Guard

While `Config.GUARD` is true, writes only go through when the active catalog's path is `/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat`, compared without case. Only the user turns the guard off.

- **Writes:** `set`, `reset`, `flag` and `preset`. `reload` is refused at the same times, because it can swap the write handlers.
- **A refused write** gets `err {code: "guard"}`. Lightroom also shows a bezel saying why, at most every 5 s, and the deck shows an alert on the key or dial that sent it.
- **`hello.writable`** says up front whether writes will go through. When it's false, a dial still sends the first `set` of each burst and keeps the rest, so Lightroom's bezel says why nothing moves and `err guard` alerts the dial.
- **Order of checks** for a write: fields (`bad`), the guard (`guard`), then for `set` a stale gesture (`stale`), the switch to Develop if needed (`noDevelop`), then the target photo and param (`noPhoto`, `bad`, `notFound`). A refused write changes no value. A `bad` field, `guard` or `stale` refusal comes before the module switch, so it leaves the module alone; a `noPhoto` or unknown-param refusal comes after it, so Lightroom may already be in Develop.

## Errors

`err {id, cmd, code, msg}`. `msg` is for logs. The deck acts on `code`:

| `code` | Meaning |
|---|---|
| `guard` | Writes are off: the test catalog isn't open |
| `bad` | Bad JSON, a missing or wrong-typed field, or an unknown param or value |
| `unknown` | Unknown command type |
| `noDevelop` | Couldn't switch to Develop |
| `noPhoto` | No target photo, for `set`, `reset`, `flag` and `preset` |
| `stale` | The `set`'s gesture ended when the photo or module changed; nothing changed. The deck goes on with a new gesture and raises no alert (see [Gestures](#gestures)) |
| `notFound` | No preset with that `uuid` |
| `busy` | The catalog was busy; `withWriteAccessDo` timed out |
| `failed` | The handler raised an error; `msg` has it |

## Rates

| What | Limit |
|---|---|
| `set` | At most 30 a second per param, latest value only. One exception: when the deck ends a gesture early, because another dial takes over, a reset, or a photo change, that gesture's pending final `set` goes out at once, once per gesture. |
| `ping` | Every 2 s |
| `vals` | At most 20 a second, pushes of every watched value included; a push that falls inside the 50 ms gap is sent when the gap ends |
| `state` | On change, from a 200 ms poll |
| Strip updates (deck internal) | At most 15 a second per dial, only the changed layout keys |

Spike S2 measured `set` at 60 a second on a 47.7 MB raw: about 1 ms in Lightroom, ack p95 3 ms or less, no backlog.

## Fixtures

`fixtures/*.jsonl` are example conversations, each a contract both sides test against. Every line is one JSON object:

| Line | Meaning |
|---|---|
| `{"note": "…"}` | Ignored |
| `{"setup": {…}}` | The first line after any `note` lines: Lightroom's state before the conversation (see below) |
| `{"deck": {…}}` | A message the deck sends. A Lightroom implementation receives it. |
| `{"raw": "…"}` | A raw line the deck sends, for malformed input |
| `{"lr": {…}}` | A message Lightroom must send next |
| `{"never": {…}}` | No message matching this may arrive after the previous `lr` match (or the start), up to the message that matches the next `lr` line. That includes messages that arrived before the `never` line was read. The message that matches the next `lr` line isn't checked. After the last `lr` line, `never` lines hold to the end of the fixture. |
| `{"user": {…}}` | Something the user does in Lightroom. Offline runners apply it to their fake Lightroom: `{"photo": "102"}` makes that photo the only selected one and the target, `{"module": "library"}` switches modules, `{"edit": {"Exposure": 0.5}}` is a mouse edit on the target photo, and `{"selected": ["101", "102"]}` changes the selection, with the first id as the target. An empty `selected` leaves no target photo. |
| `{"wait": ms}` | Lets time pass, for example for the 2 s gesture timeout |
| `{"expect": {…}}` | Lightroom's state must now be this. Offline runners check whichever fields they model: `values` (`{photo: {param: v}}`), `flags` (`{photo: flag}`), `target`, `module`, `view` (`"before"` or `"loupe"`), `tracking` (false when no gesture is open), `applied` (`{photo: [uuid]}`). `values` and `flags` are partial: only the listed photos and params are checked. `applied` is exact: exactly the listed photos have presets applied, with these uuids in order, so `"applied": {}` means none. |

**Running a fixture:**
- The runner connects both sockets, throws away whatever Lightroom sends on connect, then plays the lines in order. A runner on real sockets can't see where the greeting ends, so it waits for the greeting's `hello`, sends a `ping`, and throws away everything up to the `pong`.
- Offline runners own the clock. After every `deck`, `raw` and `user` line they advance it 200 ms and run Lightroom's poll once. A `wait` advances it in 200 ms poll steps.

**Matching `lr` lines:**
- Expected messages are matched in order. Between two of them, and after the last one, an implementation may send extra `state`, `vals`, `ranges` or `pong` messages that don't match the next expected line. Any other unexpected message fails the fixture, and so does anything but `ok` on the command socket.
- Every field in an expected message must be present and equal; extra fields are allowed.
- `"*"` matches any value. Numbers match within 1e-6.
- Arrays match when they have the same length and each element matches, in order.
- In `vals` and `ranges`, the expected keys must be present; others may be too.
- Fixtures only assert orderings Lightroom guarantees. For example, the observer's `vals` after a gesture ends arrives a few ms later and can land before or after the next `ack`, so fixtures check the outcome with `expect` instead.

**`setup`** fields, all optional:
- `catalog`: catalog path; defaults to the test catalog.
- `module`: defaults to `"develop"`.
- `photos`: list of `{id, file, fmt, flag, rating, label, values}`. `fmt` is `"RAW"`, `"DNG"` or `"JPG"`; `values` holds the controller values for that photo.
- `target`: id of the target photo; defaults to the first id in `selected`, or else the first photo.
- `selected`: ids of the target photos; defaults to `[target]`. A `target` missing from `selected` is added to it.
- `ranges`: `{fmt: {param: [min, max]}}`; defaults to the measured raw ranges for `RAW` and `DNG`, with -100..100 Temperature and Tint for `JPG`.
- `presets`: list of `{uuid, name, folder}`.
- `autoAdvance`: whether Lightroom's own Auto Advance is on; defaults to false.
- `watch`: the watched params at the start; defaults to none.

Every runner reads the same files: the Lua unit tests with stubbed `Lr*` modules, the mock Lightroom in `lightroom/tools`, and the deck plugin's tests. The deck's tests feed the `lr` lines in and check the deck's model and outgoing commands. A deck runner numbers commands its own way, so an `id` on a `deck` line only asks for some integer id, and the matching `lr` reply carries whichever id the deck used.

## Amendments

2026-10-31, after the Phase 3 build. Nothing here changes `v`: an older deck shows an alert for the new `stale` code, and everything else writes down what both implementations already do.
- **New:** `err {code: "stale"}` for a `set` whose gesture ended when the photo or module changed (see [Gestures](#gestures)). Fixture `stale-gesture.jsonl`.
- **Gestures** also end on a photo change, on leaving Develop and at shutdown. A late `done` is ignored. While a gesture is open, its param stays out of `vals`, even in a push of every watched value.
- **Echo window:** the deck holds `vals` for `p` during the 300 ms after `done` and applies the latest when the window closes, rather than dropping them.
- **Replies:** `module` always answers with `state`, even when Lightroom is already in that module. `flag` and `nav` always answer with `state`. `set` requires `g`. `noPhoto` applies to `set`, `reset` and `flag` too. Unknown params in `watch` found later carry the watch's `id`. `state.sel` is 0 without a target photo. `hello` always carries `inst`.
- **Guard:** `reload` is refused whenever writes would be. Writes are checked in a fixed order.
- **Rates:** pushes of every watched value keep to the `vals` limit. One early final `set` per gesture is allowed when the deck ends a gesture to start another.
- **Fixtures:** the `setup` line comes after any notes. `never` windows are defined, along with what happens after the last `lr` line. `applied` is matched exactly. There's a greeting rule for socket runners, and `target` defaults to the first selected photo.
