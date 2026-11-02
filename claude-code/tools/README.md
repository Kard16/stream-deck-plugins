# Claude Code tools

Tools for testing the two Claude Code side plugins against fakes, ladder steps 4 and 5 in `docs/claude-code/plan.md`, and for Phase 4 on the hardware. They speak the bridge protocol in `claude-code/protocol/PROTOCOL.md` (version 1) and play its fixtures. Plain Node 24 ESM with no dependencies, so nothing needs installing. Run node through `mise exec --`: the shell's bare `node` is 22.

| File | What |
|---|---|
| `fake-bridge.mjs` | The deck plugin's side of the protocol, without the deck: a fake deck to run the real Claude Code plugin against (step 4). Also the CLI for its control routes. |
| `fake-claude.mjs` | Plays the plugin side of the fixtures against a bridge, standing in for Claude Code and the mod at once: `--against-fake` or `--interactive` (step 5). |
| `lib/protocol.mjs` | The protocol's constants and answers, and its fingerprint and summary. |
| `lib/fixtures.mjs` | Reads and checks the fixtures and `vectors.json`. |
| `lib/match.mjs` | PROTOCOL.md's matching rules: partial objects, `*`, arrays, query parameters, `at` ignored, and binding of command ids and insts. |
| `lib/deck.mjs` | The fake deck's logic: kinds, held requests, release rules, commands, long polls, sessions and statuses. No I/O. |
| `lib/bridge.mjs` | The fake bridge's HTTP side, its folder readings and its log. |
| `lib/registry.mjs` | Reads the session registry and the app's records, read only. |
| `lib/client.mjs` | An HTTP client that sends requests exactly as a fixture says, and the control client. |
| `lib/play.mjs` | Plays one fixture by the deck side's rules in PROTOCOL.md. |
| `lib/drivers.mjs` | What happens to press, registry and expect lines: through the fake bridge, or by a person at the deck. |
| `test/` | The self-tests. |

## Self-tests

```sh
mise exec -- node --test claude-code/tools/test/
```

They play every fixture end to end, fake-claude against the fake bridge on port 0 with temp registry and records folders, and test the pieces on their own. They bind port 0 only, never 47600 or 47601, and never read or write `~/.claude/` or the app's folders: every child process gets a temp `HOME`.

Node 24 takes `node --test`'s arguments as glob patterns, so a folder is run as one module. `test/package.json` points that module at `test/all.mjs`, which imports every `*.test.mjs`. `node --test claude-code/tools/test/*.test.mjs` runs the same tests, a process per file.

## Ladder step 4: the real plugin against the fake bridge

The main thread runs this, with a throwaway session it started from the `deck-sandbox` preset, once `claude-code/sandbox-plugin` points at `claude-code/plugin/`.

1. **Free port 47600.** The plugin's hooks and mod call `http://127.0.0.1:47600`, which the spike bridge holds now and the deck plugin later. Only one of them runs at a time.
2. **Start the fake bridge:**

   ```sh
   mise exec -- node claude-code/tools/fake-bridge.mjs
   ```

   With no options it listens on 127.0.0.1:47600 and reads its token from `spikes/cc-bridge/run/token`, the spike bridge's, which the preset's `DECK_TOKEN` holds. It reads the real registry (`~/.claude/sessions/*.json`, never the `.key` files) and the app's records, only ever reading them. It logs to `claude-code/tools/run/<YYYYMMDD-HHMMSS>-fake-bridge/`, which git ignores. Stdout gets a line for each hello, held request, release, press, command and registry change.
3. **Give the session prompts** that make it read, write (an approval in Manual mode), ask a question, and so on.
4. **Act as the keys,** from another terminal. Each command prints the answer as JSON, and exits 1 when the press alerted or the call failed:

   ```sh
   T=claude-code/tools/fake-bridge.mjs
   mise exec -- node $T state                       # what the deck would show, and everything behind it
   mise exec -- node $T approve                     # the Approve key: Allow for the oldest held request
   mise exec -- node $T deny                        # the Deny key: Deny, which stops the turn
   mise exec -- node $T answer p3 none              # releases p3 with no decision: the app's dialog decides
   mise exec -- node $T prompt local_… "List the files here."
   mise exec -- node $T mode local_… acceptEdits    # the raise's own PermissionRequest is allowed at once
   ```

   A held request stays held until a command answers it or a release rule ends it: the fake bridge has no timeout of its own. `prompt` and `mode` alert for a session the registry doesn't list or whose mod hasn't spoken to the bridge, so they reach only sessions with the plugin: throwaway sessions until Phase 5. Only send them to a session the main thread started.
5. **Read the log** in the run folder, alongside the session's transcript:

   ```sh
   cd claude-code/tools/run/<the run>
   jq -c 'select(.kind == "fp-check") | {request, tool, match, bridgeFp, modFp, bridgeSummary, modSummary}' events.jsonl
   jq -c 'select(.kind == "held" or .kind == "release" or .kind == "answered") | {kind, id, tool, summary, rule, why, decision, by}' events.jsonl
   jq -c 'select(.kind == "command" or .kind == "result-ignored")' events.jsonl
   jq -c 'select(.kind == "hello" or .kind == "mod-restart")' events.jsonl
   jq -c 'select(.kind == "request") | {n, method, path, auth}' events.jsonl
   ```

   `fp-check` is PROTOCOL.md's check that both sides' fingerprints agree: for each held request, the mod's `tool.start` for the same tool in the same session, with both fps and both summaries. Every line of the log has the token scrubbed out.
6. **Stop it** with Ctrl-C. Held requests get `{}`, no decision, so the app's dialogs decide, and open polls get no commands.

What to look for: a hello with `v: 1`; events with rising `seq`; `match: true` in every `fp-check`; held requests released by rule 1 when answered in the app; a prompt going `waiting` then `done`; a mode raise allowed with no card in the app; and nothing at all from sessions without the plugin.

## Ladder step 5: the real deck plugin against fake-claude

The deck plugin runs, linked and in developer mode, and someone is at the deck.

```sh
mise exec -- node claude-code/tools/fake-claude.mjs --interactive auth hello status approve deny two-held mode-not-ours needs-you answered-in-app
```

`--url` defaults to `http://127.0.0.1:47600`; the S6 deck listens on 47601 until it moves. The token defaults to the deck's own, `claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token`.

fake-claude sends each fixture's plugin lines as the hook and the mod would, and checks the deck's answers itself. The person does the rest:
- At a `PRESS:` line, press what it says on the deck. It waits up to 300 s for the deck's answer (`--press-timeout`), or for Enter when no answer follows.
- At a `CHECK on the deck:` line, look at the deck, then press Enter, or type what you see and Enter. What you type is listed at the end.

Before starting, make sure no real session is waiting for approval: Approve acts on the oldest held request, whosever it is. Then read the deck plugin's log, `claude-code/deck/com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log`.

What doesn't carry over from the fixtures:
- **Registry lines are skipped.** The deck reads the real registry, which nothing here writes, so it doesn't list the fixtures' sessions (`local_test-a`, `local_test-b`) on the Sessions dial; they reach it only through the bridge. Checks on `sessions` and `status` can differ for that reason. A reply that waits on a registry change is skipped and reported: `p1` in `answered-in-app-registry` and in `session-gone`.
- **Saved Prompt and Mode presses** need the fixture's session as the target. If the deck lists only registry sessions, `prompt`, `prompt-refused` and `mode-raise` can't be completed: leave them out, or stop with Ctrl-C.
- **Each play is a new mod instance.** The deck isn't reset between fixtures, and each fixture's event `seq` starts at 1 again, so fake-claude gives each play a fresh `inst` (`ia-x7k2q9`) in place of the fixture's. Otherwise a correct deck would drop the replay's events as retries.
- **A press on a question jumps** to `claude://code/continue?session=local_test-a`, an id the app doesn't know, so it lands on the Code home.

## Checking the tools themselves

`--against-fake` plays the fixtures against a fake bridge whose registry and records folders are empty folders of its own:

```sh
D=$(mktemp -d); mkdir $D/registry $D/records; openssl rand -hex 32 > $D/token
mise exec -- node claude-code/tools/fake-bridge.mjs --port 0 --token-file $D/token \
  --registry-dir $D/registry --records-dir $D/records --run-dir $D/run --quiet &
# it prints "fake bridge on http://127.0.0.1:<port>"
mise exec -- node claude-code/tools/fake-claude.mjs --against-fake --url http://127.0.0.1:<port> --token-file $D/token
```

Presses go to the fake bridge's control routes, and the fixtures' registry and records files are written into its folders and removed afterwards. fake-claude refuses to write into anything under `~/.claude/` or `~/Library/Application Support/Claude/`, so this can't run against a fake bridge reading the real folders. One failure ends that fixture, with the line and the reason. `--verbose` prints every line as it plays.

## The fake bridge's control routes

On the same server, checked like every route: the Host first, then the token.

| Route | Does |
|---|---|
| `GET /control/state` | `deck`, the view in the fixtures' `expect` shape (`sessions`, `held`, `status`, `doing`, `context`, `settings`, `cmds`, `jumped`, `alert`, and `target`), plus sessions, commands, registry, records, recent requests, the last press, the folders and the run folder. |
| `GET /control/taken` | How many protocol requests it has taken since the last reset. fake-claude waits on it so a held request has landed before the next line. |
| `POST /control/approve`, `/control/deny` | A key press on the oldest held request. `{"shown": "p3"}` presses as a key that showed p3: anything else held alerts. |
| `POST /control/answer` | `{"id", "decision": "allow" \| "deny" \| "none"}` for one held request. |
| `POST /control/prompt`, `/control/mode` | `{"host", "text"}` or `{"host", "mode"}`: queues a command, or alerts. |
| `POST /control/rescan` | Reads the registry and records now. |
| `POST /control/reset` | Forgets everything: held requests get `{}`, open polls no commands. Command ids keep counting. |

## Where PROTOCOL.md left room

The fake bridge takes these readings. Each is meant to surprise the real deck least.
- **Release rule 2's "held from before that change"** is judged by what the bridge saw: the request was held when a registry reading showed `waiting`. The fixtures' times are made up (T0 is 2026-11-02 06:13:20 UTC), so comparing an arrival with `statusUpdatedAt` would pass or fail by the date. Rule 3 compares them as written; no fixture holds a request while its session reads idle.
- **An expected `{}` for a permission request means no decision.** By the general rule an empty object matches any answer, an Allow included.
- **An answer to a permission request must be one of PROTOCOL.md's three, whatever its reply line expects.** The general rule lets extra fields through, and Claude Code acts on some of them. So fake-claude fails an answer with `updatedPermissions` or `updatedInput` anywhere in it, which the deck never sends. It also fails one with any of Claude Code's own top-level fields (`continue`, `stopReason`, `decision`, `reason`, `systemMessage`, `suppressOutput`), or a `hookSpecificOutput` that isn't exactly Allow's or Deny's. Any other top-level field is one Claude Code doesn't know, which PROTOCOL.md lets either side add.
- **A delivered command with no result yet** shows as `delivered` in `cmds`. A new `inst` fails the old one's in-flight commands with "the mod restarted before its result".
- **A mode command allows one request,** the one it raised; another like it is an ordinary request.
- **Prompt and mode presses alert** for a session the registry doesn't list, or whose mod has never spoken to the bridge.
- **An `X-Deck-Host` that starts with `$`** is a variable Claude Code didn't fill in, so it counts as missing.
- **A wait outside 0–20 s** is clamped, a poll that names no session it can place gets 400, and a POST body that's JSON but not an object gets 400.
- **The token is scrubbed from a body before it's read,** as the deck does, so a request whose input holds the token gets another fp than the mod's, and is released by the other rules.
