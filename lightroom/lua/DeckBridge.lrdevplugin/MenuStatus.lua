-- File > Plug-in Extras > Deck Bridge: Status. Shows whether a deck is connected, the
-- guard and the catalog, and this plugin instance and version. Menu scripts share
-- module state with Init's task (spike run 1), so this reads the live state.
local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'

LrTasks.startAsyncTask(function()
  local ok, text = LrTasks.pcall(function() return require('Core').statusText() end)
  if not ok then
    text = 'Could not read the status: ' .. tostring(text)
  end
  LrDialogs.message('Deck Bridge: Status', text, 'info')
end, 'DeckBridge status')
