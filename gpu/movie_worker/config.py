import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = ROOT.parent
# Use this workspace's credentials, rather than a stale key inherited from a
# different project by a long-running Windows shell.
load_dotenv(ROOT / ".env.local", override=True)
DATA = Path(os.environ.get("MOVIE_DATA_DIR", REPOSITORY_ROOT / ".movie-data")).resolve()
TTS = os.environ.get("IRODORI_TTS_BASE_URL", "http://127.0.0.1:8088").rstrip("/")
TOKEN = os.environ.get("MOVIE_WORKER_TOKEN", "")
MAX_BYTES = int(os.environ.get("MOVIE_MAX_BYTES", 20 * 1024**3))
CHUNK_BYTES = 8 * 1024**2
RETENTION = 86400
ASR_MODEL = os.environ.get("MOVIE_ASR_MODEL", "large-v3")
GEMINI_MODEL = os.environ.get("GEMINI_AUDIO_MODEL", "gemini-2.5-flash")
EMOTIONS = {
    "neutral": "自然な会話調",
    "joy": "嬉しさが伝わる明るい調子",
    "surprise": "急に驚いた調子",
    "anger": "少し怒った調子",
    "fear": "不安そうな調子",
    "sadness": "落胆した調子",
    "confusion": "戸惑った調子",
    "relief": "安心した調子",
    "unknown": "自然な会話調",
}
STYLES = {
    "normal": "自然に話す",
    "whisper": "声を抑えて囁く",
    "shout": "勢いよく声を張る",
    "laugh": "軽く笑いを含めて話す",
    "cry": "泣きそうな調子で話す",
    "breathy": "息を含んで話す",
    "rushed": "焦って少し早口で話す",
}
VOCALIZATIONS = {
    "laugh": {
        "input": "🤭🤭",
        "suffix": "🤭",
        "caption": "自然な笑い声を含める",
    },
    "scream": {
        "input": "😱😱",
        "suffix": "😱",
        "caption": "自然な悲鳴や叫び声を含める",
    },
    "sigh": {
        "input": "😮‍💨",
        "suffix": "😮‍💨",
        "caption": "自然なため息を含める",
    },
    "cry": {
        "input": "😭😭",
        "suffix": "😭",
        "caption": "自然な泣き声や嗚咽を含める",
    },
    "gasp": {
        "input": "😮",
        "suffix": "😮",
        "caption": "自然に息をのむ発声を含める",
    },
    "breath": {
        "input": "🌬️",
        "suffix": "🌬️",
        "caption": "自然な息遣いを含める",
    },
    "cough": {
        "input": "🤧",
        "suffix": "🤧",
        "caption": "自然な咳や咳払いを含める",
    },
}


def gemini_configured():
    credentials = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    return bool(os.environ.get("GOOGLE_CLOUD_PROJECT")) and (
        not credentials or Path(credentials).is_file()
    )
