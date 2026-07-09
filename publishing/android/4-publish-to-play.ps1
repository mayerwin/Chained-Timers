# =====================================================================
# Build + upload the Play Store AAB to all testing tracks.
#
# Default tracks: `internal` (Internal testing) + `alpha` (Closed testing).
# We upload once via `gradlew publishBundle` (configured to the first
# track) and then `gradlew promoteArtifact` copies the same artifact onto
# the remaining tracks. The Play Developer API only accepts one upload
# per versionCode, so multi-publishBundle calls are not an option.
#
# 5-publish-to-play-production.ps1 is a one-line wrapper that adds
# `production` to the list -- use that when you're ready to ship.
#
# Override the track list per invocation:
#   $env:PLAY_TRACKS = 'internal,alpha,beta'      # add Open testing
#   $env:PLAY_TRACKS = 'alpha'                    # closed testing only
#   .\publishing\android\4-publish-to-play.ps1
#
# (`$env:PLAY_TRACK` -- singular -- is still honoured for one-track runs;
# it's what build.gradle reads for the publishBundle target.)
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
#   3. A Google Cloud service account exists with the AndroidPublisher
#      API enabled, invited to your Play Console developer account
#      (Users and permissions -> Invite new users), and granted at
#      minimum "Manage production releases" + "Manage testing track
#      releases" *for this app*. The JSON key is saved at:
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

# Tracks. PLAY_TRACKS (plural, comma-separated) is the new knob; PLAY_TRACK
# (singular) still works for one-track runs and is what build.gradle reads
# for the publishBundle target.
if ($env:PLAY_TRACKS) {
    $tracksRaw = $env:PLAY_TRACKS
} elseif ($env:PLAY_TRACK) {
    $tracksRaw = $env:PLAY_TRACK
} else {
    $tracksRaw = 'internal,alpha'
}
$tracks = @($tracksRaw -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($tracks.Count -eq 0) {
    Write-Host "PLAY_TRACKS is empty after parsing '$tracksRaw'; nothing to do." -ForegroundColor Red
    exit 1
}
$primaryTrack     = $tracks[0]
$additionalTracks = @($tracks | Select-Object -Skip 1)

$status = if ($env:PLAY_RELEASE_STATUS) { $env:PLAY_RELEASE_STATUS } else { 'completed' }
Write-Host "Tracks         : $($tracks -join ', ')"
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

# --- Step 2: upload the AAB via gradle-play-publisher, then promote ---
# `publishBundle` depends on `bundleRelease` which step 1 just ran, so
# Gradle marks it UP-TO-DATE and the task only runs the upload itself.
. (Join-Path $here '_resolve-jdk.ps1')
$jdk = Resolve-Jdk
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$sdk = Resolve-AndroidSdk
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$env:PLAY_TRACK          = $primaryTrack
$env:PLAY_RELEASE_STATUS = $status.ToUpper()

Push-Location (Join-Path $repo 'android')
$prevEAP = $ErrorActionPreference
try {
    Write-Host ''
    Write-Host "Uploading AAB to track '$primaryTrack' (gradle publishBundle)..." -ForegroundColor Cyan
    Write-Host ''
    # Temporarily switch to 'Continue' so native stderr (gradle warnings,
    # deprecation notices, javac unchecked-ops noise) doesn't become a
    # terminating NativeCommandError before we can check $LASTEXITCODE.
    # See the same pattern in 3-build-play-aab.ps1 for the full rationale.
    $ErrorActionPreference = 'Continue'
    & .\gradlew.bat publishBundle --console=plain
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) { throw "gradle publishBundle failed (exit $LASTEXITCODE)" }

    foreach ($track in $additionalTracks) {
        Write-Host ''
        Write-Host "Promoting same artifact to track '$track' (gradle promoteArtifact)..." -ForegroundColor Cyan
        Write-Host ''
        $ErrorActionPreference = 'Continue'
        & .\gradlew.bat promoteArtifact "--from-track=$primaryTrack" "--promote-track=$track" --console=plain
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) { throw "gradle promoteArtifact -> '$track' failed (exit $LASTEXITCODE)" }
    }
}
finally { Pop-Location; $ErrorActionPreference = $prevEAP }

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Tracks  : $($tracks -join ', ')"
Write-Host "  Status  : $status"
Write-Host ''
if ($status -eq 'draft') {
    Write-Host 'Release is in DRAFT -- open Play Console to submit it for review.'
} elseif ($tracks -contains 'production') {
    Write-Host 'Production rollout submitted. Review typically completes within ~2 days.'
} else {
    Write-Host "Released to tracks: $($tracks -join ', '). Testers see the new version within ~minutes."
}
Write-Host ''
