# Stream Deck + plugins

My own Elgato Stream Deck + plugins for Adobe Lightroom Classic and Claude Code, for this Mac only.

| Part | What it does | Status |
|---|---|---|
| Lightroom Classic | Develop sliders on the dials with live values on the touch strip, culling and rating keys, presets and one-click tools | Done, 2026-11-01: [plan](docs/lightroom/plan.md) |
| Claude Code | Live session status, approve/deny from the deck, Saved Prompt and Mode buttons (model and effort shown only), an overview of all sessions with jump-to-session | In daily use since 2026-11-03, hardening: [guide](claude-code/README.md), [plan](docs/claude-code/plan.md) |

## How the Claude Code side fits together

```
Stream Deck + ── Stream Deck app ── deck plugin (TypeScript, claude-code/deck)
                                        │  hosts the bridge on 127.0.0.1:47600,
                                        │  reads the session registry and the app's records
                                        │
                                        │  localhost HTTP
                                        │
                        streamdeck-bridge, a Claude Code plugin (claude-code/plugin),
                        in each Claude desktop session: a mod and two http hooks
```

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
- [claude-code/README.md](claude-code/README.md): the Claude Code side's guide: the dials and keys, setup, and what to do when something's off
- [docs/claude-code/plan.md](docs/claude-code/plan.md): the Claude Code build plan and progress
- [CLAUDE.md](CLAUDE.md): working rules for Claude Code in this repo

## Toolchain

Run `mise install` in this folder to get Node 24 and Lua 5.1.5, which are pinned in `mise.toml`.
