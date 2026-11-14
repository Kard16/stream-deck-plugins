# Docs

Working documents from the build. Claude Code sessions wrote most of them, for themselves and for me, so they're thorough rather than short. They call me "the user".

To use the plugins, start with the guides instead: [Lightroom](../lightroom/README.md) and [Claude Code](../claude-code/README.md).

## Research

Three reports from 2026-10-31, written before any code. They're a snapshot: versions and links are as of that date.

- [research/stream-deck-plus-sdk.md](research/stream-deck-plus-sdk.md): the Stream Deck SDK, and what the Stream Deck + adds
- [research/lightroom-classic-sdk.md](research/lightroom-classic-sdk.md): what the Lightroom Classic SDK can and can't control
- [research/claude-code-extensibility.md](research/claude-code-extensibility.md): hooks, mods and the desktop app

## Lightroom

- [lightroom/plan.md](lightroom/plan.md): the plan, its decisions, and a dated log of what was built and checked
- [lightroom/kickoff-prompt.md](lightroom/kickoff-prompt.md): the prompt that started the build session

## Claude Code

- [claude-code/plan.md](claude-code/plan.md): the plan, its decisions, and the log. It's long: every spike, test run and fix is in it.
- The spec for each later phase:
  - [claude-code/session-keys.md](claude-code/session-keys.md): a key and a dial for each session
  - [claude-code/hardening.md](claude-code/hardening.md): less idle work, and surviving app updates
  - [claude-code/agents-and-wake.md](claude-code/agents-and-wake.md): background agents, and the Stream Deck leaving and returning after sleep
- [claude-code/smoke-test.md](claude-code/smoke-test.md): the live check to run after a Claude app update
- [claude-code/kickoff-prompt.md](claude-code/kickoff-prompt.md) and [claude-code/hardening-kickoff.md](claude-code/hardening-kickoff.md): the prompts that started build sessions

## Elsewhere

- The wire protocols: [lightroom/protocol/PROTOCOL.md](../lightroom/protocol/PROTOCOL.md) and [claude-code/protocol/PROTOCOL.md](../claude-code/protocol/PROTOCOL.md)
- The test tools: [lightroom/tools/README.md](../lightroom/tools/README.md) and [claude-code/tools/README.md](../claude-code/tools/README.md)
- [CLAUDE.md](../CLAUDE.md): the rules and commands Claude Code follows in this repo
