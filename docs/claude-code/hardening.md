# Efficiency and update resilience (Phase 8)

The spec for the Claude Code side's second hardening round. Written 2026-11-05 by the session that built Phase 7, as its handover. The plan, the Log and Progress stay in `docs/claude-code/plan.md`; this file is what the phase does and why.

## What the user asked

After Phase 7 went live, the user asked how a press flows from the deck into Claude Code and back. They were "mainly concerned about inefficiencies, potential failure points, and future proofing", since "Claude Code is an evolving harness and I want to ensure the current setup is as lean as possible and will not be brittle with an app/harness that is quickly changing". Then, on 2026-11-05: "plan for a hardening session where we will tackle the existing inefficiencies and make sure the plugin is well maintained and resilient for future updates."

So the goals, in order:
1. **Lean:** less work while nothing happens, and less code where code isn't earning its keep.
2. **Resilient:** an app or Claude Code update is caught the day it lands, and what it breaks degrades safely and visibly.
3. **Maintained:** the routine after an update is short, scripted where it can be, and checked.

Remove before you add, and measure before and after.

## Where it starts

As of 2026-11-05:
- **Deck 0.4.0** is live on the user's Stream Deck. **Plugin 0.2.1** is released to the user's sessions through `deck-install.mjs`.
- **Phase 7** (session keys and dials) is committed as `b8f4c1a`, and the user checked it live.
- **The 2.1.317 update** followed it:
  - the vendored mods API is now `claude-code/vendor/mods-api/`, rebuilt by `claude-code/vendor/refresh.mjs`;
  - `recheck.mjs` reads the version it expects from that file's first line;
  - `release` validates with the newest bundled Claude Code.
  If `git status` isn't clean when this phase starts, ask the user before anything else.
- **The baseline checks,** all passing:
  - the deck's typecheck, 495 tests, also with the clock two days ahead and a week back, its build and `streamdeck validate`;
  - the tools' 256 tests; the installer's 11;
  - the plugin's `tsc` against the 2.1.317 declarations, `plugin validate`, 159 of 159 in `plugin test`, and sync `--check`;
  - `recheck.mjs`: 35 ok, 0 warn, 0 fail.
- **The Claude app** bundles Claude Code 2.1.309 and 2.1.317, and new sessions run 2.1.317.

Line references below are as of `b8f4c1a`. Paths are under `claude-code/`.

## Rules for this phase

CLAUDE.md's rules hold. These matter most here:
- **The user's own sessions are read-only.** Live checks run in throwaway sessions the main thread starts from the `deck-sandbox` preset, and nothing else.
- **The deck is shared hardware** in daily use. Restarting the Claude deck plugin drops requests held on the deck back to the app's dialogs. Say so before a restart if the user's sessions might have one held.
- **Contract changes** go through the main thread: PROTOCOL.md amendments, with fixtures made by `make-fixtures.mjs`.
- **Every new rule** gets a test that fails without it, shown by a mutation.
- **Nothing fails closed.** Whatever breaks, the app's own dialogs keep working, and the deck answers only what a press chose. No hook ever gets `onFailure: "block"`.

## Questions for the user

Ask these in one round, after the baseline, each with a recommendation:
1. **Which deck features do you use?** Saved Prompt keys; the Mode key and Mode dial, especially changes out of Auto; the Sessions dial; the Session key.
   - A feature on a fragile surface that isn't used should go.
   - Mode changes need the PreToolUse hook and the way around the auto-mode classifier, the most brittle trick in the project (PROTOCOL.md, Mode checks and Mode changes from Auto).
   - Saved Prompts and mode changes are the only users of the command channel, the mod's long poll. Without both, the mod would only report events.
   - Recommendation: decide from a week of use, and remove what isn't used.
2. **The PermissionRequest hook's timeout:** keep 600 s, or lower it?
   - If the deck process hangs, rather than crashing, each permission request waits on the hook until the timeout. Desktop sessions show the app's dialog meanwhile.
   - The open question is whether any process that loads the plugin waits with no dialog of its own (C5).
   - Recommendation: keep 600 s, unless C5 finds such a process.
3. **Where should a newer Claude Code show?**
   - Recommendation: one log line per new version, and the session's version on its strip's Setup page, marked when it's newer than the checked one.
4. **The idle budget:** after the baseline, agree a target. For example: with sessions open and nothing happening, so many wakeups and spawns a minute.
5. **The brief "needs you":** for about 0.2 s after any hook answer, the deck shows needs-you until the registry leaves `waiting`. Recommendation: leave it, unless it bothers the user.

## A. Measure first

**A1. The idle baseline.** With the user's usual sessions open and nothing running, for 10 minutes, count:
- registry and records scans, stat calls, and folder walks;
- `lsappinfo` spawns;
- polls per session, and model emits;
- key and strip sends;
- the deck's CPU time.

The deck logs at debug (`log-level.txt`). A small read-only `tools/idle-report.mjs` that counts the deck log's lines by kind per minute would make the measurement repeatable after each change. Record the numbers in the plan's Log, and measure again at the end of each workstream.

## B. Idle work

Each of these is small alone. Fix what the baseline shows matters, and say what you leave.

**B1. Mod copies that aren't the session's current one poll once a second, for as long as they run.**
- The deck answers such a poll at once with nothing (`deck/src/model/sessions.ts:574-578`), and the mod polls again after its 1 s floor (`plugin/hooks/bridge.ts:555`).
- The usual source is the app's pre-warmed spare processes, which pass the desktop gate and talk as the session they'll become (PROTOCOL.md, Desktop sessions only).
- Find out first why the deck answers at once. PROTOCOL.md's Identity section and the `stray-instance` fixture say what a stray copy must still be able to do.
- Then prefer a deck-only fix, such as holding the poll for its whole wait, over a protocol change.

**B2. Every poll from a current mod emits a model change** (`sessions.ts:586`).
- Every emit runs every listener, and the views of all sessions are rebuilt (`sessions.ts:1299-1315`).
- `SessionsDials.refresh` rebuilds them again even with no Sessions dial on the deck (`deck/src/sessions/dials.ts:63-64`).
- Emit only on a change some view reads, and let listeners with nothing on the deck skip their work.

**B3. The burst after a turn.**
- For up to 60 s after a main-loop turn ends, while the registry still says `busy`, polls are answered at once: about one a second (`sessions.ts:220, 579-585, 763-764, 841-843`).
- That's deliberate. The engine holds `busy` while the mod has a request open (PROTOCOL.md, Commands), so a held poll would keep the session busy.
- Live, the registry goes idle 5-6 ms after a turn ends, so the burst should be one or two polls. Measure it; change it only if it's longer.

**B4. The two once-a-second file scans.**
- The registry: `deck/src/registry/watcher.ts:37-41`, one readdir and a stat per session file.
- The records: `deck/src/records/records.ts:333-344`, a stat per wanted host. Every second, each wanted host with no record file sets off a walk of every account and org folder (`records.ts:202-261`).
- **The fix:** watch the folders (`fs.watch`, which uses FSEvents on macOS), with a debounce and a slow safety scan. Back the walk off per missing host.
- **Keep:** the deck's done, needs-you and release rules ride on registry changes. Measure the time from a registry change to the key's paint before and after, and keep it under a second.
- **Watch for:** FSEvents coalescing, renames of atomically written files, and the folder appearing after the deck starts.

**B5. The "seen" check** starts two `lsappinfo` processes a second while wanted (`deck/src/model/front.ts:21, 27`).
- It is wanted while an unseen ended session is on screen, so while the user is in another app this can run for hours.
- **The fix:** back off after about 30 s, to 5 s and then 15 s, and reset on an attach, a detach or a press. Keep the gate (`sessions.ts:1246-1256`).

**B6. The 1 s tickers** for slot keys, slot dials and Others (`deck/src/slots/keys.ts:93`, `slots/dials.ts:278`, `slots/others.ts:85`) only send what changed, so after a minute a key changes once a minute. Leave them, unless the baseline says otherwise.

## C. Resilience

**C1. Catch drift the day it lands.**
- The mod's hello carries the session's Claude Code version (`cc`).
- The deck can bake in, at build time, the version on the first line of `vendor/mods-api/claude-code.d.ts`. It then flags any session that runs a newer one, as the user chose in question 3.
- This time the app's update went unnoticed from 2026-11-03 to 2026-11-04.
- Optionally, likewise flag sessions running an older plugin than the deck was built against: they haven't restarted since a release.

**C2. A live smoke test after each update:** `docs/claude-code/smoke-test.md`, ten minutes, with a throwaway session from the preset. Each step names the deck log line that proves it, as the Phase 7 live test did (plan.md's Log, "Phase 7 live").
- A question, a plan into Manual, and an approval, each on the dial. Proof: `ANSWER #n … from its session's dial`.
- An approval on the Approve key.
- A Saved Prompt.
- ~~A mode change to Accept edits and back up to Auto.~~ Gone with mode changes, Phase 8 (2026-11-06).
- A jump from a slot key and from Others. Proof: `Jump: opened … in N ms`.
- Seen, a long press, and a swap between two slots, which wasn't tried live in Phase 7.

A small read-only script that checks the log for those lines after the run would make it quicker. This test covers the engine behaviours that recheck can't check from files.

**C3. recheck's gaps.** Appendix A lists what the integration relies on and what checks it. For each "not checked" row, pick one:
- a string check in `recheck.mjs`, cheap and run after every update;
- a smoke-test step;
- an accepted risk, written down.

Candidates for recheck:
- ~~the full mode tool name, `mcp__ccd_session_mgmt__set_session_permission_mode`;~~ Gone with mode changes, Phase 8 (2026-11-06).
- the hook input's field names;
- the engine's rule that AskUserQuestion and ExitPlanMode take an answer only with `updatedInput`;
- `lsappinfo`'s output format and the app's bundle id;
- the registry's status values.

**C4. recheck checks the vendored reference too.** A new check runs `vendor/refresh.mjs --out <temp>` for the checked version, and compares the result with `vendor/mods-api/`. It warns when they differ, and fails when the binary's file table can't be read, which means Bun changed its format.

**C5. A hung deck and the hook timeouts.**
- Which processes send the PermissionRequest hook to the bridge: desktop sessions, terminal sessions, `claude -p` runs, a `claude` a session starts? The plugin loads in all of them, through settings `env`, and the mod's desktop gate doesn't stop a hook.
- For each kind, check what happens while the bridge accepts a connection and never answers. Use a stand-in on a spare port, as `spikes/cc-ask/` did, never the deck.
- Feed what you find into question 2.

**C6. The port and the token.**
- The hooks and the mod send the bearer token to whatever listens on 127.0.0.1:47600 (`plugin/hooks/hooks.json:8-12`, `plugin/hooks/bridge.ts:25`).
- On this single-user Mac that's an accepted risk. Write it down in PROTOCOL.md's Transport, unless the user wants more.

**C7. Still open from Phase 6:** a reboot, to see macOS 26's localhost delay against the deck's listen retry and the mod's backoff. The user reboots; read the deck log for the retries and the time to the first hello.

## D. Maintenance

**D1. One routine after an app update,** written down once in CLAUDE.md:
1. `vendor/refresh.mjs`;
2. the plugin's `tsc` against the new declarations;
3. `recheck.mjs`;
4. `plugin test` on the new binary;
5. the smoke test.

Script it only if a step gets forgotten.

**D2. `vendor/refresh.mjs` has no test.** C4 covers its output against the real binary; also add a unit test on a small synthetic file table. The test must catch:
- a wrong section offset;
- a missing entry, or two;
- a changed first line.

**D3. Prune,** per the user's answer to question 1. Take features out cleanly: actions, manifest entries, PROTOCOL.md (an amendment), fixtures, tests, the README, and `hooks.json` with a plugin release when a hook goes.

**D4. Size.**
- The deck's source is 9,373 lines, about 6,600 of them code:
  - `slots/` 2,378;
  - `model/` 1,907, of which `model/sessions.ts` alone is 1,429;
  - `bridge/` 1,307.
- The mod is 1,342 lines, about 890 of them code.
- `tools/lib` is 4,224 lines.

Split `model/sessions.ts` only if a change in this phase needs it. Don't refactor for its own sake.

## Order and checks

1. A1, the baseline. Then the questions round.
2. The deck-only idle fixes: B2, B4, B5, and B1 if it can stay deck-only. Measure again.
3. Contract changes, if any: B1 with the mod, or D3. Fixtures first, then both sides, then a plugin release.
4. Resilience: C1, C2, C3, C4 and C5, then C6 written down.
5. Maintenance: D1 and D2.
6. **Live:**
   - the smoke test, with a throwaway session;
   - the reboot (C7);
   - a day of use, with the deck log free of new errors and warns, and the idle numbers compared with the baseline.

**The checks for each milestone:**
- the deck's typecheck and tests, also with the clock shifted;
- its build and `streamdeck validate`;
- the tools' tests;
- the plugin's `tsc`, `plugin validate`, `plugin test` and sync `--check`;
- the installer's tests;
- `recheck.mjs`;
- a mutation for each new rule;
- the idle count, where the milestone touched idle work.

**Done when:**
- the idle numbers meet the target the user agreed;
- each item here is done, or deferred or dropped at the user's word;
- recheck is clean, and the smoke test passed live;
- everything is committed, the plugin is released, and the Log and Progress are current.

## Appendix A: what the integration relies on, and what checks it

| Dependency | Used by | Checked by |
|---|---|---|
| The session registry, `~/.claude/sessions/<pid>.json`: `hostSessionId`, `status` (idle, busy, waiting), `statusUpdatedAt`, `name`, `sessionId`, `cwd`, `startedAt` | discovery, status, the release rules (`deck/src/registry/registry.ts:58-67`) | recheck check 2, field types only. What the statuses mean is not checked |
| The app's records, `claude-code-sessions/<account>/<org>/<host>.json`: `title`, `isArchived`, `lastFocusedAt`, `lastActivityAt`, `cwd`, `model`, `effort`, `permissionMode`, `postTurnSummary`, `turnWrapUp` | titles, archived, seen, needs-you, records for slots whose session isn't running (`deck/src/records/records.ts`) | recheck check 3, plus the app loader's field list and `is_noteworthy` in app.asar. Not checked: the category and wrap-up rules (`records.ts:54-127`) |
| The jump, `claude://code/continue?session=<host>`, through `/usr/bin/open` | every jump (`deck/src/plugin.ts:70-78`) | recheck check 4, as strings in app.asar. Not checked: that it focuses the window and starts a stopped session |
| The `local_` host id pattern | the hooks' `X-Deck-Host`, and the mod's gate | recheck check 4, as a string |
| The app's mode tool, `mcp__ccd_session_mgmt__set_session_permission_mode`, with `session_id: "self"` | mode commands, and the mode hook's matcher | recheck check 4 finds `ccd_session_mgmt` and `set_session_permission_mode` apart. Not checked: the full name, `"self"`, the modes it takes. Gone with mode changes, Phase 8 (2026-11-06). |
| The engine's words for a refused `$.mcp.call` | the mode command's refused state | recheck check 6, a warn only. Gone with mode changes, Phase 8 (2026-11-06). |
| The mods API: the events, `$` calls and event fields the mod uses (`plugin/hooks/register.ts:27-51`) | the mod | the plugin's `tsc` against `vendor/mods-api/`; recheck check 5 runs `plugin validate` and `plugin test` on the newest binary, against fixtures and a fake `$`, not the live engine |
| The HTTP hooks: `type: http`, `$VAR` headers through `allowedEnvVars`, the timeout, and the PermissionRequest and PreToolUse bodies (`session_id`, `tool_name`, `tool_input`, `permission_mode`, `effort.level`) | approvals and the mode hook (`deck/src/protocol/wire.ts:148-174`) | `plugin validate` reads hooks.json. Not checked: the input fields, or the output shapes (`wire.ts:25-97`) |
| Engine rules found by reading the binary (2026-11-04):<br>- a hook and the app's dialog race;<br>- answering in the app leaves the hook's request open;<br>- a failed connection is no decision;<br>- Deny with `interrupt` stops the turn;<br>- AskUserQuestion and ExitPlanMode take an Allow only with `updatedInput`;<br>- a failing `updatedInput` becomes a deny;<br>- the hook's win cancels the app's card;<br>- `setMode` with destination `session` | approvals, and every dial answer | not checked by recheck; the Phase 7 live test checked them. C2 and C3 |
| A PreToolUse allow skips the auto-mode classifier for the mode tool, and a raise then brings a PermissionRequest | mode changes out of Auto | not checked; Phase 4's live test. Gone with mode changes, Phase 8 (2026-11-06). |
| Hooks are read only at session start; the engine re-runs the mod after the hooks worker is lost (`vendor/mods-api/reference.md`) | releases, and the mod's restarts | not checked |
| The desktop environment: `CLAUDE_CODE_ENTRYPOINT` (`claude-desktop`, `claude-desktop-3p`), `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_TAGS` (`plugin/hooks/desktop.ts:19-35`) | the mod's desktop gate | not checked |
| Settings `env` with `CLAUDE_CODE_PLUGIN_DIRS` and `DECK_TOKEN`, applied at session start, with the launch environment winning key by key | loading the plugin in the user's sessions | `deck-install.mjs status`, the values only |
| `/usr/bin/lsappinfo` (`front`, `info -only bundleid`), its output format, and the bundle id `com.anthropic.claudefordesktop` (`deck/src/model/front.ts:13, 42-50`) | seen | not checked |
| The Bun file table in the Claude Code binary (`__BUN,__bun`) | `vendor/refresh.mjs` | not checked (C4) |
| The Stream Deck SDK 3: `pressed` on rotate, `hold` on tap, `device.size.rows`, `setFeedbackLayout`, `onSystemDidWakeUp`; `@elgato/streamdeck` 3.0.4 | the actions | the deck's tests with a fake SDK; `streamdeck validate` sees only the layout the manifest names, and the slot strip tests check all six |

## Appendix B: continuous work while idle, as of `b8f4c1a`

**The deck, always:**
- the registry scan every 1 s, with a readdir and a stat per session file (`registry/watcher.ts:39`);
- the records scan every 1 s, with a stat per wanted host, plus a folder walk each second per wanted host with no record file (`records/records.ts:342, 202-261`);
- the bridge listening on 127.0.0.1:47600.

**The deck, while Session Slot or Other Sessions actions are on the deck:** three 1 s tickers. A key or strip is sent only when it changes, so with `since` under a minute that's once a second per key.

**The deck, while "seen" is wanted:** two `lsappinfo` spawns every 1 s, with a 5 s stuck timer per ask (`model/front.ts`).

**Per desktop session with a current mod:**
- One held long poll. The deck answers it after 20 s with nothing, and the mod polls again: about one request every 20 s, each emitting a model change (B2). A 60 s no-poll timer is armed between polls (`deck/src/bridge/commands.ts:176-181, 334-367`).
- In the mod, per poll: a 35 s stall timer and the 1 s floor. Events are sent only as engine events fire.

**Per held request:** one open connection, with no timer on the deck.

**Bursts:**
- about one poll a second after a turn ends, while the registry still says `busy` (B3);
- about one a second from each mod copy that isn't the current one, for as long as it runs (B1);
- with the bridge down, each session says hello every 30 s once its backoff is done;
- with the port taken, the deck retries listening every 30 s.

Source: a read-only map of the code made on 2026-11-05 for the user's question; its full report is in that session's transcript.
