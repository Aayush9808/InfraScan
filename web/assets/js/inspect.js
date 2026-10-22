import { detectImage } from "./api.js";
import { state, on, incrementSession, setLatency } from "./store.js";
import {
  $,
  $$,
  animateNumber,
  detectionsToCsv,
  downloadText,
  escapeHtml,
  formatCoords,
  formatLatency,
  formatNumber,
  formatTime,
  icon,
  renderSeveritySummary,
  setButtonBusy,
  severityChip,
  showToast,
} from "./ui.js";
import { initCamera } from "./camera.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
let busy = false;
let sourceMode = "upload";
let lastResult = null;

function setStatusTag(label, text) {
  const tag = $("#image-result-status");
  if (!tag) return;
  tag.dataset.state = label;
  tag.textContent = text;
}

function setSource(mode, { focus = false } = {}) {
  sourceMode = mode;
  $$(".segmented [data-source]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.source === mode));
    button.tabIndex = button.dataset.source === mode ? 0 : -1;
    if (focus && button.dataset.source === mode) button.focus();
  });
  $$(".source-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== mode;
  });
}

function resetOutput() {
  $("#image-empty").hidden = false;
  $("#image-loading").hidden = true;
  $("#image-error").hidden = true;
  $("#image-output").hidden = true;
  setStatusTag("idle", "Awaiting frame");
}

function clearSelection({ reset = true } = {}) {
  if (state.image?.objectUrl) URL.revokeObjectURL(state.image.objectUrl);
  state.image = null;
  state.imageResult = null;
  state.imageView = "annotated";
  lastResult = null;

  const preview = $("#selected-preview");
  if (preview) preview.removeAttribute("src");
  $("#selected-frame").hidden = true;
  $("#image-input").value = "";
  $$(".sample-tile").forEach((tile) => tile.classList.remove("is-selected"));
  if (reset) {
    resetOutput();
    updateRunState();
  }
}

function showPreview() {
  const image = state.image;
  if (!image) return;
  $("#selected-preview").src = image.previewUrl;
  $("#selected-preview").alt = `Selected frame: ${image.name}`;
  $("#selected-name").textContent = image.name;
  const details = [];
  if (image.size) details.push(formatBytesLabel(image.size));
  if (image.source === "Dataset") details.push("dataset sample");
  else if (image.width) details.push(`${image.width} × ${image.height}`);
  else details.push("local file");
  $("#selected-size").textContent = details.join(" · ");
  $("#selected-source").textContent = image.source;
  $("#selected-frame").hidden = false;
  $$(".sample-tile").forEach((tile) => {
    tile.classList.toggle("is-selected", Boolean(image.sampleName) && tile.dataset.name === image.sampleName);
  });
}

function formatBytesLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "—";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function selectFile(file, sourceLabel = "Upload") {
  if (!file) return;
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp", ".bmp"].includes(extension)) {
    showToast("Use a JPG, PNG, WebP or BMP image.", "error");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast("That image is larger than 25 MB.", "error");
    return;
  }
  clearSelection({ reset: false });
  const url = URL.createObjectURL(file);
  state.image = {
    file,
    name: file.name || `${sourceLabel.toLowerCase()}_capture.jpg`,
    size: file.size,
    source: sourceLabel,
    previewUrl: url,
    sampleUrl: null,
    objectUrl: url,
  };
  showPreview();
  resetOutput();
  setStatusTag("idle", "Ready to inspect");
  updateRunState();
}

function selectSample(item) {
  clearSelection({ reset: false });
  state.image = {
    file: null,
    name: item.name,
    size: item.size_bytes,
    source: "Dataset",
    previewUrl: item.url,
    sampleUrl: item.url,
    sampleName: item.name,
    objectUrl: null,
  };
  showPreview();
  resetOutput();
  setStatusTag("idle", "Ready to inspect");
  updateRunState();
}

async function sampleToFile(item) {
  const response = await fetch(item.sampleUrl || item.previewUrl);
  if (!response.ok) throw new Error("The dataset sample could not be loaded.");
  const blob = await response.blob();
  return new File([blob], item.name, { type: blob.type || "image/jpeg" });
}

function updateParamLabels() {
  $("#inspect-conf").textContent = state.settings.conf.toFixed(2);
  $("#inspect-iou").textContent = state.settings.iou.toFixed(2);
}

function updateRunState() {
  updateParamLabels();
  const button = $("#run-image");
  const note = $("#image-run-note");
  if (!button || !note) return;

  const modelState = state.status?.model?.state;
  const ready = state.apiOnline && modelState === "ready";
  const hasImage = Boolean(state.image);
  button.disabled = busy || !hasImage || !ready;
  note.classList.toggle("is-warn", !ready);

  if (busy) {
    note.textContent = "Analysing the frame…";
  } else if (!state.apiOnline) {
    note.textContent = "Local server offline — restart run_app.py.";
  } else if (!hasImage) {
    note.textContent = "Select a frame to begin.";
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
  } else if (lastResult && (lastResult.conf !== state.settings.conf || lastResult.iou !== state.settings.iou)) {
    note.textContent = "Parameters changed — run again to apply.";
    note.classList.add("is-warn");
  } else {
    note.textContent = `Ready · conf ${state.settings.conf.toFixed(2)} · IoU ${state.settings.iou.toFixed(2)} · 640 px`;
  }
}

function showError(error) {
  $("#image-empty").hidden = true;
  $("#image-loading").hidden = true;
  $("#image-output").hidden = true;
  $("#image-error").hidden = false;
  $("#image-error-text").textContent = error.message || String(error);
  setStatusTag("error", "Inspection failed");
  showToast(error.message || "Inspection failed.", "error");
}

function setView(mode) {
  if (!lastResult) return;
  if (mode === "original" && !state.image?.previewUrl) {
    showToast("The original frame is no longer available.", "error");
    return;
  }
  state.imageView = mode;
  const image = $("#result-image");
  image.src = mode === "original" ? state.image.previewUrl : lastResult.image_url;
  image.alt = mode === "original" ? "Original road frame" : "Annotated road inspection";
  $("#view-annotated").classList.toggle("is-active", mode === "annotated");
  $("#view-original").classList.toggle("is-active", mode === "original");
  $("#view-annotated").setAttribute("aria-pressed", String(mode === "annotated"));
  $("#view-original").setAttribute("aria-pressed", String(mode === "original"));
}

function renderResult(result) {
  lastResult = result;
  $("#image-empty").hidden = true;
  $("#image-loading").hidden = true;
  $("#image-error").hidden = true;
  $("#image-output").hidden = false;
  setStatusTag("success", "Complete");

  const summary = result.summary || { count: 0, critical: 0, max_coverage_pct: 0 };
  $("#result-image").src = result.image_url;
  $("#result-image").alt = `Annotated inspection of ${result.filename || "road frame"}`;
  $("#download-image").href = result.image_url;
  const stem = (result.filename || state.image?.name || "inspection").replace(/\.[^.]+$/, "");
  $("#download-image").setAttribute("download", `infrascan_${stem}.jpg`);

  animateNumber($("#metric-count"), summary.count, { decimals: 0 });
  animateNumber($("#metric-critical"), summary.critical, { decimals: 0 });
  animateNumber($("#metric-coverage"), summary.max_coverage_pct, { decimals: 1, suffix: "%" });
  $("#metric-latency").textContent = formatLatency(result.inference_ms);

  renderSeveritySummary($("#severity-summary"), {
    critical: summary.critical,
    moderate: summary.moderate,
    minor: summary.minor,
  });

  const detections = result.detections || [];
  $("#detection-count-label").textContent = `${detections.length} ${detections.length === 1 ? "record" : "records"}`;
  $("#detection-body").innerHTML = detections
    .map(
      (detection) => `<tr>
        <td class="mono">${escapeHtml(detection.id)}</td>
        <td>${severityChip(detection.severity)}</td>
        <td><span class="confidence"><span class="mono">${(detection.confidence * 100).toFixed(1)}%</span><i><b style="width:${(detection.confidence * 100).toFixed(1)}%"></b></i></span></td>
        <td class="mono">${formatNumber(detection.coverage_pct, 2)}%</td>
        <td class="mono">${escapeHtml(formatCoords(detection.bbox))}</td>
      </tr>`
    )
    .join("");
  $("#detection-table-wrap").hidden = detections.length === 0;
  $("#no-detections").hidden = detections.length > 0;

  const meta = [
    `${result.width} × ${result.height} px`,
    `conf ${Number(result.conf).toFixed(2)}`,
    `IoU ${Number(result.iou).toFixed(2)}`,
    result.filename || state.image?.name,
    formatTime(result.created_at),
  ].filter(Boolean);
  $("#result-meta").textContent = meta.join("  ·  ");

  $("#view-original").disabled = !state.image?.previewUrl;
  setView("annotated");
  updateRunState();
}

async function runInspection() {
  if (busy || !state.image) return;
  if (!state.apiOnline || state.status?.model?.state !== "ready") {
    showToast("The checkpoint is not ready. Open System for details.", "error");
    return;
  }

  busy = true;
  const button = $("#run-image");
  setButtonBusy(button, true, "Analysing…");
  $("#image-empty").hidden = true;
  $("#image-error").hidden = true;
  $("#image-output").hidden = true;
  $("#image-loading").hidden = false;
  $("#loading-message").textContent = "Running YOLO inference…";
  setStatusTag("working", "Analysing");
  updateRunState();

  try {
    const file = state.image.file || (await sampleToFile(state.image));
    const result = await detectImage(file, state.settings);
    state.imageResult = result;
    setLatency(result.inference_ms);
    incrementSession("image");
    renderResult(result);
    const count = result.summary?.count ?? 0;
    showToast(
      count
        ? `${count} pothole${count === 1 ? "" : "s"} detected · ${formatLatency(result.inference_ms)}`
        : `No potholes above ${state.settings.conf.toFixed(2)} confidence.`
    );
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    $("#image-loading").hidden = true;
    setButtonBusy(button, false);
    updateRunState();
  }
}

function renderSamples(data) {
  const grid = $("#sample-grid");
  const empty = $("#sample-empty");
  const note = $("#sample-note");
  if (!grid) return;

  if (!data || !data.available || !Array.isArray(data.items) || data.items.length === 0) {
    grid.innerHTML = "";
    grid.hidden = true;
    empty.hidden = false;
    note.hidden = true;
    return;
  }

  grid.hidden = false;
  empty.hidden = true;
  grid.innerHTML = data.items
    .map(
      (item) => `<button class="sample-tile${state.image?.sampleName === item.name ? " is-selected" : ""}" type="button" data-name="${escapeHtml(
        item.name
      )}" aria-label="Use dataset sample ${escapeHtml(item.name)}">
        <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" loading="lazy">
        <span>${escapeHtml(item.name)}</span>
      </button>`
    )
    .join("");

  grid.querySelectorAll(".sample-tile").forEach((tile) => {
    const item = data.items.find((entry) => entry.name === tile.dataset.name);
    tile.addEventListener("click", () => item && selectSample(item));
  });

  note.hidden = false;
  note.textContent = `${data.count} images in dataset/images/test · showing ${data.shown ?? data.items.length}.`;
}

function openLightbox() {
  if (!lastResult || !state.image) return;
  const dialog = $("#lightbox");
  $("#lightbox-img").src = state.imageView === "original" ? state.image.previewUrl : lastResult.image_url;
  const count = lastResult.summary?.count ?? 0;
  $("#lightbox-caption").textContent = `${state.image.name} · ${lastResult.width} × ${lastResult.height} px · ${count} detection${count === 1 ? "" : "s"}`;
  dialog.showModal();
}

function downloadCsv() {
  if (!lastResult) return;
  const stem = (state.image?.name || "inspection").replace(/\.[^.]+$/, "");
  downloadText(`${stem}_telemetry.csv`, detectionsToCsv(lastResult, state.image?.name || "image.jpg"));
  showToast("Telemetry CSV downloaded.");
}

export function initInspect() {
  const dropzone = $("#image-dropzone");
  const input = $("#image-input");

  $$(".segmented [data-source]").forEach((button) => {
    button.addEventListener("click", () => setSource(button.dataset.source));
  });
  const tablist = $(".segmented[role='tablist']");
  tablist?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$(".segmented [data-source]");
    const current = tabs.findIndex((tab) => tab.dataset.source === sourceMode);
    const next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setSource(tabs[next].dataset.source, { focus: true });
  });

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
    if (file) selectFile(file, "Upload");
  });
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) selectFile(file, "Upload");
  });

  $("#clear-image")?.addEventListener("click", () => {
    clearSelection();
    setSource("upload");
  });
  $("#run-image")?.addEventListener("click", runInspection);
  $("#rerun-image")?.addEventListener("click", runInspection);
  $("#image-retry")?.addEventListener("click", runInspection);
  $("#download-csv")?.addEventListener("click", downloadCsv);
  $("#view-annotated")?.addEventListener("click", () => setView("annotated"));
  $("#view-original")?.addEventListener("click", () => setView("original"));
  $("#expand-image")?.addEventListener("click", openLightbox);
  $("#result-image")?.addEventListener("click", openLightbox);

  $("#lightbox-close")?.addEventListener("click", () => $("#lightbox").close());
  $("#lightbox")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  window.addEventListener("infrascan:run-image", () => {
    if (busy) return;
    if ($("#run-image")?.disabled) {
      showToast("Select a frame and wait for the model first.", "info");
      return;
    }
    runInspection();
  });

  window.addEventListener("beforeunload", () => {
    if (state.image?.objectUrl) URL.revokeObjectURL(state.image.objectUrl);
  });

  initCamera((file) => {
    selectFile(file, "Webcam");
    setSource("upload");
  });

  on("samples", renderSamples);
  on("status", updateRunState);
  on("offline", updateRunState);
  on("settings", updateRunState);

  if (state.samples) renderSamples(state.samples);
  updateParamLabels();
  updateRunState();
}
