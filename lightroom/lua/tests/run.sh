#!/bin/sh
# Syntax-check every plugin file with Lua 5.1.5's luac, then run the unit tests, then
# every protocol fixture in lightroom/protocol/fixtures. Stops at the first failure.
set -e
cd "$(dirname "$0")/../../.."
mise exec -- luac -p lightroom/lua/DeckBridge.lrdevplugin/*.lua
echo "luac -p: ok ($(ls lightroom/lua/DeckBridge.lrdevplugin/*.lua | wc -l | tr -d ' ') files)"
mise exec -- lua lightroom/lua/tests/run.lua
mise exec -- lua lightroom/lua/tests/fixtures.lua
