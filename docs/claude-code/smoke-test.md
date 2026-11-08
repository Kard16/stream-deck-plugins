# The smoke test after an update

A fifteen-minute live check of what the deck relies on in the engine and the app: the part `recheck.mjs` can't read from files. Run it after every Claude app or Claude Code update, once `recheck.mjs` passes. Each step names the deck log line that proves it, and `claude-code/tools/smoke-check.mjs` looks for all of them at the end. Written 2026-11-06 for Phase 8 (`docs/claude-code/hardening.md`, C2 and C3), and revised 2026-11-07 for Phase 9 (`docs/claude-code/agents-and-wake.md`, B3 and C): the dial no longer answers questions or plans, and new steps cover agents, workflows and the deck leaving. Mode changes went in Phase 8, so no step uses them. Revised again 2026-11-08, after Phase 9's first live run: the user's go-ahead in T after step 4, step 13 before step 12, and Grep-only agents in step 14.

## Who does what

- **The main thread** starts one throwaway session, T, from the app's `deck-sandbox` preset, which runs in `claude-code/sandbox`. It sends T each step's prompt, reads the deck's log, and runs the checker.
  - It gives the user steps 1–16 as one checklist.
  - It sends each prompt once the log has the line that ends the step before, so the user never has to say next.
  - Step 13 has no log line of its own, so the user does it before step 12, whose swap back is the cue for task 6.
- **The user** presses the deck and watches the app. At the end they say what they saw where a step reads **you see it**: the log can't show those.
  - **The go-ahead, after step 4.** T's tasks after the first come from this session, and in the 2026-11-08 run T refused three of them until the user said so in T: one after the Deny, since a peer's word doesn't overrule the user's denial, and both workflows, since the Workflow tool runs only when the user asks in their own words. So once step 4's turn has ended, the user types this in T's composer: `This is my Stream Deck test. Carry on with each task the other Claude session sends, also after I deny one, and run the background agent and the two workflows, smoke and writer, that tasks 6 and 7 ask for.` The main thread sends task 2 once T has replied to it. The line is untried: if T still refuses a task, the user says so in T, and the main thread sends it again.
- **Only T** is approved, denied, answered or sent a prompt. The user's own sessions stay read-only: step 1 only opens one, and step 12 only moves one between slots.

## Before you start

1. **The deck logs at debug:** `claude-code/deck/com.karimdhanji.claude.sdPlugin/log-level.txt` says `debug`, since the EVENT, STATUS, SEEN and per-event THREADS lines, and the Registry's changes, are debug. If it doesn't, write it, then at the user's word restart only the Claude deck plugin (`streamdeck restart com.karimdhanji.claude`) while nothing is held. A restart drops held requests back to the app's dialogs.
2. **Nothing is held:** the Approve key shows no request. Approve, Deny and Others act across sessions, so the user presses them only when they show T.
3. **A Saved Prompt key** is on the deck with a harmless text, such as `Reply with the word ok.` The user sets it in the Stream Deck app.
4. **This session runs in Auto,** so its own calls don't wait on the deck, and it asks the user nothing with AskUserQuestion during the test: that question would be held on the deck too.
5. **Note the start** for `--since`: `date -u +%Y-%m-%dT%H:%M:%SZ`.
6. **Start T** from the `deck-sandbox` preset, titled "Deck smoke test", on Haiku at low effort, in Manual (`default`), with step 2's task as its brief. T loads the dev copy, `claude-code/plugin`.
   - Log: `Sessions: HELLO <T> inst "…" plugin "…" cc "…"`. `<T>` is T's `local_…` id, and the `cc` its Claude Code version (step 13).
   - **Note T's pid** for the checker's `--pid` (step 14): the registry file that lists T, `grep -l '"hostSessionId":"<T>"' ~/.claude/sessions/*.json`, is `<pid>.json`. Never the `.key` files beside them.
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
   - Then, you: once T has replied done, type the go-ahead in T's composer ([Who does what](#who-does-what)). The main thread sends task 2 once T has answered it.
5. **A question reads Answer in app, and a press jumps.** The deck never answers a question or a plan: the user answers in the app.
   - The main thread sends: `Task 2: use the AskUserQuestion tool to ask the user one question. The question text is exactly "Red or blue?", with header "Color", single choice, and two options: "Red" and "Blue". Once it's answered, reply with only the answer, one word.`
   - You: T's dial strip and the Approve key read **Answer in app**, with the question. With another session on screen, press T's dial without turning it: the app comes to the front on T. Answer Blue in the app's card. Leave the deck alone after that.
   - You see: the strip and the Approve key read Answer in app, the press brings T to the front, and once you answer, the request leaves the deck and T replies Blue. **The strip, the key and the window: you see them.**
   - Log: `Sessions: HELD #n ask "AskUserQuestion" "Red or blue?" fp … from <T>`, then `Dials: jump <T> via slot dial <slot> (press): "Deck smoke test"`, then `Sessions: RELEASED #n "AskUserQuestion": the session reported the call's end (rule 1, fp …)`, and no `ANSWER #n`. Rule 2 or 3 is right here too.
6. **An approval on the Approve key.**
   - The main thread sends: `Task 3: use the Write tool to create smoke-3.txt in this folder, containing the word: three. Then reply with only the word done.`
   - You: when the Approve key shows T and smoke-3.txt, press it.
   - Log: `Sessions: ANSWER #n "Write": allow, from a key press`.
7. **A Deny, whose interrupt stops the turn.**
   - The main thread sends: `Task 4: run exactly this Bash command: echo four > smoke-4.txt. Then run exactly this one: echo five > smoke-5.txt. Then reply with only the word done.`
   - You: when the Deny key shows T's `echo four`, press it. T's dial can deny instead: turn to Deny, then press.
   - You see: the app marks the turn interrupted, T says nothing more, and no second request comes. **You see it.**
   - Log: `Sessions: ANSWER #n "Bash": deny, from a key press`, then `Sessions: EVENT <T> turn.end`, with no other call between them. T's transcript also has `[Request interrupted by user for tool use]`.
8. **A request answered in the app, which the deck lets go.**
   - The main thread sends: `Task 5: run exactly this Bash command, with the description "Write smoke-6.txt": echo six > smoke-6.txt. Then reply with only the word done.`
   - You: on T in the app, answer the app's own dialog with its allow button. Leave the deck alone.
   - You see: the request leaves the Approve key and T's strip within a second.
   - Log: `Sessions: RELEASED #n "Bash": the session reported the call's end (rule 1, fp …)`. Rule 2 is right here too, since the dialog was answered.
9. **A jump from a slot key, bringing the window to the front.**
   - You: open this session in the app, click the desktop, then press T's slot key.
   - You see: the Claude window comes to the front, on T. **The window: you see it.**
   - Log: `Keys: jump <T> via slot key <slot>: "Deck smoke test"`, `Jump: opened … in N ms`, then `Sessions: EVENT <T> attach`.
10. **A Saved Prompt.** Step 9's press made T the target.
    - You: stay on T, and press the Saved Prompt key.
    - You see: the key shows sent, and T replies.
    - Log: `Keys: Saved Prompt cN: done`, after `Sessions: QUEUED cN prompt (N characters) for <T>`.
11. **Seen.** Step 10's reply ends a turn while T is on screen and Claude is in front.
    - You see: T's key goes dark within a second, rather than staying green.
    - Log: `Sessions: SEEN <T>: on screen with Claude in front`.
12. **A swap between two slots.** Do step 13 first: it has no log line, and this step's swap back is the main thread's cue for task 6.
    - You: open this session in the app. It must be on another slot key; if it isn't, open one of yours that is, preferably a running one, since opening a stopped session starts it. Hold T's key, and the two swap. Then press T's key in its new place, and hold the first key again: they swap back.
    - Log: `Slots: SLOT <slot> ← <host> (long press), from <slot>, which takes <T>`, then the same with the two the other way round.
13. **T's Claude Code version on its strip** (C1).
    - You: with nothing waiting on T, turn its dial to the third page, Setup.
    - You see: on its second line, T's mode, Manual since it started, and its version, `Manual mode · 2.1.…`. When the version is newer than the one the repo was checked against, the first line of `claude-code/vendor/mods-api/claude-code.d.ts`, it ends in `↑` and the line is amber. **You see it.**
    - Log: the hello's `cc`, `Sessions: HELLO <T> inst "…" plugin "…" cc "2.1.…"`. smoke-check compares it with the vendored reference, so you know whether to expect the mark. A newer version also gets `Versions: Claude Code <version> in <host>: newer than …`, once a deck run, for the first session that has it.
14. **Background work: a workflow of three agents, and a background subagent** (B1, B2).
    - The main thread sends: `Task 6: do two things, then end your turn without waiting for either. First, use the Agent tool with run_in_background true and the description "count files" to count the files in this folder with the Glob tool. Second, call the Workflow tool with exactly this script: export const meta = { name: 'smoke', description: 'Three searchers', phases: [{ title: 'Search' }] }; const task = 'Use the Grep tool, and no other tool, ten times in this folder, one at a time, for each of the words one, two, three, four, five, six, seven, eight, nine and ten, then reply with how many lines matched in all.'; await parallel([() => agent(task, { label: 'one' }), () => agent(task, { label: 'two' }), () => agent(task, { label: 'three' })]) Then reply with only the word started.`
    - **T's Workflow call asks first:** in Manual, Claude Code 2.1.317 asks before a Workflow call that brings its own script, with no settings rule to look up for it. The agents then only read, so nothing else waits on the deck. In the 2026-11-08 run, on Haiku, they ran Bash loops instead of Grep, and two asked; hence "and no other tool". If one asks anyway, its request comes with the agent's id: allow it on T's dial, as in step 15.
    - You: when T's dial strip reads **Allow Workflow?**, as the Approve key does, and the app's dialog asks you to review the workflow (the engine's words: "Review dynamic workflow before running"), turn T's dial to Allow, then press. Then watch T's key and strip while the agents work, and turn T's dial to the page after Now, Agents.
    - You see: once T says started, its key turns blue and reads **Background**, with `smoke 0/3` on its bottom line counting up to `smoke 2/3`. When the last of the three ends, the run's label goes: the key reads `1 agent` while the background subagent still runs, if it does, and Done once nothing runs. The Agents page leads with `smoke · 0/3 done` and lists the running agents, two a page, and goes when the last ends. **You see it.**
    - Log: `Sessions: HELD #n tool "Workflow" "Workflow" fp … from <T>` and `Sessions: ANSWER #n "Workflow": allow, from its session's dial`. `Sessions: THREADS <T>: <n> in a turn` when they start, with the run's label in brackets if the workflow's agents are first, then `Sessions: STATUS <T> working → background` as T's turn ends, the debug `Sessions: THREADS <T>: running <n>, runs smoke <finished>/<started>` as they go, up to `running 0, runs smoke 3/3`, and `Sessions: THREADS <T>: none in a turn` when the last ends. The background subagent can end while the Workflow call waits on you: then a `THREADS <T>: none in a turn` comes before the workflow's own `in a turn`, and the checker takes the workflow's.
    - The checker reads B3 from the run's counts: `smoke 0/3` and up means `agent.spawn` came with the run's id, and `3/3` once none is in a turn means each agent's turn end reached the mod. With `--pid`, it also reads the debug `Registry: a session changed: <pid> …` lines: T's pid reads `busy` from the background to the last turn end, never `→ idle`, and `→ waiting` only while the deck holds one of T's requests, such as an agent's Bash.
15. **A workflow agent's Bash, allowed on the dial** (B2, release rule 1 by the loop). T is in Manual, so its Workflow call asks first, as in step 14, and then the agent's Bash asks.
    - The main thread sends: `Task 7: call the Workflow tool with exactly this script: export const meta = { name: 'writer', description: 'One writer', phases: [{ title: 'Write' }] }; await agent('Run exactly this Bash command, with the description "Write smoke-7.txt": echo seven > smoke-7.txt. Then reply with only the word done.', { label: 'writer' }) Then reply with only the word started.`
    - You: T's dial strip reads **Allow Workflow?** first: turn to Allow, then press. When it then shows the agent's `echo seven`, turn to Allow, then press.
    - You see: the strip shows the Workflow request before the agent's `echo seven`, the app's dialog for the agent's Bash closes by itself, and the workflow ends. **You see it.**
    - Log: `Sessions: HELD #n tool "Workflow" "Workflow" fp … from <T>` and its `ANSWER #n "Workflow": allow, from its session's dial`, then `Sessions: HELD #m tool "Bash" "echo seven > smoke-7.txt" fp <fp> from <T> agent "<agent>"`, then `Sessions: ANSWER #m "Bash": allow, from its session's dial`, then the debug `Sessions: EVENT <T> tool.end "Bash" fp <fp> agent "<agent>"`, with the same fp and agent: the request's `agent_id` is the agent's own `agentId` (B3), the id release rule 1 matches.
16. **The deck leaves and comes back** (C1–C4). Do this last: it takes the deck from every session for a moment.
    - You: unplug the Thunderbolt cable from this Mac, wait ten seconds, and plug it back. Or lock the screen (⌃⌘Q), which sleeps the display and has the Stream Deck app turn the deck off, wait half a minute, and unlock.
    - You see: the keys go dark, then come back showing the sessions as they are now, not the images from before. **You see it.**
    - Log: `Devices: Device "<name>" (<id>) disconnected`, then `Devices: Device "<name>" (<id>) connected`, with `, N s after the wake` after a lock, then `Devices: Repaint: every key and strip (device connected)`, or `(N s after the wake)`. After a lock, `Claude: woke up: rescanning; no system sleep` comes between them, or `slept …` if the Mac slept too. If the deck missed the app's connect, a warn comes just before its `connected`: `Devices: Device "<name>" (<id>): a press came from it, though the deck had it as not connected; taking it as connected`. The checker notes it, and fails no step on it.

## Watch

- **A wrong release:** a `Sessions: RELEASED #n … (rule 2)` while the app's dialog is still up.
  - Since Phase 8 the deck sees registry flips of 50 ms to 1 s, so a short `waiting → busy → waiting` could release a held approval.
  - Then the request leaves the deck, the session reads needs you with nothing held, and the app's dialog stays up.
  - smoke-check lists every rule 2 release, and flags one followed within 5 s by needs-you with nothing held.
- **Wakes:** each `Claude: woke up: rescanning; …` line, and whether the Mac slept or only the display. smoke-check lists them.
- **The bridge listening again:** a `Bridge: listening again after the server closed: …` or `errored: …` line. Nothing has shown that failure, so one is worth a look. smoke-check lists them.
- **A device taken as connected:** a `Devices: Device "<name>" (<id>): a press came from it, though the deck had it as not connected; taking it as connected` warn. The deck missed that device's connect from the Stream Deck app. smoke-check lists them, and says so in step 16's detail when the deck's return was one.
- **Known, and kept by the user:** about 0.2 s of needs you after each answer, until the registry leaves `waiting`.

## Then

1. **The main thread runs the checker:**
   ```sh
   mise exec -- node claude-code/tools/smoke-check.mjs --since <start> --host <T> --pid <pid>
   ```
   `<pid>` is the one noted when T started. It prints each step's proof, or why it's missing, then the rule 2 releases, each wake and what slept, each time the bridge listened again, each device taken as connected, and every warn and error line in the window. It exits 0 when every step's proof is there. For a step that's missing, do it again, then run the checker with the same `--since`. Without `--pid`, step 14 says the registry wasn't checked.
2. **The user says** what they saw in the steps that read **you see it**: 1, 2, 4, 5, 7, 9, 13, 14, 15 and 16. The checker lists them under "ask the user".
3. **The main thread records** the checker's output and the user's answers in `docs/claude-code/plan.md`'s Log.
4. **At the user's word,** the main thread archives T. T's slot lets it go, then takes a running session that's on no slot, if there is one.
5. **The user puts back** the session that step 3 replaced: open it in the app, then hold that slot's key. Opening a stopped session starts it.

T's files stay in `claude-code/sandbox/`, which git ignores, and the next run writes over them.

## What it covers

The engine and app behaviour no file check can show (hardening.md's Appendix A):

| What the deck relies on | Steps |
|---|---|
| The jump, `claude://code/continue`, opens the session and brings the window to the front | 2, 5, 9 |
| The jump starts a stopped session | 1 |
| The hook races the app's dialog, which works while the deck holds the request | 2, 8 |
| The hook's answer closes the app's dialog | 4, 15 |
| A question held on the deck leaves it once answered in the app: its tool's end or the registry lets it go | 5 |
| Deny with `interrupt` stops the turn | 7 |
| Answering in the app leaves the hook's request open, and a release rule ends it | 5, 8 |
| `$.prompt.submit` takes a Saved Prompt | 10 |
| The mod's attach, and lsappinfo's answer: the session on screen, with Claude in front | 11 |
| The session on screen in the app, for a long press and a swap | 3, 12 |
| The mod's hello carries the session's Claude Code version | 13 |
| `agent.spawn` fires for workflow agents with their run, and their turns reach the mod: the run's counts, and the key's label while they work (B3) | 14 |
| The registry stays busy while only background agents run (B3): with the checker's `--pid` | 14 |
| A workflow agent's PermissionRequest carries `agent_id`, its `tool.call`'s `agentId`: the agent's call ends under the id its request had (B3) | 15 |
| The Stream Deck app tells the plugin when the device leaves and comes back, and the wake tells a display's sleep from the Mac's | 16 |
