# Stream Deck + plugins for Lightroom Classic and Claude Code

Two plugins that put Adobe Lightroom Classic and Claude Code on an [Elgato Stream Deck +](https://www.elgato.com/stream-deck-plus): eight keys, four dials and a touch strip.

| Side | What it does | Guide |
|---|---|---|
| **Lightroom Classic** | Develop sliders on the dials, with live values on the touch strip. Keys for pick, reject, next and previous, Before/After and presets. | [lightroom/README.md](lightroom/README.md) |
| **Claude Code** | A key and a dial for each session in the Claude desktop app, showing what it's doing and what it needs from you. Approve and Deny keys for permission requests, saved prompts, and a press to jump to a session. | [claude-code/README.md](claude-code/README.md) |

The two sides are independent. Install either one, or both.

I built these for my own desk, and Claude Code wrote most of the code. They aren't on the Elgato Marketplace and come with no support, but everything needed to run them is here.

## Before you install

- **macOS only,** with a Stream Deck + and the Stream Deck app, 7.1 or later. Developed on macOS 26 with Stream Deck 7.6.
- **Not from the Marketplace.** Each plugin is built from a clone of this repo and linked into the Stream Deck app, which needs its developer mode. The guides have the steps.
- **The Lightroom side** is built for Lightroom Classic 15.3.
- **The Claude Code side** needs the Claude desktop app: it works with the sessions in its Code tab, not with Claude Code in a terminal. It relies on Claude Code's mods API, which is early access, and on undocumented files the app keeps, so an app update can break it. When that happens the app's own dialogs keep working, and [a routine](claude-code/README.md#after-a-claude-app-update) checks what changed. Last checked with Claude Code 2.1.321.

## How it fits together

Each side is a pair of plugins that talk over localhost.

**Lightroom Classic:**

```
Stream Deck + ── Stream Deck app ── deck plugin (TypeScript, lightroom/deck)
                                        │
                                        │  two localhost sockets, JSON lines
                                        │
                        Deck Bridge, a Lua plugin inside Lightroom Classic (lightroom/lua)
```

**Claude Code:**

```
Stream Deck + ── Stream Deck app ── deck plugin (TypeScript, claude-code/deck)
                                        │  hosts the bridge on 127.0.0.1:47600, behind a token,
                                        │  and reads the app's list of running sessions
                                        │
                                        │  localhost HTTP
                                        │
                        streamdeck-bridge, a Claude Code plugin (claude-code/plugin),
                        in each desktop session: a mod, and a hook for permission requests
```

## What's in the repo

| Path | What |
|---|---|
| [`lightroom/`](lightroom/README.md) | The Lightroom side: the Lua plugin, the deck plugin, the wire protocol and test tools |
| [`claude-code/`](claude-code/README.md) | The Claude Code side: the Claude Code plugin, the deck plugin, the bridge protocol, the installer and test tools |
| [`docs/`](docs/README.md) | Research, plans and build logs |
| `spikes/` | Early experiments, kept for the record |
| [`CLAUDE.md`](CLAUDE.md) | The working rules and commands Claude Code follows in this repo |

## How it was built

Claude Code sessions did the research, wrote the plans and built both sides, with me at the hardware for the checks only a person can do. The record is in [`docs/`](docs/README.md): the research, each side's plan with its dated log, and the prompts that started each build session.

## Toolchain

[mise](https://mise.jdx.dev) pins Node 24 and Lua 5.1.5 in `mise.toml`. From the top of the clone:

```bash
mise trust
mise install
```

Lua is only for the Lightroom plugin's tests. The Claude Code side's guide installs Node alone.

## License

[MIT](LICENSE). `lightroom/lua/DeckBridge.lrdevplugin/json.lua` is [rxi's json.lua](https://github.com/rxi/json.lua), also MIT, with its notice in the file.
