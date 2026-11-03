# Bridge protocol, version 1

The wire protocol between the Claude Code plugin `streamdeck-bridge` (`claude-code/plugin/`), which runs inside Claude Code sessions in the Claude desktop app, and the Stream Deck plugin `com.karimdhanji.claude` (`claude-code/deck/`), which hosts the bridge. Frozen on 2026-11-01 from the Phase 1 results in `docs/claude-code/plan.md`, whose Log holds each finding cited here (S0–S6).

Changes go through the main thread. A change that breaks either side bumps `v`.

Contents: [Parties](#parties) · [Transport](#transport) · [Identity](#identity) · [Desktop sessions only](#desktop-sessions-only) · [Routes](#routes) · [Permission requests](#permission-requests) · [Mode checks](#mode-checks) · [Held requests](#held-requests) · [Commands](#commands) · [Events](#events) · [Fingerprints and summaries](#fingerprints-and-summaries) · [The deck's session model](#the-decks-session-model) · [Failure and recovery](#failure-and-recovery) · [Rates](#rates) · [The plugin's hooks.json](#the-plugins-hooksjson) · [Fixtures](#fixtures) · [Amendments](#amendments)

## Parties

- **The permission hook:** an `http` PermissionRequest hook in the plugin's `hooks/hooks.json`. Claude Code posts the hook's input and waits for the answer, while the app shows its own dialog beside it. The first answer wins (S2).
- **The mode hook:** an `http` PreToolUse hook in the same `hooks/hooks.json`, matched to the app's mode tool alone. Claude Code posts the hook's input before the tool's permission check, the auto-mode classifier included, and waits for the answer ([Mode checks](#mode-checks)).
- **The mod:** the plugin's `hooks/register.ts`, one instance per session, on the mods API of the app's Claude Code 2.1.309. It says hello, reports events, and fetches and runs the deck's commands.
- **The bridge:** the HTTP server inside the deck plugin.
- **The deck:** the rest of the deck plugin. It merges what the bridge hears with the session registry and the app's session records ([The deck's session model](#the-decks-session-model)).

Nothing else talks to the bridge, and the bridge never calls the plugin.

## Transport

- HTTP/1.1 on `127.0.0.1:47600`, IPv4 only. Clients use `127.0.0.1`, never `localhost` (S6).
- Every request carries:
  - `Host: 127.0.0.1:47600` or `localhost:47600`. Anything else gets 403, before the token is looked at. That stops a web page that rebinds a DNS name to 127.0.0.1.
  - `Authorization: Bearer <token>`. Missing or wrong: 401, with `WWW-Authenticate: Bearer realm="streamdeck"`.
- **The token** is the trimmed content of the deck plugin's `com.karimdhanji.claude.sdPlugin/run/token`, which the deck creates on first start (file `0600`, folder `0700`). The plugin reads it from the environment variable `DECK_TOKEN`. The `deck-sandbox` preset sets it for throwaway sessions, and the `env` block of `~/.claude/settings.json` sets it for the user's own (Phase 5). In a desktop session the launch environment wins key by key, so a preset's value beats the settings' (the route research, 2026-11-03). Neither side ever logs it.
- Bodies are JSON in UTF-8, at most 8 MiB (413 above). A body that isn't JSON gets 400, an unknown route 404, a wrong method 405. Error answers are `{"error": "<reason>"}`.
- Unknown fields are ignored on both sides, so either side can add fields without a version bump. Answers to `/v1/permission` and `/v1/pretool` are the exception: Claude Code reads them, and a 2xx answer is exactly one of the bodies in [Permission requests](#permission-requests) or [Mode checks](#mode-checks). Any other status carries `{"error": "<reason>"}`, like every error answer.
- No CORS headers.

## Identity

- **`sid`:** Claude Code's session id, a UUID. The mod reads it with `$.session.id()`; the hook's body has it as `session_id`. It can change during a session's life (the app's records keep `priorCliSessionIds`), so the deck doesn't key on it.
- **`host`:** the app's `local_…` id, fixed for the session's life, and what the jump link `claude://code/continue?session=<host>` takes (S5). The mod reads `CLAUDE_CODE_HOST_SESSION_ID` with `$.env.get`; the hook sends it in the header `X-Deck-Host`. A value that doesn't match `^local_[A-Za-z0-9-]{1,64}$` counts as missing, such as an empty one or a `$CLAUDE_CODE_HOST_SESSION_ID` that Claude Code didn't fill in. For a mod's request, the bridge then looks `sid` up in the registry, and then among the `sid` and `host` pairs it has seen from mods. A mod request it still can't place gets 400. The hooks' requests are placed only as [Desktop sessions only](#desktop-sessions-only) says.
- **`inst`:** a random id the mod picks each time it loads, hot reloads included. **Only a hello makes an `inst` the session's current one.**
  - **A hello from an `inst` the deck hasn't had a hello from for that `host`, while another is current,** means the mod restarted. The deck then forgets that session's current tool and fails its `delivered` and `waiting` commands with "the mod restarted". It keeps the rest, queued commands included. If the old instance left a poll open, the deck answers it with `{"cmds": []}`, so commands queued from then on wait for the new instance.
  - **Any other `inst` doesn't count:** a replaced one, which the deck has had a hello from before, or one that hasn't said hello to this deck. Its events and results are still taken. Its hello is answered `ok` but changes nothing, its `model`, `mode` and `effort` included. Its polls are answered at once with `{"cmds": []}`: they never displace the current instance's poll and never receive commands.
  - **The current instance's hello, said again,** as after a rejected fetch or in an outage, is answered `ok` and takes its `cwd` and `model`, and nothing else changes. Its `mode` and `effort` are what the mod has already sent the deck, or queued to send, as `settings`, while the deck may since have taken a newer one from a PermissionRequest. So the deck keeps its own.
  - **A session with no current instance asks for one.** Until an `inst` says hello for a `host`, the deck answers every poll for that `host` at once with 409 `{"error": "hello first"}`. That happens after the deck restarts, after it forgets the session at release rule 4, and once the current instance stops polling (below). The mod takes the 409 as it takes a fetch that rejected: a quiet hello about 100 ms later ([Failure and recovery](#failure-and-recovery)).
  - **A current instance that stops polling stops counting.** Once it has gone 60 s with no poll open and none sent, counted from the later of its last poll's end and the hello that made it current, the deck forgets which instances said hello for the session. It keeps the rest: settings, held requests, commands and the current tool. Only polls count, as [Commands](#commands) counts them for a waiting prompt; a hello said again doesn't. The session then has no current instance: a prompt or mode press on it alerts, while Approve and Deny still answer its held requests. Its mod's next poll gets 409 `hello first`, and that mod's hello makes its instance current, which isn't a restart.
  - The deck remembers at least the last 8 `inst`s per `host` that said hello.
  - **Why:**
    - Before 2026-11-03 any new `inst` counted. So after a deck restart, a replaced instance's late request could become the newest instance, and the live instance's polls were then answered at once for good (round 4's review).
    - A mod says hello when it loads and after a failed request ([Routes](#routes)), so a deck that restarts while the mod has a request open hears hello first. But after a poll answered within a second, as at every turn's end, the mod waits out the rest of that second with nothing open. A restart in that second fails nothing, and neither does a registry reading that misses the session. Without the 409, the mod's polls would then be answered at once for good, and the session would take no prompts or mode changes until the mod reloaded (all three reviews of Phase 5's build).
    - The 409 goes only to a session with no current instance, so it never displaces one. A replaced instance can't answer it with a hello, since a reload drops the old environment's timers (the mods API's `reference.md`).
    - A deck that restarts while two live mods share a `host`, a restarted process and its predecessor still running, asks both for a hello, and makes current the one whose hello lands last. The mods can't say which process is newer: the mods API has no pid, and the app resumes a session under the same session id (`resume: cliSessionId`; only `--fork-session` makes a new one). If the predecessor's hello lands last, the live mod's polls are answered at once with none until the predecessor's mod has gone 60 s without one (round 2's review of Phase 5).
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
- **The bridge takes a PermissionRequest or a mode check only from a confirmed session.** Hooks can't be gated: `hooks.json` has no condition on the environment, and a hook's process always has `CLAUDECODE` set.
  - A confirmed session is one the registry lists under the request's `X-Deck-Host`, with a `sessionId` equal to the request's `session_id`.
  - If the deck's latest reading doesn't show that, it reads the registry once more.
  - A request still not confirmed gets `{}` at once, and nothing is held. The process's own permission flow decides.
- **A hello from a host the registry lists under another `sessionId` is refused,** with 409 `{"error": "not this session"}`, and so is a hello with no `sid` for a listed host. If the deck's latest reading doesn't list the host with the hello's `sid`, it reads the registry once more first, so a hello just after a `/clear` isn't refused on an old reading. A hello from a host the registry doesn't list yet, as from a spare, is taken, and the deck lists that session once the registry does.

## Routes

| Route | From | Does | Answer |
|---|---|---|---|
| `POST /v1/permission` | the hook | holds a PermissionRequest | 200, a decision or `{}` |
| `POST /v1/pretool` | the mode hook | checks a mode change, at once | 200, an allow or `{}` |
| `POST /v1/hello` | the mod | announces the mod | 200 `{"v": 1, "ok": true}` |
| `POST /v1/events` | the mod | reports events | 204 |
| `GET /v1/next` | the mod | fetches commands, long poll | 200 `{"cmds": [...]}`, or 409 `{"error": "hello first"}` |
| `POST /v1/result` | the mod | reports how a command went | 204 |

Every mod request names its session with `sid`, `host` and `inst`: in the body, or for `GET /v1/next` in the query. The bridge accepts every route from a session it hasn't had `hello` from, except that it answers polls with 409 `{"error": "hello first"}` until an instance has said hello for that session ([Identity](#identity)).

**`POST /v1/hello`** body: `{"v": 1, "sid", "host", "inst", "cwd", "model", "mode"?, "effort"?, "plugin", "cc"}`, where `model` is `$.session.model()`, `plugin` the plugin's version and `cc` Claude Code's (`"unknown"` if the mod can't read it). `mode` and `effort` are left out until the mod has seen them, `model` is left out if the mod can't read one, and `host` is `""` when the variable is unset (from plugin 0.2.0 the mod talks only with a valid one, [Desktop sessions only](#desktop-sessions-only)). The mod sends hello when it loads, before any other request, and waits for the answer. It sends it again when the bridge answers after a failed request, since the deck may have restarted, and after a rejected fetch ([Failure and recovery](#failure-and-recovery)). So a deck that restarts while a mod has a request open gets a hello before anything else from it, even one restarted within 100 ms. A mod with nothing open hears 409 `hello first` at its next poll ([Identity](#identity)). A deck on another version answers `{"v": <its own>, "ok": false, "error": "version"}`. The mod stops talking to the bridge until it reloads when a hello's answer has `ok: false` with `error: "version"`, or with a `v` other than 1, and logs that once.

## Permission requests

`POST /v1/permission`: the body is the hook's input as Claude Code sends it. The bridge reads `session_id`, `tool_name`, `tool_input`, `permission_mode` and `effort`, and the header `X-Deck-Host`. There's no `tool_use_id` in it (S2).

The bridge sorts each request into one kind:
- **mode:** `tool_name` is `mcp__ccd_session_mgmt__set_session_permission_mode`, `tool_input.session_id` is `"self"`, and the same session has a `mode` command in flight ([Commands](#commands)) whose `mode` equals `tool_input.mode`. The bridge answers Allow at once, to the first such request only: a second one for the same command is an ordinary `tool` request. Along with the mode check's allow ([Mode checks](#mode-checks)), it's the only answer the bridge gives without a key press, and a key press started both (the user's answer after S4).
- **ask:** `tool_name` is `AskUserQuestion` or `ExitPlanMode`. Held for display only: the deck never answers it, and a press on it jumps to the session (kickoff answer 3).
- **tool:** everything else, the app's mode tool included when no matching command is in flight. Held until Approve or Deny, or released ([Held requests](#held-requests)).

Answers, all 200:
- **Allow:** `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}`
- **Deny:** `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Denied from the Stream Deck.", "interrupt": true}}}`. The turn stops, as with the app's own No. Claude gets the standard rejection text, not the message (S2), but S2 verified this shape with a message, so it stays.
- **No decision:** `{}`. The app's dialog decides.

Every answer is exactly one of these three bodies. The deck never sends `updatedPermissions` or `updatedInput`, never adds a field inside `hookSpecificOutput`, and never sends Claude Code's own top-level hook fields (`continue`, `stopReason`, `decision`, `reason`, `systemMessage`, `suppressOutput`).

## Mode checks

`POST /v1/pretool`: the body is the mode hook's input as Claude Code sends it, a PreToolUse for the app's mode tool alone ([The plugin's hooks.json](#the-plugins-hooksjson)). The bridge reads `session_id`, `tool_name` and `tool_input`, and the header `X-Deck-Host`. It answers at once and never holds the request.

Answers, both 200:
- **Allow**, when `tool_name` is `mcp__ccd_session_mgmt__set_session_permission_mode`, `tool_input.session_id` is `"self"`, and the session `X-Deck-Host` names has a `mode` command in flight ([Commands](#commands)) whose `mode` equals `tool_input.mode`. Only the first such request per command gets it, as with kind mode:
  `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "The mode change pressed on the Stream Deck."}}`
- **No decision**, otherwise: `{}`. That includes a request whose `X-Deck-Host` is missing or doesn't match the host pattern ([Identity](#identity)). The session's own permission check then decides, the auto-mode classifier included.

Every 2xx answer is exactly one of these two bodies. The bridge never denies or asks here.

**Why:**
- In Auto, Claude Code judges the mod's call to the mode tool as it judges a call of Claude's own, with the server-side auto-mode classifier. A mod's call has none of the model's verdicts to go on. In Phase 4 the call was refused in 14 ms. On 2026-11-03 it went unanswered for minutes (T3).
- A PreToolUse allow skips that check. In T4, the change from Auto to Manual was `done` in 31 ms, and no PermissionRequest came.
- The user pressed for the change, and that press is what the classifier stands in for.
- A raise still brings up the app's own approval as a PermissionRequest, which kind mode allows ([Permission requests](#permission-requests)).

## Held requests

- A held request belongs to a session, and has its kind, `tool`, `summary` and `fp` ([Fingerprints and summaries](#fingerprints-and-summaries)) and the time it arrived. The bridge holds any number, from any number of sessions.
- **Approve and Deny** act on the oldest held request across all sessions, and only on the one the key showed when pressed (S6). The request must have been on the key for 1 s, timed from its first paint, or from the key's last OK or alert if that came later. An earlier press alerts and answers nothing, so a double press can't answer a request nobody has seen. On a `tool` request, Approve answers Allow and Deny answers Deny. On an `ask` request, either press jumps to its session and answers nothing; the key reads "Answer in app", and the press shows the OK.
- **Answering in the app doesn't end the hook's request** (S2), so the bridge releases a held request with `{}` at the first of:
  1. The mod reports `tool.end` with the same `fp`, from the same session. Each `tool.end` releases one request, the session's oldest with that `fp`, and a subagent's counts too.
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
  - **When the reading turns `busy`, it answers the poll it holds** with `{"cmds": []}`. The deck reads the registry once a second, so a poll can come before the reading says `busy`: after a shorter turn, or after a Deny while the reading still says `waiting`.
  - Why: Claude Code keeps a session `busy` in the registry until a moment after the turn when the mod has no request open. A poll held past the turn's end kept it `busy` for up to 20 s more. So did a poll the mod opened while its `measure` for the turn was still on its line (Phase 4). The mod's wait after an early empty answer, below, gives Claude Code that moment, and keeps the polls to about one a second.
- One open poll per session: a new poll answers any older one from the same session with `{"cmds": []}` at once.
- A command is `queued`, then `delivered` once a poll has answered it, then `waiting` (prompts only), then `done`, `refused` or `failed`.
- A queued command that no poll has taken 60 s after it was queued counts as `failed`, with "not delivered": the session's mod isn't polling.
- A delivered command with no result 60 s after delivery counts as `failed`, with "no result". A prompt's `waiting` stops that clock, since the engine holds the prompt until the turn ends (S3). A waiting prompt then ends with its final result, a new `inst`, or the session's end. It also fails, with "no result", once its mod's current instance has gone 60 s with no poll open and none sent. A live mod always keeps one open; a poll answered at once counts, but one from an `inst` that doesn't count doesn't. Mode commands keep the 60 s even after a stray `waiting`, which bounds how long the mode rule can allow a change.
- The mod polls again as soon as a poll answers. After an empty answer that came in under 1 s, or one whose commands it all skipped, it may first wait out that second, so a bridge answering at once can't drive a busy loop. After a failed poll it waits as in [Failure and recovery](#failure-and-recovery).

**Command shapes.** `id` is a string the deck picks, unique within the bridge's run.
- `{"id": "c1", "t": "prompt", "text": "..."}`: the mod calls `$.prompt.submit({text, asUser: true})`. The engine holds it until the session is idle (S3).
- `{"id": "c2", "t": "mode", "mode": "acceptEdits"}`: the mod calls `$.mcp.call("ccd_session_mgmt", "set_session_permission_mode", {session_id: "self", mode})`. `mode` is `default` (the app's Manual), `acceptEdits`, `plan` or `auto`, never `bypassPermissions`. After `done`, the mod sends a `settings` event with the new mode.
  - **Before the call runs,** the mode hook asks the bridge, which allows it ([Mode checks](#mode-checks)).
  - **A raise** then brings up the app's approval as a PermissionRequest, which the bridge allows as kind mode (S4). A change that doesn't raise brings none.
  - **A session gets the mode hook only when it starts** ([The plugin's hooks.json](#the-plugins-hooksjson)). In a session started before its plugin had the hook, a change from Auto is either refused, which the mod reports as `refused`, or never answered, which the deck fails after 60 s with "no result".

There are no model or effort commands: the deck shows them and never changes them (the user's answer after S4).

A command the mod won't run gets `failed` with the reason: an unknown `t`, a prompt with blank text, or a `mode` outside the four. The mod skips a command without a string `id`, and runs an `id` delivered twice since its last hello only once.

**`POST /v1/result`** body: `{"sid", "host", "inst", "id", "state", "error"?, "detail"?}`.
- `waiting`: a prompt was taken, and the mod is waiting for the engine to submit it. Sent once, before the final state; mode commands skip it.
- `done`, final: the prompt was submitted, or the mode changed. A mode command's `done` always has `detail`: the app's text, possibly empty.
- `refused`, final: the engine or the app said no, and `error` says why. A prompt `$.prompt.submit` drops gets `"dropped: <the engine's reason>"`, for example `"dropped: the session was stopped and nobody has sent input since"` after the user pressed Esc (S2). A mode change the app refuses gets the tool's text. A mode change the engine refuses, as the auto-mode classifier can from Auto, gets the engine's reason. The mods API has no typed refusal, so the mod reads it from the engine's own words, `$.mcp.call(<server>, <tool>) refused: <reason>` in 2.1.309, and reports a rejection worded otherwise as `failed`.
- `failed`, final: the mod's call threw for any other reason, and `error` carries the message.
- A result for an unknown or finished command is ignored (204), and so is one with no `inst`, or from an `inst` other than the one its command was delivered to.

The Saved Prompt key shows waiting, sent (`done`) or refused (`refused` or `failed`), as kickoff answer 6 asks. While its last prompt is still queued, delivered or waiting, another press alerts and queues nothing. A prompt or mode press also alerts when the target has ended, has no plugin, or has no current instance ([Identity](#identity)).

## Events

**`POST /v1/events`** body: `{"sid", "host", "inst", "seq", "events": [...]}`.
- `seq` starts at 1 for each `inst` and goes up by one per request. The bridge drops a request whose `seq` isn't above the last it saw for that `inst`, such as a retry.
- The mod sends its events and results on one ordered line, one request at a time per session, each after the previous answer, so a mode command's `done` comes before its `settings`. Its long poll runs beside that line. Version 1 puts one event in each request; the bridge accepts any number.
- Every event has `t`, its type, and `at`, milliseconds since the epoch by the mod's clock. Events from a subagent's loop carry `agent`, the engine's `agentId`; the main loop's carry none. An `agent` that isn't a non-empty string counts as none.

| `t` | Fields | From the mod's | Meaning |
|---|---|---|---|
| `turn.start` | `turn`, `agent`? | `turn.start` | A turn began. |
| `turn.end` | `turn`, `agent`?, `reason` | `turn.complete` | A turn ended. `reason` as the engine gives it: `answer` normally, also after the deck's Deny; `aborted` after Esc (S2). |
| `failed` | `error`?, `agent`? | `classic.StopFailure` | The turn failed, for example on an API error. |
| `tool.start` | `tool`, `use`, `agent`?, `summary`, `fp` | `tool.call`, before `next` | A tool call began. It may still be waiting for permission. |
| `tool.end` | `tool`, `use`, `agent`?, `fp`, `ok`, `denied`? | `tool.call`, after `next` | The call ended: it ran (`ok` is false if it errored), or it was refused (`denied` holds the reason, and `ok` is false). |
| `measure` | `context: {percent?, tokens?, window}`, `cost`?: `{usd}` | `session.measure` | Context use or cost changed. `percent` and `tokens` are missing until the engine has them. |
| `settings` | `model`?, `mode`?, `effort`? | `$.session.model()` after each main-loop turn and once each hello is answered; `permission_mode` and `effort.level` in the main loop's classic UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop and StopFailure inputs; a finished mode command | One of them changed. Only the changed fields are sent, and `mode` always after a finished mode command. |
| `attach`, `detach` | `surface` | `session.attach`, `session.detach` | The session came on screen in the app, or left it (S3). |
| `end` | `reason` | `session.end` | The session is ending. With reason `clear`, only its conversation was cleared: the mod carries on under the new `sid` with the same `inst`. The deck takes a session's end from the registry, never from this event. |

`use` is the engine's `tool_use_id`. `tool` is the name a PermissionRequest would carry: `mcp__<server>__<tool>` for MCP tools.

A call refused at the permission prompt, by the deck's Deny or the app's own, reaches the mod as an errored result with the standard rejection text (ladder step 4). Its `tool.end` therefore has `ok: false` and no `denied`. `denied` comes only from a hook's own refusal.

The mod's own submissions and tool calls never reach its own hooks (S3), so the deck's prompts appear only through `/v1/result`.

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
1. **The registry,** `~/.claude/sessions/<pid>.json`, read every second: `sessionId`, `hostSessionId`, `name`, `cwd`, `status` (`idle`, `busy` or `waiting`), `statusUpdatedAt` and `startedAt`. Missing fields are tolerated, and the `.key` files beside them are never read. Entries can live under a second (S5).
   - **A session has ended** when no file lists its `host` any more.
   - **Two files can list one `host`,** as for a moment when a session's process restarts. The deck shows the one with the later `startedAt`, and confirms a `session_id` or `sid` against any of them ([Desktop sessions only](#desktop-sessions-only)).
   - **A reading that can't list the folder changes nothing:** the deck keeps its last reading, and warns once until a reading succeeds. A folder that doesn't exist is no sessions. A file that can't be read or parsed keeps its last good reading, or is left out if it has none.
2. **The app's records,** `~/Library/Application Support/Claude/claude-code-sessions/*/*/<host>.json`, read when a session appears and again when its file changes: `model`, `effort`, `permissionMode`, `lastFocusedAt`, `postTurnSummary`, `postTurnSummaryFor`, `lastAssistantUuid` and `turnWrapUp`. Read only.
3. **The bridge,** for sessions with the plugin: hello, events and held requests.

**Model, effort and mode:** the latest of the plugin's `hello` (only `model` from the current instance's hello said again, [Identity](#identity)) and `settings`, and of `permission_mode` and `effort.level` in the session's PermissionRequests; with none of those, the app's record, which lags a change made inside the engine (S4).

**Status,** the first that applies:
1. `approval`: the bridge holds a `tool` request for the session.
2. `needs-you`: the bridge holds an `ask` request for it; or the registry says `waiting` and nothing is held for it (a session without the plugin, or a request lost when the deck restarted).
3. `working`: the registry says `busy`. With the plugin, the summary of the main loop's latest unfinished `tool.start` says on what.
   - **A `busy` that began before the main loop's last turn ended with reason `aborted` doesn't count,** and rules 4–8 take the session as idle. After a turn, Claude Code keeps the session `busy` until a moment when the mod has no request open ([Commands](#commands)), and the deck reads the registry once a second, while the plugin's `turn.end` arrives within milliseconds (Phase 4).
   - **The `busy` began before** when its `statusUpdatedAt` is at or before the moment the deck got that `turn.end`. Without that field, it began before when the deck's first reading of it came at or before then. Its first reading is the first that showed the session `busy` since one showed it otherwise. A session's very first reading counts.
   - **Also `working` from the main loop's `turn.start`:** while its latest `turn.start` has no `turn.end` or `failed` after it, and the registry says `idle` with an `idle` that began at or before the moment the deck got that `turn.start`. The plugin's `turn.start` arrives within milliseconds, while the deck reads the registry once a second and Claude Code writes `busy` a moment into the turn. The `idle` began at or before then as the `busy` above began before: by its `statusUpdatedAt`, or without it by the deck's first reading of it. An `idle` that began later means the turn ended unseen, and doesn't count.
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

**The target session** for prompts and mode is the one last picked on the Sessions dial. If it ends, it stays the target, and presses alert until another is picked: a prompt never goes to a session the user didn't pick. Until one is picked, it's the session most recently on screen in the app. For each session, that's the later of its latest `attach` (when the deck got it) and its record's `lastFocusedAt`. That refines kickoff answer 4 with S3's finding.

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
- **The deck plugin restarts with requests held:** their connections drop, the hooks get no decision, and the app's dialogs stay up. The sessions still read `waiting` in the registry, so the deck shows them as `needs-you`. Queued and in-flight commands are lost.
- **The hook's timeout** is 600 s. After it, Claude Code drops the hook and the dialog stays. The bridge sees the connection close and releases the request.
- **The mod reloads:** see `inst` in [Identity](#identity).
- **After a reboot,** macOS 26 can refuse loopback for minutes: the bridge retries listening with backoff (1–30 s), and rescans everything on wake.

## Rates

- The mod sends events as they happen, one request at a time per session.
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
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__ccd_session_mgmt__set_session_permission_mode",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:47600/v1/pretool",
            "timeout": 5,
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
- **The mode hook's `matcher` names the app's mode tool alone,** so no other tool call waits on the deck. Its timeout is 5 s. The bridge answers at once, and a bridge that's down is no decision.
- **No `onFailure`** on either, so a failure is no decision.
- **`.claude-plugin/plugin.json` only describes the plugin:** its name, version, description and author. Claude Code 2.1.309 also loads hooks, servers and commands declared there, so it declares none, and these two hooks are all there is. `claude-code/plugin-tsc/sync-fixtures.mjs --check` holds the plugin to both.
- **Claude Code reads these hooks when a session starts.** A hot reload runs the new mod, but it doesn't add hooks to a running session (ladder step 4; the Auto spike, 2026-11-03). A session gets a new hook from its next start.
- Status comes from the mod, not from command hooks: one module per session instead of a process per event. In S1 the mod's events also arrived 5–25 ms before the async hooks'.

## Fixtures

`fixtures/*.jsonl` are example conversations, each a contract both sides test against. `make-fixtures.mjs` writes them, with `fixtures/vectors.json`: edit the generator, never the generated files. Every line is one JSON object:

| Line | Meaning |
|---|---|
| `{"note": "..."}` | Ignored. |
| `{"setup": {...}}` | The first line after the notes. `session`: the session the plugin side plays (`sid`, `host`, `model`, `cwd`, `token`). `registry`: the registry files (`pid` and the file's fields). `records`: the app's records, by `host`. |
| `{"mod": {"on": "<event>", "e": {...}, "result"?: {...}}}` | An engine event the mod sees. The plugin side runs the mod's hook for it, and `next(e)` resolves to `result` (default `{}`). |
| `{"engine": {"call": "<$ call>", "args": {...}, "returns": {...}}}` | The plugin side's fake `$` answers the mod's next call of that name with `returns`, after checking `args`. `prompt.submit` takes its one argument as `args`; `mcp.call` takes `{server, tool, args}`. |
| `{"plugin": {"as"?: "<label>", "method", "path", "headers"?, "body"?, "raw"?}}` | A request the plugin sends. The plugin side checks the mod sent it; the deck side sends it to the bridge. `raw` is a body sent as is. |
| `{"reply": {"to": "<label>", "status", "body"?}}` | The bridge's answer to the labeled request. |
| `{"press": {...}}` | The user presses something on the deck: `{"approve": {}}`, `{"deny": {}}`, `{"prompt": {"session": "<host>", "text": "..."}}` or `{"mode": {"session": "<host>", "mode": "..."}}`. Approve and Deny press whatever the key shows. |
| `{"registry": {"pid", ...}}` | A registry file changes: the given fields are set, and `{"gone": true}` deletes the file. A line for a file that's gone writes it anew, with `pid` and the given fields. |
| `{"expect": {...}}` | The deck's state now. `sessions`: the hosts the deck lists (exact, any order). `held`: the held requests, oldest first, each `{host, tool, kind, summary}` (exact list, partial objects). `status`: `{host: status}`. `doing`: `{host: summary}` of the current tool, `null` for none. `context`: `{host: percent}`. `settings`: `{host: {model, effort, mode}}`, partial. `cmds`: `{label: state}` of commands, where a queued but undelivered one is `queued`. `jumped`: the `host` the last press jumped to. `alert`: whether the last press alerted. |

**The plugin side** (Track A's runner, with `claude plugin test` and a fake `$`):
- It plays the session in `setup.session`. It skips fixtures without `mod` lines, and lines about other sessions.
- It skips `press`, `registry` and `expect` lines, and `plugin` and `reply` lines for `/v1/permission` and `/v1/pretool`, which Claude Code sends, not the mod.
- It answers `$.session.id()`, `.model()`, `.cwd()` and `$.env.get` from `setup.session`. It plays a desktop session of its own: `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`, and `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_CODE_TAGS` are unset.
- It answers the mod's `/v1/hello` with `{"v": 1, "ok": true}` and its events and results with 204, unless a `reply` line says otherwise. It answers a poll only from a `reply` line; with none, the poll stays open to the end.
- It moves the mod's clock only when a line waits on it: by 1 s for a poll after an early empty answer, and by 100 ms for a hello after a rejected fetch or a 409 `hello first`. The mod logs nothing in any fixture.

**The deck side** (Track B's runner, against the real bridge on an ephemeral port, with a fake registry folder and records folder):
- It skips `mod` and `engine` lines.
- It sends `plugin` lines in order, `*` values as they are. It adds the right token and Host to the line's headers unless the line sets them; in `headers`, `$TOKEN` stands for the right token, and `null` leaves the header out.
- It waits for each answer before going on, except for `/v1/permission` and `/v1/next`, which may be held: a later `reply` line checks those, waiting up to 2 s. Answers to hello, events and results must be 200 or 204 unless a `reply` line says otherwise.
- It applies `press` lines through the actions' own handlers, and `registry` lines to the fake folder, then lets the watcher see the change. Before a `press` or `registry` line that follows a held request (`/v1/permission` or `/v1/next`), it makes sure the bridge has taken that request.
- It retries an `expect` for up to 1 s before failing, since requests and registry changes land asynchronously.
- It gives the deck a wall clock that follows the registry's times in the fixture. These are absolute around T0 = 1793600000000 (2026-11-02T06:13:20Z). The clock starts at the setup's `statusUpdatedAt` and moves up to each registry line's.
  - Release rules 2 and 3 and status rule 3 compare arrival times on that clock with `statusUpdatedAt`. An event's `at` is the mod's clock and plays no part.
  - A fake bridge may judge all three by what it saw instead.
- It turns off the deck's 1 s wait before a press counts, since a fixture's press is a deliberate press on what the key shows.
- A runner that plays fixtures to a deck it didn't reset binds each fixture `inst` to a fresh one per play, or the deck drops the replay's events as retries.

**Matching:**
- Every field of an expected object must be present and equal; extra fields are allowed. `"*"` matches any value. Arrays match when they have the same length and each element matches, in order.
- Answers to `/v1/permission` and `/v1/pretool` are checked more strictly. An expected `{}` means no decision, so the answer must have no `hookSpecificOutput`. Every 2xx answer, whatever the line expects, must be one of the bodies its route allows: the three in [Permission requests](#permission-requests), or the two in [Mode checks](#mode-checks). Any other status on any route must carry `{"error": "<reason>"}`, as [Transport](#transport) says.
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
