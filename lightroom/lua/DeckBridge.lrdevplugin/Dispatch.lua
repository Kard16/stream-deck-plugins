-- Decodes command lines and runs their handlers, each under LrTasks.pcall.
--
-- A handler is { fn = function(msg), immediate = bool, needsTask = function(msg) }.
-- * immediate handlers run straight away, whatever else is going on.
-- * Others run straight away too, unless they need to yield (needsTask returns true, e.g.
--   to switch to Develop) or the queue is busy. Then they go through one FIFO queue,
--   drained by one async task, so commands still apply in arrival order.
local LrTasks = import 'LrTasks'

local json = require 'json'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'

local Dispatch = { handlers = {} }

local queue = {}
local draining = false
local arrival = 0

-- Adds or replaces handlers by command type.
function Dispatch.register(handlers)
  for t, h in pairs(handlers) do
    Dispatch.handlers[t] = h
  end
end

local function run(h, m)
  local ok, err = LrTasks.pcall(h.fn, m)
  if not ok then
    Log.error('%s failed: %s', tostring(m.t), tostring(err))
    Server.send({ t = 'err', id = m.id, msg = tostring(err), cmd = m.t })
  end
end

local function drain()
  draining = true
  LrTasks.startAsyncTask(function()
    LrTasks.pcall(function()
      while #queue > 0 do
        local item = table.remove(queue, 1)
        run(item.h, item.m)
      end
    end)
    draining = false
    if #queue > 0 then -- only if the loop above died; never strand queued commands
      drain()
    end
  end, 'DeckBridge dispatch')
end

local function trim(s)
  return (string.gsub(string.gsub(s, '^%s+', ''), '%s+$', ''))
end

function Dispatch.onLine(line)
  if State.cyOnMessage == nil then
    State.cyOnMessage = Log.canYield()
    Log.info('onMessage can yield: %s', tostring(State.cyOnMessage))
  end
  if type(line) ~= 'string' then
    return
  end
  line = trim(line)
  if line == '' then
    return
  end
  arrival = arrival + 1

  local ok, m = LrTasks.pcall(json.decode, line)
  if not ok or type(m) ~= 'table' then
    Server.send({ t = 'err', msg = 'bad json: ' .. (ok and 'not an object' or tostring(m)) })
    return
  end
  local h = type(m.t) == 'string' and Dispatch.handlers[m.t] or nil
  if not h then
    Server.send({ t = 'err', id = m.id, msg = 'unknown command', cmd = tostring(m.t) })
    return
  end
  m._arrival = arrival
  Log.debug('cmd %s', line)

  if h.immediate then
    run(h, m)
    return
  end
  local needsTask = false
  if h.needsTask then
    local okNeeds, r = LrTasks.pcall(h.needsTask, m)
    needsTask = (not okNeeds) or (r and true or false)
  end
  if draining or needsTask then
    queue[#queue + 1] = { h = h, m = m }
    if not draining then
      drain()
    end
    return
  end
  run(h, m)
end

function Dispatch.queueLength()
  return #queue
end

return Dispatch
