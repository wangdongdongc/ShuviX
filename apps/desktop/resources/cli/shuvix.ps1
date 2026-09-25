# shuvix-cli -- PowerShell shim that runs the bundled Electron binary in node mode.
#
# Required env (injected by ShuviX's command tools):
#   SHUVIX_ELECTRON  absolute path to the Electron binary shipped with ShuviX
#   SHUVIX_CLI_JS    absolute path to the bundled cli.js
#
# PowerShell resolves `shuvix` to this file ahead of shuvix.cmd in the same
# directory. Going through the .cmd would hand every argument to cmd.exe, which
# cuts a multi-line argument (a `--sql "..."` spanning lines) at its first
# newline and reinterprets & | ^ %. Here the arguments reach Electron as argv.
#
# The script runs inside the caller's PowerShell process, so the environment it
# changes would leak into the rest of the caller's command; it is restored in
# `finally`. electron.exe is a GUI-subsystem binary and PowerShell does not wait
# for one unless its output is piped, hence `| Write-Output` -- which also keeps
# the output capturable (`shuvix widget list | ConvertFrom-Json`).

if (-not $env:SHUVIX_ELECTRON -or -not $env:SHUVIX_CLI_JS) {
  [Console]::Error.WriteLine('shuvix-cli: SHUVIX_ELECTRON and SHUVIX_CLI_JS must be set.')
  [Console]::Error.WriteLine('(This wrapper is meant to be invoked from a shell launched by ShuviX.)')
  exit 2
}

$saved = @{
  NODE_OPTIONS         = $env:NODE_OPTIONS
  SHUVIX_NODE_OPTIONS  = $env:SHUVIX_NODE_OPTIONS
  ELECTRON_RUN_AS_NODE = $env:ELECTRON_RUN_AS_NODE
}
$code = 1
try {
  # Save & strip user NODE_OPTIONS to avoid contaminating the embedded node runtime
  # (e.g. global --max-old-space-size, --import loaders, etc.).
  $env:SHUVIX_NODE_OPTIONS = $env:NODE_OPTIONS
  $env:NODE_OPTIONS = $null
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $env:SHUVIX_ELECTRON $env:SHUVIX_CLI_JS @args | Write-Output
  $code = $LASTEXITCODE
} finally {
  foreach ($name in $saved.Keys) {
    # A $null value removes the variable, restoring "was not set"
    [Environment]::SetEnvironmentVariable($name, $saved[$name])
  }
}
exit $code
