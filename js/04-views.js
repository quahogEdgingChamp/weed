"use strict";

/* ── Views and history ─────────────────────────────────────────────────── */

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  state.view = VIEWS.includes(view) ? view : "collection";
  state.search = (params.get("q") || "").slice(0, 200);
}

function writeUrl({ replace = false, entry = null } = {}) {
  const params = new URLSearchParams();
  if (state.view !== "collection") {
    params.set("view", state.view);
  }
  if (state.search && isCollectionView()) {
    params.set("q", state.search);
  }
  if (entry) {
    params.set("entry", entry);
  }

  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  const historyState = { view: state.view, entry };

  if (replace) {
    window.history.replaceState(historyState, "", url);
  } else if (url !== `${window.location.pathname}${window.location.search}`) {
    window.history.pushState(historyState, "", url);
  }
}

function openFromUrl() {
  const entryId = new URLSearchParams(window.location.search).get("entry");
  if (entryId && state.data.products.some((entry) => entry.id === entryId)) {
    openDetail(entryId, { push: false });
  }
}

async function handlePopState() {
  const previousView = state.view;
  readUrl();
  elements.searchInput.value = state.search;
  const entryId = new URLSearchParams(window.location.search).get("entry");

  if (!elements.drawer.hidden && state.drawer.mode === "form" && isFormDirty()) {
    const keep = (await confirmDiscard()) === "keep";
    if (keep) {
      writeUrl({ entry: state.drawer.entryId });
      return;
    }
  }

  if (entryId && state.data.products.some((entry) => entry.id === entryId)) {
    openDetail(entryId, { push: false });
  } else if (!elements.drawer.hidden) {
    closeDrawer({ updateUrl: false });
  }

  if (state.view !== previousView) {
    showView(state.view, { push: false });
  } else {
    renderAll();
  }
}

function isCollectionView() {
  return state.view === "collection" || state.view === "favorites";
}

function showView(view, { push = false } = {}) {
  const changed = state.view !== view;
  state.view = VIEWS.includes(view) ? view : "collection";

  elements.views.collection.hidden = !isCollectionView();
  elements.views.shopping.hidden = state.view !== "shopping";
  elements.views.insights.hidden = state.view !== "insights";
  elements.views.research.hidden = state.view !== "research";

  elements.tabs.forEach((tab) => {
    if (tab.dataset.view === state.view) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
  });

  if (push) {
    writeUrl();
  }

  if (changed || push) {
    state.selected.clear();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  renderAll();
}

function renderAll() {
  renderCounts();

  if (isCollectionView()) {
    renderCollection();
  } else if (state.view === "shopping") {
    renderWishlist();
  } else if (state.view === "research") {
    window.CloudlineResearch?.render();
  } else {
    renderInsights();
  }

  renderSync();
}

function renderCounts() {
  elements.tabCounts.collection.textContent = String(state.data.products.length);
  elements.tabCounts.favorites.textContent = String(state.data.products.filter((entry) => entry.favorite).length);
  elements.tabCounts.shopping.textContent = String(state.data.wishlist.length);
}
