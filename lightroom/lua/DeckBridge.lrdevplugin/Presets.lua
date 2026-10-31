-- presets and preset: list every Develop preset, and apply one to the target photos.
--
-- Reloadable: no state of its own, and nothing runs at load time.
local LrApplication = import 'LrApplication'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Log = require 'Log'
local Server = require 'Server'
local Proto = require 'Proto'
local Guard = require 'Guard'

local Presets = {}

-- Every Develop preset as {uuid, name, folder}, in Lightroom's folder order.
function Presets.items()
  local items = {}
  for _, folder in ipairs(LrApplication.developPresetFolders() or {}) do
    local folderName = tostring(folder:getName() or '')
    for _, preset in ipairs(folder:getDevelopPresets() or {}) do
      local uuid = preset:getUuid()
      if type(uuid) == 'string' then
        items[#items + 1] = { uuid = uuid, name = tostring(preset:getName() or ''), folder = folderName }
      end
    end
  end
  return items
end

-- The Develop preset with this uuid, or nil.
function Presets.find(uuid)
  if LrApplication.developPresetByUuid then
    local ok, preset = LrTasks.pcall(LrApplication.developPresetByUuid, uuid)
    if ok and preset then
      return preset
    end
  end
  for _, folder in ipairs(LrApplication.developPresetFolders() or {}) do
    for _, preset in ipairs(folder:getDevelopPresets() or {}) do
      if preset:getUuid() == uuid then
        return preset
      end
    end
  end
  return nil
end

-- Lightroom 15.3 locks a photo while background AI updates it. Older versions lack the
-- call, and then every photo is available.
function Presets.available(photo)
  if not photo.isAvailableForEditing then
    return true
  end
  local ok, available = LrTasks.pcall(function() return photo:isAvailableForEditing() end)
  return not ok or available ~= false
end

-- presets {id}: answers presets {id, items}.
function Presets.list(m)
  Server.send({ t = 'presets', id = Proto.id(m), items = Presets.items() })
end

-- preset {id, uuid}: guarded. Applies the preset to every target photo in one catalog
-- write, skipping locked photos, and answers applied {id, uuid, n, locked}. Does
-- nothing without a target photo: getTargetPhotos() is then the whole filmstrip.
function Presets.apply(m)
  local uuid = m.uuid
  if type(uuid) ~= 'string' or uuid == '' then
    return Proto.err(m, 'bad', 'preset needs uuid, a string')
  end
  if not Guard.check(m) then
    return
  end
  local catalog = LrApplication.activeCatalog()
  if not catalog:getTargetPhoto() then
    return Proto.err(m, 'noPhoto', 'no target photo')
  end
  local preset = Presets.find(uuid)
  if not preset then
    return Proto.err(m, 'notFound', 'no Develop preset has uuid ' .. uuid)
  end
  local photos = catalog:getTargetPhotos() or {}
  local n, locked, ran = 0, 0, false
  local result = catalog:withWriteAccessDo('Deck Bridge: apply preset', function()
    n, locked = 0, 0
    for _, photo in ipairs(photos) do
      if Presets.available(photo) then
        local ok, err = LrTasks.pcall(function() photo:applyDevelopPreset(preset) end)
        if ok then
          n = n + 1
        else
          locked = locked + 1
          Log.warn('applyDevelopPreset failed: %s', tostring(err))
        end
      else
        locked = locked + 1
      end
    end
    ran = true
  end, { timeout = Config.WRITE_TIMEOUT })
  -- With a timeout, withWriteAccessDo returns "executed", or gives up ("aborted").
  if not ran then
    return Proto.err(m, 'busy', 'the catalog was busy (' .. tostring(result) .. ')')
  end
  Server.send({ t = 'applied', id = Proto.id(m), uuid = uuid, n = n, locked = locked })
end

return Presets
