"""Background video-analysis jobs for the InfraScan dashboard.

Each job owns a directory under ``runs/dashboard/jobs`` containing the uploaded
source, the annotated video and the telemetry files. Jobs are processed one at
a time in a worker thread so long videos cannot starve the HTTP server.
"""

from __future__ import annotations

import copy
import logging
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config
from .inference import ModelUnavailableError

logger = logging.getLogger("infrascan.jobs")

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.RLock()
_worker_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _public(job: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(job)


def create_job(source_name: str, *, conf: float, iou: float) -> dict[str, Any]:
    job_id = uuid.uuid4().hex
    job_dir = config.JOBS_DIR / job_id
    (job_dir / "output").mkdir(parents=True, exist_ok=True)

    job = {
        "id": job_id,
        "status": "queued",
        "source_name": source_name,
        "conf": conf,
        "iou": iou,
        "created_at": _now_iso(),
        "started_at": None,
        "completed_at": None,
        "error": None,
        "progress": {
            "stage": "Queued",
            "frame": 0,
            "total_frames": 0,
            "fraction": 0.0,
        },
        "result": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    return _public(job)


def update_job(job_id: str, **fields: Any) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.update(fields)


def update_progress(job_id: str, *, frame: int, total: int, stage: str = "Analysing frames") -> None:
    fraction = min(frame / total, 1.0) if total else 0.0
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        progress = job.setdefault("progress", {})
        progress.update(
            {
                "stage": stage,
                "frame": frame,
                "total_frames": total,
                "fraction": round(fraction, 4),
            }
        )


def get_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return _public(job) if job else None


def job_directory(job_id: str) -> Path:
    return config.JOBS_DIR / job_id


def run_video_job(job_id: str, input_path: Path) -> None:
    """Process one uploaded video and record its result on the job."""

    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        conf = float(job["conf"])
        iou = float(job["iou"])

    started = time.perf_counter()
    update_job(job_id, status="processing", started_at=_now_iso())
    update_progress(job_id, frame=0, total=0, stage="Loading checkpoint")
    output_dir = job_directory(job_id) / "output"

    try:
        if not config.checkpoint_available():
            raise ModelUnavailableError(
                "No trained checkpoint is available. Place best.pt at "
                f"{config.WEIGHTS_PATH} and try again."
            )

        # Imported lazily so the dashboard can boot even when the ML stack is
        # being installed for the first time.
        from detect import run_detection

        with _worker_lock:
            update_progress(job_id, frame=0, total=0, stage="Preparing video")
            records = run_detection(
                source=str(input_path),
                weights=str(config.WEIGHTS_PATH),
                conf=conf,
                iou=iou,
                save=True,
                show=False,
                output_dir=str(output_dir),
                progress_callback=lambda frame, total: update_progress(
                    job_id, frame=frame, total=total
                ),
            )

        elapsed = time.perf_counter() - started
        video_path = output_dir / "detection_output.mp4"
        if not video_path.is_file() or video_path.stat().st_size == 0:
            raise RuntimeError(
                "Inference finished without producing an annotated video. "
                "Check that the uploaded file is a readable video."
            )

        telemetry_csv = output_dir / "pothole_telemetry.csv"
        telemetry_json = output_dir / "pothole_telemetry.json"

        counts = {"CRITICAL": 0, "MODERATE": 0, "MINOR": 0}
        for record in records:
            severity = str(record.get("severity", "MINOR")).upper()
            if severity in counts:
                counts[severity] += 1

        with _jobs_lock:
            job = _jobs.get(job_id) or {}
            progress = job.get("progress") or {}
            frames_processed = int(progress.get("total_frames") or progress.get("frame") or 0)

        summary = {
            "frames_processed": frames_processed,
            "detections_total": len(records),
            "critical": counts["CRITICAL"],
            "moderate": counts["MODERATE"],
            "minor": counts["MINOR"],
            "max_coverage_pct": round(
                max((float(item.get("coverage_pct", 0.0)) for item in records), default=0.0), 2
            ),
            "processing_seconds": round(elapsed, 2),
            "throughput_fps": round(frames_processed / elapsed, 1) if elapsed > 0 and frames_processed else None,
        }

        result = {
            "video_url": f"/api/jobs/{job_id}/video",
            "video_size_bytes": video_path.stat().st_size,
            "telemetry_csv_url": f"/api/jobs/{job_id}/telemetry.csv" if telemetry_csv.is_file() else None,
            "telemetry_json_url": f"/api/jobs/{job_id}/telemetry.json" if telemetry_json.is_file() else None,
            "summary": summary,
        }

        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                progress = job.setdefault("progress", {})
                progress["fraction"] = 1.0
                progress["stage"] = "Complete"

        update_job(
            job_id,
            status="completed",
            completed_at=_now_iso(),
            result=result,
            error=None,
        )
        logger.info("Video job %s completed in %.1fs (%s detections)", job_id, elapsed, len(records))
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI as an actionable message
        logger.exception("Video job %s failed", job_id)
        update_job(
            job_id,
            status="failed",
            completed_at=_now_iso(),
            error=str(exc),
            result=None,
        )
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                job.setdefault("progress", {})["stage"] = "Failed"


def start_video_job(job_id: str, input_path: Path) -> None:
    thread = threading.Thread(
        target=run_video_job,
        args=(job_id, input_path),
        name=f"infrascan-video-{job_id[:8]}",
        daemon=True,
    )
    thread.start()


def cleanup_old_jobs(*, ttl_seconds: int = config.JOB_TTL_SECONDS) -> None:
    """Remove finished job directories older than the TTL."""

    cutoff = time.time() - ttl_seconds
    with _jobs_lock:
        finished_ids = {
            job_id
            for job_id, job in _jobs.items()
            if job.get("status") in {"completed", "failed"}
        }

    candidates = set(finished_ids)
    try:
        if config.JOBS_DIR.is_dir():
            candidates.update(path.name for path in config.JOBS_DIR.iterdir() if path.is_dir())
    except OSError:
        logger.debug("Could not scan the jobs directory", exc_info=True)

    for job_id in candidates:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None and job.get("status") not in {"completed", "failed"}:
                continue
        directory = job_directory(job_id)
        try:
            if directory.is_dir() and directory.stat().st_mtime < cutoff:
                shutil.rmtree(directory, ignore_errors=True)
                with _jobs_lock:
                    _jobs.pop(job_id, None)
        except OSError:
            logger.debug("Could not remove stale job %s", job_id, exc_info=True)
