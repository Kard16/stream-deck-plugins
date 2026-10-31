-- Spike-only probes for Phase 1 (S2, S3, S5), plus the probe, reload, select and bezel
-- commands from spikes/protocol-v0.md. Track A deletes this file and the other Spike*.lua.
--
-- Every probe runs in its own async task, so it can sleep, and answers with `result`.
-- Probes report what they find instead of throwing where they can, and put back what
-- they changed: masks, flags, the selected photo, Exposure.
local LrApplication = import 'LrApplication'
local LrApplicationView = import 'LrApplicationView'
local LrDate = import 'LrDate'
local LrDevelopController = import 'LrDevelopController'
local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrSelection = import 'LrSelection'
local LrTasks = import 'LrTasks'
local LrUndo = import 'LrUndo'

local json = require 'json'
local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Guard = require 'Guard'
local Develop = require 'Develop'
local Poll = require 'Poll'
local Core = require 'Core'

local Spike = {}

local now = LrDate.currentTime

local function catalog()
  return LrApplication.activeCatalog()
end

local function photoId(photo)
  return photo and tostring(photo.localIdentifier) or nil
end

local function targetId()
  return photoId(catalog():getTargetPhoto())
end

-- Turns any value into something json.encode accepts.
local function plain(v, depth)
  depth = depth or 0
  local tv = type(v)
  if tv == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then
      return tostring(v)
    end
    return v
  end
  if tv == 'string' or tv == 'boolean' then
    return v
  end
  if tv == 'nil' then
    return json.null
  end
  if tv ~= 'table' then
    return tostring(v)
  end
  if v == json.null then
    return v
  end
  if depth > 4 then
    return '<too deep>'
  end
  local n, maxIndex, isArray = 0, 0, true
  for k in pairs(v) do
    n = n + 1
    if type(k) ~= 'number' or k < 1 or math.floor(k) ~= k then
      isArray = false
    elseif k > maxIndex then
      maxIndex = k
    end
  end
  if n == 0 then
    return {}
  end
  if isArray and maxIndex == n then
    local out = {}
    for i = 1, n do
      out[i] = plain(v[i], depth + 1)
    end
    return out
  end
  local out, count = json.object({}), 0
  for k, val in pairs(v) do
    count = count + 1
    if count > 60 then
      out['...'] = 'truncated'
      break
    end
    out[tostring(k)] = plain(val, depth + 1)
  end
  return out
end
Spike.plain = plain

-- Is `get()` non-nil, without letting an undeclared global or missing field throw?
local function has(get)
  local ok, v = LrTasks.pcall(get)
  return ok and v ~= nil
end

-- Sorted function names in an SDK module, if pairs() works on it.
local function names(mod)
  local ok, list = LrTasks.pcall(function()
    local out = {}
    for k in pairs(mod) do
      if type(k) == 'string' then
        out[#out + 1] = k
      end
    end
    table.sort(out)
    return out
  end)
  if ok then
    return list
  end
  return json.object({ error = tostring(list) })
end

local function needDevelop()
  if not Develop.ensureDevelop() then
    error('could not switch to Develop')
  end
end

local function needPhoto()
  local photo = catalog():getTargetPhoto()
  if not photo then
    error('no target photo')
  end
  return photo
end

local function sleep(s)
  LrTasks.sleep(s)
end

local P = {}

function P.features()
  local d = json.object({})
  d.lr = Core.lrVersion()
  d.setEnhance = has(function() return LrDevelopController.setEnhance end)
  d.getEnhancePanelState = has(function() return LrDevelopController.getEnhancePanelState end)
  d.changeDenoiseAmount = has(function() return LrDevelopController.changeDenoiseAmount end)
  d.createNewMask = has(function() return LrDevelopController.createNewMask end)
  d.shutdown = has(function() return LrApplication.shutdown end)
  d.addActivePhotoChangeObserver = has(function() return LrApplication.addActivePhotoChangeObserver end)
  d.addHapticObserver = has(function() return LrApplication.addHapticObserver end)
  d.removeFromCatalog = has(function() return LrSelection.removeFromCatalog end)
  d.getPhotosAvailableForEditing = has(function() return catalog().getPhotosAvailableForEditing end)
  d.showBezel = has(function() return LrDialogs.showBezel end)

  local photo = catalog():getTargetPhoto()
  if photo then
    d.isAvailableForEditing = has(function() return photo.isAvailableForEditing end)
    local ok, available = LrTasks.pcall(function() return photo:isAvailableForEditing() end)
    if ok then
      d.photoAvailableForEditing = plain(available)
    else
      d.photoAvailableForEditing = 'error: ' .. tostring(available)
    end
  end

  -- The sandbox: which loaders exist, and is require LrC's own?
  d.loadstring = has(function() return loadstring end)
  d.loadfile = has(function() return loadfile end)
  d.dofile = has(function() return dofile end)
  d.package = has(function() return package end)
  d.setfenv = has(function() return setfenv end)
  d.debugGetinfo = has(function() return debug.getinfo end)
  d.requireType = type(require)
  local okInfo, info = LrTasks.pcall(function() return debug.getinfo(require, 'S') end)
  if okInfo and type(info) == 'table' then
    d.requireWhat = plain(info.what)
    d.requireSource = plain(info.source)
  end
  d.requireLooksLrC = not d.package -- plain Lua's require comes with the package library

  d.canYieldInProbe = Log.canYield()
  d.canYieldOnMessage = plain(State.cyOnMessage)
  d.observerRegistered = State.observer ~= nil
  d.obsCount = State.obsCount
  d.triggerRoutes = plain(State.triggerLog)
  d.server = json.object({ sent = Server.sent, drops = Server.drops, senderRecreated = Server.senderRecreated, recvGen = State.recvGen, sendGen = State.sendGen })

  d.functions = json.object({
    LrDevelopController = names(LrDevelopController),
    LrApplicationView = names(LrApplicationView),
    LrSelection = names(LrSelection),
    LrApplication = names(LrApplication),
  })
  return d
end

-- getRange/getValue for one param, trying the 2012-suffixed name if the plain one fails.
local function rangeOf(p)
  local errs = {}
  for _, name in ipairs({ p, p .. '2012' }) do
    local ok, lo, hi = LrTasks.pcall(LrDevelopController.getRange, name)
    if ok and type(lo) == 'number' and type(hi) == 'number' then
      local okValue, v = LrTasks.pcall(LrDevelopController.getValue, name)
      return json.object({ name = name, min = lo, max = hi, v = okValue and plain(v) or json.null })
    end
    errs[#errs + 1] = name .. ': ' .. (ok and 'no range' or tostring(lo))
  end
  return json.object({ err = table.concat(errs, '; ') })
end

function P.ranges()
  needDevelop()
  local photo = needPhoto()
  local params = json.object({})
  for _, p in ipairs(Config.BANK_PARAMS) do
    params[p] = rangeOf(p)
  end
  return json.object({
    file = plain(photo:getFormattedMetadata('fileName')),
    format = plain(photo:getRawMetadata('fileFormat')),
    params = params,
  })
end

-- Nudges Exposure by 0.01 and back as one tracked gesture; returns observer callbacks seen.
local function nudgeCallbacks()
  local ok, v = LrTasks.pcall(LrDevelopController.getValue, 'Exposure')
  if not ok or type(v) ~= 'number' then
    error('getValue(Exposure) failed: ' .. tostring(v))
  end
  local delta = 0.01
  if v > 4.9 then
    delta = -0.01
  end
  local before = State.obsCount
  LrDevelopController.startTracking('Exposure')
  LrDevelopController.setValue('Exposure', v + delta)
  sleep(0.6)
  LrDevelopController.setValue('Exposure', v)
  sleep(0.6)
  LrDevelopController.stopTracking()
  State.tracked = nil
  sleep(0.3)
  return State.obsCount - before
end

function P.observerPhotoChange()
  needDevelop()
  needPhoto()
  if not State.observer then
    Develop.ensureObserver(false)
  end
  local d = json.object({ observerRegistered = State.observer ~= nil })

  -- Part 1: does the observer fire when the photo changes?
  local id0 = targetId()
  local c0 = State.obsCount
  local direction = 'next'
  LrSelection.nextPhoto()
  sleep(1.5)
  if targetId() == id0 then -- last photo: try the other way
    direction = 'previous'
    LrSelection.previousPhoto()
    sleep(1.5)
  end
  d.direction = direction
  d.photoChanged = targetId() ~= id0
  d.callbacksOnPhotoChange = State.obsCount - c0
  d.firesOnPhotoChange = d.callbacksOnPhotoChange > 0
  if d.photoChanged then
    if direction == 'next' then
      LrSelection.previousPhoto()
    else
      LrSelection.nextPhoto()
    end
    sleep(1.0)
  end
  d.backOnOriginal = targetId() == id0

  -- Part 2: does it still fire after leaving Develop and coming back? Needs writes.
  local ok, why = Guard.writable()
  if not ok then
    d.roundTrip = 'skipped: ' .. why
    return d
  end
  LrApplicationView.switchToModule('library')
  sleep(1.0)
  needDevelop()
  sleep(1.0)
  d.callbacksAfterRoundTrip = nudgeCallbacks()
  d.firesAfterRoundTrip = d.callbacksAfterRoundTrip > 0
  if not d.firesAfterRoundTrip then
    Develop.ensureObserver(true)
    d.callbacksAfterReregister = nudgeCallbacks()
    d.reregisterFixes = d.callbacksAfterReregister > 0
  end
  return d
end

local function countMasks()
  local ok, masks = LrTasks.pcall(LrDevelopController.getAllMasks)
  if not ok then
    return -1, 'error: ' .. tostring(masks)
  end
  if type(masks) ~= 'table' then
    return -1, masks
  end
  local n = 0
  for _ in pairs(masks) do
    n = n + 1
  end
  return n, masks
end

function P.mask()
  needDevelop()
  needPhoto()
  local d = json.object({})
  local nBefore, before = countMasks()
  d.nBefore = nBefore
  d.masksBefore = plain(before)

  local okGo, errGo = LrTasks.pcall(LrDevelopController.goToMasking)
  d.goToMasking = okGo or tostring(errGo)
  sleep(0.5)
  local t0 = now()
  local okNew, errNew = LrTasks.pcall(LrDevelopController.createNewMask, 'aiSelection', 'subject')
  d.createNewMask = okNew or tostring(errNew)
  local nAfter, after = nBefore, nil
  repeat
    sleep(0.25)
    nAfter, after = countMasks()
  until nAfter > nBefore or now() - t0 > 15
  d.nAfter = nAfter
  d.created = nAfter > nBefore
  d.createSecs = now() - t0
  d.masksAfter = plain(after)
  local okSel, selected = LrTasks.pcall(LrDevelopController.getSelectedMask)
  if okSel then
    d.selectedMask = plain(selected)
  else
    d.selectedMask = 'error: ' .. tostring(selected)
  end

  if d.created then
    local cleaned = false
    if okSel and selected ~= nil then
      local okDel, errDel = LrTasks.pcall(LrDevelopController.deleteMask, selected)
      d.deleteMask = okDel or tostring(errDel)
      sleep(0.5)
      cleaned = countMasks() <= nBefore
    end
    if not cleaned then
      local okUndo, errUndo = LrTasks.pcall(LrUndo.undo)
      d.undo = okUndo or tostring(errUndo)
      sleep(0.5)
      cleaned = countMasks() <= nBefore
    end
    d.cleaned = cleaned
  end
  local okTool, errTool = LrTasks.pcall(LrDevelopController.selectTool, 'loupe')
  d.backToLoupe = okTool or tostring(errTool)
  return d
end

function P.beforeAfter(args)
  needDevelop()
  local secs = tonumber(args.secs) or 2
  local d = json.object({ secs = secs })
  local okBefore, errBefore = LrTasks.pcall(LrApplicationView.showView, 'develop_before')
  d.before = okBefore or tostring(errBefore)
  sleep(secs)
  local okAfter, errAfter = LrTasks.pcall(LrApplicationView.showView, 'develop_loupe')
  d.after = okAfter or tostring(errAfter)
  return d
end

function P.presets()
  local t0 = now()
  local d = json.object({ folders = 0, presets = 0 })
  local items = {}
  for _, folder in ipairs(LrApplication.developPresetFolders() or {}) do
    d.folders = d.folders + 1
    local folderName = folder:getName()
    for _, preset in ipairs(folder:getDevelopPresets() or {}) do
      d.presets = d.presets + 1
      if #items < 50 then
        items[#items + 1] = json.object({ folder = plain(folderName), name = plain(preset:getName()), uuid = plain(preset:getUuid()) })
      end
    end
  end
  d.items = items
  d.listMs = (now() - t0) * 1000
  return d
end

local function bench(fn)
  local ok, r = LrTasks.pcall(function()
    local t0, maxMs = now(), 0
    for _ = 1, 20 do
      local t1 = now()
      fn()
      local dt = (now() - t1) * 1000
      if dt > maxMs then
        maxMs = dt
      end
    end
    return json.object({ avgMs = (now() - t0) * 1000 / 20, maxMs = maxMs })
  end)
  if ok then
    return r
  end
  return 'error: ' .. tostring(r)
end

function P.timing()
  local cat = catalog()
  local photo = cat:getTargetPhoto()
  local d = json.object({})
  d.statePoll = bench(function() Poll.readState() end)
  d.getTargetPhoto = bench(function() cat:getTargetPhoto() end)
  d.getTargetPhotos = bench(function() cat:getTargetPhotos() end)
  d.getCurrentModuleName = bench(function() LrApplicationView.getCurrentModuleName() end)
  d.selectionGetters = bench(function()
    LrSelection.getFlag()
    LrSelection.getRating()
    LrSelection.getColorLabel()
  end)
  if photo then
    d.rawMetadata = bench(function()
      photo:getRawMetadata('pickStatus')
      photo:getRawMetadata('rating')
      photo:getRawMetadata('colorNameForLabel')
    end)
  end
  if Develop.inDevelop() then
    d.getValue = bench(function() LrDevelopController.getValue('Exposure') end)
  end
  local targets = cat:getTargetPhotos()
  d.sel = type(targets) == 'table' and #targets or 0
  return d
end

local function restoreFlag(flag)
  if flag == 1 then
    LrSelection.flagAsPick()
  elseif flag == -1 then
    LrSelection.flagAsReject()
  else
    LrSelection.removeFlag()
  end
end

function P.flagAdvance()
  local cat = catalog()
  local photo0 = needPhoto()
  local id0 = photoId(photo0)
  local d = json.object({})
  local targets = cat:getTargetPhotos() or {}
  if #targets > 1 then -- flags apply to the whole selection in Grid; test on one photo
    cat:setSelectedPhotos(photo0, {})
    sleep(0.3)
    d.narrowedSelectionFrom = #targets
  end
  local flag0 = tonumber(photo0:getRawMetadata('pickStatus')) or 0
  d.flagBefore = flag0
  LrSelection.flagAsPick()
  sleep(0.4)
  d.flagAfterPick = plain(photo0:getRawMetadata('pickStatus'))
  d.advanced = targetId() ~= id0 -- Lightroom's Auto Advance moved on
  if d.advanced then
    cat:setSelectedPhotos(photo0, {})
    sleep(0.4)
  end
  restoreFlag(flag0)
  sleep(0.4)
  d.advancedOnRestore = targetId() ~= id0
  if d.advancedOnRestore then
    cat:setSelectedPhotos(photo0, {})
    sleep(0.4)
  end
  d.flagRestored = (tonumber(photo0:getRawMetadata('pickStatus')) or 0) == flag0
  d.backOnOriginal = targetId() == id0
  return d
end

function P.autoSync()
  local cat = catalog()
  local active = cat:getTargetPhoto()
  local photos = cat:getTargetPhotos() or {}
  if not active or #photos < 2 then
    error('select 2 or more photos first (' .. #photos .. ' selected)')
  end
  needDevelop()
  local activeId = photoId(active)
  local function readAll()
    local out = {}
    for _, photo in ipairs(photos) do
      local ok, s = LrTasks.pcall(function() return photo:getDevelopSettings() end)
      local v = ok and type(s) == 'table' and s.Exposure2012 or nil
      out[photoId(photo)] = tonumber(v) or 0 -- unedited photos may omit Exposure2012
    end
    return out
  end

  local d = json.object({ active = activeId, count = #photos })
  local before = readAll()
  local v0 = LrDevelopController.getValue('Exposure')
  LrDevelopController.startTracking('Exposure')
  LrDevelopController.setValue('Exposure', v0 + 0.5)
  sleep(2)
  LrDevelopController.stopTracking()
  State.tracked = nil
  sleep(1)
  local after = readAll()
  local changed = {}
  for id, b in pairs(before) do
    if id ~= activeId and math.abs((after[id] or 0) - b) > 0.05 then
      changed[#changed + 1] = id
    end
  end
  d.before = plain(before)
  d.after = plain(after)
  d.othersChanged = changed
  d.autoSyncCarriesSetValue = #changed > 0

  LrDevelopController.startTracking('Exposure')
  LrDevelopController.setValue('Exposure', v0)
  sleep(1)
  LrDevelopController.stopTracking()
  State.tracked = nil
  sleep(1)
  d.restored = plain(readAll())
  return d
end

function P.requireVersion()
  local m = require 'SpikeVersion'
  return json.object({ v = plain(m.v), importOk = plain(m.importOk), requireOk = plain(m.requireOk), inst = State.inst })
end

-- S3: re-read SpikeVersion.lua and run it fresh, without touching the require cache.
-- First plainly; if that fails, again with import and require passed in as arguments,
-- in case loadstring'd chunks can't see the plugin's environment.
function Spike.reloadVersion()
  local path = LrPathUtils.child(_PLUGIN.path, 'SpikeVersion.lua')
  local src = LrFileUtils.readFile(path)
  if type(src) ~= 'string' then
    error('could not read ' .. path)
  end
  local d = json.object({})
  local okLs, ls = LrTasks.pcall(function() return loadstring end)
  local compile = nil
  if okLs and type(ls) == 'function' then
    compile = function(text) return ls(text, '=SpikeVersion') end
    d.via = 'loadstring'
  else
    local okLf, lf = LrTasks.pcall(function() return loadfile end)
    if okLf and type(lf) == 'function' then
      compile = function() return lf(path) end
      d.via = 'loadfile'
    end
  end
  if not compile then
    local okDf, df = LrTasks.pcall(function() return dofile end)
    if okDf and type(df) == 'function' then
      local okRun, mod = LrTasks.pcall(df, path)
      if okRun and type(mod) == 'table' then
        d.via, d.v, d.importOk, d.requireOk = 'dofile', plain(mod.v), plain(mod.importOk), plain(mod.requireOk)
        return d
      end
      error('dofile failed: ' .. tostring(mod))
    end
    error('no loadstring, loadfile or dofile')
  end

  local chunk, errCompile = compile(src)
  if not chunk then
    error(d.via .. ' failed to compile: ' .. tostring(errCompile))
  end
  local okRun, mod = LrTasks.pcall(chunk)
  if not (okRun and type(mod) == 'table') then
    d.plainRunErr = tostring(mod)
    if d.via ~= 'loadstring' then
      error(d.via .. ' chunk failed: ' .. d.plainRunErr)
    end
    local injected = ls('local import, require = ...\n' .. src, '=SpikeVersion')
    okRun, mod = LrTasks.pcall(injected, import, require)
    if not (okRun and type(mod) == 'table') then
      error('loadstring chunk failed plainly (' .. d.plainRunErr .. ') and with import/require passed in (' .. tostring(mod) .. ')')
    end
    d.via = 'loadstring+inject'
  end
  d.v, d.importOk, d.requireOk = plain(mod.v), plain(mod.importOk), plain(mod.requireOk)
  return d
end

local function metadataFor(cat, photos, keys)
  local ok, res = LrTasks.pcall(function() return cat:batchGetRawMetadata(photos, keys) end)
  if ok and type(res) == 'table' then
    return res
  end
  local out = {}
  for _, photo in ipairs(photos) do
    local md = {}
    for _, k in ipairs(keys) do
      local okKey, v = LrTasks.pcall(function() return photo:getRawMetadata(k) end)
      if okKey then
        md[k] = v
      end
    end
    out[photo] = md
  end
  return out
end

-- select: largestRaw (falls back to the largest of any format), largestAny, or index n (1-based).
function Spike.selectPhoto(_, m)
  local what = m.what or 'largestRaw'
  local cat = catalog()
  local all = cat:getAllPhotos() or {}
  if #all == 0 then
    error('the catalog has no photos')
  end
  local chosen, fellBack
  if what == 'index' then
    local n = tonumber(m.n) or 1
    chosen = all[n]
    if not chosen then
      error('no photo at index ' .. n .. ' (the catalog has ' .. #all .. ')')
    end
  elseif what == 'largestRaw' or what == 'largestAny' then
    local meta = metadataFor(cat, all, { 'fileSize', 'fileFormat' })
    local bestAny, bestRaw, sizeAny, sizeRaw = nil, nil, -1, -1
    for _, photo in ipairs(all) do
      local md = meta[photo] or {}
      local size = tonumber(md.fileSize) or 0
      if size > sizeAny then
        bestAny, sizeAny = photo, size
      end
      if (md.fileFormat == 'RAW' or md.fileFormat == 'DNG') and size > sizeRaw then
        bestRaw, sizeRaw = photo, size
      end
    end
    if what == 'largestRaw' then
      chosen = bestRaw or bestAny
      fellBack = bestRaw == nil
    else
      chosen = bestAny
    end
  else
    error('select what must be largestRaw, largestAny or index')
  end
  cat:setSelectedPhotos(chosen, {})
  sleep(0.3)
  return json.object({
    photo = photoId(chosen),
    file = plain(chosen:getFormattedMetadata('fileName')),
    format = plain(chosen:getRawMetadata('fileFormat')),
    size = plain(chosen:getRawMetadata('fileSize')),
    dims = plain(chosen:getRawMetadata('dimensions')),
    count = #all,
    fellBack = fellBack or nil,
    selected = targetId() == photoId(chosen),
  })
end

local GUARDED = { mask = true, flagAdvance = true, autoSync = true }

local function startProbe(m, name, fn)
  LrTasks.startAsyncTask(function()
    local t0 = now()
    local ok, data = LrTasks.pcall(fn, type(m.args) == 'table' and m.args or {}, m)
    local ms = (now() - t0) * 1000
    if ok then
      Log.info('%s done in %.0f ms', name, ms)
      Server.send({ t = 'result', id = m.id, name = name, ok = true, ms = ms, data = data == nil and json.object({}) or data })
    else
      Log.warn('%s failed after %.0f ms: %s', name, ms, tostring(data))
      Server.send({ t = 'result', id = m.id, name = name, ok = false, ms = ms, msg = tostring(data) })
    end
  end, 'DeckBridge ' .. name)
end

Spike.probes = P

Spike.handlers = {
  probe = {
    immediate = true,
    fn = function(m)
      local name = m.name
      local fn = type(name) == 'string' and P[name] or nil
      if not fn then
        Server.send({ t = 'err', id = m.id, msg = 'unknown probe', cmd = 'probe', name = name and tostring(name) })
        return
      end
      if GUARDED[name] then
        local ok, why = Guard.writable()
        if not ok then
          Guard.reply(m, why)
          return
        end
      end
      Log.info('probe %s', name)
      startProbe(m, name, fn)
    end,
  },
  reload = {
    immediate = true,
    fn = function(m) startProbe(m, 'reload', Spike.reloadVersion) end,
  },
  select = {
    immediate = true,
    fn = function(m) startProbe(m, 'select', Spike.selectPhoto) end,
  },
  bezel = {
    immediate = true,
    fn = function(m)
      LrTasks.pcall(LrDialogs.showBezel, tostring(m.msg or ''), tonumber(m.secs) or 2)
    end,
  },
}

return Spike
