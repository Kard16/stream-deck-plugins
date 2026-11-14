# Lightroom Classic on the Stream Deck +

Develop sliders on the dials, plus culling, preset and Before/After keys, for Lightroom Classic 15.3 on macOS. Two plugins talk over localhost:

- **Deck Bridge** (`lua/DeckBridge.lrdevplugin`) runs inside Lightroom. It listens on ports 58780 (commands) and 58781 (events).
- **The Stream Deck plugin** (`deck/`) runs in the Stream Deck app. It connects to Deck Bridge, and reconnects on its own when either side restarts.

The wire protocol is [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md). The plan, decisions and test results are in [`docs/lightroom/plan.md`](../docs/lightroom/plan.md).

## The dials

Place **Develop Dial** on a dial, then choose its slider in the dial's settings: select the dial in the Stream Deck app. A dial placed without a choice shows Temp, Tint, Exposure or Contrast, by its position. Two dials can show the same slider.

For more sliders, use Stream Deck pages, each with its own dials. Change pages with the Stream Deck app's own page navigation, for example by swiping the strip. A layout for 16 of the 17 sliders:

| Page | Dial 1 | Dial 2 | Dial 3 | Dial 4 |
|---|---|---|---|---|
| 1 | Temp | Tint | Exposure | Contrast |
| 2 | Highlights | Shadows | Whites | Blacks |
| 3 | Texture | Clarity | Vibrance | Saturation |
| 4 | Vignette | Dehaze | Sharpening | Noise |

Grain fits on a fifth page, or in place of a slider you use less.

**Gestures:**
- **Turn** to adjust. Faster turns move further.
- **Push and turn** for fine steps.
- **Press** to reset that slider.
- **Tap the strip** for big steps. Each click then moves ten normal steps (1/3 EV, 500 K or 10 points), however fast you turn, and the strip shows a green ×10. They switch off after 2 s without turning, on another tap, when you press the dial, or when you change page or the dial's slider. A long touch does the same as a tap.

**Behaviour:**
- Each burst of turning is one history step, so Cmd-Z undoes it.
- Turning a dial outside Develop switches to Develop first.
- The strip follows edits made with the mouse.

**When a dial can't work, its strip says why,** in amber where the value goes:
- **Offline:** Lightroom isn't running, or Deck Bridge isn't enabled.
- **Busy:** a menu, a dialog or the Plug-in Manager is open in Lightroom.
- **Mismatch:** the two plugins speak different protocol versions.
- **Locked:** an AI process, such as Denoise, is working on the photo. The strip dims and keeps the last value. Turns and presses do nothing until the process finishes, and the dial alerts once per burst. Tapping the strip still switches big steps on or off.
- **Not listed:** the dial's slider isn't in `sliders.json`, so the dial only alerts. Choose another in its settings.

Strips also dim outside Develop, and while writes are off (see [the guard](#the-test-catalog-guard)).

## The keys

| Key | What it does | Settings |
|---|---|---|
| Pick, Reject, Unflag | Flags the photo, then goes to the next one | **Advance**, on by default. The key doesn't advance when Lightroom's own Auto Advance has already moved on. |
| Next Photo, Previous Photo | Moves along the filmstrip | |
| Before/After | Hold to see the photo before your edits; let go to see it after | |
| Apply Preset | Applies a Develop preset to every selected photo. It skips photos an AI process is working on. | **Preset**, picked from Lightroom's own list, so Lightroom must be running. For the Cobalt Fuji film simulations, use profile-only presets. |

## Setup

You need Lightroom Classic, the Stream Deck app (7.1 or later), a clone of this repository in a folder you'll keep, and [mise](https://mise.jdx.dev) for Node 24: the [root README](../README.md#toolchain) has its two commands. Both apps load the plugins from the clone, so don't move it afterwards.

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

- **Dials** edit the active photo. With Auto Sync on, Lightroom carries each edit to every selected photo.
- **Pick, Reject and Unflag** follow Lightroom's own rule for the selection, like its P, X and U keys.
- **Apply Preset** applies to every selected photo.

## Adding sliders

The sliders live in `deck/com.karimdhanji.lightroom.sdPlugin/sliders.json`, and its `help` field explains every field.

1. Add a slider to the list. Use any `LrDevelopController` parameter name, each once. Section 2.2 of `docs/research/lightroom-classic-sdk.md` lists them all.
2. `macro` sets its big step. It defaults to ten normal steps.
3. Restart the plugin, or quit and reopen the Stream Deck app. From `lightroom/deck`:
   ```bash
   mise exec -- npx streamdeck restart com.karimdhanji.lightroom
   ```
4. Choose it in a dial's settings. The list there follows the file's order.

`macroSeconds` sets how long big steps stay on without a turn, from 0.5 to 10 seconds. If the file has a mistake, the plugin uses its built-in 17 sliders and logs why. Deck Bridge needs no change, because it watches whatever params the deck asks for.

## The test-catalog guard

The guard is off in this repo, so the deck works in any catalog. It kept my own catalogs safe while the plugins were built.

With the guard on, Deck Bridge refuses every write unless one test catalog is open. Writes are dial turns, resets, flags and presets. When it refuses one, Lightroom shows a bezel saying why, and the deck shows an alert on the key or dial.

To change it:
1. Open `lua/DeckBridge.lrdevplugin/Config.lua`. Set `GUARD` to `true` or `false`, and `TEST_CATALOG` to the path of a catalog you can afford to break. The path there is mine, and the tests and protocol fixtures use it too.
2. Click Reload Plug-in in the Plug-in Manager, then Done.

Turn it on while an agent works on the Lua plugin. Only you decide to turn it off: the repo's rules in `CLAUDE.md` keep agents from doing it on their own.

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
- **More detail from the Stream Deck plugin:** it logs at info. Debug adds every dial tick and input, big steps going on and off, the ranges Lightroom reports, and the reasoning behind each alert. To switch to debug, from `lightroom/deck`:
  ```bash
  echo debug > com.karimdhanji.lightroom.sdPlugin/log-level.txt
  ```
  ```bash
  mise exec -- npx streamdeck restart com.karimdhanji.lightroom
  ```
  To go back to info, delete the file and restart again. Git ignores the file.

## Developing

The repo's [`CLAUDE.md`](../CLAUDE.md) has the commands, rules and layout. [`tools/README.md`](tools/README.md) describes the mock Lightroom, the fake deck and the latency harness.
