@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -Command "& ([scriptblock]::Create([System.IO.File]::ReadAllText((Join-Path (Get-Location) 'mulai_windows.ps1')))) -Page website.html"
if errorlevel 1 pause
