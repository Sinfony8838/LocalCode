@echo off
setlocal
chcp 65001 >nul
set "LOCALCODE_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%LOCALCODE_POWERSHELL%" goto missingpowershell
"%LOCALCODE_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"
set "LOCALCODE_EXIT=%errorlevel%"
if not "%LOCALCODE_EXIT%"=="0" if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b %LOCALCODE_EXIT%
:missingpowershell
echo 未找到 Windows PowerShell 5.1，请使用受支持的 Windows x64 系统。 / Windows PowerShell 5.1 was not found. Use a supported Windows x64 system.
if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b 1
