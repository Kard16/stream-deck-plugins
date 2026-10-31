-- The 200 ms state poll. Lightroom has no selection, module, flag or rating events,
-- so this reads them and sends `state` when anything changed. It also keeps the
-- adjustment observer registered while in Develop.
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

local Poll = {
  extraTick = nil, -- optional function run at the end of every tick
}

local FIELDS = { 'module', 'photo', 'file', 'flag', 'rating', 'label', 'sel' }

local lastSentState = nil
local lastModule, lastPhoto = nil, nil
local ticks = 0

function Poll.readState()
  local st = { module = LrApplicationView.getCurrentModuleName(), flag = 0, rating = 0, label = 'none', sel = 0 }
  local catalog = LrApplication.activeCatalog()
  local photo = catalog:getTargetPhoto()
  if photo then
    st.photo = tostring(photo.localIdentifier)
    st.file = photo:getFormattedMetadata('fileName')
    st.flag = tonumber(photo:getRawMetadata('pickStatus')) or 0
    st.rating = tonumber(photo:getRawMetadata('rating')) or 0
    local label = photo:getRawMetadata('colorNameForLabel')
    if type(label) ~= 'string' or label == '' then
      label = 'none'
    end
    st.label = label
  end
  local targets = catalog:getTargetPhotos()
  st.sel = type(targets) == 'table' and #targets or 0
  return st
end

local function differs(a, b)
  if not (a and b) then
    return true
  end
  for _, k in ipairs(FIELDS) do
    if a[k] ~= b[k] then
      return true
    end
  end
  return false
end

local function stateMessage(st)
  return {
    t = 'state',
    module = st.module or json.null,
    photo = st.photo or json.null,
    file = st.file or json.null,
    flag = st.flag,
    rating = st.rating,
    label = st.label,
    sel = st.sel,
    lt = LrDate.currentTime(),
  }
end

-- Sends `state` if it changed, or always when forced. Returns the state read.
function Poll.sendState(force)
  local ok, st = LrTasks.pcall(Poll.readState)
  if not ok then
    Log.warn('state read failed: %s', tostring(st))
    return nil
  end
  if force or differs(st, lastSentState) then
    Server.send(stateMessage(st))
    lastSentState = st
  end
  return st
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

function Poll.tick()
  ticks = ticks + 1
  Server.tick()

  local st = Poll.sendState(false)
  if st then
    if st.module == 'develop' and st.photo then
      if not State.observer then
        Develop.ensureObserver(false)
      elseif lastModule ~= nil and lastModule ~= 'develop' then
        -- Back in Develop: watch for the observer having gone quiet (Develop.checkObserver).
        State.observerSuspect = true
        State.lastSetAt = nil
      end
      if st.photo ~= lastPhoto or lastModule ~= 'develop' then
        Develop.pushValues(true)
      end
    end
    lastModule, lastPhoto = st.module, st.photo
  end

  Develop.checkObserver()
  Develop.flushPending()
  if ticks % 5 == 0 then
    Poll.checkInstance()
  end
  if Poll.extraTick then
    local ok, err = LrTasks.pcall(Poll.extraTick)
    if not ok then
      Log.warn('extra tick failed: %s', tostring(err))
    end
  end
end

return Poll
