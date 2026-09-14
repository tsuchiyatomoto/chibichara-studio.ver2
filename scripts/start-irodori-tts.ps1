param(
    [string]$ServerRoot = "",
    [string]$BindAddress = "127.0.0.1",
    [int]$Port = 8088,
    [ValidateRange(1, 2147483647)]
    [int]$SpeakerInversionSteps = 3000
)

$ErrorActionPreference = "Stop"

if (-not $ServerRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $devRoot = Split-Path -Parent $projectRoot
    $ServerRoot = Join-Path $devRoot "Irodori-TTS-Server"
}

$pythonPath = Join-Path $ServerRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "Irodori-TTS-Server is not installed at $ServerRoot"
}

try {
    $health = Invoke-RestMethod -Uri "http://${BindAddress}:$Port/health" -TimeoutSec 2

    if ($health.status -eq "ok") {
        Write-Host "Irodori-TTS-Server is already running at http://${BindAddress}:$Port"
        exit 0
    }
} catch {
    # No healthy server is listening yet, so start one below.
}

$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:HF_HUB_DOWNLOAD_TIMEOUT = "600"
$env:IRODORI_SPEAKER_INVERSION_MAX_STEPS = [string]$SpeakerInversionSteps

Set-Location $ServerRoot
Write-Host "Starting Irodori-TTS-Server at http://${BindAddress}:$Port"
Write-Host "Speaker Inversion: $SpeakerInversionSteps steps"
Write-Host "Press Ctrl+C to stop the server."

& $pythonPath -u -m irodori_openai_tts --host $BindAddress --port $Port
exit $LASTEXITCODE
