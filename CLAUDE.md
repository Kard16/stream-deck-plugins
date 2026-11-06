# Stream Deck + plugins

Personal Elgato Stream Deck + plugins for Adobe Lightroom Classic and Claude Code. One user, on macOS 26. The repo is developed on this Mac. Since 2026-11-06 the Claude Code side also goes onto the user's other Macs, from a clone, with `deck-install.mjs setup` (`claude-code/README.md`, Setup). No Marketplace, Windows support or distribution polish. Keystroke automation and undocumented APIs are fine when they're the only route.

- **Done:** the Lightroom Classic side, 2026-11-01, and its Phase 7, dials on Stream Deck pages and big steps, 2026-11-04. Plan, decisions and progress: `docs/lightroom/plan.md`.
- **Now:** the Claude Code side, in daily use since 2026-11-03 (Phase 5). Plan, decisions and progress: `docs/claude-code/plan.md`. Design notes: `docs/research/claude-code-extensibility.md`. The user's guide: `claude-code/README.md`.
  - **Phase 7, session keys and dials,** done 2026-11-04, deck 0.4.0, checked live by the user: a key and a dial per session, answering questions, plans and approvals on the dial. Its spec: `docs/claude-code/session-keys.md`.
  - **Now: Phase 8, efficiency and update resilience,** planned 2026-11-05. Built and committed 2026-11-06: deck 0.5.0 and plugin 0.3.0, live and released. The smoke test passed live the same day. Left are the reboot, a day of use, and the first real `setup`, on the user's work Mac; the plan's Log says where it stands. It cuts the idle work, makes the setup resilient to Claude app and Claude Code updates, and keeps it easy to maintain. Its spec: `docs/claude-code/hardening.md`. Its session's kickoff: `docs/claude-code/hardening-kickoff.md`.
- **Research (2026-10-31):** `docs/research/`. Check it before searching the web, and cite the section you rely on.

## Rules

- Never touch the user's main Lightroom catalog. Work only in the test catalog named in `docs/lightroom/plan.md`. The Lua plugin's guard (`GUARD` in `Config.lua`) refuses writes in other catalogs, but the user turned it off on 2026-11-01 for daily use. So before driving Lightroom, check that the latest `starting:` line in its log names the test catalog. Only the user changes `GUARD`.
- Lightroom, the Claude app, the Stream Deck app and the physical deck are shared. One agent drives them at a time, and the main thread decides which.
- The Claude Code plugin loads in two places, and nowhere else:
  - **Throwaway sessions** the main thread starts from the app's `deck-sandbox` preset in `claude-code/sandbox/`. They load the dev copy, `claude-code/plugin`, through the `claude-code/sandbox-plugin` link, and hot-reload every save.
  - **The user's own sessions,** since 2026-11-03 at the user's word. They load the release copy, `claude-code/release/streamdeck-bridge`, which `CLAUDE_CODE_PLUGIN_DIRS` names beside `DECK_TOKEN` in the `env` block of `~/.claude/settings.json`. Only `claude-code/install/deck-install.mjs` (`setup`, `release`, `install`, `undo`) touches those keys, and it backs the file up first. A dev change reaches the user's sessions only once it's committed and released, and each session picks it up when it next starts.
  - Not through hooks or `enabledPlugins` in `~/.claude/settings.json`, not `~/.claude/skills/`, not a user-scope install. Never set `CLAUDE_CODE_PLUGIN_DIR_WATCH`: it would turn off the dev-mods hot reload.
  - Never write under `~/.claude/dev-mods/`. The main session's mods folder there is watched, and anything in it loads into that session.
  - Only the main thread starts, messages or archives sessions in the Claude app.
  - Never approve, deny, send a prompt to, or change the mode, model or effort of a session the main thread didn't start, in the app or through the bridge. The user's own sessions are read-only: the deck acts on them only for the user's own presses.
  - Keystrokes into the Claude app only with the user's OK, and only with a throwaway session in front.
- Steps only the user can do go back to the main thread, which batches them into one numbered checklist. That means Lightroom's Plug-in Manager, prompts in the Claude app, macOS permission prompts, looking at the deck, and design choices.
- Stay inside this repo. Outside it, these are fine without asking:
  - `streamdeck link`, `restart`, `validate` and `dev`.
  - Installing the tools pinned in `mise.toml`.
  - Running `/usr/bin/lsappinfo` read only (`front`, and `info -only bundleid`), as the deck's seen check and `recheck.mjs` do.
  - Reading the logs listed below.
  - Reading, never writing: `~/.claude/sessions/*.json` (never the `.key` files), the sandbox sessions' transcripts under `~/.claude/projects/`, the Claude app's session records in `~/Library/Application Support/Claude/claude-code-sessions/`, and the Claude app bundle.
- Verification means commands you ran and their output. "Should work" isn't verification.
- Never push. Commit only when the user's instructions say to.

## Layout

| Path | What | Owner when tracks run in parallel |
|---|---|---|
| `lightroom/lua/DeckBridge.lrdevplugin/` | Lua plugin. Lightroom loads it from this path. | Lua track |
| `lightroom/deck/` | Stream Deck plugin: an npm project with `com.karimdhanji.lightroom.sdPlugin/` inside | Deck track |
| `lightroom/tools/` | Mock Lightroom, fake deck client, latency harness | Tools track |
| `lightroom/protocol/` | Wire protocol spec, plus fixture streams both sides test against | Main thread |
| `claude-code/plugin/` | Claude Code plugin `streamdeck-bridge`: hooks and a mod | Plugin track |
| `claude-code/plugin-tsc/` | The plugin's type-check config and its fixtures-copy script, kept outside the plugin because the engine writes into a folder it loads | Plugin track |
| `claude-code/deck/` | Stream Deck plugin: an npm project with `com.karimdhanji.claude.sdPlugin/` inside, hosting the bridge | Deck track |
| `claude-code/tools/` | Fake Claude, fake bridge, fixture runner | Tools track |
| `claude-code/protocol/` | Bridge protocol spec, plus fixture streams both sides test against | Main thread |
| `claude-code/sandbox/` | The folder throwaway test sessions run in | Main thread |
| `claude-code/vendor/` | The mods API reference for the app's Claude Code version | Main thread |
| `claude-code/install/` | `deck-install.mjs`: releases the plugin from HEAD, and installs it in or takes it out of settings `env` | Main thread |
| `claude-code/release/` | The release copy the user's sessions load, and backups of `settings.json`. Git ignores it, and only `deck-install.mjs` writes it | Main thread |
| `spikes/` | Phase 1 experiments for both sides | Whoever runs the spike |
| `docs/` | Research, plans, progress | Main thread |

Work in this folder, not a worktree. Lightroom, the Stream Deck app and the sandbox sessions load the plugins from these paths.

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
- Dial stacks steal the press, so every press action needs a touch alternative, unless the user rules otherwise. The Lightroom dial's reset is press-only at their word (2026-11-03), and its strip tap turns on big steps.

**System**
- `streamDeck.system.openUrl` can't open custom URL schemes; run `open` through `child_process`.
- macOS 26 can refuse localhost connections for minutes after a reboot. Retry with backoff, and resync on `onSystemDidWakeUp`.
- Two plugins share the Stream Deck app. Restart only your own with `streamdeck restart <uuid>`, never the app.

## Claude Code plugin (hooks and a mod)

**Versions:** new desktop sessions run the newest Claude Code the app bundles, under `~/Library/Application Support/Claude/claude-code/<version>/<build>/`: 2.1.317 since 2026-11-03. Running sessions keep the version they started on. The `claude` on PATH is 2.1.312. Check the plugin with the app's version.

**Mods API**
- The reference is `claude-code/vendor/mods-api/`. Its version is on the first line of `claude-code.d.ts`, which declares every event and every call on `$`, with examples (grep it). `reference.md` covers loading, testing and failures. It's early access and changes between releases.
- **After a Claude app update,** `node claude-code/vendor/refresh.mjs` rebuilds the reference from the newest bundled binary, without loading the skill. The whole routine is under Commands, "After a Claude app update". recheck warns until the reference matches the newest bundled version, and `deck-install.mjs release` validates with the newest on its own.
- A mod has no Node and no DOM. It reaches everything through `$`: `$.http.fetch`, `$.clock`, `$.process`, `$.env`, `$.session`, `$.prompt`.
- Don't load the plugin-authoring skill: it arms the session's mods folder. Read the vendored copy instead.

**The bridge protocol** is `claude-code/protocol/PROTOCOL.md`, frozen with its fixtures. Changes go through the main thread, and fixtures are edited in `make-fixtures.mjs`, never by hand.

**Hooks**
- One `http` hook, PermissionRequest, for approvals. Status comes from the mod. The PreToolUse mode hook went with mode changes, 2026-11-06.
- Never give the hook `onFailure: "block"`: with the bridge down, it would deny every tool call.
- A session reads `hooks.json` when it starts. A hot reload doesn't add a new hook.
- PermissionRequest ignores exit code 2; answer with JSON.

**The desktop app**
- Sessions are SDK-hosted. Their environment has `CLAUDE_CODE_SESSION_ID` and the app's own id, `CLAUDE_CODE_HOST_SESSION_ID` (`local_…`).
- `~/.claude/sessions/<pid>.json` lists the running sessions, with titles and busy or idle. It's undocumented, so code that reads it tolerates missing fields. Never read the `.key` files beside it.
- The app's dialogs must keep working whatever the deck does. Anything the bridge can't answer falls back to them.
- With the plugin in `~/.claude/settings.json`, every Claude Code process that reads it loads the plugin: terminal sessions, `claude -p` runs, a `claude` started inside a session. The mod talks only from a desktop session of its own, and the bridge takes hook requests only from a session the registry confirms (PROTOCOL.md, "Desktop sessions only").

## Logs agents can read

- Lua plugin: `~/Library/Logs/Adobe/Lightroom/LrClassicLogs/DeckBridge.log`
- Deck plugin: `lightroom/deck/com.karimdhanji.lightroom.sdPlugin/logs/com.karimdhanji.lightroom.0.log` (0 is newest). It logs at info. For debug, write `debug` to `com.karimdhanji.lightroom.sdPlugin/log-level.txt`, which git ignores, and restart the plugin. The file is read only at startup.
- Stream Deck app: `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log` (on 7.6 it's `StreamDeck.log`, older files are `StreamDeck.1.log`)
- Claude deck plugin: `claude-code/deck/com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log` (0 is newest), once it exists
- Spike bridge: `spikes/results/<timestamp>/`

## Commands

Run node, npm and lua through `mise exec --`: the shell's bare `node` is 22, and `lua`/`luac` aren't on its PATH.

**Lua plugin**
- `bash lightroom/lua/tests/run.sh`: `luac -p` on every plugin file, then the unit tests under Lua 5.1.5

**Deck plugin** (from `lightroom/deck`)
- `npm run watch`: rebuild and restart the plugin on save
- `npm run build`, `npm run typecheck`
- `npx streamdeck validate com.karimdhanji.lightroom.sdPlugin`
- The plugin is linked, and Stream Deck's developer mode is on (`npx streamdeck dev`). A linked plugin doesn't start without developer mode.

**Claude Code plugin** (from the repo root; `CC` is the newest bundled binary: `CC="$(ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude | sort -V | tail -1)"`, 2.1.317 since 2026-11-03)
- Run every `claude` or `"$CC"` command with `env -u CLAUDE_CODE_PLUGIN_DIRS -u DECK_TOKEN`: the install puts both in this session's environment, and they would load the release copy too.
- `node claude-code/deck/node_modules/typescript/bin/tsc -p claude-code/plugin-tsc`
- `env -u CLAUDE_CODE_PLUGIN_DIRS -u DECK_TOKEN CLAUDE_CONFIG_DIR="$(mktemp -d)" "$CC" plugin validate claude-code/plugin`, and the same with `plugin test`. The scratch config keeps the checks out of `~/.claude`. Put `perl -e 'alarm 180; exec @ARGV'` before `"$CC"` for `plugin test`: the test kit has no time limit of its own, and a mod that retries at once can hang it.
- `node claude-code/plugin-tsc/sync-fixtures.mjs --check`: the plugin's copy of the fixtures is current, `hooks.json` is PROTOCOL.md's block, `plugin.json` only describes the plugin, and its version is the mod's `PLUGIN_VERSION`. `claude plugin test` can't read files outside the plugin, so after `make-fixtures.mjs` changes them, run it without `--check`.
- `node --test claude-code/plugin-tsc/sync-fixtures.test.mjs`: that script's own tests. Name the file: Node 24 takes a bare folder as a module.

**Claude deck plugin** (from `claude-code/deck`)
- `npm run typecheck`, `npm test`, `npm run build`
- `npx streamdeck validate com.karimdhanji.claude.sdPlugin`
- After `npm run build`, `streamdeck restart com.karimdhanji.claude`; `npm run watch` does both on save.

**Install** (from the repo root)
- `node claude-code/install/deck-install.mjs status`: whether the user's sessions get the plugin at HEAD. Exits 0 when installed and current.
- After a commit to `claude-code/plugin`: `deck-install.mjs release`. Sessions pick it up when they next start. `undo` takes the plugin out of `settings.json`.
- `deck-install.mjs setup` is for another Mac, from a fresh clone. It refuses here while the deck or the plugin has uncommitted changes, and the commands above are the ones for this Mac. `setup --dry-run` runs only its preflight.
- The user's other Macs, such as their work MacBook Pro, get a change once the user pushes it and runs `git pull` and `setup` there (`claude-code/README.md`, Keeping another Mac current). After a commit to the deck or the plugin, remind the user.
- `node --test claude-code/install/test/`

**After a Claude app update** (Phase 8's routine, D1), in this order:
1. `node claude-code/vendor/refresh.mjs`: the vendored mods API, from the newest bundled Claude Code.
2. The plugin's type check, above. It includes `plugin-tsc/hook-contract.ts`, which holds the deck's answers to the engine's types.
3. `node claude-code/tools/recheck.mjs`: the app internals the deck and the plugin rely on. Read each warn; a fail stops the routine.
4. `plugin validate` and `plugin test` with the new `CC`.
5. The smoke test, `docs/claude-code/smoke-test.md`, in a throwaway session.

Then commit the refreshed reference, and run `deck-install.mjs release` if the plugin changed.

**Claude tools and protocol** (from the repo root)
- `node --test claude-code/tools/test/`
- `node claude-code/protocol/make-fixtures.mjs`: regenerates the fixtures and `vectors.json`

**Spikes**
- `node spikes/lr-harness/test.mjs`: harness self-test against the fake Lightroom, about 100 s
- `node spikes/lr-harness/harness.mjs`: the live spike harness; results go to `spikes/results/<timestamp>/summary.md`
- `node spikes/s4-ticks/analyze.mjs` (from `lightroom/deck`): tick statistics from the deck plugin's log. Needs the debug level, because TICK and INPUT lines are debug.
