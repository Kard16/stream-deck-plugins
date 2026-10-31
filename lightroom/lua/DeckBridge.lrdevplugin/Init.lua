-- LrInitPlugin: runs once per plugin load and starts the long-lived DeckBridge task,
-- which owns both sockets and the adjustment observer.
local LrDate = import 'LrDate'
local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Dispatch = require 'Dispatch'
local Guard = require 'Guard'
local Core = require 'Core'
local Develop = require 'Develop'
local Poll = require 'Poll'
local Spike = require 'Spike' -- spike-only
local SpikeTrigger = require 'SpikeTrigger' -- spike-only

math.randomseed(os.time() + math.floor((LrDate.currentTime() % 1) * 1000000))
State.inst = string.format('%x-%04x', os.time(), math.random(0, 65535))
State.startedAt = LrDate.currentTime()
State.running = true

Dispatch.register(Core.handlers)
Dispatch.register(Develop.handlers)
Dispatch.register(Spike.handlers)
Server.onLine = Dispatch.onLine
Server.onClientConnected = Core.greet
Poll.extraTick = SpikeTrigger.consume

LrFunctionContext.postAsyncTaskWithContext('DeckBridge', function(context)
  State.context = context
  Log.info('starting: inst %s, Lightroom %s, catalog %s, guard %s',
    State.inst, Core.lrVersion(), tostring(Guard.catalogPath()), Guard.mode())
  SpikeTrigger.clearStale()
  Poll.start()
  Server.start(context)
  while State.running do
    LrTasks.pcall(Poll.tick, context)
    LrTasks.sleep(Config.POLL_SECS)
  end
  LrTasks.pcall(Server.stop)
  Log.info('stopped: inst %s', tostring(State.inst))
end)
