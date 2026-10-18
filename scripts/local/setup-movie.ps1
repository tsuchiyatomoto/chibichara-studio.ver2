$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")
Set-Location -LiteralPath $projectRoot
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or -not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw "Install FFmpeg and ffprobe first." }
if (-not (Test-Path -LiteralPath ".movie-venv/Scripts/python.exe")) {
    python -m venv .movie-venv
    if ($LASTEXITCODE -ne 0) { throw "Python 3.12 is required." }
}
& .movie-venv/Scripts/python.exe -m pip install -r gpu/movie_worker/requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Movie dependencies could not be installed." }
Write-Host "Movie environment is ready. The bundled Irodori source includes the Movie snapshot extension."
