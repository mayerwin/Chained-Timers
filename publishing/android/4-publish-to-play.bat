@echo off
rem Build + upload the signed AAB to Play Console via the Google Play
rem Developer API. See 4-publish-to-play.ps1 for the actual logic and
rem publishing/android/README.md §"Automated publish" for the one-time
rem service-account setup.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp04-publish-to-play.ps1"
echo.
pause
