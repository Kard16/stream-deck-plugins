#!/bin/bash
# deck-spike: logs one classic hook event to the spike bridge.
#   hook.sh <Event>   (hook input JSON on stdin)
# Adds event, t_ms, ppid and env to the input object and POSTs it to
# $DECK_SPIKE_URL/hook/<Event> (default http://127.0.0.1:47600). hooks.json
# runs it with "async": true. Prints nothing and always exits 0: no
# `set -e`, curl capped at 2 s, every failure ignored.
# Bash 3.2 (macOS /bin/bash). DECK_SPIKE_TOKEN_FILE overrides the token path,
# for tests.

exec >/dev/null 2>&1

event=${1:-unknown}
url=${DECK_SPIKE_URL:-http://127.0.0.1:47600}

t_ms=$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000')
case $t_ms in '' | *[!0-9]*) t_ms="$(date +%s)000" ;; esac

# The token sits at spikes/cc-bridge/run/token, found from this script's
# physical folder, so a link to the plugin (claude-code/sandbox-plugin) works.
self=${BASH_SOURCE[0]}
case $self in */*) dir=${self%/*} ;; *) dir=. ;; esac
dir=$(cd -P -- "$dir" && pwd -P)
token_file=${DECK_SPIKE_TOKEN_FILE:-$dir/../../cc-bridge/run/token}
token=
if [ -r "$token_file" ]; then
  IFS= read -r token <"$token_file" || true
fi

# REPLY <- $1 as a JSON string.
jstr() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  REPLY="\"$s\""
}

# REPLY <- "NAME": value of the variable NAME, or null when it is unset.
jenv() {
  local name=$1
  if [ -n "${!name+x}" ]; then jstr "${!name}"; else REPLY=null; fi
  REPLY="\"$name\":$REPLY"
}

envs=
for name in CLAUDE_CODE_SESSION_ID CLAUDE_CODE_HOST_SESSION_ID CLAUDE_CODE_ENTRYPOINT \
  CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT CLAUDE_PLUGIN_DATA; do
  jenv "$name"
  envs="$envs$REPLY,"
done
if [ -n "${DECK_TOKEN:-}" ]; then present=true; else present=false; fi
envs="$envs\"DECK_TOKEN_present\":$present"

jstr "$event"
fields="\"event\":$REPLY,\"t_ms\":$t_ms,\"ppid\":$PPID,\"env\":{$envs}"

# Our fields go first in the input object; on a clash the input's own wins.
input=$(cat)
trimmed=${input#"${input%%[![:space:]]*}"}
case $trimmed in
  '{'*)
    inner=${trimmed#\{}
    rest=${inner#"${inner%%[![:space:]]*}"}
    case $rest in
      '}'*) body="{$fields}" ;;
      *) body="{$fields,$inner" ;;
    esac
    ;;
  '') body="{$fields}" ;;
  *)
    jstr "$input"
    body="{$fields,\"stdin\":$REPLY}"
    ;;
esac

# The token goes to curl as a header file from a process substitution, so it
# is never in any process's arguments.
if [ -n "$token" ]; then
  printf '%s' "$body" | curl -s -m 2 --connect-timeout 1 -o /dev/null \
    -H 'Content-Type: application/json' \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") \
    --data-binary @- "$url/hook/$event"
else
  printf '%s' "$body" | curl -s -m 2 --connect-timeout 1 -o /dev/null \
    -H 'Content-Type: application/json' \
    --data-binary @- "$url/hook/$event"
fi

exit 0
