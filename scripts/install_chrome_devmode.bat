@echo off
:: Umbra Sensor — Chrome manual install helper (developer-mode unpacked)
::
:: Chrome 67+ refuses any non-Web-Store CRX (CRX_REQUIRED_PROOF_MISSING)
:: on personal / non-managed machines. The only workable manual path on
:: a stock personal Chrome is "Load unpacked" via developer mode.
::
:: This script:
::   1. Takes a ZIP downloaded from the Umbra panel (Extension Download)
::      as its argument.
::   2. Extracts it to %LOCALAPPDATA%\Umbra\extension (clobbering any
::      previous install at that path).
::   3. Opens chrome://extensions so the user can finish the four manual
::      clicks Chrome forces on us.
::
:: Usage:
::   install_chrome_devmode.bat path\to\umbra-extension.zip
::   (or just drag the .zip onto this .bat)
::
:: Caveat the user should hear up front: every Chrome launch will show a
:: "Disable developer mode extensions" warning bubble. Personal Chrome
:: cannot suppress this. If that warning is unacceptable, deploy via
:: Edge instead — see docs/deployment.md.

setlocal
set "ZIP=%~1"
if "%ZIP%"=="" (
  echo Usage: install_chrome_devmode.bat ^<umbra-extension.zip^>
  echo.
  echo Drag the ZIP downloaded from the Umbra panel onto this script,
  echo or call this script with the ZIP path as an argument.
  pause
  exit /b 1
)
if not exist "%ZIP%" (
  echo [ERROR] File not found: %ZIP%
  pause
  exit /b 1
)

set "DEST=%LOCALAPPDATA%\Umbra\extension"

if exist "%DEST%" rd /s /q "%DEST%"
mkdir "%DEST%" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -Path '%ZIP%' -DestinationPath '%DEST%' -Force" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Extract failed
  pause
  exit /b 1
)

:: Some panel exports nest the extension under a single subdirectory.
:: Flatten if needed so manifest.json sits at the dest root.
for /d %%D in ("%DEST%\*") do (
  if exist "%%D\manifest.json" (
    xcopy "%%D\*" "%DEST%\" /E /I /Y >nul
    rd /s /q "%%D"
  )
)

if not exist "%DEST%\manifest.json" (
  echo [ERROR] manifest.json not found after extract; ZIP may be corrupted
  pause
  exit /b 1
)

echo [OK] Extension staged at: %DEST%
echo.
echo Now finish the manual install in Chrome:
echo   1. The browser will open chrome://extensions
echo   2. Toggle "Developer mode" (top right)
echo   3. Click "Load unpacked"
echo   4. Select this folder: %DEST%
echo.
echo NOTE: Chrome will warn about developer-mode extensions on every
echo launch. This warning cannot be suppressed on personal Chrome.
echo If unacceptable, deploy via Edge instead.
echo.
pause

start chrome.exe chrome://extensions/

endlocal
exit /b 0
