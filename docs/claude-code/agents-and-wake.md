# Approvals, agents and wake (Phase 9)

The spec for the Claude Code side's third revision, written 2026-11-07 from the user's feedback after a day on their work Mac. The plan, the Log and Progress stay in `docs/claude-code/plan.md`; this file is what the phase does and why. The contract is PROTOCOL.md's amendment "2026-11-07, Phase 9".

## What the user asked

After a day of testing on the work Mac, the user wrote (2026-11-07):
- "For questions, I don't actually use my Stream Deck to answer, but instead I press the button to make it the active session/window and interact there."
- "Similarly, I always stay on Auto mode and never change the mode."
- "I do use the Stream Deck to Approve gates that need explicit approval. That and switching between sessions are what I use the buttons for and my only real 'inputs'."
- "I found connection to be inconsistent after display/machine sleep/wake cycles." The Stream Deck is plugged into a Dell U2725QE monitor's USB hub, and one Thunderbolt cable goes from the monitor to whichever MacBook Pro they're using: the personal one, or the work one with MDM and Tailscale. "Disconnecting and reconnecting Thunderbolt would resolve." Both laptops are always on power, and the user would prevent sleep if that helps.
- "The Stream deck is best for displaying useful information. Let's see if we can display content better for sessions that might have multiple threads/workflows or ultracode sessions. Being able to quickly see status from the Deck will be nice."

**Their answers, the same day:**
1. **When the deck dropped:** the keys stayed lit but stale, and pressing a session key didn't switch the Claude app's window. Re-plugging Thunderbolt was the only thing tried.
2. **Remove:** answering questions and plans on the dial, the Sessions dial and the Session key.
3. **Keep Saved Prompts:** "I think there might be some good use cases for it, let's try and keep but I'm willing to scrap if it is a lot to maintain."
4. **Multi-agent sessions:** keep the key blue while background work runs, show a workflow's progress on the key, and add an Agents page to the strip.
5. **Cabling:** one Thunderbolt cable, moved between the laptops. So the monitor's KVM never has two hosts to choose from.
6. **The key's bottom line:** option A. A workflow reads as text, like `review 5/9`, and the thin bar keeps meaning context %.
7. **The top word** while only background work runs: **Background**.
8. **No tag** saying which Mac drives the deck.

## What the investigation found (2026-11-07)

Six read-only investigators: the code's sleep/wake paths, this Mac's logs, the mods API, the app's own files, web research on the hardware, and a removal map. Their reports are in this session's scratchpad (`inv/*.md`). What the design rests on:

**Sleep and wake, on this (personal) Mac, 2026-11-03 to 11-07:**
- **The Stream Deck app turns the deck off at every display sleep or lock, and back on about 5 s after the wake** (`Session -> suspend`, then `ADDED … reason to report now: expired` and `Device connected`). It did that 25 times out of 25. This Mac went into real system sleep only once in five days.
- **`onSystemDidWakeUp` fires on display wake and unlock,** 5–18 s before the device is back. The plugin gets no willAppear or willDisappear when the device leaves or returns.
- **The plugin has no device handling.** It has no `onDeviceDidConnect` or `onDeviceDidDisconnect`, no repaint when the device returns, and it keeps working while the deck is away. During the 28 h the deck was on the work Mac, this Mac's plugin sent 1,139 images and ran 2,886 `lsappinfo` checks.
- **The plugin's own paths recovered every time:** polls were unbroken across all 38 wakes, and there was no warn or error line in ten log files. macOS's localhost delay never showed after a wake.
- **The work Mac's logs aren't reachable from here.** That Mac is where the drops happened.

**What that means for the drop.** Keys stay lit with their last images when the deck has power but no host talking to it, and a press then reaches no Claude app. Jumps don't use the bridge, so a broken bridge can't explain dead presses. With one cable, the cause is below the plugin:
- the work Mac not bringing the Thunderbolt-tunnelled USB link back after a real system sleep (MDM may enforce sleep; this Mac never slept);
- the U2725QE's firmware failing to re-enumerate its hub (Dell lists a lid-closed wake issue, and firmware M2T102 claims fixes);
- or the Stream Deck app not re-acquiring the deck after its own suspend.
A Thunderbolt re-plug resets all three. Phase 9 makes the deck log the evidence, recover cleanly when the device returns, and stop working while it's away. It gives the user a read-only `doctor.mjs` to run before re-plugging, and the settings to try.

**Multi-agent sessions:**
- **The registry stays `busy` after the main loop's turn ends while in-process agents or a workflow run.** So a slot key already reads Working, not Done, through status rule 3. It just doesn't say what's running. (Seen live in this session at 19:16–19:24Z: the main turn ended and the registry said `busy` until the workflow finished.)
- **The mod already sees every loop.** It sends subagents' `tool.start`, `tool.end`, `turn.start` and `turn.end`, tagged with `agent`, and the deck drops all of them except `tool.end`, which release rule 1 uses. In this session's workflow that was 813 subagent events against 46 from the main loop, about 95% of them dropped.
- **The mods API gives** `agent.spawn` (each agent's kind, workflow run id and index, description), turn start and end per `agentId` (a hook that heard a start always hears the end), and the Workflow tool's result (`runId`, `taskId`, `workflowName`). It gives no event for a workflow's phase, its `log()` lines, how many agents it will start, or its end.
- **Release rule 1 matches only the fingerprint,** so one agent's finished call can release another agent's held identical request. The hook's input carries `agent_id` for a subagent's request (`claude-code.d.ts:865`), and the bridge doesn't read it.
- **The burst after a turn** (Phase 8's B3) answers about 60 polls in the minute after every main turn that leaves background work running. The registry stays `busy` either way, so those polls buy nothing.

**Removals** (the removal map): question and plan answering is the most fragile part of the deck, since it relies on the engine taking an Allow with `updatedInput`. Taking it out goes back to Phase 4's "Answer in app". The Saved Prompt command channel is the biggest single feature: about 1,050 deck lines, 190 mod lines and 1,600 test lines, plus 3 polls a minute per idle session.

## A. Inputs: approvals and jumps, plus Saved Prompts

**A1. The dial stops answering questions and plans.**
- A held `ask` request is display-only everywhere, as it was before Phase 7.
  - The Approve and Deny keys read "Answer in app", and a press jumps (unchanged).
  - A Session Slot dial shows "Answer in app" with `Question` or `Plan` and the request's summary, and a press or tap jumps to the session.
- **What goes:** the question and plan screens and their layouts (`slot-question.json`, `slot-plan.json`), `protocol/ask.ts`, the Answer and Approve plan bodies, the bridge's kept `tool_input` (the 64 KiB rule), and the token scrub's tracking of changes inside `tool_input`. The scrub itself stays.
- **What stays:** the slot key's `Question` and `Plan` words, release rules 1–5, and the approval chips with their 1 s and 300 ms rules.

**A2. The Session key and the Sessions dial go:** their actions, manifest entries, icons, `layouts/sessions.json` and `src/sessions/`.
- Constants the slots import from there (`COALESCE_MS`, `DialSurface`, `CONTEXT_HIGH`, `STRIP_COLORS`) move first.
- **The target stays, for Saved Prompts:** the session last jumped to from a Session Slot or Other Sessions, or, until one is, the session on screen in the app.
- A Session key or Sessions dial already placed on either Mac's deck shows as a missing action. The README says to remove it.

**A3. Saved Prompts and the command channel stay,** at the user's word. They're the biggest thing left to remove if the user changes their mind; the removal map has the route, including a temporary `/v1/next` stub so older mods keep their events flowing.

## B. Agents and workflows

**B1. The mod keeps a picture of the session's other loops** ("threads"), from hooks it observes and never changes:
- **`agent.spawn`** (new; returns `next(e)` and reads its result, with a pass-through `.catch`): the agent's id from the result, and its kind:
  - `workflow` when `workflow` is there, with its `runId`;
  - `teammate` when `isTeammate`;
  - `fork` when `fork`;
  - `background` when `background`;
  - otherwise `subagent`.
  It also keeps the description (else `subagentType`, cut to 60 characters).
- **`turn.start` and `turn.complete` with `agentId`** (already hooked): which loops are in a turn now. A `turn.complete` with reason `error` or `refusal` counts as failed. A loop the mod saw no spawn for is kind `other`.
- **`tool.call` in a loop other than the main one** (already hooked): that loop's latest tool and summary in its current turn, `Grep: TODO|FIXME`, cut to 60 characters, is what it's doing; empty before its first call in the turn. The summary stands alone when it would read the same without the call's arguments: an MCP tool's, or one with no summary rule, which is the tool's name (`TodoWrite`, not `TodoWrite: TodoWrite`; after the review).
- **The main loop's Workflow call** (already hooked): from its result, the run's `runId` and its name (`workflowName`; else the `name` input; else `workflow`). An agent whose `runId` no Workflow result named starts a run named `workflow`.

**The `threads` event** (PROTOCOL.md, Events) is a snapshot:
- `running`: how many loops other than the main one are in a turn.
- `agents`: up to 8 of those loops, the most recently started first, each with `kind`, `desc` and `doing`, and `run` for a workflow's.
- `runs`: up to 3 workflow runs, those with a loop in a turn first, then the most recent. Each has `run`, `name`, `started`, `finished`, `failed` and `open`: agents started, ended, ended failing, and in a turn now.

**When the mod sends it:**
- When the snapshot changes, at most once a second. The first change after a quiet second goes at once; changes later in that second go as one event when the second is up.
- Before a main-loop `turn.end` or `failed`, the mod sends any snapshot it's holding back, so the deck knows at the turn's end whether work goes on.
- A mod that reloads starts with an empty picture.
- **After each hello the deck answers,** the snapshot goes again, still at most once a second, unless the picture has been empty since the mod loaded: the deck may have restarted and lost it, and an agent busy on one long call changes nothing for minutes (after the build).
- **Until its first hello is answered, and from a failed request until the next answered hello,** the mod queues no snapshot: the one after the hello stands for them. In a process the bridge never talks from, nothing is made, sent or timed.

**And what it stops sending:** `tool.start`, `turn.start` and `turn.end` from other loops, which every deck since 0.1.0 drops. Their `tool.end` (release rule 1) and `failed` stay.

**B2. The deck:**
- **It keeps each session's latest `threads`,** from its current instance only, and forgets it at a new instance and at the session's end.
- **New status `background`,** inside rule 3 of PROTOCOL.md's status list ("`background` or `working`"; rule 6 is cited by number elsewhere, so the rules keep their numbers): the main loop isn't in a turn, a turn never seen included, and the latest `threads` has `running` above 0.
  - It comes after `approval` and `needs-you` from a held request or the registry's `waiting`, and before `failed`, `interrupted`, the record's needs-you, `done` and `idle`.
  - It holds whatever else the registry says: the registry stays `busy` while agents run.
- **`since` for background** is the later of the main loop's last turn end and the moment `running` last went above 0.
- **After background work,** Done, Failed and Stopped are timed from the later of the main loop's last turn end and the moment `running` came back to 0, and only a look after that counts as `seen`. So a workflow that ends ten minutes after the turn reads Done 0s, green and unseen, not Done 10m and already seen by a look while it ran. The app's own needs-you still times from the turn's end (after the review).
- **The key face** (option A):
  - **Background** is blue, with the top word `Background`.
  - **The bottom line's left text,** for Working and Background:
    - the most recent run with a loop in a turn, as `<name> <finished>/<started>`;
    - else `<n> agents` (`1 agent`) while `running` is above 0;
    - else, while Working, the main loop's current tool, as now.
  - The right-hand context % and the thin context bar don't change.
- **The strip's Now page** says the same: `Background: review 5/9`, `Background: 3 agents`, `Working: review 5/9` or `Working: npm test` (the current tool's summary, as before).
- **A new Agents page** comes after Now while `running` is above 0:
  - **The first line, in the accent colour:** the run as `<name> · <finished>/<started> done`, or `<name> · <finished>/<started>, <n> failed` when some failed, the counts kept whole and the name cut; or `<n> agents running` (`1 agent running`). The line holds about 22 characters.
  - **Then two running agents a page,** as `● <desc>: <doing>`. A missing description shows the kind, and a missing doing shows nothing after the description.
  - Up to 3 Agents pages, and the last one's last line says `+<n> more` when more are running than fit.
  - The page dots count every page. They're drawn smaller as pages grow, so the last never gets cut: 12 px up to four pages, 10 px for five, 8 px for six, in an item 10 px wider than 0.5.0's, which the title gives up (after the review; not yet seen on the device).
  - When the Agents pages go while one is showing, the strip goes to Now.
- **The poll burst** (PROTOCOL.md, Commands):
  - At the main loop's turn end, the at-once answer and its 60 s window apply only while `running` is 0.
  - A `threads` with `running` above 0 closes the window.
  - When `running` drops to 0 while the main loop isn't in a turn, the deck answers the open poll at once and opens the window for 60 s, so the registry can go idle.
- **Release rule 1 matches the loop:**
  - The bridge keeps a PermissionRequest's `agent_id` when it's a non-empty string.
  - A `tool.end` releases the session's oldest held request with the same `fp` and the same `agent`. A request with no `agent_id` (the main loop) matches only a `tool.end` with no `agent`.
- **Others** doesn't change.

**B3. Checked live, with the smoke test** (step list below). These are behaviours read from the declarations that no fixture can prove:
- `agent.spawn` fires for workflow agents with `workflow.runId`, and their description is the script's label or empty.
- Workflow agents' turns reach the mod.
- A workflow agent's PermissionRequest carries `agent_id`, equal to its `tool.call`'s `agentId`.
- The registry stays `busy` while only background agents run. smoke-check reads it from the deck's debug Registry lines when given the throwaway session's pid (`--pid`).

## C. Wake, and the deck coming and going

**C1. Device presence.**
- The deck handles `onDeviceDidConnect` and `onDeviceDidDisconnect`, and reads each device's `isConnected` at startup.
- Info lines: `Device "<name>" (<id>) connected` and `… disconnected`, and `known at start: …` with each device the SDK lists.
- The SDK starts every device as not connected until the app's connect. A press, a dial push or a touch from a device the deck has as away is a connect it missed: a warn line, then the connect, since the app sends a press only from a device that's there.
- **An action appearing is no connect** (decided after the review, 2026-11-07). The review's deck fixer counted it as one, in case the app's connect was missed at a start. But the app sends `willAppear` at a plugin start for a device that's asleep or on the other Mac too: on 11-05 the Stream Deck app had the deck suspended from 21:52 to 08:10, and the deck plugin's slot dials still appeared and filled at its restarts at 22:00, 23:06 and 23:33 (StreamDeck.log, and the deck's log). Counted, every start while the deck is away would paint into the void and log a missed connect that never happened, misleading `doctor.mjs`. Elgato's SDK itself marks a device connected only on the app's connect.
- **A slot key's or a slot dial's jump goes only to the session it showed:** the key's image at its key-down, the strip at the dial's push-down or at a tap. A slot that took another session since alerts, even when the full repaint that a press from an away device brings already shows the new one (after the review).

**C2. A full repaint when a device connects:**
- Forget every key painter's and strip painter's last send for that device's actions.
- Re-send each slot dial's layout.
- Then paint everything at once.
- The same runs 10 s and 20 s after each wake while a device is connected, in case the app restored the device without telling the plugin (it sends no willAppear then).
- Its line: `Repaint: every key and strip (<why>)`, where why is `device connected` or `10 s after the wake`.

**C3. While no device is connected,** the deck sends no images or strip updates. The front-app check (`lsappinfo`) and the label ticker don't run. The model keeps updating, so the repaint on connect is current.

**C4. Waking:**
- The wake line says whether the Mac slept or only the display slept, from the gap between the wall clock and the monotonic clock: `woke up: rescanning; slept 41 min` or `woke up: rescanning; no system sleep`. A gap under 2 s, or under 100 ppm of the time awake since the last look, is clock drift.
- When a device then connects within 60 s, its line adds `, <s> s after the wake`.

**C5. The bridge listens again** if its server closes or errors after listening, on the existing retry schedule: a warn or error line, then `listening again after the server <closed|errored>: <reason>`. Nothing has shown this failure, but nothing would notice it today. The first listen's line stays `listening on <host>:<port>`, which `deck-install.mjs setup` waits for. Requests held meanwhile stay on Approve, Deny and their slot dials, which still answer them through the old server's connections; the keys read Offline only with nothing held (after the review).

**C6. `claude-code/tools/doctor.mjs`,** read-only, for when the deck misbehaves. Run it before re-plugging anything: on the work Mac by the user, or on this Mac with the user's OK, since it reads beyond the logs CLAUDE.md lists. It prints, for the last `--hours` (default 12):
1. **Whether macOS sees a Stream Deck on USB now:** `ioreg -p IOUSB -l -w0`, Elgato's vendor id 4057 (0x0fd9), with its product name.
2. **Whether the Stream Deck app is running,** and its log's device, suspend and resume lines.
3. **The Claude deck plugin's** `Device`, `woke up` and `Bridge` lines.
4. **macOS's sleep and wake history** from `pmset -g log`: Sleep, Wake and DarkWake lines only.
5. **A verdict:**
   - macOS doesn't see the deck: the USB link or the hub. Try the monitor's input or power, then re-plug.
   - macOS sees it, the app doesn't: quit and reopen the Stream Deck app.
   - Both see it: the deck should be live. If it isn't, send the output.
It writes nothing. Unit tests feed it saved outputs.

**C7. The README** gains "When the deck stops responding":
- **What to try first, in order:** look whether the keys are dark or stale; run `doctor.mjs`; quit and reopen the Stream Deck app; re-plug.
- **The settings worth trying on the work Mac:**
  - System Settings, Battery, Options, "Prevent automatic sleeping on power adapter when the display is off", if MDM allows it;
  - the monitor's firmware M2T102 or later (OSD, Others, Display Info), updated through Dell Display and Peripheral Manager;
  - the lid open (Dell's lid-closed wake issue).

## Protocol changes

PROTOCOL.md's amendment "2026-11-07, Phase 9", written by the main thread with `make-fixtures.mjs`. In short:
- **Kind `ask` is display-only again.** The Answer and Approve plan bodies go, leaving three answers. The 64 KiB `tool_input` rule goes.
- **The bridge reads `agent_id`,** and release rule 1 matches it.
- **New event `threads`.** Other loops' `tool.start`, `turn.start` and `turn.end` are no longer sent.
- **New status `background`** (inside rule 3).
- **The poll burst** waits for `running` to reach 0.
- **The target** no longer comes from the Sessions dial.
- **Fixtures, 21:**
  - `answer-question`, `answer-questions`, `plan-approve` and `plan-reject` go;
  - `dial-gone` moves onto a Bash request;
  - `needs-you` gains the dial's jump;
  - new: `threads` and `release-by-agent`.
  - A dial `press` line with only `session` is a press with nothing picked.
  - New `expect` key: `threads`.
- **`v` stays 1:**
  - an older deck ignores `threads`, as it ignores any unknown event, and never used the loop events the mod stops sending;
  - an older mod sends them, and the newer deck ignores them;
  - an older mod sends no `threads`, so its session never reads `background` and shows Working through rule 3, as today.

## Build and checks

Versions: **deck 0.6.0, plugin 0.4.0.**

**Order.** The deck changes run one after another, since each agent's typecheck and tests cover the whole deck package. The plugin and the tools run beside them.
1. **Deck A,** the removals, then **Deck B,** agents and workflows, then **Deck C,** devices and wake.
2. **Plugin B1** beside them, in `claude-code/plugin/` and its tests.
3. **Tools** beside them:
   - the fake deck and the fixture player follow the amendment;
   - `doctor.mjs` and its tests;
   - `smoke-check.mjs` follows the new smoke-test steps.
4. **An adversarial reviewer per track,** then a fixer for blockers and majors.

**Checks:**
- the deck's typecheck and tests, also with the clock two days ahead and a week back, its build, and `streamdeck validate`;
- the tools' tests;
- the installer's tests;
- the plugin's `tsc`, `plugin validate`, `plugin test` and sync `--check`;
- `recheck.mjs`;
- a mutation for each new rule;
- the deck log's event counts in a multi-agent session, before and after.

**The smoke test** (`docs/claude-code/smoke-test.md`):
- Steps 5 and 6 change: a question reads Answer in app and a press jumps; the plan step goes.
- **New steps:**
  - the throwaway session runs a small workflow of three agents and a background subagent: the key reads Background with the run's label, and the Agents page lists them. In Manual, its own Workflow call asks first, and the user allows it on the dial;
  - in Manual mode, a workflow agent's Bash asks for permission, and the dial allows it (`agent_id` held);
  - the deck leaves and comes back (the user moves the cable away and back, or the display sleeps): `Device … disconnected`, then `connected`, then a full repaint.

**Done when:**
- each item here is done, or deferred or dropped at the user's word;
- the checks pass, and the smoke test passes live;
- the deck log shows the drops and returns on the work Mac after a day there;
- everything is committed, the plugin is released, the user has pushed, and the work Mac has run `setup`.
