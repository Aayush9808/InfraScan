export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function icon(name, extra = "") {
  return `<svg class="icon${extra ? ` ${extra}` : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

export function formatLatency(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "Estimating…";
  return `~${formatDuration(value)} remaining`;
}

export function formatNumber(value, decimals = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(number);
}

export function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatCoords(bbox) {
  return Array.isArray(bbox) ? `[${bbox.join(", ")}]` : "—";
}

export function severityChip(severity) {
  const value = String(severity || "").toLowerCase();
  return `<span class="sev-chip" data-sev="${escapeHtml(value)}">${escapeHtml(severity)}</span>`;
}

export function renderSeveritySummary(container, { critical = 0, moderate = 0, minor = 0 } = {}) {
  if (!container) return;
  const parts = [
    ["critical", Number(critical) || 0],
    ["moderate", Number(moderate) || 0],
    ["minor", Number(minor) || 0],
  ];
  const total = parts.reduce((sum, [, count]) => sum + count, 0);
  if (!total) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  const bar = parts
    .filter(([, count]) => count > 0)
    .map(
      ([severity, count]) =>
        `<span data-sev="${severity}" style="width:${((count / total) * 100).toFixed(2)}%"></span>`
    )
    .join("");
  const legend = parts
    .map(
      ([severity, count]) =>
        `<span><i style="background:var(--${severity})"></i>${severity[0].toUpperCase()}${severity.slice(
          1
        )} <b>${formatNumber(count)}</b></span>`
    )
    .join("");
  container.innerHTML = `<div class="severity-summary__bar" role="img" aria-label="Severity distribution: ${parts
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ")}">${bar}</div><div class="severity-summary__legend">${legend}</div>`;
}

export function setButtonBusy(button, busy, busyLabel = "Working…") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    const label = button.querySelector(".btn__label");
    if (label) {
      if (!label.dataset.idleLabel) label.dataset.idleLabel = label.textContent;
      label.textContent = busyLabel;
    } else {
      button.innerHTML = `${icon("refresh")}<span>${escapeHtml(busyLabel)}</span>`;
    }
    button.classList.add("is-busy");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  } else {
    if (button.dataset.idleHtml) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
    }
    const label = button.querySelector(".btn__label");
    if (label && label.dataset.idleLabel) {
      label.textContent = label.dataset.idleLabel;
      delete label.dataset.idleLabel;
    }
    button.classList.remove("is-busy");
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

export function showToast(message, type = "success", timeout = 4600) {
  const stack = $("#toasts");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  const iconName = type === "error" ? "alert" : type === "info" ? "info" : "check";
  toast.innerHTML = `${icon(iconName)}<span></span><button class="toast__close" type="button" aria-label="Dismiss notification">×</button>`;
  toast.querySelector("span").textContent = message;
  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 260);
  };
  toast.querySelector(".toast__close").addEventListener("click", remove);
  stack.appendChild(toast);
  window.setTimeout(remove, timeout);
}

export async function copyText(text, successMessage = "Copied to clipboard.") {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showToast(successMessage);
    return true;
  } catch {
    showToast("Could not copy. Select the command manually.", "error");
    return false;
  }
}

export function downloadText(filename, content, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function detectionsToCsv(result, filename = "image.jpg") {
  const rows = [["image", "box", "confidence", "severity", "coverage_pct"]];
  (result.detections || []).forEach((detection) => {
    rows.push([
      filename,
      JSON.stringify(detection.bbox),
      detection.confidence,
      detection.severity,
      detection.coverage_pct,
    ]);
  });
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const text = String(value ?? "");
            return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
          })
          .join(",")
      )
      .join("\n") + "\n"
  );
}

export function animateNumber(element, target, { decimals = 0, suffix = "", duration = 650 } = {}) {
  if (!element) return;
  const end = Number(target) || 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || end === 0 || document.hidden) {
    element.textContent = `${formatNumber(end, decimals)}${suffix}`;
    return;
  }
  const start = performance.now();
  const startValue = 0;
  const finish = () => {
    element.textContent = `${formatNumber(end, decimals)}${suffix}`;
  };
  // rAF can be suspended in occluded tabs; the timer guarantees the final
  // value is written even when no frames are produced.
  const fallback = window.setTimeout(finish, duration + 250);
  const tick = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = startValue + (end - startValue) * eased;
    element.textContent = `${formatNumber(value, decimals)}${suffix}`;
    if (progress < 1) requestAnimationFrame(tick);
    else {
      window.clearTimeout(fallback);
      finish();
    }
  };
  requestAnimationFrame(tick);
}

export function fileExtension(name) {
  const index = String(name || "").lastIndexOf(".");
  return index >= 0 ? String(name).slice(index).toLowerCase() : "";
}

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
export const VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv"];

export function humanFileSize(bytes) {
  return formatBytes(bytes);
}
