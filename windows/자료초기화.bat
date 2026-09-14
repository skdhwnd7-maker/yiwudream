@echo off
chcp 65001 >nul
title 이우드림무역 자금관리 - 자료 초기화
cd /d "%~dp0.."
echo.
echo   ============================================
echo    시연 자료를 처음 상태로 되돌립니다.
echo   ============================================
echo.
echo   지금까지 입력하신 내용이 모두 사라집니다.
echo   정말 초기화하시려면 아무 키나 누르세요.
echo   아니면 이 창을 그냥 닫으세요.
echo.
pause
docker compose --env-file .env.docker down -v
echo.
echo   비웠습니다. "시작.bat" 을 누르면 새 시연 자료로 다시 시작합니다.
echo.
pause
