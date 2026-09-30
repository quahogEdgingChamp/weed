"use strict";

/* ── Guide deck: go through a guide's products one at a time ─────────────

   Swipe (or press) → to put it on the shopping list, ↑ for a must-try (on
   the list at high priority), ← for "not for me", ↓ to skip for now; U
   undoes, Esc closes. Best tier first; products already owned or on the
   list, and ones decided before, are left out. Decisions are remembered
   per guide in this browser, so the next visit starts where this one
   stopped. */

const DECK_KEY = "cloudline-research-deck-v1";
const DECK_ACTIONS = {
  no: { key: "ArrowLeft", label: "Not for me", hint: "←", fly: [-1, 0] },
  skip: { key: "ArrowDown", label: "Skip", hint: "↓", fly: [0, 1] },
  must: { key: "ArrowUp", label: "Must try", hint: "↑", fly: [0, -1] },
  list: { key: "ArrowRight", label: "Shopping list", hint: "→", fly: [1, 0] },
};
const deck = { el: null, queue: [], index: 0, undo: [], counts: { list: 0, must: 0, no: 0 }, busy: false, drag: null };

function deckMemory() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DECK_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    return {};
  }
}

function rememberDeck(id, decision) {
  const memory = deckMemory();
  const guide = { ...(memory[ui.reportName] || {}) };
  if (decision) guide[id] = decision;
  else delete guide[id];
  memory[ui.reportName] = guide;
  try {
    window.localStorage.setItem(DECK_KEY, JSON.stringify(memory));
  } catch (error) {
    /* Not remembered; the deck still works for this visit. */
  }
}

/* The guide's products still worth a look, best first. */
function deckQueue() {
  const decided = deckMemory()[ui.reportName] || {};
  const bridge = window.Cloudline;
  return (ui.report?.guide?.products || [])
    .filter((p) => !decided[p.id])
    .filter((p) => {
      const own = p.ocs && bridge ? bridge.researchOwnership(p.ocs.url) : null;
      return !(own && (own.owned || own.onList));
    })
    .sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || (b.score || 0) - (a.score || 0));
}

function deckCard(p) {
  const o = p.ocs;
  const quote = (p.quotes || [])[0];
  const facts = [
    o?.price != null ? `${money(o.price)}${o.size ? ` · ${o.size}` : ""}` : "",
    o ? thcText(o) + " THC" : "",
    p.strength && p.strength !== "unknown" ? p.strength : "",
  ].filter(Boolean);
  return `<article class="rs-deck-card" aria-live="polite">
    <div class="rs-deck-top">${tierBadge(p.tier, { big: true })}
      <div><p class="rs-eyebrow">${esc(p.kind || "")}</p>
      <h2 id="rs-deck-name">${esc(p.brand)} · ${esc(p.name)}</h2></div></div>
    <div class="rs-deck-tags">${plantBadge(p._plant, o?.plant)}${facts.map((f) => `<span class="chip">${esc(f)}</span>`).join("")}</div>
    ${p.high ? `<p>${esc(p.high)}</p>` : ""}
    <p class="rs-verdict">${esc(p.verdict || "")}</p>
    ${quote ? `<blockquote class="rs-quote"><p>“${esc(quote.text)}”</p></blockquote>` : ""}
  </article>`;
}

function drawDeck() {
  const box = deck.el.querySelector(".rs-deck-stage");
  const p = deck.queue[deck.index];
  const left = deck.queue.length - deck.index;
  deck.el.querySelector(".rs-deck-count").textContent = p ? ` · ${deck.index + 1} of ${deck.queue.length}` : "";
  deck.el.querySelector("[data-deck-undo]").disabled = !deck.undo.length;
  for (const button of deck.el.querySelectorAll("[data-deck]")) button.disabled = !p;
  if (!p) {
    const { list, must, no } = deck.counts;
    box.innerHTML = `<div class="rs-deck-card rs-deck-end">
      <h2 id="rs-deck-name">${deck.queue.length ? "That's all of them" : "Nothing left to sort"}</h2>
      <p>${deck.queue.length
        ? `${list + must ? `${list + must} added to your shopping list${must ? ` (${must} must-try)` : ""}. ` : ""}${no ? `${no} passed on.` : ""}`
        : "Everything in this guide is already on your list, in your collection, or decided on before."}</p>
      <button class="btn btn-primary" type="button" data-deck-close>Back to the guide</button>
    </div>`;
    box.querySelector("[data-deck-close]").focus();
    return;
  }
  box.innerHTML = deckCard(p);
  box.dataset.left = String(left);
}

async function decideDeck(action) {
  const p = deck.queue[deck.index];
  if (!p || deck.busy) return;
  deck.busy = true;
  const card = deck.el.querySelector(".rs-deck-card");
  const [x, y] = DECK_ACTIONS[action].fly;
  if (card && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    card.style.transition = "transform 0.22s ease-in, opacity 0.22s";
    card.style.transform = `translate(${x * 120}%, ${y * 120}%) rotate(${x * 12}deg)`;
    card.style.opacity = "0";
  }
  let wishId = null;
  try {
    if (action === "list" || action === "must") {
      const result = await window.Cloudline?.addResearchPick({
        url: p.ocs?.url || "",
        name: p.ocs?.title || p.name,
        brand: p.brand,
        price: p.ocs?.price ?? null,
        note: `${ui.report.topic.label} guide: ${p.tier === "AVOID" ? "Avoid" : `${p.tier} tier`}, ${Number(p.score || 0).toFixed(1)}/10. ${p.verdict || ""}`.slice(0, 1900),
        priority: action === "must" ? "high" : "normal",
        quiet: true,
      });
      wishId = result?.status === "added" ? result.id : null;
    }
    if (action !== "skip") {
      rememberDeck(p.id, action);
      deck.counts[action] += 1;
    }
    deck.undo.push({ index: deck.index, id: p.id, action, wishId });
    deck.index += 1;
    await new Promise((resolve) => window.setTimeout(resolve, card?.style.transition ? 200 : 0));
    drawDeck();
  } finally {
    deck.busy = false;
  }
}

function undoDeck() {
  const last = deck.undo.pop();
  if (!last || deck.busy) return;
  if (last.wishId) window.Cloudline?.removeResearchPick(last.wishId);
  if (last.action !== "skip") {
    rememberDeck(last.id, null);
    deck.counts[last.action] -= 1;
  }
  deck.index = last.index;
  drawDeck();
}

/* Drag the card: past a quarter of its width (or up/down past 90 px) it
   goes that way; otherwise it springs back. */
function deckPointer(event) {
  const card = event.target.closest(".rs-deck-card:not(.rs-deck-end)");
  if (event.type === "pointerdown") {
    if (!card || event.button !== 0 || deck.busy) return;
    deck.drag = { x: event.clientX, y: event.clientY, card, width: card.offsetWidth };
    card.setPointerCapture(event.pointerId);
    card.style.transition = "none";
    return;
  }
  const drag = deck.drag;
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (event.type === "pointermove") {
    drag.card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
    return;
  }
  deck.drag = null;
  const action =
    Math.abs(dx) > drag.width / 4 && Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "list" : "no")
    : Math.abs(dy) > 90 ? (dy < 0 ? "must" : "skip")
    : null;
  if (action && event.type === "pointerup") {
    decideDeck(action);
  } else {
    drag.card.style.transition = "transform 0.2s";
    drag.card.style.transform = "";
  }
}

function deckKeys(event) {
  if (!deck.el || event.ctrlKey || event.metaKey || event.altKey) return;
  const action = Object.keys(DECK_ACTIONS).find((name) => DECK_ACTIONS[name].key === event.key);
  if (action) {
    event.preventDefault();
    decideDeck(action);
  } else if (event.key === "u" || event.key === "U") {
    event.preventDefault();
    undoDeck();
  }
}

function openDeck() {
  if (deck.el) return;
  deck.queue = deckQueue();
  deck.index = 0;
  deck.undo = [];
  deck.counts = { list: 0, must: 0, no: 0 };
  deck.el = document.createElement("div");
  deck.el.className = "rs-deck";
  deck.el.setAttribute("role", "dialog");
  deck.el.setAttribute("aria-modal", "true");
  deck.el.setAttribute("aria-labelledby", "rs-deck-name");
  deck.el.innerHTML = `
    <div class="rs-deck-bar">
      <p class="rs-deck-title">${esc(ui.report.topic?.label || "Guide")}<span class="rs-deck-count"></span></p>
      <button class="btn btn-ghost btn-small" type="button" data-deck-undo>Undo</button>
      <button class="btn btn-icon" type="button" data-deck-close aria-label="Close"><svg class="icon" aria-hidden="true"><use href="#i-close" /></svg></button>
    </div>
    <div class="rs-deck-stage"></div>
    <div class="rs-deck-actions">
      ${Object.entries(DECK_ACTIONS)
        .map(([name, a]) => `<button class="btn ${name === "list" ? "btn-primary" : "btn-secondary"}" type="button" data-deck="${name}">
          <span aria-hidden="true">${a.hint}</span> ${a.label}</button>`)
        .join("")}
    </div>`;
  document.body.appendChild(deck.el);
  deck.el.addEventListener("click", (event) => {
    const t = event.target.closest("button");
    if (!t) return;
    if (t.dataset.deck) decideDeck(t.dataset.deck);
    else if ("deckUndo" in t.dataset) undoDeck();
    else if ("deckClose" in t.dataset) closeDeck();
  });
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) deck.el.addEventListener(type, deckPointer);
  document.addEventListener("keydown", deckKeys);
  drawDeck();
  openModal(deck.el, { onRequestClose: closeDeck });
}

function closeDeck() {
  if (!deck.el) return;
  document.removeEventListener("keydown", deckKeys);
  closeModal(deck.el);
  deck.el.remove();
  deck.el = null;
  refreshOwnership();
  const { list, must, no } = deck.counts;
  if (list + must + no) {
    window.Cloudline?.toast(`${list + must} added to your shopping list${must ? `, ${must} as must-try` : ""}${no ? `; ${no} passed on` : ""}.`);
  }
}
