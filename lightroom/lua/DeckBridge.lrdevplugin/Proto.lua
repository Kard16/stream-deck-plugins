-- Protocol helpers the handler modules share: err replies and field checks.
-- See lightroom/protocol/PROTOCOL.md, Errors.
--
-- Reloadable: no state of its own, and nothing runs at load time.
local Log = require 'Log'
local Server = require 'Server'

local Proto = {}

-- A finite number: what JSON can carry and setValue accepts.
function Proto.isNumber(v)
  return type(v) == 'number' and v == v and v ~= math.huge and v ~= -math.huge
end

-- The command's id, for replies that carry it.
function Proto.id(m)
  if type(m) == 'table' and Proto.isNumber(m.id) then
    return m.id
  end
  return nil
end

-- Sends err {id, cmd, code, msg}. m is the command, or nil for a line that wasn't one.
-- Returns nothing, so a handler can `return Proto.err(...)`.
function Proto.err(m, code, msg)
  local e = { t = 'err', code = code, msg = msg or code, id = Proto.id(m) }
  if type(m) == 'table' and type(m.t) == 'string' then
    e.cmd = m.t
  end
  Log.debug('err %s %s: %s', tostring(e.cmd), tostring(code), tostring(e.msg))
  Server.send(e)
end

return Proto
