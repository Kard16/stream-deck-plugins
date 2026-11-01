#!/bin/bash
# deck-spike S4: a classic PreToolUse hook (matcher Read) that answers "ask"
# for a Read of the marker file .deck-mode-request, so the mod's own
# $.tool.call raises a PermissionRequest that the bridge can answer with
# updatedPermissions setMode. Prints nothing for every other Read.
input=$(cat)
case $input in
  *'.deck-mode-request"'*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Stream Deck: change mode"}}'
    ;;
esac
exit 0
