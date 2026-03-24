@echo off
setlocal
title ThreadClaw - Installer

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

:: ── Fix 1: Auto-cd out of System32 ──
:: If running from System32 or similar system directory, cd somewhere sensible
if /i "%SCRIPT_DIR%"=="%WINDIR%\System32" (
    echo [NOTE] Detected System32 directory. Changing to Desktop...
    cd /d "%USERPROFILE%\Desktop"
    set "SCRIPT_DIR=%USERPROFILE%\Desktop"
)
if /i "%SCRIPT_DIR%"=="%WINDIR%\system32" (
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

:: ── Fix 7: Robust Node version parsing ──
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

:: ── Fix 4: Microsoft Store Python detection ──
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
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)
type nul > "%SCRIPT_DIR%\node_modules\.install-ok"
echo [OK] Node.js dependencies installed
:npm_done
set "THREADCLAW_SKIP_NODE_INSTALL=1"

:: ── Step 4: Python virtual environment ──
if not exist "%SCRIPT_DIR%\.venv\Scripts\python.exe" goto :create_venv

:: Verify existing venv works
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import sys" >nul 2>&1
if errorlevel 1 (
    echo [WARN] Existing venv is broken — recreating...
    rmdir /s /q "%SCRIPT_DIR%\.venv"
    goto :create_venv
)
echo [OK] Python virtual environment already present
goto :venv_done

:create_venv
echo.
echo [install] Creating Python virtual environment...
python -m venv "%SCRIPT_DIR%\.venv"
if errorlevel 1 (
    echo [ERROR] Failed to create Python virtual environment.
    echo         Make sure 'python -m venv' works on your system.
    pause
    exit /b 1
)
echo [OK] Virtual environment created

:venv_done

:: ── Step 5: Install pinned Python dependencies ──
echo.
echo [install] Installing Python dependencies (this may take several minutes)...

:: Install PyTorch first (platform-specific)
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import torch" >nul 2>&1
if not errorlevel 1 (
    echo [OK] PyTorch already installed
    goto :torch_done
)

echo [install] Downloading PyTorch (this may take 5-10 minutes)...
"%SCRIPT_DIR%\.venv\Scripts\pip.exe" install torch torchvision --index-url https://download.pytorch.org/whl/cu124
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import torch; print('torch', torch.__version__)" >nul 2>&1
if not errorlevel 1 (
    echo [OK] PyTorch installed (GPU)
    goto :torch_done
)

echo [install] GPU PyTorch failed, trying CPU version...
"%SCRIPT_DIR%\.venv\Scripts\pip.exe" install torch torchvision
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import torch; print('torch', torch.__version__)" >nul 2>&1
if not errorlevel 1 (
    echo [OK] PyTorch installed (CPU)
    goto :torch_done
)

echo [ERROR] PyTorch installation failed. Could not import torch after install.
pause
exit /b 1

:torch_done

:: Install remaining pinned dependencies
if not exist "%SCRIPT_DIR%\server\requirements-pinned.txt" goto :pip_fallback

:: ── Fix 5: pip errorlevel check on requirements install ──
echo [install] Installing from requirements-pinned.txt...
"%SCRIPT_DIR%\.venv\Scripts\pip.exe" install -r "%SCRIPT_DIR%\server\requirements-pinned.txt"
if errorlevel 1 (
    echo [WARN] Some dependencies failed. Attempting individual installs...
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install sentence-transformers
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install flask
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install spacy
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install docling
)
goto :pip_validate

:pip_fallback
echo [install] No pinned requirements found, installing core deps...
"%SCRIPT_DIR%\.venv\Scripts\pip.exe" install sentence-transformers flask spacy docling

:pip_validate
:: Validate critical imports instead of trusting errorlevel
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "from sentence_transformers import SentenceTransformer" >nul 2>&1
if errorlevel 1 (
    echo [WARN] sentence-transformers import failed. Retrying install...
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install sentence-transformers
)
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo [WARN] flask import failed. Retrying install...
    "%SCRIPT_DIR%\.venv\Scripts\pip.exe" install flask
)

:: Final validation
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "from sentence_transformers import SentenceTransformer; import flask" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Critical Python dependencies missing after install.
    echo         Run pip install manually in .venv and check for errors.
    pause
    exit /b 1
)
echo [OK] Python dependencies installed

:: ── Step 6: spaCy NER model ──
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import spacy; spacy.load('en_core_web_sm')" >nul 2>&1
if not errorlevel 1 (
    echo [OK] spaCy NER model already present
    goto :spacy_done
)

echo [install] Downloading spaCy NER model...
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -m spacy download en_core_web_sm
"%SCRIPT_DIR%\.venv\Scripts\python.exe" -c "import spacy; spacy.load('en_core_web_sm')" >nul 2>&1
if errorlevel 1 (
    echo [WARN] spaCy NER model download failed. Entity extraction will use regex fallback.
) else (
    echo [OK] spaCy NER model installed
)

:spacy_done

:: ── Step 7: Memory-engine dependencies ──
if exist "%SCRIPT_DIR%\memory-engine\node_modules\@sinclair\typebox" (
    echo [OK] Memory-engine dependencies already present
    goto :memengine_done
)
echo [install] Installing memory-engine dependencies...
cd /d "%SCRIPT_DIR%\memory-engine"
call npm install --no-audit --no-fund
cd /d "%SCRIPT_DIR%"
if not exist "%SCRIPT_DIR%\memory-engine\node_modules\@sinclair" (
    echo [ERROR] Memory-engine dependencies incomplete.
    pause
    exit /b 1
)
echo [OK] Memory-engine dependencies installed

:memengine_done

echo.
echo [launch] Starting ThreadClaw setup...
echo.

:: ── Step 8: Launch the Node.js installer (handles config, models, OpenClaw) ──
node "%SCRIPT_DIR%\bin\threadclaw.mjs" install %*
if errorlevel 1 goto :install_failed

:: ── Step 9: Register global command ──
echo.
echo [install] Registering threadclaw command...
if not exist "%LOCALAPPDATA%\ThreadClaw" mkdir "%LOCALAPPDATA%\ThreadClaw"
(
    echo @echo off
    echo node "%SCRIPT_DIR%\bin\threadclaw.mjs" %%*
) > "%LOCALAPPDATA%\ThreadClaw\threadclaw.cmd"

:: ── Fix 2 & 3: Add to user PATH (fixed empty PATH + errorlevel syntax) ──
setlocal enabledelayedexpansion
set "TC_PATH=%LOCALAPPDATA%\ThreadClaw"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%b"
if not defined USER_PATH (
    setx PATH "!TC_PATH!" >nul 2>&1
    echo [OK] threadclaw command registered. Restart your terminal to use it.
) else (
    echo !USER_PATH! | findstr /i /c:"ThreadClaw" >nul 2>&1
    if errorlevel 1 (
        setx PATH "!USER_PATH!;!TC_PATH!" >nul 2>&1
        echo [OK] threadclaw command registered. Restart your terminal to use it.
    ) else (
        echo [OK] threadclaw command already on PATH
    )
)
endlocal

:: ── Fix 6: Smoke test with visible output ──
echo.
echo [install] Running smoke test...
node "%SCRIPT_DIR%\bin\threadclaw.mjs" doctor
if errorlevel 1 (
    echo [WARN] Smoke test had issues. Review the output above.
) else (
    echo [OK] Smoke test passed
)

:: ── Done ──
:: ── Fix 8: Better next-steps message ──
echo.
echo  ========================================
echo   Installation complete!
echo  ========================================
echo.
echo  Next steps:
echo    1. Close this window completely
echo    2. Open a NEW terminal (PowerShell or Command Prompt)
echo    3. Type: threadclaw
echo.
echo  The 'threadclaw' command only works in NEW terminal windows.
echo  If it doesn't work, run directly:
echo    node "%SCRIPT_DIR%\bin\threadclaw.mjs"
echo.

pause
exit /b 0

:install_failed
echo.
echo [ERROR] Installer exited with an error.
pause
exit /b 1
