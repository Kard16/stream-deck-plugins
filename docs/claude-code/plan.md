# Claude Code build plan

**Status:** Phase 7, session keys and dials, is done and live on deck 0.4.0 (2026-11-04); its spec is `docs/claude-code/session-keys.md`. Next is Phase 8, efficiency and update resilience, planned 2026-11-05: its spec is `docs/claude-code/hardening.md`, and its session starts from `docs/claude-code/hardening-kickoff.md`. Phase 5's day of use and Phase 4's step 11 are still open. The contract is in `claude-code/protocol/PROTOCOL.md`. Written 2026-11-01 by the build session, from the research of 2026-10-31 and checks made on this Mac at kickoff. Kickoff questions answered the same day.

The build session records decisions and spike results in **Log** at the bottom and keeps **Progress** current, so a fresh session can pick up from this file.

## Goal

Work with Claude Code sessions in the Claude desktop app's Code tab from the Stream Deck +:

1. **Live status for each session:** working (and on what), waiting for approval, waiting for an answer, finished, failed, plus how full its context is.
2. **Approve and deny from the deck.** The keys show which session is asking, and for what.
3. **Saved prompts** on keys, sent to a chosen session.
4. **Mode** buttons for a chosen session, with its **model and effort** shown. Changing model and effort from the deck was dropped after S4, and changing the mode in Phase 8 (2026-11-06), at the user's word. The mode is still shown.
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
| Mode dial press | A press or tap applies only a mode the dial was turned to. Without a turn it does nothing, so it can't re-apply a mode the deck shows a moment late. Gone with mode changes, Phase 8 (2026-11-06). | The user, 2026-11-03 |

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
- Approvals while Lightroom is in front. Dropped on 2026-11-02: the user won't approve Claude's requests while editing.
- Recovery after a Stream Deck app restart, a Claude app restart, and sleep and wake.

### Phase 5: daily use (only when the user says so)

- Install the plugin for the user's own sessions, the way S0 found best.
- Check that every session registers, and that the user's auto mode still decides as before.
- Watch a day of real use in the logs.

### Phase 6: hardening

- **Reliability:** a reboot, given macOS 26's localhost delay; a Claude app update, with a script that re-checks the undocumented internals (registry fields, the jump route, the mod calls we use) on a new bundled Claude Code; many sessions at once.
- **Finish:** quiet logs in normal use, and a short guide in `claude-code/README.md`.

### Phase 7: session keys and dials (only when the user says so)

The user's revision after a day of use, 2026-11-04. The spec, with the user's answers, the spike results and the design, is `docs/claude-code/session-keys.md`.
- The 4 bottom keys are Session Slot keys, one session each, showing its state, title, context and what it's doing; a press jumps, and holding puts the session on screen in the app on that key.
- The dial under each key belongs to its session. The strip pages through details, and the dial answers the session's questions, plans and approvals.
- An Others key counts the sessions off the keys that need the user.
- Verified by: the deck's checks and the new fixtures, then the user on the hardware with a throwaway session that asks a question, a plan and an approval.
- Done 2026-11-04, committed as `00c7622`, and checked live by the user.

### Phase 8: efficiency and update resilience (only when the user says so)

Planned 2026-11-05, after the user asked how a press flows through the system and where it is inefficient, fragile or not future-proof. The spec, with the user's words, the questions for them, the workstreams and the facts they rest on, is `docs/claude-code/hardening.md`. Its session starts from `docs/claude-code/hardening-kickoff.md`.
- **Measure first:** the idle baseline, before any change and after each workstream.
- **Idle work:**
  - mod copies that aren't the current one, polling once a second;
  - a model emit on every poll;
  - the two once-a-second file scans;
  - the "seen" check's process spawns.
- **Resilience:**
  - catching a newer Claude Code the day it lands;
  - a ten-minute live smoke test after each update;
  - recheck's gaps;
  - what a hung deck does to the hooks;
  - the reboot still open from Phase 6.
- **Maintenance:**
  - one routine after an update;
  - a test for `vendor/refresh.mjs`;
  - pruning features the user doesn't use.
- Verified by: every check as now, a mutation per new rule, the idle numbers against the target the user agrees, the smoke test live, and a day of use.

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
- 2026-11-01, **Phase 3 started** as workflow `wf_eb1b88f3-f07`: a builder per track (A plugin, B deck, C tools), then an independent reviewer per track that re-runs its checks, then a fixer for blockers and majors. Each agent edits only its track's folder and commits nothing; the main thread verifies and commits. The spike bridge (47600) and S0 stay up for ladder step 4.
- 2026-11-01, **Phase 3 built and verified.** All 8 agents of `wf_eb1b88f3-f07` finished.
  - **Track A, the plugin** (`claude-code/plugin/`, type-checked through `claude-code/plugin-tsc/`): the reviewer passed it with 5 minors, so no fixer ran. The engine won't load a module that stores `$` or passes it to a method. So `register.ts` holds the 13 hooks and one adapter, and the protocol logic lives in plain modules. `claude plugin test` can't read files outside the plugin, so `tests/fixtures.gen.ts` is a generated copy of the fixtures.
  - **Track B, the deck** (`claude-code/deck/`): the reviewer found 1 blocker and 2 majors, and the fixer fixed all three.
    - The Mode strip wrote live data into `title`. Its key is now `target`.
    - A quick second press answered the next request before the key showed it: a probe allowed another session's `rm -rf` 80 ms after an Approve. A press now counts only once its request has been on the key for 1 s.
    - A prompt waiting behind a turn over 60 s was failed, though it was sent later. Its `waiting` now stops the 60 s clock.
  - **Track C, the tools** (`claude-code/tools/`): 1 major, fixed. The fake Claude passed Allow or Deny answers that carried extra fields, such as `updatedPermissions`.
  - **Re-run by the main thread:**
    - Plugin: `tsc` exit 0; `plugin validate` with 2.1.309 passes; `plugin test` 39/39; the fixtures copy is current.
    - Deck: typecheck exit 0; 146/146 tests; build exit 0; `streamdeck validate` passes.
    - Tools: 77/77, and both `--help` exit 0.
    - The deck's and the tools' tests also pass with the clock moved two days ahead, past the fixtures' T0 (2026-11-02T06:13Z).
  - **Left for the next round:** the agents' contract questions and the reviewers' minors.
- 2026-11-01, **PROTOCOL.md amended** after Phase 3's build. Nothing changes on the wire, so `v` stays 1. The full list is in its Amendments section; the main decisions:
  - **A Saved Prompt waiting behind a long turn stays waiting.** Its `waiting` stops the 60 s clock. It fails only if its session goes 60 s without an open poll, since a live mod always keeps one open. Mode commands keep the 60 s, which bounds the mode rule's window.
  - **A press counts only once its request has been on the key for 1 s.** A double press can't answer a request nobody saw. Phase 4 checks that 1 s outlasts the key's checkmark and doesn't feel slow.
  - **While a Saved Prompt key's last prompt is in flight,** another press alerts and sends nothing.
  - **Answers to the hook are exactly Allow, Deny or `{}`,** and both runners check that. An expected `{}` means no decision.
  - **Release rules 2 and 3 compare arrival with `statusUpdatedAt`,** both on this Mac's clock. The fixtures' times are absolute around T0 (2026-11-02T06:13Z), so runners follow the fixture's clock.
  - Also spelled out: the command states, a new `inst` and a vanished session failing their commands, the host pattern, `needs_action` as a string, the mod's failure rules, and the `end` reason `clear`.
  - `make-fixtures.mjs` now writes only when run, so the tools import the reference implementation instead of copying it.
- 2026-11-01, **fix round for the review's minors** (workflow `wf_9f6acfe7-511`: a fixer per track, an independent verifier, and a refixer for the deck).
  - **Plugin:** the token is hidden before an error text is cut, including any 8-character run of it. Hello, events and results now fail after 35 s unanswered, like the poll. After an outage the deck ends on the current model.
  - **Deck:** the runner holds `/v1/permission` answers to the exact bodies. A waiting prompt fails after 60 s without a poll. A Saved Prompt key won't send twice while its prompt is in flight. `/v1/next`'s query is scrubbed. A vanished session's open poll is answered.
  - **The verifier caught a regression:** the deck read `turnWrapUp.needsUser` only when it was `true`. The app (4.4212.0, read in its bundle) writes it only as a string, so the refixer made it count as a non-empty string too.
  - **Tools:**
    - Fixes: a crash on deep input; fp pairing; scrubbing token runs; the `.key` test; usage checked before the token; `approve pN`; no answers to `ask` requests; a stricter write guard.
    - Amendments now applied: the 60 s and no-poll rules, rule 4, the host pattern, `inst` handling.
    - The tools import the reference implementation from `make-fixtures.mjs` instead of copying it.
  - **Re-run by the main thread:** plugin 51/51 with `tsc`, validate and the fixtures check; deck 155/155 with typecheck, build and validate; tools 89/89. The deck's and the tools' tests pass with the clock two days ahead too.
  - **The questions it raised went into a second set of amendments,** the most visible being that status rule 6 now follows the app's own `Dw`: a turn wrap-up's `needsUser` replaces the summary's `needs_action`. A third round brings the code up to them.
- 2026-11-01, **ladder step 4 started** with S0, on a snapshot of the plugin and tools at b5685f5 (in the scratchpad, so the third round's edits can't reload mid-test). The spike bridge is stopped; the fake bridge holds 47600 with the spike token. `claude-code/sandbox-plugin` points at the snapshot for now.
  - **Works:**
    - **The real mod loads by hot reload** about 4 s after the old plugin folder was touched. Its hello carried plugin 0.1.0, Claude Code 2.1.309 and the engine's model (`claude-sonnet-5-5`, while the app's record still says Haiku, as S4 found).
    - **Mode command:** lowering to Manual was `done` in 31 ms with no permission request, then `settings {mode: "default"}` on the same ordered line.
    - **Prompt command:** `waiting`, then `done` within 35 ms. Then `turn.start`, `tool.start` for Write (summary `s7.txt`, fp `4723aacf`), and `measure` (`context {percent 10, tokens 100995, window 1000000}`, `cost {usd}`).
  - **Found: a hot reload that swaps in a different plugin keeps the old plugin's `hooks.json` hooks.** The new mod ran, but the PermissionRequest still went to the spike's `/permission`, got 404, and fell back to the app's dialog. The spike's name differed (`deck-spike` against `streamdeck-bridge`), which is the likely cause. So the http hook needs a session started with the plugin already in place, which matters for Phase 5 too.
  - **Found: on its first load the engine writes `.claude-plugin/types/` and `tsconfig.json` into the plugin folder.** That write reloads the mod once more at the next turn (a new `inst` and hello), as Track A predicted. The types folder ignores itself; the plugin's `tsconfig.json` needs a `.gitignore` entry before the link points at `claude-code/plugin/`.
  - **Blocked:** S0 is waiting on the app's dialog for that Write. Stopping its turn from here was refused by the app's auto-mode classifier.
  - The user then said yes to a fresh session: **Deck test T1** (`local_5b6232aa-…`), from the `deck-sandbox` preset, in Manual. The preset sets no model, so T1 inherited the main thread's (Opus 5.5). Its mod said hello at once.
- 2026-11-01, **round 3: the code meets the second set of amendments** (workflow `wf_cf2e3d17-43e`).
  - **Plugin:** an outage ends only when the request that began it goes through, and hello leaves out a model it can't read.
  - **Deck:**
    - The scrubber is built once per secret and scans in linear time, without recursion: 1.6M short strings take 8 ms instead of 2.3 s, and no valid body gets 400.
    - A new `inst` answers the old instance's poll.
    - A command no poll takes within 60 s fails with "not delivered".
    - Rule 6 follows the app.
  - **Tools:** permission answers are checked exactly, values from mod bodies are stored only as strings, the fingerprint check pairs only by fp, rule 3 goes by observation, and the write guard sees the firmlink. Also the Saved Prompt lock, the old poll's answer, "not delivered" and rule 6. The refixer fixed one major: a subagent's `failed` had ended the main loop's fingerprint wait.
  - **Re-run by the main thread:** plugin 55/55, `tsc`, validate and the fixtures check; deck 168/168, typecheck, build and validate; tools 100/100. The deck's and the tools' tests pass with the clock two days ahead too.
  - **Left open:** a handful of minors and contract questions, batched with step 4's findings into the next round.
- 2026-11-01, **ladder step 4 passes in Deck test T1** (the snapshot at b5685f5 against the fake bridge; run log in the scratchpad's `step4/run/`). T1 loaded the real plugin at start, hooks and mod, with no prompt.
  - **Approve:** a Write in Manual reached `/v1/permission` and was held as `p1` (`Write`, `t1-a.txt`). Both sides' fingerprints were `42e4136f` (`fp-check match: true`). Approve with `shown: p1` allowed it, and the Write finished 10 ms later. The turn ended `done`, and the file holds "alpha".
  - **Deny:** held as `p2` with matching fps (`a4326d9c`). The Deny stopped the turn (`turn.end` reason `answer`), and no file was written.
  - **Prompts:** a prompt right after the Deny went in at once, so a deck Deny doesn't block prompts. A second prompt sent while T1 was busy reported `waiting` and went in 20 s later, when that turn ended.
  - **One-press mode:** a raise to Accept edits raised the app's permission request 10 ms after delivery. The fake allowed it in under 1 ms, and the command was `done` 24 ms after delivery, with the app's text and then `settings {mode}`. Lowering back to Manual raised a request too this time, also allowed by the mode rule.
  - **Events:** `attach` and `detach` came as the user looked at T1, and `measure` carried context and `{usd}` cost. `settings` carried `mode` from the first prompt and `effort: "max"`: the preset sets no model or effort, so T1 inherited the main thread's.
  - **Found:**
    - **A deck Deny also breaks the mod's next request.** The `tool.end` send right after the interrupt failed without reaching the bridge. The mod backed off 1 s, said hello on the same `inst`, and resent it under the same `seq`. It recovered as designed, but every Deny costs a 1 s delay and a debug-log line. Likely the engine abandons the mod's fetches at an interrupt (reference.md, "Work that outlives a dispatch").
    - **A call refused at the permission prompt reaches the mod as an error result,** with `is_error` and the standard rejection text, not as `{deny}`. So `tool.end` says `ok: false` without `denied`. PROTOCOL.md should say so.
    - **The deck only accepts 64-character tokens,** and the preset holds the spike's 48-character one. Sessions from the preset can reach the real deck only once the user puts the deck's token in the preset.
  - **Not covered, left for Phase 4 with the user:** a request answered in the app (release rule 1), a question (`ask`), Esc, and whether any card flashes in the app during a one-press raise.
- 2026-11-01, **ladder step 5, the part without presses, passes.**
  - **Setup:** the fake bridge was stopped, `claude-code/sandbox-plugin` now points at `../claude-code/plugin`, and `.gitignore` takes the `tsconfig.json` the engine writes there. Only our deck plugin was restarted (`streamdeck restart com.karimdhanji.claude`). It now runs round 3's build, listening on 127.0.0.1:47600 with its own token; the S6 build on 47601 is gone.
  - **The run:** `fake-claude --interactive hello status auth answered-in-app answered-in-app-registry session-gone`, with Enter piped to its eye checks: 6 passed, 0 failed.
  - **The deck's log:** each play's fresh `inst` read as a restart, and the old poll was answered. Auth refusals came in the contract's order. Held requests #1 and #2 were released by rule 1 (fps `71376090`, `85db07b2`), and #3 when its client closed. Nothing was left held.
  - **Not covered:** the fixtures with presses, and every "CHECK on the deck" line, go to Phase 4.
  - **Left over:** T1 and S0 still carry the spike token, so their mods get 401 from the deck and keep backing off. That's harmless, and a line in its log every 30 s each.
- 2026-11-01, **the user put the deck's token in the `deck-sandbox` preset, and S0 and T1 were archived with their OK.** On the deck, the Session key shows title and status, and the Sessions strip shows title, status, model and effort.
- 2026-11-01, **round 4: the code meets the third set of amendments** (workflow `wf_589940e3-051`, no refix needed).
  - **Plugin:**
    - A rejected fetch is retried once after 100 ms with no hello.
    - `canonical()` no longer recurses, so a 20,000-deep input now gets its fp; before, no `tool.start` was sent at all.
    - Main-loop checks treat a non-string `agent` as the main loop.
    - New tests pin what ends an outage and that only a hello's answer can stop the mod.
  - **Deck:** an older `inst`'s poll is answered at once. Rule 6 is the app's `_D`; on this Mac's 24 records, the same 2 count as needs-you under the old and new reading. A deeply nested hello `v` gets the version error, and Node's own error answers carry `{"error"}`.
  - **Tools:** the same `inst` and rule-6 changes, rule 4 per turn, log lines that can't throw, and an fp check that no longer gives up early.
  - **Re-run by the main thread:** plugin 75/75 with `tsc`, validate and the fixtures check; deck 181/181 with typecheck, build and validate; tools 109/109. The deck's and the tools' tests pass with the clock two days ahead too.
  - **Left for Phase 6:**
    - A deck restart can let a replaced mod instance's late request become the "newest" `inst`, starving the live one's polls. A fix: only a hello makes an `inst` current.
    - `canonical()` runs out of memory on a cyclic object, which can't come from JSON tool input.
    - The deck can't see the app's background tasks, which hide the app's needs-input indicator.
    - The app's summary loader `OM` drops malformed summaries the deck still reads.
    - The tools have small test gaps.
    - The fake bridge still takes a result from an older `inst`, where the amended text and the real deck ignore it.
- 2026-11-01, **Phase 4, part 2, with the user on the hardware.** Deck test T2 and T3 (`local_fa0238d4-…`, `local_484dec9b-…`) were started from the preset at the user's word, in Manual on Haiku at low effort. Both said hello to the real deck with the preset's new token.
  - **Steps 1–4 pass:**
    - **Approve and Deny:** each answered the request shown: T2's `t2-a.txt` allowed, then T3's `t3-b.txt` denied 3.5 s later. T3 then refused to try `t3-d.txt`, even when a peer message called the Deny a test. That's the right call.
    - **Double press:** T2 issued `t2-c.txt` and `t2-e.txt` back to back, so `#4` reached the key 24 ms after the first Approve. The second press 251 ms later was refused (in sight 151 ms, under 1000 ms).
    - **Question:** held as `ask`. Each press opened T2 in about 60 ms, and the app's record shows T2 focused 151 ms after the first. Answered in the app, it was released by rule 1.
  - **The user found a press on a question looked dead,** since the key gave no feedback. They chose a plain label over answering from the deck. The key now reads "Answer in app", and the press shows the OK (b108275).
  - **A fast deck restart skips the hello:**
    - `streamdeck restart` brought the deck back 85 ms after it stopped. T2's and T3's polls failed, and round 4's quick retry reached the new deck with no hello or version check.
    - PROTOCOL.md now makes the quick retry a quiet hello. A subagent is building the mod's side in a scratch copy, to be applied between the user's steps.
  - **Step 6 failed on setup:** the Saved Prompt's Property Inspector was open for about one second (the Stream Deck log) and no text was saved. The key shows "Set text", and each press alerted.
  - **Mode, through the dial:**
    - Accept edits, Manual and Auto were each applied in about 30 ms through the mode rule.
    - **From Auto, the change back to Manual was refused by the app's auto-mode classifier:** the mod's `$.mcp.call` is judged like any tool call. So in Auto, the user's own default, the deck can't change a session's mode. T3 is still in Auto.
  - **Step 9:** Esc showed "interrupted" on the deck several seconds late, by the user's eye. Its events are logged only at debug, so the retest runs with the deck at debug level.
  - Step 8's Session key and the dial's jumps are in the log (about 60 ms each). The user hasn't said yet whether they visibly switched the app.
  - **The quick hello is in** (a subagent's patch, applied between steps):
    - A rejected fetch now brings a quiet hello 100 ms later, then the failed request. Plugin: `tsc` clean, validate passes, 77/77 tests, fixtures current; the six new tests fail against the old `bridge.ts`.
    - T2 and T3 hot-reloaded it, each with a new `inst` and hello.
    - **Live check:** `streamdeck restart` stopped the deck at 04:28:02.977, and the new process listened 79 ms later. Both sessions said hello to it 31 ms after that, before their polls. The deck now logs at debug level (`log-level.txt`) for the Esc retest.
    - **For Phase 6:** after a Deny, the quick hello's window lasts until the reopened poll answers, up to 20 s. A second Deny inside it counts as an outage, which costs one debug line and a 1 s wait.
- 2026-11-01, **the `deny` fixture and PROTOCOL.md's wording caught up with round 4.**
  - The fixture's refusal is now an errored result, and its `tool.end` has no `denied`.
  - Matching covers 2xx and error answers separately, the records list names the two fields rule 6 reads, and rule 6 lists its known differences from the app.
  - Plugin 75/75 (its `deny` fixture passes), deck 181/181, tools 109/109, and all 14 fixtures end to end through the tools' CLIs.
- 2026-11-02, **Phase 4, part 3: retests, then a stop at the user's request.** The user unplugged the deck for about 10 hours. Times below are local (CST); the deck's log is in UTC, six hours ahead.
  - **Step 6 failed on setup again.**
    - Both presses reached the deck with no saved text: 08:04:56 with T2 picked on the Sessions dial, and 08:05:21 with T3 on screen. Each logged "no text set".
    - The Stream Deck log shows the Saved Prompt key's settings page wasn't opened after 21:35 last night, and then for only a second. So the text was never saved.
    - The page itself works. It was run in a browser against a throwaway stand-in for the app's socket on 127.0.0.1, using `ws` from the deck's `node_modules`. Typing saved `{"text": …, "label": …}` 400 ms after the last keystroke, and again when focus left the box.
    - The retest needs the text typed in the key's Prompt box, under Title. The key then shows the text instead of "Set text".
  - **Step 9: the deck showed "interrupted" 3.8 s and 9.1 s after each Esc.** The user saw 5–10 s.
    - The mod's `turn.end` (`aborted`) reached the deck 13 ms and 3 ms after each Esc, going by T3's transcript.
    - Claude Code kept T3 `busy` in the registry well past each Esc. For the second, `statusUpdatedAt` says idle came 8.2 s after it.
    - The deck shows `working` while the registry says `busy`. After a normal Stop, the registry goes idle in about 130 ms (Phase 1), so only an interrupt lags.
    - **Fix, not built:** show `interrupted` when the main loop's last `turn.end` has reason `aborted` and arrived after the registry's `statusUpdatedAt`, even if the registry still says `busy`.
      - It touches: PROTOCOL.md's status list (item 5), `sessionStatus` and its inputs, the fake deck's status in the tools, and a fixture step that keeps the registry `busy` after the abort.
      - Untested: whether a `waiting` session lags the same way after an Esc.
    - Step 9's prompt half (refused after Esc, then sent once the user types) waits on step 6's text.
  - **Step 10 dropped:** the user won't approve Claude's requests while editing in Lightroom.
  - **Step 11 later**, at the user's choice.
    - The night didn't test sleep: both sessions polled every 20 s throughout.
    - Stream Deck's wake event at 08:03:45 found nothing to recover.
  - **Step 8:** still waiting on the user's word on whether the Session key visibly switched the app.
  - **Cleanup:**
    - A fake bridge from last night's end-to-end run (pid 91084, orphaned to launchd, listening on 127.0.0.1) was still up. Stopped.
    - T2 and T3 stay idle for the retests. T3 is still in Auto.
    - The deck plugin stays running at debug level.
  - **Next, when the user is back:**
    1. Build the Esc fix, if the user wants it before the retest.
    2. The user types the Saved Prompt's text, then redoes steps 6 and 9.
    3. The user answers step 8.
    4. Step 11, with the Claude app restart last.
    5. Then decide how the deck handles a mode change from Auto, which the classifier refuses.
- 2026-11-02, **the Esc fix, built while the user was away, at their word.**
  - **The protocol** (main thread):
    - Status rule 3: a `busy` that began before the main loop's `aborted` `turn.end` doesn't count. "Began before" goes by `statusUpdatedAt`, else by the deck's first reading of that `busy`; a session's very first reading counts.
    - The Fixtures section now says the runner's wall clock follows the registry's times, and an event's `at` plays no part.
    - `prompt-refused` keeps the registry `busy` past the `turn.end`. Before the fix, the deck and the tools both failed it at line 13 ("expected interrupted, got working").
  - **A workflow built it:** one agent each for the deck and the tools, each reviewed adversarially.
    - Both reviews passed, with minor findings and nits only, so no fix-up pass ran.
    - The deck's reviewer ran 19 mutations, and the suite caught 17. The two survivors are defensive paths: a `failed` after the `aborted` end, and the order of first readings during a release.
  - **The main thread then applied:**
    - The protocol wording above.
    - A try/catch around the deck's new status log, so it can't throw into a hold, a release or a route.
    - In the tools: checks that a held question and a registry `waiting` still show needs-you under the exception.
    - In the fake: a `statusUpdatedAt` that goes missing is no change, as on the real deck.
    - Rule names made consistent in the tools' README and doc comment, and `statusSeen` added to `/control/state`.
    - The three new tools checks each fail under a mutation of the code they guard.
  - **The deck now logs each session's status change at debug:** `STATUS <key> <from> → <to>`, and `STATUS <key> → <status>` on first sight. Phase 4 can time statuses from the log.
  - **Checks, re-run by the main thread:**
    - Plugin: `tsc` clean, validate passes, 77/77, fixtures in sync.
    - Deck: typecheck clean, 186/186, the same with the clock two days ahead and a week back, build and validate pass.
    - Tools: 112/112.
  - **Live, without the deck attached:**
    - `streamdeck restart` at 15:02:25Z. T2 and T3 said hello 21–22 ms after the new deck listened.
    - T3 got a 1-to-3000 count, then `stop_session` interrupted it at 15:03:03.420Z, by its transcript.
    - The deck got the `turn.end` 7 ms later and logged `working → interrupted` in the same millisecond.
    - The registry went idle at 15:03:05.196Z, 1.8 s after the stop. The old code would have waited for that.
  - **After that stop, T3 drops the mod's prompts until someone types in it (S2).** So step 6's retest should pick T2. Step 9's retest on T3 expects the refusal anyway.
  - **Left open:**
    - Whether `waiting` lags the same way after an Esc at a permission prompt. The retest's STATUS lines will show it.
    - A late `turn.end` for an older turn id still replaces a newer unfinished turn. It can't happen on the mod's one ordered line.
    - The deck still shows idle for up to 1 s after a turn starts, until its next registry reading shows `busy`.
  - **Next, when the user is back:**
    1. The user types the Saved Prompt's text, then redoes step 6 with T2 picked, and step 9 on T3.
    2. The user answers step 8.
    3. Step 11, with the Claude app restart last.
    4. Then decide how the deck handles a mode change from Auto, which the classifier refuses.
- 2026-11-03, **Phase 4 retests, and the poll fix, at the user's word.**
  - **Step 6 passed.** The user picked T2 on the Sessions dial and pressed Saved Prompt at 01:33:20.534Z. The deck delivered the text through T2's open poll at once, and the key showed sent 55 ms after the press. T2 answered "ok".
  - **Step 9's Esc half passed.** T3's `turn.end` (`aborted`) reached the deck at 01:34:29.128Z, and the deck logged `working → interrupted` in the same millisecond. The registry went idle 5.2 s later. The prompt half (refused, then sent once the user types) is still to do.
  - **New: done showed 17 s late.** T2's turn ended at 01:33:23.658Z, but the deck showed `working` until 01:33:40.892Z.
    - The cause is the mod's own long poll: Claude Code keeps a session `busy` in the registry until the mod's open requests end.
    - Evidence: in all three turn ends logged at debug level (T2 and T3 on 11-03, T3 on 11-02), the registry's `statusUpdatedAt` came 2 ms before the deck logged the mod's next poll, that is, as the poll that was open when the turn ended ran out.
    - So the 2–8 s after an Esc in part 3 came from the same poll, and the delay follows every turn. Phase 1's 130 ms after a normal Stop predates the long poll.
  - **The fix, first step:** the deck answers a session's open poll with `{"cmds": []}` as soon as the main loop's `turn.end` or `failed` arrives. The mod polls again at once, or after the rest of its 1 s floor.
    - **Protocol** (main thread): the rule under `GET /v1/next`, status rule 3's reason, "The mod never holds up the session's work" in Failure and recovery, and the 2026-11-03 amendment.
    - **Fixtures:** `status`, `approve`, `deny` and `prompt-refused` answer `n1` at the `turn.end`, and the mod then polls again (`n2`). Before the fix, the deck failed those 4 and the tools failed 11 tests.
    - **The plugin's fixture runner** now lets the mod's 1 s floor pass while it waits for a poll. Without that, the 4 fail on the plugin side ("the mod never sent GET /v1/next"). The mod's comment on that floor now names a turn's end; its code is unchanged.
    - Editing the plugin folder hot-reloaded T3's and T2's mods (01:47:08Z and 01:47:25Z), with nothing in flight.
    - **A workflow built the deck and tools sides,** each reviewed adversarially. Both reviews passed with minors and nits only. Both reviewers found that no test pinned a waiting prompt's 60 s clock after a turn-end answer.
    - **The main thread then added:**
      - those tests, plus a dropped-retry test and a closed-reply test in the deck;
      - the main loop's `end` and an unknown type in the tools' "other events" test;
      - a README `jq` line that times the three.
      Six mutants were each caught by the test meant for them.
  - **Checks, by the main thread:**
    - Plugin: `tsc` clean, validate passes, 77/77, fixtures in sync.
    - Deck: typecheck clean, 193/193, the same with the clock two days ahead and a week back, build and validate pass.
    - Tools: 118/118.
  - **Live, at the user's go (restart 02:51:32Z), the first step was not enough:**
    - A short turn on T2 went idle 5 ms after its `turn.end`, and the deck showed done 0.85 s after.
    - A count turn whose `measure` came after its `turn.end` stayed busy 20 s. The mod had opened its next poll before sending the `measure`, so it never had nothing open until that poll ran out.
  - **What the engine shows** (the app's `claude.app`, 2.1.309): for app-hosted sessions, the registry's status mirrors the engine's session state (`running` → busy). The turn's end also waits on the post-turn summary classifier, capped at 60 s, and `idle` can come from a check when the session's background work changes. The timings say the mod's open requests are what it waits on.
  - **A throwaway prototype** answered polls at once for 3 s after a turn end. The same kind of count turn went idle 4 ms after its `turn.end` (03:06:58.949Z → .953Z), and the deck showed done 0.1 s after. The mod polled once a second meanwhile.
  - **The fix, second step** (protocol amended again): from the main loop's turn end, the deck answers the session's polls at once while the registry still says busy, until a main-loop `turn.start`, for at most 60 s.
    - `status`, `approve` and `prompt-refused` answer the next poll at once. `deny` keeps its next poll held, since its registry says `waiting`.
    - The plugin passes 77/77 on them, unchanged. The deck fails the 3 changed fixtures, and the tools fail 10 tests.
    - A workflow built the deck and tools sides, each reviewed adversarially and then fixed.
    - The second fixture sync, of the plugin's tests alone, didn't reload the mods: their instances are the same since 01:47.
  - **Both reviewers found a gap:** a poll could come before the deck's once-a-second reading said busy, after a turn shorter than a scan or after a Deny, and be held for 20 s.
    - The deck's fix pass answers the held poll when the reading turns busy inside the 60 s.
    - The main thread put that in the protocol and in the fake, and flipped the fake's test that pinned the opposite.
    - The main thread added deck tests for an old instance's poll in that time, and for a waiting prompt across 60 s of polls answered at once.
    - Four mutants were each caught by the test meant for them.
  - **Left open (minor):** the fake times its 60 s on the wall clock where the deck uses a monotonic one, and two of its README claims have no test of their own. Readings that go busy, idle, then busy again inside the 60 s answer polls at once again, which the protocol's wording allows.
  - **Checks, by the main thread:**
    - Plugin: `tsc` clean, validate passes, 77/77, fixtures in sync.
    - Deck: typecheck clean, 205/205, the same with the clock two days ahead and a week back, build and validate pass.
    - Tools: 128/128.
  - **Live** (restart 04:06:44Z):
    - A short turn on T2 ended at 04:07:04.170Z. The registry went idle 6 ms later, and the deck showed done 0.83 s after the end.
    - A count turn, with its `measure` after the `turn.end`, ended at 04:07:20.699Z. The registry went idle 5 ms later, and the deck showed done 0.33 s after.
    - Once the registry said idle, the mod's next poll was held as usual.
  - **Step 9's prompt half passed** at 03:37Z, while the prototype ran:
    - The user picked T3 and pressed Saved Prompt. The key showed refused 7 ms after the press: "dropped: the session was stopped and nobody has sent input since".
    - The user typed in T3. A second press during that turn waited, then went out as the turn ended (sent at 03:37:31.029Z), and T3 answered "ok".
  - **Step 8 passed, by the log:** at 03:37:51.304Z the Session key opened T3, and the app reported T3 on screen (`attach`) 133 ms after the press. T3 had left the screen at 03:37:39Z.
  - **Next:**
    1. Step 11, at the user's choice, with the Claude app restart last.
    2. The decision on mode changes from Auto, which the classifier refuses.
    3. Then Phase 5, when the user says so.
- 2026-11-03, **Phase 5 started, as an overnight run, at the user's word.** The user took all three recommendations:
  1. **Install tonight.** Once the route checks out, the main thread adds env lines to `~/.claude/settings.json`. They point at a release copy of the plugin kept in the repo, so dev edits never reach the user's sessions, and `DECK_TOKEN` goes in the same block. One command undoes it. Sessions load the plugin when they next start, this one included. Terminal sessions stay quiet.
  2. **Mode from Auto:** test, in T3 (already in Auto), a PreToolUse hook that the deck allows only for a change pressed on the deck. If that gets past the auto-mode classifier, build it. If not, the Mode dial on an Auto session shows "Change in app", and a press jumps to the session.
  3. **Phase 6 items that need nobody** come after tonight's Phase 5 work.
  - The Mac is kept awake for the night (`request_keep_awake`, until the session goes idle). T2 (Manual) and T3 (Auto) are reused, so tonight needs no new session.
  - **The night's order:**
    1. Side by side: the install route's open questions (does settings `env` override the preset's; does the app set plugin folders of its own; a folder marketplace as the fallback), and the Auto spike.
    2. One protocol round and a build workflow.
    3. The release, the install and their checks.
    4. Phase 6.
- 2026-11-03, **the Auto spike: a PreToolUse allow carries the deck's mode change past the auto-mode classifier.** Tools: `spikes/cc-pretool/`, a stand-in on 127.0.0.1:47610 that answers a PreToolUse http hook and hands modes to a temporary poller in the mod. The poller called the same `set_session_permission_mode` as a deck mode command, with no prompt in the transcript. Log: `spikes/results/20261103-042849-pretool/requests.jsonl`.
  - **Baseline, T3 in Auto, no new hook:** the mod's change to Manual got no answer for minutes. Nothing reached the deck, and the registry stayed `idle`. In Phase 4 the same call was refused in 14 ms ("The server-side auto mode classifi…"). In the 2.1.309 engine the server-side check judges calls against the verdicts that come with the model's own response, and a mod's call has none.
  - **T2 in Manual:** the same call returned in 34 ms ("This session is already in Manual mode"). It raised a PermissionRequest that the deck held as an ordinary `tool` request, since no deck command was in flight. Rule 3 released it when the registry read idle.
  - **A hot reload doesn't register hooks newly added to `hooks.json`.** After adding the PreToolUse hook, neither T2's own Read nor the mod's call reached the stand-in, so the test needed a fresh session. That matches ladder step 4.
  - **T4** (`local_ffcddcd0-…`) was started from the preset, in Auto, on Haiku at low effort, with the hook in place. Its first Read reached the stand-in 9 ms after `tool.start`, with `permission_mode: auto`.
  - **The decisive run:** with the stand-in allowing, the mod's change from Auto to Manual reached the hook 15 ms after the mod took it, with input `{session_id: "self", mode: "default"}`. It was allowed, and was `done` 31 ms after the call began: "This session now runs in Manual mode (default), from Auto". No PermissionRequest came, and the app's record says `default`.
  - **A raise still asks:** Manual to Auto passed the hook's allow, then raised the app's own PermissionRequest 8 ms later. The deck held it as `#3`, since this change wasn't a deck command. So the design needs both rules: PreToolUse for the classifier, and the existing mode rule for the raise's card. From Auto every change goes down, so no card comes.
  - **Left behind:** T4 is in Manual with the app's card for that raise still open (registry `waiting`). It's for the user in the morning. T3's unanswered calls may still settle later; it's a throwaway session. The spike's edits to the plugin are reverted, and the stand-in is stopped.
  - **Next:** the protocol round adds the PreToolUse route.
- 2026-11-03, **the install route, from a research agent.** It read the 2.1.309 engine and the app's JS, and ran 13 experiments with the 2.1.309 binary in scratch configs, with no credentials and no model calls. Its files are in this session's scratchpad (`route/`).
  - **Settings `env` against the launch env:** in a desktop session the launch environment wins, key by key. The engine latches the launch keys at start, and the app's preset and Environment variables are launch env. Elsewhere, settings win.
    - So the user's sessions will load the release copy from settings.
    - Preset sandbox sessions keep the dev copy and the preset's token. Their debug log says so: "Ignoring CLAUDE_CODE_PLUGIN_DIRS, DECK_TOKEN from userSettings…".
  - **The app's own plugins** come in its initialize request, which the engine merges with the env's folders, so ours drops nothing of theirs. The app never sets `CLAUDE_CODE_PLUGIN_DIRS`.
  - **When changes apply:**
    - A settings `env` change re-applies to running sessions about 1 s later. A new token reaches their mods and hooks.
    - A new plugin folder takes effect only at a session's start; `/reload-plugins` doesn't add it.
    - Removing the keys doesn't unset them in running sessions.
  - **Who else loads it, and the fixes:**
    - **Terminal and VS Code sessions, and `claude -p` runs.** They have no host id.
    - **A `claude` started inside a desktop session.** It inherits the parent's host id, with `CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1`, and its mod ran under the parent's identity.
    - **Side chats and recaps forked from preset sessions.** They carry the parent's host id and `CLAUDE_CODE_TAGS`. Forks of the user's sessions read no settings. This may explain some RESTART lines in Phase 4.
    - **The app's pre-warmed spares.** They run the mod's `session.start` with the host id of the session they'll become, before they're claimed.
    - **The fixes,** in the protocol round's "Desktop sessions only":
      - The mod uses the engine's own test (`dp()`, `_M()`) plus the forks' tags.
      - The bridge takes a hook's request only from a session the registry confirms by host and `session_id`.
      - A hello under a listed host with another `sessionId` gets 409.
  - **A mod's call has `tool_use_id: "toolu_plugin_…"`** (the Auto spike). It could tell the mod's call from Claude's own, but the rule doesn't use it yet.
  - **After the install,** this session's Bash env picks up both keys through that re-apply. So `claude` and `$CC` commands run here need `env -u CLAUDE_CODE_PLUGIN_DIRS -u DECK_TOKEN`. `DECK_TOKEN` will be in every Claude Code child process. That's no weaker than the token file, which any process of the user's can read.
  - **The route stays as planned:** settings `env` with `CLAUDE_CODE_PLUGIN_DIRS` pointing at `claude-code/release/streamdeck-bridge`, plus `DECK_TOKEN`, and no `CLAUDE_CODE_PLUGIN_DIR_WATCH`. The fallback, a folder marketplace, was checked too: the inline copy wins over an installed one of the same name.
- 2026-11-03, **the protocol round for Phase 5** (uncommitted until it's built):
  - **PROTOCOL.md's 2026-11-03 amendment:** the mode hook and `POST /v1/pretool`; "Desktop sessions only"; only a hello makes an `inst` current; and the fixtures `mode-from-auto`, `stray-instance` and `not-desktop`, with `mode-raise` and `mode-not-ours` changed (17 in all).
  - **Before the build:** the deck failed 6 checks, the tools 11 and the plugin 2.
  - **Also committed tonight:** `claude-code/tools/recheck.mjs` (5ccf1c2) re-checks the app internals after an update. 18 tests pass, and on this Mac it reports 29 ok, 0 warn, 0 fail.
  - **Building:** workflow `wf_614315da-297` covers deck, plugin and tools, each built, reviewed adversarially, then refixed. An agent writes `claude-code/install/deck-install.mjs` (status, release, install, undo).
- 2026-11-03, **the round is built and committed (911188a); its reviews found a gap in the contract.**
  - **Also committed:** `claude-code/install/deck-install.mjs` with 10 tests (401545c), and the user guide `claude-code/README.md` (911188a).
  - **Built:**
    - Deck 0.3.0: `/v1/pretool`, confirmation with one more registry reading, 409 hellos, and quiet logs for refusals.
    - Plugin 0.2.0: the mode hook, and the mod talks only from a desktop session of its own. T2–T4 hot-reloaded it and said hello as 0.2.0.
    - Tools: the same rules in the fake deck and the player.
  - **Re-run by the main thread:**
    - Deck: 230/230, also with the clock two days ahead and a week back, plus typecheck, build and validate.
    - Plugin: `tsc`, validate, 111/111 and the fixtures check.
    - Tools: 175/175, also clock-shifted. Install: 10/10.
    - Two mutations, each in a scratch copy: a plugin gate that lets everything through fails 28 tests, and a deck that confirms every hook request fails 9.
  - **The gap, which all three reviewers found:** only a hello makes an `inst` current, but the mod says hello only when it loads and after a failed request. Two things leave it with no hello to the deck and no failure to tell it so: a deck restart in the second the mod waits after a turn ends, and a registry reading that misses the session (release rule 4). Its polls were then answered at once for good, and the session took no prompts or mode changes. Probes with the real mod code showed it; HEAD's old rule had healed it by itself.
  - **The fix, in the amendment's items 5 and 6:**
    - A session no instance has said hello for gets 409 `{"error": "hello first"}` on its polls. The mod takes that like a rejected fetch: a quiet hello about 100 ms later.
    - It goes only to a session with no current instance, so it never displaces one. A replaced instance can't answer it, since a reload drops its timers.
    - The narrower choice over "any instance new to this deck": a lingering old process could otherwise take over a session after a restart.
    - New fixture `hello-again` (18 in all). Smaller points the builders raised are settled too: results with no `inst` are ignored, a hello that isn't made current changes nothing, and the mode check reads `session_id`.
    - Before the build: the deck fails 2 tests, the tools 7 and the plugin 1, all of them `hello-again` or the fixture count.
  - **Open, to check live:** whether the app's forks (side chats, recaps) write a registry file under the parent's host. None does now: 12 files, one per host.
  - **Next:** round 2's workflow builds the hello-first rule and the reviewers' remaining minors in all three tracks. Then the live checks, the release and the install.
- 2026-11-03, **round 2 is built: hello first, and the minors** (workflow `wf_d8fa4582-a7a`, each track built, reviewed adversarially, then refixed).
  - **Built:**
    - Deck: a poll for a session with no current instance gets 409 `hello first`, logged at info once per host and quietly after. Results with no `inst` are ignored. The registry, records and model wiring moved to `src/model/sources.ts`, so the fixture runner runs the plugin's own wiring. Every answer the runner waits for has a 2 s deadline, and `npm test` gives each test 20 s and force-exits, so a regression fails instead of hanging.
    - Plugin: a poll answered 409 `hello first` goes the way of a rejected fetch, a quiet hello 100 ms later. A change from Auto the engine refuses at once is reported `refused`, as the contract says. The mods API has no typed refusal, so the mod reads the engine's own words, and falls back to `failed` should they change. `sync-fixtures.mjs --check` also checks `hooks.json` against PROTOCOL.md, `plugin.json`'s keys (2.1.309 loads hooks from it too) and its version, with 21 tests of its own.
    - Tools: the same rules in the fake deck. Interactive mode skips expect lines, since a real deck shows none of the fixtures' sessions.
  - **Re-run by the main thread:**
    - Deck: 245/245, the same with the clock two days ahead and a week back, plus typecheck, build and validate.
    - Plugin: `tsc`, validate, 136/136, the fixtures check's four lines, and its tests, 21/21.
    - Tools: 192/192. Install: 10/10. `make-fixtures.mjs` regenerates with no change.
  - **Settled from the reviews:** an unlisted host's 409 logs at debug only. Hellos need no client-gone check, since an instance can only make itself current. Three hung test runs a round-1 reviewer left in a scratch copy were stopped.
  - **For round 3, decided:**
    - **Two live mods for one host across a deck restart,** a restarted process and its lingering predecessor: both get 409 and say hello, and the later one is made current, possibly the predecessor's. The mod can't rank itself. The mods API has no pid, and a resumed session keeps its session id: the app resumes with `resume: cliSessionId`, and only `--fork-session` makes a new id. The fix: a current instance that goes 60 s with no poll open and none sent stops counting, and the deck forgets the session's instances, as at release rule 4 but keeping the rest. The live mod's next poll then gets 409, and its hello makes it current. That heals any dead current instance.
    - **A repeated hello from the current instance,** as after every Deny: its mode and effort are only what the mod last told the deck. So it could put back a mode older than the PermissionRequest's the deck just took, until the next prompt. It will take `cwd` and `model` only. Both decks take everything today.
    - **Contract wording:** the registry's `startedAt`, and which of two files for one host the deck shows; release rule 4 when no file lists the host; `plugin.json` declares nothing; `refused` covers the engine refusing the call. The recheck script watches the engine's wording.
  - **Next:** commit, restart the deck, the live checks, then the release and the install.
- 2026-11-03, **round 2 is committed (f90bc6f) and live, and the plugin is installed for the user's sessions.**
  - **Spot checks by the main thread,** each in a scratch copy:
    - The deck with no 409 fails 8 tests. With the 409 sent to stray instances too, 10 fail.
    - The mod taking the 409 as a failure fails 4 tests, and so does the mod taking any 409 as a call for hello.
  - **The deck restarted at 08:41 UTC** with f90bc6f's build. T2, T3 and T4 said hello within 30 ms of it, each after the restart rejected its open poll. There have been no 409s or restarts since, and each keeps a 20 s poll open.
  - **Live checks, all 8 pass** (the main thread's script, using T2's host and made-up ones, so nothing reaches any session):
    - a PermissionRequest with no `X-Deck-Host` gets `{}` at once, and so does one under T2's host with another `session_id`;
    - T2's own mode check with no command in flight gets `{}`;
    - a hello under T2's host with another sid gets 409 `not this session`;
    - a stray instance's poll under T2's host gets `{"cmds": []}` at once;
    - a poll for a host no instance has said hello for gets 409 `hello first`;
    - a wrong token gets 401, and a foreign `Host` gets 403.
    - The deck logged each refusal once at info.
  - **The release:** f90bc6f, version 0.2.0, 16 files, validated with 2.1.309.
  - **The install:**
    - `settings.json` is backed up, and the diff, with the token masked, adds only the `env` block.
    - `deck-install.mjs status` exits 0, "installed and current".
    - As the route research said, this session's Bash picked up both keys, while the tools and tests read neither. CLAUDE.md now says to run `claude` with `env -u`, records where the plugin loads, and lists the install commands. The root README has the guide's link.
  - **The user's sessions load it when they next start.** The running ones are untouched.
  - **Next:** round 3, the hardening and the decisions above.
- 2026-11-03, **round 3 for Phase 6**, built and verified:
  - **PROTOCOL.md's amendment "2026-11-03, Phase 6",** no wire change:
    - a current instance that stops polling stops counting, after 60 s with no poll open and none sent;
    - the current instance's repeated hello takes `cwd` and `model` only;
    - status rule 3 shows `working` from the main loop's `turn.start`;
    - status rule 6 reads only a summary the app's loader `OM` would keep;
    - the registry: `startedAt`, two files for one host, release rule 4 once no file lists the host, and a reading that can't list the folder keeps the last one (until now it ended every session at once);
    - the quick hello's window closes 2 s after its answer;
    - wording: `refused` covers the engine's refusal, and `plugin.json` declares nothing.
  - **Fixtures:** `status` expects `working` right after its `turn.start`, and `needs-you-record` is new (19 in all). A scan of every fixture found no expect the new rule 3 changes.
  - **Before the build:** the deck fails 3 of 246 tests, the plugin passes 137 of 137, and the tools fail 9 of 193.
  - **Built:** workflow `wf_1ed8c2df-844` covers deck, plugin and tools, each built, reviewed adversarially, then refixed (9 agents, about 90 minutes). It also covers many-sessions tests, quiet info logs, recheck checks for the summary loader and the engine's refusal wording, the round 2 nits, and versions deck 0.3.1 and plugin 0.2.1.
    - All three reviews: pass with minors. The refixes closed the test gaps they found.
    - recheck now looks for the loader's `is_noteworthy` check only next to its field list: the app has a second copy in another validator, which hid a change to the loader.
    - The plugin tests' fake deck now fails a test after 200 requests at one clock time, whatever the route, instead of hanging `claude plugin test`. A mod that retries at once after the test kit gives up on a request can still hang it, so the checks run it under a time limit.
  - **Verified on the main thread:**
    - deck: typecheck; 286 of 286 tests, also with the clock 2 days ahead and a week back; build; validate.
    - plugin: tsc; validate; 152 of 152 tests; sync `--check`; its 21 tests.
    - tools 207 of 207; install 10 of 10; recheck 32 ok; the fixtures regenerate unchanged.
    - Five mutations in scratch copies, each caught: no watch at the hello (13 fail), the repeated hello takes the mode (1), rule 3's new clause off (5), the fake's `is_noteworthy` unchecked (4), and the quick hello's window never ending (4).
  - **Measured:** one registry reading of 30 files takes about 8 ms cold and 0.4 ms warm. Info lines across the 19 fixtures went from 107 to 98.
  - **Wording settled from the reviews** (Phase 6 item 7), matching what the code already did:
    - a restart is a new instance replacing a current one;
    - the 60 s count from the later of the last poll's end and the hello, and only polls count;
    - after them a prompt or mode press alerts, while Approve and Deny still answer;
    - rule 3's turn ends at a `failed` too;
    - past the quick hello's window, only a rejection or a 409 gets its own quick hello.
  - **Two decisions for round 4,** each reproduced by both the deck and tools reviews:
    - **The forget drops the predecessor too.** A predecessor still alive that says one more hello after the live mod is current again counts as new. That's a restart over the live mod: its commands fail and it's a stray for another minute. Round 4 keeps the list of hellos at the forget, and lets any hello make its instance current while none is. The deck fixer tried it in scratch: all 286 tests pass, and the flip-flop is gone.
    - **A hello's mode can be older than a PermissionRequest's.** The hello put back an older mode in two cases: after the forget, and after a deck restart when a PermissionRequest comes before the mod's first hello. The Mode dial's press without a turn applies what it shows, so the stale mode could be applied. Round 4: no hello replaces a mode or effort the deck took from a PermissionRequest. That fixes both paths, and 1 test changes.
  - **Accepted as minor:**
    - The plugin's version-stop line JSON-encodes before it hides the token. The deck's token is hex, so nothing changes.
    - A held poll that drops more than 2 s after each quick hello cycles quietly, no faster than about 2 s a round, as the window allows.
  - **Committed** as cfe4554. CLAUDE.md now runs `plugin test` under a time limit.
- 2026-11-03, **round 3 live:**
  - Released the plugin from cfe4554 (0.2.1); `deck-install.mjs status` says installed and current.
  - Restarted only the Claude deck plugin, on 0.3.1. T2–T4 said hello with plugin 0.2.1 within 30 ms of the bridge listening.
  - All 8 live checks pass, and nothing reached any session. The log has no warning, loop or stale line.
- 2026-11-03, **round 4 for Phase 6, built and verified:**
  - **PROTOCOL.md's amendment "2026-11-03, Phase 6, round 4",** no wire or fixture change:
    - the forget keeps the hellos, and while no instance is current, any instance's hello makes its own current;
    - no hello replaces a mode or effort the deck took from a PermissionRequest;
    - wording: while another is current, a hello from an instance that never said hello is a restart. The bullet on instances that don't count had said it changes nothing.
  - **Built:** workflow `wf_5907b8c6-531` covered deck and tools; the plugin is untouched. Each was built, reviewed adversarially, then refixed.
    - **Deck 0.3.2:** `#unpolled` keeps `hellos`. `#makeCurrent` lets any hello make its instance current while none is, and moves it to the newest place. `take()` records where each of mode and effort came from (`from`). The UNPOLLED and 409 lines say which case it is.
    - **Round 3's nits:** the registry's warn streak ends on any good stat; pins for the current tool kept at the forget, and for one UNPOLLED info line when a waiting prompt fails then.
    - **Tools:** the fake deck mirrors both rules, with `settingsFrom` in the state. Its mod has the 2 s window, checked against bridge.ts's constants. Registry-missing is said again when the folder goes a second time. The log-kinds test runs on the default 60 s.
    - **Both reviews passed with minors,** all gaps in the tests: the said-again rule was tested only with a PermissionRequest's mode, so a regression there passed; nothing pinned "nothing is failed or forgotten"; and a PermissionRequest equal to the shown mode wasn't pinned as its source. The fixers added the tests, with no source change.
    - **I fixed the wording myself:** PROTOCOL.md's bullet on instances that don't count, the tools README's copy of it, and the fake's 409 line after the 60 s.
  - **Verified on the main thread:**
    - deck: typecheck; 301 of 301, also at +2 days and −7 days; build; validate.
    - plugin: tsc; validate; 152 of 152; sync `--check`; sync tests 21 of 21.
    - tools 218 of 218; install 10 of 10; recheck 32 ok; the fixtures regenerate unchanged.
    - Eight mutations of my own on a scratch copy, each caught:
      - the forget clears the hellos: deck 6 fail, fake 7;
      - a hello replaces a PermissionRequest's mode: deck 7, fake 5;
      - a listed instance's hello never makes it current: deck 16, fake 15;
      - no move to the newest place: deck 1;
      - a settings event recorded as a PermissionRequest's: deck 3.
  - **Accepted, for the record:** only a PermissionRequest's mode and effort are protected.
    - While none is current, a predecessor's hello can still replace a mode the live mod sent as `settings`. To do so it must land before the live mod's own hello, which comes within about 1.1 s.
    - A stray's `settings` event can replace a PermissionRequest's mode. A dying process's engine rarely changes mode.
    - Both are narrow, and both matter only through the Mode dial's press without a turn, which applies the shown mode. That's a design question for the user.
  - **Also accepted as nits:** the fake has no test for moving to the newest place, nor for its 2 s window's length, nor for kind mode's source. The real deck has a test for the first. It takes kind mode's mode and effort as any PermissionRequest's, before its kind-mode branch.
  - `claude-code/README.md`'s "When something's off" now covers a press that alerts because a session's plugin hasn't checked in for a minute.
  - **Committed** as 86054e1.
- 2026-11-03, **round 4 live:**
  - Restarted only the Claude deck plugin, on 0.3.2, at 12:02Z. T2–T4 said hello with plugin 0.2.1 within 22 ms of the bridge listening.
  - All 8 live checks pass.
  - **The live 60 s check on T2** (`stale.mjs` in the scratchpad), all 6 pass:
    - A made-up instance's hello under T2's host replaced T2's mod: RESTART.
    - It never polled. At 60.6 s it stopped counting (UNPOLLED). T2's mod's next poll got 409, and its hello made it current 105 ms later, with no restart.
    - The made-up instance's poll was then a stray's, answered at once with none. Its hello again changed nothing, and T2's held poll stayed open.
    - Nothing reached T2's engine: the hellos carried no mode, model or effort, and no command was queued.
  - The log since the restart has no warning or error. `deck-install.mjs status`: installed and current, since the plugin is unchanged.
- 2026-11-03, **Phase 6's overnight scope is done.** What's left needs the user, as one checklist:
  1. If **Deck test T4** still shows an approval card in the app, answer it either way. Then say whether the main thread may archive Deck test T2, T3 and T4.
  2. **Restart the Claude app.** Every session then has the plugin, and each on the Sessions dial should show full status, not just working or idle.
  3. **Mode dial on one of your sessions in Auto:** turn to Manual and press: one press, no card. Then back to Auto: the app's approval comes up and the deck allows it. Report whether each change took and whether a card stayed up.
  4. **Approve and Deny** on a request from one of your sessions in Manual. Report what the key showed and whether each press took.
  5. **A Saved Prompt** with harmless text to one of your sessions.
  6. **Recovery:** restart the Stream Deck app, then sleep and wake the Mac, then reboot. After each, the sessions should show full status within seconds, though macOS 26 can delay localhost for minutes after a reboot.
  7. Optional: `chmod 600 ~/.claude/settings.json`.
  8. Optional: open a side chat in one of your sessions for a minute, for the fork check. The main thread then reads the deck's log.
  9. **A design question:** should a Mode dial press without a turn do nothing, rather than apply the mode it shows? That would close the stale-mode residue that round 4 accepted.
  10. **A day of real use,** with the deck's log at debug. Then the main thread reads the logs.
  - To take the plugin back out of the user's sessions: `deck-install.mjs undo`.
- 2026-11-03, **the Mode dial's press without a turn now does nothing** (checklist item 9, the user's answer):
  - **Deck 0.3.3:** `#apply` in `src/mode/dials.ts` applies only `choice`, the mode turned to, and never the target's own mode as shown. Without a choice, a press or tap logs one info line and sends nothing, with no alert. That closes round 4's accepted stale-mode residue: a mode the deck shows a moment late can no longer be re-applied.
  - **Tests:**
    - A new test covers a press or tap without a turn: before any turn, after a choice goes back on its own or on long-touch, and after an applied change. Each sends nothing and alerts nothing.
    - The carry-over test now expects a tap for a new target to apply nothing, rather than alert.
  - **Verified:** typecheck; 302 of 302; build; validate.
  - **Breaks, each on a scratch copy against an unbroken control (302 of 302):**
    - re-applying the shown mode fails the new test;
    - alerting on an unturned press fails both.
  - `claude-code/README.md`'s Mode dial bullet says so.
  - **Committed** as cdef222. Only the Claude deck plugin was restarted, on 0.3.3, at 14:18:57Z. Both running sessions said hello with plugin 0.2.1 within 22 ms.
- 2026-11-03, **the user's checks so far, by the deck's log** (the user hasn't reported yet):
  - Item 2: the Claude app was restarted. The registry lists 2 sessions, and T2–T4 aren't running.
  - Item 3, at 14:13 on the session "Stream Deck Claude Code plugin":
    - Auto to Manual: one command, done.
    - Back to Auto: the mode check and kind mode's PermissionRequest were both allowed for the same command, and it was done in 0.2 s.
    - Whether the app's card stayed up is the user's to say.
  - Item 1: the main thread archived Deck test T2, T3 and T4 at the user's word, at 14:35Z. Each get_session then said `isArchived: true`. The next live check needs a new throwaway session from the `deck-sandbox` preset, since the scratchpad's live scripts take T2's host.

- 2026-11-04, **Phase 7 started: session keys and dials, at the user's word.** After a session with the plugin, the user asked for a key per session (working, waiting or done, context, and a way to jump to one that needs them), the 4 bottom keys as sessions, and the dial under each key for that session: details on the strip, and answers to its questions. Their answers to the clarifying round:
  1. Keys fill, then stay put. A long press puts the session on screen in the app on that key, even over another.
  2. The dial answers questions, plans and approvals: turn to pick, press or tap to send.
  3. With nothing to answer, turning pages through details, and a press or tap jumps.
  4. An Others key for the sessions off the keys that need the user.
  - They saw a mockup of the layout. The spec is `docs/claude-code/session-keys.md`.
- 2026-11-04, **spikes T5 and T6, and a read of the engine: the deck can answer questions and plans.**
  - **Tools:** `spikes/cc-ask/`, a stand-in for `/v1/permission` on 127.0.0.1:47610 and a copy of the plugin whose PermissionRequest hook points at it. `claude-code/sandbox-plugin` pointed at the copy during the spike and points back at `claude-code/plugin` since. Log: `spikes/results/20261104-234605-ask/requests.jsonl`.
  - **Sessions:** throwaway **Deck test T5** (`local_bd3145de-…`) and **T6** (`local_08819a8d-…`), from the preset, on Haiku at low effort.
  - **AskUserQuestion:** an Allow whose `updatedInput` is the request's `tool_input` plus `answers` answered it. That covered one question, then two questions, one of them multi-select (`"Apple, Plum"`). Claude read `Your questions have been answered: …`, and the registry left `waiting`.
  - **ExitPlanMode:**
    - A plain Allow is ignored: T5 stayed `waiting` on the app's card, and the app won't stop a turn that waits on the user. T5 still shows that card.
    - An Allow with `updatedInput` (the `tool_input` unchanged) and a session `setMode` approved T6's plans into Accept edits and into Auto. With no `setMode`, the session went back to its mode from before Plan.
    - A Deny without `interrupt`, with feedback, kept T6 planning.
    - `tool_input` is `{}` until Claude writes a plan file, then `{plan, planFilePath}`.
  - **The engine** (2.1.309, an agent's read of the binary and the app's JS):
    - For tools that need the person, it ignores a hook's plain Allow, takes one with `updatedInput`, and always takes a Deny.
    - When the hook wins, it cancels the app's request, and the app removes its card.
    - An `updatedInput` that fails the schema becomes a deny.
    - A multi-select answer joins the labels with `", "`, quoting a label that holds `", "` or `"` as JSON.
  - `lsappinfo front` and `info -only bundleid` name the app in front with no permission prompt, in under 1 ms. That's for "seen".
- 2026-11-04, **the protocol round for Phase 7** (PROTOCOL.md's amendment "2026-11-04, session keys"; nothing changes for the plugin, so `v` stays 1):
  - A Session Slot dial answers its own session's requests with Allow or Deny, the new **Answer** (questions) or **Approve plan** (plans), or Deny.
  - A held `ask` request keeps its `tool_input`, up to 64 KiB.
  - Fixtures: dial `press` lines and 6 new fixtures, 25 in all.
  - **Before the build:** the deck fails 7 of 308 tests and the tools 2 of 158, all of them the new fixtures or the fixture count. The plugin passes 158 of 158 with its copy of the fixtures regenerated.
  - **Building:** workflow `wf_60dcceca-4ab`. The deck's core, then its surfaces, beside the tools, each reviewed adversarially and then fixed.
- 2026-11-04, **the Phase 7 build** (workflow `wf_60dcceca-4ab`, 6 agents, about 2 h 40 min; nothing committed, and the live deck not restarted):
  - **The deck, 0.4.0** (`claude-code/deck/`):
    - Session Slot (`com.karimdhanji.claude.slot`), one action for keys and dials, and Other Sessions (`com.karimdhanji.claude.others`).
    - Six strip layouts, and the dial's answer screens.
    - Slots saved in `run/slots.json`, and the `lsappinfo` front check for "seen".
  - **The tools** (`claude-code/tools/`): the fake deck answers from a dial, and the player reads dial lines.
  - **The deck's review** ran 55 mutations, and 7 survived. It found 2 majors:
    - A tick just before a push sent a choice the strip never showed. The chips also wrapped, from Deny to Allow and from Reject to Approve · Auto.
    - No test pinned the start-over when a slot's session changes. A probe sent a pick made for A's approval to B's.
  - **The fixer:**
    - A press sends only the choice the strip painted, once shown 300 ms, and the chips stop at either end. It added tests for the start-over.
    - Of the 10 minors and nits, it fixed 9:
      - key presses check what the key showed;
      - only the desktop app's `attach` counts;
      - `lsappinfo` runs only while a slot or Others key is on the deck;
      - tick errors are caught;
      - a stuck check is killed and dropped;
      - `slots.json` is flushed before its rename;
      - a hold refuses an archived session;
      - tests for the rest.
    - It left one, a moved or deleted slot key keeping its session. The README now tells the user how to recover.
    - 488 tests pass, and its 41 mutations were all caught.
  - **The tools' review:** no blockers or majors. 36 of 39 mutations were caught, 1 was equivalent and 2 found test gaps, among 5 minors and 3 nits. Three minors were contract gaps between the deck and the fake (the next entry).
  - **The main thread's checks:**
    - The deck: typecheck, and 488 of 488 tests, also with the clock two days ahead and a week back. The build passes, and so does `streamdeck validate`.
    - The tools: 248 of 248 tests, three ways, and each CLI's `--help`.
    - The plugin: `tsc`, sync `--check` and its 21 tests. `validate` and 158 of 158 on 2.1.309 and on 2.1.317.
    - The install tests: 10 of 10.
  - **The app bundles Claude Code 2.1.317,** since 2026-11-03 13:22, and every running session runs it, T5 and T6 included. So the spikes' results hold on 2.1.317.
    - The engine read was of 2.1.309. The hook-answer code it relied on is in both binaries: `control_cancel_request`, the `updatedInput` checks and the hook's deny.
    - `recheck.mjs`: 34 ok, 0 fail, and 1 warn: the vendored mods API and CLAUDE.md are for 2.1.309.
- 2026-11-04, **the contract round after the reviews** (PROTOCOL.md amendments 5–8 of "2026-11-04, session keys"; `v` stays 1):
  - **Fixtures, 26 in all:**
    - New: `dial-next`. A question is answered in the app, then the session's next request takes the strip, and the dial allows it.
    - `answer-questions` now picks out of option order, and one label holds a double quote. Each runner had passed cases the other would fail.
  - **PROTOCOL.md:**
    - The pick rule: a dial sends only the choice its strip showed, once shown 300 ms.
    - A request answered elsewhere blocks its dial only while nothing newer shows.
    - The AskUserQuestion forms the deck can't read are listed.
    - The token scrub is in Transport. An `ask` whose `tool_input` it changed is display-only, so an echo is always exact.
    - Only the desktop app's `attach` and `detach` count.
  - **The deck** (an agent):
    - A newer request painted on the strip clears the gone mark.
    - `scrubJson` flags a change inside `tool_input`, names included, and the model makes that ask display-only ("Holds the deck's token").
    - 495 tests pass, and its 16 mutations were all caught.
  - **The tools** (an agent):
    - The fake reads forms and plan lines by the deck's rules, and covers its test gaps.
    - 252 tests pass, all 26 fixtures play through the CLI, and its 15 mutations were all caught.
    - Two gaps went back to the same agent, and both are fixed:
      - The fake now parses a body first, then scrubs every string and name, as the deck does. Before, a number holding a run of the token got 400, and a `\u`-escaped token got through.
      - Only a desktop `attach` or `detach` counts.
    - Then 255 tests passed, and its 14 mutations were all caught.
    - Left, all small:
      - the fake doesn't scrub a poll's query for its own logic;
      - it refuses a hook body that isn't an object;
      - the runners treat malformed dial lines differently, and no fixture has one.
  - **The main thread's checks:**
    - The deck: typecheck; 495 of 495, also with the clock two days ahead and a week back; build and `streamdeck validate`.
    - The plugin: 159 of 159 on 2.1.309 and on 2.1.317, and sync `--check`.
    - 5 mutations of its own on what the dial sends:
      - Caught: Approve · Manual into bypassPermissions (by the type check), a press with nothing picked sending Allow, Other… sending, and Next with nothing ticked.
      - One, picks kept in pick order, changes nothing sent: the answer is put in option order before it goes.
  - **T5's leftover plan card** was answered in the app: the plan was approved and T5 replied "done".
- 2026-11-04, **Phase 7 live, with the user** (from 04:08Z on 11-05; nothing committed before it):
  - **Deck 0.4.0:** the main thread restarted only the Claude deck plugin, at the user's word. The bridge listened at once, and all four running sessions said hello on Claude Code 2.1.317.
  - **Slots:**
    - The user placed Session Slot on the 4 bottom keys and the 4 dials, and a fifth on the top row.
    - The slots filled one by one as they appeared:
      - this session first, since it needed the user;
      - then T7, T6 and T5, newest first;
      - then the Lightroom session, on the top-row slot.
    - `run/slots.json` is `0600` in a `0700` folder.
  - **Throwaway session Deck test T7** (`local_f47631fd-…`), from the preset, on Haiku at low effort, in Manual:
    - **Question,** "Red or blue?": the 2nd dial sent one Answer, `{"Red or blue?":"Blue"}`, from its own session's dial, and T7 read "Blue".
    - **Plan:** the 2nd dial approved it into Manual. get_session then said `default`, and T7 wrote `s11.txt`.
    - **Approvals:**
      - The Approve key allowed the Write of `s11.txt` and `echo twelve > s12.txt`: the user reached for it both times.
      - The 2nd dial allowed `echo thirteen > s13.txt` ("allow, from its session's dial").
      - Each file holds its word.
    - No press alerted in any of these.
  - **Seen:** each turn of T7's that ended with T7 on screen and Claude in front counted as seen within a second.
  - **Jumps:** slot keys and strip taps jumped in about 60 ms, and set the target.
  - **Long press:** with a session of the user's newly opened, holding the 4th key put it there in place of T5. Holding it again with T5 on screen put T5 back. A swap between two slots wasn't tried live; unit tests cover it.
  - **One brief state:** after a hook answer, the deck shows needs-you for about 0.2 s, until the registry leaves `waiting`. It was there before Phase 7, and nobody noticed it.
  - The user: "All worked".
- 2026-11-05, **the repo follows the app's Claude Code, 2.1.317** (at the user's word, after Phase 7's commit):
  - **The vendored reference** moved from `claude-code/vendor/mods-api-2.1.309/` to `claude-code/vendor/mods-api/`, rebuilt from 2.1.317's binary. Its version is the first line of `claude-code.d.ts`.
  - **`claude-code/vendor/refresh.mjs`** does that in one command. It reads the binary's `__BUN,__bun` file table, read only, and never loads the skill.
    - On 2.1.309 it gives the old vendored copy back, byte for byte. The d.ts matches to its line 16,972; 2.1.309 had appended the built-in tools' input types after that.
    - On 2.1.317, its d.ts is the very file the engine wrote beside the plugin.
    - Between the two versions, `reference.md` and the d.ts changed: about 6,000 lines, mostly new calls and wording. The examples didn't change.
  - **`recheck.mjs`** takes the version it expects from that first line, with a `--vendored FILE` option for its tests, and fails when the line is missing.
  - **`deck-install.mjs release`** validates with the newest bundled Claude Code, found by version and build folder, where it had hard-coded 2.1.309's build path. It gained `--claude-code-root`.
  - **Checks:**
    - The mod type-checks against 2.1.317's declarations; `plugin validate` passes and `plugin test` is 159 of 159.
    - Tools 256 of 256, install 11 of 11.
    - `recheck.mjs`: 35 ok, 0 warn, 0 fail.
    - Two mutations of the installer's lookup were each caught.
  - CLAUDE.md, PROTOCOL.md's Parties and the tools README say how a refresh goes.
- 2026-11-05, **Phase 7 closed, and Phase 8 planned:**
  - **Card close:** the user saw the app's question and plan cards close by themselves when the dial answered T7. That was the last thing not seen live, and session-keys.md and the README now say so.
  - **Archived:** the main thread archived Deck test T5, T6 and T7 at the user's word.
  - **The user's question** was how a press flows from the deck into Claude Code and back, and where that is inefficient, fragile or not future-proof.
    - A read-only map of the code gave every timer, poll, fallback and dependency with its file and line.
    - The main thread's answer named, in order of worth: idle polling from mod copies that aren't current, an emit on every poll, the two once-a-second file scans, and the "seen" spawns.
    - It named as failure points: app updates breaking undocumented internals, version skew between running sessions, a hung deck holding hooks until their timeout, and the port and token.
  - **The handover,** at the user's word: `docs/claude-code/hardening.md` is Phase 8's spec, and `docs/claude-code/hardening-kickoff.md` is its session's kickoff. CLAUDE.md names both.
- 2026-11-05, **Phase 8 started, at the user's word** (session "Stream Deck Claude Code Phase 8", `local_2f4a7a56-…`, without `ultracode`):
  - **A fourth goal:** the user's prompt added "make it easy to deploy on other machines" to the spec's three. The spec doesn't cover it, so it goes to the questions round.
  - **The tree wasn't clean:** the last session's two pieces of work were uncommitted. At the user's word, after every check passed again, they went in as two commits:
    - `af7c773`, the 2.1.317 reference;
    - `cb4a85e`, Phase 7's close and Phase 8's plan.
    - The checks: tsc, sync `--check`, `plugin validate`, `plugin test` 159/159, tools 256/256, install 11/11, recheck 35 ok.
  - **Released:** `release` put out `register.ts`'s comment-only change, and `status` says installed and current.
  - **From the deck's log, before the baseline** (debug since the deck's start at 04:08Z on 11-05):
    - **Polls:** each session holds one 20 s poll, 3 a minute. Overnight, 05–13Z with 6 sessions open, that was 1,080 an hour.
    - **Stray copies (B1):** 64 polls across the logs since 11-02, all in one minute of a live check on 11-03 (12:02–12:03Z). None in daily use since.
    - **The burst after a turn (B3):** 16 "answered at once" from 04:08Z to 00:38Z.
  - **Measuring:** `top -l … -c d -pid <deck>` gives the deck's CPU, context switches, BSD syscalls and idle wakeups without root. In 10 s with this session busy: about 200 switches, 580 syscalls, 0.01–0.03 s of CPU.
  - **Not in the log:** scans, stats, walks, `lsappinfo` spawns, emits and sends. A debug-only `IDLE` line a minute will count them, with a read-only `tools/idle-report.mjs`. Loading it takes one restart of the deck plugin.
- 2026-11-05, **the idle counters, and research for the questions round:**
  - **The counters** (uncommitted):
    - `deck/src/util/idle.ts` counts each kind of work with one Map increment where it happens. At debug it writes `Idle: IDLE {"s","userMs","sysMs","elu","rssMB","counts"}` a minute.
    - `tools/idle-report.mjs` reports a window of the log per minute: the IDLE counts, polls by session and kind, and events. With `--live N` it adds `top`'s numbers for the deck.
    - Checks: deck 501/501, also with the clock two days ahead and a week back; build; validate; tools 264/264. 20 of 20 deck mutations were caught, and 7 of 7 in the tool.
    - The main thread restarted the Claude deck plugin at 01:06:41Z with nothing held. Both sessions said hello within 20 ms.
  - **The first IDLE minute,** startup included, 2 sessions:
    - 60 registry scans (120 stats) and 60 records scans (306 stats, 5 walks);
    - 30 emits building 1,169 views, about 39 per emit (B2);
    - 118 ticks; 208 ms of CPU.
  - **B3 is longer than the spec thought.** With this session's background agents running, the registry stays `busy` after the main loop's turn. Each short turn of the main thread re-arms the 60 s window, so this session got 23–37 polls a minute answered at once (00:40–00:57Z).
  - **Feature use,** from the deck's logs since 11-02 (an agent's read):
    - Never pressed by the user: the Mode key, the Deny key, Saved Prompt keys (3 test presses on 11-03), the Others key.
    - The Mode dial: only in the user's checklist on 11-03, Auto to Manual and back.
    - Used: the Session Slots since 11-05, and before them the Sessions dial and the Session key.
    - Phase 7's layout is under a day old, so the evidence is thin.
  - **C5, a hung deck and the hooks.** Setup: a stand-in that accepts and never answers, a fake Messages API, scratch configs, Claude Code 2.1.317, a 15 s timeout standing in for 600 s.
    - A timeout, or a refused connection, is no decision. The engine's default http hook timeout is also 600 s.
    - Desktop sessions, and a terminal session's main thread: the dialog shows at once, beside the hook.
    - `claude -p` runs, nested or not: the run waits the hook's whole timeout, then denies.
    - A terminal session's background agents: no dialog until the hook ends.
    - The mode hook fires only in desktop sessions, where a hung deck delays a mode change by 5 s.
    - Restarting the deck plugin frees every waiting process at once.
    - PROTOCOL.md's Failure and recovery says the dialog stays after a timeout, which holds only for the first kind.
  - **Portability:** the code has no path of this Mac's in it; the setup does.
    - The README's steps leave out developer mode.
    - `install` refuses without `~/.claude/settings.json`.
    - There's no one-command setup.
    - `install --force` replaces another `CLAUDE_CODE_PLUGIN_DIRS` rather than adding to it.
    - A packed `.streamDeckPlugin` would also need:
      - an `.sdignore`, or the token ships inside;
      - a token path outside the repo;
      - `run/` out of the plugin folder, a PROTOCOL.md amendment.
- 2026-11-06, **the idle baseline** (A1):
  - **How:** `tools/idle-report.mjs --live 11`, 01:16:22–01:27:22Z, on deck 0.4.0 plus the counters (pid 71218). Raw output: this session's scratchpad, `baseline.txt`.
  - **Conditions:** 2 sessions open, this one and "Claude plugin session dashboard revision", both idle. Nobody at the Mac: the front app was loginwindow.
  - **A quiet minute,** over the 9 after this session's turn ended (01:17–01:26Z):
    - **CPU:** 100–118 ms, 0.18% of a core. The event loop is 0.13% busy. RSS 77 MB. `ps` agrees: 1.22 s in the 11 minutes.
    - **Kernel, from `top`:** about 830 context switches and 3,100 BSD syscalls. `top`'s idle wakeups read 0, so they're no use here.
    - **Registry:** 60 scans, 60 readdirs, 120 stats.
    - **Records:** 60 scans, 300 stats (5 hosts), 0 walks.
    - **Polls:** 6, three a session, each held 20 s. Each emits (B2).
    - **Ticks:** 120, from the slot keys' and slot dials' 1 s tickers. With the emits they build about 650 views a minute.
    - **Sends:** one key image and one strip a minute, the `since` labels (B6).
  - **The rest:**
    - **The burst after this session's turn (B3):** one poll at once, one answered with none. That's two, as the spec expected with no background work.
    - **Stray copies (B1):** none.
    - **Seen (B5):** not wanted in the window, so no asks. Timed apart: one check costs the deck 0.79 ms of CPU and two spawns (4.6 ms wall). While it's wanted that's about 47 ms of the deck's CPU a minute, about 40% on top of its whole idle CPU, plus 120 spawns and their own CPU.
  - **Reading:** the two 1 s scans are about 480 file operations a minute through Node's thread pool. They're likely most of the context switches and syscalls. B4's after-count will show it.
- 2026-11-06, **the questions round, answered by the user.** They took each recommendation, except that only mode changes go in question 1:
  1. **Features:**
     - Mode changes go: the Mode key, the Mode dial, the PreToolUse mode hook, and the way past the auto-mode classifier.
     - Saved Prompts stay, so the command channel and the mod's long poll stay.
     - The Session key, the Sessions dial and the Others key stay for a week of use to decide. They're cheap and not fragile.
     - The plan dial's "approve into a mode" is part of the approval's answer, not a mode change, and stays.
  2. **The idle target, "near zero":**
     - A quiet minute has no file scans beyond a safety scan every 30 s, no `lsappinfo` after 30 s of waiting, no emits, and ticks only when a label changes.
     - Under 25 ms of CPU, 200 context switches and 600 BSD syscalls, measured as the baseline was, with 2 sessions open.
     - Polls stay at 3 a session.
  3. **Deploy, to the user's other Macs, from a clone:**
     - a one-command `deck-install.mjs setup`;
     - a complete README section, with a check that it worked;
     - `settings.json` made when it's missing;
     - `CLAUDE_CODE_PLUGIN_DIRS` added to, not replaced.
     - No packed plugin file, and nobody else's Macs.
  4. **The hook's timeout stays 600 s.** PROTOCOL.md gets the `-p` and background-agent case, and the restart that ends it.
  5. **A newer Claude Code:** one log line per new version, and the session's version on its strip's Setup page, marked when it's newer than the vendored reference's.
  6. **The brief "needs you" stays.**
- 2026-11-06, **the plan from here** (the spec's order, with the user's answers):
  - **Wave 1, in parallel:**
    - the deck's idle fixes, B2, B4, B5 and B6, then the idle count again;
    - recheck's gaps (C3), its check of the vendored reference (C4), and the refresh test (D2);
    - the deploy work, in `install/` and the README's Setup;
    - in this thread: the PROTOCOL.md amendment for the prune, C5's case and C6's risk, with fixtures.
  - **Wave 2:** the prune on both sides, then a plugin release.
  - **Wave 3:** C1, the smoke test (C2) and the routine after an update (D1).
  - **Left as they are:**
    - **B1:** no stray copy polled in daily use.
    - **B3:** its window must outlast Claude Code's own `busy` after an Esc, 8.2 s in Phase 4. It costs at most about 60 polls per main-loop turn end, and B2 makes each cheap.
- 2026-11-06, **setup on the user's other Macs** (Wave 1's deploy work: a build, a review, a fix round):
  - **`deck-install.mjs setup`** goes from a fresh clone to a working deck in 10 steps:
    1. a preflight;
    2. `npm ci`, only when `node_modules` is missing or the lockfile's sha256 has changed;
    3. the build;
    4. developer mode;
    5. the link, skipped when it's already this clone's;
    6. the deck plugin's restart;
    7. a wait of up to 90 s for the deck's token and its "Bridge: listening" line;
    8. `release`, when the copy is stale;
    9. `install`;
    10. `status`.
    `--dry-run` runs the preflight, and says what each step would do and why.
  - **The preflight refuses** uncommitted changes in `claude-code/deck` or `claude-code/plugin`, a first setup while the Stream Deck app runs, and anything `release` would refuse. On this Mac it refuses now, as meant: setup is for a new Mac.
  - **`install`:**
    - it makes `~/.claude/settings.json` when there's none (0600, in a 0700 folder);
    - it adds the release copy to another `CLAUDE_CODE_PLUGIN_DIRS` value instead of replacing it, and puts it in place of another copy of this plugin.
    - `undo` takes out only copies of this plugin.
  - **The README's Setup** is for a new Mac: open the Stream Deck app once and quit it, `mise install node`, setup, then start a Code-tab session and check the log. It also says how to make the `deck-sandbox` preset.
  - **The review** found nothing that could harm `settings.json` or the token. It found:
    - re-runs that would wipe `node_modules` and build uncommitted deck code;
    - Lua built for nothing by a bare `mise install`;
    - developer mode taking effect only after the Stream Deck app relaunches;
    - about 170 lines to cut.
    All fixed.
  - **Checks:** install tests 20/20 (11 before), 44 mutations caught. `status` and `setup --dry-run` ran for real. A real setup waits for another Mac.
- 2026-11-06, **recheck's gaps, its check of the vendored reference, and the refresh test** (C3, C4 and D2: a build, a review, a fix round):
  - **recheck: 41 ok, 0 warn, 0 fail** (35 before). The new rows:
    - **The vendored mods API (C4):** it rebuilds the reference in memory, with refresh.mjs's own reader, from the binary of the version the d.ts's first line names, and compares. A difference warns. A file table it can't read fails.
    - **The engine:** the registry's status values, and the engine's desktop test and child markers, as strings in its JS. A table it can't read fails.
    - **The bundle:** how the app sets the desktop entrypoint and host id, in app.asar.
    - **Seen:** lsappinfo's two answers, read with the deck's patterns, and Claude's bundle id from Info.plist. On an answer it can't read, it prints only the answer's shape, never another app's name.
  - **The hook's shapes are type-checked, not string-checked.** `plugin-tsc/hook-contract.ts` assigns the deck's exact answers to the engine's types, and reads the five fields the bridge reads. The plugin's tsc then fails when the engine stops taking what the deck sends. The review found that the first version's substring checks failed on harmless refactors and passed a rename.
  - **refresh.mjs** reads the section from its own layout instead of `otool`, so it doesn't need Xcode's tools, and its output is the same byte for byte. `refresh.test.mjs` tests the reader on a synthetic file table: a wrong offset, a missing or doubled entry, a changed first line.
  - **The rows of the spec's Appendix A that nothing checked:**
    - **string checks:** the registry's statuses, the desktop environment, lsappinfo;
    - **the type check:** the hooks' input and answers;
    - **smoke-test steps:** the jump's focus, the hook racing the dialog, answering in the app, Deny's interrupt, the rule for asks, the card closing;
    - **accepted risks:** the records' category rules, a failing `updatedInput`, hooks read at session start, `CLAUDE_CODE_TAGS`, settings `env`.
    - The mode tool's rows go with mode changes.
  - **Checks:** tools 280/280 (264 before), 23 mutations caught in the fix round, the plugin's tsc, sync `--check` and its 21 tests. CLAUDE.md's list of what may run outside the repo now names lsappinfo.
- 2026-11-06, **the deck's idle work, cut (B2, B4, B5, B6).** Wave 1: a build, a review, a fix round. Still deck 0.4.0, live since 04:00:39Z.
  - **B4, the two scans:**
    - The deck watches `~/.claude/sessions` and the app's records tree with `fs.watch` (FSEvents). It scans 50 ms after the first event of a burst, and every 30 s whatever happens.
    - A safety scan that finds a change no event announced counts as `missed`. It logs at info once, and re-watches the folder.
    - Live, a registry change reached the deck 66 ms after its `statusUpdatedAt`. With the old polling it took up to 1 s.
  - **B2, the emits:**
    - A poll no longer emits: nothing a view reads changes on one.
    - Views are built once per change and shared.
    - The Sessions dial's listener does nothing while no Sessions dial is on the deck.
  - **B5, the seen check:** every 1 s for 30 s, every 5 s to 2 minutes, every 15 s to 10 minutes, then once a minute. That's the user's choice on 2026-11-06, over the spec's 15 s. It starts over on an attach, a detach, a press and a wake.
  - **B6, the ticks:** one timer for the slot keys, slot dials and Others, armed at the next moment a shown `since` changes.
  - **The review** found no correctness bug. It found labels that ran late after a sleep, a watch that could go quiet unnoticed, and parts to cut. The fix round fixed both and cut about 130 lines.
  - **Size:** deck source +398/−139, plus `util/folder-watch.ts` (205 lines).
  - **The after-count:** `idle-report --live 15`, 04:01:39–04:16:39Z, the same 2 sessions, nobody at the Mac. A quiet minute, over the 14 after the first:

    | A quiet minute | Baseline | Now | Target |
    |---|---|---|---|
    | CPU | 100–118 ms | 15–20 ms | under 25 ms |
    | Context switches | about 830 | 96–113 | under 200 |
    | BSD syscalls | about 3,100 | 275–352 | under 600 |
    | Registry scans, stats | 60, 120 | 2, 4 | safety scans only |
    | Records scans, stats | 60, 300 | 2, 10 | safety scans only |
    | Emits | 6 | 0 | 0 |
    | Ticks | 120 | 1 | when a label changes |
    | Views built | about 650 | 8 | none set |
    | Polls | 6 | 6 | 3 a session |

  - **Seen** wasn't wanted in the window, so no lsappinfo ran. At its slowest step it's one check a minute, about 110 syscalls, timed apart.
  - **Checks:** deck typecheck; 522/522, also with the clock two days ahead and a week back; build and validate; tools 280/280 with PROTOCOL.md as committed. The fix round caught 51 mutations.
  - **For the smoke test:** the deck now sees registry flips of 50 ms to 1 s. So release rule 2 may release a held approval on a short `waiting → busy → waiting`. Watch for `RELEASED … (rule 2)` while the app's dialog is still up.
- 2026-11-06, **Wave 2: mode changes removed** (at the user's word: a build, a review, a fix round):
  - **The review** found no inconsistency between PROTOCOL.md, the deck, the plugin and the tools. It confirmed in the binaries that the 404 is no decision, and that plugin 0.2.1 against deck 0.5.0, and 0.3.0 against 0.4.0, both still work. It found:
    - **a restart hazard,** already live: the deck's folder had the 0.5.0 manifest but the 0.4.0 build, which registers the two removed actions. Any restart before a rebuild would have left the deck dark, failing open to the app's dialogs. The main thread rebuilt and restarted deck 0.5.0 at 05:06:58Z. Both sessions said hello at once, on plugin 0.2.1.
    - **leftovers,** all fixed: a result's `detail` in the tools and the plugin; the README's claim that the deck shows every session's mode (only a Session Slot's Setup page does now); the hook-error line a 404 leaves in an old session; mode lines in the spec and in this plan's Goal.
  - **The contract,** in this thread: PROTOCOL.md's amendment "2026-11-06, Phase 8".
    - It removes the Mode key and dial, the `mode` command, the mode hook and `/v1/pretool`, and kind `mode`.
    - It writes down B4's watch, C5's hung deck and C6's port risk.
    - `make-fixtures.mjs` drops `mode-raise`, `mode-not-ours` and `mode-from-auto`, and `not-desktop`'s mode check, which leaves 23.
    - `v` stays 1. A session started before plugin 0.3.0 keeps its mode hook until it restarts, and its request gets 404, which is no decision.
  - **Three agents, one per side:**
    - **the deck, 0.5.0:** 12 files deleted, sources +42/−821, tests +71/−500; 503/503; a new test that `/v1/pretool` gets 404;
    - **the tools:** the fakes, the runner and recheck's two mode-only rows; 273/273; recheck 39 ok;
    - **the plugin, 0.3.0:** the mode hook, the mode command and `$.mcp.call`; `plugin test` 155/155.
    - The deck still shows each session's mode, and the plan dial still approves into a mode.
  - **Docs:** the README drops the Mode dial, the Mode key and "Mode changes from Auto", and says to remove a placed one. CLAUDE.md now says one hook.
  - **D1, in this thread:** CLAUDE.md's routine after an app update is now one ordered list of five steps, ending in the smoke test, and it finds `CC` with `sort -V` instead of a hard-coded build folder.
  - **Checks:**
    - deck typecheck, 503/503, validate;
    - tools 273/273; recheck 39 ok, 0 warn, 0 fail;
    - install 20/20;
    - the plugin's tsc, sync `--check` and its 15 tests, `plugin validate`, `plugin test` 155/155.
  - **Committed** as 6282cef. Plugin 0.3.0 is released, and `status` says installed and current. The two running sessions kept 0.2.1, with no reload, as the installer says.
- 2026-11-06, **Wave 3: drift on the deck (C1), the smoke test (C2), and the routine's pointers (D1):**
  - **C1:** the deck reads two versions from the repo: the Claude Code version on the vendored reference's first line, and the plugin's in its plugin.json. It reads both at startup, and again when a hello brings a newer one.
    - **A newer Claude Code:** one info line per version a run (`Versions: Claude Code <v> in <host>: newer than …`). Its session's Setup page reads `<mode> mode · <version> ↑`, in amber. An equal version shows in grey.
    - **An older plugin:** one line per session. Live at 05:33:55Z, both running sessions: `runs plugin 0.2.1, older than 0.3.0 in the repo: it loads the new one when it next starts`.
    - **Checks:** deck 514/514 (503 before), also with the clock shifted; 31 mutations caught; validate. Live since 05:33:55Z, restarted with nothing held.
  - **C2:** `docs/claude-code/smoke-test.md` is 14 steps in a throwaway session, each with the deck log line that proves it.
    - `tools/smoke-check.mjs --since … --host …` finds those lines, and lists every rule-2 release and every warn.
    - Five things show only on screen, and the doc says "you see it" for them.
    - Tools 284/284 (273 before), 12 mutations caught.
  - **D1:** the routine is in CLAUDE.md (Wave 2's entry). The README's update section and recheck's help now point at the smoke test.
- 2026-11-06, **the smoke test, live with the user** (`docs/claude-code/smoke-test.md`, 14:11–14:21Z):
  - **Setup:** the throwaway session "Deck smoke test" (`local_c88d2512-…`), from the preset, on Haiku 5.5 at low effort. It ran plugin 0.3.0 from the dev copy, on Claude Code 2.1.317.
  - **smoke-check: 13 ok, 1 missing,** and no warn or error line in the window:
    - **1:** a slot key opened the user's stopped "Return tiles and frame drop fixes" in 69 ms. It said hello 1.1 s after the press, on plugin 0.3.0 from the release copy.
    - **2 and 10:** jumps from Others and from a slot key opened T in 59 and 63 ms. The app showed it 174 and 147 ms after the press.
    - **3 and 13:** a long press put T on bottom key 4. Two long presses then swapped it with this session and back: the swap Phase 7 never tried live.
    - **4, 5, 6 and 8:** T's dial allowed a Bash, answered a question, approved a plan into Manual, and denied a Bash. After the Deny, the turn ended 128 ms later with no other call. The question's answer was Red, the first option: one tick of the dial, sent as the strip showed it.
    - **9:** the first request was allowed in the app before the steps began. The deck let it go by rule 2, 1 ms after the registry left `waiting`, and the command ran 60 ms later. It was the window's only rule-2 release, and a right one.
    - **11:** a Saved Prompt was done 36 ms after it was queued.
    - **12:** seen, at that turn's end.
    - **14:** T's hello said 2.1.317, the vendored reference's version, so no mark.
    - **7, missing:** every allow and deny went through T's dial, and the Approve and Deny keys were never pressed. The keys' code hasn't changed since Phase 7's live test, and the `approve` and `deny` fixtures press them.
  - **The skew, seen live:** this session, still on plugin 0.2.1, set T's mode. Its old mode hook got `404 POST "/v1/pretool"`, and the change went through.
  - **The user:** "I did the tests and everything looked good", for the steps the log can't show.
- 2026-11-06, **the user's work Mac** (the fourth goal): the user asked how to install the Claude Code side on a work MacBook Pro that has Claude Code and the Stream Deck app, and how to keep both Macs current.
  - **GitHub** stopped at 0b6ecaf, 2026-11-01, 41 commits back, with none of the Claude Code side. The user pushed: `0b6ecaf..7a19008`.
  - **mise refuses a fresh clone:** a copy of `mise.toml` is untrusted, and `mise exec` stops on it until `mise trust` (mise 2026.5.12, tried on a copy in the scratchpad). The README's Setup lacked the step.
  - **A managed Mac's policy** can keep the deck's parts off, going by Claude Code 2.1.317's settings schema:
    - `allowManagedHooksOnly` and `disableAllHooks` stop the hook, and `allowManagedModsOnly` the mod;
    - `allowedHttpHookUrls` must match the hook's URL, and `httpHookAllowedEnvVars` must list `DECK_TOKEN` and `CLAUDE_CODE_HOST_SESSION_ID`;
    - `disableSideloadFlags` likely drops the whole plugin: it drops inline plugins at load, and the engine loads `CLAUDE_CODE_PLUGIN_DIRS` folders as inline plugins.
    - Policy files are under `/Library/Application Support/ClaudeCode/` and `/Library/Managed Preferences/`. A policy can also come with the organization's Claude account, which no file shows.
    - The README's check greps both folders with `-a`, since a plain grep misses a binary plist. Tried on a fake JSON policy and a fake binary plist, and on this Mac, which has none.
  - **Docs:** the README's Setup gains the clone, the policy check, `mise trust` and a test approval. A new section, "Keeping another Mac current", covers a change, a Claude app update, a Stream Deck app update, taking it off and moving the clone. The update section says which Mac runs the routine. CLAUDE.md's Install says how the other Macs get a change.
  - **Still to come:** the first real `setup`, on the work Mac.

## Progress

- [x] Phase 0: kickoff (open questions answered), 2026-11-01
- [x] S0 sandbox · [x] S1 status · [x] S2 approvals · [x] S3 mod · [x] S4 mode, model, effort (mode through the app's tool; model and effort shown only, by the user's choice) · [x] S5 overview and jump · [x] S6 deck
- [x] Phase 1: spike results shown to the user, and their go, 2026-11-01
- [x] Phase 2: contract frozen, 2026-11-01
- [x] Track A: Claude Code plugin · [x] Track B: deck plugin · [x] Track C: tools, 2026-11-01
- [x] Protocol amendments and the reviewers' minors: three sets, rounds 2–4 committed, and Phase 4's quick hello (579f240)
- [x] Ladder steps 4–5, 2026-11-01 (what needs a person or the app's dialogs moves to Phase 4)
- [ ] Phase 4: on hardware with the user. Resumed 2026-11-03; "Next" in the Log's last entry says where it stands.
  - Pass: steps 1–4.
  - Steps 5 and 7, going by the log: the pick and the jumps took about 60 ms, and each mode change took about 30 ms. The user reported no problem with either.
  - Mode from Auto: refused by the classifier, so it needs a design choice.
  - Step 6: passed, 2026-11-03.
  - Step 8: passed by the log, 2026-11-03: the Session key opened T3, on screen 133 ms later.
  - Step 9: passed, 2026-11-03.
  - Done lag: fixed, 2026-11-03. Live, the registry goes idle 5–6 ms after a turn ends, and the deck shows done within a second.
  - Step 10: dropped.
  - Step 11: later.
- [ ] Phase 5: daily use. Started 2026-11-03 as an overnight run; the Log's last entry says where it stands.
  - Installed for the user's sessions, 2026-11-03: release f90bc6f in settings `env`.
  - Still to come: the user's morning checks, then a day of real use.
- [ ] Phase 6: hardening. Overnight 2026-11-03; the Log's last entries say where it stands.
  - Round 3 committed (cfe4554) and live: deck 0.3.1, plugin 0.2.1 released.
    - It covers stale instances, repeated hellos, status rules 3 and 6, registry failures and the quick hello's window.
    - It adds tests with 30 sessions, quieter info logs, and recheck checks for the summary loader and the engine's refusal wording.
  - The guide is `claude-code/README.md`.
  - Round 4 committed (86054e1) and live: deck 0.3.2; the plugin is unchanged, so 0.2.1 stays released.
  - The overnight scope is done. The user's checklist is in the Log's last entries; item 9 is answered, and deck 0.3.3 does it.
  - The Claude app's update to Claude Code 2.1.317 (2026-11-03) was found on 2026-11-04, and rechecked 35 ok on 2026-11-05 after the vendored reference was refreshed.
  - Still to come: a reboot (macOS 26's localhost delay), and a day of real use.
- [x] Phase 7: session keys and dials, 2026-11-04. The spec is `docs/claude-code/session-keys.md`.
  - Spikes T5 and T6: questions and plans can be answered from the deck.
  - Contract: PROTOCOL.md's amendment "2026-11-04, session keys", 26 fixtures.
  - Built and reviewed: deck 0.4.0 and the tools, with the main thread's checks passing.
  - Live with the user, 2026-11-04: a question, a plan and an approval answered on the dial, plus slots, seen, jumps and the long press. The user: "All worked".
  - Committed (00c7622) and released, 2026-11-04. Only `tests/fixtures.gen.ts` changed in the release copy, and `status` says installed and current.
  - The app's cards close when the dial answers, seen by the user. T5, T6 and T7 archived, 2026-11-05.
  - Left for Phase 8's smoke test: a swap between two slots, tried live.
- [ ] Phase 8: efficiency and update resilience. Started 2026-11-05; the spec is `docs/claude-code/hardening.md`, and the Log's last entries say where it stands.
  - The idle counters are built and live, and the baseline is measured (A1), 2026-11-06.
  - The questions round is answered. A fourth goal, deploying to the user's other Macs, is in.
  - **Committed, 2026-11-06:**
    - 64d2e71: the counters and the baseline;
    - b19a2c3: setup on other Macs;
    - d1121bc: recheck's gaps, its check of the vendored reference, and the refresh test;
    - 672c50e: the idle fixes, which meet the target;
    - 6282cef: mode changes removed. Deck 0.5.0 is live since 05:06:58Z. Plugin 0.3.0 is released; `status` says installed and current, and sessions load it when they next start.
    - 3b782b0: C1, the deck showing a newer Claude Code or an older plugin; C2, the smoke test and its log checker. Live since 05:33:55Z.
  - **The smoke test passed live,** 2026-11-06: 13 of 14 steps by the log, and the user saw the rest. The Approve and Deny keys weren't pressed.
  - **The user's work Mac,** 2026-11-06: the README's Setup now covers a managed Mac, and a new section covers keeping a second Mac current. GitHub has everything to 7a19008, pushed by the user.
  - **Still to come:** the reboot (C7), a day of use, the idle count after it, and the first real `setup`, on the work Mac.
