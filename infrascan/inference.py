"""Model lifecycle and image inference for the InfraScan dashboard.

The trained checkpoint is loaded lazily in a background thread so the UI can
render immediately. Inference is serialised with a lock because a single
Ultralytics model instance is not safe to call concurrently from multiple
threads.
"""

from __future__ import annotations

import importlib.metadata
import logging
import platform
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np

from . import config
from .severity import SEVERITY_BANDS, classify_severity

logger = logging.getLogger("infrascan.inference")

_lock = threading.RLock()
_predict_lock = threading.Lock()
_load_lock = threading.Lock()
_load_thread: threading.Thread | None = None

_model: Any | None = None
_state = "starting" if config.checkpoint_available() else "unavailable"
_error: str | None = None
_device: str | None = None
_classes: list[str] = [config.TARGET_CLASS]
_task = "detect"

_MISSING_CHECKPOINT_MESSAGE = (
    "No trained checkpoint is available. Place a compatible best.pt at "
    f"{config.WEIGHTS_PATH} (or set INFRASCAN_WEIGHTS) and reload the model."
)


class ModelUnavailableError(RuntimeError):
    """Raised when the checkpoint is missing or failed to load."""


class ModelTimeoutError(RuntimeError):
    """Raised when the model did not finish loading in time."""


class InvalidImageError(ValueError):
    """Raised when an uploaded file cannot be decoded as an image."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _set_state(state: str, *, error: str | None = None) -> None:
    global _state, _error
    with _lock:
        _state = state
        _error = error


def _select_device() -> str:
    """Pick the best available inference device without failing hard."""

    try:
        import torch
    except Exception as exc:  # pragma: no cover - environment dependent
        raise ModelUnavailableError(f"PyTorch could not be imported: {exc}") from exc

    try:
        if torch.cuda.is_available():
            return "cuda:0"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:
        logger.warning("Accelerator detection failed; falling back to CPU", exc_info=True)
    return "cpu"


def _device_label(device: str | None) -> str:
    if not device:
        return "Detecting…"
    if device == "cpu":
        return "CPU"
    if device == "mps":
        return "Apple GPU · MPS"
    if device.startswith("cuda"):
        return "NVIDIA GPU · CUDA"
    return device


def start_model_load() -> None:
    """Kick off a one-time background load of the checkpoint."""

    global _load_thread, _state

    if not config.checkpoint_available():
        _set_state("unavailable", error=_MISSING_CHECKPOINT_MESSAGE)
        return

    with _lock:
        if _model is not None and _state == "ready":
            return
        if _load_thread is not None and _load_thread.is_alive():
            return
        _state = "loading"
        _load_thread = threading.Thread(target=_load_model_sync, name="infrascan-model-loader", daemon=True)
        _load_thread.start()


def _load_model_sync(*, force: bool = False) -> None:
    global _model, _device, _classes, _task, _state, _error

    with _load_lock:
        with _lock:
            if not force and _model is not None and _state == "ready":
                return
            _state = "loading"
            _error = None

        if not config.checkpoint_available():
            _set_state("unavailable", error=_MISSING_CHECKPOINT_MESSAGE)
            return

        try:
            device = _select_device()
            from ultralytics import YOLO

            model = YOLO(str(config.WEIGHTS_PATH))
            names = getattr(model, "names", None) or {0: config.TARGET_CLASS}
            if isinstance(names, dict):
                classes = [str(names[key]) for key in sorted(names)]
            elif isinstance(names, (list, tuple)):
                classes = [str(item) for item in names]
            else:
                classes = [config.TARGET_CLASS]

            with _lock:
                _model = model
                _device = device
                _classes = classes
                _task = str(getattr(model, "task", "detect") or "detect")
                _state = "ready"
                _error = None
            logger.info("Loaded %s on %s", config.WEIGHTS_PATH.name, device)
        except Exception as exc:  # pragma: no cover - depends on local weights
            logger.exception("Failed to load model")
            with _lock:
                _model = None
                _state = "error"
                _error = f"Could not load the checkpoint: {exc}"


def ensure_ready(timeout: float = 180.0) -> Any:
    """Wait for the model to become ready and return it."""

    start_model_load()
    deadline = time.monotonic() + timeout

    while True:
        with _lock:
            state, model, error = _state, _model, _error

        if state == "ready" and model is not None:
            return model
        if state in {"unavailable", "error"}:
            raise ModelUnavailableError(error or _MISSING_CHECKPOINT_MESSAGE)
        if time.monotonic() >= deadline:
            raise ModelTimeoutError(
                "The model is still loading. Try again in a moment or reload it from the System page."
            )
        time.sleep(0.2)


def reload_model() -> dict[str, Any]:
    """Reload the checkpoint, waiting for any in-flight prediction to finish."""

    global _model, _state, _error

    if not config.checkpoint_available():
        _set_state("unavailable", error=_MISSING_CHECKPOINT_MESSAGE)
        raise ModelUnavailableError(_MISSING_CHECKPOINT_MESSAGE)

    with _predict_lock:
        with _lock:
            _model = None
            _state = "loading"
            _error = None
        _load_model_sync(force=True)

    status = model_status()
    if status["state"] != "ready":
        raise ModelUnavailableError(status.get("error") or "The checkpoint could not be loaded.")
    return status


def model_status() -> dict[str, Any]:
    with _lock:
        state, error, device = _state, _error, _device
        classes = list(_classes)
        task = _task

    checkpoint_exists = config.checkpoint_available()
    size_bytes = config.WEIGHTS_PATH.stat().st_size if checkpoint_exists else 0

    try:
        display_path = str(config.WEIGHTS_PATH.relative_to(config.PROJECT_ROOT))
    except ValueError:
        display_path = str(config.WEIGHTS_PATH)

    return {
        "state": state,
        "ready": state == "ready",
        "error": error,
        "checkpoint": {
            "name": config.WEIGHTS_PATH.name,
            "path": display_path,
            "exists": checkpoint_exists,
            "size_bytes": size_bytes,
        },
        "device": device,
        "device_label": _device_label(device),
        "classes": classes,
        "task": task,
        "imgsz": config.DEFAULT_IMGSZ,
    }


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:
        return None


def runtime_versions() -> dict[str, Any]:
    return {
        "python": platform.python_version(),
        "platform": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "torch": _package_version("torch"),
        "ultralytics": _package_version("ultralytics"),
        "opencv": _package_version("opencv-python") or _package_version("opencv-python-headless"),
        "numpy": _package_version("numpy"),
        "pandas": _package_version("pandas"),
        "fastapi": _package_version("fastapi"),
        "uvicorn": _package_version("uvicorn"),
    }


def severity_policy() -> list[dict[str, Any]]:
    policy = []
    for index, (name, threshold, _colour) in enumerate(SEVERITY_BANDS):
        upper = SEVERITY_BANDS[index - 1][1] if index > 0 else None
        policy.append(
            {
                "name": name,
                "min_pct": threshold,
                "max_pct": upper,
                "description": {
                    "CRITICAL": "High-impact road damage. Prioritise inspection.",
                    "MODERATE": "Degradation requiring planned maintenance.",
                    "MINOR": "Early surface defect with limited coverage.",
                }[name],
            }
        )
    return policy


def _annotate(image: np.ndarray, detections: list[dict[str, Any]]) -> np.ndarray:
    """Draw severity-coloured boxes and labels on a copy of the frame."""

    annotated = image.copy()
    height, width = annotated.shape[:2]
    scale = max(0.5, min(1.1, max(width, height) / 1500.0))
    thickness = max(2, int(round(scale * 2.5)))
    font = cv2.FONT_HERSHEY_SIMPLEX
    pad = max(4, int(round(8 * scale)))

    for detection in detections:
        x1, y1, x2, y2 = detection["bbox"]
        colour = detection["_colour"]
        confidence = detection["confidence"]
        severity = detection["severity"]

        label = f"Pothole {confidence:.2f} [{severity}]"
        (text_width, text_height), _ = cv2.getTextSize(label, font, scale * 0.82, thickness)
        label_top = max(0, y1 - text_height - pad)
        label_bottom = y1 if y1 - text_height - pad >= 0 else min(height, text_height + pad)
        label_right = min(width, x1 + text_width + pad * 2)
        cv2.rectangle(annotated, (x1, label_top), (label_right, label_bottom), colour, -1)
        cv2.putText(
            annotated,
            label,
            (x1 + pad, max(text_height + 2, label_bottom - pad)),
            font,
            scale * 0.82,
            (255, 255, 255),
            max(1, thickness - 1),
            cv2.LINE_AA,
        )
        cv2.rectangle(annotated, (x1, y1), (x2, y2), colour, thickness)

    return annotated


def purge_old_artifacts(*, ttl_seconds: int = config.RESULT_TTL_SECONDS) -> None:
    """Delete dashboard result images older than the configured TTL."""

    cutoff = time.time() - ttl_seconds
    for path in config.RESULTS_DIR.glob("*.jpg"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            logger.debug("Could not remove stale result %s", path, exc_info=True)


def predict_image(image_bytes: bytes, *, conf: float, iou: float) -> dict[str, Any]:
    """Run one image through the checkpoint and persist an annotated JPEG."""

    global _device

    if not image_bytes:
        raise InvalidImageError("The uploaded file is empty.")

    buffer = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise InvalidImageError("The file could not be decoded as an image. Use JPG, PNG, WebP or BMP.")

    height, width = image.shape[:2]
    frame_area = float(width * height)
    model = ensure_ready()

    with _lock:
        device = _device

    started = time.perf_counter()
    try:
        with _predict_lock:
            result = model.predict(
                image,
                conf=conf,
                iou=iou,
                imgsz=config.DEFAULT_IMGSZ,
                device=device,
                verbose=False,
            )[0]
    except Exception:
        if device not in (None, "cpu"):
            logger.warning("Accelerated inference failed; retrying on CPU", exc_info=True)
            with _predict_lock:
                result = model.predict(
                    image,
                    conf=conf,
                    iou=iou,
                    imgsz=config.DEFAULT_IMGSZ,
                    device="cpu",
                    verbose=False,
                )[0]
            with _lock:
                _device = "cpu"
        else:
            raise
    latency_ms = (time.perf_counter() - started) * 1000.0

    detections: list[dict[str, Any]] = []
    for box in result.boxes:
        x1, y1, x2, y2 = (int(value) for value in box.xyxy[0].cpu().numpy())
        x1, x2 = sorted((max(0, min(width - 1, x1)), max(0, min(width - 1, x2))))
        y1, y2 = sorted((max(0, min(height - 1, y1)), max(0, min(height - 1, y2))))
        confidence = float(box.conf[0].cpu().numpy())
        box_area = float(max(0, x2 - x1) * max(0, y2 - y1))
        severity, colour, coverage = classify_severity(box_area, frame_area)
        detections.append(
            {
                "id": len(detections) + 1,
                "confidence": round(confidence, 4),
                "severity": severity,
                "coverage_pct": round(coverage, 2),
                "bbox": [x1, y1, x2, y2],
                "_colour": colour,
            }
        )

    annotated = _annotate(image, detections)
    result_id = uuid.uuid4().hex
    output_path = config.RESULTS_DIR / f"{result_id}.jpg"
    if not cv2.imwrite(str(output_path), annotated, [cv2.IMWRITE_JPEG_QUALITY, 92]):
        raise RuntimeError("The annotated image could not be written to disk.")

    counts = {"CRITICAL": 0, "MODERATE": 0, "MINOR": 0}
    for detection in detections:
        counts[detection["severity"]] += 1

    summary = {
        "count": len(detections),
        "critical": counts["CRITICAL"],
        "moderate": counts["MODERATE"],
        "minor": counts["MINOR"],
        "max_coverage_pct": round(max((item["coverage_pct"] for item in detections), default=0.0), 2),
        "total_coverage_pct": round(sum(item["coverage_pct"] for item in detections), 2),
    }

    public_detections = [
        {key: value for key, value in detection.items() if key != "_colour"} for detection in detections
    ]

    return {
        "id": result_id,
        "image_url": f"/api/results/{result_id}.jpg",
        "width": width,
        "height": height,
        "detections": public_detections,
        "summary": summary,
        "inference_ms": round(latency_ms, 1),
        "conf": conf,
        "iou": iou,
        "imgsz": config.DEFAULT_IMGSZ,
        "created_at": _now_iso(),
    }
