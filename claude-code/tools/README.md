# Claude Code tools

Tools for testing the two Claude Code side plugins against fakes, ladder steps 4 and 5 in `docs/claude-code/plan.md`, for Phase 4 on the hardware, and for re-checking the app after an update. They speak the bridge protocol in `claude-code/protocol/PROTOCOL.md` (version 1) and play its fixtures. Plain Node 24 ESM with no dependencies, so nothing needs installing. Run node through `mise exec --`: the shell's bare `node` is 22.

| File | What |
|---|---|
| `fake-bridge.mjs` | The deck plugin's side of the protocol, without the deck: a fake deck to run the real Claude Code plugin against (step 4). Also the CLI for its control routes. |
| `fake-claude.mjs` | Plays the plugin side of the fixtures against a bridge, standing in for Claude Code's hooks and the mod at once: `--against-fake` or `--interactive` (step 5). |
| `recheck.mjs` | After a Claude app update: whether the undocumented internals the deck and the plugin rely on still hold (Phase 6). Read only. |
| `lib/protocol.mjs` | The protocol's constants and answers, which routes are Claude Code's and which the mod's, and its fingerprint and summary: the reference implementation's own, imported from `claude-code/protocol/make-fixtures.mjs`. |
| `lib/fixtures.mjs` | Reads and checks the fixtures and `vectors.json`. |
| `lib/match.mjs` | PROTOCOL.md's matching rules: partial objects, `*`, arrays, query parameters, `at` ignored, and binding of command ids and insts. |
| `lib/deck.mjs` | The fake deck's logic: which sessions it takes the hooks' requests from, kinds, held requests, mode checks, release rules, commands, long polls, insts, sessions and statuses. No I/O. |
| `lib/bridge.mjs` | The fake bridge's HTTP side, its folder readings, the second reading a request can need, and its log. |
| `lib/registry.mjs` | Reads the session registry and the app's records, read only. |
| `lib/client.mjs` | An HTTP client that sends requests exactly as a fixture says, and the control client. |
| `lib/play.mjs` | Plays one fixture by the deck side's rules in PROTOCOL.md. |
| `lib/drivers.mjs` | What happens to press, registry and expect lines: through the fake bridge, or by a person at the deck. |
| `test/` | The self-tests. |

## Self-tests

```sh
mise exec -- node --test claude-code/tools/test/
```

They play every fixture end to end, fake-claude against the fake bridge on port 0 with temp registry and records folders, and test the pieces on their own. They bind port 0 only, never 47600 or 47601, and never read or write anything in `~/.claude/` or the app's folders: every child process gets a temp `HOME`. Every bridge they start gets a token file of its own, so they don't need the spike bridge's, which git ignores.

Node 24 takes `node --test`'s arguments as glob patterns, so a folder is run as one module. `test/package.json` points that module at `test/all.mjs`, which imports every `*.test.mjs`. `node --test claude-code/tools/test/*.test.mjs` runs the same tests, a process per file.

## Ladder step 4: the real plugin against the fake bridge

The main thread runs this, with a throwaway session it started from the `deck-sandbox` preset, once `claude-code/sandbox-plugin` points at `claude-code/plugin/`.

1. **Free port 47600.** The plugin's hooks and mod call `http://127.0.0.1:47600`, which the spike bridge holds now and the deck plugin later. Only one of them runs at a time. From Phase 5 the plugin is in every desktop session, and all of them call that port: the fake bridge answers 401 to any request without its token, which a hook takes as no decision, so only sessions whose `DECK_TOKEN` is the fake bridge's token reach it.
2. **Start the fake bridge:**

   ```sh
   mise exec -- node claude-code/tools/fake-bridge.mjs
   ```

   With no options it listens on 127.0.0.1:47600 and reads its token from `spikes/cc-bridge/run/token`, the spike bridge's, which the preset's `DECK_TOKEN` holds. It reads the real registry (`~/.claude/sessions/*.json`, never the `.key` files) and the app's records, only ever reading them. It takes a permission request or a mode check only from a session that registry lists under the request's `X-Deck-Host`, with the request's `session_id`, and answers any other `{}` at once: a terminal session's, a `claude` started inside a desktop session, a pre-warmed spare's. It logs to `claude-code/tools/run/<YYYYMMDD-HHMMSS>-fake-bridge/`, which git ignores. Stdout gets a line for each hello, held request, release, press, command and registry change.
3. **Give the session prompts** that make it read, write (an approval in Manual mode), ask a question, and so on.
4. **Act as the keys,** from another terminal. Each command prints the answer as JSON, exits 1 when the press alerted or the call failed, and exits 2 for a usage error before it reads any token:

   ```sh
   T=claude-code/tools/fake-bridge.mjs
   mise exec -- node $T state                       # what the deck would show, and everything behind it
   mise exec -- node $T approve p3                  # the Approve key showing p3: Allow, if p3 is the oldest held request
   mise exec -- node $T deny p3                     # the Deny key showing p3: Deny, which stops the turn
   mise exec -- node $T approve                     # the same with no id: whatever is oldest by then
   mise exec -- node $T answer p3 none              # releases tool request p3 with no decision: the app's dialog decides
   mise exec -- node $T prompt local_… "List the files here."
   mise exec -- node $T mode local_… acceptEdits    # its mode check, and the raise's own PermissionRequest, are allowed at once
   ```

   Take the ids from `state`. With an id, `approve` and `deny` press as a key that showed that request (S6): when another held request is older, the press alerts and answers nothing, so a press can't land on a request that arrived since you looked. `answer` takes `tool` requests only: an ask request (AskUserQuestion, ExitPlanMode) is refused, since the deck never answers one, and a press on one jumps to its session instead.

   A held request stays held until a command answers it or a release rule ends it: the fake bridge has no timeout of its own. `prompt` and `mode` alert for a session the registry doesn't list or whose mod hasn't spoken to the bridge, so they reach only sessions with the plugin. Only send them to a session the main thread started.

   `prompt` is a Saved Prompt key whose text is the one you give, as PROTOCOL.md's "Commands" has the key: while the last prompt that text queued is still queued, delivered or waiting, another `prompt` with the same text alerts and queues nothing, whatever the session. One that no poll takes within 60 s fails with "not delivered", and a final result, or a reset, frees the key.
5. **Read the log** in the run folder, alongside the session's transcript:

   ```sh
   cd claude-code/tools/run/<the run>
   jq -c 'select(.kind == "fp-check") | {request, tool, match, unpaired, why, doubt, bridgeFp, modFp, bridgeSummary, modSummary, calls}' events.jsonl
   jq -c 'select(.kind == "held" or .kind == "release" or .kind == "answered") | {kind, id, tool, summary, rule, why, decision, by}' events.jsonl
   jq -c 'select(.kind == "command" or .kind == "result-ignored")' events.jsonl
   jq -c 'select(.kind == "mode-check" or .kind == "mode-allowed" or .kind == "unconfirmed") | {kind, route, host, sid, tool, mode, allowed, cmd, why}' events.jsonl
   jq -c 'select(.kind == "poll-turn-end" or .kind == "poll-at-once" or .kind == "poll-superseded" or .kind == "poll-stale" or .kind == "poll-cut")' events.jsonl
   jq -c 'select(.kind == "poll-turn-end" or .kind == "poll-at-once" or (.kind == "request" and .path == "/v1/next") or (.kind == "registry" and .change == "changed")) | {t, kind, host, poll, by, cmds, sinceTurnEndMs, query, to: .to.status}' events.jsonl
   jq -c 'select(.kind == "hello" or .kind == "mod-restart")' events.jsonl
   jq -c 'select(.kind == "request") | {n, method, path, auth}' events.jsonl
   jq -c 'select(.kind == "route-error" or .kind == "control-error" or .kind == "client-error" or .unlogged)' events.jsonl
   ```

   `fp-check` is PROTOCOL.md's check that both sides' fingerprints agree, one line for each held request, with both fps and both summaries:
   - `match: true`: the mod's `tool.start` for a call under way in the same session, with the request's tool and fp, logged as soon as both have come, in either order.
   - `match: false`: none had its fp by the time the request ended, and it could pair only one way: one call of its tool was under way while it was held and paired with nothing, no other request of that tool waited beside it unpaired, the mod didn't restart meanwhile, and no `tool.end` with its fp released it. The fps truly differ.
   - `unpaired: true`, with `match: null`, the `calls` it could have been and the `doubt` that stopped it choosing: none had its fp, and it can't tell which call was its own, or no call of its tool came.

   A request with no `tool.start` of its fp waits for one for as long as it's held: parallel calls of a tool can send theirs in any order, an older inst's events still count after the mod restarts, and a background subagent's call can outlast the main loop's turn. So `match: false` and `unpaired` lines come only when the request ends, and `why` says how: answered, released by a rule (its session's end included), its client gone, or the bridge reset. Every line of the log has the token, and any run of 8 or more of its characters, scrubbed out. A request a route threw on gets 500 and a `route-error` line, and the bridge carries on; a line whose body can't be written, nested too deep, keeps its other fields and says why in `unlogged`.
6. **Stop it** with Ctrl-C. Held requests get `{}`, no decision, so the app's dialogs decide, and open polls get no commands.

What to look for: a hello with `v: 1`; events with rising `seq`; `match: true` in every `fp-check`, and for an `unpaired` one, whether one of its `calls` has its summary but another fp; held requests released by rule 1 when answered in the app; a `poll-turn-end` at each main-loop turn's end that found a poll open (a failed turn can give two, one for its `failed` and one for its `turn.end`), then the mod's polls about a second apart, each answered at once with a `poll-at-once` line while the registry still says `busy`, and the registry going `idle` within a second or so of the turn's end, not up to 20 s later, after which the next poll is held as usual (the `jq` line that selects `poll-turn-end`, `poll-at-once`, `/v1/next` and registry changes shows them in order; `poll-at-once` lines running to a `sinceTurnEndMs` near 60000 mean the registry stayed `busy` all that minute); a prompt going `waiting` then `done`; a mode raise allowed with no card in the app, a `mode-check` line with `allowed: true` before its `mode-allowed`; a change from Auto `done` with its `mode-check` allowed and no PermissionRequest at all; an `unconfirmed` line for each hook request from a process that isn't a desktop session of its own, a `claude` run by the session's Bash tool say, and none for the session's own; no `hello` with `status: 409` from the session itself; and nothing at all from sessions without the plugin.

## Ladder step 5: the real deck plugin against fake-claude

The deck plugin runs, linked and in developer mode, and someone is at the deck.

```sh
mise exec -- node claude-code/tools/fake-claude.mjs --interactive auth hello status needs-you answered-in-app not-desktop
```

`--url` defaults to `http://127.0.0.1:47600`; the S6 deck listens on 47601 until it moves. The token defaults to the deck's own, `claude-code/deck/com.karimdhanji.claude.sdPlugin/run/token`.

fake-claude sends each fixture's plugin lines as Claude Code's hooks and the mod would, and checks the deck's answers itself. The person does the rest:
- At a `PRESS:` line, press what it says on the deck. It waits up to 300 s for the deck's answer (`--press-timeout`), or for Enter when no answer follows.
- At a `CHECK on the deck:` line, look at the deck, then press Enter, or type what you see and Enter. What you type is listed at the end.

Before starting, make sure no real session is waiting for approval: Approve acts on the oldest held request, whosever it is. Then read the deck plugin's log, `claude-code/deck/com.karimdhanji.claude.sdPlugin/logs/com.karimdhanji.claude.0.log`.

What doesn't carry over from the fixtures:
- **Registry lines are skipped.** The deck reads the real registry, which nothing here writes, so it doesn't list the fixtures' sessions (`local_test-a`, `local_test-b`) on the Sessions dial; they reach it only through the bridge. Checks on `sessions` and `status` can differ for that reason. A reply that waits on a registry change is skipped and reported: `p1` in `answered-in-app-registry` and in `session-gone`. So is a reply to a poll the deck answers at once only because the fixture's registry says `busy` after the main loop's turn ended, `n2` in `status`, `approve` and `prompt-refused`: no registry the deck reads says so, so it holds that poll.
- **The hooks' requests get no decision** (PROTOCOL.md, "Desktop sessions only"). The deck takes a permission request or a mode check only from a session its registry confirms, and no registry it reads lists the fixtures' sessions, so it answers each `{}` at once, and holds none. fake-claude checks a reply that expects `{}` as usual. One that expects a decision, whose answer was `{}` when fake-claude went on, is skipped and reported, and so is an Approve or Deny press with nothing fake-claude sent held, so you're never asked to press on another session's request. So `approve`, `deny`, `two-held`, `mode-not-ours`, `mode-raise` and `mode-from-auto` can't show a decision from such a deck: approvals and mode checks are for the tests on throwaway sessions.
- **A hello's 409** needs the registry to list its host under another session id: `h1` in `not-desktop`. The deck takes that hello instead, and its reply is skipped and reported.
- **Saved Prompt and Mode presses** need the fixture's session as the target. If the deck lists only registry sessions, `prompt`, `prompt-refused`, `mode-raise`, `mode-from-auto` and `stray-instance` can't be completed: leave them out, or stop with Ctrl-C.
- **Each play is a new mod instance.** The deck isn't reset between fixtures, and each fixture's event `seq` starts at 1 again, so fake-claude gives each play a fresh `inst` (`ia-x7k2q9`) in place of the fixture's, in the mod's requests. Otherwise a correct deck would drop the replay's events as retries. Claude Code's requests, the hooks', are sent as they are.
- **A press on a question jumps** to `claude://code/continue?session=local_test-a`, an id the app doesn't know, so it lands on the Code home.

fake-claude's line for each fixture counts what it skipped: `2 reply(s) skipped, 1 press(es) skipped`.

## Checking the tools themselves

`--against-fake` plays the fixtures against a fake bridge whose registry and records folders are empty folders of its own:

```sh
D=$(mktemp -d); mkdir $D/registry $D/records; openssl rand -hex 32 > $D/token
mise exec -- node claude-code/tools/fake-bridge.mjs --port 0 --token-file $D/token \
  --registry-dir $D/registry --records-dir $D/records --run-dir $D/run --quiet &
# it prints "fake bridge on http://127.0.0.1:<port>"
mise exec -- node claude-code/tools/fake-claude.mjs --against-fake --url http://127.0.0.1:<port> --token-file $D/token
```

Presses go to the fake bridge's control routes, and the fixtures' registry and records files are written into its folders and removed afterwards. fake-claude refuses to write into anything under `~/.claude/` or `~/Library/Application Support/Claude/`, so this can't run against a fake bridge reading the real folders. It protects both homes, `$HOME`'s and the account's own (which a `$HOME` pointed elsewhere doesn't move), and compares every folder it writes into by its real path as the system gives it, links followed and, on the Mac's case-insensitive volume, each name in its case on disk. The Mac firmlinks `/Users` and `/private` into the Data volume, so a folder named through `/System/Volumes/Data` has a second real path, which realpath keeps: paths are compared with that prefix taken off. It also refuses a registry or records folder that holds JSON files it didn't write. One failure ends that fixture, with the line and the reason. `--verbose` prints every line as it plays.

## After a Claude app update: recheck.mjs

```sh
mise exec -- node claude-code/tools/recheck.mjs          # a table
mise exec -- node claude-code/tools/recheck.mjs --json   # the same, for machines
```

It re-checks what the plan's Log found in S0–S5 and the deck relies on, one row per check: `ok`, `warn` or `fail`, with a reason. It exits 0 when no check fails and 1 when one does (2 for a usage error).
- **Versions:** the app's, and the Claude Code versions it bundles. It warns when the newest isn't 2.1.309, the one `claude-code/vendor/mods-api-2.1.309/` and these checks are for.
- **The registry:** each field the deck reads, by type, over the running sessions.
- **The app's records:** the same, and whether each running session's record is found by its host, as the deck finds it.
- **app.asar:** the jump route, the needs-input route, the `local_` id pattern and the mode tool.
- **The mods API:** the newest bundled Claude Code's `plugin validate` and `plugin test` on `claude-code/plugin` as committed at HEAD, in a fresh temp config. It takes about 5 s, and `--skip-plugin` leaves it out.

It's read only. It never opens the registry's `.key` files or a transcript, never reads the deck's token, and prints field names and counts, never a value from the registry or the records. The bundle checks find strings, not behaviour: after an update, still try one jump and one mode change on the deck.

## The fake bridge's control routes

On the same server, checked like every route: the Host first, then the token. Their answers are scrubbed of the token and of any run of 8 or more of its characters, like the log: the registry's and records' fields come from files the token can be in, a session's title say.

| Route | Does |
|---|---|
| `GET /control/state` | `deck`, the view in the fixtures' `expect` shape (`sessions`, `held`, `status`, `doing`, `context`, `settings`, `cmds`, `jumped`, `alert`, and `target`), plus sessions (each with its current `inst` and the `insts` that said hello), commands, registry, records, recent requests, the last press, the folders and the run folder. |
| `GET /control/taken` | How many protocol requests it has taken since the last reset: answered or held, after any second reading of the registry a request needed. fake-claude waits on it so a held request has landed before the next line. |
| `POST /control/approve`, `/control/deny` | A key press on the oldest held request. `{"shown": "p3"}` presses as a key that showed p3: anything else held alerts. |
| `POST /control/answer` | `{"id", "decision": "allow" \| "deny" \| "none"}` for one held `tool` request. An ask request gets 400: the deck never answers one. |
| `POST /control/prompt`, `/control/mode` | `{"host", "text"}` or `{"host", "mode"}`: queues a command, or alerts. A prompt is the Saved Prompt key with that text, which alerts while its last prompt is still queued, delivered or waiting. A mode command's mode check, and the PermissionRequest its raise brings, are each allowed once while it's in flight. |
| `POST /control/rescan` | Reads the registry and records now. |
| `POST /control/reset` | Forgets everything: held requests get `{}`, and open polls are cut off with no answer, so their mods say hello again (below). Command ids keep counting. |

## Where PROTOCOL.md leaves room

The fake bridge takes these readings. Each is meant to surprise the real deck least.
- **A hook's request is taken only from a confirmed session** ("Desktop sessions only"): one the registry lists under its `X-Deck-Host`, a host by the pattern, with a `sessionId` equal to its `session_id`. It's the pair that confirms: a host the registry lists under another session, with a session id it lists under another host, or a host it doesn't list with a listed session id, confirms nothing. When the latest reading doesn't confirm a request that names a host and a session id, the bridge reads the registry once more, and counts the request as taken only once it's held or answered. A request still not confirmed, or one without a host or a session id, gets `{}` at once, with an `unconfirmed` line saying why, and changes nothing: no session is made of it, no sid pair kept, and no mode or effort taken. A registry entry with no `sessionId` confirms nothing.
- **A hello from a host the registry lists under another `sessionId`** gets 409 `{"error": "not this session"}`, with a `hello` line whose `status` is 409, and nothing of it is kept: no inst, no restart, no sid pair, no settings. A hello with no sid counts as another session's; an entry with no `sessionId` refuses nothing. Before a 409 the bridge reads the registry once more, as for a hook's request, so a session whose sid has just changed, after a `/clear` say, isn't refused on a reading made before: PROTOCOL.md asks for the second reading only for hooks. A hello from a host the registry doesn't list, as a spare's, is taken: the session has the plugin, but stays out of `sessions`, and `prompt` and `mode` to it alert, until the registry lists it.
- **A mode check** is answered at once and never held. From a confirmed session, it's allowed when the session has a mode command in flight (delivered, or after a stray `waiting`) for the mode the call asks, for `self`: the first such check per command only, with a `mode-check` line. That allowance is counted apart from kind mode's, so one command gets one of each, in either order. Every other check gets `{}`, with a `mode-check` line saying why. A check's `permission_mode` and `effort` aren't taken: the deck shows the session's PermissionRequests', and a mode check isn't one.
- **Release rules 2 and 3 and status rule 3 are judged by what the bridge saw,** as PROTOCOL.md lets a fake bridge, and `statusUpdatedAt` is never compared with an arrival. Release rule 2's "held from before that change": the request was held when a registry reading showed `waiting`. Release rule 3: a reading shows the session `idle`, and the reading before showed it otherwise, so the bridge saw the change after every request it holds then arrived. A request is held only for a session the registry listed as it came, so the reading that releases it is never the session's first. Status rule 3: a `busy` began before the main loop's turn ended with `aborted` when the reading where the session's `status` or `statusUpdatedAt` last changed, or its first reading, came before the bridge got that `turn.end`. So a rewritten `statusUpdatedAt` is a new `busy`, as it would be by the times, and a new `name` or a missing `statusUpdatedAt` isn't. A `busy` the bridge first reads after the `turn.end` counts, though Claude Code may have written it before: run live with its 1 s scan, an Esc within a second of a turn's start can read `working` for as long as the registry stays `busy`. `GET /control/state` shows each session's `turn.endSeen` and `statusSeen`, to compare. The fixtures' times are made up (T0 is 2026-11-02 06:13:20 UTC), and fake-claude doesn't give the bridge their clock, so comparing an arrival with `statusUpdatedAt` would pass or fail by the date.
- **An answer to a hook's request must be one PROTOCOL.md allows, whatever its reply line expects,** since an expected `{}` is no decision. "Transport" settles the rest: a 2xx answer, the one Claude Code parses, is exactly Allow, Deny or `{}` for a permission request, and exactly the allow or `{}` for a mode check. fake-claude fails one with any field of its own, at the top or inside `hookSpecificOutput`, naming `updatedPermissions`, `updatedInput` and Claude Code's own top-level fields (`continue`, `stopReason`, `decision`, `reason`, `systemMessage`, `suppressOutput`) when it's one of them, and a mode check's deny or ask. A mode check's answer is checked as soon as it comes, whether or not a reply line checks it. Any other status carries `{"error": "<reason>"}` exactly: auth's `GET /v1/permission` expects a 405 with one. "Matching" still says every answer must be one of the route's bodies; fake-claude holds 2xx answers to that, as "Transport" does.
- **The clock of a waiting prompt** is its session's time without an open poll, from when its last poll was answered, timed out or closed, on the bridge's monotonic clock. A poll answered at once, because commands were queued or `wait` was 0, shows the mod is there, so the 60 s start again from its answer. A poll from an inst that isn't current doesn't: it's no sign of the current instance, whose prompt it is. A queued command has 60 s from when it was queued for a poll to take it, and a delivered one 60 s from its delivery for a result.
- **The main loop's turn end answers the open poll** with no commands, as "Commands" says: every `turn.end` or `failed` without `agent` (one that isn't a non-empty string), whatever its reason or turn id. So a failed turn's own `turn.end`, after its `failed`, answers the poll the mod opened since, if one is open. With no poll open there's nothing to answer, and a `turn.end` in a request dropped as a retry does nothing at all. A poll answered so counts as answered for a waiting prompt's clock, and the log has a `poll-turn-end` line for it.
- **Then a poll is answered at once** while all of these hold as it arrives: the main loop's turn ended as above, no main-loop `turn.start` came since, that end came less than 60 s ago by the bridge's monotonic clock, as the deck's (the wall clock plays no part, so neither a time sync nor a runner's clock that follows the registry's times moves the 60 s), and the bridge's latest registry reading says the session is `busy`. So each `turn.end` or `failed` starts the 60 s again, and "until the registry stops saying busy" is read reading by reading: a session the registry doesn't list, or lists as `idle` or `waiting`, has its polls held as usual, and a later `busy`, before a `turn.start` and within the 60 s, has them answered at once again. A poll already held when a reading turns `busy` in that time is answered with no commands then, with a `poll-turn-end` line whose `by` is `busy`: after a turn shorter than a scan, or a Deny with the reading still `waiting`, the poll came before the reading said `busy`. Such a poll takes the commands queued for the session, oldest first, counts as answered for a waiting prompt's clock like any poll answered at once, and gets a `poll-at-once` line with the ids of the commands it took and `sinceTurnEndMs`.
- **The host fallback,** for a mod's request, looks its sid up in the registry, then among every sid and host pair the bridge has seen from mods, so a session's earlier sid still places a mod's request after its sid changed. It never places a hook's request, and a hook's `session_id` is never a pair.
- **Only a hello makes an inst current:** a hello from an inst that hasn't said hello for the session before. With another current, that's the mod restarting: it fails the delivered and waiting commands with "the mod restarted", and answers the open poll, the old instance's, with no commands. The bridge remembers every inst that said hello, at least the last 8 PROTOCOL.md asks for, and a hello from one of them is answered, and its fields taken, but changes nothing else. Any other inst doesn't count, one that said hello before or never did, a poll's missing one included: its events and results are still taken, and its main loop's `turn.end` or `failed` answers the open poll, the current instance's, and has the polls after it answered at once, since the session's turn has ended whichever instance says so. Its polls are answered at once with no commands, with a `poll-stale` line, and leave the current instance's open poll alone. Before any hello, as after a deck restart, every poll is answered so.
- **A reset is a deck restart with the bridge still listening.** It forgets every inst that said hello, so a session's mod counts again only once it says hello again, and the plugin's mod does that only after a request of its own fails. So the reset cuts each open poll off with no answer, as a deck that restarts drops it, with a `poll-cut` line: the mod's fetch fails, and its hello follows about 100 ms later. Answered with no commands, the poll would go through, and the mod would poll on with its polls answered at once, never to get a command. A mod with no poll open at the reset, waiting out its second after a poll answered at once (from a main-loop turn end while the registry says `busy`), isn't told: its polls are answered at once with no commands until it reloads. The real deck is in the same place after a restart, since PROTOCOL.md gives a deck no way to ask for a hello. Shutting down, the bridge answers open polls with no commands instead: nothing serves the mod's next request.
- **A result is taken only from the inst its command was delivered to:** one from another inst is ignored with a `result-ignored` line, and so is one with no inst, which can't be from that inst.
- **Rule 4's `failed` holds for the turn it ended,** as the real deck reads it: a main-loop `turn.end` for another turn, whose `turn.start` was lost, reads done. One it can't tell apart, with no turn id on one side or the other, keeps it.
- **Rule 6 reads a record as the app's loader leaves it:** `postTurnSummaryFor` and `lastAssistantUuid` count only as strings, so two equal numbers don't make a record count, and a valid wrap-up's `needsUser` counts whenever it's there, an empty one included, as the app's `Dw` reads it. The summary's `status_category` is read from any `postTurnSummary` object, though the app's loader drops a summary with a text field that isn't a string: PROTOCOL.md doesn't say so, and nor does the fake.
- **A Saved Prompt key is known by its text,** since the fake bridge has no keys: `/control/prompt` with a text whose last prompt is still queued, delivered or waiting alerts and queues nothing, whatever session it names. Otherwise each press is a key of its own.
- **A mod's fields that PROTOCOL.md gives as strings are kept only as strings:** hello's `cwd`, `model`, `mode`, `effort`, `plugin` and `cc`, and a result's `error` and `detail`, are null otherwise; an event's `agent` that isn't a non-empty string counts as none, the main loop's, as "Events" says; and `seq`s are kept by an `inst` that's a string. Anything else could be nested too deep to write out, and stop every later state from answering. The lines people read show such a value, a refused hello's `v` or an unknown event type or result state, cut short, and name one nested too deep instead, so it can't fail its request: a 500 there would come back each time the mod resent it.
- **Rule 4's "forgets what the bridge knew of it"** drops all that came from the session's mod: its hello, settings, context, tools, insts and seqs. A later request from the mod starts afresh.
- **`/control/answer` answers `tool` requests only,** since the deck never answers an ask request.
- **A wait outside 0–20 s** is clamped, and a POST body that's JSON but not an object gets 400.
- **A request a route throws on** gets 500 `{"error"}`, which the hook takes as no decision, so the app's dialog decides. A tool_input nested too deep for `canonical()` does it, from a confirmed session. So does an answer that can't be written out: a control answer echoing a value nested too deep gets a plain 500 in its place. A request Node takes no further, one it can't parse, with headers over its limit or too slow to arrive, gets Node's status with `{"error"}` too, and a `client-error` line.
- **The token is scrubbed from a body before it's read,** as the deck does, and so is any run of 8 or more of its characters: the mod cuts a summary to 39 characters, so its `tool.start` can end in the token's first few. A request whose input holds the token gets another fp than the mod's, and is released by the other rules. The control routes' answers are scrubbed too, for what came from the folders.
