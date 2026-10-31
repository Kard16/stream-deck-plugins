# Starting the Lightroom build session

## Before you start

Make a test catalog in Lightroom Classic with File ▸ New Catalog, saved outside this repo (for example in `~/Pictures/Deck Test/`).
- Import 20–50 copies of real photos, including a few of your largest raws.
- Keep this catalog open while the build session works.

Already done on 2026-10-31: the Stream Deck app 7.6.0 is installed, and the Stream Deck + is on your dock. Some docks drop dial events, so if the dials misbehave, try one of the Mac's own ports first.

## Start the session

1. In the Claude app's Code tab, start a new session in `~/Projects/stream-deck-plugins`.
   - Use the folder itself, not a worktree: Lightroom and the Stream Deck app will load the plugins from paths inside it.
2. Choose Opus 5.5 with Max effort.
3. Paste the prompt below, with your test catalog's path filled in.

`ultracode` turns on Claude Code's orchestration mode: the session runs a multi-agent workflow for every substantial step, and token cost isn't a constraint. For lighter orchestration, delete that line. The rest of the prompt still lets the session use workflows and subagents.

## Prompt

```text
ultracode

Build the Lightroom Classic side of my Stream Deck + project in this repo. Start with CLAUDE.md and docs/lightroom/plan.md; the plan points to the research sections that matter.

You're the orchestrator. Run independent work as workflows and subagents, and keep this thread for decisions, integration and checking results.

1. Before writing code, ask me the plan's open questions in one round, with your recommendation for each.
2. Run the Phase 1 spikes and show me the results before building on them.
3. Freeze the protocol, then build the Lua, deck and tools tracks in parallel.
4. When you need me in Lightroom, the Stream Deck app or macOS settings, give me one numbered checklist.
5. My test catalog is at: <path to the .lrcat file>. Don't touch any other catalog.
6. Commit locally after each verified milestone. Don't push.

Keep the plan's Log and Progress sections current, so a fresh session could pick up where you left off.
```
