# Claude Code build plan

**Status:** Phase 1, spikes. Written 2026-11-01 by the build session, from the research of 2026-10-31 and checks made on this Mac at kickoff. Kickoff questions answered the same day.

The build session records decisions and spike results in **Log** at the bottom and keeps **Progress** current, so a fresh session can pick up from this file.

## Goal

Work with Claude Code sessions in the Claude desktop app's Code tab from the Stream Deck +:

1. **Live status for each session:** working (and on what), waiting for approval, waiting for an answer, finished, failed, plus how full its context is.
2. **Approve and deny from the deck.** The keys show which session is asking, and for what.
3. **Saved prompts** on keys, sent to a chosen session.
4. **Mode, model and effort** buttons for a chosen session.
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
- **The sandbox,** `claude-code/sandbox/`, whose own `.claude/` loads the spike plugin.
- **The spike plugin,** `spikes/cc-plugin/`: a logging command hook on every event, an http PermissionRequest hook, and a mod that reports what `$` gives it.
- **The spike bridge,** `spikes/cc-bridge/`: a Node server on 127.0.0.1:47600 that logs everything under `spikes/results/<timestamp>/` and answers held requests from a script.
- **Throwaway sessions,** started and driven by the main thread with the app's session tools: start, send a message, set the mode, archive.

**S0: sandbox and isolation.** Can the plugin load in sandbox sessions only?
- How: try a plugin folder in the sandbox's `.claude/skills/` first, then a folder marketplace with a project-scope install. Start a throwaway session there and let it and the user's sessions run for 10 minutes while the bridge logs every caller.
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
- Builds: `hooks/hooks.json`; the mod (hello, reports, the command loop, prompt submit, the S4 routes, context %); token handling; offline behaviour, where a bridge that's down means doing nothing and backing off.
- Verified by: `tsc`, `claude plugin validate` and `claude plugin test` with the app's 2.1.309, against Track C's fake bridge and the fixtures.

**Track B: Stream Deck plugin** (`claude-code/deck/`)
- Builds:
  - The bridge server: auth, held requests, the command queue.
  - The session model: the registry watcher merged with hook and mod reports.
  - Actions: Approve, Deny, Saved Prompt, the Sessions dial, Mode, Model and Effort as keys and dials, the Session key.
  - Layouts, Property Inspectors, the S5 jump route, logging.
- Verified by: typecheck, unit tests, `streamdeck validate`, and a smoke run against Track C's fake Claude.

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

## Progress

- [x] Phase 0: kickoff (open questions answered), 2026-11-01
- [ ] S0 sandbox · [ ] S1 status · [ ] S2 approvals · [ ] S3 mod · [ ] S4 mode, model, effort · [ ] S5 overview and jump · [ ] S6 deck
- [ ] Phase 2: contract frozen
- [ ] Track A: Claude Code plugin · [ ] Track B: deck plugin · [ ] Track C: tools
- [ ] Ladder steps 4–5
- [ ] Phase 4: on hardware with the user
- [ ] Phase 5: daily use, when the user says so
- [ ] Phase 6: hardening
