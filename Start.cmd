@echo off
setlocal
set "LOCALCODE_HOME=%~dp0LocalCode"
set "LOCALCODE_OLLAMA_START=%~dp0Ollama\Start.ps1"
set "ELECTRON_RUN_AS_NODE="
call "%~dp0LocalCode\Start.cmd"
exit /b %errorlevel%
