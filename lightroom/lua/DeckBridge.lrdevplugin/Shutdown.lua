-- LrShutdownPlugin: runs on disable, remove and Reload Plug-in.
local LrTasks = import 'LrTasks'

local Log = require 'Log'
local State = require 'State'
local Server = require 'Server'
local Poll = require 'Poll'

Log.info('shutdown (plugin): inst %s', tostring(State.inst))
LrTasks.pcall(Server.send, { t = 'bye', why = 'shutdownPlugin' })
State.running = false
LrTasks.pcall(Server.stop)
-- If this script doesn't share module state with Init's task, the running loop still
-- finds this marker and stops (Poll.checkInstance).
LrTasks.pcall(Poll.markShutdown)
