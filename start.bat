@echo off
:: Auto-elevate to admin
net session >nul 2>&1
if %errorLevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

title YEX WEB
echo.
echo   YEX WEB - Demarrage...
echo.
cd /d "%~dp0"

:: Add yexweb to hosts if not already there
findstr /C:"yexweb" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if %errorLevel% neq 0 (
  echo 127.0.0.1       yexweb >> C:\Windows\System32\drivers\etc\hosts
  echo   [OK] yexweb ajoute au hosts
)

if not exist node_modules (
  echo   Installation des dependances npm...
  npm install
  echo.
)

echo   Application demarree sur http://yexweb
echo   Appuyez sur Ctrl+C pour arreter
echo.

start "" http://yexweb
node server.js
pause
