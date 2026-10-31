-- DeckBridge unit tests: plain Lua 5.1.5 with a fake Lightroom 15.3 (tests/stubs/lr.lua).
-- Run from the repo root: mise exec -- lua lightroom/lua/tests/run.lua
-- The protocol fixtures run separately: tests/fixtures.lua.
local here = string.match(debug.getinfo(1, 'S').source, '^@(.*)/[^/]*$') or '.'
local PLUGIN_DIR = here .. '/../DeckBridge.lrdevplugin'
package.path = PLUGIN_DIR .. '/?.lua;' .. here .. '/stubs/?.lua;' .. package.path

local Stubs = require 'lr'

local CMD, EVT = 'receive', 'send'

local function mktemp()
  local p = os.tmpname()
  os.remove(p)
  assert(os.execute('mkdir -p "' .. p .. '"') == 0, 'mkdir failed')
  return p
end
local TMP = mktemp()

-- Test framework -------------------------------------------------------------

local passed, failed = 0, 0

local function test(name, fn)
  local ok, err = pcall(fn)
  if ok then
    passed = passed + 1
  else
    failed = failed + 1
    print('FAIL ' .. name .. ': ' .. tostring(err))
  end
end

local function eq(actual, expected, what)
  if actual ~= expected then
    error(string.format('%s: expected %s, got %s', what or 'value', tostring(expected), tostring(actual)), 2)
  end
end

local function near(actual, expected, what)
  if type(actual) ~= 'number' or math.abs(actual - expected) > 1e-6 then
    error(string.format('%s: expected %s, got %s', what or 'value', tostring(expected), tostring(actual)), 2)
  end
end

local function ok(v, what)
  if not v then error((what or 'expected a true value'), 2) end
end

local function readFile(path)
  local f = io.open(path, 'r')
  if not f then return nil end
  local s = f:read('*a')
  f:close()
  return s
end

local function writeFile(path, text)
  local f = assert(io.open(path, 'w'))
  f:write(text)
  f:close()
end

local function keys(t)
  local out = {}
  for k in pairs(t or {}) do out[#out + 1] = k end
  table.sort(out)
  return table.concat(out, ',')
end

local function types(env)
  local out = {}
  for _, m in ipairs(env.events()) do out[#out + 1] = m.t end
  return table.concat(out, ',')
end

local function noErrors(env)
  eq(#env.taskErrors, 0, 'task errors: ' .. table.concat(env.taskErrors, '; '))
  eq(#env.callbackErrors, 0, 'callback errors: ' .. table.concat(env.callbackErrors, '; '))
end

local WATCH = { 'Temperature', 'Tint', 'Exposure', 'Contrast' }

-- Loads the plugin into a fresh fake and connects a deck, then forgets what the deck
-- was sent on connecting.
local function boot(opts)
  opts = opts or {}
  local setup = opts.setup or Stubs.defaultSetup()
  if opts.module then setup.module = opts.module end
  if opts.catalog then setup.catalog = opts.catalog end
  if opts.presets then setup.presets = opts.presets end
  if opts.autoAdvance ~= nil then setup.autoAdvance = opts.autoAdvance end
  if opts.selected then setup.selected = opts.selected end
  local env = Stubs.boot({
    setup = setup,
    pluginDir = opts.pluginDir,
    tmp = TMP,
    strictTasks = opts.strictTasks,
    switchDelay = opts.switchDelay,
    clock = opts.clock,
    config = opts.config,
    watch = opts.watch,
    noStart = opts.noStart,
    connect = opts.connect,
  })
  if opts.keepEvents ~= true then env.clearEvents() end
  return env
end

local PRESETS = {
  { uuid = 'A1B2C3D4E5F60718293A4B5C6D7E8F90', name = 'Classic Chrome', folder = 'Cobalt Fuji' },
  { uuid = '0F1E2D3C4B5A69788796A5B4C3D2E1F0', name = 'Velvia', folder = 'Cobalt Fuji' },
  { uuid = 'CCCC0000CCCC0000CCCC0000CCCC0000', name = 'Punchy', folder = 'User Presets' },
}

-- json --------------------------------------------------------------------------

test('json round-trips objects, arrays and escapes', function()
  local json = boot({ connect = false }).json
  local src = { t = 'x', n = 1.5, s = 'a"b\n\\c', arr = { 1, 2, 3 }, nested = { k = 'v' }, yes = true, no = false }
  local back = json.decode(json.encode(src))
  eq(back.t, 'x'); eq(back.n, 1.5); eq(back.s, 'a"b\n\\c'); eq(#back.arr, 3); eq(back.arr[3], 3)
  eq(back.nested.k, 'v'); eq(back.yes, true); eq(back.no, false)
  eq(json.decode('"\\u00e9"'), '\195\169', 'unicode escape')
  eq(json.encode(1234567), '1234567')
end)

test('json handles null, empty objects and refuses bad values', function()
  local json = boot({ connect = false }).json
  eq(json.encode(json.object({})), '{}')
  eq(json.encode({}), '[]')
  eq(json.encode({ a = json.null }), '{"a":null}')
  eq(json.encode({ json.null, 1 }), '[null,1]')
  ok(not pcall(json.encode, { x = 0 / 0 }), 'NaN must not encode')
  ok(not pcall(json.encode, { [1] = 1, [3] = 3 }), 'sparse arrays must not encode')
  ok(not pcall(json.encode, { [1] = 1, a = 2 }), 'mixed keys must not encode')
  ok(not pcall(json.decode, '{bad'), 'bad JSON must not decode')
  eq(json.decode('{"a":null}').a, nil)
end)

-- The fake Lightroom behaves like 15.3 as measured -------------------------------

test('fake: onMessage cannot yield, metadata needs a task, LrTasks.pcall yields through', function()
  local env = boot({ connect = false })
  local LrTasks = env.M.LrTasks
  eq(LrTasks.canYield(), false, 'outside a task')
  ok(not pcall(LrTasks.sleep, 0.1), 'sleep outside a task fails')
  local okRead, err = pcall(function() return env.target:getRawMetadata('rating') end)
  ok(not okRead and string.find(err, 'within a task', 1, true), 'metadata outside a task: ' .. tostring(err))
  local log = {}
  LrTasks.startAsyncTask(function()
    log[#log + 1] = LrTasks.canYield()
    local okP, slept = LrTasks.pcall(function() LrTasks.sleep(0.5); return 'slept' end)
    log[#log + 1] = okP and slept
    log[#log + 1] = env.target:getRawMetadata('rating')
    local okPlain = pcall(function() LrTasks.sleep(0.1) end)
    log[#log + 1] = okPlain
  end, 'probe')
  eq(#log, 0, 'tasks start later, not at once')
  env.run()
  eq(log[1], true, 'tasks can yield'); eq(#log, 1, 'asleep')
  env.advance(0.5)
  eq(log[2], 'slept'); eq(log[3], 0); eq(log[4], false, 'plain pcall cannot yield')
  ok(not pcall(function() env.catalog:withWriteAccessDo('x', function() end, { timeout = 1 }) end), 'writes need a task')
end)

test('fake: the observer is silent while tracking, fires once after stopTracking, never for untracked sets', function()
  local env = boot({ connect = false })
  local Dev = env.M.LrDevelopController
  local fired = 0
  Dev.addAdjustmentChangeObserver(env.context, {}, function() fired = fired + 1 end)
  Dev.startTracking('Exposure')
  Dev.setValue('Exposure', 1); Dev.setValue('Exposure', 1.5)
  env.advance(1)
  eq(fired, 0, 'silent while tracking')
  Dev.stopTracking()
  env.advance(0.003); eq(fired, 0, 'not yet')
  env.advance(0.002); eq(fired, 1, 'once, about 4 ms after stopTracking')
  Dev.setValue('Exposure', 2)
  env.advance(1); eq(fired, 1, 'untracked sets never fire it')
  env.edit({ Contrast = 5 }); env.advance(0.1); eq(fired, 2, 'mouse edits do')
  Dev.setValue('Exposure', 99); eq(Dev.getValue('Exposure'), 99, 'setValue clamps nothing')
end)

test('fake: selection, ranges by format, resetToDefault and labels', function()
  local env = boot({ connect = false })
  local Dev = env.M.LrDevelopController
  eq(select(2, Dev.getRange('Temperature')), 50000); eq(Dev.getRange('Tint'), -150)
  env.select({ '104' })
  eq(Dev.getRange('Temperature'), -100, 'JPEG Temperature'); eq(select(2, Dev.getRange('Tint')), 100)
  env.select({ '101' })
  Dev.setValue('Temperature', 7000); Dev.setValue('Exposure', 2)
  Dev.resetToDefault('Temperature'); Dev.resetToDefault('Exposure')
  eq(Dev.getValue('Temperature'), 5500, 'as shot'); eq(Dev.getValue('Exposure'), 0)
  ok(not pcall(Dev.getRange, 'NoSuchSlider'), 'unknown params are rejected')
  env.select({})
  eq(env.catalog:getTargetPhoto(), nil); eq(#env.catalog:getTargetPhotos(), 4, 'the whole filmstrip')
  env.select({ '101' })
  env.M.LrTasks.startAsyncTask(function() env.label = env.target:getRawMetadata('colorNameForLabel') end)
  env.run()
  eq(env.label, 'gray', 'unlabelled reads as gray')
end)

-- Dispatch ------------------------------------------------------------------------

test('dispatch answers bad JSON, non-objects, missing t, unknown commands and failures with err codes', function()
  local env = boot()
  env.line('this is not json')
  local e = env.last('err'); eq(e.code, 'bad'); eq(e.cmd, nil); eq(e.id, nil); ok(e.msg, 'msg')
  env.line('[1, 2, 3]'); eq(env.last('err').code, 'bad', 'an array is not a command')
  env.line('{"id": 3}'); e = env.last('err'); eq(e.code, 'bad'); eq(e.id, 3)
  env.line('{"t": "ping", "id": "x"}'); e = env.last('err'); eq(e.code, 'bad'); eq(e.cmd, 'ping'); eq(e.id, nil)
  env.cmd({ t = 'explode', id = 4 }); e = env.last('err')
  eq(e.code, 'unknown'); eq(e.id, 4); eq(e.cmd, 'explode')
  package.loaded.Boom = { go = function() error('kaput') end }
  require('Dispatch').ROUTES.boom = { 'Boom', 'go', 'now' }
  env.cmd({ t = 'boom', id = 5 }); e = env.last('err')
  eq(e.code, 'failed'); eq(e.id, 5); eq(e.cmd, 'boom'); ok(string.find(e.msg, 'kaput'), 'error text')
  local before = #env.out
  env.line('   ')
  eq(#env.out, before, 'blank lines are ignored')
  env.cmd({ t = 'ping', id = 6, extra = { 1, 2 } }); eq(env.last('pong').id, 6, 'unknown fields are ignored')
  noErrors(env)
end)

test('ping answers pong with the same id and Lightroom time', function()
  local env = boot()
  env.cmd({ t = 'ping', id = 5 })
  local p = env.last('pong')
  eq(p.id, 5); eq(p.lt, env.clock.t)
  env.cmd({ t = 'ping' }); eq(env.last('pong').id, nil, 'no id, none in the reply')
end)

test('commands that must wait queue in order behind each other; ping does not wait', function()
  local env = boot({ module = 'library', switchDelay = 0.1 })
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 }) -- needs Develop: queued
  env.cmd({ t = 'set', p = 'Exposure', v = 2, g = 1 }) -- the queue is busy: queued behind
  env.cmd({ t = 'done', g = 1 })
  env.cmd({ t = 'ping', id = 9 })
  eq(#env.events('ack'), 0, 'nothing applied yet')
  eq(#env.events('pong'), 1, 'ping is answered at once')
  env.advance(0.5)
  local acks = env.events('ack')
  eq(#acks, 2); eq(acks[1].v, 1); eq(acks[2].v, 2)
  eq(env.target.values.Exposure, 2, 'the later set wins')
  eq(env.calls[#env.calls], 'stop', 'done ran after both sets')
  eq(env.count('start:'), 1, 'one gesture')
  eq(env.module, 'develop')
  noErrors(env)
end)

test('a command that needs a task is retried in the queue, and later ones queue too', function()
  -- Spike run 1: a handler that read photo metadata straight from onMessage failed with
  -- "We can only wait from within a task".
  local env = boot()
  local Dispatch, State = require 'Dispatch', require 'State'
  local runs = 0
  package.loaded.Needy = { go = function(m)
    env.target:getRawMetadata('rating') -- fails outside a task
    runs = runs + 1
    require('Server').send({ t = 'needy', n = m.n })
  end }
  Dispatch.ROUTES.needy = { 'Needy', 'go' }
  env.cmd({ t = 'needy', n = 1 })
  eq(runs, 1, 'retried in a task'); eq(#env.events('err'), 0, 'no err for the retry')
  ok(State.alwaysTask.needy, 'marked as needing a task')
  env.autoRun = false
  env.cmd({ t = 'needy', n = 2 })
  eq(runs, 1, 'the second one is queued, not run directly')
  env.run()
  eq(runs, 2); eq(env.last('needy').n, 2)
  noErrors(env)
end)

test('a set whose getRange turns out to need a task falls back to the queue, not to err bad', function()
  local env = boot()
  local getRange = env.M.LrDevelopController.getRange
  env.M.LrDevelopController.getRange = function(p)
    env.needTask()
    return getRange(p)
  end
  env.cmd({ t = 'set', p = 'Exposure', v = 0.5, g = 1 })
  eq(#env.events('err'), 0, 'no err'); eq(env.last('ack').v, 0.5, 'acked from the queue')
  ok(require('State').alwaysTask.set, 'later sets go through the queue')
  env.cmd({ t = 'set', p = 'Exposure', v = 0.6, g = 1 })
  eq(env.last('ack').v, 0.6); eq(env.count('start:'), 1, 'still one gesture')
  noErrors(env)
end)

-- Greeting --------------------------------------------------------------------------

test('a deck connecting gets hello v1, then state; in Develop with a watch list, ranges and vals', function()
  local env = boot({ watch = WATCH, keepEvents = true })
  eq(types(env), 'hello,state,ranges,vals')
  local h = env.events('hello')[1]
  eq(h.v, 1); eq(h.lr, '15.3'); eq(h.catalog, 'Plugin Test.lrcat'); eq(h.path, Stubs.TEST_CATALOG)
  eq(h.guard, 'on'); eq(h.writable, true); ok(type(h.inst) == 'string' and #h.inst > 4, 'inst')
  local st = env.events('state')[1]
  eq(st.module, 'develop'); eq(st.photo, '101'); eq(st.file, 'DSC0101.ARW'); eq(st.flag, 0)
  eq(st.rating, 0); eq(st.label, 'none'); eq(st.sel, 1)
  local r = env.events('ranges')[1].ranges
  eq(keys(r), 'Contrast,Exposure,Temperature,Tint'); eq(r.Temperature[2], 50000); eq(r.Tint[1], -150)
  local v = env.events('vals')[1].vals
  eq(v.Temperature, 5500); eq(v.Tint, 10); near(v.Exposure, 0.35); eq(v.Contrast, 0)
  noErrors(env)
end)

test('the greeting reads state inside a task, as Lightroom requires', function()
  -- Spike run 1: reading state in the socket callback failed with "We can only wait from
  -- within a task", so no state was ever sent.
  local env = boot({ keepEvents = true })
  eq(types(env), 'hello,state')
  eq(env.events('state')[1].file, 'DSC0101.ARW')
  ok(not env.logged('state read failed'), 'no failed state read')
  noErrors(env)
end)

test('hello answers hello and state; outside Develop no ranges or vals; a new inst per load', function()
  local env = boot({ module = 'library', watch = WATCH })
  env.cmd({ t = 'hello', v = 1, client = 'deck', ver = '0.1.0' })
  eq(types(env), 'hello,state')
  local inst = env.last('hello').inst
  ok(type(inst) == 'string' and #inst > 4, 'first inst')
  -- Real Lightroom's LrDate has a fraction that differs from load to load; the fake's
  -- clock starts on a whole second, so the second load starts a quarter second later.
  local env2 = boot({ module = 'library', clock = env.clock.t + 0.25 })
  env2.cmd({ t = 'hello', v = 1, client = 'deck', ver = '0.1.0' })
  local inst2 = env2.last('hello').inst
  ok(type(inst2) == 'string' and #inst2 > 4, 'second inst')
  ok(inst2 ~= inst, 'a new inst per load: ' .. inst .. ' twice')
  eq(env2.last('hello').inst, require('State').inst, 'hello carries this load\'s inst')
  env2.cmd({ t = 'hello', v = 2, client = 'deck', ver = '9' })
  eq(env2.last('hello').v, 1, 'still answers, with its own version')
  ok(env2.logged('protocol v2'), 'a version mismatch is logged')
end)

-- Retries -----------------------------------------------------------------------------

test('a state the server dropped is sent again on the next poll', function()
  local env = boot()
  local Server = require 'Server'
  Server.evtConnected = false -- e.g. between a client leaving and coming back
  env.target.flag = -1
  env.poll()
  Server.evtConnected = true
  env.clearEvents()
  env.poll()
  local st = env.last('state')
  ok(st, 'state resent once a client is back'); eq(st.flag, -1)
end)

test('values the server dropped are diffed again later', function()
  local env = boot({ watch = WATCH })
  local Develop, Server = require 'Develop', require 'Server'
  Server.evtConnected = false
  env.target.values.Contrast = 42
  env.advance(1)
  eq(Develop.pushValues(), false, 'push dropped')
  Server.evtConnected = true
  env.clearEvents()
  env.advance(1)
  eq(Develop.pushValues(), true, 'pushed once connected')
  eq(env.last('vals').vals.Contrast, 42)
end)

-- Guard ----------------------------------------------------------------------------------

test('the guard refuses set, reset, flag and preset outside the test catalog, and nothing changes', function()
  local env = boot({ catalog = '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat', module = 'library', presets = PRESETS })
  env.cmd({ t = 'hello', v = 1, client = 'deck', ver = '0.1.0' })
  local h = env.last('hello'); eq(h.writable, false); eq(h.catalog, 'Main.lrcat'); eq(h.guard, 'on')
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  env.cmd({ t = 'reset', p = 'Exposure' })
  env.cmd({ t = 'flag', v = 'pick', advance = true })
  env.cmd({ t = 'preset', id = 3, uuid = PRESETS[1].uuid })
  env.advance(1)
  local errs = env.events('err')
  eq(#errs, 4)
  for i, cmd in ipairs({ 'set', 'reset', 'flag', 'preset' }) do
    eq(errs[i].code, 'guard', cmd); eq(errs[i].cmd, cmd)
  end
  eq(errs[4].id, 3)
  eq(env.module, 'library', 'no switch to Develop'); near(env.target.values.Exposure, 0.35)
  eq(env.target.flag, 0); eq(next(env.applied), nil); eq(#env.events('ack'), 0)
  eq(#env.bezels, 1, 'one bezel for the burst'); ok(string.find(env.bezels[1].msg, 'writes are off', 1, true), 'bezel text')
  env.advance(5)
  env.cmd({ t = 'flag', v = 'pick' })
  eq(#env.bezels, 2, 'another bezel after 5 s')
  env.cmd({ t = 'nav', v = 'next' })
  eq(env.last('state').photo, '102', 'nav is not a write')
  env.cmd({ t = 'view', v = 'before' }); eq(env.view, 'before', 'view is not a write')
  noErrors(env)
end)

test('the guard compares the path without case, and off lets writes through anywhere', function()
  local env = boot({ catalog = string.upper(Stubs.TEST_CATALOG) })
  env.cmd({ t = 'hello', v = 1 })
  eq(env.last('hello').writable, true)
  env = boot({ catalog = '/elsewhere/Other.lrcat', config = { GUARD = false } })
  env.cmd({ t = 'hello', v = 1 })
  local h = env.last('hello'); eq(h.guard, 'off'); eq(h.writable, true)
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  eq(env.last('ack').v, 1)
end)

-- Server ---------------------------------------------------------------------------------

test('the server binds both listeners, on ephemeral ports only in tests', function()
  local env = boot({ connect = false })
  eq(env.latest(CMD).params.port, 0); eq(env.latest(EVT).params.port, 0)
  eq(env.bindsOf(CMD), 1); eq(env.bindsOf(EVT), 1)
  local Config = require 'Config'
  Config.CMD_PORT = 58780
  ok(not pcall(require('Server').bindRecv) or env.bindsOf(CMD) == 1, 'the fake refuses the real ports')
  ok(env.logged('bind failed'), 'and the failure is logged')
end)

test('a client dropping recreates the send socket and keeps listening', function()
  local env = boot()
  local Server = require 'Server'
  local cmdSock, oldSender = env.latest(CMD), env.latest(EVT)
  env.drop(CMD)
  eq(cmdSock.reconnects, 1, 'cmd socket listens again')
  ok(oldSender.closed, 'old send socket closed')
  eq(env.bindsOf(EVT), 2, 'one new send socket')
  -- The old sender's own onClosed arriving late must be ignored.
  oldSender.params.onClosed(oldSender)
  eq(env.bindsOf(EVT), 2, 'stale onClosed ignored')
  env.clearEvents()
  oldSender.params.onConnected(oldSender, oldSender.port)
  env.run()
  eq(#env.out, 0, 'no greeting from a stale socket'); eq(Server.evtConnected, false)
  env.connect(CMD)
  env.connect(EVT)
  eq(env.events()[1].t, 'hello', 'greeting after reconnect')
end)

test('an event-socket-only drop leaves the command socket alone', function()
  local env = boot()
  local cmdSock = env.latest(CMD)
  env.drop(EVT)
  eq(env.bindsOf(EVT), 2); eq(env.bindsOf(CMD), 1); eq(cmdSock.reconnects, 0)
  env.clearEvents()
  env.connect(EVT)
  eq(env.events()[1].t, 'hello')
  env.cmd({ t = 'ping', id = 1 })
  eq(env.last('pong').id, 1, 'commands still flow')
end)

test('a command-socket-only drop is survived', function()
  local env = boot()
  env.drop(CMD)
  env.connect(CMD)
  env.connect(EVT)
  env.clearEvents()
  env.cmd({ t = 'ping', id = 2 })
  eq(env.last('pong').id, 2)
end)

test('ten disconnect and reconnect cycles each get a fresh hello', function()
  local env = boot()
  for i = 1, 10 do
    env.drop(CMD)
    env.drop(EVT) -- usually stale by now; must not matter
    env.advance(1)
    env.clearEvents()
    env.connect(CMD)
    env.connect(EVT)
    eq(env.events()[1].t, 'hello', 'cycle ' .. i)
    env.cmd({ t = 'ping', id = i })
    eq(env.last('pong').id, i, 'cycle ' .. i)
  end
  noErrors(env)
end)

test('sending while disconnected drops and counts', function()
  local env = boot({ connect = false })
  local Server = require 'Server'
  eq(Server.send({ t = 'x' }), false)
  ok(Server.drops >= 1, 'drop counted')
  eq(#env.out, 0)
end)

test('send sockets that close as they bind are rebound from the poll loop, not recursively', function()
  -- Spike run 2: every new send socket reported closed at once, and rebinding from inside
  -- that callback recursed about 200 times, until Lua's C-stack limit stopped it.
  local env = boot()
  local Server = require 'Server'
  local binds0 = env.bindsOf(EVT)
  env.closeOnBind[EVT] = 1000 -- the storm: every new listener closes immediately
  env.drop(CMD) -- Lightroom closed the client connection itself
  ok(env.bindsOf(EVT) - binds0 <= 2, 'no recursive rebinding: ' .. (env.bindsOf(EVT) - binds0) .. ' binds')
  ok(Server.rebindSendAt, 'a rebind is scheduled instead')

  -- While the storm lasts, the poll loop rebinds at most every 0.5 s.
  for _ = 1, 10 do
    env.clock.t = env.clock.t + 0.1
    Server.tick()
  end
  local during = env.bindsOf(EVT) - binds0
  ok(during <= 4, 'paced rebinding while the storm lasts: ' .. during .. ' binds in 1 s')

  -- Once it's over, the next rebind sticks and a client gets its greeting.
  env.closeOnBind[EVT] = 0
  for _ = 1, 10 do
    env.clock.t = env.clock.t + 0.1
    Server.tick()
  end
  ok(not env.latest(EVT).closed, 'a live listener again')
  env.clearEvents()
  env.connect(CMD)
  env.connect(EVT)
  eq(env.events()[1].t, 'hello', 'greeting after the storm')
end)

test('a scheduled rebind leaves a connected client alone', function()
  local env = boot()
  local Server = require 'Server'
  env.drop(CMD) -- recreates the sender
  Server.recreateSender('second report of the same drop') -- too soon: scheduled
  ok(Server.rebindSendAt, 'scheduled')
  env.connect(CMD)
  env.connect(EVT)
  local binds = env.bindsOf(EVT)
  env.clock.t = env.clock.t + 1
  Server.tick()
  eq(env.bindsOf(EVT), binds, 'no rebind under a connected client')
  ok(Server.evtConnected, 'client still connected')
end)

test('a listener that fails to open is retried after 2 s', function()
  local env = boot({ noStart = true })
  env.bindFails[EVT] = 1
  local Server = require 'Server'
  env.startServer()
  eq(env.bindsOf(EVT), 0); ok(Server.rebindSendAt ~= nil, 'retry scheduled')
  Server.tick()
  eq(env.bindsOf(EVT), 0, 'not before 2 s')
  env.clock.t = env.clock.t + 2.1
  Server.tick()
  eq(env.bindsOf(EVT), 1, 'bound on retry')
  ok(env.logged('bind failed'), 'failure logged')
end)

test('timeouts keep the listeners listening', function()
  local env = boot({ connect = false })
  local cmdSock, evtSock = env.latest(CMD), env.latest(EVT)
  cmdSock.params.onError(cmdSock, 'timeout')
  evtSock.params.onError(evtSock, 'timeout')
  eq(cmdSock.reconnects, 1); eq(evtSock.reconnects, 1)
  eq(env.bindsOf(EVT), 1, 'no rebind on timeout')
end)

-- set and gestures -----------------------------------------------------------------------

test('set clamps to getRange, acks the value read back, and makes one tracked gesture', function()
  local env = boot({ watch = WATCH })
  env.cmd({ t = 'set', p = 'Exposure', v = 0.4, g = 1 })
  local a = env.last('ack'); eq(a.p, 'Exposure'); near(a.v, 0.4); eq(a.g, 1)
  env.cmd({ t = 'set', p = 'Exposure', v = 7.5, g = 1 })
  eq(env.last('ack').v, 5, 'clamped to the top of the range'); eq(env.target.values.Exposure, 5)
  env.cmd({ t = 'set', p = 'Exposure', v = -9, g = 1 })
  eq(env.last('ack').v, -5, 'and the bottom')
  eq(env.count('start:'), 1, 'one startTracking for the gesture'); eq(env.tracking, 'Exposure')
  env.select({ '104' })
  env.cmd({ t = 'set', p = 'Temperature', v = 300, g = 2 })
  eq(env.last('ack').v, 100, 'a JPEG clamps Temperature to -100..100')
  env.cmd({ t = 'done', g = 2 })
  eq(env.tracking, nil)
  noErrors(env)
end)

test('set refuses missing or wrong fields and unknown params with err bad, and tracks nothing', function()
  local env = boot()
  local cases = {
    { t = 'set', v = 1, g = 1 },
    { t = 'set', p = 5, v = 1, g = 1 },
    { t = 'set', p = 'Exposure', g = 1 },
    { t = 'set', p = 'Exposure', v = '1', g = 1 },
    { t = 'set', p = 'Exposure', v = 1 },
    { t = 'set', p = 'NoSuchSlider', v = 1, g = 1 },
  }
  for i, c in ipairs(cases) do
    env.clearEvents()
    env.cmd(c)
    local e = env.last('err')
    ok(e, 'case ' .. i .. ' answers err'); eq(e.code, 'bad', 'case ' .. i); eq(e.cmd, 'set', 'case ' .. i)
  end
  eq(env.count('start:'), 0, 'nothing tracked'); eq(env.count('set:'), 0, 'nothing set')
  env.line('{"t":"set","p":"Exposure","v":1e999,"g":1}')
  eq(env.last('err').code, 'bad', 'infinity is not a number we set')
  noErrors(env)
end)

test('set and reset in Develop with no target photo answer noPhoto, not bad', function()
  local env = boot()
  env.select({}) -- getRange then fails for every param: there's no photo to answer for
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  local e = env.last('err'); eq(e.code, 'noPhoto'); eq(e.cmd, 'set')
  env.cmd({ t = 'reset', id = 3, p = 'Exposure' })
  e = env.last('err'); eq(e.code, 'noPhoto'); eq(e.cmd, 'reset'); eq(e.id, 3)
  eq(env.count('start:'), 0, 'nothing tracked'); eq(env.count('set:'), 0); eq(env.count('reset:'), 0)
  env.select({ '101' })
  env.cmd({ t = 'set', p = 'NoSuchSlider', v = 1, g = 1 }); eq(env.last('err').code, 'bad', 'an unknown param is still bad')
  env.cmd({ t = 'reset', p = 'NoSuchSlider' }); eq(env.last('err').code, 'bad')
  noErrors(env)
end)

test('a target-photo read that needs a task moves set to the queue; noPhoto still answers', function()
  -- Spike run 1 found getValue and getPath working in onMessage; getTargetPhoto wasn't
  -- tried there. If it needs a task, set falls back to the queue, as for getRange.
  local env = boot()
  local get = env.catalog.getTargetPhoto
  env.catalog.getTargetPhoto = function(self) env.needTask(); return get(self) end
  env.cmd({ t = 'set', p = 'Exposure', v = 0.5, g = 1 })
  eq(#env.events('err'), 0, 'no err'); near(env.last('ack').v, 0.5, 'acked from the queue')
  ok(require('State').alwaysTask.set, 'later sets go through the queue')
  eq(require('State').gesture.photo, '101')
  env.cmd({ t = 'done', g = 1 })
  env.select({})
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 2 })
  eq(env.last('err').code, 'noPhoto')
  eq(env.count('start:'), 1, 'one gesture')
  noErrors(env)
end)

-- The startTracking and stopTracking calls so far, in order.
local function tracking(env)
  local seq = {}
  for _, c in ipairs(env.calls) do
    if c == 'stop' or string.find(c, '^start:') then seq[#seq + 1] = c end
  end
  return table.concat(seq, ' ')
end

test('a set for another param or gesture ends the open gesture and starts a new one', function()
  local env = boot()
  env.cmd({ t = 'set', p = 'Exposure', v = 0.5, g = 1 })
  env.cmd({ t = 'set', p = 'Contrast', v = 10, g = 2 }) -- p and g differ
  env.cmd({ t = 'set', p = 'Contrast', v = 12, g = 3 }) -- g differs
  env.cmd({ t = 'set', p = 'Contrast', v = 14, g = 3 }) -- the same gesture
  eq(tracking(env), 'start:Exposure stop start:Contrast stop start:Contrast')
  env.cmd({ t = 'set', p = 'Exposure', v = 0.6, g = 3 }) -- p differs, g the same
  eq(tracking(env), 'start:Exposure stop start:Contrast stop start:Contrast stop start:Exposure')
  eq(env.count('untracked:'), 0, 'every set ran inside its own gesture')
  local State = require 'State'
  eq(State.gesture.p, 'Exposure'); eq(State.gesture.g, 3); eq(env.tracking, 'Exposure')
end)

test('done ends the gesture; a done for an earlier gesture is ignored', function()
  local env = boot()
  local State = require 'State'
  env.cmd({ t = 'set', p = 'Exposure', v = 0.5, g = 4 })
  env.cmd({ t = 'done', g = 3 })
  eq(env.tracking, 'Exposure', 'late done ignored'); ok(State.gesture, 'still open')
  env.cmd({ t = 'done', g = 'x' }); eq(env.last('err').code, 'bad')
  env.cmd({ t = 'done' })
  eq(env.tracking, nil, 'done without g ends whatever is open'); eq(State.gesture, nil)
  env.cmd({ t = 'done', g = 4 })
  eq(env.count('stop'), 1, 'nothing to end')
end)

test('a gesture ends by itself after 2 s without a set, and vals carry its final value', function()
  local env = boot({ watch = WATCH })
  env.cmd({ t = 'set', p = 'Tint', v = 25, g = 7 })
  for _ = 1, 9 do env.step() end -- 1.8 s
  eq(env.tracking, 'Tint', 'still open after 1.8 s')
  eq(#env.events('vals'), 0, 'no vals for Tint while it runs')
  env.step(); env.step()
  eq(env.tracking, nil, 'ended after 2 s')
  local v = env.last('vals'); ok(v and v.vals.Tint == 25, 'final value reported')
  noErrors(env)
end)

test('the deck disconnecting ends an open gesture', function()
  local env = boot()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  eq(env.tracking, 'Exposure')
  env.drop(CMD)
  eq(env.tracking, nil, 'stopTracking on disconnect'); eq(require('State').gesture, nil)
end)

test('a set that lands on a new photo before the poll notices keeps its one gesture', function()
  -- The user changes photo and turns a dial straight away: the set arrives before the
  -- observer task or the poll has seen the new photo. Its gesture started on the new
  -- photo, so the poll must leave it open, or one dial gesture makes two history steps.
  local env = boot({ watch = WATCH })
  env.select({ '102' }) -- the observer fires a few ms later
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 5 })
  eq(tracking(env), 'start:Exposure')
  env.step() -- the observer and the poll see 102
  eq(env.last('state').photo, '102')
  env.cmd({ t = 'set', p = 'Exposure', v = 1.1, g = 5 })
  env.step()
  eq(tracking(env), 'start:Exposure', 'still one gesture'); eq(env.tracking, 'Exposure')
  for _, m in ipairs(env.events('vals')) do eq(m.vals.Exposure, nil, 'Exposure left out while tracked') end
  env.cmd({ t = 'done', g = 5 })
  eq(tracking(env), 'start:Exposure stop')
  near(env.byId['102'].values.Exposure, 1.1); near(env.byId['101'].values.Exposure, 0.35)
  noErrors(env)
end)

test('a gesture belongs to its photo: a set after the user changed photo starts a new one', function()
  local env = boot({ watch = WATCH })
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 5 })
  env.select({ '102' })
  env.cmd({ t = 'set', p = 'Exposure', v = 1.2, g = 5 }) -- before the poll sees 102
  eq(tracking(env), 'start:Exposure stop start:Exposure', 'ended on 101, started on 102')
  env.step()
  env.cmd({ t = 'set', p = 'Exposure', v = 1.3, g = 5 })
  env.step()
  eq(tracking(env), 'start:Exposure stop start:Exposure', 'and the poll leaves the new one open')
  eq(require('State').gesture.photo, '102')
  near(env.byId['101'].values.Exposure, 1); near(env.byId['102'].values.Exposure, 1.3)
  eq(env.count('untracked:'), 0)
  noErrors(env)
end)

test('vals leave out the tracked param, from the poll and the observer, until the gesture ends', function()
  local env = boot({ watch = WATCH })
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  env.edit({ Contrast = 7 }) -- a mouse edit while the dial turns
  env.step(); env.step()
  for _, m in ipairs(env.events('vals')) do
    eq(m.vals.Exposure, nil, 'Exposure left out while tracked')
  end
  eq(env.last('vals').vals.Contrast, 7, 'other params still flow')
  env.cmd({ t = 'done', g = 1 })
  env.step()
  eq(env.last('vals').vals.Exposure, 1, 'final value after done')
  noErrors(env)
end)

test('set outside Develop switches to Develop first; err noDevelop when it cannot', function()
  local env = boot({ module = 'library', switchDelay = 0.05 })
  env.cmd({ t = 'set', p = 'Shadows', v = 30, g = 1 })
  env.advance(0.3)
  eq(env.module, 'develop'); eq(env.last('ack').v, 30)
  env = boot({ module = 'library' })
  env.M.LrApplicationView.switchToModule = function() end -- Lightroom ignores the switch
  env.cmd({ t = 'set', p = 'Shadows', v = 30, g = 1 })
  env.advance(1.5)
  eq(env.last('err').code, 'noDevelop'); eq(#env.events('ack'), 0)
  noErrors(env)
end)

-- reset ------------------------------------------------------------------------------------

test('reset ends any gesture, resets to the default and acks without g', function()
  local env = boot({ watch = WATCH })
  env.cmd({ t = 'set', p = 'Contrast', v = 40, g = 1 })
  env.cmd({ t = 'reset', p = 'Exposure' })
  local a = env.last('ack'); eq(a.p, 'Exposure'); eq(a.v, 0); eq(a.g, nil, 'no g after reset')
  eq(env.tracking, nil, 'the Contrast gesture ended')
  env.target.values.Temperature = 7100
  env.cmd({ t = 'reset', p = 'Temperature' })
  eq(env.last('ack').v, 5500, 'Temperature resets to as shot')
  env.cmd({ t = 'reset', p = 'Bogus' }); eq(env.last('err').code, 'bad')
  env.cmd({ t = 'reset' }); eq(env.last('err').code, 'bad')
  noErrors(env)
end)

-- watch, vals and ranges ---------------------------------------------------------------------

test('watch answers ranges and every watched value, then only changes', function()
  local env = boot()
  env.cmd({ t = 'watch', ps = { 'Exposure', 'Contrast', 'Exposure' } })
  eq(types(env), 'ranges,vals')
  eq(keys(env.last('ranges').ranges), 'Contrast,Exposure', 'duplicates dropped')
  eq(keys(env.last('vals').vals), 'Contrast,Exposure')
  env.clearEvents()
  env.step()
  eq(#env.events('vals'), 0, 'no change, no vals')
  env.target.values.Contrast = 3 -- changed without the observer
  env.step()
  eq(keys(env.last('vals').vals), 'Contrast', 'the value poll finds it, and only it')
  env.clearEvents()
  env.cmd({ t = 'watch', ps = {} })
  eq(#env.out, 0, 'an empty watch list sends nothing')
  env.cmd({ t = 'watch', ps = 'Exposure' }); eq(env.last('err').code, 'bad')
  env.cmd({ t = 'watch', ps = { a = 1 } }); eq(env.last('err').code, 'bad')
end)

test('watch drops unknown params with err bad; outside Develop they are checked on entering it', function()
  local env = boot()
  env.cmd({ t = 'watch', id = 20, ps = { 'Exposure', 'NoSuchSlider', 7 } })
  local errs = env.events('err'); eq(#errs, 2)
  for _, e in ipairs(errs) do eq(e.code, 'bad'); eq(e.cmd, 'watch'); eq(e.id, 20) end
  eq(table.concat(require('State').watched, ','), 'Exposure')
  eq(keys(env.last('vals').vals), 'Exposure')

  env = boot({ module = 'library' })
  env.cmd({ t = 'watch', id = 21, ps = { 'Exposure', 'NoSuchSlider' } })
  eq(#env.out, 0, 'no ranges, vals or err outside Develop')
  env.cmd({ t = 'module', v = 'develop' })
  eq(types(env), 'state,err,ranges,vals')
  local e = env.last('err')
  eq(e.code, 'bad'); eq(e.cmd, 'watch'); eq(e.id, 21, 'the err carries the watch command\'s id')
  eq(keys(env.last('vals').vals), 'Exposure')
  noErrors(env)
end)

-- Makes getRange and getValue (or just those in which) fail for secs after every module
-- switch and photo change, the way they could while Develop is still loading the photo.
local function loadingWindow(env, secs, which)
  local Dev, View = env.M.LrDevelopController, env.M.LrApplicationView
  local busyUntil = -1
  local switch, select = View.switchToModule, env.select
  View.switchToModule = function(name) switch(name); busyUntil = env.clock.t + secs end
  env.select = function(ids) select(ids); busyUntil = env.clock.t + secs end
  for _, fn in ipairs(which or { 'getRange', 'getValue' }) do
    local real = Dev[fn]
    Dev[fn] = function(p)
      if env.clock.t < busyUntil then error('LrDevelopController.' .. fn .. ': the photo is still loading') end
      return real(p)
    end
  end
end

test('ranges and vals Lightroom could not read on entering Develop follow on a later poll', function()
  -- The deck marks every value stale on a module or photo change and holds its dials
  -- until fresh vals arrive, so a push that found nothing must be retried.
  local env = boot({ module = 'library', watch = WATCH })
  loadingWindow(env, 0.1)
  env.cmd({ t = 'module', v = 'develop' })
  eq(types(env), 'state', 'Develop is still loading: state only')
  env.step()
  eq(types(env), 'state,ranges,vals', 'the ranges and vals the deck is owed follow')
  eq(keys(env.last('ranges').ranges), 'Contrast,Exposure,Temperature,Tint')
  local v = env.last('vals').vals
  eq(keys(v), 'Contrast,Exposure,Temperature,Tint'); eq(v.Temperature, 5500); near(v.Exposure, 0.35)
  env.clearEvents()
  for _ = 1, 5 do env.step() end
  eq(#env.out, 0, 'and nothing repeats once they are through')
  noErrors(env)
end)

test('a new photo gets its vals even when they equal the last photo\'s and the first read failed', function()
  -- 101 and 102 have the same values. A plain diff against what was sent for 101 would
  -- never send them once the first push after the change found nothing.
  local env = boot({ watch = WATCH })
  loadingWindow(env, 0.3, { 'getValue' })
  env.advance(0.1)
  env.clearEvents()
  env.select({ '102' })
  env.step()
  eq(types(env), 'state,ranges', 'the values could not be read yet')
  env.step()
  eq(types(env), 'state,ranges,vals')
  local v = env.last('vals').vals
  eq(keys(v), 'Contrast,Exposure,Temperature,Tint'); eq(v.Temperature, 5500); near(v.Exposure, 0.35)
  noErrors(env)
end)

test('a watched param whose range never comes does not make ranges repeat', function()
  local env = boot({ watch = WATCH })
  local getRange = env.M.LrDevelopController.getRange
  env.M.LrDevelopController.getRange = function(p)
    if p == 'Contrast' and env.target.id == '102' then error('LrDevelopController.getRange: no range') end
    return getRange(p)
  end
  env.select({ '102' })
  for _ = 1, 10 do env.step() end
  local ranges = env.events('ranges')
  eq(#ranges, 1, 'one ranges message in 2 s'); eq(keys(ranges[1].ranges), 'Exposure,Temperature,Tint')
  eq(#env.events('vals'), 1, 'and one vals'); eq(keys(env.last('vals').vals), 'Contrast,Exposure,Temperature,Tint')
  env.select({ '101' }) -- Contrast has a range again
  env.step()
  eq(keys(env.last('ranges').ranges), 'Contrast,Exposure,Temperature,Tint')
  noErrors(env)
end)

test('vals come from the observer and the value poll, in Develop only', function()
  local env = boot({ watch = WATCH })
  env.advance(0.1) -- past the rate limit after the greeting's vals
  env.edit({ Exposure = 0.8 })
  env.advance(0.01) -- the observer, before any poll
  eq(env.last('vals').vals.Exposure, 0.8, 'the observer reported the mouse edit')
  env.clearEvents()
  env.setModule('library')
  env.target.values.Exposure = 1.2
  env.step(); env.step()
  eq(#env.events('vals'), 0, 'never outside Develop'); eq(#env.events('ranges'), 0)
  eq(env.last('state').module, 'library')
  noErrors(env)
end)

-- The most vals sent within any one second.
local function valsPerSecond(env)
  local times = {}
  for i, line in ipairs(env.out) do
    if string.find(line, '"t":"vals"', 1, true) then times[#times + 1] = env.outAt[i] end
  end
  local most = 0
  for i = 1, #times do
    local n = 0
    for j = i, #times do
      if times[j] - times[i] < 1 - 1e-6 then n = n + 1 end
    end
    if n > most then most = n end
  end
  return most
end

test('vals go out at most 20 a second, and the last change always follows', function()
  local env = boot({ watch = WATCH })
  env.clearEvents()
  for i = 1, 150 do -- a mouse drag: the observer fires every 10 ms for 1.5 s
    env.edit({ Exposure = i / 100 })
    env.advance(0.01)
    if i % 20 == 0 then env.poll() end -- the value poll joins in
  end
  env.advance(0.2)
  local most = valsPerSecond(env)
  ok(most <= 20, most .. ' vals within one second')
  ok(most >= 15, 'but not throttled further: ' .. most)
  near(env.last('vals').vals.Exposure, 1.5, 'the last value arrives')
  noErrors(env)
end)

test('every-value vals keep to 20 a second too, and the last photo still gets all of its values', function()
  -- PROTOCOL.md, Rates: vals at most 20 a second, with no exemption for the pushes of
  -- every watched value that follow a photo change.
  local env = boot({ watch = WATCH })
  env.advance(0.1)
  env.clearEvents()
  local ids = { '101', '104' }
  for i = 1, 40 do -- the photo changes every 30 ms, say with an arrow key held down
    env.select({ ids[i % 2 + 1] })
    env.advance(0.03)
    if i % 7 == 0 then env.poll() end
  end
  env.advance(0.3)
  env.poll()
  local most = valsPerSecond(env)
  ok(most <= 20, most .. ' vals within one second')
  local events, last = env.events(), nil
  for i, m in ipairs(events) do
    if m.t == 'state' then last = i end
  end
  eq(events[last].photo, env.target.id, 'the last state is for the last photo')
  local got = {}
  for i = last + 1, #events do
    if events[i].t == 'vals' then
      for p, v in pairs(events[i].vals) do got[p] = v end
    end
  end
  eq(keys(got), 'Contrast,Exposure,Temperature,Tint', 'every value after that state')
  for p, v in pairs(got) do near(v, env.target.values[p], p) end
  noErrors(env)
end)

test('a new photo brings state, then ranges for its file type, then every watched value', function()
  local env = boot({ watch = WATCH })
  env.select({ '104' }) -- the observer fires first, in a burst
  env.step()
  eq(types(env), 'state,ranges,vals')
  eq(env.last('state').photo, '104'); eq(env.last('state').file, 'IMG0104.JPG')
  local r = env.last('ranges').ranges; eq(r.Temperature[1], -100); eq(r.Tint[2], 100)
  local v = env.last('vals').vals; eq(v.Temperature, 0); eq(v.Contrast, 5); eq(keys(v), 'Contrast,Exposure,Temperature,Tint')
  noErrors(env)
end)

test('a new photo ends an open gesture, and its vals include that param', function()
  local env = boot({ watch = WATCH })
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  env.select({ '102' })
  env.step()
  eq(env.tracking, nil); eq(require('State').gesture, nil)
  ok(env.last('vals').vals.Exposure ~= nil, 'Exposure included')
end)

test('an observer handler that throws stays inside the plugin, logged once', function()
  -- After a hot reload, a bug in onAdjustment must not escape into Lightroom's callback,
  -- which fires 73 times for one photo change.
  local env = boot({ watch = WATCH })
  local Develop = require 'Develop'
  local real = Develop.onAdjustment
  Develop.onAdjustment = function() error('a broken reload') end
  env.edit({ Exposure = 0.9 })
  env.select({ '102' }) -- a burst of callbacks
  env.advance(0.1)
  eq(#env.callbackErrors, 0, 'Lightroom saw: ' .. table.concat(env.callbackErrors, '; '))
  local n = 0
  for _, line in ipairs(env.logs) do
    if string.find(line, 'adjustment observer failed', 1, true) then n = n + 1 end
  end
  eq(n, 1, 'one log line for the burst')
  Develop.onAdjustment = real
  env.edit({ Exposure = 1.1 })
  env.advance(0.1)
  near(env.last('vals').vals.Exposure, 1.1, 'the observer works again once its handler does')
  noErrors(env)
end)

-- state ---------------------------------------------------------------------------------------

test('state carries module, photo, file, flag, rating, label and sel, with labels normalized', function()
  local env = boot()
  env.select({ '102', '103' })
  env.step()
  local st = env.last('state')
  eq(st.photo, '102'); eq(st.rating, 2); eq(st.label, 'red'); eq(st.sel, 2); eq(st.flag, 0)
  env.byId['102'].label = 'Purple'; env.step(); eq(env.last('state').label, 'purple')
  env.byId['102'].label = 'none'; env.unlabelled = ''; env.step(); eq(env.last('state').label, 'none')
  env.byId['102'].label = 'none'; env.unlabelled = 'gray'; env.byId['102'].rating = 3; env.step()
  eq(env.last('state').label, 'none', 'gray is no label'); eq(env.last('state').rating, 3)
  env.clearEvents()
  env.step()
  eq(#env.events('state'), 0, 'no change, no state')
  env.select({})
  env.step()
  ok(string.find(env.out[#env.out], '"photo":null', 1, true), 'no photo encodes as null')
  st = env.last('state'); eq(st.sel, 0); eq(st.file, nil); eq(st.flag, 0)
  noErrors(env)
end)

-- flag, nav, module, view ------------------------------------------------------------------------

test('flag sets the flag and answers state; advance moves on unless Auto Advance already did', function()
  local env = boot({ module = 'library' })
  env.cmd({ t = 'flag', v = 'none' })
  eq(#env.events('state'), 1, 'state answers even when nothing changed')
  env.cmd({ t = 'flag', v = 'pick' })
  local st = env.last('state'); eq(st.photo, '101'); eq(st.flag, 1)
  env.cmd({ t = 'flag', v = 'reject', advance = true })
  env.advance(0.2)
  eq(env.byId['101'].flag, -1); eq(env.target.id, '102', 'advanced'); eq(env.last('state').photo, '102')
  eq(env.count('next'), 1)

  env = boot({ module = 'library', autoAdvance = true })
  env.cmd({ t = 'flag', v = 'pick', advance = true })
  env.advance(0.2)
  eq(env.byId['101'].flag, 1); eq(env.target.id, '102', 'moved once, by Lightroom')
  eq(env.count('next'), 0, 'no nextPhoto of our own')

  env.cmd({ t = 'flag', v = 'maybe' }); eq(env.last('err').code, 'bad')
  env.cmd({ t = 'flag', v = 'pick', advance = 'yes' }); eq(env.last('err').code, 'bad')
  env.select({})
  env.cmd({ t = 'flag', v = 'pick' }); eq(env.last('err').code, 'noPhoto')
  noErrors(env)
end)

test('nav moves to the next or previous photo and answers state', function()
  local env = boot({ watch = { 'Exposure' } })
  env.cmd({ t = 'nav', v = 'next' })
  eq(env.events()[1].t, 'state'); eq(env.events()[1].photo, '102')
  env.advance(0.1) -- vals keep to 20 a second, and the greeting's went out at this instant
  eq(types(env), 'state,ranges,vals', 'in Develop a new photo brings ranges and vals')
  env.cmd({ t = 'nav', v = 'prev' }); eq(env.last('state').photo, '101'); eq(env.target.id, '101')
  env.advance(0.1)
  env.clearEvents()
  env.cmd({ t = 'nav', v = 'prev' })
  env.advance(0.1)
  eq(types(env), 'state', 'at the first photo: state, unchanged, and no ranges or vals')
  env.cmd({ t = 'nav', v = 'up' }); eq(env.last('err').code, 'bad')
end)

test('module switches and answers state; in Develop ranges and vals, even if already there', function()
  local env = boot({ module = 'library', watch = WATCH, switchDelay = 0.05 })
  env.cmd({ t = 'module', v = 'develop' })
  env.advance(0.2)
  eq(types(env), 'state,ranges,vals'); eq(env.events()[1].module, 'develop')
  env.clearEvents()
  env.cmd({ t = 'module', v = 'develop' })
  env.advance(0.2)
  eq(types(env), 'state,ranges,vals', 'answered although nothing changed')
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  env.cmd({ t = 'module', v = 'library' })
  env.advance(0.2)
  env.step(); env.step()
  eq(env.calls[#env.calls - 1], 'stop', 'the gesture ended before leaving Develop')
  local seen = false
  for _, m in ipairs(env.events()) do
    if m.t == 'state' and m.module == 'library' then seen = true end
    if seen then ok(m.t == 'state', 'after leaving Develop only state, not ' .. m.t) end
  end
  ok(seen, 'state for Library')
  env.cmd({ t = 'module', v = 'map' }); eq(env.last('err').code, 'bad')
  noErrors(env)
end)

test('view before and after switch to Develop first and show the views', function()
  local env = boot({ module = 'library', switchDelay = 0.05 })
  env.cmd({ t = 'view', v = 'before' })
  env.advance(0.2)
  eq(env.module, 'develop'); eq(env.view, 'before'); eq(env.last('state').module, 'develop')
  env.cmd({ t = 'view', v = 'after' })
  env.advance(0.2)
  eq(env.view, 'loupe'); eq(table.concat(env.views, ' '), 'develop_before develop_loupe')
  env.cmd({ t = 'view', v = 'side' }); eq(env.last('err').code, 'bad')
  noErrors(env)
end)

-- presets -------------------------------------------------------------------------------------------

test('presets lists every Develop preset as uuid, name and folder, in folder order', function()
  local env = boot({ presets = PRESETS })
  env.cmd({ t = 'presets', id = 5 })
  local p = env.last('presets'); eq(p.id, 5); eq(#p.items, 3)
  eq(p.items[1].uuid, PRESETS[1].uuid); eq(p.items[1].name, 'Classic Chrome'); eq(p.items[1].folder, 'Cobalt Fuji')
  eq(p.items[3].folder, 'User Presets')
  env = boot({ presets = {} })
  env.cmd({ t = 'presets', id = 6 })
  ok(string.find(env.out[#env.out], '"items":[]', 1, true), 'no presets: an empty list')
end)

test('preset applies to every target photo in one write, and skips locked photos', function()
  local setup = Stubs.defaultSetup()
  setup.photos[3].locked = true
  setup.presets = PRESETS
  local env = boot({ setup = setup, selected = { '101', '102', '103' } })
  env.cmd({ t = 'preset', id = 6, uuid = PRESETS[2].uuid })
  local a = env.last('applied')
  eq(a.id, 6); eq(a.uuid, PRESETS[2].uuid); eq(a.n, 2); eq(a.locked, 1)
  eq(#env.writes, 1, 'one catalog write'); eq(env.writes[1], 'Deck Bridge: apply preset')
  eq(env.applied['101'][1], PRESETS[2].uuid); eq(env.applied['102'][1], PRESETS[2].uuid); eq(env.applied['103'], nil)
  for _, photo in ipairs(env.photoList) do photo.isAvailableForEditing = nil end -- older Lightroom
  env.cmd({ t = 'preset', id = 7, uuid = PRESETS[1].uuid })
  eq(env.last('applied').n, 3, 'without isAvailableForEditing every photo is available')
  noErrors(env)
end)

test('preset answers noPhoto, notFound, bad and busy', function()
  local env = boot({ presets = PRESETS })
  env.cmd({ t = 'preset', id = 7, uuid = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' })
  local e = env.last('err'); eq(e.code, 'notFound'); eq(e.id, 7); eq(e.cmd, 'preset')
  env.cmd({ t = 'preset', id = 8 }); eq(env.last('err').code, 'bad')
  env.catalogBusy = true
  env.cmd({ t = 'preset', id = 9, uuid = PRESETS[1].uuid })
  eq(#env.events('applied'), 0, 'waiting for the catalog')
  env.advance(3.1)
  e = env.last('err'); eq(e.code, 'busy'); eq(e.id, 9); eq(next(env.applied), nil)
  env.catalogBusy = false
  env.select({})
  env.cmd({ t = 'preset', id = 10, uuid = PRESETS[1].uuid })
  eq(env.last('err').code, 'noPhoto', 'no target photo, although getTargetPhotos is the filmstrip')
  eq(next(env.applied), nil, 'nothing applied to the filmstrip')
  noErrors(env)
end)

-- reload --------------------------------------------------------------------------------------------

local function copyPlugin()
  local dir = mktemp()
  assert(os.execute('cp "' .. PLUGIN_DIR .. '"/*.lua "' .. dir .. '"') == 0, 'cp failed')
  return dir
end

local function edit(dir, name, from, to)
  local path = dir .. '/' .. name .. '.lua'
  local src = assert(readFile(path))
  local changed, n = string.gsub(src, from, to)
  assert(n >= 1, 'pattern not found in ' .. name .. '.lua: ' .. from)
  writeFile(path, changed)
end

test('reload swaps in new handlers and keeps the sockets, observer, watch list and gesture', function()
  local dir = copyPlugin()
  local env = boot({ pluginDir = dir, watch = WATCH })
  local State, Develop = require 'State', require 'Develop'
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  local sockets, observers, observer = #env.sockets, #env.observers, State.observer
  edit(dir, 'Develop', "t = 'ack', p = p,", "t = 'ack', reloaded = true, p = p,")
  edit(dir, 'Develop', 'State.obsCount = State.obsCount %+ 1', 'State.obsCount = State.obsCount + 1000')
  env.cmd({ t = 'reload', id = 11, mods = { 'Develop' } })
  local r = env.last('reloaded')
  eq(r.id, 11); eq(r.ok, true, tostring(r.msg)); eq(#r.mods, 1); eq(r.mods[1], 'Develop')
  eq(#env.sockets, sockets, 'no socket rebound'); ok(not env.latest(CMD).closed and not env.latest(EVT).closed, 'still open')
  eq(#env.observers, observers, 'no second observer'); eq(State.observer, observer)
  eq(table.concat(State.watched, ','), table.concat(WATCH, ','), 'watch list kept')
  eq(State.gesture.p, 'Exposure', 'gesture still open'); eq(env.tracking, 'Exposure'); eq(env.count('stop'), 0)
  ok(require('Develop') == Develop, 'the same module table')
  env.cmd({ t = 'set', p = 'Exposure', v = 1.5, g = 1 })
  local a = env.last('ack'); eq(a.reloaded, true, 'the new set runs'); eq(a.v, 1.5)
  eq(env.count('start:'), 1, 'the same gesture carried on')
  local before = State.obsCount
  env.cmd({ t = 'done', g = 1 })
  env.advance(0.1)
  ok(State.obsCount - before >= 1000, 'the observer registered before the reload calls the new code')
  env.cmd({ t = 'ping', id = 12 }); eq(env.last('pong').id, 12)
  noErrors(env)
end)

test('an observer that reloaded code registered still follows later reloads', function()
  -- Reloaded functions see their own fresh module table, not the one require hands out,
  -- so anything they register with Lightroom must look the module up when called.
  local dir = copyPlugin()
  local env = boot({ pluginDir = dir, module = 'library', watch = WATCH })
  local State = require 'State'
  edit(dir, 'Develop', 'State.obsCount = State.obsCount %+ 1', 'State.obsCount = State.obsCount + 1000')
  env.cmd({ t = 'reload', id = 1, mods = { 'Develop' } })
  eq(env.last('reloaded').ok, true)
  eq(State.observer, nil, 'no observer outside Develop')
  env.cmd({ t = 'module', v = 'develop' }) -- the reloaded code registers the observer
  ok(State.observer, 'registered')
  edit(dir, 'Develop', 'State.obsCount = State.obsCount %+ 1000', 'State.obsCount = State.obsCount + 1000000')
  env.cmd({ t = 'reload', id = 2, mods = { 'Develop' } })
  eq(env.last('reloaded').ok, true)
  local before = State.obsCount
  env.edit({ Exposure = 1 })
  env.advance(0.1)
  eq(State.obsCount - before, 1000000, 'the newest onAdjustment ran')
  noErrors(env)
end)

test('reload without mods reloads every reloadable module and keeps all state', function()
  local dir = copyPlugin()
  local env = boot({ pluginDir = dir, watch = WATCH, presets = PRESETS })
  local State = require 'State'
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  local snapshot = {}
  for k, v in pairs(State) do snapshot[k] = v end
  edit(dir, 'Core', "t = 'pong', id", "t = 'pong', twice = true, id")
  env.cmd({ t = 'reload', id = 1 })
  local r = env.last('reloaded'); eq(r.ok, true, tostring(r.msg))
  eq(table.concat(r.mods, ','), table.concat(require('Reload').MODULES, ','))
  for k, v in pairs(snapshot) do
    if type(v) == 'table' then eq(State[k], v, 'State.' .. k .. ' is the same table') end
  end
  eq(State.inst, snapshot.inst); eq(State.gesture, snapshot.gesture); eq(State.observer, snapshot.observer)
  env.cmd({ t = 'ping', id = 2 }); eq(env.last('pong').twice, true, 'new Core')
  env.cmd({ t = 'presets', id = 3 }); eq(#env.last('presets').items, 3, 'every route still works')
  env.cmd({ t = 'reload', id = 4 }); eq(env.last('reloaded').ok, true, 'and again')
  env.cmd({ t = 'nav', v = 'next' }); eq(env.last('state').photo, '102')
  noErrors(env)
end)

test('a broken module reloads nothing; Server and Guard never reload; bad mods answer err', function()
  local dir = copyPlugin()
  local env = boot({ pluginDir = dir })
  edit(dir, 'Core', "t = 'pong', id", "t = 'pong', broken = true, id")
  edit(dir, 'Library', 'local Library = {}', 'local Library = {')
  env.cmd({ t = 'reload', id = 1, mods = { 'Core', 'Library' } })
  local r = env.last('reloaded'); eq(r.ok, false); ok(string.find(r.msg, 'Library.lua', 1, true), r.msg)
  env.cmd({ t = 'ping', id = 2 }); eq(env.last('pong').broken, nil, 'Core was not swapped either')
  for _, name in ipairs({ 'Server', 'Guard', 'State', 'Config' }) do
    env.cmd({ t = 'reload', id = 3, mods = { name } })
    r = env.last('reloaded'); eq(r.ok, false, name); ok(string.find(r.msg, 'Reload Plug-in', 1, true), r.msg)
  end
  env.cmd({ t = 'reload', id = 4, mods = 'Core' }); eq(env.last('err').code, 'bad')
  env.cmd({ t = 'reload', id = 5, mods = { 1 } }); eq(env.last('err').code, 'bad')
  edit(dir, 'Library', 'local Library = {\n', 'local Library = {}\n')
  edit(dir, 'Presets', 'return Presets', 'return 42')
  env.cmd({ t = 'reload', id = 6, mods = { 'Presets' } })
  r = env.last('reloaded'); eq(r.ok, false); ok(string.find(r.msg, 'not a module table', 1, true), r.msg)
  noErrors(env)
end)

test('reload passes import and require in when a chunk cannot see them', function()
  local dir = copyPlugin()
  local env = boot({ pluginDir = dir })
  edit(dir, 'Core', "t = 'pong', id", "t = 'pong', injected = true, id")
  local realLoadstring = loadstring
  loadstring = function(s, name) -- an empty environment, as a sandbox might give
    local f, err = realLoadstring(s, name)
    if f then
      setfenv(f, { string = string, table = table, math = math, type = type, tostring = tostring,
        tonumber = tonumber, pairs = pairs, ipairs = ipairs, next = next, error = error,
        select = select, unpack = unpack, os = os, io = io, _PLUGIN = _PLUGIN })
    end
    return f, err
  end
  env.cmd({ t = 'reload', id = 1, mods = { 'Core' } })
  loadstring = realLoadstring
  local r = env.last('reloaded'); eq(r.ok, true, tostring(r.msg))
  env.cmd({ t = 'ping', id = 2 }); eq(env.last('pong').injected, true)
end)

test('reload can be switched off in Config', function()
  local env = boot({ config = { RELOAD = false } })
  env.cmd({ t = 'reload', id = 1 })
  local r = env.last('reloaded'); eq(r.ok, false); ok(string.find(r.msg, 'off', 1, true), r.msg)
end)

test('reload runs only while writes may: refused with another catalog open', function()
  -- Only the user lifts the guard, so new code arrives without Reload Plug-in only
  -- while the test catalog is open (or the user turned the guard off).
  local dir = copyPlugin()
  local env = boot({ pluginDir = dir, catalog = '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat' })
  edit(dir, 'Core', "t = 'pong', id", "t = 'pong', reloaded = true, id")
  env.cmd({ t = 'reload', id = 1, mods = { 'Core' } })
  local r = env.last('reloaded'); eq(r.ok, false); eq(r.id, 1); eq(r.mods[1], 'Core')
  ok(string.find(r.msg, "test catalog isn't open", 1, true), r.msg)
  env.cmd({ t = 'reload', id = 2 }); eq(env.last('reloaded').ok, false, 'nor without mods')
  env.cmd({ t = 'ping', id = 3 }); eq(env.last('pong').reloaded, nil, 'nothing swapped')
  require('Config').GUARD = false -- the user turned the guard off
  env.cmd({ t = 'reload', id = 4, mods = { 'Core' } })
  eq(env.last('reloaded').ok, true)
  env.cmd({ t = 'ping', id = 5 }); eq(env.last('pong').reloaded, true)
  noErrors(env)
end)

-- Info.lua, the Status menu and the spike files ------------------------------------------------

test('Info.lua names files that exist; the one menu item is Deck Bridge: Status; no spike files', function()
  local info = dofile(PLUGIN_DIR .. '/Info.lua')
  eq(info.LrToolkitIdentifier, 'com.karimdhanji.deckbridge')
  eq(info.LrForceInitPlugin, true)
  eq(#info.LrExportMenuItems, 1); eq(info.LrExportMenuItems[1].title, 'Deck Bridge: Status')
  eq(info.LrLibraryMenuItems, nil)
  local files = { info.LrInitPlugin, info.LrShutdownPlugin, info.LrShutdownApp, info.LrExportMenuItems[1].file }
  for _, f in ipairs(files) do
    ok(readFile(PLUGIN_DIR .. '/' .. f), f .. ' exists')
  end
  local v = info.VERSION
  eq(string.format('%d.%d.%d', v.major, v.minor, v.revision), dofile(PLUGIN_DIR .. '/Config.lua').VERSION, 'versions match')
  for _, name in ipairs({ 'Spike', 'SpikeTrigger', 'SpikeVersion', 'SpikeMenuTests', 'SpikeMenuAutoSync' }) do
    eq(readFile(PLUGIN_DIR .. '/' .. name .. '.lua'), nil, name .. '.lua is gone')
  end
  local p = io.popen('grep -lE "SpikeTrigger|SpikeVersion|SpikeMenu|require .Spike.|Spike\\.handlers|probe" "' .. PLUGIN_DIR .. '"/*.lua')
  local hits = p:read('*a'); p:close()
  eq(hits, '', 'no plugin file uses the spike modules or probes')
end)

test('the Status dialog shows the connection, guard, catalog, instance and version', function()
  local env = boot()
  local State, Config = require 'State', require 'Config'
  package.loaded.MenuStatus = nil
  require 'MenuStatus'
  env.run()
  local d = env.dialogs[#env.dialogs]
  ok(d, 'a dialog'); eq(d.message, 'Deck Bridge: Status'); eq(d.inTask, true, 'shown from a task')
  ok(string.find(d.info, 'Deck: connected', 1, true), d.info)
  ok(string.find(d.info, 'Guard: on. Writes go through', 1, true), d.info)
  ok(string.find(d.info, Stubs.TEST_CATALOG, 1, true), d.info)
  ok(string.find(d.info, State.inst, 1, true), 'instance')
  ok(string.find(d.info, Config.VERSION, 1, true), 'version')
  env.drop(CMD)
  env.catalog.path = '/Users/karimdhanji/Pictures/Lightroom/Main.lrcat'
  package.loaded.MenuStatus = nil
  require 'MenuStatus'
  env.run()
  d = env.dialogs[#env.dialogs]
  ok(string.find(d.info, 'Deck: ', 1, true) and not string.find(d.info, 'Deck: connected.', 1, true), d.info)
  ok(string.find(d.info, 'Writes are refused', 1, true), d.info)
  ok(string.find(d.info, 'Main.lrcat', 1, true), d.info)
end)

-- Lifecycle ---------------------------------------------------------------------------------------

test('Shutdown.lua stops, ends a gesture, closes the sockets and leaves a marker; no bye', function()
  local env = boot()
  local State = require 'State'
  env.cmd({ t = 'set', p = 'Exposure', v = 1, g = 1 })
  env.clearEvents()
  require 'Shutdown'
  eq(State.running, false); eq(env.tracking, nil, 'gesture ended')
  ok(string.find(readFile(TMP .. '/deckbridge-inst'), '^shutdown '), 'marker')
  ok(env.latest(CMD).closed and env.latest(EVT).closed, 'sockets closed')
  eq(#env.out, 0, 'nothing sent: v1 has no bye')
end)

test('ShutdownApp.lua calls doneFunction promptly; no bye', function()
  local env = boot()
  local State = require 'State'
  env.clearEvents()
  local t = require 'ShutdownApp'
  local doneCalls = 0
  t.LrShutdownFunction(function() doneCalls = doneCalls + 1 end, function() end)
  eq(doneCalls, 1); eq(State.running, false); eq(#env.out, 0)
end)

test('the main task binds, polls every 200 ms, serves and exits cleanly', function()
  local env = boot({ noStart = true })
  local State = require 'State'
  eq(env.mainTaskName, 'DeckBridge')
  env.startMainTask()
  env.run()
  eq(env.bindsOf(CMD), 1); eq(env.bindsOf(EVT), 1)
  env.connectBoth()
  eq(env.events()[1].t, 'hello', 'hello sent while running')
  local ticks = State.ticks
  env.advance(1)
  eq(State.ticks - ticks, 5, 'five polls a second')
  State.running = false
  env.advance(0.3)
  ok(env.latest(CMD).closed and env.latest(EVT).closed, 'sockets closed on exit')
  ok(env.logged('stopped: inst'), 'stop logged')
  noErrors(env)
end)

test('an instance stops when a newer one starts, or on its own shutdown marker', function()
  local env = boot()
  local Poll, State = require 'Poll', require 'State'
  eq(readFile(TMP .. '/deckbridge-inst'), State.inst)
  writeFile(TMP .. '/deckbridge-inst', string.format('shutdown %.3f', State.startedAt - 10))
  Poll.checkInstance()
  eq(State.running, true, 'an older marker is ignored')
  writeFile(TMP .. '/deckbridge-inst', string.format('shutdown %.3f', env.clock.t))
  Poll.checkInstance()
  eq(State.running, false, 'own marker stops it')
  State.running = true
  writeFile(TMP .. '/deckbridge-inst', 'someone-else')
  Poll.checkInstance()
  eq(State.running, false, 'a newer instance stops it')
end)

-- Logs --------------------------------------------------------------------------------------------------

test('logs stay quiet in normal use; Config.DEBUG adds per-command lines', function()
  local env = boot({ watch = WATCH, presets = PRESETS })
  local before = #env.logs
  for i = 1, 60 do
    env.cmd({ t = 'set', p = 'Exposure', v = i / 100, g = 1 })
    env.cmd({ t = 'ping', id = i })
    env.advance(0.033)
  end
  env.cmd({ t = 'done', g = 1 })
  env.cmd({ t = 'watch', ps = WATCH })
  env.cmd({ t = 'flag', v = 'pick' })
  env.cmd({ t = 'nav', v = 'next' })
  env.cmd({ t = 'presets', id = 1 })
  env.cmd({ t = 'preset', id = 2, uuid = PRESETS[1].uuid })
  env.edit({ Contrast = 9 })
  for _ = 1, 50 do env.step() end
  local added = {}
  for i = before + 1, #env.logs do added[#added + 1] = env.logs[i] end
  eq(#added, 0, 'log lines in normal use: ' .. table.concat(added, ' | '))

  -- With no deck, LrSocket times out every 10 s and the plugin listens again, which
  -- fires onConnecting again: a minute of that adds no line.
  env.drop(CMD)
  ok(env.logged('evt: listening on'), 'the new listener is announced once')
  local idle = #env.logs
  for _ = 1, 6 do
    env.advance(10)
    local cmd, evt = env.latest(CMD), env.latest(EVT)
    cmd.params.onError(cmd, 'timeout')
    evt.params.onError(evt, 'timeout')
    for _ = 1, 3 do env.poll() end
  end
  ok(env.latest(CMD).reconnects >= 6 and env.latest(EVT).reconnects >= 6, 'both listened again')
  added = {}
  for i = idle + 1, #env.logs do added[#added + 1] = env.logs[i] end
  eq(#added, 0, 'log lines while idle: ' .. table.concat(added, ' | '))

  require('Config').DEBUG = true
  env.cmd({ t = 'ping', id = 99 })
  ok(#env.logs > before, 'debug logs commands')
  noErrors(env)
end)

os.execute('rm -rf "' .. TMP .. '"')
print(string.format('unit tests: %d passed, %d failed', passed, failed))
if failed > 0 then
  os.exit(1)
end
