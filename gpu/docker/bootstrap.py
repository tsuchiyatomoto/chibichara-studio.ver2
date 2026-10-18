"""Prepare private runtime storage, then hand process management to Supervisor."""

import json
import os
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]


def prepare_environment(env, *, secrets_root=Path("/run/chibichara")):
    for name in ("IRODORI_API_KEY", "MOVIE_WORKER_TOKEN", "TOONOUT_WORKER_TOKEN"):
        value = env.get(name, "")
        if not value or value != value.strip():
            raise ValueError(f"Set {name} to a nonempty token without surrounding whitespace.")
    env.setdefault("IRODORI_TTS_API_KEY", env["IRODORI_API_KEY"])
    if env["IRODORI_TTS_API_KEY"] != env["IRODORI_API_KEY"]:
        raise ValueError("IRODORI_TTS_API_KEY must match IRODORI_API_KEY.")
    env.setdefault("IRODORI_TTS_BASE_URL", "http://127.0.0.1:8088")

    data_root = Path(env.get("CHIBICHARA_DATA_ROOT", "/workspace/data"))
    defaults = {
        "MOVIE_DATA_DIR": data_root / "movie",
        "TOONOUT_DATA_DIR": data_root / "toonout",
        "IRODORI_VOICES_DIR": data_root / "irodori/voices",
        "IRODORI_VOICE_ASSETS_DIR": data_root / "irodori/voice-assets",
        "IRODORI_SPEAKER_INVERSION_JOBS_DIR": data_root / "irodori/speaker-inversion-jobs",
        "IRODORI_SPEECH_JOBS_DIR": data_root / "irodori/speech-jobs",
        "HF_HOME": Path("/workspace/cache/huggingface"),
        "TORCH_HOME": Path("/workspace/cache/torch"),
        "XDG_CACHE_HOME": Path("/workspace/cache"),
        "TMPDIR": Path("/workspace/tmp"),
    }
    for name, default in defaults.items():
        env.setdefault(name, str(default))
        directory = Path(env[name])
        if not directory.is_absolute():
            raise ValueError(f"{name} must be an absolute path.")
    # Validate before creating any runtime directories.
    credentials = env.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if credentials:
        if env.get("GOOGLE_APPLICATION_CREDENTIALS"):
            raise ValueError("Set only one Google credential input: JSON or file path.")
        try:
            payload = json.loads(credentials)
            if not isinstance(payload, dict) or payload.get("type") != "service_account":
                raise ValueError
            if not payload.get("private_key") or not payload.get("client_email"):
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid service-account JSON.") from None
    elif env.get("GOOGLE_APPLICATION_CREDENTIALS"):
        if not Path(env["GOOGLE_APPLICATION_CREDENTIALS"]).is_file():
            raise ValueError("GOOGLE_APPLICATION_CREDENTIALS must point to an existing file.")

    for name in defaults:
        Path(env[name]).mkdir(parents=True, exist_ok=True, mode=0o700)
    secrets_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if credentials:
        target = secrets_root / "google-service-account.json"
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(credentials)
        os.chmod(target, 0o600)
        env["GOOGLE_APPLICATION_CREDENTIALS"] = str(target)
        # Children only need the file, not another copy of the private key.
        del env["GOOGLE_SERVICE_ACCOUNT_JSON"]


def main():
    try:
        prepare_environment(os.environ)
        training_root = Path(os.environ["IRODORI_SPEAKER_INVERSION_TRAINING_ROOT"])
        if not (training_root / "train.py").is_file() or not (
            training_root / "configs/train_v4_small_speaker_inversion.yaml"
        ).is_file():
            raise ValueError("The configured Irodori training source is incomplete.")
    except (ValueError, KeyError, OSError) as error:
        # Never include environment values or credential JSON in startup logs.
        print(f"Container initialization failed: {error}", file=sys.stderr)
        return 1
    os.chdir(APP_ROOT)
    command = sys.argv[1:] or [
        "/usr/bin/supervisord", "-c", str(APP_ROOT / "docker/supervisord.conf")
    ]
    os.execvp(command[0], command)


if __name__ == "__main__":
    sys.exit(main())
