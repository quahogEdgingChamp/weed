"use strict";

/* ── OCS lookups ───────────────────────────────────────────────────────── */

async function fetchLookup(url) {
  if (!sync.available) {
    throw new Error("Link lookup needs the local server: run python3 serve.py, then open the address it prints.");
  }

  let response;
  try {
    response = await fetch(`${LOOKUP_ENDPOINT}?url=${encodeURIComponent(url)}`, { cache: "no-store" });
  } catch (error) {
    throw new Error("Could not reach the server. Check the connection and try again.");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.item) {
    throw new Error(payload.error || `Lookup failed (${response.status}).`);
  }
  return payload.item;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  button.setAttribute("aria-busy", String(busy));
  if (label) {
    button.querySelector(".btn-label").textContent = label;
  }
}

function setStatus(element, message, tone = "") {
  element.textContent = message;
  element.dataset.tone = tone;
}

function findByLink(url) {
  const key = productLinkKey(url);
  if (!key) {
    return { wish: null, entries: [] };
  }
  return {
    wish: state.data.wishlist.find((item) => productLinkKey(item.url) === key) || null,
    entries: sortEntries(state.data.products.filter((entry) => productLinkKey(entry.sourceUrl) === key), "purchaseDate-desc"),
  };
}

async function lookupForShopping(url, { skipDuplicateCheck = false } = {}) {
  if (!url || elements.linkSubmit.disabled) {
    if (!url) {
      setLinkStatus("Paste an ocs.ca product link first.", "error");
      elements.linkInput.focus();
    }
    return;
  }

  state.lastLookupUrl = url;

  if (!skipDuplicateCheck) {
    const { wish, entries } = findByLink(url);
    if (wish) {
      const choice = await openDialog({
        title: "Already on your list",
        body: h("p", { text: `“${wish.name}” is on your shopping list already.` }),
        actions: [
          { label: "Cancel", value: null },
          { label: "Add another", value: "add" },
          { label: "Show it", value: "view", variant: "primary" },
        ],
      });
      if (choice === "view") {
        highlightWish(wish.id);
      }
      if (choice !== "add") {
        return;
      }
    } else if (entries.length) {
      const choice = await openDialog({
        title: "You've bought this before",
        body: h("p", { text: `“${entries[0].name}” is in your collection${entries[0].purchaseDate ? `, bought ${formatDate(entries[0].purchaseDate)}` : ""}.` }),
        actions: [
          { label: "Cancel", value: null },
          { label: "View purchase", value: "view" },
          { label: "Add to list anyway", value: "add", variant: "primary" },
        ],
      });
      if (choice === "view") {
        openDetail(entries[0].id);
      }
      if (choice !== "add") {
        return;
      }
    }
  }

  setBusy(elements.linkSubmit, true, "Looking up…");
  setLinkStatus("Asking ocs.ca for the product…");

  try {
    const item = await fetchLookup(url);
    const { value } = normalizeWishItem({ ...item, id: uuid(), addedAt: new Date().toISOString(), priority: "normal" });
    commit((data) => {
      data.wishlist = [value, ...data.wishlist];
    });
    elements.linkInput.value = "";
    setLinkStatus(`Added ${value.name}.`, "ok");
  } catch (error) {
    setLinkStatus(error.message, "error", { retry: sync.available });
  } finally {
    setBusy(elements.linkSubmit, false, "Look up");
  }
}

/* The Research tab (js/3x-research-*.js) adds picks to the list through here, so a
   research card and a pasted link end up as the same kind of item. */
/* Returns { status: "added" | "exists" | "failed", id } so the Research
   deck can undo an add with removeResearchPick. */
async function addResearchPick({ url = "", name = "", brand = "", price = null, note = "", priority = "normal", quiet = false }) {
  const { wish } = findByLink(url);
  if (wish) {
    if (!quiet) {
      showToast(`“${wish.name}” is already on your shopping list.`, {
        action: { label: "Show", run: () => { showView("shopping", { push: true }); highlightWish(wish.id); } },
      });
    }
    return { status: "exists", id: wish.id };
  }

  let item = { name, brand, price, url };
  if (url && sync.available) {
    try {
      item = await fetchLookup(url);
    } catch (error) {
      /* OCS didn't answer: the research facts are good enough to start with. */
    }
  }

  const { value } = normalizeWishItem({
    ...item,
    id: uuid(),
    addedAt: new Date().toISOString(),
    priority: ["high", "normal", "low"].includes(priority) ? priority : "normal",
    shoppingNote: note,
  });
  if (!value) {
    return { status: "failed", id: null };
  }
  commit((data) => {
    data.wishlist = [value, ...data.wishlist];
  }, { render: false });
  renderCounts();
  if (!quiet) {
    showToast(`Added ${value.name} to your shopping list.`, {
      action: { label: "View", run: () => { showView("shopping", { push: true }); highlightWish(value.id); } },
    });
  }
  return { status: "added", id: value.id };
}

/* Undo for the Research deck: take an item it added back off the list. */
function removeResearchPick(id) {
  if (!state.data.wishlist.some((item) => item.id === id)) return false;
  commit((data) => {
    data.wishlist = data.wishlist.filter((item) => item.id !== id);
  }, { render: false });
  renderCounts();
  return true;
}

function researchOwnership(url) {
  const { wish, entries } = findByLink(url);
  const rated = entries.find((entry) => typeof entry.rating === "number");
  return {
    onList: Boolean(wish),
    owned: entries.length > 0,
    rating: rated ? rated.rating : null,
    entryId: entries[0]?.id || null,
  };
}
