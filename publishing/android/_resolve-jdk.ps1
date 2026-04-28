# Locate a JDK on the host (for keytool / gradle).
#
# Resolution order:
#   1. JAVA_HOME env var (if it points to a real JDK)
#   2. Android Studio's bundled JBR (the one Android dev machines actually have)
#   3. Anything javac/keytool already on PATH
#
# Returns the JAVA_HOME-style root directory (the one containing bin\keytool.exe).
# Throws with a helpful error if nothing is found.

function Resolve-Jdk {
    function Test-JdkRoot([string]$root) {
        return $root -and (Test-Path (Join-Path $root 'bin\keytool.exe'))
    }

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

Set JAVA_HOME to your JDK's root folder (the one containing bin\keytool.exe),
or install Android Studio (its bundled JBR will be picked up automatically).

Tried:
  - JAVA_HOME ($env:JAVA_HOME)
  - Common Android Studio paths
  - keytool on PATH
"@
}
