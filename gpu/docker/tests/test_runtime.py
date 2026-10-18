import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bootstrap
import healthcheck
import prepare_training_source
import run_service


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.secrets = self.root / "run"
        self.env = {
            "IRODORI_API_KEY": "private-tts-token",
            "MOVIE_WORKER_TOKEN": "private-movie-token",
            "TOONOUT_WORKER_TOKEN": "private-toonout-token",
            "CHIBICHARA_DATA_ROOT": str(self.root / "data"),
            "HF_HOME": str(self.root / "cache/huggingface"),
            "TORCH_HOME": str(self.root / "cache/torch"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "TMPDIR": str(self.root / "tmp"),
        }

    def prepare(self):
        bootstrap.prepare_environment(self.env, secrets_root=self.secrets)

    def test_existing_voice_and_movie_data_survive_reinitialization(self):
        self.prepare()
        voice = Path(self.env["IRODORI_VOICE_ASSETS_DIR"]) / "saved.speaker.safetensors"
        movie = Path(self.env["MOVIE_DATA_DIR"]) / "output.mp4"
        voice.write_bytes(b"saved-voice")
        movie.write_bytes(b"saved-movie")
        self.prepare()
        self.assertEqual(voice.read_bytes(), b"saved-voice")
        self.assertEqual(movie.read_bytes(), b"saved-movie")
        self.assertEqual(self.env["IRODORI_TTS_API_KEY"], self.env["IRODORI_API_KEY"])
        self.assertEqual(self.env["IRODORI_TTS_BASE_URL"], "http://127.0.0.1:8088")

    def test_missing_service_token_fails_before_creating_data(self):
        del self.env["TOONOUT_WORKER_TOKEN"]
        with self.assertRaisesRegex(ValueError, "TOONOUT_WORKER_TOKEN"):
            self.prepare()
        self.assertFalse((self.root / "data").exists())

    def test_different_internal_tts_key_is_rejected_without_disclosing_it(self):
        self.env["IRODORI_TTS_API_KEY"] = "wrong-private-key"
        with self.assertRaises(ValueError) as error:
            self.prepare()
        self.assertNotIn("wrong-private-key", str(error.exception))
        self.assertFalse((self.root / "data").exists())

    def test_relative_snapshot_directory_is_rejected(self):
        self.env["MOVIE_DATA_DIR"] = "relative-movie"
        with self.assertRaisesRegex(ValueError, "MOVIE_DATA_DIR"):
            self.prepare()
        self.assertFalse((self.root / "data").exists())

    def test_explicit_absolute_movie_directory_is_preserved(self):
        custom = self.root / "shared-snapshots"
        self.env["MOVIE_DATA_DIR"] = str(custom)
        self.prepare()
        self.assertTrue(custom.is_dir())
        self.assertEqual(self.env["MOVIE_DATA_DIR"], str(custom))

    def test_json_credential_is_private_and_not_placed_in_persistent_data(self):
        credential = json.dumps({
            "type": "service_account", "client_email": "test@example.invalid",
            "private_key": "private-test-material",
        })
        self.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = credential
        self.prepare()
        path = Path(self.env["GOOGLE_APPLICATION_CREDENTIALS"])
        self.assertEqual(path.parent, self.secrets)
        self.assertEqual(path.read_text(encoding="utf-8"), credential)
        self.assertNotIn("GOOGLE_SERVICE_ACCOUNT_JSON", self.env)
        if os.name == "posix":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_invalid_credential_error_does_not_include_secret_material(self):
        self.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "invalid-private-material"
        with self.assertRaises(ValueError) as error:
            self.prepare()
        self.assertNotIn("invalid-private-material", str(error.exception))
        self.assertFalse(self.secrets.exists())

    def test_two_credential_sources_are_rejected(self):
        self.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "{}"
        self.env["GOOGLE_APPLICATION_CREDENTIALS"] = str(self.root / "key.json")
        with self.assertRaisesRegex(ValueError, "only one"):
            self.prepare()


class HealthcheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer test-token":
                    self.send_error(401)
                    return
                if self.path.startswith("/movie") and self.headers.get("X-Movie-Owner") != healthcheck.HEALTH_OWNER:
                    self.send_error(401)
                    return
                if self.path == "/unavailable":
                    self.send_error(503)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if self.path == "/invalid":
                    self.wfile.write(b"not-json")
                else:
                    self.wfile.write(json.dumps({
                        "status": "loading" if self.path == "/loading" else "ok",
                        "tts_ready": self.path != "/movie-disconnected",
                        "voice_available": False,
                    }).encode())

            def log_message(self, *_args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_authenticated_apis_do_not_need_saved_voices_to_be_healthy(self):
        for name, path in (("irodori", "/"), ("movie", "/movie"), ("toonout", "/")):
            with self.subTest(service=name):
                healthcheck.check_endpoint(name, self.url + path, "test-token")

    def test_failed_or_loading_services_are_unhealthy(self):
        for path in ("/unavailable", "/invalid", "/loading"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                healthcheck.check_endpoint("toonout", self.url + path, "test-token")

    def test_incorrect_token_is_not_reported_in_error(self):
        with self.assertRaises(RuntimeError) as error:
            healthcheck.check_endpoint("irodori", self.url + "/", "secret-wrong-token")
        self.assertNotIn("secret-wrong-token", str(error.exception))

    def test_movie_requires_a_working_tts_connection(self):
        with self.assertRaisesRegex(RuntimeError, "connection to Irodori"):
            healthcheck.check_endpoint("movie", self.url + "/movie-disconnected", "test-token")

    def test_healthcheck_exit_status_reports_any_failed_service(self):
        with patch.dict(os.environ, {
            "IRODORI_API_KEY": "test-token", "MOVIE_WORKER_TOKEN": "test-token",
            "TOONOUT_WORKER_TOKEN": "test-token",
        }), patch.object(healthcheck, "check_endpoint", side_effect=[None, None, RuntimeError("toonout unavailable")]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(healthcheck.main(), 1)


class StartupDependencyTests(unittest.TestCase):
    def test_movie_waits_until_irodori_responds(self):
        calls = []

        def check(*args):
            calls.append(args)
            if len(calls) < 3:
                raise RuntimeError("loading")

        now = [0]
        with patch.dict(os.environ, {"IRODORI_API_KEY": "test-token"}):
            run_service.wait_for_irodori(
                timeout=20, check=check, clock=lambda: now[0],
                sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
            )
        self.assertEqual(len(calls), 3)
        self.assertEqual(now[0], 4)

    def test_startup_wait_has_a_deadline(self):
        def check(*_args):
            raise RuntimeError("unavailable")

        now = [0]
        with patch.dict(os.environ, {"IRODORI_API_KEY": "test-token"}), self.assertRaisesRegex(RuntimeError, "Timed out"):
            run_service.wait_for_irodori(
                timeout=3, check=check, clock=lambda: now[0],
                sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
            )


class TrainingSourceTests(unittest.TestCase):
    def test_training_checkout_uses_the_dependency_lock_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "uv.lock"
            revision = "a" * 40
            lock.write_text(
                '[[package]]\nname = "irodori-tts"\n'
                f'source = {{ git = "https://example.invalid/repo?rev=branch#{revision}" }}\n',
                encoding="utf-8",
            )
            self.assertEqual(
                prepare_training_source.training_source(lock),
                ("https://example.invalid/repo", revision),
            )
            lock.write_text(lock.read_text().replace(revision, "main"), encoding="utf-8")
            with self.assertRaises(ValueError):
                prepare_training_source.training_source(lock)


if __name__ == "__main__":
    unittest.main()
