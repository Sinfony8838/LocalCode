@echo off
setlocal
set "LOCALCODE_HOME=%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "LOCALCODE_RELEASE="
if exist "%LOCALCODE_HOME%app\current.txt" set /p "LOCALCODE_RELEASE="<"%LOCALCODE_HOME%app\current.txt"
if not defined LOCALCODE_RELEASE set "LOCALCODE_RELEASE=LocalCode-win32-x64"
set "LOCALCODE_EXECUTABLE=%LOCALCODE_HOME%app\%LOCALCODE_RELEASE%\LocalCode.exe"
if not exist "%LOCALCODE_EXECUTABLE%" goto missing
start "" "%LOCALCODE_EXECUTABLE%"
exit /b 0
:missing
echo LocalCode.exe was not found. See README.md for build instructions.
pause
exit /b 1
