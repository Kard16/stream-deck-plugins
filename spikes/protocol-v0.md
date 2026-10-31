# Spike protocol v0

Used only by the Phase 1 spikes: the spike build of `DeckBridge.lrdevplugin` and the Node harness in `spikes/lr-harness/`. Phase 2 replaces it with `lightroom/protocol/PROTOCOL.md`. Changes go through the main thread.

## Transport

- Lightroom binds two `LrSocket` listeners on localhost:
  - **58780**, `mode = 'receive'`: commands from the client.
  - **58781**, `mode = 'send'`: events to the client.
- The client connects to both, in either order, and reconnects with backoff (250 ms doubling to 2 s).
- Framing: one JSON object per line, ending in `\n`, UTF-8. Every message has a type field `t`.
- When a client connects to 58781, Lightroom sends `hello`, then one `state`, then `vals` for the watched params.
- A command may carry an integer `id`. Its reply carries the same `id`.
- Unknown `t`, bad JSON or a handler error produces `err`. The plugin keeps running.

## Commands (client → Lightroom, port 58780)

| `t` | Fields | Effect and reply |
|---|---|---|
| `hello` | `v: 0`, `client` | Resend `hello`, `state` and `vals`. |
| `ping` | `id` | `pong {id, lt}`. `lt` is `LrDate.currentTime()` in seconds. |
| `watch` | `ps: [param]` | Replace the watched params, then send `vals` for all of them. |
| `get` | `id`, `p` | `val {id, p, v}`. Switches to Develop if needed. |
| `range` | `id`, `p` | `range {id, p, min, max}`. Switches to Develop if needed. |
| `set` | `p`, `v`, `seq`, `track` (default `true`) | Guarded write. Switch to Develop if needed. If `track` is true and `p` isn't already being tracked, `startTracking(p)`. Then `setValue(p, v)`. Reply `ack {seq, p, v, ms, cy}`: `v` is `getValue(p)` straight after the set, `ms` is the handler's run time, `cy` is `LrTasks.canYield()` inside the handler. |
| `done` | none | `stopTracking()`. No reply. |
| `reset` | `p` | Guarded write. `resetToDefault(p)`. No reply. |
| `probe` | `id`, `name`, `args` (optional object) | Run a named probe (see below). Reply `result {id, name, ok, ms, data}` or `result {id, name, ok: false, ms, msg}`. |
| `reload` | `id` | S3: reload the reloadable modules without Lightroom's Reload Plug-in. Reply `result {id, name: "reload", ok, ms, data}`. |
| `bezel` | `msg`, `secs` (default 2) | `LrDialogs.showBezel(msg, secs)`. Used for on-screen captions while the user watches. |
| `select` | `id`, `what` (`"largestRaw"`, `"largestAny"` or `"index"`), `n` | Select one photo with `catalog:setSelectedPhotos`. Reply `result` with its file name, format, size and dimensions. |
| `config` | `pushHz` | Throttle for `vals`. `0` means unthrottled (the spike default). |

## Events (Lightroom → client, port 58781)

| `t` | Fields |
|---|---|
| `hello` | `v: 0`, `lr` (Lightroom version string), `catalog` (file name), `path` (full `.lrcat` path), `guard` (`"on"` or `"off"`), `writable` (whether writes are allowed now), `inst` (random id, new on every plugin load), `gen` (send-socket generation) |
| `state` | `module`, `photo` (`localIdentifier` as a string, or null), `file`, `flag` (-1, 0, 1), `rating` (0–5), `label`, `sel` (number of target photos). Sent on any change, from a 200 ms poll. |
| `vals` | `vals: {param: number}`, `lt`. Watched params whose value changed, from the adjustment observer. |
| `val`, `range`, `ack`, `pong`, `result` | As above. |
| `trigger` | `name`: `"tests"` or `"autosync"`. Sent when the user picks the matching menu item. |
| `err` | `id` (if the command had one), `msg`, `cmd` (the offending `t`) |
| `bye` | `why`: `"shutdownPlugin"` or `"shutdownApp"`. Best effort, just before the sockets close. |

## Guard

Writes are `set`, `reset` and the probes that change photos (`mask`, `flagAdvance`, `autoSync`). They only run while the active catalog's path is `/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat`. Otherwise the plugin replies `err {msg: "guard"}` and shows a bezel saying why.

## Probes

| `name` | What it does |
|---|---|
| `features` | Reports which newer functions exist: `LrDevelopController.setEnhance`, `getEnhancePanelState`, `changeDenoiseAmount`, `createNewMask`, `LrApplication.shutdown`, `addActivePhotoChangeObserver`, `addHapticObserver`, `LrSelection.removeFromCatalog`, `photo.isAvailableForEditing`, `catalog.getPhotosAvailableForEditing`, `LrDialogs.showBezel`, `loadstring`, `loadfile`, `dofile`. Also lists function names in `LrDevelopController`, `LrApplicationView`, `LrSelection` and `LrApplication`, if `pairs` works on them. |
| `ranges` | `getRange` and `getValue` for the 13 bank params, trying the `2012`-suffixed name too when the plain one fails. Also the active photo's file format. |
| `observerPhotoChange` | Counts adjustment-observer callbacks, calls `LrSelection.nextPhoto()`, waits 1.5 s, reports whether the count rose, then goes back with `previousPhoto()`. Then switches to Library and back to Develop, nudges Exposure by +0.01 and back, and reports whether callbacks still fire after the round trip. |
| `mask` | Guarded. `goToMasking()`, then `createNewMask('aiSelection', 'subject')`. Waits up to 15 s for `getAllMasks()` to grow, removes the mask again, returns to the loupe tool. Reports success, timing and errors. |
| `beforeAfter` | `showView('develop_before')`, waits `args.secs` (default 2), then `showView('develop_loupe')`. Reports errors. The user watches. |
| `presets` | Counts Develop preset folders and presets, lists the first 50 as `{folder, name, uuid}`, and times the call. |
| `timing` | Times 20 runs each of the state poll, `getTargetPhotos()` and the flag, rating and label getters. |
| `flagAdvance` | Guarded. Remembers the photo and its flag, calls `flagAsPick()`, waits 400 ms, reports whether the target photo changed (Lightroom's Auto Advance), then restores the flag and the photo. |
| `autoSync` | Guarded. Needs 2 or more selected photos. Reads `Exposure2012` from each selected photo's `getDevelopSettings()`, sets Exposure on the active photo to its value + 0.5, waits 2 s, `stopTracking()`, waits 1 s, reads them all again, restores the active photo's value. Reports which photos changed. |
| `requireVersion` | Returns `require('SpikeVersion').v`, plus `importOk` and `requireOk` from the module. |

## S3 reload target

`SpikeVersion.lua` has exactly this shape. The harness rewrites only the quoted string on the `local V = '…'` line, using a regex, and restores the file afterwards.

```lua
-- Spike S3: the harness rewrites the next line to test module reloading.
local V = 'v1'
local LrDate = import 'LrDate'
local json = require 'json'
return { v = V, importOk = LrDate ~= nil, requireOk = json ~= nil }
```

`reload` re-reads that file with `LrFileUtils.readFile`, compiles it with `loadstring` (falling back to `loadfile`, then `dofile`), runs it and returns the fresh table's fields. It must not touch the `require` cache, so `requireVersion` after a `reload` shows whether `require` still caches.
