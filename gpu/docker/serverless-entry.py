"""Movie queue worker plus its local Irodori dependency, under one lifetime."""
import signal
import os
import subprocess
import sys

from run_service import COMMANDS, wait_for_irodori
from healthcheck import check_endpoint


def main():
    role = os.environ.get("SERVERLESS_ROLE", "movie")
    if role in {"voice", "toonout"}:
        interpreter = "/opt/venvs/" + ("irodori" if role == "voice" else "toonout") + "/bin/python"
        os.execv(interpreter, [interpreter, "-m", "service_serverless"])
    if role != "movie":
        raise ValueError("SERVERLESS_ROLE must be movie, voice or toonout.")
    tts = subprocess.Popen(COMMANDS["irodori"])
    worker = None
    stopping = False

    def stop(_signum=None, _frame=None):
        nonlocal stopping
        stopping = True
        if worker is not None and worker.poll() is None:
            worker.terminate()
        if tts.poll() is None:
            tts.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        def check_dependency(*args):
            if stopping or tts.poll() is not None:
                raise SystemExit(1)
            return check_endpoint(*args)

        wait_for_irodori(check=check_dependency)
        worker = subprocess.Popen(["/opt/venvs/movie/bin/python", "-m", "movie_worker.serverless"])
        while True:
            try:
                return worker.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if tts.poll() is not None:
                    return 1
    finally:
        stop()
        for child in (worker, tts):
            if child is not None:
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    sys.exit(main())
