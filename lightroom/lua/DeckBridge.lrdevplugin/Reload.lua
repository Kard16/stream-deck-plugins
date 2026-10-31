-- reload {id, mods}, for development: re-reads handler modules from disk and swaps them
-- in without the user clicking Reload Plug-in.
--
-- Spike S3: Lightroom's require caches modules and has no package.loaded to clear, but
-- LrFileUtils.readFile plus loadstring sees edits, with import and require visible
-- inside the chunk. So a reload runs the new file, then copies its functions into the
-- table require already handed out. Every other module keeps its reference to that
-- table and calls the new functions from then on. The sockets, the observer, the watch
-- list and an open gesture live in Server and State, which never reload; neither do
-- Init, Config, Log or json. Reload Plug-in still reloads everything.
--
-- A reload changes code without the user clicking anything, so it runs only where
-- writes may: with the test catalog open, or the guard off. Guard.lua never hot-reloads,
-- so only Reload Plug-in changes the guard. (Lightroom Classic relaunches to open
-- another catalog, which should load every module from disk again; not measured here.)
--
-- Reloadable itself: no state of its own, and nothing runs at load time.
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Proto = require 'Proto'
local Guard = require 'Guard'

local Reload = {}

-- Every reloadable module, in load order. Each keeps its state in State.lua and does
-- nothing at load time but define functions, so running it again is safe.
Reload.MODULES = { 'Proto', 'Develop', 'Poll', 'Library', 'Presets', 'Dispatch', 'Core', 'Reload' }

local function reloadable(name)
  for _, n in ipairs(Reload.MODULES) do
    if n == name then
      return true
    end
  end
  return false
end

-- Compiles and runs one module's file. Returns its table, or nil and why.
function Reload.load(name)
  local dir = State.pluginPath or (_PLUGIN and _PLUGIN.path)
  if type(dir) ~= 'string' then
    return nil, 'the plugin folder is unknown'
  end
  local path = LrPathUtils.child(dir, name .. '.lua')
  local okRead, src = LrTasks.pcall(LrFileUtils.readFile, path)
  if not okRead or type(src) ~= 'string' then
    return nil, 'could not read ' .. path
  end
  local chunkName = '=' .. name .. '.lua'
  local chunk, errCompile = loadstring(src, chunkName)
  if not chunk then
    return nil, tostring(errCompile)
  end
  local okRun, mod = LrTasks.pcall(chunk)
  if not okRun and string.find(tostring(mod), "global 'import'", 1, true) then
    -- In case a chunk can't see the plugin's import: pass it in, on the first line so
    -- line numbers stay the same. S3 found this unnecessary on 15.3.
    local injected = loadstring('local import, require = ...; ' .. src, chunkName)
    okRun, mod = LrTasks.pcall(injected, import, require)
  end
  if not okRun then
    return nil, tostring(mod)
  end
  if type(mod) ~= 'table' then
    return nil, name .. '.lua returned ' .. type(mod) .. ', not a module table'
  end
  return mod
end

-- Makes old match new, in place.
function Reload.swap(old, new)
  for k in pairs(old) do
    if new[k] == nil then
      old[k] = nil
    end
  end
  for k, v in pairs(new) do
    old[k] = v
  end
end

-- reload {id, mods}: answers reloaded {id, mods, ok, msg}. Loads every module before
-- swapping any in, so one broken file changes nothing.
function Reload.reload(m)
  local mods = {}
  if m.mods == nil then
    for i, name in ipairs(Reload.MODULES) do
      mods[i] = name
    end
  elseif type(m.mods) ~= 'table' or (#m.mods == 0 and next(m.mods) ~= nil) then
    return Proto.err(m, 'bad', 'mods must be a list of module names')
  else
    for _, name in ipairs(m.mods) do
      if type(name) ~= 'string' then
        return Proto.err(m, 'bad', 'mods must be a list of module names')
      end
      mods[#mods + 1] = name
    end
  end
  local function reply(ok, msg)
    Server.send({ t = 'reloaded', id = Proto.id(m), mods = mods, ok = ok, msg = msg })
  end
  if not Config.RELOAD then
    return reply(false, 'reload is off (Config.RELOAD)')
  end
  local writable, why = Guard.writable()
  if not writable then
    Log.every('reload refused', Config.BEZEL_SECS, 'warn', 'reload refused: %s', why)
    return reply(false, 'reload is off while writes are: ' .. why)
  end
  if type(loadstring) ~= 'function' then
    return reply(false, 'loadstring is not available')
  end
  for _, name in ipairs(mods) do
    if not reloadable(name) then
      return reply(false, name .. " doesn't hot-reload; use Reload Plug-in")
    end
  end
  local fresh = {}
  for _, name in ipairs(mods) do
    local mod, err = Reload.load(name)
    if not mod then
      Log.warn('reload failed, nothing swapped: %s', tostring(err))
      return reply(false, err)
    end
    fresh[name] = mod
  end
  for _, name in ipairs(mods) do
    Reload.swap(require(name), fresh[name])
  end
  Log.info('reloaded %s', table.concat(mods, ', '))
  reply(true, 'reloaded ' .. table.concat(mods, ', '))
end

return Reload
