@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-tsi-chrome.ps1"
if errorlevel 1 pause
