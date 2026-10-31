-- Fake Lr* modules, so DeckBridge runs under plain Lua 5.1.5 outside Lightroom.
-- Stubs.reset() returns `env`, which holds the fakes' state and helpers that play the
-- part of the deck client (connect, send a line, drop a socket).
local json -- loaded after reset, from the plugin folder

local Stubs = {}

Stubs.TEST_CATALOG = '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat'
Stubs.CMD_PORT = 58780
Stubs.EVT_PORT = 58781

local PLUGIN_MODULES = {
  'Config', 'Core', 'Develop', 'Dispatch', 'Guard', 'Info', 'Init', 'Log', 'Poll', 'Server',
  'Shutdown', 'ShutdownApp', 'Spike', 'SpikeMenuAutoSync', 'SpikeMenuTests', 'SpikeTrigger',
  'SpikeVersion', 'State', 'json',
}

local DEFAULTS = {
  Temperature = 5500, Tint = 0, Exposure = 0, Contrast = 0, Highlights = 0, Shadows = 0,
  Whites = 0, Blacks = 0, Texture = 0, Clarity = 0, Vibrance = 0, Saturation = 0,
  PostCropVignetteAmount = 0,
}

local RANGES = { Temperature = { 2000, 50000 }, Exposure = { -5, 5 } }

local function newPhoto(id, fields)
  local photo = {
    localIdentifier = id,
    name = fields.name or string.format('DSCF%04d.RAF', id),
    meta = {
      fileSize = fields.size or 1000,
      fileFormat = fields.format or 'RAW',
      pickStatus = 0,
      rating = 0,
      colorNameForLabel = '',
      dimensions = { width = 6240, height = 4160 },
    },
    settings = { Exposure2012 = 0 },
  }
  function photo:getRawMetadata(k) return self.meta[k] end
  function photo:getFormattedMetadata(k)
    if k == 'fileName' then return self.name end
    return nil
  end
  function photo:getDevelopSettings() return self.settings end
  function photo:isAvailableForEditing() return true end
  return photo
end

function Stubs.reset(opts)
  opts = opts or {}
  for _, name in ipairs(PLUGIN_MODULES) do
    package.loaded[name] = nil
  end

  local env = {
    clock = { t = 1000 },
    canYield = false,
    module = opts.module or 'library',
    logs = {},
    bezels = {},
    views = {},
    calls = {}, -- LrDevelopController calls worth asserting on
    sockets = {},
    sentLog = {}, -- every line sent on any socket, in order
    bindFails = {}, -- port -> number of binds that should fail
    closeOnBind = {}, -- port -> number of binds whose socket reports closed before bind returns
    tasks = {},
    taskErrors = {},
    deferTasks = false,
    pendingTasks = {},
    observerOnPhotoChange = true,
    autoAdvance = false,
    sleeps = 0,
    onSleep = nil,
    tmp = opts.tmp,
    context = { name = 'stub context' },
  }

  -- Photos and catalog ------------------------------------------------------
  local photos = {}
  local specs = opts.photos or {
    { size = 30000000, format = 'RAW' },
    { size = 50000000, format = 'RAW', name = 'BIGGEST.RAF' },
    { size = 90000000, format = 'JPG', name = 'HUGE.JPG' },
    { size = 20000000, format = 'DNG' },
  }
  for i, spec in ipairs(specs) do
    photos[i] = newPhoto(i, spec)
  end
  env.photos = photos

  -- Lightroom refuses photo metadata reads outside a task, as seen on 15.3. Tests opt in
  -- with strictTasks, because most of them call module functions directly.
  env.strictTasks = opts.strictTasks or false
  local function needTask()
    if env.strictTasks and not env.canYield then
      error('We can only wait from within a task', 3)
    end
  end
  for _, photo in ipairs(photos) do
    local raw, fmt = photo.getRawMetadata, photo.getFormattedMetadata
    function photo:getRawMetadata(k) needTask(); return raw(self, k) end
    function photo:getFormattedMetadata(k) needTask(); return fmt(self, k) end
  end

  local catalog = { path = opts.catalogPath or Stubs.TEST_CATALOG, target = photos[1], targets = { photos[1] } }
  function catalog:getPath() return self.path end
  function catalog:getTargetPhoto() return self.target end
  function catalog:getTargetPhotos() return self.targets end
  function catalog:getAllPhotos() return photos end
  function catalog:setSelectedPhotos(active, others)
    self.target = active
    local list = { active }
    for _, p in ipairs(others or {}) do list[#list + 1] = p end
    self.targets = list
  end
  function catalog:batchGetRawMetadata(list, keys)
    local out = {}
    for _, photo in ipairs(list) do
      local md = {}
      for _, k in ipairs(keys) do md[k] = photo.meta[k] end
      out[photo] = md
    end
    return out
  end
  env.catalog = catalog

  local function indexOf(photo)
    for i, p in ipairs(photos) do
      if p == photo then return i end
    end
  end

  -- Modules -------------------------------------------------------------------
  local M = {}

  M.LrDate = { currentTime = function() return env.clock.t end }

  M.LrTasks = {
    pcall = pcall,
    canYield = function() return env.canYield end,
    sleep = function(s)
      env.clock.t = env.clock.t + s
      env.sleeps = env.sleeps + 1
      if env.onSleep then env.onSleep(s) end
    end,
    yield = function() end,
    startAsyncTask = function(fn, name)
      env.tasks[#env.tasks + 1] = name or '?'
      local function runIt()
        local prev = env.canYield
        env.canYield = true
        local ok, err = pcall(fn)
        env.canYield = prev
        if not ok then env.taskErrors[#env.taskErrors + 1] = tostring(err) end
      end
      if env.deferTasks then
        env.pendingTasks[#env.pendingTasks + 1] = runIt
      else
        runIt()
      end
    end,
  }

  M.LrLogger = function()
    local logger = {}
    function logger:enable() end
    for _, level in ipairs({ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' }) do
      logger[level] = function(_, s) env.logs[#env.logs + 1] = level .. ' ' .. tostring(s) end
    end
    return logger
  end

  M.LrDialogs = { showBezel = function(msg, secs) env.bezels[#env.bezels + 1] = { msg = msg, secs = secs } end }

  M.LrFunctionContext = {
    postAsyncTaskWithContext = function(name, fn)
      env.mainTaskName = name
      env.mainTask = function() return fn(env.context) end
    end,
  }

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
    delete = function(p) return os.remove(p) ~= nil end,
  }

  M.LrApplicationView = {
    getCurrentModuleName = function() return env.module end,
    switchToModule = function(m) env.module = m end,
    showView = function(v) env.views[#env.views + 1] = v end,
  }

  local dev = { values = {}, observers = {}, masks = {}, selectedMask = nil, nextMask = 0 }
  for k, v in pairs(DEFAULTS) do dev.values[k] = v end
  env.dev = dev
  local function fireObservers()
    for _, o in ipairs(dev.observers) do o.cb(o.obs) end
  end
  env.fireObservers = fireObservers
  local function needDevelop()
    if env.module ~= 'develop' then error('LrDevelopController: Develop is not active', 2) end
  end
  local function needParam(p)
    if dev.values[p] == nil then error('unknown parameter ' .. tostring(p), 2) end
  end
  local function range(p)
    local r = RANGES[p] or { -100, 100 }
    return r[1], r[2]
  end
  M.LrDevelopController = {
    getValue = function(p) needDevelop(); needParam(p); return dev.values[p] end,
    setValue = function(p, v)
      needDevelop(); needParam(p)
      local lo, hi = range(p)
      if v < lo then v = lo elseif v > hi then v = hi end
      local changed = dev.values[p] ~= v
      dev.values[p] = v
      env.catalog.target.settings[p .. '2012'] = v
      if changed then fireObservers() end
    end,
    getRange = function(p) needDevelop(); needParam(p); return range(p) end,
    startTracking = function(p) env.calls[#env.calls + 1] = 'start:' .. tostring(p) end,
    stopTracking = function() env.calls[#env.calls + 1] = 'stop' end,
    resetToDefault = function(p)
      needDevelop(); needParam(p)
      local changed = dev.values[p] ~= DEFAULTS[p]
      dev.values[p] = DEFAULTS[p]
      if changed then fireObservers() end
    end,
    addAdjustmentChangeObserver = function(context, obs, cb)
      needDevelop()
      if context == nil then error('no function context') end
      dev.observers[#dev.observers + 1] = { obs = obs, cb = cb }
    end,
    goToMasking = function() env.calls[#env.calls + 1] = 'goToMasking' end,
    createNewMask = function(kind, sub)
      dev.nextMask = dev.nextMask + 1
      local id = 'mask' .. dev.nextMask
      dev.masks[#dev.masks + 1] = { id = id, kind = kind, sub = sub }
      dev.selectedMask = id
    end,
    getAllMasks = function()
      local copy = {}
      for i, m in ipairs(dev.masks) do copy[i] = { id = m.id } end
      return copy
    end,
    getSelectedMask = function() return dev.selectedMask end,
    deleteMask = function(id)
      for i, m in ipairs(dev.masks) do
        if m.id == id then table.remove(dev.masks, i); return end
      end
    end,
    selectTool = function(t) env.calls[#env.calls + 1] = 'tool:' .. t end,
    setEnhance = function() end,
  }

  local function movePhoto(step)
    local i = indexOf(catalog.target) or 1
    local j = i + step
    if photos[j] then
      catalog.target = photos[j]
      catalog.targets = { photos[j] }
      if env.observerOnPhotoChange and env.module == 'develop' then fireObservers() end
    end
  end
  local function setFlag(v)
    for _, p in ipairs(catalog.targets) do p.meta.pickStatus = v end
    if env.autoAdvance then movePhoto(1) end
  end
  M.LrSelection = {
    flagAsPick = function() setFlag(1) end,
    flagAsReject = function() setFlag(-1) end,
    removeFlag = function() setFlag(0) end,
    getFlag = function() return catalog.target and catalog.target.meta.pickStatus end,
    getRating = function() return catalog.target and catalog.target.meta.rating end,
    getColorLabel = function() return 'none' end,
    nextPhoto = function() movePhoto(1) end,
    previousPhoto = function() movePhoto(-1) end,
  }

  M.LrUndo = { undo = function() env.calls[#env.calls + 1] = 'undo' end }

  local folder = {
    getName = function() return 'Deck Profiles' end,
    getDevelopPresets = function()
      return {
        { getName = function() return 'Classic Chrome' end, getUuid = function() return 'uuid-1' end },
        { getName = function() return 'Velvia' end, getUuid = function() return 'uuid-2' end },
      }
    end,
  }
  M.LrApplication = {
    activeCatalog = function() return catalog end,
    versionString = function() return '15.3 [ stub ]' end,
    versionTable = function() return { major = 15, minor = 3, revision = 0 } end,
    developPresetFolders = function() return { folder } end,
  }

  M.LrSocket = {
    bind = function(params)
      local fails = env.bindFails[params.port]
      if fails and fails > 0 then
        env.bindFails[params.port] = fails - 1
        error('failed to open')
      end
      local s = { params = params, port = params.port, mode = params.mode, sent = {}, closed = false, reconnects = 0, connected = false }
      function s:send(line)
        if self.closed then error('socket is closed') end
        self.sent[#self.sent + 1] = line
        env.sentLog[#env.sentLog + 1] = line
      end
      function s:reconnect() self.reconnects = self.reconnects + 1 end
      function s:close()
        if self.closed then return end
        self.closed = true
        self.connected = false
        if params.onClosed then params.onClosed(self) end -- fires synchronously, as in LrC
      end
      env.sockets[#env.sockets + 1] = s
      if params.onConnecting then params.onConnecting(s, params.port) end
      -- Spike run 2: around Lightroom's menus and Plug-in Manager, a new send socket
      -- reported closed straight away, before bind had even returned.
      local closing = env.closeOnBind[params.port]
      if closing and closing > 0 then
        env.closeOnBind[params.port] = closing - 1
        s.closed = true
        if params.onClosed then params.onClosed(s) end
      end
      return s
    end,
  }
  env.modules = M

  -- Helpers that play the deck client -----------------------------------------
  function env.latest(port)
    for i = #env.sockets, 1, -1 do
      if env.sockets[i].port == port then return env.sockets[i] end
    end
  end
  function env.bindsOf(port)
    local n = 0
    for _, s in ipairs(env.sockets) do
      if s.port == port then n = n + 1 end
    end
    return n
  end
  function env.connect(port)
    local s = env.latest(port)
    s.connected = true
    if s.params.onConnected then s.params.onConnected(s, port) end
    return s
  end
  function env.connectBoth()
    env.connect(Stubs.CMD_PORT)
    return env.connect(Stubs.EVT_PORT)
  end
  function env.line(text)
    local s = env.latest(Stubs.CMD_PORT)
    s.params.onMessage(s, text)
  end
  function env.cmd(tbl)
    env.line(json.encode(tbl))
  end
  function env.drop(port)
    local s = env.latest(port)
    s.connected = false
    s.params.onClosed(s)
  end
  function env.events(t)
    local out = {}
    for _, line in ipairs(env.sentLog) do
      local msg = json.decode((string.gsub(line, '\n$', '')))
      if t == nil or msg.t == t then out[#out + 1] = msg end
    end
    return out
  end
  function env.clearEvents()
    env.sentLog = {}
  end
  function env.runTasks()
    while #env.pendingTasks > 0 do
      table.remove(env.pendingTasks, 1)()
    end
  end
  function env.logged(pattern)
    for _, line in ipairs(env.logs) do
      if string.find(line, pattern) then return true end
    end
    return false
  end

  import = function(name) -- the plugin's global; LrC provides the real one
    local m = M[name]
    if not m then error('stub: no module ' .. tostring(name), 2) end
    return m
  end
  _PLUGIN = { path = opts.pluginDir, id = 'com.karimdhanji.deckbridge' }

  json = require 'json'
  env.json = json
  return env
end

return Stubs
