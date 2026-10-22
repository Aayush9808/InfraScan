const SETTINGS_KEY = "infrascan.settings.v2";
const DEFAULT_SETTINGS = { conf: 0.25, iou: 0.45 };

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      conf: clamp(stored.conf, 0.05, 1, DEFAULT_SETTINGS.conf),
      iou: clamp(stored.iou, 0.1, 1, DEFAULT_SETTINGS.iou),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const state = {
  apiOnline: true,
  status: null,
  samples: null,
  settings: loadSettings(),
  image: null,
  imageResult: null,
  imageView: "annotated",
  video: null,
  job: null,
  lastLatency: null,
  session: { scans: 0, videos: 0 },
};

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  const handlers = listeners.get(event);
  if (!handlers) return;
  handlers.forEach((handler) => {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[infrascan] listener for "${event}" failed`, error);
    }
  });
}

export function setStatus(status) {
  state.status = status;
  state.apiOnline = true;
  emit("status", status);
}

export function setOffline(message = "The local API is unreachable.") {
  state.apiOnline = false;
  emit("offline", message);
}

export function setSettings(patch) {
  const next = {
    conf: clamp(patch.conf ?? state.settings.conf, 0.05, 1, DEFAULT_SETTINGS.conf),
    iou: clamp(patch.iou ?? state.settings.iou, 0.1, 1, DEFAULT_SETTINGS.iou),
  };
  state.settings = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage can be unavailable in hardened browsers */
  }
  emit("settings", next);
}

export function resetSettings() {
  state.settings = { ...DEFAULT_SETTINGS };
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
  emit("settings", state.settings);
}

export function setSamples(samples) {
  state.samples = samples;
  emit("samples", samples);
}

export function incrementSession(kind) {
  if (kind === "image") state.session.scans += 1;
  if (kind === "video") state.session.videos += 1;
  emit("session", state.session);
}

export function setLatency(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return;
  state.lastLatency = value;
  emit("latency", value);
}

export { DEFAULT_SETTINGS };
