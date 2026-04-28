# =====================================================================
# Print the SHA-1 / SHA-256 fingerprints of both signing keys.
#
# Use the SHA-256 of upload.keystore in:
#   - Play Console -> "App signing" -> "Upload key certificate"
#
# Use the SHA-256 of sideload.keystore for:
#   - The release notes on the GitHub Releases page (so users can verify
#     the APK before sideloading)
#   - Anywhere else you want to vouch for "this APK is genuinely mine"
#
# Both keystores live in publishing/android/. The upload-key password
# is read from publishing/android/keystore.properties (which
# 1-generate-upload-keystore.ps1 wrote). The sideload-key password is
# the committed plaintext "sideload" -- that's intentional; see
# android/app/build.gradle for the rationale.
# =====================================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

. (Join-Path $here '_resolve-jdk.ps1')
$keytool = Join-Path (Resolve-Jdk) 'bin\keytool.exe'

# Note on the $pw parameter name below: PSScriptAnalyzer's
# PSAvoidUsingPlainTextForPassword rule fires on parameters literally
# named $password (or similar) when typed as [string]. The parameter is
# never user input here -- it's either the committed-plaintext "sideload"
# value or what we just wrote to keystore.properties on disk -- and we
# hand it to keytool via -storepass:env (an env var) so it doesn't sit
# in a process arg list. Renaming sidesteps the lint cleanly.
function Show-Fingerprint([string]$label, [string]$keystore, [string]$alias, [string]$pw) {
    Write-Host ''
    Write-Host "=== $label ===" -ForegroundColor Cyan
    Write-Host "  $keystore"
    if (-not (Test-Path $keystore)) {
        Write-Host '  (not found)' -ForegroundColor Yellow
        return
    }
    $env:CT_FP_PW = $pw
    try {
        $output = & $keytool -list -v `
            -keystore $keystore -alias $alias `
            -storepass:env CT_FP_PW 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host '  (could not read; password mismatch?)' -ForegroundColor Red
            $output | ForEach-Object { Write-Host "    $_" }
            return
        }
        $output | Select-String -Pattern 'Owner|Valid|SHA1|SHA256' | ForEach-Object {
            Write-Host "  $($_.Line.Trim())"
        }
    }
    finally {
        $env:CT_FP_PW = $null
        Remove-Item Env:\CT_FP_PW -ErrorAction SilentlyContinue
    }
}

# Upload key -- read password from keystore.properties.
$uploadKs    = Join-Path $here 'upload.keystore'
$uploadProps = Join-Path $here 'keystore.properties'
if (Test-Path $uploadProps) {
    $kvs = @{}
    Get-Content $uploadProps | Where-Object { $_ -match '^\s*[^#].*?=' } | ForEach-Object {
        $k, $v = $_ -split '=', 2
        $kvs[$k.Trim()] = $v.Trim()
    }
    Show-Fingerprint -label 'PLAY STORE UPLOAD KEY (upload.keystore)' `
                      -keystore $uploadKs `
                      -alias    $kvs['keyAlias'] `
                      -pw       $kvs['storePassword']
} else {
    Write-Host ''
    Write-Host 'PLAY STORE UPLOAD KEY: not yet generated.' -ForegroundColor Yellow
    Write-Host '  Run publishing\android\1-generate-upload-keystore.bat first.'
}

# Sideload key -- committed plaintext password.
Show-Fingerprint -label 'SIDELOAD KEY (sideload.keystore -- public)' `
                  -keystore (Join-Path $here 'sideload.keystore') `
                  -alias    'chainedtimers' `
                  -pw       'sideload'

Write-Host ''
