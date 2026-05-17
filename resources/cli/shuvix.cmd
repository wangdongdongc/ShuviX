@echo off
REM shuvix-cli — Windows shim that runs the bundled Electron binary in node mode.
REM
REM Required env (injected by ShuviX's bash tool):
REM   SHUVIX_ELECTRON  absolute path to the Electron binary shipped with ShuviX
REM   SHUVIX_CLI_JS    absolute path to the bundled cli.js

if "%SHUVIX_ELECTRON%"=="" goto :missingenv
if "%SHUVIX_CLI_JS%"=="" goto :missingenv

set "SHUVIX_NODE_OPTIONS=%NODE_OPTIONS%"
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE=1"
"%SHUVIX_ELECTRON%" "%SHUVIX_CLI_JS%" %*
exit /b %ERRORLEVEL%

:missingenv
echo shuvix-cli: SHUVIX_ELECTRON and SHUVIX_CLI_JS must be set.>&2
echo (This wrapper is meant to be invoked from a shell launched by ShuviX.)>&2
exit /b 2
