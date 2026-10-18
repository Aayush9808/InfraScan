import io
import os
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
import streamlit as st
from PIL import Image
from ultralytics import YOLO

from detect import run_detection


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = PROJECT_ROOT / "weights" / "best.pt"

st.set_page_config(
    page_title="InfraScan | Road Intelligence",
    page_icon="IS",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """
    <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap');

    :root {
        --navy: #07111f;
        --panel: rgba(16, 31, 52, 0.72);
        --line: rgba(151, 183, 219, 0.18);
        --muted: #8ea4bd;
        --text: #eaf2fb;
        --cyan: #4de4e8;
        --violet: #9b8cff;
        --orange: #ffae67;
    }

    .stApp {
        background:
            radial-gradient(circle at 92% 4%, rgba(78, 91, 210, 0.22), transparent 27rem),
            radial-gradient(circle at 5% 20%, rgba(28, 191, 192, 0.12), transparent 25rem),
            linear-gradient(145deg, #06101c 0%, #09182a 52%, #07111f 100%);
        color: var(--text);
        font-family: 'DM Sans', sans-serif;
    }
    [data-testid="stHeader"] { background: transparent; }
    [data-testid="stSidebar"] {
        background: rgba(5, 15, 28, 0.92);
        border-right: 1px solid var(--line);
    }
    [data-testid="stSidebar"] > div:first-child { padding-top: 1.5rem; }
    h1, h2, h3, h4 { font-family: 'Space Grotesk', sans-serif; letter-spacing: -0.03em; }
    h2 { margin-top: 1.1rem; }
    .brand {
        display: flex; align-items: center; gap: .8rem; margin: .25rem 0 2rem;
    }
    .brand-mark {
        width: 2.7rem; height: 2.7rem; border-radius: .85rem;
        display: grid; place-items: center; color: #07111f; font-weight: 700;
        background: linear-gradient(135deg, var(--cyan), var(--violet));
        box-shadow: 0 0 30px rgba(77, 228, 232, .2);
    }
    .brand-name { font: 700 1.25rem 'Space Grotesk'; color: var(--text); }
    .brand-sub { color: var(--muted); font-size: .72rem; margin-top: .12rem; }
    .hero {
        padding: 1.45rem 1.7rem; border: 1px solid var(--line); border-radius: 1.2rem;
        background: linear-gradient(110deg, rgba(20, 45, 70, .82), rgba(25, 31, 67, .65));
        box-shadow: 0 24px 70px rgba(0, 0, 0, .18); margin-bottom: 1.2rem;
    }
    .eyebrow { color: var(--cyan); font-size: .72rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    .hero-title { font: 700 clamp(2rem, 4vw, 3.3rem) 'Space Grotesk'; line-height: 1.02; margin: .5rem 0; }
    .hero-copy { color: var(--muted); max-width: 48rem; line-height: 1.55; margin-bottom: .8rem; }
    .status-pill {
        display: inline-flex; align-items: center; gap: .45rem; color: #b7f7df;
        font-size: .78rem; padding: .38rem .7rem; border: 1px solid rgba(92, 226, 177, .25);
        border-radius: 999px; background: rgba(54, 160, 119, .13);
    }
    .status-dot { width: .45rem; height: .45rem; border-radius: 50%; background: #5ce2b1; box-shadow: 0 0 12px #5ce2b1; }
    .glass-card {
        padding: 1.1rem 1.2rem; border-radius: 1rem; border: 1px solid var(--line);
        background: var(--panel); box-shadow: 0 16px 40px rgba(0, 0, 0, .12);
    }
    .card-label { color: var(--muted); font-size: .76rem; text-transform: uppercase; letter-spacing: .08em; }
    .card-value { color: var(--text); font: 700 1.45rem 'Space Grotesk'; margin-top: .25rem; }
    .section-note { color: var(--muted); margin-top: -.5rem; margin-bottom: 1rem; }
    div[data-testid="stFileUploader"] {
        border: 1px dashed rgba(77, 228, 232, .35); border-radius: 1rem;
        background: rgba(16, 39, 61, .38); padding: .4rem;
    }
    .stButton > button, .stDownloadButton > button {
        border: 1px solid rgba(77, 228, 232, .38); border-radius: .65rem;
        background: linear-gradient(135deg, rgba(77, 228, 232, .16), rgba(155, 140, 255, .16));
        color: var(--text); font-weight: 600; transition: border-color .2s, transform .2s;
    }
    .stButton > button:hover, .stDownloadButton > button:hover { border-color: var(--cyan); transform: translateY(-1px); }
    [data-testid="stMetric"] {
        background: var(--panel); border: 1px solid var(--line); border-radius: .9rem; padding: .8rem;
    }
    [data-testid="stDataFrame"] { border: 1px solid var(--line); border-radius: .8rem; overflow: hidden; }
    .footer { color: #61778f; text-align: center; font-size: .75rem; margin: 2.5rem 0 1rem; }
    </style>
    """,
    unsafe_allow_html=True,
)


def project_path(relative_path: str) -> Path:
    return PROJECT_ROOT / relative_path


@st.cache_resource
def load_yolo_model(weights_path: str):
    return YOLO(weights_path)


def render_brand():
    st.sidebar.markdown(
        """
        <div class="brand">
            <div class="brand-mark">IS</div>
            <div><div class="brand-name">InfraScan</div>
            <div class="brand-sub">ROAD INTELLIGENCE PLATFORM</div></div>
        </div>
        """,
        unsafe_allow_html=True,
    )


render_brand()
st.sidebar.markdown("### Detection settings")
weights_options = ["weights/best.pt"]
selected_weights = st.sidebar.selectbox("Model checkpoint", weights_options, index=0)
conf_threshold = st.sidebar.slider("Confidence threshold", 0.05, 1.0, 0.25, 0.05)
iou_threshold = st.sidebar.slider("NMS IoU threshold", 0.1, 1.0, 0.45, 0.05)
st.sidebar.markdown("---")
st.sidebar.markdown("**Severity scale**")
st.sidebar.caption("CRITICAL  ·  area ≥ 8%")
st.sidebar.caption("MODERATE  ·  area 2.5–8%")
st.sidebar.caption("MINOR  ·  area < 2.5%")

weights_path = project_path(selected_weights) if selected_weights.startswith("weights/") else selected_weights
model_available = Path(weights_path).is_file() if isinstance(weights_path, (str, Path)) else False
try:
    model = load_yolo_model(str(weights_path))
    model_error = None
except Exception as exc:
    model = None
    model_error = str(exc)

st.markdown(
    """
    <div class="hero">
        <div class="eyebrow">AI-powered road intelligence</div>
        <div class="hero-title">See the road ahead.<br><span style="color:#4de4e8">Decide with confidence.</span></div>
        <div class="hero-copy">Inspect road surfaces with computer vision, turn detections into actionable telemetry, and accelerate infrastructure maintenance.</div>
        <span class="status-pill"><span class="status-dot"></span> Inference workspace online</span>
    </div>
    """,
    unsafe_allow_html=True,
)

status_col1, status_col2, status_col3 = st.columns(3)
status_col1.markdown(
    f'<div class="glass-card"><div class="card-label">Model status</div><div class="card-value">{"Ready" if model is not None else "Unavailable"}</div></div>',
    unsafe_allow_html=True,
)
status_col2.markdown(
    f'<div class="glass-card"><div class="card-label">Active checkpoint</div><div class="card-value">{Path(str(weights_path)).name}</div></div>',
    unsafe_allow_html=True,
)
status_col3.markdown(
    '<div class="glass-card"><div class="card-label">Supported media</div><div class="card-value">Images + video</div></div>',
    unsafe_allow_html=True,
)

if model_error:
    st.error(
        "The trained checkpoint is not available in this release candidate. "
        "Place a compatible, lawfully obtained checkpoint at "
        f"`{DEFAULT_WEIGHTS}` before running inference. Details: {model_error}"
    )

tab_image, tab_video, tab_system = st.tabs(["Image inspection", "Video analysis", "System"])

with tab_image:
    st.header("Image inspection")
    st.markdown('<div class="section-note">Upload a road image or select a local sample to generate an annotated inspection.</div>', unsafe_allow_html=True)
    left, right = st.columns([0.95, 1.25], gap="large")
    with left:
        source_mode = st.radio("Input source", ["Upload image", "Dataset sample", "Webcam snapshot"], horizontal=True)
        input_image = None
        if source_mode == "Upload image":
            uploaded_file = st.file_uploader("Drop a JPG or PNG road image", type=["jpg", "jpeg", "png"], key="image_upload")
            if uploaded_file:
                input_image = Image.open(uploaded_file).convert("RGB")
        elif source_mode == "Webcam snapshot":
            st.caption("Capture a still frame from your browser camera.")
            camera_image = st.camera_input("Take a road snapshot")
            if camera_image:
                input_image = Image.open(camera_image).convert("RGB")
        else:
            sample_dir = project_path("dataset/images/test")
            sample_files = sorted(sample_dir.glob("*.jpg")) if sample_dir.exists() else []
            if sample_files:
                sample_choice = st.selectbox("Select a test image", [path.name for path in sample_files[:30]])
                input_image = Image.open(sample_dir / sample_choice).convert("RGB")
            else:
                st.info("No dataset samples are available in dataset/images/test.")
        if input_image is not None:
            st.image(input_image, caption="Source frame", width="stretch")
    with right:
        st.subheader("Inspection result")
        if input_image is None:
            st.info("Choose an input source to begin an inspection.")
        elif model is None:
            st.error("The selected model is unavailable. Choose a valid checkpoint in the sidebar.")
        else:
            image_array = np.array(input_image)
            frame_area = image_array.shape[0] * image_array.shape[1]
            with st.spinner("Analyzing road surface..."):
                started = time.time()
                result = model.predict(image_array, conf=conf_threshold, iou=iou_threshold, verbose=False)[0]
                latency_ms = (time.time() - started) * 1000
            annotated = image_array.copy()
            detections = []
            for box in result.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
                confidence = float(box.conf[0].cpu().numpy())
                ratio = ((x2 - x1) * (y2 - y1) / frame_area) * 100.0
                if ratio >= 8.0:
                    severity, color = "CRITICAL", (255, 0, 0)
                elif ratio >= 2.5:
                    severity, color = "MODERATE", (255, 140, 0)
                else:
                    severity, color = "MINOR", (255, 215, 0)
                detections.append({
                    "Pothole ID": len(detections) + 1,
                    "Confidence": f"{confidence * 100:.1f}%",
                    "Severity": severity,
                    "Road Area Coverage": f"{ratio:.2f}%",
                    "BBox [x1, y1, x2, y2]": f"[{x1}, {y1}, {x2}, {y2}]",
                })
                cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 3)
                cv2.putText(annotated, f"Pothole {confidence:.2f} [{severity}]", (x1, max(25, y1 - 10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
            st.image(annotated, caption="Annotated inspection", width="stretch")
            metric1, metric2, metric3 = st.columns(3)
            metric1.metric("Potholes detected", len(detections))
            metric2.metric("Critical hazards", sum(item["Severity"] == "CRITICAL" for item in detections))
            metric3.metric("Inference latency", f"{latency_ms:.1f} ms")
            if detections:
                st.markdown("#### Detection telemetry")
                telemetry_df = pd.DataFrame(detections)
                st.dataframe(telemetry_df, width="stretch", hide_index=True)
                csv_buffer = io.StringIO()
                telemetry_df.to_csv(csv_buffer, index=False)
                st.download_button("Download telemetry CSV", csv_buffer.getvalue(), "pothole_telemetry.csv", "text/csv")
            else:
                st.success("No potholes detected above the current threshold.")

with tab_video:
    st.header("Video analysis")
    st.markdown('<div class="section-note">Process dashcam footage through the same trained checkpoint and export an annotated inspection video.</div>', unsafe_allow_html=True)
    video_file = st.file_uploader("Drop an MP4, AVI, or MOV file", type=["mp4", "avi", "mov"], key="video_upload")
    if video_file:
        st.video(video_file)
        if st.button("Process video", type="primary"):
            if model is None:
                st.error(
                    "Video inference is unavailable until a compatible checkpoint "
                    f"is placed at `{DEFAULT_WEIGHTS}`."
                )
                st.stop()
            suffix = Path(video_file.name).suffix.lower()
            progress = st.progress(0)
            status = st.empty()
            try:
                with tempfile.TemporaryDirectory(prefix="infrascan_video_") as temp_dir:
                    temp_path = Path(temp_dir)
                    input_path = temp_path / f"input{suffix}"
                    output_dir = temp_path / "output"
                    input_path.write_bytes(video_file.getvalue())

                    def update_progress(frame_number, total_frames):
                        if total_frames:
                            progress.progress(min(frame_number / total_frames, 1.0))
                        status.info(f"Processing frame {frame_number}" + (f" of {total_frames}" if total_frames else "") + "...")

                    status.info("Starting video inference...")
                    run_detection(
                        source=str(input_path),
                        weights=str(weights_path),
                        conf=conf_threshold,
                        iou=iou_threshold,
                        save=True,
                        show=False,
                        output_dir=str(output_dir),
                        progress_callback=update_progress,
                    )
                    output_video = output_dir / "detection_output.mp4"
                    if not output_video.is_file() or output_video.stat().st_size == 0:
                        raise RuntimeError("Inference completed without producing an annotated video.")
                    output_bytes = output_video.read_bytes()
                    progress.progress(1.0)
                    status.success("Video processing complete.")
                    st.video(output_bytes)
                    st.download_button("Download annotated video", output_bytes, f"{Path(video_file.name).stem}_annotated.mp4", "video/mp4")
                    telemetry = output_dir / "pothole_telemetry.csv"
                    if telemetry.is_file():
                        st.download_button("Download video telemetry CSV", telemetry.read_bytes(), "pothole_telemetry.csv", "text/csv")
            except Exception as exc:
                progress.empty()
                status.error(f"Video processing failed: {exc}")
    else:
        st.info("Upload footage to begin a dashcam inspection.")

with tab_system:
    st.header("System overview")
    st.markdown('<div class="section-note">Runtime details and operating guidance for this local inspection workspace.</div>', unsafe_allow_html=True)
    info1, info2 = st.columns(2)
    with info1:
        st.markdown("#### Runtime")
        st.markdown(
            f"""
            <div class="glass-card">
            <div class="card-label">Engine</div><div class="card-value">Ultralytics YOLO</div>
            <div class="card-label" style="margin-top:1rem">Checkpoint</div><div class="card-value">{Path(str(weights_path)).name}</div>
            <div class="card-label" style="margin-top:1rem">Target class</div><div class="card-value">pothole</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with info2:
        st.markdown("#### Supported workflows")
        st.markdown(
            """
            <div class="glass-card">
            <div class="card-value">Image inspection</div><div class="section-note">Upload, sample, or capture a still frame.</div>
            <div class="card-value">Video analysis</div><div class="section-note">MP4, AVI, and MOV with annotated export.</div>
            <div class="card-value">Telemetry export</div><div class="section-note">CSV and JSON files from the inference pipeline.</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    st.markdown("#### Camera workflow")
    st.info("Use Webcam snapshot for browser capture. For continuous camera HUD inference, run `python test_camera.py` or `python detect.py --camera` from the project directory.")

st.markdown('<div class="footer">InfraScan · Local road intelligence workspace</div>', unsafe_allow_html=True)
