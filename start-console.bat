@echo off
chcp 65001 >nul
title Bannerlord Coop Web Console
rem %~dp0 is already the console folder -- do not append a subfolder
cd /d "%~dp0"

rem Usage:  start-console.bat [local|lan] [port]
rem   (none)           listen on 0.0.0.0:7788  (default -- every NIC)
rem   local            listen on 127.0.0.1 only (this machine only)
rem   lan              loopback + private subnets only (LAN / ZeroTier, no public IP)
rem   7790             custom port -- handy for a second read-only panel
rem                    while the main one is busy running the game server
rem
rem WHERE PORT AND BIND ADDRESS COME FROM (highest first):
rem   port : env COOP_CONSOLE_PORT > --port > config.json > 7788
rem   host : env COOP_CONSOLE_HOST > --host > config.json > --lan/--local > 0.0.0.0
rem
rem This script deliberately does NOT set COOP_CONSOLE_HOST / COOP_CONSOLE_PORT
rem any more. Setting them pinned the values at the top of that list, so
rem whatever you saved in the Config tab was silently ignored.
rem
rem KEEP THIS FILE ASCII-ONLY + CRLF. cmd.exe misparses UTF-8 text inside
rem if(...) blocks, and an LF-only file makes the window close instantly.
rem (Tried Chinese messages here once -- the multibyte text got split and cmd
rem  ran half of it as a command. Keep it ASCII, put Chinese in INSTALL.txt.)

rem No MODEARG by default -> built-in default 0.0.0.0.
rem A "host" in config.json still overrides it.
set "MODEARG="
set "PORTARG="

if /i "%~1"=="lan" goto MODE_LAN
if /i "%~1"=="local" goto MODE_LOCAL
if not "%~1"=="" set "PORTARG=--port %~1"
goto RUN

:MODE_LAN
set "MODEARG=--lan"
if not "%~2"=="" set "PORTARG=--port %~2"
goto RUN

:MODE_LOCAL
set "MODEARG=--local"
if not "%~2"=="" set "PORTARG=--port %~2"

:RUN
echo [start] %MODEARG% %PORTARG%
echo [note] port / bind address are read from config.json when defined there.
echo        edit them in the console: Config tab -^> save -^> restart.

rem ---- locate node.exe, in order of preference ----
rem 1) node.exe right next to this script (the step-1 zip: nothing to install)
rem 2) runtime\node.exe (bundled layout)
rem 3) "node" anywhere on PATH (a normal Node.js installation)
set "NODE="
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
if defined NODE goto HAVENODE
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if defined NODE goto HAVENODE
where node >nul 2>nul
if errorlevel 1 goto NONODE
set "NODE=node"

:HAVENODE
echo [node]  %NODE%
echo.
"%NODE%" server.js %MODEARG% %PORTARG%
echo.
echo Console exited. The game server it started has stopped too.
pause
exit /b 0

:NONODE
echo.
echo [ERROR] node.exe not found.
echo.
echo   Put node.exe NEXT TO start-console.bat in this folder.
echo   It is the only file inside the "step 1 / Node.js runtime" download.
echo.
echo   Or install Node.js 18+ from https://nodejs.org and make sure
echo   the "node" command works -- either way is fine.
echo.
if exist "%~dp0INSTALL.txt" start "" notepad "%~dp0INSTALL.txt"
pause
exit /b 1
