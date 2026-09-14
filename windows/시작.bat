@echo off
chcp 65001 >nul
title 이우드림무역 자금관리
cd /d "%~dp0.."

echo.
echo   ============================================
echo    이우드림무역 자금관리
echo   ============================================
echo.

docker info >nul 2>&1
if errorlevel 1 goto nodocker

if not exist ".env.docker" copy ".env.docker.example" ".env.docker" >nul

echo   프로그램을 준비합니다.
echo   처음에는 5~10분, 다음부터는 20초쯤 걸립니다.
echo.

docker compose --env-file .env.docker up -d --build
if errorlevel 1 goto failed

echo.
echo   화면이 열릴 때까지 기다립니다...

set /a n=0
:wait
set /a n+=1
powershell -NoProfile -Command "try{ Invoke-WebRequest http://localhost:3000/login -UseBasicParsing -TimeoutSec 3 ^> $null; exit 0 }catch{ exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
if %n% GEQ 120 goto slow
timeout /t 2 /nobreak >nul
goto wait

:ready
for /f "tokens=2 delims==" %%p in ('findstr "SEED_ADMIN_PASSWORD" .env.docker') do set "PW=%%p"
echo.
echo   ============================================
echo    준비되었습니다.
echo.
echo    주소     http://localhost:3000
echo    아이디   admin
echo    비밀번호 %PW%
echo   ============================================
echo.
start "" http://localhost:3000
goto done

:slow
echo.
echo   준비가 조금 오래 걸리고 있습니다.
echo   1~2분 뒤 브라우저에서 http://localhost:3000 을 열어 보세요.
goto done

:nodocker
echo   [!] Docker Desktop 이 실행되어 있지 않습니다.
echo.
echo       1. 시작 메뉴에서 "Docker Desktop" 을 실행하세요.
echo       2. 고래 아이콘이 초록색이 될 때까지 기다리세요 (1~2분).
echo       3. 이 창을 닫고 시작.bat 을 다시 눌러 주세요.
echo.
pause
exit /b 1

:failed
echo.
echo   [!] 실행에 실패했습니다. 위에 나온 메시지를 그대로 알려 주세요.
pause
exit /b 1

:done
echo   끄실 때는 "중지.bat" 을 눌러 주세요.
echo.
pause
