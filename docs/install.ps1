$ErrorActionPreference = 'Stop'

$Repo = 'pcarrier/moo'
$BinDir = if ($env:BIN_DIR) {
  $env:BIN_DIR
}
elseif ($env:MOO_PREFIX) {
  Join-Path $env:MOO_PREFIX 'bin'
}
else {
  Join-Path (Join-Path $HOME '.local') 'bin'
}
$TmpDir = $null
try {
  $Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    'X64' { 'x86_64-pc-windows-msvc'; break }
    default { throw "unsupported Windows architecture: $_" }
  }
  $Release = Invoke-RestMethod -Headers @{ Accept = 'application/vnd.github+json' } -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $LatestTag = [string]$Release.tag_name
  $LatestVersion = $LatestTag -replace '^[^0-9]*', ''
  if (-not $LatestVersion) { throw 'could not determine latest release version' }

  $Dest = Join-Path $BinDir 'moo.exe'
  if (Test-Path -LiteralPath $Dest -PathType Leaf) {
    $InstalledOutput = $null
    $InstalledOk = $false
    try {
      $InstalledOutput = & $Dest --version 2>$null
      $InstalledOk = $LASTEXITCODE -eq 0
    }
    catch {
      $InstalledOk = $false
    }
    if ($InstalledOk) {
      $InstalledVersion = ([string]($InstalledOutput | Select-Object -First 1)) -replace '^[^0-9]*', ''
      if ($InstalledVersion -eq $LatestVersion) {
        Write-Host "moo $LatestVersion is already installed at $Dest"
        return
      }
    }
  }

  $Asset = $Release.assets | Where-Object { $_.name -like "moo-*-$Arch.zip" } | Select-Object -First 1
  if (-not $Asset) { throw "could not find release asset for $Arch" }

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $TmpDir | Out-Null
  $Zip = Join-Path $TmpDir 'moo.zip'
  Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Zip
  Expand-Archive -Path $Zip -DestinationPath $TmpDir -Force
  $Moo = Get-ChildItem -Path $TmpDir -Recurse -Filter moo.exe | Select-Object -First 1
  if (-not $Moo) { throw 'release archive did not contain moo.exe' }
  Copy-Item -Path $Moo.FullName -Destination $Dest -Force
  & $Dest --version *> $null
  if ($LASTEXITCODE -ne 0) { Write-Warning "installed binary did not report a version; try: $Dest serve" }
  Write-Host "installed moo to $Dest"
  if (($env:Path -split ';') -notcontains $BinDir) {
    Write-Host "add $BinDir to PATH, then run: moo serve"
  }
}
finally {
  if ($TmpDir) {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
