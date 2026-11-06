# Session keys and dials (Phase 7)

**Status:** designed 2026-11-04, from the user's feedback after a day of use. Spikes T5 and T6 and a read of the engine settled the risks, and PROTOCOL.md's amendment "2026-11-04, session keys" holds the contract. Progress and results go in `docs/claude-code/plan.md` (Phase 7 and the Log); this file is the spec.

## What the user asked

After a session with the plugin, the user asked for (2026-11-04):
- **A key for each session,** to see at a glance which sessions are working, waiting or done, how full their context is, and anything else useful, and to switch to one that needs them.
- **The 4 bottom keys are sessions,** and the dial under each key belongs to that session. Its strip shows what didn't fit on the key, and the dial answers the session's questions.

Their answers to the clarifying round, the same day:
1. **Slots:** keys fill, then stay put. A long press puts the session that's on screen in the app on that key, even when another session is there.
2. **What a dial answers:** questions, plans and approvals. Turn to pick, press or tap the strip to send.
3. **With nothing to answer,** turning the dial pages through details, and a press or tap jumps to the session.
4. **More than 4 sessions:** an Others key for the top row counts the sessions off the keys that need you, and a press jumps to the one that has waited longest.

Defaults they saw and didn't change: "done" stays lit until the user has seen the session; the existing actions stay available for the top row and other pages.

## What T5, T6 and the engine check found (2026-11-04)

Spike `spikes/cc-ask/`: a stand-in for `/v1/permission` on 127.0.0.1:47610 and a copy of the plugin whose PermissionRequest hook points at it. The throwaway sessions **Deck test T5** (`local_bd3145de-…`) and **T6** (`local_08819a8d-…`) ran from the `deck-sandbox` preset on Haiku at low effort. The log is in `spikes/results/<stamp>-ask/requests.jsonl`.

**The engine** (2.1.309, read by an agent: notes in that session's scratchpad, `engine-ask/notes.txt`):
- For a tool that needs the person (AskUserQuestion, ExitPlanMode), it ignores a hook's plain Allow, takes an Allow that carries `updatedInput`, and always takes a Deny. The hook races the app's request as for any tool.
- When the hook wins, the engine sends the app `control_cancel_request`, and the app removes its card and its notification. A half-typed answer there is lost.
- An `updatedInput` that fails the tool's schema becomes a deny, so the deck echoes `tool_input` as it came.
- `answers` keys are each question's exact text. A multi-select answer joins the labels with `", "`, writing a label that holds `", "` or `"` as a JSON string. A question left out reads as unanswered.

- **A hook answers AskUserQuestion.** The answer is Allow with `updatedInput`, which is the request's own `tool_input` plus `answers`, a map from each question's text to the chosen option's label:
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":[…as asked…],"answers":{"Which colour should the test use?":"Blue"}}}}}`
  - Claude got `Your questions have been answered: "Which colour should the test use?"="Blue". You can now continue with these answers in mind.` and replied "Blue". The registry went idle.
  - **Two questions, one of them multi-select,** worked the same way: `"Apple, Plum"` for the multi-select (the labels joined with `", "`) and `"Large"` for the other.
  - **The request carries the whole form** in `tool_input.questions` (`question`, `header`, `options[{label, description}]`, `multiSelect`), and no `permission_suggestions`.
- **A plain Allow doesn't approve a plan.** T5's stayed `waiting` in Plan mode on the app's own card, and the app won't stop a turn that waits on the user. T5 still shows that card.
- **Allow with `updatedInput` does** (T6):
  - With `updatedPermissions: [{type: "setMode", mode: "acceptEdits", destination: "session"}]`, T6 left Plan mode into Accept edits and read "User has approved exiting plan mode".
  - With `mode: "auto"`, into Auto.
  - With no `setMode`, it went back to the mode it had before Plan mode.
- **A Deny without `interrupt`, with feedback,** kept T6 planning. It wrote a plan file and asked again with the feedback's change.
- **ExitPlanMode's `tool_input`** is `{}` when Claude wrote no plan file, and `{plan, planFilePath}` when it did. There are no `permission_suggestions` either way.
- **Seen live, 2026-11-05:** the app's question and plan cards close by themselves when the dial answers first. The engine cancels the app's request, and the registry leaves `waiting` (T7; the user watched).

## The layout

| Where | Action | What it does |
|---|---|---|
| Bottom row, keys 5–8 | **Session Slot** | One session per key: its state, title, context and what it's doing. Press to jump to it; hold to put the session on screen in the app on this key. |
| Dials 1–4 | **Session Slot** (the same action, on a dial) | The session on the key above. The strip shows its details, or the question, plan or approval it's waiting on. Turn to page or pick, press or tap to jump or send. |
| Top row | **Others**, plus any of the existing keys (Approve, Deny, Saved Prompt, Mode Key, Session) | Others counts the sessions off the slot keys that need you. |

The existing actions (Sessions dial, Mode dial, Approve, Deny, Saved Prompt, Mode Key, Session) stay, unchanged except where noted.

## Slots

**A slot** is a Session Slot key's place: device, row and column. A Session Slot dial joins the slot of the key above it, the bottom row's key in its column (`row = rows − 1` from the device's size; row 1 on a Stream Deck +). A dial with no key above still has that slot, and a slot key on the top row has no dial. In a multi-action a slot key has no place, so it does nothing (`SupportedInMultiActions: false`).

- **One session per slot,** shared by the key and the dial. A session is on at most one slot.
- **Saved** in `com.karimdhanji.claude.sdPlugin/run/slots.json` (git ignores `run/`), written whole to a temp file and renamed, on every change: `{"v": 1, "slots": {"<device>:<row>:<col>": {"host": "local_…"}}}`. A file that can't be read means empty slots and one warn line.
- **A slot that's showing** has its key or its dial appearing (`willAppear`, until `willDisappear`). Only a showing slot fills, but every slot keeps its session while hidden, on another page for instance.

**Fill:** a showing slot with no session takes a running session (in the registry, with a host) that's on no slot. A session that needs you comes first, the one waiting longest; otherwise the newest by the registry's `startedAt`. Empty slots fill bottom row first, left to right.

**Stay put:** a slot keeps its session until one of these:
- the app's record for it says `isArchived: true`;
- no record file exists for it any more, and the registry doesn't list it;
- a long press puts another session on that slot.

A session whose process isn't running (not in the registry, but not archived) stays on its key, dimmed as "not running". A press opens it in the app, which starts it again. After a Claude app restart, the keys keep their sessions this way.

**Long press on a slot key** (held 500 ms; the key-up after it does nothing): the slot takes **the session on screen in the app**, the one with the latest of its last `attach` (when the deck got it) and its record's `lastFocusedAt`. If that session is on another slot, the two slots swap. The key shows OK, or an alert when no session is known to be on screen.

**A press, or a jump from the dial,** opens the session in the app (`claude://code/continue?session=<local_…>`, as today) and makes it **the target**, as a pick on the Sessions dial does. Saved Prompt and Mode keys then act on it.

## What each session shows

The deck's session view gains these, for every session (registry, records and the bridge, as today):
- **`need`**: what it waits on: `approval` (a held `tool` request), `question` (a held AskUserQuestion), `plan` (a held ExitPlanMode), `input` (the registry's `waiting` with nothing held, or the app's needs-input sign), or none.
- **`since`**: when the current status began: the registry's `statusUpdatedAt`, the held request's arrival, or the turn's end, whichever the status came from. Keys and strips show it as `30s`, `4m`, `2h`, `3d`.
- **`seen`**, for a session whose last turn ended (done, failed, interrupted): whether the user has looked at it since. A turn's end is seen once, after it:
  - the session came on screen (an `attach`, or a later `lastFocusedAt`); or
  - the session was on screen (its last `attach` is later than its last `detach`) **and Claude was the app in front.** The deck asks `lsappinfo` (`/usr/bin/lsappinfo front`, then `info -only bundleid <asn>`, `com.anthropic.claudefordesktop`), which needs no permission and takes under a millisecond. It asks every second for the first 30 s, every 5 s to 2 minutes, every 15 s to 10 minutes, and once a minute after that. It starts over on an attach, a detach, a press or a wake (Phase 8, the user's choice, 2026-11-06). And it asks only while some ended session that isn't seen is on screen and a Session Slot or Others key is on the deck; or
  - Only the desktop app's `attach` and `detach` count (`surface` `desktop`). The mods API sends them per client, so a phone's would otherwise hide a session the desktop still shows.
  - the user pressed its slot key or jumped from its dial.
  - When the deck has seen no turn end for a session (after a deck restart), an idle session counts as not seen when its record's `lastActivityAt` is later than its `lastFocusedAt`.
- **`running`**: in the registry. Slotted sessions that aren't running come from their record alone (title, model, effort, mode, summary).
- **Context:** `percent`, `tokens` and `window` from the latest `measure`; **cost** in USD from the same.
- **Last summary:** what the app's per-turn summary or wrap-up says the turn did (`postTurnSummary.status_detail`, read the way status rule 6 reads the summary, else `turnWrapUp.description`), and **what the app says it needs** (`needs_action`, or `turnWrapUp.needsUser` as a string).
- **Project:** the last segment of `cwd`.

## The key face

144-unit SVG, as the other keys draw. The mockup the user saw on 2026-11-04 has the look: the key's colour says the state, and the title is in the middle.

| State | Colour | Top line | Bottom line |
|---|---|---|---|
| Question, plan, approval, needs input | amber, with a light outline | `Question`, `Plan`, `Approve?`, `Needs you`, and `since` | the tool (approval), and context % with its bar |
| Working | blue | `Working`, `since` | the current tool, context % and bar |
| Done, not seen | green | `Done`, `since` | context % and bar |
| Failed, not seen | red | `Failed`, `since` | the same |
| Interrupted, not seen | dark red | `Stopped`, `since` | the same |
| Done, failed or interrupted, seen; idle | dark (`#1F2430`) | `Done`, `Idle` … , `since` | the same, dimmed |
| Not running | darker, dim text | `Not running` | — |
| Empty slot | darker | `No session` | `Hold to add the one on screen` |

The title takes up to two lines, cut with `…`. Only the states that need you are amber, so a glance at the row finds them.

## The strip

Each dial's 200×100 segment shows its slot's session. It uses text and bar layouts, as today (proven on this Mac), switched with `setFeedbackLayout`. Text items can have a `background`, so choices draw as chips. Run `streamdeck validate` after every layout change.

**Pages, when the session needs nothing.** Turning moves one page, wrapping. A press or tap jumps to the session. Long touch goes back to the first page. The page dots show which page is on.
1. **Now:** the title; what it's doing (`Bash: npm test`) or how its last turn ended (`Done 3m ago`); the last summary, or what the app says it needs, on up to two lines.
2. **Context:** `Context 62%` with its bar; `620k of 1M tokens`; `Cost $1.24`.
3. **Setup:** model and effort; mode; project.

**An answer screen, when the session waits on you.** The strip shows the session's oldest held request. When that changes (answered, released, or a newer one now first), the screen starts over with what's next, or goes back to the pages.
- **Approval:** `Allow Bash?`, the summary (command or file), and two chips, Allow and Deny. Nothing is picked until the dial turns. A turn picks one, and further turns switch between them, stopping at either end, so a tick past Deny stays on Deny. A press or tap sends the pick: Allow or Deny, the same bodies as the keys. A press with nothing picked jumps to the session. Long touch clears the pick.
- **Question:** the header, `1 of 2` when there are several questions, the question on up to two lines, then the option under the cursor with its description, and `2/3`.
  - Turning moves the cursor through the options, then **Other…**, which a press turns into a jump (typing goes in the app).
  - **Single-select:** a press picks the option and moves to the next question.
  - **Multi-select:** a press ticks or unticks the option, and the list ends with **Next** (or **Send** on the last question), which needs at least one tick.
  - After the last question, the deck sends the answers. A press before any turn jumps to the session. Long touch goes back a question, or clears the picks on the first.
  - A question the dial can't answer (no options, a form that doesn't parse, or one the token scrub changed; PROTOCOL.md, Held requests, lists them) shows `Answer in app`, and a press jumps.
- **Plan:** `Plan ready`, the plan's first line, and its choices as chips, which stop at either end like the approval's. See "Plans".
- **The 1 s rule** applies to the dial as to the keys: a press sends only once the request has been on that strip for 1 s, from its first paint there. Earlier, it alerts and sends nothing.
- **The pick rule:** a press sends only the chip, or the question and place on its list, that the strip has painted, once it has shown for 300 ms. A tick just before a push alerts instead of sending a choice nobody saw. (The deck's review, 2026-11-04.)
- **Answered elsewhere:** a request answered first in the app, or by Approve or Deny, makes the press alert and send nothing. For 1 s the strip's pages alert too, rather than jump. Once the strip shows the session's next request, a press acts on that one (`dial-next`).

## Others

A key for the top row, about the running sessions on no slot.
- It shows how many of them need you, and the title and `since` of the one that has waited longest. Below that, in small type, how many are done and not seen. With none needing you, it's dim and says how many other sessions are running.
- A press jumps to the one that has waited longest, and makes it the target. With none needing you, it alerts.

## Plans

The strip shows `Plan ready`, then the plan's first heading or line when `tool_input` has a `plan`. The choices, in this order:
1. **Approve · Auto**
2. **Approve · Accept edits**
3. **Approve · Manual**
4. **Reject**

Each Approve sends Approve plan with its mode (PROTOCOL.md): the request's `tool_input` unchanged, and a `setMode` for the session. Reject sends the keys' Deny, which stops the turn, so the user says in the app what to change. A dial can't type feedback, and a "keep planning" with none would only re-plan blind.

As for an approval, nothing is picked until the dial turns, and a press with nothing picked jumps to the session, where the whole plan is.

## Protocol changes

PROTOCOL.md's amendment "2026-11-04, session keys", with `make-fixtures.mjs`, both written by the main thread. In short:
- **Kind `ask` becomes answerable from a Session Slot dial.** The Approve and Deny keys keep "Answer in app" and jump.
- **Two new answer bodies:**
  - **Answer,** for an AskUserQuestion: Allow with `updatedInput`, the request's `tool_input` unchanged plus `answers`.
  - **Approve plan,** for an ExitPlanMode: Allow with the request's `tool_input` unchanged, and `updatedPermissions` with one `setMode` for the session.
  - A dial rejects a plan with the existing Deny.
- **The bridge keeps an `ask` request's `tool_input`** (up to 64 KiB of JSON; a bigger one stays display-only), so the dial can show the form and echo it back.
- **The dial answers its own session's oldest held request,** of any kind. The keys still answer the oldest across all sessions. The first answer wins, and the others alert.
- **Fixture `press` lines** gain the dial: `{"dial": {"session": "<host>", "picks": {"<question>": ["<label>", …]}}}`, `{"dial": {"session": "<host>", "decision": "allow" | "deny"}}` and `{"dial": {"session": "<host>", "plan": "auto" | "acceptEdits" | "default" | "reject"}}`. The deck runner gives the session a slot, then turns and presses its dial.
- **New fixtures (26 in all):** `answer-question`, `answer-questions` (a multi-select picked out of option order, whose labels hold `", "` and a double quote), `dial-gone`, `dial-next`, `dial-approve`, `plan-approve` and `plan-reject`.
- **Before the build:** the deck fails 7 of 308 tests and the tools 2 of 158, all of them the new fixtures or the fixture count. The plugin passes 158 of 158 with the new copy of the fixtures.
- **After the reviews,** the main thread added `dial-next` and widened `answer-questions`, since each side's runner passed cases the other would fail. It also wrote down the display-only forms, the token scrub, the pick rule and the desktop-only `attach`. The plugin passes 159 of 159 with all 26.

The plugin needs no change: the hook is configuration, and the mod already sends `attach`, `detach`, `measure` and the tool events. Its copy of the fixtures is regenerated (`sync-fixtures.mjs`), and its tests must still pass.

## Build and checks

A workflow, as in earlier rounds, each agent in its own folder:
1. **Deck core** (`claude-code/deck/`): the bridge's answers and kept `tool_input`; the session view's new fields and `seen`, including the `lsappinfo` check; records for slotted sessions that aren't running; slots, with fill, stay put, long press, swap and the saved file. Unit tests for each, and the new fixtures.
2. **Deck surfaces** (`claude-code/deck/`, after 1): the Session Slot action on keys and dials, Others, the key art, the strip layouts and their screens, the manifest, icons, and `claude-code/README.md`. Unit tests for the painters and every gesture.
3. **Tools** (`claude-code/tools/`, beside 1): the fake deck and the fixture player follow the amendment.
4. An adversarial reviewer per track re-runs its checks against PROTOCOL.md, this file and CLAUDE.md, then a fixer for blockers and majors.

**Checks:** the deck's typecheck, tests (also with the clock two days ahead and a week back), build and `streamdeck validate`; the tools' tests; the plugin's `tsc`, validate, tests and sync `--check`; mutations that each break one new rule.

**Live, with the user:** restart only the Claude deck plugin; the user places Session Slot on the 4 bottom keys and the 4 dials and Others on a top key; a throwaway session from the preset asks a question, a plan and an approval, and the user answers each on a dial; then long press, swap, Others and seen, on their own sessions.
