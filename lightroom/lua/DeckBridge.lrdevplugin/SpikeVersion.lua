-- Spike S3: the harness rewrites the next line to test module reloading.
local V = 'v1'
local LrDate = import 'LrDate'
local json = require 'json'
return { v = V, importOk = LrDate ~= nil, requireOk = json ~= nil }
