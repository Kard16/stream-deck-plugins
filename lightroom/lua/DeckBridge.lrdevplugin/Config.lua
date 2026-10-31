-- DeckBridge settings. Only the user turns GUARD off.
return {
  CMD_PORT = 58780, -- Lightroom receives commands here
  EVT_PORT = 58781, -- Lightroom sends events here
  -- Never 58763/58764: MIDI2LR and lightroom-mcp use them.

  -- While GUARD is true, writes (Develop changes, flags, ratings, presets) only go
  -- through when this catalog is the active one.
  TEST_CATALOG = '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat',
  GUARD = true,

  POLL_SECS = 0.2, -- state poll
  REBIND_SECS = 2, -- retry after a listener fails to open

  -- The dial banks' params, in bank order. Watched by default.
  BANK_PARAMS = {
    'Temperature', 'Tint', 'Exposure', 'Contrast',
    'Highlights', 'Shadows', 'Whites', 'Blacks',
    'Texture', 'Clarity', 'Vibrance', 'Saturation',
    'PostCropVignetteAmount',
  },

  DEBUG = false, -- log every command when true
}
