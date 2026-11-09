# Claude Code on the Stream Deck +

Live status for the Claude desktop app's Code-tab sessions, with a key and a dial for each session, approvals and saved prompts on the deck. Two plugins talk over localhost:

- **`streamdeck-bridge`** (`plugin/`) is a Claude Code plugin, so it runs inside each session. It has two parts:
  - a mod that reports the session's status and runs the saved prompts the deck sends;
  - a PermissionRequest hook that puts approvals on the deck.
- **The Stream Deck plugin** (`deck/`, `com.karimdhanji.claude`) runs in the Stream Deck app and hosts the bridge on 127.0.0.1:47600. It also reads the session registry (`~/.claude/sessions/`) and the app's session records, so it lists every running session, with or without the plugin.

The wire protocol is [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md). The plan, decisions and test results are in [`docs/claude-code/plan.md`](../docs/claude-code/plan.md).

## The layout

| Where | Action | What it does |
|---|---|---|
| Bottom row, 4 keys | **Session Slot** | One session per key: its state, title, context and what it's doing. Press to jump to it; hold to put the session on screen in the app on this key. |
| The 4 dials | **Session Slot**, the same action on a dial | The session on the key above. The strip shows its details, or what it's waiting on: an approval to allow or deny, or a question or plan to answer in the app. Turn to page or pick; press or tap to jump or send. |
| Top row | **Other Sessions**, and any of the keys below | How many sessions on no slot need you. Press to jump to the one that has waited longest. |

The other keys work as before, on this page or another.

## Session Slot keys

**The key face:**
- **The colour says the state.** Amber, with a light outline, means the session needs you: **Question**, **Plan**, **Approve?** or **Needs you**. Blue is **Working**, and **Background** while the session's own turn has ended but its agents, a workflow or its threads still run. Threads are the sessions it started, from task cards you started. Green is **Done**, red **Failed** and dark red **Stopped**, until you've seen the session; then the key goes dark, as it is while **Idle**.
- **The top line** says the state and how long it has lasted: 30s, 4m, 2h, 3d. A long word, such as Background, gets smaller type rather than being cut.
- **The title** is in the middle.
- **The bottom line** has the context % on the right, over a thin bar that turns orange at 80%. On the left:
  - **Working or Background,** while other agents run: the workflow, as `review 5/9` (its agents finished of those started), or else how many agents run, `3 agents`. A long workflow name is cut, never its counts. With no agents, how many of its threads are unfinished, `2 threads`: working, or waiting on you.
  - **Otherwise,** the tool it's running or waiting to run.
- **Not running**, dimmed: the session's process has stopped, after a Claude app restart say. A press opens it, and the app starts it again.
- **No session:** an empty slot. Hold the key to add the session on screen.

**Press** to jump to the session in the app. It becomes the target, so the Saved Prompt keys act on it. A press in the moment before the key shows a change, such as a swap, alerts and does nothing.

**Hold** for half a second to put the session that's on screen in the app on this key. If it's on another slot, the two swap. The key shows OK, or an alert when the deck doesn't know which session is on screen, or that session is archived.

**How slots fill:** an empty slot takes a running session that's on no other slot: one that needs you first, the one waiting longest; otherwise the newest. The bottom row fills first, left to right.

**Then each stays put.** A slot keeps its session on other pages and across restarts, until you archive the session in the app, until it's deleted, or until you hold the key for another one. The slots are saved in `deck/com.karimdhanji.claude.sdPlugin/run/slots.json`.

**Seen:** a turn's end stays lit until you've seen the session: it came on screen in the app on this Mac, it was on screen there while Claude was the app in front, or you pressed its key or jumped from its dial. Claude on your phone doesn't count. When its agents or a workflow run on after the turn, their end counts as the turn's end: Done, Failed or Stopped is timed from it, and only a look after it counts.

## Session Slot dials

Each dial belongs to the session on the key above it, and its strip shows what didn't fit on the key.

**With nothing waiting on you,** the strip has three pages, or more while agents or threads run, and the dots say which:
1. **Now:** what it's doing, or how its last turn ended, then the app's last summary, or what the app says it needs. While agents or threads run it says what the key says: `Background: review 5/9`, `Working: 3 agents`, `Background: 2 threads`.
2. **Agents,** only while other agents run or threads are unfinished, up to three pages:
   - the first line, in blue: the workflow, as `review · 5/9 done`, or `review · 5/9, 1 failed` once some have failed, with a long name cut, never its counts; or how many agents run, as `3 agents running`; or `2 threads`, or `3 agents, 2 threads`;
   - then two agents a page, as `● <what it was asked>: <what it's doing>`, such as `● logs: Grep: Device`; then the threads, each by its title, after what it waits on when it waits on you: `● Approve? Doc 40 T2: the safelight`;
   - when more run than fit, the last page ends with `+3 more`.
   When they finish while you're on one of these pages, the strip goes back to Now.
3. **Context:** the context %, with its bar, the tokens, and the cost so far.
4. **Setup:** model and effort; the mode and the session's Claude Code version; and the project. A version newer than the one this repo was checked against ends in ↑, with the line in amber: run the routine after an update (`CLAUDE.md`).

Turn to page. Press or tap to jump to the session. Long-touch goes back to the first page. As on the key, a press in the moment before the strip shows another session alerts and does nothing.

**When the session waits on you,** the strip shows what for, the oldest first.
- **Approval:** Allow or Deny, the same as the Approve and Deny keys. Turn to pick, then press or tap to send. Nothing is picked until you turn, and a press before that jumps to the session. The choices stop at either end, so an extra tick past Deny stays there. Long-touch clears your pick.
- **Question or plan:** the strip reads **Answer in app**, under **Question** or **Plan** and what it's about. A press or tap jumps to the session, where you answer it. The deck never answers one, and turning does nothing.

**A press sends only what the strip has shown you:** the request, once it has been there for a second, and your pick, once it has shown for a moment, about 0.3 s. So a quick double press, or a tick just before the press, can't send something you didn't see. Otherwise the strip alerts and sends nothing, and the second starts again. A press for a request just answered somewhere else, in the app or on the Approve or Deny key, alerts too: whichever answers first wins.

## Other Sessions

A key for the top row, about the running sessions on no Session Slot. It shows how many need you, and the title of the one that has waited longest, with what it waits on and for how long. How many are done and not seen is in small type. With none needing you, it's dim and says how many others are running. Press to jump to the one that has waited longest, which becomes the target; with none, it alerts. As on a Session Slot key, a press in the moment before the key shows a change alerts.

## Actions that went

A placed one of these shows as a missing action, on this Mac or another: remove it in the Stream Deck app.
- **The Session key and the Sessions dial,** in Phase 9 (2026-11-07). The Session Slots and Other Sessions show the sessions and jump to them, and a jump makes the session the target.
- **The Mode dial and Mode keys,** in Phase 8 (2026-11-06). The deck never changes a session's mode, model or effort; a Session Slot's Setup page shows them.

## The other keys

| Key | What it does | Settings |
|---|---|---|
| Approve | Shows the oldest request waiting for permission, across sessions: its session, tool, and file or command. Press to allow it. | |
| Deny | The same request. Press to deny it, which stops the turn like the app's own No. | |
| Saved Prompt | Sends its text to the target session as your own message. A busy session gets it when its turn ends. The key shows waiting, sent or refused. | **Prompt** (the text) and **Key label** |

**How Approve and Deny behave:**
- **The app's dialog stays up beside the deck's request, and still works.** Whichever answers first wins.
- **A press counts only once its request has been on the key for 1 s,** so a double press can't answer a request you didn't see.
- **A question or a plan reads "Answer in app".** A press on it jumps to its session, where you answer it. Its Session Slot dial reads the same.
- **After an Esc in a session,** a Saved Prompt to it is refused until you type there yourself. That's Claude Code's rule.

## Statuses

| Status | Meaning |
|---|---|
| working | A turn is running. The strip says on what. |
| background | The session's own turn has ended, but its agents, a workflow or its threads still run. Blue, like working. A thread waiting on you keeps it here too; the thread's own key says what it waits on. |
| approval | A request is waiting on Approve or Deny. |
| needs you | A question, a plan, the app's own needs-input sign, or task cards waiting for you to start them. Cards count when the app's summary says the turn waits on them, so a card that only suggests a follow-up after a finished turn doesn't. A card that holds the turn open until you pick a new session or this one always counts. |
| failed | The last turn ended with an error. |
| interrupted | The last turn was stopped with Esc. |
| done | The last turn finished. |
| idle | Nothing yet. |

Without the plugin, a session shows only what the registry and the app's records give: working, needs you or idle.

A session started before plugin 0.4.0 shows Working instead of Background, with no workflow or agents, until it restarts: its plugin doesn't report other agents.

## The target session

The target, where Saved Prompts go, is the session last jumped to from a Session Slot or Other Sessions. Until you jump to one, it's the session most recently on screen in the app. A press for a session that has ended alerts and sends nothing.

## Which sessions it covers

- **Every running Code-tab session can fill a Session Slot,** counts on Other Sessions while it's on no slot, and can be jumped to.
- **Approvals, prompts and the full status need the plugin.**
  - A session gets the plugin, its hooks included, when it starts. A session that was already running gets it at its next start, for example after the Claude app restarts.
- **Only desktop sessions talk to the deck.** The plugin also loads in terminal and VS Code sessions, in `claude -p` runs, and in `claude` processes that a session starts, but there it stays quiet. Their permission prompts stay where they are.
- **The deck acts only on a press,** and only for the request or session it shows.

## Setup

`setup` is for a new Mac, from a clone of this repository. On the Mac where the repository is developed, use the dev commands in [`CLAUDE.md`](../CLAUDE.md) instead. To bring a Mac up to date after its setup, see [Keeping another Mac current](#keeping-another-mac-current).

**First:**
- **The Stream Deck app,** 7.1 or later. Install it, open it once, so it makes its plugins folder, then quit it. setup's restart starts it again, with developer mode on and the link in place: an app already running may not see developer mode until it relaunches.
- **The Claude app,** signed in, with one session started in its Code tab, so it has a Claude Code of its own. Claude Code in a terminal isn't enough: only the app's sessions talk to the deck.
- **git and [mise](https://mise.jdx.dev),** for example `brew install mise`. mise brings the Node 24 the deck is built with.
- **No Claude Code policy in the way,** on a Mac an employer manages. Managed settings can turn off the plugin's hook or its mod, or keep the plugin from loading. This lists the policy files on the Mac that set any of the settings that can:
  ```bash
  grep -r -l -s -a -E 'allowManagedHooksOnly|allowManagedModsOnly|disableAllHooks|allowedHttpHookUrls|httpHookAllowedEnvVars|disableSideloadFlags' "/Library/Application Support/ClaudeCode" "/Library/Managed Preferences"; echo checked
  ```
  - **Only `checked`:** none does.
  - **A file above it:** look in it for those names. `allowedHttpHookUrls` is fine when one of its patterns matches `http://127.0.0.1:47600/v1/permission`, and `httpHookAllowedEnvVars` when it has both `DECK_TOKEN` and `CLAUDE_CODE_HOST_SESSION_ID`.
  - **A policy that comes with the organization's Claude account** doesn't show here. The test approval under **Then** finds it.
  - Whatever a policy turns off, the app's own dialogs keep working.
- **The clone,** in a folder you'll keep, on a path without a `:`. `install` writes the path into `~/.claude/settings.json`, and the Stream Deck app links the deck from there. The repository is private on GitHub, so sign in first, with `gh auth login`, or with a token when git asks for a password:
  ```bash
  git clone https://github.com/Kard16/stream-deck-plugins.git ~/Projects/stream-deck-plugins
  ```
  - GitHub has only what the Mac where the repository is developed has pushed.
  - **Without a GitHub sign-in:** run `git bundle create deck.bundle main` on the Mac where the repository is developed, copy the file over, and clone from it. Each update then needs a new bundle.

**Then, from the top of the clone:**
```bash
mise trust
mise install node
mise exec node -- node claude-code/install/deck-install.mjs setup
```
`mise trust` lets mise read the clone's `mise.toml`: it refuses a config file it hasn't been told to trust. Name `node` in the other two: the Claude Code side needs nothing else, and a bare `mise exec --` would install every tool in `mise.toml`, Lua 5.1.5 built from source included.

`setup` prints each step and its result, and stops at the first that fails:
1. **A preflight** of the apps and the Node above, and of the clone: `claude-code/deck` and `claude-code/plugin` must be committed, so the build never ships unfinished code. It writes nothing.
2. **`npm ci` and `npm run build`** in `claude-code/deck`.
3. **`streamdeck dev`, `link` and `restart`:** Stream Deck's developer mode, which a linked plugin needs, then the deck plugin. A restart drops a request held on the deck back to the app's dialogs.
4. **A wait for the deck to start:** its first start makes its token, then its log says "Bridge: listening".
5. **`release`, `install` and `status`,** below. `install` makes `~/.claude/settings.json` when there's none.

Run it again after fixing what stopped it. It skips `npm ci` while `node_modules` has what `package-lock.json` names, the link while it points at this clone, and the release while the copy is current.

`setup --dry-run` runs only the preflight, then says whether each step would run, and why.

**If the wait times out,** quit and reopen the Stream Deck app, then run `setup` again.

**Then:**
1. **Quit the Claude app** (⌘Q) and open it again. A session loads the plugin when it starts.
2. **Start a session in the Code tab, then check that it worked:**
   ```bash
   mise exec node -- node claude-code/install/deck-install.mjs status
   grep -E "Bridge: listening|Sessions: HELLO .* plugin" claude-code/deck/com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log
   ```
   `status` ends with "installed and current" and exits 0. The log has "Bridge: listening on 127.0.0.1:47600", then a "Sessions: HELLO … plugin" line for each session.
3. **In the Stream Deck app,** place the actions from the **Claude Code** category, as in [The layout](#the-layout), or import a profile exported from another Mac. Each Mac keeps its own record of which session is on which slot.
   - **No Claude Code category:** quit and reopen the Stream Deck app.
4. **Try an approval:** in a session in Manual mode, ask Claude to write a small file. The Approve key shows its request, and a press allows it.
   - **The app asks and the deck shows nothing:** a policy is the likely cause; see **First**, above. Answer in the app.

### The release copy

The Claude Code plugin loads in your sessions from a release copy, through two keys in `~/.claude/settings.json`. `setup` runs these, and each also runs alone, from the repo root:
```bash
mise exec node -- node claude-code/install/deck-install.mjs status
```
- `release` copies `claude-code/plugin` as committed at HEAD into `claude-code/release/streamdeck-bridge`, which git ignores, and checks it with the app's Claude Code first.
- `install` sets `DECK_TOKEN` in the `env` block, and adds the release copy to `CLAUDE_CODE_PLUGIN_DIRS`, after any folders already there. It backs up the file to `claude-code/release/backups/` first, or makes it, `{}` at 0600, when there's none.
  - **Another copy of `streamdeck-bridge` there,** such as an old clone's release copy, gives its place to this one, since a session would load both. The backup keeps it.
- **To update:** commit, then run `release` again. New sessions load the new copy; running ones load it when they next start.
- **To undo:** `deck-install.mjs undo` removes `DECK_TOKEN`, and takes the release copy and any other copy of `streamdeck-bridge` out of `CLAUDE_CODE_PLUGIN_DIRS`, leaving other folders. New sessions start without the plugin; running ones keep it until they restart.

**About the token:** `DECK_TOKEN` keeps web pages and other accounts off the bridge. After `install` it's in the environment of every Claude Code process you run, and in `settings.json`. Any process of yours can read the deck's token file anyway. A `settings.json` that `install` makes is 0600. To keep other accounts on this Mac from reading one that was there before:
```bash
chmod 600 ~/.claude/settings.json
```

### Keeping another Mac current

Only the Mac where the repository is developed changes it. Another Mac pulls what that Mac pushes, then runs `setup` again.

- **After a change,** once it's committed, released and pushed. On the other Mac, from the top of the clone:
  ```bash
  git pull
  mise exec node -- node claude-code/install/deck-install.mjs setup
  ```
  - `setup` skips what's current, then rebuilds and restarts the deck plugin. A request held on the deck at that moment goes back to the app's dialog.
  - Its release checks a new plugin with that Mac's own Claude Code first, and keeps the old copy if the check fails.
  - Sessions load a new plugin when they next start.
  - Don't change files on that Mac: `setup` refuses uncommitted changes in `claude-code/deck` and `claude-code/plugin`.
- **After a Claude app update:** each Mac's app updates itself, perhaps on different days. Until the routine has run, whatever the deck can't handle falls back to the app's own dialogs.
  - A session on a Claude Code newer than the one this repository was checked against shows `↑`, in amber, on its Session Slot dial's Setup page.
  - Run [After a Claude app update](#after-a-claude-app-update) on the Mac where the repository is developed, once it has that version too. Then push, and pull and run `setup` on the other Mac. That clears its `↑`.
- **After a Stream Deck app update:** usually nothing. If the deck plugin doesn't come back, quit and reopen the Stream Deck app, or run `setup` again.
- **To take it off a Mac,** from the top of the clone:
  ```bash
  mise exec node -- node claude-code/install/deck-install.mjs undo
  cd claude-code/deck && mise exec node -- npx streamdeck unlink com.karimdhanji.claude
  ```
- **To move the clone:** take it off, move the folder, then run `setup` as on a new Mac.

## When something's off

- **setup's preflight says the Stream Deck app has the deck plugin from another folder,** such as an older clone: `streamdeck link` won't replace it. Take that link out, then run `setup` again. From `claude-code/deck`:
  ```bash
  mise exec node -- npx streamdeck unlink com.karimdhanji.claude
  ```
- **A session shows no details,** only working or idle: it started before the install or the last update. Restart it.
- **The app asks for permission and the Approve key shows nothing:** the deck couldn't confirm which session asked, or the deck restarted while the request was held. On a Mac an employer manages, a Claude Code policy may also keep the hook from running ([Setup](#setup), **First**). Answer in the app; it always works.
- **After a Stream Deck or Claude app restart, or after sleep,** the deck and the sessions find each other again within seconds, and when the Stream Deck comes back, every key and strip is repainted. A held request is lost on a deck restart, and its session shows needs you until you answer it in the app. If the keys stay dark or stale, see [When the deck stops responding](#when-the-deck-stops-responding).
- **A slot key shows the wrong session:** open the one you want in the app, then hold the key.
- **A slot stays empty:** every running session is on another slot. Hold its key to take the one on screen.
- **A session is on no key, and Other Sessions doesn't count it,** after you moved or removed a Session Slot key: the key's old place still holds it, as a slot on another page would. Open the session in the app, then hold the slot key you want it on.
- **A key stays lit after you looked:** the deck counts a look when the session comes on screen in the app on this Mac, or while it's on screen there with Claude in front. It checks which app is in front only while a Session Slot or Other Sessions key is on the deck. A press on its key counts too.
- **A dial alerts and sends nothing:** the request had been on the strip for under a second, your pick had only just shown, or it was answered somewhere else first. Look at the strip again, then press.
- **A dial reads Answer in app:** the session waits on a question or a plan, which the deck never answers. Press the dial to jump to the session, and answer there.
- **A Saved Prompt press alerts:** the deck's log says why. Often the target has ended, or its last prompt is still waiting. It can also mean the session's plugin hasn't checked in for a minute, as when the session's process was replaced while the deck restarted. The deck sends it nothing until it checks in again, which a live plugin does within a second. Approve and Deny still work meanwhile.
- **Logs:**
  - The deck: `deck/com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log`. For more detail, write `debug` to `deck/com.karimdhanji.claude.sdPlugin/log-level.txt` and restart the plugin.
  - The mod: each session's own debug log.

## When the deck stops responding

The Stream Deck app turns the Stream Deck off at every display sleep or lock, and back on a few seconds after the wake. When it's back, the deck plugin repaints every key and strip, and again 10 s and 20 s after the wake, in case the app brought it back without saying so. While the Stream Deck is away, the plugin sends it nothing. Its log says when the Stream Deck left and came back (`Devices:` lines), and whether the Mac slept or only its display did (`woke up:` lines).

**If the keys stay dark, or lit and stale,** try these in order:
1. **Look at the keys, and note which:** dark, or lit with old images while a press doesn't switch the Claude app's window. Lit and stale means the Stream Deck has power, but nothing on this Mac is talking to it.
2. **Run `doctor.mjs` before you re-plug anything,** so it reads the deck as it is while it's stuck, and keep its output. From the top of the clone:
   ```bash
   mise exec node -- node claude-code/tools/doctor.mjs | tee ~/Desktop/deck-doctor.txt
   ```
   It says whether macOS sees the Stream Deck on USB, whether the Stream Deck app has it, the deck plugin's Device, wake and Bridge lines, and macOS's sleep history, over the last 12 hours (`--hours 48` for more), then what to try. It's read only.
3. **Quit and reopen the Stream Deck app.**
4. **Re-plug** the Thunderbolt cable.

**Settings worth trying on the work Mac:**
- **System Settings, Battery, Options:** turn on "Prevent automatic sleeping on power adapter when the display is off", if MDM allows it. The Mac then stays out of system sleep on power; the app still turns the Stream Deck off while the display sleeps.
- **The monitor's firmware, M2T102 or later:** the OSD's Others, Display Info shows it. Update it with Dell Display and Peripheral Manager.
- **The lid open:** Dell lists USB devices on the monitor's hub not found after a wake with the lid closed.

## After a Claude app update

On the Mac where the repository is developed, a session runs the routine in [`CLAUDE.md`](../CLAUDE.md), "After a Claude app update". Its main check:

```bash
mise exec node -- node claude-code/tools/recheck.mjs
```

It checks the app internals this relies on: the registry and record fields, the jump route, and the mods API on the newest bundled Claude Code. Then run the fifteen-minute smoke test, [`docs/claude-code/smoke-test.md`](../docs/claude-code/smoke-test.md), in a throwaway session: it says what to press and the log line that proves each step.

Another Mac runs none of this. Once it's done and pushed, pull and run `setup` there, as in [Keeping another Mac current](#keeping-another-mac-current).

## Development

- **Throwaway sessions** start from the app's `deck-sandbox` preset, in `claude-code/sandbox/`. They load the dev copy through the `claude-code/sandbox-plugin` link, with hot reload, and the preset's token. In a desktop session the launch environment beats `settings.json`, so these never load the release copy.
  - **To make the preset** on a new Mac, after `setup`: in the Claude app's New session picker, save a preset named `deck-sandbox`, with the folder `claude-code/sandbox` in this clone, no worktree, and three environment variables:
    - `CLAUDE_CODE_PLUGIN_DIRS`: the absolute path of `claude-code/sandbox-plugin`, a link to `claude-code/plugin`.
    - `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`: a desktop session hot-reloads the plugin only with it. It goes in the preset, never in `settings.json`.
    - `DECK_TOKEN`: this Mac's deck token. The first line copies it without printing it; once it's pasted, the second clears the clipboard:
      ```bash
      tr -d '\n' < claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token | pbcopy
      pbcopy < /dev/null
      ```
- **Checks** are in [`CLAUDE.md`](../CLAUDE.md), under Commands. Once the plugin is installed, run `claude` commands with `env -u CLAUDE_CODE_PLUGIN_DIRS -u DECK_TOKEN`, so they don't load the release copy too.
- **The fake Claude, fake deck, fixture player and recheck** are in [`tools/`](tools/README.md).
