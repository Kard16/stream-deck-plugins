# Stream Deck + plugins

My own Elgato Stream Deck + plugins for Adobe Lightroom Classic and Claude Code, for this Mac only.

| Part | What it does | Status |
|---|---|---|
| Lightroom Classic | Develop sliders on the dials with live values on the touch strip, culling and rating keys, presets and one-click tools | Building: [plan](docs/lightroom/plan.md) |
| Claude Code | Live session status, approve/deny from the deck, saved-prompt and mode/model/effort buttons, an overview of all sessions with jump-to-session | Building: [plan](docs/claude-code/plan.md) |

## How the Lightroom side fits together

```
Stream Deck + ── Stream Deck app ── deck plugin (TypeScript, lightroom/deck)
                                        │
                                        │  two localhost sockets, JSON lines
                                        │
                        Lua plugin inside Lightroom Classic (lightroom/lua)
```

## Docs

- [docs/research/](docs/research/): Stream Deck, Lightroom Classic and Claude Code research, as of 31 October 2026
- [docs/lightroom/plan.md](docs/lightroom/plan.md): the Lightroom build plan and progress
- [docs/lightroom/kickoff-prompt.md](docs/lightroom/kickoff-prompt.md): how to start the build session
- [docs/claude-code/plan.md](docs/claude-code/plan.md): the Claude Code build plan and progress
- [CLAUDE.md](CLAUDE.md): working rules for Claude Code in this repo

## Toolchain

Run `mise install` in this folder to get Node 24 and Lua 5.1.5, which are pinned in `mise.toml`.
