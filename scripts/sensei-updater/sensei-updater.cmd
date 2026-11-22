@echo off
rem Native messaging entry point for the Sensei extension (see sensei-updater.ps1).
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0sensei-updater.ps1" %*
