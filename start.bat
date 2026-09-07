@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM Locate node.exe: when double-clicking, node is usually NOT in
REM PATH. Try workbuddy first, then Program Files.
REM CRITICAL: must use enabledelayedexpansion + !NODE_HOME! because
REM the for-loop sets NODE_HOME at runtime; %NODE_HOME% would expand
REM at parse time (empty), so PATH would never get the node dir.
REM This delayed-expansion bug was the root cause of the original
REM "double-click flash-exit".
REM ============================================================
setlocal enabledelayedexpansion
set "NODE_HOME="

where node >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
        for /d %%v in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
            if exist "%%v\node.exe" set "NODE_HOME=%%v"
        )
    )
    if not defined NODE_HOME if exist "%ProgramFiles%\nodejs\node.exe" (
        for %%i in ("%ProgramFiles%\nodejs\node.exe") do set "NODE_HOME=%%~dpi"
    )
    if defined NODE_HOME set "PATH=!NODE_HOME!;%PATH%"
)

REM Re-confirm node is actually reachable (so later steps don't fail silently)
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Install Node.js from https://nodejs.org and add it to PATH,
    echo         or open a terminal with node configured and run: npm start
    echo.
    pause
    exit /b 1
)

REM ============================================================
REM Dependency check
REM ============================================================
if not exist "node_modules" (
    echo [INFO] node_modules missing, installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Dependency install failed!
        pause
        exit /b 1
    )
)

REM ============================================================
REM Build artifact check (electron-vite output: out\main\main.js)
REM ============================================================
if not exist "out\main\main.js" (
    echo [INFO] Build artifact missing, building project...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed!
        pause
        exit /b 1
    )
)

REM ============================================================
REM Launch the app.
REM `node launcher.cjs` auto-detects whether it's running inside the
REM Electron main process; if not, it locates electron.exe and
REM re-spawns itself under it. So we don't need
REM node_modules\.bin\electron.cmd here, avoiding its setlocal quirks.
REM --enable-logging/--log-file make electron write native crashes to
REM electron-debug.log (useful when JS handlers can't catch them).
REM ============================================================
echo [INFO] Launching app...
set ELECTRON_ENABLE_LOGGING=1
node launcher.cjs --enable-logging=file --log-file=electron-debug.log
set ELECTRON_ENABLE_LOGGING=

REM ============================================================
REM Show diagnostic logs after exit (launcher.cjs writes crashes to
REM startup-crash.log)
REM ============================================================
if exist "startup-crash.log" (
  echo.
  echo ============ startup-crash.log ============
  type startup-crash.log
  echo ==========================================================
)
if exist "electron-debug.log" (
  echo.
  echo ============ electron-debug.log (last 40 lines) ============
  REM L9: log can grow huge; dump only the tail instead of flooding the console
  powershell -NoProfile -Command "Get-Content -LiteralPath 'electron-debug.log' -Tail 40" 2>nul
  echo ================================================================
)

echo.
echo [INFO] App exited. Press any key to close...
pause
endlocal
