@echo off
setlocal

REM Ensure script runs from the repository root directory
cd /d "%~dp0"

echo ========================================================
echo               Starting GitHow Platform
echo ========================================================
echo.

REM 1. Check for required tools
echo [Check] Verifying prerequisites...
where docker >nul 2>&1
if errorlevel 1 goto err_no_docker

docker info >nul 2>&1
if errorlevel 1 goto err_docker_down

where pnpm >nul 2>&1
if errorlevel 1 goto err_no_pnpm

echo [Check] Docker and pnpm verified.

REM 2. Environment file setup
if exist ".env" goto env_ready
echo [.env] .env file not found. Creating from .env.example...
copy .env.example .env >nul || goto error
echo [.env] .env file created successfully.
:env_ready
echo [.env] .env file ready.

REM 3. Install dependencies if needed
if exist "node_modules" goto deps_ready
echo [Dependencies] Installing dependencies via pnpm...
call pnpm install || goto error
:deps_ready
echo [Dependencies] Dependencies verified.

REM 4. Start Docker infrastructure
echo.
echo [Infra] Starting Docker containers - PostgreSQL and Object Storage...
call pnpm infra:up || goto error

REM 5. Wait for PostgreSQL to be ready
echo [Infra] Waiting for PostgreSQL database to be healthy...
set RETRIES=30

:wait_postgres
docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U gitflow -d gitflow >nul 2>&1
if not errorlevel 1 goto postgres_ready

set /a RETRIES=RETRIES-1
if %RETRIES% leq 0 goto err_postgres_timeout
timeout /t 1 /nobreak >nul
goto wait_postgres

:postgres_ready
echo [Infra] PostgreSQL is ready and accepting connections.

REM 6. Run database migrations
echo.
echo [Database] Running database migrations...
call pnpm db:migrate || goto error
echo [Database] Migrations applied successfully!

REM 7. Launch development servers
if /i "%~1"=="--setup-only" goto setup_only_done

echo.
echo ========================================================
echo           All setup complete! Starting servers...
echo.
echo   * Web Frontend (Next.js):     http://localhost:3000
echo   * Backend API (Fastify):      http://localhost:4000
echo   * PostgreSQL Database:        localhost:5433
echo   * Object Storage Console:     http://localhost:9001
echo.
echo   Press Ctrl+C in this terminal anytime to stop.
echo ========================================================
echo.

call pnpm dev || goto error
goto finish

:setup_only_done
echo.
echo [SUCCESS] Setup completed successfully - setup-only mode.
goto finish

:err_no_docker
echo [ERROR] Docker is not installed or not in PATH.
echo Please install and start Docker Desktop: https://www.docker.com/products/docker-desktop/
goto error

:err_docker_down
echo [ERROR] Docker Desktop or daemon is not running.
echo Please launch Docker Desktop and wait until it is running, then re-run this script.
goto error

:err_no_pnpm
echo [ERROR] pnpm is not installed or not in PATH.
echo Please install pnpm: run "npm install -g pnpm" or "corepack enable".
goto error

:err_postgres_timeout
echo [ERROR] PostgreSQL did not become ready within 30 seconds.
goto error

:error
echo.
echo ========================================================
echo [FAILURE] An error occurred during startup.
echo Please review the messages above.
echo ========================================================
echo.
pause
exit /b 1

:finish
echo.
echo GitHow dev processes exited.
pause
exit /b 0
