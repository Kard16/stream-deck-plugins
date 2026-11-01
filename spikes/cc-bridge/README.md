# Spike bridge and spike plugin (Claude Code side, Phase 1)

Tools for spikes S0–S4 in `docs/claude-code/plan.md`:

- `bridge.mjs`: a Node 24 server with no dependencies. It logs every request from the spike plugin, holds PermissionRequest hooks until you answer them, queues commands for the mod, and watches the session registry.
- `ctl.mjs`: a tiny CLI for the bridge's control endpoints.
- `../cc-plugin/`: the Claude Code plugin `deck-spike`. A logging command hook on every event, two PermissionRequest hooks that can decide, and a mod.

Both built against the desktop app's bundled Claude Code **2.1.309**.

## Run the bridge

```sh
mise exec -- node spikes/cc-bridge/bridge.mjs
```

It listens on TCP `127.0.0.1:47600` and on the Unix socket `spikes/cc-bridge/run/bridge.sock` (mode 0600), and reads the token from `spikes/cc-bridge/run/token`. Ctrl-C (or SIGTERM) answers any held request with `{}`, closes and removes the socket.

| Flag | Env | Default |
|---|---|---|
| `--port N` (0 = ephemeral) | `PORT` | 47600 |
| `--sock PATH`, or `none` | `BRIDGE_SOCK` | `run/bridge.sock` |
| `--token-file PATH` | `BRIDGE_TOKEN_FILE` | `run/token` |
| `--results DIR` | `BRIDGE_RESULTS_DIR` | `spikes/results` |
| `--sessions-dir DIR` | `CC_SESSIONS_DIR` | `~/.claude/sessions` |
| `--hold-cap-ms N` | `BRIDGE_HOLD_CAP_MS` | 590000 |
| `--registry-ms N` | `BRIDGE_REGISTRY_MS` | 250 |
| `--no-registry` | | watcher on |
| `--all-polls` | | empty `/mod/next` polls not printed |

The token is never logged or printed. A request body that contains it is logged with `<token>` in its place and `redacted: true`.

## Where results go

Each run writes `spikes/results/<YYYYMMDD-HHMMSS>-cc/` (gitignored):

- `bridge.json`: ports, paths, pid, start time, starting policy.
- `events.jsonl`: one line per request, and one per response or close.
  - Every line: `kind` (`request`, `response` or `close`), `t` (ms since epoch), `mono` (ms since the bridge started, `performance.now`), `conn` (`tcp` or `unix`), `method`, `path`, `query` if any.
  - Request lines: `auth` (`match`, `mismatch` or `absent`), plus `authLiteral: true` when the literal `$DECK_TOKEN` arrived and `authDetail` on a mismatch (`literal $DECK_TOKEN`, `empty bearer`, `not a Bearer header`). Also `ua` (user agent), `host`, `body` (parsed JSON, else the text), and `event` and `sessionId` where known.
  - Response lines: `status`, `ms`, and the `body` where it says something (permission answers, commands handed out, control results).
  - Permission requests carry `id` (`p1`, `p2`…) and `via` on every line. Their response or close line adds `end` (`answered`, `client-closed`, `timeout` or `shutdown`), `heldMs`, `by` (`control`, `policy`, `cap`, `via-mismatch`, `policy-none`) and `decision` (`allow`, `deny`, `none`).
- `registry.jsonl`: changes to `~/.claude/sessions/*.json`, read every 250 ms. The `.key` files are never opened.
  - `added` (with `initial: true` for files there at start), `changed` (`{field: {from, to}}`), `removed` (with the `last` fields).
  - Only `pid`, `sessionId`, `hostSessionId`, `cwd`, `name`, `nameSource`, `status`, `statusUpdatedAt`, `updatedAt`, `kind`, `entrypoint`, `version` are logged. Any other top-level key is logged by name only: `otherKeys`, then `otherKeysAdded` and `otherKeysRemoved`.
  - `unreadable`: a file that didn't parse, usually half-written. It's read again next tick and isn't counted as removed.

Stdout gets one compact line per request, held-request ending and registry change, for example:

```
13:23:39.672 tcp  POST /hook/PreToolUse 204 match abcdef12 Bash
13:23:39.689 tcp  POST /permission p1 match abcdef12 Bash: rm -rf build HOLD
13:23:39.789       p1 answered deny (control) after 0.1s
13:23:41.296       p2 timeout none (cap) after 1.5s
13:23:41.405       registry ~ 777 abcdef12 status="busy"
```

Empty `/mod/next` polls (one a second per session) go to `events.jsonl` but not to stdout, except each session's first poll. `--all-polls` prints them all.

Handy reads, from the run folder:

```sh
jq -c 'select(.kind != "request") | select(.id) | {id, end, by, decision, heldMs}' events.jsonl
jq -c 'select(.kind == "request" and (.path | startswith("/hook/"))) | {t, event, sessionId, auth}' events.jsonl
jq -c 'select(.kind == "changed") | {t, file, changed}' registry.jsonl
```

## Endpoints

| Endpoint | From | Answer |
|---|---|---|
| `POST /hook/<Event>` | `bin/hook.sh`, every classic event | 204 |
| `POST /permission` | the http PermissionRequest hook | held per the policy; decision JSON or `{}` |
| `POST /permission-cmd` | `bin/permission.sh` | the same |
| `POST /mod/hello`, `/mod/event`, `/mod/result` | the mod | 200 `{}` |
| `GET /mod/next?sid=<session id>` | the mod, every second | `{"cmds": [...], "policy": {...}}` |
| `GET /control/state` | you (TCP only) | sessions, held, recent, queued, policy, registry |
| `POST /control/policy` | you | `{"ok": true, "policy": {...}}` |
| `POST /control/answer` | you | `{"ok", "id", "wasOpen", ...}` |
| `POST /control/queue` | you | `{"ok": true, "id", "sid", "queued"}` |

`/mod/next` drains that session's queue and any commands queued for `*`. Those go once, to the first session that polls. The mod's `unixFetch` check polls as `sid=probe`, which never takes `*` commands. Control endpoints over the Unix socket answer 403.

`/control/state` returns:
- `sessions`, by session id: `hostSessionId`, `cwd`, `ppid` (from `hook.sh`), `firstSeen`, `lastSeen`, `lastEvent`, `lastPoll`, and `counts` by source (`hook`, `permission`, `mod`, `poll`).
- `held`: the open permission requests, with `id`, `via`, `sessionId`, `tool`, `input` (a summary) and `ageMs`. `recent`: the last 10 that ended, with `end` and `heldMs`.
- `queued`, `policy`, and `registry` (the current files' logged fields).

## ctl

`PORT` from the environment (default 47600). It sends the token from `run/token` and never prints it.

```sh
node spikes/cc-bridge/ctl.mjs state
node spikes/cc-bridge/ctl.mjs policy '{"permission":{"via":"cmd"}}'
node spikes/cc-bridge/ctl.mjs answer p1 allow
node spikes/cc-bridge/ctl.mjs answer oldest deny '{"message":"No from the deck","interrupt":true}'
node spikes/cc-bridge/ctl.mjs answer p2 allow '{"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}'
node spikes/cc-bridge/ctl.mjs queue <session id or *> '{"t":"submit","text":"List the files here.","asUser":true}'
```

(`mise exec -- node` if the shell's `node` isn't 24; ctl works on 22 too.)

## The policy

```json
{
  "permission": {
    "via": "http",
    "action": "hold",
    "delayMs": 0,
    "interrupt": false,
    "message": "optional",
    "updatedPermissions": ["optional"],
    "updatedInput": {"optional": true}
  },
  "toolCheck": "pass",
  "classicPermission": "pass"
}
```

`POST /control/policy` merges into it. `permission` merges field by field; `null` removes `message`, `updatedPermissions` or `updatedInput`. An unknown field or value gets 400 and changes nothing.

- `permission.via`: which hook the bridge holds, `http` (`/permission`) or `cmd` (`/permission-cmd`). The other endpoint answers `{}` (no decision) at once. Both hooks fire on every PermissionRequest.
- `permission.action`:
  - `hold` (default): held until `/control/answer`, until the client closes it, or until the cap (590 s, under the hooks' 600 s timeout), which answers `{}` with `end: timeout`.
  - `allow` or `deny`: answered by the bridge after `delayMs`. Allow carries only `updatedInput` and `updatedPermissions`; deny only `message` and `interrupt` (when true). So leftovers from an earlier test never ride along.
  - `none`: `{}` at once.
- `toolCheck` (the mod's `tool.check` hook): `ask` or `deny` answers `{decision, reason: "deck spike"}`; `pass` returns the engine's own verdict.
- `classicPermission` (the mod's `classic.PermissionRequest` hook): `allow` answers `{decision: {behavior: "allow"}}`, `deny` answers `{decision: {behavior: "deny", message: "deck spike"}}`. **The settings hooks run beneath the mod's hook**, the plugin's own http and command hooks included, so with `allow` or `deny` they never fire. `pass` lets them run.

The mod reads the policy on each poll, so a change reaches it within a second.

## Answers

`POST /control/answer` takes `{"id": "p1" | "oldest", "decision": "allow" | "deny" | "none", "message"?, "interrupt"?, "updatedPermissions"?, "updatedInput"?}`. It builds:

```json
{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}
```

with whichever extras you give, as given: a non-empty `message`, `interrupt` only when `true`, `updatedPermissions` (an array), `updatedInput` (an object). Per the d.ts, allow takes `updatedInput` and `updatedPermissions` and deny takes `message` and `interrupt`. `none` answers `{}`. `permission.sh` prints the same JSON. The reply says `wasOpen: true`, or `wasOpen: false` with how the request had already ended.

## Mod commands

Queue with `ctl queue <sid> '<json>'`. Each runs on its own, and its outcome comes back as `POST /mod/result` `{id, t, ok, result | error, ms}`.

| Command | Runs |
|---|---|
| `{"t":"submit","text":"…","asUser":true}` | `$.prompt.submit({text, asUser})`. Resolves as the turn starts; `ok: false` when dropped. `asUser` optional. |
| `{"t":"command","command":"model","args":"haiku"}` | `$.command.run({command, args})`: the name without its slash, `args` optional. |
| `{"t":"config","key":"…","value":…}` | `$.config.set`; `ok: false` on a deny. |
| `{"t":"configList"}` | `$.config.list()` |
| `{"t":"usage","breakdown":"summary"}` | `$.session.usage()`; `breakdown` (`summary` or `full`) optional. |
| `{"t":"model"}` | `$.session.model()` |
| `{"t":"status","text":"…"}` | `$.ui.status`; no `text` clears it. |
| `{"t":"toast","text":"…"}` | `$.ui.toast` |
| `{"t":"notice","tool_use_id":"toolu_…","text":"…"}` | `$.ui.notice`: a line under that call's open dialog. The id is in the hook and mod events for the call. |
| `{"t":"abort"}` | `$.turn.abort` on the last main-loop turn the mod saw start; `turnId` overrides. |
| `{"t":"check","tool":"Bash","input":{"command":"ls"}}` | `$.tool.check`: the verdict, nothing runs. |
| `{"t":"env","name":"CLAUDE_CODE_MESSAGING_SOCKET"}` | `$.env.get`. It takes string literals only, so just the names spelled in `register.ts` work: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_PLUGIN_DIR_WATCH`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_CONFIG_DIR`, `CLAUDE_EFFORT`, `PWD`. `DECK_TOKEN` and `CLAUDE_CODE_MESSAGING_TOKEN` answer only `{set}`. |
| `{"t":"unixFetch"}` | `GET /mod/next?sid=probe` over `run/bridge.sock` with `socketPath`; reports the status. `socketPath` overrides. |

Anything else answers `ok: false`, `unknown t`. An `id` is added (`c1`, `c2`…) unless you give one.

## The plugin, `spikes/cc-plugin/` (`deck-spike`)

Loaded with `CLAUDE_CODE_PLUGIN_DIRS` through the `deck-sandbox` preset and the `claude-code/sandbox-plugin` link. Nothing in it assumes its own path: the scripts find `run/token` from their physical folder, and the mod resolves `$.plugin.root` to its real path.

- `.claude-plugin/plugin.json`: the manifest.
- `hooks/hooks.json`: the classic hooks, plus `"modules": ["./register.ts"]`. `claude plugin validate` accepts both in one file.
  - An async `bin/hook.sh <Event>` on each of the 33 events whose `hook_event_name` literals the 2.1.309 d.ts holds, timeout 10 s.
  - PermissionRequest also has an http hook to `/permission` (timeout 600, `Authorization: Bearer $DECK_TOKEN`, `allowedEnvVars: ["DECK_TOKEN"]`, no `onFailure`) and the command hook `bin/permission.sh` (timeout 600). Neither is async.
- `bin/hook.sh`: adds `event`, `t_ms`, `ppid` and `env` (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `DECK_TOKEN_present`) to the input object. On a clash the input's own field wins. It POSTs with `curl -m 2`, prints nothing and exits 0.
- `bin/permission.sh`: POSTs its input to `/permission-cmd` (`curl -m 600`). It prints the answer only when it's a JSON object with content, and exits 0. Killed with TERM, INT or HUP, it kills curl at once, so the bridge sees the close. SIGKILL can't be caught.
- `hooks/register.ts`: the mod.
  - On `session.start`, after `next`, it starts polling `/mod/next` every second and posts `/mod/hello`: `$.session` (id, cwd, root, model, version, surfaces, turns, usage), the three ids from `$.env`, `DECK_TOKEN_present`, `$.plugin`, `$.config.list()` rows, `$.command.list()` (name, description, source), `$.tool.list()` names, and `errors` for any call that failed. `instance` changes on every load, so a hot reload shows as a new hello.
  - It authenticates with `DECK_TOKEN` from its environment, else the token file (`tokenSource` in the hello).
  - If the session id changes (a `/clear`), the next poll sends a new hello.
  - Event hooks post to `/mod/event`, fire and forget: `session.start`, `session.end`, `session.attach`, `session.detach`, `session.measure` (context % pushed after each turn, an addition), `turn.start`, `turn.complete`, `prompt.submit` (start and end), `tool.call` (start, and end with `isError`), `tool.check` (input and verdict), `classic.PermissionRequest` (start and end with the result beneath, or `answered`), `classic.Notification`, `classic.Stop`.
  - With the bridge down it posts nothing, keeps polling, and logs the first failure of each outage with `$.ui.log` at debug.
- `tests/register.test.ts`: the mod under `claude plugin test`, against a stub bridge.

For tests, `DECK_SPIKE_URL` (default `http://127.0.0.1:47600`) and `DECK_SPIKE_TOKEN_FILE` override the scripts' bridge and token file. The mod's bridge address is fixed.

## Checks

```sh
mise exec -- node --test spikes/cc-bridge/test.mjs
mise exec -- node lightroom/deck/node_modules/typescript/bin/tsc -p spikes/cc-tsc
CC="$HOME/Library/Application Support/Claude/claude-code/2.1.309/5af865b9901c/claude.app/Contents/MacOS/claude"
CLAUDE_CONFIG_DIR="$(mktemp -d)" "$CC" plugin validate spikes/cc-plugin
CLAUDE_CONFIG_DIR="$(mktemp -d)" "$CC" plugin test spikes/cc-plugin
```

`CLAUDE_CONFIG_DIR` keeps the binary from writing to `~/.claude/`: `validate` writes a `.claude.json` and `backups/` there. The node tests use ephemeral ports, temp sockets and a test token. They never bind 47600 or `run/bridge.sock`, and never read `run/token`.
