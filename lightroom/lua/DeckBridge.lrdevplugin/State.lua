-- Shared mutable state for the DeckBridge modules. Plain data only.
--
-- Never reloads, so everything a hot reload must keep lives here: the socket
-- generations, the command queue, the watch list and what the deck was sent and is
-- owed, the open gesture and the observer. The reloadable modules keep no state of
-- their own.
return {
  running = false,
  inst = nil, -- random id, new on every plugin load
  startedAt = nil, -- LrDate time this instance started
  context = nil, -- the long-lived function context that owns sockets and the observer
  pluginPath = nil, -- _PLUGIN.path, where reload reads modules from

  recvGen = 0, -- generation of the command (receive) socket
  sendGen = 0, -- generation of the event (send) socket

  -- Dispatch
  queue = {}, -- commands waiting for the dispatch task: { mod, fn, m }
  draining = false, -- a dispatch task is working through the queue
  arrival = 0, -- commands received so far
  alwaysTask = {}, -- command type -> true once it failed outside a task
  cyOnMessage = nil, -- LrTasks.canYield() as seen inside onMessage

  -- Develop
  watched = {}, -- params pushed in vals and ranges, in the deck's order
  watchChecked = false, -- the watch list has been checked against getRange
  watchId = nil, -- id of the watch command that set the list, for a later err
  -- What the deck is owed. After hello and watch, on entering Develop and on every photo
  -- change it needs every watched range and value (Develop.owe). A param with no
  -- lastSent value goes out with the next vals, and one in rangesOwed with the next
  -- ranges, so a read that fails while Develop is still loading is retried, not lost.
  lastSent = {}, -- param -> value last sent in vals, for the current photo
  rangesOwed = {}, -- param -> true: a watched param whose range the deck still needs
  lastValsAt = nil, -- when vals last went out
  flushAt = nil, -- when a vals push the rate limit held back is due
  gesture = nil, -- the open gesture: { p, g, photo = id it started on, at = time of its last set }
  observer = nil, -- the registered adjustment observer
  obsCount = 0, -- adjustment-observer callbacks so far
  obsTask = false, -- an observer task is on its way

  -- Poll
  lastState = nil, -- the state last sent
  lastModule = nil, -- module and target photo at the last poll, to spot changes
  lastPhoto = nil,
  ticks = 0,

  -- Guard
  lastBezelAt = nil, -- when the guard last showed its bezel
}
