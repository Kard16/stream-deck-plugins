-- Two localhost LrSocket listeners, because each LrSocket is one-way:
-- Config.CMD_PORT receives commands, Config.EVT_PORT sends events.
-- Every bind gets a generation number; callbacks from a replaced socket are ignored.
--
-- Never reloads. Init points onLine, onClientConnected and onClientGone at callbacks
-- that look the handler modules up on every call, so a hot reload swaps the handlers
-- in around these sockets without touching them.
local LrDate = import 'LrDate'
local LrSocket = import 'LrSocket'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'

local Server = {
  onLine = nil, -- function(line), set by Init: a command line arrived
  onClientConnected = nil, -- function(), set by Init: a client connected to the event port
  onClientGone = nil, -- function(why), set by Init: the command connection ended

  context = nil,
  recv = nil,
  sender = nil,
  cmdConnected = false,
  evtConnected = false,
  binding = false, -- true while LrSocket.bind runs for either listener
  lastSenderRecreateAt = -1,
  lastRecvReconnectAt = -1,
  rebindRecvAt = nil,
  rebindSendAt = nil,

  sent = 0,
  drops = 0,
  senderRecreated = 0,
}

local function now()
  return LrDate.currentTime()
end

local function closeQuietly(sock)
  if sock then
    LrTasks.pcall(function() sock:close() end)
  end
end

local function reconnectQuietly(sock)
  LrTasks.pcall(function() sock:reconnect() end)
end

-- The deck went away: Lightroom's own send socket never notices, so this is the only
-- sign of it. Ends an open gesture, as if done had arrived.
local function clientGone(why)
  if Server.onClientGone then
    local ok, err = LrTasks.pcall(Server.onClientGone, why)
    if not ok then
      Log.warn('cmd: client-gone handling failed: %s', tostring(err))
    end
  end
end

-- While no client comes, LrSocket times out every 10 s, onError reconnects, and
-- onConnecting fires again. Only the first time per generation is worth a log line;
-- the rest would write 12 lines a minute into an idle Lightroom's log.
local function listening(what, port, gen, again)
  if again then
    Log.debug('%s: listening again on %s (gen %d)', what, tostring(port), gen)
  else
    Log.info('%s: listening on %s (gen %d)', what, tostring(port), gen)
  end
end

function Server.bindRecv()
  -- Bump the generation before closing: onClosed can fire synchronously inside close().
  State.recvGen = State.recvGen + 1
  local gen = State.recvGen
  local old = Server.recv
  Server.recv, Server.cmdConnected = nil, false
  closeQuietly(old)

  local announced = false
  Server.binding = true
  local ok, sock = LrTasks.pcall(LrSocket.bind, {
    functionContext = Server.context,
    plugin = _PLUGIN,
    port = Config.CMD_PORT,
    mode = 'receive',
    onConnecting = function(_, port)
      if gen ~= State.recvGen then return end
      listening('cmd', port, gen, announced)
      announced = true
    end,
    onConnected = function()
      if gen ~= State.recvGen then return end
      Server.cmdConnected = true
      Log.info('cmd: client connected (gen %d)', gen)
    end,
    onMessage = function(_, line)
      if gen ~= State.recvGen then return end
      if Server.onLine then
        local okLine, err = LrTasks.pcall(Server.onLine, line)
        if not okLine then
          Log.error('cmd: message handling failed: %s', tostring(err))
        end
      end
    end,
    onClosed = function(s)
      if gen ~= State.recvGen then return end
      Server.cmdConnected = false
      Log.info('cmd: client closed (gen %d)', gen)
      clientGone('client closed')
      if not State.running then return end
      Server.relisten(s) -- listen for the next client
      -- The client is gone, so its event connection is too. Recreate the send socket
      -- rather than calling reconnect() on it: that reportedly hangs Lightroom (MIDI2LR).
      Server.recreateSender('cmd socket closed')
    end,
    onError = function(s, err)
      if gen ~= State.recvGen then return end
      if err == 'timeout' then -- no client yet: keep listening
        if State.running then reconnectQuietly(s) end
        return
      end
      Log.warn('cmd: error %s (gen %d)', tostring(err), gen)
      if not State.running then return end
      if Server.cmdConnected then
        Server.cmdConnected = false
        clientGone('client error')
        Server.relisten(s)
        Server.recreateSender('cmd socket error')
      else
        -- Most likely the port is in use, e.g. by an instance that hasn't shut down yet.
        Server.rebindRecvAt = now() + Config.REBIND_SECS
      end
    end,
  })
  Server.binding = false
  if ok then
    Server.recv = sock
  else
    Log.error('cmd: bind failed: %s', tostring(sock))
    Server.rebindRecvAt = now() + Config.REBIND_SECS
  end
end

function Server.bindSender()
  State.sendGen = State.sendGen + 1
  local gen = State.sendGen
  local old = Server.sender
  Server.sender, Server.evtConnected = nil, false
  closeQuietly(old)

  local announced = false
  Server.binding = true
  local ok, sock = LrTasks.pcall(LrSocket.bind, {
    functionContext = Server.context,
    plugin = _PLUGIN,
    port = Config.EVT_PORT,
    mode = 'send',
    onConnecting = function(_, port)
      if gen ~= State.sendGen then return end
      listening('evt', port, gen, announced)
      announced = true
    end,
    onConnected = function()
      if gen ~= State.sendGen then return end
      Server.evtConnected = true
      Log.info('evt: client connected (gen %d)', gen)
      if Server.onClientConnected then
        local okGreet, err = LrTasks.pcall(Server.onClientConnected)
        if not okGreet then
          Log.error('evt: greeting failed: %s', tostring(err))
        end
      end
    end,
    onClosed = function()
      if gen ~= State.sendGen then return end
      Server.evtConnected = false
      Log.info('evt: client closed (gen %d)', gen)
      if State.running then
        Server.recreateSender('evt socket closed')
      end
    end,
    onError = function(s, err)
      if gen ~= State.sendGen then return end
      if err == 'timeout' then -- no client yet: keep listening
        if State.running and not Server.evtConnected then reconnectQuietly(s) end
        return
      end
      Log.warn('evt: error %s (gen %d)', tostring(err), gen)
      if not State.running then return end
      if Server.evtConnected then
        Server.evtConnected = false
        Server.recreateSender('evt socket error')
      else
        Server.rebindSendAt = now() + Config.REBIND_SECS
      end
    end,
  })
  Server.binding = false
  if ok then
    Server.sender = sock
  else
    Log.error('evt: bind failed: %s', tostring(sock))
    Server.rebindSendAt = now() + Config.REBIND_SECS
  end
end

-- Spike run 2: around Lightroom's menus and Plug-in Manager, new send sockets reported
-- closed while still being bound, and rebinding from inside that callback recursed about
-- 200 times, until Lua's C-stack limit. So a rebind asked for during a bind, or within
-- 0.5 s of the last one, is left to the poll loop (Server.tick), which skips it if a
-- client has connected by then. Both sockets also report the same client leaving, and
-- that second report lands here too.
local PACE_SECS = 0.5

function Server.recreateSender(why)
  local t = now()
  if Server.binding or t - Server.lastSenderRecreateAt < PACE_SECS then
    if not Server.rebindSendAt then
      Server.rebindSendAt = t + PACE_SECS
      Log.info('evt: %s; rebinding the send socket shortly', why)
    end
    return
  end
  Server.lastSenderRecreateAt = t
  Server.senderRecreated = Server.senderRecreated + 1
  Log.info('evt: %s; recreating the send socket', why)
  Server.bindSender()
end

-- Listens for the next client on the receive socket, paced like recreateSender.
function Server.relisten(sock)
  local t = now()
  if Server.binding or t - Server.lastRecvReconnectAt < PACE_SECS then
    if not Server.rebindRecvAt then
      Server.rebindRecvAt = t + PACE_SECS
      Log.info('cmd: rebinding the receive socket shortly')
    end
    return
  end
  Server.lastRecvReconnectAt = t
  reconnectQuietly(sock)
end

function Server.start(context)
  Server.context = context
  Server.bindRecv()
  Server.bindSender()
end

-- Called from the poll loop: retries listeners that failed to open, and paced rebinds.
function Server.tick()
  local t = now()
  if Server.rebindRecvAt and t >= Server.rebindRecvAt then
    Server.rebindRecvAt = nil
    if Server.cmdConnected then
      Log.info('cmd: rebind skipped, a client is connected')
    else
      Log.info('cmd: retrying bind')
      Server.lastRecvReconnectAt = t
      Server.bindRecv()
    end
  end
  if Server.rebindSendAt and t >= Server.rebindSendAt then
    Server.rebindSendAt = nil
    if Server.evtConnected then
      Log.info('evt: rebind skipped, a client is connected')
    else
      Log.info('evt: retrying bind')
      Server.lastSenderRecreateAt = t
      Server.bindSender()
    end
  end
end

function Server.stop()
  State.recvGen = State.recvGen + 1
  State.sendGen = State.sendGen + 1
  local recv, sender = Server.recv, Server.sender
  Server.recv, Server.sender = nil, nil
  Server.cmdConnected, Server.evtConnected = false, false
  Server.rebindRecvAt, Server.rebindSendAt = nil, nil
  closeQuietly(recv)
  closeQuietly(sender)
end

-- Sends one JSON line. Drops it, and counts the drop, while no client is connected.
-- Returns true only when the line went out.
function Server.send(tbl)
  if not (Server.sender and Server.evtConnected) then
    Server.drops = Server.drops + 1
    return false
  end
  local ok, line = LrTasks.pcall(json.encode, tbl)
  if not ok then
    Log.error('encode failed for %s: %s', tostring(tbl and tbl.t), tostring(line))
    line = json.encode({ t = 'err', code = 'failed', msg = 'encode failed: ' .. tostring(line), cmd = tostring(tbl and tbl.t) })
  end
  local sender = Server.sender
  local okSend, err = LrTasks.pcall(function() sender:send(line .. '\n') end)
  if not okSend then
    Log.warn('evt: send failed: %s', tostring(err))
    Server.evtConnected = false
    Server.recreateSender('send failed')
    return false
  end
  Server.sent = Server.sent + 1
  return true
end

return Server
