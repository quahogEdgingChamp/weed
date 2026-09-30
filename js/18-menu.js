"use strict";

/* ── Menu ──────────────────────────────────────────────────────────────── */

function toggleMenu(event) {
  event.stopPropagation();
  const open = elements.menuPanel.hidden;
  elements.menuPanel.hidden = !open;
  elements.menuButton.setAttribute("aria-expanded", String(open));
  if (open) {
    elements.menuPanel.querySelector("button")?.focus();
  }
}

function closeMenu({ restoreFocus = false } = {}) {
  if (elements.menuPanel.hidden) {
    return;
  }
  elements.menuPanel.hidden = true;
  elements.menuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    elements.menuButton.focus();
  }
}

function closeMenuOnOutsideClick(event) {
  if (!elements.menuPanel.hidden && !event.target.closest(".menu")) {
    closeMenu();
  }
}

function isEditable(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function handleGlobalKeys(event) {
  if (event.key === "Tab" && modalStack.length) {
    trapFocus(event);
    return;
  }

  if (event.key === "Escape") {
    if (modalStack.length) {
      event.preventDefault();
      modalStack[modalStack.length - 1].onRequestClose?.();
      return;
    }

    if (!elements.menuPanel.hidden) {
      closeMenu({ restoreFocus: true });
      return;
    }

    if (document.activeElement === elements.searchInput && elements.searchInput.value) {
      event.preventDefault();
      elements.searchInput.value = "";
      state.search = "";
      writeUrl({ replace: true });
      renderCollection();
    }
    return;
  }

  if (event.key === "/" && !modalStack.length && !isEditable(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!isCollectionView()) {
      showView("collection", { push: true });
    }
    event.preventDefault();
    elements.searchInput.focus();
    elements.searchInput.select();
  }
}

/* ── Modals ────────────────────────────────────────────────────────────── */

const modalStack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/* Everything outside the topmost modal is made inert, so neither the mouse,
   Tab, nor a screen reader's virtual cursor can wander behind it. */
function openModal(container, { onRequestClose, focus = true } = {}) {
  modalStack.push({ container, onRequestClose, opener: document.activeElement });
  syncModalLayers();
  if (focus) {
    focusFirst(container);
  }
}

function closeModal(container) {
  const index = modalStack.findIndex((entry) => entry.container === container);
  if (index < 0) {
    return;
  }

  const [entry] = modalStack.splice(index, 1);
  syncModalLayers();

  /* The control that opened the modal may have been re-rendered meanwhile
     (a favorite toggled in the panel redraws the table); find its twin. */
  let opener = entry.opener;
  if (opener && !opener.isConnected && opener.dataset?.focusKey) {
    opener = document.querySelector(`[data-focus-key="${CSS.escape(opener.dataset.focusKey)}"]`);
  }
  if (opener && opener.isConnected && typeof opener.focus === "function" && !opener.closest("[inert]")) {
    opener.focus({ preventScroll: true });
  } else if (modalStack.length) {
    focusFirst(modalStack[modalStack.length - 1].container);
  }
}

function syncModalLayers() {
  const top = modalStack[modalStack.length - 1]?.container;
  for (const layer of [elements.appbar, elements.banner, elements.main, elements.drawer, elements.dialogLayer]) {
    layer.inert = Boolean(top) && layer !== top && !layer.contains(top);
  }
  document.body.classList.toggle("modal-open", modalStack.length > 0);
}

function visibleFocusables(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(
    (element) => !element.closest("[hidden]") && !element.closest("[inert]") && element.getClientRects().length
  );
}

function focusFirst(container) {
  const fieldsFirst = visibleFocusables(container).filter((element) => element.matches("input, select, textarea"));
  const target = container.querySelector("[data-autofocus]") || fieldsFirst[0] || visibleFocusables(container)[0] || container;
  target.focus({ preventScroll: true });
}

function trapFocus(event) {
  const container = modalStack[modalStack.length - 1].container;
  const focusables = visibleFocusables(container);
  if (!focusables.length) {
    event.preventDefault();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

let dialogResolver = null;
const dialogQueue = [];

/* One dialog at a time; a second request waits for the first to close. */
function openDialog(options) {
  return new Promise((resolve) => {
    dialogQueue.push({ options, resolve });
    if (!dialogResolver) {
      showNextDialog();
    }
  });
}

function showNextDialog() {
  const next = dialogQueue.shift();
  if (!next) {
    return;
  }

  const { options, resolve } = next;
  const { title, body, actions, wide = false, dismissValue = null, validate = null } = options;
  const dialog = clear(elements.dialog);
  dialog.classList.toggle("is-wide", wide);

  const finish = (value) => {
    if (value !== dismissValue && validate && value !== null && !validate(value)) {
      return;
    }
    dialogResolver = null;
    elements.dialogLayer.hidden = true;
    closeModal(elements.dialogLayer);
    resolve(value);
    showNextDialog();
  };
  dialogResolver = finish;

  const primary = actions.find((action) => action.variant === "primary");
  append(dialog, [
    h(
      "header",
      { class: "dialog-head" },
      h("h2", { id: "dialog-title", text: title }),
      h("button", { type: "button", class: "btn btn-icon", "aria-label": "Close", onclick: () => finish(dismissValue) }, icon("i-close"))
    ),
    h("div", { class: "dialog-body" }, body),
    h(
      "footer",
      { class: "dialog-foot" },
      actions.map((action) =>
        h(
          "button",
          {
            type: "button",
            class: `btn ${action.variant === "primary" ? "btn-primary" : action.variant === "danger" ? "btn-danger" : "btn-secondary"}`,
            "data-autofocus": action === primary && !body.querySelector?.("input, textarea, select") ? true : null,
            onclick: () => finish(action.value),
          },
          action.label
        )
      )
    ),
  ]);

  elements.dialogLayer.hidden = false;
  openModal(elements.dialogLayer, { onRequestClose: () => finish(dismissValue) });
}

/* For a dialog that leads to another (Backups -> Preview): close this one so
   the next isn't queued behind it. */
function closeCurrentDialog() {
  dialogResolver?.(null);
}

function closeAllDialogs() {
  dialogQueue.length = 0;
  dialogResolver?.(null);
}

async function promptDialog({ title, label, placeholder = "", confirmLabel = "OK" }) {
  const input = h("input", { type: "text", placeholder, "data-autofocus": true, maxlength: "60" });
  const error = h("p", { class: "field-error", role: "alert", hidden: true });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dialogResolver?.("ok");
    }
  });

  const choice = await openDialog({
    title,
    body: h("div", { class: "dialog-form" }, h("label", null, label, input), error),
    actions: [
      { label: "Cancel", value: null },
      { label: confirmLabel, value: "ok", variant: "primary" },
    ],
    validate: () => {
      if (!input.value.trim()) {
        error.textContent = "Enter a name.";
        error.hidden = false;
        input.focus();
        return false;
      }
      return true;
    },
  });

  return choice === "ok" ? input.value.trim() : null;
}

/* ── Toast ─────────────────────────────────────────────────────────────── */

let toastAction = null;

function showToast(message, { action = null, duration = null } = {}) {
  toastAction = action?.run || null;
  elements.toastText.textContent = message;
  elements.toastAction.hidden = !action;
  elements.toastAction.textContent = action?.label || "";
  elements.toast.hidden = false;

  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(hideToast, duration || (action ? 7000 : 3200));
}

function hideToast() {
  elements.toast.hidden = true;
  toastAction = null;
}

function runToastAction() {
  const run = toastAction;
  hideToast();
  run?.();
}
