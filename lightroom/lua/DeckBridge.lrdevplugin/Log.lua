-- Logging to ~/Library/Logs/Adobe/Lightroom/LrClassicLogs/DeckBridge.log (LrC 14+).
--
-- Normal use logs only lifecycle lines, connections and problems. Per-command and
-- per-poll lines go through Log.debug, which writes only while Config.DEBUG is on.
-- Problems that could repeat on every poll or command go through Log.every. Never
-- reloads.
local LrDate = import 'LrDate'
local LrLogger = import 'LrLogger'
local LrTasks = import 'LrTasks'

local Config = require 'Config'

local logger = LrLogger('DeckBridge')
logger:enable('logfile')

local Log = {}

local lastAt = {} -- Log.every key -> when it last wrote

-- string.format that never throws: a bad format falls back to joining the arguments.
local function render(fmt, ...)
  if select('#', ...) == 0 then
    return tostring(fmt)
  end
  local ok, s = LrTasks.pcall(string.format, fmt, ...)
  if ok then
    return s
  end
  local parts = { tostring(fmt) }
  for i = 1, select('#', ...) do
    parts[#parts + 1] = tostring((select(i, ...)))
  end
  return table.concat(parts, ' ')
end

local function emit(level, s)
  local ok = LrTasks.pcall(function() logger[level](logger, s) end)
  if not ok then
    LrTasks.pcall(function() logger:info(level .. ': ' .. s) end)
  end
end

function Log.info(fmt, ...) emit('info', render(fmt, ...)) end
function Log.warn(fmt, ...) emit('warn', render(fmt, ...)) end
function Log.error(fmt, ...) emit('error', render(fmt, ...)) end

function Log.debug(fmt, ...)
  if Config.DEBUG then
    emit('info', '[debug] ' .. render(fmt, ...))
  end
end

-- A line written at most once every secs for each key; level is 'warn' or 'error'.
function Log.every(key, secs, level, fmt, ...)
  local t = LrDate.currentTime()
  if lastAt[key] and t - lastAt[key] < secs then
    return
  end
  lastAt[key] = t
  emit(level, render(fmt, ...))
end

-- LrTasks.canYield(), or false if this Lightroom lacks it. Lives here because every
-- module already requires Log.
function Log.canYield()
  local ok, r = LrTasks.pcall(function() return LrTasks.canYield() end)
  return ok and r == true
end

return Log
