-- Shared mutable state for the DeckBridge modules. Plain data only.
return {
  running = false,
  inst = nil, -- random id, new on every plugin load
  startedAt = nil, -- LrDate time this instance started
  context = nil, -- the long-lived function context that owns sockets and the observer

  recvGen = 0, -- generation of the command (receive) socket
  sendGen = 0, -- generation of the event (send) socket

  watched = {}, -- params pushed in `vals`
  lastSent = {}, -- param -> value last sent in `vals`
  lastValues = {}, -- param -> value last read from Lightroom
  pushHz = 0, -- `vals` throttle; 0 = unthrottled

  observer = nil, -- current observer table; callbacks from older ones are ignored
  observerGen = 0,
  observerSuspect = false, -- set on re-entering Develop until a callback proves the observer alive
  obsCount = 0, -- adjustment-observer callbacks so far
  lastObsAt = nil,

  tracked = nil, -- param passed to startTracking, until `done`
  lastSetAt = nil, -- when a `set` last changed a value
  obsAtSet = nil, -- obsCount just before that set

  cyOnMessage = nil, -- LrTasks.canYield() as seen inside the socket's onMessage

  pendingTrigger = nil, -- spike: menu trigger, shared-state route
  triggerLog = {}, -- spike: recent trigger arrivals and their routes
}
