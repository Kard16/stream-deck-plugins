# Claude Code build plan

**Status:** Phase 3, building in parallel tracks, 2026-11-01. The contract is frozen in `claude-code/protocol/PROTOCOL.md`. Written 2026-11-01 by the build session, from the research of 2026-10-31 and checks made on this Mac at kickoff. Kickoff questions answered the same day.

The build session records decisions and spike results in **Log** at the bottom and keeps **Progress** current, so a fresh session can pick up from this file.

## Goal

Work with Claude Code sessions in the Claude desktop app's Code tab from the Stream Deck +:

1. **Live status for each session:** working (and on what), waiting for approval, waiting for an answer, finished, failed, plus how full its context is.
2. **Approve and deny from the deck.** The keys show which session is asking, and for what.
3. **Saved prompts** on keys, sent to a chosen session.
4. **Mode** buttons for a chosen session, with its **model and effort** shown. Changing model and effort from the deck was dropped after S4.
5. **An overview of all sessions,** with a way to jump to any of them in the app.

Done means:
- The user can run several sessions and handle their approvals, prompts and settings from the deck while working in another app, Lightroom included.
- Nothing reaches a session from the deck except through a key or dial the user pressed, and every command names the session or request it's for.
- The app's own dialogs always keep working. A deck that's offline, restarting or slow never blocks a session.
- The deck recovers on its own when the Claude app, the Stream Deck app or the Mac restarts.

**Out of scope:**
- Terminal (CLI) sessions, VS Code, cloud sessions, Remote Control. They may work by accident; nothing is built or tested for them.
- Interrupting a running turn. Not chosen at kickoff. The mods API has `$.turn.abort` if it's wanted later.
- Answering AskUserQuestion and approving plans from the deck, unless S2 shows the app lets a hook do it. The deck shows them and jumps to the session.
- Changing a session's model or effort. The user chose to have them shown only, after S4 found no route the app's menus follow.
- Marketplace, Windows, sharing the mod.

## Prerequisites

Checked at kickoff, 2026-11-01:
- macOS 26.6.2. Claude.app 4.4212.0 (`com.anthropic.claudefordesktop`). Its sessions run the app's own Claude Code **2.1.309**; the `claude` CLI on PATH is 2.1.312.
- Stream Deck app 7.6.0, running the Lightroom plugin. Lightroom is open and holds ports 58780/58781.
- Node 24 and Lua 5.1.5 through `mise exec --`.
- Port 47600 is free.

## What the kickoff checks found

Facts from this Mac that the research didn't have. They're undocumented unless marked, so the spikes check again the ones the build relies on.

- **Desktop sessions are SDK-hosted.** The app runs `claude … --input-format stream-json --output-format stream-json --permission-prompt-tool=stdio` from `~/Library/Application Support/Claude/claude-code/2.1.309/`. That's the `canUseTool` host of CC research §1 Q3.
- **A session knows its desktop id.** Its environment has `CLAUDE_CODE_SESSION_ID` (Claude Code's UUID, which names the transcript), `CLAUDE_CODE_HOST_SESSION_ID` (the app's `local_…` id) and `CLAUDE_CODE_ENTRYPOINT=claude-desktop`. Hooks and the mod should see both ids.
- **Desktop sessions have an inbox socket,** `CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<pid>.sock`. That answers half of CC research §13 Q12.
- **A live session registry:** `~/.claude/sessions/<pid>.json`, one file per running session (10 at kickoff). Fields: `sessionId`, `hostSessionId`, `cwd`, `name` (the sidebar title), `nameSource`, `status` (`busy` and `idle` seen), `statusUpdatedAt`, `entrypoint`, `version`, `messagingSocketPath`. Each has a `0600` `.key` file beside it, which nothing of ours reads. It lists every session, with or without our plugin, so it can feed the overview.
- **The app keeps its own session records** in `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<id>.json`. Not read yet.
- **The app registers one URL scheme, `claude`.** Which routes it handles is S5's question.
- **The mods API in 2.1.309.** The plugin-authoring skill's type file and reference are vendored in `claude-code/vendor/mods-api-2.1.309/`; the API is "early access" and changes between releases. What matters here:
  - `$.session.id()`, `.model()`, `.cwd()`, `.usage()` (context %, rate limits, cost, "as the status line has them"); `$.env.get()`.
  - `$.prompt.submit()`: a turn of its own, "once the session is idle".
  - `$.command.run()`: runs a slash command "as if the person typed" it, once the session is idle. `$.config.list()`/`.set()`: the `/config` rows, changed "as if the person did in the menu".
  - The `tool.check` event: a hook can answer allow, ask or deny. "For a tool that requires the person (a question put to them, a plan to approve) a hook only tightens: its `allow` does not dismiss the dialog."
  - Classic hook events are hookable from the mod as `classic.<Event>`.
  - `$.ui.status()`, `.toast()`, `.notice()` (a line under an open dialog); `$.http.fetch()`, `$.clock.every()`, `$.process.run()`, `$.store`; `$.turn.abort()`.
- **Loading a plugin under development** (the same reference, "Developing one"):
  - `--plugin-dir` (CLI only).
  - `CLAUDE_CODE_PLUGIN_DIRS`, from the process environment or the `env` block of `~/.claude/settings.json`, "never a project's settings". User settings would load it everywhere, so that route is out.
  - A plugin folder in a project's `.claude/skills/<name>` loads for sessions in that project.
  - A folder marketplace, re-read with `/reload-plugins`.
  - Desktop sessions hot-reload only with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`.
- **This session's mods folder is armed.** Loading the plugin-authoring skill started a watch on `~/.claude/dev-mods/<this session's id>/`. Anything written there would load into this session, so nothing goes there.
- **The user's settings:** `permissions.defaultMode` is `auto`, a status-line command is set, there are no hooks, and the Vercel plugin is enabled.

## Already decided

| Topic | Decision | Source |
|---|---|---|
| Plugins | A Stream Deck plugin of its own, `com.karimdhanji.claude`, separate from the Lightroom one, so restarting one never disturbs the other. | LR plan; SD research §8 |
| Bridge | The Stream Deck plugin hosts it: HTTP on 127.0.0.1:47600, a bearer token from a `0600` file, the Host header checked, no CORS. | CC research §11, §12; SD research §3.2 |
| Claude Code side | One Claude Code plugin, `streamdeck-bridge`, holding hooks and a mod. Only it talks to the bridge. | CC research §2, §11 |
| Approvals | A PermissionRequest hook, held until a deck key answers. Never `onFailure: "block"`: the app's dialog stays up beside it, the first answer wins, and a deck that's down or slow changes nothing. | CC research §1 Q3, §3, §11 |
| Fail safe | Every path falls back to the app's own behaviour: a bridge that's down, a held request dropped by a deck restart, a timeout. | SD research §3.3, §7 item 11 |
| Only presses act | The deck approves, denies, sends or changes something only on a key or dial press, for a request or session it shows. The bridge refuses a decision for a request it doesn't hold. | This plan |
| Desktop first | Design and test for the Code tab. Terminal-only features (the status line, channels, Shift+Tab) don't count. | CC research §10; the user's memory notes |
| Session identity | Claude Code's `session_id` plus the app's `hostSessionId`. | Kickoff checks |
| Toolchain | Node 24, `@elgato/streamdeck` 3.0.4, `@elgato/cli` 1.10.4 and SDK 3, as for Lightroom. The mod is TypeScript, checked with `tsc` and with the app's own `claude` 2.1.309 (`plugin validate`, `plugin test`), not the 2.1.312 CLI. | CLAUDE.md; kickoff checks |
| Development safety | The Claude Code plugin loads only in throwaway sessions the main thread starts (open question 1). Never user-wide, never through `~/.claude/settings.json`, never in this session's mods folder. Agents never approve, deny, send a prompt or change a setting in a session the main thread didn't start. | The user, at kickoff |
| Names | `claude-code/deck/` (`com.karimdhanji.claude.sdPlugin`), `claude-code/plugin/` (`streamdeck-bridge`), `claude-code/protocol/`, `claude-code/tools/`, `claude-code/sandbox/`. | This plan |

## Open questions for the user

Ask these in one round at kickoff, with a recommendation for each, and record the answers in the log.

1. **Where throwaway sessions run.** Proposed: `claude-code/sandbox/` in this repo. Its own `.claude/` loads the plugin for sessions started in that folder and nowhere else.
   - The main thread starts them in Manual mode, without a worktree, on Haiku at low effort unless a spike needs more. Their prompts are harmless: list files, write a scratch file inside the sandbox. They're archived when a spike ends, and show in the user's sidebar while they run.
   - Agents may also read, without writing, outside the repo: `~/.claude/sessions/` (never the `.key` files), the sandbox sessions' transcripts, the app's session records, and the Claude app bundle, to find its `claude://` routes.
2. **Starting layout.** Proposed:
   - **Dial 1, Sessions:** turn to scroll the running sessions on the strip (title, state, context %). Press or tap jumps to that session in the app and makes it the target.
   - **Dials 2–4, Mode, Model, Effort** for the target session: turn to choose, press or tap to apply.
   - **Keys:** Approve, Deny, and up to six Saved Prompt keys.
   - The plugin also offers key versions of Mode, Model and Effort, and a Session key showing one session's state, for other pages and the Lightroom profile. The user arranges actions in the Stream Deck app, as with Lightroom.
3. **Approve and Deny.** Proposed:
   - They act on the oldest waiting request across all sessions, and show its session title and tool, with a short command or file name. After an answer, the next request shows.
   - Deny works like the app's own "No": Claude stops and waits for the user.
   - No "Always allow" key at first, because it writes permission rules.
   - Questions (AskUserQuestion) and plan approvals show as "needs you", and a press jumps to the session, unless S2 finds that a hook may answer them.
4. **The target session** for prompts, mode, model and effort. Proposed: the session last picked on the Sessions dial, named on every strip. Until one is picked, the session that most recently finished a turn. A press for a session that's gone does nothing and shows an alert.
5. **The values, and a keystroke fallback.** Proposed values:
   - Mode: Manual, Accept edits, Plan, Auto. No Bypass.
   - Model: Opus 5.5, Sonnet 5.5, Haiku 5.5.
   - Effort: low, medium, high, xhigh, max.

   If S4 finds no API route for one of them, may it use the app's own shortcuts instead? That needs Accessibility for the Stream Deck app, brings Claude to the front on that session, and acts only on the session in front. Proposed: yes as a fallback, after the user sees S4's results.
6. **Saved prompts.** Proposed: each key's text is set in its Property Inspector. A press sends it to the target session as the user's own message, waiting until the session is idle. The key shows sent, waiting or refused. Slash commands are allowed if S3 shows they work.
7. **Overview scope.** Proposed: the overview and jump cover every running Code-tab session, read from the registry, without the plugin. Richer status, approvals, prompts and settings need the plugin, so until the user says otherwise they cover only throwaway sessions. Phase 5 installs it for the user's own sessions, when they say so.

## Phases

Each phase ends with a verification step. Phases 1 and 2 are mostly serial; Phase 3 is where parallel tracks pay off.

### Phase 0: kickoff (main thread)

1. Read this plan, `CLAUDE.md`, CC research §1–§5, §11–§13, and SD research §3, §6.2, §7 and §8.
2. Check the prerequisites (done above).
3. Ask the open questions.

### Phase 1: spikes

Answer the risky questions before building on them. Spike code lives in `spikes/cc-*`. Report the results to the user, record them in the log, and wait for the user's go before Phase 2.

The spikes share:
- **The sandbox:** the folder `claude-code/sandbox/`, plus a session preset, `deck-sandbox`, that the user makes in the app. The preset starts sessions in that folder with `CLAUDE_CODE_PLUGIN_DIRS` set to `claude-code/sandbox-plugin`, a link to the plugin under test (the spike plugin now, `claude-code/plugin/` from Phase 4). No plugin sits in a `.claude/skills/` folder, which this session might discover as a nested one.
- **The spike plugin,** `spikes/cc-plugin/`: a logging command hook on every event, an http PermissionRequest hook, and a mod that reports what `$` gives it.
- **The spike bridge,** `spikes/cc-bridge/`: a Node server on 127.0.0.1:47600 that logs everything under `spikes/results/<timestamp>/` and answers held requests from a script.
- **Throwaway sessions,** started and driven by the main thread with the app's session tools: start, send a message, set the mode, archive.

**S0: sandbox and isolation.** Can the plugin load in sandbox sessions only?
- How: start a throwaway session from the `deck-sandbox` preset, and let it and the user's sessions run for 10 minutes while the bridge logs every caller. Fallbacks, in order: a plugin folder in the sandbox's `.claude/skills/` (watching for this session picking it up), then a folder marketplace with a project-scope install.
- Pass: the throwaway session's hooks and mod reach the bridge; nothing arrives from any other session; no prompt is left waiting in the app.

**S1: status from hooks.**
- How: give a throwaway session prompts that run a read, an edit that needs approval, a failing command and a subagent. Then press Esc mid-turn, and archive it.
- Measure:
  - Which events fire, with which fields, and whether hooks see `CLAUDE_CODE_HOST_SESSION_ID`.
  - The delay from the action to the bridge.
  - Whether Stop fires after Esc (CC research §13 Q6).
  - How `status` in the registry moves: `busy`, `idle`, anything for "waiting".
- Pass: a table of event, fields and delay, and a state machine for each session's status on the deck.

**S2: approve and deny.** A PermissionRequest http hook to the spike bridge, with scripted answers:
1. Allow from the bridge: does the tool run, and does the app's dialog close?
2. Deny with a message, with and without `interrupt`.
3. Answer in the app first: does the held request end, and when? (CC research §13 Q1)
4. No answer: the hook times out and the dialog still works.
5. AskUserQuestion and plan approval: does PermissionRequest fire for them, and can a hook answer?
6. The mod's alternatives: `tool.check`, `classic.PermissionRequest`, and `$.ui.notice` under the dialog.

Pass: a decision table, and the user confirms what the app showed.

**S3: the mod in the desktop app.**
- How: the spike mod logs `$.session.id()`, `$.env.get(…)`, `.usage()`, `.model()`, `$.config.list()`, `$.command.list()` and `$.session.surfaces()`. It polls the bridge with `$.http.fetch` on `$.clock.every`, submits a prompt with `$.prompt.submit` when idle and while busy, and tries `$.ui.status`.
- Pass: the mod loads in a desktop session, reaches 127.0.0.1, knows both ids and the context %, and a submitted prompt shows in the app as the user's message and starts a turn. Also recorded: what the user sees, the delay, behaviour after Esc, and whether a slash command works.

**S4: mode, model and effort of a running session.** Try in this order, in a throwaway session, checking each in the app's own pickers:
1. The mod: `$.config.set` on the rows `$.config.list()` shows; `$.command.run` with whatever `$.command.list()` offers (`/model`, `/effort`, …).
2. A PermissionRequest allow with `updatedPermissions` `setMode`. Mode only, and only while a request is open.
3. The app's shortcuts (Cmd+Shift+M, I or E, then a digit) through System Events. Only if the user allows it (question 5), after granting Accessibility, with the throwaway session in front.

Pass: for each of mode, model and effort, a route that the app's pickers reflect and that holds for the next turn, or a firm "no route".

**S5: overview and jump.**
- How:
  - Watch the registry while sessions start, work, wait, end and are archived, and compare it with the app's own session records.
  - Find the `claude://` routes in the app's bundled JavaScript and try them on a throwaway session. Try `claude --desktop --resume <id>` too.
  - For each route: does it focus the open session, open a duplicate, or do nothing? Does it work when the app is hidden, or showing another session?
- Pass: a route that brings a given running session to the front, or a firm "not possible" and the best fallback.

**S6: the deck side.**
- How: a minimal `com.karimdhanji.claude` plugin with the bridge server, one key and a dial with a session-list strip layout, beside the Lightroom plugin.
- Pass: `streamdeck validate` passes; a hook reaches the server; `streamdeck restart com.karimdhanji.claude` leaves the Lightroom plugin alone and drops held requests cleanly; the user confirms the strip and the key.

S0 comes first, since everything depends on it. One throwaway session can cover S1–S3 together. S4 and S5 follow S3. S6 runs alongside, built by a subagent.

The user's steps go into one checklist: answer any prompt about the sandbox in the Claude app; watch the dialogs during S2; grant Accessibility only if S4 needs it; place the S6 action and look at the deck.

### Phase 2: freeze the contract (main thread)

Write `claude-code/protocol/PROTOCOL.md`: transport, auth, endpoints, the session model, states, held requests, the command queue, timeouts, errors and a version number. Write `claude-code/protocol/fixtures/*.jsonl`: conversations both sides test against. After the freeze, protocol changes go through the main thread.

Starting sketch, to be settled by the spikes:

```
Claude Code plugin → bridge, HTTP, Authorization: Bearer <token>
  POST /v1/hook             a hook event, fire and forget            → 204
  POST /v1/permission       PermissionRequest, held                  → decision JSON, or {} for "no decision"
  POST /v1/mod/hello        {sid, host, cwd, model, mode, effort, v} → {v, ok}
  GET  /v1/mod/next?sid=…   long poll, up to 25 s                    → {cmds: [{id, t: prompt|mode|model|effort, …}]}
  POST /v1/mod/report       {sid, usage: {pct}, model, effort, done: [{id, ok, why}]}

Inside the Stream Deck plugin
  sessions = ~/.claude/sessions/*.json (every session) + hook and mod reports (sessions with the plugin)
```

### Phase 3: build in parallel tracks

Run this as a workflow. Each track owns its directory, so tracks don't need worktrees. Each ends with its checks, then an independent review against `PROTOCOL.md` and the `CLAUDE.md` rules, then a fixer for blockers and majors.

**Track A: Claude Code plugin** (`claude-code/plugin/`)
- Builds: `hooks/hooks.json` as PROTOCOL.md gives it; the mod (hello, events, the long poll, the `prompt` and `mode` commands, fingerprints and summaries, `settings`); token handling; offline behaviour, where a bridge that's down means doing nothing and backing off.
- Verified by: `tsc`, `claude plugin validate` and `claude plugin test` with the app's 2.1.309, running the fixtures' plugin side and `vectors.json`.

**Track B: Stream Deck plugin** (`claude-code/deck/`, growing the S6 plugin)
- Builds:
  - The bridge on 47600: the `/v1/` routes, auth, held requests with their kinds and release rules, the command queue and long poll.
  - The session model: the registry and the app's records merged with the mod's reports, statuses as PROTOCOL.md lists them, and the target session.
  - Actions: Approve and Deny keys, Saved Prompt keys, the Sessions dial (showing model and effort), the Mode dial and key, and the Session key. No Model or Effort actions.
  - Layouts, Property Inspectors, the S5 jump route, logging.
- Verified by: typecheck, unit tests, `streamdeck validate`, the fixtures' deck side and `vectors.json`, and a smoke run against Track C's fake Claude.

**Track C: tools** (`claude-code/tools/`)
- Builds: a fake Claude that speaks the plugin's side of the protocol from fixtures, hooks and mod alike; a fake bridge for Track A; a fixture runner; a fake registry folder.
- Verified by: the fixtures, and Tracks A and B using them.

Then the main thread integrates: the real plugin in a throwaway session against the fake deck (ladder step 4), then the real deck plugin against the fake Claude (step 5).

### Phase 4: integration on hardware (with the user)

Walk through a checklist with the user, with two or three throwaway sessions:
- Every action and gesture.
- Approvals while Lightroom is in front.
- Recovery after a Stream Deck app restart, a Claude app restart, and sleep and wake.

### Phase 5: daily use (only when the user says so)

- Install the plugin for the user's own sessions, the way S0 found best.
- Check that every session registers, and that the user's auto mode still decides as before.
- Watch a day of real use in the logs.

### Phase 6: hardening

- **Reliability:** a reboot, given macOS 26's localhost delay; a Claude app update, with a script that re-checks the undocumented internals (registry fields, the jump route, the mod calls we use) on a new bundled Claude Code; many sessions at once.
- **Finish:** quiet logs in normal use, and a short guide in `claude-code/README.md`.

## Human-only steps

- **In the Claude app:** answer any prompt about the sandbox folder or the plugin; watch dialogs and pickers when a spike asks; look at what a jump did.
- **macOS:** Accessibility for the Stream Deck app, only if S4 needs keystrokes and the user agrees.
- **Stream Deck app:** place actions, look at keys and strips, say how the dials feel.
- **Design choices,** and the go-ahead for Phase 5.

Ask with one numbered checklist that says what to click and what to report back.

## Verification ladder

1. Static: `tsc` for both plugins, `claude plugin validate` (2.1.309), `streamdeck validate`.
2. Unit: `claude plugin test` for the mod; `node --test` for the deck plugin and the tools.
3. Contract: both sides pass the fixture streams.
4. The real Claude Code plugin in a throwaway session, against the fake deck. Read the session's transcript and the fake's log.
5. The real deck plugin against the fake Claude. Read the deck plugin's log.
6. The real deck and real throwaway sessions, with the user.
7. The user's own sessions, after they say so.

Agents report what they ran and its output. The main thread re-runs the checks before ticking off a milestone.

## Risks to watch

- **Undocumented internals.** The registry, any `claude://` route, the app's shortcuts and the mods API can change with any app update, and the app updates itself and its bundled Claude Code. Record the versions each finding was made on, keep Phase 6's re-check script, and have the deck show "unknown" rather than something wrong.
- **Two Claude Code versions.** The app runs 2.1.309 and the CLI 2.1.312. Test with the app's.
- **Approving the wrong thing.** Ids on every decision, the bridge holds the exact request, keys show the session and the tool, nothing approves on its own, and a press after the request has ended does nothing.
- **Stale requests** on the deck, if a held hook isn't cancelled when the app's dialog answers first (S2, item 3). Then the mod or later hook events must clear them.
- **Keystrokes go to whatever is in front.** If S4 needs them: only straight after a confirmed jump, never into the user's own sessions during development, and never while another app is in front.
- **Restarting the Stream Deck app** restarts the Lightroom plugin too. Restart only ours, with `streamdeck restart com.karimdhanji.claude`.
- **Throwaway sessions cost tokens** and appear in the user's sidebar. Small prompts, Haiku at low effort where it doesn't matter, archived after each spike.
- **Auto mode.** The user's default is `auto`, where the classifier settles most calls, so real approvals are rarer. Sandbox sessions use Manual to make them happen.
- **The token file is a secret:** `0600`, gitignored, and never in action settings, which are exported with profiles (SD research §3.4).
- **Inherited from Lightroom:** the deck is on a dock; macOS 26 delays localhost after a reboot; agents can't see the deck or the app's window, so visual checks need the user and get batched.

## Log

Record kickoff answers, spike results and decisions here, newest last, with dates.

- 2026-11-01, kickoff: Plan written. Checks: Claude.app 4.4212.0 with bundled Claude Code 2.1.309 (CLI 2.1.312); Stream Deck 7.6.0 running the Lightroom plugin; Lightroom open on 58780/58781; port 47600 free; macOS 26.6.2.
- 2026-11-01, kickoff: Read outside the repo, without writing, for those checks: the keys of `~/.claude/settings.json`; the fields of `~/.claude/sessions/*.json`, not the `.key` files; directory listings of `~/Library/Application Support/Claude/`. The plugin-authoring skill was loaded for its API reference, which is vendored in `claude-code/vendor/mods-api-2.1.309/`.
- 2026-11-01, kickoff answers: the user took all seven recommendations.
  1. **Sandbox:** throwaway sessions run in `claude-code/sandbox/`, which loads the plugin for sessions started there only. The main thread starts them in Manual mode, without a worktree, on Haiku at low effort unless a spike needs more, gives them harmless prompts, and archives them after each spike. Agents may read, never write, outside the repo: `~/.claude/sessions/` (never the `.key` files), the sandbox sessions' transcripts, the app's session records, and the Claude app bundle.
  2. **Layout:** dial 1 is Sessions (turn to scroll the strip list; press or tap to jump and make that session the target); dials 2–4 are Mode, Model and Effort for the target (turn to choose, press or tap to apply); keys are Approve, Deny and up to six Saved Prompts. Key versions of every action exist too, for other pages and the Lightroom profile.
  3. **Approve and Deny** act on the oldest waiting request across sessions and show its session and tool. Deny works like the app's "No". No "Always allow" key for now. Questions and plan approvals show "needs you" and jump, unless S2 finds a hook may answer them.
  4. **Target session:** the one last picked on the Sessions dial; until then, the one that most recently finished a turn. A press for a session that's gone alerts and does nothing.
  5. **Values:** Mode Manual, Accept edits, Plan, Auto (no Bypass); Model Opus 5.5, Sonnet 5.5, Haiku 5.5; Effort low to max. Keystrokes are an allowed fallback where S4 finds no API route, after the user has seen S4's results.
  6. **Saved prompts:** text set per key in its Property Inspector, sent as the user's own message, waiting while the session is busy; the key shows sent, waiting or refused. Slash commands if S3 shows they work.
  7. **Overview scope:** every running Code-tab session, from the registry, with jump for all. Approvals, prompts and settings only for sessions with the plugin, which means throwaway sessions until the user says otherwise.
- 2026-11-01, S0 setup: the plugin reaches throwaway sessions through a session preset, not a project skills folder.
  - **Why:** the reference documents `CLAUDE_CODE_PLUGIN_DIRS` for "a session the desktop app or an SDK host starts", read from the process environment, and the app's presets carry environment variables (the app's start-session tool says so). A plugin in `claude-code/sandbox/.claude/skills/` sits under this session's root, and whether a session loads nested skills folders it works in isn't documented.
  - **The preset** (`deck-sandbox`, made by the user): folder `claude-code/sandbox`, no worktree, and `CLAUDE_CODE_PLUGIN_DIRS=<repo>/claude-code/sandbox-plugin`, `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (desktop sessions hot-reload only with it) and `DECK_TOKEN` (the spike token, for the http hook's header).
  - `claude-code/sandbox-plugin` is a link to `spikes/cc-plugin`, so the preset stays the same when the real plugin replaces the spike one.
  - Three agents started: the spike bridge and spike plugin (`spikes/cc-bridge/`, `spikes/cc-plugin/`), the S6 deck spike (`claude-code/deck/`, its server on 47601 while the spike bridge holds 47600), and a read-only search of the app bundle for `claude://` routes (S5).
- 2026-11-01, S5 desk research (read-only, Claude.app 4.4212.0's `app.asar` and CLI 2.1.312's binary; nothing opened or launched). Still to test live.
  - **Jump route: `claude://code/continue?session=<local_id>`.** It's what the app's own Dock menu and Spotlight entries use.
    - It takes the `local_…` id (`hostSessionId`), not the Claude Code UUID.
    - It shows no dialog. It restores, shows and focuses the app's one main window, then navigates to `/epitaxy/<local_id>`, the session in the Code tab.
    - An unknown or archived id lands on the Code home. An id that doesn't match `^local_[A-Za-z0-9-]{1,64}$` does nothing. `session=last` means the most recently active session.
  - **`claude://code/needs-input[?session=local_…]`** opens that session if it has a pending permission prompt, otherwise the oldest waiting session. That fits a "needs you" key.
  - **Avoid:**
    - `claude --desktop --resume <uuid>` refuses any session the app is running, because those register as live `interactive` sessions.
    - `claude://resume?session=<uuid>` un-archives the session, and can import a duplicate when the UUID is an old one.
    - `claude://code/local_<id>` isn't a route.
    - `claude://hotkey` only brings the app forward.
  - **No AppleScript dictionary.** Use `/usr/bin/open <url>`; a plugin sending Apple Events would raise an Automation prompt.
  - **The app's session records** (`claude-code-sessions/<account>/<org>/local_<id>.json`, 22 files, 7 archived). Fields:
    - `sessionId` (`local_…`); `cliSessionId`, the Claude Code UUID, which can change, with `priorCliSessionIds`; `isArchived`; `title`.
    - Times: `lastActivityAt`, `lastFocusedAt`, `createdAt`.
    - `model`, `effort`, `permissionMode`, `completedTurns`.
    - `postTurnSummary` (`needs_action`, `status_category`, `status_detail`), and `turnWrapUp` (`description`, `needsUser`).
  - **What that could mean for the build:**
    - The overview can show every session's mode, model and effort without the plugin.
    - `lastFocusedAt` could pick the target session better than "last finished a turn" (kickoff answer 4).
    - S4 can read a record to check a change landed.
    - Key the deck on the `local_` id, which is fixed for a session's life.
  - **Open for the live test:**
    - Whether the app really comes to the front when a background process (the Stream Deck plugin) runs `open`.
    - What happens when the session is already showing in a split pane.
    - A cold start.
- 2026-11-01, S6 built and checked offline (`claude-code/deck/`, plugin `com.karimdhanji.claude` 0.1.0.0). The agent's results, re-run by the main thread: typecheck exit 0, 49/49 tests, `streamdeck validate` passes.
  - **Linking needs no app restart.** On app 7.6 with developer mode on, `streamdeck link` then `streamdeck restart com.karimdhanji.claude` started it. Its log has STARTUP, then "listening on 127.0.0.1:47601" and "Registry: 10 session(s) running".
  - **The Lightroom plugin wasn't touched:** same process (pid 2181) since 10:50:20, one STARTUP line, and nothing about it in the app log since.
  - **Live curl checks:** no token or a wrong one gets 401; a wrong Host gets 403, checked before the token; requests are held and logged. A client that gives up is removed from the count. A plugin restart while a request is held gives the client an empty reply, never a decision; the new process was up about 60 ms later and reused the token. The token appears in no log.
  - **Decisions taken in the spike, for Phase 2:**
    - A key press answers only the request the key last showed. If that one has gone, the press alerts and does nothing.
    - The dial follows a session by `hostSessionId`, ordered by `startedAt`.
    - Hooks must use `127.0.0.1`, not `localhost`: the server binds IPv4 only.
    - Held requests have no server-side timeout yet.
  - **For Track B:**
    - `Nodejs.Debug: "enabled"`, copied from Lightroom, opens a Node inspector on a random 127.0.0.1 port. Turn it off for daily use.
    - Log SIGTERM, since a killed plugin currently logs nothing.
  - **The plugin now runs whenever the Stream Deck app does,** reading `~/.claude/sessions` every second and holding 47601.
  - **Still to do, with the user:** place Sessions on a dial and Approve on a key, look at the strip, and press Approve on a held request.
- 2026-11-01, spike tools checked by the main thread: bridge 18/18 tests, tsc clean, and the app's 2.1.309 `plugin validate` and `plugin test` (4/4) pass.
  - `validate` and `test` write `.claude.json` and `backups/` into the config folder, so they run with `CLAUDE_CONFIG_DIR` set to a scratch folder.
  - One `hooks.json` may hold both `hooks` and `modules`.
  - The user made the `deck-sandbox` preset.
  - The app starts a session only in a turn that began with the user's own words; a turn woken by an agent's report was refused. So test sessions start on the user's go, and get reused across spikes.
  - The bridge runs from `spikes/results/20261101-133155-cc/`.
- 2026-11-01, **S0 passes so far** ("Deck spike S0", `local_5e3575bb…`, Claude Code session `3fa86955…`, Haiku, Manual, started 13:32:50). The isolation watch runs on through the other spikes.
  - **The preset route works.** The plugin loaded from `CLAUDE_CODE_PLUGIN_DIRS`, with no prompt. `CLAUDE_PLUGIN_ROOT` is the link path (`claude-code/sandbox-plugin`), not its target, and `CLAUDE_PROJECT_DIR` is the sandbox.
  - **Every plugin request came from that session.** None came from this session (`548b10e1…`) or the user's nine others.
  - **Hooks see both ids.** `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_HOST_SESSION_ID` are in their environment.
  - **The mod sees fewer.** `$.env.get("CLAUDE_CODE_SESSION_ID")` is null, but `$.session.id()` gives the same id, and `$.env.get("CLAUDE_CODE_HOST_SESSION_ID")` works.
  - **Auth works three ways:** the http hook interpolated `$DECK_TOKEN` from the preset's environment, the mod read it from its environment, and `hook.sh` read the token file.
  - **The mod's fetches** come from the host with user agent `Bun/1.4.4`.
  - **Where prompts come from,** as the mod's `prompt.submit` sees them:
    - the app's own prompt: `origin.kind` `sdk`;
    - a message from another session: `peer`;
    - a finished background subagent: `task-notification`, which starts a turn of its own.
  - **First turn, in ms from the first hook:** InstructionsLoaded ×3 at 0, SessionStart (`source: startup`) at 261, the mod's `session.start` and hello at about 500, UserPromptSubmit at 524, Stop at 3916.
  - **The mod's view of the session** (`$.session.*`): model `claude-haiku-5-5`; version 2.1.309; `surfaces` empty and not interactive, so the mod draws nowhere in a desktop session; at start, `usage()` gives the context window size (1,000,000) but no figures yet.
  - **The `/config` rows** (43):
    - `model` is this session's model, with choices `default`, `sonnet`, `opus`, `haiku`, `fable`, `best` and the `[1m]` variants.
    - `permissionMode` is the *default* for new sessions, so it's no route to the current session's mode.
    - There's no effort row.
  - **Commands** (132) include `/model`, `/effort`, `/fast`, `/rename`, `/context`, `/compact`, `/clear`, `/focus` and `/goal`, but no mode command.
- 2026-11-01, **S1: status from hooks** (same session; the bridge allowed each request at once).
  - **Every step fires a hook,** with `permission_mode` and `effort.level` on tool and Stop events:
    - Bash `ls`: PreToolUse, PostToolUse, PostToolBatch, with no PermissionRequest.
    - Write: PermissionRequest, then PostToolUse.
    - `false`: PostToolUseFailure, with `error: "Exit code 1"` and `is_interrupt: false`.
    - Agent: SubagentStart and SubagentStop, carrying `agent_id` and `agent_type`. The subagent's own tool calls carry `agent_id` too. It ran in the background, and its result started a new turn.
  - **The approval path, in ms after the Write call:**
    - The mod's `tool.check` verdict was `ask`, with the reason "Claude requested permissions to write to …".
    - The http hook's request reached the bridge at +16; the policy's `allow` went back 2 ms later; the Write had finished by +47. Nobody touched the app.
    - The request carried `permission_suggestions: [{type: "setMode", mode: "acceptEdits", destination: "session"}]`, the app's own "don't ask again for edits" choice.
  - **Async logging hooks** arrive about 5–25 ms after the mod's view of the same moment.
  - **The registry** flips `idle`→`busy` about 35 ms after a prompt, and `busy`→`idle` about 130 ms after Stop, for all sessions. During the approval only `statusUpdatedAt` moved, and the status read `busy` at both polls. A held request in S2 shows whether there's a separate waiting status.
- 2026-11-01, **S3: the mod in the desktop app** (same session). Results without the user:
  - **Context and limits:** `$.session.usage()` gives `{context: {tokens: 89910, window: 1000000, percent: 9}, rateLimits: [{kind: "seven_day", percentUsed: 24, …}], cost: {usd: 0.027}}`. The `session.measure` event pushes changes after each turn.
  - **Sending a prompt:**
    - `$.prompt.submit({text, asUser: true})` into an idle session started a turn within 29 ms. UserPromptSubmit saw the bare text, with no plugin framing.
    - Submitted while busy, it waited out a 20 s turn, then started 24 ms after `turn.complete`.
    - The mod's own hooks don't see its own submissions or tool calls.
  - **The mod reaches the bridge** over TCP and over the Unix socket (`socketPath`, 200 in 19 ms).
  - **Hot reload works** in a desktop session with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`. Edits to the mod and to `hooks.json` both took effect within about 8 s, and the mod reran `session.start` as a new instance.
  - **Which session is on screen:** opening a session in the app raises `session.attach` (`surface: "desktop"`, the window size), and leaving it raises `session.detach`. The app's record sets `lastFocusedAt` to the same millisecond. So the mod knows when its session is in front, which beats "last finished a turn" for kickoff answer 4.
  - **The app's per-turn summary:** each record has `postTurnSummary` (`status_category`, `status_detail` such as "replied 'effort check' as requested", and `needs_action`), which could caption sessions on the overview.
  - `$.ui.status` and `$.ui.toast` return nothing. Whether they show is for the user to check.
  - **The S0 session refused long waits.** The Bash tool blocks a plain `sleep 30`, and the session then took a `perl` wait as a workaround, per the sandbox's no-workarounds rule. The sandbox CLAUDE.md now says a long command asked for on purpose isn't a workaround. The Esc test moves to the user's checklist.
- 2026-11-01, **S4: mode, model and effort of a running session.** Results without the user:
  - **Model and effort through the engine work for the next turns, but the app doesn't learn of them.**
    - The mod ran `$.command.run({command: "effort", args: "medium"})`, answered "Set effort level to medium (this session only)", and the next turn's Stop hook had `effort.level: "medium"`.
    - `/model sonnet` answered "Set model to `Sonnet 5.5` for this session only", and the next turn replied "Sonnet 5.5".
    - `~/.claude/settings.json` kept the same mtime throughout.
    - The app's record and `get_session` still say `claude-haiku-5-5` and `low`.
    - Open, for the user: what the app's pickers show, and whether a prompt typed in the app switches back.
  - **The app's own tools, called from the mod** with `$.mcp.call("ccd_session_mgmt", …)`. The `ccd_*` servers are connected in every desktop session. A mod's `$.mcp.call` goes through the session's permission check like any tool call (corrected in "S4 finished" below).
    - `set_session_effort` and `set_session_model` with `self` are refused: "Refusing to change this session's own model or effort".
    - `set_session_permission_mode` with `self` worked going down (`acceptEdits`→`default`, "applies to the rest of this turn and every turn after it"). The first try was refused with "this session is waiting for the user to answer a request", which didn't recur; cause unknown.
    - Going up should show an approval card in the app, by that tool's own documentation. The user to see.
  - **A mode switch carried by an approval.**
    - S0's own Write raised a PermissionRequest carrying `permission_suggestions: [{type: "setMode", mode: "acceptEdits", destination: "session"}]`. The bridge allowed it with that update, and the engine was in `acceptEdits` from the PostToolUse on. The next Write needed no approval, and the app's record changed to `acceptEdits`.
    - That makes a deck "Approve + accept edits" possible, with no card.
    - A request the mod raises itself won't carry a switch. The mod's `$.tool.call` (a Read of a marker file, forced to ask by a classic PreToolUse hook) did raise a PermissionRequest, and the bridge answered with `setMode plan`, then `default`, but the mode stayed.
  - **This session set S0 to Plan** with its own `set_session_permission_mode`: going down, for a session it started, needs no card.
  - **So far, then:**
    - Mode: the mod and the app's tool, with a card when going up; or an approval carrying `setMode`.
    - Model and effort: `/model` and `/effort`, with the app showing stale values, or the app's shortcuts.
- 2026-11-01, the S6 deck plugin now jumps. Press or tap on the Sessions dial runs `/usr/bin/open claude://code/continue?session=<local_id>` and logs the result. Typecheck clean, 49/49 tests, validate passes, and the plugin restarted at 19:47:18 UTC.
- 2026-11-01, **S2: approve and deny** (S0, with the bridge holding each PermissionRequest and the user in the app). Driver: `spikes/cc-bridge/s2-run.mjs`. Results: `s2-summary*.json` in the bridge's run folder.
  - **What each answer did:**
    - **The deck allows** (held 8 s): the tool ran about 50 ms later, and the app's dialog closed by itself (the user watched).
    - **The deck denies with `interrupt: true`:** the Write didn't run, the dialog closed by itself, and the turn stopped. Claude got the standard "The user doesn't want to proceed with this tool use … STOP" text and "[Request interrupted by user for tool use]", not the deck's message. No Stop or PostToolUseFailure hook fired; the mod's `turn.complete` came with reason `answer`. The mod's next prompt was accepted.
    - **Deny without `interrupt`:** not tested.
    - **The user answers in the app first:** the tool ran 20–50 ms after the click, but the held request stayed open (23 s, 9 s and 15 s) until the script closed it after the turn. The app doesn't cancel the hook.
    - **No answer until the hook times out:** not tested. The dialog works while a request is held, which covers the risk.
    - **AskUserQuestion and plan approval (ExitPlanMode)** both raise a PermissionRequest. The user answered them in the app, and the held copies stayed open as above. A hook's answer to them wasn't tried, so they stay "needs you" and jump (kickoff answer 3).
  - **The request carries no `tool_use_id`.** Its fields: `session_id`, `prompt_id`, `tool_name`, `tool_input`, `permission_mode`, `effort`, `cwd`, `transcript_path` and `scratchpad_dir`; `permission_suggestions` for edits and the app's tools; `mcp_server` for MCP tools. PreToolUse and PostToolUse carry the `tool_use_id`, so a held request matches its tool call by session, tool name and input.
  - **The registry has a third status, `waiting`,** while a request is open. It showed in every step with a dialog and in none of the others.
  - **Notification** ("Claude needs your permission to use Write", `notification_type: permission_prompt`) fires 6 s after a request that's still open.
  - **Esc** (by the user, step 6) ended the turn with the mod's `turn.complete` reason `aborted`, and no Stop or StopFailure hook. After it the mod's `$.prompt.submit` was dropped ("the session was stopped and nobody has sent input since") until the user typed in the session. The mod's `$.mcp.call` still worked.
  - **Step 3's Allow also switched S0 to Accept edits,** the request's `setMode` suggestion. The user doesn't remember the button; the dialog showed an allow and a deny button. Whether the app's plain Allow applies the switch is open. It changes nothing for the deck, whose Allow is "this once".
  - **Prompts from the mod show in the app** as the user's messages: the user followed the steps from them. The transcript marks them `origin: {kind: "plugin", name: "deck-spike", asUser: true}`.
- 2026-11-01, **S4 finished.**
  - **Correction:** a mod's `$.mcp.call` goes through the session's permission check like any tool call. The app's tools raise a PermissionRequest (`tool_name: mcp__ccd_session_mgmt__set_session_permission_mode`); the app let lowering through at once and asked the user for the rest.
  - **Mode:** the mod calls `set_session_permission_mode` for `self`.
    - Going down (Accept edits → Manual) took 31–55 ms with no card.
    - Going up (Manual → Accept edits) raised the app's dialog. The user approved it after 88 s, and the mode and the app's record changed.
    - With the bridge allowing that request, the raise took 57 ms with no card, and the record followed. So the deck can confirm a raise itself.
  - **Model and effort:**
    - `/model` and `/effort` through `$.command.run` held for the following turns: S0 still answered "Sonnet 5.5" hours later. But the app's menus showed Haiku and low (the user looked), as do its record and `get_session`.
    - The app's `set_session_model` with the session's own `local_…` id is refused like `self`, and only after the app's permission dialog: the user approved a "Set Session Model" card, then the tool refused. By its documentation it's refused for the calling session, and for any other session the app asks the user first.
    - The app's bundle has no `claude://` link for them, only `code/new`, `code/needs-input` and `code/continue`.
    - The app's menus (Cmd+Shift+I, Cmd+Shift+E) open, as the user saw. Driving them by keystrokes is untested.
  - **Open, for the user:** the route for model and effort, and whether a mode raise needs a second press.
- 2026-11-01, **S5 live: the jump works.**
  - Pressing the Sessions dial with another app in front brought Claude forward on S0 (the user saw it).
  - Tapping the strip while Claude showed another session switched it to S0. The mod's `session.attach` came 133 ms after the tap, and the record's `lastFocusedAt` matches it.
  - `open` returned in 59–87 ms on all four jumps.
  - Not tested: a session in a split pane, and a cold start.
  - The registry went from 11 sessions to 12 and back within a second as the user switched sessions in the app. The deck must tolerate short-lived entries.
- 2026-11-01, **S6 passes on the deck.** The user confirmed that the strip shows session titles with their status, turning scrolls them, press and tap jump, and the Approve key shows a held request. A press answered it with Allow after 16 minutes. Re-run before the commit: typecheck exit 0, 49/49 tests, `streamdeck validate` passes. The spike tools too: bridge 18/18, `tsc` clean, the app's 2.1.309 `plugin validate` passes and `plugin test` 4/4.
- 2026-11-01, **S0 passes.** Over 3 h 20 min of spikes, all 12,420 plugin requests came from S0: 455 hook and mod calls with its session id, and 11,976 polls from its mod (plus one socket probe). Nothing came from this session or the user's other sessions, which ran throughout.
- 2026-11-01, **S1 and S3 pass.** S1's table is in its entry, and its state machine is under "Session status" below. S3's last item, prompts showing in the app, is confirmed in S2. `$.ui.status` and `.toast` weren't checked; nothing needs them.
- 2026-11-01, **decisions from the spikes, for Phase 2:**
  - **A held request ends** when the deck answers it, or when the same session reports a PostToolUse or PostToolUseFailure for the same tool and input, a turn end (the mod's `turn.complete`, or Stop), or a registry status other than `waiting`. The deck then clears it from the keys.
  - **Session status:** `idle`, `busy` and `waiting` from the registry, for every session. Sessions with the plugin add the tool being run, "needs you" (AskUserQuestion, ExitPlanMode), interrupted (`turn.complete` reason `aborted`) and context % (`session.measure`).
  - **Deny** is `behavior: "deny"` with `interrupt: true`, like the app's No (kickoff answer 3). Claude never sees the message with it, but the deck still sends a fixed one, since S2 verified that shape.
  - **Saved prompts after Esc** are refused by the engine until the user types in that session. The key shows refused, with that reason.
  - **The mod's mode changes raise PermissionRequests of their own.** How the deck treats them waits on the user's answer about a second press.
- 2026-11-01, **the user's answers after the spikes:**
  1. **Model and effort are shown, never changed,** from the deck. So the Model and Effort dials and keys are dropped. The Sessions strip shows each session's model and effort, and the Mode strip the target's.
  2. **A mode raise takes one press.** The bridge allows the PermissionRequest that the deck's own mode change raises, and only that one: the same session, the app's mode tool, and the mode the deck asked for, while that change is in flight.
  3. **Go** for Phase 2, then Phase 3.
- 2026-11-01, **Phase 2: the contract is frozen** in `claude-code/protocol/PROTOCOL.md`, version 1, with 14 fixtures and `vectors.json`, written by `make-fixtures.mjs`. The choices the spikes didn't settle:
  - **Routes under `/v1/` on 47600:** the hook's `POST /v1/permission`, and the mod's `hello`, `events`, `next` (a long poll of up to 20 s) and `result`. The deck plugin moves from 47601 to 47600 once the spike bridge stops.
  - **Status comes from the mod alone.** The only hook is the PermissionRequest http hook, which also sends the `local_…` id in an `X-Deck-Host` header.
  - **A held request is matched to its tool call by a fingerprint,** FNV-1a over the tool name and its canonical input, since the request has no `tool_use_id`. Registry changes release it when the fingerprints don't meet.
  - **Three kinds of request:** `tool` (Approve and Deny), `ask` (AskUserQuestion and ExitPlanMode: shown, and a press jumps), and `mode` (the deck's own mode change, allowed at once).
  - **Commands** are `prompt` and `mode` only. Results go `waiting`, then `done`, `refused` or `failed`.
  - **The target session** is the last one picked on the Sessions dial, else the one last on screen (`attach`, or the records' `lastFocusedAt`), refining kickoff answer 4 with S3's finding.

## Progress

- [x] Phase 0: kickoff (open questions answered), 2026-11-01
- [x] S0 sandbox · [x] S1 status · [x] S2 approvals · [x] S3 mod · [x] S4 mode, model, effort (mode through the app's tool; model and effort shown only, by the user's choice) · [x] S5 overview and jump · [x] S6 deck
- [x] Phase 1: spike results shown to the user, and their go, 2026-11-01
- [x] Phase 2: contract frozen, 2026-11-01
- [ ] Track A: Claude Code plugin · [ ] Track B: deck plugin · [ ] Track C: tools
- [ ] Ladder steps 4–5
- [ ] Phase 4: on hardware with the user
- [ ] Phase 5: daily use, when the user says so
- [ ] Phase 6: hardening
