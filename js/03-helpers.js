"use strict";

/* ── DOM helpers ───────────────────────────────────────────────────────── */

function h(tag, props, ...children) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) {
      continue;
    }

    if (key === "class") {
      element.className = value;
    } else if (key === "text") {
      element.textContent = value;
    } else if (key === "dataset") {
      Object.assign(element.dataset, value);
    } else if (key === "style") {
      Object.assign(element.style, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value") {
      element.value = value;
    } else if (key === "checked") {
      element.checked = Boolean(value);
    } else if (value === true) {
      element.setAttribute(key, "");
    } else {
      element.setAttribute(key, String(value));
    }
  }

  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.appendChild(use);
  return svg;
}

/* An icon button whose visible label appears on touch layouts, where a bare
   glyph is too easy to mistake. */
function iconButton(symbol, label, onClick, { danger = false, pressed = null, text = "", focusKey = null } = {}) {
  return h(
    "button",
    {
      type: "button",
      class: `icon-button${danger ? " is-danger" : ""}${pressed ? " is-on" : ""}`,
      title: label,
      "aria-label": label,
      "aria-pressed": pressed === null ? null : String(Boolean(pressed)),
      "data-focus-key": focusKey,
      onclick: onClick,
    },
    icon(symbol),
    text ? h("span", { class: "icon-button-text", "aria-hidden": "true", text }) : null
  );
}

// The server finds the product's own hibuddy page and redirects there, so the
// link needs no lookup until it is actually opened.
function hibuddyHref(item) {
  const params = new URLSearchParams({ name: item.name || "", brand: item.brand || "", type: item.type || "" });
  return `${HIBUDDY_ENDPOINT}?${params}`;
}

function hibuddyLink(item, { text = "" } = {}) {
  const label = `Compare store prices for ${item.name} on hibuddy`;
  return h(
    "a",
    { class: "icon-button", href: hibuddyHref(item), target: "_blank", rel: "noopener noreferrer", title: label, "aria-label": label },
    icon("i-price"),
    text ? h("span", { class: "icon-button-text", "aria-hidden": "true", text }) : null
  );
}

function chip(text, extraClass = "") {
  return h("span", { class: `chip ${extraClass}`.trim(), text });
}

function clear(element) {
  element.replaceChildren();
  return element;
}

function announce(message) {
  window.clearTimeout(announce.timer);
  announce.timer = window.setTimeout(() => {
    elements.announcer.textContent = message;
  }, 600);
}

/* ── Formatting ────────────────────────────────────────────────────────── */

const currencyFormat = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const dateFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "short", day: "numeric" });
const monthFormat = new Intl.DateTimeFormat("en-CA", { month: "short" });
const timeFormat = new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit" });

function formatCurrency(value) {
  return typeof value === "number" ? currencyFormat.format(value) : "—";
}

function formatPotency(value, unit = "%") {
  if (typeof value !== "number") {
    return "—";
  }
  return unit === "mg" ? `${trimNumber(value)} mg` : `${value.toFixed(1)}%`;
}

function formatRating(value) {
  return typeof value === "number" ? value.toFixed(1) : "—";
}

function formatDate(value) {
  if (!value) {
    return "—";
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return dateFormat.format(new Date(year, month - 1, day));
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const sameDay = today(date) === today();
  return sameDay ? `today at ${timeFormat.format(date)}` : dateFormat.format(date);
}

function formatRange(low, high) {
  if (typeof low !== "number" || typeof high !== "number") {
    return "";
  }
  return low === high ? `${trimNumber(low)}%` : `${trimNumber(low)}–${trimNumber(high)}%`;
}

function formatUnitPrice(entry) {
  const price = unitPrice(entry);
  if (!price) {
    return "—";
  }
  const unit = price.unit === "unit" ? "each" : `/${price.unit}`;
  return `${currencyFormat.format(price.value)}${unit === "each" ? " each" : unit}`;
}

function trimNumber(value) {
  return String(Number(value.toFixed(1)));
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function typeLabel(type) {
  return TYPE_LABELS[type] || "Other";
}

/* ── Theme and privacy ─────────────────────────────────────────────────── */

function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = prefs.theme;
  }

  elements.themeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === prefs.theme));
  });
}

function applyPrivacy() {
  document.body.classList.toggle("privacy", prefs.privacy);
  elements.privacyIndicator.hidden = !prefs.privacy;
  elements.privacyButton.setAttribute("aria-pressed", String(prefs.privacy));
  elements.privacyButton.title = prefs.privacy
    ? "Privacy mode is on: prices and notes are hidden"
    : "Privacy mode: hide prices and notes";
  elements.privacyButton.querySelector("use").setAttribute("href", prefs.privacy ? "#i-eye-off" : "#i-eye");
  applyTitle();
}

/* ── Discretion: plain title, panic cover, blank when switched away ─────

   Concealment for a glance over the shoulder or the phone's app switcher,
   not security: anyone with the device can still open the page. */

const PLAIN_ICON =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="6" y="3" width="20" height="26" rx="3" fill="#e8e6df" stroke="#8a877c" stroke-width="2"/><path d="M11 11h10M11 16h10M11 21h6" stroke="#8a877c" stroke-width="2" stroke-linecap="round"/></svg>');
const cover = { panic: false, away: false };

function applyTitle() {
  const plain = prefs.plainTitle || cover.panic || cover.away;
  document.title = plain ? "Notes" : "Cloudline";
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    icon.dataset.real = icon.dataset.real || icon.getAttribute("href");
    icon.setAttribute("href", plain ? PLAIN_ICON : icon.dataset.real);
  }
}

function applyCover() {
  const shown = cover.panic || cover.away;
  elements.cover.hidden = !shown;
  for (const child of document.body.children) {
    if (child !== elements.cover && child.tagName !== "SCRIPT") child.inert = shown;
  }
  applyTitle();
}

function togglePanic(on = !cover.panic) {
  cover.panic = on;
  applyCover();
}

function setupDiscretion() {
  elements.plainTitleToggle.checked = prefs.plainTitle;
  elements.blankAwayToggle.checked = prefs.blankAway;
  elements.plainTitleToggle.addEventListener("change", () => {
    prefs.plainTitle = elements.plainTitleToggle.checked;
    savePrefs();
    applyTitle();
  });
  elements.blankAwayToggle.addEventListener("change", () => {
    prefs.blankAway = elements.blankAwayToggle.checked;
    savePrefs();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "`" && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
      event.preventDefault();
      togglePanic();
    }
  });
  document.addEventListener("touchstart", (event) => {
    if (event.touches.length === 3) togglePanic(true);
  }, { passive: true });
  elements.cover.addEventListener("dblclick", () => togglePanic(false));

  /* The app switcher shows the page as it was when you left it: cover it
     then. It comes off by itself when you're back, unless panic put it up. */
  const away = (hidden) => {
    if (!prefs.blankAway) return;
    cover.away = hidden;
    applyCover();
  };
  document.addEventListener("visibilitychange", () => away(document.visibilityState === "hidden"));
  window.addEventListener("pagehide", () => away(true));
  window.addEventListener("pageshow", () => away(false));
}
