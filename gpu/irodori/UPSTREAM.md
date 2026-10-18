# Source provenance

This is a vendored working-tree snapshot of the local Irodori-TTS-Server used
by Chibichara Studio. The original MIT license is retained in `LICENSE`.

- Upstream: https://github.com/Aratako/Irodori-TTS-Server
- Local base revision: `3316cef87c11f2f5b2b805f9bf603d6440bf758e`
- Imported on: 2026-10-18
- Includes the existing owner-scoped Voice asset and Speaker Inversion changes.
- Includes the uncommitted Movie snapshot endpoint changes in
  `src/irodori_openai_tts/app.py` and `voice_assets.py`, plus
  `tests/test_movie_snapshot.py`.

The Movie snapshot extension is already applied. Do not reapply
`docs/irodori-movie-snapshot.patch`; that file is retained at the repository root
as a historical patch for the previous standalone checkout.

Only source, tests, dependency locks, examples, upstream deployment files, and
license/documentation were imported. The original checkout, Git metadata,
virtual environment, credentials, model weights, and saved user assets were not
moved or added to version control.

Chibichara integration now adds persistent owner-scoped speech jobs. The shared
queue implementation is `gpu/worker_jobs.py`; launch from the repository's
Windows scripts or the combined `gpu/Dockerfile` so the GPU source root is on
Python's import path. Tests configure this path in `tests/conftest.py`.
The retained upstream standalone Dockerfile does not package this shared module.
