# Stream Deck + plugin SDK: research for Lightroom Classic and Claude Code control surfaces

- **Thread:** Elgato Stream Deck plugin SDK, with a focus on the Stream Deck + (one of three parallel threads; the others cover the Lightroom Classic SDK and Claude Code)
- **Researched:** 2026-10-31. All sources were accessed on that date unless noted otherwise.
- **Target setup:** one person on macOS 26.6.2 (Tahoe), personal use only, with a Stream Deck + (8 LCD keys, 4 push dials, LCD touch strip). The Stream Deck app isn't installed yet. Claude Code runs inside the **Claude desktop app**, not a terminal.
- **Features in scope:**
  - Claude Code: live status, Approve/Deny keys, prompt and mode buttons, multi-session control.
  - Lightroom: Develop sliders on the dials with live values on the touch strip, culling and rating, presets and one-click tools.
- **Labels used below:**
  - **[official]**: Elgato docs, Elgato repos, npm registry, or Elgato release notes.
  - **[community]**: third-party repos, forums, or blogs.
  - **[inference]**: my own reasoning, not stated by a source.

---

## Verdict (Stream Deck side only)

**Difficulty: low to moderate (about 2 out of 5).** The Stream Deck half of this project is the easiest of the three threads. Reasons:

- **Mature, official SDK.** The TypeScript SDK is at `@elgato/streamdeck` 3.0.4 (published 2026-10-29). The CLI (`@elgato/cli` 1.10.4) handles scaffolding, hot reload, validation, and packaging.
- **Complete Stream Deck + API.** Dial rotation reports ticks and pressed state. Dial press and release, touch taps with position and long-touch, per-dial layouts, `setFeedback`, `setFeedbackLayout`, and `setTriggerDescription` are all supported.
- **Full Node.js runtime.** Plugins run on stock Node 20, 24, or 26 with every built-in available (`http`, `net`, `child_process`, `fs`). Native addons are allowed. No sandbox is documented or observed.
- **Both halves of the planned design already exist as open source:**
  - TypeScript Stream Deck plugins that talk to a Lua plugin inside Lightroom over 127.0.0.1 TCP.
  - Plugins that host a loopback HTTP server for Claude Code hooks and hold a `PermissionRequest` open until a key is pressed (one holds it up to 24 hours).

**Where the real friction is.** It isn't the Stream Deck API. It's in four places:

1. The touch-strip canvas is limited to 200×100 px per dial, and plugins can't draw across the whole strip. Update rates are not documented.
2. Controlling *other* apps on macOS takes TCC grants (Accessibility, Automation). Also, `openUrl` doesn't support custom URL schemes, so `claude://`-style links need `child_process` running `open`.
3. Smart Profile auto-switching is configured by the user, not the plugin.
4. A few 2026 platform bugs on Tahoe: encoder lag after a cold boot, and localhost connections that are flaky right after login.

The hard parts of this project sit on the Lightroom Lua side and in the Claude desktop app's control surface, which has no public API. Those belong to the other threads.

---

## 0. Setup notes for this Mac (macOS 26.6.2, app not yet installed)

| Item | Finding | Source |
|---|---|---|
| Current Stream Deck app | **7.6.0, build 23012**, released 22 Sep 2026. I found no 7.6.x or 7.7 release notes as of 31 Oct 2026. | Homebrew cask `elgato-stream-deck` = 7.6.0.23012 [official installer URL]; Elgato 7.6 release notes (help-center listing) |
| Install | Download from elgato.com/downloads, or run `brew install --cask elgato-stream-deck`. It's a `.pkg` installer from edge.elgato.com, so it needs an admin password. The app auto-updates. | formulae.brew.sh cask JSON |
| macOS support | Elgato's system-requirements article says macOS 13 Ventura or later for Stream Deck 6.9 through the present (the page may be stale). The Stream Deck + product page also says macOS 13+. 7.1.1 (23 Dec 2025) listed improved macOS 26 compatibility. 7.6 fixes a menu-bar crash on macOS 27. | Elgato help center (search snippets; the pages return 403 to fetches); Stream Deck + product page; 7.6 in-app release notes |
| Minimum app version for SDK 3.x | **7.1** (needed by the 3.0 settings and message-ID behaviour). 7.6 is needed only for the Neo Infobar. | SDK changelog [official] |
| Permissions to expect | **Accessibility**, for the built-in Hotkey and Text actions and for any plugin that sends keystrokes. **Automation** prompts, for each app a plugin drives through AppleScript (System Events, Claude, Lightroom). Relaunch the app after granting. The prompts can name "Elgato Stream Deck", `node`, or `osascript`. | Elgato hotkey guide [official]; agent-vitals README [community] |
| Local Network prompt | 7.5.0 showed a spurious local-network "trampoline_handler" prompt at launch. It was fixed in 7.5.1, so 7.6 shouldn't show it. Loopback traffic (127.0.0.1) isn't a "local network" under Apple's definition, and *accepting* TCP connections never needs the permission. | 7.5.1 in-app release notes [official]; Apple TN3179 [official]; loopback conclusion [inference] |
| Known Tahoe bugs | (a) **Encoder events lag about 2 s after a cold boot.** Reported on macOS 26.4.1 with app 7.4.1; quitting and relaunching the app fixes it. Elgato escalated it as "upstream", with no fixed version named. (b) A plugin's **localhost connections fail for minutes after a reboot** on Tahoe (Home Assistant plugin #429, still open Oct 2026); restarting the app helps. Build retry/backoff into the plugin, and consider a relaunch-after-login LaunchAgent if (a) shows up. | elgatosf/streamdeck #154 [official repo, user report]; cgiesche/streamdeck-homeassistant #429 [community] |
| Hardware connection | Connect the Stream Deck + directly, not through a dock or hub. Elgato's maintainers say some docks cause erratic or missing events. | elgatosf/streamdeck #149 [official repo] |
| Smart Profiles | Per-app automatic profile switching is set by the user in the app (Profile → Application). It is **disabled while the Stream Deck window is open**. | Elgato Smart Profiles guide [official] |
| Dev toolchain | Node.js **24+** on the dev machine (nvm recommended), then `npm i -g @elgato/cli`, `streamdeck create`, and `npm run watch`. | Getting Started [official] |

---

## 1. Current state

### 1.1 Docs, packages, versions

| Thing | Current value | Date | Source |
|---|---|---|---|
| Official docs | https://docs.elgato.com/streamdeck/sdk/ (defaults to v3.0.0; version picker also offers 2.1.2 and 1.4.1). CLI docs at https://docs.elgato.com/streamdeck/cli/ | — | [official] |
| Source | https://github.com/elgatosf/streamdeck. pnpm/Turborepo monorepo with `packages/plugin`, `cli`, `schemas`, `utils`, `markdown`, plus `examples/`. MIT. | — | [official] |
| `@elgato/streamdeck` | **3.0.4** (npm `latest`). Earlier releases: 3.0.0 on 2026-09-22; 2.1.2 on 2026-08-17; 2.1.0 on 2026-04-16; 2.0.0 on 2025-12-03; 1.4.1 on 2025-09-18. There's also an `ea` tag at 2.1.0-ea.202608131212. `engines.node >= 20.5.1`. Runtime dependencies: `ws` ^8.19, `@elgato/utils` 0.6.2, `@elgato/schemas` 0.6.0. | 2026-10-29 | registry.npmjs.org [official] |
| `@elgato/cli` | **1.10.4**. Earlier releases: 1.10.0 on 2026-09-22; 1.9.0 on 2026-08-19; 1.8.0 on 2026-08-08; 1.7.0 on 2026-01-19; 1.6.0 on 2025-12-03. `engines.node >= 20.1.0` (as of 1.10.3). | 2026-10-29 | registry.npmjs.org [official] |
| `@elgato/mcp-server` | 0.1.8. Bridges MCP clients to Elgato apps (see §6.3). | 2026-10-01 | registry.npmjs.org [official] |
| Manifest `SDKVersion` | `2` or `3`. **3 recommended.** Elgato Marketplace requires 3 for new plugins from 19 Jan 2026 and for updates from 19 Feb 2026. | — | manifest reference; Maker Console notice (via search) [official] |
| `Software.MinimumVersion` | `"6.4"` through `"7.6"`. Use `"7.1"` or later with SDK 3.x. | — | manifest reference [official] |
| Stream Deck app (latest) | **7.6.0 (23012)**. Release history: 7.0 on 12 Aug 2025; 7.1 on 3 Dec 2025; 7.1.1 on 23 Dec 2025; 7.4 on 1 Apr 2026; 7.5.0 on 30 Jun 2026; 7.6 on 22 Sep 2026. | 2026-09-22 | Elgato release notes; Homebrew cask [official] |
| sdpi-components (Property Inspector UI library) | **v4** is what the docs reference (`https://sdpi-components.dev/releases/v4/sdpi-components.js`). The docs now recommend a **local copy** instead of the CDN. I couldn't confirm the exact patch version. Repo: GeekyEggo/sdpi-components. | — | UI guide [official] |

### 1.2 Bundled Node.js and how a plugin picks one [official]

- The manifest sets the runtime: `"Nodejs": { "Version": "20" | "24" | "26", "Debug": ... }`.
  - `"26"` was added to the schema and CLI by PR #176, merged 2026-10-19 and shipped in the CLI 1.10.3 / SDK 3.0.3 patch releases.
- Since app 7.1, runtimes **auto-update** to the latest version that Stream Deck supports. The Plugin Environment page lists these for apps 7.1 through 7.6:
  - Node **20.20.2, 24.22.1, 26.12.1**
  - Chromium **130** (7.1–7.5) and **140** (7.6) for Property Inspectors
- Older apps: 7.0 and 6.9 bundled Node 20.19.0; 6.4 bundled 20.5.1.
- Plugins always run with `--enable-source-maps` and `--no-global-search-paths`. `--no-addons` applied only on app 6.4, so Node-API native addons work. The official `examples/image-resizer` sample uses `sharp`.
- `Nodejs.Debug` values:
  - `"enabled"` runs the plugin with `--inspect`.
  - `"break"` runs it with `--inspect-brk`.
  - Both use an auto-assigned port. To fix the port, pass explicit flags, e.g. `"--inspect=127.0.0.1:12345"`.
- `GenerateProfilerOutput` is a separate boolean option.
- **Recommendation:** `"Version": "24"` (LTS). Node 20 reached end of life in April 2026. `"26"` works if you want it, but it's brand new in the schema.

### 1.3 Supported languages [official]

- **Official SDK:** Node.js (TypeScript or JavaScript) via `@elgato/streamdeck`.
- **Raw WebSocket protocol:** still documented. The app launches `CodePath`/`CodePathMac` with `-port`, `-pluginUUID`, `-registerEvent`, and `-info`. The plugin connects to `ws://127.0.0.1:<port>` and registers.
- **Native plugins:** the reference page calls them an advanced technique that isn't recommended, and suggests Node-API native addons instead. They still work:
  - Elgato's DRM docs name C#, C++ and Go SDK libraries.
  - Community plugins in Go and Rust were active in 2026 [community].

### 1.4 Notable and breaking changes, 2025–2026 [official unless noted]

- **App 6.9:** Node 20.19, Chromium 122, `SupportURL`.
  - Breaking: the Property Inspector no longer gets `beforeunload`.
- **App 7.0 (Aug 2025):**
  - Passive deep links (`?streamdeck=hidden`) and the `deviceDidChange` event.
  - `SupportedInKeyLogicActions` and the Virtual Stream Deck device type (11).
  - Device `size` now reflects the visual size.
  - Fix: linked plugins didn't run on first launch.
- **App 7.1 (Dec 2025):**
  - **Embedded resources** (`setResources` / `getResources`), **Node 24**, and in-app developer tools that follow the current Property Inspector.
  - Node runtimes now auto-update.
- **SDK 2.0 (2025-12-03):**
  - DRM support, resources, and experimental message identifiers.
  - Property Inspector messaging moved to `streamDeck.ui.*`.
  - Removed the manifest namespace, browser import, and PI types and routing.
  - `NodeNext` module resolution.
- **SDK 2.1 (2026-04-16):** action-settings cache. The README now requires Node 24 and app 7.1 for development.
- **Maker Console (Marketplace only):** from 19 Jan 2026, new plugins must be DRM-compatible, require app 6.9 or later, and use `SDKVersion` 3. The same applies to updates from 19 Feb 2026.
- **App 7.4 (1 Apr 2026):**
  - MCP support: a virtual "MCP Deck", with actions on an "MCP Actions" profile triggerable by AI assistants (§6.3).
  - The "Stream Deck + Lever" in those notes is an April Fools' joke, not hardware.
- **App 7.5 (30 Jun 2026), 7.5.1:** fixes, including the spurious Local Network prompt (§0).
- **App 7.6 (22 Sep 2026):** Neo Infobar actions (`"Controllers": ["Neo"]`), the official ChatGPT & Codex plugin, and a crash fix for macOS 27.
- **SDK 3.0 (2026-09-22), breaking:**
  - `onDidReceiveSettings` and `onDidReceiveGlobalSettings` now fire **only when the Property Inspector changes settings**, no longer after `getSettings()` or `getGlobalSettings()`. `streamDeck.settings.useLegacySettingsBehavior = true` reverts this temporarily.
  - Message identifiers are always on.
  - `Action` is now a union (key, dial, or Neo Infobar), and actions must declare a settings type.
  - **The `getSecrets` API was removed.**
  - `connect()` fails with `ERR_NOT_SUPPORTED` unless the app and the manifest minimum are both 7.1 or later. This last point comes from a community diff of 2.1.2 vs 3.0.x and agrees with the official changelog [community + official].
- **Node 26:** added to the manifest schema on 2026-10-19.

### 1.5 Encoder-equipped hardware sharing the same APIs

| Device | `DeviceType` | Encoders | Strip / canvas | Notes |
|---|---|---|---|---|
| Stream Deck + | 7 | 4 push dials | 800×100 strip (108×14 mm), so **4 × 200×100** per-dial canvases | 8 LCD keys. Requires macOS 13+. [official] |
| Stream Deck + XL | 13 | 6 push dials | 1200×100 strip, so **6 × 200×100** canvases | 36 LCD keys. Announced Mar 2026 [community: retailer listings and a Japanese news report]. The docs confirm 200×100 layouts for "+ (Classic \| XL)". [official] |
| Corsair Galleon 100 SD | 12 | 2 dials (up to 4 dial actions via layers) | 5" LCD | Keyboard with 12 LCD keys. Listed as dial-stack compatible. [official + vendor] |
| Stream Deck Neo | 9 | none | Infobar 232×50 | Not an encoder, but uses the same layout and `setFeedback` model through the `"Neo"` controller (app 7.6, SDK 3.0). [official] |

Code written for 200×100 encoder layouts carries over unchanged to the + XL.

---

## 2. Stream Deck + APIs

### 2.1 Events (WebSocket names; SDK handlers on `SingletonAction`) [official]

| Event | SDK handler | Payload highlights |
|---|---|---|
| `dialRotate` | `onDialRotate(ev: DialRotateEvent<T>)` | `ticks` (signed; + is clockwise), `pressed` (dial held during rotation, which enables push-and-turn "fine" modes), `coordinates {column,row}`, `settings`, `resources` (7.1+), `controller: "Encoder"` |
| `dialDown` / `dialUp` | `onDialDown` / `onDialUp` | `coordinates`, `settings`, `resources`. `dialPress` was **removed** in 6.5. |
| `touchTap` | `onTouchTap(ev: TouchTapEvent<T>)` | `tapPos: [x, y]` relative to *this action's* 200×100 canvas, and `hold: boolean` (long touch) |
| `willAppear` / `willDisappear` | `onWillAppear` / `onWillDisappear` | Fires on page, profile or folder changes, and at startup for front-page actions. Use `ev.action.isDial()` before calling dial-only commands. |
| Others | `onKeyDown/Up`, `onDidReceiveSettings`, `onDidReceiveResources`, `onSendToPlugin`, `onPropertyInspectorDidAppear/Disappear`, `onTitleParametersDidChange` | Plugin-wide events: `streamDeck.system.onDidReceiveDeepLink`, `onApplicationDidLaunch/Terminate`, `onSystemDidWakeUp`; `streamDeck.devices.onDeviceDidConnect/Disconnect/Change` |

The full WebSocket list has 22 events, and none of them is a swipe or drag. **Swipes on the strip are consumed by the app for dial-page navigation. Plugins only get taps and long-touches.** [official event list; swipe-for-pages from Marketplace listings, community]

### 2.2 Commands for dial actions [official]

- **`setFeedback(payload)`:** updates layout items by `key`.
  - Text and pixmap items take strings; bar and gbar take numbers.
  - An object form can set `value`, `range {min,max}`, `opacity` (0–1 in 0.1 steps), `enabled`, `background`, `zOrder`, plus colours and fonts for text and bar colours.
  - A partial update touches only the keys you pass.
- **`setFeedbackLayout(layout: string)`:** takes a built-in id (`$X1`, `$A0`, `$A1`, `$B1`, `$B2`, `$C1`) or a path to a JSON file **inside the plugin folder**.
  - The SDK 3.x signature is `setFeedbackLayout(layout: string)`, so pass a built-in id or a path. One search snippet of the layouts page mentioned defining layouts "programmatically using an object", but neither the fetched 3.0 page nor the signature supports that (see open questions).
  - An item's `rect`, `key` and `type` can't change at runtime. To move things, switch layouts.
- **`setTriggerDescription({ push, rotate, touch, longTouch })`:** sets the hints shown in the app. Calling it with no argument restores the manifest defaults.
- **`setImage(image?, { target, state })` / `setTitle`:** for a dial, these set the action's icon and title as used by the layout's reserved `icon` and `title` keys. The plugin's values are **ignored when the user has set a custom image or title**.
- **`showAlert()`:** shows a temporary warning on the strip segment.
- **`getSettings` / `setSettings`, `getResources` / `setResources`** (resources need 7.1+).

### 2.3 Built-in layouts (all 200×100) [official]

| Id | Purpose | Item keys |
|---|---|---|
| `$X1` | Default icon layout | `title`, `icon` |
| `$A0` | Canvas | `full-canvas` (pixmap 0,0,200,100), `title`, `canvas` (pixmap 16,34,136,54) |
| `$A1` | Value | `title`, `icon` (48×48), `value` (text, 24 px) |
| `$B1` | Indicator | `title`, `icon`, `value`, `indicator` (bar) |
| `$B2` | Gradient indicator | `title`, `icon`, `value`, `indicator` (gbar with a gradient `bar_bg_c`) |
| `$C1` | Double indicator | `title`, `icon1`, `icon2`, `indicator1`, `indicator2` (bars) |

### 2.4 Custom layout JSON [official]

- **Structure:** `{ "$schema": "https://schemas.elgato.com/streamdeck/plugins/layout.json", "id": "...", "controller"?: "Encoder"|"Neo", "items": [...] }`.
- **Item types:**
  - `text`: `value`, `color`, `alignment` (left, center or right), `font {size, weight 100–1000}`, `text-overflow` (clip, ellipsis or fade).
  - `pixmap`: `value` is an image.
  - `bar`: `value`, `range`, `subtype` 0–4, `bar_bg_c`, `bar_fill_c`, `bar_border_c`, `border_w`.
  - `gbar`: a bar with a triangle indicator, plus `bar_h`.
- **Common properties:** `key`, `rect [x,y,w,h]`, `type`, `background` (colour, hex, or gradient stops like `0:#f00,0.5:yellow,1:#0f0`), `enabled`, `opacity`, `zOrder` (0–700).
- **Validation rules:** every item must stay inside 200×100, and items with the same `zOrder` must not overlap. **If either rule is broken, the whole layout silently fails to render.** Check with `streamdeck validate` or the app logs.
  - No maximum item count is documented.
- **Reserved keys:** `title` and `icon` follow the user's overrides; for `title`, the app ignores your font, colour and alignment.
  - For imagery the plugin must always control, use non-reserved keys (Elgato's advice in issue #149).
- **Touch targets:** at least 35×35 px (Marketplace guideline).

### 2.5 Arbitrary images on the strip (histogram, thumbnail) [official]

**Yes, within each dial's segment.**

- A `pixmap` value can be any of:
  - a plugin-relative file path
  - a base64 data URL (PNG or JPEG)
  - an SVG data URL
- `$A0`'s `full-canvas` covers the full 200×100.
- Ways to produce the images [inference]:
  - **Histogram:** generate an SVG path in JS and send `data:image/svg+xml;base64,...`. No native dependency needed.
  - **Thumbnail:** send JPEG bytes from Lightroom (for example from a Lua-side thumbnail request; that's the Lightroom thread's call), base64-encode them, and push to a pixmap. Use `sharp` (Node-API, used in Elgato's own sample) if you need to resize or crop.

### 2.6 Whole strip vs own segment [official]

The docs state outright that plugins **can't render across the entire touch strip**. Each encoder action owns its own 200×100 segment.

Workaround [inference]: if *your* plugin's actions occupy all 4 dials, render one 800×100 image and push each 200×100 slice to the matching action. Use `coordinates.column` to pick the slice. This breaks if the user puts another plugin's action on one of the dials. (The app also has user-level strip backgrounds per page, which a plugin doesn't control.)

### 2.7 Update-rate limits

- **No documented limit** for `setFeedback`, `setImage`, or `setTitle` in the SDK reference [official].
- The Marketplace plugin guidelines cap **programmatic key-icon updates at 10 per second** [official guideline; Marketplace review only, not enforced for local plugins as far as I know].
- One community test (a Windows bridge for *non-Elgato* Mirabox hardware) reached about 30 fps per strip region with frame-pacing caveats [community; weak evidence].
- Elgato's animated-icon guidance suggests 10–20 fps [official, icon packs].
- **Design target [inference]:** at most 10–15 strip updates per second per segment while the user is turning, and only when the value actually changes. Send diffs (only changed keys). Avoid sending large base64 pixmaps every frame; re-render the histogram only after Lightroom settles.

### 2.8 Dial event rate, acceleration, coalescing

- **No official acceleration setting.** `ticks` is a signed count per event. Community reports agree that fast spins arrive as a single event with |ticks| > 1, so the app batches ticks [community; FXCommands wiki and others]. I found no documented batching window or maximum.
- **Coalescing pattern (recommended) [inference, matching prior art]:**
  - Accumulate ticks per action.
  - Flush to Lightroom at most every 30–50 ms. Show the optimistic value on the strip right away, then reconcile with the value Lightroom echoes back.
  - Apply your own curve, e.g. `step × ticks × (1 + k·|ticks|)`.
  - Use `pressed` as a fine-adjust modifier.
  - Prior art: obalunenko's plugin waits until the dial rests for 0.5 s before acting on model or effort changes. DevelopDeck and FlowKits show live values while turning.
- **Dial stacks:** a user can stack several actions on one dial. **Pressing the dial then cycles through the stack** instead of reaching your action, and press functions move to a strip tap [official explorer article].
  - Design "reset" to work on both a press *and* a touch tap or long-touch.

### 2.9 Manifest `Encoder` block and `Controllers` [official]

- `Actions[].Controllers` can hold up to three of `"Keypad"`, `"Encoder"`, `"Neo"`.
- `Actions[].Encoder`:
  - `layout`: a built-in id or a `.json` path.
  - `Icon`: 72×72 px, plus a 144×144 @2x version.
  - `background`: 200×100 px, plus a 400×200 @2x version.
  - `StackColor`: hex colour.
  - `TriggerDescription { Push, Rotate, Touch, LongTouch }`.
- `States[].Image` is still required (72×72 / 144×144).
- See snippet B below.

---

## 3. Runtime capabilities

### 3.1 Node built-ins, sandboxing, TCC

- **Built-ins:** `http`, `net`, `dgram`, `child_process`, `fs`, `crypto` and the rest are all available. It's stock Node launched by the app.
- **Dependencies:** `--no-global-search-paths` means globally installed modules are never found, so **bundle every dependency** (the template uses Rollup).
- **Native addons:** allowed. Build them for the runtime's architecture (check `process.arch` on Apple Silicon) [official + inference].
- **Sandbox:** no app sandbox is documented, and community plugins freely read `~/.claude`, bind loopback ports, and spawn `osascript` [community].
- **TCC attribution:** macOS attributes helper processes to the app that spawned them (Apple TN3179 says this for Local Network privacy, and TCC works the same way). So Accessibility and Automation prompts generally attribute to **Elgato Stream Deck**, but users report prompts naming `node` or `osascript` too [community, agent-vitals].
  - Grant them and relaunch the app.
  - Grants tied to the Elgato-signed app survive rebuilds of your JS plugin. A separate **ad-hoc-signed helper binary** loses its Accessibility grant on every rebuild unless you sign it with a stable (self-signed) certificate. kotyzap's "Deck for Claude" ran into exactly this [community].

### 3.2 Local servers inside a plugin [community-proven; official hint]

- Running an HTTP or WebSocket server inside the plugin works and is common practice. Examples:
  - **msageha/claude-code-for-stream-deck** (and its upstream, paultyng/agentsd): `127.0.0.1:9200`, `/hooks/{Event}`; `PermissionRequest` held open up to 24 h (agentsd uses 120 s).
  - **obalunenko/streamdeck-claude-plugin:** `127.0.0.1:47823`.
  - **agent-vitals:** loopback listener with a 32-character secret in the URL path.
- Elgato's own deep-link docs say to switch to a WebSocket connection when messages exceed about 2,000 characters [official].
- **Good practice:**
  - Bind to `127.0.0.1` only.
  - Require a shared secret (header or path), because any local process can reach a loopback port.
  - Alternatively, use a **Unix domain socket** with `0600` permissions; Node supports `server.listen(path)` and `curl --unix-socket` [inference].
  - Use a fixed, unusual port, and show a "port busy" state on a key.

### 3.3 Process lifecycle

- The app owns the lifecycle and restarts the plugin automatically after a crash [official].
- **One Node process per plugin** (not per action) [official model].
- The plugin starts with the app (the app autostarts at login) and keeps running whether or not its actions are visible. Every hook-receiving plugin above relies on this [community-confirmed; not stated explicitly in current docs, see open questions].
- After sleep, the plugin gets `onWillAppear` for every visible action, then `onSystemDidWakeUp`. Use that to re-establish sockets (to Lightroom) [official].
- **Restarts kill in-flight held HTTP requests.** That includes every save in `npm run watch`. Hook scripts must fail safe and fall back to the normal in-app prompt [inference].

### 3.4 Settings, global settings, secrets [official]

- **Action settings:**
  - Per instance, JSON, plain text.
  - **Included in profile exports**, so never put tokens there.
  - Read from `ev.payload.settings`; `getSettings()` works only while the action is visible.
- **Global settings:**
  - Plugin-wide, via `streamDeck.settings.get/setGlobalSettings()`.
  - Docs say to use these for user-provided API keys or OAuth tokens.
- **SDK 3.0 changes:**
  - Change events fire **only for Property Inspector edits**, not for your own get/set calls.
  - The `getSecrets` API (bundled, obfuscated secrets for DRM-protected Marketplace plugins) is gone.
- **For this personal project [inference]:**
  - Keep the hook shared secret in global settings or a `0600` file under `~/Library/Application Support/<you>/`.
  - Or use the macOS Keychain through `security` with `child_process`.
  - Keep live session and Lightroom state in memory.

### 3.5 Property Inspector [official]

- An HTML page per action (`PropertyInspectorPath`), running in the app's Chromium (140 in app 7.6).
- Use **sdpi-components v4**, copied locally.
  - It provides `<sdpi-textfield>`, `<sdpi-select>`, `<sdpi-range>`, `<sdpi-checkbox>`, `<sdpi-file>` and more.
  - Bind with `setting="..."`; messaging goes through `SDPIComponents.streamDeckClient`.
- Plugin side:
  - `streamDeck.ui.sendToPropertyInspector()` is a no-op unless a PI is visible.
  - `streamDeck.ui.onSendToPlugin`, `streamDeck.ui.onDidAppear`, and `streamDeck.ui.action` round out the API.
- **Debugging:**
  - Developer mode (`streamdeck dev`) exposes `http://localhost:23654/`; pick the PI page and use DevTools.
  - App 7.1+ also has in-app dev tools that follow the current PI.

### 3.6 Inbound messages from external processes

| Channel | Direction | Payload | Notes |
|---|---|---|---|
| **Loopback HTTP / WebSocket / Unix socket server in the plugin** | Two-way, request and response | Any size | **Best for Approve/Deny** (the hook blocks until a key is pressed). Proven in multiple 2026 Claude Code plugins [community]. |
| **Deep link** `streamdeck://plugins/message/<PLUGIN_UUID>[/path][?query][#fragment]` | One-way, fire-and-forget | Keep under 2,000 chars; local only | Handled by `streamDeck.system.onDidReceiveDeepLink(ev => ev.url.path / .query / .queryParameters / .fragment / .href)`. Active (6.5+) brings the app window forward. **Passive `?streamdeck=hidden` (7.0+) doesn't.** Trigger from a shell with `open "streamdeck://plugins/message/<uuid>/status?x=1&streamdeck=hidden"`. Good for status pings; no reply channel. Also usable as an OAuth callback (Elgato's `oauth2-redirect.elgato.com` proxy). [official] |
| **File drop + `fs.watch`** | One-way (two-way only with polling) | Any | Used by McTonnie's Claude Notify (`~/.claude/streamdeck/sessions/*.json`) and wayzeer's approve plugin [community]. Simple, but needs polling for responses. |
| **Plugin as a client** to an external server | Two-way | Any | For example, the plugin connects to a TCP server opened by the Lightroom Lua plugin (ErikBongers' design), or the reverse. |
| **Elgato MCP server** (`@elgato/mcp-server`, app 7.4+) | AI to deck | — | Lets MCP clients trigger actions the user places on the "MCP Actions" profile. One-way; no documented state readback (§6.3). |

### 3.7 Outbound control of *specific* apps (Claude desktop, Lightroom) on macOS

- **Use `child_process`, not `streamDeck.system.openUrl`.** The 3.0 docs say `openUrl` opens only in the default browser and **doesn't yet support custom schemes** like `my-app://` [official].
  - Run `open "claude://..."` / `open -a "Claude"` / `open -g ...` with `execFile("/usr/bin/open", [...])`.
  - McTonnie's plugin opens a Claude Desktop Code session with `claude://code/continue?session=<id>`. That link is undocumented and was verified on Windows with Desktop 4.29 [community]. The Claude Code thread should verify it on macOS.
- **AppleScript** through `execFile("/usr/bin/osascript", ["-e", ...])`:
  - `tell application "Claude" to activate`, then System Events `keystroke` or `key code`.
  - Needs Automation for each target app, plus Accessibility for keystrokes.
  - Keystrokes go to the **frontmost** app, so activate the target first.
- **Accessibility-API "press button X"** in Claude's window:
  - kotyzap "Deck for Claude" ships a Swift helper (`axpress`) that walks Claude's AX tree to press Allow or Deny, even when Claude isn't frontmost.
  - Fragile when Claude renames buttons; needs a stable signature for the TCC grant [community].
- **Built-in actions (no code):**
  - **Hotkey** and **Hotkey Switch**: frontmost app only; needs Accessibility.
  - **Text**: types text, optionally followed by Enter.
  - **Website**: opens a URL or URI; can also fire a background GET, e.g. at your plugin's localhost endpoint.
  - **Open** / **Open Application**: launches apps, files or scripts (7.4 fixed third-party apps missing from the dropdown).
  - **Multi Action**: sequences actions.
  - All of these can sit beside plugin actions on the same profile [official help].
- **Lightroom:** prefer the Lua plugin protocol over keystrokes. It doesn't need focus or Accessibility, and it gives live values back.

### 3.8 Profiles [official]

- **Bundled profiles:**
  - Export a `.streamDeckProfile`, put it in the plugin folder, and declare it under `Profiles: [{ Name, DeviceType: 7, Readonly, DontAutoSwitchWhenInstalled, AutoInstall }]`.
  - `AutoInstall: false` defers installation until the first switch (6.6+).
- **`streamDeck.profiles.switchToProfile(deviceId, profile?, page?)`:**
  - Works **only with profiles bundled in your manifest**.
  - Omit `profile` to go back to the previous profile.
  - `page` is 0-indexed and needs 6.5+.
  - Older notes say switching temporarily suspends Smart Profile switching.
- **App monitoring:** `ApplicationsToMonitor.mac` takes bundle IDs, with `onApplicationDidLaunch` / `onApplicationDidTerminate`.
  - **Launch and terminate only; no focus or frontmost events.**
  - Bundle IDs: Lightroom Classic is `com.adobe.LightroomClassicCC7`; Claude desktop is `com.anthropic.claudefordesktop` [community-verified; confirm with `osascript -e 'id of app "Claude"'`].
- **Per-app auto-switching:** user-side **Smart Profiles** (profile → application). Paused while the Stream Deck window is open.
  - A plugin can approximate this by polling the frontmost app (e.g. `lsappinfo front` or `osascript`) and calling `switchToProfile`, but only for bundled profiles [inference].
- **For Approve/Deny while you're in Lightroom [inference]:** put the Claude Approve/Deny keys on the Lightroom profile as well (actions from any plugin can live on any profile). Alternatively, have the Claude plugin switch to its bundled profile when a request arrives, then call `switchToProfile(deviceId)` to return.

### 3.9 Dynamic visuals [official]

- `setTitle`, `setImage` (path, data URL, or SVG string; **no animated GIF via `setImage`**; `target` = Hardware, Software, or both), `setState` (0/1 for two-state actions), `showOk`, `showAlert`.
- Iterate visible instances with `streamDeck.actions.forEach(...)` or `this.actions` inside an action class. This is how an HTTP-triggered event repaints every visible Approve key.
- Plugins can't control other plugins' actions.

---

## 4. Dev workflow [official unless noted]

1. Install Node 24+ and `npm i -g @elgato/cli` (1.10.4). The `sd` alias also works.
2. Run `streamdeck create`. The wizard scaffolds `<uuid>.sdPlugin/` plus `src/`, using TypeScript and Rollup, and enables developer mode by default.
   - The UUID is reverse-DNS with lowercase letters, digits, `-` and `.`. The folder name must be `<uuid>.sdPlugin`.
3. Run `npm run watch`, i.e. `rollup -c -w --watch.onEnd="streamdeck restart <uuid>"`. This is hot reload: it rebuilds and restarts on changes to `src/` or the manifest.
   - Restart manually with `streamdeck restart <uuid>`; stop with `streamdeck stop <uuid>`.
   - After adding a plugin, restarting the app can be required if it's running with elevated privileges.
4. **Link and unlink:**
   - `streamdeck link [path]` installs the folder in place.
   - `streamdeck unlink <uuid>` (CLI 1.5+) removes it; `--delete` deletes a non-linked install.
   - The plugins folder is `~/Library/Application Support/com.elgato.StreamDeck/Plugins/` [community + Elgato help].
5. **Developer mode:** `streamdeck dev` (disable with `-d`). It lets debuggers attach and serves the PI debugger at `http://localhost:23654/`.
6. **Debugging Node:** set `"Nodejs": {"Debug": "enabled"}` (or `"break"` / an explicit `--inspect=` port). In VS Code, run "Debug: Attach to Node Process".
7. **Logs:**
   - Use `streamDeck.logger` (`setLevel`, `createScope`).
   - Plugin logs go to `<uuid>.sdPlugin/logs/<uuid>.N.log`: 10 files rotated at 10 MiB, `0` is the newest. The default level is DEBUG in development and INFO in production.
   - App logs go to `~/Library/Logs/ElgatoStreamDeck/StreamDeck0.log`.
   - Uninstalling a plugin deletes its logs.
8. **Validate and pack:**
   - `streamdeck validate [path]` checks the manifest and layout schemas, which catches layouts that silently fail to render.
   - `streamdeck pack [path] -o dist/ [--version x.y.z]` produces `.streamDeckPlugin`. It must pass validation, and `.sdignore` uses gitignore syntax.
9. **Running your own unsigned plugin:** **yes**.
   - Install with `streamdeck link`, by double-clicking a `.streamDeckPlugin`, or by copying the folder into Plugins.
   - No Marketplace, signing, or DRM is needed for local use. DRM applies only after Maker Console processing.
   - JS plugins need no macOS code signing. Only extra native helper binaries need a signing strategy, because of TCC (see §3.1).

---

## 5. Distribution (brief; personal use only)

- Marketplace goes through **Maker Console**, which runs a review and can request changes or reject.
  - Guidelines cover UUIDs, names, 2–30 actions, icons, PI conventions, `showAlert` and `showOk` usage, touch targets of at least 35×35 px, and at most 10 icon updates per second.
- Since Jan/Feb 2026 Marketplace requires DRM compatibility, `SDKVersion` 3, and app 6.9 or later.
- Paid listings pay out through Stripe Connect. I couldn't verify the revenue split.
- Single-platform listings exist (DevelopDeck and Lightroom Dials are Windows-only), and the manifest `OS` array accepts one platform, so mac-only is fine.
- **None of this is needed here.** Keep the plugin linked or locally installed.

---

## 6. Prior art

### 6.1 Lightroom Classic on Stream Deck

| Project | Platform | Bridge to Lightroom | Dials / strip | Status |
|---|---|---|---|---|
| **FlowKits "Lightroom Classic Plugin"** (Marketplace) | **macOS + Windows**, app 7.1+ | Auto-installed LR "companion module", enabled in Plug-in Manager; two-way state | 3 LCD dial actions (Library, 26 Develop params, Crop/Transform) with live values; supports +, + XL, Galleon | v1.7.1, 21 Oct 2026 |
| **SideshowFX "Lightroom Classic Pro"** + "Pro Profiles Stream Deck +" | macOS + Windows, app 7.1+ | Its own plugin "through Lightroom's API" (700+ commands); **English Lightroom only** | 106 dial controls, 368 presets | v4.0.2, 10 Jun 2026; about $34.99 |
| **DevelopDeck** (Enfoke) | **Windows only**, app 6.9+, LrC 12+ | Self-installing LR connector | All Develop sliders on dials; **live values on the strip, updated even when you edit with the mouse**; press resets, tap switches slider; rating dial | v1.0.6, 26 Oct 2026 (fixed reconnection after a brief disconnect) |
| **Lightroom Dials** (Steve Lunden) | Windows only, app 6.9+ | ErikBongers' MIT bridge (below) | 12 dial actions, press resets, 3 swipeable dial pages | v1.1, 8 Jul 2026 |
| **ImSammyTTV/Lightroom-Control-Deck** (GitHub, MIT) | macOS + Windows, app 7.1+ | TypeScript plugin plus a Lua `.lrdevplugin`; **two loopback ports, 53110 and 53112**; text protocol (`adj:Exposure2012:5`, `cmd:pick`); returns flag, stars, label, module and slider values | Live slider values on dial cards; key states for flag, stars and label; alert icon when disconnected | Small (about 5 commits). **Best fork candidate.** |
| **ErikBongers/streamdeck-lightroom** (GitHub, MIT) | Windows | C++ Stream Deck plugin; Lua plugin opens a **TCP server**, the SD side connects as a client; plain-text commands (`Exposure+`, `reset`, values) | No dials | Old; reference only |
| ninoleto/LRBridge | Windows x64 | HTTP API on 17890–17892 plus Lua; reached through Bitfocus Companion, no SD plugin | — | v0.6.0-rc.1; development paused |
| MIDI2LR (rsjaffe) | mac + Windows | MIDI → app → Lua plugin | Not Stream Deck-native | Last push Mar 2026 |

**Takeaways for the Stream Deck side** [community]:

- Every serious integration uses a **Lightroom SDK plugin over local sockets**, not keystrokes.
- Two-port or two-socket designs are common, which fits LrSocket's one-way sockets (Lightroom thread to confirm).
- Lightroom side, reported in the ImSammyTTV README:
  - Lightroom loads plug-ins only at launch.
  - A plug-in that throws during load gets disabled.
  - **Modal dialogs pause the bridge.**
  - There's no "remove colour label" API.
  - Slider actions need a selected photo.
- Stream Deck side, from the same README: the app **skips installing an update whose version number equals the installed one**, so bump `Version`.
- Gap: nobody I found shows a **histogram or photo thumbnail on the strip**. All of them show numeric values or bars.
- Gap: the best-reviewed dial-heavy option (DevelopDeck) is Windows-only, and FlowKits and SideshowFX are closed-source.

### 6.2 Claude Code and AI coding agents on Stream Deck (all community, all 2026)

- **msageha/claude-code-for-stream-deck** (fork of paultyng/agentsd, MIT):
  - Claude Code **HTTP hooks**, 16 events, POST to `127.0.0.1:9200/hooks/{Event}`.
  - **`PermissionRequest` held open up to 24 h**; Approve, Deny and Always Allow keys.
  - FIFO queue across sessions; a session dial; Focus can target Claude Desktop.
  - Gotchas: Stop sends Ctrl+C to the *frontmost* terminal, and a debug endpoint is unauthenticated.
- **tapparello/agent-vitals** (MIT, mac + Windows):
  - Reads `~/.claude/sessions/*.json` and transcripts.
  - Approval hook goes to a loopback listener with a **secret in the path**; Allow, Always Allow and Deny keys; 20 s window; first answer wins.
  - Lists exactly which keys need Accessibility and Automation.
  - Uses an **undocumented** usage endpoint.
- **obalunenko/streamdeck-claude-plugin** (MIT, macOS):
  - Hooks go to `127.0.0.1:47823`; 600 s hold; Allow, Always and Deny.
  - **AskUserQuestion answered from keys.**
  - Stream Deck + dial changes model or effort by typing `/model` or `/effort` into Terminal.app after a 0.5 s rest.
  - Appears to be built with Go tooling, which suggests a non-Node plugin.
- **McTonnie/claude-streamdeck "Claude Notify"** (MIT, Windows):
  - Targets **Claude Desktop Code-tab sessions** via Claude Code "mods" that write per-session JSON.
  - **Stream Deck + session-browser and session-status dials** with strip rows coloured by state.
  - Opens sessions via `claude://code/continue?session=<id>` (undocumented).
  - Closest to the user's setup, but Windows-only.
- **kotyzap/Stream-Deck-Claude-Plugin "Deck for Claude"** (macOS, Claude desktop app):
  - Accessibility-API helper presses Allow and Deny, even when Claude isn't frontmost.
  - Keystroke shortcuts, plus status and usage keys.
  - Ships a signed helper so TCC grants survive rebuilds.
- Others:
  - cla1redonald/streamdeck-claude: MCP server plus broker; approval calls block for up to 5 min.
  - fredriklindstrom/stream-deck-claude-code: one key per session.
  - wayzeer/claude-code-streamdeck-approve: Windows; file-based.
  - GlebYaltchik/streamdeck-claude-monitor: early-stage.
  - Marketplace: "Claude Code Usage" (Windows), the "Claude Code Shortcut Profile" (57 slash commands; dials for permission mode, history, scroll and zoom), "Claude Peak Ticker".
- **Elgato's official "ChatGPT & Codex" plugin** (app 7.6+, 22 Sep 2026). A good UX reference:
  - Activity keys show working, waiting or finished; New Chat, Send Prompt (8,000-char saved prompts), Dictate, Steer, Stop, Run Skill; model, effort and speed keys; usage.
  - Stream Deck + **dials scroll and open chats, browse skills, and adjust model and effort**.
  - Notably, it **doesn't approve or deny**: the key changes colour and tapping opens the chat.
  - Its transport to the ChatGPT app isn't documented.
- **No official Anthropic–Elgato integration** found.

### 6.3 Official Elgato AI / MCP

- **App 7.4+ MCP:**
  - Enable "Elgato MCP Deck" under Preferences → General. This creates an **MCP Actions** profile; only actions placed there are exposed, each with a description the AI uses to decide when to trigger it.
  - Server: `npx --yes @elgato/mcp-server@latest` (0.1.8, 2026-10-01), stdio (Claude Desktop) or `--http`. The transport to the app isn't documented (Elgato says "IPC").
  - Docs cover **triggering actions only**, with no state readback or events.
  - Relevance: Claude could *press* your plugin's actions (e.g. "apply preset X"), but this doesn't replace hooks for status or approvals.
- Elgato's "AI controller" explainer (updated 30 Jul 2026) names Hotkeys, Multi Actions, MCP and plugins as the integration paths.

### 6.4 Repos worth studying or forking

1. **elgatosf/streamdeck** `examples/layouts`: the official encoder, layout and feedback sample (SDKVersion 3, min app 7.1, Node 20).
2. **ImSammyTTV/Lightroom-Control-Deck**: TS + Lua over loopback, mac + Windows, MIT. Fork base for the Lightroom plugin.
3. **msageha/claude-code-for-stream-deck** or **paultyng/agentsd**: hook HTTP server, held `PermissionRequest`, multi-session queue, session dial.
4. **tapparello/agent-vitals**: secret-path loopback auth, TCC permission table, Always-Allow UX.
5. **kotyzap/Stream-Deck-Claude-Plugin**: macOS Claude-desktop control through the AX API; lessons on signing and TCC.
6. **McTonnie/claude-streamdeck**: Stream Deck + session-dial UX for Claude Desktop sessions.

---

## 7. Gotchas

1. **The strip is per-dial: 200×100 each.** You can't draw one image across the whole strip, and no swipe events reach plugins.
2. **Silent layout failure** when an item is out of bounds or overlaps another at the same `zOrder`. Always run `streamdeck validate`.
3. **Reserved `title` and `icon` keys** are overridden by user customization, and `setImage`/`setTitle` are ignored once the user customizes. Use your own keys for live data (#149).
4. **No documented rate limits.** Self-throttle to about 10–15 Hz per segment and send diffs.
5. **Ticks batch on fast spins, and there's no official acceleration.** Coalesce and apply your own curve. **Dial stacks steal the press**, so mirror press actions on tap or long-touch.
6. **`openUrl` doesn't support custom schemes.** Use `child_process` with `open`.
7. **TCC prompts (Accessibility, Automation)** can name Stream Deck, `node`, or `osascript`. Grant them and relaunch. Separate helper binaries need stable signing.
8. **Keystroke routes (Hotkey or System Events) hit the frontmost app.** To target Claude, activate it first, or use AX-API or URL routes.
9. **SDK 3.0 settings semantics:** `onDidReceiveSettings` and `onDidReceiveGlobalSettings` don't fire after your own `getSettings()` calls. Read settings from event payloads or use `await getSettings()`. The secrets API is gone.
10. **Action settings are plain text and exported with profiles.** Keep secrets elsewhere.
11. **Restarts drop held HTTP requests,** including on every watch rebuild. Hooks must time out and fall back. Also, hooks fail if the Stream Deck app isn't running.
12. **Two plugins means two processes and two ports.** Choose fixed ports, detect conflicts, and authenticate requests.
13. **Tahoe issues:** encoder lag after a cold boot (#154; relaunch the app). Plugin localhost connections are flaky right after login (HA #429). Use retry with backoff, and re-sync on `onSystemDidWakeUp`.
14. **Use direct USB, not a dock or hub,** for reliable events.
15. **Smart Profiles pause while the app window is open,** so close it when testing auto-switching. Plugins can only switch to *bundled* profiles.
16. **Bump the manifest `Version` (x.y.z.w) on reinstall,** or the app may skip the update [community].
17. **Bundle all npm dependencies** (`--no-global-search-paths`).
18. The **`claude://code/continue?session=` link is undocumented** [community]. Treat any Claude Desktop URL or AX route as brittle.

---

## 8. How the planned architecture maps onto the platform

- **(a) Lightroom:**
  - The Node plugin keeps a reconnecting `net` client (or server) to the Lua plugin on 127.0.0.1. A two-socket protocol is fine.
  - Dials send coalesced deltas, and the plugin repaints the strip from the values Lightroom echoes back.
  - Keys handle pick, reject, rating, labels and presets. Use `showAlert` while disconnected.
  - Re-sync on `onSystemDidWakeUp` and on `applicationDidLaunch` (`com.adobe.LightroomClassicCC7`).
  - **Feasible; proven by prior art.**
- **(b) Claude Code:**
  - The plugin hosts an authenticated loopback HTTP server, or a Unix socket.
  - Status hooks POST and return immediately. Deep links are an optional fire-and-forget alternative.
  - `PermissionRequest` POSTs are held until an Approve or Deny key press, a timeout, or the client disconnects, then answered with the hook's decision JSON. The Claude Code thread defines the hook schema and whether hooks fire for Desktop-hosted sessions.
  - Multi-session browsing works on a dial, with strip rows per session.
  - Prompt and mode buttons go out through `osascript` or `open` into the Claude app, or the built-in Text and Hotkey actions.
  - **Feasible on the Stream Deck side.** How Claude Desktop sessions get targeted is the open risk.
- **One plugin or two:** two independent plugins (separate processes, ports and restarts) are simpler. Put the Claude Approve/Deny keys on the Lightroom profile too, so approvals work while you're editing.

---

## Code snippets (SDK 3.x)

### A. Encoder action: `dialRotate` with coalescing and `setFeedback`

```ts
// src/actions/develop-slider.ts
import streamDeck, {
  action,
  SingletonAction,
  type DialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type TouchTapEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import { lr } from "../lightroom-bridge"; // your TCP client to the Lua plugin (not shown)

type SliderSettings = { param?: string; step?: number; min?: number; max?: number };

@action({ UUID: "com.example.lrdeck.develop-slider" })
export class DevelopSlider extends SingletonAction<SliderSettings> {
  private pending = new Map<string, number>(); // accumulated ticks per action instance
  private timers = new Map<string, NodeJS.Timeout>();

  override async onWillAppear(ev: WillAppearEvent<SliderSettings>): Promise<void> {
    if (!ev.action.isDial()) return; // dial-only commands below
    await ev.action.setFeedbackLayout("layouts/slider.json");
    await ev.action.setTriggerDescription({
      rotate: "Adjust (push + turn = fine)",
      push: "Reset",
      touch: "Reset",
      longTouch: "Choose slider",
    });
    const { param = "Exposure2012" } = ev.payload.settings;
    await this.paint(ev.action, param, await lr.get(param));
  }

  override onDialRotate(ev: DialRotateEvent<SliderSettings>): void {
    const id = ev.action.id;
    // ticks > 0 = clockwise; fast spins arrive as |ticks| > 1 in one event.
    const t = ev.payload.ticks;
    const curve = ev.payload.pressed ? 0.2 : 1 + 0.5 * Math.max(0, Math.abs(t) - 1);
    this.pending.set(id, (this.pending.get(id) ?? 0) + t * curve);
    if (this.timers.has(id)) return; // flush at most every 40 ms

    this.timers.set(id, setTimeout(async () => {
      this.timers.delete(id);
      const delta = this.pending.get(id) ?? 0;
      this.pending.delete(id);
      const { param = "Exposure2012", step = 0.05 } = ev.payload.settings;
      try {
        const value = await lr.adjust(param, delta * step); // LR echoes the real value
        await this.paint(ev.action, param, value);
      } catch (err) {
        streamDeck.logger.warn(`adjust failed: ${err}`);
        await ev.action.showAlert();
      }
    }, 40));
  }

  override async onDialDown(ev: DialDownEvent<SliderSettings>): Promise<void> {
    await this.reset(ev.action, ev.payload.settings);
  }

  override async onTouchTap(ev: TouchTapEvent<SliderSettings>): Promise<void> {
    // Mirror "reset" on tap, because inside a Dial Stack the press cycles actions.
    if (!ev.payload.hold) return this.reset(ev.action, ev.payload.settings);
    // long touch: open a slider picker, etc. ev.payload.tapPos = [x, y] in this dial's 200x100 canvas
  }

  private async reset(a: DialAction<SliderSettings>, s: SliderSettings) {
    const param = s.param ?? "Exposure2012";
    await this.paint(a, param, await lr.reset(param));
  }

  private async paint(a: DialAction<SliderSettings>, param: string, v: number) {
    await a.setFeedback({
      title: param.replace(/2012$/, ""),
      value: v.toFixed(2),
      indicator: { value: v, range: { min: -5, max: 5 } },
    });
  }
}
```

```jsonc
// <uuid>.sdPlugin/layouts/slider.json  (all items inside 200x100, no same-zOrder overlaps)
{
  "$schema": "https://schemas.elgato.com/streamdeck/plugins/layout.json",
  "id": "lr-slider",
  "items": [
    { "key": "title", "type": "text", "rect": [16, 8, 168, 22], "font": { "size": 16, "weight": 600 }, "alignment": "left" },
    { "key": "value", "type": "text", "rect": [16, 32, 168, 30], "font": { "size": 24, "weight": 700 }, "alignment": "right" },
    { "key": "indicator", "type": "gbar", "rect": [16, 70, 168, 20], "value": 0, "range": { "min": -5, "max": 5 },
      "subtype": 4, "bar_h": 10, "border_w": 0, "bar_bg_c": "0:#3a6df0,0.5:#777777,1:#f0c23a" }
  ]
}
```

(Using `title` as a key means the user's title settings override its font and alignment. Rename it, e.g. to `label`, if you want full control.)

### B. Manifest: Encoder action block plus relevant top-level fields

```jsonc
{
  "$schema": "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
  "UUID": "com.example.lrdeck",
  "Name": "LR Deck",
  "Version": "0.1.0.0",
  "Author": "you",
  "Icon": "imgs/plugin/icon",
  "CodePath": "bin/plugin.js",
  "SDKVersion": 3,
  "Software": { "MinimumVersion": "7.1" },
  "Nodejs": { "Version": "24", "Debug": "enabled" },
  "OS": [{ "Platform": "mac", "MinimumVersion": "13" }],
  "ApplicationsToMonitor": { "mac": ["com.adobe.LightroomClassicCC7"] },
  "Profiles": [{ "Name": "profiles/LR Develop", "DeviceType": 7, "AutoInstall": true, "DontAutoSwitchWhenInstalled": true }],
  "Actions": [
    {
      "UUID": "com.example.lrdeck.develop-slider",
      "Name": "Develop Slider",
      "Icon": "imgs/actions/slider/icon",
      "Controllers": ["Encoder"],
      "States": [{ "Image": "imgs/actions/slider/key" }],
      "PropertyInspectorPath": "ui/slider.html",
      "Encoder": {
        "layout": "layouts/slider.json",
        "Icon": "imgs/actions/slider/dial",
        "background": "imgs/actions/slider/strip-bg",
        "StackColor": "#3A6DF0",
        "TriggerDescription": {
          "Rotate": "Adjust (push + turn = fine)",
          "Push": "Reset",
          "Touch": "Reset",
          "LongTouch": "Choose slider"
        }
      }
    }
  ]
}
```

### C. Inbound channels: deep link (fire-and-forget) and loopback HTTP (blocking Approve/Deny)

```ts
// src/inbound.ts (Claude plugin)
import streamDeck from "@elgato/streamdeck";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

// 1) Deep link (one-way, under 2,000 chars). Send from a hook script:
//    open -g "streamdeck://plugins/message/com.example.claudedeck/status?session=abc&state=idle&streamdeck=hidden"
streamDeck.system.onDidReceiveDeepLink((ev) => {
  const { path, queryParameters } = ev.url; // "/status", URLSearchParams
  if (path === "/status") sessions.update(queryParameters.get("session"), queryParameters.get("state"));
});

// 2) Loopback HTTP (two-way). A PermissionRequest hook POSTs and waits for a key press.
const TOKEN = Buffer.from(loadSharedSecret()); // e.g. from a 0600 file, also read by the hook script
export const pending = new Map<string, (d: "allow" | "deny") => void>();

createServer((req, res) => {
  const auth = Buffer.from(String(req.headers["x-deck-token"] ?? ""));
  if (auth.length !== TOKEN.length || !timingSafeEqual(auth, TOKEN)) return void res.writeHead(401).end();
  if (req.method !== "POST" || req.url !== "/permission") return void res.writeHead(404).end();

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const id = randomUUID();
    const done = (decision: "allow" | "deny") => {
      clearTimeout(timer);
      pending.delete(id);
      if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ decision }));
      repaintApprovalKeys(); // streamDeck.actions.forEach(...) -> setTitle/setImage
    };
    const timer = setTimeout(() => done("deny"), 120_000); // or let the hook time out and fall back
    pending.set(id, done);
    res.on("close", () => { if (!res.writableEnded) { clearTimeout(timer); pending.delete(id); repaintApprovalKeys(); } });
    repaintApprovalKeys(JSON.parse(body)); // show tool + command on keys / strip
  });
}).listen(47999, "127.0.0.1");

// In the Approve key's onKeyDown: take the oldest entry from `pending` and call it with "allow".
// (The exact response JSON Claude Code expects is defined by the Claude Code thread.)
```

---

## Unverified / open questions

1. **Plugin start-up:** does the app launch every installed plugin at startup, even with none of its actions placed? Prior art depends on it, but the current docs don't say. Verify by logging in `plugin.ts`.
2. **Developer mode and linked plugins:** is developer mode *required* for a linked plugin to load? `create` enables it by default; not documented.
3. **TCC attribution:** for Accessibility and Automation, is the grant recorded against "Elgato Stream Deck" or against the bundled `node` / `osascript` binary? And does the 7.1+ Node runtime auto-update reset any grant made to `node`?
4. **Encoder lag (#154):** is the cold-boot lag on macOS 26 fixed in 7.5 or 7.6? No fixed version is named.
5. **Rate limits:** is there an app-side cap or queue for `setFeedback`, `setImage`, or WebSocket messages? What batching window produces |ticks| > 1? Measure on the device.
6. **Passive deep links:** does `streamdeck=hidden` work combined with other query parameters (`?a=1&streamdeck=hidden`), and is it stripped before the plugin sees the URL? Does a deep link sent while the app isn't running launch it and get delivered once the plugin connects?
7. **Smart Profiles:** can bundled (plugin-shipped) profiles be assigned to applications? Or must the user build their own profiles for per-app switching?
8. **Node 26 end to end:** the schema accepts `"26"` (merged 2026-10-19) and the docs list runtime 26.12.1 for apps 7.1–7.6. Not tested here. `"24"` is the safe choice.
9. **Stream Deck + key size:** 120×120 px is commonly cited but wasn't confirmed by an official source. Manifest images are 72/144 px either way.
10. **sdpi-components:** exact current v4 patch version and release date.
11. **Marketplace:** revenue share and fees (irrelevant for personal use).
12. **Elgato's ChatGPT & Codex plugin:** how it talks to the ChatGPT app (local API, deep links, or something else). Not documented.
13. **`claude://code/continue?session=<id>`** on macOS Claude Desktop, and whether Claude Code hooks fire for Desktop-hosted sessions. Hand off to the Claude Code thread.
14. **Galleon 100 SD:** full Encoder API parity (it's listed as dial-stack compatible).
15. **Stream Deck + XL:** official announcement and ship date (secondary sources only: Mar 2026 announcement, Q2 2026 release).
16. **Inline layout objects:** can `setFeedbackLayout` accept an inline object instead of a file path? The SDK 3.x signature says string only.
17. **Help center:** help.elgato.com pages (system requirements, 7.x release notes, tech specs) returned HTTP 403 to fetches. Facts from them came from search snippets and the in-app release-notes pages on edge.elgato.com.

---

## Sources (all accessed 2026-10-31)

**Official: Elgato docs**

- SDK docs home (v3.0.0): https://docs.elgato.com/streamdeck/sdk/
- Getting Started: https://docs.elgato.com/streamdeck/sdk/introduction/getting-started
- Your First Changes: https://docs.elgato.com/streamdeck/sdk/introduction/your-first-changes/
- Plugin Environment (runtimes table): https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/
- Manifest reference: https://docs.elgato.com/streamdeck/sdk/references/manifest/
- Dials & Touch Strip: https://docs.elgato.com/streamdeck/sdk/guides/dials/
- Layouts reference: https://docs.elgato.com/streamdeck/sdk/references/layouts/
- WebSocket plugin API: https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/
- Stream Deck changes (app changelog): https://docs.elgato.com/streamdeck/sdk/references/changelog/
- WebSocket API changes: https://docs.elgato.com/streamdeck/sdk/references/websocket/changelog/
- Deep-Linking: https://docs.elgato.com/streamdeck/sdk/guides/deep-linking/
- Settings: https://docs.elgato.com/streamdeck/sdk/guides/settings/
- Logging: https://docs.elgato.com/streamdeck/sdk/guides/logging/
- Property Inspectors (UI): https://docs.elgato.com/streamdeck/sdk/guides/ui/
- Profiles: https://docs.elgato.com/streamdeck/sdk/guides/profiles/
- System (openUrl, wake): https://docs.elgato.com/streamdeck/sdk/guides/system/
- App Monitoring: https://docs.elgato.com/streamdeck/sdk/guides/app-monitoring/
- Resources: https://docs.elgato.com/streamdeck/sdk/guides/resources/
- Actions: https://docs.elgato.com/streamdeck/sdk/guides/actions/
- Keys: https://docs.elgato.com/streamdeck/sdk/guides/keys/
- Architecture: https://docs.elgato.com/sdk/plugins/architecture
- CLI docs:
  - Intro: https://docs.elgato.com/streamdeck/cli/intro
  - dev: https://docs.elgato.com/streamdeck/cli/commands/dev
  - link: https://docs.elgato.com/streamdeck/cli/commands/link
  - unlink: https://docs.elgato.com/streamdeck/cli/commands/unlink
  - pack: https://docs.elgato.com/streamdeck/cli/commands/pack
  - validate: https://docs.elgato.com/streamdeck/cli/commands/validate
- Marketplace plugin guidelines: https://docs.elgato.com/guidelines/stream-deck/plugins

**Official: Elgato repos and registries**

- SDK monorepo: https://github.com/elgatosf/streamdeck
- SDK plugin changelog: https://github.com/elgatosf/streamdeck/blob/main/packages/plugin/CHANGELOG.md
- Node 26 PR #176 (merged 2026-10-19): https://github.com/elgatosf/streamdeck/pull/176
- Issue #154 (encoder lag after cold boot on Tahoe, Apr 2026): https://github.com/elgatosf/streamdeck/issues/154
- Issue #149 (setFeedback icon vs setImage; docks): https://github.com/elgatosf/streamdeck/issues/149
- npm registry:
  - `@elgato/streamdeck`: https://registry.npmjs.org/@elgato/streamdeck
  - `@elgato/cli`: https://registry.npmjs.org/@elgato/cli
  - `@elgato/mcp-server`: https://registry.npmjs.org/@elgato/mcp-server
- Context7 index of the SDK's `_autodocs` (DeepLinkURL, switchToProfile, ui API): library `/elgatosf/streamdeck`

**Official: Elgato product pages and release notes**

- Release notes:
  - 7.6: https://help.elgato.com/hc/en-us/articles/51156609278737-Elgato-Stream-Deck-7-6-Release-Notes (22 Sep 2026; via search), with in-app notes at https://edge.elgato.com/egc/sd_content/releasenotes/7.6.0.html
  - 7.5.1: https://edge.elgato.com/egc/sd_content/releasenotes/7.5.1.html
  - 7.4: https://edge.elgato.com/egc/sd_content/releasenotes/7.4.0.html (1 Apr 2026)
  - 7.1.1: https://help.elgato.com/hc/en-us/articles/42210974537233-Elgato-Stream-Deck-7-1-1-Release-Notes (23 Dec 2025; via search)
- Homebrew cask (7.6.0.23012): https://formulae.brew.sh/api/cask/elgato-stream-deck.json
- Product and support pages:
  - Stream Deck + product page: https://www.elgato.com/us/en/p/stream-deck-plus-black
  - Stream Deck + XL: https://www.elgato.com/us/en/p/stream-deck-plus-xl
  - System requirements (macOS 13+, via search): https://help.elgato.com/hc/en-us/articles/34512594204049-Elgato-Stream-Deck-Software-System-Requirements
  - Smart Profiles: https://www.elgato.com/us/en/explorer/products/stream-deck/smart-profiles-stream-deck/
  - Dial Stack (updated 9 Jul 2026): https://www.elgato.com/eu/bg/explorer/products/stream-deck/what-is-a-dial-stack-for-stream-deck/
- AI-related pages:
  - MCP setup (updated 9 Jul 2026): https://www.elgato.com/us/en/explorer/products/stream-deck/sd-mcp-setup/
  - "What is an AI controller" (updated 30 Jul 2026): https://www.elgato.com/us/en/explorer/products/stream-deck/what-is-an-ai-controller/
  - ChatGPT & Codex plugin (updated 23 Sep 2026): https://www.elgato.com/eu/en/explorer/products/stream-deck/control-chatgpt-and-codex-from-stream-deck/
  - Control Claude with Stream Deck (updated 7 Aug 2026): https://www.elgato.com/explorer/products/stream-deck/control-claude-with-stream-deck-for-faster-workflows/
- Marketplace listings:
  - FlowKits Lightroom Classic Plugin: https://marketplace.elgato.com/product/lightroom-classic-plugin-bc1cd74a-e605-410e-82f6-2082cc8899f6
  - DevelopDeck: https://marketplace.elgato.com/product/developdeck-6b98ad12-a090-4e41-80c0-42737fd411cf
  - Lightroom Dials: https://marketplace.elgato.com/product/lightroom-dials-3f0a0400-2dd5-4857-9228-7549bb8013d7
  - SideshowFX Pro Profiles: https://marketplace.elgato.com/product/lightroom-classic-pro-profiles-stream-deck-plus-fd6791a6-8f33-49c0-92aa-9d319d1361b2

**Official: Apple**

- TN3179 Understanding local network privacy (rev. 2026-10-06): https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy

**Community**

- ChekTek/streamdeck-rs PR #5 (diff of SDK 2.1.2 vs 3.0.x): https://github.com/ChekTek/streamdeck-rs/pull/5
- niklam/iracedeck #1208 (3.0 settings-event migration, Sep 2026): https://github.com/niklam/iracedeck/issues/1208
- cgiesche/streamdeck-homeassistant #429 (localhost failures after reboot on Tahoe): https://github.com/cgiesche/streamdeck-homeassistant/issues/429
- Lightroom projects:
  - ImSammyTTV/Lightroom-Control-Deck: https://github.com/ImSammyTTV/Lightroom-Control-Deck
  - ErikBongers/streamdeck-lightroom: https://github.com/ErikBongers/streamdeck-lightroom
  - ninoleto/LRBridge: https://github.com/ninoleto/lrbridge
- Claude Code projects:
  - msageha/claude-code-for-stream-deck: https://github.com/msageha/claude-code-for-stream-deck
  - paultyng/agentsd: https://github.com/paultyng/agentsd
  - tapparello/agent-vitals: https://github.com/tapparello/agent-vitals
  - obalunenko/streamdeck-claude-plugin: https://github.com/obalunenko/streamdeck-claude-plugin
  - McTonnie/claude-streamdeck: https://github.com/McTonnie/claude-streamdeck
  - kotyzap/Stream-Deck-Claude-Plugin: https://github.com/kotyzap/Stream-Deck-Claude-Plugin
- Alish3r/claude-deck SDK notes: https://github.com/Alish3r/claude-deck/blob/master/docs/STREAMDECK-SDK.md
- FXCommands wiki (dial ticks grow with speed): https://github.com/josh-tf/fxcommands/wiki/Dials
- Bundle IDs:
  - Lightroom Classic: https://doesitarm.com/app/lightroom
  - Claude desktop: https://doesitarm.com/app/claude
