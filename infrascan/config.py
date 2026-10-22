"""Runtime configuration for the InfraScan dashboard.

All paths are resolved from the repository root so the application behaves the
same whether it is launched with ``python run_app.py``, ``uvicorn app:app`` or
``python app.py``.
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_ROOT / "web"
ASSETS_DIR = WEB_DIR / "assets"

# A checkpoint is deliberately not bundled with the repository. Operators can
# point the dashboard at a compatible checkpoint with INFRASCAN_WEIGHTS.
_weights_env = os.environ.get("INFRASCAN_WEIGHTS", "").strip()
WEIGHTS_PATH = (
    Path(_weights_env).expanduser().resolve()
    if _weights_env
    else PROJECT_ROOT / "weights" / "best.pt"
)

DATASET_TEST_DIR = PROJECT_ROOT / "dataset" / "images" / "test"
RUNS_DIR = PROJECT_ROOT / "runs" / "dashboard"
RESULTS_DIR = RUNS_DIR / "results"
JOBS_DIR = RUNS_DIR / "jobs"

APP_NAME = "InfraScan"
APP_VERSION = "2.0.0"
TARGET_CLASS = "pothole"
DEFAULT_IMGSZ = 640

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}

MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024

SAMPLE_LIMIT = 24
RESULT_TTL_SECONDS = 24 * 60 * 60
JOB_TTL_SECONDS = 24 * 60 * 60

CONF_MIN, CONF_MAX, CONF_DEFAULT = 0.05, 1.0, 0.25
IOU_MIN, IOU_MAX, IOU_DEFAULT = 0.10, 1.0, 0.45


def ensure_directories() -> None:
    """Create the gitignored runtime directories used by the dashboard."""

    for directory in (RESULTS_DIR, JOBS_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def checkpoint_available() -> bool:
    return WEIGHTS_PATH.is_file() and WEIGHTS_PATH.stat().st_size > 0
