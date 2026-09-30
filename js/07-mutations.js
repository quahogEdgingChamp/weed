"use strict";

/* ── Mutations ─────────────────────────────────────────────────────────── */

/* Every change to the data goes through here: it marks the data dirty,
   writes this browser's copy, and queues the server save. */
function commit(mutator, { reason = null, render = true } = {}) {
  mutator(state.data);
  state.data.trash = purgeTrash(state.data.trash);

  /* Journal notes live as long as their product, in the collection or in
     the trash; once it is gone for good, so are they. */
  const productIds = new Set([
    ...state.data.products.map((entry) => entry.id),
    ...state.data.trash.filter((item) => item.kind === "product").map((item) => item.id),
  ]);
  state.data.experiences = state.data.experiences.filter((item) => productIds.has(item.productId));
  sync.generation += 1;
  sync.dirty = true;
  if (reason) {
    sync.pendingReason = reason;
  }

  saveLocal();
  scheduleSave();

  if (render) {
    renderAll();
    refreshDrawer();
  }
}

function saveLocal() {
  const dataOk = storageSet(DATA_KEY, JSON.stringify(state.data));
  const metaOk = storageSet(
    SYNC_KEY,
    JSON.stringify({ datasetId: sync.datasetId, revision: sync.revision, dirty: sync.dirty, base: sync.base })
  );
  state.storageOk = dataOk && metaOk;
  renderSync();
  return state.storageOk;
}

function toggleFavorite(entryId) {
  const entry = findEntry(entryId);
  if (!entry) {
    return;
  }

  commit((data) => {
    data.products = data.products.map((item) =>
      item.id === entryId ? { ...item, favorite: !item.favorite, updatedAt: new Date().toISOString() } : item
    );
  });

  announce(entry.favorite ? `Removed ${entry.name} from favorites.` : `Added ${entry.name} to favorites.`);
}

function findEntry(id) {
  return state.data.products.find((entry) => entry.id === id) || null;
}

/* Deleting moves records to the trash, where they stay for 30 days. The toast
   offers an immediate undo; "Recently deleted" covers everything after. */
function deleteEntries(ids) {
  const targets = ids.map(findEntry).filter(Boolean);
  if (!targets.length) {
    return;
  }

  const now = new Date().toISOString();
  commit((data) => {
    const tombstones = targets.map((entry) => ({
      id: entry.id,
      kind: "product",
      item: entry,
      deletedAt: now,
      position: data.products.findIndex((item) => item.id === entry.id),
    }));
    data.products = data.products.filter((entry) => !ids.includes(entry.id));
    data.trash = [...tombstones, ...data.trash.filter((item) => !(item.kind === "product" && ids.includes(item.id)))];
  });

  ids.forEach((id) => state.selected.delete(id));

  if (state.drawer.entryId && ids.includes(state.drawer.entryId)) {
    closeDrawer();
  }

  const label = targets.length === 1 ? `Deleted ${targets[0].name}.` : `Deleted ${targets.length} entries.`;
  showToast(label, {
    action: { label: "Undo", run: () => restoreFromTrash(targets.map((entry) => ["product", entry.id])) },
    duration: 8000,
  });
}

function removeWishlistItem(itemId) {
  const item = state.data.wishlist.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  commit((data) => {
    const position = data.wishlist.findIndex((entry) => entry.id === itemId);
    data.wishlist = data.wishlist.filter((entry) => entry.id !== itemId);
    data.trash = [
      { id: item.id, kind: "wishlist", item, deletedAt: new Date().toISOString(), position },
      ...data.trash.filter((entry) => !(entry.kind === "wishlist" && entry.id === itemId)),
    ];
  });

  showToast(`Removed ${item.name} from the list.`, {
    action: { label: "Undo", run: () => restoreFromTrash([["wishlist", item.id]]) },
    duration: 8000,
  });
}

function deleteExperience(experienceId) {
  const item = state.data.experiences.find((entry) => entry.id === experienceId);
  if (!item) {
    return;
  }

  commit((data) => {
    data.experiences = data.experiences.filter((entry) => entry.id !== experienceId);
    data.trash = [{ id: item.id, kind: "experience", item, deletedAt: new Date().toISOString(), position: 0 }, ...data.trash];
  });

  showToast("Deleted that experience.", {
    action: { label: "Undo", run: () => restoreFromTrash([["experience", item.id]]) },
    duration: 8000,
  });
}

const TRASH_TARGET = { product: "products", wishlist: "wishlist", experience: "experiences" };

/* Puts records back exactly where they were. */
function restoreFromTrash(pairs) {
  const wanted = new Set(pairs.map(([kind, id]) => `${kind}:${id}`));
  const found = state.data.trash.filter((item) => wanted.has(`${item.kind}:${item.id}`));
  if (!found.length) {
    showToast("That record is no longer in Recently deleted.");
    return;
  }

  commit((data) => {
    for (const tombstone of [...found].sort((a, b) => a.position - b.position)) {
      const key = TRASH_TARGET[tombstone.kind];
      const list = data[key].filter((item) => item.id !== tombstone.id);
      const restored = { ...tombstone.item, updatedAt: new Date().toISOString() };
      list.splice(Math.min(tombstone.position, list.length), 0, restored);
      data[key] = list;
    }
    data.trash = data.trash.filter((item) => !wanted.has(`${item.kind}:${item.id}`));
  });

  showToast(found.length === 1 ? `Restored ${found[0].item.name || "the record"}.` : `Restored ${found.length} records.`);
}
