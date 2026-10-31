#!/bin/sh
# Syntax-check every plugin file with Lua 5.1.5's luac, then run the unit tests.
set -e
cd "$(dirname "$0")/../../.."
mise exec -- luac -p lightroom/lua/DeckBridge.lrdevplugin/*.lua
echo "luac -p: ok"
mise exec -- lua lightroom/lua/tests/run.lua
