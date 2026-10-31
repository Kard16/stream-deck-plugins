-- DeckBridge unit tests: plain Lua 5.1.5 with fake Lr* modules (tests/stubs/lr.lua).
-- Run from the repo root: mise exec -- lua lightroom/lua/tests/run.lua
local here = string.match(debug.getinfo(1, 'S').source, '^@(.*)/[^/]*$') or '.'
local PLUGIN_DIR = here .. '/../DeckBridge.lrdevplugin'
package.path = PLUGIN_DIR .. '/?.lua;' .. here .. '/stubs/?.lua;' .. package.path

local Stubs = require 'lr'

local CMD, EVT = Stubs.CMD_PORT, Stubs.EVT_PORT

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

local function ok(v, what)
  if not v then error((what or 'expected a true value'), 2) end
end

local function count(list, pred)
  local n = 0
  for _, v in ipairs(list) do
    if pred(v) then n = n + 1 end
  end
  return n
end

local function writeFile(path, text)
  local f = assert(io.open(path, 'w'))
  f:write(text)
  f:close()
end

local function readFile(path)
  local f = io.open(path, 'r')
  if not f then return nil end
  local s = f:read('*a')
  f:close()
  return s
end

-- Loads the plugin as Init does, then performs the main task's setup without its loop.
local function boot(opts)
  opts = opts or {}
  local env = Stubs.reset({
    pluginDir = opts.pluginDir or PLUGIN_DIR,
    tmp = TMP,
    module = opts.module or 'develop',
    catalogPath = opts.catalogPath,
    photos = opts.photos,
    strictTasks = opts.strictTasks,
  })
  os.remove(TMP .. '/deckbridge-inst')
  os.remove(TMP .. '/deckbridge-trigger-tests')
  os.remove(TMP .. '/deckbridge-trigger-autosync')
  require 'Init'
  if opts.noStart then return env end
  local State = require 'State'
  State.context = env.context
  require('SpikeTrigger').clearStale()
  require('Poll').start()
  require('Server').start(env.context)
  if opts.connect ~= false then
    env.connectBoth()
  end
  return env
end

local function last(list)
  return list[#list]
end

-- json ------------------------------------------------------------------------

test('json round-trips objects, arrays and escapes', function()
  local json = Stubs.reset({ pluginDir = PLUGIN_DIR, tmp = TMP }).json
  local src = { t = 'x', n = 1.5, s = 'a"b\n\\c', arr = { 1, 2, 3 }, nested = { k = 'v' }, yes = true, no = false }
  local back = json.decode(json.encode(src))
  eq(back.t, 'x'); eq(back.n, 1.5); eq(back.s, 'a"b\n\\c'); eq(#back.arr, 3); eq(back.arr[3], 3)
  eq(back.nested.k, 'v'); eq(back.yes, true); eq(back.no, false)
  eq(json.decode('"\\u00e9"'), '\195\169', 'unicode escape')
  eq(json.encode(1234567), '1234567')
end)

test('json handles null, empty objects and refuses bad values', function()
  local json = Stubs.reset({ pluginDir = PLUGIN_DIR, tmp = TMP }).json
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

-- Dispatch --------------------------------------------------------------------

test('dispatch answers bad json, unknown commands and handler errors with err', function()
  local env = boot()
  env.clearEvents()
  env.line('not json')
  local e = last(env.events('err'))
  ok(e and string.find(e.msg, '^bad json'), 'bad json err')

  env.cmd({ t = 'nope', id = 3 })
  e = last(env.events('err'))
  eq(e.id, 3); eq(e.msg, 'unknown command'); eq(e.cmd, 'nope')

  env.line('[1,2]')
  eq(last(env.events('err')).msg, 'unknown command')

  require('Dispatch').register({ boom = { immediate = true, fn = function() error('kaput') end } })
  env.cmd({ t = 'boom', id = 4 })
  e = last(env.events('err'))
  eq(e.id, 4); eq(e.cmd, 'boom'); ok(string.find(e.msg, 'kaput'), 'error text')

  local before = #env.sentLog
  env.line('   ')
  eq(#env.sentLog, before, 'blank lines are ignored')
end)

test('ping answers pong with the same id', function()
  local env = boot()
  env.clearEvents()
  env.cmd({ t = 'ping', id = 5 })
  local p = last(env.events('pong'))
  eq(p.id, 5); eq(type(p.lt), 'number')
end)

test('commands that must yield queue in order behind each other', function()
  local env = boot({ module = 'library' })
  env.deferTasks = true
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, seq = 1 }) -- needs Develop: queued
  env.cmd({ t = 'set', p = 'Exposure', v = 2, seq = 2 }) -- queue busy: queued behind
  env.cmd({ t = 'done' })
  env.cmd({ t = 'ping', id = 9 }) -- immediate: answered now
  eq(#env.events('ack'), 0, 'nothing applied yet')
  eq(#env.events('pong'), 1, 'ping is immediate')
  env.runTasks()
  local acks = env.events('ack')
  eq(#acks, 2); eq(acks[1].seq, 1); eq(acks[2].seq, 2)
  eq(env.dev.values.Exposure, 2, 'the later set wins')
  eq(last(env.calls), 'stop', 'done ran after both sets')
  eq(acks[1].cy, true, 'queued handlers can yield')
  eq(env.module, 'develop')
  eq(#env.taskErrors, 0, table.concat(env.taskErrors, '; '))
end)

-- Greeting and guard -----------------------------------------------------------

test('connecting to the event port sends hello, state, then vals', function()
  local env = boot()
  local evs = env.events()
  eq(evs[1].t, 'hello'); eq(evs[2].t, 'state'); eq(evs[3].t, 'vals')
  local h = evs[1]
  eq(h.v, 0); eq(h.guard, 'on'); eq(h.writable, true); eq(h.catalog, 'Plugin Test.lrcat')
  eq(h.path, Stubs.TEST_CATALOG); ok(type(h.inst) == 'string' and #h.inst > 4, 'inst'); eq(type(h.gen), 'number')
  ok(string.find(h.lr, '15.3', 1, true), 'lr version')
  eq(evs[3].vals.Exposure, 0); eq(evs[3].vals.Temperature, 5500)
end)

test('the greeting reads state inside a task, as Lightroom requires', function()
  -- Live run 20261031-133539: reading state in the socket callback failed with
  -- "We can only wait from within a task", so no state was ever sent.
  local env = boot({ strictTasks = true })
  local evs = env.events()
  eq(evs[1].t, 'hello'); eq(evs[2].t, 'state'); eq(evs[3].t, 'vals')
  eq(evs[2].file, 'DSCF0001.RAF')
  ok(not env.logged('state read failed'), 'no failed state read')
end)

test('a state the server dropped is sent again on the next poll', function()
  local env = boot()
  local Poll, Server = require 'Poll', require 'Server'
  Poll.tick()
  Server.evtConnected = false -- e.g. between a client leaving and coming back
  env.catalog.target.meta.pickStatus = -1
  Poll.tick()
  Server.evtConnected = true
  env.clearEvents()
  Poll.tick()
  local st = last(env.events('state'))
  ok(st, 'state resent once a client is back'); eq(st.flag, -1)
end)

test('values the server dropped are diffed again later', function()
  local env = boot()
  local Develop, Server = require 'Develop', require 'Server'
  Server.evtConnected = false
  env.dev.values.Shadows = 42
  eq(Develop.pushValues(false), false, 'push dropped')
  Server.evtConnected = true
  env.clearEvents()
  eq(Develop.pushValues(false), true, 'pushed once connected')
  eq(last(env.events('vals')).vals.Shadows, 42)
end)

test('a command that needs a task is retried in the queue, and later ones queue too', function()
  local env = boot()
  local Dispatch = require 'Dispatch'
  local runs = 0
  Dispatch.register({ needy = { fn = function(m)
    if not env.canYield then error('We can only wait from within a task') end
    runs = runs + 1
    require('Server').send({ t = 'done-needy', n = m.n })
  end } })
  env.clearEvents()
  env.cmd({ t = 'needy', n = 1 })
  eq(runs, 1, 'retried in a task'); eq(#env.events('err'), 0, 'no err for the retry')
  ok(Dispatch.handlers.needy.alwaysTask, 'marked as needing a task')
  env.deferTasks = true
  env.cmd({ t = 'needy', n = 2 })
  eq(runs, 1, 'second one queued, not run directly')
  env.runTasks()
  eq(runs, 2); eq(last(env.events('done-needy')).n, 2)
end)

test('a trigger with no client is held, then sent when one connects', function()
  local env = boot()
  local Server, SpikeTrigger = require 'Server', require 'SpikeTrigger'
  Server.evtConnected = false
  SpikeTrigger.fire('tests')
  SpikeTrigger.consume()
  eq(#env.events('trigger'), 0, 'nothing sent yet')
  Server.evtConnected = true
  SpikeTrigger.consume()
  local trig = env.events('trigger')
  eq(#trig, 1); eq(trig[1].name, 'tests'); eq(trig[1].held, true)
  SpikeTrigger.consume()
  eq(#env.events('trigger'), 1, 'sent once')
end)

test('guard refuses writes outside the test catalog', function()
  local env = boot({ catalogPath = '/Users/karimdhanji/Pictures/Main/Main.lrcat' })
  eq(env.events('hello')[1].writable, false)
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, seq = 1 })
  local e = last(env.events('err'))
  eq(e.msg, 'guard'); eq(e.cmd, 'set'); eq(env.dev.values.Exposure, 0, 'value untouched')
  eq(#env.events('ack'), 0)
  ok(#env.bezels >= 1, 'bezel shown')

  env.cmd({ t = 'reset', p = 'Exposure' })
  eq(last(env.events('err')).cmd, 'reset')
  for _, name in ipairs({ 'mask', 'flagAdvance', 'autoSync' }) do
    env.cmd({ t = 'probe', id = 7, name = name })
    e = last(env.events('err'))
    eq(e.msg, 'guard', name); eq(e.id, 7, name)
  end
  eq(#env.events('result'), 0, 'guarded probes never ran')

  require('Config').GUARD = false
  env.cmd({ t = 'set', p = 'Exposure', v = 1, seq = 2 })
  eq(last(env.events('ack')).seq, 2, 'guard off lets writes through')
end)

test('guard compares the catalog path without case', function()
  local env = boot({ catalogPath = string.upper(Stubs.TEST_CATALOG) })
  eq(env.events('hello')[1].writable, true)
end)

-- Server ------------------------------------------------------------------------

test('server binds both listeners', function()
  local env = boot({ connect = false })
  eq(env.latest(CMD).mode, 'receive'); eq(env.latest(EVT).mode, 'send')
  eq(env.bindsOf(CMD), 1); eq(env.bindsOf(EVT), 1)
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
  -- Its onConnected too.
  env.clearEvents()
  oldSender.params.onConnected(oldSender, EVT)
  eq(#env.sentLog, 0, 'no greeting from a stale socket'); eq(Server.evtConnected, false)

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
  eq(last(env.events('pong')).id, 1, 'commands still flow')
end)

test('a command-socket-only drop is survived', function()
  local env = boot()
  env.drop(CMD)
  env.connect(CMD)
  env.connect(EVT)
  env.clearEvents()
  env.cmd({ t = 'ping', id = 2 })
  eq(last(env.events('pong')).id, 2)
end)

test('ten disconnect and reconnect cycles each get a fresh hello', function()
  local env = boot()
  for i = 1, 10 do
    env.drop(CMD)
    env.drop(EVT) -- usually stale by now; must not matter
    env.clock.t = env.clock.t + 1
    env.clearEvents()
    env.connect(CMD)
    env.connect(EVT)
    eq(env.events()[1].t, 'hello', 'cycle ' .. i)
    env.cmd({ t = 'ping', id = i })
    eq(last(env.events('pong')).id, i, 'cycle ' .. i)
  end
end)

test('sending while disconnected drops and counts', function()
  local env = boot({ connect = false })
  local Server = require 'Server'
  eq(Server.send({ t = 'x' }), false)
  ok(Server.drops >= 1, 'drop counted')
  eq(#env.sentLog, 0)
end)

test('a listener that fails to open is retried after 2 s', function()
  local env = Stubs.reset({ pluginDir = PLUGIN_DIR, tmp = TMP, module = 'develop' })
  env.bindFails[EVT] = 1
  require 'Init'
  local State, Server = require 'State', require 'Server'
  State.context = env.context
  Server.start(env.context)
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

-- Develop -------------------------------------------------------------------------

test('set replies ack and tracks once per param until done', function()
  local env = boot()
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 0.5, seq = 1 })
  local a = last(env.events('ack'))
  eq(a.seq, 1); eq(a.p, 'Exposure'); eq(a.v, 0.5); eq(type(a.ms), 'number'); eq(a.cy, false)
  env.cmd({ t = 'set', p = 'Exposure', v = 0.6, seq = 2 })
  env.cmd({ t = 'set', p = 'Contrast', v = 10, seq = 3 })
  eq(count(env.calls, function(c) return c == 'start:Exposure' end), 1)
  eq(count(env.calls, function(c) return c == 'start:Contrast' end), 1)
  env.cmd({ t = 'done' })
  eq(last(env.calls), 'stop'); eq(require('State').tracked, nil)
  env.cmd({ t = 'set', p = 'Exposure', v = 0.7, seq = 4 })
  eq(count(env.calls, function(c) return c == 'start:Exposure' end), 2, 'tracking restarts after done')
  env.cmd({ t = 'set', p = 'Exposure', v = 9, seq = 5 })
  eq(last(env.events('ack')).v, 5, 'Lightroom clamps; ack reports the real value')
  local starts = #env.calls
  env.cmd({ t = 'done' })
  env.cmd({ t = 'set', p = 'Exposure', v = 1, seq = 6, track = false })
  eq(#env.calls, starts + 1, 'track=false: stop only, no start')
end)

test('set outside Develop switches to Develop first', function()
  local env = boot({ module = 'library' })
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 0.25, seq = 1 })
  eq(env.module, 'develop'); eq(last(env.events('ack')).v, 0.25); eq(last(env.events('ack')).cy, true)
end)

test('an older set never overwrites a newer one', function()
  local env = boot()
  local Develop = require 'Develop'
  env.clearEvents()
  Develop.set({ t = 'set', p = 'Exposure', v = 2, seq = 2, _arrival = 20 })
  Develop.set({ t = 'set', p = 'Exposure', v = 1, seq = 1, _arrival = 10 })
  local a = last(env.events('ack'))
  eq(a.seq, 1); eq(a.stale, true); eq(env.dev.values.Exposure, 2)
end)

test('set with a bad value answers err', function()
  local env = boot()
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 'x', seq = 1 })
  eq(last(env.events('err')).cmd, 'set')
end)

test('get, range and reset', function()
  local env = boot()
  env.clearEvents()
  env.cmd({ t = 'range', id = 7, p = 'Temperature' })
  local r = last(env.events('range'))
  eq(r.id, 7); eq(r.min, 2000); eq(r.max, 50000)
  env.cmd({ t = 'set', p = 'Exposure', v = 1.5, seq = 1 })
  env.cmd({ t = 'get', id = 8, p = 'Exposure' })
  eq(last(env.events('val')).v, 1.5)
  env.cmd({ t = 'reset', p = 'Exposure' })
  eq(env.dev.values.Exposure, 0)
  env.cmd({ t = 'get', id = 9, p = 'Nonsense' })
  eq(last(env.events('err')).id, 9, 'unknown param answers err')
end)

test('watch pushes all watched params, then only changes', function()
  local env = boot()
  local Poll = require 'Poll'
  Poll.tick() -- registers the observer
  env.clearEvents()
  env.cmd({ t = 'watch', ps = { 'Exposure', 'Contrast' } })
  local v = last(env.events('vals')).vals
  eq(v.Exposure, 0); eq(v.Contrast, 0); eq(v.Temperature, nil, 'unwatched params left out')
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, seq = 1 })
  local vals = env.events('vals')
  eq(#vals, 1); eq(vals[1].vals.Exposure, 1); eq(vals[1].vals.Contrast, nil, 'unchanged left out')
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 1, seq = 2 })
  eq(#env.events('vals'), 0, 'no change, no push')
end)

test('pushHz throttles vals and the poll flushes what it held back', function()
  local env = boot()
  local Poll = require 'Poll'
  Poll.tick()
  env.cmd({ t = 'watch', ps = { 'Exposure' } })
  env.cmd({ t = 'config', pushHz = 10 })
  env.clock.t = env.clock.t + 1
  env.clearEvents()
  env.cmd({ t = 'set', p = 'Exposure', v = 2, seq = 1 })
  env.cmd({ t = 'set', p = 'Exposure', v = 3, seq = 2 })
  local vals = env.events('vals')
  eq(#vals, 1, 'second push held back'); eq(vals[1].vals.Exposure, 2)
  env.clock.t = env.clock.t + 0.2
  Poll.tick()
  vals = env.events('vals')
  eq(#vals, 2); eq(vals[2].vals.Exposure, 3)
end)

test('watch outside Develop sends cached values', function()
  local env = boot()
  require('Poll').tick()
  env.module = 'library'
  env.clearEvents()
  env.cmd({ t = 'watch', ps = { 'Exposure' } })
  local m = last(env.events('vals'))
  eq(m.cached, true); eq(m.vals.Exposure, 0)
end)

test('observer callbacks from a replaced observer are ignored', function()
  local env = boot()
  local Develop, State = require 'Develop', require 'State'
  require('Poll').tick()
  ok(State.observer, 'registered')
  Develop.ensureObserver(true)
  eq(#env.dev.observers, 2)
  local before = State.obsCount
  env.fireObservers()
  eq(State.obsCount, before + 1, 'only the current observer counts')
end)

test('a silent observer after re-entering Develop is re-registered', function()
  local env = boot()
  local Poll, State = require 'Poll', require 'State'
  Poll.tick()
  env.module = 'library'
  Poll.tick()
  env.module = 'develop'
  Poll.tick()
  ok(State.observerSuspect, 'suspect after re-entry')
  env.dev.observers = {} -- Lightroom forgot the observer
  env.cmd({ t = 'set', p = 'Exposure', v = 1.25, seq = 1 })
  env.clock.t = env.clock.t + 2
  Poll.tick()
  eq(#env.dev.observers, 1, 're-registered')
  ok(env.logged('registering a new observer'), 'logged')
end)

-- Poll ------------------------------------------------------------------------------

test('the poll sends state only when it changes', function()
  local env = boot()
  local Poll = require 'Poll'
  Poll.tick()
  env.clearEvents()
  Poll.tick()
  eq(#env.events('state'), 0, 'no change, no state')
  env.catalog.target.meta.pickStatus = 1
  Poll.tick()
  local st = last(env.events('state'))
  eq(st.flag, 1); eq(st.photo, '1'); eq(st.file, 'DSCF0001.RAF'); eq(st.label, 'none'); eq(st.sel, 1)
  env.clearEvents()
  env.modules.LrSelection.nextPhoto()
  Poll.tick()
  eq(last(env.events('state')).photo, '2')
  ok(#env.events('vals') >= 1, 'photo change pushes vals')
  env.catalog.target, env.catalog.targets = nil, {}
  env.clearEvents()
  Poll.tick()
  ok(string.find(env.sentLog[1], '"photo":null', 1, true), 'no photo encodes as null')
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

-- Spike: reload, triggers, probes ---------------------------------------------------

local function fakePluginWith(version)
  local dir = mktemp()
  local src = assert(readFile(PLUGIN_DIR .. '/SpikeVersion.lua'))
  local changed, n = string.gsub(src, "local V = '[^']*'", "local V = '" .. version .. "'")
  eq(n, 1, 'the harness regex shape matches SpikeVersion.lua')
  writeFile(dir .. '/SpikeVersion.lua', changed)
  return dir
end

test('reload returns the fresh version while require stays cached', function()
  local env = boot()
  env.cmd({ t = 'probe', id = 1, name = 'requireVersion' })
  eq(last(env.events('result')).data.v, 'v1')
  _PLUGIN.path = fakePluginWith('v2')
  env.cmd({ t = 'reload', id = 2 })
  local r = last(env.events('result'))
  eq(r.name, 'reload'); eq(r.ok, true); eq(r.data.v, 'v2'); eq(r.data.via, 'loadstring')
  eq(r.data.importOk, true); eq(r.data.requireOk, true)
  env.cmd({ t = 'probe', id = 3, name = 'requireVersion' })
  eq(last(env.events('result')).data.v, 'v1', 'require still caches')
end)

test('reload passes import and require in when the chunk cannot see them', function()
  local env = boot()
  _PLUGIN.path = fakePluginWith('v3')
  local realLoadstring = loadstring
  loadstring = function(s, name) -- an empty environment, as a sandbox might give
    local f, err = realLoadstring(s, name)
    if f then setfenv(f, {}) end
    return f, err
  end
  env.cmd({ t = 'reload', id = 4 })
  loadstring = realLoadstring
  local r = last(env.events('result'))
  eq(r.ok, true, tostring(r.msg)); eq(r.data.via, 'loadstring+inject'); eq(r.data.v, 'v3')
  ok(r.data.plainRunErr, 'plain failure recorded')
end)

test('menu triggers arrive once, by either route', function()
  local env = boot()
  local SpikeTrigger = require 'SpikeTrigger'
  env.clearEvents()
  SpikeTrigger.fire('tests')
  ok(readFile(SpikeTrigger.path('tests')), 'file route written')
  SpikeTrigger.consume()
  local trig = env.events('trigger')
  eq(#trig, 1); eq(trig[1].name, 'tests'); eq(trig[1].route, 'state')
  ok(env.logged('via file %(duplicate'), 'second route logged as duplicate')
  eq(readFile(SpikeTrigger.path('tests')), nil, 'file consumed')
  SpikeTrigger.consume()
  eq(#env.events('trigger'), 1, 'nothing left')

  env.clock.t = env.clock.t + 3
  writeFile(SpikeTrigger.path('autosync'), string.format('%.3f', env.clock.t))
  SpikeTrigger.consume()
  trig = env.events('trigger')
  eq(#trig, 2); eq(trig[2].name, 'autosync'); eq(trig[2].route, 'file')

  writeFile(SpikeTrigger.path('tests'), string.format('%.3f', env.clock.t - 60))
  SpikeTrigger.consume()
  eq(#env.events('trigger'), 2, 'stale file ignored')

  writeFile(SpikeTrigger.path('tests'), '1')
  SpikeTrigger.clearStale()
  eq(readFile(SpikeTrigger.path('tests')), nil, 'cleared at start')
end)

test('the poll consumes triggers', function()
  local env = boot()
  env.clearEvents()
  require('SpikeTrigger').fire('autosync')
  require('Poll').tick()
  eq(last(env.events('trigger')).name, 'autosync')
end)

local function probe(env, name, args)
  env.cmd({ t = 'probe', id = 99, name = name, args = args })
  return last(env.events('result'))
end

test('probe: features, ranges, presets, timing, requireVersion', function()
  local env = boot()
  require('Poll').tick()
  local r = probe(env, 'features')
  eq(r.ok, true, tostring(r.msg)); eq(r.data.setEnhance, true); eq(r.data.loadstring, true)
  eq(type(r.data.functions.LrDevelopController), 'table'); eq(r.data.observerRegistered, true)

  r = probe(env, 'ranges')
  eq(r.ok, true, tostring(r.msg))
  eq(r.data.params.Exposure.min, -5); eq(r.data.params.Temperature.max, 50000); eq(r.data.format, 'RAW')

  r = probe(env, 'presets')
  eq(r.data.folders, 1); eq(r.data.presets, 2); eq(r.data.items[1].name, 'Classic Chrome')

  r = probe(env, 'timing')
  eq(r.ok, true, tostring(r.msg)); eq(type(r.data.statePoll.avgMs), 'number')

  env.cmd({ t = 'probe', id = 1, name = 'nope' })
  eq(last(env.events('err')).msg, 'unknown probe')
  eq(#env.taskErrors, 0, table.concat(env.taskErrors, '; '))
end)

test('probe: observerPhotoChange', function()
  local env = boot()
  require('Poll').tick()
  local r = probe(env, 'observerPhotoChange')
  eq(r.ok, true, tostring(r.msg))
  eq(r.data.photoChanged, true); eq(r.data.firesOnPhotoChange, true); eq(r.data.backOnOriginal, true)
  eq(r.data.firesAfterRoundTrip, true); eq(env.dev.values.Exposure, 0, 'nudge undone')
  eq(env.module, 'develop')
end)

test('probe: mask creates and removes an AI subject mask', function()
  local env = boot()
  local r = probe(env, 'mask')
  eq(r.ok, true, tostring(r.msg)); eq(r.data.created, true); eq(r.data.cleaned, true)
  eq(#env.dev.masks, 0); eq(last(env.calls), 'tool:loupe')
end)

test('probe: beforeAfter shows Before then the loupe', function()
  local env = boot()
  local r = probe(env, 'beforeAfter', { secs = 1 })
  eq(r.ok, true, tostring(r.msg))
  eq(env.views[1], 'develop_before'); eq(env.views[2], 'develop_loupe')
end)

test('probe: flagAdvance restores the flag, with and without Auto Advance', function()
  local env = boot()
  local r = probe(env, 'flagAdvance')
  eq(r.ok, true, tostring(r.msg)); eq(r.data.advanced, false); eq(r.data.flagRestored, true)
  eq(env.photos[1].meta.pickStatus, 0)
  env.autoAdvance = true
  r = probe(env, 'flagAdvance')
  eq(r.data.advanced, true); eq(r.data.flagRestored, true); eq(r.data.backOnOriginal, true)
  eq(env.photos[1].meta.pickStatus, 0)
end)

test('probe: autoSync needs a selection and restores Exposure', function()
  local env = boot()
  local r = probe(env, 'autoSync')
  eq(r.ok, false); ok(string.find(r.msg, 'select 2 or more'), r.msg)
  env.catalog:setSelectedPhotos(env.photos[1], { env.photos[2] })
  r = probe(env, 'autoSync')
  eq(r.ok, true, tostring(r.msg)); eq(r.data.autoSyncCarriesSetValue, false); eq(r.data.count, 2)
  eq(env.dev.values.Exposure, 0, 'restored')
end)

test('select picks the largest raw, the largest file or an index', function()
  local env = boot()
  env.cmd({ t = 'select', id = 1, what = 'largestRaw' })
  local r = last(env.events('result'))
  eq(r.ok, true, tostring(r.msg)); eq(r.data.file, 'BIGGEST.RAF'); eq(r.data.selected, true)
  eq(env.catalog.target, env.photos[2])
  env.cmd({ t = 'select', id = 2, what = 'largestAny' })
  eq(last(env.events('result')).data.file, 'HUGE.JPG')
  env.cmd({ t = 'select', id = 3, what = 'index', n = 4 })
  eq(last(env.events('result')).data.format, 'DNG')
  env.cmd({ t = 'select', id = 4, what = 'bogus' })
  eq(last(env.events('result')).ok, false)
end)

test('select falls back to any format when there is no raw', function()
  local env = boot({ photos = { { size = 5, format = 'JPG' }, { size = 9, format = 'JPG', name = 'B.JPG' } } })
  env.cmd({ t = 'select', id = 1, what = 'largestRaw' })
  local r = last(env.events('result'))
  eq(r.data.file, 'B.JPG'); eq(r.data.fellBack, true)
end)

test('bezel shows a caption', function()
  local env = boot()
  env.cmd({ t = 'bezel', msg = 'Latency 15 Hz', secs = 3 })
  eq(last(env.bezels).msg, 'Latency 15 Hz'); eq(last(env.bezels).secs, 3)
end)

-- Lifecycle -----------------------------------------------------------------------

test('Shutdown.lua says bye, stops and leaves a marker', function()
  local env = boot()
  local State = require 'State'
  env.clearEvents()
  require 'Shutdown'
  eq(last(env.events('bye')).why, 'shutdownPlugin'); eq(State.running, false)
  ok(string.find(readFile(TMP .. '/deckbridge-inst'), '^shutdown '), 'marker')
  ok(env.latest(CMD).closed and env.latest(EVT).closed, 'sockets closed')
end)

test('ShutdownApp.lua calls doneFunction promptly', function()
  local env = boot()
  local State = require 'State'
  env.clearEvents()
  local t = require 'ShutdownApp'
  local doneCalls = 0
  t.LrShutdownFunction(function() doneCalls = doneCalls + 1 end, function() end)
  eq(doneCalls, 1); eq(last(env.events('bye')).why, 'shutdownApp'); eq(State.running, false)
end)

test('the main task binds, serves and exits cleanly', function()
  local env = boot({ noStart = true })
  local State = require 'State'
  ok(env.mainTask, 'main task posted'); eq(env.mainTaskName, 'DeckBridge')
  local seenHello = false
  env.onSleep = function()
    if env.sleeps == 1 then
      env.connectBoth()
      seenHello = env.events('hello')[1] ~= nil
    elseif env.sleeps == 3 then
      State.running = false
    end
  end
  env.mainTask()
  ok(seenHello, 'hello sent while running')
  ok(env.latest(CMD).closed and env.latest(EVT).closed, 'sockets closed on exit')
  ok(env.logged('stopped: inst'), 'stop logged')
end)

test('Info.lua names files that exist', function()
  local info = dofile(PLUGIN_DIR .. '/Info.lua')
  eq(info.LrToolkitIdentifier, 'com.karimdhanji.deckbridge')
  eq(info.LrForceInitPlugin, true)
  local files = { info.LrInitPlugin, info.LrShutdownPlugin, info.LrShutdownApp }
  for _, item in ipairs(info.LrExportMenuItems) do files[#files + 1] = item.file end
  eq(#files, 5)
  for _, f in ipairs(files) do
    ok(readFile(PLUGIN_DIR .. '/' .. f), f .. ' exists')
  end
end)

test('menu scripts fire their triggers', function()
  local env = boot()
  env.clearEvents()
  package.loaded.SpikeMenuTests = nil
  require 'SpikeMenuTests'
  require('Poll').tick()
  eq(last(env.events('trigger')).name, 'tests')
  ok(last(env.bezels).msg:find('tests requested', 1, true), 'bezel confirms the click')
end)

os.execute('rm -rf "' .. TMP .. '"')
print(string.format('%d passed, %d failed', passed, failed))
if failed > 0 then
  os.exit(1)
end
