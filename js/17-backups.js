"use strict";

/* ── Backups and recovery ──────────────────────────────────────────────── */

async function openBackups() {
  const list = h("div", { class: "backup-list" }, h("p", { class: "muted", text: sync.available ? "Loading snapshots…" : "" }));
  const recovery = readJson(RECOVERY_KEY);

  const body = h(
    "div",
    null,
    h("p", {
      class: "dialog-note",
      text: "The server copies weed_chart.json aside before every import, restore or clear, and at most every 15 minutes while you edit. The newest 100 are kept. Restoring takes a new snapshot first, so a restore can be undone too.",
    }),
    recovery?.data
      ? h(
          "section",
          { class: "backup-local" },
          h("h3", { class: "detail-heading", text: "This browser's recovery copy" }),
          h(
            "div",
            { class: "backup-row" },
            h("div", null, h("strong", { text: `Saved ${formatTimestamp(recovery.savedAt)}` }), h("p", { class: "muted", text: `${recovery.label} · ${countsLabel(recovery.data)}` })),
            h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => restoreDoc(recovery.data, "the browser recovery copy") }, "Restore")
          )
        )
      : null,
    sync.available ? h("h3", { class: "detail-heading", text: "Server snapshots" }) : h("p", { class: "muted", text: "Server snapshots need the page to be opened through serve.py." }),
    sync.available ? list : null,
    sync.available
      ? h(
          "section",
          { class: "backup-local" },
          h("h3", { class: "detail-heading", text: "Start over from the server" }),
          h("p", { class: "muted", text: "Throws away this browser's copy, including changes that haven't reached the server, and loads the server's version." }),
          h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: reloadFromServer }, "Reload from server")
        )
      : null
  );

  const dialogPromise = openDialog({
    title: "Backups & recovery",
    wide: true,
    body,
    actions: [{ label: "Close", value: null, variant: "primary" }],
  });

  if (sync.available) {
    try {
      const response = await fetch(SNAPSHOT_ENDPOINT, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(response.status === 404 ? "This server doesn't keep snapshots yet: restart it to pick up the new serve.py." : `Server answered ${response.status}.`);
      }
      const { snapshots } = await response.json();
      clear(list);
      if (!snapshots.length) {
        list.appendChild(h("p", { class: "muted", text: "No snapshots yet. The first one is taken before the next save." }));
      }
      for (const snapshot of snapshots) {
        list.appendChild(
          h(
            "div",
            { class: "backup-row" },
            h(
              "div",
              null,
              h("strong", { text: formatTimestamp(snapshot.createdAt) }),
              h("p", { class: "muted", text: `${REASON_LABELS[snapshot.reason] || snapshot.reason}${snapshot.counts ? ` · ${countsLabel(snapshot.counts)}` : ""}` })
            ),
            h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => previewSnapshot(snapshot) }, "Preview")
          )
        );
      }
    } catch (error) {
      clear(list).appendChild(h("p", { class: "is-over-text", text: error.message }));
    }
  }

  await dialogPromise;
}

const REASON_LABELS = {
  auto: "Before an edit",
  import: "Before an import",
  restore: "Before a restore",
  clear: "Before clearing",
  migration: "Before upgrading the file format",
};

function countsLabel(source) {
  const counts = Array.isArray(source.products)
    ? { products: source.products.length, wishlist: (source.wishlist || []).length }
    : source;
  return `${plural(counts.products || 0, "entry", "entries")}, ${plural(counts.wishlist || 0, "shopping item")}`;
}

async function previewSnapshot(snapshot) {
  closeCurrentDialog();
  let payload;
  try {
    const response = await fetch(`${SNAPSHOT_ENDPOINT}/${encodeURIComponent(snapshot.name)}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Server answered ${response.status}.`);
    }
    payload = await response.json();
  } catch (error) {
    showToast(`Could not open that snapshot: ${error.message}`);
    return;
  }

  const { doc } = migrateDoc(payload.state);
  const currentIds = new Set(state.data.products.map((entry) => entry.id));
  const snapshotIds = new Set(doc.products.map((entry) => entry.id));
  const onlyInSnapshot = doc.products.filter((entry) => !currentIds.has(entry.id));
  const onlyNow = state.data.products.filter((entry) => !snapshotIds.has(entry.id));

  const body = h(
    "div",
    null,
    h("p", { text: `Taken ${formatTimestamp(snapshot.createdAt)} · ${countsLabel(doc)}.` }),
    h("p", { class: "muted", text: `You have ${countsLabel(state.data)} now.` }),
    onlyInSnapshot.length
      ? h("div", null, h("h3", { class: "detail-heading", text: "Would come back" }), h("ul", { class: "import-problems" }, onlyInSnapshot.slice(0, 10).map((entry) => h("li", { text: entry.name })), onlyInSnapshot.length > 10 ? h("li", { text: `…and ${onlyInSnapshot.length - 10} more` }) : null))
      : null,
    onlyNow.length
      ? h("div", null, h("h3", { class: "detail-heading", text: "Would be removed (kept in Recently deleted)" }), h("ul", { class: "import-problems" }, onlyNow.slice(0, 10).map((entry) => h("li", { text: entry.name })), onlyNow.length > 10 ? h("li", { text: `…and ${onlyNow.length - 10} more` }) : null))
      : null,
    !onlyInSnapshot.length && !onlyNow.length ? h("p", { class: "muted", text: "Same entries as now; restoring brings back their older field values." }) : null
  );

  const choice = await openDialog({
    title: "Restore this snapshot?",
    body,
    actions: [
      { label: "Cancel", value: null },
      { label: "Restore", value: "restore", variant: "primary" },
    ],
  });

  if (choice === "restore") {
    restoreDoc(doc, `the snapshot from ${formatTimestamp(snapshot.createdAt)}`);
  }
}

function restoreDoc(source, label) {
  const { doc } = migrateDoc(source);
  saveRecoveryCopy(`before restoring ${label}`);
  commit((data) => {
    const restoredIds = new Set(doc.products.map((entry) => entry.id));
    const displaced = data.products
      .filter((entry) => !restoredIds.has(entry.id))
      .map((item, position) => ({ id: item.id, kind: "product", item, deletedAt: new Date().toISOString(), position }));
    Object.assign(data, doc, { trash: purgeTrash([...displaced, ...doc.trash]) });
  }, { reason: "restore" });
  closeAllDialogs();
  showToast(`Restored ${label}.`);
}

async function reloadFromServer() {
  closeCurrentDialog();
  const choice = await openDialog({
    title: "Reload from the server?",
    body: h("p", { text: sync.dirty ? "This browser has changes the server hasn't got yet. They'll be lost (a recovery copy is kept in this browser)." : "This browser's copy will be replaced with the server's." }),
    actions: [
      { label: "Cancel", value: null },
      { label: "Reload", value: "reload", variant: "danger" },
    ],
  });

  if (choice !== "reload") {
    return;
  }

  saveRecoveryCopy("before reloading from the server");
  try {
    const remote = await fetchState();
    applyRemote(remote);
    closeAllDialogs();
    showToast("Loaded the server's copy.");
  } catch (error) {
    showToast(`Could not reach the server: ${error.message}`);
  }
}

/* ── Recently deleted ──────────────────────────────────────────────────── */

function openTrash() {
  const container = h("div", { class: "trash-list" });

  const render = () => {
    clear(container);
    const items = state.data.trash;
    if (!items.length) {
      container.appendChild(h("p", { class: "muted", text: "Nothing here. Deleted entries, shopping items and journal notes wait here for 30 days." }));
      return;
    }

    for (const tombstone of items) {
      const label = tombstone.kind === "experience"
        ? `Journal note for ${findEntry(tombstone.item.productId)?.name || state.data.trash.find((item) => item.id === tombstone.item.productId)?.item.name || "a deleted entry"}`
        : tombstone.item.name;
      container.appendChild(
        h(
          "div",
          { class: "backup-row" },
          h("div", null, h("strong", { text: label }), h("p", { class: "muted", text: `${KIND_LABELS[tombstone.kind]} · deleted ${formatTimestamp(tombstone.deletedAt)}` })),
          h(
            "div",
            { class: "row-buttons" },
            h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => { restoreFromTrash([[tombstone.kind, tombstone.id]]); render(); } }, "Restore"),
            h("button", { type: "button", class: "btn btn-danger-ghost btn-small", onclick: () => { purgeFromTrash([[tombstone.kind, tombstone.id]]); render(); } }, "Delete forever")
          )
        )
      );
    }
  };

  render();
  openDialog({
    title: "Recently deleted",
    wide: true,
    body: h("div", null, h("p", { class: "dialog-note", text: `Kept for ${TRASH_RETENTION_DAYS} days, on every device that syncs.` }), container),
    actions: [{ label: "Close", value: null, variant: "primary" }],
  });
}

const KIND_LABELS = { product: "Entry", wishlist: "Shopping item", experience: "Journal note" };

function purgeFromTrash(pairs) {
  const wanted = new Set(pairs.map(([kind, id]) => `${kind}:${id}`));
  commit((data) => {
    const productIds = new Set(pairs.filter(([kind]) => kind === "product").map(([, id]) => id));
    /* A product gone for good takes its journal with it. */
    data.experiences = data.experiences.filter((item) => !productIds.has(item.productId));
    data.trash = data.trash.filter(
      (item) => !wanted.has(`${item.kind}:${item.id}`) && !(item.kind === "experience" && productIds.has(item.item.productId))
    );
  });
}

/* ── Tag manager ───────────────────────────────────────────────────────── */

function openTagManager() {
  const container = h("div", { class: "tag-list" });

  const render = () => {
    clear(container);
    const tags = allTags();
    if (!tags.length) {
      container.appendChild(h("p", { class: "muted", text: "No tags yet. Add them in an entry's Experience section, comma-separated." }));
      return;
    }

    for (const { label, count } of tags) {
      const input = h("input", { type: "text", value: label, "aria-label": `Rename tag ${label}` });
      container.appendChild(
        h(
          "form",
          {
            class: "tag-row",
            onsubmit: (event) => {
              event.preventDefault();
              renameTag(label, input.value);
              render();
            },
          },
          input,
          h("span", { class: "muted tag-count", text: plural(count, "entry", "entries") }),
          h("button", { type: "submit", class: "btn btn-secondary btn-small" }, "Rename"),
          h("button", { type: "button", class: "btn btn-danger-ghost btn-small", onclick: () => { renameTag(label, ""); render(); } }, "Remove")
        )
      );
    }
  };

  render();
  openDialog({
    title: "Manage tags",
    body: h("div", null, h("p", { class: "dialog-note", text: "Renaming a tag to one that already exists merges them. Removing takes it off every entry." }), container),
    actions: [{ label: "Done", value: null, variant: "primary" }],
  });
}

function renameTag(from, to) {
  const fromKey = tagKey(from);
  const target = Core.cleanText(to, 40);
  const affected = state.data.products.filter((entry) => entry.tags.some((tag) => tagKey(tag) === fromKey));
  if (!affected.length || (target && target === from)) {
    return;
  }

  const now = new Date().toISOString();
  commit((data) => {
    data.products = data.products.map((entry) => {
      if (!entry.tags.some((tag) => tagKey(tag) === fromKey)) {
        return entry;
      }
      const tags = entry.tags.map((tag) => (tagKey(tag) === fromKey ? target : tag)).filter(Boolean);
      return { ...entry, tags: normalizeTags(tags), updatedAt: now };
    });
  });

  prefs.filters.tags = prefs.filters.tags.map((tag) => (tagKey(tag) === fromKey ? target : tag)).filter(Boolean);
  savePrefs();
  showToast(target ? `Renamed “${from}” to “${target}” on ${plural(affected.length, "entry", "entries")}.` : `Removed “${from}” from ${plural(affected.length, "entry", "entries")}.`);
}
