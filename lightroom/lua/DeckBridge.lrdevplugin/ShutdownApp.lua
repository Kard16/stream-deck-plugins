-- LrShutdownApp: runs when Lightroom quits. Quit waits until doneFunction is called,
-- so do the minimum and call it straight away. The sockets are already closed.
local LrTasks = import 'LrTasks'

local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'

return {
  LrShutdownFunction = function(doneFunction, progressFunction)
    LrTasks.pcall(function()
      Log.info('shutdown (app): inst %s', tostring(State.inst))
      State.running = false
      Server.stop()
      require('Poll').markShutdown()
    end)
    doneFunction()
  end,
}
