@echo off
cd /d "%~dp0"

:: 检查 node_modules 是否存在
if not exist "node_modules" (
    echo [错误] node_modules 不存在，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败！
        pause
        exit /b 1
    )
)

:: 检查构建产物是否存在
if not exist "out\main\index.js" (
    echo [信息] 构建产物不存在，正在构建项目...
    call npm run build
    if errorlevel 1 (
        echo [错误] 构建失败！
        pause
        exit /b 1
    )
)

echo [信息] 启动应用...
node_modules\.bin\electron.cmd .
