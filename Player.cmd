@echo off
title MEASURED player
rem Serve from the repo root: server.cjs lives here, and the old `player\`
rem subdirectory has not existed for several releases.
cd /d "%~dp0"

rem Prefer the standard install, but fall back to PATH so nvm and portable
rem installs work too.
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" for /f "delims=" %%i in ('where node 2^>nul') do set "NODE=%%i"
if not exist "%NODE%" (
  echo Node.js was not found.
  echo Install Node.js, or edit NODE in this file to point at node.exe.
  pause
  exit /b 1
)

start "" /b "%NODE%" server.cjs

rem Open the browser only once the port answers. Opening it first lands the
rem user on a connection-refused page on a cold start. The probe is node
rem itself: it is already required, and it beats parsing netstat, which keeps
rem stale CLOSED rows around after a crash.
set /a tries=0
:wait
set /a tries+=1
"%NODE%" -e "const s=require('net').connect(8142,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 goto open
if %tries% geq 30 goto failed
timeout /t 1 /nobreak >nul
goto wait

:failed
echo The player did not start listening on 127.0.0.1:8142 within 30 seconds.
echo Check the output above for the server's error.
pause
exit /b 1

:open
start "" http://127.0.0.1:8142/
pause
