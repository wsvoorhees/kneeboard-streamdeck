<#
Build and install Kneeboard-Streamdeck for Stream Deck on Windows.
Use -StageOnly to build while Stream Deck is running, then quit it and use
-UseStagedBuild to install without rebuilding.
Refuses to install over a newer installed version; -AllowDowngrade goes back on purpose.
Moves aside the plugin's pre-0.5 install (com.willvoorhees.openkneeboard-configurator), so
Stream Deck does not load both.
#>
[CmdletBinding()]
param(
  [string] $SourceDir = $PSScriptRoot,
  [string] $BuildDir = "$env:LOCALAPPDATA\KneeboardStreamdeck\build",
  [switch] $Copy,
  [switch] $StageOnly,
  [switch] $UseStagedBuild,
  [switch] $AllowDowngrade
)

$ErrorActionPreference = 'Stop'
$PluginId = 'com.willvoorhees.kneeboard-streamdeck'
$PluginDir = "$PluginId.sdPlugin"
# The ID before 0.5.0, when the plugin was called OpenKneeboard Configurator.
$LegacyPluginDir = 'com.willvoorhees.openkneeboard-configurator.sdPlugin'
$Plugins = Join-Path $env:APPDATA 'Elgato\StreamDeck\Plugins'

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
  throw 'Build and installation require Windows PowerShell or PowerShell on Windows.'
}
if ($StageOnly -and $UseStagedBuild) { throw 'Choose either -StageOnly or -UseStagedBuild.' }

# Never install over a NEWER build: on 2026-10-09 an older checkout's 0.3.0.0 silently replaced an
# installed 0.4.0.0. Checked before building, against whichever tree is about to be installed.
if (-not $StageOnly -and -not $AllowDowngrade) {
  $from = if ($UseStagedBuild) { $BuildDir } elseif ($SourceDir) { $SourceDir } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $building = [version](Get-Content (Join-Path $from "$PluginDir\manifest.json") -Raw | ConvertFrom-Json).Version
  $installedManifest = Join-Path $Plugins "$PluginDir\manifest.json"
  if (Test-Path $installedManifest) {
    $installed = [version](Get-Content $installedManifest -Raw | ConvertFrom-Json).Version
    if ($installed -gt $building) {
      throw "Stream Deck has $PluginId $installed, newer than this tree's $building. Install from the newer tree, or re-run with -AllowDowngrade if you mean to go back."
    }
  }
}
if (-not $UseStagedBuild) {
  if (-not $SourceDir) { $SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $SourceDir = (Resolve-Path $SourceDir).Path
  New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
  foreach ($item in @('src', 'scripts', 'tsconfig.json', 'rollup.config.ts', 'package.json', 'package-lock.json', $PluginDir)) {
    $from = Join-Path $SourceDir $item
    if (-not (Test-Path $from)) { throw "Missing from source tree: $item" }
    $to = Join-Path $BuildDir $item
    if (Test-Path $to) { Remove-Item -Recurse -Force $to }
    Copy-Item -Recurse -Force -Path $from -Destination $to
  }

  Push-Location $BuildDir
  try {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
    & npm run validate
    if ($LASTEXITCODE -ne 0) { throw "Stream Deck validation failed ($LASTEXITCODE)" }
    & npm run bundle:runtime
    if ($LASTEXITCODE -ne 0) { throw "runtime bundling failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}

$built = Join-Path $BuildDir "$PluginDir\bin\plugin.js"
$native = Join-Path $BuildDir "$PluginDir\node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node"
if (-not (Test-Path $built) -or -not (Test-Path $native)) { throw 'Staged build is missing plugin.js or the Windows native binary.' }
if ($StageOnly) { Write-Host "Staged plugin at $BuildDir"; return }
if (Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue) {
  throw 'Quit Stream Deck from the tray before installing; its native koffi file is locked while running.'
}

# Renamed, not deleted: its logs/ folder is the only record of what the old plugin did, and the
# suffix stops Stream Deck loading it (it loads folders ending in .sdPlugin).
$legacy = Join-Path $Plugins $LegacyPluginDir
if (Test-Path $legacy) {
  $retired = "$legacy.retired-$(Get-Date -Format 'yyyyMMddTHHmmss')"
  Move-Item $legacy $retired
  Write-Host "Moved the pre-0.5 plugin aside to $retired; profile keys that used it need replacing"
}

$target = Join-Path $Plugins $PluginDir
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
if ($Copy) {
  Copy-Item -Recurse -Force (Join-Path $BuildDir $PluginDir) $target
  Write-Host "Copied plugin to $target"
} else {
  New-Item -ItemType SymbolicLink -Path $target -Target (Join-Path $BuildDir $PluginDir) | Out-Null
  Write-Host "Linked plugin at $target"
}
Write-Host "Smoke test: node `"$BuildDir\$PluginDir\bin\smoke.js`" AMS2"
