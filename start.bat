@echo off
chcp 65001 >nul
title LogVar Player
cd /d "%~dp0"
call npm run dev
