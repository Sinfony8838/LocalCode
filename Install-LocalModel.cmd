@echo off
setlocal
rem Explicit opt-in for the prebuilt portable app. Never builds or installs Node.js.
call "%~dp0Setup.cmd" -ModelOnly %*
exit /b %errorlevel%
