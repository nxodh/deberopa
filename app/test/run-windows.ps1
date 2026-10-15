# Runs the app smoke test on Windows and prints what it logged. Electron is a GUI program: wait on
# the process itself, with a time limit, and kill what is left (the agent it started).
param([int]$TimeoutSeconds = 240)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = (node -p "require('electron')" 2>$null | Select-Object -Last 1)
if (-not $exe -or -not (Test-Path $exe)) { Write-Host "Electron binary not found (run: node node_modules/electron/install.js)"; exit 1 }
Write-Host "electron: $exe"
$log = Join-Path $env:RUNNER_TEMP "app-test.log"
$out = Join-Path $env:RUNNER_TEMP "app-test.out"
$err = Join-Path $env:RUNNER_TEMP "app-test.err"
Remove-Item $log, $out, $err -ErrorAction SilentlyContinue
$env:DEBEROPA_APP_TEST = "1"
$env:DEBEROPA_APP_TEST_LOG = $log
$env:DEBEROPA_APP_SHOTS = Join-Path $env:RUNNER_TEMP "app-shots"

$p = Start-Process -FilePath $exe -ArgumentList @(".", "--no-sandbox", "--disable-gpu") -WorkingDirectory $root -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
  Write-Host "timed out after $TimeoutSeconds s; killing"
  taskkill /F /T /PID $p.Id | Out-Null
}
Write-Host "---- exit code: $($p.ExitCode)"
Write-Host "---- app-test log"
if (Test-Path $log) { Get-Content $log } else { Write-Host "(no log written)" }
Write-Host "---- stdout"; if (Test-Path $out) { Get-Content $out | Select-Object -Last 30 }
Write-Host "---- stderr"; if (Test-Path $err) { Get-Content $err | Select-Object -Last 30 }
if (-not (Test-Path $log) -or -not (Select-String -Path $log -Pattern "\[app-test\].* OK$" -Quiet)) {
  Write-Host "the app test did not report OK"
  exit 1
}
