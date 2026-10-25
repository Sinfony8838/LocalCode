@echo off
setlocal
set "OLLAMA_HOST=127.0.0.1:11434"
set "USERPROFILE=%~dp0profile"
set "OLLAMA_MODELS=%~dp0models"
set "TEMP=%~dp0temp"
set "TMP=%~dp0temp"
"%~dp0runtime\ollama.exe" %*
exit /b %errorlevel%
