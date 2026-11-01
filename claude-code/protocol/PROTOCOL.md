# Bridge protocol, version 1

The wire protocol between the Claude Code plugin `streamdeck-bridge` (`claude-code/plugin/`), which runs inside Claude Code sessions in the Claude desktop app, and the Stream Deck plugin `com.karimdhanji.claude` (`claude-code/deck/`), which hosts the bridge. Frozen on 2026-11-01 from the Phase 1 results in `docs/claude-code/plan.md`, whose Log holds each finding cited here (S0–S6).

Changes go through the main thread. A change that breaks either side bumps `v`.

Contents: [Parties](#parties) · [Transport](#transport) · [Identity](#identity) · [Routes](#routes) · [Permission requests](#permission-requests) · [Held requests](#held-requests) · [Commands](#commands) · [Events](#events) · [Fingerprints and summaries](#fingerprints-and-summaries) · [The deck's session model](#the-decks-session-model) · [Failure and recovery](#failure-and-recovery) · [Rates](#rates) · [The plugin's hooks.json](#the-plugins-hooksjson) · [Fixtures](#fixtures) · [Amendments](#amendments)

## Parties

- **The permission hook:** an `http` PermissionRequest hook in the plugin's `hooks/hooks.json`. Claude Code posts the hook's input and waits for the answer, while the app shows its own dialog beside it. The first answer wins (S2).
- **The mod:** the plugin's `hooks/register.ts`, one instance per session, on the mods API of the app's Claude Code 2.1.309. It says hello, reports events, and fetches and runs the deck's commands.
- **The bridge:** the HTTP server inside the deck plugin.
- **The deck:** the rest of the deck plugin. It merges what the bridge hears with the session registry and the app's session records ([The deck's session model](#the-decks-session-model)).

Nothing else talks to the bridge, and the bridge never calls the plugin.

## Transport

- HTTP/1.1 on `127.0.0.1:47600`, IPv4 only. Clients use `127.0.0.1`, never `localhost` (S6).
- Every request carries:
  - `Host: 127.0.0.1:47600` or `localhost:47600`. Anything else gets 403, before the token is looked at. That stops a web page that rebinds a DNS name to 127.0.0.1.
  - `Authorization: Bearer <token>`. Missing or wrong: 401, with `WWW-Authenticate: Bearer realm="streamdeck"`.
- **The token** is the trimmed content of the deck plugin's `com.karimdhanji.claude.sdPlugin/run/token`, which the deck creates on first start (file `0600`, folder `0700`). The plugin reads it from the environment variable `DECK_TOKEN`: the `deck-sandbox` preset sets it during development, and Phase 5 decides how the user's own sessions get it. Neither side ever logs it.
- Bodies are JSON in UTF-8, at most 8 MiB (413 above). A body that isn't JSON gets 400, an unknown route 404, a wrong method 405. Error answers are `{"error": "<reason>"}`.
- Unknown fields are ignored on both sides, so either side can add fields without a version bump.
- No CORS headers.

## Identity

- **`sid`:** Claude Code's session id, a UUID. The mod reads it with `$.session.id()`; the hook's body has it as `session_id`. It can change during a session's life (the app's records keep `priorCliSessionIds`), so the deck doesn't key on it.
- **`host`:** the app's `local_…` id, fixed for the session's life, and what the jump link `claude://code/continue?session=<host>` takes (S5). The mod reads `CLAUDE_CODE_HOST_SESSION_ID` with `$.env.get`; the hook sends it in the header `X-Deck-Host`. When it's missing or empty, the bridge looks `sid` up in the registry.
- **`inst`:** a random id the mod picks each time it loads, hot reloads included. A new `inst` for the same `host` means the mod restarted: the deck forgets that session's current tool and its in-flight commands, and keeps the rest.
- The deck keys sessions by `host`.

## Routes

| Route | From | Does | Answer |
|---|---|---|---|
| `POST /v1/permission` | the hook | holds a PermissionRequest | 200, a decision or `{}` |
| `POST /v1/hello` | the mod | announces the mod | 200 `{"v": 1, "ok": true}` |
| `POST /v1/events` | the mod | reports events | 204 |
| `GET /v1/next` | the mod | fetches commands, long poll | 200 `{"cmds": [...]}` |
| `POST /v1/result` | the mod | reports how a command went | 204 |

Every mod request names its session with `sid`, `host` and `inst`: in the body, or for `GET /v1/next` in the query. The bridge accepts every route from a session it hasn't had `hello` from.

**`POST /v1/hello`** body: `{"v": 1, "sid", "host", "inst", "cwd", "model", "mode"?, "effort"?, "plugin", "cc"}`, where `model` is `$.session.model()`, `plugin` the plugin's version and `cc` Claude Code's. The mod sends it when it loads, before any other request, and waits for the answer. It sends it again when the bridge answers after a failed request, since the deck may have restarted. A deck on another version answers `{"v": <its own>, "ok": false, "error": "version"}`; the mod then stops talking to the bridge until it reloads, and logs that once.

## Permission requests

`POST /v1/permission`: the body is the hook's input as Claude Code sends it. The bridge reads `session_id`, `tool_name`, `tool_input`, `permission_mode` and `effort`, and the header `X-Deck-Host`. There's no `tool_use_id` in it (S2).

The bridge sorts each request into one kind:
- **mode:** `tool_name` is `mcp__ccd_session_mgmt__set_session_permission_mode`, `tool_input.session_id` is `"self"`, and the same session has a `mode` command in flight ([Commands](#commands)) whose `mode` equals `tool_input.mode`. The bridge answers Allow at once. It's the only answer the bridge gives without a key press, and a key press started it (the user's answer after S4).
- **ask:** `tool_name` is `AskUserQuestion` or `ExitPlanMode`. Held for display only: the deck never answers it, and a press on it jumps to the session (kickoff answer 3).
- **tool:** everything else, the app's mode tool included when no matching command is in flight. Held until Approve or Deny, or released ([Held requests](#held-requests)).

Answers, all 200:
- **Allow:** `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}`
- **Deny:** `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Denied from the Stream Deck.", "interrupt": true}}}`. The turn stops, as with the app's own No. Claude gets the standard rejection text, not the message (S2), but S2 verified this shape with a message, so it stays.
- **No decision:** `{}`. The app's dialog decides.

The deck never sends `updatedPermissions` or `updatedInput`.

## Held requests

- A held request belongs to a session, and has its kind, `tool`, `summary` and `fp` ([Fingerprints and summaries](#fingerprints-and-summaries)) and the time it arrived. The bridge holds any number, from any number of sessions.
- **Approve and Deny** act on the oldest held request across all sessions, and only on the one the key showed when pressed (S6). On a `tool` request, Approve answers Allow and Deny answers Deny. On an `ask` request, either press jumps to its session and answers nothing.
- **Answering in the app doesn't end the hook's request** (S2), so the bridge releases a held request with `{}` at the first of:
  1. The mod reports `tool.end` with the same `fp`, from the same session.
  2. The registry shows the session leaving `waiting`, and this is the session's only held request, held from before that change.
  3. The registry shows the session `idle`, with a `statusUpdatedAt` after the request arrived.
  4. The session's registry file disappears.
  5. The client closes the connection: the hook's 600 s timeout, or the session ended.
- A press for a request that's gone does nothing, and the key shows an alert (S6).
- Nothing else answers a held request: the bridge has no timeout of its own and no default.

## Commands

The deck queues commands for a session when the user presses a key. The mod fetches them with a long poll.

**`GET /v1/next?sid=<sid>&host=<host>&inst=<inst>&wait=<s>`**
- With commands queued for that session, it answers them at once, oldest first.
- Otherwise it holds the request up to `wait` seconds (0–20, default 20; 0 answers at once) and answers as soon as a command is queued, or with `{"cmds": []}` when the time is up.
- One open poll per session: a new poll answers any older one from the same session with `{"cmds": []}` at once.
- A command answered to a poll is in flight until its final result arrives, or for 60 s. After that it counts as failed, with "no result".
- The mod polls again as soon as a poll answers. After a failed poll it waits as in [Failure and recovery](#failure-and-recovery).

**Command shapes.** `id` is a string the deck picks, unique within the bridge's run.
- `{"id": "c1", "t": "prompt", "text": "..."}`: the mod calls `$.prompt.submit({text, asUser: true})`. The engine holds it until the session is idle (S3).
- `{"id": "c2", "t": "mode", "mode": "acceptEdits"}`: the mod calls `$.mcp.call("ccd_session_mgmt", "set_session_permission_mode", {session_id: "self", mode})`. `mode` is `default` (the app's Manual), `acceptEdits`, `plan` or `auto`, never `bypassPermissions`. Every change raises a PermissionRequest for that tool, which the bridge allows as kind mode (S4). After `done`, the mod sends a `settings` event with the new mode.

There are no model or effort commands: the deck shows them and never changes them (the user's answer after S4).

**`POST /v1/result`** body: `{"sid", "host", "inst", "id", "state", "error"?, "detail"?}`.
- `waiting`: a prompt was taken, and the mod is waiting for the engine to submit it. Sent once, before the final state; mode commands skip it.
- `done`, final: the prompt was submitted, or the mode changed. `detail` may carry the app's text.
- `refused`, final: the engine or the app said no, and `error` says why. A prompt `$.prompt.submit` drops gets `"dropped: <the engine's reason>"`, for example `"dropped: the session was stopped and nobody has sent input since"` after the user pressed Esc (S2). A mode change the app refuses gets the tool's text.
- `failed`, final: the mod's call threw, and `error` carries the message.
- A result for an unknown or finished command is ignored (204).

The Saved Prompt key shows waiting, sent (`done`) or refused (`refused` or `failed`), as kickoff answer 6 asks.

## Events

**`POST /v1/events`** body: `{"sid", "host", "inst", "seq", "events": [...]}`.
- `seq` starts at 1 for each `inst` and goes up by one per request. The bridge drops a request whose `seq` isn't above the last it saw for that `inst`, such as a retry.
- The mod sends one request at a time per session, in order, each after the previous answer. Version 1 puts one event in each; the bridge accepts any number.
- Every event has `t`, its type, and `at`, milliseconds since the epoch by the mod's clock. Events from a subagent's loop carry `agent`, the engine's `agentId`; the main loop's carry none.

| `t` | Fields | From the mod's | Meaning |
|---|---|---|---|
| `turn.start` | `turn`, `agent`? | `turn.start` | A turn began. |
| `turn.end` | `turn`, `agent`?, `reason` | `turn.complete` | A turn ended. `reason` as the engine gives it: `answer` normally, also after the deck's Deny; `aborted` after Esc (S2). |
| `failed` | `error`? | `classic.StopFailure` | The turn failed, for example on an API error. |
| `tool.start` | `tool`, `use`, `agent`?, `summary`, `fp` | `tool.call`, before `next` | A tool call began. It may still be waiting for permission. |
| `tool.end` | `tool`, `use`, `agent`?, `fp`, `ok`, `denied`? | `tool.call`, after `next` | The call ended: it ran (`ok` is false if it errored), or it was refused (`denied` holds the reason, and `ok` is false). |
| `measure` | `context: {percent, tokens, window}`, `cost`? | `session.measure` | Context use changed. |
| `settings` | `model`?, `mode`?, `effort`? | `$.session.model()` after each turn; `permission_mode` and `effort.level` in classic hook inputs; a finished mode command | One of them changed. Only the changed fields are sent. |
| `attach`, `detach` | `surface` | `session.attach`, `session.detach` | The session came on screen in the app, or left it (S3). |
| `end` | `reason` | `session.end` | The session is ending. |

`use` is the engine's `tool_use_id`. `tool` is the name a PermissionRequest would carry: `mcp__<server>__<tool>` for MCP tools.

The mod's own submissions and tool calls never reach its own hooks (S3), so the deck's prompts appear only through `/v1/result`.

## Fingerprints and summaries

**`fp`** ties a held request to the tool call it was for.
- `fp = fnv1a32(tool + "\n" + canonical(input))`, written as 8 lowercase hex digits.
- `canonical(v)`: JSON with no spaces, keys sorted by UTF-16 code units (JavaScript's default sort), keys whose value is `undefined` left out, arrays in order, and strings, numbers, booleans and `null` as `JSON.stringify` writes them.
- `fnv1a32(s)`: start with `h = 0x811c9dc5`; for each UTF-16 code unit `c` of `s`, `h = Math.imul(h ^ c, 0x01000193) >>> 0`.
- The bridge takes `tool` and `input` from `tool_name` and `tool_input`. The mod takes them from `tool.call`'s `e`: `e.tool`, and `e` without `tool`, `tool_use_id`, `agentId`, `requestMeta` and any other keys the API reserves (`ToolCallReserved` in the vendored d.ts).
- Should the two sides' fingerprints differ for some tool, release rules 2–5 still apply, only later. Ladder step 4 logs both sides' values to check.

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
1. **The registry,** `~/.claude/sessions/<pid>.json`, read every second: `sessionId`, `hostSessionId`, `name`, `cwd`, `status` (`idle`, `busy` or `waiting`) and `statusUpdatedAt`. Missing fields are tolerated, and the `.key` files beside them are never read. A file that disappears is a session that ended. Entries can live under a second (S5).
2. **The app's records,** `~/Library/Application Support/Claude/claude-code-sessions/*/*/<host>.json`, read when a session appears and again when its file changes: `model`, `effort`, `permissionMode`, `lastFocusedAt`, `postTurnSummary` and `turnWrapUp`. Read only.
3. **The bridge,** for sessions with the plugin: hello, events and held requests.

**Model, effort and mode:** the latest of the plugin's `hello` and `settings`, and of `permission_mode` and `effort.level` in the session's PermissionRequests; with none of those, the app's record, which lags a change made inside the engine (S4).

**Status,** the first that applies:
1. `approval`: the bridge holds a `tool` request for the session.
2. `needs-you`: the bridge holds an `ask` request for it; or the registry says `waiting` and nothing is held for it (a session without the plugin, or a request lost when the deck restarted).
3. `working`: the registry says `busy`. With the plugin, the summary of the main loop's latest unfinished `tool.start` says on what.
4. `failed`: idle, and its last turn ended with `failed`.
5. `interrupted`: idle, and its last main-loop `turn.end` had reason `aborted`.
6. `needs-you`: idle, and the app's record says its last turn needs the user (`turnWrapUp.needsUser` or `postTurnSummary.needs_action` is true).
7. `done`: idle after a turn the deck saw end.
8. `idle`: otherwise.

**Context %:** the latest `measure`.

**The target session** for prompts and mode is the one last picked on the Sessions dial. Until one is picked, it's the one most recently on screen in the app: the latest `attach`, or else the records' `lastFocusedAt`. That refines kickoff answer 4 with S3's finding.

## Failure and recovery

- **The bridge is down or restarting:** the hook can't connect, which Claude Code takes as no decision, so the app's dialog decides. The hook never has `onFailure: "block"`. The mod's requests fail: it backs off 1, 2, 5, 10 and 30 s, then every 30 s, logs once per outage, and says hello again when the bridge answers. It never holds up the session.
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
    ]
  },
  "modules": ["./register.ts"]
}
```

- No `matcher`, so every tool's request comes.
- No `onFailure`, so a failure is no decision.
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
| `{"registry": {"pid", ...}}` | A registry file changes: the given fields are set, and `{"gone": true}` deletes the file. |
| `{"expect": {...}}` | The deck's state now. `sessions`: the hosts the deck lists (exact, any order). `held`: the held requests, oldest first, each `{host, tool, kind, summary}` (exact list, partial objects). `status`: `{host: status}`. `doing`: `{host: summary}` of the current tool, `null` for none. `context`: `{host: percent}`. `settings`: `{host: {model, effort, mode}}`, partial. `cmds`: `{label: state}` of commands, where a queued but undelivered one is `queued`. `jumped`: the `host` the last press jumped to. `alert`: whether the last press alerted. |

**The plugin side** (Track A's runner, with `claude plugin test` and a fake `$`):
- It plays the session in `setup.session`. It skips fixtures without `mod` lines, and lines about other sessions.
- It skips `press`, `registry` and `expect` lines, and `plugin` and `reply` lines for `/v1/permission`, which Claude Code sends, not the mod.
- It answers `$.session.id()`, `.model()`, `.cwd()` and `$.env.get` from `setup.session`.
- It answers the mod's `/v1/hello` with `{"v": 1, "ok": true}` and its events and results with 204, unless a `reply` line says otherwise. It answers a poll only from a `reply` line; with none, the poll stays open to the end.

**The deck side** (Track B's runner, against the real bridge on an ephemeral port, with a fake registry folder and records folder):
- It skips `mod` and `engine` lines.
- It sends `plugin` lines in order, `*` values as they are. It adds the right token and Host to the line's headers unless the line sets them; in `headers`, `$TOKEN` stands for the right token, and `null` leaves the header out.
- It waits for each answer before going on, except for `/v1/permission` and `/v1/next`, which may be held: a later `reply` line checks those, waiting up to 2 s. Answers to hello, events and results must be 200 or 204 unless a `reply` line says otherwise.
- It applies `press` lines through the actions' own handlers, and `registry` lines to the fake folder, then lets the watcher see the change.
- It retries an `expect` for up to 1 s before failing, since requests and registry changes land asynchronously.

**Matching:**
- Every field of an expected object must be present and equal; extra fields are allowed. `"*"` matches any value. Arrays match when they have the same length and each element matches, in order.
- A `path` with a query matches when the route is equal and each listed parameter is present and equal; other parameters may be there too.
- `at` is never compared. The plugin side binds the mod's real `inst` to the fixture's at its first appearance.
- Command ids are `"c1"`, `"c2"`… The deck side binds the deck's real id to the fixture's name at its first appearance in a `reply`, and uses the real one from then on.
- Polls (`GET /v1/next`) are matched in order among themselves, apart from other requests, since a mod polls again while it runs a command.

## Amendments

None yet.
