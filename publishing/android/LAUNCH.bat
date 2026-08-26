@echo off
rem Build the app from source and run it on an Android emulator.
rem See LAUNCH.ps1 for the actual logic (and the flags it accepts).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0LAUNCH.ps1" %*
echo.
pause
