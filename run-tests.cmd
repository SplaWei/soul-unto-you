@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js v22.13+.
  pause
  exit /b 1
)
node scripts/run-test-suite.ts %*
set EXIT_CODE=%ERRORLEVEL%
echo %* | findstr /i "no-pause json" >nul
if errorlevel 1 if "%CI%"=="" pause
exit /b %EXIT_CODE%
