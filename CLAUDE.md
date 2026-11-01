# Stream Deck + plugins

Personal Elgato Stream Deck + plugins for Adobe Lightroom Classic and, later, Claude Code. One user, one Mac (macOS 26). No Marketplace, Windows support or distribution polish. Keystroke automation and undocumented APIs are fine when they're the only route.

- **Done:** the Lightroom Classic side, 2026-11-01. Plan, decisions and progress: `docs/lightroom/plan.md`.
- **Next:** the Claude Code side. Design notes: `docs/research/claude-code-extensibility.md`. Kickoff prompt: `docs/claude-code/kickoff-prompt.md`.
- **Research (2026-10-31):** `docs/research/`. Check it before searching the web, and cite the section you rely on.

## Rules

- Never touch the user's main Lightroom catalog. Work only in the test catalog named in `docs/lightroom/plan.md`. The Lua plugin's guard (`GUARD` in `Config.lua`) refuses writes in other catalogs, but the user turned it off on 2026-11-01 for daily use. So before driving Lightroom, check that the latest `starting:` line in its log names the test catalog. Only the user changes `GUARD`.
- Lightroom, the Stream Deck app and the physical deck are shared. One agent drives them at a time, and the main thread decides which.
- Steps only the user can do go back to the main thread, which batches them into one numbered checklist. That means Lightroom's Plug-in Manager, macOS permission prompts, looking at the deck, and design choices.
- Stay inside this repo. Outside it, these are fine without asking:
  - `streamdeck link`, `restart`, `validate` and `dev`.
  - Installing the tools pinned in `mise.toml`.
  - Reading the logs listed below.
- Verification means commands you ran and their output. "Should work" isn't verification.
- Never push. Commit only when the user's instructions say to.

## Layout

| Path | What | Owner when tracks run in parallel |
|---|---|---|
| `lightroom/lua/DeckBridge.lrdevplugin/` | Lua plugin. Lightroom loads it from this path. | Lua track |
| `lightroom/deck/` | Stream Deck plugin: an npm project with `com.karimdhanji.lightroom.sdPlugin/` inside | Deck track |
| `lightroom/tools/` | Mock Lightroom, fake deck client, latency harness | Tools track |
| `lightroom/protocol/` | Wire protocol spec, plus fixture streams both sides test against | Main thread |
| `spikes/` | Phase 1 experiments | Whoever runs the spike |
| `docs/` | Research, plans, progress | Main thread |

Work in this folder, not a worktree. Lightroom and the Stream Deck app load the plugins from these paths.

## Lightroom Classic (Lua)

**Language and modules**
- Lightroom Classic 15.3 (SDK 15.3) runs Lua 5.1.5. That rules out `goto`, `//`, bitwise operators, `utf8` and `table.unpack`.
- Check every file with `luac -p`; 5.1.5 is pinned in `mise.toml`.
- Load SDK modules with `local LrTasks = import 'LrTasks'` and plugin modules with `require 'Dispatch'`.
- Lightroom only sees plugin files that existed when it launched. A new `.lua` file needs a quit and relaunch: Reload Plug-in fails with "Could not load toolkit script: <name>" and disables the plugin. Edits to existing files need only Reload Plug-in, or the `reload` command for handler modules.
- The SDK has no JSON library; use the vendored `json.lua`.
- Keep Lightroom calls behind thin adapters, so logic can be unit-tested with stubbed `Lr*` modules outside Lightroom.

**Develop control**
- `LrDevelopController` works only in Develop, on the active photo. Switch with `LrApplicationView.switchToModule('develop')`, then call `LrTasks.yield()`.
- `setValue` takes numbers only.
- Ranges vary by file type (Temperature is Kelvin on raw but -100..100 on JPEG), so always call `getRange`.
- Call `startTracking(param)` while a dial turns and `stopTracking()` on release. That makes one history step per gesture.
- The adjustment observer doesn't say what changed, so diff the watched params.
- There's no photo-change event, so poll `catalog:getTargetPhoto()`.

**Tasks, writes and sockets**
- Catalog writes run in an async task inside `catalog:withWriteAccessDo(name, fn, {timeout = 3})`.
- Wrap every handler in `LrTasks.pcall`.
- Each `LrSocket` is one-way. After a client drops, recreate the send socket instead of reconnecting it.
- The plugin starts only after Lightroom's window is first activated. Its tasks pause while a menu or the Plug-in Manager is open.
- Feature-detect calls newer than 14.0, e.g. `if LrDevelopController.setEnhance then`.

**Not in the SDK:** menu commands, the Sync dialog, Auto Sync, brushes, Generative Remove and the histogram. Use the Stream Deck Hotkey action, or skip them.

## Stream Deck plugin (TypeScript)

**Versions:** `@elgato/streamdeck` 3.0.4 and `@elgato/cli` 1.10.4, with manifest `SDKVersion` 3 and `Nodejs.Version` "24". Node 24 is pinned in `mise.toml`.

**SDK 3 settings**
- Settings events fire only when the user edits in the Property Inspector. Read settings from event payloads or `await getSettings()`.
- Declare a settings type per action.
- There's no secrets API.

**Dials and the touch strip**
- Each dial owns a 200×100 strip segment.
- Put live data in custom layout keys, never `title`/`icon`.
- One item out of bounds, or overlapping another at the same `zOrder`, makes the whole layout fail silently. Run `streamdeck validate` after every layout change.
- Coalesce dial ticks (~40 ms) and apply our own acceleration.
- Send at most 10–15 strip updates per second per dial, with only the changed keys.
- Dial stacks steal the press, so every press action needs a touch alternative.

**System**
- `streamDeck.system.openUrl` can't open custom URL schemes; run `open` through `child_process`.
- macOS 26 can refuse localhost connections for minutes after a reboot. Retry with backoff, and resync on `onSystemDidWakeUp`.

## Logs agents can read

- Lua plugin: `~/Library/Logs/Adobe/Lightroom/LrClassicLogs/DeckBridge.log`
- Deck plugin: `lightroom/deck/com.karimdhanji.lightroom.sdPlugin/logs/com.karimdhanji.lightroom.0.log` (0 is newest). It logs at info. For debug, write `debug` to `com.karimdhanji.lightroom.sdPlugin/log-level.txt`, which git ignores, and restart the plugin. The file is read only at startup.
- Stream Deck app: `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log` (on 7.6 it's `StreamDeck.log`, older files are `StreamDeck.1.log`)

## Commands

Run node, npm and lua through `mise exec --`: the shell's bare `node` is 22, and `lua`/`luac` aren't on its PATH.

**Lua plugin**
- `bash lightroom/lua/tests/run.sh`: `luac -p` on every plugin file, then the unit tests under Lua 5.1.5

**Deck plugin** (from `lightroom/deck`)
- `npm run watch`: rebuild and restart the plugin on save
- `npm run build`, `npm run typecheck`
- `npx streamdeck validate com.karimdhanji.lightroom.sdPlugin`
- The plugin is linked, and Stream Deck's developer mode is on (`npx streamdeck dev`). A linked plugin doesn't start without developer mode.

**Spikes**
- `node spikes/lr-harness/test.mjs`: harness self-test against the fake Lightroom, about 100 s
- `node spikes/lr-harness/harness.mjs`: the live spike harness; results go to `spikes/results/<timestamp>/summary.md`
- `node spikes/s4-ticks/analyze.mjs` (from `lightroom/deck`): tick statistics from the deck plugin's log. Needs the debug level, because TICK and INPUT lines are debug.
