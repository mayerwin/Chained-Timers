# =====================================================================
# Print the SHA-1 / SHA-256 fingerprints of both signing keys.
#
# Use the SHA-256 of upload.keystore in:
#   - Play Console → "App signing" → "Upload key certificate"
#
# Use the SHA-256 of sideload.keystore for:
#   - The release notes on the GitHub Releases page (so users can verify
#     the APK before sideloading)
#   - Anywhere else you want to vouch for "this APK is genuinely mine"
#
# Reads the upload-key password from android\keystore.properties (which
# 1-generate-upload-keystore.ps1 wrote). The sideload-key password is the
# committed plaintext "sideload" — that's intentional, see android\app\
# build.gradle for the rationale.
# =====================================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')

. (Join-Path $here '_resolve-jdk.ps1')
$keytool = Join-Path (Resolve-Jdk) 'bin\keytool.exe'

function Show-Fingerprint([string]$label, [string]$keystore, [string]$alias, [string]$password) {
    Write-Host ''
    Write-Host "=== $label ===" -ForegroundColor Cyan
    Write-Host "  $keystore"
    if (-not (Test-Path $keystore)) {
        Write-Host '  (not found)' -ForegroundColor Yellow
        return
    }
    $env:CT_FP_PW = $password
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

# Upload key — read password from keystore.properties.
$uploadKs    = Join-Path $repo 'upload.keystore'
$uploadProps = Join-Path $repo 'android\keystore.properties'
if (Test-Path $uploadProps) {
    $kvs = @{}
    Get-Content $uploadProps | Where-Object { $_ -match '^\s*[^#].*?=' } | ForEach-Object {
        $k, $v = $_ -split '=', 2
        $kvs[$k.Trim()] = $v.Trim()
    }
    Show-Fingerprint -label 'PLAY STORE UPLOAD KEY (upload.keystore)' `
                      -keystore $uploadKs `
                      -alias    $kvs['keyAlias'] `
                      -password $kvs['storePassword']
} else {
    Write-Host ''
    Write-Host 'PLAY STORE UPLOAD KEY: not yet generated.' -ForegroundColor Yellow
    Write-Host '  Run publishing\android\1-generate-upload-keystore.bat first.'
}

# Sideload key — committed plaintext password.
Show-Fingerprint -label 'SIDELOAD KEY (sideload.keystore — public)' `
                  -keystore (Join-Path $repo 'android\sideload.keystore') `
                  -alias    'chainedtimers' `
                  -password 'sideload'

Write-Host ''
