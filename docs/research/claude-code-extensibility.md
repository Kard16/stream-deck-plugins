# Claude Code extensibility for a Stream Deck + integration

> Research thread report, 2026-10-31. The research agent couldn't write files, so the coordinating session saved this from its final report. Most documentation facts come from WebFetch summaries of live pages on code.claude.com. Spot-check quoted phrases before building on them. Community projects are labeled as such and are unverified.

**Context:** the user runs Claude Code mainly in the Claude desktop app's Code tab (Claude.app 4.4212.0, macOS 26.6.2). CLI 2.1.312 is also installed. Wanted: live status, approve/deny from the deck, prompt & mode buttons, multi-session control. Personal use only.

## Summary

### Difficulty: moderate

Documented hooks cover live status and approve/deny in the desktop app. The new **mods** API covers prompt submission, context usage, and a status band. Mods are in-process JavaScript, supported in the desktop app from v2.1.286. No documented external API exists for interrupt, mode, model, or effort on an existing desktop session. Those need macOS keystrokes, which are fragile.

### Versions (2026-10-31)

- CLI 2.1.312, per the docs changelog dated 2026-10-27. npm `latest` is 2.1.316; the registry JSON doesn't show a publish date.
- Desktop app 4.4212.0. The desktop app bundles its own copy of Claude Code, which can differ from the CLI; check `/status` in a Code-tab session.
- Mods need at least 2.1.286 in the desktop app. `claude --desktop` needs CLI 2.1.285 or later.

### Feasibility in the desktop app

| Item | Verdict | Mechanism |
|---|---|---|
| A. Live status | Yes | Hooks. UserPromptSubmit means working. PreToolUse/PostToolUse give `tool_name` and `cwd`. PermissionRequest and Notification(`permission_prompt`) mean approval is needed. Stop means done; StopFailure means error. |
| A. Context % | Partial | No documented desktop status line. Use mod `$.session.usage()` (documented; shape not fetched) or derive it from OTEL token counts. |
| A. Cost | Partial | OTEL `claude_code.api_request` carries `cost_usd` per request. It's a client-side estimate, not billing. |
| A. Model/effort | Yes | `SessionStart.model`, `PostModelSwitch.to_model`, and `effort.level` on tool and Stop payloads. |
| B. Approve/deny | Yes | A PermissionRequest command or http hook returns decision JSON. Hooks "run alongside your host, and whichever decides first applies." The desktop app uses the `canUseTool` host. |
| B. Send prompt | Yes via mods; partial otherwise | `$.prompt.submit({ text, asUser: true })` submits as the user's words once Claude is idle. It's refused after Esc until the user types. Fallbacks: an `asyncRewake` hook or an inbox-socket peer message. |
| B. Slash commands | Unverified | Through `$.prompt.submit`. |
| B. Interrupt | No API | Esc keystroke via Accessibility. A PermissionRequest deny with `interrupt: true` works only while a prompt is open. |
| B. Mode/model/effort | No API for existing sessions | Desktop keys Cmd+Shift+M/I/E (Accessibility). A PermissionRequest allow can carry `updatedPermissions` with `setMode` (exact JSON unverified). `permissions.defaultMode` affects new sessions only. |
| B. Jump to session | Partial | `claude --desktop --resume <session-id>` is documented; whether it focuses an already-open session is unverified. `open -a Claude` brings the app forward. No documented focus-by-URL. |
| C. Plugin | Yes | One plugin can ship hooks, mods, monitors, MCP servers, and `bin/`. A plugin cannot set the main statusLine. |

### Hard limits

- **Channels:** `--channels` is a CLI-only research preview and requires claude.ai or Console auth.
- **Remote Control:** cloud-relayed. The local process opens no inbound ports and has no local API.
- **Peer messages:** cross-session messages are framed as coming from another session.
  - In the desktop app, a message held for approval (in a bypass-class session) expires after `dialogExpiry`, default 5 min.
  - That doesn't happen if `dialogExpiry` is set to "never" or `crossSessionInbound` is "accept".
- **Hook timeouts:** default 600 s for command and http hooks; the maximum isn't stated.
  - `async` is command-only and skips timeout enforcement.
  - `asyncRewake` still enforces the timeout.
- **Sandboxed network requests:** PermissionRequest hooks don't run for them.
- **Transcript JSONL:** the format is internal and can change between releases.
- **Esc:** community reports say it emits no Stop hook (unverified for the desktop app).
- **WSL:** plugin hooks and mods don't run in WSL desktop sessions.
- **Plugin names:** can't start with `claude-`, `anthropic-`, `anthropics-`, or `cc-plugin-`.

### Recommended design

The Stream Deck plugin hosts a bridge bound to 127.0.0.1 and protected by a bearer token. A Claude Code plugin (e.g., `streamdeck-bridge`) contributes:

1. A PermissionRequest **http** hook to the bridge, timeout 120 s, **without** `onFailure: "block"`.
   - With `block`, a bridge outage would deny every tool call.
   - Without it, a timeout falls back to the in-app dialog.
2. Async curl command hooks for status events and Notification (`permission_prompt`, `idle_prompt`).
3. A mod that:
   - polls the bridge queue and submits prompts with `asUser: true`;
   - reads `$.session.usage()` for context %;
   - shows `$.ui.status`.
4. Optionally, OTEL export to a local receiver for cost and tokens.
5. Opt-in Accessibility keystrokes for interrupt, mode, model, and effort.

To jump to a session, run `claude --desktop --resume <session_id>`, then `open -a Claude`.

### Prior art (community)

- **Existing projects:** several hook-based Stream Deck projects exist (details in §9).
- **How approvals work:** approval-capable projects use PermissionRequest plus a localhost server. Their timeouts range from 45 s (fall back to the terminal) to 2 min (reject) to 24 h.
- **Gaps:**
  - None of the excerpts mention the desktop Code tab, mods, or full plan/question handling.
  - claude-deck excludes AskUserQuestion.

### Open questions

1. Is a pending PermissionRequest HTTP hook cancelled when the in-app dialog is answered first?
2. Does `claude --desktop --resume` focus an already-open session?
3. Is there a desktop status line? Test before assuming.
4. What are the exact mod method names for tool approval, the `$.session.usage()` shape, and session-id access?
5. Does `asyncRewake` wake an idle desktop session?
6. Does Stop fire on Esc in the desktop app?
7. What is the maximum hook timeout?
8. Do user-level OTEL env settings apply to Code-tab sessions?

---

## 1. Desktop-app answers

### Q1. Hooks in the desktop app

**What the docs say:**
- The desktop app "reads the same settings files as the CLI"; "Hooks and skills defined in settings apply to both."
- The hooks docs say Claude Code "fires the same hook events wherever it runs: terminal sessions, IDE extensions, the Desktop app, and cloud sessions."
- No desktop-specific exclusion found; verify with a logging hook.

**Common stdin fields:**
- `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`.
- `permission_mode`: default, plan, acceptEdits, auto, dontAsk or bypassPermissions. Manual mode arrives as `default`.
- `scratchpad_dir` (v2.1.257+) and `effort: {level}`.
- `agent_id`/`agent_type` in subagents.

**Per-event fields:**
- Tool events add `tool_name`, `tool_input`, `tool_use_id`.
- Stop/SubagentStop add `last_assistant_message`.
- SessionStart adds `source` (startup/resume/clear/compact/fork) and `model`.
- Notification adds `message`, `title`, `notification_type`.
- Model-switch events add `from_model`/`to_model`.

**The 33 events:** SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.

### Q2. Status line in the desktop app

Not documented:
- The statusLine page describes the terminal footer: ANSI colors, COLUMNS/LINES from the terminal, footer hints.
- The desktop guide and its CLI comparison table never mention it.

Treat it as CLI-only until tested. To test, add a statusLine that tees stdin to a file, then start a desktop session.

Next-best sources:

1. **Mod `$.session.usage()`.** It "returns context window use and plan limits." Documented, in-process, and mods run in the desktop app.
2. **OTEL `claude_code.api_request` events.**
   - Fields: `model`, `cost_usd`, `input_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `effort`, `query_source`, `session.id`.
   - Logs export every 5 s; metrics every 60 s.
   - OTEL has no context %. You can derive it the way the status line computes it: input + cache_creation + cache_read tokens of the latest main-chain request, divided by 200k or 1M. This is a derivation, not a documented equivalent.
3. **Transcript JSONL at `transcript_path`.**
   - Path: `~/.claude/projects/<cwd with non-alphanumerics replaced by ->/<session-id>.jsonl`.
   - The docs warn the format "is internal to Claude Code and changes between versions." Avoid it as a primary source.

### Q3. Permission prompts in the desktop app

- **Modes:** Manual (default), Accept edits, Plan, Auto (when available), Bypass (when enabled).
  - `dontAsk` is CLI-only.
  - Shift+Tab does not cycle modes in the desktop app; use Cmd+Shift+M.
- **Dialogs:**
  - Edits show a diff with accept/reject.
  - Computer-use and external-site approvals show Allow/Deny.
  - The docs don't describe the dialog for ordinary shell-command approvals.
- **Mechanism:** the desktop app hosts Claude Code through the Agent SDK `canUseTool` callback. For host sessions, hooks "run alongside your host, and whichever decides first applies."
- **PermissionRequest output** (see §11):
  - Allow may carry `updatedInput` (re-checked against deny/ask rules) and `updatedPermissions`.
  - Deny carries `message` and `interrupt`.
  - Exit code 2 is not honored; no decision means the normal flow continues.
- **Rules still apply:** a hook's allow can't override a matching deny rule.
- **`permission_prompt` notification:**
  - In host sessions it fires about 6 s after the request if nobody answers: "If you or a PermissionRequest hook answer sooner, Claude Code doesn't run permission_prompt."
  - Disable it with `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS=1`.
- **Not stated:** on-screen ordering, and what happens to a pending hook when the in-app answer arrives first.

### Q4. URL schemes and deep links

- **`claude://code/new?ssh_host=…&ssh_port=…&ssh_folder=…&q=…`** (desktop app).
  - Documented only for SSH targets (desktop v2.110.0+).
  - It pre-fills `q` but never sends it, and the app asks for confirmation before selecting the connection.
  - No documented local-folder form, session-ID parameter, or focus-existing-session link.
- **`claude-cli://open?cwd=&repo=&q=`** opens a terminal session, not the desktop app. Registration requires a prior prompt in an interactive CLI session.
- **`vscode://anthropic.claude-code/open`** opens a VS Code tab.
- **Opening a specific session in the desktop app** is documented only through the CLI:
  - `claude --desktop --resume <session-id>` (CLI v2.1.285+).
  - `--continue` opens the most recent session in this directory.
  - `/desktop` hands an active CLI session to the desktop app and exits the CLI.
  - Not stated: whether an already-open session gets focused or duplicated.
- **Undocumented (community, from the Stream Deck thread):** McTonnie's Windows-only "Claude Notify" plugin opens desktop sessions with `claude://code/continue?session=<id>`. Untested on macOS.

### Q5. Outside control of a desktop session

| Action | Mechanism | Desktop status |
|---|---|---|
| Approve/deny | PermissionRequest hook (decision JSON) | Documented; first decision wins |
| Send prompt | Mod `$.prompt.submit({text, asUser:true})` | Documented; idle-gated; refused after Esc until user input |
| Send prompt (fallback) | Hook `asyncRewake` with exit 2 | Documented for hooks; desktop unverified |
| Send prompt (fallback) | Inbox-socket peer message | Documented for scripts and hooks; framed as a peer message |
| Interrupt | Esc keystroke | Accessibility only; not an API |
| Mode/model/effort | Cmd+Shift+M/I/E keystrokes; PermissionRequest `setMode` on allow | Accessibility; hook path unverified |
| Remote Control | `/remote-control` in the Code tab; phone or web | Works, but cloud-relayed; no local API |
| Channels | `--channels plugin:…` | CLI-only ("Your machine (CLI)" in the Remote Control comparison table) |
| `claude --resume <bg> "prompt"` | CLI background sessions | CLI-only; attaches a terminal |
| `claude -p --resume <id>` | New run in a stored session | Not live injection; conflicts with a running process |

Desktop keys:

| Key | Action |
|---|---|
| Esc | Stop the response |
| Cmd+Shift+M | Mode menu |
| Cmd+Shift+I | Model menu |
| Cmd+Shift+E | Effort menu |
| 1–9 | Select a menu item |
| Ctrl+Tab / Ctrl+Shift+Tab, Cmd+Shift+] / [ | Switch sessions |
| Cmd+N | New session |

Keystroke injection needs macOS Accessibility permission for the sending app. That's macOS behavior, not something Anthropic documents.

Remote Control from the desktop app is also a backup approval path from a phone: "Claude Code keeps permission prompts and AskUserQuestion questions open until you answer them."

## 2. Plugin system

**Layout:**
- `.claude-plugin/plugin.json`: only `name` is required; kebab-case; reserved prefixes apply.
- Default folders: `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `themes/`, `workflows/`, `monitors/monitors.json`, `bin/`, `settings.json`.
- A plugin's `settings.json` honors only `agent` and `subagentStatusLine`, so **a plugin cannot ship the main statusLine**.

**Environment variables:**

| Variable | Meaning |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Versioned install dir; don't write state there |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/`; persists across updates |
| `${CLAUDE_PROJECT_DIR}` | The project directory |
| `CLAUDE_PLUGIN_OPTION_<KEY>` | userConfig values, passed to hook processes |

**userConfig:**
- Types: string, number, boolean, directory, file.
- `sensitive: true` goes to secure storage.
- Set values with `claude plugin configure`, or `--config KEY=VALUE` at install.

**Install and update:**
- `/plugin install name@marketplace` or `claude plugin install …`.
- Marketplaces use `marketplace.json`; the docs map lists `create-marketplace.md` (not fetched).
- Local development: `--plugin-dir`.

**Long-running processes:**

1. **Monitors.**
   - Entries in `monitors/monitors.json` take the form `{name, command, description, when?}`.
   - `when` is `"always"` (default) or `"on-skill-invoke:<skill>"`.
   - A monitor runs for the session in the working directory, with full user permissions, outside the sandbox.
   - Its stdout "reaches Claude as notifications."
   - Not started with `-p`. Whether an idle session wakes per line is unverified.
2. **Mods.**
   - JavaScript in `hooks/register.js`, listed under `modules` in `hooks/hooks.json` (shape per the components doc).
   - Mods are "not sandboxed" and run with user permissions.
   - Built-in mods exist, e.g., `cc-plugin-diff`.

**In the desktop app:** plugins are managed in the desktop plugin manager. Plugins aren't available in WSL sessions.

## 3. Hooks

**Config:** a `hooks` object in settings, or `hooks/hooks.json` in a plugin.

**Matchers:**
- Tool events match on tool name.
- SessionStart matches on source: startup, resume, clear, compact, fork.
- Notification matches on type: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*`, `plugin_notification`.
- `*` or an omitted matcher matches everything.

**Hook types:**

| Type | Behavior |
|---|---|
| `command` | Receives JSON on stdin. Options: `args` (exec form), `async`, `asyncRewake`, `shell`, `onFailure`, `timeout`, `if`, `once` (in skills) |
| `http` | POSTs the input JSON. `headers` interpolate `$VAR` only for names listed in `allowedEnvVars`. A 2xx JSON body is parsed |
| `mcp_tool` | Calls a tool on a configured MCP server; valid on PermissionRequest |
| `prompt` | Single-turn model judgment |
| `agent` | Experimental; not valid on PermissionRequest |

**Output:**
- **PreToolUse:** `hookSpecificOutput.permissionDecision` is allow, deny, ask or defer (`defer` only in `-p`), plus `updatedInput`. When several hooks answer, precedence is deny > defer > ask > allow.
- **PermissionRequest:** `hookSpecificOutput.decision.behavior` is allow or deny.
  - Allow can carry `updatedInput` and `updatedPermissions`.
  - `updatedPermissions` types: addRules, replaceRules, removeRules, setMode, addDirectories, removeDirectories.
  - `updatedPermissions` destinations: session, localSettings, projectSettings, userSettings.
  - Deny can carry `message` and `interrupt`.
- **Exit codes:**
  - 0 is success and the JSON applies. Plain stdout becomes context only for UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch.
  - 2 is blocking (ignored by PermissionRequest).
  - Any other code is a non-blocking error.
- **`onFailure: "block"`** (v2.1.295+): failures act like exit 2. On PermissionRequest, a failure denies.

**Timeouts:**

| Hook | Default |
|---|---|
| command, http, mcp_tool | 600 s |
| command, http, mcp_tool on UserPromptSubmit, PreModelSwitch, PostModelSwitch | 30 s |
| agent | 60 s |
| prompt | 30 s |
| MessageDisplay | 10 s |
| SessionEnd | 1.5 s budget, raisable to 60 s |

- The maximum isn't stated.
- A timeout cancels the hook.
- On PermissionRequest without `onFailure`, a timeout falls back to the normal flow.

**Async:**
- `"async": true` (command only) runs the hook in the background.
  - Decision fields have no effect.
  - Results deliver on the next turn (waiting if Claude is idle).
  - With `-p`, running async hooks are killed at teardown.
- `asyncRewake`: exit 2 wakes an idle Claude, with stderr (or stdout) shown as a system reminder. The timeout is still enforced.

**Parallelism:**
- Matching hooks run in parallel.
- More than 12 prompt/agent hooks run 12 at a time.
- v2.1.312 raised the per-session cap to 24.

**Environment:**
- `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_<KEY>`.
- `CLAUDE_ENV_FILE`, for SessionStart, Setup, CwdChanged and FileChanged only.
- `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, exported before any hook runs when messaging is on.
- No documented `CLAUDE_CODE_ENTRYPOINT` for hooks.

**Surfaces:**
- **Desktop app:** same events, hosted via `canUseTool`.
- **IDE:** same events.
- **`-p`:**
  - `Setup` fires with `--init`/`--maintenance`.
  - PermissionRequest denies if no hook decides in a session that can't prompt.
  - `defer` works only here.
- **Agent SDK:** acts as a `canUseTool` host. An SDK callback hook on PreToolUse that times out blocks the call.
- **Cloud sessions:** don't read local settings.

## 4. Status line

**Config:** `{"statusLine": {"type": "command", "command": "~/.claude/statusline.sh", "padding": 2}}`. Optional: `refreshInterval` (min 1 s), `hideVimModeIndicator`.

**Stdin fields:**
- Session: `session_id`, `session_name` (custom name or AI title), `transcript_path`, `cwd`, `version`, `output_style`.
- `workspace.{current_dir, project_dir, added_dirs, git_worktree, repo}`.
- `model.{id, display_name}`.
- `cost.{total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed}`.
- `context_window.{total_input_tokens, total_output_tokens, context_window_size, used_percentage, remaining_percentage, current_usage{…}}` and `exceeds_200k_tokens`.
- `effort.level`, `thinking.enabled`, `fast_mode`.
- `rate_limits.{five_hour, seven_day, spend_limit}` (subscribers).
- Also `prompt_cache`, `vim`, `agent`, `pr`, `worktree`.

**How `used_percentage` is computed:** input + cache_creation + cache_read tokens of the latest API response, divided by the window size. Output tokens are excluded.

**Refreshes:**
- Triggers: session start, a new assistant message, `/compact`, a permission-mode change, the vim toggle, a command change, `refreshInterval`, a rate-limit reset, prompt-cache expiry.
- Debounced by 300 ms; a new trigger cancels an in-flight run.
- Hidden during permission prompts.

**Cost** is "computed client-side at list price unless a modelPricing table is in effect."

## 5. Injecting input (ranked for the desktop app)

1. **Mod `$.prompt.submit`.** Robust and documented.
   - Waits for idle and resolves when the turn starts.
   - `asUser: true` sends the text as the user's words; otherwise it follows a sentence naming the mod.
   - After an interrupt, new work is refused until the user types (v2.1.304+). Refused calls resolve with `{drop: reason}`.
2. **PermissionRequest decisions.** Approvals only.
3. **`asyncRewake`.**
   - Exit 2 wakes an idle session.
   - Needs a re-arm loop, because the hook exits once it fires.
   - The timeout is enforced. Unverified in the desktop app.
4. **Inbox-socket peer message.**
   - **Connecting:**
     - The socket path appears in `/status` ("Peer address", `uds:` prefix) and is exported as `CLAUDE_CODE_MESSAGING_SOCKET`; the token is in `CLAUDE_CODE_MESSAGING_TOKEN`.
     - On macOS/Linux, an optional first line `{"type":"auth","token":"…"}` authenticates.
     - A complete line must arrive within 30 s.
   - **Delivery:** between tool calls, or it starts a turn if Claude is idle.
   - **Limits:**
     - It's framed as coming from another session.
     - It can't approve, and doesn't interrupt.
     - `/compact` arrives as plain text.
   - **Acceptance:**
     - Prompting-class sessions accept by default.
     - Bypass-class sessions hold messages for approval. The desktop app can't show that dialog, so held messages expire after `dialogExpiry`.
5. **Accessibility keystrokes.** Last resort; fragile.
6. **Channels.** CLI-only research preview.
   - Requires an approved allowlist or `--dangerously-load-development-channels server:<name>`; `-p` ignores the dev flag.
   - Channel servers declare `claude/channel` (and `claude/channel/permission` for relayed approvals) and emit `notifications/claude/channel`.
7. **Remote Control.** Outbound HTTPS only; not a local control surface.
8. **`claude --resume <bg-session> "prompt"`.** CLI background sessions; attaches a TTY.
9. **`claude -p --resume`.** Starts a new turn in a stored session; not live injection.

## 6. MCP

- **No push.** Standard MCP servers can't send unsolicited messages into a session: "nothing is pushed to the session." Only channels can.
- **Blocking tools.** An MCP tool can hold a call until a physical button is pressed. Limits on long waits weren't checked.
- **`mcp_tool` hooks.** This hook type calls a tool on a configured MCP server and is valid on PermissionRequest, so a blocking deck-approval tool could serve as the approval hook.
- **Elicitation.** `Elicitation` and `ElicitationResult` hook events exist for MCP user-input requests. Decision semantics weren't checked.
- **Desktop MCP config.** Local sessions read `claude_desktop_config.json`; settings files also work.
- **Plugin MCP names.** Servers are named `plugin:<plugin>:<server>`; tools are `mcp__plugin_<plugin>_<server>__<tool>`.

## 7. Multi-session and focus

- **Identifying sessions:** hook payloads carry `session_id`, `cwd`, `transcript_path` and `prompt_id`. In practice, the bridge keeps a registry fed by SessionStart/SessionEnd.
- **Names:** `session_name` appears only in the status line; hooks don't carry names.
- **Listings:**
  - `claude agents --json` covers background sessions only.
    - Fields include `state`, `status`, `sessionId`, `name`.
    - `waitingFor` is one of: permission prompt, input needed, sandbox request, worker request, dialog open.
  - `/list-agents` (or `/peers`) inside a session lists sessions that bind an inbox socket.
  - A desktop session listing isn't documented.
- **Focus:**
  - Options: `claude --desktop --resume <id>`, `open -a Claude`, or the desktop sidebar keys.
  - No focus URL is documented for Claude.app.
  - The community project phmatray/claude-deck focuses Warp via `warp://session/<uuid>`, which doesn't apply here.
- **Separate lists:** the desktop session list is separate from the CLI and VS Code lists. The desktop app can resume CLI sessions.

## 8. Model, effort, and mode from outside

- **CLI flags** apply at launch only:
  - `--model`
  - `--effort` (low … max, ultracode)
  - `--permission-mode`
  - `--session-id` (choose a UUID up front; CLI only)
- **Settings:**
  - `permissions.defaultMode` (new local sessions).
  - `model`.
  - `CLAUDE_CODE_EFFORT_LEVEL` pins effort.
- **Remote Control:** from a connected device, `/model` and `/effort` apply to the running session.
- **Hooks:** PreModelSwitch can block a switch; PostModelSwitch reports the new model.
- **Settings reload:** settings reload automatically (per the statusLine docs). Unverified whether an edited file changes a running session's model.
- **CLI keys:**

  | Key | Action |
  |---|---|
  | Shift+Tab | Cycle default → acceptEdits → plan → bypassPermissions (when available) → auto |
  | Option+P (macOS; needs Option as Meta) | Switch model |
  | Option+T | Toggle thinking |
  | Option+O | Toggle fast mode |

- **CLI commands:** `/model`, `/effort` and `/fast` run immediately, even while Claude works.
- **Queueing:**
  - Esc interrupts, and queued messages are sent next.
  - Enter while Claude is working queues rather than interrupts.
  - Ctrl+Enter sends queued messages now (v2.1.275+).

## 9. Prior art (community; verify before use)

- **phmatray/claude-deck** (macOS; Stream Deck XL; software 6.6+; MIT).
  - Every session on a key; approvals via PermissionRequest.
  - The terminal dialog stays open, and "whichever you answer first wins."
  - Limits: plans can't be approved, and AskUserQuestion never reaches the deck.
  - Focuses sessions via a Warp URL. State lives in files ("No daemon, no socket").
- **wayzeer/claude-code-streamdeck-approve** (Windows). Approve/deny keys; falls back to the usual prompt after a 45 s window.
- **msageha/claude-code-for-stream-deck.** Fork of agentsd; localhost hook events; 24 h decision window.
- **paultyng/agentsd** (macOS). Localhost server on port 9200; 2 min window; unanswered requests are rejected.
- **fernandobelotto/AgentDeck.** Press-and-hold approve; jump to terminal; some features need Kitty.
- **Elgato Marketplace "Session Keys for Claude Code"** (Windows). Allow/Always/Deny/Answer keys.
- **dmtrio/streamdeck-code-companion.** Status only. Notes that Esc emits no hook event and tool exit codes are hidden.
- **JulienCr/streamdeck-claude.** Status, including permission state; macOS/Windows.
- **etechlead/claude-deck.** Status. A stale "completed" indicator issue is reported (old, unverified).
- **Others:** antonym/clawdeck (canonical repo unclear), Mawsis/slopdeck (PWA, not hardware), Florian-DELRIEU and Corrugator Stream Deck plugins.
- **Found by the Stream Deck thread** (see `stream-deck-plus-sdk.md`): kotyzap "Deck for Claude" (macOS desktop app; presses Allow/Deny through the Accessibility API), McTonnie "Claude Notify" (Windows; undocumented `claude://code/continue?session=` link), obalunenko/streamdeck-claude-plugin, tapparello/agent-vitals.

**Gaps:**
- None of the excerpts mention the desktop Code tab or mods; most target terminals.
- Plan approvals and AskUserQuestion are only partly handled.
- Context and cost are absent.
- Interrupts aren't reliable from outside.

## 10. Surface differences

| Capability | CLI (terminal) | Desktop Code tab | VS Code | Agent SDK / `-p` |
|---|---|---|---|---|
| Hook events | All | Same events (docs) | Same events | Yes; `defer` only in `-p` |
| Approval hook | Documented; terminal timing unstated | Hosted; hook runs alongside | Hosted | `canUseTool`; no decision → deny |
| statusLine | Documented | Not documented | Not checked | N/A |
| Mods | Yes (2.1.287+) | Yes (2.1.286+; not WSL) | Yes (ext 2.1.299+) | Hooks yes; no drawing |
| Channels | Yes (preview) | Not documented | Not documented | Ignored |
| Cross-session | Yes | Yes (2.1.234+) | Peer dialog unavailable | Yes (with socket) |
| `claude agents` | Yes | Not stated | Not stated | N/A |
| Remote Control | Yes | `/remote-control` | `/remote-control` | N/A |
| Permission modes | All, incl. dontAsk | No dontAsk; Shift+Tab doesn't cycle | Not checked | All |
| OTEL | Yes | Documented for Code tab | Not checked | Yes |

## 11. Recommended design and snippets

**Architecture:**
- The Stream Deck plugin runs a bridge on 127.0.0.1, protected by a bearer token, with no permissive CORS.
- A Claude Code plugin, `streamdeck-bridge`, runs in each desktop session.

Telemetry hook. It's async, so it doesn't block tool calls:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47600/event >/dev/null 2>&1; exit 0",
            "async": true
          }
        ]
      }
    ]
  }
}
```

PermissionRequest hook to the bridge. Do **not** add `"onFailure": "block"`: a stopped bridge would then deny every tool call.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:47600/permission",
            "timeout": 120,
            "headers": { "Authorization": "Bearer $DECK_TOKEN" },
            "allowedEnvVars": ["DECK_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

PermissionRequest decision, returned as the HTTP body (or as stdout for command hooks):

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }
```

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "Denied from Stream Deck", "interrupt": true } } }
```

statusLine (CLI; unverified in the desktop app):

```json
{ "statusLine": { "type": "command", "command": "~/.claude/statusline.sh", "padding": 2 } }
```

A minimal plugin bundling hooks. First `.claude-plugin/plugin.json`:

```json
{ "name": "streamdeck-bridge", "version": "0.1.0", "description": "Stream Deck bridge hooks and mod for Claude Code" }
```

Then `hooks/hooks.json`, which has a top-level `"hooks"` key:

```json
{ "hooks": { "PermissionRequest": [ { "matcher": "*", "hooks": [ { "type": "http", "url": "http://127.0.0.1:47600/permission", "timeout": 120 } ] } ] } }
```

Mod prompt-injection sketch. It's illustrative, based on the mods API examples, and hasn't been run:

```javascript
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(1000, async () => {
      const r = await $.http.fetch('http://127.0.0.1:47600/next')
      if (r.ok && r.text) $.prompt.submit({ text: r.text, asUser: true }).catch(() => {})
    })
    return next(e)
  })
}
```

The bridge must route queued text to the right session. How a mod reads its session id is unconfirmed.

OTEL settings, as user-level `env` per the monitoring page's wording (verify for the desktop app):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
  }
}
```

To jump to a session: `claude --desktop --resume <session_id>`, plus `open -a Claude`.

## 12. Gotchas

- A plugin can't ship the statusLine; it stays in user or project settings.
- Synchronous hooks block every matching event, so use async for telemetry. Async command hooks can't make decisions.
- PermissionRequest ignores exit 2; return JSON instead.
- Mod prompt injection waits for idle and is refused after Esc until the user types. The deck UI must show queued and refused states.
- Peer messages can't approve, don't run commands, and can't interrupt.
- Bypass-class sessions hold peer messages for approval. The desktop app expires them after 5 min unless configured otherwise.
- Stop may not fire on interrupt, so "working" can get stuck. Add a watchdog.
- The desktop app's bundled Claude Code can differ from CLI 2.1.312.
- Esc and Accessibility control break on app updates and need macOS permissions.
- Bridge security: bind to 127.0.0.1, use a random bearer token, and reject unexpected Host headers. Any local process that can reach the bridge can send prompts.
- Mods, hooks, and monitors run with user permissions and aren't sandboxed.

## 13. Unverified / open questions

1. Whether a pending PermissionRequest HTTP hook is cancelled when the in-app dialog is answered first.
2. Whether a PermissionRequest decision resolves the desktop dialog. Documented in general, but not tested.
3. Whether the desktop app has a status line; test before assuming.
4. Whether `claude --desktop --resume <id>` focuses an already-open session.
5. Whether `asyncRewake` wakes an idle desktop session.
6. Whether Stop fires on Esc in the desktop app.
7. Mod details: exact method names for tool approval and deny, the `$.session.usage()` shape, and session-id access (`$.session.id` is unconfirmed).
8. Whether `$.prompt.submit` runs slash commands.
9. The maximum hook timeout.
10. The exact `updatedPermissions` entry JSON, and whether `setMode` applies to an existing desktop session.
11. OTEL in the desktop app:
    - Does user-level OTEL env apply to Code-tab sessions?
    - Does `DISABLE_TELEMETRY` suppress OTEL?
    - What is the desktop `app.entrypoint` value (inferred to be `claude-desktop`)?
12. Whether desktop sessions expose an inbox socket and appear in `/list-agents`.
13. Monitor delivery and idle-wake behavior, and whether the desktop app supports monitors.
14. Whether `$.process.spawn` gives stdin for a two-way bridge.
15. AskUserQuestion via PreToolUse allow with `updatedInput`. The pattern is documented, but the exact keys are unverified.
16. Release sources: the npm 2.1.316 publish date is unknown, and the GitHub CHANGELOG couldn't be retrieved. The docs changelog's newest entry is 2.1.312.
17. Not researched: Agent SDK streaming and `interrupt()` details, the IDE protocol, and Dispatch.
18. Accessibility details are macOS-level and weren't checked.

## 14. Sources (accessed 2026-10-31)

- Docs map: https://code.claude.com/docs/en/claude_code_docs_map.md
- Desktop: https://code.claude.com/docs/en/desktop.md
- Hooks: https://code.claude.com/docs/en/hooks.md (also hooks-guide.md)
- Status line: https://code.claude.com/docs/en/statusline.md
- Deep links (`claude-cli://`; notes on `claude://`): https://code.claude.com/docs/en/deep-links.md
- Remote Control: https://code.claude.com/docs/en/remote-control.md
- Channels: https://code.claude.com/docs/en/channels.md and https://code.claude.com/docs/en/channels-reference.md
- Sessions: https://code.claude.com/docs/en/sessions.md
- Agent view: https://code.claude.com/docs/en/agent-view.md
- Cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging.md
- CLI reference: https://code.claude.com/docs/en/cli-reference.md
- Interactive mode: https://code.claude.com/docs/en/interactive-mode.md
- Plugin components: https://code.claude.com/docs/en/plugins/components.md
- Plugin manifest: https://code.claude.com/docs/en/plugins/manifest-reference.md
- Mods overview: https://code.claude.com/docs/en/plugins/mods/overview.md
- Mods API: https://code.claude.com/docs/en/plugins/mods/api.md
- Monitoring (OTEL): https://code.claude.com/docs/en/monitoring-usage.md
- Changelog: https://code.claude.com/docs/en/changelog.md
- npm registry (latest): https://registry.npmjs.org/@anthropic-ai/claude-code/latest (npmjs.com returned 403; the GitHub CHANGELOG fetch failed)
- Community (from search snippets; only claude-deck's README was read in full):
  - https://github.com/phmatray/claude-deck
  - https://github.com/wayzeer/claude-code-streamdeck-approve
  - https://github.com/msageha/claude-code-for-stream-deck
  - https://github.com/paultyng/agentsd
  - https://github.com/fernandobelotto/AgentDeck
  - https://github.com/dmtrio/streamdeck-code-companion
  - https://github.com/JulienCr/streamdeck-claude
  - https://github.com/etechlead/claude-deck
  - https://github.com/antonym/clawdeck
  - https://github.com/Mawsis/slopdeck
  - https://marketplace.elgato.com/product/session-keys-for-claude-code-18eca9e0-518e-43f9-97e8-237f52d860d0
  - https://dev.to/altair_alter/which-session-is-waiting-for-me-claude-code-hooks-on-a-stream-deck-3moo
