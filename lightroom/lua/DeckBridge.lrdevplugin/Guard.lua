-- Test-catalog guard: writes only go through while the test catalog is open.
local LrApplication = import 'LrApplication'
local LrDate = import 'LrDate'
local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Log = require 'Log'

local Guard = {}

local lastBezelAt = 0

function Guard.catalogPath()
  local ok, path = LrTasks.pcall(function() return LrApplication.activeCatalog():getPath() end)
  if ok and type(path) == 'string' then
    return path
  end
  return nil
end

function Guard.mode()
  if Config.GUARD then
    return 'on'
  end
  return 'off'
end

-- Returns ok, reason.
function Guard.writable()
  if not Config.GUARD then
    return true, 'guard off'
  end
  local path = Guard.catalogPath()
  if not path then
    return false, 'no active catalog'
  end
  -- APFS is case-insensitive by default, so compare without case.
  if string.lower(path) == string.lower(Config.TEST_CATALOG) then
    return true, 'test catalog'
  end
  return false, 'not the test catalog'
end

-- Answers a refused command with err {msg = "guard"} and says why on screen, at most every 5 s.
function Guard.reply(m, reason)
  local Server = require 'Server'
  Server.send({ t = 'err', id = m and m.id, msg = 'guard', cmd = m and m.t, why = reason })
  Log.warn('guard refused %s: %s', tostring(m and m.t), tostring(reason))
  local now = LrDate.currentTime()
  if now - lastBezelAt > 5 then
    lastBezelAt = now
    LrTasks.pcall(LrDialogs.showBezel, 'Deck Bridge: writes are off (' .. tostring(reason) .. ')', 3)
  end
end

return Guard
