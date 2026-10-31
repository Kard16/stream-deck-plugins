-- Decodes command lines and runs their handlers, each under LrTasks.pcall.
--
-- onMessage runs outside any task and can't yield (spike run 1), so a handler runs
-- straight away only when it never has to wait. Handlers that read photo metadata,
-- switch modules or write the catalog go through one FIFO queue, drained by one async
-- task, and while that queue is busy every command but ping joins it, so commands still
-- apply in arrival order.
--
-- Handlers are looked up by module and function name on every call, so functions
-- swapped in by a hot reload take over at once. Reloadable: the queue lives in State.
local LrTasks = import 'LrTasks'

local json = require 'json'
local Log = require 'Log'
local State = require 'State'
local Proto = require 'Proto'
local Develop = require 'Develop'

local Dispatch = {}

-- t -> { module, function, when }
-- when: 'now' runs straight away, even while the queue is busy; 'task' always goes
-- through the queue; 'develop' goes through the queue unless Develop is already active;
-- nil runs straight away unless the queue is busy.
Dispatch.ROUTES = {
  hello = { 'Core', 'hello', 'task' },
  ping = { 'Core', 'ping', 'now' },
  watch = { 'Develop', 'watch', 'task' },
  set = { 'Develop', 'set', 'develop' },
  done = { 'Develop', 'done' },
  reset = { 'Develop', 'reset', 'develop' },
  module = { 'Library', 'module', 'task' },
  flag = { 'Library', 'flag', 'task' },
  nav = { 'Library', 'nav', 'task' },
  view = { 'Library', 'view', 'task' },
  presets = { 'Presets', 'list', 'task' },
  preset = { 'Presets', 'apply', 'task' },
  reload = { 'Reload', 'reload', 'task' },
}

-- Runs one queued or direct item { mod, fn, m }. direct is true when it ran straight
-- from onMessage, outside any task.
function Dispatch.run(item, direct)
  local m = item.m
  local ok, err = LrTasks.pcall(function()
    local fn = require(item.mod)[item.fn]
    if type(fn) ~= 'function' then
      error(item.mod .. '.' .. item.fn .. ' is missing')
    end
    fn(m)
  end)
  if ok then
    return
  end
  -- Some Lightroom calls wait internally and fail outside a task ("We can only wait
  -- from within a task"). Run this command, and every later one of its type, through
  -- the task queue instead.
  if direct and string.find(tostring(err), 'within a task', 1, true) then
    Log.warn('%s needs a task; routing it through the queue from now on', tostring(m.t))
    State.alwaysTask[m.t or item.fn] = true
    Dispatch.enqueue(item)
    return
  end
  -- A dial can send 30 sets a second, so a failing handler logs at most every 5 s.
  local what = tostring(m.t or item.fn)
  Log.every('failed ' .. what, 5, 'error', '%s failed: %s', what, tostring(err))
  Proto.err(m, 'failed', tostring(err))
end

function Dispatch.drain()
  State.draining = true
  local ok, err = LrTasks.pcall(LrTasks.startAsyncTask, function()
    LrTasks.pcall(function()
      while #State.queue > 0 do
        local item = table.remove(State.queue, 1)
        require('Dispatch').run(item, false)
      end
    end)
    State.draining = false
    if #State.queue > 0 then -- only if the loop above died; never strand queued commands
      require('Dispatch').drain()
    end
  end, 'DeckBridge dispatch')
  if not ok then
    State.draining = false
    Log.error('could not start the dispatch task: %s', tostring(err))
  end
end

-- Queues an item { mod, fn, m } for the dispatch task.
function Dispatch.enqueue(item)
  State.queue[#State.queue + 1] = item
  if not State.draining then
    Dispatch.drain()
  end
end

local function trim(s)
  return (string.gsub(string.gsub(s, '^%s+', ''), '%s+$', ''))
end

function Dispatch.onLine(line)
  if State.cyOnMessage == nil then
    State.cyOnMessage = Log.canYield()
    Log.debug('onMessage can yield: %s', tostring(State.cyOnMessage))
  end
  if type(line) ~= 'string' then
    return
  end
  line = trim(line)
  if line == '' then
    return
  end
  -- rxi's json.lua decodes arrays and objects alike, so check for an object first.
  if string.sub(line, 1, 1) ~= '{' then
    return Proto.err(nil, 'bad', 'not a JSON object')
  end
  local ok, m = LrTasks.pcall(json.decode, line)
  if not ok or type(m) ~= 'table' then
    return Proto.err(nil, 'bad', 'bad JSON: ' .. tostring(m))
  end
  if m.id ~= nil and not Proto.isNumber(m.id) then
    m.id = nil
    return Proto.err(m, 'bad', 'id must be a number')
  end
  if type(m.t) ~= 'string' then
    return Proto.err(m, 'bad', 'the command has no type t')
  end
  local route = Dispatch.ROUTES[m.t]
  if not route then
    return Proto.err(m, 'unknown', 'unknown command ' .. m.t)
  end
  State.arrival = State.arrival + 1
  Log.debug('cmd %s', line)

  local item = { mod = route[1], fn = route[2], m = m }
  local when = route[3]
  local always = State.alwaysTask[m.t]
  if when == 'now' and not always then
    return Dispatch.run(item, true)
  end
  local needsTask = always or when == 'task' or (when == 'develop' and not Develop.inDevelop())
  if State.draining or needsTask then
    return Dispatch.enqueue(item)
  end
  Dispatch.run(item, true)
end

function Dispatch.queueLength()
  return #State.queue
end

return Dispatch
