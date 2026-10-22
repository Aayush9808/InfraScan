export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new ApiError(
      "Could not reach the local InfraScan server. Check that it is still running.",
      0
    );
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && body.detail) {
        message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status);
  }

  return response;
}

export async function getStatus() {
  const response = await request("/api/status");
  return response.json();
}

export async function getSamples() {
  const response = await request("/api/samples");
  return response.json();
}

export async function detectImage(file, { conf, iou }) {
  const form = new FormData();
  form.append("file", file, file.name || "road.jpg");
  form.append("conf", String(conf));
  form.append("iou", String(iou));
  const response = await request("/api/detect/image", { method: "POST", body: form });
  return response.json();
}

export async function createVideoJob(file, { conf, iou }) {
  const form = new FormData();
  form.append("file", file, file.name || "footage.mp4");
  form.append("conf", String(conf));
  form.append("iou", String(iou));
  const response = await request("/api/detect/video", { method: "POST", body: form });
  return response.json();
}

export async function getJob(jobId) {
  const response = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
  return response.json();
}

export async function reloadModel() {
  const response = await request("/api/model/reload", { method: "POST" });
  return response.json();
}
