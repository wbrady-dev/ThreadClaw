@echo off
setlocal enabledelayedexpansion
title ThreadClaw - Update
cd /d "%~dp0\.."
set "ROOT=%cd%"

:: ── Prerequisites ──
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] git not found
    exit /b 1
)

:: ── Record current version and commit for rollback ──
for /f "tokens=*" %%v in ('node -e "console.log(require('./package.json').version)" 2^>nul') do set "OLD_VERSION=%%v"
if not defined OLD_VERSION set "OLD_VERSION=unknown"
for /f "tokens=*" %%h in ('git rev-parse HEAD 2^>nul') do set "OLD_HASH=%%h"

:: ── Use tracking branch ──
for /f "tokens=*" %%u in ('git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2^>nul') do set "UPSTREAM=%%u"
if not defined UPSTREAM set "UPSTREAM=origin/main"

:: ── Check for updates ──
echo [update] Checking for updates...
git fetch >nul 2>&1
for /f "tokens=*" %%c in ('git rev-list HEAD..%UPSTREAM% --count 2^>nul') do set "NEW_COMMITS=%%c"
if "%NEW_COMMITS%"=="0" (
    echo [OK] Already up to date.
    exit /b 0
)
echo [update] %NEW_COMMITS% new commit(s) available.

:: ── Stop services ──
echo [update] Stopping services...
curl -s -X POST http://127.0.0.1:18800/shutdown >nul 2>&1
curl -s -X POST http://127.0.0.1:8012/shutdown >nul 2>&1
schtasks /end /tn ThreadClaw_RAG >nul 2>&1
schtasks /end /tn ThreadClaw_Models >nul 2>&1

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

:: ── Backup before pull ──
if exist "%ROOT%\scripts\backup.bat" (
    call "%ROOT%\scripts\backup.bat"
    if !errorlevel! neq 0 (
        echo [ERROR] Backup failed. Aborting update for safety.
        exit /b 1
    )
) else (
    echo [ERROR] Backup script not found. Aborting update for safety.
    exit /b 1
)

:: ── Pull latest ──
:: Check if this is a git repo (install locations may not have .git/)
if not exist "%ROOT%\.git" (
    echo [update] This install location is not a git repository.
    echo          To update ThreadClaw:
    echo.
    echo          1. Go to your original git clone directory
    echo          2. Run: git pull
    echo          3. Run: install.bat
    echo             ^(the installer will update the install location^)
    echo.
    echo          Or clone fresh:
    echo          git clone https://github.com/wbrady-dev/ThreadClaw.git
    echo          cd ThreadClaw ^&^& install.bat
    pause
    exit /b 1
)

echo [update] Pulling latest from GitHub...
git pull
if !errorlevel! neq 0 (
    echo [ERROR] git pull failed. Auto-rolling back to %OLD_HASH%...
    echo [WARN]  git reset --hard will discard any local modifications to tracked files.
    echo [WARN]  If you have local changes, press Ctrl+C now and resolve manually.
    timeout /t 5
    git reset --hard %OLD_HASH%
    pause
    exit /b 1
)

:: ── Update Node.js dependencies ──
echo [update] Updating Node.js dependencies...
call npm install --no-audit --no-fund >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] npm install failed.
)

:: ── Update memory-engine dependencies ──
if exist "%ROOT%\memory-engine\package.json" (
    echo [update] Updating memory-engine dependencies...
    pushd "%ROOT%\memory-engine"
    call npm install --no-audit --no-fund >nul 2>&1
    if %errorlevel% neq 0 (
        echo [WARN] memory-engine npm install failed.
    )
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
if !errorlevel! neq 0 (
    echo [ERROR] Build failed. Services will NOT be restarted.
    echo [ERROR] Fix build errors and run: npm run build ^&^& threadclaw start
    exit /b 1
)

:: ── Run migrations ──
echo [update] Running migrations...
node "%ROOT%\bin\threadclaw.mjs" upgrade
if %errorlevel% neq 0 (
    echo [WARN] Upgrade had issues. Run 'threadclaw doctor' for details.
)

:: ── Restart services ──
echo [update] Restarting services...
schtasks /run /tn ThreadClaw_Models >nul 2>&1

:: Wait for model server health (60s max) with progress
set /a WAIT=0
:health_loop
if %WAIT% GEQ 60 goto :health_done
curl -s http://127.0.0.1:8012/health >nul 2>&1
if %errorlevel% equ 0 goto :health_done
timeout /t 2 /nobreak >nul
set /a WAIT+=2
set /a MOD=WAIT %% 10
if %MOD% equ 0 echo [update] Still waiting for model server... (%WAIT%s)
goto :health_loop
:health_done

schtasks /run /tn ThreadClaw_RAG >nul 2>&1

:: ── Smoke test ──
echo [update] Running smoke test...
node "%ROOT%\bin\threadclaw.mjs" doctor >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Smoke test passed.
) else (
    echo [WARN] Smoke test had issues. Run 'threadclaw doctor' for details.
)

:: ── Show update summary ──
for /f "tokens=*" %%v in ('node -e "console.log(require('./package.json').version)" 2^>nul') do set "NEW_VERSION=%%v"
if not defined NEW_VERSION set "NEW_VERSION=unknown"
echo.
echo [OK] ThreadClaw updated successfully.
echo      Version: %OLD_VERSION% -^> %NEW_VERSION%
echo.
if exist "%ROOT%\.git" (
    echo   Recent commits:
    git log --oneline -5
)
