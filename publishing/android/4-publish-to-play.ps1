# =====================================================================
# Build + upload the Play Store AAB to a chosen Google Play track.
#
# This is a thin wrapper on top of 3-build-play-aab.ps1: that script
# handles the npm cap:sync + signed `gradlew bundleRelease` + AAB-staging
# steps; we run those as-is, then run `gradlew publishBundle` (added by
# the gradle-play-publisher plugin) which uploads the already-built AAB
# to Play Console and creates a release on the chosen track.
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
#   2. The first AAB has been uploaded to Play Console MANUALLY (Play
#      Console requires this before it accepts API uploads -- they call
#      it "claim the listing").
#   3. A Google Cloud service account exists, granted "Release manager"
#      access to this app in Play Console -> Setup -> API access. The
#      JSON key is saved at:
#        publishing\android\secrets\play-service-account.json
#      (gitignored alongside upload.keystore + keystore.properties).
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

# --- Sanity checks specific to the publish step ---
# (3-build-play-aab.ps1 will run its own keystore checks; we only
# need to add the service-account + release-notes check here.)
$secretsDir     = Join-Path $here 'secrets'
$serviceAccount = Join-Path $secretsDir 'play-service-account.json'
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
    Write-Host "Release notes file missing -- Play Console requires per-release notes:" -ForegroundColor Red
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

# --- Step 1: build the AAB by delegating to 3-build-play-aab.ps1 ---
# That script does the full env setup (JDK, SDK, npm cap:sync) and runs
# `gradlew bundleRelease`. We re-run the env setup ourselves below so the
# `gradlew publishBundle` invocation in step 2 can find the same JDK
# (PowerShell child-script env doesn't propagate back to the parent).
$buildScript = Join-Path $here '3-build-play-aab.ps1'
& $buildScript
if ($LASTEXITCODE -ne 0) {
    Write-Host '3-build-play-aab.ps1 failed; aborting upload.' -ForegroundColor Red
    exit $LASTEXITCODE
}

# --- Step 2: upload the AAB via gradle-play-publisher ---
# `publishBundle` depends on `bundleRelease` which step 1 just ran, so
# Gradle marks it UP-TO-DATE and the task only runs the upload itself.
. (Join-Path $here '_resolve-jdk.ps1')
$jdk = Resolve-Jdk
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$sdk = Resolve-AndroidSdk
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$env:PLAY_TRACK          = $track
$env:PLAY_RELEASE_STATUS = $status.ToUpper()

Write-Host ''
Write-Host 'Uploading AAB to Play Console (gradle publishBundle)...' -ForegroundColor Cyan
Write-Host ''

Push-Location (Join-Path $repo 'android')
try {
    & .\gradlew.bat publishBundle --console=plain
    if ($LASTEXITCODE -ne 0) { throw "gradle publishBundle failed (exit $LASTEXITCODE)" }
}
finally { Pop-Location }

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Uploaded to track : $track"
Write-Host "  Status            : $status"
Write-Host ''
if ($status -eq 'draft') {
    Write-Host 'Release is in DRAFT -- open Play Console to submit it for review.'
} elseif ($track -eq 'internal') {
    Write-Host 'Internal testers will see the new version in their app within ~minutes.'
} elseif ($track -eq 'production') {
    Write-Host 'Production rollout submitted. Review typically completes within ~2 days.'
} else {
    Write-Host "Released to track: $track. Open Play Console to verify."
}
Write-Host ''
