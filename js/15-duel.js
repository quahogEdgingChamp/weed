"use strict";

/* ── Duel: rank what you have by picking the better of two ──────────────

   Stars say how good something was on the day; a duel says which you'd
   rather have. The rules are in core.js (Elo, pairing); this is the dialog
   and the "Your ranking" card in Insights. */

const duel = { pair: null, last: null, undo: [], picks: 0 };

function duelTypeLabel(entry) {
  return TYPE_LABELS[entry.type] || entry.type || "";
}

function duelCard(row, side) {
  const entry = row.entry;
  const bought = row.ids.length > 1 ? ` · bought ${row.ids.length}×` : "";
  /* The latest purchase may not be rated yet; an earlier one may be. */
  const ratedEntry = state.data.products
    .filter((item) => row.ids.includes(item.id) && typeof item.rating === "number")
    .sort((a, b) => String(b.purchaseDate || "").localeCompare(String(a.purchaseDate || "")))[0];
  const rated = ratedEntry ? `you rated it ${formatRating(ratedEntry.rating)}/10` : "not rated";
  return h(
    "button",
    { type: "button", class: "duel-card", "data-side": String(side), onclick: () => pickDuelSide(side) },
    h("span", { class: "duel-key", "aria-hidden": "true", text: side === 0 ? "←" : "→" }),
    duelTypeLabel(entry) ? chip(duelTypeLabel(entry)) : null,
    h("span", { class: "duel-name", text: entry.name }),
    entry.brand ? h("span", { class: "duel-brand", text: entry.brand }) : null,
    h("span", { class: "duel-meta", text: `${rated}${bought}${row.games ? ` · ${plural(row.games, "duel")}` : ""}` })
  );
}

function drawDuel(body) {
  clear(body);
  if (!duel.pair) {
    body.appendChild(h("p", { class: "panel-empty", text: "Duels need at least two products in your collection." }));
    return;
  }
  body.append(
    h("p", { class: "duel-hint", text: "Which would you rather have again? Tap one, or use ← and →. ↓ gives a new pair, U undoes." }),
    h("div", { class: "duel-pair" }, duelCard(duel.pair[0], 0), h("span", { class: "duel-vs", text: "or" }), duelCard(duel.pair[1], 1)),
    h(
      "div",
      { class: "duel-tools" },
      h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: () => nextDuel() }, "New pair"),
      h("button", { type: "button", class: "btn btn-ghost btn-small", disabled: duel.undo.length ? null : true, onclick: () => undoDuel() }, "Undo"),
      h("span", { class: "duel-count", text: duel.picks ? `${plural(duel.picks, "pick")} this time` : "" })
    )
  );
}

let duelBody = null;

function nextDuel() {
  duel.pair = Core.pickDuel(state.data.products, { last: duel.pair ? duel.pair.map((row) => row.key) : null });
  if (duelBody) drawDuel(duelBody);
}

/* Writes the new scores onto every purchase of both products, remembering
   the old ones for Undo. The page redraws when the dialog closes. */
function pickDuelSide(side) {
  if (!duel.pair) return;
  const winner = duel.pair[side];
  const loser = duel.pair[1 - side];
  const result = Core.duelOutcome(winner, loser);
  const before = [];
  const now = new Date().toISOString();
  commit(
    (data) => {
      data.products = data.products.map((item) => {
        const key = Core.duelKey(item);
        const next = key === winner.key ? result.winner : key === loser.key ? result.loser : null;
        if (!next) return item;
        before.push({ id: item.id, duelRating: item.duelRating, duelGames: item.duelGames });
        return { ...item, duelRating: next.rating, duelGames: next.games, updatedAt: now };
      });
    },
    { render: false }
  );
  duel.undo.push(before);
  duel.picks += 1;
  announce(`${winner.entry.name} wins.`);
  nextDuel();
}

function undoDuel() {
  const before = duel.undo.pop();
  if (!before) return;
  const byId = new Map(before.map((row) => [row.id, row]));
  const now = new Date().toISOString();
  commit(
    (data) => {
      data.products = data.products.map((item) => {
        const old = byId.get(item.id);
        if (!old) return item;
        const { duelRating, duelGames, ...rest } = item;
        return { ...rest, ...(typeof old.duelRating === "number" ? { duelRating: old.duelRating, duelGames: old.duelGames } : {}), updatedAt: now };
      });
    },
    { render: false }
  );
  duel.picks = Math.max(0, duel.picks - 1);
  announce("Last pick undone.");
  if (duelBody) drawDuel(duelBody);
}

function duelKeys(event) {
  if (!duelBody || isEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  const actions = { ArrowLeft: () => pickDuelSide(0), ArrowRight: () => pickDuelSide(1), ArrowDown: () => nextDuel(), u: () => undoDuel(), U: () => undoDuel() };
  if (actions[event.key]) {
    event.preventDefault();
    actions[event.key]();
  }
}

async function openDuel() {
  duel.undo = [];
  duel.picks = 0;
  duel.pair = null;
  duelBody = h("div", { class: "duel" });
  nextDuel();
  document.addEventListener("keydown", duelKeys);
  try {
    await openDialog({ title: "Duel", body: duelBody, wide: true, actions: [{ label: "Done", value: "done", variant: "primary" }] });
  } finally {
    document.removeEventListener("keydown", duelKeys);
    duelBody = null;
    renderAll();
    if (duel.picks) showToast(`${plural(duel.picks, "pick")} saved to your ranking.`);
  }
}

/* Insights: the ranking so far. */
function renderDuelRanking(entries) {
  const container = clear(elements.duelList);
  const rows = Core.duelStandings(entries)
    .filter((row) => row.games > 0)
    .sort((a, b) => b.rating - a.rating);
  elements.duelButton.disabled = Core.duelStandings(entries).length < 2;
  if (!rows.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "No duels yet. Start one: a few picks per product and the order settles." }));
    return;
  }
  container.appendChild(
    h(
      "table",
      { class: "mini-table" },
      h("thead", null, h("tr", null, h("th", { scope: "col", class: "num", text: "#" }), h("th", { scope: "col", text: "Product" }), h("th", { scope: "col", text: "Type" }), h("th", { scope: "col", class: "num", text: "Score" }), h("th", { scope: "col", class: "num", text: "Duels" }))),
      h(
        "tbody",
        null,
        rows.slice(0, 12).map((row, index) =>
          h(
            "tr",
            null,
            h("td", { class: "num", text: String(index + 1) }),
            h("td", null, h("button", { type: "button", class: "name-link", onclick: () => openDetail(row.entry.id) }, row.entry.name)),
            h("td", { text: duelTypeLabel(row.entry) }),
            h("td", { class: "num", text: String(Math.round(row.rating)) }),
            h("td", { class: "num", text: String(row.games) })
          )
        )
      )
    )
  );
}
