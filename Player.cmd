@echo off
title MEASURED player
cd /d "%~dp0player"
start "" http://127.0.0.1:8142/
"C:\Program Files\nodejs\node.exe" server.cjs
pause