"use strict";

/* ── Import and export ─────────────────────────────────────────────────── */

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  downloadJson(
    {
      version: Core.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      ...syncable(state.data),
    },
    `weed_chart-${today()}.json`
  );
  showToast("Exported everything, including the journal and recently deleted items.");
}

async function importData(event) {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (!file) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    await openDialog({
      title: "That file can't be imported",
      body: h("p", { text: `It isn't valid JSON (${error.message}). Nothing was changed.` }),
      actions: [{ label: "OK", value: null, variant: "primary" }],
    });
    return;
  }

  const { doc, report, valid } = migrateDoc(parsed);
  if (!valid) {
    await openDialog({
      title: "That file can't be imported",
      body: h("p", { text: `${report.errors[0]?.message || "Unrecognised format"}. Nothing was changed.` }),
      actions: [{ label: "OK", value: null, variant: "primary" }],
    });
    return;
  }

  const counts = docCounts(doc);
  const current = docCounts(state.data);
  const problems = [...report.errors, ...report.warnings];

  const body = h(
    "div",
    { class: "import-preview" },
    h("p", null, h("strong", { text: file.name }), " contains:"),
    h(
      "ul",
      { class: "import-counts" },
      h("li", { text: `${plural(counts.products, "entry", "entries")} (you have ${current.products})` }),
      h("li", { text: `${plural(counts.wishlist, "shopping item")} (you have ${current.wishlist})` }),
      counts.experiences ? h("li", { text: `${plural(counts.experiences, "journal note")}` }) : null
    ),
    report.errors.length ? h("p", { class: "is-over-text", text: `${plural(report.errors.length, "record")} will be skipped:` }) : null,
    report.warnings.length ? h("p", { class: "muted", text: `${plural(report.warnings.length, "value")} will be cleared because they were invalid:` }) : null,
    problems.length
      ? h(
          "ul",
          { class: "import-problems" },
          problems.slice(0, 12).map((problem) =>
            h("li", { text: `${problem.collection}${problem.index >= 0 ? ` #${problem.index + 1}` : ""}${problem.label ? ` “${problem.label}”` : ""}: ${problem.message}` })
          ),
          problems.length > 12 ? h("li", { text: `…and ${problems.length - 12} more.` }) : null
        )
      : null,
    h(
      "dl",
      { class: "choice-list" },
      h("dt", { text: "Merge" }),
      h("dd", { text: "Adds what's new. Where both have the same record, the more recently edited one is kept." }),
      h("dt", { text: "Replace" }),
      h("dd", { text: "Everything you have now is swapped for the file. A copy is kept so you can restore it from Backups & recovery." })
    )
  );

  const choice = await openDialog({
    title: "Import data",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Replace everything", value: "replace", variant: "danger" },
      { label: "Merge", value: "merge", variant: "primary" },
    ],
  });

  if (!choice) {
    return;
  }

  saveRecoveryCopy(choice === "replace" ? "before replacing with an import" : "before merging an import");

  if (choice === "replace") {
    commit((data) => {
      Object.assign(data, doc, { trash: purgeTrash([...trashEverything(data), ...doc.trash]) });
    }, { reason: "import" });
    showToast(`Replaced with ${plural(counts.products, "entry", "entries")} from the file.`);
  } else {
    commit((data) => {
      Object.assign(data, combineDocs(data, doc));
    }, { reason: "import" });
    showToast(`Merged ${file.name}.`);
  }

  closeDrawer();
}

/* Replacing keeps what was there in Recently deleted, so a mistaken import
   can be undone record by record too. */
function trashEverything(data) {
  const now = new Date().toISOString();
  return [
    ...data.products.map((item, position) => ({ id: item.id, kind: "product", item, deletedAt: now, position })),
    ...data.wishlist.map((item, position) => ({ id: item.id, kind: "wishlist", item, deletedAt: now, position })),
    ...data.trash,
  ];
}

function saveRecoveryCopy(label) {
  const ok = storageSet(RECOVERY_KEY, JSON.stringify({ label, savedAt: new Date().toISOString(), data: syncable(state.data) }));
  if (!ok) {
    console.warn("No room for a browser recovery copy; the server snapshot still covers it.");
  }
}

async function confirmClearAll() {
  const counts = docCounts(state.data);
  const body = h(
    "div",
    null,
    h("p", { text: `This removes ${plural(counts.products, "entry", "entries")}, ${plural(counts.wishlist, "shopping item")} and ${plural(counts.experiences, "journal note")}.` }),
    h("p", {
      text: sync.available
        ? "It clears them for every device that uses this server, not only this browser. The server keeps a snapshot first, which you can restore from Backups & recovery."
        : "This page isn't connected to the server, so only this browser's copy is cleared. A recovery copy is kept in this browser.",
    }),
    h("p", { class: "muted", text: "If you want a file of your own first, export it." })
  );

  const choice = await openDialog({
    title: "Clear the collection and shopping list?",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Export first", value: "export" },
      { label: "Clear everything", value: "clear", variant: "danger" },
    ],
  });

  if (choice === "export") {
    exportData();
    return;
  }

  if (choice !== "clear") {
    return;
  }

  saveRecoveryCopy("before clearing everything");
  commit((data) => {
    Object.assign(data, emptyDoc(), { settings: data.settings });
  }, { reason: "clear" });
  closeDrawer();
  showToast("Cleared. Restore from Backups & recovery if that was a mistake.");
}
