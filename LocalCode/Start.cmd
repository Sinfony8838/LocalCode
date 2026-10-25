@echo off
setlocal
chcp 65001 >nul
set "LOCALCODE_HOME=%~dp0"
if not defined LOCALCODE_OLLAMA_START set "LOCALCODE_OLLAMA_START=%~dp0..\Ollama\Start.ps1"
set "ELECTRON_RUN_AS_NODE="
set "LOCALCODE_RELEASE="
if exist "%LOCALCODE_HOME%app\current.txt" set /p "LOCALCODE_RELEASE="<"%LOCALCODE_HOME%app\current.txt"
if not defined LOCALCODE_RELEASE set "LOCALCODE_RELEASE=LocalCode-win32-x64"
set "LOCALCODE_EXECUTABLE=%LOCALCODE_HOME%app\%LOCALCODE_RELEASE%\LocalCode.exe"
if not exist "%LOCALCODE_EXECUTABLE%" goto missing
start "" "%LOCALCODE_EXECUTABLE%"
if errorlevel 1 goto failed
exit /b 0
:missing
if exist "%LOCALCODE_HOME%source\package.json" goto missingsource
echo 便携程序文件缺失。请在新目录完整解压应用 ZIP，保留旧目录和数据；无需重新构建。 / Portable app files are missing. Extract the complete app ZIP into a new folder; keep the old folder and data. No source build is needed.
goto error
:missingsource
echo 尚未找到 LocalCode 程序。请完整解压 ZIP，再运行根目录 Setup.cmd，等待安装完成。 / LocalCode is not installed yet. Extract the complete ZIP, then run Setup.cmd in the root folder and wait for it to finish.
echo 只安装桌面、不下载模型：Setup.cmd -BuildOnly / Desktop only, without a model: Setup.cmd -BuildOnly
echo 无需手动安装 Node.js 或 Git。 / No manual Node.js or Git installation is required.
goto error
:failed
echo 启动失败。请确认是 Windows x64，并检查安全软件提示；不要关闭系统防护。 / Launch failed. Check Windows x64 compatibility and security-software notifications; do not disable system protection.
:error
if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b 1
