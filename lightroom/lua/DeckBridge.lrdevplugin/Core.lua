-- Core commands (hello, ping, config) and the greeting sent to every new client.
local LrApplication = import 'LrApplication'
local LrDate = import 'LrDate'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Guard = require 'Guard'

local Core = {}

function Core.lrVersion()
  local ok, v = LrTasks.pcall(LrApplication.versionString)
  if ok and v then
    return tostring(v)
  end
  local okTable, t = LrTasks.pcall(LrApplication.versionTable)
  if okTable and type(t) == 'table' then
    return string.format('%s.%s.%s', tostring(t.major), tostring(t.minor), tostring(t.revision))
  end
  return 'unknown'
end

function Core.helloMessage()
  local path = Guard.catalogPath()
  local writable = Guard.writable()
  return {
    t = 'hello',
    v = 0,
    lr = Core.lrVersion(),
    catalog = path and LrPathUtils.leafName(path) or json.null,
    path = path or json.null,
    guard = Guard.mode(),
    writable = writable and true or false,
    inst = State.inst,
    gen = State.sendGen,
  }
end

-- hello, then state, then vals: what a client gets on connecting to the event port.
function Core.greet()
  Server.send(Core.helloMessage())
  local Poll = require 'Poll'
  local Develop = require 'Develop'
  Poll.sendState(true)
  Develop.pushValues(true)
end

Core.handlers = {
  hello = {
    immediate = true,
    fn = function(m)
      Log.info('client hello: %s v%s', tostring(m.client), tostring(m.v))
      Core.greet()
    end,
  },
  ping = {
    immediate = true,
    fn = function(m)
      Server.send({ t = 'pong', id = m.id, lt = LrDate.currentTime() })
    end,
  },
  config = {
    immediate = true,
    fn = function(m)
      if m.pushHz ~= nil then
        State.pushHz = tonumber(m.pushHz) or 0
        Log.info('pushHz = %s', tostring(State.pushHz))
      end
    end,
  },
}

return Core
