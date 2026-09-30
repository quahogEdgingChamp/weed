"use strict";

/* ── Sync status ───────────────────────────────────────────────────────── */

function renderSync() {
  const { label, state: tone, detail } = describeSync();
  elements.syncState.dataset.state = tone;
  elements.syncLabel.textContent = label;
  elements.syncDetail.textContent = detail;
  elements.syncState.title = detail;
  renderBanner();
}

function describeSync() {
  if (!state.storageOk) {
    return { label: "Not saved", state: "error", detail: "This browser refused to store your changes (storage full or blocked). Export a backup." };
  }

  if (!sync.available) {
    return { label: "This browser only", state: "offline", detail: "Saved in this browser. Open the page through serve.py to share it between devices." };
  }

  if (sync.awaitingChoice) {
    return { label: "Needs a decision", state: "error", detail: "This browser and the server disagree. Choose which copy to keep." };
  }

  if (!sync.hydrated) {
    return sync.status === "offline" || sync.status === "error"
      ? { label: "Offline", state: "offline", detail: "Can't reach the server. Changes stay in this browser until it's back." }
      : { label: "Loading", state: "pending", detail: "Fetching the latest copy from the server." };
  }

  if (sync.rejected) {
    return { label: "Not saved", state: "error", detail: `The server rejected the last save: ${sync.lastError}` };
  }

  if (sync.inFlight) {
    return { label: "Saving…", state: "pending", detail: "Sending your changes to the server." };
  }

  if (sync.dirty && sync.status === "offline") {
    return { label: "Offline · pending", state: "offline", detail: "Can't reach the server. Your changes are kept in this browser and will be sent when it's back. Select to retry now." };
  }

  if (sync.dirty && sync.status === "error") {
    return { label: "Not saved · retry", state: "error", detail: `The last save failed (${sync.lastError}). It will retry automatically; select to retry now.` };
  }

  if (sync.dirty) {
    return { label: "Pending", state: "pending", detail: "Changes are about to be sent to the server." };
  }

  if (sync.status === "offline" || sync.status === "error") {
    return { label: "Offline", state: "offline", detail: "Can't reach the server right now. Everything you've done so far is saved." };
  }

  return {
    label: "Saved",
    state: "synced",
    detail: sync.lastSavedAt ? `Saved to the server ${formatTimestamp(sync.lastSavedAt)}.` : "Up to date with the server.",
  };
}

function renderBanner() {
  let message = "";
  let canRetry = false;

  if (!state.storageOk) {
    message = "This browser couldn't store your latest changes. Export a backup now so nothing is lost.";
    canRetry = sync.available && sync.hydrated;
  } else if (sync.legacy && sync.hydrated) {
    message = "The server is still running the old serve.py. Restart it (sudo systemctl restart weed) to turn on conflict protection, snapshots and the journal sync.";
  } else if (sync.rejected) {
    message = `The server refused your last change: ${sync.lastError}. It's kept in this browser.`;
    canRetry = true;
  } else if (sync.dirty && sync.status === "error" && sync.retryDelay >= 8000) {
    message = "Your recent changes haven't reached the server yet. They're kept in this browser and will keep retrying.";
    canRetry = true;
  }

  elements.banner.hidden = !message;
  elements.bannerText.textContent = message;
  elements.bannerRetry.hidden = !canRetry;
}

function handleSyncClick() {
  const { detail } = describeSync();
  if (sync.dirty && (sync.status === "offline" || sync.status === "error" || sync.rejected)) {
    retryNow();
    showToast("Retrying…");
    return;
  }
  showToast(detail);
}

function retryNow() {
  if (!sync.available) {
    return;
  }
  sync.rejected = false;
  sync.retryDelay = 0;
  window.clearTimeout(sync.retryTimer);
  if (!sync.hydrated) {
    hydrate();
  } else {
    poll({ force: true });
  }
}

/* ── Server sync ───────────────────────────────────────────────────────── */

class ServerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function toRemote(payload) {
  const { doc, report } = migrateDoc(payload);
  return {
    doc,
    report,
    exists: payload.exists !== false,
    datasetId: typeof payload.datasetId === "string" ? payload.datasetId : null,
    revision: String(payload.revision ?? ""),
    legacy: payload.schema !== Core.SCHEMA_VERSION,
  };
}

async function fetchState() {
  let response;
  try {
    response = await fetch(SYNC_ENDPOINT, { cache: "no-store" });
  } catch (error) {
    throw new ServerError("the server can't be reached", 0);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new ServerError(payload?.error || `the server answered ${response.status}`, response.status);
  }

  return toRemote(payload);
}

function adoptServerIdentity(remote) {
  sync.revision = remote.revision;
  sync.datasetId = remote.datasetId;
  sync.legacy = remote.legacy;
  sync.hydrated = true;
}

function applyRemote(remote, { announceChange = false } = {}) {
  const changed = !docsEqual(state.data, remote.doc);
  state.data = remote.doc;
  sync.base = clone(remote.doc);
  sync.dirty = false;
  adoptServerIdentity(remote);
  sync.status = "saved";

  /* The server's copy was stored in an older shape or had made-up ids: write
     the normalized version back once so it stays stable. */
  if (remote.report.repaired && !sync.legacy) {
    sync.dirty = true;
    sync.generation += 1;
    scheduleSave();
  }

  saveLocal();
  if (changed) {
    renderAll();
    refreshDrawer();
    if (announceChange) {
      showToast("Updated with changes from another device.");
    }
  } else {
    renderSync();
  }
}

/* Local edits exist that the server hasn't seen, and the server has moved
   on: combine the two against the last copy both agreed on. */
function mergeRemote(base, remote) {
  const { doc, conflicts } = mergeDocs(base, state.data, remote.doc);
  const changedLocally = !docsEqual(doc, state.data);
  state.data = doc;
  sync.base = clone(remote.doc);
  adoptServerIdentity(remote);

  if (docsEqual(doc, remote.doc)) {
    sync.dirty = false;
  } else {
    sync.dirty = true;
    sync.generation += 1;
    scheduleSave(0);
  }

  saveLocal();
  if (changedLocally) {
    renderAll();
    refreshDrawer();
  }

  if (conflicts) {
    showToast(`Merged with changes from another device. ${plural(conflicts, "record was", "records were")} edited in both places; the newer edit was kept.`, { duration: 9000 });
  } else if (changedLocally) {
    showToast("Merged in changes from another device.");
  }
}

async function hydrate() {
  if (!sync.available) {
    sync.status = "local";
    renderSync();
    return;
  }

  if (sync.hydrating || sync.hydrated || sync.awaitingChoice) {
    return;
  }

  sync.hydrating = true;
  renderSync();

  try {
    const remote = await fetchState();
    sync.status = "saved";
    await reconcileInitial(remote);
  } catch (error) {
    if (error.status >= 500 && error.status < 600) {
      /* A broken data file: never write over it. */
      sync.status = "error";
      sync.lastError = error.message;
      showToast(`The server's data file can't be read: ${error.message}. Nothing will be saved to it until it's fixed.`, { duration: 12000 });
    } else {
      sync.status = navigator.onLine === false ? "offline" : "error";
      sync.lastError = error.message;
    }
    scheduleRetry();
  } finally {
    sync.hydrating = false;
    renderSync();
  }
}

/* The first contact with the server decides whose copy wins. A browser that
   has synced with this dataset before just merges its pending edits. A new
   browser holding data the server lacks is asked, because that is exactly
   how deleted data would otherwise come back from the dead. */
async function reconcileInitial(remote) {
  const local = state.data;

  if (!remote.exists && !remote.legacy) {
    if (isEmptyDoc(local)) {
      applyRemote(remote);
    } else {
      /* A brand-new server: this browser's copy becomes the first version. */
      sync.base = emptyDoc();
      adoptServerIdentity(remote);
      sync.dirty = true;
      sync.generation += 1;
      saveLocal();
      scheduleSave(0);
      showToast("Sent this browser's data to the new server.");
    }
    return;
  }

  const sameDataset = remote.legacy ? Boolean(sync.base) : Boolean(sync.datasetId && sync.datasetId === remote.datasetId);

  if (sameDataset) {
    if (sync.dirty) {
      mergeRemote(sync.base, remote);
    } else {
      applyRemote(remote);
    }
    return;
  }

  const localOnly = recordsMissingFrom(local, remote.doc);
  if (isEmptyDoc(local) || !localOnly.length) {
    applyRemote(remote);
    return;
  }

  sync.awaitingChoice = true;
  renderSync();

  const serverEmpty = isEmptyDoc(remote.doc);
  const choice = await openDialog({
    title: "Which copy should be kept?",
    body: h(
      "div",
      null,
      h("p", {
        text: serverEmpty
          ? `The server's collection is empty, but this browser still holds ${countsLabel(local)}. It may have been cleared on purpose from another device.`
          : `This browser has ${plural(localOnly.length, "record")} the server doesn't have. They might be new, or they might have been deleted on another device.`,
      }),
      h("p", { class: "muted", text: `Server: ${countsLabel(remote.doc)}. This browser: ${countsLabel(local)}.` }),
      h(
        "dl",
        { class: "choice-list" },
        h("dt", { text: "Use the server's copy" }),
        h("dd", { text: "This browser's extra records are dropped (a recovery copy is kept in this browser)." }),
        serverEmpty ? null : h("dt", { text: "Keep both" }),
        serverEmpty ? null : h("dd", { text: "Adds this browser's extra records to the server." }),
        h("dt", { text: "Use this browser's copy" }),
        h("dd", { text: "Replaces the server's data. The server keeps a snapshot first." })
      )
    ),
    actions: [
      { label: "Use this browser's copy", value: "local" },
      serverEmpty ? null : { label: "Keep both", value: "merge" },
      { label: "Use the server's copy", value: "remote", variant: "primary" },
    ].filter(Boolean),
    dismissValue: "remote",
  });

  sync.awaitingChoice = false;
  saveRecoveryCopy("before choosing between this browser and the server");

  if (choice === "local") {
    sync.base = clone(remote.doc);
    adoptServerIdentity(remote);
    sync.dirty = true;
    sync.pendingReason = "restore";
    sync.generation += 1;
    saveLocal();
    scheduleSave(0);
  } else if (choice === "merge") {
    sync.base = clone(remote.doc);
    adoptServerIdentity(remote);
    state.data = combineDocs(remote.doc, local);
    sync.dirty = true;
    sync.generation += 1;
    saveLocal();
    renderAll();
    scheduleSave(0);
  } else {
    applyRemote(remote);
  }
}

function recordsMissingFrom(local, remote) {
  const ids = new Set([...remote.products, ...remote.wishlist, ...remote.experiences].map((item) => item.id));
  const trashed = new Set(remote.trash.map((item) => item.id));
  return [...local.products, ...local.wishlist, ...local.experiences].filter((item) => !ids.has(item.id) && !trashed.has(item.id));
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS) {
  if (!sync.available) {
    return;
  }
  window.clearTimeout(sync.saveTimer);
  sync.saveTimer = window.setTimeout(saveToServer, delay);
  renderSync();
}

function scheduleRetry() {
  window.clearTimeout(sync.retryTimer);
  sync.retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, sync.retryDelay * 2));
  sync.retryTimer = window.setTimeout(() => {
    if (!sync.hydrated) {
      hydrate();
    } else {
      poll({ force: true });
    }
  }, sync.retryDelay);
}

async function saveToServer() {
  window.clearTimeout(sync.saveTimer);
  sync.saveTimer = null;

  if (!sync.available || !sync.hydrated || sync.inFlight || !sync.dirty || sync.awaitingChoice || sync.rejected) {
    return;
  }

  const generation = sync.generation;
  const sent = clone(syncable(state.data));
  const reason = sync.pendingReason;
  sync.inFlight = true;
  renderSync();

  let response;
  let payload;
  try {
    response = await fetch(SYNC_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: sync.revision ?? "", datasetId: sync.datasetId, reason, ...sent }),
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    sync.inFlight = false;
    sync.status = navigator.onLine === false ? "offline" : "error";
    sync.lastError = "the server can't be reached";
    scheduleRetry();
    renderSync();
    return;
  }

  sync.inFlight = false;

  if (response.status === 409 && payload?.state) {
    /* Someone else saved first. Merge their version with ours and go again. */
    mergeRemote(sync.base, toRemote(payload.state));
    return;
  }

  if (response.status === 400) {
    sync.rejected = true;
    sync.status = "error";
    sync.lastError = (payload?.problems || [payload?.error || "invalid data"]).slice(0, 3).join("; ");
    renderSync();
    return;
  }

  if (!response.ok || !payload) {
    sync.status = "error";
    sync.lastError = payload?.error || `the server answered ${response.status}`;
    scheduleRetry();
    renderSync();
    return;
  }

  sync.revision = String(payload.revision ?? "");
  sync.datasetId = typeof payload.datasetId === "string" ? payload.datasetId : sync.datasetId;
  sync.legacy = payload.schema !== Core.SCHEMA_VERSION;
  sync.base = sent;
  sync.pendingReason = null;
  sync.status = "saved";
  sync.retryDelay = 0;
  sync.lastSavedAt = Date.now();
  if (sync.generation === generation) {
    sync.dirty = false;
  }

  saveLocal();
  if (sync.dirty) {
    scheduleSave();
  }
}

async function poll({ force = false } = {}) {
  if (!sync.available || sync.awaitingChoice) {
    return;
  }

  if (!sync.hydrated) {
    if (force) hydrate();
    return;
  }

  if (sync.inFlight || poll.running) {
    return;
  }

  poll.running = true;
  const revisionAtStart = sync.revision;

  try {
    const remote = await fetchState();
    const wasDown = sync.status === "offline" || sync.status === "error";
    if (wasDown && !sync.rejected) {
      sync.status = "saved";
      sync.retryDelay = 0;
    }

    /* A save finished while this request was out: its answer is newer. */
    if (sync.inFlight || sync.revision !== revisionAtStart) {
      return;
    }

    if (remote.revision !== sync.revision) {
      if (sync.dirty) {
        mergeRemote(sync.base, remote);
      } else {
        applyRemote(remote, { announceChange: true });
      }
    } else if (sync.dirty && !sync.saveTimer) {
      saveToServer();
    }
  } catch (error) {
    sync.status = navigator.onLine === false ? "offline" : "error";
    sync.lastError = error.message;
    if (sync.dirty) {
      scheduleRetry();
    }
  } finally {
    poll.running = false;
    renderSync();
  }
}
