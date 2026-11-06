# Claude Code on the Stream Deck +

Live status for the Claude desktop app's Code-tab sessions, with a key and a dial for each session, answers to questions, plans and approvals, saved prompts and mode changes on the deck, for this Mac. Two plugins talk over localhost:

- **`streamdeck-bridge`** (`plugin/`) is a Claude Code plugin, so it runs inside each session. It has three parts:
  - a mod that reports the session's status and runs what the deck sends;
  - a PermissionRequest hook that puts approvals on the deck;
  - a PreToolUse hook for the deck's own mode changes.
- **The Stream Deck plugin** (`deck/`, `com.karimdhanji.claude`) runs in the Stream Deck app and hosts the bridge on 127.0.0.1:47600. It also reads the session registry (`~/.claude/sessions/`) and the app's session records, so it lists every running session, with or without the plugin.

The wire protocol is [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md). The plan, decisions and test results are in [`docs/claude-code/plan.md`](../docs/claude-code/plan.md).

## The layout

| Where | Action | What it does |
|---|---|---|
| Bottom row, 4 keys | **Session Slot** | One session per key: its state, title, context and what it's doing. Press to jump to it; hold to put the session on screen in the app on this key. |
| The 4 dials | **Session Slot**, the same action on a dial | The session on the key above. The strip shows its details, or the question, plan or approval it's waiting on. Turn to page or pick; press or tap to jump or send. |
| Top row | **Other Sessions**, and any of the keys below | How many sessions on no slot need you. Press to jump to the one that has waited longest. |

The Sessions and Mode dials and the other keys work as before, on this page or another.

## Session Slot keys

**The key face:**
- **The colour says the state.** Amber, with a light outline, means the session needs you: **Question**, **Plan**, **Approve?** or **Needs you**. Blue is **Working**. Green is **Done**, red **Failed** and dark red **Stopped**, until you've seen the session; then the key goes dark, as it is while **Idle**.
- **The top line** says the state and how long it has lasted: 30s, 4m, 2h, 3d.
- **The title** is in the middle.
- **The bottom line** has the tool it's running or waiting to run, and the context %, over a thin bar that turns orange at 80%.
- **Not running**, dimmed: the session's process has stopped, after a Claude app restart say. A press opens it, and the app starts it again.
- **No session:** an empty slot. Hold the key to add the session on screen.

**Press** to jump to the session in the app. It becomes the target, as a pick on the Sessions dial does, so the Saved Prompt and Mode keys act on it. A press in the moment before the key shows a change, such as a swap, alerts and does nothing.

**Hold** for half a second to put the session that's on screen in the app on this key. If it's on another slot, the two swap. The key shows OK, or an alert when the deck doesn't know which session is on screen, or that session is archived.

**How slots fill:** an empty slot takes a running session that's on no other slot: one that needs you first, the one waiting longest; otherwise the newest. The bottom row fills first, left to right.

**Then each stays put.** A slot keeps its session on other pages and across restarts, until you archive the session in the app, until it's deleted, or until you hold the key for another one. The slots are saved in `deck/com.karimdhanji.claude.sdPlugin/run/slots.json`.

**Seen:** a turn's end stays lit until you've seen the session: it came on screen in the app on this Mac, it was on screen there while Claude was the app in front, or you pressed its key or jumped from its dial. Claude on your phone doesn't count.

## Session Slot dials

Each dial belongs to the session on the key above it, and its strip shows what didn't fit on the key.

**With nothing to answer,** the strip has three pages, and the dots say which:
1. **Now:** what it's doing, or how its last turn ended, then the app's last summary, or what the app says it needs.
2. **Context:** the context %, with its bar, the tokens, and the cost so far.
3. **Setup:** model and effort, mode, and project.

Turn to page. Press or tap to jump to the session. Long-touch goes back to the first page.

**When the session waits on you,** the strip shows what for, the oldest first. Turn to pick, then press or tap to send. Nothing is picked until you turn, and a press before that jumps to the session. The Allow, Deny and plan choices stop at either end, so an extra tick past Deny or Reject stays there. Long-touch goes back a step.
- **Approval:** Allow or Deny, the same as the Approve and Deny keys.
- **Question:** turn through the options. A press picks one and moves to the next question. On a multi-select question, a press ticks or unticks, and **Next**, or **Send** on the last question, goes on once something is ticked. After the last question, the deck sends your answers.
- **Other…**, after a question's options, jumps to the app, so you can type your own answer.
- **Plan:** **✓ Auto**, **✓ Accept edits** or **✓ Manual** approves the plan and leaves Plan mode into that mode. **✗ Reject** stops the turn, so you can say in the app what to change. The whole plan is in the app.
- **Answer in app:** a question or plan the deck can't read, or one too big for it. A press jumps.

**When the dial answers first, the app's own question or plan card closes by itself.**

**A press sends only what the strip has shown you:** the request, once it has been there for a second, and your pick, once it has shown for a moment, about 0.3 s. So a quick double press, or a tick just before the press, can't send something you didn't see. Otherwise the strip alerts and sends nothing, and the second starts again. A press for a request just answered somewhere else, in the app or on the Approve or Deny key, alerts too: whichever answers first wins.

## Other Sessions

A key for the top row, about the running sessions on no Session Slot. It shows how many need you, and the title of the one that has waited longest, with what it waits on and for how long. How many are done and not seen is in small type. With none needing you, it's dim and says how many others are running. Press to jump to the one that has waited longest, which becomes the target; with none, it alerts. As on a Session Slot key, a press in the moment before the key shows a change alerts.

## The Sessions and Mode dials

- **Sessions:** turn to scroll the running sessions on the strip. Each shows its title, status, context %, model and effort. Press or tap to jump to that session in the app and make it the target.
- **Mode:** shows the target session's mode, model and effort.
  - Turn to choose Manual, Accept edits, Plan or Auto.
  - Press or tap to apply it. Without a turn, a press or tap does nothing, so it can't re-apply a mode the deck shows a moment late. Long-touch cancels the choice.
  - Model and effort are shown, never changed.

## The other keys

| Key | What it does | Settings |
|---|---|---|
| Approve | Shows the oldest request waiting for permission, across sessions: its session, tool, and file or command. Press to allow it. | |
| Deny | The same request. Press to deny it, which stops the turn like the app's own No. | |
| Saved Prompt | Sends its text to the target session as your own message. A busy session gets it when its turn ends. The key shows waiting, sent or refused. | **Prompt** (the text) and **Key label** |
| Mode Key | Sets the target session to one mode. | **Mode** |
| Session | The target session's title and status. Press to jump to it. | |

**How Approve and Deny behave:**
- **The app's dialog stays up beside the deck's request, and still works.** Whichever answers first wins.
- **A press counts only once its request has been on the key for 1 s,** so a double press can't answer a request you didn't see.
- **A question or a plan reads "Answer in app".** A press on it jumps to its session. Its Session Slot dial can answer it.
- **After an Esc in a session,** a Saved Prompt to it is refused until you type there yourself. That's Claude Code's rule.

## Statuses

| Status | Meaning |
|---|---|
| working | A turn is running. The strip says on what. |
| approval | A request is waiting on Approve or Deny. |
| needs you | A question, a plan, or the app's own needs-input sign. |
| failed | The last turn ended with an error. |
| interrupted | The last turn was stopped with Esc. |
| done | The last turn finished. |
| idle | Nothing yet. |

Without the plugin, a session shows only what the registry and the app's records give: working, needs you or idle.

## The target session

The target is the session last picked on the Sessions dial, or last jumped to from a Session Slot or Other Sessions. Until you pick one, it's the session most recently on screen in the app. A press for a session that has ended alerts and sends nothing.

## Which sessions it covers

- **Every running Code-tab session is on the Sessions dial,** can fill a Session Slot, and can be jumped to.
- **Approvals, prompts, mode and the full status need the plugin.**
  - A session gets the plugin, its hooks included, when it starts. A session that was already running gets it at its next start, for example after the Claude app restarts.
- **Only desktop sessions talk to the deck.** The plugin also loads in terminal and VS Code sessions, in `claude -p` runs, and in `claude` processes that a session starts, but there it stays quiet. Their permission prompts stay where they are.
- **The deck acts only on a press,** and only for the request or session it shows.

## Mode changes from Auto

In Auto, Claude Code's auto-mode classifier would refuse the plugin's own call to change the mode. The deck's mode hook gets the change past it, and the deck allows only a change you pressed for. A raise, such as back to Auto, brings up the app's approval, which the deck allows for the same press. A session started before plugin 0.2.0 can't change mode from Auto.

## Setup

This is done on this Mac. The steps are here for a rebuild or an update.

1. **The Stream Deck plugin** is linked from `claude-code/deck/com.karimdhanji.claude.sdPlugin` and needs Stream Deck's developer mode. From `claude-code/deck`:
   ```bash
   mise exec -- npm install
   mise exec -- npm run build
   mise exec -- npx streamdeck link com.karimdhanji.claude.sdPlugin
   mise exec -- npx streamdeck restart com.karimdhanji.claude
   ```
2. **The Claude Code plugin** loads in your sessions from a release copy, through two keys in `~/.claude/settings.json`. From the repo root:
   ```bash
   mise exec -- node claude-code/install/deck-install.mjs status
   ```
   ```bash
   mise exec -- node claude-code/install/deck-install.mjs release
   ```
   ```bash
   mise exec -- node claude-code/install/deck-install.mjs install
   ```
   - `release` copies `claude-code/plugin` as committed at HEAD into `claude-code/release/streamdeck-bridge`, which git ignores, and checks it with the app's Claude Code first.
   - `install` adds `CLAUDE_CODE_PLUGIN_DIRS` and `DECK_TOKEN` to the `env` block. It backs up the file to `claude-code/release/backups/` first.
   - **To update:** commit, then run `release` again. New sessions load the new copy; running ones load it when they next start.
   - **To undo:** `deck-install.mjs undo` removes the two keys. New sessions start without the plugin; running ones keep it until they restart.
3. **In the Stream Deck app,** place the actions from the **Claude Code** category.

**About the token:** `DECK_TOKEN` keeps web pages and other accounts off the bridge. After `install` it's in the environment of every Claude Code process you run, and in `settings.json`. Any process of yours can read the deck's token file anyway. To keep other accounts on this Mac from reading `settings.json`:
```bash
chmod 600 ~/.claude/settings.json
```

## When something's off

- **A session shows no details,** only working or idle: it started before the install or the last update. Restart it.
- **The app asks for permission and the Approve key shows nothing:** the deck couldn't confirm which session asked, or the deck restarted while the request was held. Answer in the app; it always works.
- **After a Stream Deck or Claude app restart, or after sleep,** the deck and the sessions find each other again within seconds. A held request is lost on a deck restart, and its session shows needs you until you answer it in the app.
- **A slot key shows the wrong session:** open the one you want in the app, then hold the key.
- **A slot stays empty:** every running session is on another slot. Hold its key to take the one on screen.
- **A session is on no key, and Other Sessions doesn't count it,** after you moved or removed a Session Slot key: the key's old place still holds it, as a slot on another page would. Open the session in the app, then hold the slot key you want it on.
- **A key stays lit after you looked:** the deck counts a look when the session comes on screen in the app on this Mac, or while it's on screen there with Claude in front. It checks which app is in front only while a Session Slot or Other Sessions key is on the deck. A press on its key counts too.
- **A dial alerts and sends nothing:** the request had been on the strip for under a second, your pick had only just shown, or it was answered somewhere else first. Look at the strip again, then press.
- **A dial reads Answer in app:** the deck couldn't read the question's form, the request is over 64 KiB, or, rarely, it held part of the deck's token, which the deck takes out of everything it reads. Answer in the app.
- **A Saved Prompt or Mode press alerts:** the deck's log says why. Often the target has ended, or its last prompt is still waiting. It can also mean the session's plugin hasn't checked in for a minute, as when the session's process was replaced while the deck restarted. The deck sends it nothing until it checks in again, which a live plugin does within a second. Approve and Deny still work meanwhile.
- **Logs:**
  - The deck: `deck/com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log`. For more detail, write `debug` to `deck/com.karimdhanji.claude.sdPlugin/log-level.txt` and restart the plugin.
  - The mod: each session's own debug log.

## After a Claude app update

```bash
mise exec -- node claude-code/tools/recheck.mjs
```

It checks the app internals this relies on: the registry and record fields, the jump route, the mode tool, and the mods API on the newest bundled Claude Code. Then try one jump and one mode change on the deck.

## Development

- **Throwaway sessions** start from the app's `deck-sandbox` preset, in `claude-code/sandbox/`. They load the dev copy through the `claude-code/sandbox-plugin` link, with hot reload, and the preset's token. In a desktop session the launch environment beats `settings.json`, so these never load the release copy.
- **Checks** are in [`CLAUDE.md`](../CLAUDE.md), under Commands. Once the plugin is installed, run `claude` commands with `env -u CLAUDE_CODE_PLUGIN_DIRS -u DECK_TOKEN`, so they don't load the release copy too.
- **The fake Claude, fake deck, fixture player and recheck** are in [`tools/`](tools/README.md).
