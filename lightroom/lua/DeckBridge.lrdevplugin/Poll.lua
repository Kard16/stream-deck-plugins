-- The 200 ms poll. Lightroom has no events for the module, the target photo, flags,
-- ratings, labels or locks, so this reads them and sends state when something changed.
-- On entering Develop or a new photo it sends ranges and every watched value, retrying
-- any Lightroom couldn't read yet; otherwise, in Develop, it polls the watched values for
-- edits the observer didn't report. It also ends gestures that went quiet, and stops
-- this instance if a newer one started.
--
-- Reloadable: all state lives in State.lua, and nothing runs at load time.
local LrApplication = import 'LrApplication'
local LrApplicationView = import 'LrApplicationView'
local LrDate = import 'LrDate'
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Develop = require 'Develop'
local Presets = require 'Presets'

local Poll = {}

Poll.FIELDS = { 'module', 'photo', 'file', 'flag', 'rating', 'label', 'sel', 'locked' }

local LABELS = { red = true, yellow = true, green = true, blue = true, purple = true }

-- colorNameForLabel says "gray" for an unlabelled photo on 15.3 (spike run 2), and may
-- say "" or nil.
function Poll.label(name)
  if type(name) == 'string' then
    local lower = string.lower(name)
    if LABELS[lower] then
      return lower
    end
  end
  return 'none'
end

-- Photo metadata reads fail outside a task on 15.3, so this must run in one. That also
-- keeps isAvailableForEditing out of onMessage, as PROTOCOL.md asks.
function Poll.readState()
  local catalog = LrApplication.activeCatalog()
  local st = {
    module = LrApplicationView.getCurrentModuleName() or 'unknown',
    flag = 0,
    rating = 0,
    label = 'none',
    sel = 0, -- with no target photo, commands act on nothing
    locked = false,
  }
  local photo = catalog:getTargetPhoto()
  if photo then
    st.photo = tostring(photo.localIdentifier)
    st.file = photo:getFormattedMetadata('fileName')
    st.flag = tonumber(photo:getRawMetadata('pickStatus')) or 0
    st.rating = tonumber(photo:getRawMetadata('rating')) or 0
    st.label = Poll.label(photo:getRawMetadata('colorNameForLabel'))
    local targets = catalog:getTargetPhotos()
    st.sel = type(targets) == 'table' and #targets or 1
    -- A background AI process such as Denoise holds the photo it works on. Without
    -- isAvailableForEditing, no photo is locked.
    st.locked = not Presets.available(photo)
  end
  return st
end

local function differs(a, b)
  if not (a and b) then
    return true
  end
  for _, k in ipairs(Poll.FIELDS) do
    if a[k] ~= b[k] then
      return true
    end
  end
  return false
end

function Poll.stateMessage(st)
  return {
    t = 'state',
    module = st.module,
    photo = st.photo or json.null,
    file = st.file or json.null,
    flag = st.flag,
    rating = st.rating,
    label = st.label,
    sel = st.sel,
    locked = st.locked,
  }
end

-- Reads the state and tells the deck what changed, in this order:
-- * state, when a field changed, or always with opts.state;
-- * in Develop with a target photo: the ranges the deck is owed, then the values it is
--   owed or that changed. Entering Develop, a new photo and opts.vals owe it every
--   watched range and value (Develop.owe); what Lightroom can't read yet, say while
--   Develop is still loading the photo, goes out on a later sync.
-- Leaving Develop, or a photo other than the one an open gesture started on, ends that
-- gesture first. Must run in a task.
function Poll.sync(opts)
  opts = opts or {}
  local ok, st = LrTasks.pcall(Poll.readState)
  if not ok then
    Log.every('state', 60, 'warn', 'state read failed: %s', tostring(st))
    return nil
  end
  -- set and reset go by this reading, but only for the photo it was read for.
  State.lockReading = { photo = st.photo, locked = st.locked }
  local inDevelop = st.module == 'develop'
  local entered = inDevelop and State.lastModule ~= 'develop'
  local left = State.lastModule == 'develop' and not inDevelop
  local newPhoto = st.photo ~= State.lastPhoto
  State.lastModule, State.lastPhoto = st.module, st.photo
  if left or Develop.gestureElsewhere(st.photo, newPhoto) then
    Develop.endGesture(left and 'left Develop' or 'new photo', true)
  end
  if opts.vals or entered or newPhoto then
    Develop.owe()
  end
  -- Only a state that went out counts as sent; a dropped one goes again next time.
  if (opts.state or differs(st, State.lastState)) and Server.send(Poll.stateMessage(st)) then
    State.lastState = st
  end
  if inDevelop and st.photo then
    Develop.ensureObserver()
    Develop.catchUp()
  end
  return st
end

function Poll.tick()
  State.ticks = State.ticks + 1
  Server.tick()
  Develop.checkGesture()
  if State.flushAt and LrDate.currentTime() - State.flushAt > 1 then
    State.flushAt = nil -- its task never ran; let the next push schedule another
  end
  Poll.sync()
  if State.ticks % 5 == 0 then
    Poll.checkInstance()
  end
end

-- Instance file: each load writes its id here, and Shutdown writes a marker. A running
-- loop that sees another id, or a marker newer than itself, stops. This covers the case
-- where Shutdown.lua doesn't share module state with Init's task.
function Poll.instPath()
  return LrPathUtils.child(LrPathUtils.getStandardFilePath('temp'), 'deckbridge-inst')
end

local function writeInst(text)
  local ok, err = LrTasks.pcall(function()
    local f = io.open(Poll.instPath(), 'w')
    if f then
      f:write(text)
      f:close()
    end
  end)
  if not ok then
    Log.warn('could not write the instance file: %s', tostring(err))
  end
end

function Poll.start()
  writeInst(State.inst)
end

function Poll.markShutdown()
  writeInst(string.format('shutdown %.3f', LrDate.currentTime()))
end

function Poll.checkInstance()
  local ok, content = LrTasks.pcall(LrFileUtils.readFile, Poll.instPath())
  if not ok or type(content) ~= 'string' or content == '' or content == State.inst then
    return
  end
  local when = tonumber(string.match(content, '^shutdown (%S+)$') or '')
  if string.match(content, '^shutdown ') then
    if when and State.startedAt and when >= State.startedAt then
      Log.info('instance %s: shutdown marker found; stopping', tostring(State.inst))
      State.running = false
    end
    return -- an older instance's marker
  end
  Log.warn('instance %s: newer instance %s is running; stopping', tostring(State.inst), content)
  State.running = false
end

return Poll
