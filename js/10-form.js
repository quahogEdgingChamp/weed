"use strict";

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
