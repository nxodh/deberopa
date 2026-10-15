# Runs the in-app end-to-end test on Windows. The app is started with a few flag sets, one after the other,
# until one gets as far as the test; the log of every attempt is printed so a failure can be understood.
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Work,
  [int]$TimeoutSec = 150
)
$ErrorActionPreference = "Continue"
$exe = Get-ChildItem $App -Filter "Deberopa Desktop.exe" | Select-Object -First 1
if (-not $exe) { $exe = Get-ChildItem $App -Filter *.exe | Where-Object { $_.Name -notmatch 'unins|elevate|inno|crash' } | Select-Object -First 1 }
if ($exe.VersionInfo.CompanyName -match 'Microsoft') { throw "the executable's file properties still name Microsoft as the company" }
Write-Host "executable: $($exe.FullName)"
$exe.VersionInfo | Format-List FileName, CompanyName, ProductName, LegalCopyright, FileVersion | Out-String | Write-Host

$variants = @(
  @{ name = "default";          flags = @("--disable-gpu") },
  @{ name = "no-sandbox";       flags = @("--disable-gpu", "--no-sandbox") },
  @{ name = "software-render";  flags = @("--disable-gpu", "--disable-software-rasterizer", "--no-sandbox", "--disable-gpu-compositing") },
  @{ name = "in-process-gpu";   flags = @("--in-process-gpu", "--no-sandbox", "--disable-gpu") }
)
$ok = $false
$i = 0
foreach ($v in $variants) {
  $i++
  $tag = "e2e-$i"
  $log = Join-Path $env:RUNNER_TEMP "$tag.log"
  $stdout = Join-Path $env:RUNNER_TEMP "$tag.stdout.txt"
  $stderr = Join-Path $env:RUNNER_TEMP "$tag.stderr.txt"
  $logs = Join-Path $env:RUNNER_TEMP "$tag-logs"
  Remove-Item -Force $log -ErrorAction SilentlyContinue
  $env:DEBEROPA_E2E_LOG = $log
  Write-Host "::group::variant $($v.name)"
  $args = $v.flags + @(
    "--disable-workspace-trust",
    "--user-data-dir", (Join-Path $env:RUNNER_TEMP "$tag-ud"),
    "--extensions-dir", (Join-Path $env:RUNNER_TEMP "$tag-ex"),
    "--extensionDevelopmentPath=$App\resources\app\extensions\deberopa-agent",
    "--extensionTestsPath=$env:GITHUB_WORKSPACE\desktop\test\e2e\index.cjs",
    "--verbose", "--logsPath", $logs,
    "--enable-logging=stderr", "--v=0",
    $Work)
  $p = Start-Process -FilePath $exe.FullName -ArgumentList $args -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null = $p.Handle
  # not -Wait: that also waits for children, and a server that outlives the app would hang the job
  $timedOut = -not $p.WaitForExit($TimeoutSec * 1000)
  if ($timedOut) { Write-Host "the app did not exit in $TimeoutSec s; stopping it"; taskkill /T /F /PID $p.Id | Out-Null }
  Get-Process -Name deberopa -ErrorAction SilentlyContinue | Stop-Process -Force
  $exit = if ($timedOut) { "timeout" } else { $p.ExitCode }
  Write-Host "variant $($v.name): exit $exit"
  if (Test-Path $log) { Write-Host "-- test log"; Get-Content $log } else { Write-Host "-- the test wrote no log" }
  foreach ($f in @($stdout, $stderr)) { if (Test-Path $f) { Write-Host "-- $(Split-Path $f -Leaf) (tail)"; Get-Content $f -Tail 25 } }
  Get-ChildItem $logs -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "   log file: $($_.FullName.Substring($logs.Length)) ($($_.Length) bytes)" }
  $renderer = Get-ChildItem $logs -Recurse -Filter "renderer.log" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($renderer) { Write-Host "-- renderer.log (tail)"; Get-Content $renderer.FullName -Tail 20 }
  $exthost = Get-ChildItem $logs -Recurse -Filter "exthost.log" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exthost) { Write-Host "-- exthost.log (tail)"; Get-Content $exthost.FullName -Tail 40 }
  Write-Host "-- matching lines in all logs"
  Get-ChildItem $logs -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern "\[error\]|uncaught|cannot find|failed to|extensionTests|deberopa-agent|e2e" -ErrorAction SilentlyContinue | Select-Object -First 30 | ForEach-Object { Write-Host $_.Line.Substring(0, [Math]::Min(260, $_.Line.Length)) }
  Write-Host "::endgroup::"
  if ((-not $timedOut) -and $exit -eq 0 -and (Test-Path $log) -and ((Get-Content $log -Raw) -match "\[e2e\].* OK")) {
    Write-Host "variant '$($v.name)' passed"
    $ok = $true
    break
  }
}
# Windows' own account of a crash, if there was one
try {
  Get-WinEvent -FilterHashtable @{ LogName = "Application"; Level = 2; StartTime = (Get-Date).AddMinutes(-30) } -MaxEvents 8 -ErrorAction Stop |
    ForEach-Object { Write-Host "event: $($_.TimeCreated) $($_.ProviderName): $(($_.Message -split "`n")[0..3] -join ' | ')" }
} catch { Write-Host "(no application errors recorded)" }
if (-not $ok) { throw "in-app test failed in every variant" }
