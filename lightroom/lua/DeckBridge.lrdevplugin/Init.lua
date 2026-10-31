-- LrInitPlugin: runs once per plugin load. Loads the modules, points the socket server
-- at the handlers, and starts the long-lived DeckBridge task, which owns both sockets
-- and the adjustment observer and runs the 200 ms poll. Never reloads.
local LrDate = import 'LrDate'
local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Reload = require 'Reload'

-- Load every reloadable module once. require caches them, and the reload command swaps
-- new functions into these same tables.
for _, name in ipairs(Reload.MODULES) do
  require(name)
end

math.randomseed(os.time() + math.floor((LrDate.currentTime() % 1) * 1000000))
State.inst = string.format('%x-%04x', os.time(), math.random(0, 65535))
State.startedAt = LrDate.currentTime()
State.pluginPath = _PLUGIN and _PLUGIN.path
State.running = true

-- These look the handler up on every call, so functions a reload swaps in take over at
-- once, and the sockets never need rebinding for it.
Server.onLine = function(line) require('Dispatch').onLine(line) end
Server.onClientConnected = function() require('Core').greet() end
Server.onClientGone = function(why) require('Develop').endGesture(why) end

LrFunctionContext.postAsyncTaskWithContext('DeckBridge', function(context)
  State.context = context
  local Core, Guard, Poll = require 'Core', require 'Guard', require 'Poll'
  Log.info('starting: Deck Bridge %s, inst %s, Lightroom %s, catalog %s, guard %s',
    Config.VERSION, State.inst, Core.lrVersion(), tostring(Guard.catalogPath()), Guard.mode())
  Poll.start()
  Server.start(context)
  while State.running do
    LrTasks.pcall(Poll.tick)
    LrTasks.sleep(Config.POLL_SECS)
  end
  LrTasks.pcall(Server.stop)
  Log.info('stopped: inst %s', tostring(State.inst))
end)
