# Locate a JDK and Android SDK on the host (for keytool / gradle).
#
# Both functions check, in order:
#   1. publishing\android\local-config.ps1 (gitignored, per-machine)
#   2. The corresponding env var (JAVA_HOME / ANDROID_HOME / ANDROID_SDK_ROOT)
#   3. Conventional install locations (Android Studio bundled JBR /
#      %LOCALAPPDATA%\Android\Sdk)
#   4. Anything on PATH (JDK only — keytool.exe)
#
# They throw with a self-explanatory error message if nothing matches,
# pointing the user at local-config.ps1.example as the canonical fix.

# Lazy load the local-config (idempotent — the variables it sets are
# scoped to the calling scope, so dot-sourcing once is enough). Safe to
# call from any function below.
$script:_localConfigLoaded = $false
function _Load-LocalConfig {
    if ($script:_localConfigLoaded) { return }
    $cfg = Join-Path $PSScriptRoot 'local-config.ps1'
    if (Test-Path $cfg) {
        # Use the script:* scope so $LocalJdkPath / $LocalSdkPath are
        # visible from the resolver functions below.
        . $cfg
        if ($LocalJdkPath) { $script:LocalJdkPath = $LocalJdkPath }
        if ($LocalSdkPath) { $script:LocalSdkPath = $LocalSdkPath }
    }
    $script:_localConfigLoaded = $true
}

function Resolve-Jdk {
    function Test-JdkRoot([string]$root) {
        return $root -and (Test-Path (Join-Path $root 'bin\keytool.exe'))
    }

    _Load-LocalConfig
    if (Test-JdkRoot $script:LocalJdkPath) { return (Resolve-Path $script:LocalJdkPath).Path }

    if (Test-JdkRoot $env:JAVA_HOME) { return (Resolve-Path $env:JAVA_HOME).Path }

    $candidates = @(
        "$env:ProgramFiles\Android\Android Studio\jbr",
        "$env:ProgramFiles\Android\Android Studio\jre",
        "${env:ProgramFiles(x86)}\Android\Android Studio\jbr",
        "${env:ProgramFiles(x86)}\Android\Android Studio\jre",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
        "$env:LOCALAPPDATA\Programs\Android Studio\jre"
    )
    foreach ($c in $candidates) {
        if (Test-JdkRoot $c) { return (Resolve-Path $c).Path }
    }

    # JetBrains Toolbox installs Android Studio under a versioned path.
    foreach ($base in @(
        "$env:LOCALAPPDATA\JetBrains\Toolbox\apps\AndroidStudio",
        "$env:LOCALAPPDATA\JetBrains\Toolbox\apps\android-studio"
    )) {
        if (Test-Path $base) {
            $bundled = Get-ChildItem $base -Recurse -Directory -Depth 4 -Filter 'jbr' -ErrorAction SilentlyContinue |
                       Where-Object { Test-JdkRoot $_.FullName } |
                       Select-Object -First 1
            if ($bundled) { return $bundled.FullName }
        }
    }

    $kt = Get-Command keytool.exe -ErrorAction SilentlyContinue
    if ($kt) { return (Split-Path -Parent (Split-Path -Parent $kt.Source)) }

    throw @"
Could not find a JDK on this machine.

Quick fix: copy publishing\android\local-config.ps1.example to
publishing\android\local-config.ps1 and set `$LocalJdkPath to your JDK
root (the directory that contains bin\keytool.exe).

Or set JAVA_HOME, or install Android Studio (its bundled JBR will be
picked up automatically), or put keytool on PATH.

Tried:
  - publishing\android\local-config.ps1 (`$LocalJdkPath = $script:LocalJdkPath)
  - JAVA_HOME ($env:JAVA_HOME)
  - Common Android Studio paths
  - keytool on PATH
"@
}

function Resolve-AndroidSdk {
    function Test-SdkRoot([string]$root) {
        return $root -and (Test-Path (Join-Path $root 'platform-tools'))
    }

    _Load-LocalConfig
    if (Test-SdkRoot $script:LocalSdkPath) { return (Resolve-Path $script:LocalSdkPath).Path }

    foreach ($v in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)) {
        if (Test-SdkRoot $v) { return (Resolve-Path $v).Path }
    }

    $candidates = @(
        "$env:LOCALAPPDATA\Android\Sdk",
        "$env:ProgramFiles\Android\Sdk",
        "${env:ProgramFiles(x86)}\Android\Sdk"
    )
    foreach ($c in $candidates) {
        if (Test-SdkRoot $c) { return (Resolve-Path $c).Path }
    }

    throw @"
Could not find an Android SDK on this machine.

You need to install one before you can build the AAB:

  Option A (recommended)  Install Android Studio:
                            https://developer.android.com/studio
                          The first launch downloads the SDK to
                          %LOCALAPPDATA%\Android\Sdk and the build
                          script will pick it up automatically.

  Option B (lighter)      Download "command-line tools only" from
                            https://developer.android.com/studio#command-line-tools-only
                          Extract anywhere, then run sdkmanager once
                          to download the platforms / build-tools.

After installing, EITHER:
  - copy publishing\android\local-config.ps1.example to
    publishing\android\local-config.ps1 and set `$LocalSdkPath, OR
  - set ANDROID_HOME to the SDK root.

Tried:
  - publishing\android\local-config.ps1 (`$LocalSdkPath = $script:LocalSdkPath)
  - ANDROID_HOME ($env:ANDROID_HOME)
  - ANDROID_SDK_ROOT ($env:ANDROID_SDK_ROOT)
  - $env:LOCALAPPDATA\Android\Sdk
  - $env:ProgramFiles\Android\Sdk
"@
}
