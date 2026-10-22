"""FastAPI application and HTTP API for the InfraScan dashboard."""

from __future__ import annotations

import logging
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import config, inference, jobs

logger = logging.getLogger("infrascan.api")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.ensure_directories()
    inference.purge_old_artifacts()
    jobs.cleanup_old_jobs()
    inference.start_model_load()
    logger.info("InfraScan dashboard ready at the configured host")
    yield


app = FastAPI(
    title="InfraScan API",
    description="Local computer-vision API for pothole inspection and road-hazard telemetry.",
    version=config.APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)

if not config.ASSETS_DIR.is_dir():
    raise RuntimeError(f"Dashboard assets are missing: {config.ASSETS_DIR}")

app.mount("/assets", StaticFiles(directory=config.ASSETS_DIR), name="assets")


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; "
        "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    )
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    logger.exception("Unhandled error while serving %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred. Check the server log for details."},
    )


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(
        config.WEB_DIR / "index.html",
        media_type="text/html",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/favicon.svg", include_in_schema=False)
async def favicon():
    return FileResponse(config.ASSETS_DIR / "brand" / "favicon.svg", media_type="image/svg+xml")


def _validate_thresholds(conf: float, iou: float) -> None:
    if not config.CONF_MIN <= conf <= config.CONF_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"Confidence must be between {config.CONF_MIN} and {config.CONF_MAX}.",
        )
    if not config.IOU_MIN <= iou <= config.IOU_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"IoU must be between {config.IOU_MIN} and {config.IOU_MAX}.",
        )


def _sample_files() -> list[Path]:
    directory = config.DATASET_TEST_DIR
    if not directory.is_dir():
        return []
    try:
        files = [
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in config.IMAGE_EXTENSIONS
        ]
    except OSError:
        return []
    return sorted(files, key=lambda path: path.name.lower())


@app.get("/api/health")
async def health():
    model = inference.model_status()
    return {"status": "ok", "model_state": model["state"]}


@app.get("/api/status")
async def status():
    model = inference.model_status()
    samples = _sample_files()
    return {
        "app": {
            "name": config.APP_NAME,
            "version": config.APP_VERSION,
            "description": "Local road-surface inspection powered by Ultralytics YOLO.",
        },
        "model": model,
        "runtime": inference.runtime_versions(),
        "severity_policy": inference.severity_policy(),
        "severity_rules": {
            "critical_min_pct": 8.0,
            "moderate_min_pct": 2.5,
        },
        "media": {
            "image_extensions": sorted(ext.lstrip(".") for ext in config.IMAGE_EXTENSIONS),
            "video_extensions": sorted(ext.lstrip(".") for ext in config.VIDEO_EXTENSIONS),
            "max_image_bytes": config.MAX_IMAGE_BYTES,
            "max_video_bytes": config.MAX_VIDEO_BYTES,
        },
        "thresholds": {
            "default_conf": config.CONF_DEFAULT,
            "default_iou": config.IOU_DEFAULT,
            "conf_min": config.CONF_MIN,
            "conf_max": config.CONF_MAX,
            "iou_min": config.IOU_MIN,
            "iou_max": config.IOU_MAX,
            "imgsz": config.DEFAULT_IMGSZ,
        },
        "samples": {"count": len(samples), "available": bool(samples)},
    }


@app.get("/api/samples")
async def list_samples():
    files = _sample_files()
    items = [
        {
            "name": path.name,
            "url": f"/api/samples/{path.name}",
            "size_bytes": path.stat().st_size,
        }
        for path in files[: config.SAMPLE_LIMIT]
    ]
    return {
        "available": bool(files),
        "count": len(files),
        "shown": len(items),
        "items": items,
        "directory": "dataset/images/test",
    }


@app.get("/api/samples/{name}", include_in_schema=False)
async def sample_image(name: str):
    if Path(name).name != name or not name or Path(name).suffix.lower() not in config.IMAGE_EXTENSIONS:
        raise HTTPException(status_code=404, detail="Sample image not found.")
    path = config.DATASET_TEST_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Sample image not found.")
    media_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/results/{filename}", include_in_schema=False)
async def result_image(filename: str):
    if Path(filename).name != filename or not filename.endswith(".jpg"):
        raise HTTPException(status_code=404, detail="Result image not found.")
    path = config.RESULTS_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Result image not found.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})


@app.post("/api/model/reload")
async def reload_model():
    try:
        model = await run_in_threadpool(inference.reload_model)
    except inference.ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"model": model}


async def _read_upload(file: UploadFile, max_bytes: int) -> bytes:
    data = bytearray()
    try:
        while chunk := await file.read(config.UPLOAD_CHUNK_BYTES):
            data.extend(chunk)
            if len(data) > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File is too large. The limit is {max_bytes // (1024 * 1024)} MB.",
                )
    finally:
        await file.close()
    return bytes(data)


async def _save_upload(file: UploadFile, destination: Path, max_bytes: int) -> int:
    size = 0
    try:
        with destination.open("wb") as handle:
            while chunk := await file.read(config.UPLOAD_CHUNK_BYTES):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Video is too large. The limit is {max_bytes // (1024**3)} GB.",
                    )
                handle.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    return size


@app.post("/api/detect/image")
async def detect_image(
    file: UploadFile = File(...),
    conf: float = Form(config.CONF_DEFAULT),
    iou: float = Form(config.IOU_DEFAULT),
):
    _validate_thresholds(conf, iou)
    if not config.checkpoint_available():
        raise HTTPException(
            status_code=503,
            detail=inference.model_status().get("error")
            or "No trained checkpoint is available. Place best.pt in the weights folder.",
        )

    data = await _read_upload(file, config.MAX_IMAGE_BYTES)
    try:
        result = await run_in_threadpool(inference.predict_image, data, conf=conf, iou=iou)
    except inference.InvalidImageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except inference.ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except inference.ModelTimeoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    result["filename"] = file.filename or "capture.jpg"
    return result


@app.post("/api/detect/video", status_code=202)
async def detect_video(
    file: UploadFile = File(...),
    conf: float = Form(config.CONF_DEFAULT),
    iou: float = Form(config.IOU_DEFAULT),
):
    _validate_thresholds(conf, iou)
    if not config.checkpoint_available():
        raise HTTPException(
            status_code=503,
            detail=inference.model_status().get("error")
            or "No trained checkpoint is available. Place best.pt in the weights folder.",
        )

    filename = file.filename or "video.mp4"
    suffix = Path(filename).suffix.lower()
    if suffix not in config.VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported video format. Use MP4, AVI, MOV or MKV.",
        )

    job = jobs.create_job(filename, conf=conf, iou=iou)
    destination = jobs.job_directory(job["id"]) / f"input{suffix}"
    try:
        await _save_upload(file, destination, config.MAX_VIDEO_BYTES)
    except HTTPException as exc:
        jobs.update_job(job["id"], status="failed", error=exc.detail)
        raise
    except Exception as exc:  # noqa: BLE001
        jobs.update_job(job["id"], status="failed", error=f"Upload failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}") from exc

    jobs.start_video_job(job["id"], destination)
    return job


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found. It may have been cleaned up.")
    return job


def _completed_job_output(job_id: str, filename: str) -> Path:
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found. It may have been cleaned up.")
    if job["status"] != "completed":
        raise HTTPException(status_code=409, detail="The job has not finished yet.")
    path = jobs.job_directory(job_id) / "output" / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Output file is not available.")
    return path


@app.get("/api/jobs/{job_id}/video", include_in_schema=False)
async def job_video(job_id: str):
    path = _completed_job_output(job_id, "detection_output.mp4")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"infrascan_{job_id[:8]}_annotated.mp4",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/jobs/{job_id}/telemetry.csv", include_in_schema=False)
async def job_telemetry_csv(job_id: str):
    path = _completed_job_output(job_id, "pothole_telemetry.csv")
    return FileResponse(
        path,
        media_type="text/csv",
        filename="pothole_telemetry.csv",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/jobs/{job_id}/telemetry.json", include_in_schema=False)
async def job_telemetry_json(job_id: str):
    path = _completed_job_output(job_id, "pothole_telemetry.json")
    return FileResponse(
        path,
        media_type="application/json",
        filename="pothole_telemetry.json",
        headers={"Cache-Control": "no-store"},
    )
