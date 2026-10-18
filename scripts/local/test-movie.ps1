$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")
Set-Location -LiteralPath $gpuRoot
# A fresh, explicitly scoped directory avoids Windows temp ACL problems and deletion.
$testRoot = Join-Path $projectRoot (".movie-data/tests/" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Split-Path -Parent $testRoot) -Force | Out-Null
$pythonPath = Join-Path $projectRoot ".movie-venv/Scripts/python.exe"
& $pythonPath -m pytest movie_worker/tests -q --basetemp $testRoot
exit $LASTEXITCODE
