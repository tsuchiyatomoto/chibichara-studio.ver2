param([int]$Port = 8090)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot ".movie-venv/Scripts/python.exe"
if (-not (Test-Path -LiteralPath $pythonPath)) { throw "Run npm run movie:setup first." }
$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:HF_HUB_DOWNLOAD_TIMEOUT = "600"
$env:PYTHONUTF8 = "1"
Set-Location -LiteralPath $projectRoot
& $pythonPath -m uvicorn movie_worker.server:app --host 127.0.0.1 --port $Port --workers 1
exit $LASTEXITCODE
