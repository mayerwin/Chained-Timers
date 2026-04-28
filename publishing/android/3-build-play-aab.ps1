# =====================================================================
# Build the Play Store AAB.
#
# Outputs:  android\app\build\outputs\bundle\release\app-release.aab
#
# Steps:
#   1. npm run build:www        (copy index.html, css, js, icons -> dist)
#   2. npx cap sync android     (sync dist + plugins into the Android project)
#   3. android\gradlew.bat bundleRelease   (compile + sign with upload key)
#
# Prerequisites:
#   - publishing\android\1-generate-upload-keystore.bat has been run
#     (creates upload.keystore + android\keystore.properties)
#   - npm + Node are on PATH (any 18+ works, project tested on 22)
#   - Android SDK installed (Android Studio -> SDK Manager). The script
#     points Gradle at it automatically if ANDROID_HOME / ANDROID_SDK_ROOT
#     is set, otherwise falls back to the standard %LOCALAPPDATA% path.
# =====================================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')

Write-Host ''
Write-Host '=== Build Play Store AAB ===' -ForegroundColor Cyan
Write-Host ''

# --- Sanity checks ---
$keystore = Join-Path $repo 'upload.keystore'
$props    = Join-Path $repo 'android\keystore.properties'
if (-not (Test-Path $keystore) -or -not (Test-Path $props)) {
    Write-Host 'Upload keystore not found.' -ForegroundColor Red
    Write-Host 'Run this first:'
    Write-Host '  publishing\android\1-generate-upload-keystore.bat'
    exit 1
}

. (Join-Path $here '_resolve-jdk.ps1')
$jdk = Resolve-Jdk
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
Write-Host "Using JDK: $jdk"

# Resolve Android SDK.
$sdkCandidates = @(
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT,
    "$env:LOCALAPPDATA\Android\Sdk",
    "$env:ProgramFiles\Android\Sdk"
) | Where-Object { $_ -and (Test-Path "$_\platform-tools") }

if (-not $sdkCandidates) {
    Write-Host ''
    Write-Host 'Android SDK not found.' -ForegroundColor Red
    Write-Host 'Install via Android Studio (Tools > SDK Manager) or set'
    Write-Host 'ANDROID_HOME to your SDK folder, then re-run.'
    exit 1
}
$sdk = $sdkCandidates | Select-Object -First 1
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk
Write-Host "Using Android SDK: $sdk"
Write-Host ''

# --- Step 1+2: build web assets + cap sync ---
Push-Location $repo
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host 'Installing npm dependencies (one-time)...' -ForegroundColor Cyan
        & npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }

    Write-Host 'Building web assets and syncing Capacitor...' -ForegroundColor Cyan
    & npm run cap:sync
    if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }

    # --- Step 3: gradle bundleRelease ---
    Write-Host ''
    Write-Host 'Building signed AAB (gradle bundleRelease)...' -ForegroundColor Cyan
    Write-Host '(first run takes 1-3 min; subsequent runs are under 30s)'
    Write-Host ''

    Push-Location (Join-Path $repo 'android')
    try {
        & .\gradlew.bat bundleRelease --console=plain
        if ($LASTEXITCODE -ne 0) { throw "gradle bundleRelease failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}
finally { Pop-Location }

$aab = Join-Path $repo 'android\app\build\outputs\bundle\release\app-release.aab'
if (-not (Test-Path $aab)) {
    Write-Host ''
    Write-Host 'Build finished but the AAB was not where expected:' -ForegroundColor Red
    Write-Host "  $aab"
    exit 1
}

$size = [math]::Round((Get-Item $aab).Length / 1KB, 1)
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  AAB    : $aab"
Write-Host "  Size   : $size KB"
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Open https://play.google.com/console'
Write-Host '  2. Production > Create new release > Upload the .aab above'
Write-Host '  3. Paste the release notes from publishing\android\store-listing.md'
Write-Host '  4. (First time only) Permission declarations:'
Write-Host '     publishing\android\permissions-declaration.md'
Write-Host ''
