$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
# A fresh, explicitly scoped directory avoids Windows temp ACL problems and deletion.
$testRoot = Join-Path $projectRoot (".movie-data/tests/" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Split-Path -Parent $testRoot) -Force | Out-Null
& .movie-venv/Scripts/python.exe -m pytest movie_worker/tests -q --basetemp $testRoot
exit $LASTEXITCODE
