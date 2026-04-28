@echo off
rem Build the signed AAB for Play Store upload.
rem See 3-build-play-aab.ps1 for the actual logic.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp03-build-play-aab.ps1"
echo.
pause
