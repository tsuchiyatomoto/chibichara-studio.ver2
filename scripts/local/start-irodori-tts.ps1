param(
    [string]$ServerRoot = "",
    [string]$VenvPath = "",
    [string]$DataRoot = "",
    [string]$BindAddress = "127.0.0.1",
    [int]$Port = 8088,
    [ValidateRange(1, 2147483647)]
    [int]$SpeakerInversionSteps = 3000
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")

if (-not $ServerRoot) {
    $ServerRoot = Join-Path $gpuRoot "irodori"
}

if (-not $VenvPath) {
    $VenvPath = if ($env:IRODORI_VENV_DIR) { $env:IRODORI_VENV_DIR }
        elseif (Test-Path -LiteralPath (Join-Path $ServerRoot ".venv/Scripts/python.exe")) { Join-Path $ServerRoot ".venv" }
        else { Join-Path $legacyIrodoriRoot ".venv" }
}
$pythonPath = Join-Path $VenvPath "Scripts/python.exe"

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "Install Irodori dependencies in gpu/irodori, or set IRODORI_VENV_DIR."
}
if (-not $DataRoot) {
    $DataRoot = if ($env:IRODORI_LOCAL_DATA_DIR) { $env:IRODORI_LOCAL_DATA_DIR }
        elseif (Test-Path -LiteralPath (Join-Path $ServerRoot ".env")) { $ServerRoot }
        elseif (Test-Path -LiteralPath (Join-Path $legacyIrodoriRoot ".env")) { $legacyIrodoriRoot }
        else { $ServerRoot }
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
if (-not $env:IRODORI_SPEECH_JOBS_DIR) {
    $env:IRODORI_SPEECH_JOBS_DIR = Join-Path $projectRoot ".speech-jobs"
}

$sourceRoot = Join-Path $ServerRoot "src"
$sourceRoot = "$sourceRoot$([IO.Path]::PathSeparator)$gpuRoot"
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$sourceRoot$([IO.Path]::PathSeparator)$env:PYTHONPATH" } else { $sourceRoot }
Set-Location -LiteralPath $DataRoot
Write-Host "Starting Irodori-TTS-Server at http://${BindAddress}:$Port"
Write-Host "Source: $ServerRoot"
Write-Host "Runtime data: $DataRoot"
Write-Host "Speaker Inversion: $SpeakerInversionSteps steps"
Write-Host "Press Ctrl+C to stop the server."

& $pythonPath -u -m irodori_openai_tts --host $BindAddress --port $Port
exit $LASTEXITCODE
