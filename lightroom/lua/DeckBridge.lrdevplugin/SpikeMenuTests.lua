-- Spike-only: File > Plug-in Extras > Deck Spike: Run tests. Track A deletes this file.
local LrTasks = import 'LrTasks'

local SpikeTrigger = require 'SpikeTrigger'

LrTasks.startAsyncTask(function()
  LrTasks.pcall(SpikeTrigger.fire, 'tests')
end, 'DeckBridge menu: tests')
