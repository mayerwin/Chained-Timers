@echo off
rem One-time: generate the Play Store upload keystore.
rem See 1-generate-upload-keystore.ps1 for the actual logic.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp01-generate-upload-keystore.ps1"
echo.
pause
