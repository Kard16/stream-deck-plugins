-- LrShutdownPlugin: runs on disable, remove and Reload Plug-in. Lightroom closes the
-- plugin's sockets before this runs (spike run 2), so there's no goodbye to send: the
-- deck treats any disconnect as offline.
local LrTasks = import 'LrTasks'

local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'

Log.info('shutdown (plugin): inst %s', tostring(State.inst))
State.running = false
LrTasks.pcall(function() require('Develop').endGesture('shutdown') end)
LrTasks.pcall(Server.stop)
-- If this script doesn't share module state with Init's task, the running loop still
-- finds this marker and stops (Poll.checkInstance).
LrTasks.pcall(function() require('Poll').markShutdown() end)
