@echo off
setlocal
set "CHECK_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%CHECK_POWERSHELL%" goto missingpowershell
if not exist "%~dp0Check-Environment.ps1" goto missingscript
rem This policy applies only to this child process; no machine/user policy is changed.
"%CHECK_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Check-Environment.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Check failed. Keep this error for the maintainer. Do not change system protection or organization policy.
goto done
:missingpowershell
echo Windows PowerShell 5.1 was not found. Send this message to the maintainer.
set "RESULT=2"
goto done
:missingscript
echo Check-Environment.ps1 is missing. Extract the complete acceptance ZIP and try again.
set "RESULT=2"
:done
if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b %RESULT%
