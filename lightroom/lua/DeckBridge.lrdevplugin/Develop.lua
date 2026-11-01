-- Develop control: watch, set, done and reset, gestures, the adjustment observer, and
-- the ranges and vals pushed to the deck. LrDevelopController works only in Develop, on
-- the active photo, and ranges differ by file type, so every range comes from getRange.
--
-- Gestures (PROTOCOL.md, Gestures; spike S2): a gesture must be tracked to become one
-- history step, and Lightroom's observer stays silent while it is tracked. A set whose
-- p or g differs from the open gesture ends it and starts another. Two seconds without
-- a set, or the client leaving, ends it too. While a gesture tracks p, vals leave p out:
-- the deck owns that value. A gesture also belongs to the photo it started on: once the
-- photo or module changes under it, its later sets are refused with err stale. So is a
-- set or reset whose ph, the photo the deck worked from, isn't the target photo, and one
-- whose target photo changed while Lightroom switched to Develop for it.
--
-- Locked photos (PROTOCOL.md, Locked photos): set and reset on a photo that a background
-- AI process holds get err locked, and are checked again after a switch to Develop. They
-- go by the poll's latest reading for that photo (Poll.sync), so they never call
-- isAvailableForEditing, which onMessage mustn't.
--
-- Reloadable: all state lives in State.lua, and nothing runs at load time.
local LrApplication = import 'LrApplication'
local LrApplicationView = import 'LrApplicationView'
local LrDate = import 'LrDate'
local LrDevelopController = import 'LrDevelopController'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Proto = require 'Proto'
local Guard = require 'Guard'

local Develop = {}

local EPSILON = 1e-9

local function now()
  return LrDate.currentTime()
end

function Develop.inDevelop()
  local ok, name = LrTasks.pcall(LrApplicationView.getCurrentModuleName)
  return ok and name == 'develop'
end

function Develop.targetPhoto()
  local ok, photo = LrTasks.pcall(function() return LrApplication.activeCatalog():getTargetPhoto() end)
  if ok then
    return photo
  end
  return nil
end

-- Switches to Develop and waits up to Config.MODULE_SECS for it. Waiting needs a task;
-- outside one this can only ask for the switch.
function Develop.ensureDevelop()
  if Develop.inDevelop() then
    return true
  end
  if not LrTasks.pcall(LrApplicationView.switchToModule, 'develop') then
    return false
  end
  if not Log.canYield() then
    return Develop.inDevelop()
  end
  local t0 = now()
  while not Develop.inDevelop() and now() - t0 < Config.MODULE_SECS do
    LrTasks.sleep(0.05)
  end
  LrTasks.yield() -- let Develop finish loading the photo, as MIDI2LR does
  return Develop.inDevelop()
end

-- A call that failed only for want of a task re-raises, so the dispatcher can run the
-- command again from its queue (Dispatch.run) instead of answering for the wrong reason.
local function rethrowTaskError(err)
  if string.find(tostring(err), 'within a task', 1, true) then
    error(err, 0)
  end
end

-- getRange(p) as two numbers, or nil when Lightroom rejects p.
function Develop.range(p)
  local ok, lo, hi = LrTasks.pcall(LrDevelopController.getRange, p)
  if ok and Proto.isNumber(lo) and Proto.isNumber(hi) then
    return lo, hi
  end
  if not ok then
    rethrowTaskError(lo)
  end
  return nil
end

-- getValue(p) as a number, or nil.
function Develop.value(p)
  local ok, v = LrTasks.pcall(LrDevelopController.getValue, p)
  if ok and Proto.isNumber(v) then
    return v
  end
  if not ok then
    rethrowTaskError(v)
  end
  return nil
end

-- The target photo's localIdentifier as a string, as state carries it, or nil when there
-- is no target photo. Unlike targetPhoto, a read that fails for want of a task re-raises,
-- so a command run straight from onMessage moves to the task queue; any other failure
-- returns false, for "can't tell".
function Develop.photoId()
  local ok, id = LrTasks.pcall(function()
    local photo = LrApplication.activeCatalog():getTargetPhoto()
    return photo and tostring(photo.localIdentifier) or nil
  end)
  if ok then
    return id
  end
  rethrowTaskError(id)
  return false
end

-- For a set or reset whose getRange(p) failed: noPhoto when that is because Lightroom has
-- no target photo, otherwise bad, since p is no param Lightroom knows.
local function rangeFailed(m, p)
  if Develop.photoId() == nil then
    return Proto.err(m, 'noPhoto', 'no target photo')
  end
  return Proto.err(m, 'bad', 'unknown param ' .. p)
end

-- set and reset may carry ph, the photo from the latest state the deck has. It is
-- optional, but a string when present.
local function badPh(m)
  return m.ph ~= nil and type(m.ph) ~= 'string'
end

-- Whether a set or reset's ph rules it out as stale: it isn't photo, the target photo's
-- id as state carries it, compared as a string. No target photo is a mismatch, and so is
-- one Lightroom couldn't read. Commands without ph aren't checked.
local function wrongPhoto(m, photo)
  return m.ph ~= nil and m.ph ~= photo
end

-- Whether the poll's latest reading says photo, the target photo's id, is locked. Only a
-- reading taken for that photo counts. Reads State only, so it is safe in onMessage.
function Develop.isLocked(photo)
  local reading = State.lockReading -- nil until a poll has read a lock
  return photo ~= nil and reading ~= nil and reading.photo == photo and reading.locked == true
end

-- Switches to Develop for a set or reset that arrived outside it. While Lightroom
-- switches, the user can pick another photo, and the poll can read a lock, so once there
-- this reads the target photo again (PROTOCOL.md, Gestures: the photo the deck worked
-- from). photo is the one the command's earlier checks were made against. Returns nil
-- when the command may go on, or the err code and message to refuse it with. A command
-- that arrives in Develop asks Lightroom nothing more: set runs that way, straight from
-- onMessage, for every dial tick.
local function switchToDevelop(photo)
  if Develop.inDevelop() then
    return nil
  end
  if not Develop.ensureDevelop() then
    return 'noDevelop', 'could not switch to Develop'
  end
  local after = Develop.photoId() or nil
  if after ~= photo then
    return 'stale', 'the target photo changed while Lightroom switched to Develop ('
      .. tostring(photo or 'none') .. ' to ' .. tostring(after or 'none') .. ')'
  end
  if Develop.isLocked(photo) then
    return 'locked', 'photo ' .. photo .. ' was locked by a background process while Lightroom switched to Develop'
  end
  return nil
end

-- Gestures ------------------------------------------------------------------------

-- Ends the open gesture, if any. stopTracking makes it one history step, and the
-- observer then fires, so vals carry the final value. stale is true when it ends because
-- the target photo or module changed: the deck's later sets for it carry values worked
-- out for the old photo, so set refuses them.
function Develop.endGesture(why, stale)
  local g = State.gesture
  if not g then
    return false
  end
  State.gesture = nil
  if stale then
    State.staleG = g.g
  end
  local ok, err = LrTasks.pcall(LrDevelopController.stopTracking)
  if not ok then
    Log.debug('stopTracking failed (%s): %s', tostring(why), tostring(err))
  end
  Log.debug('gesture %s on %s ended: %s', tostring(g.g), tostring(g.p), tostring(why))
  return true
end

-- Ends a gesture with no set for Config.GESTURE_SECS, as if done had arrived. Called
-- from the poll.
function Develop.checkGesture()
  local g = State.gesture
  if g and now() - g.at >= Config.GESTURE_SECS then
    Develop.endGesture('no set for ' .. Config.GESTURE_SECS .. ' s')
  end
end

-- Whether the open gesture started on a photo other than photo, the target the poll
-- just read. A set can arrive after the user changed photo but before the poll noticed:
-- its gesture started on the new photo and carries on. Without the photo it started on,
-- any photo change counts (newPhoto).
function Develop.gestureElsewhere(photo, newPhoto)
  local g = State.gesture
  if not g then
    return false
  end
  if g.photo == nil then
    return newPhoto
  end
  return g.photo ~= photo
end

-- vals and ranges -------------------------------------------------------------------

-- The deck needs every watched range and value after hello and watch, on entering
-- Develop and on every photo change (PROTOCOL.md, Events). This marks them all owed:
-- the next push sends whatever Lightroom can read, and later pushes the rest.
function Develop.owe()
  for p in pairs(State.lastSent) do
    State.lastSent[p] = nil
  end
  for p in pairs(State.rangesOwed) do
    State.rangesOwed[p] = nil
  end
  for _, p in ipairs(State.watched) do
    State.rangesOwed[p] = true
  end
end

-- Sends the watched values the deck doesn't have: those it is owed (no lastSent value)
-- and those that changed since they were last sent, leaving out the param an open
-- gesture tracks. Develop only. At most one push every Config.VALS_SECS, owed ones
-- included; one held back follows when the limit allows (flushing is that push). Values
-- count as sent only once the send succeeded, so a dropped push is diffed again later.
function Develop.pushValues(flushing)
  if #State.watched == 0 or not Develop.inDevelop() then
    return false
  end
  local t = now()
  -- 1 ms of slack, so a push timed for exactly the limit isn't held back again.
  if not flushing and State.lastValsAt and t - State.lastValsAt < Config.VALS_SECS - 0.001 then
    Develop.flushLater()
    return false
  end
  local skip = State.gesture and State.gesture.p
  local vals, n = json.object({}), 0
  for _, p in ipairs(State.watched) do
    if p ~= skip then
      local v = Develop.value(p)
      local last = State.lastSent[p]
      if v ~= nil and (last == nil or math.abs(v - last) > EPSILON) then
        vals[p] = v
        n = n + 1
      end
    end
  end
  if n == 0 then
    return false
  end
  if not Server.send({ t = 'vals', vals = vals }) then
    return false
  end
  for p, v in pairs(vals) do
    State.lastSent[p] = v
  end
  State.lastValsAt = t
  return true
end

-- Sends a push the rate limit held back once the limit allows it.
function Develop.flushLater()
  if State.flushAt then
    return
  end
  local at = (State.lastValsAt or now()) + Config.VALS_SECS
  State.flushAt = at
  local ok = LrTasks.pcall(LrTasks.startAsyncTask, function()
    LrTasks.pcall(function()
      local wait = at - now()
      if wait > 0 then
        LrTasks.sleep(wait)
      end
    end)
    State.flushAt = nil
    LrTasks.pcall(function() require('Develop').pushValues(true) end) -- flushing: the limit allows it now
  end, 'DeckBridge vals')
  if not ok then
    State.flushAt = nil
  end
end

-- Sends the ranges the deck is owed for the watched params, as far as getRange gives
-- them. Develop only. A range counts as sent only once the send succeeded.
function Develop.sendRanges()
  if #State.watched == 0 or next(State.rangesOwed) == nil or not Develop.inDevelop() then
    return false
  end
  local ranges, n = json.object({}), 0
  for _, p in ipairs(State.watched) do
    if State.rangesOwed[p] then
      local lo, hi = Develop.range(p)
      if lo then
        ranges[p] = { lo, hi }
        n = n + 1
      end
    end
  end
  if n == 0 or not Server.send({ t = 'ranges', ranges = ranges }) then
    return false
  end
  for p in pairs(ranges) do
    State.rangesOwed[p] = nil
  end
  return true
end

-- Drops watched params that getRange rejects, with err bad for the watch that sent
-- them. That needs Develop and a photo, so a list sent outside Develop is checked on
-- entering it. Exposure exists for every file type: if even its range fails, Develop
-- isn't ready and nothing is dropped.
function Develop.checkWatch()
  if State.watchChecked or #State.watched == 0 then
    return
  end
  if not Develop.inDevelop() or not Develop.range('Exposure') then
    return
  end
  State.watchChecked = true
  local keep, unknown = {}, {}
  for _, p in ipairs(State.watched) do
    if Develop.range(p) then
      keep[#keep + 1] = p
    else
      unknown[#unknown + 1] = p
      State.rangesOwed[p] = nil
    end
  end
  if #unknown > 0 then
    State.watched = keep
    Proto.err({ t = 'watch', id = State.watchId }, 'bad',
      'unknown param, dropped from the watch list: ' .. table.concat(unknown, ', '))
  end
end

-- In Develop with a target photo: checks the watch list once Develop can tell, then
-- sends the ranges the deck is owed, then the values it is owed or that changed.
function Develop.catchUp()
  Develop.checkWatch()
  Develop.sendRanges()
  Develop.pushValues()
end

-- The observer ------------------------------------------------------------------------

-- Registers the adjustment observer against the long-lived context, once per plugin
-- instance. Must run in Develop. The callback looks Develop up on every call, so a hot
-- reload takes over without registering a second observer, and it runs the handler
-- under LrTasks.pcall, so a broken reload can't throw into Lightroom's callback.
function Develop.ensureObserver()
  if State.observer then
    return true
  end
  if not State.context or not Develop.inDevelop() then
    return false
  end
  local obs = {}
  local ok, err = LrTasks.pcall(LrDevelopController.addAdjustmentChangeObserver, State.context, obs, function()
    local okCall, errCall = LrTasks.pcall(function() require('Develop').onAdjustment(obs) end)
    if not okCall then
      Log.every('observer-callback', 60, 'warn', 'adjustment observer failed: %s', tostring(errCall))
    end
  end)
  if not ok then
    Log.every('observer', 60, 'warn', 'addAdjustmentChangeObserver failed: %s', tostring(err))
    return false
  end
  State.observer = obs
  Log.info('adjustment observer registered')
  return true
end

-- The observer fired. It fires in bursts (73 callbacks for one photo change on 15.3)
-- and doesn't say what changed, so this only makes sure one task is on its way.
function Develop.onAdjustment(obs)
  if obs ~= State.observer then
    return
  end
  State.obsCount = State.obsCount + 1
  if State.obsTask then
    return
  end
  State.obsTask = true
  local ok, err = LrTasks.pcall(LrTasks.startAsyncTask, function()
    State.obsTask = false
    local okRun, errRun = LrTasks.pcall(function() require('Develop').afterAdjustment() end)
    if not okRun then
      Log.every('observer-push', 60, 'warn', 'observer push failed: %s', tostring(errRun))
    end
  end, 'DeckBridge observer')
  if not ok then
    State.obsTask = false
    Log.every('observer-task', 60, 'warn', 'could not start the observer task: %s', tostring(err))
  end
end

-- In a task, after the observer fired. A new photo or module goes through the poll's
-- sync, so the deck gets state, ranges and vals in that order; anything else is a
-- value change, diffed against what was last sent, and a chance to send what the deck
-- is still owed.
function Develop.afterAdjustment()
  local photo = Develop.targetPhoto()
  local id = photo and tostring(photo.localIdentifier) or nil
  if State.lastModule ~= 'develop' or id ~= State.lastPhoto or not Develop.inDevelop() then
    require('Poll').sync()
  elseif id then
    Develop.catchUp()
  end
end

-- Commands ----------------------------------------------------------------------------

-- watch {ps}: replaces the watch list. In Develop, answers ranges and every value.
function Develop.watch(m)
  local ps = m.ps
  if type(ps) ~= 'table' or (#ps == 0 and next(ps) ~= nil) then
    return Proto.err(m, 'bad', 'watch needs ps, a list of param names')
  end
  local list, seen, wrong = {}, {}, 0
  for _, p in ipairs(ps) do
    if type(p) == 'string' and p ~= '' then
      if not seen[p] then
        seen[p] = true
        list[#list + 1] = p
      end
    else
      wrong = wrong + 1
    end
  end
  State.watched = list
  State.watchChecked = false
  State.watchId = Proto.id(m)
  Develop.owe()
  if wrong > 0 then
    Proto.err(m, 'bad', wrong .. ' entries in ps are not param names, dropped')
  end
  if Develop.inDevelop() then
    Develop.catchUp()
  end
end

-- set {p, v, g, ph}: guarded. Clamps v to getRange(p), sets it inside gesture g, and
-- acks with the value read straight back. Refused with err stale: a set for a gesture
-- that ended when the photo or module changed, and one whose ph isn't the target photo,
-- which makes its g stale too. Refused with err locked on a locked photo. Those refusals
-- change nothing, not even the module. A set that had to switch to Develop is checked
-- again once there: another target photo is stale, with or without ph, and makes its g
-- stale too, and a lock the poll read meanwhile is locked; only the module has changed
-- (PROTOCOL.md, Guard, has the order of checks). Runs straight from onMessage in
-- Develop, so it reads nothing that needs a task.
function Develop.set(m)
  local p, v, g = m.p, m.v, m.g
  if type(p) ~= 'string' or p == '' then
    return Proto.err(m, 'bad', 'set needs p, a param name')
  end
  if not Proto.isNumber(v) then
    return Proto.err(m, 'bad', 'set needs v, a number')
  end
  if not Proto.isNumber(g) then
    return Proto.err(m, 'bad', 'set needs g, the gesture number')
  end
  if badPh(m) then
    return Proto.err(m, 'bad', 'ph must be a string, the photo id from state')
  end
  if not Guard.check(m) then
    return
  end
  local photo = Develop.photoId() or nil
  local open = State.gesture
  if open and open.g == g and photo and open.photo and open.photo ~= photo then
    Develop.endGesture('the photo changed', true) -- before the poll noticed
    open = nil
  end
  if g == State.staleG then
    return Proto.err(m, 'stale', 'gesture ' .. tostring(g) .. ' ended when the photo or module changed')
  end
  if wrongPhoto(m, photo) then
    -- The deck worked out this gesture from another photo's values, so its later sets
    -- are refused too. An open gesture is left alone: this set changes nothing.
    State.staleG = g
    return Proto.err(m, 'stale', 'ph ' .. m.ph .. " isn't the target photo (" .. tostring(photo or 'none') .. ')')
  end
  if Develop.isLocked(photo) then
    return Proto.err(m, 'locked', 'photo ' .. photo .. ' is locked by a background process')
  end
  local code, msg = switchToDevelop(photo)
  if code == 'stale' then
    -- Worked out from the photo the deck saw, as with a wrong ph: its later sets are
    -- refused too, and an open gesture is left alone.
    State.staleG = g
  end
  if code then
    return Proto.err(m, code, msg)
  end
  local lo, hi = Develop.range(p)
  if not lo then
    return rangeFailed(m, p)
  end
  if open and (open.p ~= p or open.g ~= g) then
    Develop.endGesture('next gesture')
    open = nil
  end
  if not open then
    LrDevelopController.startTracking(p)
    open = { p = p, g = g, photo = photo }
    State.gesture = open
    State.staleG = nil -- the deck has moved on to a new gesture
  end
  open.at = now()
  if v < lo then
    v = lo
  elseif v > hi then
    v = hi
  end
  LrDevelopController.setValue(p, v)
  Server.send({ t = 'ack', p = p, v = Develop.value(p) or json.null, g = g })
end

-- done {g}: ends the gesture. A done for an earlier gesture than the open one is late,
-- and ignored.
function Develop.done(m)
  if m.g ~= nil and not Proto.isNumber(m.g) then
    return Proto.err(m, 'bad', 'g must be a number')
  end
  local open = State.gesture
  if not open or (m.g ~= nil and m.g ~= open.g) then
    return
  end
  Develop.endGesture('done')
end

-- reset {p, ph}: guarded. Ends any gesture, resets p and acks the value after, without
-- g. A ph that isn't the target photo gets err stale, and a locked photo err locked; each
-- refusal changes nothing, not even the module or an open gesture. A reset that had to
-- switch to Develop is checked again once there, as set is: another target photo is
-- stale, with or without ph, and a lock the poll read meanwhile is locked. Those change
-- nothing but the module.
function Develop.reset(m)
  local p = m.p
  if type(p) ~= 'string' or p == '' then
    return Proto.err(m, 'bad', 'reset needs p, a param name')
  end
  if badPh(m) then
    return Proto.err(m, 'bad', 'ph must be a string, the photo id from state')
  end
  if not Guard.check(m) then
    return
  end
  local photo = Develop.photoId() or nil
  if wrongPhoto(m, photo) then
    return Proto.err(m, 'stale', 'ph ' .. m.ph .. " isn't the target photo (" .. tostring(photo or 'none') .. ')')
  end
  if Develop.isLocked(photo) then
    return Proto.err(m, 'locked', 'photo ' .. photo .. ' is locked by a background process')
  end
  local code, msg = switchToDevelop(photo)
  if code then
    return Proto.err(m, code, msg)
  end
  if not Develop.range(p) then
    return rangeFailed(m, p)
  end
  Develop.endGesture('reset')
  LrDevelopController.resetToDefault(p)
  Server.send({ t = 'ack', p = p, v = Develop.value(p) or json.null })
end

return Develop
