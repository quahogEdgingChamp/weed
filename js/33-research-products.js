"use strict";

function sectionRankings(g) {
  const products = g.products || [];
  if (!products.length) return "";
  const f = ui.filters;
  const plants = [...new Set(products.map((p) => p._plant).filter(Boolean))];
  const uses = Object.keys(GOOD_FOR).filter((tag) => products.some((p) => (p.good_for || []).includes(tag)));
  const brands = [...new Set(products.map((p) => p.brand))].sort((a, b) => a.localeCompare(b));
  const terps = terpeneCounts(products).map(([key]) => key);
  const hasSolo = products.some((p) => p.solo && ["great", "good"].includes(p.solo.fit));
  const option = (value, label, current) => `<option value="${esc(value)}" ${current === value ? "selected" : ""}>${esc(label)}</option>`;
  return section(
    "rankings",
    `Rankings <span class="rs-count" id="rs-count"></span>`,
    "",
    `<div class="rs-controls">
      <label class="rs-search"><span class="sr-only">Search products</span>
        <svg class="icon" aria-hidden="true"><use href="#i-search" /></svg>
        <input type="search" id="rs-q" placeholder="Brand, strain, terpene, flavour, effect…" value="${esc(f.q)}" /></label>
      <label class="select"><span class="sr-only">Tier</span><select id="rs-f-tier">
        <option value="">All tiers</option>${TIERS.map((t) => option(t, t === "AVOID" ? "Avoid" : `${t} tier`, f.tier)).join("")}
      </select></label>
      ${
        plants.length
          ? `<label class="select"><span class="sr-only">Indica or sativa</span><select id="rs-f-plant">
        <option value="">Indica, sativa, hybrid</option>${plants.map((pl) => option(pl, pl[0].toUpperCase() + pl.slice(1), f.plant)).join("")}
      </select></label>`
          : ""
      }
      ${
        uses.length
          ? `<label class="select"><span class="sr-only">Good for</span><select id="rs-f-use">
        <option value="">Good for anything</option>${uses.filter((u) => u !== "solo").map((u) => option(u, GOOD_FOR[u], f.use)).join("")}
      </select></label>`
          : ""
      }
      ${
        brands.length > 1
          ? `<label class="select"><span class="sr-only">Brand</span><select id="rs-f-brand">
        <option value="">All brands</option>${brands.map((b) => option(b, b, f.brand)).join("")}
      </select></label>`
          : ""
      }
      ${
        terps.length
          ? `<label class="select"><span class="sr-only">Terpene</span><select id="rs-f-terp">
        <option value="">Any terpene</option>${terps.map((k) => option(k, terpName(k), f.terp)).join("")}
      </select></label>`
          : ""
      }
      <label class="select"><span class="sr-only">Sort</span><select id="rs-sort">
        ${[
          ["score", "Best first"],
          ["price", "Cheapest per gram"],
          ["thc", "Strongest THC"],
          ["mentions", "Most talked about"],
          ["new", "Newest on OCS"],
          ["solo", "Solo sessions"],
          ["brand", "Brand A–Z"],
        ]
          .filter(([v]) => v !== "solo" || hasSolo)
          .map(([v, l]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}${v === "solo" ? ' class="rs-solo"' : ""}>${l}</option>`)
          .join("")}
      </select></label>
      <label class="rs-check"><input type="checkbox" id="rs-f-online" ${f.online ? "checked" : ""} /> Sold on ocs.ca</label>
      ${hasSolo ? `<label class="rs-check rs-solo"><input type="checkbox" id="rs-f-solo" ${f.solo ? "checked" : ""} /> Good for solo sessions</label>` : ""}
    </div>
    <div class="rs-tier-key">${TIERS.map((t) => `<span>${tierBadge(t)} ${esc(TIER_TEXT[t])}</span>`).join("")}</div>
    <div id="rs-cards" class="rs-cards"></div>`
  );
}

function filteredProducts() {
  const f = ui.filters;
  const q = f.q.trim().toLowerCase();
  const list = (ui.report.guide.products || []).filter(
    (p) =>
      (!f.tier || p.tier === f.tier) &&
      (!f.lean || p.lean === f.lean) &&
      (!f.plant || p._plant === f.plant) &&
      (!f.use || (p.good_for || []).includes(f.use)) &&
      (!f.brand || p.brand === f.brand) &&
      (!f.terp || p._terps.includes(f.terp)) &&
      (!f.solo || (p.solo && ["great", "good"].includes(p.solo.fit))) &&
      (!f.online || (p.ocs && p.ocs.online)) &&
      (!q || p._haystack.includes(q))
  );
  const byScore = (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score - a.score;
  const sorts = {
    score: byScore,
    price: (a, b) => (a._ppg ?? Infinity) - (b._ppg ?? Infinity) || byScore(a, b),
    thc: (a, b) => b._thc - a._thc || byScore(a, b),
    mentions: (a, b) => (b._mention?.mentions || 0) - (a._mention?.mentions || 0) || byScore(a, b),
    new: (a, b) => String(b.ocs?.created || "").localeCompare(String(a.ocs?.created || "")) || byScore(a, b),
    solo: (a, b) => (SOLO_RANK[a.solo?.fit] ?? 3) - (SOLO_RANK[b.solo?.fit] ?? 3) || byScore(a, b),
    brand: (a, b) => a.brand.localeCompare(b.brand) || byScore(a, b),
  };
  return list.sort(sorts[f.sort] || byScore);
}

function drawCards() {
  const box = qs("#rs-cards");
  if (!box) return;
  const all = ui.report.guide.products || [];
  const list = filteredProducts();
  qs("#rs-count").textContent = list.length === all.length ? `(${all.length})` : `(${list.length} of ${all.length})`;
  box.innerHTML = list.length
    ? list.map(card).join("")
    : `<p class="rs-empty">Nothing matches. <button class="btn btn-ghost btn-small" type="button" data-act="clear-filters">Clear filters</button></p>`;
  refreshOwnership();
}

function card(p) {
  const r = ui.report;
  const o = p.ocs;
  const tags = [
    plantBadge(p._plant, o?.plant),
    p._new ? `<span class="rs-new-badge">New on OCS</span>` : "",
    ...[p.kind, o ? (o.online ? "on ocs.ca" : "stores only") : "not matched to OCS"].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`),
  ].join("");
  const quotes = (p.quotes || [])
    .map(
      (q) => `<blockquote class="rs-quote"><p>“${esc(q.text)}”</p>
        <footer><a href="${esc(threadUrl(r, q.thread, q.comment))}" target="_blank" rel="noopener noreferrer">${esc(
          r.threads[q.thread]?.title || `thread ${q.thread}`
        )}</a>${r.threads[q.thread]?.date ? ` · ${esc(r.threads[q.thread].date)}` : ""}</footer></blockquote>`
    )
    .join("");
  const search = encodeURIComponent(`${p.brand} ${String(p.name).split(/[(/—]/)[0]}`.trim());
  const facts = [
    ["OCS price", o && typeof o.price === "number" ? `<span class="private">${money(o.price)}</span> <span class="rs-hint">/ ${esc(o.size)}</span>` : "—"],
    ["Per gram", p._ppg ? `<span class="private">${money(p._ppg)}</span>` : "—"],
    ["THC", thcText(o)],
    ["CBD", o && o.cbdMax ? `${o.cbdMin === o.cbdMax ? o.cbdMax : `${o.cbdMin}–${o.cbdMax}`}%` : "—"],
    ["Strength", p.strength && p.strength !== "unknown" ? esc(p.strength) : "—"],
    ["Best time", TIME_LABEL[p.best_time] || "—"],
    ["Talked about", p._mention ? `${p._mention.mentions}× <span class="rs-hint">(brand)</span>` : "—"],
  ].filter(([, v]) => v !== "—");
  const details = [
    ["Genetics", o?.genetics ? esc(o.genetics) : ""],
    ["Made by", o ? esc([o.subsub, o.process].filter(Boolean).join(" · ")) : ""],
    ["Producer", o?.producer ? esc(`${o.producer}${o.province ? `, ${o.province}` : ""}`) : ""],
    ["Sizes", o?.sizes?.length > 1 ? o.sizes.map((z) => `${esc(z.size)} <span class="private">${money(z.price)}</span>${z.available ? "" : ' <span class="rs-hint">(out)</span>'}`).join(" · ") : ""],
    ["On OCS since", o?.created ? esc(when(o.created)) : ""],
  ].filter(([, v]) => v);
  const uses = goodForChips(p);
  return `<article class="card rs-card" id="rs-p-${esc(p.id)}" data-tier="${esc(p.tier)}">
    <div class="rs-card-head">
      ${o && o.image ? `<img class="rs-thumb" src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="rs-thumb rs-thumb-empty" aria-hidden="true"></span>`}
      <div class="rs-card-title">
        <p class="rs-eyebrow">${esc(p.brand)}</p>
        <h3>${esc(p.name)}</h3>
        <div class="chip-row">${tags}</div>
      </div>
      <div class="rs-score">${tierBadge(p.tier, { big: true })}<b>${Number(p.score).toFixed(1)}</b><small>/ 10</small></div>
    </div>
    <dl class="rs-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    ${uses ? `<div class="rs-uses"><span class="rs-hint">Good for</span>${uses}</div>` : ""}
    ${p._terps.length ? `<div class="rs-uses"><span class="rs-hint">Terpenes</span>${p._terps.map((k) => terpChip(k)).join("")}</div>` : ""}
    <p class="rs-verdict">${esc(p.verdict)}</p>
    ${
      p.high || p.flavour || p.effects || p.hardware || p.value
        ? `<dl class="rs-fe">${[
            ["The high", p.high || p.effects],
            ["Flavour", p.flavour],
            ["Hardware", p.hardware],
            ["Value", p.value],
          ]
            .filter(([, v]) => v)
            .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
            .join("")}</dl>`
        : ""
    }
    ${soloBlock(p)}
    ${
      (p.pros || []).length || (p.cons || []).length
        ? `<div class="rs-pc">
      <div class="rs-pros"><h4>Pros</h4><ul>${(p.pros || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div class="rs-cons"><h4>Cons</h4><ul>${(p.cons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>`
        : ""
    }
    ${details.length ? `<details class="rs-said"><summary>Product details</summary><dl class="rs-details">${details.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></details>` : ""}
    ${quotes ? `<details class="rs-said"><summary>What people said (${p.quotes.length})</summary>${quotes}</details>` : ""}
    <div class="rs-actions">
      <button class="btn btn-secondary btn-small" type="button" data-add="${esc(p.id)}">
        <svg class="icon" aria-hidden="true"><use href="#i-plus" /></svg> Shopping list
      </button>
      <span class="rs-owned" data-owned="${esc(p.id)}"></span>
      ${o ? `<a class="btn btn-ghost btn-small" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">OCS <svg class="icon" aria-hidden="true"><use href="#i-external" /></svg></a>` : ""}
      <a class="btn btn-ghost btn-small" href="/api/hibuddy?${esc(new URLSearchParams({ name: String(p.name).split(/[(/—]/)[0].trim(), brand: p.brand || "" }))}" target="_blank" rel="noopener noreferrer">Store prices <svg class="icon" aria-hidden="true"><use href="#i-external" /></svg></a>
      <a class="btn btn-ghost btn-small" href="https://www.reddit.com/r/TheOCS/search/?q=${search}&restrict_sr=1&sort=new" target="_blank" rel="noopener noreferrer">Latest posts <svg class="icon" aria-hidden="true"><use href="#i-external" /></svg></a>
    </div>
  </article>`;
}

function refreshOwnership() {
  const bridge = window.Cloudline;
  if (!bridge || !ui.report) return;
  const byId = new Map((ui.report.guide.products || []).map((p) => [p.id, p]));
  for (const slot of qsa("[data-owned]")) {
    const p = byId.get(slot.dataset.owned);
    const own = p && p.ocs ? bridge.researchOwnership(p.ocs.url) : null;
    if (own && own.owned) {
      slot.innerHTML = `<button class="rs-owned-chip" type="button" data-entry="${esc(own.entryId)}">In your collection${
        own.rating != null ? ` · you rated it ${own.rating}/10` : ""
      }</button>`;
    } else if (own && own.onList) {
      slot.innerHTML = `<span class="rs-owned-chip rs-owned-list">On your list</span>`;
    } else {
      slot.innerHTML = "";
    }
  }
}

function sectionChart(g) {
  const points = (g.products || []).filter((p) => p._ppg);
  if (!points.length) return "";
  return section(
    "chart",
    "Price vs score",
    "Each dot is a product with an OCS price. Up and to the left is more loved for less money. Select a dot to jump to its card.",
    `<figure class="rs-figure">
      <div class="rs-legend">${TIERS.filter((t) => points.some((p) => p.tier === t))
        .map((t) => `<span><span class="rs-dot rs-dot-${t}" aria-hidden="true"></span>${t === "AVOID" ? "Avoid" : `${t} tier`}</span>`)
        .join("")}</div>
      <div class="rs-chart-wrap" id="rs-scatter"></div>
    </figure>`
  );
}

function drawScatter() {
  const box = qs("#rs-scatter");
  if (!box) return;
  const points = (ui.report.guide.products || []).filter((p) => p._ppg);
  const W = Math.max(300, Math.min(box.clientWidth || 640, 960));
  const H = W < 480 ? 260 : 320;
  const pad = { l: 40, r: 16, t: 14, b: 38 };
  const maxX = niceTicks(Math.max(...points.map((p) => p._ppg)) * 1.05, 4);
  const minScore = Math.max(0, Math.floor(Math.min(...points.map((p) => p.score)) - 0.5));
  const xTop = maxX[maxX.length - 1];
  const x = (v) => pad.l + ((W - pad.l - pad.r) * v) / xTop;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - minScore) / (10 - minScore));
  const yTicks = [];
  for (let t = minScore; t <= 10; t += 10 - minScore > 5 ? 2 : 1) yTicks.push(t);
  const grid =
    yTicks
      .map(
        (t) => `<line class="rs-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" />
        <text class="rs-axis" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`
      )
      .join("") +
    maxX
      .map((t) => `<text class="rs-axis" x="${x(t)}" y="${H - pad.b + 16}" text-anchor="middle">$${t}</text>`)
      .join("") +
    `<text class="rs-axis rs-axis-title" x="${(W + pad.l) / 2}" y="${H - 4}" text-anchor="middle">OCS price per gram</text>
     <text class="rs-axis rs-axis-title" x="12" y="${pad.t + (H - pad.t - pad.b) / 2}" text-anchor="middle" transform="rotate(-90 12 ${pad.t + (H - pad.t - pad.b) / 2})">Score</text>`;

  /* Many carts share one list price: spread each same-price stack sideways
     a little so every dot stays visible and selectable. */
  const offset = new Map();
  const stacks = new Map();
  for (const p of points) {
    const key = p._ppg.toFixed(2);
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key).push(p);
  }
  for (const stack of stacks.values()) {
    stack.sort((a, b) => b.score - a.score);
    stack.forEach((p, i) => offset.set(p.id, stack.length > 1 ? (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 7 : 0));
  }

  /* Label only the best few, and never two labels on top of each other. */
  const labelled = new Set();
  const placed = [];
  for (const p of [...points].sort((a, b) => b.score - a.score || a._ppg - b._ppg)) {
    if (labelled.size >= (W < 480 ? 2 : 5)) break;
    const lx = x(p._ppg) + offset.get(p.id);
    const ly = y(p.score);
    if (placed.some(([px, py]) => Math.abs(px - lx) < 120 && Math.abs(py - ly) < 16)) continue;
    placed.push([lx, ly]);
    labelled.add(p.id);
  }
  const dots = [...points]
    .sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier])
    .map((p) => {
      const cx = x(p._ppg) + offset.get(p.id);
      const cy = y(p.score);
      const tip = `${p.brand} — ${p.name}: ${p.tier === "AVOID" ? "Avoid" : `${p.tier} tier`}, ${p.score.toFixed(1)}/10, ${money(p._ppg)}/g`;
      const right = cx > W * 0.7;
      return `<g class="rs-point" tabindex="0" role="button" aria-label="${esc(tip)}" data-tip="${esc(tip)}" data-jump="rs-p-${esc(p.id)}">
        <circle class="rs-hit" cx="${cx}" cy="${cy}" r="14" />
        <circle class="rs-dot-mark rs-dot-${esc(p.tier)}" cx="${cx}" cy="${cy}" r="6" />
        ${labelled.has(p.id) ? `<text class="rs-point-label" x="${cx + (right ? -10 : 10)}" y="${cy + 4}" text-anchor="${right ? "end" : "start"}">${esc(shortName(p))}</text>` : ""}
      </g>`;
    })
    .join("");
  box.innerHTML = `<svg class="rs-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}${dots}</svg><div class="rs-tip" hidden></div>`;
}

/* "Fantasm Live Resin 510 Thread Cartridge" -> "Fantasm", for chart labels. */
function shortName(p) {
  const name = String(p.name || "")
    .split(/\s+(?:pure\s+)?(?:live|solventless|cured|fse|510|resin|rosin|cart|cartridge|vape)\b|[(/—,]/i)[0]
    .trim();
  const generic = /^(pure|live|solventless|cured|fse|510|resin|rosin|cart|cartridge|vape)$/i.test(name);
  return name && !generic && name.length <= 24 ? name : p.brand;
}

const COLUMNS = [
  ["tier", "Tier", (p) => tierBadge(p.tier), (p) => TIER_ORDER[p.tier] * 100 - p.score],
  ["score", "Score", (p) => p.score.toFixed(1), (p) => p.score],
  ["brand", "Brand", (p) => esc(p.brand), (p) => p.brand.toLowerCase()],
  ["name", "Product", (p) => esc(p.name), (p) => p.name.toLowerCase()],
  ["plant", "Type", (p) => plantBadge(p._plant, p.ocs?.plant) || "—", (p) => p._plant || "~"],
  ["strength", "Strength", (p) => esc(p.strength && p.strength !== "unknown" ? p.strength : "—"),
    (p) => ({ "very strong": 0, strong: 1, medium: 2, mild: 3 })[p.strength] ?? 4],
  ["time", "Best time", (p) => esc(TIME_LABEL[p.best_time] || "—"), (p) => p.best_time || "~"],
  ["price", "OCS $", (p) => money(p.ocs?.price), (p) => p.ocs?.price ?? Infinity],
  ["size", "Size", (p) => esc(p.ocs?.size || "—"), (p) => grams(p.ocs?.size) ?? Infinity],
  ["ppg", "$ / g", (p) => (p._ppg ? money(p._ppg) : "—"), (p) => p._ppg ?? Infinity],
  ["thc", "THC", (p) => thcText(p.ocs), (p) => p._thc],
  ["where", "Where", (p) => (p.ocs ? (p.ocs.online ? "online" : "stores") : "—"), (p) => (p.ocs ? (p.ocs.online ? 0 : 1) : 2)],
  ["talk", "Mentions", (p) => (p._mention ? p._mention.mentions : "—"), (p) => p._mention?.mentions || 0],
];

function sectionCompare(g) {
  if (!(g.products || []).length) return "";
  return section(
    "compare",
    "Compare",
    "Select a column to sort. Prices are OCS list prices before tax; stores are often a few dollars cheaper. Select a row to open its card.",
    `<div class="rs-table-wrap"><table class="rs-table rs-compare"><thead></thead><tbody></tbody></table></div>`
  );
}

function drawTable() {
  const table = qs(".rs-compare");
  if (!table) return;
  const { key, asc } = ui.table;
  const col = COLUMNS.find((c) => c[0] === key) || COLUMNS[1];
  const rows = [...(ui.report.guide.products || [])].sort((a, b) => {
    const va = col[3](a);
    const vb = col[3](b);
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return asc ? cmp : -cmp;
  });
  table.querySelector("thead").innerHTML = `<tr>${COLUMNS.map(
    ([k, label]) => `<th scope="col" aria-sort="${k === key ? (asc ? "ascending" : "descending") : "none"}">
      <button type="button" data-sort="${k}">${label}${k === key ? `<span aria-hidden="true">${asc ? " ▲" : " ▼"}</span>` : ""}</button></th>`
  ).join("")}</tr>`;
  table.querySelector("tbody").innerHTML = rows
    .map((p) => `<tr data-jump="rs-p-${esc(p.id)}" tabindex="0">${COLUMNS.map((c) => `<td>${c[2](p)}</td>`).join("")}</tr>`)
    .join("");
}

function sectionAvoid(r, g) {
  const items = g.avoid || [];
  if (!items.length) return "";
  return section(
    "avoid",
    "Skip these",
    "",
    `<ul class="rs-avoid">${items
      .map(
        (a) => `<li><span class="rs-avoid-icon" aria-hidden="true">!</span><div><strong>${esc(a.name)}</strong>
        <p>${esc(a.reason)}</p>${threadLinks(r, a.threads)}</div></li>`
      )
      .join("")}</ul>`
  );
}

function sectionTips(g) {
  const tips = g.tips || [];
  if (!tips.length) return "";
  return section(
    "tips",
    "Tips",
    "",
    `<ol class="rs-tips">${tips.map((t) => `<li><h3>${esc(t.title)}</h3><p>${esc(t.body)}</p></li>`).join("")}</ol>`
  );
}

/* [[key, how many products have it]], most common first. */
