@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
