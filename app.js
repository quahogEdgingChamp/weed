const STORAGE_KEY = "cloudline-cannabis-log-v1";

/* Server sync: weed_chart.json on the server is the source of truth. Declared
   up here because initialize() runs before the bottom of this file. */
const SYNC_ENDPOINT = "/api/state";
const SYNC_POLL_MS = 5000;

let syncEnabled = false;
let syncRevision = 0;
let syncSaveTimer = null;
let syncInFlight = false;
let syncNeedsSave = false;
let applyingServerState = false;

const state = {
  entries: loadEntries(),
  editingId: null,
  search: "",
  filterType: "all",
  sortBy: "purchaseDate-desc",
};

const elements = {
  form: document.querySelector("#product-form"),
  entryId: document.querySelector("#entry-id"),
  formModeLabel: document.querySelector("#form-mode-label"),
  nameInput: document.querySelector("#name"),
  typeInput: document.querySelector("#type"),
  brandInput: document.querySelector("#brand"),
  strainInput: document.querySelector("#strain"),
  extractionInput: document.querySelector("#extraction"),
  amountInput: document.querySelector("#amount"),
  thcInput: document.querySelector("#thc"),
  cbdInput: document.querySelector("#cbd"),
  terpenePercentInput: document.querySelector("#terpenePercent"),
  purchaseDateInput: document.querySelector("#purchaseDate"),
  priceInput: document.querySelector("#price"),
  ratingInput: document.querySelector("#rating"),
  vendorInput: document.querySelector("#vendor"),
  terpenesInput: document.querySelector("#terpenes"),
  effectsInput: document.querySelector("#effects"),
  notesInput: document.querySelector("#notes"),
  favoriteInput: document.querySelector("#favorite"),
  searchInput: document.querySelector("#search-input"),
  filterType: document.querySelector("#filter-type"),
  sortBy: document.querySelector("#sort-by"),
  entriesBody: document.querySelector("#entries-body"),
  typeBars: document.querySelector("#type-bars"),
  topThcList: document.querySelector("#top-thc-list"),
  statusMessage: document.querySelector("#status-message"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  resetButton: document.querySelector("#reset-button"),
  cancelEditButton: document.querySelector("#cancel-edit-button"),
  emptyRowTemplate: document.querySelector("#empty-row-template"),
  statTotal: document.querySelector("#stat-total"),
  statFavorites: document.querySelector("#stat-favorites"),
  statAverageThc: document.querySelector("#stat-average-thc"),
  statSpend: document.querySelector("#stat-spend"),
};

initialize();

function initialize() {
  elements.form.addEventListener("submit", handleSubmit);
  elements.amountInput.addEventListener("blur", () => {
    elements.amountInput.value = normalizeAmount(elements.amountInput.value);
  });
  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    render();
  });
  elements.filterType.addEventListener("change", (event) => {
    state.filterType = event.target.value;
    render();
  });
  elements.sortBy.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    render();
  });
  elements.exportButton.addEventListener("click", exportEntries);
  elements.importInput.addEventListener("change", importEntries);
  elements.resetButton.addEventListener("click", resetEntries);
  elements.cancelEditButton.addEventListener("click", resetForm);

  render();
  showStatus("Loaded local collection.");

  loadServerState();
  window.setInterval(pollServerState, SYNC_POLL_MS);
}

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && Array.isArray(parsed.products)) {
      return parsed.products;
    }
  } catch (error) {
    console.error("Failed to read saved entries", error);
  }

  return [];
}

function handleSubmit(event) {
  event.preventDefault();

  const formData = new FormData(elements.form);
  const existingEntry = state.entries.find((entry) => entry.id === state.editingId);
  const timestamp = new Date().toISOString();

  const entry = {
    id: state.editingId || crypto.randomUUID(),
    name: readText(formData, "name"),
    type: readText(formData, "type") || "other",
    brand: readText(formData, "brand"),
    strain: readText(formData, "strain"),
    extraction: readText(formData, "extraction"),
    amount: normalizeAmount(readText(formData, "amount")),
    thc: readNumber(formData, "thc"),
    cbd: readNumber(formData, "cbd"),
    terpenePercent: readNumber(formData, "terpenePercent"),
    purchaseDate: readText(formData, "purchaseDate"),
    price: readNumber(formData, "price"),
    rating: readNumber(formData, "rating"),
    vendor: readText(formData, "vendor"),
    terpenes: readText(formData, "terpenes"),
    effects: readText(formData, "effects"),
    notes: readText(formData, "notes"),
    favorite: elements.favoriteInput.checked,
    createdAt: existingEntry?.createdAt || timestamp,
    updatedAt: timestamp,
  };

  if (state.editingId) {
    state.entries = state.entries.map((item) => (item.id === state.editingId ? entry : item));
    showStatus(`Updated ${entry.name}.`);
  } else {
    state.entries = [entry, ...state.entries];
    showStatus(`Saved ${entry.name}.`);
  }

  persistEntries();
  resetForm();
  render();
}

function readText(formData, fieldName) {
  return String(formData.get(fieldName) || "").trim();
}

function readNumber(formData, fieldName) {
  const raw = String(formData.get(fieldName) || "").trim();
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAmount(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (/^\d+(\.\d+)?$/.test(compact)) {
    return `${compact}g`;
  }

  if (/^\d+(\.\d+)?g$/i.test(compact)) {
    return `${compact.slice(0, -1)}g`;
  }

  return trimmed;
}

function persistEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
  queueServerSave();
}

function render() {
  const visibleEntries = getVisibleEntries();
  renderStats(visibleEntries);
  renderTypeBars(visibleEntries);
  renderTopThc(visibleEntries);
  renderTable(visibleEntries);
}

function getVisibleEntries() {
  const filteredEntries = state.entries.filter((entry) => {
    const matchesType = state.filterType === "all" || entry.type === state.filterType;
    if (!matchesType) {
      return false;
    }

    if (!state.search) {
      return true;
    }

    const haystack = [
      entry.name,
      entry.type,
      entry.brand,
      entry.strain,
      entry.extraction,
      entry.vendor,
      entry.terpenePercent,
      entry.terpenes,
      entry.effects,
      entry.notes,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(state.search);
  });

  return filteredEntries.sort(sortEntries);
}

function sortEntries(left, right) {
  switch (state.sortBy) {
    case "purchaseDate-asc":
      return compareDates(left.purchaseDate, right.purchaseDate);
    case "rating-desc":
      return compareNumbers(right.rating, left.rating) || left.name.localeCompare(right.name);
    case "thc-desc":
      return compareNumbers(right.thc, left.thc) || left.name.localeCompare(right.name);
    case "price-desc":
      return compareNumbers(right.price, left.price) || left.name.localeCompare(right.name);
    case "name-asc":
      return left.name.localeCompare(right.name);
    case "purchaseDate-desc":
    default:
      return compareDates(right.purchaseDate, left.purchaseDate) || left.name.localeCompare(right.name);
  }
}

function compareNumbers(left, right) {
  return (left ?? Number.NEGATIVE_INFINITY) - (right ?? Number.NEGATIVE_INFINITY);
}

function compareDates(left, right) {
  return new Date(left || 0).getTime() - new Date(right || 0).getTime();
}

function renderStats(entries) {
  const favorites = entries.filter((entry) => entry.favorite).length;
  const thcEntries = entries.filter((entry) => typeof entry.thc === "number");
  const averageThc = thcEntries.length
    ? thcEntries.reduce((sum, entry) => sum + entry.thc, 0) / thcEntries.length
    : 0;
  const totalSpend = entries.reduce((sum, entry) => sum + (entry.price || 0), 0);

  elements.statTotal.textContent = String(entries.length);
  elements.statFavorites.textContent = String(favorites);
  elements.statAverageThc.textContent = `${averageThc.toFixed(1)}%`;
  elements.statSpend.textContent = formatCurrency(totalSpend);
}

function renderTypeBars(entries) {
  const counts = entries.reduce((accumulator, entry) => {
    accumulator[entry.type] = (accumulator[entry.type] || 0) + 1;
    return accumulator;
  }, {});

  const types = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  const highestCount = types[0]?.[1] || 1;

  elements.typeBars.innerHTML = "";

  if (!types.length) {
    elements.typeBars.innerHTML = '<p class="tagline">Add entries to see type counts.</p>';
    return;
  }

  types.forEach(([type, count]) => {
    const row = document.createElement("div");
    row.className = "type-bar";
    row.innerHTML = `
      <span class="type-bar-label">${capitalize(type)}</span>
      <div class="type-bar-track">
        <div class="type-bar-fill" style="width:${(count / highestCount) * 100}%"></div>
      </div>
      <span class="type-bar-value">${count}</span>
    `;
    elements.typeBars.appendChild(row);
  });
}

function renderTopThc(entries) {
  const topEntries = [...entries]
    .filter((entry) => typeof entry.thc === "number")
    .sort((left, right) => (right.thc || 0) - (left.thc || 0))
    .slice(0, 3);

  elements.topThcList.innerHTML = "";

  if (!topEntries.length) {
    elements.topThcList.innerHTML = "<li>No THC values entered yet.</li>";
    return;
  }

  topEntries.forEach((entry) => {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${escapeHtml(entry.name)}</strong> <span>${entry.thc.toFixed(1)}% THC</span>`;
    elements.topThcList.appendChild(item);
  });
}

function renderTable(entries) {
  elements.entriesBody.innerHTML = "";

  if (!entries.length) {
    const emptyRow = elements.emptyRowTemplate.content.cloneNode(true);
    elements.entriesBody.appendChild(emptyRow);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <div class="entry-name">
          <strong>${escapeHtml(entry.name)}</strong>
          <small>${escapeHtml(compactDetails(entry))}</small>
          ${entry.favorite ? '<span class="favorite-badge">Favorite</span>' : ""}
        </div>
      </td>
      <td>${escapeHtml(capitalize(entry.type))}</td>
      <td>${escapeHtml(entry.brand || "-")}</td>
      <td>${formatPercent(entry.thc)}</td>
      <td>${formatCurrency(entry.price)}</td>
      <td>${formatRating(entry.rating)}</td>
      <td>${escapeHtml(formatTerpeneCell(entry))}</td>
      <td class="actions-cell"></td>
    `;

    const actionsCell = row.querySelector(".actions-cell");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "row-button";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => startEdit(entry.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "row-button danger";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deleteEntry(entry.id));

    actionsCell.append(editButton, deleteButton);
    elements.entriesBody.appendChild(row);
  });
}

function compactDetails(entry) {
  return [entry.strain, entry.extraction, entry.amount].filter(Boolean).join(" | ") || "No extra details";
}

function startEdit(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) {
    return;
  }

  state.editingId = entry.id;
  elements.entryId.value = entry.id;
  elements.formModeLabel.textContent = `Editing ${entry.name}`;

  elements.nameInput.value = entry.name || "";
  elements.typeInput.value = entry.type || "other";
  elements.brandInput.value = entry.brand || "";
  elements.strainInput.value = entry.strain || "";
  elements.extractionInput.value = entry.extraction || "";
  elements.amountInput.value = entry.amount || "";
  elements.thcInput.value = entry.thc ?? "";
  elements.cbdInput.value = entry.cbd ?? "";
  elements.terpenePercentInput.value = entry.terpenePercent ?? "";
  elements.purchaseDateInput.value = entry.purchaseDate || "";
  elements.priceInput.value = entry.price ?? "";
  elements.ratingInput.value = entry.rating ?? "";
  elements.vendorInput.value = entry.vendor || "";
  elements.terpenesInput.value = entry.terpenes || "";
  elements.effectsInput.value = entry.effects || "";
  elements.notesInput.value = entry.notes || "";
  elements.favoriteInput.checked = Boolean(entry.favorite);

  elements.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetForm() {
  state.editingId = null;
  elements.form.reset();
  elements.entryId.value = "";
  elements.formModeLabel.textContent = "Creating a new record";
}

function deleteEntry(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) {
    return;
  }

  const confirmed = window.confirm(`Delete "${entry.name}"?`);
  if (!confirmed) {
    return;
  }

  state.entries = state.entries.filter((item) => item.id !== entryId);
  persistEntries();

  if (state.editingId === entryId) {
    resetForm();
  }

  render();
  showStatus(`Deleted ${entry.name}.`);
}

function exportEntries() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    products: state.entries,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "weed_chart.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  showStatus("Exported JSON backup.");
}

async function importEntries(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const importedEntries = Array.isArray(parsed) ? parsed : parsed.products;

    if (!Array.isArray(importedEntries)) {
      throw new Error("Expected a JSON array or a { products: [] } object.");
    }

    state.entries = importedEntries
      .filter(Boolean)
      .map((entry) => ({
        id: entry.id || crypto.randomUUID(),
        name: entry.name || "Untitled product",
        type: entry.type || "other",
        brand: entry.brand || "",
        strain: entry.strain || "",
        extraction: entry.extraction || "",
        amount: normalizeAmount(entry.amount || ""),
        thc: typeof entry.thc === "number" ? entry.thc : toNumber(entry.thc),
        cbd: typeof entry.cbd === "number" ? entry.cbd : toNumber(entry.cbd),
        terpenePercent:
          typeof entry.terpenePercent === "number"
            ? entry.terpenePercent
            : toNumber(entry.terpenePercent),
        purchaseDate: entry.purchaseDate || "",
        price: typeof entry.price === "number" ? entry.price : toNumber(entry.price),
        rating: typeof entry.rating === "number" ? entry.rating : toNumber(entry.rating),
        vendor: entry.vendor || "",
        terpenes: entry.terpenes || "",
        effects: entry.effects || "",
        notes: entry.notes || "",
        favorite: Boolean(entry.favorite),
        createdAt: entry.createdAt || new Date().toISOString(),
        updatedAt: entry.updatedAt || new Date().toISOString(),
      }));

    persistEntries();
    resetForm();
    render();
    showStatus(`Imported ${state.entries.length} entries.`);
  } catch (error) {
    console.error(error);
    window.alert(`Import failed: ${error.message}`);
  } finally {
    event.target.value = "";
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetEntries() {
  const confirmed = window.confirm(
    "Clear all local entries from this browser? Export JSON first if you want a backup."
  );
  if (!confirmed) {
    return;
  }

  state.entries = [];
  persistEntries();
  resetForm();
  render();
  showStatus("Cleared local browser data.");
}

function showStatus(message) {
  elements.statusMessage.textContent = message;

  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    if (elements.statusMessage.textContent === message) {
      elements.statusMessage.textContent = "";
    }
  }, 2600);
}

function formatPercent(value) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "-";
}

function formatCurrency(value) {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
    : "-";
}

function formatRating(value) {
  return typeof value === "number" ? `${value.toFixed(1)}/10` : "-";
}

function formatTerpeneCell(entry) {
  const parts = [];

  if (typeof entry.terpenePercent === "number") {
    parts.push(`Total ${entry.terpenePercent.toFixed(1)}%`);
  }

  if (entry.terpenes) {
    parts.push(entry.terpenes);
  }

  return parts.join(" | ") || "-";
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "-";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* ---- server sync ---------------------------------------------------------
   The server stores entries in weed_chart.json and reports the file's mtime as
   its revision, so editing that file by hand is noticed here within a few
   seconds. Opened as a plain file:// page, or on a host with no backend, every
   function below no-ops and the app behaves exactly as it did before:
   localStorage only.
--------------------------------------------------------------------------- */

function canSync() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function readSyncResponse(response) {
  if (!response.ok) {
    throw new Error(`sync failed: ${response.status}`);
  }

  return response.json();
}

function applyServerState(payload, message) {
  applyingServerState = true;
  state.entries = Array.isArray(payload.products) ? payload.products : [];
  syncRevision = payload.revision || 0;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
  applyingServerState = false;

  resetForm();
  render();
  showStatus(message);
}

function loadServerState() {
  if (!canSync()) {
    return;
  }

  fetch(SYNC_ENDPOINT, { cache: "no-store" })
    .then(readSyncResponse)
    .then((payload) => {
      syncEnabled = true;

      const serverIsEmpty = !Array.isArray(payload.products) || payload.products.length === 0;
      if (serverIsEmpty && state.entries.length > 0) {
        syncRevision = payload.revision || 0;
        queueServerSave();
        showStatus("Sent this browser's collection to the server.");
        return;
      }

      applyServerState(payload, `Loaded ${payload.products.length} entries from server.`);
    })
    .catch(() => {
      syncEnabled = false;
      showStatus("Local only - server unreachable.");
    });
}

function pollServerState() {
  if (!syncEnabled || syncInFlight || state.editingId) {
    return;
  }

  fetch(SYNC_ENDPOINT, { cache: "no-store" })
    .then(readSyncResponse)
    .then((payload) => {
      if ((payload.revision || 0) > syncRevision) {
        applyServerState(payload, "Updated from weed_chart.json.");
      }
    })
    .catch(() => {
      syncEnabled = false;
      showStatus("Sync paused - server unreachable.");
    });
}

function queueServerSave() {
  if (!syncEnabled || applyingServerState) {
    return;
  }

  window.clearTimeout(syncSaveTimer);
  syncSaveTimer = window.setTimeout(saveServerState, 300);
}

function saveServerState() {
  if (!syncEnabled || applyingServerState) {
    return;
  }

  if (syncInFlight) {
    syncNeedsSave = true;
    return;
  }

  syncInFlight = true;

  fetch(SYNC_ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ products: state.entries }),
  })
    .then(readSyncResponse)
    .then((payload) => {
      syncRevision = payload.revision || syncRevision;
      showStatus("Saved to server.");
    })
    .catch(() => {
      showStatus("Not saved to server.");
    })
    .finally(() => {
      syncInFlight = false;

      if (syncNeedsSave) {
        syncNeedsSave = false;
        saveServerState();
      }
    });
}
