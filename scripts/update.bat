@echo off
title ClawCore - Update
cd /d "%~dp0\.."
set "ROOT=%cd%"

:: ── Record current commit for rollback ──
for /f "tokens=*" %%h in ('git rev-parse HEAD 2^>nul') do set "OLD_HASH=%%h"

:: ── Check for updates ──
echo [update] Checking for updates...
git fetch >nul 2>&1
for /f "tokens=*" %%c in ('git rev-list HEAD..origin/main --count 2^>nul') do set "NEW_COMMITS=%%c"
if "%NEW_COMMITS%"=="0" (
    echo [OK] Already up to date.
    exit /b 0
)
echo [update] %NEW_COMMITS% new commit(s) available.

:: ── Stop services ──
echo [update] Stopping services...
curl -s -X POST http://127.0.0.1:18800/shutdown >nul 2>&1
curl -s -X POST http://127.0.0.1:8012/shutdown >nul 2>&1
schtasks /end /tn ClawCore_RAG >nul 2>&1
schtasks /end /tn ClawCore_Models >nul 2>&1

:: Wait for ports to close (15s max)
set /a WAIT=0
:wait_loop
if %WAIT% GEQ 15 goto :wait_done
curl -s http://127.0.0.1:8012/health >nul 2>&1
if %errorlevel% neq 0 goto :wait_done
timeout /t 1 /nobreak >nul
set /a WAIT+=1
goto :wait_loop
:wait_done

:: ── Pull latest ──
echo [update] Pulling latest from GitHub...
git pull
if %errorlevel% neq 0 (
    echo [ERROR] git pull failed. Rollback: git reset --hard %OLD_HASH%
    pause
    exit /b 1
)

:: ── Update Node.js dependencies ──
echo [update] Updating Node.js dependencies...
call npm install --no-audit --no-fund >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] npm install failed. Rollback: git reset --hard %OLD_HASH%
)

:: ── Update memory-engine dependencies ──
if exist "%ROOT%\memory-engine\package.json" (
    echo [update] Updating memory-engine dependencies...
    pushd "%ROOT%\memory-engine"
    call npm install --no-audit --no-fund >nul 2>&1
    popd
)

:: ── Update Python dependencies ──
if exist "%ROOT%\.venv\Scripts\pip.exe" (
    if exist "%ROOT%\server\requirements-pinned.txt" (
        echo [update] Updating Python dependencies...
        "%ROOT%\.venv\Scripts\pip.exe" install -q -r "%ROOT%\server\requirements-pinned.txt" >nul 2>&1
    )
)

:: ── Rebuild ──
echo [update] Building...
call npm run build
if %errorlevel% neq 0 (
    echo [WARN] Build failed. TUI will use tsx fallback.
)

:: ── Run migrations ──
echo [update] Running migrations...
node "%ROOT%\bin\clawcore.mjs" upgrade >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Upgrade had issues. Run 'clawcore doctor' for details.
)

:: ── Restart services ──
echo [update] Restarting services...
schtasks /run /tn ClawCore_Models >nul 2>&1

:: Wait for model server health (60s max)
set /a WAIT=0
:health_loop
if %WAIT% GEQ 60 goto :health_done
curl -s http://127.0.0.1:8012/health >nul 2>&1
if %errorlevel% equ 0 goto :health_done
timeout /t 2 /nobreak >nul
set /a WAIT+=2
goto :health_loop
:health_done

schtasks /run /tn ClawCore_RAG >nul 2>&1

:: ── Smoke test ──
echo [update] Running smoke test...
node "%ROOT%\bin\clawcore.mjs" doctor >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Smoke test passed.
) else (
    echo [WARN] Smoke test had issues. Run 'clawcore doctor' for details.
)

echo.
echo [OK] ClawCore updated successfully.
