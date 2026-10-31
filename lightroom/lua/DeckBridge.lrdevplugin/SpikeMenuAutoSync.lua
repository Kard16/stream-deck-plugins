-- Spike-only: File > Plug-in Extras > Deck Spike: Auto Sync test. Track A deletes this file.
local LrTasks = import 'LrTasks'

local SpikeTrigger = require 'SpikeTrigger'

LrTasks.startAsyncTask(function()
  LrTasks.pcall(SpikeTrigger.fire, 'autosync')
end, 'DeckBridge menu: autosync')
