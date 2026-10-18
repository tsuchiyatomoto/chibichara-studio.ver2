param([int]$Port = 8091)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")
$venvPath = if ($env:TOONOUT_VENV_DIR) {
    [System.IO.Path]::GetFullPath($env:TOONOUT_VENV_DIR)
} else {
    "$projectRoot-toonout-venv"
}
$pythonPath = Join-Path $venvPath "Scripts/python.exe"
if (-not (Test-Path -LiteralPath $pythonPath)) { throw "Run npm run toonout:setup first." }

$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:HF_HUB_DOWNLOAD_TIMEOUT = "600"
$env:PYTHONUTF8 = "1"
Set-Location -LiteralPath $gpuRoot
& $pythonPath -m uvicorn toonout_worker.server:app --host 127.0.0.1 --port $Port --workers 1
exit $LASTEXITCODE
