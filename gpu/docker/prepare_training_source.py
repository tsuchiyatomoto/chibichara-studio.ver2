"""Include full training sources at the same Git revision as the locked package."""

import subprocess
import tomllib
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]


def training_source(lock_path):
    with lock_path.open("rb") as stream:
        lock = tomllib.load(stream)
    package = next(item for item in lock["package"] if item["name"] == "irodori-tts")
    url, revision = package["source"]["git"].rsplit("#", 1)
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Irodori must be locked to a full Git commit.")
    return url.split("?", 1)[0], revision


def main():
    url, revision = training_source(APP_ROOT / "irodori/uv.lock")
    target = Path("/opt/irodori-training")
    subprocess.run(["git", "init", str(target)], check=True)
    subprocess.run(["git", "-C", str(target), "remote", "add", "origin", url], check=True)
    subprocess.run([
        "git", "-C", str(target), "fetch", "--depth", "1", "origin", revision
    ], check=True)
    subprocess.run(["git", "-C", str(target), "checkout", "--detach", "FETCH_HEAD"], check=True)
    if not (target / "train.py").is_file() or not (
        target / "configs/train_v4_small_speaker_inversion.yaml"
    ).is_file():
        raise RuntimeError("The pinned Irodori training checkout is incomplete.")


if __name__ == "__main__":
    main()
