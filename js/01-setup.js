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
const HIBUDDY_ENDPOINT = "/api/hibuddy";
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
    plainTitle: Boolean(stored.plainTitle),
    blankAway: Boolean(stored.blankAway),
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
  plainTitleToggle: $("#plain-title-toggle"),
  blankAwayToggle: $("#blank-away-toggle"),
  cover: $("#cover"),
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
