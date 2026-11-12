@echo off
title MEASURED player
rem Serve from the repo root: server.cjs lives here, and the old `player\`
rem subdirectory has not existed for several releases.
cd /d "%~dp0"
start "" /b "C:\Program Files\nodejs\node.exe" server.cjs
rem Open the browser only once the port answers. Opening it first lands the
rem user on a connection-refused page on a cold start.
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',8142);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto open
if %tries% geq 30 goto open
timeout /t 1 /nobreak >nul
goto wait
:open
start "" http://127.0.0.1:8142/
pause
