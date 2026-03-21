@echo off
setlocal enabledelayedexpansion
title ClawCore - Installer

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

cd /d "%SCRIPT_DIR%"

echo.
echo  ========================================
echo   ClawCore - One-Click Installer
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
    echo [ERROR] Node.js %NODE_MAJOR% detected. ClawCore requires Node.js 22+.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

:: ── Step 2: Check Python ──
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not on PATH.
    echo         Install Python 3.10+ and enable "Add to PATH", then try again.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do echo [OK] %%v

:: ── Step 3: Node.js dependencies ──
if not exist "%SCRIPT_DIR%\node_modules" (
    echo.
    echo [install] Installing Node.js dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo [OK] Node.js dependencies installed
) else (
    echo [OK] Node.js dependencies already present
)
set "CLAWCORE_SKIP_NODE_INSTALL=1"

:: ── Step 4: Python virtual environment ──
if not exist "%SCRIPT_DIR%\.venv\Scripts\python.exe" (
    echo.
    echo [install] Creating Python virtual environment...
    python -m venv "%SCRIPT_DIR%\.venv"
    if %errorlevel% neq 0 (
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
    echo [install] Installing PyTorch...
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 >nul 2>&1
    if %errorlevel% neq 0 (
        echo [install] GPU PyTorch failed, trying CPU version...
        "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install torch torchvision
        if %errorlevel% neq 0 (
            echo [ERROR] PyTorch install failed.
            pause
            exit /b 1
        )
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
    call npm install >nul 2>&1
    cd /d "%SCRIPT_DIR%"
    if exist "%SCRIPT_DIR%\memory-engine\node_modules\@sinclair\typebox" (
        echo [OK] Memory-engine dependencies installed
    ) else (
        echo [WARN] Memory-engine install incomplete. Plugin may not load.
        echo         Fix: cd memory-engine ^&^& npm install
    )
) else (
    echo [OK] Memory-engine dependencies already present
)

echo.
echo [launch] Starting ClawCore setup...
echo.

:: ── Step 8: Launch the Node.js installer (handles config, models, OpenClaw) ──
node "%SCRIPT_DIR%\bin\clawcore.mjs" install %*
set "EXIT_CODE=%ERRORLEVEL%"

:: ── Step 9: Register global command ──
if %EXIT_CODE% equ 0 (
    echo.
    echo [install] Registering clawcore command...
    if not exist "%LOCALAPPDATA%\ClawCore" mkdir "%LOCALAPPDATA%\ClawCore"
    (
        echo @echo off
        echo node "%SCRIPT_DIR%\bin\clawcore.mjs" %%*
    ) > "%LOCALAPPDATA%\ClawCore\clawcore.cmd"

    :: Add to user PATH if not already there
    echo %PATH% | findstr /i "ClawCore" >nul 2>&1
    if %errorlevel% neq 0 (
        setx PATH "%PATH%;%LOCALAPPDATA%\ClawCore" >nul 2>&1
        set "PATH=%PATH%;%LOCALAPPDATA%\ClawCore"
        echo [OK] clawcore command registered. Restart your terminal to use it.
    ) else (
        echo [OK] clawcore command already on PATH
    )
)

if %EXIT_CODE% neq 0 (
    echo.
    echo [ERROR] Installer exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
