# Lightroom Classic SDK: controlling Lightroom Classic in real time from a Stream Deck +

*Research date: 2026-10-31. Scope: the Lightroom Classic (LrC) side of a Stream Deck + bridge on macOS.*

**User context (scope update from coordinator):** LrC **15.3** on **macOS 26.6.2**, personal use. The Claude↔Lightroom MCP bridge is **out of scope**; MCP prior art is noted only briefly. Priorities:

1. Develop sliders on the dials, with live values on the touch strip.
2. Culling and rating on the keys.
3. Presets and one-click tools: auto settings, copy/paste/sync, snapshots, virtual copies, and AI tools where the SDK allows.

**Source labels used below:**
- **[Adobe]**: official Adobe page or Adobe staff post.
- **[Adobe-mirror]**: unofficial HTML mirror of Adobe's LuaDoc API reference at lrc.mcor.dev, about SDK 14.1–14.3. It lacks functions added in 14.5 and later.
- **[OSS]**: source code of an open-source project.
- **[2nd]**: secondary summary of SDK docs by a third party.
- **[Community]**: forum, blog or Reddit post.

---

## 0. Verdict (TL;DR)

**Feasible, and moderately difficult.** The Lightroom side is well-trodden. MIDI2LR has driven LrC this way since 2015. In 2026, at least four commercial Stream Deck + products ship Lua-SDK bridges with live dial values: FlowKits, SideshowFX, DevelopDeck and Lightroom Dials. FlowKits and SideshowFX run on macOS.

Documented APIs cover all three user priorities:
- **Dials:** `LrDevelopController.setValue/getValue/getRange/increment` plus `addAdjustmentChangeObserver`.
- **Keys:** `LrSelection` handles flag, rating, label and next/previous. `LrApplicationView` handles modules and views.
- **Presets and one-click tools:** `photo:applyDevelopPreset`, `copySettings/pasteSettings`, `setAutoTone/WB`, snapshots, virtual copies, AI masks, and Denoise through `setEnhance` on 15.x.

The difficulty comes from five areas:
- The sandboxed Lua 5.1 environment and sparse, lagging docs.
- No event for selection changes, so the plugin must poll.
- Most Develop calls work only while the Develop module is active.
- Hand-rolled two-socket transport with reconnect logic.
- A few hard gaps that need keyboard-shortcut workarounds: Sync dialog, Auto Sync toggle, brush painting and brush size, and arbitrary menu commands.

Plan for about one to two weekends to an MVP (dials and culling keys) and a few weeks to a robust plugin, for a developer comfortable with Lua and Node.

---

## 1. Current state

### 1.1 Lightroom Classic versions (as of 2026-10-31)

| Version | Release date | Notes |
|---|---|---|
| 15.0 | 2025-10-28 (Adobe MAX 2025) | macOS 14+ minimum, supports macOS 26. Catalog upgrade. Assisted Culling (EA), auto-stacking, Dust Removal. Large AI edits move to `.acr` sidecars. [Community: Lightroom Queen] |
| 15.0.1 | Nov 2025 | Bug fixes. [Community] |
| 15.1 / 15.1.1 | Dec 2025 | [Community, Adobe release-notes snippet] |
| 15.2 | 2026-02-20 | SDK bug fixes for `catalog:getCurrentViewFilter()` stack options and `photo:addOrRemoveFromTargetCollection()`. [Community] |
| 15.2.1 | Mar 2026 | [Adobe release-notes snippet] |
| **15.3 (user's version)** | **2026-04-15** | Background AI processing for copy/paste/sync/Auto Sync/presets. "AI Updates Required" dialog on export. "Interactive slider editing optimized." [Community: Lightroom Queen] |
| 15.3.1 | May 2026 | [Adobe release-notes snippet] |
| 15.4 | 2026-06-18 | Withdrawn 06-20 for a data-loss bug. Brush-mask storage changed (see 1.4). |
| 15.4.1 | 2026-06-22 | Fixes the data-loss bug. [Community] |
| 15.5 | 2026-08-03 | AI-mask Feather and Edge, Render to DNG, catalog repair. [Community] |
| 15.5.1 | Aug–Sep 2026 | Bug fixes. [Community] |
| **15.6 (current)** | **2026-09-29** | Reflection Removal improved, mask "Check All/None". Fixes an SDK race between `applyDevelopPreset` and `updateAISettings`. [Adobe announcement] |

**15.3 is not the current release.** 15.6 (2026-09-29) is current, and 15.4.1, 15.5 and 15.5.1 came in between. A third-party download site lists a 15.6.0.2 build dated 2026-10-07; this is unofficial.

**Next major release:** expected at **Adobe MAX 2026, Nov 10–12, 2026, Miami Beach** [Adobe: max.adobe.com]. Adobe ships the new LrC major version around MAX each year. The "bigger release at MAX" expectation comes from a commenter, not from Adobe.

As of today no LrC 16 or MAX 2026 release exists.

### 1.2 SDK versions and where to get the SDK

| SDK | Date | Evidence |
|---|---|---|
| 13.3 | 2024-05-21 | [Adobe] staff post: "SDK 13.3 is now available… the guide has also been updated" (includes the controller addendum). |
| 14.0 | 2024-10-14 | [Adobe] MAX release announcement. |
| 14.3 | mid-2025 | Was still the Developer Console version in Nov 2025. [Community] |
| 15.1 | ≤ 2025-12-16 | A forum user reports downloading the "SDK 15.1 resources". [Community] |
| 15.2 | before Oct 2026 | Found on disk (Readme.txt) by the LrC-AVG project. [OSS] |
| **15.3** | 2026 (likely with LrC 15.3) | Described as "the latest published SDK"; "LrC 15.4 shipped without a new SDK." [2nd: kevinkiklee/adobe-plugin-skills, "last verified July 2026"] |

**Download:** Adobe Developer Console → Services & APIs → **Lightroom Classic** → View downloads (`https://developer.adobe.com/console/servicesandapis`). Sign-in with an Adobe ID is required. The zip contains:
- the **Programmer's Guide** (PDF);
- the **API Reference** (HTML LuaDoc);
- sample plug-ins;
- the "Addendum: Externally Controlling Lightroom" controller guide, which is exactly this use case. It was re-included and updated in SDK 13.3.

The console download links were reported broken in 2024 and June 2025 [Community]. An unofficial HTML mirror of the reference is at `lrc.mcor.dev`. It is useful, but it is **pre-14.5**: no `setEnhance`, reflection-removal or distraction-removal functions.

### 1.3 Language and runtime

- **Lua 5.1(.5)**, sandboxed [2nd].
- Available: `io`, `math`, `string`; `os` limited to clock/date/time/tmpname; partial `table`, `coroutine` and `debug`.
- Unavailable: `package`, native modules, `collectgarbage`, `setfenv`/`getfenv`.
- `Info.lua` runs in a tiny restricted environment with no `import` or `require`.
- No JSON library ships with the SDK. Projects vendor a `JSON.lua`; both MIDI2LR-style text lines and JSON lines are proven.
- Plug-in code runs as **cooperative tasks (coroutines) on LrC's main UI thread** [Adobe-mirror LrTasks].

### 1.4 SDK changes 2023–2026, relevant subset

| SDK / LrC | Additions and changes |
|---|---|
| 12.0 (Nov 2022) | `setValue/increment/decrement` gain `withClippingOn`. Mask subtypes `background`, `objects`, `people`. `goToHealing`/`resetHealing`. [Community: johnrellis] |
| 13.0 | New `getDevelopSettings` keys (HDR, Lens Blur, Point Colors). [Community] |
| 13.2 | **Point Color** API (`addPointColorSwatch`…), `revealPanel` sub-panels (`hslColorPanel`, `pointColorPanel`). [Adobe-mirror, Community] |
| 13.3 | **Lens Blur** (`setLensBlurBokeh`, `LensBlur*` params). **`photo:updateAISettings()`, `catalog:updateAISettings(photos)`**. `applyDevelopPreset(…, updateAISettings)`. [Adobe-mirror] |
| 13.5 | `LrDigest.MD4/MD5/SHA1` deprecated. |
| 14.0 (Oct 2024) | `catalog:deleteAllEmptyMasks(photos)`. `keyword:setAttributes` ignoreCase. **LrLogger log location moved** to `~/Library/Logs/Adobe/Lightroom/LrClassicLogs/`. [Adobe] |
| 14.1 | **Remove/spot API**: `goToRemove`, `getAllSpots`, `setSelectedSpotType(spotType, useGenAI)`, variations, `goToEyeCorrection`. [Adobe-mirror] |
| 14.3 | `LrApplication.shutdown()`, `LrSelection.removeFromCatalog()`. [Adobe-mirror] |
| 14.4 (Jun 2025) | Denoise, Raw Details and Super Resolution become **non-destructive Detail-panel toggles**. SDK initially had no access to them (bug filed 2025-06-30). [Community] |
| 14.5 (Aug 2025) | Adobe replied that "the August update contains an update regarding this issue" [Adobe]. Added: `toggleEnhance` (now deprecated), `changeDenoiseAmount(1–100)`, `getEnhancePanelState()`, `hasFilterWithName/resetFilterWithName` (`enhance`, `dereflect`, `remove_people`), reflection-removal and distraction-removal (people) functions. [2nd + OSS] |
| 15.0 (Oct 2025) | Undocumented `LrApplication.addHapticObserver` (found by johnrellis's discovery scripts; purpose unconfirmed). [Community] |
| **15.3** | **`LrDevelopController.setEnhance(paramName, value, denoiseAmount)`** with paramName `denoise`/`rawDetails`/`superRes`. `photo:isAvailableForEditing()`, `photo:needsUpdateAISettings()`, `catalog:pasteSettings(photos, updateAISettings)`, `catalog:getPhotosAvailableForEditing(photos)` (splits off photos locked by background AI). [2nd; consistent with LrC-AVG not finding `setEnhance` in the 15.2 docs] |
| 15.4 | Brush strokes with ≥250 points are stored as opaque `BrushTable` instead of `Dabs` in `getDevelopSettings()`. This broke johnrellis's Copy Settings plugin. Fix: `folder:getParent()` on Windows. [Community] |
| 15.6 | Fix: race between `photo:applyDevelopPreset()` and `catalog:updateAISettings()`. [Adobe] |

**For the user's 15.3:** everything above through 15.3 should be present. The 15.4 brush-format change and the 15.6 race fix do not apply yet. Keep this in mind before upgrading.

### 1.5 Is Adobe replacing the Classic plug-in model (UXP)?

**No sign of it.**
- Adobe's developer blog (Jul 2022): "Neither Lightroom nor Lightroom Classic have UXP support on their roadmaps at the time of this writing" [Adobe].
- No later Adobe statement was found.
- Adobe kept shipping Lua SDK releases (14.x, 15.1–15.3) and fixing SDK bugs in 15.0, 15.2, 15.4, 15.5 and 15.6 through Sep 2026.
- The real risk is **undocumented formats changing**, such as mask and brush data in 15.4, not the SDK disappearing.

---

## 2. Real-time Develop control (dials)

### 2.1 `LrDevelopController` functions

All are called as `LrDevelopController.fn(...)`. "Dev" means the call must be made while the Develop module is active. The list comes from [Adobe-mirror] plus the 14.5/15.3 additions [2nd/OSS].

| Group | Functions (since) |
|---|---|
| Values | `getValue(param)` (6.0, Dev), `setValue(param, value, withClippingOn)` (6.0, Dev; 3rd arg 12.0), `getRange(param)` → min, max (6.0, Dev), `increment(param, withClippingOn)` / `decrement(...)` (6.0, Dev; step size undocumented), `resetToDefault(param)`, `resetAllDevelopAdjustments()`, `resetCrop()`, `resetTransforms()` (6.6), `resetRedeye()`, `resetMasking()`, `resetHealing()` |
| Tracking / history | `startTracking(param)`, `stopTracking(isLocalParam)`, `setTrackingDelay(seconds)` (default 2 s), `setMultipleAdjustmentThreshold(seconds)` (default 0.5 s); all 6.0, Dev |
| Observer | `addAdjustmentChangeObserver(functionContext, observer, callback)` (6.0, Dev). Fires "any time the adjustments in the Develop module change". Callback receives the observer object, so you must `getValue()` the params you care about. No modal dialogs inside it. |
| UI | `revealPanel(paramOrPanelID, subPanelID)`, `revealPanelIfVisible` (8.1), `revealAdjustedControls(bool)`, `getSelectedTool()`, `selectTool(tool)` (tools: `loupe, crop, dust, redeye, masking, point_color, local_point_color, depth_refinement, upright`), `showClipping()` (7.4), `toggleOverlay()` (7.4), `editInPhotoshop()` (7.4) |
| Process version | `getProcessVersion()`, `setProcessVersion(v)` |
| One-click | `setAutoTone()`, `setAutoWhiteBalance()` (7.4) |
| Masking (11.0) | `goToMasking`, `createNewMask(type, subtype)`, `addToCurrentMask`, `subtractFromCurrentMask`, `intersectWithCurrentMask`, `getAllMasks`, `getSelectedMask`, `getSelectedMaskTool`, `selectMask`, `selectMaskTool`, `deleteMask`, `deleteMaskTool`, `toggleHideMask`, `toggleHideMaskTool`, `toggleInvertMaskTool`, `invertMask` (11.4), `duplicateAndInvertMask` (11.4). Types: `brush, gradient, radialGradient, rangeMask, aiSelection`. Subtypes: `color, luminance, depth, subject, sky, background, objects, people, landscape`. |
| Remove / spots (14.1) | `goToRemove(spotType[, whichFeature])`, `countAllSpots`, `getAllSpots`, `get/setSelectedSpotIndex`, `get/setSelectedSpotParams`, `get/setSelectedSpotType(spotType, useGenAI)`, `deleteSelectedSpot`, `deleteSelectedVariation`, `gotoNext/PreviousVariation`, `moveSelectedSpot`, `refreshSelectedSpot`, `get/setRemovePanelPreferences`. Spot types: `heal_patchmatch, heal, clone`. |
| Eye correction (14.1) | `goToEyeCorrection('red_eye' or 'pet_eye')` |
| Point Color (13.2, PV3+) | `addPointColorSwatch`, `deletePointColorSwatch`, `getSelectedPointColorSwatchIndex`, `selectPointColorSwatch(1–8)`, `updateSelectedPointColorSwatch`, `togglePointColorRangeVisualization` |
| Color grading (10.0) | `getActiveColorGradingView`, `setActiveColorGradingView` (`3-way, shadow, midtone, highlight, global`) |
| Lens Blur (13.3) | `getSelectedLensBlurBokeh`, `setLensBlurBokeh` (`Circle, SoapBubble, Blade, Ring, Anamorphic`), `toggleLensBlurDepthVisualization` |
| AI / Enhance (14.5+) [2nd/OSS] | `changeDenoiseAmount(1–100, absolute)`, `getEnhancePanelState()`, `toggleEnhance` (deprecated), **`setEnhance(name, bool, denoiseAmount)` (15.3)**, `toggleReflectionRemoval(amount?, quality?, cb?)`, `changeReflectionRemovalAmount(-100..100)`, `changeReflectionRemovalQuality('preview' / 'standard' / 'best')`, `getReflectionRemovalPanelState()`, `detectDistractingPeople()`, `applyRemovalOnDetectedDistractingPeople(cb?)`, `hasFilterWithName/resetFilterWithName` |
| Deprecated | `goToSpotRemoval`, `goToHealing`, `goToDevelopGraduatedFilter`, `goToDevelopRadialFilter`, `resetGradient`, `resetCircularGradient`, `resetBrushing`, `resetSpotRemoval` |

### 2.2 Controllable parameter names [Adobe-mirror]

| Panel | Parameters |
|---|---|
| Basic (`adjustPanel`) | Temperature, Tint, Exposure, Highlights, Shadows, Brightness, Contrast, Whites, Blacks, Texture, Clarity, Dehaze, Vibrance, Saturation, PresetAmount, ProfileAmount |
| Tone curve (`tonePanel`) | ParametricDarks/Lights/Shadows/Highlights, ParametricShadowSplit/MidtoneSplit/HighlightSplit, ToneCurve, ToneCurvePV2012 (+Red/Green/Blue), CurveRefineSaturation |
| HSL / Color mixer (`mixerPanel`) | HueAdjustment, SaturationAdjustment and LuminanceAdjustment × {Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta}; GrayMixer × the same eight colors; PointColors |
| Color grading (`colorGradingPanel`) | SplitToningShadowHue/Saturation, ColorGradeShadowLum, SplitToningHighlightHue/Saturation, ColorGradeHighlightLum, ColorGradeMidtoneHue/Sat/Lum, ColorGradeGlobalHue/Sat/Lum, SplitToningBalance, ColorGradeBlending |
| Detail (`detailPanel`) | Sharpness, SharpenRadius, SharpenDetail, SharpenEdgeMasking, LuminanceSmoothing, LuminanceNoiseReductionDetail/Contrast, ColorNoiseReduction, ColorNoiseReductionDetail/Smoothness |
| Effects (`effectsPanel`) | PostCropVignetteAmount/Midpoint/Feather/Roundness/Style/HighlightContrast, GrainAmount/Size/Frequency |
| Lens / Transform (`lensCorrectionsPanel`) | AutoLateralCA, LensProfileEnable, LensProfileDistortionScale/VignettingScale, LensManualDistortionAmount, DefringePurple/Green Amount/HueLo/HueHi, VignetteAmount/Midpoint, PerspectiveVertical/Horizontal/Rotate/Scale/Aspect/X/Y/Upright |
| Calibration (`calibratePanel`) | ShadowTint, Red/Green/Blue Hue and Saturation |
| Lens Blur (`lensBlurPanel`) | LensBlurActive, LensBlurAmount, LensBlurCatEye, LensBlurHighlightsBoost, LensBlurFocalRange |
| Crop | `straightenAngle` (documented). MIDI2LR also drives `CropTop/CropLeft/CropBottom/CropRight` through `setValue` [OSS]. |
| Local (selected mask) | `local_` + Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Clarity, Dehaze, Texture, Temperature, Tint, Saturation, Hue, Sharpness, LuminanceNoise, Moire, Defringe, ToningHue/Saturation/Luminance, Amount, Grain, RefineSaturation, PointColors, Maincurve/Red/Green/Bluecurve (PV-dependent) |

**Notes:**
- Temperature is **logarithmic** for raw/DNG and linear for everything else. Its range depends on file type (Kelvin for raw, -100..100 for JPEG). Always call `getRange()`.
- `setValue` handles **numbers only**. Adobe staff (2018) confirmed it "doesn't support the case when the value is not a number". Therefore:
  - Tone-curve point tables, profiles and `Enable*` panel toggles go through `photo:applyDevelopSettings{...}`.
  - Some params (point curve, Point Color, Lens Blur) don't respond to `resetToDefault` [Community 2023].

### 2.3 Develop must be the active module

Most functions say "Must be called while the Develop module is active." Some also need a specific tool open: masking, Remove, PV3+.

MIDI2LR's pattern is to call `LrApplicationView.switchToModule('develop')` if needed, then `LrTasks.yield()` before `setValue` [OSS]. An alternative in Library is `photo:quickDevelopAdjustImage(name, size)` (Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Clarity, Vibrance, Saturation) and `quickDevelopAdjustWhiteBalance` for relative nudges on selected photos without leaving Library.

### 2.4 Latency, throughput and undo history

- **No published benchmarks** for LrSocket or `setValue` rates were found.
- Evidence that 20–60 updates/s from a dial is fine:
  - MIDI2LR handles continuous MIDI encoders this way.
  - FlowKits, SideshowFX and DevelopDeck ship live dial control.
  - lightroom-mcp pushes multi-MB base64 JPEGs over LrSocket in single messages.
- The realistic bottleneck is **LrC's render**: GPU, file size, masks and AI. The socket is not the limit.
- An old Adobe-forum explanation: nudging renders each intermediate state, which causes lag or overshoot on slow systems. Hence: **coalesce on the Node side and send only the latest absolute value per param**, at about 20–30 Hz.
- **Undo flooding is handled by LrC's tracking state.**
  - `startTracking` gives "faster, lower-quality redraw" and prevents history states.
  - Tracking stays on for `setTrackingDelay` seconds after each adjustment (default 2 s). It turns off when a different parameter is adjusted.
  - `stopTracking` creates "a single history state".
  - `setMultipleAdjustmentThreshold` (default 0.5 s) groups different params together.
  - Result: one dial gesture becomes one history step. Call `stopTracking()` on dial release or touch-up for snappier commits.
- **How MIDI2LR handles it [OSS]:**
  - The C++ app keeps the value model and converts encoders into absolute values.
  - The plugin calls `setValue` only if the value differs.
  - "Pickup" accepts a value within 0.03 of the current one, or if the param moved in the last 0.5 s.
  - The observer → app push is throttled to **10 Hz** (`os.clock()+0.1`).
  - A user-set tracking delay is applied with `setTrackingDelay`.
  - Main loop: `LrTasks.sleep(0.29)`.
  - "Fine" commands give 1/2–1/16 step sizes.
  - MIDI2LR FAQ: with photos synced to Lightroom Mobile, adjusting another slider before the tracking delay expires jumps the panel back to Basic. Workaround: shorten the tracking delay (or disable the GPU).
- `LrTasks.yield` is reported to be over 100× slower on Windows than on Mac [Community], so macOS is the better platform here.

### 2.5 Multiple selected photos and Auto Sync

- `LrDevelopController` acts on the **active ("most selected") photo** in Develop.
- Built-in Auto Sync (toggle Cmd+Opt+Shift+A) echoes edits on the most-selected photo to the rest of the selection. Whether SDK `setValue` calls propagate under Auto Sync is **unverified**, though plausible since the controller drives the same UI controls.
- For deterministic batch edits, read the active photo's values and `applyDevelopSettings` to each target photo inside one write gate. Quick Develop is another option.
- LrC 15.3+ can **lock photos while background AI updates run**. Check `photo:isAvailableForEditing()` (15.3) [2nd].

---

## 3. Library and workflow control (keys)

### 3.1 `LrSelection` (27 functions; all 6.0 except removeFromCatalog 14.3) [Adobe-mirror]

- **Flags and ratings:** `flagAsPick`, `flagAsReject`, `removeFlag`, `getFlag` (-1/0/1), `setRating(0–5)`, `increaseRating`, `decreaseRating`, `getRating`.
- **Labels:** `setColorLabel('red' | 'yellow' | 'green' | 'blue' | 'purple' | 'none')`, `toggleRed/Yellow/Green/Blue/PurpleLabel`, `clearLabels`, `getColorLabel`.
- **Navigation and selection:** `nextPhoto`, `previousPhoto`, `selectAll`, `selectNone`, `selectInverse`, `selectFirstPhoto`, `selectLastPhoto` (all modules since 13.0), `extendSelection(dir, n)`, `deselectActive`, `deselectOthers`, `removeFromCatalog` (14.3).
- **Scope:** with Grid visible these act on all selected photos; otherwise on the active photo only.
- No catalog write gate is needed, because they behave like UI commands.
- Whether LrC's Auto Advance (Caps Lock) applies to SDK ratings is unverified. Plan an optional "rate then `nextPhoto()`" in the plugin.

### 3.2 `LrApplicationView` [Adobe-mirror]

- `switchToModule('library' | 'develop' | 'map' | 'book' | 'slideshow' | 'print' | 'web')` and `getCurrentModuleName()`.
- `showView('loupe' | 'grid' | 'compare' | 'survey' | 'people' | 'develop_loupe' | 'develop_before_after_horiz' | 'develop_before_after_vert' | 'develop_before' | 'develop_reference_horiz' | 'develop_reference_vert')`. This covers **Before/After**.
- `gridView`, `toggleLoupe`, `gridViewStyle`, `cycleLoupeViewInfo`.
- `zoomIn`, `zoomOut`, `toggleZoom`, `zoomToOneToOne` (10.0).
- `fullscreenPreview`, `fullscreenHidePanels`, `nextScreenMode`.
- Secondary display: `toggleSecondaryDisplay`, `showSecondaryView('loupe' | 'live_loupe' | 'locked_loupe' | 'grid' | 'compare' | 'survey' | 'slideshow')`, `isSecondaryDisplayOn`, `getSecondaryViewName`, `toggleSecondaryDisplayFullscreen`.

### 3.3 Library filters (useful for culling)

- `catalog:setViewFilter(filterTableOrPresetId)` and `catalog:getCurrentViewFilter()` (3.0).
- Filter fields include `pick` (flagged/rejected/unflagged), `minRating` + `ratingOp`, `label1..5`, `edit`, `whichCopies`, and `searchString` [Adobe-mirror].
- Example: a "show unflagged only" key.

### 3.4 Presets, copy/paste/sync, auto settings, snapshots, virtual copies

- **Develop presets:**
  - List with `LrApplication.developPresetFolders()` → `folder:getDevelopPresets()` → `preset:getName()/getUuid()`. `developPresetByUuid(uuid)` also exists.
  - Apply with `photo:applyDevelopPreset(preset, plugin, presetAmount 0–200, updateAISettings)` inside `catalog:withWriteAccessDo`.
  - **Adaptive or AI-mask presets:** pass `updateAISettings = true`, or run `photo:updateAISettings()` (13.3) in a **separate** write transaction. Developers report that doing both in one transaction doesn't recompute masks.
  - On 15.3 a reported race exists; the workaround is a `LrTasks.sleep(0.1)` before `catalog:updateAISettings`. The race was fixed in 15.6. [Community/OSS]
  - Presets created with `addDevelopPresetForPlugin` are hidden from the Presets panel.
- **Copy/Paste:** `photo:copySettings()` copies from the photo selected in the UI and must run in a task. `photo:pasteSettings(updateAISettings)` (10.3). `catalog:pasteSettings(photos, updateAISettings)` (15.3, [2nd]).
- **Sync:** there is no Sync-Settings or Auto-Sync API. Either emulate it with `getDevelopSettings()` + `applyDevelopSettings(subset)`, or send shortcuts (section 4).
- **Auto:** `LrDevelopController.setAutoTone()` and `setAutoWhiteBalance()` (7.4) work only on the active Develop photo.
  - In Library: `photo:applyDevelopSettings{WhiteBalance="Auto"}` or `photo:quickDevelopSetWhiteBalance('Auto')`.
  - "Auto Settings" can only be applied through a preset (johnrellis, 2025).
  - LRBridge notes LrC can ignore Auto Tone/WB right after slider moves, so add a short cooldown [Community].
- **Snapshots:** `photo:createDevelopSnapshot(name, updateInPlace)` (write gate), `getDevelopSnapshots()`, `applyDevelopSnapshot(id)`, `deleteDevelopSnapshot(id)`. Gotcha: reusing a name with `updateInPlace=true` replaces the existing snapshot [OSS].
- **Virtual copies:** `catalog:createVirtualCopies(copyName)` (5.0, run in a task) acts on the selected photos.
- **Rotate:** `photo:rotateLeft()/rotateRight()` (7.4). Since 11.4 these affect only that photo; before 11.4 they could rotate the whole selection.
- **Undo/Redo:** `LrUndo.undo()`, `redo()`, `canUndo()`, `canRedo()` (6.0). MIDI2LR still sends Cmd+Z keystrokes instead.
- **Treatment and crop aspect:** `photo:quickDevelopSetTreatment('color' | 'grayscale')`, `quickDevelopCropAspect`.
- **Profiles:** set through `applyDevelopSettings` or presets, since profiles are non-numeric; `ProfileAmount` is numeric.

### 3.5 Catalog writes, keywords, collections, export

- `catalog:withWriteAccessDo(name, fn, {timeout = n})` returns "executed", "queued" or "aborted". Without `timeoutParams` it throws if the catalog is busy, so always pass a timeout from a deck.
- `withProlongedWriteAccessDo` shows a modal progress dialog.
- Reportedly, successive write gates on Mac without user interaction merge into one undo step [2nd].
- **Keywords:** `catalog:createKeyword(name, synonyms, includeOnExport, parent, returnExisting)` + `photo:addKeyword(kw)` / `removeKeyword` (write gate).
- **Collections:** `catalog:createCollection(name, parent, canReturnPrior)` + `collection:addPhotos(photos)`.
- **Export without a dialog:** `LrExportSession{photosToExport=…, exportSettings=…}:doExportOnCurrentTask()`. You build the settings table yourself; saved export presets are not directly exposed.

### 3.6 Reading state back

- **Current photo and selection:** `catalog:getTargetPhoto()`, `getTargetPhotos()`; `photo.localIdentifier`.
- **Metadata:** `photo:getRawMetadata('rating' | 'pickStatus' | 'path' | 'width' …)`, `batchGetRawMetadata`, `getFormattedMetadata('fileName')`.
- **Develop settings:** `photo:getDevelopSettings()` (task; format undocumented and changes between versions).
- **Thumbnails for keys or the touch strip:** `photo:requestJpegThumbnail(w, h, cb)` (5.0).
  - **Keep the returned request object referenced**, or it may be cancelled.
  - Guard against the callback firing twice.
  - LrC returns the **smallest cached preview ≥ the requested size** (e.g. 855 px for a 512 request), so resize on the Node side.
  - Encode with `LrStringUtils.encodeBase64` (1.3) for newline-framed transport, or write a temp file and send the path.
  - Previews can lag behind edits.
- **No histogram API.** Compute one from the thumbnail on the Node side.

---

## 4. What is NOT possible (or only partly), with workarounds

| Gap | Status | Workaround |
|---|---|---|
| Arbitrary menu commands and keyboard shortcuts | No API to invoke menu items or send keys from Lua. | Stream Deck **Hotkey** actions (LrC must be frontmost; macOS shortcuts are language-dependent). MIDI2LR has the Lua plugin ask its native app to inject keystrokes (`SendKey …`) for copy/paste, brush size/feather, overlay color, slider +/- and undo. |
| Sync Settings dialog, Auto Sync toggle, "Sync without dialog" | No API. | Shortcuts: Sync dialog **Cmd+Shift+S**, Auto Sync **Cmd+Opt+Shift+A**, Paste from Previous **Cmd+Opt+V**; Option-click Sync bypasses the dialog [Adobe evangelist J. Kost, 2024]. Or emulate sync with `applyDevelopSettings`. |
| Brush painting, brush size/feather, drawing gradients interactively | No API. Mask geometry lives in undocumented `getDevelopSettings` data; brush storage changed in 15.4. | Create masks with `createNewMask` and let the user paint. Keystrokes for brush size. Guarded `applyDevelopSettings` writes, as lightroom-mcp does with version checks. |
| AI masks | **Possible:** `createNewMask('aiSelection', 'subject' / 'sky' / 'background' / 'landscape' …)`. `people` prompts the user to pick people. `objects` needs user brushing. Person/landscape **parts** are not exposed. | A preset containing a person mask gets converted to "All People" (johnrellis). Sub-parts need the mouse. |
| Denoise / Raw Details / Super Resolution | **Denoise possible on 15.x:** `setEnhance('denoise', true, amt)` (15.3) or `changeDenoiseAmount` (14.5). It is asynchronous, takes about 10 s/photo, and works on the active Develop photo only. Super Resolution is **conflicting**: `setEnhance('superRes', …)` per [2nd], but lightroom-mcp lists Super Res as not exposed. | Runtime-check `LrDevelopController.setEnhance` and verify on 15.3. |
| Reflection removal and distraction (people) removal | API exists from 14.5 per [2nd]. Untested here. | Runtime-check and test. |
| Generative Remove, heal/clone **creation** | Cannot create spots. Can only edit or switch existing ones (`setSelectedSpotType(type, useGenAI)`, variations). | `goToRemove()` opens the tool for mouse work. |
| Lens Blur focus/depth painting | Sliders and bokeh possible (13.3). Focus point and depth refinement need the mouse. | `selectTool('depth_refinement')` opens it. |
| Point Color eyedropper sampling | Swatches can be added, selected or updated by value (13.2). | `selectTool('point_color')`, then the mouse. |
| Tone-curve points, profiles, `Enable*` panel switches | Not via `setValue` (numbers only). | `photo:applyDevelopSettings{...}`. |
| Histogram, pixel access | None. | Compute from `requestJpegThumbnail` output in Node. |
| HDR/Panorama merge, stacking (create), folder create/move/delete, print/book/slideshow creation, Render to DNG (15.5) | Not exposed (lightroom-mcp list + LrC-AVG). | Shortcuts open the dialogs (e.g. Ctrl+H / Ctrl+M); otherwise do it manually. |
| Assisted Culling scores (15.x) | No evidence they're readable via the SDK. | None known. |
| Selection-changed event | None documented. An undocumented `LrApplication.addActivePhotoChangeObserver` was mentioned in 2017 but is unverified. | Poll `getTargetPhoto()` every 150–300 ms. |
| Adding UI inside Develop panels | Not possible. | Floating dialogs from Plug-in Extras only. |
| Plugin running before LrC's window is shown | `LrInitPlugin` runs only once the LrC window is first activated, even with `LrForceInitPlugin` (measured on 15.6 macOS) [OSS]. Plug-in tasks are reportedly paused while a menu or Plug-in Manager is open [Community]. | Activate LrC once, e.g. launch it from the deck. Show an "offline" state on keys. |

---

## 5. External communication

### 5.1 `LrSocket` (6.0) [Adobe-mirror + OSS/Community]

**Binding:** `LrSocket.bind{ functionContext, plugin=_PLUGIN, port, mode='send'|'receive', onConnecting(sock, port), onConnected(sock, port), onMessage(sock, msg), onClosed(sock), onError(sock, err) }`. It returns an object with `send(str)` (send mode only), `reconnect()` and `close()`.

- **Localhost only.** It opens a listening socket "on localhost".
- **LrC is always the server.** The external process connects as a TCP client. LrSocket cannot initiate outbound connections.
- **One direction per socket.** Use two ports: LrC "receive" for commands and LrC "send" for events. MIDI2LR, lightroom-mcp, lightroom-cli and Adobe's controller addendum all use this two-port pattern.
- **`port = 0`** lets the OS assign a port. `onConnecting` reports the chosen port, which you then publish through a discovery file. Example: 4xiomdev writes `/tmp/lightroom_mcp_custom_ports.json`; lightroom-mcp writes a token to `~/.config/lightroom-mcp/token`.
- **Framing:** each inbound message **must end with `\n`**; `onMessage` fires per line. A sender without a newline never triggers `onMessage` [Community 2015]. Outbound: append `"\n"` yourself.
- **Payload size:** multi-MB base64 lines work in practice (lightroom-mcp previews up to about 3.5 MB). No documented limit.
- **Lifecycle:** sockets close automatically when the plugin is disabled or removed, and when the function context exits. Keep a `while running do LrTasks.sleep(..) end` loop inside the context.
- **Reconnect patterns (proven):**
  - receive `onError 'timeout'` (no client yet) → `sock:reconnect()`.
  - receive `onClosed` (client left) → `sock:reconnect()`, then **close and recreate** the send socket. MIDI2LR: "calling SERVER:reconnect causes LR to hang".
  - send `onError` → `reconnect()`.
  - lightroom-mcp adds generation counters to ignore callbacks from replaced sockets, heartbeats (ping every 30 s, stale after 90 s), rebind on "failed to open" (port held by a leftover instance), and an instance id to survive "Reload Plug-in". It also notes `onClosed` may fire synchronously during `close()`.
- **Security:** localhost-only and no TLS. Any local process can connect. For personal use a token in a file in `~/Library/Application Support/<id>/` is optional.

### 5.2 Other channels

- **`LrHttp`** is client-only (`get`, `post`, `postMultipart`, from a task). LrC could poll a Node HTTP server, but that is higher latency than sockets.
- **File polling** works but is slow.
- **`LrShell`** only opens or reveals files in apps.
- **`LrTasks.execute(cmd)`** runs a shell command, blocking only the calling task. It can launch helpers or `osascript`; keystrokes that way need macOS Accessibility permission for LrC.

### 5.3 Lifecycle, tasks and observers

- `LrInitPlugin` (2.0) runs on demand. With `LrForceInitPlugin = true` (4.0) it runs at startup; lightroom-mcp says this works **only if the plugin also has at least one menu item**, as in Adobe's own socket sample.
- `LrShutdownPlugin` (3.0) runs on disable, remove or reload. `LrShutdownApp` (4.0) runs on quit with a 10 s budget and no `LrDialogs`. lightroom-mcp removed its quit hooks after they added a 7.7 s quit delay.
- Use `LrFunctionContext.postAsyncTaskWithContext(name, fn(context))` for a long-lived task that owns the sockets. lightroom-mcp notes a plain `startAsyncTask` from the init script gets cancelled when init returns.
- Use **`LrTasks.pcall`, not `pcall`**, around anything that yields; plain `pcall` raises "attempt to yield across" errors. `xpcall` and `debug.traceback` are unreliable in the sandbox.
- **Observers:** `LrDevelopController.addAdjustmentChangeObserver` is the only Develop push event. It must be registered while Develop is active, and it covers mouse moves, presets and undo. There are **no** selection, module, rating or flag observers, so poll them. MIDI2LR polls the module and target photo every 0.29 s.

### 5.4 Prior-art bridges

**MIDI2LR** (GPL-3; v6.3.1.0, 2026-07-30; `LrSdkVersion = 15.0`, minimum 15.0) [OSS]:
- **Plugin side:** `receive` on **58763** and `send` on **58764**, on 127.0.0.1; the C++ app connects to both.
- **Protocol:** text lines `"<Name> <value>\n"`. Develop params use normalized values; actions like `Pick 1`; plugin → app `"<Param> %g\n"`, plus `SendKey …` for keystroke-only features. The app restarts the plugin connection on close.
- **Behavior:** auto-switches to Develop and yields before `setValue`. Observer push is throttled to 10 Hz. A polling loop watches module and photo changes.
- **Version:** this version requires LrC 15+.

**lightroom-mcp** (Automaat; MIT; 166★; created 2026-02-07, pushed 2026-10-30) [OSS]:
- Same dual-port pattern and **same default ports 58763/58764**, which conflict with MIDI2LR.
- Newline-delimited JSON with a token, a dispatch table, `LrTasks.pcall`, and heartbeat and rebind logic as described in 5.1.
- MCP is out of scope, but this is the best current LrSocket reference code.

---

## 6. Dev workflow on macOS

- **Layout:** develop in `DeckBridge.lrdevplugin/`, which shows as a normal folder in Finder. Ship as `DeckBridge.lrplugin/`, which is a package on macOS. Put `Info.lua` at the root plus your `.lua` files and a vendored `JSON.lua` if you use JSON.
- `Info.lua` requires `LrSdkVersion`, `LrToolkitIdentifier` and `LrPluginName`. Add `LrSdkMinimumVersion` and `VERSION`. `LrSdkVersion` does not gate API availability (lightroom-mcp declares 8.0 and uses 15.x calls), so feature-detect at runtime with `if LrDevelopController.setEnhance then …`.
- **Install:**
  - File ▸ Plug-in Manager ▸ Add ▸ Enable.
  - Or drop the plugin into `~/Library/Application Support/Adobe/Lightroom/Modules/` to auto-load it. Auto-loaded plugins can be disabled but not removed in the UI.
  - Use **Reload Plug-in** in the Plug-in Manager's author tools after edits. Restart LrC if new files referenced in `Info.lua` aren't picked up.
- **Logging:** `local log = import 'LrLogger'('DeckBridge'); log:enable('logfile')`. On LrC 14+ logs go to `~/Library/Logs/Adobe/Lightroom/LrClassicLogs/DeckBridge.log`; before 14.0 they went to `~/Documents/LrClassicLogs/`. Follow with `tail -f`.
- **Deprecations:** set `sdkDeprecation` in a `config.lua` to log deprecated calls to `~/Documents/AgSdkDeprecation.log` [2nd].
- **Debugging:**
  - **John R. Ellis's Debugging Toolkit v1.8** (`johnrellis.com/debugging-toolkit/`): `strict.lua`, a reloadable `Require.lua`, and `Debug.lua` with breakpoints, stepping, stack traces, a pretty-printer and a profiler. It handles LrTasks and pcall better than generic debuggers. Compatibility with 15.x is not stated.
  - **ZeroBrane Studio** via MobDebug: a 2014 recipe that installs an undocumented `.lrmodule` whose `VERSION` must match LrC. Breakage was reported on later versions, so treat it as unverified on 15.x.
  - For VS Code + LuaLS there are type stubs (`murayama-photo.lightroom-sdk-types`), but they cover only SDK 6–10. Generate your own annotations for 11–15.
- **Signing and security:** pure-Lua plugins need no code signing. macOS Gatekeeper and quarantine matter only for bundled native helper binaries (`xattr -dr com.apple.quarantine <plugin>`). Adobe Exchange distribution needs a signed ZXP, which is not relevant for personal use. MIDI2LR's FAQ suggests checking the firewall if the app can't connect. Whether macOS 26 shows a firewall prompt for LrC listening on localhost is unverified.

---

## 7. Prior art (Stream Deck and other controllers)

| Product | Platform | Bridge mechanism | Notes and complaints |
|---|---|---|---|
| **FlowKits "Lightroom Classic Plugin"** (Elgato Marketplace) | **macOS + Win** | Companion LrC plugin installed automatically ("Enable in Plug-in Manager"); two-way live feedback. | v1.7.1, 2026-10-21; SD 7.1+; $30. Dial actions for 26 Develop params with live LCD values. Keys for pick/reject/ratings/labels, AI masks (LrC 14+), presets, snapshots, collections, keywords, export. Works when LrC isn't frontmost. |
| FlowKits "Lightroom Classic Profiles" | macOS + Win | Lite profile is **keyboard shortcuts**; Pro needs the plugin above. | v1, 2026-07-06. |
| **SideshowFX "Lightroom Classic Pro Profiles for Stream Deck +"** | macOS + Win | Own LrC plugin through "Lightroom's API". | v4.0.2, 2026-06-10. 700+ commands, 106 dial controls. **English LrC only**, which suggests some keystroke reliance. $34.99–44.99. |
| DevelopDeck (Morgan Kessler) | **Windows only** | Self-installing LrC connector, "two links" with auto-rebuild. | v1.0.6, 2026-10-26, fixed a reconnect bug (keys stuck after disconnect). Touch strip shows live values; press resets, tap switches. Rating dial, AI-mask keys. |
| Lightroom Dials (Steve Lunden) | **Windows only** | Free MIT bridge plugin by Erik Bongers; manual Plug-in Manager step. | v1.1, 2026-07-08. 12 dial actions on 3 pages. |
| **MIDI2LR** | macOS + Win | LrSocket 58763/58764 + C++ app. | Proven open-source reference (GPL-3). FAQ issues: slow response after repeated LrC restarts (fix: reboot), synced-photo tracking quirk. |
| Logitech MX Creative Console / Loupedeck | macOS + Win | Logi Marketplace "Lightroom Classic" plugin (v6.2.1.8818) installs an LrC plug-in visible in Plug-in Manager. | 100+ actions. New presets require a manual refresh through Plug-in Extras. CC-installed LrC only. Haptics work with LrC on MX Master 4; possibly related to the new `addHapticObserver` (unverified). |
| TourBox (Console + "Dynamic Panel", 2025) | macOS + Win | Mechanism undisclosed ("deep Lightroom API integration") plus mouse-pointer slider adjust. | Marketing claims only. |
| Monogram | — | Advertises native LrC integration. | Status unclear. |
| LRBridge (ninoleto) | Windows only | LrC SDK plugin + HTTP API (port 17892) + Windows UI automation. | Feedback is **polling-based**. Auto Tone/WB need a cooldown after slider moves. Development paused. |
| MCP/AI (out of scope) | — | lightroom-mcp (Automaat, Mac+Win), LrC-AVG (Windows fork), lightroom-cli (Python, JSON-RPC dual sockets), 4xiomdev/lightroom-classic-mcp (macOS, port 0 + discovery file). | All use the same LrSocket pattern. |

**Common limitations in prior art:**
- Windows-only builds.
- English-only shortcut dependence.
- LrC must be frontmost for keystroke features.
- Plugin starts only after LrC's window is activated.
- Reconnect bugs.
- Polling lag.
- Gaps around Sync/Auto Sync, brush and mask painting, and AI sub-features.

**Why build anyway:** macOS and SD+-specific UX, your own dial pages and step sizes, touch-strip graphics such as thumbnails or histograms, and owning the protocol.

---

## 8. Recommended bridge design

**Lua side (`DeckBridge.lrdevplugin`):**
1. `Info.lua`: `LrInitPlugin` + `LrForceInitPlugin = true` + one Library menu item (status / restart) + `LrShutdownPlugin`.
2. One long-lived task (`postAsyncTaskWithContext`) owns two localhost listeners:
   - **cmd** (LrC receive), for example **58780**.
   - **evt** (LrC send), for example **58781**.
   - Avoid 58763/58764 (MIDI2LR, lightroom-mcp). Alternatively use port 0 and write `~/Library/Application Support/DeckBridge/bridge.json` with `{cmdPort, evtPort, token, lrVersion}`.
3. **Protocol:** newline-delimited text or JSON. Messages include `hello`, `set <param> <abs>`, `nudge <param> <ticks>`, `done` (stopTracking), `reset`, `watch <params…>`, `pick`/`reject`/`unflag`, `rate n`, `label c`, `next`/`prev`, `view …`, `module …`, `filter …`, `preset <uuid>`, `listPresets`, `copy`/`paste`, `snapshot`, `vc`, `autotone`/`autowb`, `mask subject|sky|…`, `denoise n`, `thumb <size>`.
4. **Fast path:** `set`/`nudge` are handled directly in `onMessage` (`setValue` with clamping; switch to Develop if needed). Anything touching the catalog goes through `LrTasks.startAsyncTask` + `withWriteAccessDo(…, {timeout=3})`.
5. **Push events:**
   - `val <param> <v>` from `addAdjustmentChangeObserver`, diffed against the last values, **only for watched params**, ≤20 Hz.
   - `state <module> <photoId> <rating> <flag> <label>` from a 150–250 ms poll.
   - Optional `thumb <base64>` on photo change.
   - `pong` heartbeats.
6. **Robustness:**
   - Generation counters.
   - Recreate (don't `reconnect()`) the send socket after a client drops.
   - `LrTasks.pcall` around every handler.
   - Feature detection for 14.5/15.3 calls.
   - Re-register the observer after re-entering Develop if needed.
   - Treat "failed to open" as port-in-use.

**Node side (Stream Deck plugin; detail belongs to the Stream Deck thread):**
- TCP client with backoff reconnect to both ports. Show an "LrC offline" state until `hello`.
- Keep a **local value model** per param (`getRange` + current value).
- Apply dial ticks to the model immediately and update the touch strip optimistically. Send the **latest absolute value per param at ≤30 Hz**.
- Ignore LrC echoes for that param for about 300 ms after your own writes, a pickup-style window like MIDI2LR's.
- Send `done` on dial release or touch-up to commit one history step. `setTrackingDelay(0.5–1)` is optional.
- Map step sizes per param yourself, because `increment()` step sizes are undocumented. For example: Exposure 1/30 EV per tick, Temperature ±50 K, and the rest about 1/200 of range. Press = reset; push+turn = fine mode.
- Shortcut-only features (Sync dialog, Auto Sync toggle, brush size) go through Stream Deck Hotkey actions while LrC is frontmost.

---

## 9. Code snippets (current APIs; untested sketches)

### 9.1 Minimal `Info.lua`

```lua
-- DeckBridge.lrdevplugin/Info.lua  (Info.lua can't import/require anything)
return {
  LrSdkVersion        = 15.0,
  LrSdkMinimumVersion = 15.0,              -- user is on 15.3; feature-detect 14.5/15.3 calls at runtime
  LrToolkitIdentifier = 'com.example.deckbridge',
  LrPluginName        = 'Deck Bridge',
  LrInitPlugin        = 'Init.lua',         -- starts the socket server
  LrForceInitPlugin   = true,               -- load at launch (still waits for first window activation)
  LrShutdownPlugin    = 'Shutdown.lua',     -- runs on disable/remove/reload: require('State').running = false
  LrLibraryMenuItems  = {                   -- per lightroom-mcp, force-init needs >= 1 menu item
    { title = 'Deck Bridge: Status', file = 'Status.lua' },
  },
  VERSION = { major = 0, minor = 1, revision = 0, build = 0 },
}
```

### 9.2 `LrSocket` server with a command dispatcher (`Init.lua` + `Dispatch.lua`)

```lua
-- Init.lua (LrInitPlugin): two localhost listeners, newline-framed text protocol
local LrFunctionContext = import 'LrFunctionContext'
local LrSocket          = import 'LrSocket'
local LrTasks           = import 'LrTasks'
local log               = import 'LrLogger'('DeckBridge')
log:enable('logfile')            -- ~/Library/Logs/Adobe/Lightroom/LrClassicLogs/DeckBridge.log

local S        = require 'State'     -- State.lua: return { running = true, send = function() end }
local Dispatch = require 'Dispatch'
local Watch    = require 'Watch'     -- 9.3

local CMD_PORT, EVT_PORT = 58780, 58781   -- 58763/58764 are taken by MIDI2LR and lightroom-mcp

LrFunctionContext.postAsyncTaskWithContext('DeckBridge', function(context)
  local sender, senderUp = nil, false
  local function bindSender()
    sender = LrSocket.bind {
      functionContext = context, plugin = _PLUGIN, port = EVT_PORT, mode = 'send',
      onConnected = function() senderUp = true end,
      onClosed    = function() senderUp = false end,
      onError     = function(sock) senderUp = false; if S.running then sock:reconnect() end end,
    }
  end
  S.send = function(line) if senderUp then sender:send(line .. '\n') end end
  bindSender()

  LrSocket.bind {
    functionContext = context, plugin = _PLUGIN, port = CMD_PORT, mode = 'receive',
    onMessage = function(_, line)                    -- fires once per '\n'-terminated line
      local ok, err = LrTasks.pcall(Dispatch.handle, line)   -- LrTasks.pcall: handlers may yield
      if not ok then log:error(err) end
    end,
    onClosed = function(sock)                        -- deck disconnected: listen again
      if not S.running then return end
      sock:reconnect()
      sender:close(); bindSender()                   -- MIDI2LR: sender:reconnect() can hang LrC
    end,
    onError = function(sock, err)
      if err == 'timeout' and S.running then sock:reconnect() end   -- no client yet
    end,
  }

  while S.running do                                 -- keeps the context (and sockets) alive
    LrTasks.pcall(Watch.poll, context)
    LrTasks.sleep(0.15)
  end
end)
```

```lua
-- Dispatch.lua: "set Exposure 0.42" | "nudge Shadows -3" | "done" | "pick" | "rate 3" | "preset <uuid>"
local LrDevelopController = import 'LrDevelopController'
local LrApplicationView   = import 'LrApplicationView'
local LrSelection         = import 'LrSelection'
local LrApplication       = import 'LrApplication'
local LrTasks             = import 'LrTasks'
local LrUndo              = import 'LrUndo'

local function develop()                       -- most LrDevelopController calls need Develop active
  if LrApplicationView.getCurrentModuleName() ~= 'develop' then
    LrApplicationView.switchToModule('develop')
    LrTasks.yield()                            -- let the switch land (MIDI2LR does the same)
  end
end

local H = {}
function H.set(p, v)   develop(); LrDevelopController.setValue(p, tonumber(v)) end   -- absolute (preferred)
function H.nudge(p, n)                                                         -- relative fallback
  develop()
  local lo, hi = LrDevelopController.getRange(p)
  local v = LrDevelopController.getValue(p) + tonumber(n) * (hi - lo) / 200
  LrDevelopController.setValue(p, math.max(lo, math.min(hi, v)))
end
function H.inc(p)      develop(); LrDevelopController.increment(p) end   -- LrC's own (undocumented) step
function H.reset(p)    develop(); LrDevelopController.resetToDefault(p) end
function H.done()      LrDevelopController.stopTracking() end            -- dial released: one history step
function H.pick()      LrSelection.flagAsPick() end
function H.reject()    LrSelection.flagAsReject() end
function H.unflag()    LrSelection.removeFlag() end
function H.rate(n)     LrSelection.setRating(tonumber(n)) end
function H.label(c)    LrSelection.setColorLabel(c) end
function H.next()      LrSelection.nextPhoto() end
function H.prev()      LrSelection.previousPhoto() end
function H.undo()      LrUndo.undo() end
function H.autotone()  develop(); LrDevelopController.setAutoTone() end
function H.subject()   develop(); LrDevelopController.goToMasking()
                       LrDevelopController.createNewMask('aiSelection', 'subject') end
function H.denoise(a)                                   -- SDK 15.3+; feature-detect
  if LrDevelopController.setEnhance then
    develop(); LrDevelopController.setEnhance('denoise', true, tonumber(a) or 50)
  end
end
function H.preset(uuid)                                 -- catalog write: run in its own task
  LrTasks.startAsyncTask(function()
    local cat, preset = LrApplication.activeCatalog(), LrApplication.developPresetByUuid(uuid)
    cat:withWriteAccessDo('Deck: apply preset', function()
      for _, photo in ipairs(cat:getTargetPhotos()) do photo:applyDevelopPreset(preset) end
    end, { timeout = 3 })
  end)
end

return { handle = function(line)
  local verb, a, b = line:match('^(%S+)%s*(%S*)%s*(%S*)')
  local f = verb and H[verb]
  if f then f(a, b) end
end }
```

### 9.3 Adjustment-change observer and selection polling (`Watch.lua`)

```lua
-- Watch.lua: push live values (mouse edits, presets, undo) and photo/rating changes to the deck
local LrDevelopController = import 'LrDevelopController'
local LrApplicationView   = import 'LrApplicationView'
local LrApplication       = import 'LrApplication'
local LrSelection         = import 'LrSelection'
local LrDate              = import 'LrDate'
local S                   = require 'State'

local W = { params = { 'Exposure', 'Contrast', 'Highlights', 'Shadows' } }  -- updated by a "watch" command
local last, lastPush, lastSig, observing = {}, 0, nil, false

local function pushValues(force)
  local now = LrDate.currentTime()                         -- wall clock (os.clock is CPU time)
  if not force and now - lastPush < 0.05 then return end   -- <= 20 Hz (MIDI2LR uses 10 Hz)
  lastPush = now
  for _, p in ipairs(W.params) do
    local v = LrDevelopController.getValue(p)
    if force or v ~= last[p] then last[p] = v; S.send(('val %s %s'):format(p, tostring(v))) end
  end
end

function W.poll(context)
  local module = LrApplicationView.getCurrentModuleName()
  local photo  = LrApplication.activeCatalog():getTargetPhoto()
  if module == 'develop' and photo and not observing then  -- the observer must be added in Develop
    LrDevelopController.addAdjustmentChangeObserver(context, W, function() pushValues(false) end)
    observing = true
  end
  -- No documented selection, rating or flag events exist, so poll a cheap signature.
  local sig = photo and table.concat({ module, photo.localIdentifier,
      LrSelection.getRating() or 0, LrSelection.getFlag() or 0, LrSelection.getColorLabel() or 'none' }, ' ')
      or (module .. ' none')
  if sig ~= lastSig then
    lastSig = sig
    S.send('state ' .. sig)
    if module == 'develop' and photo then pushValues(true) end
  end
end

return W
```

---

## 10. Unverified / open questions

1. **Exact SDK for 15.3.** One secondary source says SDK 15.3 is the latest published and LrC 15.4 had none. Confirm by downloading from the Developer Console, which needs sign-in.
   - Do 15.4/15.5/15.6 SDK zips exist?
   - Is `setEnhance` really new in 15.3, given LrC-AVG found it missing from the 15.2 docs?
   - Run `if LrDevelopController.setEnhance then` on the user's 15.3.
2. **Super Resolution via the SDK:** `setEnhance('superRes', …)` per kevinkiklee vs. "not exposed" per lightroom-mcp. Raw Details via `setEnhance('rawDetails')` is also untested.
3. **Reflection and distraction (people) removal functions:** exact names and signatures come from one secondary source. Untested on 15.3.
4. **Auto Sync and `LrDevelopController.setValue`:** does a dial edit propagate to all selected photos when Auto Sync is on?
5. **Does `addAdjustmentChangeObserver` fire on photo change in Develop?** MIDI2LR's motorized-fader behavior suggests yes. Keep the polling fallback regardless.
6. **Real throughput and latency** of `setValue` at 30–60 Hz on large raws with AI masks on the user's Mac. No benchmarks exist; measure round-trip with timestamps.
7. **`increment()`/`decrement()` step sizes:** undocumented. Is the "LR Classic Auto Advance" behavior applied to SDK ratings?
8. **`photo:copySettings()`/`pasteSettings()`:** do they honor the Copy Settings dialog's checkbox selection or copy everything? MIDI2LR uses keystrokes instead.
9. **AI mask subtypes on 15.3:** what do `createNewMask('aiSelection','people')`, `'objects'` and `'landscape'` do (UI prompt? all people? which landscape parts?). Can 15.x mask "parts" be addressed?
10. **HDR edit params** (`HDREditMode`, `SDR*`): are they settable with `setValue`? MIDI2LR 6.2 added "HDR commands", mechanism unchecked.
11. **Crop edges:** MIDI2LR drives `CropTop/Left/Bottom/Right` through `setValue`. These names are not in Adobe's documented list.
12. **Undocumented observers:** do `LrApplication.addActivePhotoChangeObserver` (2017 mention) and `addKeyModifierObserver` still work? What does `addHapticObserver` (15.0) do?
13. **macOS 26 firewall or Local Network prompts** for LrC listening on localhost. Expect none for loopback; unverified.
14. **LrInitPlugin deferral** until window activation was measured on 15.6 macOS; not verified on 15.3.
15. **Background-AI locking (15.3+):** how often `isAvailableForEditing()` is false in practice. Whether Develop calls on a locked photo fail silently.
16. **15.6 regression report:** a lightroom-mcp author saw a state where `LrDevelopController` edits showed in the panel but weren't saved until restart. Anecdotal.
17. **Exact 15.3.1 / 15.5.1 dates:** Adobe's release-notes page blocked automated fetches. Dates come from search snippets and Lightroom Queen.
18. **Keyboard shortcuts:** confirm in the user's LrC (Help ▸ Develop Module Shortcuts, Cmd+/), since sources disagree on Copy/Paste (Cmd+C vs Cmd+Shift+C in Develop).

---

## 11. Sources (accessed 2026-10-31)

**Adobe (official or staff):**
- LrC 15.6 announcement, 2026-09-29: https://community.adobe.com/announcements-673/lightroom-classic-15-6-is-here-improved-reflection-removal-faster-masking-workflows-and-expanded-camera-lens-support-1644250
- LrC SDK 14.0 MAX release, 2024-10-14: https://community.adobe.com/announcements-673/lightroom-classic-sdk-14-0-max-release-now-live-978916
- SDK 13.3 available, 2024-05-21: https://community.adobe.com/t5/lightroom-classic-discussions/lightroom-classic-sdk-13-3-is-now-available/td-p/14630788
- Adobe Developer Console (SDK download, sign-in): https://developer.adobe.com/console/servicesandapis
- LrC release notes (blocked automated fetch; used via search snippets): https://helpx.adobe.com/lightroom-classic/desktop/introduction-to-lightroom-classic/release-notes.html
- Adobe MAX 2026, Nov 10–12, Miami Beach: https://max.adobe.com/
- Adobe Developer blog, LrC plug-ins on Exchange / no UXP on roadmap, ~Jul 2022: https://blog.developer.adobe.com/lightroom-classic-plugin-support-for-the-adobe-exchange-for-creative-cloud-14e4a0f690df
- Bug "SDK omits the new Denoise and Distraction Removal", 2025-06-30, Adobe reply 2025-08-13: https://community.adobe.com/t5/lightroom-classic-bugs/p-sdk-omits-the-new-denoise-and-distraction-removal/idc-p/15456456
- Julieanne Kost (Adobe), copy/paste/sync shortcuts, 2024-09-03: https://jkost.com/blog/2024/09/quickly-applying-settings-to-multiple-images-in-lightroom-classic.html
- Programmer's Guide 2020 PDF (CDN; not parsed): https://ioconsolerykerprodcdn.azureedge.net/static/installers/lr/sdk/2020/doc/Lightroom%20Classic%20SDK%20Guide%202020.pdf

**API reference mirror** (unofficial copy of Adobe LuaDoc, © 2007–2025 Adobe, about SDK 14.x):
- https://lrc.mcor.dev/
- Pages used: LrDevelopController, LrSocket, LrSelection, LrApplicationView, LrPhoto, LrCatalog, LrTasks, LrStringUtils, LrUndo and LrApplication (`/modules/<Name>.html`).

**Adobe community (developer reports):**
- "No Lua SDK for LrC v15?", 2025-11-24 to 2025-12-16: https://community.adobe.com/questions-675/no-lua-sdk-for-lightroom-classic-v15-1617369
- Changes to the LR 14.0 SDK, 2024-12-27: https://community.adobe.com/questions-675/changes-to-the-lr-14-0-sdk-980257
- Changes to the LR 13.2 SDK, 2024-05-05: https://community.adobe.com/questions-675/changes-to-the-lr-13-2-sdk-976181
- Changes to the LR 12.0 SDK, 2022-11-10 (people-mask behavior): https://community.adobe.com/t5/lightroom-classic-discussions/changes-to-the-lightroom-12-0-sdk/m-p/13336161
- 15.4 brush-mask BrushTable feature request, 2026-07-06: https://community.adobe.com/feature-requests-676/p-sdk-restore-ability-of-copy-settings-plugin-to-work-around-longstanding-lr-bugs-1630749
- `setValue` vs `Enable*` settings, 2018-06-30: https://community.adobe.com/questions-675/lightroom-sdk-lrdevelopcontroller-setvalue-doesn-t-work-with-enable-settings-963810
- Working with LrSocket (newline framing), 2015-09: https://community.adobe.com/questions-675/working-with-lrsocket-receiving-942963
- Controller SDK guide thread, 2018-02-22, 13.3 update note 2024-05-21: https://community.adobe.com/questions-675/new-documentation-lightroom-controller-sdk-guide-993117
- Auto Tone/WB via SDK, 2025-07-18: https://community.adobe.com/questions-675/sdk-or-api-to-run-lightroom-classic-s-tone-control-auto-and-white-balance-auto-982862
- rotateLeft/Right bug, 2021-12, fixed in 11.4: https://community.adobe.com/t5/lightroom-classic-bugs/p-sdk-photo-rotateleft-and-rotateright-can-rotate-all-photos-in-the-catalog/idc-p/12590859
- Missing Develop params, 2023-11-11: https://community.adobe.com/t5/lightroom-classic-discussions/develop-parameters-are-missing-in-the-list-for-the-quot-lrdevelopcontroller-quot/td-p/14227547
- Undocumented `addActivePhotoChangeObserver`, 2017 (via search snippet): https://community.adobe.com/t5/lightroom-classic-discussions/q-event-handling-tool-module-and-image/m-p/9425336
- `LrTasks.yield` slow on Windows (via search snippet): https://community.adobe.com/t5/lightroom-classic-bugs/p-sdk-lrtasks-yield-is-extremely-slow-on-windows/idi-p/12252419

**Open source:**
- MIDI2LR (v6.3.1.0, 2026-07-30): https://github.com/rsjaffe/MIDI2LR
  - Client.lua: https://raw.githubusercontent.com/rsjaffe/MIDI2LR/master/src/plugin/Client.lua
  - Info.lua: https://raw.githubusercontent.com/rsjaffe/MIDI2LR/master/src/plugin/Info.lua
  - Wiki: https://github.com/rsjaffe/MIDI2LR/wiki (Home/FAQ and Commands)
  - Release dates: https://api.github.com/repos/rsjaffe/MIDI2LR/releases
- Automaat/lightroom-mcp (pushed 2026-10-30): https://github.com/Automaat/lightroom-mcp
  - `plugin/LightroomMCP.lrplugin/{Info,PluginInit,PluginInfoProvider,HandlerDevelop,DevelopSession,HandlerPreview}.lua`
  - PR #288 (2026-10-21/23): https://github.com/Automaat/lightroom-mcp/pull/288
  - PR #297: https://github.com/Automaat/lightroom-mcp/pull/297
- LrC-AVG (jimjohnbeebe-jpg): https://github.com/jimjohnbeebe-jpg/LrC_Autonomous_Gateway
  - PR #223 (2026-10-26/27): https://github.com/jimjohnbeebe-jpg/LrC_Autonomous_Gateway/pull/223
  - PR #191: https://github.com/jimjohnbeebe-jpg/LrC_Autonomous_Gateway/pull/191
- kevinkiklee/adobe-plugin-skills (`lrc-sdk.md`, SDK 15.3 baseline, verified Jul 2026): https://github.com/kevinkiklee/adobe-plugin-skills
- LRBridge: https://github.com/ninoleto/lrbridge
- 4xiomdev/lightroom-classic-mcp: https://github.com/4xiomdev/lightroom-classic-mcp
- lightroom-cli: https://pypi.org/project/lightroom-cli/

**Marketplaces (prior art):**
- FlowKits Lightroom Classic Plugin (v1.7.1, 2026-10-21): https://marketplace.elgato.com/product/lightroom-classic-plugin-bc1cd74a-e605-410e-82f6-2082cc8899f6
- FlowKits Profiles (2026-07-06): https://marketplace.elgato.com/product/lightroom-classic-profiles-9ac56229-9984-4485-a8e3-8d95887ff820
- SideshowFX SD+ Pro Profiles (v4.0.2, 2026-06-10): https://marketplace.elgato.com/product/lightroom-classic-pro-profiles-stream-deck-plus-fd6791a6-8f33-49c0-92aa-9d319d1361b2
- DevelopDeck (v1.0.6, 2026-10-26): https://marketplace.elgato.com/product/developdeck-6b98ad12-a090-4e41-80c0-42737fd411cf
- Lightroom Dials (v1.1, 2026-07-08): https://marketplace.elgato.com/product/lightroom-dials-3f0a0400-2dd5-4857-9228-7549bb8013d7
- Logi Marketplace LrC plugin: https://marketplace.logi.com/plugin/Lightroom/en
- Logi support article: https://support.logi.com/hc/en-us/articles/25439101831063-Adobe-Plugins-MX-Creative-Console
- TourBox for LrC: https://www.tourboxtech.com/photo-editing/tourbox-for-lightroom-classic/

**Community and blogs:**
- Lightroom Queen "What's new":
  - 15.0 (2025-10-28): https://www.lightroomqueen.com/whats-new-in-lightroom-2025-10/
  - 15.2 (2026-02-20): https://www.lightroomqueen.com/whats-new-in-lightroom-2026-02/
  - 15.3 (2026-04-15): https://www.lightroomqueen.com/whats-new-in-lightroom-2026-04/
  - 15.4/15.4.1 (2026-06-18/22): https://www.lightroomqueen.com/whats-new-in-lightroom-2026-06/
  - 15.5 (2026-08-03): https://www.lightroomqueen.com/whats-new-in-lightroom-2026-08/
  - 15.6 (2026-09-29): https://www.lightroomqueen.com/whats-new-in-lightroom-2026-09/
- Wikipedia, Adobe Lightroom (infobox 15.6 / 2026-09-29): https://en.wikipedia.org/wiki/Adobe_Lightroom
- Thomas Fitzgerald, LrC 14.4 Enhance changes (Jun 2025): https://blog.thomasfitzgeraldphotography.com/blog/2025/6/lightroom-144-released-big-changes-to-raw-details-denoise-and-super-resolution
- John R. Ellis Debugging Toolkit v1.8: https://johnrellis.com/debugging-toolkit/
- ZeroBrane + Lightroom (2014-04-06): https://notebook.kulchenko.com/zerobrane/debugging-lightroom-plugins-zerobrane-studio-ide
- akrabat, Writing a LrC plug-in (2020-01-06): https://akrabat.com/writing-a-lightroom-classic-plug-in/
- VS Code LrC SDK type stubs: https://marketplace.visualstudio.com/items?itemName=murayama-photo.lightroom-sdk-types
