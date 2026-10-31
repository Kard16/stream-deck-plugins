# Lightroom Classic build plan

**Status:** not started. Written 2026-10-31 at the end of the research session.

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

## Progress

- [x] Phase 0: kickoff (test catalog recorded, open questions answered), 2026-10-31
- [ ] S1 sockets · [ ] S2 latency · [ ] S3 hot reload · [ ] S4 deck basics · [ ] S5 15.3 checks
- [ ] Phase 2: protocol frozen
- [ ] Track A: Lua plugin · [ ] Track B: deck plugin · [ ] Track C: tools
- [ ] Phase 4: integration on hardware
- [ ] Phase 5: presets and tools
- [ ] Phase 6: hardening
