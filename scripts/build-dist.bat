@echo off
setlocal enabledelayedexpansion
title ClawCore - Build Distribution

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "ROOT=%SCRIPT_DIR%\.."

cd /d "%ROOT%"

echo.
echo  ========================================
echo   ClawCore - Distribution Builder
echo  ========================================
echo.

:: Read version from package.json
for /f "tokens=2 delims=:, " %%v in ('findstr "version" package.json') do (
    set "VERSION=%%~v"
    goto :got_version
)
:got_version
echo  Version: %VERSION%
echo.

:: ── Step 1: Build TypeScript ──
echo [build] Building TypeScript to dist/...
call npx tsup
if %errorlevel% neq 0 (
    echo [ERROR] tsup build failed.
    pause
    exit /b 1
)
echo [OK] dist/ built

:: ── Step 2: Generate pinned Python requirements ──
echo [build] Generating pinned Python requirements...
"%ROOT%\.venv\Scripts\pip.exe" freeze > "%ROOT%\server\requirements-pinned.txt"
echo [OK] requirements-pinned.txt generated

:: ── Step 3: Verify node_modules exist ──
if not exist "%ROOT%\node_modules" (
    echo [ERROR] node_modules missing. Run npm install first.
    pause
    exit /b 1
)
if not exist "%ROOT%\memory-engine\node_modules\@sinclair\typebox" (
    echo [ERROR] memory-engine/node_modules missing. Run: cd memory-engine ^&^& npm install
    pause
    exit /b 1
)
echo [OK] node_modules verified

:: ── Step 4: Create distribution directory ──
set "DIST_NAME=ClawCore-%VERSION%-win-x64"
set "DIST_DIR=%ROOT%\build\%DIST_NAME%"

if exist "%ROOT%\build" rmdir /s /q "%ROOT%\build"
mkdir "%DIST_DIR%"

echo [build] Copying files to %DIST_DIR%...

:: Copy everything except exclusions
robocopy "%ROOT%" "%DIST_DIR%" /E /NFL /NDL /NJH /NJS /NP ^
    /XD .git .venv build data logs __pycache__ .tui-test-build ^
    /XF .env *.db *.db-wal *.db-shm *.pid *.log package-lock.json >nul 2>&1

:: Ensure data dir exists with .gitkeep
mkdir "%DIST_DIR%\data" 2>nul
echo. > "%DIST_DIR%\data\.gitkeep"

echo [OK] Files copied

:: ── Step 5: Create zip archive ──
echo [build] Creating zip archive...
set "ZIP_PATH=%ROOT%\build\%DIST_NAME%.zip"

powershell -Command "Compress-Archive -Path '%DIST_DIR%\*' -DestinationPath '%ZIP_PATH%' -Force"
if %errorlevel% neq 0 (
    echo [ERROR] Zip creation failed.
    pause
    exit /b 1
)

:: Get file size
for %%A in ("%ZIP_PATH%") do set "ZIP_SIZE=%%~zA"
set /a "ZIP_MB=%ZIP_SIZE% / 1048576"

echo.
echo  ========================================
echo   Distribution built successfully!
echo  ========================================
echo.
echo   Archive: %ZIP_PATH%
echo   Size:    ~%ZIP_MB% MB
echo.
echo   Contents:
echo     - Source code + compiled dist/
echo     - node_modules (root + memory-engine)
echo     - Pinned Python requirements
echo     - Install scripts (install.bat, install.sh)
echo     - Documentation, skills, server
echo.
echo   To install: unzip, run install.bat
echo.

pause
exit /b 0
