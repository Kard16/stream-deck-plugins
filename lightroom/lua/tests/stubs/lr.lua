-- Fake Lr* modules, so DeckBridge runs under plain Lua 5.1.5 outside Lightroom.
--
-- The fake behaves the way the spikes measured Lightroom Classic 15.3 (docs/lightroom/
-- plan.md, spike runs 1 and 2):
-- * Tasks are coroutines, run by a scheduler that owns the clock. startAsyncTask runs a
--   task later, not at once. LrTasks.sleep and yield need a task. LrTasks.pcall lets a
--   task yield through it; plain pcall doesn't.
-- * Socket callbacks, onMessage among them, run outside any task, so they can't yield.
-- * Photo metadata reads and catalog writes fail outside a task with "We can only wait
--   from within a task" (strictTasks, on unless a test turns it off). So does
--   isAvailableForEditing here: not measured, but PROTOCOL.md keeps it out of onMessage,
--   and env.availableOutsideTask counts any call that tries.
-- * The adjustment observer is silent during a tracked gesture and fires once, 4 ms
--   after stopTracking. An untracked setValue never fires it. Mouse edits, resets and
--   photo changes in Develop do.
-- * With nothing selected, getTargetPhoto() is nil and getTargetPhotos() is the whole
--   filmstrip.
-- * colorNameForLabel says "gray" for an unlabelled photo.
-- * setValue clamps nothing. getRange depends on the file format: PROTOCOL.md's ranges.
-- * resetToDefault gives 0, or the photo's as-shot value for Temperature and Tint.
-- * Lightroom's own Auto Advance is optional.
-- * LrSocket.bind refuses every port but 0, so tests never touch 58780/58781.
--
-- Stubs.boot(opts) loads the plugin into a fresh fake and returns `env`: the fake's
-- state plus helpers that play the deck (connect, send a line, drop a socket) and the
-- user (select photos, edit with the mouse, switch modules, lock photos).
local Stubs = {}

local here = string.match(debug.getinfo(1, 'S').source, '^@(.*)/[^/]*$') or '.'
Stubs.PLUGIN_DIR = here .. '/../../DeckBridge.lrdevplugin'

Stubs.TEST_CATALOG = '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat'

-- Every module the plugin has, so each boot starts from scratch.
Stubs.PLUGIN_MODULES = {
  'Config', 'Core', 'Develop', 'Dispatch', 'Guard', 'Info', 'Init', 'Library', 'Log',
  'MenuStatus', 'Poll', 'Presets', 'Proto', 'Reload', 'Server', 'Shutdown', 'ShutdownApp',
  'State', 'json',
}

-- Params the fake's LrDevelopController knows. Anything else is rejected.
Stubs.PARAMS = {
  'Temperature', 'Tint', 'Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites',
  'Blacks', 'Texture', 'Clarity', 'Dehaze', 'Vibrance', 'Saturation',
  'PostCropVignetteAmount', 'Sharpness', 'LuminanceSmoothing',
}

-- PROTOCOL.md, Develop values: measured on the user's raws.
local RAW_RANGES = { Temperature = { 2000, 50000 }, Tint = { -150, 150 }, Exposure = { -5, 5 } }
local RENDERED_RANGES = { Temperature = { -100, 100 }, Tint = { -100, 100 }, Exposure = { -5, 5 } }

Stubs.VALUES = {
  Temperature = 5500, Tint = 10, Exposure = 0.35, Contrast = 0, Highlights = -20, Shadows = 15,
  Whites = 0, Blacks = 0, Texture = 0, Clarity = 0, Vibrance = 0, Saturation = 0,
  PostCropVignetteAmount = 0,
}
Stubs.JPG_VALUES = {
  Temperature = 0, Tint = 0, Exposure = 0, Contrast = 5, Highlights = 0, Shadows = 0,
  Whites = 0, Blacks = 0, Texture = 0, Clarity = 0, Vibrance = 0, Saturation = 0,
  PostCropVignetteAmount = 0,
}

local function copy(t)
  local out = {}
  for k, v in pairs(t or {}) do
    out[k] = v
  end
  return out
end
Stubs.copy = copy

local function pack(...)
  return { n = select('#', ...), ... }
end

-- The photos most tests use: the fixtures' 101-103 raws and the 104 JPEG.
function Stubs.defaultSetup()
  return {
    module = 'develop',
    photos = {
      { id = '101', file = 'DSC0101.ARW', fmt = 'RAW', flag = 0, rating = 0, label = 'none', values = copy(Stubs.VALUES) },
      { id = '102', file = 'DSC0102.ARW', fmt = 'RAW', flag = 0, rating = 2, label = 'red', values = copy(Stubs.VALUES) },
      { id = '103', file = 'DSC0103.ARW', fmt = 'RAW', flag = 1, rating = 0, label = 'none', values = copy(Stubs.VALUES) },
      { id = '104', file = 'IMG0104.JPG', fmt = 'JPG', flag = 0, rating = 0, label = 'none', values = copy(Stubs.JPG_VALUES) },
    },
    target = '101',
  }
end

-- A fake Lightroom built from a fixture-style setup (PROTOCOL.md, Fixtures). Extra,
-- test-only photo fields: locked (isAvailableForEditing is false) and asShot.
function Stubs.new(setup, opts)
  setup = setup or Stubs.defaultSetup()
  opts = opts or {}

  local env = {
    clock = { t = opts.clock or 1000 }, -- LrDate time; real Lightroom's has a fraction
    inTask = false,
    strictTasks = opts.strictTasks ~= false,
    switchDelay = opts.switchDelay or 0, -- seconds a module switch takes
    autoRun = true, -- run ready tasks after every deck or user action
    autoAdvance = setup.autoAdvance or false,
    unlabelled = 'gray', -- what colorNameForLabel says for an unlabelled photo
    tmp = opts.tmp,
    context = { name = 'stub context' },

    ready = {}, timers = {}, seq = 0,
    taskNames = {}, taskErrors = {}, callbackErrors = {},
    logs = {}, bezels = {}, dialogs = {}, views = {},
    calls = {}, -- LrDevelopController and LrSelection calls worth asserting on
    sockets = {}, out = {}, outAt = {}, nextPort = 49152,
    bindFails = {}, closeOnBind = {}, -- by mode: binds that fail, or close as they bind
    observers = {},
    tracking = nil, dirty = false,
    view = 'loupe',
    applied = {}, -- photo id -> preset uuids, in order
    writes = {}, inWrite = false, catalogBusy = false,
    availableOutsideTask = 0, -- isAvailableForEditing calls made outside any task
  }

  -- Scheduler -------------------------------------------------------------------------

  function env.addTimer(at, item)
    env.seq = env.seq + 1
    item.at, item.seq = at, env.seq
    env.timers[#env.timers + 1] = item
    table.sort(env.timers, function(a, b)
      if a.at ~= b.at then return a.at < b.at end
      return a.seq < b.seq
    end)
  end

  -- A Lightroom callback (observer, module switch) secs from now, outside any task.
  function env.later(secs, fn, name)
    env.addTimer(env.clock.t + secs, { fn = fn, name = name })
  end

  local function resume(item)
    local prev = env.inTask
    env.inTask = true
    local r = pack(coroutine.resume(item.co))
    env.inTask = prev
    if not r[1] then
      env.taskErrors[#env.taskErrors + 1] = tostring(item.name) .. ': ' .. tostring(r[2])
      return
    end
    if coroutine.status(item.co) == 'dead' then
      return
    end
    local req = r[2]
    local secs = type(req) == 'table' and tonumber(req.sleep) or 0
    env.addTimer(env.clock.t + math.max(secs or 0, 0), { co = item.co, name = item.name })
  end

  -- Runs every task and callback that is due now, until none is.
  function env.run()
    local n = 0
    while true do
      while env.timers[1] and env.timers[1].at <= env.clock.t + 1e-9 do
        env.ready[#env.ready + 1] = table.remove(env.timers, 1)
      end
      local item = table.remove(env.ready, 1)
      if not item then
        return
      end
      n = n + 1
      if n > 100000 then
        error('stub scheduler: runaway tasks')
      end
      if item.co then
        resume(item)
      else
        local ok, err = pcall(item.fn)
        if not ok then
          env.callbackErrors[#env.callbackErrors + 1] = tostring(item.name) .. ': ' .. tostring(err)
        end
      end
    end
  end

  -- Lets secs pass, running tasks and callbacks at their times.
  function env.advance(secs)
    local target = env.clock.t + secs
    env.run()
    while env.timers[1] and env.timers[1].at <= target + 1e-9 do
      if env.timers[1].at > env.clock.t then
        env.clock.t = env.timers[1].at
      end
      env.run()
    end
    env.clock.t = target
    env.run()
  end

  -- One run of the plugin's poll, inside a task, as the main loop does it.
  function env.poll()
    env.M.LrTasks.startAsyncTask(function()
      local ok, err = env.M.LrTasks.pcall(require('Poll').tick)
      if not ok then
        env.taskErrors[#env.taskErrors + 1] = 'poll: ' .. tostring(err)
      end
    end, 'test poll')
    env.run()
  end

  -- What the fixtures do after every line: 200 ms pass, then the poll runs once.
  function env.step()
    env.advance(0.2)
    env.poll()
  end

  -- Not in a task: fail the way Lightroom 15.3 does.
  function env.needTask()
    if env.strictTasks and not env.inTask then
      error('We can only wait from within a task', 3)
    end
  end

  -- Photos, selection and catalog ----------------------------------------------------

  env.photoList, env.byId = {}, {}
  for _, spec in ipairs(setup.photos or {}) do
    local id = tostring(spec.id)
    local values = copy(spec.values)
    local photo = {
      localIdentifier = tonumber(id) or id,
      id = id,
      file = spec.file or ('DSC' .. id .. '.ARW'),
      fmt = spec.fmt or 'RAW',
      flag = spec.flag or 0,
      rating = spec.rating or 0,
      label = spec.label or 'none',
      values = values,
      asShot = spec.asShot or { Temperature = values.Temperature or 0, Tint = values.Tint or 0 },
      locked = spec.locked or false,
    }
    function photo:getRawMetadata(k)
      env.needTask()
      if k == 'pickStatus' then return self.flag end
      if k == 'rating' then return self.rating end
      if k == 'colorNameForLabel' then
        if self.label == 'none' then return env.unlabelled end
        return self.label
      end
      if k == 'fileFormat' then return self.fmt end
      return nil
    end
    function photo:getFormattedMetadata(k)
      env.needTask()
      if k == 'fileName' then return self.file end
      return nil
    end
    function photo:isAvailableForEditing()
      if not env.inTask then
        env.availableOutsideTask = env.availableOutsideTask + 1
      end
      env.needTask()
      return not self.locked
    end
    function photo:applyDevelopPreset(preset)
      if not env.inWrite then
        error('LrPhoto:applyDevelopPreset must be called inside catalog:withWriteAccessDo')
      end
      env.applied[self.id] = env.applied[self.id] or {}
      table.insert(env.applied[self.id], preset.uuid)
    end
    env.photoList[#env.photoList + 1] = photo
    env.byId[id] = photo
  end

  local function findPhotos(ids)
    local out = {}
    for _, id in ipairs(ids or {}) do
      local photo = env.byId[tostring(id)]
      if photo then
        out[#out + 1] = photo
      end
    end
    return out
  end

  local targetId = setup.target or (env.photoList[1] and env.photoList[1].id)
  env.selection = findPhotos(setup.selected or { targetId })
  env.target = env.byId[tostring(targetId)] or env.selection[1]

  env.catalog = { path = setup.catalog or Stubs.TEST_CATALOG }
  function env.catalog:getPath() return self.path end
  function env.catalog:getTargetPhoto() return env.target end
  function env.catalog:getTargetPhotos()
    if #env.selection == 0 then
      return copy(env.photoList) -- nothing selected: Lightroom answers with the filmstrip
    end
    return copy(env.selection)
  end
  function env.catalog:getAllPhotos() return copy(env.photoList) end
  function env.catalog:withWriteAccessDo(name, fn, params)
    env.needTask()
    env.writes[#env.writes + 1] = name
    if env.inWrite then
      error('LrCatalog:withWriteAccessDo: nested write access')
    end
    if env.catalogBusy then
      if params and params.timeout then
        env.M.LrTasks.sleep(params.timeout)
        return 'aborted'
      end
      error("LrCatalog:withWriteAccessDo: could not execute action '" .. tostring(name) .. "'. It was blocked by another write access call, and no timeout parameters were provided.")
    end
    env.inWrite = true
    local ok, err = env.M.LrTasks.pcall(fn)
    env.inWrite = false
    if not ok then
      error(err, 0)
    end
    return 'executed'
  end

  -- The observer: callbacks secs from now, count of them a few ms apart.
  function env.fireObservers(secs, count)
    for k = 1, count or 1 do
      env.later(secs + (k - 1) * 0.005, function()
        for _, o in ipairs(env.observers) do
          o.cb(o.obs)
        end
      end, 'adjustment observer')
    end
  end

  -- Selects these photos; the first is the target. An empty list leaves no target.
  function env.select(ids)
    local before = env.target
    env.selection = findPhotos(ids)
    env.target = env.selection[1]
    if env.target ~= before and env.module == 'develop' then
      env.fireObservers(0.005, 3) -- a burst; 15.3 fired 73 callbacks for one change
    end
  end

  function env.setModule(name)
    if env.module == name then
      return
    end
    if env.module == 'develop' then
      env.tracking, env.dirty = nil, false -- leaving Develop ends any tracking
    end
    env.module = name
    if name == 'develop' then
      env.view = 'loupe'
    end
  end

  -- The user moves sliders with the mouse.
  function env.edit(values)
    if not env.target then return end
    for p, v in pairs(values) do
      env.target.values[p] = v
    end
    if env.module == 'develop' then
      env.fireObservers(0.004, 1)
    end
  end

  -- Makes exactly these photos locked, as a background AI process such as Denoise would;
  -- an empty list unlocks every photo.
  function env.setLocked(ids)
    local locked = {}
    for _, id in ipairs(ids) do
      locked[tostring(id)] = true
    end
    for _, photo in ipairs(env.photoList) do
      photo.locked = locked[photo.id] or false
    end
  end

  -- A fixture `user` line.
  function env.userAction(u)
    if u.photo ~= nil then env.select({ tostring(u.photo) }) end
    if u.selected ~= nil then env.select(u.selected) end
    if u.module ~= nil then env.setModule(u.module) end
    if u.edit ~= nil then env.edit(u.edit) end
    if u.locked ~= nil then env.setLocked(u.locked) end
    if env.autoRun then env.run() end
  end

  env.module = setup.module or 'develop'

  -- Presets, grouped into folders in the order they first appear.
  env.folders, env.presetsByUuid = {}, {}
  local folderByName = {}
  for _, spec in ipairs(setup.presets or {}) do
    local folder = folderByName[spec.folder]
    if not folder then
      folder = { name = spec.folder, presets = {} }
      function folder:getName() return self.name end
      function folder:getDevelopPresets() return copy(self.presets) end
      folderByName[spec.folder] = folder
      env.folders[#env.folders + 1] = folder
    end
    local preset = { uuid = spec.uuid, name = spec.name }
    function preset:getUuid() return self.uuid end
    function preset:getName() return self.name end
    folder.presets[#folder.presets + 1] = preset
    env.presetsByUuid[spec.uuid] = preset
  end

  -- Modules -----------------------------------------------------------------------------

  local M = {}
  env.M = M

  local function copcall(f, ...)
    local co = coroutine.create(function(...) return f(...) end)
    local r = pack(coroutine.resume(co, ...))
    while true do
      if not r[1] then
        return false, r[2]
      end
      if coroutine.status(co) == 'dead' then
        return true, unpack(r, 2, r.n)
      end
      -- f yielded: a sleep inside a task. Pass it up, then carry on with the answer.
      r = pack(coroutine.resume(co, coroutine.yield(unpack(r, 2, r.n))))
    end
  end

  M.LrTasks = {
    pcall = copcall,
    canYield = function() return env.inTask end,
    sleep = function(s)
      if not env.inTask then
        error('LrTasks.sleep: yielding is not allowed outside a task', 2)
      end
      coroutine.yield({ sleep = s or 0 })
    end,
    yield = function()
      if not env.inTask then
        error('LrTasks.yield: yielding is not allowed outside a task', 2)
      end
      coroutine.yield({ sleep = 0 })
    end,
    startAsyncTask = function(fn, name)
      env.taskNames[#env.taskNames + 1] = name or '?'
      env.ready[#env.ready + 1] = { co = coroutine.create(function() fn() end), name = name or '?' }
    end,
  }

  M.LrDate = { currentTime = function() return env.clock.t end }

  M.LrLogger = function()
    local logger = {}
    function logger:enable() end
    for _, level in ipairs({ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' }) do
      logger[level] = function(_, s) env.logs[#env.logs + 1] = level .. ' ' .. tostring(s) end
    end
    return logger
  end

  M.LrDialogs = {
    showBezel = function(msg, secs) env.bezels[#env.bezels + 1] = { msg = msg, secs = secs, at = env.clock.t } end,
    message = function(message, info, style)
      env.dialogs[#env.dialogs + 1] = { message = message, info = info, style = style, inTask = env.inTask }
    end,
  }

  M.LrFunctionContext = {
    postAsyncTaskWithContext = function(name, fn)
      env.mainTaskName = name
      env.mainTaskFn = fn
    end,
  }
  function env.startMainTask()
    M.LrTasks.startAsyncTask(function() env.mainTaskFn(env.context) end, env.mainTaskName)
  end

  M.LrPathUtils = {
    child = function(a, b) return a .. '/' .. b end,
    getStandardFilePath = function() return env.tmp end,
    leafName = function(p) return string.match(p, '([^/]+)$') end,
  }

  M.LrFileUtils = {
    exists = function(p)
      local f = io.open(p, 'r')
      if f then f:close(); return 'file' end
      return false
    end,
    readFile = function(p)
      local f = io.open(p, 'r')
      if not f then return nil end
      local s = f:read('*a')
      f:close()
      return s
    end,
  }

  local VIEW_NAMES = { develop_before = 'before', develop_loupe = 'loupe' }
  M.LrApplicationView = {
    getCurrentModuleName = function() return env.module end,
    switchToModule = function(name)
      env.calls[#env.calls + 1] = 'module:' .. tostring(name)
      if env.switchDelay > 0 then
        env.later(env.switchDelay, function() env.setModule(name) end, 'module switch')
      else
        env.setModule(name)
      end
    end,
    showView = function(name)
      if string.find(name, '^develop_') and env.module ~= 'develop' then
        error('showView ' .. name .. ': Develop is not active')
      end
      env.views[#env.views + 1] = name
      env.view = VIEW_NAMES[name] or name
    end,
  }

  local KNOWN = {}
  for _, p in ipairs(Stubs.PARAMS) do KNOWN[p] = true end
  local function needDevelop(fn)
    if env.module ~= 'develop' then
      error('LrDevelopController.' .. fn .. ': must be called while the Develop module is active', 3)
    end
  end
  local function needPhoto(fn)
    if not env.target then error('LrDevelopController.' .. fn .. ': no active photo', 3) end
  end
  local function needParam(fn, p)
    if not KNOWN[p] then error('LrDevelopController.' .. fn .. ': unknown parameter ' .. tostring(p), 3) end
  end
  local function range(p)
    local fmt = env.target.fmt
    local custom = setup.ranges and setup.ranges[fmt] and setup.ranges[fmt][p]
    if custom then return custom[1], custom[2] end
    local defaults = (fmt == 'RAW' or fmt == 'DNG') and RAW_RANGES or RENDERED_RANGES
    local r = defaults[p] or { -100, 100 }
    return r[1], r[2]
  end
  env.range = range

  M.LrDevelopController = {
    getValue = function(p)
      needDevelop('getValue'); needPhoto('getValue'); needParam('getValue', p)
      return env.target.values[p] or 0
    end,
    setValue = function(p, v)
      needDevelop('setValue'); needPhoto('setValue'); needParam('setValue', p)
      if type(v) ~= 'number' then error('LrDevelopController.setValue: the value must be a number') end
      env.calls[#env.calls + 1] = 'set:' .. p .. '=' .. tostring(v)
      if env.tracking and env.tracking ~= p then
        env.calls[#env.calls + 1] = 'untracked:' .. p -- Lightroom would end tracking here
      end
      env.target.values[p] = v -- no clamping: setValue clamps nothing
      if env.tracking then env.dirty = true end -- untracked sets never fire the observer
    end,
    getRange = function(p)
      needDevelop('getRange'); needPhoto('getRange'); needParam('getRange', p)
      return range(p)
    end,
    startTracking = function(p)
      needDevelop('startTracking')
      env.calls[#env.calls + 1] = 'start:' .. tostring(p)
      env.tracking = p
    end,
    stopTracking = function()
      needDevelop('stopTracking')
      env.calls[#env.calls + 1] = 'stop'
      local dirty = env.tracking and env.dirty
      env.tracking, env.dirty = nil, false
      if dirty then
        env.fireObservers(0.004, 1) -- once, about 4 ms after stopTracking
      end
    end,
    resetToDefault = function(p)
      needDevelop('resetToDefault'); needPhoto('resetToDefault'); needParam('resetToDefault', p)
      env.calls[#env.calls + 1] = 'reset:' .. p
      local default = env.target.asShot[p] or 0
      if p ~= 'Temperature' and p ~= 'Tint' then default = 0 end
      local changed = env.target.values[p] ~= default
      env.target.values[p] = default
      if changed then env.fireObservers(0.004, 1) end
    end,
    addAdjustmentChangeObserver = function(context, obs, cb)
      needDevelop('addAdjustmentChangeObserver')
      if context == nil then error('addAdjustmentChangeObserver: no function context') end
      env.observers[#env.observers + 1] = { obs = obs, cb = cb }
    end,
  }

  local function move(step)
    if not env.target then return end
    local i
    for k, photo in ipairs(env.photoList) do
      if photo == env.target then i = k end
    end
    local nextPhoto = i and env.photoList[i + step]
    if nextPhoto then env.select({ nextPhoto.id }) end
  end
  env.move = move
  local function setFlag(v)
    env.calls[#env.calls + 1] = 'flag:' .. v
    for _, photo in ipairs(env.selection) do photo.flag = v end
    if env.autoAdvance and #env.selection > 0 then move(1) end
  end
  M.LrSelection = {
    flagAsPick = function() setFlag(1) end,
    flagAsReject = function() setFlag(-1) end,
    removeFlag = function() setFlag(0) end,
    nextPhoto = function() env.calls[#env.calls + 1] = 'next'; move(1) end,
    previousPhoto = function() env.calls[#env.calls + 1] = 'prev'; move(-1) end,
  }

  M.LrApplication = {
    activeCatalog = function() return env.catalog end,
    versionString = function() return '15.3' end,
    versionTable = function() return { major = 15, minor = 3, revision = 0, build = 0 } end,
    developPresetFolders = function() return copy(env.folders) end,
    developPresetByUuid = function(uuid) return env.presetsByUuid[uuid] end,
  }

  M.LrSocket = {
    bind = function(params)
      if params.port ~= 0 then
        error('tests bind port 0 only, never ' .. tostring(params.port))
      end
      local mode = params.mode
      if (env.bindFails[mode] or 0) > 0 then
        env.bindFails[mode] = env.bindFails[mode] - 1
        error('failed to open')
      end
      env.nextPort = env.nextPort + 1
      local s = { params = params, mode = mode, port = env.nextPort, sent = {}, closed = false, reconnects = 0, connected = false }
      function s:send(line)
        if self.closed then error('socket is closed') end
        if self.mode ~= 'send' then error('a receive socket cannot send') end
        self.sent[#self.sent + 1] = line
        env.out[#env.out + 1] = line
        env.outAt[#env.out] = env.clock.t
      end
      -- As in LrC: listening again fires onConnecting again. While no client comes, the
      -- socket times out every 10 s and the plugin reconnects it (the real log shows
      -- onConnecting every 10 s).
      function s:reconnect()
        self.reconnects = self.reconnects + 1
        if params.onConnecting then params.onConnecting(self, self.port) end
      end
      function s:close()
        if self.closed then return end
        self.closed = true
        self.connected = false
        if params.onClosed then params.onClosed(self) end -- fires synchronously, as in LrC
      end
      env.sockets[#env.sockets + 1] = s
      if params.onConnecting then params.onConnecting(s, s.port) end
      -- Spike run 2: around Lightroom's menus and Plug-in Manager, a new send socket
      -- reported closed straight away, before bind had even returned.
      if (env.closeOnBind[mode] or 0) > 0 then
        env.closeOnBind[mode] = env.closeOnBind[mode] - 1
        s.closed = true
        if params.onClosed then params.onClosed(s) end
      end
      return s
    end,
  }

  -- Helpers that play the deck client ------------------------------------------------

  function env.latest(mode)
    for i = #env.sockets, 1, -1 do
      if env.sockets[i].mode == mode then return env.sockets[i] end
    end
  end
  function env.bindsOf(mode)
    local n = 0
    for _, s in ipairs(env.sockets) do
      if s.mode == mode then n = n + 1 end
    end
    return n
  end
  function env.connect(mode)
    local s = env.latest(mode)
    s.connected = true
    if s.params.onConnected then s.params.onConnected(s, s.port) end
    if env.autoRun then env.run() end
    return s
  end
  function env.connectBoth()
    env.connect('receive')
    return env.connect('send')
  end
  function env.line(text)
    local s = env.latest('receive')
    s.params.onMessage(s, text)
    if env.autoRun then env.run() end
  end
  function env.cmd(tbl)
    env.line(env.json.encode(tbl))
  end
  function env.drop(mode)
    local s = env.latest(mode)
    s.connected = false
    s.params.onClosed(s)
    if env.autoRun then env.run() end
  end
  function env.events(t)
    local out = {}
    for _, line in ipairs(env.out) do
      local msg = env.json.decode((string.gsub(line, '\n$', '')))
      if t == nil or msg.t == t then out[#out + 1] = msg end
    end
    return out
  end
  function env.last(t)
    local list = env.events(t)
    return list[#list]
  end
  function env.clearEvents()
    env.out, env.outAt = {}, {}
  end
  function env.logged(pattern)
    for _, line in ipairs(env.logs) do
      if string.find(line, pattern) then return true end
    end
    return false
  end
  function env.count(prefix)
    local n = 0
    for _, c in ipairs(env.calls) do
      if c == prefix or string.sub(c, 1, #prefix) == prefix then n = n + 1 end
    end
    return n
  end

  return env
end

-- Loads the plugin into a fresh fake, the way Lightroom does, then does what the main
-- task does before its loop: bind both listeners. Without opts.connect = false, a deck
-- then connects both sockets.
-- opts: setup (fixture-style), pluginDir, tmp, strictTasks, switchDelay, clock (the
-- LrDate time at the start), config (Config overrides), watch (the watch list at the
-- start), noStart, connect.
function Stubs.boot(opts)
  opts = opts or {}
  local env = Stubs.new(opts.setup, opts)

  -- The plugin's globals; Lightroom provides the real ones.
  import = function(name)
    local m = env.M[name]
    if not m then error('stub: no module ' .. tostring(name), 2) end
    return m
  end
  _PLUGIN = { path = opts.pluginDir or Stubs.PLUGIN_DIR, id = 'com.karimdhanji.deckbridge', enabled = true }

  for _, name in ipairs(Stubs.PLUGIN_MODULES) do
    package.loaded[name] = nil
  end
  local Config = require 'Config'
  Config.CMD_PORT, Config.EVT_PORT = 0, 0 -- ephemeral ports only: other tracks test too
  Config.GUARD = true -- whatever the user set; tests that want it off say so in config
  for k, v in pairs(opts.config or {}) do
    Config[k] = v
  end
  env.json = require 'json'
  require 'Init'
  if opts.noStart then
    return env
  end
  env.startServer()
  if opts.watch or (opts.setup and opts.setup.watch) then
    require('State').watched = copy(opts.watch or opts.setup.watch)
  end
  env.run()
  env.poll() -- the plugin has been polling before any deck connects
  if opts.connect ~= false then
    env.connectBoth()
  end
  return env
end

-- What Init's main task does before its loop.
function Stubs.startServer(env)
  local State = require 'State'
  State.context = env.context
  require('Poll').start()
  require('Server').start(env.context)
end

local new = Stubs.new
function Stubs.new(setup, opts)
  local env = new(setup, opts)
  env.startServer = function() Stubs.startServer(env) end
  return env
end

return Stubs
