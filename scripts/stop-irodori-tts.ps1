param(
    [int]$Port = 8088
)

$ErrorActionPreference = "Stop"

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if (-not $listeners) {
    Write-Host "Irodori-TTS-Server is not running on port $Port."
    exit 0
}

$serverProcessIds = $listeners.OwningProcess | Sort-Object -Unique

foreach ($serverProcessId in $serverProcessIds) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"

    if (-not $processInfo.CommandLine -or $processInfo.CommandLine -notmatch "irodori_openai_tts") {
        throw "Port $Port is owned by a different process (PID $serverProcessId). It was not stopped."
    }

    Stop-Process -Id $serverProcessId -Force
    Write-Host "Stopped Irodori-TTS-Server (PID $serverProcessId)."
}
