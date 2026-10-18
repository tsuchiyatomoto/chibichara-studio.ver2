# syntax=docker/dockerfile:1.7
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc
FROM ghcr.io/astral-sh/uv:0.13.1 AS uv
FROM ${CUDA_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venvs/irodori \
    HF_HUB_DISABLE_XET=1 \
    HF_HUB_DOWNLOAD_TIMEOUT=600 \
    IRODORI_HF_CHECKPOINT=phasefield-audio/Irodori-TTS-v4.1-Anime \
    IRODORI_MODEL_DEVICE=cuda \
    IRODORI_CODEC_DEVICE=cuda \
    IRODORI_MODEL_PRECISION=fp32 \
    IRODORI_CODEC_PRECISION=fp32 \
    IRODORI_SILENTCIPHER_WATERMARK=false \
    IRODORI_SPEAKER_INVERSION_TRAINING_ROOT=/opt/irodori-training \
    IRODORI_SPEAKER_INVERSION_MAX_STEPS=3000 \
    IRODORI_SPEAKER_INVERSION_MIN_SAMPLES=5 \
    TOONOUT_DEVICE=cuda \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

# Keep Ubuntu packages on the distribution's security update repositories.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates cmake ffmpeg git libgomp1 libsndfile1 \
        pkg-config python3 python3-dev python3-venv supervisor tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/
WORKDIR /opt/chibichara

# Keep dependency installation cached when application source changes.
COPY irodori/pyproject.toml irodori/uv.lock irodori/README.md irodori/LICENSE ./irodori/
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --project irodori --python /usr/bin/python3 --locked --no-dev \
        --no-install-project --extra cu128

COPY docker/requirements-movie-linux.txt docker/requirements-toonout-linux.txt ./docker/
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv venv --python /usr/bin/python3 /opt/venvs/movie \
    && uv pip sync --python /opt/venvs/movie/bin/python --torch-backend cpu \
        docker/requirements-movie-linux.txt \
    && uv venv --python /usr/bin/python3 /opt/venvs/toonout \
    && uv pip sync --python /opt/venvs/toonout/bin/python --torch-backend cu128 \
        docker/requirements-toonout-linux.txt

COPY irodori/src ./irodori/src
# Dependencies are already locked and installed above. Install only the server
# wheel here; re-syncing tries to remove legacy metadata shipped by randomname.
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv pip install --python /opt/venvs/irodori/bin/python --no-deps ./irodori

COPY docker/*.py docker/*.sh docker/supervisord.conf ./docker/
# A wheel alone omits train.py/configs. Vendor the exact revision in uv.lock,
# independently of the temporary uv build cache, for Speaker Inversion.
RUN python3 docker/prepare_training_source.py \
    && chmod +x docker/entrypoint.sh

COPY movie_worker ./movie_worker
COPY toonout_worker ./toonout_worker
COPY worker_jobs.py ./worker_jobs.py

# Import each service with its own interpreter without starting an API,
# downloading model weights, or requiring a GPU during docker build.
RUN /opt/venvs/irodori/bin/python -c "import irodori_openai_tts.runtime, irodori_tts, torch" \
    && /opt/venvs/movie/bin/python -c "import movie_worker.analysis, movie_worker.media, whisperx.alignment, faster_whisper" \
    && /opt/venvs/toonout/bin/python -c "import toonout_worker.model"

EXPOSE 8088 8090 8091
HEALTHCHECK --interval=30s --timeout=15s --start-period=30m --retries=3 \
    CMD ["/usr/bin/python3", "/opt/chibichara/docker/healthcheck.py"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/chibichara/docker/entrypoint.sh"]
