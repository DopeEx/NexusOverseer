@echo off
setlocal
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Import-Galaxy-Data.ps1"
set "result=%errorlevel%"
echo.
pause
exit /b %result%
