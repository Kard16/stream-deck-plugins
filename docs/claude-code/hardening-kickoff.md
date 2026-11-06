# Starting the hardening session (Phase 8)

## Before you start

- **Nothing to prepare.** Phase 7 and the 2.1.317 update are committed. The deck runs 0.4.0, and plugin 0.2.1 is released to your sessions. If `git status` isn't clean, the session asks you first.
- **Keep using the deck as you do.** The session measures idle work with your usual sessions open, so a normal setup is the right one. It asks before restarting the Claude deck plugin.
- **Lightroom isn't involved.** Its plugin keeps running in the Stream Deck app.
- **Partway through, the session asks you for:**
  - a few answers in one round, starting with which deck features you use;
  - presses on the deck for a live check;
  - one reboot of the Mac.

## Start the session

1. In the Claude app's Code tab, start a new session in `~/Projects/stream-deck-plugins`.
   - Use the folder itself, not a worktree: the Stream Deck app loads the plugins from paths inside it.
2. Choose Opus 5.5 with Max effort.
3. Paste the prompt below.

`ultracode` turns on Claude Code's orchestration mode: the session runs a multi-agent workflow for every substantial step, and token cost isn't a constraint. For lighter orchestration, delete that line. The rest of the prompt still lets the session use workflows and subagents.

## Prompt

```text
ultracode

Run Phase 8 of the Claude Code side of my Stream Deck + project in this repo. There are three goals:
- cut the work the deck and the plugin do while nothing is happening;
- make the setup resilient to Claude app and Claude Code updates;
- keep it easy to maintain.
Start with CLAUDE.md, then the spec, docs/claude-code/hardening.md, then the last entries of the Log in docs/claude-code/plan.md.

Lean over clever: remove before you add, measure before and after, and don't refactor what this phase doesn't need.

You're the orchestrator. Run independent work as workflows and subagents, and keep this thread for decisions, integration and checking results.

1. Measure the idle baseline first, as the spec says, and record it in the plan's Log.
2. Then ask me the spec's questions in one round, with your recommendation for each.
3. Changes to the bridge protocol go through this thread: PROTOCOL.md amendments, with fixtures made by make-fixtures.mjs.
4. My own sessions are read-only. Live checks run in throwaway sessions you start from the deck-sandbox preset. Tell me before you restart the Claude deck plugin.
5. When you need me on the deck, in the Claude app or in macOS, give me one numbered checklist.
6. Commit locally after each verified milestone. After a commit that changes claude-code/plugin, release it with deck-install.mjs. Don't push.

Keep the plan's Log and Progress current, so a fresh session could pick up where you left off.
```
