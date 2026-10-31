-- hello and ping, the greeting a client gets on connecting, and the text of the
-- Deck Bridge: Status dialog.
--
-- Reloadable: no state of its own, and nothing runs at load time.
local LrApplication = import 'LrApplication'
local LrDate = import 'LrDate'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Proto = require 'Proto'
local Guard = require 'Guard'
local Poll = require 'Poll'
local Dispatch = require 'Dispatch'

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
    v = Config.PROTOCOL,
    lr = Core.lrVersion(),
    catalog = path and LrPathUtils.leafName(path) or json.null,
    path = path or json.null,
    guard = Guard.mode(),
    writable = writable and true or false,
    inst = State.inst or json.null,
  }
end

-- hello, state, then in Develop ranges and vals for the watch list. Runs in a task.
function Core.greeting()
  Server.send(Core.helloMessage())
  Poll.sync({ state = true, vals = true })
end

-- A client connected to the event socket. The greeting goes through the command queue,
-- so it runs in a task (reading state needs one) and in order with commands.
function Core.greet()
  Dispatch.enqueue({ mod = 'Core', fn = 'greeting', m = { t = 'hello' } })
end

-- hello {v, client, ver}
function Core.hello(m)
  if m.v ~= Config.PROTOCOL then
    Log.warn('the deck speaks protocol v%s; this plugin speaks v%d', tostring(m.v), Config.PROTOCOL)
  end
  Log.info('deck hello: %s %s', tostring(m.client), tostring(m.ver))
  Core.greeting()
end

-- ping {id}
function Core.ping(m)
  Server.send({ t = 'pong', id = Proto.id(m), lt = LrDate.currentTime() })
end

-- "2 h 5 min", "3 min", "12 s"
function Core.duration(secs)
  secs = math.max(0, math.floor(secs or 0))
  if secs < 60 then
    return secs .. ' s'
  end
  local mins = math.floor(secs / 60)
  if mins < 60 then
    return mins .. ' min'
  end
  return math.floor(mins / 60) .. ' h ' .. (mins % 60) .. ' min'
end

-- The text of the Status dialog: the connection, the guard and catalog, this instance.
function Core.statusText()
  local lines = {}
  local function add(fmt, ...)
    lines[#lines + 1] = string.format(fmt, ...)
  end
  local cmd, evt = Server.cmdConnected, Server.evtConnected
  if cmd and evt then
    add('Deck: connected.')
  elseif cmd or evt then
    add('Deck: partly connected (commands %s, events %s).', cmd and 'yes' or 'no', evt and 'yes' or 'no')
  else
    add('Deck: not connected. Listening on ports %s and %s.', tostring(Config.CMD_PORT), tostring(Config.EVT_PORT))
  end
  local writable, why = Guard.writable()
  if Config.GUARD then
    add('Guard: on. Writes %s: %s.', writable and 'go through' or 'are refused', why)
  else
    add('Guard: off. Writes go through in any catalog.')
  end
  add('Catalog: %s', tostring(Guard.catalogPath() or 'none'))
  add('Test catalog: %s', Config.TEST_CATALOG)
  add('Plugin: Deck Bridge %s, protocol v%d, instance %s.', Config.VERSION, Config.PROTOCOL, tostring(State.inst or 'none'))
  if State.running and State.startedAt then
    add('Running for %s. Watching %d params.', Core.duration(LrDate.currentTime() - State.startedAt), #State.watched)
  else
    add('The bridge is not running.')
  end
  return table.concat(lines, '\n')
end

return Core
