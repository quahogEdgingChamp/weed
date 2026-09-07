/* ---------------------------------------------------------------------------
   Cloudline - a personal product log plus an OCS-backed shopping list.

   Two stores, kept in step: localStorage so the page works offline and from
   file://, and weed_chart.json on the server so every device sees the same
   collection. The server is authoritative whenever it answers.
--------------------------------------------------------------------------- */

const ENTRIES_KEY = "cloudline-cannabis-log-v1";
const WISHLIST_KEY = "cloudline-shopping-list-v1";

const SYNC_ENDPOINT = "/api/state";
const LOOKUP_ENDPOINT = "/api/lookup";
const SYNC_POLL_MS = 5000;

const TYPE_LABELS = {
  cart: "Cart",
  disposable: "Disposable",
  concentrate: "Concentrate",
  flower: "Flower",
  edible: "Edible",
  tincture: "Tincture",
  other: "Other",
};

let syncEnabled = false;
let syncRevision = 0;
let syncSaveTimer = null;
let syncInFlight = false;
let syncNeedsSave = false;
let applyingServerState = false;
let lookupInFlight = false;

const state = {
  entries: readStore(ENTRIES_KEY),
  wishlist: readStore(WISHLIST_KEY),
  view: "collection",
  editingId: null,
  /* Set while the drawer is filled from a shopping-list item: saving the entry
     then takes that item off the list. */
  sourceWishId: null,
  search: "",
  filterType: "all",
  sortBy: "purchaseDate-desc",
};

const elements = {
  tabs: document.querySelectorAll(".tab"),
  views: {
    collection: document.querySelector("#view-collection"),
    shopping: document.querySelector("#view-shopping"),
  },
  tabCounts: {
    collection: document.querySelector("#tab-count-collection"),
    shopping: document.querySelector("#tab-count-shopping"),
  },

  menuButton: document.querySelector("#menu-button"),
  menuPanel: document.querySelector("#menu-panel"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  resetButton: document.querySelector("#reset-button"),

  syncState: document.querySelector("#sync-state"),
  syncLabel: document.querySelector("#sync-label"),
  toast: document.querySelector("#toast"),

  searchInput: document.querySelector("#search-input"),
  filterType: document.querySelector("#filter-type"),
  sortBy: document.querySelector("#sort-by"),
  addEntryButton: document.querySelector("#add-entry-button"),

  statTotal: document.querySelector("#stat-total"),
  statFavorites: document.querySelector("#stat-favorites"),
  statAverageThc: document.querySelector("#stat-average-thc"),
  statSpend: document.querySelector("#stat-spend"),
  typeBars: document.querySelector("#type-bars"),
  topThcList: document.querySelector("#top-thc-list"),
  entriesBody: document.querySelector("#entries-body"),
  emptyRowTemplate: document.querySelector("#empty-row-template"),

  linkForm: document.querySelector("#link-form"),
  linkInput: document.querySelector("#link-input"),
  linkSubmit: document.querySelector("#link-submit"),
  linkStatus: document.querySelector("#link-status"),
  manualForm: document.querySelector("#manual-form"),
  manualName: document.querySelector("#manual-name"),
  manualBrand: document.querySelector("#manual-brand"),
  manualPrice: document.querySelector("#manual-price"),
  wishlist: document.querySelector("#wishlist"),
  wishCount: document.querySelector("#wish-count"),
  wishTotal: document.querySelector("#wish-total"),

  scrim: document.querySelector("#scrim"),
  drawer: document.querySelector("#drawer"),
  drawerTitle: document.querySelector("#drawer-title"),
  drawerSubtitle: document.querySelector("#drawer-subtitle"),
  drawerClose: document.querySelector("#drawer-close"),
  drawerCancel: document.querySelector("#drawer-cancel"),
  form: document.querySelector("#product-form"),
  entryId: document.querySelector("#entry-id"),
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
};

initialize();

function initialize() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });

  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderCollection();
  });
  elements.filterType.addEventListener("change", (event) => {
    state.filterType = event.target.value;
    renderCollection();
  });
  elements.sortBy.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    renderCollection();
  });

  elements.addEntryButton.addEventListener("click", () => openDrawer());
  elements.form.addEventListener("submit", handleSubmit);
  elements.amountInput.addEventListener("blur", () => {
    elements.amountInput.value = normalizeAmount(elements.amountInput.value);
  });
  elements.drawerClose.addEventListener("click", closeDrawer);
  elements.drawerCancel.addEventListener("click", closeDrawer);
  elements.scrim.addEventListener("click", closeDrawer);

  elements.linkForm.addEventListener("submit", handleLinkLookup);
  elements.manualForm.addEventListener("submit", handleManualAdd);

  elements.exportButton.addEventListener("click", exportData);
  elements.importInput.addEventListener("change", importData);
  elements.resetButton.addEventListener("click", resetData);
  elements.menuButton.addEventListener("click", toggleMenu);

  document.addEventListener("keydown", handleGlobalKeys);
  document.addEventListener("click", closeMenuOnOutsideClick);

  render();

  loadServerState();
  window.setInterval(pollServerState, SYNC_POLL_MS);
}

/* ── Views ─────────────────────────────────────────────────────────────── */

function showView(view) {
  state.view = view;

  Object.entries(elements.views).forEach(([name, section]) => {
    section.hidden = name !== view;
  });

  elements.tabs.forEach((tab) => {
    if (tab.dataset.view === view) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  });

  window.scrollTo({ top: 0, behavior: "instant" });
}

function render() {
  renderCollection();
  renderWishlist();
  elements.tabCounts.collection.textContent = String(state.entries.length);
  elements.tabCounts.shopping.textContent = String(state.wishlist.length);
}

/* ── Collection ────────────────────────────────────────────────────────── */

function renderCollection() {
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
      return compareNumbers(right.rating, left.rating) || compareNames(left, right);
    case "thc-desc":
      return compareNumbers(right.thc, left.thc) || compareNames(left, right);
    case "price-desc":
      return compareNumbers(right.price, left.price) || compareNames(left, right);
    case "name-asc":
      return compareNames(left, right);
    case "purchaseDate-desc":
    default:
      return compareDates(right.purchaseDate, left.purchaseDate) || compareNames(left, right);
  }
}

function compareNames(left, right) {
  return String(left.name || "").localeCompare(String(right.name || ""));
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
    : null;
  const spend = entries.reduce((sum, entry) => sum + (entry.price || 0), 0);

  elements.statTotal.textContent = String(entries.length);
  elements.statFavorites.textContent = String(favorites);
  elements.statAverageThc.textContent = averageThc === null ? "—" : `${averageThc.toFixed(1)}%`;
  elements.statSpend.textContent = entries.length ? formatCurrency(spend) : "—";
}

function renderTypeBars(entries) {
  const counts = entries.reduce((accumulator, entry) => {
    accumulator[entry.type] = (accumulator[entry.type] || 0) + 1;
    return accumulator;
  }, {});

  const types = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  elements.typeBars.innerHTML = "";

  if (!types.length) {
    elements.typeBars.innerHTML = '<p class="panel-empty">Nothing to count yet.</p>';
    return;
  }

  /* One measure across nominal categories, so every bar wears the same hue and
     the value rides the tip of the bar. */
  const highestCount = types[0][1];

  types.forEach(([type, count]) => {
    const row = document.createElement("div");
    row.className = "bar";
    row.innerHTML = `
      <span class="bar-label">${escapeHtml(typeLabel(type))}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${(count / highestCount) * 100}%"></div>
      </div>
      <span class="bar-value">${count}</span>
    `;
    row.title = `${typeLabel(type)}: ${count} ${count === 1 ? "entry" : "entries"}`;
    elements.typeBars.appendChild(row);
  });
}

function renderTopThc(entries) {
  const topEntries = entries
    .filter((entry) => typeof entry.thc === "number")
    .sort((left, right) => right.thc - left.thc)
    .slice(0, 3);

  elements.topThcList.innerHTML = "";

  if (!topEntries.length) {
    elements.topThcList.innerHTML = '<li class="panel-empty">No THC values recorded yet.</li>';
    return;
  }

  topEntries.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = "rank";
    item.innerHTML = `
      <span class="rank-index">${index + 1}</span>
      <span class="rank-name">${escapeHtml(entry.name)}</span>
      <span class="rank-value">${entry.thc.toFixed(1)}%</span>
    `;
    elements.topThcList.appendChild(item);
  });
}

function renderTable(entries) {
  elements.entriesBody.innerHTML = "";

  if (!entries.length) {
    elements.entriesBody.appendChild(elements.emptyRowTemplate.content.cloneNode(true));
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="cell-name">
        <strong>${escapeHtml(entry.name)}</strong>
        <span class="cell-sub">${escapeHtml(subtitleFor(entry))}</span>
      </td>
      <td data-label="Type">${escapeHtml(typeLabel(entry.type))}</td>
      <td class="num" data-label="THC">${formatPercent(entry.thc)}</td>
      <td class="num" data-label="CBD">${formatPercent(entry.cbd)}</td>
      <td class="num" data-label="Price">${formatCurrency(entry.price)}</td>
      <td class="num" data-label="Rating">${formatRating(entry.rating)}</td>
      <td class="cell-terpenes" data-label="Terpenes">${escapeHtml(terpeneSummary(entry))}</td>
      <td class="row-actions"></td>
    `;

    const actions = row.querySelector(".row-actions");
    actions.append(
      iconButton("i-star", entry.favorite ? "Remove favorite" : "Mark favorite", () => toggleFavorite(entry.id), {
        active: Boolean(entry.favorite),
      }),
      iconButton("i-pencil", `Edit ${entry.name}`, () => startEdit(entry.id)),
      iconButton("i-trash", `Delete ${entry.name}`, () => deleteEntry(entry.id), { danger: true })
    );

    elements.entriesBody.appendChild(row);
  });
}

function subtitleFor(entry) {
  const details = [entry.brand, entry.strain, entry.extraction, entry.amount].filter(Boolean);
  return details.join(" · ") || "No extra details";
}

function terpeneSummary(entry) {
  const parts = [];

  if (typeof entry.terpenePercent === "number") {
    parts.push(`${entry.terpenePercent.toFixed(1)}% total`);
  }

  if (entry.terpenes) {
    parts.push(entry.terpenes);
  }

  return parts.join(" · ") || "—";
}

function iconButton(symbol, label, onClick, { danger = false, active = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button${danger ? " is-danger" : ""}${active ? " is-on" : ""}`;
  button.title = label;
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${symbol}" /></svg>`;

  const name = document.createElement("span");
  name.className = "sr-only";
  name.textContent = label;
  button.appendChild(name);

  button.addEventListener("click", onClick);
  return button;
}

/* ── Entry drawer ──────────────────────────────────────────────────────── */

function openDrawer({ title = "Add entry", subtitle = "New record in your collection" } = {}) {
  elements.drawerTitle.textContent = title;
  elements.drawerSubtitle.textContent = subtitle;
  elements.drawer.hidden = false;
  elements.scrim.hidden = false;
  document.body.style.overflow = "hidden";
  elements.nameInput.focus({ preventScroll: true });
}

function closeDrawer() {
  elements.drawer.hidden = true;
  elements.scrim.hidden = true;
  document.body.style.overflow = "";
  resetForm();
}

function resetForm() {
  state.editingId = null;
  state.sourceWishId = null;
  elements.form.reset();
  elements.entryId.value = "";
}

function startEdit(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) {
    return;
  }

  resetForm();
  state.editingId = entry.id;
  elements.entryId.value = entry.id;
  fillForm(entry);
  openDrawer({ title: "Edit entry", subtitle: entry.name });
}

function fillForm(values) {
  elements.nameInput.value = values.name || "";
  elements.typeInput.value = values.type || "other";
  elements.brandInput.value = values.brand || "";
  elements.strainInput.value = values.strain || "";
  elements.extractionInput.value = values.extraction || "";
  elements.amountInput.value = values.amount || "";
  elements.thcInput.value = values.thc ?? "";
  elements.cbdInput.value = values.cbd ?? "";
  elements.terpenePercentInput.value = values.terpenePercent ?? "";
  elements.purchaseDateInput.value = values.purchaseDate || "";
  elements.priceInput.value = values.price ?? "";
  elements.ratingInput.value = values.rating ?? "";
  elements.vendorInput.value = values.vendor || "";
  elements.terpenesInput.value = values.terpenes || "";
  elements.effectsInput.value = values.effects || "";
  elements.notesInput.value = values.notes || "";
  elements.favoriteInput.checked = Boolean(values.favorite);
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
    sourceUrl: existingEntry?.sourceUrl || "",
    createdAt: existingEntry?.createdAt || timestamp,
    updatedAt: timestamp,
  };

  const wasEdit = Boolean(state.editingId);
  if (wasEdit) {
    state.entries = state.entries.map((item) => (item.id === state.editingId ? entry : item));
  } else {
    state.entries = [entry, ...state.entries];
  }

  /* Logging a purchase retires the shopping-list item it came from. */
  const boughtId = state.sourceWishId;
  if (boughtId) {
    const bought = state.wishlist.find((item) => item.id === boughtId);
    entry.sourceUrl = bought?.url || entry.sourceUrl;
    state.wishlist = state.wishlist.filter((item) => item.id !== boughtId);
  }

  persist();
  closeDrawer();
  render();
  showToast(wasEdit ? `Updated ${entry.name}.` : `Saved ${entry.name}.`);
}

function toggleFavorite(entryId) {
  state.entries = state.entries.map((entry) =>
    entry.id === entryId
      ? { ...entry, favorite: !entry.favorite, updatedAt: new Date().toISOString() }
      : entry
  );

  persist();
  renderCollection();
}

function deleteEntry(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry || !window.confirm(`Delete "${entry.name}"?`)) {
    return;
  }

  state.entries = state.entries.filter((item) => item.id !== entryId);
  persist();

  if (state.editingId === entryId) {
    closeDrawer();
  }

  render();
  showToast(`Deleted ${entry.name}.`);
}

/* ── Shopping list ─────────────────────────────────────────────────────── */

async function handleLinkLookup(event) {
  event.preventDefault();

  const url = elements.linkInput.value.trim();
  if (!url || lookupInFlight) {
    return;
  }

  if (!canSync()) {
    setLinkStatus("Link lookup needs the local server: run python3 serve.py, then open the address it prints.", "error");
    return;
  }

  lookupInFlight = true;
  elements.linkSubmit.disabled = true;
  setLinkStatus("Looking up…");

  try {
    const response = await fetch(`${LOOKUP_ENDPOINT}?url=${encodeURIComponent(url)}`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setLinkStatus(payload.error || `Lookup failed (${response.status}).`, "error");
      return;
    }

    addWishlistItem(toWishlistItem(payload.item));
    elements.linkInput.value = "";
    setLinkStatus(`Added ${payload.item.name}.`, "ok");
  } catch (error) {
    console.error(error);
    setLinkStatus("Could not reach the server.", "error");
  } finally {
    lookupInFlight = false;
    elements.linkSubmit.disabled = false;
  }
}

function handleManualAdd(event) {
  event.preventDefault();

  const name = elements.manualName.value.trim();
  if (!name) {
    return;
  }

  addWishlistItem({
    id: crypto.randomUUID(),
    name,
    brand: elements.manualBrand.value.trim(),
    price: toNumber(elements.manualPrice.value),
    addedAt: new Date().toISOString(),
  });

  elements.manualForm.reset();
  setLinkStatus(`Added ${name}.`, "ok");
}

function toWishlistItem(item) {
  return {
    ...item,
    id: crypto.randomUUID(),
    addedAt: new Date().toISOString(),
  };
}

function addWishlistItem(item) {
  state.wishlist = [item, ...state.wishlist];
  persist();
  render();
}

function removeWishlistItem(itemId) {
  state.wishlist = state.wishlist.filter((item) => item.id !== itemId);
  persist();
  render();
}

/* Move a shopping-list item into the collection: the drawer opens prefilled so
   the price paid and a rating can be corrected before saving. */
function logPurchase(itemId) {
  const item = state.wishlist.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  resetForm();
  state.sourceWishId = item.id;

  fillForm({
    name: item.name,
    type: item.type || "other",
    brand: item.brand,
    strain: item.strain,
    extraction: item.extraction,
    amount: item.amount,
    thc: item.thc,
    cbd: item.cbd,
    price: item.price,
    vendor: "OCS",
    purchaseDate: today(),
    terpenes: (item.terpenes || []).join(", "),
    notes: purchaseNotes(item),
  });

  openDrawer({ title: "Log purchase", subtitle: `From your shopping list · ${item.name}` });
}

function purchaseNotes(item) {
  const facts = [];

  if (item.genetics) {
    facts.push(`Genetics: ${item.genetics}`);
  }

  const thcRange = formatRange(item.thcMin, item.thcMax);
  if (thcRange) {
    facts.push(`THC ${thcRange}`);
  }

  const cbdRange = formatRange(item.cbdMin, item.cbdMax);
  if (cbdRange) {
    facts.push(`CBD ${cbdRange}`);
  }

  if (item.process) {
    facts.push(`Extraction: ${item.process}`);
  }

  if (item.producer) {
    facts.push(`Producer: ${item.producer}`);
  }

  return facts.join(". ");
}

function renderWishlist() {
  elements.wishlist.innerHTML = "";

  const total = state.wishlist.reduce((sum, item) => sum + (item.price || 0), 0);
  elements.wishCount.textContent = state.wishlist.length
    ? `${state.wishlist.length} ${state.wishlist.length === 1 ? "item" : "items"}`
    : "Nothing on the list";
  elements.wishTotal.textContent = total ? `${formatCurrency(total)} estimated` : "";

  if (!state.wishlist.length) {
    const empty = document.createElement("li");
    empty.className = "wish-empty";
    empty.textContent = "Paste an ocs.ca product link above to start the list.";
    elements.wishlist.appendChild(empty);
    return;
  }

  state.wishlist.forEach((item) => elements.wishlist.appendChild(wishlistCard(item)));
}

function wishlistCard(item) {
  const card = document.createElement("li");
  card.className = "wish";

  const head = document.createElement("div");
  head.className = "wish-head";

  if (item.image) {
    const thumb = document.createElement("img");
    thumb.className = "wish-thumb";
    thumb.src = item.image;
    thumb.alt = "";
    thumb.loading = "lazy";
    head.appendChild(thumb);
  } else {
    head.style.gridTemplateColumns = "minmax(0, 1fr)";
  }

  const heading = document.createElement("div");
  heading.innerHTML = `
    <p class="wish-name">${escapeHtml(item.name)}</p>
    <p class="wish-brand">${escapeHtml(wishSubtitle(item))}</p>
  `;
  head.appendChild(heading);
  card.appendChild(head);

  const body = document.createElement("div");
  body.appendChild(chipRow(item));

  if (item.terpenes?.length) {
    const terpenes = document.createElement("p");
    terpenes.className = "wish-terpenes";
    terpenes.textContent = item.terpenes.join(" · ");
    body.appendChild(terpenes);
  }

  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "wish-foot";

  const price = document.createElement("p");
  price.className = "wish-price";
  price.innerHTML = item.price
    ? `${escapeHtml(formatCurrency(item.price))}<small>CAD</small>`
    : '<span class="muted">No price</span>';
  foot.appendChild(price);

  foot.append(
    iconButton("i-trash", `Remove ${item.name}`, () => removeWishlistItem(item.id), { danger: true })
  );

  if (item.url) {
    const link = document.createElement("a");
    link.className = "wish-link";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Open on ocs.ca";
    link.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-external" /></svg>';
    link.appendChild(srOnly("Open on ocs.ca"));
    foot.appendChild(link);
  }

  const logButton = document.createElement("button");
  logButton.type = "button";
  logButton.className = "btn btn-secondary";
  logButton.textContent = "Log it";
  logButton.addEventListener("click", () => logPurchase(item.id));
  foot.appendChild(logButton);

  card.appendChild(foot);
  return card;
}

function wishSubtitle(item) {
  return [item.brand, item.amount, item.strain].filter(Boolean).join(" · ") || "Added by hand";
}

function chipRow(item) {
  const row = document.createElement("div");
  row.className = "wish-chips";

  const thcRange = formatRange(item.thcMin, item.thcMax);
  if (thcRange) {
    row.appendChild(chip(`THC ${thcRange}`, "chip-accent"));
  }

  const cbdRange = formatRange(item.cbdMin, item.cbdMax);
  if (cbdRange) {
    row.appendChild(chip(`CBD ${cbdRange}`));
  }

  if (item.type) {
    row.appendChild(chip(typeLabel(item.type)));
  }

  if (item.extraction) {
    row.appendChild(chip(item.extraction));
  }

  if (item.url && item.available === false) {
    row.appendChild(chip("Out of stock", "wish-out"));
  }

  return row;
}

function chip(text, extraClass = "") {
  const span = document.createElement("span");
  span.className = `chip ${extraClass}`.trim();
  span.textContent = text;
  return span;
}

function srOnly(text) {
  const span = document.createElement("span");
  span.className = "sr-only";
  span.textContent = text;
  return span;
}

function setLinkStatus(message, tone = "") {
  elements.linkStatus.textContent = message;
  elements.linkStatus.dataset.tone = tone;
}

/* ── Data menu ─────────────────────────────────────────────────────────── */

function toggleMenu(event) {
  event.stopPropagation();
  const open = elements.menuPanel.hidden;
  elements.menuPanel.hidden = !open;
  elements.menuButton.setAttribute("aria-expanded", String(open));
}

function closeMenu() {
  elements.menuPanel.hidden = true;
  elements.menuButton.setAttribute("aria-expanded", "false");
}

function closeMenuOnOutsideClick(event) {
  if (!elements.menuPanel.hidden && !event.target.closest(".menu")) {
    closeMenu();
  }
}

function handleGlobalKeys(event) {
  if (event.key !== "Escape") {
    return;
  }

  if (!elements.menuPanel.hidden) {
    closeMenu();
    return;
  }

  if (!elements.drawer.hidden) {
    closeDrawer();
  }
}

function exportData() {
  closeMenu();

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    products: state.entries,
    wishlist: state.wishlist,
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

  showToast("Exported weed_chart.json.");
}

async function importData(event) {
  closeMenu();

  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const parsed = JSON.parse(await file.text());
    const products = Array.isArray(parsed) ? parsed : parsed.products;

    if (!Array.isArray(products)) {
      throw new Error("Expected a JSON array or a { products: [] } object.");
    }

    state.entries = products.filter(Boolean).map(normalizeEntry);
    state.wishlist = Array.isArray(parsed.wishlist) ? parsed.wishlist.filter(Boolean) : [];

    persist();
    closeDrawer();
    render();
    showToast(`Imported ${state.entries.length} entries.`);
  } catch (error) {
    console.error(error);
    window.alert(`Import failed: ${error.message}`);
  } finally {
    event.target.value = "";
  }
}

function normalizeEntry(entry) {
  const timestamp = new Date().toISOString();

  return {
    id: entry.id || crypto.randomUUID(),
    name: entry.name || "Untitled product",
    type: entry.type || "other",
    brand: entry.brand || "",
    strain: entry.strain || "",
    extraction: entry.extraction || "",
    amount: normalizeAmount(entry.amount || ""),
    thc: toNumber(entry.thc),
    cbd: toNumber(entry.cbd),
    terpenePercent: toNumber(entry.terpenePercent),
    purchaseDate: entry.purchaseDate || "",
    price: toNumber(entry.price),
    rating: toNumber(entry.rating),
    vendor: entry.vendor || "",
    terpenes: entry.terpenes || "",
    effects: entry.effects || "",
    notes: entry.notes || "",
    favorite: Boolean(entry.favorite),
    sourceUrl: entry.sourceUrl || "",
    createdAt: entry.createdAt || timestamp,
    updatedAt: entry.updatedAt || timestamp,
  };
}

function resetData() {
  closeMenu();

  const confirmed = window.confirm(
    "Clear the collection and the shopping list from this browser? Export first if you want a backup."
  );
  if (!confirmed) {
    return;
  }

  state.entries = [];
  state.wishlist = [];
  persist();
  closeDrawer();
  render();
  showToast("Cleared local data.");
}

/* ── Storage & formatting ──────────────────────────────────────────────── */

function readStore(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && Array.isArray(parsed.products)) {
      return parsed.products;
    }
  } catch (error) {
    console.error(`Failed to read ${key}`, error);
  }

  return [];
}

function persist() {
  writeLocal();
  queueServerSave();
}

function writeLocal() {
  try {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(state.entries));
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(state.wishlist));
  } catch (error) {
    console.error("Failed to save locally", error);
  }
}

function readText(formData, fieldName) {
  return String(formData.get(fieldName) || "").trim();
}

function readNumber(formData, fieldName) {
  return toNumber(formData.get(fieldName));
}

function toNumber(value) {
  const raw = String(value ?? "").trim();
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
  if (/^\d+(\.\d+)?g?$/i.test(compact)) {
    return `${compact.replace(/g$/i, "")}g`;
  }

  return trimmed;
}

function today() {
  return new Date().toLocaleDateString("en-CA");
}

function typeLabel(type) {
  return TYPE_LABELS[type] || "Other";
}

function formatPercent(value) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "—";
}

function formatRange(low, high) {
  if (typeof low !== "number" || typeof high !== "number") {
    return "";
  }

  return low === high ? `${trimZero(low)}%` : `${trimZero(low)}–${trimZero(high)}%`;
}

function trimZero(value) {
  return String(Number(value.toFixed(1)));
}

function formatCurrency(value) {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value)
    : "—";
}

function formatRating(value) {
  return typeof value === "number" ? `${value.toFixed(1)}` : "—";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;

  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

function setSyncState(stateName, label, title) {
  elements.syncState.dataset.state = stateName;
  elements.syncState.title = title;
  elements.syncLabel.textContent = label;
}

/* ── Server sync ───────────────────────────────────────────────────────────
   The server stores everything in weed_chart.json and reports the file's mtime
   as its revision, so editing that file by hand is noticed here within a few
   seconds. Opened as a file:// page, or on a host with no backend, every
   function below no-ops and the app runs on localStorage alone.
------------------------------------------------------------------------- */

function canSync() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function readSyncResponse(response) {
  if (!response.ok) {
    throw new Error(`sync failed: ${response.status}`);
  }

  return response.json();
}

function applyServerState(payload) {
  applyingServerState = true;
  state.entries = Array.isArray(payload.products) ? payload.products : [];
  state.wishlist = Array.isArray(payload.wishlist) ? payload.wishlist : [];
  syncRevision = payload.revision || 0;
  writeLocal();
  applyingServerState = false;

  render();
}

function loadServerState() {
  if (!canSync()) {
    setSyncState("offline", "Local only", "Open through serve.py to sync weed_chart.json");
    return;
  }

  fetch(SYNC_ENDPOINT, { cache: "no-store" })
    .then(readSyncResponse)
    .then((payload) => {
      syncEnabled = true;
      setSyncState("synced", "Synced", "Saving to weed_chart.json");

      const serverIsEmpty = !payload.products?.length && !payload.wishlist?.length;
      const localHasData = state.entries.length > 0 || state.wishlist.length > 0;

      if (serverIsEmpty && localHasData) {
        syncRevision = payload.revision || 0;
        queueServerSave();
        showToast("Sent this browser's data to the server.");
        return;
      }

      applyServerState(payload);
      showToast(`Loaded ${state.entries.length} entries from the server.`);
    })
    .catch(() => {
      syncEnabled = false;
      setSyncState("offline", "Local only", "Server unreachable - changes stay in this browser");
    });
}

function pollServerState() {
  if (!syncEnabled || syncInFlight || !elements.drawer.hidden) {
    return;
  }

  fetch(SYNC_ENDPOINT, { cache: "no-store" })
    .then(readSyncResponse)
    .then((payload) => {
      if ((payload.revision || 0) > syncRevision) {
        applyServerState(payload);
        showToast("Updated from weed_chart.json.");
      }
    })
    .catch(() => {
      syncEnabled = false;
      setSyncState("error", "Sync paused", "Server unreachable - changes stay in this browser");
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
    body: JSON.stringify({ products: state.entries, wishlist: state.wishlist }),
  })
    .then(readSyncResponse)
    .then((payload) => {
      syncRevision = payload.revision || syncRevision;
      setSyncState("synced", "Synced", "Saved to weed_chart.json");
    })
    .catch(() => {
      setSyncState("error", "Not saved", "The last change did not reach the server");
    })
    .finally(() => {
      syncInFlight = false;

      if (syncNeedsSave) {
        syncNeedsSave = false;
        saveServerState();
      }
    });
}
