@echo off
REM ThreadClaw startup wrapper
REM Usage: start-threadclaw.bat [--with-openclaw]

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
cd /d "%SCRIPT_DIR%"

set WITH_OPENCLAW=false
for %%a in (%*) do (
  if "%%a"=="--with-openclaw" set WITH_OPENCLAW=true
)

REM Check each port independently — chaining with && only checks the last errorlevel
set "_MODELS_UP=0"
set "_API_UP=0"
curl -s http://127.0.0.1:8012/health >nul 2>&1
if %errorlevel%==0 set "_MODELS_UP=1"
curl -s http://127.0.0.1:18800/health >nul 2>&1
if %errorlevel%==0 set "_API_UP=1"
if "%_MODELS_UP%"=="1" if "%_API_UP%"=="1" (
  echo [threadclaw] ThreadClaw already running ^(models :8012, API :18800^)
  goto :start_openclaw
)

if not exist "%SCRIPT_DIR%\node_modules" if not exist "%SCRIPT_DIR%\dist\cli\threadclaw.js" (
  echo [threadclaw] ERROR: ThreadClaw runtime files are missing. Run install.bat first.
  exit /b 1
)

echo [threadclaw] Starting ThreadClaw services...
start /min "ThreadClaw" node "%SCRIPT_DIR%\bin\threadclaw.mjs" serve

echo [threadclaw] Waiting for model server ^(may take 30-60s on first load^)...
call :wait_for_port 8012 120
if errorlevel 1 (
  echo [threadclaw] ERROR: Model server failed to start within 120s
  exit /b 1
)
echo [threadclaw] Model server ready.

echo [threadclaw] Waiting for ThreadClaw API...
call :wait_for_port 18800 30
if errorlevel 1 (
  echo [threadclaw] ERROR: ThreadClaw API failed to start within 30s
  exit /b 1
)
echo [threadclaw] ThreadClaw API ready.

:start_openclaw
if "%WITH_OPENCLAW%"=="true" (
  echo [threadclaw] Starting OpenClaw gateway...
  start /min "OpenClaw" openclaw
  timeout /t 3 /nobreak >nul
  echo [threadclaw] OpenClaw started.
)

echo.
echo   Model Server:  http://127.0.0.1:8012/health
echo   ThreadClaw API:  http://127.0.0.1:18800/health
if "%WITH_OPENCLAW%"=="true" (
  echo   OpenClaw:      http://127.0.0.1:18789
)
echo.
echo [threadclaw] All services running.
exit /b 0

:wait_for_port
set _port=%1
set _timeout=%2
set _elapsed=0
:wait_loop
if %_elapsed% geq %_timeout% exit /b 1
curl -s http://127.0.0.1:%_port%/health >nul 2>&1
if %errorlevel%==0 exit /b 0
timeout /t 2 /nobreak >nul
set /a _elapsed+=2
goto wait_loop
