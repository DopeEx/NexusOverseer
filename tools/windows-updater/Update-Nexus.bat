@echo off
setlocal DisableDelayedExpansion
set "NEXUS_MANUAL_ROOT=%~dp0"
echo Nexus Overseer - Windows updater
echo.
REM Keep this protocol-1 starter independent of the replaceable updater.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $root=$env:NEXUS_MANUAL_ROOT; $update=Join-Path $root '.update'; [IO.Directory]::CreateDirectory($update) | Out-Null; $lock=[IO.File]::Open((Join-Path $update 'updater.lock'),'OpenOrCreate','ReadWrite','None'); try { $pending=Join-Path $update 'updater.pending'; $previous=Join-Path $update 'updater.previous.ps1'; $updater=Join-Path $root 'updater.ps1'; if(Test-Path -LiteralPath $pending) { if(!(Test-Path -LiteralPath $previous -PathType Leaf)) { throw 'Updater recovery file missing. Extract the manual package again; keep the addon folder and its path.' }; Copy-Item -LiteralPath $previous -Destination $updater -Force; Remove-Item -LiteralPath $pending; Write-Host 'Interrupted updater update recovered.' } } finally { $lock.Dispose() }; & $updater } catch { Write-Host ('ERROR: '+$_.Exception.Message) -ForegroundColor Red; exit 1 }"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Update failed. See the message above and .update\updater.log if available.
echo Press any key to close this window.
pause >nul
exit /b %RESULT%
