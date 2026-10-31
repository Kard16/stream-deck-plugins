-- DeckBridge settings. Only the user turns GUARD off. Never reloads.
return {
  VERSION = '1.0.0', -- keep in step with Info.lua's VERSION
  PROTOCOL = 1, -- hello.v; the contract is lightroom/protocol/PROTOCOL.md

  CMD_PORT = 58780, -- Lightroom receives commands here
  EVT_PORT = 58781, -- Lightroom sends events here
  -- Never 58763/58764: MIDI2LR and lightroom-mcp use them.

  -- While GUARD is true, writes (set, reset, flag, preset) only go through when this
  -- catalog is the active one, compared without case.
  TEST_CATALOG = '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat',
  GUARD = true,

  POLL_SECS = 0.2, -- the state and value poll
  REBIND_SECS = 2, -- retry after a listener fails to open
  GESTURE_SECS = 2, -- a gesture with no set for this long ends by itself
  VALS_SECS = 0.05, -- at most 20 vals a second
  ADVANCE_SECS = 0.15, -- flag with advance waits this long for Lightroom's own Auto Advance
  MODULE_SECS = 1, -- how long to wait for a module switch
  BEZEL_SECS = 5, -- at most one guard bezel this often
  WRITE_TIMEOUT = 3, -- seconds catalog:withWriteAccessDo waits for the catalog

  RELOAD = true, -- the reload command, for development
  DEBUG = false, -- log every command and poll when true
}
