# Lightroom Classic on the Stream Deck +

Develop sliders on the four dials, plus culling, preset and Before/After keys, for Lightroom Classic 15.3 on this Mac. Two plugins talk over localhost:

- **Deck Bridge** (`lua/DeckBridge.lrdevplugin`) runs inside Lightroom. It listens on ports 58780 (commands) and 58781 (events).
- **The Stream Deck plugin** (`deck/`) runs in the Stream Deck app. It connects to Deck Bridge, and reconnects on its own when either side restarts.

The wire protocol is [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md). The plan, decisions and test results are in [`docs/lightroom/plan.md`](../docs/lightroom/plan.md).

## The dials

Place **Develop Dial** on all four dials. They page together through four banks:

| Bank | Dial 1 | Dial 2 | Dial 3 | Dial 4 |
|---|---|---|---|---|
| 1 | Temp | Tint | Exposure | Contrast |
| 2 | Highlights | Shadows | Whites | Blacks |
| 3 | Texture | Clarity | Vibrance | Saturation |
| 4 | Vignette | — | — | — |

**Gestures:**
- **Turn** to adjust. Faster turns move further.
- **Push and turn** for fine steps.
- **Press** to reset that slider.
- **Tap the strip** for the next bank.
- **Long-touch the strip** to reset the slider, for when a dial stack takes the press.

**Behaviour:**
- Each burst of turning is one history step, so Cmd-Z undoes it.
- Turning a dial outside Develop switches to Develop first.
- The strip follows edits made with the mouse.

**When a dial can't work, its strip says why,** in amber where the value goes:
- **Offline:** Lightroom isn't running, or Deck Bridge isn't enabled.
- **Busy:** a menu, a dialog or the Plug-in Manager is open in Lightroom.
- **Mismatch:** the two plugins speak different protocol versions.
- **Locked:** an AI process, such as Denoise, is working on the photo. The strip dims and keeps the last value. Turns and presses do nothing until the process finishes, and the dial alerts once per burst. Tapping the strip still changes the bank.

Strips also dim outside Develop, and while writes are off (see [the guard](#the-test-catalog-guard)).

## The keys

| Key | What it does | Settings |
|---|---|---|
| Pick, Reject, Unflag | Flags the photo, then goes to the next one | **Advance**, on by default. The key doesn't advance when Lightroom's own Auto Advance has already moved on. |
| Next Photo, Previous Photo | Moves along the filmstrip | |
| Before/After | Hold to see the photo before your edits; let go to see it after | |
| Apply Preset | Applies a Develop preset to every selected photo. It skips photos an AI process is working on. | **Preset**, picked from Lightroom's own list, so Lightroom must be running. For the Cobalt Fuji film simulations, use profile-only presets. |

## Setup

This is already done on this Mac; the steps are here for a rebuild.

1. **Lightroom:** choose File ▸ Plug-in Manager ▸ Add, then `lightroom/lua/DeckBridge.lrdevplugin`. Its status is under File ▸ Plug-in Extras ▸ Deck Bridge: Status.
2. **Stream Deck:** the plugin is linked from `lightroom/deck/com.karimdhanji.lightroom.sdPlugin`. It doesn't come from the Marketplace, so it needs Stream Deck's developer mode. From `lightroom/deck`:
   ```bash
   mise exec -- npm install
   mise exec -- npm run build
   mise exec -- npx streamdeck link com.karimdhanji.lightroom.sdPlugin
   mise exec -- npx streamdeck dev
   ```
3. In the Stream Deck app, place the actions from the **Lightroom** category. If they're missing, restart the Stream Deck app.
4. Set up the Smart Profile, below.

## Switching profiles with Lightroom

Make a Stream Deck profile for Lightroom, then set its application to Adobe Lightroom Classic in the profile's settings. This makes it a Smart Profile: the deck switches to it whenever Lightroom is frontmost, and back when Lightroom isn't. Smart Profiles don't switch while the Stream Deck app's window is open.

## Hotkey actions

The Lightroom SDK has no call for the features below. Use Stream Deck's built-in **Hotkey** action with Lightroom's shortcuts instead. They work only while Lightroom is frontmost, and assume an English keyboard layout.

| Feature | Shortcut |
|---|---|
| Sync Settings (opens the dialog) | Cmd-Shift-S |
| Auto Sync on or off | Cmd-Option-Shift-A |
| Paste Settings from Previous | Cmd-Option-V |
| Brush smaller, larger | [, ] |
| Brush feather smaller, larger | Shift-[, Shift-] |

To check these or find others, press Cmd-/ in Lightroom; it lists the current module's shortcuts.

## Several photos at once

- **Dials** edit the active photo. With Auto Sync on, Lightroom carries each edit to every selected photo; spike S5 confirmed this.
- **Pick, Reject and Unflag** follow Lightroom's own rule for the selection, like its P, X and U keys.
- **Apply Preset** applies to every selected photo.

## Adding sliders

The banks live in `deck/com.karimdhanji.lightroom.sdPlugin/banks.json`, and its `help` field explains every field.

1. Add a slot to a bank. Use any `LrDevelopController` parameter name, such as Dehaze, Sharpness, LuminanceSmoothing or GrainAmount. Section 2.2 of `docs/research/lightroom-classic-sdk.md` lists them all.
2. A bank holds up to 4 slots, and `null` is an empty dial.
3. Restart the plugin, or quit and reopen the Stream Deck app. From `lightroom/deck`:
   ```bash
   mise exec -- npx streamdeck restart com.karimdhanji.lightroom
   ```

If the file has a mistake, the plugin uses its built-in banks and logs why. Deck Bridge needs no change, because it watches whatever params the deck asks for.

## The test-catalog guard

While the plugins are being built, Deck Bridge refuses every write unless the test catalog, `/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat`, is open. Writes are dial turns, resets, flags and presets. When it refuses one, Lightroom shows a bezel saying why, and the deck shows an alert on the key or dial.

To use the deck on your own catalogs:
1. Open `lua/DeckBridge.lrdevplugin/Config.lua` and set `GUARD = false`.
2. Click Reload Plug-in in the Plug-in Manager.

Only you do this: the repo's rules in `CLAUDE.md` keep agents from lifting the guard.

## When something's wrong

- **The deck says Offline:**
  - Open Lightroom, or enable Deck Bridge in the Plug-in Manager. The deck reconnects within 2 s of Lightroom starting.
  - After a reboot, macOS can refuse localhost connections for a few minutes; the deck keeps trying.
- **Busy:** close the menu, the dialog or the Plug-in Manager in Lightroom. Lightroom pauses plugin tasks while one is open.
- **An alert on a dial or key:** Lightroom refused the write, and its bezel says why. A dial also alerts by itself, with no bezel, when the photo is locked or no photo is selected.
- **Deck Bridge is disabled after Reload Plug-in, with "Could not load toolkit script":** a plugin file was added after Lightroom launched. Quit and relaunch Lightroom.
- **Logs:**
  - Deck Bridge: `~/Library/Logs/Adobe/Lightroom/LrClassicLogs/DeckBridge.log`
  - The Stream Deck plugin: `deck/com.karimdhanji.lightroom.sdPlugin/logs/com.karimdhanji.lightroom.0.log`, where 0 is the newest.
  - The Stream Deck app: `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log`
- **More detail from the Stream Deck plugin:** it logs at info. Debug adds every dial tick and input, plus the reasoning behind each alert. To switch to debug, from `lightroom/deck`:
  ```bash
  echo debug > com.karimdhanji.lightroom.sdPlugin/log-level.txt
  ```
  ```bash
  mise exec -- npx streamdeck restart com.karimdhanji.lightroom
  ```
  To go back to info, delete the file and restart again. Git ignores the file.

## Developing

The repo's [`CLAUDE.md`](../CLAUDE.md) has the commands, rules and layout. [`tools/README.md`](tools/README.md) describes the mock Lightroom, the fake deck and the latency harness.
