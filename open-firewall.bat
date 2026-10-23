@echo off
chcp 65001 >nul
title Open firewall ports for Bannerlord Coop console
rem KEEP ASCII-ONLY + CRLF (see note in start-console.bat).
rem
rem Usage: open-firewall.bat [consolePort] [gamePort]
rem        defaults: 7788 / 4200
rem If you changed the console port in the Config tab (config.json), pass it
rem here too -- otherwise this opens a port nobody is listening on.
set "TCPPORT=%~1"
set "UDPPORT=%~2"
if not defined TCPPORT set "TCPPORT=7788"
if not defined UDPPORT set "UDPPORT=4200"

echo.
echo Opens these inbound rules (needs Administrator):
echo    TCP %TCPPORT%   Web console
echo    UDP %UDPPORT%   Game port  ^(only needed for direct / ZeroTier join^)
echo.

net session >nul 2>nul
if %errorlevel% neq 0 goto ELEVATE

netsh advfirewall firewall delete rule name="Bannerlord Coop Web Console %TCPPORT%" >nul 2>nul
netsh advfirewall firewall add rule name="Bannerlord Coop Web Console %TCPPORT%" dir=in action=allow protocol=TCP localport=%TCPPORT% profile=any

netsh advfirewall firewall delete rule name="Bannerlord Coop Dedicated Server %UDPPORT%" >nul 2>nul
netsh advfirewall firewall add rule name="Bannerlord Coop Dedicated Server %UDPPORT%" dir=in action=allow protocol=UDP localport=%UDPPORT% profile=any

echo.
echo Done. Current rule:
netsh advfirewall firewall show rule name="Bannerlord Coop Web Console %TCPPORT%"
echo.
pause
exit /b 0

:ELEVATE
echo Requesting administrator rights...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%TCPPORT% %UDPPORT%' -Verb RunAs"
exit /b 0
