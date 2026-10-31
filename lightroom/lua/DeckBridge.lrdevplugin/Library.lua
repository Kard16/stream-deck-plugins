-- module, flag, nav and view. Each runs in a task from the command queue: the state it
-- answers with reads photo metadata, and switching modules means waiting.
--
-- Reloadable: no state of its own, and nothing runs at load time.
local LrApplicationView = import 'LrApplicationView'
local LrDate = import 'LrDate'
local LrSelection = import 'LrSelection'
local LrTasks = import 'LrTasks'

local Config = require 'Config'
local Proto = require 'Proto'
local Guard = require 'Guard'
local Develop = require 'Develop'
local Poll = require 'Poll'

local Library = {}

local MODULES = { develop = true, library = true }
local FLAGS = { pick = 'flagAsPick', reject = 'flagAsReject', none = 'removeFlag' }
local NAV = { next = 'nextPhoto', prev = 'previousPhoto' }
local VIEWS = { before = 'develop_before', after = 'develop_loupe' }

local function targetId()
  local photo = Develop.targetPhoto()
  return photo and tostring(photo.localIdentifier) or nil
end

local function currentModule()
  local ok, name = LrTasks.pcall(LrApplicationView.getCurrentModuleName)
  return ok and name or nil
end

-- Switches to name and waits up to Config.MODULE_SECS for it.
local function switchTo(name)
  if currentModule() == name then
    return true
  end
  if not LrTasks.pcall(LrApplicationView.switchToModule, name) then
    return false
  end
  local t0 = LrDate.currentTime()
  while currentModule() ~= name and LrDate.currentTime() - t0 < Config.MODULE_SECS do
    LrTasks.sleep(0.05)
  end
  LrTasks.yield()
  return currentModule() == name
end

-- module {v}: answers state once the module has changed, and in Develop ranges and
-- vals too. It answers even when Lightroom was already there, because a deck that sends
-- module develop holds its dial ticks until those vals arrive.
function Library.module(m)
  local v = m.v
  if type(v) ~= 'string' or not MODULES[v] then
    return Proto.err(m, 'bad', 'module v must be "develop" or "library"')
  end
  if v ~= 'develop' then
    Develop.endGesture('leaving Develop', true)
  end
  if not switchTo(v) then
    if v == 'develop' then
      return Proto.err(m, 'noDevelop', 'could not switch to Develop')
    end
    return Proto.err(m, 'failed', 'could not switch to ' .. v)
  end
  Poll.sync({ state = true, vals = v == 'develop' })
end

-- flag {v, advance}: guarded. Flags the target photos the way LrSelection does, and
-- answers state. With advance, waits Config.ADVANCE_SECS and moves to the next photo,
-- unless the target already changed: then Lightroom's own Auto Advance moved on.
function Library.flag(m)
  local fn = type(m.v) == 'string' and FLAGS[m.v] or nil
  if not fn then
    return Proto.err(m, 'bad', 'flag v must be "pick", "reject" or "none"')
  end
  if m.advance ~= nil and type(m.advance) ~= 'boolean' then
    return Proto.err(m, 'bad', 'advance must be true or false')
  end
  if not Guard.check(m) then
    return
  end
  local before = targetId()
  if not before then
    return Proto.err(m, 'noPhoto', 'no target photo')
  end
  LrSelection[fn]()
  -- The reply is state, sent even when nothing changed; with advance the flag shows
  -- before the wait, and the reply follows it.
  Poll.sync({ state = not m.advance })
  if m.advance then
    LrTasks.sleep(Config.ADVANCE_SECS)
    if targetId() == before then
      Develop.endGesture('next photo', true)
      LrSelection.nextPhoto()
    end
    Poll.sync({ state = true })
  end
end

-- nav {v}: next or previous photo; answers state, even at the end of the filmstrip.
function Library.nav(m)
  local fn = type(m.v) == 'string' and NAV[m.v] or nil
  if not fn then
    return Proto.err(m, 'bad', 'nav v must be "next" or "prev"')
  end
  Develop.endGesture('photo change', true)
  LrSelection[fn]()
  Poll.sync({ state = true })
end

-- view {v}: Before on key down, back to the loupe on key up, in Develop.
function Library.view(m)
  local name = type(m.v) == 'string' and VIEWS[m.v] or nil
  if not name then
    return Proto.err(m, 'bad', 'view v must be "before" or "after"')
  end
  if not Develop.ensureDevelop() then
    return Proto.err(m, 'noDevelop', 'could not switch to Develop')
  end
  LrApplicationView.showView(name)
  Poll.sync()
end

return Library
