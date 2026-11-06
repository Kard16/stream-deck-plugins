# The smoke test after an update

A ten-minute live check of what the deck relies on in the engine and the app: the part `recheck.mjs` can't read from files. Run it after every Claude app or Claude Code update, once `recheck.mjs` passes. Each step names the deck log line that proves it, and `claude-code/tools/smoke-check.mjs` looks for all of them at the end. Written 2026-11-06 for Phase 8 (`docs/claude-code/hardening.md`, C2 and C3). Mode changes went in Phase 8, so no step uses them.

## Who does what

- **The main thread** starts one throwaway session, T, from the app's `deck-sandbox` preset, which runs in `claude-code/sandbox`. It sends T each step's prompt, reads the deck's log, and runs the checker.
  - It gives the user steps 1–14 as one checklist.
  - It sends each prompt once the log has the line that ends the step before, so the user never has to say next.
- **The user** presses the deck and watches the app. At the end they say what they saw where a step reads **you see it**: the log can't show those.
- **Only T** is approved, denied, answered or sent a prompt. The user's own sessions stay read-only: step 1 only opens one, and step 13 only moves one between slots.

## Before you start

1. **The deck logs at debug:** `claude-code/deck/com.karimdhanji.claude.sdPlugin/log-level.txt` says `debug`, since the EVENT, STATUS and SEEN lines are debug. If it doesn't, write it, then at the user's word restart only the Claude deck plugin (`streamdeck restart com.karimdhanji.claude`) while nothing is held. A restart drops held requests back to the app's dialogs.
2. **Nothing is held:** the Approve key shows no request. Approve, Deny and Others act across sessions, so the user presses them only when they show T.
3. **A Saved Prompt key** is on the deck with a harmless text, such as `Reply with the word ok.` The user sets it in the Stream Deck app.
4. **This session runs in Auto,** so its own calls don't wait on the deck, and it asks the user nothing with AskUserQuestion during the test: that question would be held on the deck too.
5. **Note the start** for `--since`: `date -u +%Y-%m-%dT%H:%M:%SZ`.
6. **Start T** from the `deck-sandbox` preset, titled "Deck smoke test", on Haiku at low effort, in Manual (`default`), with step 2's task as its brief. T loads the dev copy, `claude-code/plugin`.
   - Log: `Sessions: HELLO <T> inst "…" plugin "…" cc "…"`. `<T>` is T's `local_…` id, and the `cc` its Claude Code version (step 14).
   - T should be on no slot, as when every slot holds a session. If it took an empty one (`Slots: SLOT <slot> ← <T> (fill: …)`), open this session in the app and hold that key: this session takes the slot, and T is on none.

## The steps

`<slot>` is a slot id, such as `7649…:1:3`. A log line is shown from its scope on.

1. **A jump starts a stopped session.**
   - You: press a slot key that reads **Not running**. After the update's restart, the sessions you haven't opened since do. This opens one of yours, and does nothing else to it.
   - You see: the app comes to the front on that session, and its key lights up within seconds. **You see it.**
   - Log: `Keys: jump <host> via slot key <slot>: "<title>"`, `Jump: opened claude://code/continue?session=<host> in N ms`, then `Sessions: HELLO <host> inst …` from its new process.
   - **If no key reads Not running,** do this step last, with T. Open this session in the app, then, while none of your sessions is working, quit the Claude app (⌘Q) and open it again. It reopens on this session, so T's key should read Not running: press it. Then tell this session to go on.
2. **A jump from Others, with the app's dialog beside the held request.**
   - T's brief: `Task 1: run exactly this Bash command, with the description "Write smoke-1.txt": echo one > smoke-1.txt. Then reply with only the word done, or the word denied if it was denied.`
   - You: with this session on screen, click the desktop, so another app is in front. When Others shows T, press it.
   - You see: the Claude window comes to the front on T, with the app's own permission dialog up, and the Approve key shows the same request. **The dialog: you see it.**
   - Log: `Sessions: HELD #n tool "Bash" "echo one > smoke-1.txt" fp … from <T>`, then `Keys: jump <T> via the Others key: "Deck smoke test"`, `Jump: opened … in N ms`, and `Sessions: EVENT <T> attach`.
3. **A long press.**
   - You: with T on screen, hold a bottom-row slot key for half a second.
   - You see: the key shows OK, then T.
   - Log: `Slots: SLOT <slot> ← <T> (long press), in place of <host>`. The cleanup puts that `<host>` back.
4. **An approval on the dial.**
   - You: T's dial strip shows Allow and Deny. Turn to Allow, then press.
   - You see: the app's dialog closes by itself. **You see it.**
   - Log: `Sessions: ANSWER #n "Bash": allow, from its session's dial`.
5. **A question on the dial.**
   - The main thread sends: `Task 2: use the AskUserQuestion tool to ask the user one question. The question text is exactly "Red or blue?", with header "Color", single choice, and two options: "Red" and "Blue". Once it's answered, reply with only the answer, one word.`
   - You: turn T's dial to Blue, then press.
   - You see: the app's question card closes by itself, and T replies Blue. **The card: you see it.**
   - Log: `Sessions: ANSWER #n "AskUserQuestion": answered "{\"Red or blue?\":\"Blue\"}", from its session's dial`.
6. **A plan approved into Manual on the dial.**
   - The main thread sets T to Plan mode, a lower one, so no card asks, then sends: `Task 3: you're in Plan mode. Without reading any file, write this one-step plan and call ExitPlanMode with it: "1. Create smoke-3.txt in this folder containing the word: three." Once the plan is approved, carry it out with the Write tool, then reply with only the word done. If the plan is rejected, reply with only the word rejected.`
   - You: turn T's dial to **✓ Manual**, then press.
   - You see: the plan card closes by itself, and T asks to write smoke-3.txt. **You see it.**
   - Log: `Sessions: ANSWER #n "ExitPlanMode": plan approved into default, from its session's dial`.
7. **An approval on the Approve key.**
   - You: when the Approve key shows T and smoke-3.txt, press it.
   - Log: `Sessions: ANSWER #n "Write": allow, from a key press`.
8. **A Deny, whose interrupt stops the turn.**
   - The main thread sends: `Task 4: run exactly this Bash command: echo four > smoke-4.txt. Then run exactly this one: echo five > smoke-5.txt. Then reply with only the word done.`
   - You: when the Deny key shows T's `echo four`, press it. T's dial can deny instead: turn to Deny, then press.
   - You see: the app marks the turn interrupted, T says nothing more, and no second request comes. **You see it.**
   - Log: `Sessions: ANSWER #n "Bash": deny, from a key press`, then `Sessions: EVENT <T> turn.end`, with no other call between them. T's transcript also has `[Request interrupted by user for tool use]`.
9. **A request answered in the app, which the deck lets go.**
   - The main thread sends: `Task 5: run exactly this Bash command, with the description "Write smoke-6.txt": echo six > smoke-6.txt. Then reply with only the word done.`
   - You: on T in the app, answer the app's own dialog with its allow button. Leave the deck alone.
   - You see: the request leaves the Approve key and T's strip within a second.
   - Log: `Sessions: RELEASED #n "Bash": the session reported the call's end (rule 1, fp …)`. Rule 2 is right here too, since the dialog was answered.
10. **A jump from a slot key, bringing the window to the front.**
    - You: open this session in the app, click the desktop, then press T's slot key.
    - You see: the Claude window comes to the front, on T. **The window: you see it.**
    - Log: `Keys: jump <T> via slot key <slot>: "Deck smoke test"`, `Jump: opened … in N ms`, then `Sessions: EVENT <T> attach`.
11. **A Saved Prompt.** Step 10's press made T the target.
    - You: stay on T, and press the Saved Prompt key.
    - You see: the key shows sent, and T replies.
    - Log: `Keys: Saved Prompt cN: done`, after `Sessions: QUEUED cN prompt (N characters) for <T>`.
12. **Seen.** Step 11's reply ends a turn while T is on screen and Claude is in front.
    - You see: T's key goes dark within a second, rather than staying green.
    - Log: `Sessions: SEEN <T>: on screen with Claude in front`.
13. **A swap between two slots,** never tried live before.
    - You: open this session in the app. It must be on another slot key; if it isn't, open one of yours that is, preferably a running one, since opening a stopped session starts it. Hold T's key, and the two swap. Then press T's key in its new place, and hold the first key again: they swap back.
    - Log: `Slots: SLOT <slot> ← <host> (long press), from <slot>, which takes <T>`, then the same with the two the other way round.
14. **T's Claude Code version on its strip** (C1).
    - You: with nothing waiting on T, turn its dial to the third page, Setup.
    - You see: on its second line, the mode from step 6 and T's version, `Manual mode · 2.1.…`. When the version is newer than the one the repo was checked against, the first line of `claude-code/vendor/mods-api/claude-code.d.ts`, it ends in `↑` and the line is amber. **You see it.**
    - Log: the hello's `cc`, `Sessions: HELLO <T> inst "…" plugin "…" cc "2.1.…"`. smoke-check compares it with the vendored reference, so you know whether to expect the mark. A newer version also gets `Versions: Claude Code <version> in <host>: newer than …`, once a deck run, for the first session that has it.

## Watch

- **A wrong release:** a `Sessions: RELEASED #n … (rule 2)` while the app's dialog is still up.
  - Since Phase 8 the deck sees registry flips of 50 ms to 1 s, so a short `waiting → busy → waiting` could release a held approval.
  - Then the request leaves the deck, the session reads needs you with nothing held, and the app's dialog stays up.
  - smoke-check lists every rule 2 release, and flags one followed within 5 s by needs-you with nothing held.
- **Known, and kept by the user:** about 0.2 s of needs you after each answer, until the registry leaves `waiting`.

## Then

1. **The main thread runs the checker:**
   ```sh
   mise exec -- node claude-code/tools/smoke-check.mjs --since <start> --host <T>
   ```
   It prints each step's proof, or why it's missing, then the rule 2 releases and every warn and error line in the window. It exits 0 when every step's proof is there. For a step that's missing, do it again, then run the checker with the same `--since`.
2. **The user says** what they saw in the steps that read **you see it**: 1, 2, 4, 5, 6, 8, 10 and 14. The checker lists them under "ask the user".
3. **The main thread records** the checker's output and the user's answers in `docs/claude-code/plan.md`'s Log.
4. **At the user's word,** the main thread archives T. T's slot lets it go, then takes a running session that's on no slot, if there is one.
5. **The user puts back** the session that step 3 replaced: open it in the app, then hold that slot's key. Opening a stopped session starts it.

T's files stay in `claude-code/sandbox/`, which git ignores, and the next run writes over them.

## What it covers

The engine and app behaviour no file check can show (hardening.md's Appendix A):

| What the deck relies on | Steps |
|---|---|
| The jump, `claude://code/continue`, opens the session and brings the window to the front | 2, 10 |
| The jump starts a stopped session | 1 |
| The hook races the app's dialog, which works while the deck holds the request | 2, 9 |
| The hook's answer closes the app's dialog or card | 4, 5, 6 |
| AskUserQuestion and ExitPlanMode take an Allow only with `updatedInput`, and `setMode` with destination `session` | 5, 6 |
| Deny with `interrupt` stops the turn | 8 |
| Answering in the app leaves the hook's request open, and a release rule ends it | 9 |
| `$.prompt.submit` takes a Saved Prompt | 11 |
| The mod's attach, and lsappinfo's answer: the session on screen, with Claude in front | 12 |
| The session on screen in the app, for a long press and a swap | 3, 13 |
| The mod's hello carries the session's Claude Code version | 14 |
