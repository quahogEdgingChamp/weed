"use strict";

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
