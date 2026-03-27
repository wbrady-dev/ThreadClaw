@echo off
setlocal
title ThreadClaw - Installer

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

:: Auto-cd out of System32 (case-insensitive /i covers all variants)
if /i "%SCRIPT_DIR%"=="%WINDIR%\System32" (
    echo [NOTE] Detected System32 directory. Changing to Desktop...
    cd /d "%USERPROFILE%\Desktop"
    set "SCRIPT_DIR=%USERPROFILE%\Desktop"
)

:: Verify this is actually a ThreadClaw directory
if not exist "%SCRIPT_DIR%\package.json" (
    echo [ERROR] This does not appear to be a ThreadClaw directory.
    echo         Clone ThreadClaw first: git clone https://github.com/wbrady-dev/ThreadClaw.git
    echo         Then: cd ThreadClaw ^& install.bat
    pause
    exit /b 1
)

cd /d "%SCRIPT_DIR%"

echo.
echo  ========================================
echo   ThreadClaw - One-Click Installer
echo  ========================================
echo.

:: ── Step 1: Check Node.js ──
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo         Install Node.js 22+ from https://nodejs.org/
    pause
    exit /b 1
)

:: Parse major version from "vXX.Y.Z" output
for /f "tokens=1 delims=." %%v in ('node --version') do set "NODE_VER=%%v"
set "NODE_MAJOR=%NODE_VER:v=%"
set "NODE_MAJOR=%NODE_MAJOR:V=%"

:: Validate NODE_MAJOR is numeric
set /a "_NV=%NODE_MAJOR%" 2>nul
if "%_NV%"=="0" if not "%NODE_MAJOR%"=="0" (
    echo [ERROR] Could not determine Node.js version.
    pause
    exit /b 1
)
if "%NODE_MAJOR%"=="" (
    echo [ERROR] Could not determine Node.js version.
    pause
    exit /b 1
)
:: NOTE: LSS does string comparison, but this works correctly for two-digit
:: version numbers (22+). Would break if comparing e.g. "9" LSS "22" (string "9" > "2").
:: The set /a numeric check above ensures NODE_MAJOR is valid.
if "%NODE_MAJOR%" LSS "22" (
    echo [ERROR] Node.js %NODE_MAJOR% detected. ThreadClaw requires Node.js 22+.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

:: ── Pre-flight: internet connectivity ──
ping -n 1 -w 3000 pypi.org >nul 2>&1
if errorlevel 1 (
    echo [WARN] Cannot reach pypi.org — Python package downloads may fail.
)

:: ── Pre-flight: logs directory ──
if not exist "%SCRIPT_DIR%\logs" mkdir "%SCRIPT_DIR%\logs"

:: ── Step 2: Check Python ──
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not on PATH.
    echo         Install Python 3.10+ and enable "Add to PATH", then try again.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do echo [OK] %%v

:: Verify venv module actually works (Microsoft Store Python often lacks it)
python -m venv --help >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python venv module not available.
    echo         Install Python from python.org (not Microsoft Store^).
    echo         Enable "Add to PATH" during installation.
    pause
    exit /b 1
)

for /f %%m in ('python -c "import sys; print(sys.version_info.minor)"') do set "PYTHON_MINOR=%%m"
if "%PYTHON_MINOR%"=="" (
    echo [ERROR] Could not determine Python version.
    pause
    exit /b 1
)
if "%PYTHON_MINOR%" LSS "10" (
    echo [ERROR] Python 3.%PYTHON_MINOR% detected. ThreadClaw requires Python 3.10+.
    pause
    exit /b 1
)

:: ── Step 3: Node.js dependencies ──
if exist "%SCRIPT_DIR%\node_modules\.install-ok" (
    echo [OK] Node.js dependencies already present
    goto :npm_done
)
echo.
echo [install] Installing Node.js dependencies...
call npm install --loglevel=http --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)
type nul > "%SCRIPT_DIR%\node_modules\.install-ok"
echo [OK] Node.js dependencies installed
:npm_done
set "THREADCLAW_SKIP_NODE_INSTALL=1"

:: ── Step 3b: Build TypeScript ──
echo [install] Building ThreadClaw...
call npm run build
if errorlevel 1 (
    echo [WARN] Build failed. Install will continue but may run slower.
) else (
    echo [OK] Build complete
)

:: ── Python venv, pip, spaCy, and memory-engine deps are handled by the TUI ──
:: The TUI installer creates .venv at the install root (which may differ from
:: SCRIPT_DIR) and installs all Python dependencies there. This avoids wasting
:: 5-10 minutes installing Python deps at the clone location only to have the
:: TUI re-install them at the actual install directory.

echo.
echo [launch] Starting ThreadClaw setup...
echo.

:: ── Step 8: Launch the Node.js installer (handles config, models, OpenClaw) ──
node "%SCRIPT_DIR%\bin\threadclaw.mjs" install %*
if errorlevel 1 goto :install_failed

:: The TUI installer (performInstallPlan) registers the global command
:: pointing to the correct install root. No fallback needed here.
if exist "%LOCALAPPDATA%\ThreadClaw\threadclaw.cmd" (
    echo [OK] threadclaw command registered
) else (
    echo [WARN] Global command not registered. Run: threadclaw install
)

:: ── Done ──
echo.
echo  ========================================
echo   Installation complete!
echo  ========================================
echo.
echo  IMPORTANT: Close this window and open a
echo  NEW terminal, then type: threadclaw
echo.
echo  The command will NOT work in this window
echo  because PATH updates require a new session.
echo.

pause
exit /b 0

:install_failed
echo.
echo [ERROR] Installer exited with an error.
pause
exit /b 1
