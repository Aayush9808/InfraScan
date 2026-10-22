import { getSamples, getStatus } from "./api.js";
import {
  on,
  resetSettings,
  setOffline,
  setSamples,
  setSettings,
  setStatus,
  state,
} from "./store.js";
import {
  $,
  $$,
  animateNumber,
  copyText,
  formatBytes,
  formatLatency,
  showToast,
} from "./ui.js";
import { initInspect } from "./inspect.js";
import { initVideo } from "./video.js";
import { initPalette } from "./palette.js";
import { initSystem, renderSystem } from "./system.js";

const ROUTES = {
  overview: { title: "Overview", eyebrow: "Workspace" },
  inspect: { title: "Image inspection", eyebrow: "Image workspace" },
  video: { title: "Video analysis", eyebrow: "Video workspace" },
  system: { title: "System", eyebrow: "Runtime" },
};

const STATUS_INTERVAL = 15000;
const LOADING_INTERVAL = 2500;
const OFFLINE_INTERVAL = 5000;

let statusTimer = null;
let polling = false;
let queuedRefresh = false;
let offlineNotified = false;
let revealObserver = null;

function setChip(chipState, text) {
  const chip = $("#model-chip");
  if (chip) {
    chip.dataset.state = chipState;
    const dot = chip.querySelector(".status-dot");
    if (dot) dot.dataset.state = chipState;
  }
  const textNode = $("#model-chip-text");
  if (textNode) textNode.textContent = text;
  const sidebarDot = $("#sidebar-dot");
  if (sidebarDot) sidebarDot.dataset.state = chipState;
}

function renderSession() {
  const element = $("#stat-sessions");
  if (element) animateNumber(element, state.session.scans);
  const note = element?.closest(".stat")?.querySelector("small");
  if (note) {
    note.textContent = state.session.videos
      ? `${state.session.videos} video${state.session.videos === 1 ? "" : "s"} processed`
      : "This browser session";
  }
}

function renderStatus(status) {
  window.__infrascanStatus = status;
  const model = status?.model;
  const modelState = model?.state || "loading";
  const checkpoint = model?.checkpoint;
  const deviceLabel = model?.device_label || "—";

  let chipState;
  let chipText;
  let heroBadge;
  let statModel;
  let sidebarModel;

  if (modelState === "ready") {
    chipState = "ready";
    chipText = "Model ready";
    heroBadge = "Operational";
    statModel = "Ready";
    sidebarModel = checkpoint?.name || "Ready";
  } else if (modelState === "loading" || modelState === "starting") {
    chipState = "loading";
    chipText = "Loading model";
    heroBadge = "Loading";
    statModel = "Loading…";
    sidebarModel = "Loading…";
  } else if (modelState === "unavailable") {
    chipState = "unavailable";
    chipText = "No checkpoint";
    heroBadge = "Unavailable";
    statModel = "Unavailable";
    sidebarModel = "No checkpoint";
  } else if (modelState === "error") {
    chipState = "error";
    chipText = "Model error";
    heroBadge = "Error";
    statModel = "Error";
    sidebarModel = "Load error";
  } else {
    chipState = "loading";
    chipText = "Connecting";
    heroBadge = "Standby";
    statModel = "Checking…";
    sidebarModel = "Connecting…";
  }

  setChip(chipState, chipText);
  const setText = (selector, value) => {
    const node = $(selector);
    if (node) node.textContent = value;
  };
  setText("#sidebar-model", sidebarModel);
  setText("#sidebar-device", deviceLabel);
  setText("#stat-model", statModel);
  setText("#stat-device", deviceLabel);
  setText("#stat-checkpoint", checkpoint?.name || "—");
  setText(
    "#stat-checkpoint-note",
    checkpoint?.exists ? `${formatBytes(checkpoint.size_bytes)} checkpoint` : "Not found"
  );
  setText("#hero-model-badge", heroBadge);
  setText("#hero-checkpoint", checkpoint?.name || "—");
  setText("#hero-device", deviceLabel);
  setText("#hero-latency", state.lastLatency ? formatLatency(state.lastLatency) : "—");

  renderSystem(status);
}

function renderOffline(message) {
  window.__infrascanStatus = null;
  setChip("error", "API offline");
  const setText = (selector, value) => {
    const node = $(selector);
    if (node) node.textContent = value;
  };
  setText("#sidebar-model", "Offline");
  setText("#sidebar-device", "—");
  setText("#stat-model", "Unavailable");
  setText("#stat-device", "—");
  setText("#stat-checkpoint", "—");
  setText("#stat-checkpoint-note", "API unreachable");
  setText("#hero-model-badge", "Offline");
  setText("#hero-checkpoint", "—");
  setText("#hero-device", "—");

  const tag = $("#system-model-tag");
  if (tag) {
    tag.dataset.state = "error";
    tag.textContent = "Offline";
  }
  const errorBox = $("#system-model-error");
  const errorText = $("#system-model-error-text");
  if (errorBox && errorText) {
    errorBox.hidden = false;
    errorText.textContent = message || "The local InfraScan API is unreachable.";
  }
}

function scheduleStatus(delay) {
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(refreshStatus, delay);
}

async function refreshStatus() {
  if (polling) {
    queuedRefresh = true;
    return;
  }
  polling = true;
  window.clearTimeout(statusTimer);

  try {
    const status = await getStatus();
    setStatus(status);
    renderStatus(status);
    if (offlineNotified) {
      showToast("Connection restored. The local API is reachable again.");
      offlineNotified = false;
    }
  } catch (error) {
    const message = error?.message || "The local API is unreachable.";
    setOffline(message);
    renderOffline(message);
    if (!offlineNotified) {
      showToast(message, "error", 7000);
      offlineNotified = true;
    }
  } finally {
    polling = false;
    if (queuedRefresh) {
      queuedRefresh = false;
      refreshStatus();
      return;
    }
    const modelState = state.status?.model?.state;
    if (!state.apiOnline) scheduleStatus(OFFLINE_INTERVAL);
    else if (modelState === "loading" || modelState === "starting") scheduleStatus(LOADING_INTERVAL);
    else scheduleStatus(STATUS_INTERVAL);
  }
}

async function loadSamples() {
  try {
    setSamples(await getSamples());
  } catch {
    setSamples({
      available: false,
      count: 0,
      shown: 0,
      items: [],
      directory: "dataset/images/test",
    });
  }
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "").split("?")[0];
  return Object.prototype.hasOwnProperty.call(ROUTES, raw) ? raw : "overview";
}

function observeReveals() {
  if (!revealObserver) return;
  $$(".view:not([hidden]) .reveal:not(.is-visible)").forEach((element) => {
    revealObserver.observe(element);
  });
}

function route() {
  const name = parseRoute();
  const meta = ROUTES[name];
  if (location.hash !== `#/${name}`) {
    history.replaceState(null, "", `#/${name}`);
  }

  $$(".view").forEach((view) => {
    view.hidden = view.dataset.view !== name;
  });
  $$(".nav__item").forEach((item) => {
    if (item.dataset.nav === name) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const eyebrow = $("#page-eyebrow");
  const title = $("#page-title");
  if (eyebrow) eyebrow.textContent = meta.eyebrow;
  if (title) title.textContent = meta.title;
  document.title = `${meta.title} · InfraScan`;

  setSidebar(false);
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  observeReveals();
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function setSidebar(open) {
  const app = $("#app");
  if (!app) return;
  app.classList.toggle("sidebar-open", open);
  $("#menu-btn")?.setAttribute("aria-expanded", String(open));
}

function initRouter() {
  if ("IntersectionObserver" in window) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.06, rootMargin: "0px 0px -40px 0px" }
    );
  } else {
    $$(".reveal").forEach((element) => element.classList.add("is-visible"));
  }

  window.addEventListener("hashchange", route);
  route();
}

function initSidebar() {
  $("#menu-btn")?.addEventListener("click", () => setSidebar(true));
  $("#sidebar-close")?.addEventListener("click", () => setSidebar(false));
  $("#scrim")?.addEventListener("click", () => setSidebar(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setSidebar(false);
  });
}

function syncSettings() {
  const confInput = $("#conf-range");
  const iouInput = $("#iou-range");
  if (confInput) confInput.value = String(state.settings.conf);
  if (iouInput) iouInput.value = String(state.settings.iou);
  const confValue = $("#conf-value");
  const iouValue = $("#iou-value");
  if (confValue) confValue.textContent = state.settings.conf.toFixed(2);
  if (iouValue) iouValue.textContent = state.settings.iou.toFixed(2);
}

function initSettings() {
  const confInput = $("#conf-range");
  const iouInput = $("#iou-range");
  confInput?.addEventListener("input", () => setSettings({ conf: Number(confInput.value) }));
  iouInput?.addEventListener("input", () => setSettings({ iou: Number(iouInput.value) }));
  $("#reset-params")?.addEventListener("click", () => {
    resetSettings();
    showToast("Inference parameters reset to defaults.", "info");
  });
  syncSettings();
}

function buildCommands() {
  const goInspect = (action) => {
    go("#/inspect");
    window.setTimeout(action, 80);
  };

  return [
    {
      label: "Overview",
      hint: "Workspace",
      icon: "grid",
      keywords: "home dashboard start",
      run: () => go("#/overview"),
    },
    {
      label: "Image inspection",
      hint: "Workspace",
      icon: "scan",
      keywords: "detect analyse photo frame",
      run: () => go("#/inspect"),
    },
    {
      label: "Video analysis",
      hint: "Workspace",
      icon: "film",
      keywords: "dashcam footage process",
      run: () => go("#/video"),
    },
    {
      label: "System & runtime",
      hint: "Workspace",
      icon: "cpu",
      keywords: "model checkpoint device versions",
      run: () => go("#/system"),
    },
    {
      label: "Run image inspection",
      hint: "Selected frame",
      icon: "play",
      keywords: "detect start analyse",
      run: () => goInspect(() => window.dispatchEvent(new CustomEvent("infrascan:run-image"))),
    },
    {
      label: "Capture a webcam frame",
      hint: "Webcam",
      icon: "camera",
      keywords: "camera snapshot still",
      run: () =>
        goInspect(() => {
          $("#tab-camera")?.click();
          $("#open-camera")?.click();
        }),
    },
    {
      label: "Reload checkpoint",
      hint: "System",
      icon: "refresh",
      keywords: "model weights restart",
      run: () => {
        go("#/system");
        window.setTimeout(() => $("#reload-model")?.click(), 80);
      },
    },
    {
      label: "Reset inference parameters",
      hint: "conf 0.25 · IoU 0.45",
      icon: "zap",
      keywords: "threshold default confidence iou",
      run: () => {
        resetSettings();
        showToast("Inference parameters reset to defaults.", "info");
      },
    },
    {
      label: "Copy dashboard command",
      hint: "python run_app.py",
      icon: "copy",
      keywords: "terminal launch serve",
      run: () => copyText("python run_app.py", "Command copied."),
    },
    {
      label: "Open API documentation",
      hint: "/api/docs",
      icon: "terminal",
      keywords: "swagger openapi reference",
      run: () => window.open("/api/docs", "_blank", "noopener,noreferrer"),
    },
    {
      label: "Open GitHub repository",
      hint: "GitHub",
      icon: "github",
      keywords: "source code repo",
      run: () =>
        window.open("https://github.com/Aayush9808/InfraScan", "_blank", "noopener,noreferrer"),
    },
  ];
}

function init() {
  initInspect();
  initVideo();
  initSystem();
  initPalette(buildCommands);
  initSettings();
  initSidebar();
  initRouter();

  on("settings", syncSettings);
  on("session", renderSession);
  on("latency", (milliseconds) => {
    const node = $("#hero-latency");
    if (node) node.textContent = formatLatency(milliseconds);
  });

  window.addEventListener("infrascan:refresh-status", refreshStatus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshStatus();
  });

  renderSession();
  refreshStatus();
  loadSamples();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
