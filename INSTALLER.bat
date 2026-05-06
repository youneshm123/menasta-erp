@echo off
:: Auto-elevate to admin
net session >nul 2>&1
if %errorLevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

title YEX WEB - Installation
color 0A
cls
echo.
echo  =============================================
echo        YEX WEB - Installation
echo  =============================================
echo.

cd /d "%~dp0"

:: Check Node.js
echo  [1/4] Verification de Node.js...
node -v >nul 2>&1
if %errorLevel% neq 0 (
  echo.
  echo  Node.js n'est pas installe !
  echo  Ouverture du site de telechargement...
  echo  Installez Node.js puis relancez ce fichier.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
node -e "if(parseInt(process.version.slice(1))<22){process.exit(1)}" >nul 2>&1
if %errorLevel% neq 0 (
  echo  Node.js trop ancien. Installez la version 22 ou plus.
  start "" https://nodejs.org/en/download
  pause
  exit /b
)
echo  [OK] Node.js detecte

:: Install dependencies
echo.
echo  [2/4] Installation des dependances...
npm install --silent
echo  [OK] Dependances installees

:: Add yexweb to hosts
echo.
echo  [3/4] Configuration du nom yexweb...
findstr /C:"yexweb" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if %errorLevel% neq 0 (
  echo 127.0.0.1       yexweb >> C:\Windows\System32\drivers\etc\hosts
  echo  [OK] yexweb configure
) else (
  echo  [OK] yexweb deja configure
)

:: Port proxy 80 -> 3000
echo.
echo  [4/4] Configuration du port...
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=80 connectaddress=127.0.0.1 connectport=3000 >nul 2>&1
echo  [OK] Port configure

echo.
echo  =============================================
echo    Installation terminee avec succes !
echo  =============================================
echo.
echo  Lancez YEX WEB.bat pour demarrer l'application
echo  Adresse : http://yexweb
echo.
pause
