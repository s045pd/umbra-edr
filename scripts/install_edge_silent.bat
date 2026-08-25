@echo off
:: Umbra Sensor — Microsoft Edge silent force-install via Enterprise Policy
::
:: This is the OFFLINE template. The umbra-server also serves a
:: pre-filled BAT at /ext/install-edge.bat with the Extension ID and
:: URL already substituted. Use that one if you can reach the server;
:: use this template if you need to ship a script before the server
:: is reachable from the target host.
::
:: SUBSTITUTE the two placeholders below with values from your server,
:: then deploy via login script / RMM / Intune / SCCM:
::
::   <EXTENSION_ID>  — 32-char a-p string. Look at server log line
::                     "ext signing key ready" or GET /ext/updates.xml
::                     and read the appid attribute.
::   <UMBRA_HOST>    — e.g. umbra.acme.example  (no scheme, no path)
::
:: After substitution, the script writes HKLM Edge policies and exits.
:: First run triggers exactly one UAC prompt (HKLM requires admin);
:: subsequent runs are fully silent. The extension installs on the
:: next Edge launch with no install bubble, no review prompt, and the
:: user cannot disable or remove it.

>nul 2>&1 reg query "HKU\S-1-5-19" || (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -WindowStyle Hidden -FilePath '%~f0'" >nul 2>&1
  exit /b
)

setlocal
set "EXTID=<EXTENSION_ID>"
set "UMBRA_HOST=<UMBRA_HOST>"
set "UPDATES_URL=https://%UMBRA_HOST%/ext/updates.xml"

reg add "HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "%EXTID%;%UPDATES_URL%" /f >nul 2>&1
reg add "HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallAllowlist" /v "1" /t REG_SZ /d "%EXTID%" /f >nul 2>&1
reg add "HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallSources"   /v "1" /t REG_SZ /d "https://%UMBRA_HOST%/*" /f >nul 2>&1

:: Block any leftover sideloaded "external" extensions from other deployments.
reg add "HKLM\Software\Policies\Microsoft\Edge" /v "ExternalExtensionsBlocked" /t REG_DWORD /d 1 /f >nul 2>&1

:: Refresh policies. No-op on non-domain machines but harmless.
gpupdate /target:computer /force >nul 2>&1

endlocal
exit /b 0
