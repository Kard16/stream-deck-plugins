# Starting the Claude Code build session

## Before you start

Nothing to prepare. The Lightroom side is finished and stays as it is: its plugin keeps running in the Stream Deck app, and this build doesn't need Lightroom open.

If you choose the features that press keys for you (interrupt, mode, model and effort), the session may ask you partway through to grant macOS Accessibility permission.

## Start the session

1. In the Claude app's Code tab, start a new session in `~/Projects/stream-deck-plugins`.
   - Use the folder itself, not a worktree: the Stream Deck app loads plugins from paths inside it.
2. Choose Opus 5.5 with Max effort.
3. Paste the prompt below.

`ultracode` turns on Claude Code's orchestration mode: the session runs a multi-agent workflow for every substantial step, and token cost isn't a constraint. For lighter orchestration, delete that line. The rest of the prompt still lets the session use workflows and subagents.

## Prompt

```text
ultracode

Build the Claude Code side of my Stream Deck + project in this repo. The Lightroom Classic side is finished: leave its code and its running plugin alone. Start with CLAUDE.md, docs/research/claude-code-extensibility.md and docs/research/stream-deck-plus-sdk.md.

The features I chose: live status for each session, approve and deny from the deck, buttons for saved prompts and for mode, model and effort, and an overview of all my sessions with a way to jump to any of them.

You're the orchestrator. Run independent work as workflows and subagents, and keep this thread for decisions, integration and checking results.

1. There's no plan yet. Write docs/claude-code/plan.md first, modeled on docs/lightroom/plan.md: goal, decisions, open questions, phases with spikes before any build, a verification ladder, human-only steps, risks, log and progress. Add the Claude Code side to CLAUDE.md.
2. Before writing code, ask me the plan's open questions in one round, with your recommendation for each.
3. Run the spikes in the desktop app and show me the results before building on them. The research dates from 2026-10-31 and marks what it couldn't verify.
4. Freeze the contract between the Stream Deck plugin and the Claude Code plugin, then build the tracks in parallel.
5. Until I say otherwise, the Claude Code plugin runs only in throwaway sessions you start for testing. Never install it where this session or my other sessions would load it, and never approve, deny or send a prompt in a session you didn't start.
6. When you need me in the Claude app, the Stream Deck app or macOS settings, give me one numbered checklist.
7. Commit locally after each verified milestone. Don't push.

Keep the plan's Log and Progress sections current, so a fresh session could pick up where you left off.
```
