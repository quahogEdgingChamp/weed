"use strict";

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
