import { $ } from "./ui.js";

let stream = null;
let onCapture = null;

function stopStream() {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  const video = $("#camera-video");
  if (video) video.srcObject = null;
}

function showCameraError(message) {
  const box = $("#camera-error");
  const capture = $("#camera-capture");
  if (box) {
    box.hidden = false;
    box.textContent = message;
  }
  if (capture) capture.disabled = true;
}

async function openCamera() {
  const dialog = $("#camera-dialog");
  if (!dialog) return;

  const errorBox = $("#camera-error");
  const capture = $("#camera-capture");
  errorBox.hidden = true;
  errorBox.textContent = "";
  capture.disabled = true;

  if (!navigator.mediaDevices?.getUserMedia) {
    dialog.showModal();
    showCameraError("This browser does not expose camera access. Try a modern browser on localhost.");
    return;
  }

  dialog.showModal();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    const video = $("#camera-video");
    video.srcObject = stream;
    await video.play();
    capture.disabled = false;
  } catch (error) {
    const name = error?.name || "";
    let message = "The camera could not be opened.";
    if (name === "NotAllowedError" || name === "SecurityError") {
      message = "Camera permission was denied. Allow access in your browser and try again.";
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      message = "No camera was found on this device.";
    } else if (name === "NotReadableError") {
      message = "The camera is busy in another application. Close it and try again.";
    }
    showCameraError(message);
  }
}

function closeCamera() {
  stopStream();
  const dialog = $("#camera-dialog");
  if (dialog?.open) dialog.close();
}

function captureFrame() {
  const video = $("#camera-video");
  if (!video || !video.videoWidth) {
    showCameraError("The camera has not produced a frame yet. Wait a moment and try again.");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(
    (blob) => {
      if (!blob) {
        showCameraError("The frame could not be captured. Try again.");
        return;
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const file = new File([blob], `webcam_${stamp}.jpg`, { type: "image/jpeg" });
      closeCamera();
      onCapture?.(file);
    },
    "image/jpeg",
    0.92
  );
}

export function initCamera(captureHandler) {
  onCapture = captureHandler;
  $("#open-camera")?.addEventListener("click", openCamera);
  $("#camera-close")?.addEventListener("click", closeCamera);
  $("#camera-cancel")?.addEventListener("click", closeCamera);
  $("#camera-capture")?.addEventListener("click", captureFrame);
  $("#camera-dialog")?.addEventListener("close", stopStream);
  $("#camera-dialog")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeCamera();
  });
}
