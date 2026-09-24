/* ---------------------------------------------------------------------------
   Cloudline - a personal collection journal and purchase planner.

   Two stores, kept in step: localStorage so the page works offline and from
   file://, and weed_chart.json on the server so every device sees the same
   collection. Every write to the server names the revision it was based on;
   if someone else wrote in between, the server refuses, this page merges the
   two versions record by record, and tries again. Nothing is reported as
   saved until the server has said so.

   Data rules live in core.js; this file is the page.
--------------------------------------------------------------------------- */

"use strict";

const Core = window.CloudlineCore;
const {
  TYPE_LABELS,
  STATUS_LABELS,
  PRIORITY_LABELS,
  MG_TYPES,
  TRASH_RETENTION_DAYS,
  uuid,
  tagKey,
  normalizeTags,
  today,
  normalizeAmount,
  normalizeEntry,
  normalizeWishItem,
  normalizeExperience,
  emptyDoc,
  migrateDoc,
  docCounts,
  isEmptyDoc,
  docsEqual,
  syncable,
  purgeTrash,
  mergeDocs,
  combineDocs,
  parseQuantity,
  unitPrice,
  productLinkKey,
  nameKey,
  relatedPurchases,
  defaultFilters,
  matchesFilters,
  activeFilterCount,
  sortEntries,
  sortWishlist,
  monthlySpend,
  spendInMonth,
  ratingDistribution,
  countBy,
  averageThcPercent,
  isLiked,
  matchScore,
  awaitingRating,
} = Core;

const DATA_KEY = "cloudline-data-v2";
const SYNC_KEY = "cloudline-sync-v2";
const PREFS_KEY = "cloudline-prefs-v1";
const DRAFT_KEY = "cloudline-draft-v1";
const RECOVERY_KEY = "cloudline-recovery-v1";
const LEGACY_ENTRIES_KEY = "cloudline-cannabis-log-v1";
const LEGACY_WISHLIST_KEY = "cloudline-shopping-list-v1";

const SYNC_ENDPOINT = "/api/state";
const SNAPSHOT_ENDPOINT = "/api/snapshots";
const LOOKUP_ENDPOINT = "/api/lookup";
const POLL_MS = 5000;
const SAVE_DEBOUNCE_MS = 400;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;

const VIEWS = ["collection", "favorites", "shopping", "insights", "research"];

/* ── Storage ───────────────────────────────────────────────────────────── */

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.error(`Could not save ${key}`, error);
    return false;
  }
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    /* Nothing to do: the key is unreachable either way. */
  }
}

function readJson(key) {
  try {
    return JSON.parse(storageGet(key) || "null");
  } catch (error) {
    console.error(`Could not read ${key}`, error);
    return null;
  }
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function loadLocalData() {
  const stored = readJson(DATA_KEY);
  if (stored) {
    return migrateDoc(stored).doc;
  }

  /* First run after the v1 page: its two separate keys. */
  const products = readJson(LEGACY_ENTRIES_KEY);
  const wishlist = readJson(LEGACY_WISHLIST_KEY);
  return migrateDoc({
    products: Array.isArray(products) ? products : products?.products || [],
    wishlist: Array.isArray(wishlist) ? wishlist : [],
  }).doc;
}

function loadSyncMeta() {
  const meta = readJson(SYNC_KEY) || {};
  return {
    datasetId: typeof meta.datasetId === "string" ? meta.datasetId : null,
    revision: typeof meta.revision === "string" ? meta.revision : null,
    dirty: Boolean(meta.dirty),
    base: meta.base ? migrateDoc(meta.base).doc : null,
  };
}

function loadPrefs() {
  const stored = readJson(PREFS_KEY) || {};
  const filters = { ...defaultFilters(), ...(stored.filters || {}) };
  return {
    theme: ["system", "light", "dark"].includes(stored.theme) ? stored.theme : "system",
    privacy: Boolean(stored.privacy),
    sortBy: typeof stored.sortBy === "string" ? stored.sortBy : "purchaseDate-desc",
    wishSort: typeof stored.wishSort === "string" ? stored.wishSort : "priority",
    filters,
    savedViews: Array.isArray(stored.savedViews) ? stored.savedViews.slice(0, 20) : [],
    reminders: {
      enabled: stored.reminders?.enabled !== false,
      snoozeUntil: typeof stored.reminders?.snoozeUntil === "string" ? stored.reminders.snoozeUntil : "",
      dismissed: Array.isArray(stored.reminders?.dismissed) ? stored.reminders.dismissed.slice(-200) : [],
    },
  };
}

function savePrefs() {
  storageSet(PREFS_KEY, JSON.stringify(prefs));
}

/* ── State ─────────────────────────────────────────────────────────────── */

const prefs = loadPrefs();
const meta = loadSyncMeta();

const state = {
  data: loadLocalData(),
  view: "collection",
  search: "",
  selected: new Set(),
  storageOk: true,
  drawer: {
    mode: null,
    entryId: null,
    formMode: null,
    sourceWishId: null,
    productKey: "",
    sourceUrl: "",
    returnToDetail: null,
    baseline: "",
    potencyTouched: false,
  },
  lastLookupUrl: "",
};

const sync = {
  available: window.location.protocol === "http:" || window.location.protocol === "https:",
  hydrated: false,
  hydrating: false,
  awaitingChoice: false,
  legacy: false,
  datasetId: meta.datasetId,
  revision: meta.revision,
  base: meta.base,
  dirty: meta.dirty,
  generation: 0,
  inFlight: false,
  pendingReason: null,
  saveTimer: null,
  retryTimer: null,
  retryDelay: 0,
  status: "loading",
  lastError: "",
  rejected: false,
  lastSavedAt: null,
};

/* ── Elements ──────────────────────────────────────────────────────────── */

const $ = (selector) => document.querySelector(selector);

const elements = {
  appbar: $("#appbar"),
  main: $("#main"),
  banner: $("#banner"),
  bannerText: $("#banner-text"),
  bannerRetry: $("#banner-retry"),
  bannerExport: $("#banner-export"),
  tabs: document.querySelectorAll(".tab"),
  views: {
    collection: $("#view-collection"),
    shopping: $("#view-shopping"),
    insights: $("#view-insights"),
    research: $("#view-research"),
  },
  tabCounts: {
    collection: $("#tab-count-collection"),
    favorites: $("#tab-count-favorites"),
    shopping: $("#tab-count-shopping"),
  },

  syncState: $("#sync-state"),
  syncLabel: $("#sync-label"),
  syncDetail: $("#sync-detail"),
  privacyButton: $("#privacy-button"),
  privacyIndicator: $("#privacy-indicator"),

  menuButton: $("#menu-button"),
  menuPanel: $("#menu-panel"),
  exportButton: $("#export-button"),
  importButton: $("#import-button"),
  importInput: $("#import-input"),
  backupsButton: $("#backups-button"),
  trashButton: $("#trash-button"),
  tagsButton: $("#tags-button"),
  themeButtons: document.querySelectorAll("[data-theme-choice]"),
  remindersToggle: $("#reminders-toggle"),
  resetButton: $("#reset-button"),

  collectionHeading: $("#collection-heading"),
  collectionDescription: $("#collection-description"),
  addEntryButton: $("#add-entry-button"),
  ocsEntryButton: $("#ocs-entry-button"),
  statTotal: $("#stat-total"),
  statFavorites: $("#stat-favorites"),
  statSpend: $("#stat-spend"),
  statMonth: $("#stat-month"),
  statMonthNote: $("#stat-month-note"),

  reminder: $("#reminder"),
  reminderText: $("#reminder-text"),
  reminderReview: $("#reminder-review"),
  reminderSnooze: $("#reminder-snooze"),
  reminderOff: $("#reminder-off"),

  searchInput: $("#search-input"),
  filterToggle: $("#filter-toggle"),
  filterCount: $("#filter-count"),
  filterPanel: $("#filter-panel"),
  filterTypes: $("#filter-types"),
  filterStatuses: $("#filter-statuses"),
  filterBrands: $("#filter-brands"),
  filterBrandsGroup: $("#filter-brands-group"),
  filterTags: $("#filter-tags"),
  filterTagsGroup: $("#filter-tags-group"),
  filterRating: $("#filter-rating"),
  filterPriceMin: $("#filter-price-min"),
  filterPriceMax: $("#filter-price-max"),
  filterDateFrom: $("#filter-date-from"),
  filterDateTo: $("#filter-date-to"),
  filterRepurchase: $("#filter-repurchase"),
  savedViews: $("#saved-views"),
  saveViewButton: $("#save-view-button"),
  sortBy: $("#sort-by"),
  resultCount: $("#result-count"),
  filterChips: $("#filter-chips"),

  bulkBar: $("#bulk-bar"),
  bulkCount: $("#bulk-count"),
  bulkSelectAll: $("#bulk-select-all"),
  bulkClear: $("#bulk-clear"),
  bulkCompare: $("#bulk-compare"),
  bulkEdit: $("#bulk-edit"),
  bulkExport: $("#bulk-export"),
  bulkDelete: $("#bulk-delete"),

  tableCard: $("#table-card"),
  selectVisible: $("#select-visible"),
  entriesBody: $("#entries-body"),
  collectionEmpty: $("#collection-empty"),
  emptyTitle: $("#empty-title"),
  emptyNote: $("#empty-note"),
  emptyActions: $("#empty-actions"),
  typeBars: $("#type-bars"),
  topThcList: $("#top-thc-list"),

  linkForm: $("#link-form"),
  linkInput: $("#link-input"),
  linkSubmit: $("#link-submit"),
  linkStatus: $("#link-status"),
  linkStatusText: $("#link-status-text"),
  linkRetry: $("#link-retry"),
  manualDetails: $("#manual-details"),
  manualForm: $("#manual-form"),
  manualName: $("#manual-name"),
  manualNameError: $("#manual-name-error"),
  manualBrand: $("#manual-brand"),
  manualPrice: $("#manual-price"),
  manualPriority: $("#manual-priority"),
  manualNote: $("#manual-note"),
  wishSort: $("#wish-sort"),
  wishlist: $("#wishlist"),
  wishCount: $("#wish-count"),
  wishTotal: $("#wish-total"),

  spendChart: $("#spend-chart"),
  spendNote: $("#spend-note"),
  budgetForm: $("#budget-form"),
  budgetInput: $("#budget-input"),
  budgetSummary: $("#budget-summary"),
  inventorySummary: $("#inventory-summary"),
  ratingChart: $("#rating-chart"),
  ratingsNote: $("#ratings-note"),
  brandChart: $("#brand-chart"),
  repurchaseList: $("#repurchase-list"),
  valueList: $("#value-list"),
  valueNote: $("#value-note"),

  scrim: $("#scrim"),
  drawer: $("#drawer"),
  drawerTitle: $("#drawer-title"),
  drawerSubtitle: $("#drawer-subtitle"),
  drawerClose: $("#drawer-close"),
  detailView: $("#detail-view"),
  detailFoot: $("#detail-foot"),
  form: $("#product-form"),
  formFoot: $("#form-foot"),
  formError: $("#form-error"),
  formSubmit: $("#form-submit"),
  drawerCancel: $("#drawer-cancel"),
  draftNotice: $("#draft-notice"),
  draftRestore: $("#draft-restore"),
  draftDiscard: $("#draft-discard"),
  formOcs: $("#form-ocs"),
  formOcsInput: $("#form-ocs-input"),
  formOcsButton: $("#form-ocs-button"),
  formOcsStatus: $("#form-ocs-status"),
  duplicateHint: $("#duplicate-hint"),
  amountHint: $("#amount-hint"),
  sectionPurchase: $("#section-purchase"),
  sectionExperience: $("#section-experience"),
  sectionInventory: $("#section-inventory"),
  brandOptions: $("#brand-options"),
  vendorOptions: $("#vendor-options"),
  tagOptions: $("#tag-options"),

  dialogLayer: $("#dialog-layer"),
  dialog: $("#dialog"),
  toast: $("#toast"),
  toastText: $("#toast-text"),
  toastAction: $("#toast-action"),
  announcer: $("#announcer"),
};

/* The entry form's inputs, by field name. */
const fields = Object.fromEntries(
  [
    "name", "type", "brand", "price", "rating", "purchaseDate", "vendor", "amount", "strain",
    "extraction", "batch", "thc", "cbd", "terpenePercent", "terpenes", "effects", "tags", "notes",
    "status", "openedAt", "remaining", "favorite",
  ].map((name) => [name, document.getElementById(name)])
);

/* ── Boot ──────────────────────────────────────────────────────────────── */

function initialize() {
  applyTheme();
  applyPrivacy();
  readUrl();

  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      showView(tab.dataset.view, { push: true });
    });
  });

  elements.searchInput.value = state.search;
  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    renderCollection();
    writeUrl({ replace: true });
  });

  elements.sortBy.value = prefs.sortBy;
  elements.sortBy.addEventListener("change", (event) => {
    prefs.sortBy = event.target.value;
    savePrefs();
    renderCollection();
  });

  elements.filterToggle.addEventListener("click", () => {
    const open = elements.filterPanel.hidden;
    elements.filterPanel.hidden = !open;
    elements.filterToggle.setAttribute("aria-expanded", String(open));
  });
  bindFilterFields();
  elements.saveViewButton.addEventListener("click", saveCurrentView);

  elements.addEntryButton.addEventListener("click", () => openEntryForm({ mode: "new" }));
  elements.ocsEntryButton.addEventListener("click", () => openEntryForm({ mode: "new", focusOcs: true }));

  elements.selectVisible.addEventListener("change", toggleSelectVisible);
  elements.bulkSelectAll.addEventListener("click", selectAllVisible);
  elements.bulkClear.addEventListener("click", () => {
    state.selected.clear();
    renderCollection();
  });
  elements.bulkCompare.addEventListener("click", () => openCompare([...state.selected]));
  elements.bulkEdit.addEventListener("click", openBulkEdit);
  elements.bulkExport.addEventListener("click", exportSelected);
  elements.bulkDelete.addEventListener("click", () => deleteEntries([...state.selected]));

  elements.form.addEventListener("submit", handleSubmit);
  elements.form.addEventListener("input", handleFormInput);
  elements.form.addEventListener("change", handleFormInput);
  fields.amount.addEventListener("blur", () => {
    fields.amount.value = normalizeAmount(fields.amount.value);
    updateAmountHint();
  });
  fields.type.addEventListener("change", suggestPotencyUnit);
  elements.form.querySelectorAll('input[name="potencyUnit"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.drawer.potencyTouched = true;
      applyPotencyUnit(radio.value);
      ["thc", "cbd"].forEach((name) => fields[name].getAttribute("aria-invalid") && validateField(name));
    });
  });
  elements.formOcsButton.addEventListener("click", fillFormFromOcs);
  elements.formOcsInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      fillFormFromOcs();
    }
  });
  elements.draftRestore.addEventListener("click", restoreDraft);
  elements.draftDiscard.addEventListener("click", () => {
    storageRemove(DRAFT_KEY);
    elements.draftNotice.hidden = true;
  });

  elements.drawerClose.addEventListener("click", requestCloseDrawer);
  elements.drawerCancel.addEventListener("click", cancelForm);
  elements.scrim.addEventListener("click", requestCloseDrawer);

  elements.linkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    lookupForShopping(elements.linkInput.value.trim());
  });
  elements.linkRetry.addEventListener("click", () => lookupForShopping(state.lastLookupUrl, { skipDuplicateCheck: true }));
  elements.manualForm.addEventListener("submit", handleManualAdd);
  elements.wishSort.value = prefs.wishSort;
  elements.wishSort.addEventListener("change", (event) => {
    prefs.wishSort = event.target.value;
    savePrefs();
    renderWishlist();
  });

  elements.budgetForm.addEventListener("submit", handleBudget);

  elements.menuButton.addEventListener("click", toggleMenu);
  elements.exportButton.addEventListener("click", () => {
    closeMenu();
    exportData();
  });
  elements.importButton.addEventListener("click", () => {
    closeMenu();
    elements.importInput.click();
  });
  elements.importInput.addEventListener("change", importData);
  elements.backupsButton.addEventListener("click", () => {
    closeMenu();
    openBackups();
  });
  elements.trashButton.addEventListener("click", () => {
    closeMenu();
    openTrash();
  });
  elements.tagsButton.addEventListener("click", () => {
    closeMenu();
    openTagManager();
  });
  elements.themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      prefs.theme = button.dataset.themeChoice;
      savePrefs();
      applyTheme();
    });
  });
  elements.remindersToggle.checked = prefs.reminders.enabled;
  elements.remindersToggle.addEventListener("change", () => {
    prefs.reminders.enabled = elements.remindersToggle.checked;
    savePrefs();
    renderReminder();
  });
  elements.resetButton.addEventListener("click", () => {
    closeMenu();
    confirmClearAll();
  });

  elements.privacyButton.addEventListener("click", () => {
    prefs.privacy = !prefs.privacy;
    savePrefs();
    applyPrivacy();
  });

  elements.reminderReview.addEventListener("click", reviewNextUnrated);
  elements.reminderSnooze.addEventListener("click", () => {
    prefs.reminders.snoozeUntil = today(new Date(Date.now() + 7 * 86400000));
    savePrefs();
    renderReminder();
    showToast("Rating reminders snoozed for a week.");
  });
  elements.reminderOff.addEventListener("click", () => {
    prefs.reminders.enabled = false;
    elements.remindersToggle.checked = false;
    savePrefs();
    renderReminder();
    showToast("Rating reminders are off. Turn them back on from the menu.");
  });

  elements.syncState.addEventListener("click", handleSyncClick);
  elements.bannerRetry.addEventListener("click", retryNow);
  elements.bannerExport.addEventListener("click", exportData);
  elements.toastAction.addEventListener("click", runToastAction);

  document.addEventListener("keydown", handleGlobalKeys);
  document.addEventListener("click", closeMenuOnOutsideClick);
  window.addEventListener("popstate", handlePopState);
  window.addEventListener("pagehide", saveDraft);
  window.addEventListener("online", retryNow);
  window.addEventListener("offline", () => {
    if (sync.available) {
      sync.status = "offline";
      renderSync();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      poll();
    }
  });

  showView(state.view, { push: false });
  setLinkStatus("");
  openFromUrl();

  hydrate();
  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      poll();
    }
  }, POLL_MS);

  registerServiceWorker();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && window.isSecureContext && sync.available) {
    navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Offline support unavailable", error));
  }
}

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
}

/* ── Views and history ─────────────────────────────────────────────────── */

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  state.view = VIEWS.includes(view) ? view : "collection";
  state.search = (params.get("q") || "").slice(0, 200);
}

function writeUrl({ replace = false, entry = null } = {}) {
  const params = new URLSearchParams();
  if (state.view !== "collection") {
    params.set("view", state.view);
  }
  if (state.search && isCollectionView()) {
    params.set("q", state.search);
  }
  if (entry) {
    params.set("entry", entry);
  }

  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  const historyState = { view: state.view, entry };

  if (replace) {
    window.history.replaceState(historyState, "", url);
  } else if (url !== `${window.location.pathname}${window.location.search}`) {
    window.history.pushState(historyState, "", url);
  }
}

function openFromUrl() {
  const entryId = new URLSearchParams(window.location.search).get("entry");
  if (entryId && state.data.products.some((entry) => entry.id === entryId)) {
    openDetail(entryId, { push: false });
  }
}

async function handlePopState() {
  const previousView = state.view;
  readUrl();
  elements.searchInput.value = state.search;
  const entryId = new URLSearchParams(window.location.search).get("entry");

  if (!elements.drawer.hidden && state.drawer.mode === "form" && isFormDirty()) {
    const keep = (await confirmDiscard()) === "keep";
    if (keep) {
      writeUrl({ entry: state.drawer.entryId });
      return;
    }
  }

  if (entryId && state.data.products.some((entry) => entry.id === entryId)) {
    openDetail(entryId, { push: false });
  } else if (!elements.drawer.hidden) {
    closeDrawer({ updateUrl: false });
  }

  if (state.view !== previousView) {
    showView(state.view, { push: false });
  } else {
    renderAll();
  }
}

function isCollectionView() {
  return state.view === "collection" || state.view === "favorites";
}

function showView(view, { push = false } = {}) {
  const changed = state.view !== view;
  state.view = VIEWS.includes(view) ? view : "collection";

  elements.views.collection.hidden = !isCollectionView();
  elements.views.shopping.hidden = state.view !== "shopping";
  elements.views.insights.hidden = state.view !== "insights";
  elements.views.research.hidden = state.view !== "research";

  elements.tabs.forEach((tab) => {
    if (tab.dataset.view === state.view) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  });

  if (push) {
    writeUrl();
  }

  if (changed || push) {
    state.selected.clear();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  renderAll();
}

function renderAll() {
  renderCounts();

  if (isCollectionView()) {
    renderCollection();
  } else if (state.view === "shopping") {
    renderWishlist();
  } else if (state.view === "research") {
    window.CloudlineResearch?.render();
  } else {
    renderInsights();
  }

  renderSync();
}

function renderCounts() {
  elements.tabCounts.collection.textContent = String(state.data.products.length);
  elements.tabCounts.favorites.textContent = String(state.data.products.filter((entry) => entry.favorite).length);
  elements.tabCounts.shopping.textContent = String(state.data.wishlist.length);
}

/* ── Collection ────────────────────────────────────────────────────────── */

function scopeEntries() {
  return state.view === "favorites" ? state.data.products.filter((entry) => entry.favorite) : state.data.products;
}

function visibleEntries() {
  const filtered = scopeEntries().filter((entry) => matchesFilters(entry, prefs.filters, state.search));
  return sortEntries(filtered, prefs.sortBy);
}

function renderCollection() {
  if (!isCollectionView()) {
    return;
  }

  const favorites = state.view === "favorites";
  elements.collectionHeading.textContent = favorites ? "Favorites" : "Collection";
  elements.collectionDescription.textContent = favorites
    ? "The ones you starred. Search and filters work here too."
    : "Everything you've bought, what it was like, and whether to buy it again.";

  const visible = visibleEntries();
  const scope = scopeEntries();

  /* Drop selections of records that no longer exist. */
  const ids = new Set(state.data.products.map((entry) => entry.id));
  for (const id of state.selected) {
    if (!ids.has(id)) {
      state.selected.delete(id);
    }
  }

  renderStats();
  renderReminder();
  renderFilterOptions();
  renderFilterChips(visible.length, scope.length);
  renderBulkBar(visible);
  renderTable(visible, scope);
  renderTypeBars(visible);
  renderTopThc(visible);
}

/* Totals always cover the whole collection, whatever is filtered, so "Total
   spend" means one thing. */
function renderStats() {
  const entries = state.data.products;
  const spend = entries.reduce((sum, entry) => sum + (entry.price || 0), 0);
  const month = spendInMonth(entries);
  const budget = state.data.settings.monthlyBudget;

  elements.statTotal.textContent = String(entries.length);
  elements.statFavorites.textContent = String(entries.filter((entry) => entry.favorite).length);
  elements.statSpend.textContent = entries.some((entry) => typeof entry.price === "number") ? formatCurrency(spend) : "—";
  elements.statMonth.textContent = formatCurrency(month);
  elements.statMonthNote.textContent =
    typeof budget === "number"
      ? month > budget
        ? `${formatCurrency(month - budget)} over budget`
        : `${formatCurrency(budget - month)} left of ${formatCurrency(budget)}`
      : "";
  elements.statMonthNote.classList.toggle("is-over", typeof budget === "number" && month > budget);
}

/* Re-rendering a list replaces its buttons; put focus back on the twin of
   whichever one had it, so keyboard users don't get thrown to the top. */
function keepFocus(render) {
  const key = document.activeElement?.dataset?.focusKey;
  render();
  if (key && !document.activeElement?.dataset?.focusKey) {
    document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }
}

function renderTable(visible, scope) {
  keepFocus(() => renderTableRows(visible, scope));
}

function renderTableRows(visible, scope) {
  clear(elements.entriesBody);

  const noEntries = state.data.products.length === 0;
  const noneInScope = scope.length === 0;
  const empty = visible.length === 0;

  elements.tableCard.hidden = empty;
  elements.collectionEmpty.hidden = !empty;

  if (empty) {
    clear(elements.emptyActions);

    if (noEntries) {
      elements.emptyTitle.textContent = "Start your collection";
      elements.emptyNote.textContent = "Log something you've bought, or paste an OCS link and let it fill itself in.";
      append(elements.emptyActions, [
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openEntryForm({ mode: "new" }) }, icon("i-plus"), "Add first entry"),
        h("button", { type: "button", class: "btn btn-secondary", onclick: () => openEntryForm({ mode: "new", focusOcs: true }) }, "Paste an OCS link"),
      ]);
    } else if (state.view === "favorites" && noneInScope) {
      elements.emptyTitle.textContent = "No favorites yet";
      elements.emptyNote.textContent = "Star an entry in your collection and it will be kept here.";
      append(elements.emptyActions, [
        h("button", { type: "button", class: "btn btn-secondary", onclick: () => showView("collection", { push: true }) }, "Browse collection"),
      ]);
    } else {
      elements.emptyTitle.textContent = "Nothing matches";
      elements.emptyNote.textContent = state.search
        ? `No ${state.view === "favorites" ? "favorites" : "entries"} match "${state.search}" with the current filters.`
        : "No entries match the current filters.";
      append(elements.emptyActions, [
        h("button", { type: "button", class: "btn btn-secondary", onclick: clearAllFilters }, "Clear search and filters"),
      ]);
    }

    elements.selectVisible.checked = false;
    elements.selectVisible.indeterminate = false;
    return;
  }

  for (const entry of visible) {
    elements.entriesBody.appendChild(entryRow(entry));
  }

  const selectedVisible = visible.filter((entry) => state.selected.has(entry.id)).length;
  elements.selectVisible.checked = selectedVisible > 0 && selectedVisible === visible.length;
  elements.selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
}

function entryRow(entry) {
  const selected = state.selected.has(entry.id);
  const facts = [
    typeLabel(entry.type),
    typeof entry.thc === "number" ? `${formatPotency(entry.thc, entry.potencyUnit)} THC` : "",
    typeof entry.rating === "number" ? `★ ${formatRating(entry.rating)}` : "",
  ].filter(Boolean);

  const subtitle = [entry.brand, entry.amount, entry.purchaseDate ? formatDate(entry.purchaseDate) : ""]
    .filter(Boolean)
    .join(" · ");

  return h(
    "tr",
    { class: selected ? "is-selected" : "", dataset: { id: entry.id, type: entry.type || "other" } },
    h(
      "td",
      { class: "col-select" },
      h("input", {
        type: "checkbox",
        checked: selected,
        "aria-label": `Select ${entry.name}`,
        onchange: (event) => {
          if (event.target.checked) {
            state.selected.add(entry.id);
          } else {
            state.selected.delete(entry.id);
          }
          renderCollection();
        },
      })
    ),
    h(
      "td",
      { class: "cell-name" },
      h("button", { type: "button", class: "name-link", "data-focus-key": `name:${entry.id}`, onclick: () => openDetail(entry.id) }, entry.name),
      h("span", { class: "cell-sub", text: subtitle || "No details yet" }),
      h(
        "span",
        { class: "row-facts" },
        facts.join(" · "),
        typeof entry.price === "number" ? h("span", { class: "private" }, ` · ${formatCurrency(entry.price)}`) : null
      ),
      entry.tags.length || entry.status
        ? h(
            "span",
            { class: "row-tags" },
            entry.status ? chip(STATUS_LABELS[entry.status], `chip-status chip-status-${entry.status}`) : null,
            entry.tags.slice(0, 4).map((tag) => chip(tag, "chip-tag"))
          )
        : null
    ),
    h("td", { "data-label": "Type" }, h("span", { class: `badge badge-${entry.type}`, text: typeLabel(entry.type) })),
    h("td", { class: "num", "data-label": "THC" }, formatPotency(entry.thc, entry.potencyUnit)),
    h("td", { class: "num private", "data-label": "Price" }, formatCurrency(entry.price)),
    h(
      "td",
      { class: "num", "data-label": "Rating" },
      typeof entry.rating === "number"
        ? h("span", { class: "rating-pill", dataset: { level: entry.rating >= 8 ? "high" : entry.rating >= 6 ? "mid" : "low" } }, formatRating(entry.rating))
        : "—"
    ),
    h(
      "td",
      { class: "row-actions" },
      iconButton("i-star", entry.favorite ? `Remove ${entry.name} from favorites` : `Add ${entry.name} to favorites`, () => toggleFavorite(entry.id), {
        pressed: entry.favorite,
        text: "Favorite",
        focusKey: `fav:${entry.id}`,
      }),
      iconButton("i-pencil", `Edit ${entry.name}`, () => openEntryForm({ mode: "edit", entryId: entry.id }), { text: "Edit", focusKey: `edit:${entry.id}` }),
      iconButton("i-trash", `Delete ${entry.name}`, () => deleteEntries([entry.id]), { danger: true, text: "Delete" })
    )
  );
}

function renderTypeBars(entries) {
  clear(elements.typeBars);
  const counts = countBy(entries, (entry) => entry.type);

  if (!counts.length) {
    elements.typeBars.appendChild(h("p", { class: "panel-empty", text: "Nothing to count." }));
    return;
  }

  const highest = counts[0][1];
  for (const [type, count] of counts) {
    const active = prefs.filters.types.includes(type);
    elements.typeBars.appendChild(
      barButton({
        label: typeLabel(type),
        value: count,
        max: highest,
        active,
        title: `${typeLabel(type)}: ${plural(count, "entry", "entries")}. ${active ? "Remove this filter" : "Show only this type"}`,
        onClick: () => {
          toggleFilterValue("types", type);
          renderCollection();
        },
      })
    );
  }
}

function barButton({ label, value, max, display = String(value), active = false, title, onClick }) {
  const fill = h("span", { class: "bar-fill" });
  fill.style.width = `${max ? Math.max(2, (value / max) * 100) : 0}%`;

  const content = [
    h("span", { class: "bar-label", text: label }),
    h("span", { class: "bar-track", "aria-hidden": "true" }, fill),
    h("span", { class: "bar-value", text: display }),
  ];

  if (!onClick) {
    return h("div", { class: "bar", title }, content);
  }

  return h(
    "button",
    { type: "button", class: `bar bar-button${active ? " is-active" : ""}`, title, "aria-pressed": String(active), onclick: onClick },
    content
  );
}

function renderTopThc(entries) {
  clear(elements.topThcList);
  const top = entries
    .filter((entry) => entry.potencyUnit === "%" && typeof entry.thc === "number")
    .sort((a, b) => b.thc - a.thc)
    .slice(0, 3);

  if (!top.length) {
    elements.topThcList.appendChild(h("li", { class: "panel-empty", text: "No THC percentages recorded here." }));
    return;
  }

  top.forEach((entry, index) => {
    elements.topThcList.appendChild(
      h(
        "li",
        null,
        h(
          "button",
          { type: "button", class: "rank", "data-focus-key": `rank:${entry.id}`, onclick: () => openDetail(entry.id) },
          h("span", { class: "rank-index", text: String(index + 1) }),
          h("span", { class: "rank-name", text: entry.name }),
          h("span", { class: "rank-value", text: formatPotency(entry.thc, "%") })
        )
      )
    );
  });
}

/* ── Filters ───────────────────────────────────────────────────────────── */

function bindFilterFields() {
  const f = prefs.filters;
  elements.filterRating.value = f.minRating === null ? "" : String(f.minRating);
  elements.filterPriceMin.value = f.minPrice ?? "";
  elements.filterPriceMax.value = f.maxPrice ?? "";
  elements.filterDateFrom.value = f.dateFrom;
  elements.filterDateTo.value = f.dateTo;
  elements.filterRepurchase.checked = f.repurchase;

  const update = () => {
    f.minRating = Core.toNumber(elements.filterRating.value);
    f.minPrice = Core.toNumber(elements.filterPriceMin.value);
    f.maxPrice = Core.toNumber(elements.filterPriceMax.value);
    f.dateFrom = Core.isValidDate(elements.filterDateFrom.value) ? elements.filterDateFrom.value : "";
    f.dateTo = Core.isValidDate(elements.filterDateTo.value) ? elements.filterDateTo.value : "";
    f.repurchase = elements.filterRepurchase.checked;
    savePrefs();
    renderCollection();
  };

  [elements.filterRating, elements.filterDateFrom, elements.filterDateTo, elements.filterRepurchase].forEach((input) =>
    input.addEventListener("change", update)
  );
  [elements.filterPriceMin, elements.filterPriceMax].forEach((input) => input.addEventListener("input", update));
}

function syncFilterFields() {
  const f = prefs.filters;
  elements.filterRating.value = f.minRating === null ? "" : String(f.minRating);
  elements.filterPriceMin.value = f.minPrice ?? "";
  elements.filterPriceMax.value = f.maxPrice ?? "";
  elements.filterDateFrom.value = f.dateFrom;
  elements.filterDateTo.value = f.dateTo;
  elements.filterRepurchase.checked = f.repurchase;
}

function toggleFilterValue(key, value) {
  const list = prefs.filters[key];
  const index = list.findIndex((item) => tagKey(item) === tagKey(value));
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(value);
  }
  savePrefs();
}

function renderFilterOptions() {
  const entries = state.data.products;

  const checkChip = (key, value, label, count) =>
    h(
      "label",
      { class: "check-chip" },
      h("input", {
        type: "checkbox",
        checked: prefs.filters[key].some((item) => tagKey(item) === tagKey(value)),
        onchange: () => {
          toggleFilterValue(key, value);
          renderCollection();
        },
      }),
      h("span", null, label, count !== undefined ? h("span", { class: "check-chip-count", text: ` ${count}` }) : null)
    );

  clear(elements.filterTypes);
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    elements.filterTypes.appendChild(checkChip("types", type, label));
  }

  clear(elements.filterStatuses);
  for (const [status, label] of [...Object.entries(STATUS_LABELS), ["none", "Not tracked"]]) {
    elements.filterStatuses.appendChild(checkChip("statuses", status, label));
  }

  const brands = countBy(entries, (entry) => entry.brand.trim());
  clear(elements.filterBrands);
  elements.filterBrandsGroup.hidden = !brands.length;
  brands.slice(0, 30).forEach(([brand, count]) => elements.filterBrands.appendChild(checkChip("brands", brand, brand, count)));

  const tags = allTags();
  clear(elements.filterTags);
  elements.filterTagsGroup.hidden = !tags.length;
  tags.forEach(({ label, count }) => elements.filterTags.appendChild(checkChip("tags", label, label, count)));

  clear(elements.savedViews);
  if (!prefs.savedViews.length) {
    elements.savedViews.appendChild(h("p", { class: "hint", text: "None yet. Set up a search and filters, then save them here." }));
  }
  prefs.savedViews.forEach((view, index) => {
    elements.savedViews.appendChild(
      h(
        "span",
        { class: "saved-view" },
        h("button", { type: "button", class: "saved-view-apply", onclick: () => applySavedView(view) }, view.name),
        h(
          "button",
          {
            type: "button",
            class: "saved-view-remove",
            "aria-label": `Delete saved view ${view.name}`,
            onclick: () => {
              prefs.savedViews.splice(index, 1);
              savePrefs();
              renderCollection();
            },
          },
          icon("i-close")
        )
      )
    );
  });

  const count = activeFilterCount(prefs.filters);
  elements.filterCount.hidden = count === 0;
  elements.filterCount.textContent = String(count);
}

function renderFilterChips(shown, total) {
  clear(elements.filterChips);
  const f = prefs.filters;
  const chips = [];
  const add = (label, remove) =>
    chips.push(
      h(
        "button",
        { type: "button", class: "filter-chip", "aria-label": `Remove filter: ${label}`, onclick: () => { remove(); savePrefs(); syncFilterFields(); renderCollection(); } },
        h("span", { text: label }),
        icon("i-close")
      )
    );

  if (state.search) {
    add(`“${state.search}”`, () => {
      state.search = "";
      elements.searchInput.value = "";
      writeUrl({ replace: true });
    });
  }
  f.types.forEach((type) => add(typeLabel(type), () => f.types.splice(f.types.indexOf(type), 1)));
  f.statuses.forEach((status) =>
    add(status === "none" ? "Not tracked" : STATUS_LABELS[status], () => f.statuses.splice(f.statuses.indexOf(status), 1))
  );
  f.brands.forEach((brand) => add(brand, () => f.brands.splice(f.brands.indexOf(brand), 1)));
  f.tags.forEach((tag) => add(`#${tag}`, () => f.tags.splice(f.tags.indexOf(tag), 1)));
  if (f.minRating !== null) add(`Rated ${f.minRating}+`, () => (f.minRating = null));
  if (f.minPrice !== null) add(`From ${formatCurrency(f.minPrice)}`, () => (f.minPrice = null));
  if (f.maxPrice !== null) add(`Up to ${formatCurrency(f.maxPrice)}`, () => (f.maxPrice = null));
  if (f.dateFrom) add(`Since ${formatDate(f.dateFrom)}`, () => (f.dateFrom = ""));
  if (f.dateTo) add(`Until ${formatDate(f.dateTo)}`, () => (f.dateTo = ""));
  if (f.repurchase) add("Would buy again", () => (f.repurchase = false));

  append(elements.filterChips, chips);
  if (chips.length > 1) {
    elements.filterChips.appendChild(h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: clearAllFilters }, "Clear all"));
  }

  const noun = state.view === "favorites" ? "favorite" : "entry";
  const nouns = state.view === "favorites" ? "favorites" : "entries";
  const text = shown === total ? plural(total, noun, nouns) : `Showing ${shown} of ${plural(total, noun, nouns)}`;
  elements.resultCount.textContent = text;
  if (renderFilterChips.lastText !== undefined && renderFilterChips.lastText !== text) {
    announce(text);
  }
  renderFilterChips.lastText = text;
}

function clearAllFilters() {
  prefs.filters = defaultFilters();
  state.search = "";
  elements.searchInput.value = "";
  savePrefs();
  syncFilterFields();
  writeUrl({ replace: true });
  renderCollection();
}

async function saveCurrentView() {
  const name = await promptDialog({
    title: "Save this view",
    label: "Name",
    placeholder: "Favorites under $40",
    confirmLabel: "Save view",
  });
  if (!name) {
    return;
  }

  prefs.savedViews = prefs.savedViews.filter((view) => view.name !== name);
  prefs.savedViews.push({ name, search: state.search, sortBy: prefs.sortBy, filters: clone(prefs.filters), view: state.view });
  savePrefs();
  renderCollection();
  showToast(`Saved the view “${name}”. It stays in this browser.`);
}

function applySavedView(view) {
  prefs.filters = { ...defaultFilters(), ...clone(view.filters) };
  prefs.sortBy = view.sortBy || prefs.sortBy;
  state.search = view.search || "";
  elements.searchInput.value = state.search;
  elements.sortBy.value = prefs.sortBy;
  savePrefs();
  syncFilterFields();
  showView(view.view === "favorites" ? "favorites" : "collection", { push: true });
}

function allTags() {
  const counts = new Map();
  for (const entry of state.data.products) {
    for (const tag of entry.tags) {
      const key = tagKey(tag);
      const existing = counts.get(key);
      counts.set(key, { label: existing?.label || tag, count: (existing?.count || 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/* ── Selection and bulk actions ────────────────────────────────────────── */

function toggleSelectVisible() {
  const visible = visibleEntries();
  const allSelected = visible.every((entry) => state.selected.has(entry.id));
  visible.forEach((entry) => (allSelected ? state.selected.delete(entry.id) : state.selected.add(entry.id)));
  renderCollection();
}

function selectAllVisible() {
  visibleEntries().forEach((entry) => state.selected.add(entry.id));
  renderCollection();
}

function renderBulkBar(visible) {
  const count = state.selected.size;
  elements.bulkBar.hidden = count === 0;
  if (!count) {
    return;
  }

  const hidden = [...state.selected].filter((id) => !visible.some((entry) => entry.id === id)).length;
  elements.bulkCount.textContent = `${count} selected${hidden ? ` (${hidden} hidden by filters)` : ""}`;

  const unselectedVisible = visible.filter((entry) => !state.selected.has(entry.id)).length;
  elements.bulkSelectAll.hidden = unselectedVisible === 0;
  elements.bulkSelectAll.textContent = `Select all ${visible.length} shown`;
  elements.bulkCompare.disabled = count < 2 || count > 4;
  elements.bulkCompare.title = count < 2 || count > 4 ? "Select 2 to 4 entries to compare" : "";
}

function exportSelected() {
  const entries = state.data.products.filter((entry) => state.selected.has(entry.id));
  const ids = new Set(entries.map((entry) => entry.id));
  downloadJson(
    {
      version: Core.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      products: entries,
      wishlist: [],
      experiences: state.data.experiences.filter((item) => ids.has(item.productId)),
    },
    `cloudline-selection-${today()}.json`
  );
  showToast(`Exported ${plural(entries.length, "entry", "entries")}.`);
}

async function openBulkEdit() {
  const ids = [...state.selected];
  renderDatalists();
  const tagInput = h("input", { type: "text", list: "tag-options", placeholder: "weekend, great flavour", autocomplete: "off" });
  const removeTagInput = h("input", { type: "text", list: "tag-options", placeholder: "harsh", autocomplete: "off" });
  const typeSelect = h(
    "select",
    null,
    h("option", { value: "", text: "Leave as is" }),
    Object.entries(TYPE_LABELS).map(([value, label]) => h("option", { value, text: label }))
  );
  const statusSelect = h(
    "select",
    null,
    h("option", { value: "keep", text: "Leave as is" }),
    h("option", { value: "", text: "Not tracked" }),
    Object.entries(STATUS_LABELS).map(([value, label]) => h("option", { value, text: label }))
  );
  const favoriteSelect = h(
    "select",
    null,
    h("option", { value: "", text: "Leave as is" }),
    h("option", { value: "yes", text: "Add to favorites" }),
    h("option", { value: "no", text: "Remove from favorites" })
  );

  const body = h(
    "div",
    { class: "dialog-form" },
    h("p", { class: "dialog-note", text: `Changes apply to ${plural(ids.length, "selected entry", "selected entries")}. Blank fields are left alone. You can undo right after.` }),
    h("label", null, "Add tags", tagInput),
    h("label", null, "Remove tags", removeTagInput),
    h("label", null, "Type", typeSelect),
    h("label", null, "Status", statusSelect),
    h("label", null, "Favorite", favoriteSelect)
  );

  const choice = await openDialog({
    title: "Edit selected entries",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Apply changes", value: "apply", variant: "primary" },
    ],
  });

  if (choice !== "apply") {
    return;
  }

  const addTags = normalizeTags(tagInput.value);
  const removeKeys = new Set(normalizeTags(removeTagInput.value).map(tagKey));
  const before = clone(state.data.products.filter((entry) => ids.includes(entry.id)));
  const now = new Date().toISOString();

  commit((data) => {
    data.products = data.products.map((entry) => {
      if (!ids.includes(entry.id)) {
        return entry;
      }
      const next = { ...entry };
      next.tags = normalizeTags([...entry.tags.filter((tag) => !removeKeys.has(tagKey(tag))), ...addTags]);
      if (typeSelect.value) next.type = typeSelect.value;
      if (statusSelect.value !== "keep") next.status = statusSelect.value;
      if (favoriteSelect.value) next.favorite = favoriteSelect.value === "yes";
      next.updatedAt = now;
      return next;
    });
  });

  showToast(`Updated ${plural(ids.length, "entry", "entries")}.`, {
    action: {
      label: "Undo",
      run: () => {
        const byId = new Map(before.map((entry) => [entry.id, entry]));
        commit((data) => {
          data.products = data.products.map((entry) =>
            byId.has(entry.id) ? { ...byId.get(entry.id), updatedAt: new Date().toISOString() } : entry
          );
        });
        showToast("Bulk edit undone.");
      },
    },
  });
}

/* ── Mutations ─────────────────────────────────────────────────────────── */

/* Every change to the data goes through here: it marks the data dirty,
   writes this browser's copy, and queues the server save. */
function commit(mutator, { reason = null, render = true } = {}) {
  mutator(state.data);
  state.data.trash = purgeTrash(state.data.trash);

  /* Journal notes live as long as their product, in the collection or in
     the trash; once it is gone for good, so are they. */
  const productIds = new Set([
    ...state.data.products.map((entry) => entry.id),
    ...state.data.trash.filter((item) => item.kind === "product").map((item) => item.id),
  ]);
  state.data.experiences = state.data.experiences.filter((item) => productIds.has(item.productId));
  sync.generation += 1;
  sync.dirty = true;
  if (reason) {
    sync.pendingReason = reason;
  }

  saveLocal();
  scheduleSave();

  if (render) {
    renderAll();
    refreshDrawer();
  }
}

function saveLocal() {
  const dataOk = storageSet(DATA_KEY, JSON.stringify(state.data));
  const metaOk = storageSet(
    SYNC_KEY,
    JSON.stringify({ datasetId: sync.datasetId, revision: sync.revision, dirty: sync.dirty, base: sync.base })
  );
  state.storageOk = dataOk && metaOk;
  renderSync();
  return state.storageOk;
}

function toggleFavorite(entryId) {
  const entry = findEntry(entryId);
  if (!entry) {
    return;
  }

  commit((data) => {
    data.products = data.products.map((item) =>
      item.id === entryId ? { ...item, favorite: !item.favorite, updatedAt: new Date().toISOString() } : item
    );
  });

  announce(entry.favorite ? `Removed ${entry.name} from favorites.` : `Added ${entry.name} to favorites.`);
}

function findEntry(id) {
  return state.data.products.find((entry) => entry.id === id) || null;
}

/* Deleting moves records to the trash, where they stay for 30 days. The toast
   offers an immediate undo; "Recently deleted" covers everything after. */
function deleteEntries(ids) {
  const targets = ids.map(findEntry).filter(Boolean);
  if (!targets.length) {
    return;
  }

  const now = new Date().toISOString();
  commit((data) => {
    const tombstones = targets.map((entry) => ({
      id: entry.id,
      kind: "product",
      item: entry,
      deletedAt: now,
      position: data.products.findIndex((item) => item.id === entry.id),
    }));
    data.products = data.products.filter((entry) => !ids.includes(entry.id));
    data.trash = [...tombstones, ...data.trash.filter((item) => !(item.kind === "product" && ids.includes(item.id)))];
  });

  ids.forEach((id) => state.selected.delete(id));

  if (state.drawer.entryId && ids.includes(state.drawer.entryId)) {
    closeDrawer();
  }

  const label = targets.length === 1 ? `Deleted ${targets[0].name}.` : `Deleted ${targets.length} entries.`;
  showToast(label, {
    action: { label: "Undo", run: () => restoreFromTrash(targets.map((entry) => ["product", entry.id])) },
    duration: 8000,
  });
}

function removeWishlistItem(itemId) {
  const item = state.data.wishlist.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  commit((data) => {
    const position = data.wishlist.findIndex((entry) => entry.id === itemId);
    data.wishlist = data.wishlist.filter((entry) => entry.id !== itemId);
    data.trash = [
      { id: item.id, kind: "wishlist", item, deletedAt: new Date().toISOString(), position },
      ...data.trash.filter((entry) => !(entry.kind === "wishlist" && entry.id === itemId)),
    ];
  });

  showToast(`Removed ${item.name} from the list.`, {
    action: { label: "Undo", run: () => restoreFromTrash([["wishlist", item.id]]) },
    duration: 8000,
  });
}

function deleteExperience(experienceId) {
  const item = state.data.experiences.find((entry) => entry.id === experienceId);
  if (!item) {
    return;
  }

  commit((data) => {
    data.experiences = data.experiences.filter((entry) => entry.id !== experienceId);
    data.trash = [{ id: item.id, kind: "experience", item, deletedAt: new Date().toISOString(), position: 0 }, ...data.trash];
  });

  showToast("Deleted that experience.", {
    action: { label: "Undo", run: () => restoreFromTrash([["experience", item.id]]) },
    duration: 8000,
  });
}

const TRASH_TARGET = { product: "products", wishlist: "wishlist", experience: "experiences" };

/* Puts records back exactly where they were. */
function restoreFromTrash(pairs) {
  const wanted = new Set(pairs.map(([kind, id]) => `${kind}:${id}`));
  const found = state.data.trash.filter((item) => wanted.has(`${item.kind}:${item.id}`));
  if (!found.length) {
    showToast("That record is no longer in Recently deleted.");
    return;
  }

  commit((data) => {
    for (const tombstone of [...found].sort((a, b) => a.position - b.position)) {
      const key = TRASH_TARGET[tombstone.kind];
      const list = data[key].filter((item) => item.id !== tombstone.id);
      const restored = { ...tombstone.item, updatedAt: new Date().toISOString() };
      list.splice(Math.min(tombstone.position, list.length), 0, restored);
      data[key] = list;
    }
    data.trash = data.trash.filter((item) => !wanted.has(`${item.kind}:${item.id}`));
  });

  showToast(found.length === 1 ? `Restored ${found[0].item.name || "the record"}.` : `Restored ${found.length} records.`);
}

/* ── Drawer: shared ────────────────────────────────────────────────────── */

function openDrawerShell() {
  if (!elements.drawer.hidden) {
    return;
  }

  elements.drawer.hidden = false;
  elements.scrim.hidden = false;
  openModal(elements.drawer, { onRequestClose: requestCloseDrawer, focus: false });
}

function closeDrawer({ updateUrl = true } = {}) {
  if (elements.drawer.hidden) {
    return;
  }

  const hadEntryInUrl = new URLSearchParams(window.location.search).has("entry");
  elements.drawer.hidden = true;
  elements.scrim.hidden = true;
  state.drawer = { ...state.drawer, mode: null, entryId: null, formMode: null, sourceWishId: null, returnToDetail: null };
  closeModal(elements.drawer);

  /* Closing a panel that Back could also have closed takes the same step
     back, so the history doesn't fill up with duplicate pages. */
  if (updateUrl && hadEntryInUrl) {
    if (state.detailPushed && window.history.state?.entry) {
      state.detailPushed = false;
      window.history.back();
    } else {
      writeUrl({ replace: true });
    }
  }
  state.detailPushed = false;
}

async function requestCloseDrawer() {
  if (state.drawer.mode === "form") {
    await cancelForm();
    return;
  }

  closeDrawer();
}

function setDrawerMode(mode) {
  state.drawer.mode = mode;
  elements.detailView.hidden = mode !== "detail";
  elements.detailFoot.hidden = mode !== "detail";
  elements.form.hidden = mode !== "form";
  elements.formFoot.hidden = mode !== "form";
}

/* Re-render whatever the drawer shows after data changed underneath it,
   for example when another device's edit is merged in. */
function refreshDrawer() {
  if (elements.drawer.hidden || state.drawer.mode !== "detail") {
    return;
  }

  if (!findEntry(state.drawer.entryId)) {
    closeDrawer();
    return;
  }

  const focusedKey = document.activeElement?.dataset?.focusKey;
  renderDetail(state.drawer.entryId);
  if (focusedKey) {
    elements.drawer.querySelector(`[data-focus-key="${focusedKey}"]`)?.focus({ preventScroll: true });
  }
}

/* ── Drawer: product details ───────────────────────────────────────────── */

function openDetail(entryId, { push = true } = {}) {
  const entry = findEntry(entryId);
  if (!entry) {
    return;
  }

  const alreadyOpen = !elements.drawer.hidden && new URLSearchParams(window.location.search).has("entry");
  openDrawerShell();
  state.drawer.entryId = entryId;
  setDrawerMode("detail");
  renderDetail(entryId);
  elements.detailView.scrollTop = 0;
  elements.drawerTitle.setAttribute("tabindex", "-1");
  elements.drawerTitle.focus({ preventScroll: true });

  /* One history step per visit to the panel; moving between products
     inside it replaces that step. */
  if (push && !alreadyOpen) {
    writeUrl({ entry: entryId });
    state.detailPushed = true;
  } else if (push || alreadyOpen) {
    writeUrl({ entry: entryId, replace: true });
  }
}

function renderDetail(entryId) {
  const entry = findEntry(entryId);
  if (!entry) {
    return;
  }

  elements.drawerTitle.textContent = entry.name;
  elements.drawerSubtitle.textContent = [entry.brand, typeLabel(entry.type)].filter(Boolean).join(" · ");

  const view = clear(elements.detailView);

  const badges = h(
    "div",
    { class: "detail-badges" },
    h("span", { class: `badge badge-${entry.type}`, text: typeLabel(entry.type) }),
    entry.status ? chip(STATUS_LABELS[entry.status], `chip-status chip-status-${entry.status}`) : null,
    entry.wouldRepurchase === true ? chip("Would buy again", "chip-accent") : null,
    entry.wouldRepurchase === false ? chip("Wouldn't buy again") : null,
    h(
      "button",
      {
        type: "button",
        class: `btn btn-secondary btn-small favorite-toggle${entry.favorite ? " is-on" : ""}`,
        "aria-pressed": String(entry.favorite),
        dataset: { focusKey: "favorite" },
        onclick: () => toggleFavorite(entry.id),
      },
      icon("i-star"),
      entry.favorite ? "Favorite" : "Add to favorites"
    )
  );
  view.appendChild(badges);

  const price = unitPrice(entry);
  const facts = [
    ["Rating", typeof entry.rating === "number" ? `${formatRating(entry.rating)} / 10` : null],
    ["THC", typeof entry.thc === "number" ? formatPotency(entry.thc, entry.potencyUnit) : null],
    ["CBD", typeof entry.cbd === "number" ? formatPotency(entry.cbd, entry.potencyUnit) : null],
    ["Total terpenes", typeof entry.terpenePercent === "number" ? `${entry.terpenePercent.toFixed(1)}%` : null],
    ["Price paid", typeof entry.price === "number" ? formatCurrency(entry.price) : null, true],
    ["Amount", entry.amount || null],
    [price?.unit === "unit" ? "Per unit" : "Per gram", price ? formatUnitPrice(entry) : null, true],
    ["Purchased", entry.purchaseDate ? formatDate(entry.purchaseDate) : null],
    ["Vendor", entry.vendor || null],
    ["Strain", entry.strain || null],
    ["Extraction", entry.extraction || null],
    ["Batch", entry.batch || null],
    ["Opened", entry.openedAt ? formatDate(entry.openedAt) : null],
    ["Left", entry.remaining || null],
  ].filter(([, value]) => value !== null);

  if (facts.length) {
    view.appendChild(
      h(
        "dl",
        { class: "facts" },
        facts.map(([label, value, isPrivate]) =>
          h("div", { class: "fact" }, h("dt", { text: label }), h("dd", { class: isPrivate ? "private" : "", text: value }))
        )
      )
    );
  } else {
    view.appendChild(h("p", { class: "muted", text: "No details recorded yet. Edit this entry to add potency, price and notes." }));
  }

  if (entry.tags.length) {
    view.appendChild(detailSection("Tags", h("div", { class: "chip-row" }, entry.tags.map((tag) => chip(tag, "chip-tag")))));
  }

  if (entry.terpenes) {
    const list = entry.terpenes.split(/[,;·]/).map((item) => item.trim()).filter(Boolean);
    view.appendChild(detailSection("Terpene breakdown", h("ul", { class: "terpene-list" }, list.map((item) => h("li", { text: item })))));
  }

  if (entry.effects) {
    view.appendChild(detailSection("Effects", h("p", { text: entry.effects })));
  }

  if (entry.notes) {
    view.appendChild(detailSection("Notes", h("p", { class: "prose private", text: entry.notes })));
  }

  if (entry.sourceUrl) {
    view.appendChild(
      h(
        "p",
        { class: "detail-link" },
        h("a", { href: entry.sourceUrl, target: "_blank", rel: "noopener noreferrer" }, icon("i-external"), "Open the product page")
      )
    );
  }

  const related = relatedPurchases(state.data.products, entry);
  if (related.length > 1) {
    const rows = sortEntries(related, "purchaseDate-desc").map((item) =>
      h(
        "tr",
        { class: item.id === entry.id ? "is-current" : "" },
        h(
          "td",
          null,
          item.id === entry.id
            ? h("span", { text: `${formatDate(item.purchaseDate)} (this one)` })
            : h("button", { type: "button", class: "name-link", onclick: () => openDetail(item.id) }, formatDate(item.purchaseDate))
        ),
        h("td", { text: item.vendor || "—" }),
        h("td", { class: "num private", text: formatCurrency(item.price) }),
        h("td", { text: item.batch || "—" }),
        h("td", { class: "num", text: formatRating(item.rating) })
      )
    );
    view.appendChild(
      detailSection(
        `Purchase history · ${related.length} purchases`,
        h(
          "div",
          { class: "mini-table-wrap" },
          h(
            "table",
            { class: "mini-table" },
            h("thead", null, h("tr", null, ["Date", "Vendor", "Paid", "Batch", "Rating"].map((label, index) => h("th", { scope: "col", class: index === 2 || index === 4 ? "num" : "", text: label })))),
            h("tbody", null, rows)
          )
        )
      )
    );
  }

  view.appendChild(renderJournal(entry));

  const foot = clear(elements.detailFoot);
  append(foot, [
    h("button", { type: "button", class: "btn btn-danger-ghost", onclick: () => deleteEntries([entry.id]) }, icon("i-trash"), "Delete"),
    h("span", { class: "foot-spacer" }),
    h("button", { type: "button", class: "btn btn-secondary", onclick: () => openEntryForm({ mode: "buyAgain", entryId: entry.id }) }, icon("i-copy"), "Buy again"),
    h("button", { type: "button", class: "btn btn-primary", onclick: () => openEntryForm({ mode: "edit", entryId: entry.id, returnToDetail: entry.id }) }, icon("i-pencil"), "Edit"),
  ]);
}

function detailSection(title, content) {
  return h("section", { class: "detail-section" }, h("h3", { class: "detail-heading", text: title }), content);
}

/* ── Experience journal ────────────────────────────────────────────────── */

function renderJournal(entry) {
  const experiences = state.data.experiences
    .filter((item) => item.productId === entry.id)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  const list = h("ol", { class: "timeline" });
  for (const item of experiences) {
    list.appendChild(
      h(
        "li",
        { class: "timeline-item" },
        h(
          "div",
          { class: "timeline-head" },
          h("strong", { text: formatDate(item.date) }),
          typeof item.rating === "number" ? h("span", { class: "muted", text: ` · ${formatRating(item.rating)} / 10` }) : null,
          item.amount ? h("span", { class: "muted", text: ` · ${item.amount}` }) : null,
          h(
            "span",
            { class: "timeline-actions" },
            iconButton("i-pencil", "Edit this experience", () => showExperienceForm(entry, item)),
            iconButton("i-trash", "Delete this experience", () => deleteExperience(item.id), { danger: true })
          )
        ),
        item.effects.length ? h("div", { class: "chip-row" }, item.effects.map((effect) => chip(effect))) : null,
        item.flavor ? h("p", { class: "timeline-text" }, h("span", { class: "muted", text: "Flavour: " }), item.flavor) : null,
        item.notes ? h("p", { class: "timeline-text prose private", text: item.notes }) : null
      )
    );
  }

  const section = h(
    "section",
    { class: "detail-section journal" },
    h(
      "div",
      { class: "detail-heading-row" },
      h("h3", { class: "detail-heading", text: `Experience journal${experiences.length ? ` · ${experiences.length}` : ""}` }),
      h(
        "button",
        { type: "button", class: "btn btn-secondary btn-small", dataset: { focusKey: "record" }, onclick: () => showExperienceForm(entry) },
        icon("i-plus"),
        "Record experience"
      )
    ),
    h("div", { class: "journal-form-slot" }),
    experiences.length
      ? list
      : h("p", { class: "muted", text: "Each time you try it, note how it went. Sessions build up into a timeline here." })
  );

  return section;
}

function showExperienceForm(entry, existing = null) {
  const slot = elements.detailView.querySelector(".journal-form-slot");
  if (!slot) {
    return;
  }

  const dateInput = h("input", { type: "date", value: existing?.date || today(), required: true });
  const amountInput = h("input", { type: "text", value: existing?.amount || "", placeholder: "2 puffs, 5 mg, a bowl" });
  const ratingInput = h("input", { type: "number", min: "0", max: "10", step: "0.5", inputmode: "decimal", value: existing?.rating ?? "" });
  const effectsInput = h("input", { type: "text", value: existing?.effects.join(", ") || "", placeholder: "Calm, focused, sleepy", list: "tag-options" });
  const flavorInput = h("input", { type: "text", value: existing?.flavor || "", placeholder: "Citrus, gassy, earthy" });
  const notesInput = h("textarea", { rows: "3", placeholder: "Setting, how long it lasted, anything notable" });
  notesInput.value = existing?.notes || "";
  const error = h("p", { class: "field-error", role: "alert", hidden: true });

  const form = h(
    "form",
    { class: "journal-form", novalidate: true },
    h("div", { class: "form-grid" },
      h("label", null, "Date", dateInput),
      h("label", null, "Amount", amountInput),
      h("label", null, "Rating ", h("span", { class: "hint", text: "0–10" }), ratingInput),
      h("label", null, "Flavour", flavorInput),
      h("label", { class: "span-2" }, "Effects ", h("span", { class: "hint", text: "comma-separated" }), effectsInput),
      h("label", { class: "span-2" }, "Notes", notesInput)
    ),
    h("p", { class: "hint", text: "Your own impressions. Nothing here is medical or dosing advice." }),
    error,
    h(
      "div",
      { class: "journal-form-actions" },
      h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => { clear(slot); slot.parentElement.querySelector('[data-focus-key="record"]')?.focus(); } }, "Cancel"),
      h("button", { type: "submit", class: "btn btn-primary btn-small" }, existing ? "Save changes" : "Add to journal")
    )
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const rating = Core.toNumber(ratingInput.value);
    if (!Core.isValidDate(dateInput.value)) {
      error.textContent = "Pick a date.";
      error.hidden = false;
      dateInput.focus();
      return;
    }
    if (ratingInput.value.trim() && (rating === null || rating < 0 || rating > 10)) {
      error.textContent = "Rating must be between 0 and 10.";
      error.hidden = false;
      ratingInput.focus();
      return;
    }

    const now = new Date().toISOString();
    const { value } = normalizeExperience({
      ...(existing || {}),
      id: existing?.id || uuid(),
      productId: entry.id,
      date: dateInput.value,
      amount: amountInput.value,
      rating,
      effects: effectsInput.value,
      flavor: flavorInput.value,
      notes: notesInput.value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    commit((data) => {
      data.experiences = existing
        ? data.experiences.map((item) => (item.id === existing.id ? value : item))
        : [value, ...data.experiences];
    });

    showToast(existing ? "Updated the experience." : "Added to the journal.");
    elements.detailView.querySelector('[data-focus-key="record"]')?.focus({ preventScroll: true });
  });

  clear(slot).appendChild(form);
  dateInput.focus();
}

/* ── Drawer: the entry form ────────────────────────────────────────────── */

const FORM_TITLES = {
  new: ["Add entry", "Only the name is required. Add the rest now or later."],
  edit: ["Edit entry", ""],
  buyAgain: ["Buy again", "Product details copied. Rating and notes start fresh for this purchase."],
  purchase: ["Log purchase", ""],
};

/* mode: new | edit | buyAgain | purchase (from the shopping list). */
function openEntryForm({ mode, entryId = null, prefill = null, sourceWishId = null, focusOcs = false, returnToDetail = null, focusField = null } = {}) {
  const entry = entryId ? findEntry(entryId) : null;
  if ((mode === "edit" || mode === "buyAgain") && !entry) {
    return;
  }

  openDrawerShell();
  setDrawerMode("form");
  resetForm();

  state.drawer.formMode = mode;
  state.drawer.entryId = mode === "edit" ? entry.id : null;
  state.drawer.sourceWishId = sourceWishId;
  state.drawer.returnToDetail = returnToDetail;

  const [title, subtitle] = FORM_TITLES[mode];
  elements.drawerTitle.textContent = title;
  elements.drawerSubtitle.textContent =
    mode === "edit" ? entry.name : mode === "purchase" ? `From your shopping list · ${prefill?.name || ""}` : subtitle;
  elements.formSubmit.textContent = mode === "edit" ? "Save changes" : mode === "purchase" ? "Log purchase" : "Save entry";
  elements.formOcs.hidden = mode === "edit";

  if (mode === "edit") {
    fillForm(entry);
    state.drawer.productKey = entry.productKey;
    state.drawer.sourceUrl = entry.sourceUrl;
    openSectionsWithValues(entry);
  } else if (mode === "buyAgain") {
    fillForm(buyAgainValues(entry));
    state.drawer.productKey = entry.productKey || entry.id;
    state.drawer.sourceUrl = entry.sourceUrl;
    elements.sectionPurchase.open = true;
    if (!entry.productKey) {
      /* Link the original to the family too, so both show the history. */
      state.drawer.linkOriginal = entry.id;
    }
  } else {
    /* New entries start as the type logged most recently: people tend to
       buy in runs. */
    const lastType = [...state.data.products].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.type || "cart";
    fillForm({ purchaseDate: today(), type: lastType, ...(prefill || {}) });
    state.drawer.productKey = prefill?.productKey || "";
    state.drawer.sourceUrl = prefill?.sourceUrl || "";
    if (prefill) {
      elements.sectionPurchase.open = true;
    }
  }

  state.drawer.potencyTouched = mode !== "new";
  state.drawer.ownsDraft = false;
  renderDatalists();
  state.drawer.baseline = serializeForm();
  updateDuplicateHint();
  updateAmountHint();
  offerDraft(mode, entry);

  elements.form.scrollTop = 0;
  if (focusField && fields[focusField]) {
    const section = fields[focusField].closest("details");
    if (section) section.open = true;
    fields[focusField].focus({ preventScroll: false });
  } else if (focusOcs) {
    elements.formOcsInput.focus();
  } else {
    fields.name.focus({ preventScroll: true });
  }
}

function renderDatalists() {
  const fill = (list, values) => {
    clear(list);
    values.slice(0, 60).forEach((value) => list.appendChild(h("option", { value })));
  };
  fill(elements.brandOptions, countBy(state.data.products, (entry) => entry.brand.trim()).map(([brand]) => brand));
  fill(elements.vendorOptions, countBy(state.data.products, (entry) => entry.vendor.trim()).map(([vendor]) => vendor));
  fill(elements.tagOptions, allTags().map((tag) => tag.label));
}

function buyAgainValues(entry) {
  return {
    name: entry.name,
    type: entry.type,
    brand: entry.brand,
    strain: entry.strain,
    extraction: entry.extraction,
    amount: entry.amount,
    potencyUnit: entry.potencyUnit,
    thc: entry.thc,
    cbd: entry.cbd,
    terpenePercent: entry.terpenePercent,
    terpenes: entry.terpenes,
    vendor: entry.vendor,
    price: entry.price,
    purchaseDate: today(),
  };
}

function resetForm() {
  elements.form.reset();
  state.drawer.productKey = "";
  state.drawer.sourceUrl = "";
  state.drawer.linkOriginal = null;
  elements.formOcsInput.value = "";
  setStatus(elements.formOcsStatus, "");
  elements.formError.textContent = "";
  elements.draftNotice.hidden = true;
  [elements.sectionPurchase, elements.sectionExperience, elements.sectionInventory].forEach((section) => (section.open = false));
  elements.form.querySelectorAll(".field-error").forEach((error) => {
    error.hidden = true;
    error.textContent = "";
  });
  elements.form.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
  applyPotencyUnit("%");
}

function fillForm(values) {
  const text = (value) => (value === null || value === undefined ? "" : String(value));
  for (const name of ["name", "brand", "purchaseDate", "vendor", "amount", "strain", "extraction", "batch", "terpenes", "effects", "notes", "openedAt", "remaining"]) {
    fields[name].value = text(values[name]);
  }
  for (const name of ["price", "rating", "thc", "cbd", "terpenePercent"]) {
    fields[name].value = typeof values[name] === "number" ? String(values[name]) : "";
  }
  fields.type.value = TYPE_LABELS[values.type] ? values.type : "other";
  fields.status.value = STATUS_LABELS[values.status] ? values.status : "";
  fields.tags.value = Array.isArray(values.tags) ? values.tags.join(", ") : text(values.tags);
  fields.favorite.checked = Boolean(values.favorite);

  const unit = values.potencyUnit || (MG_TYPES.has(values.type) ? "mg" : "%");
  elements.form.querySelector(`input[name="potencyUnit"][value="${unit === "mg" ? "mg" : "%"}"]`).checked = true;
  applyPotencyUnit(unit);

  const repurchase = values.wouldRepurchase === true ? "yes" : values.wouldRepurchase === false ? "no" : "";
  elements.form.querySelector(`input[name="wouldRepurchase"][value="${repurchase}"]`).checked = true;
}

function openSectionsWithValues(entry) {
  elements.sectionPurchase.open = Boolean(
    entry.purchaseDate || entry.vendor || entry.amount || entry.strain || entry.extraction || entry.batch ||
      typeof entry.thc === "number" || typeof entry.cbd === "number" || entry.terpenes
  );
  elements.sectionExperience.open = Boolean(entry.effects || entry.notes || entry.tags.length || entry.wouldRepurchase !== null);
  elements.sectionInventory.open = Boolean(entry.status || entry.openedAt || entry.remaining);
}

function currentPotencyUnit() {
  return elements.form.querySelector('input[name="potencyUnit"]:checked')?.value === "mg" ? "mg" : "%";
}

function applyPotencyUnit(unit) {
  const mg = unit === "mg";
  for (const input of [fields.thc, fields.cbd]) {
    input.max = mg ? "10000" : "100";
    input.placeholder = mg ? "10" : input === fields.thc ? "82.5" : "1.2";
  }
  elements.form.querySelectorAll(".unit-label").forEach((label) => (label.textContent = mg ? "mg" : "%"));
}

/* Edibles and tinctures are dosed in milligrams: switch the unit for them,
   unless it was chosen by hand. */
function suggestPotencyUnit() {
  if (state.drawer.potencyTouched) {
    return;
  }
  const unit = MG_TYPES.has(fields.type.value) ? "mg" : "%";
  elements.form.querySelector(`input[name="potencyUnit"][value="${unit}"]`).checked = true;
  applyPotencyUnit(unit);
}

function serializeForm() {
  const data = new FormData(elements.form);
  const values = {};
  for (const [key, value] of data.entries()) {
    values[key] = String(value);
  }
  values.favorite = fields.favorite.checked;
  return JSON.stringify(values);
}

function isFormDirty() {
  return state.drawer.mode === "form" && serializeForm() !== state.drawer.baseline;
}

function handleFormInput(event) {
  if (event.target === fields.name || event.target === fields.brand) {
    updateDuplicateHint();
  }
  if (event.target === fields.amount) {
    updateAmountHint();
  }
  if (event.target.getAttribute("aria-invalid") === "true") {
    validateField(event.target.name);
  }

  window.clearTimeout(handleFormInput.timer);
  handleFormInput.timer = window.setTimeout(saveDraft, 500);
}

function saveDraft() {
  if (state.drawer.mode !== "form") {
    return;
  }

  if (!isFormDirty()) {
    return;
  }

  state.drawer.ownsDraft = true;
  storageSet(
    DRAFT_KEY,
    JSON.stringify({
      mode: state.drawer.formMode,
      entryId: state.drawer.entryId,
      sourceWishId: state.drawer.sourceWishId,
      productKey: state.drawer.productKey,
      sourceUrl: state.drawer.sourceUrl,
      values: JSON.parse(serializeForm()),
      savedAt: new Date().toISOString(),
    })
  );
}

function readDraft() {
  const draft = readJson(DRAFT_KEY);
  return draft && typeof draft === "object" && draft.values ? draft : null;
}

/* A draft left behind by a closed tab or a crash is offered back - but only
   on the same kind of form it came from. */
function offerDraft(mode, entry) {
  const draft = readDraft();
  if (!draft) {
    return;
  }

  const matches = mode === "edit" ? draft.mode === "edit" && draft.entryId === entry?.id : draft.mode !== "edit" && mode === "new";
  elements.draftNotice.hidden = !matches;
  if (matches) {
    elements.draftNotice.querySelector("p").textContent = `You have an unsaved draft${draft.values.name ? ` of “${draft.values.name}”` : ""} from ${formatTimestamp(draft.savedAt)}.`;
  }
}

function restoreDraft() {
  const draft = readDraft();
  if (!draft) {
    return;
  }

  const values = { ...draft.values };
  state.drawer.ownsDraft = true;
  fillForm({
    ...values,
    price: Core.toNumber(values.price),
    rating: Core.toNumber(values.rating),
    thc: Core.toNumber(values.thc),
    cbd: Core.toNumber(values.cbd),
    terpenePercent: Core.toNumber(values.terpenePercent),
    wouldRepurchase: values.wouldRepurchase === "yes" ? true : values.wouldRepurchase === "no" ? false : null,
    favorite: values.favorite === true || values.favorite === "on",
  });
  if (draft.mode === "purchase" && state.data.wishlist.some((item) => item.id === draft.sourceWishId)) {
    state.drawer.sourceWishId = draft.sourceWishId;
    state.drawer.formMode = "purchase";
    elements.formSubmit.textContent = "Log purchase";
  }
  state.drawer.productKey = draft.productKey || state.drawer.productKey;
  state.drawer.sourceUrl = draft.sourceUrl || state.drawer.sourceUrl;
  [elements.sectionPurchase, elements.sectionExperience, elements.sectionInventory].forEach((section) => (section.open = true));
  elements.draftNotice.hidden = true;
  updateDuplicateHint();
  updateAmountHint();
  fields.name.focus();
}

function updateDuplicateHint() {
  const name = fields.name.value.trim();
  const hint = elements.duplicateHint;
  if (!name || state.drawer.formMode === "buyAgain") {
    hint.hidden = true;
    return;
  }

  const key = nameKey({ name, brand: fields.brand.value });
  const matches = state.data.products.filter((entry) => entry.id !== state.drawer.entryId && nameKey(entry) === key);
  hint.hidden = !matches.length;
  if (matches.length) {
    const latest = sortEntries(matches, "purchaseDate-desc")[0];
    hint.textContent = `Already in your collection${latest.purchaseDate ? ` (bought ${formatDate(latest.purchaseDate)})` : ""}. Repeat purchases are fine — saving adds another.`;
  }
}

function updateAmountHint() {
  const quantity = parseQuantity(fields.amount.value);
  const hint = elements.amountHint;
  hint.hidden = !quantity;
  if (quantity) {
    hint.textContent =
      quantity.unit === "unit"
        ? `Reads as ${trimNumber(quantity.value)} units, for price per unit.`
        : `Reads as ${trimNumber(quantity.value)} ${quantity.unit}, for price per ${quantity.unit === "g" ? "gram" : quantity.unit}.`;
  }
}

async function cancelForm() {
  if (isFormDirty()) {
    const choice = await confirmDiscard();
    if (choice === "keep") {
      return;
    }
  }

  if (state.drawer.ownsDraft) {
    storageRemove(DRAFT_KEY);
  }
  const back = state.drawer.returnToDetail;
  if (back && findEntry(back)) {
    openDetail(back, { push: false });
  } else {
    closeDrawer();
  }
}

function confirmDiscard() {
  return openDialog({
    title: "Discard your changes?",
    body: h("p", { text: "What you typed in this form will be lost." }),
    actions: [
      { label: "Keep editing", value: "keep", variant: "primary" },
      { label: "Discard", value: "discard", variant: "danger" },
    ],
    dismissValue: "keep",
  });
}

const VALIDATION = {
  name: (value) => (value.trim() ? "" : "Give it a name, even a rough one."),
  price: (value) => numberProblem(value, 0, 100000, "Price"),
  rating: (value) => numberProblem(value, 0, 10, "Rating"),
  thc: (value) => numberProblem(value, 0, currentPotencyUnit() === "mg" ? 10000 : 100, "THC"),
  cbd: (value) => numberProblem(value, 0, currentPotencyUnit() === "mg" ? 10000 : 100, "CBD"),
  terpenePercent: (value) => numberProblem(value, 0, 100, "Total terpenes"),
  purchaseDate: (value) => (!value || Core.isValidDate(value) ? "" : "Use a real date."),
};

function numberProblem(value, min, max, label) {
  if (!String(value).trim()) {
    return "";
  }
  const number = Core.toNumber(value);
  if (number === null) {
    return `${label} must be a number.`;
  }
  if (number < min || number > max) {
    return `${label} must be between ${min} and ${max}.`;
  }
  return "";
}

function validateField(name) {
  const input = fields[name];
  const error = document.getElementById(`${name}-error`);
  const problem = VALIDATION[name] ? VALIDATION[name](input.value) : "";
  if (problem) {
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
  if (error) {
    error.textContent = problem;
    error.hidden = !problem;
  }
  return !problem;
}

function readFormValues() {
  const data = new FormData(elements.form);
  const text = (name) => String(data.get(name) || "").trim();
  const repurchase = text("wouldRepurchase");

  return {
    name: text("name"),
    type: text("type") || "other",
    brand: text("brand"),
    strain: text("strain"),
    extraction: text("extraction"),
    amount: normalizeAmount(text("amount")),
    batch: text("batch"),
    potencyUnit: currentPotencyUnit(),
    thc: Core.toNumber(text("thc")),
    cbd: Core.toNumber(text("cbd")),
    terpenePercent: Core.toNumber(text("terpenePercent")),
    terpenes: text("terpenes"),
    price: Core.toNumber(text("price")),
    purchaseDate: text("purchaseDate"),
    vendor: text("vendor"),
    rating: Core.toNumber(text("rating")),
    wouldRepurchase: repurchase === "yes" ? true : repurchase === "no" ? false : null,
    effects: text("effects"),
    tags: normalizeTags(text("tags")),
    notes: String(data.get("notes") || "").trim(),
    status: text("status"),
    openedAt: text("openedAt"),
    remaining: text("remaining"),
    favorite: fields.favorite.checked,
  };
}

function handleSubmit(event) {
  event.preventDefault();

  const invalid = Object.keys(VALIDATION).filter((name) => !validateField(name));
  if (invalid.length) {
    const first = fields[invalid[0]];
    const section = first.closest("details");
    if (section) {
      section.open = true;
    }
    elements.formError.textContent = invalid.length === 1 ? "Fix the highlighted field." : `Fix the ${invalid.length} highlighted fields.`;
    first.focus();
    return;
  }
  elements.formError.textContent = "";

  const mode = state.drawer.formMode;
  const existing = mode === "edit" ? findEntry(state.drawer.entryId) : null;
  if (mode === "edit" && !existing) {
    /* Deleted on another device while this form was open: save it as new
       rather than losing what was typed. */
    showToast("That entry was deleted elsewhere; saved your version as a new entry.");
  }

  const now = new Date().toISOString();
  const values = readFormValues();
  const { value: entry } = normalizeEntry({
    ...(existing || {}),
    ...values,
    id: existing?.id || uuid(),
    productKey: state.drawer.productKey || existing?.productKey || "",
    sourceUrl: state.drawer.sourceUrl || existing?.sourceUrl || "",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });

  const boughtId = state.drawer.sourceWishId;
  const linkOriginal = state.drawer.linkOriginal;
  const returnTo = state.drawer.returnToDetail;

  commit((data) => {
    if (existing) {
      data.products = data.products.map((item) => (item.id === entry.id ? entry : item));
    } else {
      data.products = [entry, ...data.products];
    }

    if (linkOriginal) {
      data.products = data.products.map((item) =>
        item.id === linkOriginal && !item.productKey ? { ...item, productKey: linkOriginal, updatedAt: now } : item
      );
    }

    /* Logging a purchase retires the shopping-list item it came from. */
    if (boughtId) {
      data.wishlist = data.wishlist.filter((item) => item.id !== boughtId);
    }
  }, { render: false });

  if (state.drawer.ownsDraft) {
    storageRemove(DRAFT_KEY);
  }
  state.drawer.baseline = serializeForm();

  if (existing && returnTo) {
    openDetail(entry.id, { push: false });
  } else {
    closeDrawer();
  }

  renderAll();
  showToast(existing ? `Updated ${entry.name}.` : `Saved ${entry.name}.`, {
    action: existing ? null : { label: "View", run: () => openDetail(entry.id) },
  });
}

/* ── OCS lookups ───────────────────────────────────────────────────────── */

async function fetchLookup(url) {
  if (!sync.available) {
    throw new Error("Link lookup needs the local server: run python3 serve.py, then open the address it prints.");
  }

  let response;
  try {
    response = await fetch(`${LOOKUP_ENDPOINT}?url=${encodeURIComponent(url)}`, { cache: "no-store" });
  } catch (error) {
    throw new Error("Could not reach the server. Check the connection and try again.");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.item) {
    throw new Error(payload.error || `Lookup failed (${response.status}).`);
  }
  return payload.item;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  button.setAttribute("aria-busy", String(busy));
  if (label) {
    button.querySelector(".btn-label").textContent = label;
  }
}

function setStatus(element, message, tone = "") {
  element.textContent = message;
  element.dataset.tone = tone;
}

function findByLink(url) {
  const key = productLinkKey(url);
  if (!key) {
    return { wish: null, entries: [] };
  }
  return {
    wish: state.data.wishlist.find((item) => productLinkKey(item.url) === key) || null,
    entries: sortEntries(state.data.products.filter((entry) => productLinkKey(entry.sourceUrl) === key), "purchaseDate-desc"),
  };
}

async function lookupForShopping(url, { skipDuplicateCheck = false } = {}) {
  if (!url || elements.linkSubmit.disabled) {
    if (!url) {
      setLinkStatus("Paste an ocs.ca product link first.", "error");
      elements.linkInput.focus();
    }
    return;
  }

  state.lastLookupUrl = url;

  if (!skipDuplicateCheck) {
    const { wish, entries } = findByLink(url);
    if (wish) {
      const choice = await openDialog({
        title: "Already on your list",
        body: h("p", { text: `“${wish.name}” is on your shopping list already.` }),
        actions: [
          { label: "Cancel", value: null },
          { label: "Add another", value: "add" },
          { label: "Show it", value: "view", variant: "primary" },
        ],
      });
      if (choice === "view") {
        highlightWish(wish.id);
      }
      if (choice !== "add") {
        return;
      }
    } else if (entries.length) {
      const choice = await openDialog({
        title: "You've bought this before",
        body: h("p", { text: `“${entries[0].name}” is in your collection${entries[0].purchaseDate ? `, bought ${formatDate(entries[0].purchaseDate)}` : ""}.` }),
        actions: [
          { label: "Cancel", value: null },
          { label: "View purchase", value: "view" },
          { label: "Add to list anyway", value: "add", variant: "primary" },
        ],
      });
      if (choice === "view") {
        openDetail(entries[0].id);
      }
      if (choice !== "add") {
        return;
      }
    }
  }

  setBusy(elements.linkSubmit, true, "Looking up…");
  setLinkStatus("Asking ocs.ca for the product…");

  try {
    const item = await fetchLookup(url);
    const { value } = normalizeWishItem({ ...item, id: uuid(), addedAt: new Date().toISOString(), priority: "normal" });
    commit((data) => {
      data.wishlist = [value, ...data.wishlist];
    });
    elements.linkInput.value = "";
    setLinkStatus(`Added ${value.name}.`, "ok");
  } catch (error) {
    setLinkStatus(error.message, "error", { retry: sync.available });
  } finally {
    setBusy(elements.linkSubmit, false, "Look up");
  }
}

/* The Research tab (research.js) adds picks to the list through here, so a
   research card and a pasted link end up as the same kind of item. */
async function addResearchPick({ url = "", name = "", brand = "", price = null, note = "" }) {
  const { wish } = findByLink(url);
  if (wish) {
    showToast(`“${wish.name}” is already on your shopping list.`, {
      action: { label: "Show", run: () => { showView("shopping", { push: true }); highlightWish(wish.id); } },
    });
    return "exists";
  }

  let item = { name, brand, price, url };
  if (url && sync.available) {
    try {
      item = await fetchLookup(url);
    } catch (error) {
      /* OCS didn't answer: the research facts are good enough to start with. */
    }
  }

  const { value } = normalizeWishItem({
    ...item,
    id: uuid(),
    addedAt: new Date().toISOString(),
    priority: "normal",
    shoppingNote: note,
  });
  if (!value) {
    return "failed";
  }
  commit((data) => {
    data.wishlist = [value, ...data.wishlist];
  }, { render: false });
  renderCounts();
  showToast(`Added ${value.name} to your shopping list.`, {
    action: { label: "View", run: () => { showView("shopping", { push: true }); highlightWish(value.id); } },
  });
  return "added";
}

function researchOwnership(url) {
  const { wish, entries } = findByLink(url);
  const rated = entries.find((entry) => typeof entry.rating === "number");
  return {
    onList: Boolean(wish),
    owned: entries.length > 0,
    rating: rated ? rated.rating : null,
    entryId: entries[0]?.id || null,
  };
}

window.Cloudline = {
  addResearchPick,
  researchOwnership,
  openEntry: (id) => openDetail(id),
  toast: (message) => showToast(message),
  get privacy() {
    return Boolean(prefs.privacy);
  },
};

function setLinkStatus(message, tone = "", { retry = false } = {}) {
  elements.linkStatusText.textContent = message;
  elements.linkStatus.dataset.tone = tone;
  elements.linkStatus.classList.toggle("is-empty", !message);
  elements.linkRetry.hidden = !retry;
}

async function fillFormFromOcs() {
  const url = elements.formOcsInput.value.trim();
  if (!url) {
    setStatus(elements.formOcsStatus, "Paste an ocs.ca product link first.", "error");
    elements.formOcsInput.focus();
    return;
  }

  setBusy(elements.formOcsButton, true, "Looking up…");
  setStatus(elements.formOcsStatus, "Asking ocs.ca for the product…");

  try {
    const item = await fetchLookup(url);
    const values = wishToEntryValues(item);
    fillForm({ ...readFormValues(), ...values, purchaseDate: fields.purchaseDate.value || today() });
    state.drawer.sourceUrl = item.url || "";
    state.drawer.potencyTouched = true;
    elements.sectionPurchase.open = true;

    const { entries } = findByLink(item.url);
    if (entries.length) {
      state.drawer.productKey = entries[0].productKey || entries[0].id;
      if (!entries[0].productKey) {
        state.drawer.linkOriginal = entries[0].id;
      }
      setStatus(elements.formOcsStatus, `Filled in. You've bought this before (${formatDate(entries[0].purchaseDate)}), so it will show in that product's history.`, "ok");
    } else {
      setStatus(elements.formOcsStatus, "Filled in from OCS. Check the price you actually paid.", "ok");
    }

    updateDuplicateHint();
    updateAmountHint();
    fields.price.focus();
  } catch (error) {
    setStatus(elements.formOcsStatus, error.message, "error");
  } finally {
    setBusy(elements.formOcsButton, false, "Fill in");
  }
}

/* Shopping-list item -> the entry form's fields. The single THC figure is
   the midpoint of OCS's published range; the range itself goes in the notes. */
function wishToEntryValues(item) {
  const type = TYPE_LABELS[item.type] ? item.type : "other";
  const mg = MG_TYPES.has(type);
  return {
    name: item.name,
    type,
    brand: item.brand,
    strain: item.strain,
    extraction: item.extraction,
    amount: item.amount,
    potencyUnit: mg ? "mg" : "%",
    thc: mg ? null : item.thc,
    cbd: mg ? null : item.cbd,
    price: item.price,
    vendor: item.preferredVendor || (item.url ? "OCS" : ""),
    terpenes: Array.isArray(item.terpenes) ? item.terpenes.join(", ") : item.terpenes || "",
    notes: purchaseNotes(item),
  };
}

function purchaseNotes(item) {
  const facts = [];
  if (item.shoppingNote) facts.push(item.shoppingNote);
  if (item.genetics) facts.push(`Genetics: ${item.genetics}`);
  const thcRange = formatRange(item.thcMin, item.thcMax);
  if (thcRange) facts.push(`THC ${thcRange} (store estimate)`);
  const cbdRange = formatRange(item.cbdMin, item.cbdMax);
  if (cbdRange) facts.push(`CBD ${cbdRange} (store estimate)`);
  if (item.process) facts.push(`Extraction: ${item.process}`);
  if (item.producer) facts.push(`Producer: ${item.producer}`);
  return facts.join(". ");
}

/* ── Shopping list ─────────────────────────────────────────────────────── */

function handleManualAdd(event) {
  event.preventDefault();

  const name = elements.manualName.value.trim();
  if (!name) {
    elements.manualName.setAttribute("aria-invalid", "true");
    elements.manualNameError.textContent = "Give the item a name.";
    elements.manualNameError.hidden = false;
    elements.manualName.focus();
    return;
  }
  elements.manualName.removeAttribute("aria-invalid");
  elements.manualNameError.hidden = true;

  const price = Core.toNumber(elements.manualPrice.value);
  const { value } = normalizeWishItem({
    id: uuid(),
    name,
    brand: elements.manualBrand.value,
    price: price !== null && price >= 0 ? price : null,
    priority: elements.manualPriority.value,
    shoppingNote: elements.manualNote.value,
    addedAt: new Date().toISOString(),
  });

  const duplicate = state.data.wishlist.find((item) => nameKey(item) === nameKey(value));
  commit((data) => {
    data.wishlist = [value, ...data.wishlist];
  });

  elements.manualForm.reset();
  elements.manualPriority.value = "normal";
  setLinkStatus(duplicate ? `Added ${name}. There's already an item with that name on the list.` : `Added ${name}.`, "ok");
  elements.manualName.focus();
}

function wishScores() {
  const scores = new Map();
  for (const item of state.data.wishlist) {
    if (!item.matchDismissed) {
      scores.set(item.id, matchScore(item, state.data.products));
    }
  }
  return scores;
}

function renderWishlist() {
  if (state.view !== "shopping") {
    return;
  }

  const items = state.data.wishlist;
  const scores = wishScores();
  clear(elements.wishlist);

  const priced = items.filter((item) => typeof item.price === "number");
  const total = priced.reduce((sum, item) => sum + item.price, 0);
  const unknown = items.length - priced.length;

  elements.wishCount.textContent = items.length ? plural(items.length, "item") : "Nothing on the list";
  elements.wishTotal.textContent = items.length
    ? [priced.length ? `${formatCurrency(total)} estimated` : "", unknown ? `${unknown} without a price` : ""].filter(Boolean).join(" · ")
    : "";

  if (!items.length) {
    elements.wishlist.appendChild(
      h(
        "li",
        { class: "empty wish-empty" },
        h("p", { class: "empty-title", text: "Your list is empty" }),
        h("p", { class: "empty-note", text: "Paste an ocs.ca product link above, or add something by hand." }),
        h("div", { class: "empty-actions" }, h("button", { type: "button", class: "btn btn-secondary", onclick: () => elements.linkInput.focus() }, "Paste an OCS link"))
      )
    );
    return;
  }

  keepFocus(() => {
    for (const item of sortWishlist(items, prefs.wishSort, scores)) {
      elements.wishlist.appendChild(wishlistCard(item, scores.get(item.id)));
    }
  });
}

function wishlistCard(item, match) {
  const priceLine = [];
  if (typeof item.price === "number") {
    priceLine.push(h("span", { class: "wish-price private", text: formatCurrency(item.price) }));
  } else {
    priceLine.push(h("span", { class: "muted", text: "No price" }));
  }

  const atTarget = typeof item.targetPrice === "number" && typeof item.price === "number" && item.price <= item.targetPrice;
  const freshness = item.url
    ? item.lookedUpAt
      ? `OCS price, checked ${formatTimestamp(item.lookedUpAt)}`
      : "OCS price at the time it was added"
    : "Entered by hand";

  const thumb = item.image
    ? h("img", { class: "wish-thumb", src: item.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
    : h("span", { class: "wish-thumb wish-thumb-empty", "aria-hidden": "true", text: (item.name[0] || "?").toUpperCase() });

  const chips = h("div", { class: "chip-row" });
  if (item.priority !== "normal") {
    chips.appendChild(chip(`${PRIORITY_LABELS[item.priority]} priority`, item.priority === "high" ? "chip-priority-high" : "chip-priority-low"));
  }
  const thcRange = formatRange(item.thcMin, item.thcMax);
  if (thcRange) chips.appendChild(chip(`THC ${thcRange}`, "chip-accent"));
  const cbdRange = formatRange(item.cbdMin, item.cbdMax);
  if (cbdRange) chips.appendChild(chip(`CBD ${cbdRange}`));
  if (item.type) chips.appendChild(chip(typeLabel(item.type)));
  if (item.extraction) chips.appendChild(chip(item.extraction));
  if (item.url && item.available === false) chips.appendChild(chip("Out of stock", "chip-danger"));

  return h(
    "li",
    { class: "wish", dataset: { id: item.id } },
    h(
      "div",
      { class: "wish-head" },
      thumb,
      h(
        "div",
        { class: "wish-heading" },
        h("h2", { class: "wish-name", text: item.name }),
        h("p", { class: "wish-brand", text: [item.brand, item.amount, item.strain].filter(Boolean).join(" · ") || "Added by hand" })
      )
    ),
    chips.childElementCount ? chips : null,
    item.terpenes.length ? h("p", { class: "wish-terpenes", text: item.terpenes.join(" · ") }) : null,
    item.shoppingNote ? h("p", { class: "wish-note" }, icon("i-note"), h("span", { text: item.shoppingNote })) : null,
    item.preferredVendor ? h("p", { class: "wish-meta", text: `Preferred store: ${item.preferredVendor}` }) : null,
    match && match.score
      ? h(
          "div",
          { class: "wish-match" },
          h(
            "p",
            null,
            h("strong", { text: "Matches your taste: " }),
            `${match.reasons.join(", ")} with `,
            h("button", { type: "button", class: "name-link", onclick: () => openDetail(match.basis.id) }, match.basis.name),
            typeof match.basis.rating === "number" ? ` (you rated it ${formatRating(match.basis.rating)})` : match.basis.favorite ? " (a favorite)" : ""
          ),
          iconButton("i-close", "Hide this suggestion", () => updateWishItem(item.id, { matchDismissed: true }))
        )
      : null,
    h(
      "div",
      { class: "wish-foot" },
      h(
        "div",
        { class: "wish-pricing" },
        h("p", { class: "wish-price-line" }, priceLine, typeof item.targetPrice === "number" ? h("span", { class: `wish-target private${atTarget ? " is-met" : ""}`, text: atTarget ? `at or under target (${formatCurrency(item.targetPrice)})` : `target ${formatCurrency(item.targetPrice)}` }) : null),
        h("p", { class: "wish-fresh", text: freshness })
      ),
      h(
        "div",
        { class: "wish-actions" },
        item.url
          ? h("a", { class: "icon-button", href: item.url, target: "_blank", rel: "noopener noreferrer", title: "Open on ocs.ca", "aria-label": `Open ${item.name} on ocs.ca` }, icon("i-external"))
          : null,
        iconButton("i-pencil", `Edit ${item.name}`, () => editWishItem(item.id), { focusKey: `wish-edit:${item.id}` }),
        iconButton("i-trash", `Remove ${item.name}`, () => removeWishlistItem(item.id), { danger: true }),
        h("button", { type: "button", class: "btn btn-primary btn-small", "data-focus-key": `wish-log:${item.id}`, onclick: () => logPurchase(item.id) }, "Log purchase")
      )
    )
  );
}

function highlightWish(itemId) {
  const card = elements.wishlist.querySelector(`[data-id="${CSS.escape(itemId)}"]`);
  if (card) {
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.classList.add("is-flash");
    window.setTimeout(() => card.classList.remove("is-flash"), 1600);
  }
}

function updateWishItem(itemId, changes) {
  commit((data) => {
    data.wishlist = data.wishlist.map((item) =>
      item.id === itemId ? normalizeWishItem({ ...item, ...changes, updatedAt: new Date().toISOString() }).value : item
    );
  });
}

async function editWishItem(itemId) {
  const item = state.data.wishlist.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  const nameInput = h("input", { type: "text", value: item.name, required: true });
  const brandInput = h("input", { type: "text", value: item.brand });
  const priceInput = h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal", value: item.price ?? "" });
  const targetInput = h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal", value: item.targetPrice ?? "", placeholder: "Buy at or under" });
  const prioritySelect = h("select", null, Object.entries(PRIORITY_LABELS).map(([value, label]) => h("option", { value, text: label })));
  prioritySelect.value = item.priority;
  const vendorInput = h("input", { type: "text", value: item.preferredVendor, placeholder: "Store you'd buy it from", list: "vendor-options" });
  const noteInput = h("textarea", { rows: "3", placeholder: "Why it's interesting, alternatives, who recommended it" });
  noteInput.value = item.shoppingNote;
  const error = h("p", { class: "field-error", role: "alert", hidden: true });

  const choice = await openDialog({
    title: "Edit shopping item",
    body: h(
      "div",
      { class: "dialog-form form-grid" },
      h("label", { class: "span-2" }, "Product", nameInput),
      h("label", null, "Brand", brandInput),
      h("label", null, "Priority", prioritySelect),
      h("label", null, "Current price", priceInput),
      h("label", null, "Target price", targetInput),
      h("label", { class: "span-2" }, "Preferred store", vendorInput),
      h("label", { class: "span-2" }, "Notes", noteInput),
      error
    ),
    actions: [
      { label: "Cancel", value: null },
      { label: "Save", value: "save", variant: "primary" },
    ],
    validate: () => {
      if (!nameInput.value.trim()) {
        error.textContent = "The item needs a name.";
        error.hidden = false;
        nameInput.focus();
        return false;
      }
      return true;
    },
  });

  if (choice !== "save") {
    return;
  }

  const price = Core.toNumber(priceInput.value);
  updateWishItem(itemId, {
    name: nameInput.value,
    brand: brandInput.value,
    price,
    priority: prioritySelect.value,
    targetPrice: Core.toNumber(targetInput.value),
    preferredVendor: vendorInput.value,
    shoppingNote: noteInput.value,
    /* A hand-edited price is no longer the looked-up one. */
    lookedUpAt: price === item.price ? item.lookedUpAt : "",
  });
  showToast(`Updated ${nameInput.value.trim()}.`);
}

/* Move a shopping-list item into the collection: the form opens prefilled so
   the price paid and a rating can be corrected. Cancelling keeps the item;
   saving takes it off the list. */
function logPurchase(itemId) {
  const item = state.data.wishlist.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  const { entries } = findByLink(item.url);
  const previous = entries[0];

  openEntryForm({
    mode: "purchase",
    sourceWishId: item.id,
    prefill: {
      ...wishToEntryValues(item),
      purchaseDate: today(),
      sourceUrl: item.url,
      productKey: previous ? previous.productKey || previous.id : "",
    },
  });

  if (previous && !previous.productKey) {
    state.drawer.linkOriginal = previous.id;
  }
}

/* ── Insights ──────────────────────────────────────────────────────────── */

function renderInsights() {
  if (state.view !== "insights") {
    return;
  }

  const entries = state.data.products;
  renderSpendChart(entries);
  renderBudget(entries);
  renderInventory(entries);
  renderRatings(entries);
  renderBrands(entries);
  renderRepurchase(entries);
  renderValue(entries);
}

function renderSpendChart(entries) {
  const { buckets, undated, unpriced } = monthlySpend(entries, 12);
  const budget = state.data.settings.monthlyBudget;
  const max = Math.max(...buckets.map((bucket) => bucket.total), budget || 0, 1);
  const chart = clear(elements.spendChart);

  const notes = [];
  if (undated) notes.push(`${plural(undated, "entry", "entries")} without a purchase date`);
  if (unpriced) notes.push(`${unpriced} without a price`);
  elements.spendNote.textContent = `Last 12 months, dated purchases only.${notes.length ? ` Left out: ${notes.join(" and ")}.` : ""}`;

  const plot = h("div", { class: "month-plot", role: "img", "aria-label": "Monthly spend, last 12 months. The table below has the values." });
  if (typeof budget === "number" && budget > 0) {
    const line = h("span", { class: "budget-line", title: `Budget ${formatCurrency(budget)}` }, h("span", { class: "budget-line-label", text: `Budget ${formatCurrency(budget)}` }));
    line.style.bottom = `${(budget / max) * 100}%`;
    plot.appendChild(line);
  }

  for (const bucket of buckets) {
    const column = h("div", { class: "month-col", title: `${monthFormat.format(bucket.date)} ${bucket.date.getFullYear()}: ${formatCurrency(bucket.total)} across ${plural(bucket.count, "purchase")}` });
    const bar = h("span", { class: `month-bar${typeof budget === "number" && bucket.total > budget ? " is-over" : ""}` });
    bar.style.height = `${(bucket.total / max) * 100}%`;
    column.append(
      h("span", { class: "month-value", text: bucket.total ? `$${Math.round(bucket.total)}` : "" }),
      h("span", { class: "month-bar-wrap" }, bar)
    );
    plot.appendChild(column);
  }

  const labels = h("div", { class: "month-labels", "aria-hidden": "true" }, buckets.map((bucket) => h("span", { text: monthFormat.format(bucket.date) })));

  const table = h(
    "table",
    { class: "sr-only" },
    h("caption", { text: "Monthly spend" }),
    h("thead", null, h("tr", null, h("th", { scope: "col", text: "Month" }), h("th", { scope: "col", text: "Spend" }), h("th", { scope: "col", text: "Purchases" }))),
    h("tbody", null, buckets.map((bucket) => h("tr", null, h("td", { text: `${monthFormat.format(bucket.date)} ${bucket.date.getFullYear()}` }), h("td", { text: formatCurrency(bucket.total) }), h("td", { text: String(bucket.count) }))))
  );

  append(chart, [plot, labels, table]);
}

function renderBudget(entries) {
  const budget = state.data.settings.monthlyBudget;
  if (document.activeElement !== elements.budgetInput) {
    elements.budgetInput.value = budget ?? "";
  }

  const month = spendInMonth(entries);
  const shopping = state.data.wishlist.reduce((sum, item) => sum + (typeof item.price === "number" ? item.price : 0), 0);
  const summary = clear(elements.budgetSummary);

  if (typeof budget !== "number") {
    append(summary, [
      h("p", null, "This month so far: ", h("strong", { text: formatCurrency(month) })),
      shopping ? h("p", { class: "muted", text: `Your shopping list would add about ${formatCurrency(shopping)}.` }) : null,
    ]);
    return;
  }

  const meter = h("span", { class: `meter-fill${month > budget ? " is-over" : ""}` });
  meter.style.width = `${Math.min(100, budget ? (month / budget) * 100 : 100)}%`;
  append(summary, [
    h("p", null, h("strong", { text: formatCurrency(month) }), ` of ${formatCurrency(budget)} spent this month`),
    h("span", { class: "meter", role: "img", "aria-label": `${Math.round((month / (budget || 1)) * 100)}% of budget used` }, meter),
    h("p", { class: month > budget ? "is-over-text" : "muted", text: month > budget ? `${formatCurrency(month - budget)} over budget.` : `${formatCurrency(budget - month)} left.` }),
    shopping ? h("p", { class: "muted", text: `Shopping list estimate, not counted above: ${formatCurrency(shopping)}.` }) : null,
  ]);
}

function handleBudget(event) {
  event.preventDefault();
  const raw = elements.budgetInput.value.trim();
  const value = Core.toNumber(raw);
  if (raw && (value === null || value < 0)) {
    showToast("The budget must be a positive number, or blank for none.");
    return;
  }
  commit((data) => {
    data.settings = { ...data.settings, monthlyBudget: raw ? value : null };
  });
  showToast(raw ? `Monthly budget set to ${formatCurrency(value)}.` : "Monthly budget removed.");
}

function renderInventory(entries) {
  const container = clear(elements.inventorySummary);
  const counts = [
    ["unopened", "Unopened"],
    ["open", "In use"],
    ["finished", "Finished"],
    ["none", "Not tracked"],
  ].map(([key, label]) => [key, label, entries.filter((entry) => (entry.status || "none") === key).length]);
  const max = Math.max(...counts.map(([, , count]) => count), 1);

  for (const [key, label, count] of counts) {
    container.appendChild(
      barButton({
        label,
        value: count,
        max,
        title: `${label}: ${plural(count, "entry", "entries")}. Show these in the collection.`,
        onClick: count
          ? () => {
              prefs.filters = { ...defaultFilters(), statuses: [key] };
              savePrefs();
              syncFilterFields();
              showView("collection", { push: true });
            }
          : null,
      })
    );
  }
}

function renderRatings(entries) {
  const { buckets, unrated } = ratingDistribution(entries);
  const container = clear(elements.ratingChart);
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const rated = entries.length - unrated;
  const average = rated ? entries.reduce((sum, entry) => sum + (entry.rating || 0), 0) / rated : null;
  elements.ratingsNote.textContent = rated
    ? `Average ${average.toFixed(1)} across ${plural(rated, "rated entry", "rated entries")}.${unrated ? ` ${unrated} not rated yet.` : ""}`
    : "Nothing rated yet.";

  for (const bucket of [...buckets].reverse()) {
    if (!bucket.count && bucket.score < 3) {
      continue;
    }
    container.appendChild(
      barButton({
        label: String(bucket.score),
        value: bucket.count,
        max,
        title: bucket.score === 10 ? `Rated 10: ${plural(bucket.count, "entry", "entries")}` : `Rated ${bucket.score} to ${bucket.score}.5: ${plural(bucket.count, "entry", "entries")}`,
      })
    );
  }
}

function renderBrands(entries) {
  const container = clear(elements.brandChart);
  const counts = countBy(entries.filter((entry) => entry.favorite), (entry) => entry.brand.trim());
  if (!counts.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "Star a few entries that have a brand and they'll be counted here." }));
    return;
  }

  const max = counts[0][1];
  for (const [brand, count] of counts.slice(0, 8)) {
    container.appendChild(
      barButton({
        label: brand,
        value: count,
        max,
        title: `${brand}: ${plural(count, "favorite")}. Show them.`,
        onClick: () => {
          prefs.filters = { ...defaultFilters(), brands: [brand] };
          savePrefs();
          syncFilterFields();
          showView("favorites", { push: true });
        },
      })
    );
  }
}

/* Groups purchases of one product so "bought 3 times" is visible. */
function productGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.productKey || productLinkKey(entry.sourceUrl) || entry.id;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function renderRepurchase(entries) {
  const container = clear(elements.repurchaseList);
  const groups = productGroups(entries)
    .map((group) => {
      const latest = sortEntries(group, "purchaseDate-desc")[0];
      const rated = group.filter((entry) => typeof entry.rating === "number");
      const prices = group.filter((entry) => typeof entry.price === "number");
      return {
        latest,
        count: group.length,
        explicit: group.some((entry) => entry.wouldRepurchase === true),
        rejected: latest.wouldRepurchase === false,
        liked: group.some(isLiked),
        rating: rated.length ? rated.reduce((sum, entry) => sum + entry.rating, 0) / rated.length : null,
        averagePrice: prices.length ? prices.reduce((sum, entry) => sum + entry.price, 0) / prices.length : null,
      };
    })
    .filter((group) => group.liked && !group.rejected)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || (b.rating ?? -1) - (a.rating ?? -1) || b.count - a.count);

  if (!groups.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "Nothing yet. Mark entries as favorites, rate them 8+, or answer “would you buy it again?”." }));
    return;
  }

  container.appendChild(
    h(
      "table",
      { class: "mini-table" },
      h("thead", null, h("tr", null, h("th", { scope: "col", text: "Product" }), h("th", { scope: "col", class: "num", text: "Rating" }), h("th", { scope: "col", class: "num", text: "Bought" }), h("th", { scope: "col", class: "num", text: "Avg paid" }), h("th", { scope: "col", text: "Last bought" }))),
      h(
        "tbody",
        null,
        groups.slice(0, 15).map((group) =>
          h(
            "tr",
            null,
            h("td", null, h("button", { type: "button", class: "name-link", onclick: () => openDetail(group.latest.id) }, group.latest.name), group.explicit ? h("span", { class: "sr-only", text: " (marked would buy again)" }) : null, group.explicit ? chip("Yes", "chip-accent chip-inline") : null),
            h("td", { class: "num", text: formatRating(group.rating) }),
            h("td", { class: "num", text: `${group.count}×` }),
            h("td", { class: "num private", text: formatCurrency(group.averagePrice) }),
            h("td", { text: formatDate(group.latest.purchaseDate) })
          )
        )
      )
    )
  );
}

function renderValue(entries) {
  const container = clear(elements.valueList);
  const withPrice = entries
    .map((entry) => ({ entry, price: unitPrice(entry) }))
    .filter(({ price }) => price && price.unit === "g");
  const leftOut = entries.length - withPrice.length;
  elements.valueNote.textContent = `Price paid divided by grams, grouped by type so unlike products are never ranked together.${leftOut ? ` ${plural(leftOut, "entry", "entries")} left out: no price, or an amount that doesn't read as grams.` : ""}`;

  if (!withPrice.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "Record a price and an amount like 3.5g to compare value." }));
    return;
  }

  const byType = new Map();
  for (const row of withPrice) {
    const list = byType.get(row.entry.type) || [];
    list.push(row);
    byType.set(row.entry.type, list);
  }

  for (const [type, rows] of byType) {
    rows.sort((a, b) => a.price.value - b.price.value);
    container.appendChild(
      h(
        "section",
        { class: "value-group" },
        h("h3", { class: "detail-heading", text: typeLabel(type) }),
        h(
          "table",
          { class: "mini-table" },
          h("thead", null, h("tr", null, h("th", { scope: "col", text: "Product" }), h("th", { scope: "col", text: "Amount" }), h("th", { scope: "col", class: "num", text: "Paid" }), h("th", { scope: "col", class: "num", text: "Per gram" }))),
          h(
            "tbody",
            null,
            rows.map(({ entry }) =>
              h(
                "tr",
                null,
                h("td", null, h("button", { type: "button", class: "name-link", onclick: () => openDetail(entry.id) }, entry.name)),
                h("td", { text: entry.amount }),
                h("td", { class: "num", text: formatCurrency(entry.price) }),
                h("td", { class: "num", text: formatUnitPrice(entry) })
              )
            )
          )
        )
      )
    );
  }
}

/* ── Reminders ─────────────────────────────────────────────────────────── */

function unratedForReminder() {
  const dismissed = new Set(prefs.reminders.dismissed);
  return sortEntries(awaitingRating(state.data.products).filter((entry) => !dismissed.has(entry.id)), "purchaseDate-asc");
}

function renderReminder() {
  const reminders = prefs.reminders;
  const snoozed = reminders.snoozeUntil && reminders.snoozeUntil > today();
  const pending = reminders.enabled && !snoozed && state.view === "collection" ? unratedForReminder() : [];

  elements.reminder.hidden = !pending.length;
  if (pending.length) {
    const names = pending.slice(0, 2).map((entry) => `“${entry.name}”`).join(" and ");
    elements.reminderText.textContent =
      pending.length === 1
        ? `How was ${names}? It's waiting for a rating.`
        : `${pending.length} purchases are waiting for a rating, starting with ${names}.`;
  }
}

function reviewNextUnrated() {
  const [next] = unratedForReminder();
  if (!next) {
    return;
  }

  /* Once opened, this one stops nagging whether or not it gets a rating. */
  prefs.reminders.dismissed.push(next.id);
  savePrefs();
  openEntryForm({ mode: "edit", entryId: next.id, focusField: "rating" });
  renderReminder();
}

/* ── Compare ───────────────────────────────────────────────────────────── */

function openCompare(ids) {
  const entries = ids.map(findEntry).filter(Boolean).slice(0, 4);
  if (entries.length < 2) {
    return;
  }

  const units = new Set(entries.map((entry) => entry.potencyUnit));
  const bestOf = (values, pick) => {
    const numbers = values.filter((value) => typeof value === "number");
    if (numbers.length < 2) return null;
    return pick === "min" ? Math.min(...numbers) : Math.max(...numbers);
  };

  const unitValues = entries.map((entry) => {
    const price = unitPrice(entry);
    return price && price.unit === "g" ? price.value : null;
  });
  const bestUnit = new Set(entries.map((entry) => entry.type)).size === 1 ? bestOf(unitValues, "min") : null;
  const bestRating = bestOf(entries.map((entry) => entry.rating), "max");

  const rows = [
    ["Type", (entry) => typeLabel(entry.type)],
    ["Brand", (entry) => entry.brand],
    ["Amount", (entry) => entry.amount],
    ["Price paid", (entry) => (typeof entry.price === "number" ? formatCurrency(entry.price) : ""), { private: true }],
    ["Per gram", (entry, index) => (unitValues[index] !== null ? formatUnitPrice(entry) : ""), { private: true, best: (entry, index) => bestUnit !== null && unitValues[index] === bestUnit, bestLabel: "lowest" }],
    ["Rating", (entry) => (typeof entry.rating === "number" ? `${formatRating(entry.rating)} / 10` : ""), { best: (entry) => bestRating !== null && entry.rating === bestRating, bestLabel: "highest" }],
    ["Would buy again", (entry) => (entry.wouldRepurchase === true ? "Yes" : entry.wouldRepurchase === false ? "No" : "")],
    ["THC", (entry) => (typeof entry.thc === "number" ? formatPotency(entry.thc, entry.potencyUnit) : "")],
    ["CBD", (entry) => (typeof entry.cbd === "number" ? formatPotency(entry.cbd, entry.potencyUnit) : "")],
    ["Total terpenes", (entry) => (typeof entry.terpenePercent === "number" ? `${entry.terpenePercent.toFixed(1)}%` : "")],
    ["Terpenes", (entry) => entry.terpenes],
    ["Effects", (entry) => entry.effects],
    ["Tags", (entry) => entry.tags.join(", ")],
    ["Purchased", (entry) => (entry.purchaseDate ? formatDate(entry.purchaseDate) : "")],
    ["Notes", (entry) => entry.notes, { private: true, long: true }],
  ];

  const table = h(
    "table",
    { class: "compare-table" },
    h("thead", null, h("tr", null, h("td", null), entries.map((entry) => h("th", { scope: "col", text: entry.name })))),
    h(
      "tbody",
      null,
      rows.map(([label, read, options = {}]) =>
        h(
          "tr",
          null,
          h("th", { scope: "row", text: label }),
          entries.map((entry, index) => {
            const value = read(entry, index);
            const best = options.best?.(entry, index);
            return h(
              "td",
              { class: [options.private ? "private" : "", best ? "is-best" : "", options.long ? "is-long" : ""].join(" ").trim(), "data-label": entry.name },
              value ? value : h("span", { class: "muted", text: "Not recorded" }),
              best ? h("span", { class: "best-mark", text: ` ${options.bestLabel}` }) : null
            );
          })
        )
      )
    )
  );

  openDialog({
    title: `Comparing ${entries.length} entries`,
    wide: true,
    body: h(
      "div",
      null,
      units.size > 1 ? h("p", { class: "dialog-note", text: "Potency is in different units here (percent and milligrams), so those rows can't be compared directly." }) : null,
      new Set(entries.map((entry) => entry.type)).size > 1 ? h("p", { class: "dialog-note", text: "These are different types, so price per gram isn't ranked." }) : null,
      h("div", { class: "compare-scroll" }, table)
    ),
    actions: [{ label: "Done", value: null, variant: "primary" }],
  });
}

/* ── Import and export ─────────────────────────────────────────────────── */

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  downloadJson(
    {
      version: Core.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      ...syncable(state.data),
    },
    `weed_chart-${today()}.json`
  );
  showToast("Exported everything, including the journal and recently deleted items.");
}

async function importData(event) {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (!file) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    await openDialog({
      title: "That file can't be imported",
      body: h("p", { text: `It isn't valid JSON (${error.message}). Nothing was changed.` }),
      actions: [{ label: "OK", value: null, variant: "primary" }],
    });
    return;
  }

  const { doc, report, valid } = migrateDoc(parsed);
  if (!valid) {
    await openDialog({
      title: "That file can't be imported",
      body: h("p", { text: `${report.errors[0]?.message || "Unrecognised format"}. Nothing was changed.` }),
      actions: [{ label: "OK", value: null, variant: "primary" }],
    });
    return;
  }

  const counts = docCounts(doc);
  const current = docCounts(state.data);
  const problems = [...report.errors, ...report.warnings];

  const body = h(
    "div",
    { class: "import-preview" },
    h("p", null, h("strong", { text: file.name }), " contains:"),
    h(
      "ul",
      { class: "import-counts" },
      h("li", { text: `${plural(counts.products, "entry", "entries")} (you have ${current.products})` }),
      h("li", { text: `${plural(counts.wishlist, "shopping item")} (you have ${current.wishlist})` }),
      counts.experiences ? h("li", { text: `${plural(counts.experiences, "journal note")}` }) : null
    ),
    report.errors.length ? h("p", { class: "is-over-text", text: `${plural(report.errors.length, "record")} will be skipped:` }) : null,
    report.warnings.length ? h("p", { class: "muted", text: `${plural(report.warnings.length, "value")} will be cleared because they were invalid:` }) : null,
    problems.length
      ? h(
          "ul",
          { class: "import-problems" },
          problems.slice(0, 12).map((problem) =>
            h("li", { text: `${problem.collection}${problem.index >= 0 ? ` #${problem.index + 1}` : ""}${problem.label ? ` “${problem.label}”` : ""}: ${problem.message}` })
          ),
          problems.length > 12 ? h("li", { text: `…and ${problems.length - 12} more.` }) : null
        )
      : null,
    h(
      "dl",
      { class: "choice-list" },
      h("dt", { text: "Merge" }),
      h("dd", { text: "Adds what's new. Where both have the same record, the more recently edited one is kept." }),
      h("dt", { text: "Replace" }),
      h("dd", { text: "Everything you have now is swapped for the file. A copy is kept so you can restore it from Backups & recovery." })
    )
  );

  const choice = await openDialog({
    title: "Import data",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Replace everything", value: "replace", variant: "danger" },
      { label: "Merge", value: "merge", variant: "primary" },
    ],
  });

  if (!choice) {
    return;
  }

  saveRecoveryCopy(choice === "replace" ? "before replacing with an import" : "before merging an import");

  if (choice === "replace") {
    commit((data) => {
      Object.assign(data, doc, { trash: purgeTrash([...trashEverything(data), ...doc.trash]) });
    }, { reason: "import" });
    showToast(`Replaced with ${plural(counts.products, "entry", "entries")} from the file.`);
  } else {
    commit((data) => {
      Object.assign(data, combineDocs(data, doc));
    }, { reason: "import" });
    showToast(`Merged ${file.name}.`);
  }

  closeDrawer();
}

/* Replacing keeps what was there in Recently deleted, so a mistaken import
   can be undone record by record too. */
function trashEverything(data) {
  const now = new Date().toISOString();
  return [
    ...data.products.map((item, position) => ({ id: item.id, kind: "product", item, deletedAt: now, position })),
    ...data.wishlist.map((item, position) => ({ id: item.id, kind: "wishlist", item, deletedAt: now, position })),
    ...data.trash,
  ];
}

function saveRecoveryCopy(label) {
  const ok = storageSet(RECOVERY_KEY, JSON.stringify({ label, savedAt: new Date().toISOString(), data: syncable(state.data) }));
  if (!ok) {
    console.warn("No room for a browser recovery copy; the server snapshot still covers it.");
  }
}

async function confirmClearAll() {
  const counts = docCounts(state.data);
  const body = h(
    "div",
    null,
    h("p", { text: `This removes ${plural(counts.products, "entry", "entries")}, ${plural(counts.wishlist, "shopping item")} and ${plural(counts.experiences, "journal note")}.` }),
    h("p", {
      text: sync.available
        ? "It clears them for every device that uses this server, not only this browser. The server keeps a snapshot first, which you can restore from Backups & recovery."
        : "This page isn't connected to the server, so only this browser's copy is cleared. A recovery copy is kept in this browser.",
    }),
    h("p", { class: "muted", text: "If you want a file of your own first, export it." })
  );

  const choice = await openDialog({
    title: "Clear the collection and shopping list?",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Export first", value: "export" },
      { label: "Clear everything", value: "clear", variant: "danger" },
    ],
  });

  if (choice === "export") {
    exportData();
    return;
  }

  if (choice !== "clear") {
    return;
  }

  saveRecoveryCopy("before clearing everything");
  commit((data) => {
    Object.assign(data, emptyDoc(), { settings: data.settings });
  }, { reason: "clear" });
  closeDrawer();
  showToast("Cleared. Restore from Backups & recovery if that was a mistake.");
}

/* ── Backups and recovery ──────────────────────────────────────────────── */

async function openBackups() {
  const list = h("div", { class: "backup-list" }, h("p", { class: "muted", text: sync.available ? "Loading snapshots…" : "" }));
  const recovery = readJson(RECOVERY_KEY);

  const body = h(
    "div",
    null,
    h("p", {
      class: "dialog-note",
      text: "The server copies weed_chart.json aside before every import, restore or clear, and at most every 15 minutes while you edit. The newest 100 are kept. Restoring takes a new snapshot first, so a restore can be undone too.",
    }),
    recovery?.data
      ? h(
          "section",
          { class: "backup-local" },
          h("h3", { class: "detail-heading", text: "This browser's recovery copy" }),
          h(
            "div",
            { class: "backup-row" },
            h("div", null, h("strong", { text: `Saved ${formatTimestamp(recovery.savedAt)}` }), h("p", { class: "muted", text: `${recovery.label} · ${countsLabel(recovery.data)}` })),
            h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => restoreDoc(recovery.data, "the browser recovery copy") }, "Restore")
          )
        )
      : null,
    sync.available ? h("h3", { class: "detail-heading", text: "Server snapshots" }) : h("p", { class: "muted", text: "Server snapshots need the page to be opened through serve.py." }),
    sync.available ? list : null,
    sync.available
      ? h(
          "section",
          { class: "backup-local" },
          h("h3", { class: "detail-heading", text: "Start over from the server" }),
          h("p", { class: "muted", text: "Throws away this browser's copy, including changes that haven't reached the server, and loads the server's version." }),
          h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: reloadFromServer }, "Reload from server")
        )
      : null
  );

  const dialogPromise = openDialog({
    title: "Backups & recovery",
    wide: true,
    body,
    actions: [{ label: "Close", value: null, variant: "primary" }],
  });

  if (sync.available) {
    try {
      const response = await fetch(SNAPSHOT_ENDPOINT, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(response.status === 404 ? "This server doesn't keep snapshots yet: restart it to pick up the new serve.py." : `Server answered ${response.status}.`);
      }
      const { snapshots } = await response.json();
      clear(list);
      if (!snapshots.length) {
        list.appendChild(h("p", { class: "muted", text: "No snapshots yet. The first one is taken before the next save." }));
      }
      for (const snapshot of snapshots) {
        list.appendChild(
          h(
            "div",
            { class: "backup-row" },
            h(
              "div",
              null,
              h("strong", { text: formatTimestamp(snapshot.createdAt) }),
              h("p", { class: "muted", text: `${REASON_LABELS[snapshot.reason] || snapshot.reason}${snapshot.counts ? ` · ${countsLabel(snapshot.counts)}` : ""}` })
            ),
            h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => previewSnapshot(snapshot) }, "Preview")
          )
        );
      }
    } catch (error) {
      clear(list).appendChild(h("p", { class: "is-over-text", text: error.message }));
    }
  }

  await dialogPromise;
}

const REASON_LABELS = {
  auto: "Before an edit",
  import: "Before an import",
  restore: "Before a restore",
  clear: "Before clearing",
  migration: "Before upgrading the file format",
};

function countsLabel(source) {
  const counts = Array.isArray(source.products)
    ? { products: source.products.length, wishlist: (source.wishlist || []).length }
    : source;
  return `${plural(counts.products || 0, "entry", "entries")}, ${plural(counts.wishlist || 0, "shopping item")}`;
}

async function previewSnapshot(snapshot) {
  closeCurrentDialog();
  let payload;
  try {
    const response = await fetch(`${SNAPSHOT_ENDPOINT}/${encodeURIComponent(snapshot.name)}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Server answered ${response.status}.`);
    }
    payload = await response.json();
  } catch (error) {
    showToast(`Could not open that snapshot: ${error.message}`);
    return;
  }

  const { doc } = migrateDoc(payload.state);
  const currentIds = new Set(state.data.products.map((entry) => entry.id));
  const snapshotIds = new Set(doc.products.map((entry) => entry.id));
  const onlyInSnapshot = doc.products.filter((entry) => !currentIds.has(entry.id));
  const onlyNow = state.data.products.filter((entry) => !snapshotIds.has(entry.id));

  const body = h(
    "div",
    null,
    h("p", { text: `Taken ${formatTimestamp(snapshot.createdAt)} · ${countsLabel(doc)}.` }),
    h("p", { class: "muted", text: `You have ${countsLabel(state.data)} now.` }),
    onlyInSnapshot.length
      ? h("div", null, h("h3", { class: "detail-heading", text: "Would come back" }), h("ul", { class: "import-problems" }, onlyInSnapshot.slice(0, 10).map((entry) => h("li", { text: entry.name })), onlyInSnapshot.length > 10 ? h("li", { text: `…and ${onlyInSnapshot.length - 10} more` }) : null))
      : null,
    onlyNow.length
      ? h("div", null, h("h3", { class: "detail-heading", text: "Would be removed (kept in Recently deleted)" }), h("ul", { class: "import-problems" }, onlyNow.slice(0, 10).map((entry) => h("li", { text: entry.name })), onlyNow.length > 10 ? h("li", { text: `…and ${onlyNow.length - 10} more` }) : null))
      : null,
    !onlyInSnapshot.length && !onlyNow.length ? h("p", { class: "muted", text: "Same entries as now; restoring brings back their older field values." }) : null
  );

  const choice = await openDialog({
    title: "Restore this snapshot?",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Restore", value: "restore", variant: "primary" },
    ],
  });

  if (choice === "restore") {
    restoreDoc(doc, `the snapshot from ${formatTimestamp(snapshot.createdAt)}`);
  }
}

function restoreDoc(source, label) {
  const { doc } = migrateDoc(source);
  saveRecoveryCopy(`before restoring ${label}`);
  commit((data) => {
    const restoredIds = new Set(doc.products.map((entry) => entry.id));
    const displaced = data.products
      .filter((entry) => !restoredIds.has(entry.id))
      .map((item, position) => ({ id: item.id, kind: "product", item, deletedAt: new Date().toISOString(), position }));
    Object.assign(data, doc, { trash: purgeTrash([...displaced, ...doc.trash]) });
  }, { reason: "restore" });
  closeAllDialogs();
  showToast(`Restored ${label}.`);
}

async function reloadFromServer() {
  closeCurrentDialog();
  const choice = await openDialog({
    title: "Reload from the server?",
    body: h("p", { text: sync.dirty ? "This browser has changes the server hasn't got yet. They'll be lost (a recovery copy is kept in this browser)." : "This browser's copy will be replaced with the server's." }),
    actions: [
      { label: "Cancel", value: null },
      { label: "Reload", value: "reload", variant: "danger" },
    ],
  });

  if (choice !== "reload") {
    return;
  }

  saveRecoveryCopy("before reloading from the server");
  try {
    const remote = await fetchState();
    applyRemote(remote);
    closeAllDialogs();
    showToast("Loaded the server's copy.");
  } catch (error) {
    showToast(`Could not reach the server: ${error.message}`);
  }
}

/* ── Recently deleted ──────────────────────────────────────────────────── */

function openTrash() {
  const container = h("div", { class: "trash-list" });

  const render = () => {
    clear(container);
    const items = state.data.trash;
    if (!items.length) {
      container.appendChild(h("p", { class: "muted", text: "Nothing here. Deleted entries, shopping items and journal notes wait here for 30 days." }));
      return;
    }

    for (const tombstone of items) {
      const label = tombstone.kind === "experience"
        ? `Journal note for ${findEntry(tombstone.item.productId)?.name || state.data.trash.find((item) => item.id === tombstone.item.productId)?.item.name || "a deleted entry"}`
        : tombstone.item.name;
      container.appendChild(
        h(
          "div",
          { class: "backup-row" },
          h("div", null, h("strong", { text: label }), h("p", { class: "muted", text: `${KIND_LABELS[tombstone.kind]} · deleted ${formatTimestamp(tombstone.deletedAt)}` })),
          h(
            "div",
            { class: "row-buttons" },
            h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => { restoreFromTrash([[tombstone.kind, tombstone.id]]); render(); } }, "Restore"),
            h("button", { type: "button", class: "btn btn-danger-ghost btn-small", onclick: () => { purgeFromTrash([[tombstone.kind, tombstone.id]]); render(); } }, "Delete forever")
          )
        )
      );
    }
  };

  render();
  openDialog({
    title: "Recently deleted",
    wide: true,
    body: h("div", null, h("p", { class: "dialog-note", text: `Kept for ${TRASH_RETENTION_DAYS} days, on every device that syncs.` }), container),
    actions: [{ label: "Close", value: null, variant: "primary" }],
  });
}

const KIND_LABELS = { product: "Entry", wishlist: "Shopping item", experience: "Journal note" };

function purgeFromTrash(pairs) {
  const wanted = new Set(pairs.map(([kind, id]) => `${kind}:${id}`));
  commit((data) => {
    const productIds = new Set(pairs.filter(([kind]) => kind === "product").map(([, id]) => id));
    /* A product gone for good takes its journal with it. */
    data.experiences = data.experiences.filter((item) => !productIds.has(item.productId));
    data.trash = data.trash.filter(
      (item) => !wanted.has(`${item.kind}:${item.id}`) && !(item.kind === "experience" && productIds.has(item.item.productId))
    );
  });
}

/* ── Tag manager ───────────────────────────────────────────────────────── */

function openTagManager() {
  const container = h("div", { class: "tag-list" });

  const render = () => {
    clear(container);
    const tags = allTags();
    if (!tags.length) {
      container.appendChild(h("p", { class: "muted", text: "No tags yet. Add them in an entry's Experience section, comma-separated." }));
      return;
    }

    for (const { label, count } of tags) {
      const input = h("input", { type: "text", value: label, "aria-label": `Rename tag ${label}` });
      container.appendChild(
        h(
          "form",
          {
            class: "tag-row",
            onsubmit: (event) => {
              event.preventDefault();
              renameTag(label, input.value);
              render();
            },
          },
          input,
          h("span", { class: "muted tag-count", text: plural(count, "entry", "entries") }),
          h("button", { type: "submit", class: "btn btn-secondary btn-small" }, "Rename"),
          h("button", { type: "button", class: "btn btn-danger-ghost btn-small", onclick: () => { renameTag(label, ""); render(); } }, "Remove")
        )
      );
    }
  };

  render();
  openDialog({
    title: "Manage tags",
    body: h("div", null, h("p", { class: "dialog-note", text: "Renaming a tag to one that already exists merges them. Removing takes it off every entry." }), container),
    actions: [{ label: "Done", value: null, variant: "primary" }],
  });
}

function renameTag(from, to) {
  const fromKey = tagKey(from);
  const target = Core.cleanText(to, 40);
  const affected = state.data.products.filter((entry) => entry.tags.some((tag) => tagKey(tag) === fromKey));
  if (!affected.length || (target && target === from)) {
    return;
  }

  const now = new Date().toISOString();
  commit((data) => {
    data.products = data.products.map((entry) => {
      if (!entry.tags.some((tag) => tagKey(tag) === fromKey)) {
        return entry;
      }
      const tags = entry.tags.map((tag) => (tagKey(tag) === fromKey ? target : tag)).filter(Boolean);
      return { ...entry, tags: normalizeTags(tags), updatedAt: now };
    });
  });

  prefs.filters.tags = prefs.filters.tags.map((tag) => (tagKey(tag) === fromKey ? target : tag)).filter(Boolean);
  savePrefs();
  showToast(target ? `Renamed “${from}” to “${target}” on ${plural(affected.length, "entry", "entries")}.` : `Removed “${from}” from ${plural(affected.length, "entry", "entries")}.`);
}

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

/* ── Sync status ───────────────────────────────────────────────────────── */

function renderSync() {
  const { label, state: tone, detail } = describeSync();
  elements.syncState.dataset.state = tone;
  elements.syncLabel.textContent = label;
  elements.syncDetail.textContent = detail;
  elements.syncState.title = detail;
  renderBanner();
}

function describeSync() {
  if (!state.storageOk) {
    return { label: "Not saved", state: "error", detail: "This browser refused to store your changes (storage full or blocked). Export a backup." };
  }

  if (!sync.available) {
    return { label: "This browser only", state: "offline", detail: "Saved in this browser. Open the page through serve.py to share it between devices." };
  }

  if (sync.awaitingChoice) {
    return { label: "Needs a decision", state: "error", detail: "This browser and the server disagree. Choose which copy to keep." };
  }

  if (!sync.hydrated) {
    return sync.status === "offline" || sync.status === "error"
      ? { label: "Offline", state: "offline", detail: "Can't reach the server. Changes stay in this browser until it's back." }
      : { label: "Loading", state: "pending", detail: "Fetching the latest copy from the server." };
  }

  if (sync.rejected) {
    return { label: "Not saved", state: "error", detail: `The server rejected the last save: ${sync.lastError}` };
  }

  if (sync.inFlight) {
    return { label: "Saving…", state: "pending", detail: "Sending your changes to the server." };
  }

  if (sync.dirty && sync.status === "offline") {
    return { label: "Offline · pending", state: "offline", detail: "Can't reach the server. Your changes are kept in this browser and will be sent when it's back. Select to retry now." };
  }

  if (sync.dirty && sync.status === "error") {
    return { label: "Not saved · retry", state: "error", detail: `The last save failed (${sync.lastError}). It will retry automatically; select to retry now.` };
  }

  if (sync.dirty) {
    return { label: "Pending", state: "pending", detail: "Changes are about to be sent to the server." };
  }

  if (sync.status === "offline" || sync.status === "error") {
    return { label: "Offline", state: "offline", detail: "Can't reach the server right now. Everything you've done so far is saved." };
  }

  return {
    label: "Saved",
    state: "synced",
    detail: sync.lastSavedAt ? `Saved to the server ${formatTimestamp(sync.lastSavedAt)}.` : "Up to date with the server.",
  };
}

function renderBanner() {
  let message = "";
  let canRetry = false;

  if (!state.storageOk) {
    message = "This browser couldn't store your latest changes. Export a backup now so nothing is lost.";
    canRetry = sync.available && sync.hydrated;
  } else if (sync.legacy && sync.hydrated) {
    message = "The server is still running the old serve.py. Restart it (sudo systemctl restart weed) to turn on conflict protection, snapshots and the journal sync.";
  } else if (sync.rejected) {
    message = `The server refused your last change: ${sync.lastError}. It's kept in this browser.`;
    canRetry = true;
  } else if (sync.dirty && sync.status === "error" && sync.retryDelay >= 8000) {
    message = "Your recent changes haven't reached the server yet. They're kept in this browser and will keep retrying.";
    canRetry = true;
  }

  elements.banner.hidden = !message;
  elements.bannerText.textContent = message;
  elements.bannerRetry.hidden = !canRetry;
}

function handleSyncClick() {
  const { detail } = describeSync();
  if (sync.dirty && (sync.status === "offline" || sync.status === "error" || sync.rejected)) {
    retryNow();
    showToast("Retrying…");
    return;
  }
  showToast(detail);
}

function retryNow() {
  if (!sync.available) {
    return;
  }
  sync.rejected = false;
  sync.retryDelay = 0;
  window.clearTimeout(sync.retryTimer);
  if (!sync.hydrated) {
    hydrate();
  } else {
    poll({ force: true });
  }
}

/* ── Server sync ───────────────────────────────────────────────────────── */

class ServerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function toRemote(payload) {
  const { doc, report } = migrateDoc(payload);
  return {
    doc,
    report,
    exists: payload.exists !== false,
    datasetId: typeof payload.datasetId === "string" ? payload.datasetId : null,
    revision: String(payload.revision ?? ""),
    legacy: payload.schema !== Core.SCHEMA_VERSION,
  };
}

async function fetchState() {
  let response;
  try {
    response = await fetch(SYNC_ENDPOINT, { cache: "no-store" });
  } catch (error) {
    throw new ServerError("the server can't be reached", 0);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new ServerError(payload?.error || `the server answered ${response.status}`, response.status);
  }

  return toRemote(payload);
}

function adoptServerIdentity(remote) {
  sync.revision = remote.revision;
  sync.datasetId = remote.datasetId;
  sync.legacy = remote.legacy;
  sync.hydrated = true;
}

function applyRemote(remote, { announceChange = false } = {}) {
  const changed = !docsEqual(state.data, remote.doc);
  state.data = remote.doc;
  sync.base = clone(remote.doc);
  sync.dirty = false;
  adoptServerIdentity(remote);
  sync.status = "saved";

  /* The server's copy was stored in an older shape or had made-up ids: write
     the normalized version back once so it stays stable. */
  if (remote.report.repaired && !sync.legacy) {
    sync.dirty = true;
    sync.generation += 1;
    scheduleSave();
  }

  saveLocal();
  if (changed) {
    renderAll();
    refreshDrawer();
    if (announceChange) {
      showToast("Updated with changes from another device.");
    }
  } else {
    renderSync();
  }
}

/* Local edits exist that the server hasn't seen, and the server has moved
   on: combine the two against the last copy both agreed on. */
function mergeRemote(base, remote) {
  const { doc, conflicts } = mergeDocs(base, state.data, remote.doc);
  const changedLocally = !docsEqual(doc, state.data);
  state.data = doc;
  sync.base = clone(remote.doc);
  adoptServerIdentity(remote);

  if (docsEqual(doc, remote.doc)) {
    sync.dirty = false;
  } else {
    sync.dirty = true;
    sync.generation += 1;
    scheduleSave(0);
  }

  saveLocal();
  if (changedLocally) {
    renderAll();
    refreshDrawer();
  }

  if (conflicts) {
    showToast(`Merged with changes from another device. ${plural(conflicts, "record was", "records were")} edited in both places; the newer edit was kept.`, { duration: 9000 });
  } else if (changedLocally) {
    showToast("Merged in changes from another device.");
  }
}

async function hydrate() {
  if (!sync.available) {
    sync.status = "local";
    renderSync();
    return;
  }

  if (sync.hydrating || sync.hydrated || sync.awaitingChoice) {
    return;
  }

  sync.hydrating = true;
  renderSync();

  try {
    const remote = await fetchState();
    sync.status = "saved";
    await reconcileInitial(remote);
  } catch (error) {
    if (error.status >= 500 && error.status < 600) {
      /* A broken data file: never write over it. */
      sync.status = "error";
      sync.lastError = error.message;
      showToast(`The server's data file can't be read: ${error.message}. Nothing will be saved to it until it's fixed.`, { duration: 12000 });
    } else {
      sync.status = navigator.onLine === false ? "offline" : "error";
      sync.lastError = error.message;
    }
    scheduleRetry();
  } finally {
    sync.hydrating = false;
    renderSync();
  }
}

/* The first contact with the server decides whose copy wins. A browser that
   has synced with this dataset before just merges its pending edits. A new
   browser holding data the server lacks is asked, because that is exactly
   how deleted data would otherwise come back from the dead. */
async function reconcileInitial(remote) {
  const local = state.data;

  if (!remote.exists && !remote.legacy) {
    if (isEmptyDoc(local)) {
      applyRemote(remote);
    } else {
      /* A brand-new server: this browser's copy becomes the first version. */
      sync.base = emptyDoc();
      adoptServerIdentity(remote);
      sync.dirty = true;
      sync.generation += 1;
      saveLocal();
      scheduleSave(0);
      showToast("Sent this browser's data to the new server.");
    }
    return;
  }

  const sameDataset = remote.legacy ? Boolean(sync.base) : Boolean(sync.datasetId && sync.datasetId === remote.datasetId);

  if (sameDataset) {
    if (sync.dirty) {
      mergeRemote(sync.base, remote);
    } else {
      applyRemote(remote);
    }
    return;
  }

  const localOnly = recordsMissingFrom(local, remote.doc);
  if (isEmptyDoc(local) || !localOnly.length) {
    applyRemote(remote);
    return;
  }

  sync.awaitingChoice = true;
  renderSync();

  const serverEmpty = isEmptyDoc(remote.doc);
  const choice = await openDialog({
    title: "Which copy should be kept?",
    body: h(
      "div",
      null,
      h("p", {
        text: serverEmpty
          ? `The server's collection is empty, but this browser still holds ${countsLabel(local)}. It may have been cleared on purpose from another device.`
          : `This browser has ${plural(localOnly.length, "record")} the server doesn't have. They might be new, or they might have been deleted on another device.`,
      }),
      h("p", { class: "muted", text: `Server: ${countsLabel(remote.doc)}. This browser: ${countsLabel(local)}.` }),
      h(
        "dl",
        { class: "choice-list" },
        h("dt", { text: "Use the server's copy" }),
        h("dd", { text: "This browser's extra records are dropped (a recovery copy is kept in this browser)." }),
        serverEmpty ? null : h("dt", { text: "Keep both" }),
        serverEmpty ? null : h("dd", { text: "Adds this browser's extra records to the server." }),
        h("dt", { text: "Use this browser's copy" }),
        h("dd", { text: "Replaces the server's data. The server keeps a snapshot first." })
      )
    ),
    actions: [
      { label: "Use this browser's copy", value: "local" },
      serverEmpty ? null : { label: "Keep both", value: "merge" },
      { label: "Use the server's copy", value: "remote", variant: "primary" },
    ].filter(Boolean),
    dismissValue: "remote",
  });

  sync.awaitingChoice = false;
  saveRecoveryCopy("before choosing between this browser and the server");

  if (choice === "local") {
    sync.base = clone(remote.doc);
    adoptServerIdentity(remote);
    sync.dirty = true;
    sync.pendingReason = "restore";
    sync.generation += 1;
    saveLocal();
    scheduleSave(0);
  } else if (choice === "merge") {
    sync.base = clone(remote.doc);
    adoptServerIdentity(remote);
    state.data = combineDocs(remote.doc, local);
    sync.dirty = true;
    sync.generation += 1;
    saveLocal();
    renderAll();
    scheduleSave(0);
  } else {
    applyRemote(remote);
  }
}

function recordsMissingFrom(local, remote) {
  const ids = new Set([...remote.products, ...remote.wishlist, ...remote.experiences].map((item) => item.id));
  const trashed = new Set(remote.trash.map((item) => item.id));
  return [...local.products, ...local.wishlist, ...local.experiences].filter((item) => !ids.has(item.id) && !trashed.has(item.id));
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS) {
  if (!sync.available) {
    return;
  }
  window.clearTimeout(sync.saveTimer);
  sync.saveTimer = window.setTimeout(saveToServer, delay);
  renderSync();
}

function scheduleRetry() {
  window.clearTimeout(sync.retryTimer);
  sync.retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, sync.retryDelay * 2));
  sync.retryTimer = window.setTimeout(() => {
    if (!sync.hydrated) {
      hydrate();
    } else {
      poll({ force: true });
    }
  }, sync.retryDelay);
}

async function saveToServer() {
  window.clearTimeout(sync.saveTimer);
  sync.saveTimer = null;

  if (!sync.available || !sync.hydrated || sync.inFlight || !sync.dirty || sync.awaitingChoice || sync.rejected) {
    return;
  }

  const generation = sync.generation;
  const sent = clone(syncable(state.data));
  const reason = sync.pendingReason;
  sync.inFlight = true;
  renderSync();

  let response;
  let payload;
  try {
    response = await fetch(SYNC_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: sync.revision ?? "", datasetId: sync.datasetId, reason, ...sent }),
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    sync.inFlight = false;
    sync.status = navigator.onLine === false ? "offline" : "error";
    sync.lastError = "the server can't be reached";
    scheduleRetry();
    renderSync();
    return;
  }

  sync.inFlight = false;

  if (response.status === 409 && payload?.state) {
    /* Someone else saved first. Merge their version with ours and go again. */
    mergeRemote(sync.base, toRemote(payload.state));
    return;
  }

  if (response.status === 400) {
    sync.rejected = true;
    sync.status = "error";
    sync.lastError = (payload?.problems || [payload?.error || "invalid data"]).slice(0, 3).join("; ");
    renderSync();
    return;
  }

  if (!response.ok || !payload) {
    sync.status = "error";
    sync.lastError = payload?.error || `the server answered ${response.status}`;
    scheduleRetry();
    renderSync();
    return;
  }

  sync.revision = String(payload.revision ?? "");
  sync.datasetId = typeof payload.datasetId === "string" ? payload.datasetId : sync.datasetId;
  sync.legacy = payload.schema !== Core.SCHEMA_VERSION;
  sync.base = sent;
  sync.pendingReason = null;
  sync.status = "saved";
  sync.retryDelay = 0;
  sync.lastSavedAt = Date.now();
  if (sync.generation === generation) {
    sync.dirty = false;
  }

  saveLocal();
  if (sync.dirty) {
    scheduleSave();
  }
}

async function poll({ force = false } = {}) {
  if (!sync.available || sync.awaitingChoice) {
    return;
  }

  if (!sync.hydrated) {
    if (force) hydrate();
    return;
  }

  if (sync.inFlight || poll.running) {
    return;
  }

  poll.running = true;
  const revisionAtStart = sync.revision;

  try {
    const remote = await fetchState();
    const wasDown = sync.status === "offline" || sync.status === "error";
    if (wasDown && !sync.rejected) {
      sync.status = "saved";
      sync.retryDelay = 0;
    }

    /* A save finished while this request was out: its answer is newer. */
    if (sync.inFlight || sync.revision !== revisionAtStart) {
      return;
    }

    if (remote.revision !== sync.revision) {
      if (sync.dirty) {
        mergeRemote(sync.base, remote);
      } else {
        applyRemote(remote, { announceChange: true });
      }
    } else if (sync.dirty && !sync.saveTimer) {
      saveToServer();
    }
  } catch (error) {
    sync.status = navigator.onLine === false ? "offline" : "error";
    sync.lastError = error.message;
    if (sync.dirty) {
      scheduleRetry();
    }
  } finally {
    poll.running = false;
    renderSync();
  }
}

/* Last, so every constant above exists before the first render. */
initialize();
