# GPU services

This directory groups the three services intended for one RunPod Pod:

| Source | Port | Python environment |
| --- | --- | --- |
| `irodori/` | 8088 | Irodori-specific environment |
| `movie_worker/` | 8090 | Movie-specific environment |
| `toonout_worker/` | 8091 | ToonOut-specific environment |

Keep their Python environments separate. The currently pinned PyTorch and
Transformers versions differ between services. Movie currently runs ASR and
alignment on CPU, and calls Irodori for synthesis.

Run the Movie and ToonOut modules with this directory as the working directory:

```powershell
python -m uvicorn movie_worker.server:app --host 127.0.0.1 --port 8090 --workers 1
python -m uvicorn toonout_worker.server:app --host 127.0.0.1 --port 8091 --workers 1
```

Each command must use its own Python interpreter. The repository-level
`npm run movie:start` and `npm run toonout:start` commands select the existing
Windows environments automatically. Copy `.env.example` to `.env.local` for
the workers; Irodori uses its own `.env` settings.

Source code is grouped here, but existing local runtime data stays outside the
source folders: `.movie-data/` and `.toonout-data/` at the repository root.
Set `MOVIE_DATA_DIR` and `TOONOUT_DATA_DIR` to absolute persistent data paths
when deploying. Movie passes an absolute voice snapshot path to Irodori, so
both processes must be able to read the same file at the same path.

`npm run tts:start` uses the source in `irodori/src`. It prefers an environment
in `irodori/.venv`, and otherwise reuses the existing sibling
`Irodori-TTS-Server/.venv`. For compatibility, it also reuses that sibling's
`.env` and saved voice data when `irodori/.env` does not exist. Override the
locations with `IRODORI_VENV_DIR` and `IRODORI_LOCAL_DATA_DIR`, or the launcher's
`-VenvPath` and `-DataRoot` parameters. The sibling source is no longer used.

For a fresh Windows environment, install the included Irodori project rather
than cloning a separate server:

```powershell
Set-Location gpu/irodori
uv sync --extra cu128
Copy-Item .env.example .env
```

## RunPod Docker image

Build all three services into one Linux image from the repository root:

```powershell
docker build --platform linux/amd64 -t chibichara-gpu:local ./gpu
```

The image retains separate Python environments, includes the full pinned
Irodori training source, and starts all APIs under Supervisor. Models and user
data live under `/workspace`; tokens and credentials are supplied at runtime.
See [RunPod Docker setup](../docs/runpod-docker.md) for environment settings,
persistent storage, health checks, and Render connection settings. Voice and
background removal use persistent jobs with short HTTP requests; see
[Job API and recovery](../docs/async-jobs.md). Movie keeps its existing job API
and communicates with TTS over Pod-local loopback.
