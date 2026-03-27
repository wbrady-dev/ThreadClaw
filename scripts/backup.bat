@echo off
REM ThreadClaw Backup Script (Windows)
REM Creates hot backups of both databases using SQLite VACUUM INTO.
REM Safe to run while services are active (WAL mode).
REM
REM Usage: scripts\backup.bat [backup_dir]
REM Default: %USERPROFILE%\backups\threadclaw\YYYY-MM-DD

setlocal enabledelayedexpansion

set "BACKUP_ROOT=%~1"
if "%BACKUP_ROOT%"=="" set "BACKUP_ROOT=%USERPROFILE%\backups\threadclaw"

REM NOTE: Uses PowerShell for reliable date formatting (adds ~200ms startup cost).
REM Alternatives (%date%) are locale-dependent and unreliable across Windows versions.
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%a"
set "BACKUP_DIR=%BACKUP_ROOT%\%TODAY%"

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo ThreadClaw Backup — %date% %time%
echo Destination: %BACKUP_DIR%
echo.

REM Find databases — read data dir from .env or use default
set "DATA_DIR="
if exist "%~dp0..\.env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /b "THREADCLAW_DATA_DIR=" "%~dp0..\.env" 2^>nul') do (
        set "DATA_DIR=%%b"
    )
)
if "!DATA_DIR!"=="" set "DATA_DIR=%USERPROFILE%\.threadclaw\data"
REM Strip surrounding quotes if present
set "DATA_DIR=!DATA_DIR:"=!"
set "THREADCLAW_DB=!DATA_DIR!\threadclaw.db"
set "MEMORY_DB=!DATA_DIR!\memory.db"
set "GRAPH_DB=!DATA_DIR!\graph.db"

REM Check for sqlite3
where sqlite3 >nul 2>&1
if errorlevel 1 (
    echo   Using file copy for backup ^(sqlite3 CLI not found^)...

    if exist "!THREADCLAW_DB!" (
        echo   Backing up threadclaw.db...
        copy /Y "!THREADCLAW_DB!" "%BACKUP_DIR%\threadclaw.db" >nul
        echo   Done ^(file copy — stop services for consistent backup^)
    )

    if exist "!MEMORY_DB!" (
        echo   Backing up memory.db...
        copy /Y "!MEMORY_DB!" "%BACKUP_DIR%\memory.db" >nul
        echo   Done ^(file copy — stop services for consistent backup^)
    )

    if exist "!GRAPH_DB!" (
        echo   Backing up graph.db...
        copy /Y "!GRAPH_DB!" "%BACKUP_DIR%\graph.db" >nul
        echo   Done ^(file copy — stop services for consistent backup^)
    )

    goto :done
)

REM Backup ThreadClaw knowledge DB
if exist "!THREADCLAW_DB!" (
    echo   Backing up threadclaw.db...
    REM NOTE: VACUUM INTO requires single-quoted path per SQLite syntax.
    REM This means paths with single quotes will fail — not typical on Windows.
    sqlite3 "!THREADCLAW_DB!" "VACUUM INTO '%BACKUP_DIR%\threadclaw.db'"
    echo   Done
) else (
    echo   threadclaw.db not found
)

REM Backup Memory DB
if exist "!MEMORY_DB!" (
    echo   Backing up memory.db...
    sqlite3 "!MEMORY_DB!" "VACUUM INTO '%BACKUP_DIR%\memory.db'"
    echo   Done
) else (
    echo   memory.db not found
)

REM Backup Graph DB
if exist "!GRAPH_DB!" (
    echo   Backing up graph.db...
    sqlite3 "!GRAPH_DB!" "VACUUM INTO '%BACKUP_DIR%\graph.db'"
    echo   Done
) else (
    echo   graph.db not found
)

:done
REM Prune backups older than 30 days
powershell -NoProfile -Command "Get-ChildItem '%BACKUP_ROOT%' -Directory | Where-Object { $_.CreationTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Recurse -Force" 2>nul

echo.
echo Backup complete.
