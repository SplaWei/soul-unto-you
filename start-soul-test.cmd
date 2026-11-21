@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js v22.18+.
  pause
  exit /b 1
)
node scripts/launch-workbench.ts
if errorlevel 1 pause
