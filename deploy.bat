@echo off
REM NovaCart deploy helper: stage, commit, push, and force-trigger Jenkins.
REM Usage:  deploy "your commit message"

setlocal enabledelayedexpansion

if "%~1"=="" (
    echo.
    echo Usage: deploy.bat "commit message"
    echo.
    exit /b 1
)

set MSG=%~1
set JENKINS_URL=http://localhost:8080
set JOB=novacart-pipeline
set USER=admin
set PASS=e49730d4c15c40cbb4be7334daf60556

echo.
echo ====================================
echo  NovaCart Deploy
echo ====================================
echo.

REM --- 1. Stage everything ---
echo [1/4] Staging changes...
git add -A
if errorlevel 1 goto :error

REM --- 2. Commit ---
echo [2/4] Committing: %MSG%
git commit -m "%MSG%"
if errorlevel 1 (
    echo Nothing to commit, but continuing to trigger build anyway.
)

REM --- 3. Push to GitHub ---
echo [3/4] Pushing to GitHub...
git push
if errorlevel 1 goto :error

REM --- 4. Trigger Jenkins build (so we don't wait for the polling cycle) ---
echo [4/4] Triggering Jenkins pipeline...
for /f "delims=" %%C in ('curl -s -c "%TEMP%\jcrumb.txt" -u %USER%:%PASS% "%JENKINS_URL%/crumbIssuer/api/json"') do set CRUMB_JSON=%%C

REM Extract crumb field and value via Python (works without jq)
for /f "delims=" %%K in ('python -c "import json,sys; d=json.loads(sys.argv[1]); print(d['crumbRequestField']+':'+d['crumb'])" "!CRUMB_JSON!"') do set CRUMB_HEADER=%%K

curl -s -b "%TEMP%\jcrumb.txt" -u %USER%:%PASS% -H "!CRUMB_HEADER!" -X POST "%JENKINS_URL%/job/%JOB%/build" -o nul -w "Build triggered: HTTP %%{http_code}\n"

echo.
echo Done. Watch progress at: %JENKINS_URL%/job/%JOB%/
echo.
exit /b 0

:error
echo.
echo ! Deploy failed. Check the error above.
exit /b 1
