"use strict";

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
      hibuddyLink(entry, { text: "Prices" }),
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
