@echo off
rem Build + upload the signed AAB to ALL tracks, including production.
rem Thin wrapper that calls 4-publish-to-play.ps1 with PLAY_TRACKS set to
rem 'internal,alpha,production'. See 5-publish-to-play-production.ps1 and
rem publishing/android/README.md §"Automated publish" for the one-time
rem service-account setup.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp05-publish-to-play-production.ps1"
echo.
pause
