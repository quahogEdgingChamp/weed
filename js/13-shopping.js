"use strict";

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
    item.terpenes.length ? h("ul", { class: "wish-terpenes terpene-list" }, item.terpenes.map((terpene) => h("li", null, terpeneButton(terpene) || terpene))) : null,
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
        hibuddyLink(item),
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
