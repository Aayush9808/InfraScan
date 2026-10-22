import { $, $$, escapeHtml, icon } from "./ui.js";

let dialog = null;
let trigger = null;
let input = null;
let list = null;
let provider = null;
let visible = [];
let activeIndex = 0;
let previousFocus = null;

function matches(command, query) {
  if (!query) return true;
  const haystack = [command.label, command.hint, command.keywords].filter(Boolean).join(" ").toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function render(query) {
  const normalized = String(query || "").trim().toLowerCase();
  const commands = (provider?.() || []).filter((command) => !command.when || command.when());
  visible = commands.filter((command) => matches(command, normalized));

  if (!visible.length) {
    list.innerHTML = '<p class="palette__empty">No matching pages or actions.</p>';
    input.removeAttribute("aria-activedescendant");
    return;
  }

  list.innerHTML = visible
    .map(
      (command, index) => `<button class="palette__item" id="palette-item-${index}" type="button" role="option" tabindex="-1" data-index="${index}" aria-selected="${index === 0}">
        ${icon(command.icon || "arrow")}
        <span>${escapeHtml(command.label)}</span>
        ${command.hint ? `<small>${escapeHtml(command.hint)}</small>` : ""}
      </button>`
    )
    .join("");
  activeIndex = 0;
  setActive(0);
}

function setActive(next) {
  const items = $$(".palette__item", list);
  if (!items.length) return;
  activeIndex = (next + items.length) % items.length;
  items.forEach((item, index) => {
    const isActive = index === activeIndex;
    item.classList.toggle("is-active", isActive);
    item.setAttribute("aria-selected", String(isActive));
  });
  const current = items[activeIndex];
  current.scrollIntoView({ block: "nearest" });
  input.setAttribute("aria-activedescendant", current.id);
}

function run(index) {
  const command = visible[index];
  if (!command) return;
  dialog.close();
  window.setTimeout(() => {
    try {
      command.run();
    } catch (error) {
      console.error("[infrascan] palette command failed", error);
    }
  }, 0);
}

function open() {
  if (!dialog || dialog.open) return;
  previousFocus = document.activeElement;
  input.value = "";
  dialog.showModal();
  render("");
  input.focus();
}

function close() {
  if (dialog?.open) dialog.close();
}

export function initPalette(commandProvider) {
  provider = commandProvider;
  dialog = $("#palette");
  trigger = $("#palette-open");
  input = $("#palette-input");
  list = $("#palette-list");
  if (!dialog || !trigger || !input || !list) return;

  trigger.addEventListener("click", open);

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(visible.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(activeIndex);
    }
  });

  list.addEventListener("click", (event) => {
    const item = event.target.closest(".palette__item");
    if (item) run(Number(item.dataset.index));
  });
  list.addEventListener("mousemove", (event) => {
    const item = event.target.closest(".palette__item");
    if (item && Number(item.dataset.index) !== activeIndex) setActive(Number(item.dataset.index));
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    list.innerHTML = "";
    visible = [];
    input.value = "";
    input.removeAttribute("aria-activedescendant");
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      if (dialog.open) close();
      else open();
    }
  });

  const shortcut = trigger.querySelector("kbd");
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
  if (shortcut) shortcut.textContent = isMac ? "⌘K" : "Ctrl K";
}
