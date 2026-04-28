# =====================================================================
# Generate the Play Store upload keystore (one-time setup).
#
# Run this ONCE before submitting the first build to Google Play.
# Creates two files in publishing/android/:
#
#   upload.keystore         -- the actual private key
#   keystore.properties     -- password + alias for Gradle
#
# Both files are gitignored. If you lose them, Google Play has a key-reset
# process but it's slow -- back them up to a password manager / encrypted
# vault BEFORE you forget.
#
# Distinguished Name uses the Play-Console-friendly convention:
#   CN=<your name>, O=<your name>, L=<city>, C=FR
# Edit $dn below if you want a different identity on the certificate.
# Google identifies the key by its SHA-256 fingerprint, not the DN, so
# this is only what shows up if anyone inspects the certificate.
# =====================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$keystore = Join-Path $here 'upload.keystore'
$props    = Join-Path $here 'keystore.properties'

. (Join-Path $here '_resolve-jdk.ps1')

Write-Host ''
Write-Host '=== Chained Timers -- Play Store upload keystore ===' -ForegroundColor Cyan
Write-Host ''

if (Test-Path $keystore) {
    Write-Host "upload.keystore already exists at:" -ForegroundColor Yellow
    Write-Host "  $keystore"
    Write-Host ''
    Write-Host "Refusing to overwrite. If you really want to regenerate," -ForegroundColor Yellow
    Write-Host "delete that file (and keystore.properties next to it)" -ForegroundColor Yellow
    Write-Host "manually first -- but be aware that any Play Store listing" -ForegroundColor Yellow
    Write-Host "already signed with the existing key will be locked out of" -ForegroundColor Yellow
    Write-Host "updates without going through Google's key-reset process." -ForegroundColor Yellow
    exit 1
}

$jdk = Resolve-Jdk
$keytool = Join-Path $jdk 'bin\keytool.exe'
Write-Host "Using JDK: $jdk"
Write-Host ''

# Edit this DN if you want a different identity on the cert.
$dn = 'CN=Erwin Mayer, O=Erwin Mayer, L=Menoncourt, C=FR'

Write-Host 'You will now be prompted for a password to protect the key.'
Write-Host 'Choose something STRONG and SAVE IT -- Google cannot recover it for you.'
Write-Host ''

$pw1 = Read-Host 'Choose a password' -AsSecureString
$pw2 = Read-Host 'Re-enter password' -AsSecureString

$plain1 = [System.Net.NetworkCredential]::new('', $pw1).Password
$plain2 = [System.Net.NetworkCredential]::new('', $pw2).Password

if ($plain1 -ne $plain2) {
    Write-Host ''
    Write-Host 'Passwords do not match. Aborting.' -ForegroundColor Red
    exit 1
}
if ($plain1.Length -lt 8) {
    Write-Host ''
    Write-Host 'Password must be at least 8 characters. Aborting.' -ForegroundColor Red
    exit 1
}

# Pass passwords to keytool via environment variables (-storepass:env / -keypass:env)
# instead of command-line flags so they don't leak into the process list or
# Windows event logs.
$env:CT_KEYSTORE_PW = $plain1

try {
    Write-Host ''
    Write-Host 'Generating 2048-bit RSA key (this is fast)...'
    & $keytool -genkey -v `
        -keystore $keystore `
        -alias chainedtimers-upload `
        -keyalg RSA -keysize 2048 -validity 30000 `
        -dname $dn `
        -storepass:env CT_KEYSTORE_PW `
        -keypass:env  CT_KEYSTORE_PW
    if ($LASTEXITCODE -ne 0) { throw "keytool failed with exit code $LASTEXITCODE" }

    # Write keystore.properties with the password embedded. The file is
    # gitignored; for a more locked-down setup, replace these literals
    # with environment-variable expansion in build.gradle.
    #
    # storeFile is just a filename -- Gradle joins it with the directory
    # holding this properties file (publishing/android/) to find the
    # actual keystore.
    $propsContent = @"
# Play Store upload keystore -- DO NOT COMMIT (gitignored).
# Read by android/app/build.gradle to sign release AABs.
storeFile=upload.keystore
storePassword=$plain1
keyAlias=chainedtimers-upload
keyPassword=$plain1
"@
    [IO.File]::WriteAllText($props, $propsContent, [Text.UTF8Encoding]::new($false))

    Write-Host ''
    Write-Host 'Done.' -ForegroundColor Green
    Write-Host "  Keystore : $keystore"
    Write-Host "  Settings : $props"
    Write-Host ''
    Write-Host 'BACK UP NOW:' -ForegroundColor Yellow
    Write-Host '  1. Copy upload.keystore to a password manager / encrypted vault.'
    Write-Host '  2. Save the password you just typed in the same place.'
    Write-Host '  3. (Optional) email a copy to yourself.'
    Write-Host ''
    Write-Host 'To see the SHA-1 / SHA-256 fingerprints Google Play asks for, run:'
    Write-Host '  publishing\android\2-show-fingerprints.bat'
    Write-Host ''
    Write-Host 'To build the AAB for upload, run:'
    Write-Host '  publishing\android\3-build-play-aab.bat'
    Write-Host ''
}
finally {
    $env:CT_KEYSTORE_PW = $null
    Remove-Item Env:\CT_KEYSTORE_PW -ErrorAction SilentlyContinue
    $plain1 = $null
    $plain2 = $null
}
