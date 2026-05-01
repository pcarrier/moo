$ErrorActionPreference = 'Stop'

$Repo = 'pcarrier/moo'
$BinDir = if ($env:BIN_DIR) { $env:BIN_DIR } else { Join-Path $HOME '.local\bin' }
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TmpDir | Out-Null
try {
  $Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    'X64' { 'x86_64-pc-windows-msvc'; break }
    default { throw "unsupported Windows architecture: $_" }
  }
  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $Asset = $Release.assets | Where-Object { $_.name -like "moo-*-$Arch.zip" } | Select-Object -First 1
  if (-not $Asset) { throw "could not find release asset for $Arch" }

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $Zip = Join-Path $TmpDir 'moo.zip'
  Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Zip
  Expand-Archive -Path $Zip -DestinationPath $TmpDir -Force
  $Moo = Get-ChildItem -Path $TmpDir -Recurse -Filter moo.exe | Select-Object -First 1
  if (-not $Moo) { throw 'release archive did not contain moo.exe' }
  Copy-Item -Path $Moo.FullName -Destination (Join-Path $BinDir 'moo.exe') -Force
  Write-Host "installed moo to $(Join-Path $BinDir 'moo.exe')"
  if (($env:Path -split ';') -notcontains $BinDir) {
    Write-Host "add $BinDir to PATH, then run: moo serve"
  }
}
finally {
  Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
