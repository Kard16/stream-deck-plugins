-- Develop control: set/get/range/done/reset/watch, and the adjustment observer that
-- pushes watched params to the deck. LrDevelopController works only in Develop, on the
-- active photo. Ranges differ by file type, so nothing here assumes one.
local LrApplicationView = import 'LrApplicationView'
local LrDate = import 'LrDate'
local LrDevelopController = import 'LrDevelopController'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Guard = require 'Guard'

local Develop = {}

local applied = {} -- param -> arrival number of the last command that wrote it
local lastPushAt = 0
local pendingPush = false

for i, p in ipairs(Config.BANK_PARAMS) do
  State.watched[i] = p
end

local function now()
  return LrDate.currentTime()
end

local function msSince(t0)
  return (now() - t0) * 1000
end

local function numOrNull(v)
  if type(v) == 'number' and v == v then
    return v
  end
  return json.null
end

function Develop.inDevelop()
  return LrApplicationView.getCurrentModuleName() == 'develop'
end

-- Switches to Develop and waits up to 1 s for it. Waiting needs a task that can yield.
function Develop.ensureDevelop()
  if Develop.inDevelop() then
    return true
  end
  LrApplicationView.switchToModule('develop')
  if not Log.canYield() then
    Log.warn('switched to Develop without being able to wait for it')
    return Develop.inDevelop()
  end
  local t0 = now()
  repeat
    LrTasks.sleep(0.05)
  until Develop.inDevelop() or now() - t0 > 1
  LrTasks.yield() -- let Develop finish loading the photo, as MIDI2LR does
  return Develop.inDevelop()
end

-- Sends watched params that changed since the last push. force sends them all, and
-- outside Develop sends the last values read (marked cached).
function Develop.pushValues(force)
  local t = now()
  if not force and State.pushHz and State.pushHz > 0 and t - lastPushAt < 1 / State.pushHz then
    pendingPush = true
    return false
  end
  local inDev = Develop.inDevelop()
  local changed, n = json.object({}), 0
  for _, p in ipairs(State.watched) do
    local v
    if inDev then
      local ok, val = LrTasks.pcall(LrDevelopController.getValue, p)
      if ok and type(val) == 'number' and val == val then
        v = val
        State.lastValues[p] = val
      end
    elseif force then
      v = State.lastValues[p]
    end
    if v ~= nil then
      local last = State.lastSent[p]
      if force or last == nil or math.abs(v - last) > 1e-9 then
        changed[p] = v
        n = n + 1
        State.lastSent[p] = v
      end
    end
  end
  pendingPush = false
  if n == 0 and not force then
    return false
  end
  lastPushAt = t
  local msg = { t = 'vals', vals = changed, lt = t }
  if not inDev then
    msg.cached = true
  end
  Server.send(msg)
  return true
end

-- Sends a push the throttle held back. Called from the poll loop.
function Develop.flushPending()
  if pendingPush then
    Develop.pushValues(false)
  end
end

-- Registers the adjustment observer against the long-lived context. Must run in Develop.
-- Older observers can't be removed, so each one checks it is still current.
function Develop.ensureObserver(force)
  if State.observer and not force then
    return true
  end
  if not Develop.inDevelop() then
    return false
  end
  local obs = { gen = State.observerGen + 1 }
  local ok, err = LrTasks.pcall(LrDevelopController.addAdjustmentChangeObserver, State.context, obs, function()
    if State.observer ~= obs then return end
    State.obsCount = State.obsCount + 1
    State.lastObsAt = now()
    State.observerSuspect = false
    local okPush, errPush = LrTasks.pcall(Develop.pushValues, false)
    if not okPush then
      Log.warn('observer push failed: %s', tostring(errPush))
    end
  end)
  if not ok then
    Log.error('addAdjustmentChangeObserver failed: %s', tostring(err))
    return false
  end
  State.observerGen = obs.gen
  State.observer = obs
  Log.info('adjustment observer registered (gen %d)', obs.gen)
  return true
end

-- After re-entering Develop, a set that changed a value but drew no callback within
-- 1.5 s means the observer stopped firing: register a fresh one. Called from the poll loop.
function Develop.checkObserver()
  if not (State.observerSuspect and State.lastSetAt and State.obsAtSet) then
    return
  end
  if State.obsCount > State.obsAtSet then
    State.observerSuspect = false
    return
  end
  if now() - State.lastSetAt > 1.5 and Develop.inDevelop() then
    Log.warn('no observer callback since re-entering Develop; registering a new observer')
    State.observerSuspect = false
    Develop.ensureObserver(true)
  end
end

function Develop.set(m)
  local t0 = now()
  local cy = Log.canYield()
  local p, v = m.p, m.v
  if type(p) ~= 'string' or type(v) ~= 'number' or v ~= v then
    error('set needs a param name p and a number v')
  end
  local ok, why = Guard.writable()
  if not ok then
    Guard.reply(m, why)
    return
  end
  -- Never let an older set overwrite a newer one for the same param.
  if m._arrival and applied[p] and applied[p] > m._arrival then
    local okCur, cur = LrTasks.pcall(LrDevelopController.getValue, p)
    Server.send({ t = 'ack', seq = m.seq, p = p, v = okCur and numOrNull(cur) or json.null, ms = msSince(t0), cy = cy, stale = true })
    return
  end
  if not Develop.ensureDevelop() then
    error('could not switch to Develop')
  end
  if m.track ~= false and State.tracked ~= p then
    LrDevelopController.startTracking(p)
    State.tracked = p
  end
  local obsBefore = State.obsCount -- the observer may fire inside setValue
  LrDevelopController.setValue(p, v)
  applied[p] = m._arrival or applied[p]
  local v2 = LrDevelopController.getValue(p)
  if type(v2) == 'number' then
    local prev = State.lastValues[p]
    if prev == nil or math.abs(v2 - prev) > 1e-9 then
      State.lastSetAt = now()
      State.obsAtSet = obsBefore
    end
    State.lastValues[p] = v2
  end
  Server.send({ t = 'ack', seq = m.seq, p = p, v = numOrNull(v2), ms = msSince(t0), cy = cy })
end

function Develop.done()
  LrTasks.pcall(LrDevelopController.stopTracking)
  State.tracked = nil
end

local function needsDevelop()
  return not Develop.inDevelop()
end

local function requireParam(m)
  if type(m.p) ~= 'string' then
    error(tostring(m.t) .. ' needs a param name p')
  end
end

Develop.handlers = {
  watch = {
    immediate = true,
    fn = function(m)
      if type(m.ps) ~= 'table' then
        error('watch needs ps, a list of param names')
      end
      local ps = {}
      for _, p in ipairs(m.ps) do
        if type(p) == 'string' then
          ps[#ps + 1] = p
        end
      end
      State.watched = ps
      State.lastSent = {}
      Develop.pushValues(true)
    end,
  },
  get = {
    needsTask = needsDevelop,
    fn = function(m)
      requireParam(m)
      if not Develop.ensureDevelop() then
        error('could not switch to Develop')
      end
      local v = LrDevelopController.getValue(m.p)
      Server.send({ t = 'val', id = m.id, p = m.p, v = numOrNull(v) })
    end,
  },
  range = {
    needsTask = needsDevelop,
    fn = function(m)
      requireParam(m)
      if not Develop.ensureDevelop() then
        error('could not switch to Develop')
      end
      local lo, hi = LrDevelopController.getRange(m.p)
      Server.send({ t = 'range', id = m.id, p = m.p, min = numOrNull(lo), max = numOrNull(hi) })
    end,
  },
  set = { needsTask = needsDevelop, fn = Develop.set },
  done = { fn = Develop.done },
  reset = {
    needsTask = needsDevelop,
    fn = function(m)
      requireParam(m)
      local ok, why = Guard.writable()
      if not ok then
        Guard.reply(m, why)
        return
      end
      if not Develop.ensureDevelop() then
        error('could not switch to Develop')
      end
      LrDevelopController.resetToDefault(m.p)
      applied[m.p] = m._arrival or applied[m.p]
    end,
  },
}

return Develop
