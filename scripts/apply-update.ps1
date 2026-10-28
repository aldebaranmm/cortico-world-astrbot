# Apply an already-downloaded update: stop Coopanion, overwrite the extension, restart.
# Called detached from the extension; runs after Coopanion has quit.
param(
    [Parameter(Mandatory=$true)][string]$ZipPath,
    [Parameter(Mandatory=$true)][string]$ExtDir,
    [Parameter(Mandatory=$true)][string]$CoopRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 1. stop any Coopanion process under the app root
$procs = Get-Process | Where-Object { $_.Path -and $_.Path -like "$CoopRoot*" }
foreach ($p in $procs) {
    try { $p.Kill() } catch {}
}
Start-Sleep -Seconds 2

# 2. unpack the zip (zip root is cortico-world-astrbot/)
$unpack = Join-Path $env:TEMP 'cortico-update-unpack'
if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
Expand-Archive -Path $ZipPath -DestinationPath $unpack -Force
$src = Join-Path $unpack 'cortico-world-astrbot'
if (-not (Test-Path $src)) {
    Write-Output "UNEXPECTED_ZIP_LAYOUT"
    exit 1
}

# 3. overwrite the extension directory
Copy-Item "$src\*" -Destination $ExtDir -Recurse -Force

# 4. restart Coopanion
$exe = Get-ChildItem $CoopRoot -Filter '*.exe' | Sort-Object Name | Select-Object -First 1
if ($exe) {
    Start-Process $exe.FullName
    Write-Output "RESTARTED"
} else {
    Write-Output "UPDATED_NO_EXE"
}
