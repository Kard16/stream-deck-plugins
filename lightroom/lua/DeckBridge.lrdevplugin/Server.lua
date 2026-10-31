-- Two localhost LrSocket listeners, because each LrSocket is one-way:
-- Config.CMD_PORT receives commands, Config.EVT_PORT sends events.
-- Every bind gets a generation number; callbacks from a replaced socket are ignored.
local LrDate = import 'LrDate'
local LrSocket = import 'LrSocket'
local LrTasks = import 'LrTasks'

local json = require 'json'
local Config = require 'Config'
local Log = require 'Log'
local State = require 'State'

local Server = {
  onLine = nil, -- function(line), set by Init
  onClientConnected = nil, -- function(), set by Init: hello, state, vals

  context = nil,
  recv = nil,
  sender = nil,
  cmdConnected = false,
  evtConnected = false,
  senderBoundAt = 0,
  senderHadClient = false,
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

function Server.bindRecv()
  -- Bump the generation before closing: onClosed can fire synchronously inside close().
  State.recvGen = State.recvGen + 1
  local gen = State.recvGen
  local old = Server.recv
  Server.recv, Server.cmdConnected = nil, false
  closeQuietly(old)

  local ok, sock = LrTasks.pcall(LrSocket.bind, {
    functionContext = Server.context,
    plugin = _PLUGIN,
    port = Config.CMD_PORT,
    mode = 'receive',
    onConnecting = function(_, port)
      if gen ~= State.recvGen then return end
      Log.info('cmd: listening on %s (gen %d)', tostring(port), gen)
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
      if not State.running then return end
      reconnectQuietly(s) -- listen for the next client
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
        reconnectQuietly(s)
        Server.recreateSender('cmd socket error')
      else
        -- Most likely the port is in use, e.g. by an instance that hasn't shut down yet.
        Server.rebindRecvAt = now() + Config.REBIND_SECS
      end
    end,
  })
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
  Server.senderBoundAt = now()
  Server.senderHadClient = false

  local ok, sock = LrTasks.pcall(LrSocket.bind, {
    functionContext = Server.context,
    plugin = _PLUGIN,
    port = Config.EVT_PORT,
    mode = 'send',
    onConnecting = function(_, port)
      if gen ~= State.sendGen then return end
      Log.info('evt: listening on %s (gen %d)', tostring(port), gen)
    end,
    onConnected = function()
      if gen ~= State.sendGen then return end
      Server.evtConnected = true
      Server.senderHadClient = true
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
  if ok then
    Server.sender = sock
  else
    Log.error('evt: bind failed: %s', tostring(sock))
    Server.rebindSendAt = now() + Config.REBIND_SECS
  end
end

function Server.recreateSender(why)
  -- Both sockets report a client leaving. A listener bound moments ago that has never
  -- had a client is already fresh, and binding again would only race the reconnect.
  if Server.sender and not Server.senderHadClient and now() - Server.senderBoundAt < 0.5 then
    Log.info('evt: %s; listener is already fresh', why)
    return
  end
  Server.senderRecreated = Server.senderRecreated + 1
  Log.info('evt: %s; recreating the send socket', why)
  Server.bindSender()
end

function Server.start(context)
  Server.context = context
  Server.bindRecv()
  Server.bindSender()
end

-- Called from the poll loop: retries listeners that failed to open.
function Server.tick()
  local t = now()
  if Server.rebindRecvAt and t >= Server.rebindRecvAt then
    Server.rebindRecvAt = nil
    Log.info('cmd: retrying bind')
    Server.bindRecv()
  end
  if Server.rebindSendAt and t >= Server.rebindSendAt then
    Server.rebindSendAt = nil
    Log.info('evt: retrying bind')
    Server.bindSender()
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
function Server.send(tbl)
  if not (Server.sender and Server.evtConnected) then
    Server.drops = Server.drops + 1
    return false
  end
  local ok, line = LrTasks.pcall(json.encode, tbl)
  if not ok then
    Log.error('encode failed for %s: %s', tostring(tbl and tbl.t), tostring(line))
    line = json.encode({ t = 'err', msg = 'encode failed: ' .. tostring(line), cmd = tostring(tbl and tbl.t) })
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
