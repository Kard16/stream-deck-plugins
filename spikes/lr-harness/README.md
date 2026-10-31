# Spike harness (S1, S2, S3, S5)

Drives the spike build of DeckBridge over `spikes/protocol-v0.md`. Node 24, no dependencies; run everything from the repo root.

- **Live:** `mise exec -- node spikes/lr-harness/harness.mjs`. It waits for Lightroom, runs S1 and S3 on connect, shows a "ready" bezel, then reacts to the Deck Spike menu items (`trigger tests`, `trigger autosync`), Reload Plug-in and quit/relaunch. Stop it with SIGINT or SIGTERM; either way it puts `SpikeVersion.lua` back.
- **Results:** `spikes/results/<timestamp>/`, with `summary.md` (start with its Status table), `summary.json`, `events.jsonl` (every message) and `s2-samples.jsonl` (one line per `set`).
- **Options:** `--cmd-port`, `--evt-port`, `--plugin-dir`, `--out`, `--quick` (1 s bursts), `--max-minutes` (default 90).
- **Self-test** against `fake-lr.mjs` on ports 59780–59785: `mise exec -- node spikes/lr-harness/test.mjs`.
- **Fake alone:** `mise exec -- node spikes/lr-harness/fake-lr.mjs --cmd-port 59780 --evt-port 59781`, then type `trigger tests`, `trigger autosync`, `reload` or `quit`.
