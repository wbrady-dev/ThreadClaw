@echo off
setlocal enabledelayedexpansion
title ThreadClaw - Installer

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

cd /d "%SCRIPT_DIR%"

echo.
echo  ========================================
echo   ThreadClaw - One-Click Installer
echo  ========================================
echo.

:: ── Step 1: Check Node.js ──
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo         Install Node.js 22+ from https://nodejs.org/
    pause
    exit /b 1
)
for /f %%m in ('node -e "console.log(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%m
if %NODE_MAJOR% LSS 22 (
    echo [ERROR] Node.js %NODE_MAJOR% detected. ThreadClaw requires Node.js 22+.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

:: ── Pre-flight: internet connectivity ──
ping -n 1 -w 3000 pypi.org >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Cannot reach pypi.org — Python package downloads may fail.
    echo         Check your internet connection.
)

:: ── Pre-flight: logs directory ──
if not exist "%SCRIPT_DIR%\logs" mkdir "%SCRIPT_DIR%\logs"

:: ── Step 2: Check Python ──
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not on PATH.
    echo         Install Python 3.10+ and enable "Add to PATH", then try again.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do echo [OK] %%v

:: Check Python version >= 3.10
for /f %%m in ('python -c "import sys; print(sys.version_info.minor)"') do set PYTHON_MINOR=%%m
if %PYTHON_MINOR% LSS 10 (
    echo [ERROR] Python 3.%PYTHON_MINOR% detected. ThreadClaw requires Python 3.10+.
    pause
    exit /b 1
)

:: ── Step 3: Node.js dependencies ──
if not exist "%SCRIPT_DIR%\node_modules\.install-ok" (
    echo.
    echo [install] Installing Node.js dependencies...
    call npm install --no-audit --no-fund
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    type nul > "%SCRIPT_DIR%\node_modules\.install-ok"
    echo [OK] Node.js dependencies installed
) else (
    echo [OK] Node.js dependencies already present
)
set "THREADCLAW_SKIP_NODE_INSTALL=1"

:: ── Step 4: Python virtual environment ──
if exist "%SCRIPT_DIR%\.venv\Scripts\python.exe" (
    "%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import sys" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [WARN] Existing venv is broken — recreating...
        rmdir /s /q "%SCRIPT_DIR%\.venv"
    )
)
if not exist "%SCRIPT_DIR%\.venv\Scripts\python.exe" (
    echo.
    echo [install] Creating Python virtual environment...
    python -m venv "%SCRIPT_DIR%\.venv"
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create Python virtual environment.
        echo         Make sure 'python -m venv' works on your system.
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created
) else (
    echo [OK] Python virtual environment already present
)

:: ── Step 5: Install pinned Python dependencies ──
echo.
echo [install] Installing Python dependencies (this may take several minutes)...

:: Install PyTorch first (platform-specific)
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import torch" >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Downloading PyTorch (this may take 5-10 minutes)...
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install torch torchvision --index-url https://download.pytorch.org/whl/cu124
    if %errorlevel% neq 0 (
        echo [install] GPU PyTorch failed, trying CPU version...
        "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install torch torchvision
        if %errorlevel% neq 0 (
            echo [ERROR] PyTorch install failed.
            pause
            exit /b 1
        )
    )
    "%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import torch" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [ERROR] PyTorch installation failed.
        pause
        exit /b 1
    )
    echo [OK] PyTorch installed
) else (
    echo [OK] PyTorch already installed
)

:: Install remaining pinned dependencies
if exist "%SCRIPT_DIR%\server\requirements-pinned.txt" (
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install -r "%SCRIPT_DIR%\server\requirements-pinned.txt" >nul 2>&1
    if %errorlevel% neq 0 (
        echo [WARN] Some Python dependencies failed. Trying individually...
        "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install sentence-transformers flask
        "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install spacy 2>nul
        "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install docling 2>nul
    )
    echo [OK] Python dependencies installed
) else (
    echo [install] No pinned requirements found, installing core deps...
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install sentence-transformers flask spacy docling
    echo [OK] Python dependencies installed
)

:: ── Step 6: spaCy NER model ──
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import spacy; spacy.load('en_core_web_sm')" >nul 2>&1
if %errorlevel% neq 0 (
    echo [install] Downloading spaCy NER model...
    "%SCRIPT_DIR%\.venv\Scripts\python.exe" -m spacy download en_core_web_sm >nul 2>&1
    if %errorlevel% neq 0 (
        echo [WARN] spaCy NER model download failed. Entity extraction will use regex fallback.
    ) else (
        echo [OK] spaCy NER model installed
    )
) else (
    echo [OK] spaCy NER model already present
)

:: ── Step 7: Memory-engine dependencies ──
if not exist "%SCRIPT_DIR%\memory-engine\node_modules\@sinclair\typebox" (
    echo [install] Installing memory-engine dependencies...
    cd /d "%SCRIPT_DIR%\memory-engine"
    call npm install --no-audit --no-fund >nul 2>&1
    if %errorlevel% neq 0 (
        echo [WARN] memory-engine npm install returned an error.
    )
    cd /d "%SCRIPT_DIR%"
    if exist "%SCRIPT_DIR%\memory-engine\node_modules\@sinclair" (
        echo [OK] Memory-engine dependencies installed
    ) else (
        echo [ERROR] Memory-engine dependencies incomplete.
        pause
        exit /b 1
    )
) else (
    echo [OK] Memory-engine dependencies already present
)

echo.
echo [launch] Starting ThreadClaw setup...
echo.

:: ── Step 8: Launch the Node.js installer (handles config, models, OpenClaw) ──
node "%SCRIPT_DIR%\bin\threadclaw.mjs" install %*
set "EXIT_CODE=%ERRORLEVEL%"

:: ── Step 9: Register global command ──
if %EXIT_CODE% equ 0 (
    echo.
    echo [install] Registering threadclaw command...
    if not exist "%LOCALAPPDATA%\ThreadClaw" mkdir "%LOCALAPPDATA%\ThreadClaw"
    (
        echo @echo off
        echo node "%SCRIPT_DIR%\bin\threadclaw.mjs" %%*
    ) > "%LOCALAPPDATA%\ThreadClaw\threadclaw.cmd"

    :: Add to user PATH if not already there (read from registry to avoid corruption)
    for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%b"
    if not defined USER_PATH set "USER_PATH="
    echo !USER_PATH! | findstr /i "ThreadClaw" >nul 2>&1
    if !errorlevel! neq 0 (
        setx PATH "!USER_PATH!;%LOCALAPPDATA%\ThreadClaw" >nul 2>&1
        set "PATH=%PATH%;%LOCALAPPDATA%\ThreadClaw"
        echo [OK] threadclaw command registered. Restart your terminal to use it.
    ) else (
        echo [OK] threadclaw command already on PATH
    )
)

:: ── Step 10: Register background services (Task Scheduler, no admin needed) ──
if %EXIT_CODE% equ 0 (
    echo.
    echo [install] Setting up background services...
    if not exist "%SCRIPT_DIR%\logs" mkdir "%SCRIPT_DIR%\logs"

    :: Find Python and models script
    set "PYTHON=%SCRIPT_DIR%\.venv\Scripts\python.exe"
    set "MODELS_SCRIPT=%SCRIPT_DIR%\server\server.py"
    if not exist "!MODELS_SCRIPT!" (
        echo [WARN] server\server.py not found. Model services may not start.
    )

    :: Create wrapper scripts for Task Scheduler
    (
        echo @echo off
        echo cd /d "%SCRIPT_DIR%"
        echo "!PYTHON!" "!MODELS_SCRIPT!" ^>^> "%SCRIPT_DIR%\logs\models.log" 2^>^&1
    ) > "%SCRIPT_DIR%\bin\ThreadClaw_Models.cmd"

    if exist "%SCRIPT_DIR%\dist\index.js" (
        set "API_ENTRY=%SCRIPT_DIR%\dist\index.js"
    ) else (
        set "API_ENTRY=%SCRIPT_DIR%\node_modules\tsx\dist\cli.mjs" "%SCRIPT_DIR%\src\index.ts"
    )

    (
        echo @echo off
        echo cd /d "%SCRIPT_DIR%"
        echo node "!API_ENTRY!" ^>^> "%SCRIPT_DIR%\logs\threadclaw.log" 2^>^&1
    ) > "%SCRIPT_DIR%\bin\ThreadClaw_RAG.cmd"

    :: Remove old tasks if they exist (clean reinstall)
    schtasks /delete /tn ThreadClaw_Models /f >nul 2>&1
    schtasks /delete /tn ThreadClaw_RAG /f >nul 2>&1

    :: Register tasks (onlogon auto-start, no admin required)
    schtasks /create /tn ThreadClaw_Models /tr "\"%SCRIPT_DIR%\bin\ThreadClaw_Models.cmd\"" /sc onlogon /rl limited /f >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] ThreadClaw_Models task registered
    ) else (
        echo [WARN] ThreadClaw_Models task registration failed
    )

    schtasks /create /tn ThreadClaw_RAG /tr "\"%SCRIPT_DIR%\bin\ThreadClaw_RAG.cmd\"" /sc onlogon /rl limited /f >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] ThreadClaw_RAG task registered
    ) else (
        echo [WARN] ThreadClaw_RAG task registration failed
    )

    echo [OK] Services will start automatically on login
    echo      Use 'threadclaw' TUI to start/stop/restart services
)

if %EXIT_CODE% neq 0 (
    echo.
    echo [ERROR] Installer exited with code %EXIT_CODE%.
    pause
    exit /b %EXIT_CODE%
)

:: ── Smoke test ──
echo.
echo [install] Running smoke test...
node "%SCRIPT_DIR%\bin\threadclaw.mjs" doctor >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Smoke test passed
) else (
    echo [WARN] Smoke test had issues. Run 'threadclaw doctor' for details.
)

exit /b 0
