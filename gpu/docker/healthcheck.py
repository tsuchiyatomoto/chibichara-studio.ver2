"""Check the local APIs without downloading models or synthesizing audio."""

import json
import os
import sys
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

# Health checks are local. Do not forward their private tokens through a proxy.
OPENER = build_opener(ProxyHandler({}))
HEALTH_OWNER = "anon_" + "0" * 32


def check_endpoint(name, url, token):
    headers = {"Authorization": "Bearer " + token}
    if name == "movie":
        headers["X-Movie-Owner"] = HEALTH_OWNER
    request = Request(url, headers=headers)
    try:
        with OPENER.open(request, timeout=3) as response:
            payload = json.load(response)
    except (URLError, OSError, ValueError):
        raise RuntimeError(f"{name}: health endpoint is unavailable or invalid") from None
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        raise RuntimeError(f"{name}: API is not ready")
    if name == "movie" and not payload.get("tts_ready"):
        raise RuntimeError("movie: connection to Irodori is not ready")
    if name == "irodori" and payload.get("speech_jobs") is False:
        raise RuntimeError("irodori: speech job worker is not ready")


def main():
    services = (
        ("irodori", 8088, "IRODORI_API_KEY"),
        ("movie", 8090, "MOVIE_WORKER_TOKEN"),
        ("toonout", 8091, "TOONOUT_WORKER_TOKEN"),
    )
    failures = []
    for name, port, key in services:
        token = os.environ.get(key)
        if not token:
            failures.append(f"{name}: token is not configured")
            continue
        try:
            check_endpoint(name, f"http://127.0.0.1:{port}/health", token)
        except RuntimeError as error:
            failures.append(str(error))
    if failures:
        print("; ".join(failures), file=sys.stderr)
        return 1
    print("Irodori, Movie and ToonOut APIs are ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
