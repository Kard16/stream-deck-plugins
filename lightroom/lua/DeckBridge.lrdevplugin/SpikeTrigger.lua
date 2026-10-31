-- Spike-only: menu items ask the harness to start test runs. Track A deletes this file.
--
-- Whether menu scripts share require'd module state with Init's task is unverified, so a
-- click travels two routes: State.pendingTrigger, and a file in Lightroom's temp folder.
-- The poll loop consumes whichever arrives, sends one `trigger`, and logs each route seen.
local LrDate = import 'LrDate'
local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local Log = require 'Log'
local State = require 'State'

local SpikeTrigger = { NAMES = { 'tests', 'autosync' } }

local lastSentAt = {}

function SpikeTrigger.path(name)
  return LrPathUtils.child(LrPathUtils.getStandardFilePath('temp'), 'deckbridge-trigger-' .. name)
end

-- Runs in the menu item's own script.
function SpikeTrigger.fire(name)
  local now = LrDate.currentTime()
  State.pendingTrigger = { name = name, at = now }
  local ok, err = LrTasks.pcall(function()
    local f = io.open(SpikeTrigger.path(name), 'w')
    if f then
      f:write(string.format('%.3f', now))
      f:close()
    end
  end)
  if not ok then
    Log.warn('menu: could not write the trigger file: %s', tostring(err))
  end
  Log.info('menu: %s requested', name)
  LrTasks.pcall(LrDialogs.showBezel, 'Deck Spike: ' .. name .. ' requested', 2)
end

local function arrive(name, route)
  local now = LrDate.currentTime()
  local log = State.triggerLog
  log[#log + 1] = { name = name, route = route, lt = now }
  while #log > 10 do
    table.remove(log, 1)
  end
  if lastSentAt[name] and now - lastSentAt[name] < 2 then
    Log.info('trigger %s arrived via %s (duplicate, ignored)', name, route)
    return false
  end
  lastSentAt[name] = now
  Log.info('trigger %s arrived via %s', name, route)
  local Server = require 'Server'
  Server.send({ t = 'trigger', name = name, route = route })
  return true
end

-- Runs from the poll loop.
function SpikeTrigger.consume()
  local pending = State.pendingTrigger
  if pending then
    State.pendingTrigger = nil
    arrive(pending.name, 'state')
  end
  for _, name in ipairs(SpikeTrigger.NAMES) do
    local path = SpikeTrigger.path(name)
    if LrFileUtils.exists(path) then
      local at = tonumber(LrFileUtils.readFile(path) or '')
      LrFileUtils.delete(path)
      if at and LrDate.currentTime() - at > 30 then
        Log.info('trigger file for %s is stale; ignored', name)
      else
        arrive(name, 'file')
      end
    end
  end
end

-- Runs at startup: a file left from an earlier session must not fire.
function SpikeTrigger.clearStale()
  for _, name in ipairs(SpikeTrigger.NAMES) do
    local path = SpikeTrigger.path(name)
    if LrFileUtils.exists(path) then
      LrFileUtils.delete(path)
    end
  end
end

return SpikeTrigger
