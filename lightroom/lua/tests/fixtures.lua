-- Runs every lightroom/protocol/fixtures/*.jsonl against the Lua plugin in the fake
-- Lightroom (tests/stubs/lr.lua), by the rules in PROTOCOL.md's Fixtures section:
-- * The runner connects both sockets and throws away whatever Lightroom sends on
--   connect, then plays the lines in order.
-- * It owns the clock. After every deck, raw and user line it lets 200 ms pass and runs
--   Lightroom's poll once; a wait passes in 200 ms poll steps.
-- * lr lines match in order. Between them Lightroom may send extra state, vals, ranges
--   or pong that don't match; anything else fails. Trailing messages after the last lr
--   line are held to the same rule.
-- * A never line forbids matching messages until the next lr line is matched.
-- * expect checks the fake Lightroom: values, flags, target, module, view, tracking and
--   applied.
-- Run from the repo root: mise exec -- lua lightroom/lua/tests/fixtures.lua [name ...]
local here = string.match(debug.getinfo(1, 'S').source, '^@(.*)/[^/]*$') or '.'
local PLUGIN_DIR = here .. '/../DeckBridge.lrdevplugin'
local FIXTURE_DIR = here .. '/../../protocol/fixtures'
package.path = PLUGIN_DIR .. '/?.lua;' .. here .. '/?.lua;' .. here .. '/stubs/?.lua;' .. package.path

local Stubs = require 'lr'
local FX = require 'fxjson'

local STEP_MS = 200
local SWITCH_SECS = 0.03 -- module switches take a moment, as in Lightroom
local EXTRAS = { state = true, vals = true, ranges = true, pong = true }

local function mktemp()
  local p = os.tmpname()
  os.remove(p)
  assert(os.execute('mkdir -p "' .. p .. '"') == 0, 'mkdir failed')
  return p
end
local TMP = mktemp()

local function fixtureFiles(only)
  local files = {}
  local p = assert(io.popen('ls "' .. FIXTURE_DIR .. '"'))
  for name in p:lines() do
    local base = string.match(name, '^(.+)%.jsonl$')
    if base and (not only or only[base]) then
      files[#files + 1] = { name = base, path = FIXTURE_DIR .. '/' .. name }
    end
  end
  p:close()
  table.sort(files, function(a, b) return a.name < b.name end)
  return files
end

-- Plain Lua tables from FX's tagged ones, for the fake's setup.
local function plain(v)
  if type(v) ~= 'table' or v == FX.NULL then
    if v == FX.NULL then return nil end
    return v
  end
  local out = {}
  for k, x in pairs(v) do out[k] = plain(x) end
  return out
end

-- expect ------------------------------------------------------------------------------

local function checkExpect(env, e)
  local problems = {}
  local function problem(fmt, ...) problems[#problems + 1] = string.format(fmt, ...) end
  for field, want in pairs(e) do
    if field == 'values' then
      for id, params in pairs(want) do
        local photo = env.byId[id]
        if not photo then
          problem('values: no photo %s', id)
        else
          for p, v in pairs(params) do
            local got = photo.values[p]
            if type(got) ~= 'number' or math.abs(got - v) > 1e-6 then
              problem('values: photo %s %s is %s, expected %s', id, p, tostring(got), tostring(v))
            end
          end
        end
      end
    elseif field == 'flags' then
      for id, flag in pairs(want) do
        local photo = env.byId[id]
        if not photo or photo.flag ~= flag then
          problem('flags: photo %s is %s, expected %s', id, tostring(photo and photo.flag), tostring(flag))
        end
      end
    elseif field == 'target' then
      local got = env.target and env.target.id
      if got ~= want then problem('target is %s, expected %s', tostring(got), tostring(want)) end
    elseif field == 'module' then
      if env.module ~= want then problem('module is %s, expected %s', tostring(env.module), tostring(want)) end
    elseif field == 'view' then
      if env.view ~= want then problem('view is %s, expected %s', tostring(env.view), tostring(want)) end
    elseif field == 'tracking' then
      local got = env.tracking ~= nil
      if got ~= want then problem('tracking is %s (%s), expected %s', tostring(got), tostring(env.tracking), tostring(want)) end
    elseif field == 'applied' then
      -- Exhaustive by photo: {} means nothing was applied anywhere.
      for id, uuids in pairs(env.applied) do
        if want[id] == nil then problem('applied: photo %s got %s, expected nothing', id, table.concat(uuids, ',')) end
      end
      for id, uuids in pairs(want) do
        local got = FX.array(env.applied[id] or {})
        if not FX.match(uuids, got) then
          problem('applied: photo %s got [%s], expected %s', id, table.concat(env.applied[id] or {}, ','), FX.encode(uuids))
        end
      end
    else
      problem('expect field %s is not modelled by this runner', field)
    end
  end
  if #problems > 0 then
    error('expect ' .. FX.encode(e) .. ': ' .. table.concat(problems, '; '), 0)
  end
end

-- One fixture ----------------------------------------------------------------------------

local function runFixture(path)
  local lines = {}
  local n = 0
  for text in io.lines(path) do
    n = n + 1
    if string.find(text, '%S') then
      lines[#lines + 1] = { n = n, text = text, v = FX.decode(text) }
    end
  end
  local setup = {}
  for _, line in ipairs(lines) do
    if line.v.setup ~= nil then setup = plain(line.v.setup); break end
    if line.v.note == nil then break end -- setup comes before anything else
  end

  local env = Stubs.boot({ setup = setup, tmp = TMP, switchDelay = SWITCH_SECS })
  env.clearEvents() -- whatever Lightroom sent on connect

  local cursor, nevers, current = 1, {}, nil
  local function fail(msg)
    error(string.format('line %d: %s', current and current.n or 0, msg), 0)
  end
  local function nextMessage()
    local raw = env.out[cursor]
    cursor = cursor + 1
    raw = string.gsub(raw, '\n$', '')
    return FX.decode(raw), raw
  end
  local function checkExtra(msg, raw)
    for _, never in ipairs(nevers) do
      if FX.match(never, msg) then fail('sent ' .. raw .. ', which a never line forbids: ' .. FX.encode(never)) end
    end
  end
  local function matchLr(expected)
    while cursor <= #env.out do
      local msg, raw = nextMessage()
      checkExtra(msg, raw)
      if FX.match(expected, msg) then
        nevers = {}
        return
      end
      if not EXTRAS[msg.t] then fail('expected ' .. FX.encode(expected) .. ', but Lightroom sent ' .. raw) end
    end
    fail('expected ' .. FX.encode(expected) .. ', but Lightroom sent nothing more')
  end

  for _, line in ipairs(lines) do
    current = line
    local v = line.v
    if v.note ~= nil or v.setup ~= nil then
      -- nothing to do
    elseif v.deck ~= nil then
      env.line(FX.encode(v.deck))
      env.step()
    elseif v.raw ~= nil then
      env.line(v.raw)
      env.step()
    elseif v.user ~= nil then
      env.userAction(plain(v.user))
      env.step()
    elseif v.wait ~= nil then
      for _ = 1, math.ceil(v.wait / STEP_MS - 1e-9) do env.step() end
    elseif v.lr ~= nil then
      matchLr(v.lr)
    elseif v.never ~= nil then
      nevers[#nevers + 1] = v.never
    elseif v.expect ~= nil then
      checkExpect(env, plain(v.expect))
    else
      fail('unknown line: ' .. line.text)
    end
  end
  current = nil
  while cursor <= #env.out do
    local msg, raw = nextMessage()
    checkExtra(msg, raw)
    if not EXTRAS[msg.t] then fail('unexpected trailing message ' .. raw) end
  end
  if #env.taskErrors > 0 then fail('task errors: ' .. table.concat(env.taskErrors, '; ')) end
  if #env.callbackErrors > 0 then fail('callback errors: ' .. table.concat(env.callbackErrors, '; ')) end
  for _, log in ipairs(env.logs) do
    if string.find(log, '^error ') then fail('logged ' .. log) end
  end
end

-- Main ---------------------------------------------------------------------------------------

local only = nil
if arg and #arg > 0 then
  only = {}
  for _, name in ipairs(arg) do only[name] = true end
end

local files = fixtureFiles(only)
local passed, failed = 0, 0
for _, f in ipairs(files) do
  local ok, err = pcall(runFixture, f.path)
  if ok then
    passed = passed + 1
    print('ok   ' .. f.name)
  else
    failed = failed + 1
    print('FAIL ' .. f.name .. ': ' .. tostring(err))
  end
end
os.execute('rm -rf "' .. TMP .. '"')
print(string.format('fixtures: %d passed, %d failed', passed, failed))
if failed > 0 or passed == 0 then
  os.exit(1)
end
