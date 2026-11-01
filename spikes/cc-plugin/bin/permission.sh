#!/bin/bash
# deck-spike: the command-hook variant of the PermissionRequest hook.
# POSTs the hook input (stdin) to $DECK_SPIKE_URL/permission-cmd (default
# http://127.0.0.1:47600), which may hold it for up to the bridge's cap.
# Prints the bridge's answer only when it is a JSON object with content,
# else nothing, and always exits 0: a bridge that is down, slow or answers
# {} leaves the decision to the app.
# If Claude Code cancels the hook (TERM, INT or HUP), curl is killed at once,
# so the bridge sees the held request close. A SIGKILL can't be trapped:
# curl then lingers until the bridge answers or its own 600 s cap.
# Bash 3.2 (macOS /bin/bash). DECK_SPIKE_TOKEN_FILE overrides the token path,
# for tests.

exec 2>/dev/null

url=${DECK_SPIKE_URL:-http://127.0.0.1:47600}

self=${BASH_SOURCE[0]}
case $self in */*) dir=${self%/*} ;; *) dir=. ;; esac
dir=$(cd -P -- "$dir" 2>/dev/null && pwd -P)
token_file=${DECK_SPIKE_TOKEN_FILE:-$dir/../../cc-bridge/run/token}
token=
if [ -r "$token_file" ]; then
  IFS= read -r token <"$token_file" 2>/dev/null || true
fi

tmp=$(mktemp "${TMPDIR:-/tmp}/deck-perm.XXXXXX" 2>/dev/null) || exit 0
pid=
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  rm -f "$tmp" "$tmp.code"
}
trap 'cleanup; exit 0' TERM INT HUP
trap cleanup EXIT

input=$(cat)

# curl runs in the background so a trapped signal can stop it mid-wait: bash
# runs traps only between commands, and `wait` returns at once on a signal.
if [ -n "$token" ]; then
  printf '%s' "$input" | curl -s -m 600 --connect-timeout 2 -o "$tmp" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") \
    --data-binary @- "$url/permission-cmd" >"$tmp.code" 2>/dev/null &
else
  printf '%s' "$input" | curl -s -m 600 --connect-timeout 2 -o "$tmp" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data-binary @- "$url/permission-cmd" >"$tmp.code" 2>/dev/null &
fi
pid=$!
wait "$pid" 2>/dev/null
pid=

code=
IFS= read -r code <"$tmp.code" 2>/dev/null || true
case $code in 2??) ;; *) exit 0 ;; esac

body=
IFS= read -r -d '' body <"$tmp" 2>/dev/null || true
trimmed=${body#"${body%%[![:space:]]*}"}
trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
case $trimmed in
  '{'*'}')
    inner=${trimmed#\{}
    inner=${inner%\}}
    inner=${inner//[[:space:]]/}
    [ -n "$inner" ] && printf '%s' "$body"
    ;;
esac
exit 0
