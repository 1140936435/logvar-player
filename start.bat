@echo off
chcp 65001 >nul
title LogVar Player
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
node node_modules\electron-vite\bin\electron-vite.js dev
