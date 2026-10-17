@echo off
setlocal

cd /d "%~dp0"

echo ========================================================
echo             Stopping GitHow Infrastructure
echo ========================================================
echo.

where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed or not in PATH.
    pause
    exit /b 1
)

echo Stopping and removing Docker containers...
docker compose -f infra/docker-compose.yml down

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] GitHow Docker containers stopped successfully.
) else (
    echo.
    echo [ERROR] Failed to stop Docker containers.
)

echo.
pause
