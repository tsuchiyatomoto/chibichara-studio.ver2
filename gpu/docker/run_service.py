"""Select the interpreter and wait for TTS before resuming Movie jobs."""

import os
import sys
import time

from healthcheck import check_endpoint

COMMANDS = {
    "irodori": [
        "/opt/venvs/irodori/bin/python", "-m", "irodori_openai_tts",
        "--host", "0.0.0.0", "--port", "8088",
    ],
    "movie": [
        "/opt/venvs/movie/bin/python", "-m", "uvicorn", "movie_worker.server:app",
        "--host", "0.0.0.0", "--port", "8090", "--workers", "1",
    ],
    "toonout": [
        "/opt/venvs/toonout/bin/python", "-m", "uvicorn", "toonout_worker.server:app",
        "--host", "0.0.0.0", "--port", "8091", "--workers", "1",
    ],
}


def wait_for_irodori(*, timeout=1800, check=check_endpoint, sleep=time.sleep, clock=time.monotonic):
    deadline = clock() + timeout
    while True:
        try:
            check("irodori", "http://127.0.0.1:8088/health", os.environ["IRODORI_API_KEY"])
            return
        except RuntimeError:
            if clock() >= deadline:
                raise RuntimeError("Timed out waiting for the Irodori API.") from None
            sleep(2)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        raise SystemExit("Choose a service: irodori, movie, toonout.")
    service = sys.argv[1]
    if service == "movie":
        print("Waiting for the Irodori API before starting Movie.", flush=True)
        wait_for_irodori()
    command = COMMANDS[service]
    os.execv(command[0], command)


if __name__ == "__main__":
    main()
