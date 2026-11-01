# Lightroom Classic build plan

**Status:** Phases 0–6 are done, with Phase 5 as scoped at kickoff. The guard is off, for daily use with the user's own catalogs. Written 2026-10-31 at the end of the research session.

The build session records decisions and spike results in **Log** at the bottom and keeps **Progress** current, so a fresh session can pick up from this file.

## Goal

Drive Lightroom Classic from the Stream Deck + on this Mac:

1. **Develop sliders on the dials.** Each dial's strip segment shows the slider's name and live value, and follows changes made in Lightroom with the mouse.
2. **Culling and rating keys.** Key images show the current photo's flag, stars and colour label.
3. **Presets and one-click tools** on keys.

Done means two things:
- The user can cull a shoot and do a basic edit pass from the deck.
- The deck recovers on its own when Lightroom, the Stream Deck app or the Mac restarts.

**Out of scope:**
- Marketplace, Windows.
- A Claude↔Lightroom bridge, Lightroom (cloud).
- Brush painting, Generative Remove.

## Prerequisites

The user does this before kickoff:

- Creates a test catalog with 20–50 copies of real photos, including a few of the largest raws. Path: `/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat` (recorded at kickoff, 2026-10-31).

Already done on 2026-10-31:
- Node 24 and Lua 5.1.5 from `mise.toml` installed.
- Stream Deck app 7.6.0 (build 23012) installed. SDK 3 needs 7.1 or later.
- The Stream Deck + is plugged into the user's dock, not the Mac, and stays there by the user's choice (see Risks).

Check these at kickoff and ask for anything missing.

## Already decided

| Topic | Decision | Source |
|---|---|---|
| Plugins | The Lightroom side is its own Stream Deck plugin. Claude Code gets a separate one later, so restarting one never disturbs the other. | SD research §8 |
| Transport | The Lua plugin binds two localhost sockets, because each `LrSocket` is one-way. See the transport notes below. | LR research §5.1, §8 |
| Framing | Newline-delimited JSON, using a vendored pure-Lua JSON library (MIT or similar). | LR research §1.3 |
| Value ownership | The deck plugin keeps a value model per parameter. See the value-model notes below. | LR research §2.4, §8 |
| History | `startTracking` on the first tick. `done` (→ `stopTracking`) on dial release or touch-up. One history step per gesture. | LR research §2.4 |
| Lightroom → deck | Watched parameters only, on change, at most 20 times a second. Module, photo, flag, rating and label are polled every 150–250 ms. | LR research §8 |
| Ticks | Coalesce per dial (~40 ms), with our own acceleration curve and a per-parameter step table. See the tick notes below. | SD research §2.8, LR research §8 |
| Strip | Custom layout with label, value and bar. Send diffs only, at most 10–15 updates a second per dial. | SD research §2.4, §2.7 |
| Shortcut-only features | Sync dialog, Auto Sync and brush size use Stream Deck's built-in Hotkey action, set up by the user. No plugin code. | LR research §4 |
| Test-catalog guard | During development the Lua plugin refuses every write unless the test catalog is open. See the guard notes below. | This plan |
| Names | Lua plugin `lightroom/lua/DeckBridge.lrdevplugin`, with `LrToolkitIdentifier` `com.karimdhanji.deckbridge`. Stream Deck plugin UUID `com.karimdhanji.lightroom`. | This plan |

**Transport notes**
- Commands go to port 58780, where Lightroom receives.
- Events come from port 58781, where Lightroom sends.
- The deck plugin is the client and reconnects with backoff.
- Never use 58763/58764; MIDI2LR and lightroom-mcp use them.

**Value-model notes**
- The deck plugin applies ticks to its own value immediately.
- It sends the latest absolute value at most 30 times a second.
- It ignores Lightroom's echo of that parameter for about 300 ms after its own write.

**Tick notes**
- Step examples: Exposure 1/30 EV per tick, Temperature 50 K, everything else about 1/200 of its range.
- Push + turn adjusts in fine steps.

**Guard notes**
- "Every write" means Develop changes, flags, ratings and presets.
- Writes go through only when the active catalog's path matches the test catalog.
- When a write is refused, the deck shows a warning.
- Only the user turns the guard off.

## Open questions for the user

Ask these in one round at kickoff, with a recommendation for each, and record the answers in the log.

1. **Dial banks.** All four dials page together. Banks live in a JSON file the user can edit. Proposed:
   1. Light: Exposure, Contrast, Highlights, Shadows
   2. Range: Whites, Blacks, Texture, Clarity
   3. Colour: Temperature, Tint, Vibrance, Saturation
   4. Finish: Dehaze, PostCropVignetteAmount, Sharpness, LuminanceSmoothing
   5. Mask (applies to the selected mask): local_Exposure, local_Contrast, local_Highlights, local_Shadows
2. **Dial gestures.** Proposed:
   - Turn = adjust; push + turn = fine adjust; push = reset this slider.
   - Tap the strip = next bank; long-touch = previous bank.
   - If the user stacks actions on a dial, the stack takes the push, so reset also needs a touch gesture.
3. **Turning a dial in Library.** Switch to Develop (recommended), or use Quick Develop nudges? Quick Develop covers only nine sliders (LR research §2.3).
4. **Keys.** The plugin provides actions; the user arranges keys and pages in the Stream Deck app.
   - Proposed actions: Pick, Reject, Unflag, Set rating n, Rating +/−, Colour label, Previous/Next photo, Library/Develop.
   - Also propose a starting Cull page and Edit page.
5. **Presets and tools.** Which presets and one-click tools come first?
6. **Several photos selected.** Should dial edits reach all of them? Whether Auto Sync carries `setValue` changes is unverified (LR research §2.5). The fallback is `applyDevelopSettings` on each photo.
7. **Strip extras.** Should a histogram or thumbnail on the strip be a later milestone, or skipped?

## Phases

Each phase ends with a verification step. Phases 1 and 2 are mostly serial. Phase 3 is where parallel tracks pay off.

### Phase 0: kickoff (main thread)

1. Read this plan and `CLAUDE.md`.
2. Read the research:
   - LR research §2, §4, §5 and §8–§10.
   - SD research §2, §4, §7 and §8.
   - The code snippets both reports end with.
3. Check the prerequisites, and record the test catalog path above.
4. Ask the open questions.

### Phase 1: spikes

Answer the risky questions before building on them. Spike code lives in `spikes/`. Report the results to the user and record them in the log.

**S1: sockets.** Does a minimal DeckBridge bind both ports, survive the client dropping and reconnecting, and keep working after Reload Plug-in?
- How: the snippets in LR research §9.1–§9.2, plus a Node client script.
- Pass: 10 disconnect/reconnect cycles without restarting Lightroom, and a clean shutdown on quit.

**S2: latency.** How fast is dial control on the largest raw?
- How: a Node script sets Exposure at 15, 30 and 60 Hz for 5 s each, with and without tracking. Time each write until its echo arrives.
- Pass:
  - Median and p95 echo latency reported.
  - No growing backlog.
  - One history step per gesture.
  - The user says the image keeps up.

**S3: hot reload.** Can agents reload Lua without the user clicking Reload Plug-in? Try these in order:
1. Check whether Lightroom's `require` caches modules across reloads.
2. Try a loader that reloads modules on a `reload` command, based on John R. Ellis's reloadable `Require.lua` (LR research §6).
3. Fall back to AppleScript UI scripting of the Plug-in Manager.

Pass: a working hot-reload path, or a firm "the user must click Reload".

**S4: Stream Deck + basics.**
- How:
  - Scaffold the deck plugin, with one encoder action using a custom label/value/bar layout.
  - Log `dialRotate` ticks during fast spins.
  - Check whether the app launches the plugin before any action is placed.
- Pass: `streamdeck validate` passes, the user confirms the strip renders, and tick batching is measured.

**S5: what works on 15.3?**
- How:
  - Feature-detect `setEnhance`.
  - Try `createNewMask('aiSelection', 'subject')`.
  - Check whether the adjustment observer fires on photo change.
  - Check whether Auto Sync carries `setValue` changes.
- Pass: a list of what works, recorded in the log.

S1, S2, S3 and S5 need Lightroom, so run them one at a time. S4 needs the deck and can run alongside them.

Batch the user's steps into one checklist:
- Add the plugin.
- Open the test catalog in Develop.
- Place the action on a dial.
- Look at the strip.

### Phase 2: freeze the contract (main thread)

Write `lightroom/protocol/PROTOCOL.md`. It covers messages, fields, rates, heartbeats, errors and a version number.

Write `lightroom/protocol/fixtures/*.jsonl`: example streams that both sides test against.

After the freeze, protocol changes go through the main thread.

Starting sketch (LR research §8 has the full command list):

```
deck → LR   {"t":"hello","v":1}
            {"t":"watch","ps":["Exposure","Contrast","Highlights","Shadows"]}
            {"t":"set","p":"Exposure","v":0.35}         absolute; Lightroom clamps
            {"t":"done"}                                stopTracking: one history step
            {"t":"reset","p":"Exposure"}
            {"t":"range","id":7,"p":"Temperature"}
            {"t":"flag","v":"pick"}  {"t":"rate","v":3}  {"t":"label","v":"red"}  {"t":"next"}
            {"t":"presets"}  {"t":"preset","id":"<uuid>"}  {"t":"tool","name":"autoTone"}
            {"t":"ping"}
LR → deck   {"t":"hello","v":1,"lr":"15.3","catalog":"Deck Test","guard":true}
            {"t":"state","module":"develop","photo":"123","rating":3,"flag":1,"label":"red"}
            {"t":"vals","vals":{"Exposure":0.35}}
            {"t":"range","id":7,"min":2000,"max":50000}
            {"t":"presets","items":[{"id":"<uuid>","name":"…","folder":"…"}]}
            {"t":"err","id":7,"msg":"…"}  {"t":"pong"}
```

### Phase 3: build in parallel tracks

Run this as a workflow.
- Each track owns its directory (see `CLAUDE.md`), so tracks don't need worktree isolation.
- Each track ends with its checks, then an independent review against `PROTOCOL.md` and the `CLAUDE.md` rules.

**Track A: Lua plugin** (`lightroom/lua/`)
- Builds:
  - Socket server with reconnect and generation counters.
  - Dispatcher with a `pcall` per handler.
  - Develop fast path with tracking.
  - Observer that diffs the watched params.
  - State poller.
  - Catalog writes, feature detection, the test-catalog guard and logging.
- Verified by:
  - `luac -p`.
  - Unit tests under Lua 5.1.5 with stubbed `Lr*` modules.
  - The fixture streams.

**Track B: deck plugin** (`lightroom/deck/`)
- Builds:
  - Lightroom client: two sockets, backoff, hello, offline state.
  - Value model and echo suppression.
  - Develop Dial action: banks, coalescing, acceleration and strip layout.
  - Culling and rating keys with live state images.
- Verified by:
  - Typecheck and unit tests.
  - `streamdeck validate`.
  - Runs against the mock Lightroom.

**Track C: tools** (`lightroom/tools/`)
- Builds:
  - A mock Lightroom that speaks the protocol and simulates values, ranges and photos.
  - A fake deck client that drives the real Lua plugin from scripts.
  - The S2 latency harness, kept for later.
- Verified by:
  - Running the fixture streams.
  - Tracks A and B using it.

Then the main thread integrates:
1. The real Lua plugin against the real deck plugin, through the fixtures.
2. Then on hardware.

### Phase 4: integration on hardware (with the user)

Walk through a checklist with the user:
- Every bank and gesture.
- Syncing with edits made with the mouse.
- Culling keys.
- Develop auto-switch.
- Offline state.
- Recovery after a Lightroom restart, a Stream Deck app restart, and sleep/wake.

### Phase 5: presets and one-click tools

- A preset key, whose Property Inspector picker is fed by `presets` from Lightroom.
- Auto Tone, Auto White Balance, reset, copy and paste settings, snapshot, virtual copy.
- AI masks: subject, sky, background.
- Denoise, if S5 passed.
- Write up the Hotkey actions for Sync and Auto Sync for the user rather than coding them.

### Phase 6: hardening

**Reliability**
- Reconnect after a reboot, given macOS 26's localhost delay.
- Work around the dial lag after a cold boot if it shows up.
- Offline key state when Lightroom isn't running.

**Edge cases**
- Many selected photos.
- Photos locked by background AI (`photo:isAvailableForEditing()`).

**Finish**
- Quiet logs in normal use.
- A short user guide in `lightroom/README.md`:
  - Setup.
  - The Smart Profile that switches to the Lightroom profile when Lightroom is frontmost.
  - The Hotkey actions.

Optional later: a histogram or thumbnail on the strip (`requestJpegThumbnail`, rendered in Node).

## Human-only steps

- Installing apps, granting macOS permissions, plugging in hardware.
- In Lightroom:
  - Open the test catalog.
  - Add or enable the plugin in File ▸ Plug-in Manager.
  - Click Reload Plug-in, until S3 removes the need.
  - Quit and relaunch Lightroom after a plugin file is added, because Reload Plug-in doesn't see new files.
  - Switch modules when asked.
  - Close menus and the Plug-in Manager afterwards, because they pause plugin tasks.
- Looking at the deck: strip rendering, key images, how the dials feel.
- Design choices.

Ask with one numbered checklist that says what to click and what to report back.

## Verification ladder

1. Lua: `luac -p` on every file, and unit tests with stubbed `Lr*` modules.
2. Node: typecheck, unit tests, `streamdeck validate`.
3. Contract: both sides pass the fixture streams.
4. The Lua plugin inside Lightroom, driven by the fake deck client. Read Lightroom's log.
5. The deck plugin against the mock Lightroom. Read the plugin's log.
6. The real deck and real Lightroom, with the user.

Agents report what they ran and its output. The main thread re-runs the checks before ticking off a milestone.

## Risks to watch

- **Plugin startup:** `LrInitPlugin` waits for Lightroom's window to be activated. Plugin tasks pause while a menu or the Plug-in Manager is open.
- **Lightroom versions:**
  - There's an anecdotal report of 15.6 not saving Develop edits until a restart. Stay on 15.3 for the build, and test again before updating.
  - Lightroom 16 may arrive at Adobe MAX (10–12 November).
- **Parameter quirks:** Temperature's range depends on the file type. Some parameters ignore `resetToDefault` (LR research §2.2).
- **macOS 26:** localhost connections can fail after a reboot, and dials can lag after a cold boot (SD research §0).
- **The deck is on a dock.** Elgato's maintainers say some docks cause erratic or missing events (SD research §0, §7). If S4 or Phase 4 shows dropped or late ticks, retest with the deck on one of the Mac's own ports before debugging code. Otherwise don't ask the user to move it.
- **Agents can't see the deck.** Anything visual needs the user, so batch those checks.

## Log

Record kickoff answers, spike results and decisions here, newest last, with dates.

- 2026-10-31: Plan written. Node 24 and Lua 5.1.5 pinned in `mise.toml` and installed.
- 2026-10-31: Stream Deck app 7.6.0 installed. The deck stays on the user's dock, their choice after hearing that some docks drop events.
- 2026-10-31, kickoff: Test catalog is `/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat`. Checked: LrC 15.3 (`com.adobe.LightroomClassicCC7`) running with it open, Stream Deck 7.6.0 running, Node 24.22.2 and Lua 5.1.5 through `mise exec --` (the shell's bare `node` is 22), ports 58780/58781 and 58763/58764 free.
- 2026-10-31, kickoff: The user's feature list for this build:
  - Keys: Pick, Reject, Unflag; 4 keys for their Cobalt Fuji film-simulation profiles; Before/After.
  - Dials: Temperature, Tint, Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Texture, Clarity, Vibrance, Saturation, PostCropVignetteAmount.
  - More may come later.
- 2026-10-31, kickoff answers (open questions 1–7):
  1. **Banks**, in Basic-panel order: (1) Temperature, Tint, Exposure, Contrast; (2) Highlights, Shadows, Whites, Blacks; (3) Texture, Clarity, Vibrance, Saturation; (4) PostCropVignetteAmount plus 3 empty slots. No mask bank for now.
  2. **Gestures** (default accepted): turn = adjust with acceleration; push + turn = fine; press = reset that slider; tap the strip = next bank; long-touch = reset, as the touch alternative CLAUDE.md asks for. No previous-bank gesture: tap round the 4 banks.
  3. **Dial outside Develop:** switch to Develop first.
  4. **Keys:** Pick, Reject and Unflag, each with an "advance after flagging" option; Next and Previous photo; Before/After. No rating or label keys yet, but the Lua side still reports flag, rating and label in `state`.
  5. **Presets:** the 4 profile keys are a generic "Apply preset" key. The user makes 4 profile-only Develop presets (only "Profile" ticked), and each key picks one from a Property Inspector list fed by `presets`. Other one-click tools wait for a later phase.
  6. **Several photos selected:** dials edit the active photo only, and S5 checks whether Lightroom's Auto Sync carries them. Flag keys follow `LrSelection`'s own rule. Preset keys apply to all of `getTargetPhotos()`, and do nothing when there's no target photo.
  7. **Strip histogram or thumbnail:** later, not in this build.
  - **Before/After:** hold to compare. Key down = `showView('develop_before')`, key up = `showView('develop_loupe')`. The user preferred it if it wasn't harder, and it isn't: it needs no toggle state.
- 2026-10-31, process: The spikes are built where Lightroom and the Stream Deck app will load the real plugins from: `lightroom/lua/DeckBridge.lrdevplugin` (real id and ports) and `lightroom/deck/` (real plugin and dial-action UUIDs). That way the user adds the Lua plugin and places the dial actions once. Spike-only code stays in clearly named files (`Spike*.lua`, the spike menu items), which Track A deletes. The harness and analysis scripts live in `spikes/`, and the temporary wire format is `spikes/protocol-v0.md`.
- 2026-10-31, spike run 1 (`spikes/results/20261031-133539`, aborted). The plugin loaded on the first Plug-in Manager ▸ Add: LrC 15.3, the test catalog, guard on, writable. Findings:
  - **S1:** 10/10 full drops and 3/3 cmd-only drops recovered (connect about 2 ms, hello 2–7 ms).
  - **Send sockets never notice a client leaving.** LrC's send-mode socket gets no `onClosed`/`onError`, and sends to the dead peer don't fail; only the receive socket's `onClosed` fires. After the harness dropped only the event socket, Lightroom kept writing into it, so every later result and the user's menu trigger were lost. **Rule:** the client always drops and reconnects both sockets together, and pings to detect a dead event path.
  - **LrSocket's receive mode answers every line with `ok`** on the same connection. Clients must keep reading and discarding it.
  - **`onMessage` runs outside a task** (`canYield()` is false). Photo metadata reads there fail with "We can only wait from within a task". `LrDevelopController.getValue` and `catalog:getPath()` work there.
  - **Menu scripts share module state with Init's task:** the trigger arrived through `State`, and the file route was a duplicate.
  - **The user doesn't see bezels** shown while the Plug-in Manager is open.
  - **Bugs fixed:** the greeting now reads state inside a task; dropped state, vals and triggers are retried instead of being marked sent; a command that fails outside a task falls back to the task queue from then on. Five regression tests now fail on the old code and pass on the new.
- 2026-10-31, spike run 2 (`spikes/results/20261031-142013`). The user did the whole checklist. Results:
  - **S1 sockets: pass.** 16/16 reconnect cycles, with hello about 2 ms after connecting. Reload Plug-in and a quit and relaunch both reconnected on their own. Quit wasn't slower (`LrShutdownApp` took 0.2 s).
    - **`bye` never arrives:** Lightroom closes plugin sockets before `LrShutdownPlugin`/`LrShutdownApp` run. The deck treats any disconnect as offline, and v1 drops `bye`.
    - **Lightroom also closes the client connection by itself**, seen 19 s before the user's Reload click, probably when a menu or the Plug-in Manager opened. Every new send socket then reported closed while still binding, and the old code rebound from inside that callback about 200 times, until Lua's C-stack limit, before recovering 2 s later. **Fixed:** rebinds asked for during a bind, or within 0.5 s of the last one, go to the poll loop, which skips them if a client has connected. Two regression tests reproduce the storm (196 binds before the fix).
  - **S2 latency: pass on the numbers.** On the largest raw (DSC01250-2.ARW, Sony, 47.7 MB, 7008×4672), at 15, 30 and 60 sets a second, tracked and untracked:
    - Commands reach Lightroom in 0.1–0.3 ms (LrSocket's `ok`). `setValue` runs in about 1 ms. Ack median 1.2–2 ms, p95 3 ms or less, max 8.5 ms. No backlog at any rate, and `getValue` straight after `setValue` always matched (1051/1051).
    - **The adjustment observer doesn't fire during a tracked gesture.** It fires once, about 4 ms after `stopTracking`. Untracked bursts fired it never.
    - **History gained 4 Exposure steps:** one per tracked burst plus the restore. Untracked bursts made no step of their own and folded into the next one.
    - So: always track gestures, as planned, and stop on release. The deck can't use echoes of its own writes; it keeps its own value model, as planned. To follow mouse edits live, Lightroom will also poll the watched values every 200 ms, since 13 `getValue` calls cost about 0.08 ms.
    - The user's visual check ("does the image keep up") is still to do: a caption covered the image during the bursts. Do it in Phase 4 with the real dials.
  - **S3 hot reload: pass.** `require` caches modules. The plugin's `reload` command (`LrFileUtils.readFile` + `loadstring`, with `import` and `require` visible in the chunk) sees edits. Reload Plug-in and relaunching clear the cache. So stateless handler modules can be hot-reloaded without the user; the socket server and state still need Reload Plug-in.
  - **S4 deck basics.**
    - All 124 dial and touch events reached the plugin.
    - **Tick batching:** the app sends dialRotate events at most about every 50 ms, with up to 4 ticks per event on fast spins. That's about 20–32 ticks a second typically and about 60 at peak.
    - The plugin starts without any placed action, but only with developer mode on. `validate` passes and the log shows no layout errors.
    - The spike dials only change a fake on-strip value; they don't talk to Lightroom yet.
    - The user confirmed the strip: slider names, a value that changed while turning, and a bar. Tapping changed the bank. **S4 passes.**
  - **S5 on 15.3.**
    - Present: `setEnhance`, `changeDenoiseAmount`, `getEnhancePanelState`, `isAvailableForEditing`, `showBezel`, and the undocumented `LrApplication.addActivePhotoChangeObserver`, `addKeyModifierObserver` and `addHapticObserver`.
    - **AI subject mask:** `createNewMask('aiSelection', 'subject')` made one in 2.0 s; `deleteMask` removed it.
    - **Auto Sync carries `setValue`:** with 3 photos selected and Auto Sync on, +0.5 EV on the active photo reached the other two. Multi-photo dial edits need no code of ours: the user turns on Auto Sync.
    - The observer fires on a photo change (73 callbacks) and still fires after a Library ↔ Develop round trip.
    - `LrApplicationView` has no getter for the current primary view, which confirms hold-to-compare for Before/After. `showView('develop_before')` and `'develop_loupe'` ran without errors; the user's visual check is pending.
    - SDK `flagAsPick()` didn't trigger Lightroom's Auto Advance with the user's current setting, so the deck's own "advance after flagging" option is needed.
    - Presets: 393 in 40 folders, listed in 17 ms.
    - Ranges on a raw: Temperature 2000–50000 K, Tint -150..150, Exposure -5..5, all others -100..100.
    - Timing: the whole state poll takes 0.7 ms and photo metadata reads 0.37 ms; the other getters are under 0.01 ms.
  - The test photos are Sony ARW files, so the user's Cobalt Fuji film-simulation profiles are for Sony raws.
- 2026-10-31, Phase 2: protocol v1 frozen in `lightroom/protocol/PROTOCOL.md`, with 18 fixture conversations in `lightroom/protocol/fixtures/`. Decisions taken from the spikes:
  - The pair rule, `ok` draining, and a heartbeat that tells a stale event socket ("reconnect") from a paused Lightroom ("busy, wait").
  - No `bye`.
  - Gestures numbered `g`. Lightroom starts and stops tracking per gesture, ends it itself after 2 s without a `set`, and leaves the gesture's param out of `vals` while it runs.
  - Values come from the observer plus a 200 ms value poll, in Develop only. Outside Develop a dial turn sends `module` first and waits for `vals`.
  - `flag` takes an `advance` flag, which Lightroom skips if its own Auto Advance already moved on.
  - `view` before/after for hold-to-compare.
  - `presets` and `preset`, with locked photos skipped.
  - `reload` hot-swaps handler modules (S3).
  - Error codes for the deck to act on.
  - The fixture format and matching rules that the Lua tests, the mock Lightroom and the deck tests all share.
- 2026-10-31, Phase 3 started as the workflow `lightroom-tracks` (run `wf_50e3a891-197`). Each track gets a builder, then an independent reviewer that re-runs the checks against PROTOCOL.md, the fixtures and CLAUDE.md, then a fixer for blocker and major findings. Each track owns its directory, and none touches ports 58780/58781, Lightroom or the Stream Deck app. Tests use ephemeral ports.
  - Track A, `lightroom/lua/`: protocol v1, hot reload, Status menu, spike files removed, Lua fixture runner.
  - Track B, `lightroom/deck/`: client, value model, banks.json, Develop Dial, the Pick/Reject/Unflag, Next/Previous, Before/After and Apply Preset keys, plain-HTML Property Inspectors, `npm test`.
  - Track C, `lightroom/tools/`: shared client and matcher, mock Lightroom with 15.3's quirks, fixture runner, fake deck with `smoke.json`, v1 latency harness.
- 2026-10-31, Phase 3 built: 9 agents, about 2 h. All three reviews passed with no blockers. Track A had 1 major and Track C had 3; the fixers fixed all of them and most minors. The main thread then re-ran every check:
  - **Track A** (`lightroom/lua/`). `bash lightroom/lua/tests/run.sh`: luac on 19 files, 73/73 unit tests, 18/18 fixtures.
    - The spike files and their menu items are gone. The one menu item left is File ▸ Plug-in Extras ▸ "Deck Bridge: Status".
    - `reload` hot-swaps nine handler modules, and only while writes may go through. Guard, Server, State, Init, Config, Log and json still need Reload Plug-in.
    - Review fixes:
      - ranges and vals Lightroom couldn't read are retried until they're sent;
      - full vals pushes keep to 20/s;
      - noPhoto for set and reset when there's no target photo;
      - a gesture belongs to the photo it started on;
      - the observer callback runs under pcall;
      - an idle Lightroom no longer logs "listening" every 10 s;
      - reload is refused outside the test catalog.
  - **Track B** (`lightroom/deck/`). Build, typecheck, 169/169 tests and validate all pass. `npm run smoke` passes 26/26: the real bundle against a fake Stream Deck app and a fake Lightroom on ephemeral ports.
    - New keys: Pick, Reject, Unflag, Next Photo, Previous Photo, Before/After and Apply Preset. Banks now live in `banks.json`.
    - Review fixes:
      - a lost `ok` no longer makes "busy" flap;
      - Next, Previous and flag-advance end the open gesture first and hold turns for the new photo;
      - a dial-up without a press the plugin saw no longer resets;
      - turns wait for the param's range;
      - a monotonic clock;
      - set at most 30/s per param;
      - half-away rounding;
      - a replay of the deck's own fixture lines.
  - **Track C** (`lightroom/tools/`). `node --test lightroom/tools/`: 124/124. Fixtures: 18/18 on both the manual and the real clock.
    - Review fixes for `smoke.json` and `latency.mjs`:
      - they refuse any catalog but the test catalog, even with the guard off;
      - they require exactly one selected photo, because of Auto Sync;
      - they stop before writing if Lightroom's own Auto Advance moves the photo.
  - The build replaced `bin/plugin.js`. Until integration, the Stream Deck app still runs the S4 spike process and Lightroom still runs the spike Lua plugin.
  - The tracks raised protocol ambiguities, settled next. The main thread owns `PROTOCOL.md`.
- 2026-10-31, protocol amendments after Phase 3, listed under Amendments in `PROTOCOL.md`. The tracks' ambiguities are now settled in the text; most amendments write down what both sides already did. One changes behaviour, for **stale gestures**:
  - The bug: if the user changes photo in Lightroom while a dial gesture is open (arrow key, filmstrip, Lightroom's own Auto Advance), the deck's next sets carry values worked out for the old photo, and they landed on the new one.
  - The fix: Lightroom now ends that gesture and refuses its later sets with `err stale`, changing nothing. The deck holds turns until it has the new photo's values. New fixture: `stale-gesture.jsonl`.
  - Track A is done: 76 unit tests and 19/19 fixtures pass, and each of 8 deliberate breaks of the fix fails a test. Two agents are bringing the deck and the mock in line.
- 2026-10-31, the stale-gesture amendment is now in all three tracks. The main thread re-ran every check:
  - Lua: 76/76 unit tests, 19/19 fixtures.
  - Deck: build, typecheck and validate pass; 177/177 tests; smoke 26/26.
  - Tools: 149/149 tests; 19/19 fixtures on both clocks.
  - On `stale`, the deck ends the gesture without `done` and raises no alert. It holds turns only if it hasn't seen the new photo's `state` yet. After any photo change, turns also wait for that photo's `ranges`.
  - The latency harness stops writing, and skips its restore, if the photo changes mid-run.
  - The mock follows the Lua plugin at the ends of the filmstrip: `nav` there ends a gesture as stale.
  - **Still open, documented in `PROTOCOL.md`:** a new gesture that starts within a few ms of a photo change made in Lightroom. Its first `set` uses the old photo's value. Lightroom's observer reports photo changes within milliseconds in Develop, so this needs a very fast hand. Phase 6 fix: `set` carries the photo the deck worked from.
- 2026-10-31, the first live load of v1 failed.
  - **What happened:** Reload Plug-in shut down the spike instance, which took 9.7 s; that was the user's "long wait". Then `Init.lua` failed before logging anything, and Lightroom disabled the plugin. Enable failed the same way.
  - **Diagnosis:** `Init.lua` now catches a load failure and logs it in full. It logged `init failed: Could not load toolkit script: Reload`.
  - **Likely cause:** Lightroom only sees plugin files that existed when it launched. `Reload.lua`, `Proto.lua`, `Library.lua`, `Presets.lua` and `MenuStatus.lua` all came after the 14:28 launch, while files that existed then load fine.
  - **Fix to try:** quit and relaunch Lightroom.
- 2026-10-31, v1 is live in Lightroom (ladder step 4).
  - The relaunch fixed the load, which confirms the diagnosis. Deck Bridge 1.0.0 started as inst 6ae6743e-93a1, and CLAUDE.md now has the new-files rule.
  - Everything below ran in the test catalog on photo 573 (`DSC01268-2.ARW`), from a snapshot of the committed tools:
    - **`smoke.json` passed:** 57 steps in 3.8 s, with nothing left to clean up.
      - Acks took 4–14 ms; Next and Previous about 125 ms each.
      - It listed 398 presets, including the user's "Cobalt Fuji" folder: Classic Chrome, Classic Neg, Nostalgic Neg, Provia and Reala Ace.
    - **`set` ran straight from `onMessage`**, with no "needs a task" fallback, so reading the target photo there works on 15.3.
    - **Hot reload:** `reload {mods: [Library]}` answered ok.
    - **Latency**, 3 s bursts at 15, 30 and 60 sets a second:
      - ack median 2.3, 1.6 and 1.2 ms;
      - p95 4.1, 2.0 and 1.5 ms, with a max of 7.4 ms;
      - `done` to `vals`: 10–20 ms;
      - no backlog, no leaks, no errors, and Exposure was put back afterwards.
    - **Lightroom's log** has no warnings or errors.
  - **The deck plugin** was restarted on the v1 build (0.2.0.0). It connected and said hello, and Lightroom shows it online.
- 2026-10-31, ladder step 5: the real deck bundle against Track C's mock. The script is `lightroom/tools/integration/deck-vs-mock.mjs`, run with `mise exec -- node lightroom/tools/integration/deck-vs-mock.mjs`.
  - **93 checks:**
    - setup, gestures, fine adjust, resets and banks;
    - every key, and a mouse edit;
    - both stale orders, and Library;
    - recovery after a relaunch, a stale socket, a busy Lightroom and going offline;
    - rules over the whole session: every command valid, rates kept, no alerts.
  - **Result:** 93/93 on four runs, three by the agent and one by the main thread. The two sides never disagree. As a negative control, removing the mock's stale refusal makes step 6 fail.
  - **Doc fixes:** `PROTOCOL.md`'s `state` row now mentions the observer path. The tools README says the mock notices photo changes later than Lightroom does.
  - **Not covered yet:**
    - read-only mode and a version mismatch;
    - two dials at once, and clamping at the ends of a range;
    - presets that change sliders;
    - ticks dropped after 2 s.
- 2026-10-31, Phase 4 (ladder step 6): the user walked through checklist 2 on the real deck and Lightroom and reports that every step worked as expected. That includes step 5, "does the image keep up", the visual check left over from S2. Both logs agree:
  - **No warnings or errors** in either log since v1 started at 18:05.
  - **Dials:**
    - 271 tick events across all four dials, every one applied;
    - 53 of them with the dial pushed (fine adjust);
    - 11 presses;
    - 34 strip taps, each one a bank change.
  - **Apply Preset:** 22 applies across the four Cobalt Fuji presets (Classic Chrome, Classic Neg, Nostalgic Neg, Reala Ace), each to 1 photo with none locked. The picker listed 398 presets each time its Property Inspector opened.
  - **Recovery:**
    - Sleep and wake: at 18:36 the deck saw the wake and reconnected in 256 ms.
    - Lightroom quit and relaunch: the deck went offline at once and came back 1.1 s after Lightroom started listening. It noticed the new instance and watched again. Lightroom's shutdown took 0.2 s.
  - **Not in the logs, so these go on the next checklist:**
    - A Stream Deck app restart. The app has been one process since 12:44. My `streamdeck restart` at 18:07 covered the plugin's side, connecting in 5 ms.
    - A long-touch on the strip. All 34 touches were short taps.
  - The deck logs no key presses and Lightroom logs no commands, so Pick, Reject, Unflag, Next, Previous and Before/After rest on the user's report.
- 2026-10-31, Phase 5 is done as scoped at kickoff (answer 5): the Apply Preset key, verified on hardware. The other one-click tools wait, by the user's choice. The Hotkey write-up for Sync and Auto Sync moves to Phase 6's README.
- 2026-10-31, Phase 6 started.
  - **Protocol amendment, still v1** (Amendments ▸ "for Phase 6" in `PROTOCOL.md`):
    - `set` and `reset` carry `ph`, the photo the deck worked from, and a wrong `ph` gets `stale`. This closes the last stale-gesture gap.
    - `state.locked` and `err locked`, for photos a background AI process such as Denoise holds.
    - New fixtures `stale-photo.jsonl` and `locked.jsonl`. Before any code, both runners failed exactly these two and passed the other 19.
  - **The workflow `lightroom-phase6`** (run `wf_9f3275d1-b94`):
    - Builders: the Lua track, the deck track and the mock, in parallel. The deck also moves to info-level logs by default.
    - Integration: deck-vs-mock gains scenarios for the `ph` race, locked photos, read-only mode, a version mismatch, two dials at once, clamping, presets that change sliders, and held ticks dropped after 2 s.
    - Then an independent review per track, and fixers for blockers and majors.
  - **Constraints:** no new Lua files, and Lua code changes only in hot-reloadable modules, so the main thread can load them into the running Lightroom without a relaunch.
  - **Next checklist, after the build:** a Stream Deck app restart, a long-touch, a locked photo during Denoise, many selected photos with Auto Sync, and a reboot last.
- 2026-10-31, Phase 6 built (workflow `wf_9f3275d1-b94`: 9 agents, none failed). The main thread re-ran every check, and the results matched:
  - **Lua:**
    - `set` and `reset` check `ph`.
    - The poll reads `isAvailableForEditing` for the target photo inside a task, and keeps each reading with the photo it was read for. That reading becomes `state.locked`.
    - `err locked` comes after the stale checks and before the switch to Develop. It reads only the stored reading, so the onMessage fast path stays task-free.
    - Code changed only in Develop and Poll.
    - 91 unit tests and 21/21 fixtures. The tests caught all 23 of the builder's deliberate breaks. They caught 12 of the reviewer's 17 at first, and all 17 after the fixer's new tests.
  - **Deck:**
    - `ph` on every `set` and `reset`.
    - While locked: the strips say Locked, dimmed; turns and presses send nothing and alert once per burst; taps still change banks.
    - Info-level logs by default, with `log-level.txt` to raise them.
    - 214 tests, smoke 36/36, and validate passes.
  - **Mock and tools:**
    - The plugin's rules.
    - A control API for deck scenarios: `holdPoll`, `nextPoll`, `delayEvents`, `protocolVersion`, `moduleDelayMs`, and another catalog.
    - `ph` in the fake deck and the latency harness.
    - 183 tests, and fixtures 42/42 on both clocks.
  - **Deck vs mock:**
    - 177 checks, up from 93. They cover the `ph` race, locked photos, read-only mode, a version mismatch, two dials at once, clamping, presets that change sliders, and held ticks dropped after 2 s.
    - 177/177 on every run, three by the agents and one by the main thread.
    - Negative controls: without the mock's `ph` check 169/177, without its lock check 173/177, and with `state.locked` never true 159/177.
  - **Reviews found four majors:**
    - no Lua test for the `ph` race;
    - the mock's delayed events could arrive out of order on the real clock;
    - three of the mock's lock-reading rules had no test;
    - nothing checked the photo again after a switch to Develop.

    The fixers handled the first three and 6 minors.
  - **Settled by the main thread** (`PROTOCOL.md`, Amendments ▸ "Settled in review"):
    - A null `ph` counts as absent.
    - After a switch to Develop, `set` and `reset` check the target photo again. Otherwise a press in Library could reset a photo clicked during the switch.
    - With no photo in its `state`, the deck sends no `set` or `reset`. The fixer found a real path for a `set` without `ph`: Lightroom's `watch` reply can bring `ranges` and `vals` before the new photo's `state`.
    - Lightroom keeps only the latest stale `g`.
    - `err locked` usually arrives just after `state.locked`.
  - **Known limit, unchanged:** two dials turned at once make every dial event its own gesture, because Lightroom tracks one param at a time. 10 + 10 interleaved ticks make 20 history steps, and Exposure moves about 10% less than the ticks ask for.
  - **Lightroom already runs the new Lua.** It quit and relaunched at 19:46:27–46, after the Lua track had written Develop, Poll, Presets and State, so it loaded that code, alongside the old deck plugin. Since then neither log has a warning, and no dial was used.
  - **The fix for the switch to Develop** came from one more fixer.
    - **Lightroom:** Develop.lua is the only plugin file changed, and the dial-tick fast path asks Lightroom nothing new.
    - **The deck** also sends no `set` without a photo.
    - **Checks after it:** Lua 96 unit tests and 21/21 fixtures; deck 217/217 and smoke 36/36; tools 185/185, fixtures 42/42 and deck-vs-mock 177/177, re-run by the main thread. Every deliberate break of the new rules was caught: 4 in Lua, 4 in the mock, 3 in the deck.
    - **Rehearsed offline:** booting the exact 19 files Lightroom loaded at 19:46, then hot-reloading only the new Develop, passes 21/21 fixtures. A control that reloads the old Develop fails all 21 on the swap check.
- 2026-10-31, Phase 6 live (ladder step 4). The deck plugin was stopped from 22:11:13 to 22:12:33, with the user's approval.
  - **`reload` of Develop** into the running Lightroom: 2 ms.
  - **A one-off live script** on the tools' `LrClient`, dry-run against the mock first and not kept: 25/25 checks.
    - `state.locked` is false on photos 569 and 570.
    - After `nav` to 570, a `set` and a `reset` carrying 569 get `stale`, and so does that `g` with 570's `ph`. Neither photo's Exposure moved.
    - A `set` and a `reset` sent from Library switch to Develop, check the photo again and land, in 71 and 56 ms. Exposure ends where it started.
  - **`smoke.json`:** PASS, 57 steps in 4.4 s.
  - **Latency** at 15, 30 and 60 sets/s: ack median 2.7, 1.6 and 1.2 ms, max 11 ms. No backlog, leaks or errors, and Exposure was put back.
  - **Lightroom's log:** 26 lines, all INFO.
  - **The deck plugin** restarted on the new build: STARTUP at log level info, and online 6 ms later.
- 2026-10-31, Phase 6 on hardware (ladder step 6): the user walked through checklist 3 and reports that steps 1–5 worked. Step 6, the reboot, waits until they can restart the Mac. The deck logged at debug from 22:14 for this checklist. Both logs agree:
  - **No warnings or errors** in either log.
  - **Long-touch:** two strip touches with `hold: true` on the first dial, each right after a turn.
  - **Locked photo:** Lightroom 15.3 locks a photo while Denoise runs. That answers the first half of LR research §10, question 15.
    - `isAvailableForEditing()` read false, so `state.locked` was true. The deck refused 4 tick events in two bursts, with one alert per burst (23:38:56 and 23:38:58). The next turns, at 23:39:30, applied.
    - Still open: whether Develop calls on a locked photo fail silently. Deck Bridge never makes them.
    - No gesture was open when the lock arrived, so neither "ending gesture … locked" nor `err locked` came up. Tests cover both.
  - **Many photos:** with 3 selected and Auto Sync on, the user saw Exposure from the deck reach all 3, as S5 found, and Apply Preset too.
  - **Recovery:**
    - Stream Deck app restart: the app quit at 23:40:36.4 and started again at 23:40:37.4. The new plugin process reached Lightroom 5 ms after starting, and the app had it connected 0.7 s after launch.
    - Lightroom quit and relaunch: the deck went offline at once. It came back 0.7 s after Lightroom started listening again, noticed the new instance and watched again. Turns applied afterwards.
    - Sleep and wake, at 23:37:36 before the checklist: reconnected in 258 ms.
  - Neither log records resets, preset applies or which photos changed, so the long-touch reset, Auto Sync and Apply Preset rest on the user's report.
  - **No short tap shows in the log,** so this build's bank changes, locked or not, rest on the tests. Phase 4 had 34 on hardware.
  - **Still to do:** the reboot. The deck stays at debug until then, for tick timing after a cold boot. Afterwards, delete `log-level.txt` and restart the plugin.
- 2026-11-01, Phase 6 reboot (checklist 3, step 6): the user restarted the Mac and reports that everything worked. The logs agree, and neither has a warning or error.
  - **Before the reboot,** the deck saw the Mac wake at 10:30:11 and reconnected in 256 ms. Lightroom shut down cleanly with the restart.
  - **After it:**
    - The Mac booted at 10:30:56. The Stream Deck app started at 10:45:08, and the plugin 3 s later.
    - Lightroom wasn't open yet, so the deck kept retrying for 2 min, with one log line. Lightroom started listening at 10:47:11.4, and the deck connected 1.6 s later.
    - Lightroom opened 16 min after boot, so this run can't say whether macOS's localhost delay after a reboot would have struck. The deck's first try after Lightroom listened got through.
  - **Ticks after the cold boot,** 17 min after boot with the Mac still busy (5-minute load average 5.1): one spin of 26 events and 45 ticks in 2.4 s, all applied, then a press. Events came less evenly than during checklist 3: median 97 ms apart and uneven, against S4's steady steps of about 50 ms (median 51 ms last night). The user felt no lag, so no workaround is needed.
  - **No strip tap** after the reboot either, so bank changes on this build still rest on the tests.
  - **Logs back to info:** `log-level.txt` deleted and the plugin restarted at 10:50:20. STARTUP at log level info, online 6 ms later.
- 2026-11-01, after Phase 6: the user lifted the guard for daily use and asked the main thread to make the change. Lightroom's log showed their own catalog open, with 4 flags refused by the guard.
  - `GUARD = false` in `Config.lua`. It takes effect at the next Reload Plug-in.
  - `Stubs.boot` now turns the guard on for every test, unless a test's `config` turns it off. Without that, 5 of the guard's tests failed against the new setting.
  - Lua 96 unit tests and 21/21 fixtures, with `GUARD = false` in `Config.lua`.
  - `CLAUDE.md` keeps agents out of the user's catalogs. Before driving Lightroom, they check that its log names the test catalog.
  - **In effect:** the user relaunched Lightroom at 11:38, and Deck Bridge started on their catalog with `guard off`. The deck reconnected 1.4 s later. The user reports that writes go through, and Lightroom's log has no refusal, warning or error in the 15 minutes since.

## Progress

- [x] Phase 0: kickoff (test catalog recorded, open questions answered), 2026-10-31
- [x] S1 sockets · [x] S2 latency (numbers; the visual check moves to Phase 4) · [x] S3 hot reload · [x] S4 deck basics · [x] S5 15.3 checks, all 2026-10-31. The user approved building on these results.
- [x] Phase 2: protocol frozen, 2026-10-31
- [x] Track A: Lua plugin · [x] Track B: deck plugin · [x] Track C: tools, all built and verified offline, 2026-10-31 (workflow `wf_50e3a891-197`)
- [x] Protocol amendments, all three tracks, 2026-10-31 · [x] the fake deck against the real Lightroom (ladder step 4), 2026-10-31 · [x] the deck plugin against the mock (step 5), 2026-10-31
- [x] Phase 4: integration on hardware, 2026-10-31. A Stream Deck app restart and a long-touch move to the next checklist.
- [x] Phase 5: presets, as scoped at kickoff, 2026-10-31. The other one-click tools wait.
- [x] Phase 6: hardening, verified offline, in Lightroom and on hardware (ladder steps 1–6), 2026-11-01. Bank changes on this build rest on the tests.
