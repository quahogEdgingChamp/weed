"use strict";

/* ── Terpene card ──────────────────────────────────────────────────────────
   Tapping a terpene anywhere opens a small card: what it smells like, the
   effects people link it with, and how it has gone for you. A tap works on a
   phone where a hover tooltip never shows. The card sits beside the tapped
   chip on a wide screen and slides up from the bottom on a narrow one.
   Callers can add lines (`stats`) and buttons (`actions`) of their own. */

const terpeneCard = { el: null, anchor: null };

/* How the terpene has gone in the user's own collection. */
function terpeneHistory(key) {
  const withIt = state.data.products.filter((entry) => Core.terpeneKeys(entry.terpenes).includes(key));
  if (!withIt.length) return "Not in anything you've logged yet.";
  const rated = withIt.filter((entry) => typeof entry.rating === "number");
  const average = rated.length ? rated.reduce((sum, entry) => sum + entry.rating, 0) / rated.length : null;
  const count = `${withIt.length} ${withIt.length === 1 ? "entry" : "entries"}`;
  return average === null ? `In ${count} you've logged, none rated yet.` : `In ${count} you've logged, rated ${average.toFixed(1)} / 10 on average.`;
}

function showTerpene(anchor, raw, { stats = [], actions = [] } = {}) {
  const info = Core.terpeneInfo(raw);
  if (!info) return;
  if (terpeneCard.el && terpeneCard.anchor === anchor) {
    closeTerpene({ restoreFocus: true });
    return;
  }
  closeTerpene();

  const facts = [
    ["Smells like", info.aroma],
    [info.flavour ? "Note" : "What people say", info.flavour ? "A flavour compound, not a terpene; often added for taste." : info.linked],
    ["Also found in", info.also],
  ].filter(([, value]) => value);
  const titleId = "terp-card-title";
  const card = h(
    "div",
    { class: "terp-card", role: "dialog", "aria-labelledby": titleId, tabindex: "-1" },
    h(
      "div",
      { class: "terp-card-head" },
      h("h2", { id: titleId, class: "terp-card-title", text: info.name }),
      h("button", { type: "button", class: "btn btn-icon terp-card-close", "aria-label": "Close", onClick: () => closeTerpene({ restoreFocus: true }) }, icon("i-close"))
    ),
    info.effects.length
      ? h(
          "div",
          { class: "terp-card-effects" },
          h("span", { class: "terp-card-label", text: "Main effects" }),
          h("ul", { class: "chip-row" }, info.effects.map((effect) => h("li", { class: "terp-effect", text: effect })))
        )
      : null,
    facts.length
      ? h("dl", { class: "terp-card-facts" }, facts.map(([label, value]) => h("div", null, h("dt", { text: label }), h("dd", { text: value }))))
      : h("p", { class: "muted", text: "No notes on this one yet." }),
    h(
      "ul",
      { class: "terp-card-stats" },
      [...stats, terpeneHistory(info.key)].filter(Boolean).map((line) => h("li", { text: line }))
    ),
    actions.length
      ? h(
          "div",
          { class: "terp-card-actions" },
          actions.map((action, index) =>
            h("button", {
              type: "button",
              class: `btn btn-small ${index ? "btn-ghost" : "btn-secondary"}`,
              text: action.label,
              onClick: () => {
                closeTerpene();
                action.run();
              },
            })
          )
        )
      : null,
    info.flavour ? null : h("p", { class: "terp-card-note", text: "What people commonly report, not settled science. The whole plant matters more than any one terpene." })
  );

  document.body.appendChild(card);
  terpeneCard.el = card;
  terpeneCard.anchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  placeTerpene();
  card.querySelector(".terp-card-close").focus({ preventScroll: true });
}

function placeTerpene() {
  const { el, anchor } = terpeneCard;
  if (!el) return;
  const sheet = window.matchMedia("(max-width: 560px)").matches;
  el.classList.toggle("is-sheet", sheet);
  if (sheet || !anchor.isConnected) {
    el.style.left = el.style.top = "";
    return;
  }
  const gap = 8;
  const box = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const left = Math.min(Math.max(gap, box.left), window.innerWidth - width - gap);
  const below = box.bottom + gap;
  const top = Math.max(gap, below + height <= window.innerHeight - gap ? below : box.top - height - gap);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function closeTerpene({ restoreFocus = false } = {}) {
  const { el, anchor } = terpeneCard;
  if (!el) return;
  el.remove();
  terpeneCard.el = terpeneCard.anchor = null;
  anchor?.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

/* Capture phase, so Escape closes the card before it closes a drawer under it. */
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && terpeneCard.el) {
      event.preventDefault();
      event.stopPropagation();
      closeTerpene({ restoreFocus: true });
    }
  },
  true
);
document.addEventListener("pointerdown", (event) => {
  if (terpeneCard.el && !terpeneCard.el.contains(event.target) && !terpeneCard.anchor?.contains(event.target)) closeTerpene();
});
document.addEventListener("focusin", (event) => {
  if (terpeneCard.el && !terpeneCard.el.contains(event.target) && event.target !== terpeneCard.anchor) closeTerpene();
});
window.addEventListener("resize", placeTerpene);
window.addEventListener("scroll", placeTerpene, { capture: true, passive: true });

/* A tappable terpene chip for the Collection and Shopping list. */
function terpeneButton(raw) {
  const key = Core.terpeneKey(raw);
  if (!key) return null;
  return h("button", {
    type: "button",
    class: "terp-chip",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    text: String(raw).trim(),
    onClick: (event) => showTerpene(event.currentTarget, raw),
  });
}

function setLinkStatus(message, tone = "", { retry = false } = {}) {
  elements.linkStatusText.textContent = message;
  elements.linkStatus.dataset.tone = tone;
  elements.linkStatus.classList.toggle("is-empty", !message);
  elements.linkRetry.hidden = !retry;
}

async function fillFormFromOcs() {
  const url = elements.formOcsInput.value.trim();
  if (!url) {
    setStatus(elements.formOcsStatus, "Paste an ocs.ca product link first.", "error");
    elements.formOcsInput.focus();
    return;
  }

  setBusy(elements.formOcsButton, true, "Looking up…");
  setStatus(elements.formOcsStatus, "Asking ocs.ca for the product…");

  try {
    const item = await fetchLookup(url);
    const values = wishToEntryValues(item);
    fillForm({ ...readFormValues(), ...values, purchaseDate: fields.purchaseDate.value || today() });
    state.drawer.sourceUrl = item.url || "";
    state.drawer.potencyTouched = true;
    elements.sectionPurchase.open = true;

    const { entries } = findByLink(item.url);
    if (entries.length) {
      state.drawer.productKey = entries[0].productKey || entries[0].id;
      if (!entries[0].productKey) {
        state.drawer.linkOriginal = entries[0].id;
      }
      setStatus(elements.formOcsStatus, `Filled in. You've bought this before (${formatDate(entries[0].purchaseDate)}), so it will show in that product's history.`, "ok");
    } else {
      setStatus(elements.formOcsStatus, "Filled in from OCS. Check the price you actually paid.", "ok");
    }

    updateDuplicateHint();
    updateAmountHint();
    fields.price.focus();
  } catch (error) {
    setStatus(elements.formOcsStatus, error.message, "error");
  } finally {
    setBusy(elements.formOcsButton, false, "Fill in");
  }
}
