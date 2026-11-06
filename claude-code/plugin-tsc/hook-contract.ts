// The PermissionRequest hook between the deck and the engine, held to the engine's own declarations: this tsconfig
// type-checks it with the mod, against the vendored mods API d.ts, so after an app update (refresh.mjs, then this
// type check) it fails here when the engine stops taking what the deck sends or giving what it reads. Nothing runs it.
// - The answers are the exact bodies the deck sends (claude-code/deck/src/protocol/wire.ts): Allow, Deny, the Answer
//   and the Approve plan, into each of its modes.
// - The input is the five fields the bridge reads from the hook's body (parseHook and parsePermission there), each as
//   a type the bridge can read it as.
// The tools' drift test holds these to wire.ts.

import type { ClassicHookEvent, ClassicHookInputs, PermissionRequestDecision } from 'claude-code'

/** A PermissionRequest hook's answer as the deck sends it: the engine's decision, in the classic hook's output. */
type Answer = { hookSpecificOutput: { hookEventName: Extract<ClassicHookEvent, 'PermissionRequest'>; decision: PermissionRequestDecision } }

export const allow: Answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

export const deny: Answer = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from the Stream Deck.', interrupt: true } },
}

/** The Answer, for an AskUserQuestion: its tool_input as it came, with `answers`. */
export const answer: Answer = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Blue', description: 'The sky' }], multiSelect: false }],
        answers: { 'Which colour?': 'Blue' },
      },
    },
  },
}

/** The Approve plan, for an ExitPlanMode: its tool_input unchanged, and a setMode for the session, in each mode the dial offers. */
const approvePlan = (mode: 'auto' | 'acceptEdits' | 'default'): Answer => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow', updatedInput: { plan: '# Plan', planFilePath: '/tmp/plan.md' }, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] },
  },
})
export const approvePlans: Answer[] = [approvePlan('auto'), approvePlan('acceptEdits'), approvePlan('default')]

/** What the bridge reads of the hook's body. */
export const reads = (input: ClassicHookInputs['PermissionRequest']) => ({
  sid: input.session_id satisfies string | undefined,
  tool: input.tool_name satisfies string,
  input: input.tool_input satisfies unknown,
  mode: input.permission_mode satisfies string | undefined,
  effort: input.effort?.level satisfies string | undefined,
})
