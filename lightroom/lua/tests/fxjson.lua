-- JSON for the fixture runner. rxi's json.lua, which the plugin uses, decodes [] and {}
-- alike and drops null, but the fixture rules tell arrays from objects, so this decoder
-- tags them (FX.kind) and keeps null as FX.NULL. It also has the matcher the rules in
-- PROTOCOL.md's Fixtures section describe.
local FX = {}

FX.NULL = setmetatable({}, { __tostring = function() return 'null' end })
local ARRAY = { __jsontype = 'array' }
local OBJECT = { __jsontype = 'object' }

function FX.array(t) return setmetatable(t or {}, ARRAY) end
function FX.object(t) return setmetatable(t or {}, OBJECT) end

-- 'null', 'array', 'object', 'string', 'number' or 'boolean'.
function FX.kind(v)
  if v == FX.NULL then return 'null' end
  if type(v) == 'table' then
    local mt = getmetatable(v)
    if mt == ARRAY then return 'array' end
    if mt == OBJECT then return 'object' end
    if next(v) == nil or v[1] ~= nil then return 'array' end
    return 'object'
  end
  return type(v)
end

-- Decoding ---------------------------------------------------------------------------

local function fail(s, i, msg)
  error(string.format('bad JSON (%s at %d): %s', msg, i, s), 0)
end

local function skip(s, i)
  local _, e = string.find(s, '^[ \t\r\n]*', i)
  return e + 1
end

local function utf8(n)
  if n < 0x80 then return string.char(n) end
  if n < 0x800 then return string.char(192 + math.floor(n / 64), 128 + n % 64) end
  return string.char(224 + math.floor(n / 4096), 128 + math.floor(n / 64) % 64, 128 + n % 64)
end

local ESCAPES = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }

local function parseString(s, i)
  local out, j = {}, i + 1
  while true do
    local c = string.sub(s, j, j)
    if c == '' then fail(s, i, 'unterminated string') end
    if c == '"' then return table.concat(out), j + 1 end
    if c == '\\' then
      local e = string.sub(s, j + 1, j + 1)
      if ESCAPES[e] then
        out[#out + 1] = ESCAPES[e]
        j = j + 2
      elseif e == 'u' then
        local n = tonumber(string.sub(s, j + 2, j + 5), 16)
        if not n then fail(s, j, 'bad \\u escape') end
        out[#out + 1] = utf8(n)
        j = j + 6
      else
        fail(s, j, 'bad escape')
      end
    else
      out[#out + 1] = c
      j = j + 1
    end
  end
end

local parse

local function parseList(s, i, close, item)
  i = skip(s, i + 1)
  if string.sub(s, i, i) == close then return i + 1 end
  while true do
    i = item(skip(s, i))
    i = skip(s, i)
    local c = string.sub(s, i, i)
    if c == close then return i + 1 end
    if c ~= ',' then fail(s, i, "expected ',' or '" .. close .. "'") end
    i = i + 1
  end
end

parse = function(s, i)
  i = skip(s, i)
  local c = string.sub(s, i, i)
  if c == '{' then
    local obj = FX.object()
    local j = parseList(s, i, '}', function(k)
      if string.sub(s, k, k) ~= '"' then fail(s, k, 'expected a key') end
      local key, after = parseString(s, k)
      after = skip(s, after)
      if string.sub(s, after, after) ~= ':' then fail(s, after, "expected ':'") end
      local val
      val, after = parse(s, after + 1)
      obj[key] = val
      return after
    end)
    return obj, j
  elseif c == '[' then
    local arr = FX.array()
    local j = parseList(s, i, ']', function(k)
      local val, after = parse(s, k)
      arr[#arr + 1] = val
      return after
    end)
    return arr, j
  elseif c == '"' then
    return parseString(s, i)
  elseif string.sub(s, i, i + 3) == 'true' then
    return true, i + 4
  elseif string.sub(s, i, i + 4) == 'false' then
    return false, i + 5
  elseif string.sub(s, i, i + 3) == 'null' then
    return FX.NULL, i + 4
  end
  local num = string.match(s, '^-?%d+%.?%d*[eE]?[-+]?%d*', i)
  local n = num and tonumber(num)
  if not n then fail(s, i, 'unexpected character') end
  return n, i + #num
end

function FX.decode(s)
  local v, i = parse(s, 1)
  i = skip(s, i)
  if i <= #s then fail(s, i, 'trailing characters') end
  return v
end

-- Encoding, for the deck lines the runner sends and for messages in failures -------------

local function encodeString(s)
  return '"' .. string.gsub(s, '[%c"\\]', function(c)
    local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
    return map[c] or string.format('\\u%04x', string.byte(c))
  end) .. '"'
end

function FX.encode(v)
  local k = FX.kind(v)
  if k == 'null' or v == nil then return 'null' end
  if k == 'string' then return encodeString(v) end
  if k == 'number' then
    if v == math.floor(v) and math.abs(v) < 1e15 then return string.format('%d', v) end
    return string.format('%.14g', v)
  end
  if k == 'boolean' then return tostring(v) end
  local parts = {}
  if k == 'array' then
    for i = 1, #v do parts[i] = FX.encode(v[i]) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local names = {}
  for name in pairs(v) do names[#names + 1] = name end
  table.sort(names)
  for _, name in ipairs(names) do parts[#parts + 1] = encodeString(name) .. ':' .. FX.encode(v[name]) end
  return '{' .. table.concat(parts, ',') .. '}'
end

-- Matching (PROTOCOL.md, Fixtures) -----------------------------------------------------
-- * "*" matches any value that is present.
-- * Numbers match within 1e-6.
-- * Arrays match when they have the same length and each element matches, in order.
-- * Every field of an expected object must be present and match; extra fields are
--   allowed. That covers vals and ranges too: their expected keys must be present.

function FX.match(expected, actual)
  if expected == '*' then
    return actual ~= nil
  end
  local k = FX.kind(expected)
  if k == 'number' then
    return type(actual) == 'number' and math.abs(actual - expected) <= 1e-6
  end
  if k == 'null' then
    return actual == FX.NULL
  end
  if k == 'array' then
    if FX.kind(actual) ~= 'array' or #actual ~= #expected then return false end
    for i = 1, #expected do
      if not FX.match(expected[i], actual[i]) then return false end
    end
    return true
  end
  if k == 'object' then
    if FX.kind(actual) ~= 'object' then return false end
    for key, want in pairs(expected) do
      if actual[key] == nil or not FX.match(want, actual[key]) then return false end
    end
    return true
  end
  return expected == actual
end

return FX
