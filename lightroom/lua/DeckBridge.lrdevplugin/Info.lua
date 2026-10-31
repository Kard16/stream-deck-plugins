-- Info.lua runs in a restricted environment: no import or require here.
return {
  LrSdkVersion = 15.0,
  LrSdkMinimumVersion = 15.0, -- the user runs 15.3; newer calls are feature-detected at runtime
  LrToolkitIdentifier = 'com.karimdhanji.deckbridge',
  LrPluginName = 'Deck Bridge',

  LrInitPlugin = 'Init.lua',
  LrForceInitPlugin = true, -- still waits for Lightroom's window to be activated once
  LrShutdownPlugin = 'Shutdown.lua', -- disable, remove and Reload Plug-in
  LrShutdownApp = 'ShutdownApp.lua', -- quit

  -- File > Plug-in Extras, in every module. Force-init needs at least one menu item.
  LrExportMenuItems = {
    { title = 'Deck Bridge: Status', file = 'MenuStatus.lua' },
  },

  VERSION = { major = 1, minor = 0, revision = 0, build = 1 }, -- Config.VERSION matches
}
