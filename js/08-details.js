"use strict";

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
    view.appendChild(detailSection("Terpene breakdown", h("ul", { class: "terpene-list" }, list.map((item) => h("li", null, terpeneButton(item) || item)))));
  }

  if (entry.effects) {
    view.appendChild(detailSection("Effects", h("p", { text: entry.effects })));
  }

  if (entry.notes) {
    view.appendChild(detailSection("Notes", h("p", { class: "prose private", text: entry.notes })));
  }

  view.appendChild(
    h(
      "p",
      { class: "detail-link" },
      entry.sourceUrl ? h("a", { href: entry.sourceUrl, target: "_blank", rel: "noopener noreferrer" }, icon("i-external"), "Open the product page") : null,
      h("a", { href: hibuddyHref(entry), target: "_blank", rel: "noopener noreferrer" }, icon("i-price"), "Store prices on hibuddy")
    )
  );

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
