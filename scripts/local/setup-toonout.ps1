param(
    [ValidateSet("auto", "cpu", "cu128")]
    [string]$Torch = "auto"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")
$venvPath = if ($env:TOONOUT_VENV_DIR) {
    [System.IO.Path]::GetFullPath($env:TOONOUT_VENV_DIR)
} else {
    "$projectRoot-toonout-venv"
}
$pythonPath = Join-Path $venvPath "Scripts/python.exe"
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv $venvPath
    if ($LASTEXITCODE -ne 0) { throw "Python 3.12 is required." }
}

if ($Torch -eq "auto") {
    $Torch = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { "cu128" } else { "cpu" }
}
$indexUrl = if ($Torch -eq "cu128") {
    "https://download.pytorch.org/whl/cu128"
} else {
    "https://download.pytorch.org/whl/cpu"
}

& $pythonPath -m pip install torch==2.11.0 torchvision==0.26.0 --index-url $indexUrl
if ($LASTEXITCODE -ne 0) { throw "PyTorch ($Torch) could not be installed." }
& $pythonPath -m pip install -r gpu/toonout_worker/requirements.txt
if ($LASTEXITCODE -ne 0) { throw "ToonOut dependencies could not be installed." }

Write-Host "ToonOut environment is ready at $venvPath with $Torch PyTorch."
Write-Host "The pinned model files are downloaded when the worker starts for the first time."
