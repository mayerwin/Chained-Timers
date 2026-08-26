# =====================================================================
# Build the app from source and launch it on an Android emulator.
#
# The one-command version of the loop used while developing:
#   1. npm run cap:sync      — build web assets, copy into the Android project
#   2. gradlew assembleDebug — compile the debug APK (sideload-signed)
#   3. start an emulator     — reuses a running one, else boots an AVD
#   4. adb install -r + launch, and grant POST_NOTIFICATIONS so the
#      first run isn't blocked by the permission dialog
#
# Usage:
#   .\LAUNCH.ps1                    # build, boot if needed, install, run
#   .\LAUNCH.ps1 -Avd my_avd        # pick a specific AVD
#   .\LAUNCH.ps1 -SkipBuild         # install whatever APK is already built
#   .\LAUNCH.ps1 -ColdBoot          # ignore the saved snapshot
#   .\LAUNCH.ps1 -Devtools          # also forward the WebView to :9222
#
# Notes:
#   - Debug builds are signed with the COMMITTED sideload keystore, so no
#     secrets/ setup is needed. This never touches Play.
#   - The emulator is deliberately started WITH audio. Passing -no-audio
#     silences every app on the device, which reads as "the app's sounds
#     are broken" when it is really the emulator.
# =====================================================================

param(
    [string]$Avd,
    [switch]$SkipBuild,
    [switch]$ColdBoot,
    [switch]$Devtools
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')
. (Join-Path $here '_resolve-jdk.ps1')

$APP_ID   = 'com.github.chainedtimers'
$ACTIVITY = "$APP_ID/.MainActivity"

Write-Host ''
Write-Host '=== Launch Chained Timers on an emulator ===' -ForegroundColor Cyan
Write-Host ''

# --- Toolchain -------------------------------------------------------
$jdk = Resolve-Jdk
$sdk = Resolve-AndroidSdk
$env:JAVA_HOME        = $jdk
$env:Path             = "$jdk\bin;$env:Path"
$env:ANDROID_HOME     = $sdk
$env:ANDROID_SDK_ROOT = $sdk
Write-Host "JDK         : $jdk"
Write-Host "Android SDK : $sdk"

$adb      = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
if (-not (Test-Path $adb))      { throw "adb not found at $adb" }
if (-not (Test-Path $emulator)) { throw "emulator not found at $emulator - install it via Android Studio > SDK Manager > SDK Tools > Android Emulator" }

# --- 1 + 2: build ----------------------------------------------------
if ($SkipBuild) {
    Write-Host ''
    Write-Host 'Skipping build (-SkipBuild).' -ForegroundColor Yellow
} else {
    Write-Host ''
    Write-Host 'Building web assets and syncing Capacitor...' -ForegroundColor Cyan
    Push-Location $repo
    try {
        # npm writes progress to stderr; don't let that read as failure.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        # Invoke through cmd.exe: calling `npm` directly hits npm.ps1,
        # whose argument forwarding mangles the sub-command in Windows
        # PowerShell 5.1 (it reports: Unknown command: "pm").
        & cmd.exe /c "npm run cap:sync"
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) { throw "npm run cap:sync failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }

    Write-Host ''
    Write-Host 'Compiling debug APK (gradlew assembleDebug)...' -ForegroundColor Cyan
    Push-Location (Join-Path $repo 'android')
    try {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & .\gradlew.bat assembleDebug --console=plain
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) { throw "gradlew assembleDebug failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
}

$apk = Join-Path $repo 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apk)) { throw "APK not found at $apk - run without -SkipBuild." }
# Gradle reports success even when it had nothing to do, so say plainly
# how old this artifact is rather than letting a stale APK install
# silently.
$apkAgeMin = [math]::Round(((Get-Date) - (Get-Item $apk).LastWriteTime).TotalMinutes)
Write-Host ("APK         : {0} (built {1} min ago)" -f $apk, $apkAgeMin)

# --- 3: emulator -----------------------------------------------------
function Get-OnlineDevice {
    $lines = & $adb devices 2>$null
    foreach ($l in $lines) {
        if ($l -match '^(\S+)\s+device$') { return $Matches[1] }
    }
    return $null
}

$device = Get-OnlineDevice
if ($device) {
    Write-Host ''
    Write-Host "Reusing running device: $device" -ForegroundColor Green
} else {
    if (-not $Avd) {
        $avds = @(& $emulator -list-avds 2>$null | Where-Object { $_ -and $_.Trim() })
        if ($avds.Count -eq 0) {
            throw 'No AVD found. Create one in Android Studio > Device Manager, then re-run (or pass -Avd <name>).'
        }
        $Avd = $avds[0].Trim()
        if ($avds.Count -gt 1) {
            $others = ($avds | Select-Object -Skip 1) -join ', '
            Write-Host ("Multiple AVDs found; using '{0}'. Others: {1}" -f $Avd, $others) -ForegroundColor Yellow
        }
    }
    Write-Host ''
    Write-Host "Booting emulator '$Avd' (audio enabled)..." -ForegroundColor Cyan
    $emuArgs = @('-avd', $Avd, '-no-boot-anim')
    if ($ColdBoot) { $emuArgs += '-no-snapshot-load' }
    Start-Process -FilePath $emulator -ArgumentList $emuArgs -WindowStyle Minimized | Out-Null

    Write-Host 'Waiting for boot to complete (this can take a minute)...'
    & $adb wait-for-device | Out-Null
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        $booted = (& $adb shell getprop sys.boot_completed 2>$null | Out-String).Trim()
        if ($booted -eq '1') { break }
        Start-Sleep -Seconds 3
    }
    if ((Get-Date) -ge $deadline) { throw 'Emulator did not finish booting within 5 minutes.' }
    $device = Get-OnlineDevice
    Write-Host "Emulator ready: $device" -ForegroundColor Green
    Start-Sleep -Seconds 3   # let the launcher settle before installing
}

# --- 4: install + run ------------------------------------------------
Write-Host ''
Write-Host 'Installing APK...' -ForegroundColor Cyan
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $adb install -r "$apk"
$installExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($installExit -ne 0) {
    Write-Host 'Install failed - retrying after uninstall (signature or downgrade clash).' -ForegroundColor Yellow
    & $adb uninstall $APP_ID | Out-Null
    & $adb install "$apk"
    if ($LASTEXITCODE -ne 0) { throw "adb install failed (exit $LASTEXITCODE)" }
}

# Pre-grant notifications so the first launch isn't covered by the
# permission dialog (the app needs it for the foreground-service timer).
& $adb shell pm grant $APP_ID android.permission.POST_NOTIFICATIONS 2>$null | Out-Null

Write-Host 'Launching...' -ForegroundColor Cyan
& $adb shell am force-stop $APP_ID | Out-Null
& $adb shell am start -n $ACTIVITY | Out-Null

if ($Devtools) {
    Start-Sleep -Seconds 5
    $appPid = (& $adb shell pidof $APP_ID | Out-String).Trim()
    if ($appPid) {
        & $adb forward --remove-all 2>$null | Out-Null
        & $adb forward tcp:9222 "localabstract:webview_devtools_remote_$appPid" | Out-Null
        Write-Host ''
        Write-Host 'DevTools: open  chrome://inspect  (or http://localhost:9222/json/list)' -ForegroundColor Green
    } else {
        Write-Host 'Could not find the app process for DevTools forwarding.' -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host 'Done - the app is running on the emulator.' -ForegroundColor Green
Write-Host ''
