# OpenKneeboard Configurator

A Windows Stream Deck plugin for controlling OpenKneeboard from keys and dials. It can switch tabs and profiles, recenter VR, nudge a view's placement and size, toggle one view, and fade one view. Each action has an offline property inspector for its settings. The plugin includes its own icons and build files.

Its visible name and category are **OpenKneeboard Configurator**, and its plugin ID is `com.willvoorhees.openkneeboard-configurator`. Profiles using the earlier plugin identifier need their actions re-added after installation; Stream Deck identifies actions by their plugin and action IDs.

## Artwork

The icons in `imgs/actions/` are the plugin's bundled defaults, shown in Stream Deck's action list and on newly added actions. Stream Deck profiles can override the image on each key or dial. The existing rig uses those overrides, so its key faces differ from the bundled defaults.

The package also includes 14 images verified against the installed profiles in `imgs/profile/`: the original steering wheel and icons based on Google's Material set. Their source SVGs and image hashes are in `artwork-source/`; the Material license is in the plugin's `licenses/` folder. Six other images in the current profile came from the Lovely Sim Racing icon pack and are deliberately absent from this public repository. The plugin does not require that pack to build, install, or run.

## OpenKneeboard compatibility

| Action | OpenKneeboard requirement |
| --- | --- |
| Tab switching, profile switching, recenter VR | 1.12.10 or newer |
| VR placement and size adjustment | A build containing merged [PR #937](https://github.com/OpenKneeboard/OpenKneeboard/pull/937). Release 1.12.10 predates it. |
| Toggle one view | A build containing [PR #939](https://github.com/OpenKneeboard/OpenKneeboard/pull/939) as reworked after review (`ToggleVRViewVisibility`); builds of earlier versions, which used `ToggleViewVisibility` or `SetViewVisibility`, ignore it. Include [PR #942](https://github.com/OpenKneeboard/OpenKneeboard/pull/942) too: without it, hiding the last visible view with SteamVR running can crash OpenKneeboard. |
| Fade one view | A build containing [PR #940](https://github.com/OpenKneeboard/OpenKneeboard/pull/940) as reworked after review (`SetVRViewOpacity`); builds of earlier versions, which used `SetViewOpacity`, ignore it. |

The API uses a one-way Windows mailslot. A successful write confirms delivery to OpenKneeboard, not that the requested change was applied. Unsupported messages are ignored by older builds.

## Configure actions

Add an action from the **OpenKneeboard Configurator** category in Stream Deck, select it, enter its settings in the property inspector, and press **Save**. Tab and profile names must exactly match names in OpenKneeboard. View numbers start at 1; 0 means the active view where supported. Actions can be placed on keys or dials where their controller supports them. Dial rotation adjusts placement or opacity.

| Action | Key press | Dial |
| --- | --- | --- |
| **Switch Profile** | Switch to the configured OpenKneeboard profile | Press to switch |
| **Show Tab** | Show the configured tab on the active or selected view | Press to show |
| **Overlay Control** | Show or hide the reference panel; optionally select a profile first | Press for the same command |
| **Adjust Placement** | Nudge one axis or resize by signed key press ticks; use separate keys for increase and decrease | Turn to adjust using the configured dial ticks per detent |
| **Select View** | Point placement controls at a view | Press to select |
| **Toggle View** | Show or hide one view | Press to toggle |
| **Fade View** | Change opacity by a configured signed step | Turn to fade; press for the configured step |
| **Reset Position** | Undo this session's placement changes for the selected view | Press to reset |
| **Recentre VR** | Recenter the VR overlay | Press to recenter |

For **Switch Profile**, enter one exact profile name per action. This is a manual command; **Overlay Control** can also select its configured profile automatically when a Stream Deck page appears. A later page change can therefore replace a manual selection if that page has **Overlay Control** configured. For **Adjust Placement**, choose Left/Right, Up/Down, Near/Far, Pitch, Yaw, Roll, or Size from the Axis menu. Size scales both physical dimensions proportionally. Device default follows the dial column, or Left/Right on a key. On a key, `Key press ticks` defaults to `1`; use `10` for coarse translation/rotation or `5` for coarse size, with a negative sign to decrease. Set `Dial ticks per detent` to the same positive count on dials. Existing actions with an axis index or Size setting appear with the matching menu choice and keep working.

Place coarse and fine controls on separate Stream Deck pages with a native Go to Page key between them. Set each action’s `Placement reference tab` to the matching OpenKneeboard tab (`Placement` or `Placement Fine`). The displayed Stream Deck page and its configured ticks determine the step size; there is no plugin mode to track. The plugin does not create tabs or Stream Deck profiles.

## Build and install

Use Node.js 20 or newer. Build and install on **Windows**, because `koffi` selects a native Windows binary when `npm ci` runs there. Quit Stream Deck from its tray icon before the install step.

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run validate
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Copy
```

`install.ps1` stages the source in a native Windows build directory, so it also works when the checkout is in WSL and PowerShell sees it through a UNC path. To keep Stream Deck available during the build, run `install.ps1 -StageOnly`, quit Stream Deck, then run `install.ps1 -UseStagedBuild -Copy`. Omit `-Copy` to link the build directory into Stream Deck's Plugins folder; that requires Windows Developer Mode or elevation. The script refuses to install while Stream Deck is running to avoid partially replacing its locked native binary.

To make a distributable `.streamDeckPlugin` file on Windows:

```powershell
npm ci
npm run pack
```

`pack` builds the JavaScript, copies both `koffi` and its Windows x64 native binary into the plugin, validates the manifest and assets, then writes the installer under `dist/`. The compiled plugin includes all UI and icons. Run `npm run generate:icons` only when changing the original vector artwork in `scripts/generate-icons.mjs`; generated images are committed.

## Diagnostics

With OpenKneeboard running, the built `bin/smoke.js` sends a tab-switch packet:

```powershell
$plugin = Get-ChildItem -Directory -Filter '*.sdPlugin' | Select-Object -First 1
node (Join-Path $plugin.FullName 'bin/smoke.js') AMS2
```

Replace `AMS2` with an existing tab title. If OpenKneeboard is closed, the smoke test should fail. Logs from the installed plugin live in its `logs/` folder under `%APPDATA%\Elgato\StreamDeck\Plugins\`.

## Source layout

- `src/protocol.ts`, `placement.ts`, `dispatch.ts`, `pages.ts`: pure logic tested on Linux and Windows.
- `src/runtime/`: Stream Deck actions, the mailslot sender, and process state.
- `*.sdPlugin/manifest.json`, `ui/`, `imgs/`: the installable plugin's metadata, offline settings UI, and original bundled artwork.
- `scripts/generate-icons.mjs`: reproducible source for every manifest image; no third-party art is required.
