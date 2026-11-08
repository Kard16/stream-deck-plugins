# Bridge protocol, version 1

The wire protocol between the Claude Code plugin `streamdeck-bridge` (`claude-code/plugin/`), which runs inside Claude Code sessions in the Claude desktop app, and the Stream Deck plugin `com.karimdhanji.claude` (`claude-code/deck/`), which hosts the bridge. Frozen on 2026-11-01 from the Phase 1 results in `docs/claude-code/plan.md`, whose Log holds each finding cited here (S0–S6).

Changes go through the main thread. A change that breaks either side bumps `v`.

Contents: [Parties](#parties) · [Transport](#transport) · [Identity](#identity) · [Desktop sessions only](#desktop-sessions-only) · [Routes](#routes) · [Permission requests](#permission-requests) · [Held requests](#held-requests) · [Commands](#commands) · [Events](#events) · [Fingerprints and summaries](#fingerprints-and-summaries) · [The deck's session model](#the-decks-session-model) · [Failure and recovery](#failure-and-recovery) · [Rates](#rates) · [The plugin's hooks.json](#the-plugins-hooksjson) · [Fixtures](#fixtures) · [Amendments](#amendments)

## Parties

- **The permission hook:** an `http` PermissionRequest hook in the plugin's `hooks/hooks.json`. Claude Code posts the hook's input and waits for the answer, while the app shows its own dialog beside it. The first answer wins (S2).
- **The mod:** the plugin's `hooks/register.ts`, one instance per session, on the mods API of the app's Claude Code (2.1.317 since 2026-11-03; `claude-code/vendor/mods-api/` is its reference). It says hello, reports events, and fetches and runs the deck's commands.
- **The bridge:** the HTTP server inside the deck plugin.
- **The deck:** the rest of the deck plugin. It merges what the bridge hears with the session registry and the app's session records ([The deck's session model](#the-decks-session-model)).

Nothing else talks to the bridge, and the bridge never calls the plugin.

## Transport

- HTTP/1.1 on `127.0.0.1:47600`, IPv4 only. Clients use `127.0.0.1`, never `localhost` (S6).
- Every request carries:
  - `Host: 127.0.0.1:47600` or `localhost:47600`. Anything else gets 403, before the token is looked at. That stops a web page that rebinds a DNS name to 127.0.0.1.
  - `Authorization: Bearer <token>`. Missing or wrong: 401, with `WWW-Authenticate: Bearer realm="streamdeck"`.
- **The token** is the trimmed content of the deck plugin's `com.karimdhanji.claude.sdPlugin/run/token`, which the deck creates on first start (file `0600`, folder `0700`). The plugin reads it from the environment variable `DECK_TOKEN`. The `deck-sandbox` preset sets it for throwaway sessions, and the `env` block of `~/.claude/settings.json` sets it for the user's own (Phase 5). In a desktop session the launch environment wins key by key, so a preset's value beats the settings' (the route research, 2026-11-03). Neither side ever logs it.
- **Nothing proves the bridge is the deck.** The hooks and the mod send the token to whatever listens on `127.0.0.1:47600`, and Claude Code takes the hook's answer as a decision. So a process holding the port while the deck is down could read the token and answer approvals. That's an accepted risk on the user's own Macs, where only the user logs in (Phase 8, 2026-11-06): any process that could hold the port could as well change `~/.claude/settings.json`.
- **The token scrub:** once the bridge has parsed a body, it takes the token out of every string in it, names included. The whole token, and every run of 8 or more characters that's also part of it, become `<token>`. So nothing the deck shows or logs can carry any of it.
- Bodies are JSON in UTF-8, at most 8 MiB (413 above). A body that isn't JSON gets 400, an unknown route 404, a wrong method 405. Error answers are `{"error": "<reason>"}`.
- Unknown fields are ignored on both sides, so either side can add fields without a version bump. Answers to `/v1/permission` are the exception: Claude Code reads them, and a 2xx answer is exactly one of the bodies in [Permission requests](#permission-requests). Any other status carries `{"error": "<reason>"}`, like every error answer.
- No CORS headers.

## Identity

- **`sid`:** Claude Code's session id, a UUID. The mod reads it with `$.session.id()`; the hook's body has it as `session_id`. It can change during a session's life (the app's records keep `priorCliSessionIds`), so the deck doesn't key on it.
- **`host`:** the app's `local_…` id, fixed for the session's life, and what the jump link `claude://code/continue?session=<host>` takes (S5). The mod reads `CLAUDE_CODE_HOST_SESSION_ID` with `$.env.get`; the hook sends it in the header `X-Deck-Host`. A value that doesn't match `^local_[A-Za-z0-9-]{1,64}$` counts as missing, such as an empty one or a `$CLAUDE_CODE_HOST_SESSION_ID` that Claude Code didn't fill in. For a mod's request, the bridge then looks `sid` up in the registry, and then among the `sid` and `host` pairs it has seen from mods. A mod request it still can't place gets 400. The hooks' requests are placed only as [Desktop sessions only](#desktop-sessions-only) says.
- **`inst`:** a random id the mod picks each time it loads, hot reloads included. **Only a hello makes an `inst` the session's current one.**
  - **A hello from an `inst` the deck hasn't had a hello from for that `host`, while another is current,** means the mod restarted. The deck then forgets that session's current tool and fails its `delivered` and `waiting` commands with "the mod restarted". It keeps the rest, queued commands included. If the old instance left a poll open, the deck answers it with `{"cmds": []}`, so commands queued from then on wait for the new instance.
  - **While one is current, any other `inst` doesn't count:** a replaced one, which the deck has had a hello from before, or one that hasn't said hello to this deck. Its events and results are still taken. Its polls are answered at once with `{"cmds": []}`: they never displace the current instance's poll and never receive commands. A replaced one's hello is answered `ok` but changes nothing, its `model`, `mode` and `effort` included; a hello from one that hasn't said hello before is a restart, as above.
  - **The current instance's hello, said again,** as after a rejected fetch or in an outage, is answered `ok` and takes its `cwd` and `model`, and nothing else changes. Its `mode` and `effort` are what the mod has already sent the deck, or queued to send, as `settings`, while the deck may since have taken a newer one from a PermissionRequest. So the deck keeps its own.
  - **A session with no current instance asks for one.** Until an `inst` says hello for a `host`, the deck answers every poll for that `host` at once with 409 `{"error": "hello first"}`. That happens after the deck restarts, after it forgets the session at release rule 4, and once the current instance stops polling (below). The mod takes the 409 as it takes a fetch that rejected: a quiet hello about 100 ms later ([Failure and recovery](#failure-and-recovery)).
  - **A current instance that stops polling stops counting.** Once it has gone 60 s with no poll open and none sent, counted from the later of its last poll's end and the hello that made it current, it's no longer current. The deck keeps the rest: settings, held requests, commands, the current tool, and which instances have said hello. Only polls count, as [Commands](#commands) counts them for a waiting prompt; a hello said again doesn't. The session then has no current instance: a prompt press on it alerts, while Approve and Deny still answer its held requests. Its mods' polls get 409 `hello first`.
  - **While a session has no current instance, any instance's hello makes it current,** one the deck has had a hello from before included. That isn't a restart: nothing is failed or forgotten. From then on the others don't count, as above.
  - The deck remembers at least the last 8 `inst`s per `host` that said hello.
  - **Why:**
    - Before 2026-11-03 any new `inst` counted. So after a deck restart, a replaced instance's late request could become the newest instance, and the live instance's polls were then answered at once for good (round 4's review).
    - A mod says hello when it loads and after a failed request ([Routes](#routes)), so a deck that restarts while the mod has a request open hears hello first. But after a poll answered within a second, as at every turn's end, the mod waits out the rest of that second with nothing open. A restart in that second fails nothing, and neither does a registry reading that misses the session. Without the 409, the mod's polls would then be answered at once for good, and the session would take no prompts until the mod reloaded (all three reviews of Phase 5's build).
    - The 409 goes only to a session with no current instance, so it never displaces one. A replaced instance can't answer it with a hello, since a reload drops the old environment's timers (the mods API's `reference.md`).
    - A deck that restarts while two live mods share a `host`, a restarted process and its predecessor still running, asks both for a hello, and makes current the one whose hello lands last. The mods can't say which process is newer: the mods API has no pid, and the app resumes a session under the same session id (`resume: cliSessionId`; only `--fork-session` makes a new one). If the predecessor's hello lands last, the live mod's polls are answered at once with none until the predecessor's mod has gone 60 s without one (round 2's review of Phase 5). Then the live mod's next poll gets 409, and its hello makes it current. The deck still remembers the predecessor's hello, so a later one from it, as after one of its fetches rejects, changes nothing. Forgetting it made that hello a restart over the live mod, which failed the live mod's commands for another minute (round 3's review of Phase 6).
- The deck keys sessions by `host`.

## Desktop sessions only

From Phase 5 the plugin is in `~/.claude/settings.json`, so every Claude Code process on this Mac that reads it loads the plugin (the route research, 2026-11-03):
- **Terminal and VS Code sessions, and `claude -p` runs,** with no host id.
- **A `claude` started inside a desktop session,** by its Bash tool, a hook or a script. It inherits the session's `CLAUDE_CODE_ENTRYPOINT` and host id, with `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION` set to `1`.
- **The side chats and recaps the app forks from a preset session.** They carry its host id and a `CLAUDE_CODE_TAGS`. Forks of the user's own sessions read no settings.
- **The app's pre-warmed spare processes.** They run the mod with the host id of the session they'll become, before one is claimed.

Only a desktop session of its own talks to the bridge.

- **The mod says nothing at all to the bridge, and logs that once,** unless all of these hold:
  - `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop` or `claude-desktop-3p`;
  - `CLAUDE_CODE_HOST_SESSION_ID` matches the host pattern;
  - `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_CODE_TAGS` are unset or empty;
  - `DECK_TOKEN` is set and not blank.

  A variable the mod can't read fails its test, and only the empty string counts as empty. That's the engine's own test for trusting a host id (`dp()` and `_M()` in 2.1.309), plus the forks' tags. A spare passes it: its mod talks as the session it will become, and the deck lists that session once the registry does.
- **The bridge takes a PermissionRequest only from a confirmed session.** Hooks can't be gated: `hooks.json` has no condition on the environment, and a hook's process always has `CLAUDECODE` set.
  - A confirmed session is one the registry lists under the request's `X-Deck-Host`, with a `sessionId` equal to the request's `session_id`.
  - If the deck's latest reading doesn't show that, it reads the registry once more.
  - A request still not confirmed gets `{}` at once, and nothing is held. The process's own permission flow decides.
- **A hello from a host the registry lists under another `sessionId` is refused,** with 409 `{"error": "not this session"}`, and so is a hello with no `sid` for a listed host. If the deck's latest reading doesn't list the host with the hello's `sid`, it reads the registry once more first, so a hello just after a `/clear` isn't refused on an old reading. A hello from a host the registry doesn't list yet, as from a spare, is taken, and the deck lists that session once the registry does.

## Routes

| Route | From | Does | Answer |
|---|---|---|---|
| `POST /v1/permission` | the hook | holds a PermissionRequest | 200, a decision or `{}` |
| `POST /v1/hello` | the mod | announces the mod | 200 `{"v": 1, "ok": true}` |
| `POST /v1/events` | the mod | reports events | 204 |
| `GET /v1/next` | the mod | fetches commands, long poll | 200 `{"cmds": [...]}`, or 409 `{"error": "hello first"}` |
| `POST /v1/result` | the mod | reports how a command went | 204 |

Every mod request names its session with `sid`, `host` and `inst`: in the body, or for `GET /v1/next` in the query. The bridge accepts every route from a session it hasn't had `hello` from, except that it answers polls with 409 `{"error": "hello first"}` until an instance has said hello for that session ([Identity](#identity)).

**`POST /v1/hello`** body: `{"v": 1, "sid", "host", "inst", "cwd", "model", "mode"?, "effort"?, "plugin", "cc"}`, where `model` is `$.session.model()`, `plugin` the plugin's version and `cc` Claude Code's (`"unknown"` if the mod can't read it). `mode` and `effort` are left out until the mod has seen them, `model` is left out if the mod can't read one, and `host` is `""` when the variable is unset (from plugin 0.2.0 the mod talks only with a valid one, [Desktop sessions only](#desktop-sessions-only)). The mod sends hello when it loads, before any other request, and waits for the answer. It sends it again when the bridge answers after a failed request, since the deck may have restarted, and after a rejected fetch ([Failure and recovery](#failure-and-recovery)). So a deck that restarts while a mod has a request open gets a hello before anything else from it, even one restarted within 100 ms. A mod with nothing open hears 409 `hello first` at its next poll ([Identity](#identity)). A deck on another version answers `{"v": <its own>, "ok": false, "error": "version"}`. The mod stops talking to the bridge until it reloads when a hello's answer has `ok: false` with `error: "version"`, or with a `v` other than 1, and logs that once.

## Permission requests

`POST /v1/permission`: the body is the hook's input as Claude Code sends it. The bridge reads `session_id`, `tool_name`, `tool_input`, `permission_mode`, `effort` and `agent_id`, and the header `X-Deck-Host`. There's no `tool_use_id` in it (S2).
- **`agent_id`** is there only when the request comes from another loop than the main one: a subagent's, a teammate's or a workflow agent's (the vendored d.ts, the hook input's base). It's the same id as that loop's `tool.call` `agentId`, which the mod sends as `agent`. The bridge keeps it as the request's `agent` when it's a non-empty string, else the request has none. Release rule 1 matches it ([Held requests](#held-requests)).

The bridge sorts each request into one kind:
- **ask:** `tool_name` is `AskUserQuestion` or `ExitPlanMode`. Claude Code needs the person for these: it ignores a plain Allow (the engine check, 2026-11-04). **The deck never answers one** (Phase 9, at the user's word). The Approve and Deny keys and the session's Session Slot dial read "Answer in app", and a press on any of them jumps to the session and answers nothing (kickoff answer 3). Held until released ([Held requests](#held-requests)).
- **tool:** everything else. Held until Approve or Deny, from the keys or the session's dial, or released ([Held requests](#held-requests)).

Answers, all 200:
- **Allow:** `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}`
- **Deny:** `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Denied from the Stream Deck.", "interrupt": true}}}`. The turn stops, as with the app's own No. Claude gets the standard rejection text, not the message (S2), but S2 verified this shape with a message, so it stays.
- **No decision:** `{}`. The app's dialog decides.

Every answer is exactly one of these three bodies. The deck never sends `updatedInput` or `updatedPermissions`, never adds another field inside `hookSpecificOutput`, and never sends Claude Code's own top-level hook fields (`continue`, `stopReason`, `decision`, `reason`, `systemMessage`, `suppressOutput`). Phase 7's Answer and Approve plan went in Phase 9: the user answers questions and plans in the app.

## Held requests

- A held request belongs to a session, and has its kind, `tool`, `summary`, `fp` ([Fingerprints and summaries](#fingerprints-and-summaries)) and `agent` ([Permission requests](#permission-requests)), and the time it arrived. The bridge holds any number, from any number of sessions.
- **Approve and Deny** act on the oldest held request across all sessions, and only on the one the key showed when pressed (S6). The request must have been on the key for 1 s, timed from its first paint, or from the key's last OK or alert if that came later. An earlier press alerts and answers nothing, so a double press can't answer a request nobody has seen. On a `tool` request, Approve answers Allow and Deny answers Deny. On an `ask` request, either press jumps to its session and answers nothing; the key reads "Answer in app", and the press shows the OK.
- **A Session Slot dial** acts on its own session's oldest held request. On a `tool` request it answers Allow or Deny. On an `ask` request it reads "Answer in app", and a press jumps to the session and answers nothing.
  - It answers only the request its strip showed when pressed, once that request has been on the strip for 1 s, timed from its first paint there, or from the strip's last alert or answer if that came later.
  - It sends only the chip its strip showed, once that chip has been on the strip for 300 ms. A turn just before a push can't send a choice nobody saw.
  - An earlier press alerts and answers nothing.
  - The keys and the dials answer the same requests, and the first answer wins: a press for a request that has gone alerts and answers nothing. Its strip moves on to the session's next request, or back to its pages. Until it shows a newer request, and for at most 1 s, a press on it alerts rather than jumping or answering. Once the strip shows the session's next request, a press acts on that one, under the rules above (`dial-next`).
- **The bridge keeps no request's `tool_input`** beyond the summary and fingerprint it makes from it. Phase 7 kept an `ask` request's, up to 64 KiB, for the dial's answers, which went in Phase 9.
- **Answering in the app doesn't end the hook's request** (S2), so the bridge releases a held request with `{}` at the first of:
  1. The mod reports `tool.end` with the same `fp`, from the same session and the same loop: the event's `agent` equals the request's, and a request with no `agent` (the main loop's) matches only an event with none. Each `tool.end` releases one request, the session's oldest that matches. Until Phase 9 the loop wasn't compared, so one agent's finished call could release another agent's identical request.
  2. The registry shows the session leaving `waiting`, and this is the session's only held request, held from before that change. That means it arrived before the new status's `statusUpdatedAt`, or, without that field, before the deck saw the change.
  3. The registry shows the session `idle`, with a `statusUpdatedAt` after the request arrived. Without that field, the deck must have seen the session go from another status to `idle` after the request arrived; a session's first reading doesn't count.
  4. No registry file lists the session's `host` any more ([The deck's session model](#the-decks-session-model)). The deck also fails the session's commands with "the session ended", answers its open poll with `{"cmds": []}`, and forgets what the bridge knew of it.
  5. The client closes the connection: the hook's 600 s timeout, or the session ended.
- Arrival times and `statusUpdatedAt` are both this Mac's wall clock.
- A press for a request that's gone does nothing, and the key shows an alert (S6).
- Nothing else answers a held request: the bridge has no timeout of its own and no default.

## Commands

The deck queues commands for a session when the user presses a key. The mod fetches them with a long poll.

**`GET /v1/next?sid=<sid>&host=<host>&inst=<inst>&wait=<s>`**
- With commands queued for that session, it answers them at once, oldest first.
- Otherwise it holds the request up to `wait` seconds (0–20, default 20; 0 answers at once) and answers as soon as a command is queued, or with `{"cmds": []}` when the time is up.
- **At the end of the main loop's turn,** a `turn.end` or `failed` without `agent`, it answers the session's open poll with `{"cmds": []}` at once. Then, until a main-loop `turn.start` comes or for 60 s, while its registry reading says `busy`:
  - **It answers each of the session's polls at once,** with the commands queued for it or none.
  - **When the reading turns `busy`, it answers the poll it holds** with `{"cmds": []}`. The deck's reading trails the registry ([The deck's session model](#the-decks-session-model)), so a poll can come before the reading says `busy`: after a shorter turn, or after a Deny while the reading still says `waiting`.
  - Why: Claude Code keeps a session `busy` in the registry until a moment after the turn when the mod has no request open. A poll held past the turn's end kept it `busy` for up to 20 s more. So did a poll the mod opened while its `measure` for the turn was still on its line (Phase 4). The mod's wait after an early empty answer, below, gives Claude Code that moment, and keeps the polls to about one a second.
- **While other loops are at work,** none of that applies (Phase 9): the session's latest `threads` has `running` above 0 ([Events](#events)). Its agents keep the registry `busy` whatever the mod has open, so answering at once would only spin the mod, about 60 polls in the minute after every such turn.
  - The deck holds the session's polls as usual. A `threads` with `running` above 0 closes the 60 s window, and so does a turn's end that comes while `running` is above 0.
  - When `running` drops to 0 while the main loop isn't in a turn, the deck answers the open poll with `{"cmds": []}` at once and opens the 60 s window, as at a turn's end.
- One open poll per session: a new poll answers any older one from the same session with `{"cmds": []}` at once.
- A command is `queued`, then `delivered` once a poll has answered it, then `waiting` (prompts only), then `done`, `refused` or `failed`.
- A queued command that no poll has taken 60 s after it was queued counts as `failed`, with "not delivered": the session's mod isn't polling.
- A delivered command with no result 60 s after delivery counts as `failed`, with "no result". A prompt's `waiting` stops that clock, since the engine holds the prompt until the turn ends (S3). A waiting prompt then ends with its final result, a new `inst`, or the session's end. It also fails, with "no result", once its mod's current instance has gone 60 s with no poll open and none sent. A live mod always keeps one open; a poll answered at once counts, but one from an `inst` that doesn't count doesn't.
- The mod polls again as soon as a poll answers. After an empty answer that came in under 1 s, or one whose commands it all skipped, it may first wait out that second, so a bridge answering at once can't drive a busy loop. After a failed poll it waits as in [Failure and recovery](#failure-and-recovery).

**Command shapes.** `id` is a string the deck picks, unique within the bridge's run.
- `{"id": "c1", "t": "prompt", "text": "..."}`: the mod calls `$.prompt.submit({text, asUser: true})`. The engine holds it until the session is idle (S3).

There are no mode, model or effort commands: the deck shows them and never changes them. That was the user's answer after S4 for the model and the effort, and on 2026-11-06 for the mode (Phase 8).

A command the mod won't run gets `failed` with the reason: an unknown `t`, or a prompt with blank text. The mod skips a command without a string `id`, and runs an `id` delivered twice since its last hello only once.

**`POST /v1/result`** body: `{"sid", "host", "inst", "id", "state", "error"?}`.
- `waiting`: a prompt was taken, and the mod is waiting for the engine to submit it. Sent once, before the final state.
- `done`, final: the prompt was submitted.
- `refused`, final: the engine said no, and `error` says why. A prompt `$.prompt.submit` drops gets `"dropped: <the engine's reason>"`, for example `"dropped: the session was stopped and nobody has sent input since"` after the user pressed Esc (S2).
- `failed`, final: the mod's call threw for any other reason, and `error` carries the message.
- A result for an unknown or finished command is ignored (204), and so is one with no `inst`, or from an `inst` other than the one its command was delivered to.

The Saved Prompt key shows waiting, sent (`done`) or refused (`refused` or `failed`), as kickoff answer 6 asks. While its last prompt is still queued, delivered or waiting, another press alerts and queues nothing. A prompt press also alerts when the target has ended, has no plugin, or has no current instance ([Identity](#identity)).

## Events

**`POST /v1/events`** body: `{"sid", "host", "inst", "seq", "events": [...]}`.
- `seq` starts at 1 for each `inst` and goes up by one per request. The bridge drops a request whose `seq` isn't above the last it saw for that `inst`, such as a retry.
- The mod sends its events and results on one ordered line, one request at a time per session, each after the previous answer. Its long poll runs beside that line. Version 1 puts one event in each request; the bridge accepts any number.
- Every event has `t`, its type, and `at`, milliseconds since the epoch by the mod's clock. Events from another loop than the main one (a subagent's, a teammate's or a workflow agent's) carry `agent`, the engine's `agentId`; the main loop's carry none. An `agent` that isn't a non-empty string counts as none.
- **From another loop, the mod sends only `tool.end` and `failed`** (plugin 0.4.0, Phase 9), and reports the rest in `threads`. Older mods also send other loops' `turn.start`, `turn.end` and `tool.start`. The deck has never used those: it ignores them.

| `t` | Fields | From the mod's | Meaning |
|---|---|---|---|
| `turn.start` | `turn`, `agent`? | `turn.start` | A main-loop turn began. |
| `turn.end` | `turn`, `agent`?, `reason` | `turn.complete` | A main-loop turn ended. `reason` as the engine gives it: `answer` normally, also after the deck's Deny; `aborted` after Esc (S2). |
| `failed` | `error`?, `agent`? | `classic.StopFailure` | The turn failed, for example on an API error. |
| `tool.start` | `tool`, `use`, `agent`?, `summary`, `fp` | `tool.call`, before `next` | A main-loop tool call began. It may still be waiting for permission. |
| `tool.end` | `tool`, `use`, `agent`?, `fp`, `ok`, `denied`? | `tool.call`, after `next` | The call ended: it ran (`ok` is false if it errored), or it was refused (`denied` holds the reason, and `ok` is false). |
| `threads` | `running`, `agents`, `runs` | `agent.spawn`; other loops' `turn.start`, `turn.complete` and `tool.call`; the main loop's Workflow `tool.call` | The session's other loops now, as a snapshot (below). |
| `measure` | `context: {percent?, tokens?, window}`, `cost`?: `{usd}` | `session.measure` | Context use or cost changed. `percent` and `tokens` are missing until the engine has them. |
| `settings` | `model`?, `mode`?, `effort`? | `$.session.model()` after each main-loop turn and once each hello is answered; `permission_mode` and `effort.level` in the main loop's classic UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop and StopFailure inputs | One of them changed. Only the changed fields are sent. |
| `attach`, `detach` | `surface` | `session.attach`, `session.detach` | The session came on screen in the app, or left it (S3). The deck counts only `surface` `desktop`, the app's own: another client, a phone say, coming or going changes nothing for it. |
| `end` | `reason` | `session.end` | The session is ending. With reason `clear`, only its conversation was cleared: the mod carries on under the new `sid` with the same `inst`. The deck takes a session's end from the registry, never from this event. |

`use` is the engine's `tool_use_id`. `tool` is the name a PermissionRequest would carry: `mcp__<server>__<tool>` for MCP tools.

A call refused at the permission prompt, by the deck's Deny or the app's own, reaches the mod as an errored result with the standard rejection text (ladder step 4). Its `tool.end` therefore has `ok: false` and no `denied`. `denied` comes only from a hook's own refusal.

The mod's own submissions and tool calls never reach its own hooks (S3), so the deck's prompts appear only through `/v1/result`.

**`threads`** (Phase 9) is the mod's picture of the session's other loops, a snapshot that replaces the last one:
- `running`: how many loops other than the main one are in a turn: their `turn.start` has had no `turn.complete` yet. A hook that heard a turn's start always hears its end (the vendored d.ts, `turn.complete`).
- `agents`: up to 8 of those loops, the most recently started first. Each is `{kind, desc, doing, run?}`:
  - `kind` comes from the loop's `agent.spawn`: `workflow` when it has `workflow`, `teammate` when `isTeammate`, `fork` when `fork`, `background` when `background`, else `subagent`. A loop the mod saw no `agent.spawn` for is `other`.
  - `desc` is the spawn's `description`, else its `subagentType`, at most 60 characters; `""` for `other`.
  - `doing` is the loop's latest `tool.call` in its current turn, as `<tool>: <summary>` ([Fingerprints and summaries](#fingerprints-and-summaries)), or the summary alone when it would read the same without the call's arguments: an MCP tool's, which names the tool; one with no summary rule, which is the tool's name; and ExitPlanMode's `Plan ready`, which its rule fixes. At most 60 characters, and `""` before the loop's first call in the turn.
  - `run` is a workflow agent's `workflow.runId`.
  - A loop whose `turn.start` the mod didn't hear, as after the mod reloads mid-turn, isn't in a turn for it: its `tool.call`s change nothing in `threads`, though its `tool.end`s still go out.
- `runs`: up to 3 workflow runs, those with a loop in a turn first, then the most recently started. Each is `{run, name, started, finished, failed, open}`:
  - `run` is the run's id (`wf_…`).
  - `name` is the `workflowName` of the main loop's Workflow call whose result named that `runId`, else that call's `name` input, else `"workflow"`.
  - `started` counts its agents' `agent.spawn`s, `finished` their `turn.complete`s, `failed` those with reason `error` or `refusal`, and `open` its agents in a turn now.
- **When it's sent:**
  - When the snapshot changes, at most once a second. The first change after a quiet second goes at once; later changes in that second go as one `threads` when the second is up, as things then stand.
  - Before a main-loop `turn.end` or `failed`, the mod sends any `threads` it's holding back, so the deck knows at the turn's end whether work goes on.
  - A mod that reloads starts with an empty picture, and sends nothing until it changes.
  - After each hello the deck answers, the mod sends its snapshot again, unless it has had nothing to report since it loaded (`running` 0 and no runs throughout, so a snapshot that went empty during an outage still goes). The deck may have restarted and lost it, and an agent busy on one long call changes nothing for minutes. The once-a-second rule still holds.
  - Until its first hello is answered, and from a failed request until the next answered hello, the mod queues no `threads`. The one sent after that hello stands for them, and they would only push older events out of the queue ([Failure and recovery](#failure-and-recovery)). In a process the bridge never talks from, it makes, sends and times none.
- **The deck** keeps the latest `threads` from a session's current instance, and forgets it at a new instance and at the session's end. A newer deck takes each field with care: a `running` that isn't a whole number from 0 counts as 0; an entry that isn't an object is skipped; an unknown `kind` reads as `other`.

## Fingerprints and summaries

**`fp`** ties a held request to the tool call it was for.
- `fp = fnv1a32(tool + "\n" + canonical(input))`, written as 8 lowercase hex digits.
- `canonical(v)`: JSON with no spaces, keys sorted by UTF-16 code units (JavaScript's default sort), keys whose value is `undefined` left out, arrays in order, and strings, numbers, booleans and `null` as `JSON.stringify` writes them.
- `fnv1a32(s)`: start with `h = 0x811c9dc5`; for each UTF-16 code unit `c` of `s`, `h = Math.imul(h ^ c, 0x01000193) >>> 0`.
- The bridge takes `tool` and `input` from `tool_name` and `tool_input`. The mod takes them from `tool.call`'s `e`: `e.tool`, and `e` without `tool`, `tool_use_id`, `agentId`, `requestMeta` and any other keys the API reserves (`ToolCallReserved` in the vendored d.ts).
- Should the two sides' fingerprints differ for some tool, release rules 2–5 still apply, only later. Ladder step 4 logs both sides' values to check.
- `canonical()` handles input of any depth. A side that still can't compute an fp, such as a deck whose `canonical()` recurses, leaves it out: no `fp` on the held request or the event. Rules 2–5 then release the request.

**`summary(tool, input)`** is what the deck shows for a call: at most 40 UTF-16 code units, and a longer one is cut to its first 39 followed by `…`.
- `Bash`: the first line of `command`, trimmed.
- `Read`, `Write`, `Edit`, `MultiEdit`: the last non-empty segment of `file_path`, split on `/`. `NotebookEdit`: the same of `notebook_path`.
- `Glob`, `Grep`: `pattern`.
- `WebFetch`: the host of `url`: the text after `://` up to the next `/`, `?` or `#`, without any `user@` or `:port`. `WebSearch`: `query`.
- `Agent`, `Task`: `description`, else `subagent_type`.
- `AskUserQuestion`: the first question's `question`.
- `ExitPlanMode`: `Plan ready`.
- `mcp__<server>__<name>`: `<name>`, with `_` as spaces.
- Any other tool, or a field that's missing, empty or not a string: the tool's name.

`fixtures/vectors.json` lists inputs with their `fp` and `summary`. Both sides test against it. `make-fixtures.mjs` holds the reference implementation and regenerates the vectors and fixtures.

## The deck's session model

The deck shows every running Code-tab session, with or without the plugin (kickoff answer 7). It merges three sources, keyed by `host`:
1. **The registry,** `~/.claude/sessions/<pid>.json`. The deck watches the folder (FSEvents) and reads it about 50 ms after a change, and every 30 s whatever happens, in case a change went unreported. It reads `sessionId`, `hostSessionId`, `name`, `cwd`, `status` (`idle`, `busy` or `waiting`), `statusUpdatedAt` and `startedAt`. Missing fields are tolerated, and the `.key` files beside them are never read. Entries can live under a second (S5).
   - **A session has ended** when no file lists its `host` any more.
   - **Two files can list one `host`,** as for a moment when a session's process restarts. The deck shows the one with the later `startedAt`, and confirms a `session_id` or `sid` against any of them ([Desktop sessions only](#desktop-sessions-only)).
   - **A reading that can't list the folder changes nothing:** the deck keeps its last reading, and warns once until a reading succeeds. A folder that doesn't exist is no sessions. A file that can't be read or parsed keeps its last good reading, or is left out if it has none.
2. **The app's records,** `~/Library/Application Support/Claude/claude-code-sessions/*/*/<host>.json`, read when a session appears and again when its file changes: `model`, `effort`, `permissionMode`, `lastFocusedAt`, `postTurnSummary`, `postTurnSummaryFor`, `lastAssistantUuid` and `turnWrapUp`. Read only.
3. **The bridge,** for sessions with the plugin: hello, events and held requests.

**Model, effort and mode:** the latest of the plugin's `hello` and `settings`, and of `permission_mode` and `effort.level` in the session's PermissionRequests; with none of those, the app's record, which lags a change made inside the engine (S4). A hello counts for less:
- **The current instance's hello said again** gives only its `model` ([Identity](#identity)).
- **No hello replaces a `mode` or `effort` the deck took from a PermissionRequest.** A hello's `mode` and `effort` are what its mod has already sent as `settings`, or queued to send. So they can be older than a PermissionRequest's, which are the engine's own at that moment: after a deck restart, a PermissionRequest can come before the mod's first hello, and after the 60 s of [Identity](#identity), before the hello that makes an instance current again. A `settings` event, or a later PermissionRequest, replaces them as usual. Each field goes by where the deck took it from, so a hello can still give the `effort` when only the `mode` came from a PermissionRequest.

**Status,** the first that applies:
1. `approval`: the bridge holds a `tool` request for the session.
2. `needs-you`: the bridge holds an `ask` request for it; or the registry says `waiting` and nothing is held for it (a session without the plugin, or a request lost when the deck restarted).
3. `background` or `working`, while the session has work going:
   - **`background`** (Phase 9): the main loop isn't in a turn, and the session's latest `threads` has `running` above 0 ([Events](#events)). The main loop isn't in a turn when its latest `turn.start` has a `turn.end` or `failed` after it, or when the deck has seen none. That holds whatever the registry says: other loops keep it `busy`, and an `idle` while `threads` still counts loops in a turn is a reading that trails.
   - **`working`** otherwise, as follows.
   - The deck times `background` (a key's `since`) from the later of the main loop's last turn end and the moment `running` last went above 0.

   `working`: the registry says `busy`. With the plugin, the summary of the main loop's latest unfinished `tool.start` says on what.
   - **A `busy` that began before the main loop's last turn ended with reason `aborted` doesn't count,** and rules 4–8 take the session as idle. After a turn, Claude Code keeps the session `busy` until a moment when the mod has no request open ([Commands](#commands)), and the deck's reading trails the registry, while the plugin's `turn.end` arrives within milliseconds (Phase 4).
   - **The `busy` began before** when its `statusUpdatedAt` is at or before the moment the deck got that `turn.end`. Without that field, it began before when the deck's first reading of it came at or before then. Its first reading is the first that showed the session `busy` since one showed it otherwise. A session's very first reading counts.
   - **Also `working` from the main loop's `turn.start`:** while its latest `turn.start` has no `turn.end` or `failed` after it, and the registry says `idle` with an `idle` that began at or before the moment the deck got that `turn.start`. The plugin's `turn.start` arrives within milliseconds, while the deck's reading trails the registry and Claude Code writes `busy` a moment into the turn. The `idle` began at or before then as the `busy` above began before: by its `statusUpdatedAt`, or without it by the deck's first reading of it. An `idle` that began later means the turn ended unseen, and doesn't count.
4. `failed`: idle, and its last main-loop turn ended with `failed`. A subagent's `failed` doesn't count.
5. `interrupted`: idle, and its last main-loop `turn.end` had reason `aborted`.
6. `needs-you`: idle, and the app's own needs-input indicator would show for the record. That's app 4.4212.0's `_D`, with its `Dw` and the record loader's `OM` and `jM`:
   - **A valid summary** is a `postTurnSummary` object, not an array, whose `title`, `description`, `status_category`, `status_detail`, `recent_action`, `needs_action` and `summarizes_uuid` are each missing or a string, and whose `is_noteworthy` is missing or a boolean. `null` is neither. Any other summary is ignored, as the app's loader drops it. `postTurnSummaryFor` and `lastAssistantUuid` count only as strings.
   - **A valid wrap-up** is a `turnWrapUp` object with a string `description` (empty counts) and a `needsUser` that's missing or a string. Any other `turnWrapUp` is ignored, as the app's loader drops it.
   - **The record counts** only when it has a valid wrap-up, or a `postTurnSummaryFor` equal to its `lastAssistantUuid`.
   - **The turn's category** is the valid summary's `status_category`, or none. With a valid wrap-up: a `failed` summary stays `failed`; otherwise a wrap-up with `needsUser` makes it `blocked`, and one without turns `blocked` or `need_input` into `review_ready`.
   - **needs-you** when that category is `blocked` or `need_input`.
   - **Known differences from the app:**
     - The app also hides the indicator while the session has background tasks, which the record doesn't show.
     - The sidebar takes `Dw`'s category without `_D`'s check that the summary is for the last assistant message.
     None of this changes any record on this Mac (2026-11-01).
7. `done`: idle after a turn the deck saw end.
8. `idle`: otherwise.

**Context %:** the latest `measure`.

**The target session** for prompts is the one last jumped to from a Session Slot or Other Sessions (the Sessions dial, which also picked it, went in Phase 9). If it ends, it stays the target, and presses alert until another is picked: a prompt never goes to a session the user didn't pick. Until one is picked, it's the session most recently on screen in the app. For each session, that's the later of its latest desktop `attach` (when the deck got it) and its record's `lastFocusedAt`. That refines kickoff answer 4 with S3's finding.

## Failure and recovery

- **The bridge is down or restarting:** the hook can't connect, which Claude Code takes as no decision, so the app's dialog decides. The hook never has `onFailure: "block"`.
- **The mod's requests fail:**
  - **What counts as a failure:** no answer; a 5xx; a non-2xx answer to a hello, or to a poll unless it's 409 `hello first`; a hello answer without `ok: true`; or a request still unanswered 35 s after it was sent, since `$.http.fetch` has no timeout.
  - **A fetch that rejects** (no answer at all), **or a poll answered 409 `{"error": "hello first"}`,** is followed about 100 ms later by a quiet hello: no log line, and no outage yet. Once that hello gets `ok: true`, the mod reopens its poll and resends the failed request under its original `seq`. A second failure, of that hello or of what follows it, a second 409 included, begins an outage, unless it comes once the failed request has gone through, or more than 2 s after that hello's answer: then a rejection or a 409 is a first failure again, with its own quick hello. So a poll the deck holds, then abandoned at an Esc or a Deny, gets a quick hello, not an outage. Three cases need this:
    - The engine abandons a mod's fetches when a turn is interrupted, a deck Deny included (ladder step 4), while the bridge is still there.
    - `streamdeck restart` brings the deck back within 85 ms (Phase 4), so the new deck must still get a hello, with its version check, before anything else.
    - A deck with no current instance for the session asks for one: after a restart while the mod had nothing open, after release rule 4, or once the current instance has stopped polling ([Identity](#identity)).
  - **What the mod does:** it backs off 1, 2, 5, 10 and 30 s, then every 30 s, with a hello each time, and logs once per outage. Once a hello gets `ok: true`, it reopens its poll and resends the failed request under its original `seq`. The outage, and so the backoff, ends only when the request whose failure began it goes through, meaning any answer under 500 for an event or result and a 2xx for a poll. Later failures in the same outage don't replace that request, and an answered hello alone doesn't end it.
  - **Any other answer to an event or result** that isn't 2xx and is under 500, such as a 4xx, drops that one request, so a bad request can't block the line. It's logged once per route and status.
  - The mod never holds up the session's work. Its open requests do hold up the registry's `idle` after a turn, so the deck answers its polls at once from the turn's end until the session is idle ([Commands](#commands)).
- **The deck's server closes or fails after listening** (Phase 9; never seen): the deck listens again on its retry schedule, and logs why. Requests it holds stay held, on Approve, Deny and their slot dials, which still answer them: the old server keeps their connections. The keys read Offline only with nothing held. Until it listens again, new requests fail as above.
- **The deck plugin restarts with requests held:** their connections drop, the hooks get no decision, and the app's dialogs stay up. The sessions still read `waiting` in the registry, so the deck shows them as `needs-you`. Queued and in-flight commands are lost.
- **The hook's timeout** is 600 s, which is also Claude Code's default for an `http` hook. After it, Claude Code drops the hook, which is no decision. The bridge sees the connection close and releases the request.
- **A deck that hangs,** accepting connections but never answering, holds every PermissionRequest to that timeout (Phase 8's C5, 2026-11-06, Claude Code 2.1.317):
  - In a desktop session, and in a terminal session's main thread, the dialog shows at once beside the hook, and decides.
  - A `claude -p` run, a nested one included, waits out the whole timeout on each request, then denies, as it does with no prompt.
  - A terminal session's background agent shows its dialog only once the hook ends.
  - `streamdeck restart com.karimdhanji.claude` frees them all at once: a dropped connection is no decision too.
  - The user kept 600 s (2026-11-06). It's how long a dial can hold a request, and only a hung deck makes these wait.
- **The mod reloads:** see `inst` in [Identity](#identity).
- **After a reboot,** macOS 26 can refuse loopback for minutes: the bridge retries listening with backoff (1–30 s), and rescans everything on wake.

## Rates

- The mod sends events as they happen, one request at a time per session, and at most one `threads` a second, besides the one it sends before a main-loop `turn.end` or `failed` ([Events](#events), `threads`).
- Each session keeps one open `GET /v1/next`, with `wait=20`.
- The deck repaints a dial's strip at most 10 times a second, with only the changed keys.

## The plugin's hooks.json

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:47600/v1/permission",
            "timeout": 600,
            "headers": {
              "Authorization": "Bearer $DECK_TOKEN",
              "X-Deck-Host": "$CLAUDE_CODE_HOST_SESSION_ID"
            },
            "allowedEnvVars": ["DECK_TOKEN", "CLAUDE_CODE_HOST_SESSION_ID"]
          }
        ]
      }
    ]
  },
  "modules": ["./register.ts"]
}
```

- **The permission hook has no `matcher`,** so every tool's request comes.
- **No `onFailure`,** so a failure is no decision.
- **`.claude-plugin/plugin.json` only describes the plugin:** its name, version, description and author. Claude Code 2.1.309 also loads hooks, servers and commands declared there, so it declares none, and this hook is all there is. `claude-code/plugin-tsc/sync-fixtures.mjs --check` holds the plugin to both.
- **Claude Code reads these hooks when a session starts.** A hot reload runs the new mod, but it doesn't add hooks to a running session (ladder step 4; the Auto spike, 2026-11-03). A session gets a new hook from its next start.
- Status comes from the mod, not from command hooks: one module per session instead of a process per event. In S1 the mod's events also arrived 5–25 ms before the async hooks'.

## Fixtures

`fixtures/*.jsonl` are example conversations, each a contract both sides test against. `make-fixtures.mjs` writes them, with `fixtures/vectors.json`: edit the generator, never the generated files. Every line is one JSON object:

| Line | Meaning |
|---|---|
| `{"note": "..."}` | Ignored. |
| `{"setup": {...}}` | The first line after the notes. `session`: the session the plugin side plays (`sid`, `host`, `model`, `cwd`, `token`). `registry`: the registry files (`pid` and the file's fields). `records`: the app's records, by `host`. |
| `{"mod": {"on": "<event>", "e": {...}, "result"?: {...}}}` | An engine event the mod sees. The plugin side runs the mod's hook for it, and `next(e)` resolves to `result` (default `{}`). |
| `{"engine": {"call": "<$ call>", "args": {...}, "returns": {...}}}` | The plugin side's fake `$` answers the mod's next call of that name with `returns`, after checking `args`. `prompt.submit` takes its one argument as `args`. |
| `{"plugin": {"as"?: "<label>", "method", "path", "headers"?, "body"?, "raw"?}}` | A request the plugin sends. The plugin side checks the mod sent it; the deck side sends it to the bridge. `raw` is a body sent as is. |
| `{"reply": {"to": "<label>", "status", "body"?}}` | The bridge's answer to the labeled request. |
| `{"press": {...}}` | The user presses something on the deck: `{"approve": {}}`, `{"deny": {}}`, `{"prompt": {"session": "<host>", "text": "..."}}`, or a Session Slot dial's `{"dial": {"session": "<host>", "decision"?: "allow" \| "deny"}}`. Approve and Deny press whatever the key shows. A dial line with `decision` turns to that chip and presses, for the request its strip showed last; one without it presses with nothing picked, which jumps to the session, on an approval or on an "Answer in app". A runner first gives the session a slot if it has none. If the request has gone and nothing newer shows, the press alerts. |
| `{"registry": {"pid", ...}}` | A registry file changes: the given fields are set, and `{"gone": true}` deletes the file. A line for a file that's gone writes it anew, with `pid` and the given fields. |
| `{"expect": {...}}` | The deck's state now. `sessions`: the hosts the deck lists (exact, any order). `held`: the held requests, oldest first, each `{host, tool, kind, summary}` (exact list, partial objects). `status`: `{host: status}`. `doing`: `{host: summary}` of the current tool, `null` for none. `context`: `{host: percent}`. `settings`: `{host: {model, effort, mode}}`, partial. `cmds`: `{label: state}` of commands, where a queued but undelivered one is `queued`. `jumped`: the `host` the last press jumped to. `alert`: whether the last press alerted. `threads`: `{host: {running, runs}}` of the session's latest `threads`, partial, with `runs` an exact list of partial runs. |

**The plugin side** (Track A's runner, with `claude plugin test` and a fake `$`):
- It plays the session in `setup.session`. It skips fixtures without `mod` lines, and lines about other sessions.
- It skips `press`, `registry` and `expect` lines, and `plugin` and `reply` lines for `/v1/permission`, which Claude Code sends, not the mod.
- It answers `$.session.id()`, `.model()`, `.cwd()` and `$.env.get` from `setup.session`. It plays a desktop session of its own: `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`, and `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_CODE_TAGS` are unset.
- It answers the mod's `/v1/hello` with `{"v": 1, "ok": true}` and its events and results with 204, unless a `reply` line says otherwise. It answers a poll only from a `reply` line; with none, the poll stays open to the end.
- It moves the mod's clock only when a line waits on it: by 1 s for a poll after an early empty answer, by 100 ms for a hello after a rejected fetch or a 409 `hello first`, and by up to 1 s for a `threads` the mod holds back. The mod logs nothing in any fixture.
- An `agent.spawn` line's `result` is what `next(e)` resolves to: the spawned agent's `agentId` and `model`.
- A `tool.call` line's `next(e)` stays open until the `plugin` line that expects its `tool.end` (the same `use`), so a call can stay open across other loops' lines, as in `release-by-agent`.

**The deck side** (Track B's runner, against the real bridge on an ephemeral port, with a fake registry folder and records folder):
- It skips `mod` and `engine` lines.
- It sends `plugin` lines in order, `*` values as they are. It adds the right token and Host to the line's headers unless the line sets them; in `headers`, `$TOKEN` stands for the right token, and `null` leaves the header out.
- It waits for each answer before going on, except for `/v1/permission` and `/v1/next`, which may be held: a later `reply` line checks those, waiting up to 2 s. Answers to hello, events and results must be 200 or 204 unless a `reply` line says otherwise.
- It applies `press` lines through the actions' own handlers, and `registry` lines to the fake folder, then lets the watcher see the change. Before a `press` or `registry` line that follows a held request (`/v1/permission` or `/v1/next`), it makes sure the bridge has taken that request.
- It retries an `expect` for up to 1 s before failing, since requests and registry changes land asynchronously.
- It gives the deck a wall clock that follows the registry's times in the fixture. These are absolute around T0 = 1793600000000 (2026-11-02T06:13:20Z). The clock starts at the setup's `statusUpdatedAt` and moves up to each registry line's.
  - Release rules 2 and 3 and status rule 3 compare arrival times on that clock with `statusUpdatedAt`. An event's `at` is the mod's clock and plays no part.
  - A fake bridge may judge all three by what it saw instead.
- It turns off the deck's 1 s wait before a press counts, and a dial's 300 ms wait for the choice its strip shows, since a fixture's press is a deliberate press on what the key or the strip shows. A dial's press for a request that has gone keeps alerting until its strip shows a newer one.
- A runner that plays fixtures to a deck it didn't reset binds each fixture `inst` to a fresh one per play, or the deck drops the replay's events as retries.

**Matching:**
- Every field of an expected object must be present and equal; extra fields are allowed. `"*"` matches any value. Arrays match when they have the same length and each element matches, in order.
- Answers to `/v1/permission` are checked more strictly. An expected `{}` means no decision, so the answer must have no `hookSpecificOutput`. Every 2xx answer, whatever the line expects, must be one of the three bodies in [Permission requests](#permission-requests). Any other status on any route must carry `{"error": "<reason>"}`, as [Transport](#transport) says.
- A `path` with a query matches when the route is equal and each listed parameter is present and equal; other parameters may be there too.
- `at` is never compared. The plugin side binds the mod's real `inst` to the fixture's at its first appearance.
- Command ids are `"c1"`, `"c2"`… The deck side binds the deck's real id to the fixture's name at its first appearance in a `reply`, and uses the real one from then on.
- Polls (`GET /v1/next`) are matched in order among themselves, apart from other requests, since a mod polls again while it runs a command.

## Amendments

**2026-11-01, after Phase 3's build** (no wire change, so `v` stays 1). Settles the questions the three tracks raised. The text above already includes them:
1. A prompt's `waiting` stops its 60 s clock; a waiting prompt fails only when its session has gone 60 s without an open poll. Mode commands keep the 60 s. (Commands)
2. Command states are named: `queued`, `delivered`, `waiting`, then `done`, `refused` or `failed`. A new `inst` fails the delivered and waiting ones. A registry file that disappears fails all of them and answers the session's open poll. (Identity, Commands, Held requests)
3. The mode rule allows one request per mode command. (Permission requests)
4. Answers to `/v1/permission` are exactly the three bodies, and runners check that, with `{}` meaning no `hookSpecificOutput`. (Permission requests, Matching)
5. A press counts only once its request has been on the key for 1 s. (Held requests)
6. Release rules 1–4 spelled out: one request per `tool.end`, and how rules 2 and 3 compare times. (Held requests)
7. Hosts must match `^local_[A-Za-z0-9-]{1,64}$`; a request the bridge can't place is held without a host, or gets 400 from a mod. (Identity)
8. The mod's side: hello's optional fields and the version stop, one ordered line for events and results, what counts as a failed request, `measure`'s fields, the sources of `settings`, `end` with reason `clear`, and the commands it won't run. (Routes, Events, Commands, Failure and recovery)
9. The deck's side: `needs_action` as a string, the target fallback, a picked target that ends, and when Saved Prompt, prompt and mode presses alert. (The deck's session model, Commands)
10. Runners: take held requests before a press or registry change, follow the fixture's clock, skip the press wait, and use a fresh `inst` per replay. (Fixtures)

**2026-11-01, after the fix round** (no wire change). Settles the questions it raised:
1. Answers to `/v1/permission` are exempt from "unknown fields are ignored": they're exactly the three bodies. (Transport)
2. A new `inst` answers the old instance's open poll. Requests from an `inst` seen before are still taken, and the deck keeps at least 8 per host. The bridge may place a host from the `sid` and `host` pairs its mods sent. (Identity)
3. A queued command no poll takes within 60 s fails with "not delivered", so a Saved Prompt key can't stay locked. A poll answered at once counts as the mod being alive. The mod may wait out 1 s after an empty answer that came sooner. (Commands)
4. The mod reads the model again once each hello is answered. Hello's `model` may be missing. The version stop applies to hello answers. (Routes, Events)
5. An answered hello alone doesn't end an outage or reset the backoff, and any non-2xx answer under 500 to an event or result drops it. (Failure and recovery)
6. Rule 3 without `statusUpdatedAt` needs a change to `idle` the deck saw; a first reading doesn't count. A fake bridge may judge rules 2 and 3 by what it saw. (Held requests, Fixtures)
7. Status rule 6 follows the app's own reading: a turn wrap-up's `needsUser` replaces the summary's `needs_action`. (The deck's session model)

**2026-11-01, after round 3 and ladder steps 4–5** (no wire change):
1. Status rule 6 is now the app's own needs-input indicator (`_D`), read from the bundle: a valid wrap-up or a summary for the last assistant message, and `Dw`'s category `blocked` or `need_input`. Rule 4 counts only the main loop's `failed`. (The deck's session model)
2. A poll from an older `inst` is answered at once and never gets commands. The host fallback may use the hook's `sid` and `host` pairs too. (Identity)
3. A fetch that rejects is retried once after about 100 ms before it counts as a failure, since an interrupt abandons the mod's fetches. "Goes through" means any answer under 500 for an event or result, and a 2xx for a poll. The request whose failure began an outage is the one that ends it. (Failure and recovery)
4. A call refused at the permission prompt arrives as `ok: false` without `denied`. `failed` may carry `agent`, and an `agent` that isn't a non-empty string means the main loop. (Events)
5. Error answers to `/v1/permission` are `{"error"}`. The mod may wait out 1 s after a fast answer whose commands it all skipped. (Transport, Commands)

**2026-11-01, after round 4** (wording only, no wire or behaviour change for the real sides):
1. Matching holds 2xx answers to `/v1/permission` to the three bodies and every other status to `{"error"}`. The `deny` fixture's mod line now has the refusal as an errored result, and its `tool.end` has no `denied`. (Fixtures)
2. The records source list names `postTurnSummaryFor` and `lastAssistantUuid`, and rule 6 lists its known differences from the app. (The deck's session model)
3. `canonical()` handles any depth, or the fp is left out. A waiting prompt's liveness counts only the newest instance's polls. A result counts only from the instance its command went to. (Fingerprints, Commands)

**2026-11-01, Phase 4** (no wire change):
1. The quick retry after a rejected fetch is now a quiet hello, then the failed request. In Phase 4, `streamdeck restart` brought the deck back 85 ms after it stopped, so T2's and T3's retried polls reached the new deck with no hello and no version check. (Routes, Failure and recovery)
2. On the deck, a question or plan reads "Answer in app", and a press that opens its session shows the OK. The user found a press on a question looked dead and chose this over answering from the deck. (Held requests)

**2026-11-02, Phase 4** (no wire change):
1. A `busy` that began before the main loop's interrupted turn ended no longer hides the interruption. The session shows `interrupted` as soon as the deck gets the `turn.end`.
   - In Phase 4, Claude Code kept T3 `busy` for 8.2 s after an Esc, while the plugin's `turn.end` reached the deck 3 ms after it.
   - The `prompt-refused` fixture now keeps the registry `busy` past the `turn.end`.
   - (The deck's session model, Fixtures)

**2026-11-03, Phase 4** (no wire change):
1. At the end of the main loop's turn, the deck answers the session's open poll with `{"cmds": []}`. Then, for up to 60 s and until a main-loop `turn.start`, while the registry says `busy`, it answers the session's polls at once, and answers the poll it holds when its reading turns `busy`. Claude Code keeps a session `busy` until a moment after the turn when the mod has no request open. (Commands, Failure and recovery)
   - In the retests, T2 stayed `busy` for 17 s after a normal turn ended. In each of the three turn ends logged at debug level before the change, the registry went `idle` 2 ms before the deck logged the mod's next poll, that is, as the poll that was open when the turn ended ran out.
   - Answering only the open poll brought a short turn to 5 ms. But a turn whose `measure` reached the deck after its `turn.end` stayed `busy` for 20 s, because the mod polled again while the `measure` was on its line. Answering its polls at once brought the same turn to 4 ms.
   - Both reviewers found that a poll could still come before the deck's once-a-second reading said `busy`, after a short turn or a Deny, and be held for 20 s. So a reading that turns `busy` in that time answers the poll the deck holds.
   - This corrects the 2026-11-02 entry. The 8.2 s after an Esc came from the same poll, and the delay follows every turn, not only an interrupted one. Status rule 3 stays, for the second before the deck reads the registry again. (The deck's session model)
2. The `status`, `approve` and `prompt-refused` fixtures answer `n1` at the `turn.end` and the next poll at once while the registry says `busy`. `deny` holds its next poll: its registry still says `waiting`. (Fixtures)

**2026-11-03, Phase 5** (`v` stays 1: one route and one hook are added, and a side without them treats the other's as unknown, which is no decision):
1. **The mode hook and `POST /v1/pretool`.** Before the app's mode tool runs, a PreToolUse http hook asks the bridge. The bridge allows the deck's own change in flight, under the same rule as kind mode, and gives every other request `{}` at once. (Parties, Transport, Routes, Permission requests, Mode checks, Commands, The plugin's hooks.json)
   - In Auto, the auto-mode classifier refused the mod's change in Phase 4 and left it unanswered for minutes on 2026-11-03.
   - With the hook's allow, T4's change from Auto to Manual was `done` in 31 ms.
   - A raise still brings up the app's approval as a PermissionRequest.
   - A hot reload doesn't add the hook to a running session, so a session gets it from its next start.
2. **Desktop sessions only.** With the plugin in `~/.claude/settings.json`, every Claude Code process that reads it loads the plugin: terminal and VS Code sessions, `claude -p` runs, a `claude` started inside a desktop session (which inherits its host id), forks of preset sessions, and the app's pre-warmed spares. So:
   - The mod talks to the bridge only in a desktop session of its own, by the engine's own test plus the forks' tags.
   - The bridge takes a hook's request only from a session the registry confirms by host and `session_id`, and answers any other with `{}` at once.
   - A hello under a listed host with another `sessionId` gets 409.
   - (Transport, Identity, Desktop sessions only, Fixtures)
3. **Only a hello makes an `inst` current.** Any other request from an `inst` that hasn't said hello to this deck is an older instance's. That closes round 4's open point: after a deck restart, a replaced instance's late request could take over a session's polls. (Identity, Commands)
4. **Fixtures:**
   - `mode-raise` has the mode check before its PermissionRequest.
   - `mode-not-ours` checks that a mode check with no command in flight gets `{}`.
   - New: `mode-from-auto`, `stray-instance` and `not-desktop`.
   - The plugin side plays a desktop session of its own.
   - Runners treat `/v1/pretool` like `/v1/permission`: the plugin side skips it, and its answers are checked strictly.
   - (Fixtures)
5. **A session no instance has said hello for asks for one.** The deck answers its polls with 409 `{"error": "hello first"}`, and the mod says a quiet hello about 100 ms later, as after a rejected fetch. All three reviews of the build found that a deck restart in the second after a turn's end, or a registry reading that misses the session, otherwise left the mod's polls answered at once for good. The new `hello-again` fixture plays the second case; a registry line can now write a gone file anew, and the plugin side moves its clock 100 ms for the quick hello. (Identity, Routes, Commands, Failure and recovery, Fixtures)
6. **Points the build settled:**
   - A hello that doesn't make its `inst` current changes nothing.
   - A result with no `inst` is ignored.
   - A press alerts for a session with no current instance.
   - A hello with no `sid` for a listed host gets 409, after one more registry reading.
   - The mode check reads `session_id`.
   - `DECK_TOKEN` must not be blank, and a variable the mod can't read keeps it quiet.
   - (Identity, Desktop sessions only, Mode checks, Commands)

**2026-11-03, Phase 6** (no wire change):
1. **A current instance that stops polling stops counting.** After 60 s with no poll open and none sent, the deck forgets which instances said hello for the session, so the live mod's next poll gets 409 `hello first`. Round 2's review of Phase 5 found that a deck restart while two live mods share a `host` makes current whichever says hello last, possibly a predecessor about to exit. (Identity)
2. **The current instance's hello, said again, takes `cwd` and `model` only.** After every Deny it came with the mode the mod had sent before, and could put back an older one than the PermissionRequest's (round 2's review). (Identity, The deck's session model)
3. **Status rule 3 shows `working` from the main loop's `turn.start`,** before the registry's next reading says `busy`. The `status` fixture checks it. (The deck's session model, Fixtures)
4. **Status rule 6 reads only a summary the app's loader would keep,** which removes a known difference from the app. New fixture `needs-you-record` (19 in all). (The deck's session model, Fixtures)
5. **The registry:** `startedAt`, which of two files for one `host` the deck shows, release rule 4 once no file lists the `host`, and a reading that can't list the folder keeps the last one. Until now such a reading ended every session at once. (The deck's session model, Held requests)
6. **The quick hello's window closes 2 s after its answer,** so a poll the deck holds, then abandoned at an Esc or a Deny, gets a quick hello instead of an outage. (Failure and recovery)
7. **Wording:** `refused` covers a mode change the engine refuses, read from its words, and `plugin.json` declares nothing. Round 3's review settled readings the code already had: a restart is a new instance replacing a current one; the 60 s count from the later of the last poll's end and the hello that made the instance current, and only polls count; after them a prompt or mode press alerts, while Approve and Deny still answer; rule 3's turn ends at a `failed` too; and past the quick hello's window, only a rejection or a 409 gets its own quick hello. (Commands, The plugin's hooks.json, Identity, The deck's session model, Failure and recovery)

**2026-11-03, Phase 6, round 4** (no wire change, no fixture change: the plugin is untouched, and the deck and the fake test each rule apart):
1. **When the current instance stops polling, the deck remembers which instances have said hello.** While none is current, any instance's hello makes its own current, which isn't a restart; from then on the others don't count. Round 3's review found that forgetting them let a live predecessor's later hello take the session back as a restart, failing the live mod's commands for another minute. (Identity)
2. **No hello replaces a `mode` or `effort` the deck took from a PermissionRequest.** Round 3's review found a hello putting back an older mode after the 60 s, and after a deck restart when a PermissionRequest came before the mod's first hello. The Mode dial's press without a turn applies the mode it shows. (The deck's session model)
3. **Wording:** the bullet on instances that don't count said that the hello of one that hasn't said hello before changes nothing. While another is current, that hello is a restart, as the bullet before it says and the deck has always done. (Identity)

**2026-11-04, session keys** (Phase 7, `docs/claude-code/session-keys.md`; nothing changes for the plugin, so `v` stays 1):
1. **A Session Slot dial answers its own session's requests:** Allow or Deny for a tool, an Answer for a question, an Approve plan or a Deny for a plan. The Approve and Deny keys don't change. The user asked for it on 2026-11-04. (Permission requests, Held requests)
2. **Two new answer bodies, Answer and Approve plan.** Claude Code needs the person for AskUserQuestion and ExitPlanMode, so it ignores a plain Allow for them: T5's plan stayed on the app's card. It honours an Allow with `updatedInput`, then cancels the app's request, and the app removes its card (the engine check; the user saw it live with T7, 2026-11-05). T5 checked the Answer live with one question and with two, one of them multi-select. T6 checked Approve plan into Accept edits and into Auto, a Deny with feedback that kept Claude planning, and an Allow with no `setMode`, which went back to the mode from before Plan. (Permission requests)
3. **A held `ask` request keeps its `tool_input`,** up to 64 KiB. (Held requests)
4. **Fixtures:**
   - Dial `press` lines, and strict matching of the new bodies.
   - New: `answer-question`, `answer-questions`, `dial-gone`, `dial-next`, `dial-approve`, `plan-approve` and `plan-reject`, 26 in all.
   - `answer-questions` picks out of option order and has a label that holds a double quote, so both runners check the whole join rule.
   - `needs-you` keeps the keys' jump.
   - (Fixtures)
5. **A dial sends only the choice its strip showed,** once it has shown 300 ms. The deck's review found that a tick just before a push could send a choice the strip never showed, such as Allow when Deny was on screen. (Held requests)
6. **A request answered elsewhere blocks its dial only while nothing newer shows.**
   - The deck kept the block for 1 s even after its strip showed the session's next request. Its fixture runner holds the clock still, so there the block lasted to the end of the fixture. The fake deck acted on the next request at once, so the two runners differed (`dial-next`).
   - On the device, the 1 s from the next request's first paint already guarded every send. The change reaches only the presses that rule doesn't guard: a jump, a pick that moves on, a tick, Next and Other….
   - (Held requests, Fixtures)
7. **Display-only asks:** the AskUserQuestion forms the deck can't read are listed, and the two sides now agree on them. An `ask` whose `tool_input` the token scrub changed is display-only, so an echo is always exact. (Transport, Held requests)
8. **Only the desktop app's `attach` and `detach` count.** The mods API sends them per client, so a phone leaving a session would have hidden it from a desktop that still shows it. (Events, The deck's session model)

**2026-11-06, Phase 8** (`docs/claude-code/hardening.md`; `v` stays 1: a route, a hook and a command go, and a newer side takes an older one's as unknown, which is no decision):
1. **Mode changes go,** at the user's word on 2026-11-06: the Mode key and the Mode dial, the `mode` command, the mode hook with `POST /v1/pretool`, and kind `mode` of permission requests. (Parties, Transport, Identity, Desktop sessions only, Routes, Permission requests, Commands, Events, The deck's session model, The plugin's hooks.json, Fixtures)
   - **Why:** the deck's logs since 11-02 showed them used only in the user's checklist on 11-03, and they needed the most brittle trick in the project, a PreToolUse allow past the auto-mode classifier.
   - **What stays:** a Session Slot's Setup page still shows its session's mode. A plan dial's Approve plan still leaves Plan mode into the mode it shows: that's an answer, not a command.
   - **Sessions started before plugin 0.3.0** keep the mode hook until they restart. Its request now gets 404, an unknown route. Claude Code takes that as no decision, as with a deck that's down, and the tool call goes on. Each one leaves a hook-error line in the session, and an info line in the deck's log. The deck sends no mode command, so an older mod never gets one.
2. **The deck watches the registry and the app's records** instead of reading them every second (B4). It reads the registry about 50 ms after FSEvents reports a change, and every 30 s whatever happens. (The deck's session model, Commands)
3. **A hung deck and the hook's timeout** (C5): what each kind of Claude Code process does while the bridge accepts a request and never answers, and that restarting the deck plugin frees them all. The timeout stays 600 s, at the user's word. (Failure and recovery)
4. **Nothing proves the bridge is the deck** (C6): an accepted risk on the user's own Macs, now written down. (Transport)
5. **Fixtures:** `mode-raise`, `mode-not-ours` and `mode-from-auto` go, and `not-desktop` loses its mode check, which leaves 23. The plugin side no longer answers `mcp.call`. (Fixtures)

**2026-11-07, Phase 9** (`docs/claude-code/agents-and-wake.md`; `v` stays 1: an older deck ignores `threads` as an unknown event and never used the loop events the mod stops sending, and an older mod's session shows `working` through rule 3, as before):
1. **The deck answers no question or plan,** at the user's word after a day on their work Mac: they answer in the app, after a press that jumps there. Kind `ask` is display-only on the dial as on the keys. The Answer and Approve plan bodies go, which leaves three, and the bridge keeps no `tool_input`. The deck no longer relies on Claude Code taking an Allow with `updatedInput`. (Transport, Permission requests, Held requests, Fixtures)
2. **The bridge reads `agent_id`, and release rule 1 matches the loop.** The investigation found that one agent's finished call could release another agent's identical request held on the deck. (Permission requests, Held requests)
3. **New event `threads`:** the session's other loops (subagents, teammates, workflow agents) as a snapshot, at most once a second. The mod stops sending other loops' `tool.start`, `turn.start` and `turn.end`: the deck dropped them, and in one workflow they were 95% of a session's events. (Events, Rates)
4. **New status `background`,** within rule 3: the main loop isn't in a turn while other loops are. The registry already said `busy` then, so the deck read `working` without saying why. (The deck's session model)
5. **The poll burst after a turn waits for `running` to reach 0:** while other loops keep the registry `busy`, answering at once only spun the mod. (Commands)
6. **The target** comes from slot and Other Sessions jumps: the Sessions dial and the Session key went, at the user's word. (The deck's session model)
7. **Fixtures:** `answer-question`, `answer-questions`, `plan-approve` and `plan-reject` go. `dial-gone` moves onto a Bash request. `needs-you` gains the dial's jump. New: `threads` and `release-by-agent`, 21 in all. A dial `press` line has `decision` or nothing, and `expect` gains `threads`. On the plugin side, a `tool.call` stays open until its `tool.end` line. (Fixtures)
8. **After the build:** the mod sends its `threads` again after each answered hello, and queues none before its first answered hello or from a failed request until the next. The build found that after a deck restart, a session's agents showed nothing until their picture next changed, and that an outage filled the queue with snapshots. The deck also listens again should its server close or fail, and keeps showing the requests it holds meanwhile. (Events, Failure and recovery)
9. **After the review:** `doing` is the call in the loop's current turn, and shows the summary alone when it would read the same without the call's arguments, so `TodoWrite: TodoWrite` reads `TodoWrite`. (Events)
