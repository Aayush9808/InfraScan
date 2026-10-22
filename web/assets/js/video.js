import { createVideoJob, getJob } from "./api.js";
import { state, on, incrementSession } from "./store.js";
import {
  $,
  formatBytes,
  formatDuration,
  formatEta,
  formatNumber,
  renderSeveritySummary,
  setButtonBusy,
  showToast,
} from "./ui.js";

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv"];

let busy = false;
let pollTimer = null;
let currentJob = null;
let startedAt = 0;
let objectUrl = null;

function setStatusTag(label, text) {
  const tag = $("#video-status-tag");
  if (!tag) return;
  tag.dataset.state = label;
  tag.textContent = text;
}

function updateParamLabels() {
  $("#video-conf").textContent = state.settings.conf.toFixed(2);
  $("#video-iou").textContent = state.settings.iou.toFixed(2);
}

function updateRunState() {
  updateParamLabels();
  const button = $("#run-video");
  const note = $("#video-run-note");
  if (!button || !note) return;

  const modelState = state.status?.model?.state;
  const ready = state.apiOnline && modelState === "ready";
  const hasVideo = Boolean(state.video);
  button.disabled = busy || !hasVideo || !ready;
  note.classList.toggle("is-warn", !ready);

  if (busy) {
    note.textContent = "Processing locally — keep this tab open.";
  } else if (!state.apiOnline) {
    note.textContent = "Local server offline — restart run_app.py.";
  } else if (!hasVideo) {
    note.textContent = "Select footage to begin.";
  } else if (!ready) {
    if (modelState === "loading" || modelState === "starting") {
      note.textContent = "Model is loading — this can take a moment.";
    } else if (modelState === "unavailable") {
      note.textContent = "Checkpoint required — add weights/best.pt, then reload in System.";
    } else if (modelState === "error") {
      note.textContent = "Model failed to load — open System for details.";
    } else {
      note.textContent = "Waiting for the model.";
    }
  } else if (
    currentJob?.status === "completed" &&
    (currentJob.conf !== state.settings.conf || currentJob.iou !== state.settings.iou)
  ) {
    note.textContent = "Parameters changed — process again to apply.";
    note.classList.add("is-warn");
  } else {
    note.textContent = `Ready · conf ${state.settings.conf.toFixed(2)} · IoU ${state.settings.iou.toFixed(2)}.`;
  }
}

function stopPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function resetJobView() {
  stopPolling();
  currentJob = null;
  state.job = null;
  busy = false;
  const bar = $("#job-bar");
  if (bar) bar.style.width = "0%";
  $("#video-idle").hidden = false;
  $("#video-progress").hidden = true;
  $("#video-complete").hidden = true;
  $("#video-error").hidden = true;
  $("#video-result").hidden = true;
  setStatusTag("idle", "Idle");
  updateRunState();
}

function clearVideo({ reset = true } = {}) {
  if (busy) {
    showToast("Wait for the current video to finish before changing footage.", "info");
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  const preview = $("#video-preview");
  if (preview) {
    preview.pause();
    preview.removeAttribute("src");
    preview.load();
  }
  state.video = null;
  $("#selected-video").hidden = true;
  $("#video-input").value = "";
  if (reset) {
    resetJobView();
    updateRunState();
  }
}

function selectVideo(file) {
  if (!file) return;
  if (busy) {
    showToast("Wait for the current video to finish first.", "info");
    return;
  }
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(extension)) {
    showToast("Use an MP4, AVI, MOV or MKV video.", "error");
    return;
  }
  if (file.size > MAX_VIDEO_BYTES) {
    showToast("That video is larger than 2 GB.", "error");
    return;
  }

  clearVideo({ reset: false });
  objectUrl = URL.createObjectURL(file);
  state.video = { file, name: file.name, size: file.size, previewUrl: objectUrl };
  const preview = $("#video-preview");
  preview.src = objectUrl;
  $("#selected-video-name").textContent = file.name;
  $("#selected-video-size").textContent = formatBytes(file.size);
  $("#selected-video").hidden = false;
  resetJobView();
  updateRunState();

  preview.addEventListener(
    "loadedmetadata",
    () => {
      if (!Number.isFinite(preview.duration)) return;
      $("#selected-video-size").textContent = `${formatBytes(file.size)} · ${formatDuration(preview.duration)}`;
    },
    { once: true }
  );
}

function renderProgress(job) {
  const progress = job.progress || {};
  const fraction = Number(progress.fraction) || 0;
  $("#video-idle").hidden = true;
  $("#video-complete").hidden = true;
  $("#video-error").hidden = true;
  $("#video-result").hidden = true;
  $("#video-progress").hidden = false;
  setStatusTag("working", "Processing");

  const stage = progress.stage || "Processing";
  $("#job-stage").textContent = stage;
  $("#job-bar").style.width = `${Math.min(100, Math.max(fraction * 100, job.status === "processing" ? 1.5 : 0))}%`;

  const frame = Number(progress.frame) || 0;
  const total = Number(progress.total_frames) || 0;
  $("#job-frames").textContent = total > 0 ? `Frame ${formatNumber(frame)} / ${formatNumber(total)}` : frame > 0 ? `Frame ${formatNumber(frame)}` : "Preparing…";

  if (fraction >= 1) {
    $("#job-eta").textContent = "Finishing…";
  } else if (fraction > 0.015 && startedAt) {
    const elapsed = (performance.now() - startedAt) / 1000;
    $("#job-eta").textContent = formatEta((elapsed * (1 - fraction)) / fraction);
  } else {
    $("#job-eta").textContent = "Estimating…";
  }
}

function setDownload(selector, url, available) {
  const link = $(selector);
  if (!link) return;
  if (available && url) {
    link.href = url;
    link.classList.remove("is-disabled");
    link.removeAttribute("aria-disabled");
    link.removeAttribute("title");
  } else {
    link.removeAttribute("href");
    link.classList.add("is-disabled");
    link.setAttribute("aria-disabled", "true");
    link.title = "No telemetry was recorded for this clip.";
  }
}

function renderResult(job) {
  stopPolling();
  busy = false;
  currentJob = job;
  state.job = job;
  setButtonBusy($("#run-video"), false);
  $("#video-progress").hidden = true;
  $("#video-error").hidden = true;
  $("#video-idle").hidden = true;
  $("#video-complete").hidden = false;
  $("#video-result").hidden = false;
  setStatusTag("success", "Complete");

  const result = job.result || {};
  const summary = result.summary || {};
  $("#result-video").src = result.video_url || "";

  $("#video-metric-detections").textContent = formatNumber(summary.detections_total || 0);
  $("#video-metric-critical").textContent = formatNumber(summary.critical || 0);
  $("#video-metric-frames").textContent = formatNumber(summary.frames_processed || 0);
  $("#video-metric-time").textContent = summary.processing_seconds
    ? formatDuration(summary.processing_seconds)
    : "—";
  $("#video-metric-rate").textContent = summary.throughput_fps
    ? `${summary.throughput_fps} frames/s processing`
    : "local processing";

  renderSeveritySummary($("#video-severity-summary"), {
    critical: summary.critical || 0,
    moderate: summary.moderate || 0,
    minor: summary.minor || 0,
  });

  $("#video-result-note").textContent = `Frame-level records across ${formatNumber(
    summary.frames_processed || 0
  )} processed frames. There is no cross-frame tracking.`;

  setDownload("#download-video", result.video_url, true);
  setDownload("#download-video-csv", result.telemetry_csv_url, Boolean(result.telemetry_csv_url));
  setDownload("#download-video-json", result.telemetry_json_url, Boolean(result.telemetry_json_url));

  incrementSession("video");
  const total = summary.detections_total || 0;
  showToast(
    total
      ? `Video complete · ${formatNumber(total)} frame-level detections.`
      : "Video complete · no potholes above the current threshold."
  );
  updateRunState();

  window.setTimeout(() => {
    if (location.hash === "#/video" && !document.hidden) {
      $("#video-result")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 250);
}

function showVideoError(message) {
  stopPolling();
  busy = false;
  setButtonBusy($("#run-video"), false);
  $("#video-progress").hidden = true;
  $("#video-idle").hidden = true;
  $("#video-complete").hidden = true;
  $("#video-result").hidden = true;
  $("#video-error").hidden = false;
  $("#video-error-text").textContent = message || "Video processing failed.";
  setStatusTag("failed", "Failed");
  showToast(message || "Video processing failed.", "error");
  updateRunState();
}

async function pollJob() {
  if (!currentJob) return;
  try {
    const job = await getJob(currentJob.id);
    currentJob = job;
    state.job = job;
    if (job.status === "completed") {
      renderResult(job);
      return;
    }
    if (job.status === "failed") {
      showVideoError(job.error || "The video job failed.");
      return;
    }
    renderProgress(job);
    pollTimer = window.setTimeout(pollJob, 850);
  } catch (error) {
    showVideoError(error.message || "Lost connection to the local server.");
  }
}

async function runVideo() {
  if (busy || !state.video) return;
  if (!state.apiOnline || state.status?.model?.state !== "ready") {
    showToast("The checkpoint is not ready. Open System for details.", "error");
    return;
  }

  busy = true;
  setButtonBusy($("#run-video"), true, "Uploading…");
  $("#video-idle").hidden = true;
  $("#video-complete").hidden = true;
  $("#video-error").hidden = true;
  $("#video-result").hidden = true;
  $("#video-progress").hidden = false;
  setStatusTag("working", "Uploading");
  $("#job-stage").textContent = "Uploading footage";
  $("#job-frames").textContent = "Uploading…";
  $("#job-eta").textContent = "Estimating…";
  $("#job-bar").style.width = "0%";
  updateRunState();

  try {
    const job = await createVideoJob(state.video.file, state.settings);
    currentJob = job;
    state.job = job;
    startedAt = performance.now();
    setButtonBusy($("#run-video"), false);
    busy = true;
    $("#run-video").disabled = true;
    setButtonBusy($("#run-video"), true, "Processing…");
    renderProgress(job);
    pollJob();
  } catch (error) {
    showVideoError(error.message || "The video could not be queued.");
  }
}

function resetForAnother() {
  clearVideo();
  $("#run-video")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function initVideo() {
  const dropzone = $("#video-dropzone");
  const input = $("#video-input");

  dropzone?.addEventListener("click", () => input?.click());
  dropzone?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input?.click();
    }
  });
  ["dragenter", "dragover"].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragover");
    });
  });
  dropzone?.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) selectVideo(file);
  });
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) selectVideo(file);
  });

  $("#clear-video")?.addEventListener("click", () => clearVideo());
  $("#run-video")?.addEventListener("click", runVideo);
  $("#new-video")?.addEventListener("click", resetForAnother);
  $("#jump-to-result")?.addEventListener("click", () => {
    $("#video-result")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  on("status", updateRunState);
  on("offline", updateRunState);
  on("settings", updateRunState);

  window.addEventListener("beforeunload", (event) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (busy) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  updateParamLabels();
  updateRunState();
}
