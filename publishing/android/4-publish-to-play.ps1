# =====================================================================
# Build + upload the Play Store AAB to a chosen Google Play track.
#
# What it does:
#   1. npm run cap:sync          (build web assets + sync into android/)
#   2. gradlew bundleRelease     (compile the signed AAB)
#   3. gradlew publishBundle     (upload to Play Console + create release)
#
# Track defaults to `internal` for safety. Override:
#   $env:PLAY_TRACK = 'production'
#   .\publishing\android\4-publish-to-play.ps1
#
# Status defaults to `completed` (full rollout). Override to land the
# release in Play Console as a draft you can submit manually:
#   $env:PLAY_RELEASE_STATUS = 'draft'
#
# Prerequisites (one-time, see publishing/android/README.md §"Automated
# publish" for the full walkthrough):
#   1. publishing\android\1-generate-upload-keystore.bat has been run.
#   2. The first AAB has been uploaded to Play Console MANUALLY (the
#      Play Console requires a manual first upload before it will accept
#      API uploads — they call this "claim the listing").
#   3. A Google Cloud service account exists with role "Service Account
#      User", and is granted "Release manager" access to this app in
#      Play Console → Setup → API access. The JSON key is saved at
#      publishing\android\play-service-account.json (gitignored).
#   4. Each publish requires versionCode in android/app/build.gradle to
#      be HIGHER than the last uploaded version, otherwise the API
#      rejects it.
#
# Release notes are read from
#   android/app/src/main/play/release-notes/en-US/default.txt
# Update before running.
# =====================================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')

Write-Host ''
Write-Host '=== Publish to Google Play ===' -ForegroundColor Cyan
Write-Host ''

# --- Sanity checks ---
$keystore       = Join-Path $here 'upload.keystore'
$props          = Join-Path $here 'keystore.properties'
$serviceAccount = Join-Path $here 'play-service-account.json'

if (-not (Test-Path $keystore) -or -not (Test-Path $props)) {
    Write-Host 'Upload keystore not found in publishing\android\.' -ForegroundColor Red
    Write-Host 'Run this first:'
    Write-Host '  publishing\android\1-generate-upload-keystore.bat'
    exit 1
}

if (-not (Test-Path $serviceAccount)) {
    Write-Host 'Play service-account JSON not found:' -ForegroundColor Red
    Write-Host "  $serviceAccount"
    Write-Host ''
    Write-Host 'See publishing\android\README.md §"Automated publish" for the'
    Write-Host 'one-time setup (Google Cloud service account + Play Console grant).'
    exit 1
}

$track = if ($env:PLAY_TRACK) { $env:PLAY_TRACK } else { 'internal' }
$status = if ($env:PLAY_RELEASE_STATUS) { $env:PLAY_RELEASE_STATUS } else { 'completed' }
Write-Host "Track          : $track"
Write-Host "Release status : $status"

$notesFile = Join-Path $repo 'android\app\src\main\play\release-notes\en-US\default.txt'
if (-not (Test-Path $notesFile)) {
    Write-Host ''
    Write-Host "Release notes file missing — Play Console requires per-release notes:" -ForegroundColor Red
    Write-Host "  $notesFile"
    Write-Host 'Create it with the human-readable changelog for this version.'
    exit 1
}
$noteSize = (Get-Item $notesFile).Length
if ($noteSize -lt 1) {
    Write-Host "Release notes file is empty: $notesFile" -ForegroundColor Red
    exit 1
}
Write-Host "Release notes  : $notesFile ($noteSize bytes)"
Write-Host ''

# --- Resolve toolchain ---
. (Join-Path $here '_resolve-jdk.ps1')
$jdk = Resolve-Jdk
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
Write-Host "Using JDK: $jdk"

$sdk = Resolve-AndroidSdk
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk
Write-Host "Using Android SDK: $sdk"
Write-Host ''

# Resolve npm (see 3-build-play-aab.ps1 for why we use npm.cmd directly).
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) {
    Write-Host 'npm.cmd not found on PATH.' -ForegroundColor Red
    Write-Host 'Install Node.js (https://nodejs.org) and re-run.'
    exit 1
}

# --- Step 1+2: build web assets + cap sync ---
Push-Location $repo
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host 'Installing npm dependencies (one-time)...' -ForegroundColor Cyan
        & $npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }

    Write-Host 'Building web assets and syncing Capacitor...' -ForegroundColor Cyan
    & $npm run cap:sync
    if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }

    # --- Step 3: gradle bundleRelease + publishBundle ---
    # publishBundle depends on bundleRelease, so a single invocation does
    # both: compiles the signed AAB and uploads it to Play Console.
    Write-Host ''
    Write-Host 'Building + uploading AAB (gradle publishBundle)...' -ForegroundColor Cyan
    Write-Host '(first run takes 1-3 min; subsequent runs are under 30s + upload time)'
    Write-Host ''

    $env:PLAY_TRACK          = $track
    $env:PLAY_RELEASE_STATUS = $status.ToUpper()

    Push-Location (Join-Path $repo 'android')
    try {
        & .\gradlew.bat publishBundle --console=plain
        if ($LASTEXITCODE -ne 0) { throw "gradle publishBundle failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}
finally { Pop-Location }

# Stage a copy of the AAB next to the rest of the publishing material,
# same as 3-build-play-aab.ps1 does — useful for rollback / archival.
$aab = Join-Path $repo 'android\app\build\outputs\bundle\release\app-release.aab'
if (Test-Path $aab) {
    $buildGradle = Join-Path $repo 'android\app\build.gradle'
    $versionName = (Select-String -Path $buildGradle -Pattern '^\s*versionName\s+"([^"]+)"' -List).Matches[0].Groups[1].Value
    if ($versionName) {
        $staged = Join-Path $here "chained-timers-v$versionName-play.aab"
        Copy-Item -Force $aab $staged
        $size = [math]::Round((Get-Item $staged).Length / 1KB, 1)
        Write-Host ''
        Write-Host "Staged AAB     : $staged ($size KB)"
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Uploaded to track : $track"
Write-Host "  Status            : $status"
Write-Host ''
if ($status -eq 'draft') {
    Write-Host 'Release is in DRAFT — open Play Console to submit it for review.'
} elseif ($track -eq 'internal') {
    Write-Host 'Internal testers will see the new version in their app within ~minutes.'
} elseif ($track -eq 'production') {
    Write-Host 'Production rollout submitted. Review typically completes within ~2 days.'
} else {
    Write-Host "Released to track: $track. Open Play Console to verify."
}
Write-Host ''
