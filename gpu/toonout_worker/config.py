import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = ROOT.parent
load_dotenv(ROOT / ".env.local", override=True)

DATA = Path(os.environ.get("TOONOUT_DATA_DIR", REPOSITORY_ROOT / ".toonout-data")).resolve()
DATA.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("TOONOUT_WORKER_TOKEN", "")
MODEL_REPO = "joelseytre/toonout"
MODEL_FILE = "birefnet_finetuned_toonout.pth"
MODEL_REVISION = os.environ.get(
    "TOONOUT_MODEL_REVISION", "cbf720eca394edcde66b861a8a8c20fbabe9c748"
)
BASE_MODEL = "ZhengPeng7/BiRefNet"
BASE_REVISION = os.environ.get(
    "TOONOUT_BASE_REVISION", "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"
)
DEVICE = os.environ.get("TOONOUT_DEVICE", "auto").lower()
INFERENCE_SIZE = int(os.environ.get("TOONOUT_INFERENCE_SIZE", "1024"))
MAX_BYTES = int(os.environ.get("TOONOUT_MAX_BYTES", 12 * 1024**2))
MAX_PIXELS = int(os.environ.get("TOONOUT_MAX_PIXELS", 4096 * 4096))
FEATHER = float(os.environ.get("TOONOUT_FEATHER", "0.5"))
ERODE = int(os.environ.get("TOONOUT_ERODE", "0"))
