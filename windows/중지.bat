@echo off
chcp 65001 >nul
title 이우드림무역 자금관리 - 중지
cd /d "%~dp0.."
echo.
echo   프로그램을 멈춥니다...
docker compose --env-file .env.docker stop
echo.
echo   멈췄습니다. 입력하신 자료는 그대로 남아 있습니다.
echo   다시 쓰시려면 "시작.bat" 을 눌러 주세요.
echo.
pause
