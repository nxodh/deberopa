# Vedecaps installer for Windows (Windows PowerShell 5.1 and PowerShell 7+).
#   irm https://raw.githubusercontent.com/nxodh/vedecaps/main/install.ps1 | iex
#
# Environment:
#   VEDECAPS_VERSION         version to install (default: latest release), e.g. 0.1.0
#   VEDECAPS_INSTALL_DIR     where the binary goes (default: %LOCALAPPDATA%\vedecaps\bin)
#   VEDECAPS_NO_MODIFY_PATH  set to 1 to leave the user PATH untouched

# Wrapped in a script block so a truncated download cannot run half a script.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow on 5.1
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  $repo = 'nxodh/vedecaps'
  $base = if ($env:VEDECAPS_RELEASE_URL) { $env:VEDECAPS_RELEASE_URL.TrimEnd('/') } else { "https://github.com/$repo/releases" }
  $installDir = if ($env:VEDECAPS_INSTALL_DIR) { $env:VEDECAPS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'vedecaps\bin' }

  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -eq 'ARM64') {
    Write-Host 'Note: installing the x64 build; Windows on ARM runs it through emulation.'
  } elseif ($arch -ne 'AMD64') {
    throw "Unsupported CPU architecture: $arch (a 64-bit Windows is required)."
  }

  $version = $env:VEDECAPS_VERSION
  if (-not $version) {
    # Read the redirect of /releases/latest instead of calling the rate-limited API.
    $request = [Net.HttpWebRequest]::Create("$base/latest")
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'vedecaps-install'
    $response = $null
    try { $response = $request.GetResponse() } catch [Net.WebException] { $response = $_.Exception.Response }
    $location = if ($response) { $response.Headers['Location'] } else { $null }
    if ($response) { $response.Close() }
    if ($location -match '/tag/v?([^/?#]+)') { $version = $Matches[1] }
    if (-not $version) { throw "Could not determine the latest version. Set `$env:VEDECAPS_VERSION, or see https://github.com/$repo/releases" }
  }
  $version = $version.TrimStart('v')

  $asset = 'vedecaps-windows-x64.zip'
  $url = "$base/download/v$version"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("vedecaps-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Write-Host "Downloading vedecaps $version (windows-x64)"
    $zip = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'checksums.txt'
    Invoke-WebRequest -Uri "$url/$asset" -OutFile $zip -UseBasicParsing
    Invoke-WebRequest -Uri "$url/checksums.txt" -OutFile $sums -UseBasicParsing

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0] }
    }
    if (-not $expected) { throw "checksums.txt has no entry for $asset" }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "Checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed." }

    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $fresh = Join-Path $tmp 'vedecaps.exe'
    if (-not (Test-Path -LiteralPath $fresh)) { throw 'The archive did not contain vedecaps.exe' }
    & $fresh --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The downloaded binary does not run on this system.' }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $target = Join-Path $installDir 'vedecaps.exe'
    if (Test-Path -LiteralPath $target) {
      # A running executable cannot be overwritten, but it can be renamed out of the way.
      $old = "$target.old"
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $target -Destination $old -Force
    }
    Copy-Item -LiteralPath $fresh -Destination $target -Force
    Remove-Item -LiteralPath "$target.old" -Force -ErrorAction SilentlyContinue
    Write-Host "Installed $target"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @()
  if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
  $present = $entries | Where-Object { $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') }
  if (-not $present) {
    if ($env:VEDECAPS_NO_MODIFY_PATH -eq '1') {
      Write-Host "Add $installDir to your PATH to use it."
    } else {
      [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';'), 'User')
      Write-Host "Added $installDir to your user PATH (open a new terminal for it to take effect)."
    }
  }
  if (($env:Path -split ';') -notcontains $installDir) { $env:Path = "$env:Path;$installDir" }

  Write-Host ''
  Write-Host "Run 'vedecaps' in a project directory to start."
  Write-Host "First time? Connect a model provider with 'vedecaps auth login'."
}
