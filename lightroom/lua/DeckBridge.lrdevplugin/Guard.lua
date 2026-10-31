-- Test-catalog guard: while Config.GUARD is true, writes (set, reset, flag, preset) only
-- go through when the test catalog is open. Only the user turns it off.
--
-- Never hot-reloads (Reload.MODULES leaves it out), so only Reload Plug-in changes the
-- guard; the reload command itself runs only while writes may. Its one piece of state,
-- lastBezelAt, lives in State.lua.
local LrApplication = import 'LrApplication'
local LrDate = import 'LrDate'
local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Proto = require 'Proto'

local Guard = {}

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
    return true, 'the guard is off'
  end
  local path = Guard.catalogPath()
  if not path then
    return false, 'no catalog is open'
  end
  -- APFS is case-insensitive by default, so compare without case.
  if string.lower(path) == string.lower(Config.TEST_CATALOG) then
    return true, 'the test catalog is open'
  end
  return false, "the test catalog isn't open"
end

-- For a write: true if it may go ahead. Otherwise answers err guard and says why in a
-- bezel, at most every Config.BEZEL_SECS, and logs it as often.
function Guard.check(m)
  local ok, why = Guard.writable()
  if ok then
    return true
  end
  Proto.err(m, 'guard', 'writes are off: ' .. why)
  local t = LrDate.currentTime()
  if not State.lastBezelAt or t - State.lastBezelAt >= Config.BEZEL_SECS then
    State.lastBezelAt = t
    Log.warn('guard refused %s: %s', tostring(m and m.t), why)
    LrTasks.pcall(LrDialogs.showBezel, 'Deck Bridge: writes are off (' .. why .. ')', 3)
  end
  return false
end

return Guard
