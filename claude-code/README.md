# Claude Code on the Stream Deck +

Live status for the Claude desktop app's Code-tab sessions, with approvals, saved prompts and mode changes on the deck, for this Mac. Two plugins talk over localhost:

- **`streamdeck-bridge`** (`plugin/`) is a Claude Code plugin, so it runs inside each session. It has three parts:
  - a mod that reports the session's status and runs what the deck sends;
  - a PermissionRequest hook that puts approvals on the deck;
  - a PreToolUse hook for the deck's own mode changes.
- **The Stream Deck plugin** (`deck/`, `com.karimdhanji.claude`) runs in the Stream Deck app and hosts the bridge on 127.0.0.1:47600. It also reads the session registry (`~/.claude/sessions/`) and the app's session records, so it lists every running session, with or without the plugin.

The wire protocol is [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md). The plan, decisions and test results are in [`docs/claude-code/plan.md`](../docs/claude-code/plan.md).

## The dials

- **Sessions:** turn to scroll the running sessions on the strip. Each shows its title, status, context %, model and effort. Press or tap to jump to that session in the app and make it the target.
- **Mode:** shows the target session's mode, model and effort.
  - Turn to choose Manual, Accept edits, Plan or Auto.
  - Press or tap to apply it. Long-touch cancels the choice.
  - Model and effort are shown, never changed.

## The keys

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
- **A question or a plan reads "Answer in app".** A press on it jumps to its session.
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

The target is the session last picked on the Sessions dial. Until you pick one, it's the session most recently on screen in the app. A press for a session that has ended alerts and sends nothing.

## Which sessions it covers

- **Every running Code-tab session is on the Sessions dial,** and every one can be jumped to.
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
