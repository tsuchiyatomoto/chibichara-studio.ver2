# Shared locations for Windows development. Runtime data and virtual environments
# stay outside web/ so Next.js does not watch or bundle them.
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$webRoot = Join-Path $projectRoot "web"
$gpuRoot = Join-Path $projectRoot "gpu"
$legacyIrodoriRoot = Join-Path (Split-Path -Parent $projectRoot) "Irodori-TTS-Server"
