@echo off
chcp 65001 >nul
title Bannerlord Coop Web Console (LAN / ZeroTier)
rem LAN mode: other machines on LAN / ZeroTier can open the console.
rem Optional first argument is the port, e.g.  start-console-lan.bat 7790
rem
rem This only sets a FALLBACK default (host = auto). If config.json defines
rem "host", that value wins -- so you can switch to 127.0.0.1 from the
rem console's Config tab without touching this file.
rem KEEP ASCII-ONLY + CRLF (see note in start-console.bat).
call "%~dp0start-console.bat" lan %~1
