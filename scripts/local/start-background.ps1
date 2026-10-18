param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("dev", "tts", "movie", "toonout")]
    [string]$Service
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")
$services = @{
    dev = @{
        Executable = "node.exe"
        Arguments = @("web/scripts/start-next.mjs", "dev", "--port", "3000")
        Port = 3000
    }
    tts = @{
        Executable = "powershell.exe"
        Arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/local/start-irodori-tts.ps1")
        Port = 8088
    }
    movie = @{
        Executable = "powershell.exe"
        Arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/local/start-movie.ps1")
        Port = 8090
    }
    toonout = @{
        Executable = "powershell.exe"
        Arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/local/start-toonout.ps1")
        Port = 8091
    }
}
$serviceConfig = $services[$Service]
$listener = Get-NetTCPConnection -LocalPort $serviceConfig.Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "Port $($serviceConfig.Port) is already in use. No new process was started."
}

$executablePath = (Get-Command $serviceConfig.Executable -CommandType Application -ErrorAction Stop).Source
$logDirectory = Join-Path $projectRoot "logs/$Service"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPrefix = Join-Path $logDirectory "$Service-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$PID"
$stdoutPath = "$logPrefix.out.log"
$stderrPath = "$logPrefix.err.log"
$serviceProcess = Start-Process -FilePath $executablePath `
    -ArgumentList $serviceConfig.Arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Write-Host "Started $Service (PID $($serviceProcess.Id))."
Write-Host "stdout: $stdoutPath"
Write-Host "stderr: $stderrPath"
