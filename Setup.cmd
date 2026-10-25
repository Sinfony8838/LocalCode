@echo off
setlocal
chcp 65001 >nul
set "LOCALCODE_PAUSE=1"
for %%A in (%*) do if /I "%%~A"=="-Plan" set "LOCALCODE_PAUSE=0"
set "LOCALCODE_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%LOCALCODE_POWERSHELL%" goto missingpowershell
set "LOCALCODE_MODE="
if not "%~1"=="" goto run
echo.
echo LocalCode 安装 / Setup
echo 1. 本地模型 + 桌面：下载数 GB，建议 25 GiB 空间 / Local model + desktop: several GB download, 25 GiB recommended
echo 2. 仅桌面：稍后连接已有 Ollama 或自选 API，不下载模型 / Desktop only: connect an existing Ollama or your own API later, no model download
echo 3. 退出 / Exit
echo 无需预装 Node.js、Git 或管理员权限，不购买服务，也不会要求输入密钥。 / No manual Node.js, Git or admin rights. No purchases or credentials requested here.
choice /C 123 /N /M "请选择 / Choose [1/2/3]: "
if not errorlevel 1 exit /b 0
if errorlevel 4 exit /b 1
if errorlevel 3 exit /b 0
if errorlevel 2 set "LOCALCODE_MODE=-BuildOnly"
:run
"%LOCALCODE_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" %LOCALCODE_MODE% %*
set "LOCALCODE_EXIT=%errorlevel%"
if not "%LOCALCODE_EXIT%"=="0" echo 安装未完成，请查看上方提示。 / Setup did not finish. Follow the message above.
if "%LOCALCODE_PAUSE%"=="1" if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b %LOCALCODE_EXIT%
:missingpowershell
echo 未找到 Windows PowerShell。请在 Windows x64 上运行并启用 Windows PowerShell 5.1。 / Windows PowerShell was not found. Use Windows x64 with Windows PowerShell 5.1 enabled.
echo 无需手动安装 Node.js 或 Git。 / Node.js and Git do not need to be installed manually.
if "%LOCALCODE_PAUSE%"=="1" if not "%LOCALCODE_NO_PAUSE%"=="1" pause
exit /b 1
