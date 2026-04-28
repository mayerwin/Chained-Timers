@echo off
rem Show SHA-1 / SHA-256 fingerprints of both signing keystores.
rem See 2-show-fingerprints.ps1 for the actual logic.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp02-show-fingerprints.ps1"
echo.
pause
