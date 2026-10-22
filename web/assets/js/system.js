import { reloadModel } from "./api.js";
import { $, copyText, formatBytes, setButtonBusy, showToast } from "./ui.js";

function setText(id, value) {
  const element = $(`#${id}`);
  if (element) element.textContent = value ?? "—";
}

function tagState(modelState) {
  if (modelState === "ready") return ["success", "Ready"];
  if (modelState === "loading" || modelState === "starting") return ["working", "Loading"];
  if (modelState === "error") return ["error", "Error"];
  return ["unavailable", "Unavailable"];
}

function rangeLabel(policy) {
  if (!policy) return "—";
  const min = Number(policy.min_pct);
  const max = policy.max_pct === null || policy.max_pct === undefined ? null : Number(policy.max_pct);
  if (policy.name === "CRITICAL") return `≥ ${min.toFixed(1)}%`;
  if (policy.name === "MINOR") return max === null ? `≥ ${min.toFixed(1)}%` : `< ${max.toFixed(1)}%`;
  return max === null ? `≥ ${min.toFixed(1)}%` : `${min.toFixed(1)}% – ${max.toFixed(1)}%`;
}

export function renderSystem(status) {
  const model = status?.model;
  const tag = $("#system-model-tag");
  if (tag) {
    const [stateName, text] = tagState(model?.state);
    tag.dataset.state = stateName;
    tag.textContent = text;
  }

  setText("spec-checkpoint", model?.checkpoint?.name);
  setText("spec-path", model?.checkpoint?.path);
  setText("spec-task", model?.task);
  setText("spec-classes", Array.isArray(model?.classes) ? model.classes.join(", ") : "—");
  setText("spec-device", model?.device_label);
  setText("spec-imgsz", model?.imgsz ? `${model.imgsz} px` : "—");
  setText("spec-size", model?.checkpoint?.size_bytes ? formatBytes(model.checkpoint.size_bytes) : "—");

  const errorBox = $("#system-model-error");
  const errorText = $("#system-model-error-text");
  if (errorBox && errorText) {
    const hasError = Boolean(model?.error) && !model?.ready;
    errorBox.hidden = !hasError;
    errorText.textContent = model?.error || "";
  }

  const runtime = status?.runtime || {};
  setText("rt-python", runtime.python);
  setText("rt-platform", runtime.platform);
  setText("rt-machine", runtime.machine);
  setText("rt-torch", runtime.torch);
  setText("rt-ultralytics", runtime.ultralytics);
  setText("rt-opencv", runtime.opencv);
  setText("rt-numpy", runtime.numpy);
  setText("rt-fastapi", runtime.fastapi);

  const policyBody = $("#severity-policy-body");
  if (policyBody) {
    const policy = status?.severity_policy || [];
    if (policy.length) {
      policyBody.innerHTML = policy
        .map(
          (row) => `<tr>
            <td><span class="sev-chip" data-sev="${String(row.name).toLowerCase()}">${row.name}</span></td>
            <td class="mono">${rangeLabel(row)}</td>
            <td>${row.description || ""}</td>
          </tr>`
        )
        .join("");
    } else {
      policyBody.innerHTML = '<tr><td colspan="3" class="table-loading">Severity policy is unavailable.</td></tr>';
    }
  }

  const reload = $("#reload-model");
  if (reload) {
    const loading = model?.state === "loading" || model?.state === "starting";
    reload.disabled = loading;
  }
}

export function initSystem() {
  $("#reload-model")?.addEventListener("click", async () => {
    const button = $("#reload-model");
    setButtonBusy(button, true, "Reloading…");
    try {
      await reloadModel();
      showToast("Checkpoint reloaded.");
      window.dispatchEvent(new CustomEvent("infrascan:refresh-status"));
    } catch (error) {
      showToast(error.message || "The checkpoint could not be reloaded.", "error");
    } finally {
      setButtonBusy(button, false);
      const modelState = window.__infrascanStatus?.model?.state;
      if (button) button.disabled = modelState === "loading" || modelState === "starting";
    }
  });

  document.addEventListener("click", (event) => {
    const copy = event.target.closest(".copy-btn");
    if (!copy) return;
    const value = copy.dataset.copy;
    if (value) copyText(value, "Command copied.");
  });
}
