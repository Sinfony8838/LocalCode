@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" %*
if errorlevel 1 (
  echo Setup failed. See the message above.
  pause
  exit /b 1
)
echo Setup completed. Double-click Start.cmd to open LocalCode.
pause
