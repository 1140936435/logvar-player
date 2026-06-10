@echo off
chcp 65001 >nul
title LogVar Player - 环境安装
echo.
echo ╔══════════════════════════════════════╗
echo ║   LogVar Player 环境安装脚本        ║
echo ╚══════════════════════════════════════╝
echo.

:: 检查 Node.js
echo [1/3] 检查 Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，正在自动安装...
    echo 请在弹出的安装窗口中点击 "Next" 完成安装
    echo 安装完成后重新运行此脚本
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi' -OutFile '%TEMP%\node-install.msi'; Start-Process msiexec.exe -ArgumentList '/i','%TEMP%\node-install.msi','/qn' -Wait"
    echo ✅ Node.js 安装完成
) else (
    echo ✅ Node.js 已安装: 
    node -v
)

:: 检查 mpv
echo.
echo [2/3] 检查 mpv 播放器...
if exist "%~dp0mpv\mpv.exe" (
    echo ✅ mpv 已存在
) else (
    echo 正在下载 mpv 播放器（约 80MB，请稍候）...
    mkdir "%~dp0mpv" 2>nul
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260610/mpv-x86_64-20260610-git-304426c.7z' -OutFile '%TEMP%\mpv.7z'"
    
    where 7z >nul 2>&1
    if %errorlevel% equ 0 (
        7z x "%TEMP%\mpv.7z" -o"%~dp0mpv" -y >nul
    ) else (
        powershell -Command "Expand-Archive -Path '%TEMP%\mpv.7z' -DestinationPath '%~dp0mpv' -Force" 2>nul
        if %errorlevel% neq 0 (
            echo 需要 7-Zip 来解压 mpv，请手动安装 7-Zip 后重试
            echo 或者手动下载 mpv: https://sourceforge.net/projects/mpv-player-windows/
            pause
            exit /b 1
        )
    )
    del "%TEMP%\mpv.7z" 2>nul
    echo ✅ mpv 下载完成
)

:: 安装 npm 依赖
echo.
echo [3/3] 安装项目依赖...
cd /d "%~dp0"
call npm install
if %errorlevel% neq 0 (
    echo ❌ npm install 失败，请检查网络连接
    pause
    exit /b 1
)

echo.
echo ╔══════════════════════════════════════╗
echo ║   ✅ 安装完成！                      ║
echo ╚══════════════════════════════════════╝
echo.
echo 现在可以运行 start.bat 启动应用了
echo.
pause
