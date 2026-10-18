$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")
Set-Location -LiteralPath $projectRoot
$pythonPath = Join-Path $projectRoot ".movie-venv/Scripts/python.exe"
$testRoot = Join-Path $projectRoot (".diagnostics/job-tests/" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Split-Path -Parent $testRoot) -Force | Out-Null
& $pythonPath -m pytest gpu/tests -q --basetemp $testRoot
exit $LASTEXITCODE
