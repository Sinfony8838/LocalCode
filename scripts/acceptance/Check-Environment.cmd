@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0Check-Environment.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b %RESULT%
