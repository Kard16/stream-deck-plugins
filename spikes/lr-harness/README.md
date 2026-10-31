# Spike harness (S1, S2, S3, S5)

Drives the spike build of DeckBridge over `spikes/protocol-v0.md`. Node 24, no dependencies; run everything from the repo root.

- **Live:** `mise exec -- node spikes/lr-harness/harness.mjs`. It waits for Lightroom, runs S1 and S3 on connect (about 10 s), shows a "ready" bezel (repeated every 20 s, up to 4 times, until a trigger arrives), then reacts to the Deck Spike menu items (`trigger tests`, `trigger autosync`), Reload Plug-in and quit/relaunch. Stop it with SIGINT or SIGTERM; either way it puts `SpikeVersion.lua` back.
- **Link rules** (`lib/client.mjs`, as the deck client will do): losing either socket closes the other and reconnects both, because Lightroom's sender never notices a client leaving. A 2 s heartbeat reconnects when events stop for 4 s while Lightroom still answers `ok`, and waits when the `ok`s stop too (Lightroom paused by a menu).
- **Results:** `spikes/results/<timestamp>/`, with `summary.md` (start with its Status table), `summary.json`, `events.jsonl` (every message) and `s2-samples.jsonl` (one line per `set`).
- **Options:** `--cmd-port`, `--evt-port`, `--plugin-dir`, `--out`, `--quick` (1 s bursts), `--max-minutes` (default 90).
- **Self-test** against `fake-lr.mjs` on ports 59780–59785: `mise exec -- node spikes/lr-harness/test.mjs`.
- **Fake alone:** `mise exec -- node spikes/lr-harness/fake-lr.mjs --cmd-port 59780 --evt-port 59781`, then type `trigger tests`, `trigger autosync`, `stale`, `freeze 6 autosync`, `reload` or `quit`.
