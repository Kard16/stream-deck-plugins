-- LrShutdownApp: runs when Lightroom quits. Quit waits until doneFunction is called,
-- so do the minimum and call it straight away.
local LrTasks = import 'LrTasks'

local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Poll = require 'Poll'

return {
  LrShutdownFunction = function(doneFunction, progressFunction)
    LrTasks.pcall(function()
      Log.info('shutdown (app): inst %s', tostring(State.inst))
      Server.send({ t = 'bye', why = 'shutdownApp' })
      State.running = false
      Server.stop()
      Poll.markShutdown()
    end)
    doneFunction()
  end,
}
