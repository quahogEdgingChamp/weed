"use strict";

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
