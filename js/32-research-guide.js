"use strict";

/* ── Report ────────────────────────────────────────────────────────────── */

async function showReport(name) {
  if (ui.reportName === name && ui.report) {
    refreshOwnership();
    return;
  }
  ui.reportName = name;
  ui.report = null;
  ui.reportError = "";
  ui.filters = { q: "", tier: "", lean: "", plant: "", use: "", brand: "", terp: "", solo: false, sort: "score", online: false };
  ui.brandQuery = "";
  researchRoot.innerHTML = `<div class="rs-loading"><span class="spinner" aria-hidden="true"></span> Loading guide…</div>`;
  try {
    const { report } = await api(`${API}/reports/${encodeURIComponent(name)}`);
    if (ui.reportName !== name) return;
    ui.report = prepare(report);
    if (report.kind === "question") drawAnswer();
    else drawReport();
  } catch (error) {
    if (ui.reportName !== name) return;
    researchRoot.innerHTML = `<div class="rs-home"><button class="btn btn-ghost rs-back" type="button" data-home>← All research</button>
      <p class="rs-error">${esc(error.message)}</p></div>`;
  }
}

const GOOD_FOR = {
  daytime: "Daytime",
  night: "Night",
  sleep: "Sleep",
  focus: "Focus",
  creative: "Creative",
  social: "Social",
  relax: "Unwind",
  body: "Body high",
  solo: "Solo sessions",
  beginners: "Beginner-friendly",
  heavy: "Heavy hitter",
};
const SOLO_FIT = { great: "Great", good: "Good", mixed: "Mixed", poor: "Poor", unknown: "Not enough to tell" };
const SOLO_RANK = { great: 0, good: 1, mixed: 2, unknown: 3, poor: 4 };
const TIME_LABEL = { day: "Daytime", evening: "Evening", night: "Night", any: "Any time" };
const NEW_DAYS = 90;

/* The terpene notes live in core.js, so the Collection, Shopping list and
   Research all say the same thing about each one. */
const TERPENES = Core.TERPENES;
const terpKey = Core.terpeneKey;
const terpName = Core.terpeneName;

/* Indica / sativa / hybrid: OCS's label first ("Indica Dominant"), else what
   people reported. */
function plantOf(p) {
  const raw = String(p.ocs?.plant || "").toLowerCase();
  if (raw.includes("indica")) return "indica";
  if (raw.includes("sativa")) return "sativa";
  if (raw.includes("hybrid")) return "hybrid";
  if (raw.includes("blend")) return "blend";
  return ["indica", "sativa", "hybrid", "balanced"].includes(p.lean) ? p.lean : "";
}

function plantBadge(kind, source) {
  if (!kind) return "";
  const label = { indica: "Indica", sativa: "Sativa", hybrid: "Hybrid", blend: "Blend", balanced: "Balanced" }[kind];
  return `<span class="rs-plant rs-plant-${kind}" title="${esc(source || "")}">${label}${source && /dominant/i.test(source) ? "-dominant" : ""}</span>`;
}

function isNew(created, report) {
  if (!created) return false;
  const end = Date.parse(report.window?.to || report.createdAt || Date.now());
  return end - Date.parse(created) <= NEW_DAYS * 86400000;
}

function soloBlock(p) {
  const solo = p.solo;
  if (!solo || !solo.fit || solo.fit === "unknown") return "";
  return `<p class="rs-solo rs-solo-${esc(solo.fit)}"><span class="rs-solo-label">Solo sessions</span>
    <span class="rs-solo-fit">${esc(SOLO_FIT[solo.fit] || solo.fit)}</span>${solo.why ? ` <span class="rs-solo-why">${esc(solo.why)}</span>` : ""}</p>`;
}

function goodForChips(p) {
  return (p.good_for || [])
    .filter((tag) => GOOD_FOR[tag])
    .map((tag) => `<span class="rs-use${tag === "solo" ? " rs-solo" : ""}">${esc(GOOD_FOR[tag])}</span>`)
    .join("");
}

function prepare(report) {
  const guide = report.guide || {};
  const mentionByBrand = new Map();
  for (const row of report.mentions?.brands || []) mentionByBrand.set(brandKey(row.brand), row);
  const catalogByBrand = new Map();
  for (const row of report.catalog || []) {
    const key = brandKey(row.brand);
    if (!catalogByBrand.has(key)) catalogByBrand.set(key, []);
    catalogByBrand.get(key).push(row);
  }
  for (const p of guide.products || []) {
    p._ppg = perGram(p.ocs);
    p._thc = p.ocs && p.ocs.thcMax != null ? p.ocs.thcMax : -1;
    p._mention = mentionByBrand.get(brandKey(p.brand)) || null;
    p._plant = plantOf(p);
    p._new = isNew(p.ocs?.created, report);
    p._terps = [...new Set((p.ocs?.terpenes || []).map(terpKey).filter(Boolean))];
    p._haystack = [p.brand, p.name, p.kind, p.flavour, p.effects, p.high, p.verdict, p.hardware, p.ocs?.genetics,
      ...(p.ocs?.terpenes || []), ...p._terps.map(terpName), ...(p.pros || []), ...(p.cons || []), ...(p.good_for || []).map((t) => GOOD_FOR[t])]
      .join(" ")
      .toLowerCase();
  }
  for (const b of guide.brands || []) {
    b._mention = mentionByBrand.get(brandKey(b.brand)) || null;
    const rows = catalogByBrand.get(brandKey(b.brand)) || [];
    const prices = rows.map((r) => r.price).filter((v) => typeof v === "number");
    b._ocs = {
      count: rows.length,
      online: rows.filter((r) => r.online).length,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
    };
    b._products = (guide.products || []).filter((p) => brandKey(p.brand) === brandKey(b.brand));
  }
  report.threads = report.threads || {};
  return report;
}

function drawReport() {
  const r = ui.report;
  const g = r.guide || {};
  const s = r.stats || {};
  const quotes = (g.products || []).reduce((n, p) => n + (p.quotes || []).length, 0);
  const sections = [
    ["picks", "Quick picks", (g.quick_picks || []).length],
    ["trends", "Trends", (g.trends || []).length || (r.mentions?.months || []).length],
    ["brands", "Brands", (g.brands || []).length],
    ["rankings", "Rankings", (g.products || []).length],
    ["terpenes", "Terpenes", terpeneCounts(g.products || []).length],
    ["chart", "Price vs score", (g.products || []).some((p) => p._ppg)],
    ["compare", "Compare", (g.products || []).length],
    ["avoid", "Skip these", (g.avoid || []).length],
    ["tips", "Tips", (g.tips || []).length],
    ["glossary", "Glossary", (g.glossary || []).length],
    ["faq", "FAQ", (g.faq || []).length],
    ["method", "Method", true],
  ].filter(([, , present]) => present);

  researchRoot.innerHTML = `
    <article class="rs-report" aria-labelledby="research-heading">
      <div class="rs-report-top">
        <button class="btn btn-ghost btn-small rs-back" type="button" data-home>← All research</button>
        <div class="rs-report-actions">
          ${(g.products || []).length ? `<button class="btn btn-primary btn-small" type="button" data-act="deck"
            title="Go through the products one at a time: shopping list, must try, or not for me">Sort through</button>` : ""}
          ${archiveThisButton()}
          ${READ_ONLY ? "" : `<button class="btn btn-secondary btn-small" type="button" data-act="rerun">
            <svg class="icon" aria-hidden="true"><use href="#i-refresh" /></svg> Run again
          </button>
          <button class="btn btn-ghost btn-small" type="button" data-delete="${esc(ui.reportName)}">
            <svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg><span class="sr-only">Delete this guide</span>
          </button>`}
        </div>
      </div>

      <header class="rs-hero">
        <p class="rs-eyebrow">${esc(r.topic?.label)} · community guide</p>
        <h1 id="research-heading">${esc(g.headline || r.topic?.label)}</h1>
        ${g.lede ? `<p class="rs-lede">${esc(g.lede)}</p>` : ""}
        <p class="rs-hint">${esc(when(r.createdAt))} · Reddit ${esc(r.window?.from)} to ${esc(r.window?.to)} ·
          ${esc(writtenBy(r.writer?.by, r.writer?.model, r.writer?.effort))}</p>
        <dl class="rs-stats">
          ${[
            [s.postsScanned, "posts scanned"],
            [s.postsRelevant, "on this topic"],
            ...readStats(s),
            [s.ocsTopicProducts, "OCS products in category"],
            [quotes, "verified quotes"],
          ]
            .map(([n, label]) => `<div><dd>${Number(n || 0).toLocaleString()}</dd><dt>${label}</dt></div>`)
            .join("")}
        </dl>
      </header>

      <nav class="rs-toc" aria-label="Guide sections">
        ${sections.map(([id, label]) => `<button type="button" data-jump="rs-${id}">${label}</button>`).join("")}
      </nav>

      ${sectionPicks(g)}
      ${sectionTrends(r, g)}
      ${sectionBrands(r, g)}
      ${sectionRankings(g)}
      ${sectionTerpenes(g)}
      ${sectionChart(g)}
      ${sectionCompare(g)}
      ${sectionAvoid(r, g)}
      ${sectionTips(g)}
      ${sectionGlossary(g)}
      ${sectionFaq(g)}
      ${sectionMethod(r)}

      <p class="rs-foot">Independent notes from public Reddit discussion and the OCS catalog. Not medical advice.
      Cannabis is for adults 19+ in Ontario; buy from OCS or a licensed store. Quotes belong to their authors.</p>
    </article>`;

  drawCards();
  drawBrands();
  drawTable();
  drawScatter();
  drawVolume();
  refreshOwnership();
  spySection();
}

/* The section menu sticks under the app bar, so it is one tap away however
   far down the guide you are. It marks the section being read and keeps
   that button in view when the menu scrolls sideways on a phone. */
const appbar = document.getElementById("appbar");
if (appbar && "ResizeObserver" in window) {
  new ResizeObserver(() => document.documentElement.style.setProperty("--appbar-h", `${appbar.offsetHeight}px`)).observe(appbar);
}
let spyFrame = 0;

function spySection() {
  spyFrame = 0;
  const toc = researchRoot.querySelector(".rs-toc");
  if (!toc || toc.offsetParent === null) return;
  const box = toc.getBoundingClientRect();
  const buttons = [...toc.querySelectorAll("[data-jump]")];
  let current = null;
  for (const button of buttons) {
    const target = document.getElementById(button.dataset.jump);
    if (target && target.getBoundingClientRect().top <= box.bottom + 24) current = button;
  }
  toc.classList.toggle("is-stuck", box.top <= (appbar?.offsetHeight || 0) + 1 && window.scrollY > 0);
  if (current?.getAttribute("aria-current")) return;
  for (const button of buttons) button.removeAttribute("aria-current");
  if (!current) return;
  current.setAttribute("aria-current", "true");
  toc.scrollTo({ left: current.offsetLeft - (toc.clientWidth - current.offsetWidth) / 2, behavior: "smooth" });
}

window.addEventListener("scroll", () => {
  if (!spyFrame) spyFrame = window.requestAnimationFrame(spySection);
}, { passive: true });

function section(id, title, note, body) {
  return `<section class="rs-section" id="rs-${id}" aria-labelledby="rs-${id}-h">
    <h2 class="rs-h2" id="rs-${id}-h">${title}</h2>
    ${note ? `<p class="rs-note">${note}</p>` : ""}
    ${body}
  </section>`;
}

const PICK_ICON = [
  [/skip|avoid/i, "!"],
  [/solo/i, "◆"],
  [/night|sleep|evening/i, "☾"],
  [/day|morning/i, "☀"],
  [/value|cheap|budget|price/i, "$"],
  [/flavou?r|taste|terp/i, "✿"],
  [/strong|potent|hardest/i, "⚡"],
  [/beginner|first/i, "✦"],
  [/overall|best/i, "★"],
];

function sectionPicks(g) {
  const picks = g.quick_picks || [];
  if (!picks.length) return "";
  const byId = new Map((g.products || []).map((p) => [p.id, p]));
  return section(
    "picks",
    "Quick picks",
    "",
    `<div class="rs-picks">${picks
      .map((pick) => {
        const skip = /skip|avoid/i.test(pick.label);
        const solo = /solo/i.test(pick.label);
        const icon = (PICK_ICON.find(([rx]) => rx.test(pick.label)) || [null, "•"])[1];
        const p = byId.get(pick.product);
        const target = p ? `data-jump="rs-p-${esc(p.id)}"` : "";
        const facts = p
          ? [plantBadge(p._plant, p.ocs?.plant), p.ocs && thcText(p.ocs) !== "—" ? `<span class="rs-fact-chip">THC ${esc(thcText(p.ocs))}</span>` : "",
             p.ocs && typeof p.ocs.price === "number" ? `<span class="rs-fact-chip">${money(p.ocs.price)} / ${esc(p.ocs.size)}</span>` : "",
             tierBadge(p.tier)].join("")
          : "";
        return `<div class="rs-pick${skip ? " rs-pick-skip" : ""}${solo ? " rs-solo" : ""}">
          <p class="rs-pick-label"><span class="rs-pick-icon" aria-hidden="true">${icon}</span>${esc(pick.label)}</p>
          ${
            target
              ? `<button type="button" class="rs-pick-name" ${target}>${esc(pick.pick)}</button>`
              : `<p class="rs-pick-name">${esc(pick.pick)}</p>`
          }
          ${facts ? `<div class="rs-pick-facts">${facts}</div>` : ""}
          <p class="rs-pick-why">${esc(pick.why)}</p>
        </div>`;
      })
      .join("")}</div>`
  );
}

function sectionTrends(r, g) {
  const trends = g.trends || [];
  const months = r.mentions?.months || [];
  if (!trends.length && !months.length) return "";
  const cards = trends
    .map(
      (t) => `<div class="rs-trend-card" data-direction="${esc(t.direction)}">
        <div class="rs-trend-top">${trendChip(t.direction)}${t.when ? `<span class="rs-hint">${esc(t.when)}</span>` : ""}</div>
        <h3>${esc(t.title)}</h3>
        <p>${esc(t.detail)}</p>
        ${t.means ? `<p class="rs-means"><strong>For you:</strong> ${esc(t.means)}</p>` : ""}
        ${(t.brands || []).length ? `<div class="rs-brand-chips">${t.brands.map((b) => `<button type="button" class="rs-brand-chip" data-brand-filter="${esc(b)}">${esc(b)}</button>`).join("")}</div>` : ""}
        ${threadLinks(r, t.threads)}
      </div>`
    )
    .join("");
  const chart = months.length
    ? `<figure class="rs-figure">
        <figcaption><strong>Posts about ${esc(r.topic.label.toLowerCase())}, by month</strong>
        <span class="rs-hint">${months.length > 1 ? "The last month is partial." : ""}</span></figcaption>
        <div class="rs-chart-wrap" id="rs-volume"></div>
      </figure>`
    : "";
  return section(
    "trends",
    "What's changing",
    "",
    `<div class="rs-trend-grid">${cards}</div>${moversPanel(r)}${newOnOcsPanel(r)}${chart}`
  );
}

/* Brands whose share of the conversation moved: last 90 days vs before.
   Counted, not the model's opinion. */
function moversPanel(r) {
  const rows = (r.mentions?.brands || []).filter((b) => b.inTopic !== false && b.mentions >= 3);
  const rising = rows.filter((b) => b.trend === "rising" || b.trend === "new").sort((a, b) => b.recent - a.recent).slice(0, 6);
  const falling = rows.filter((b) => b.trend === "falling").sort((a, b) => b.mentions - a.mentions).slice(0, 6);
  if (!rising.length && !falling.length) return "";
  const list = (items, empty) =>
    items.length
      ? `<ul class="rs-movers">${items
          .map(
            (b) => `<li><button type="button" class="rs-mover-name" data-brand-filter="${esc(b.brand)}" title="${esc(b.brand)}">${esc(b.brand)}</button>
              ${sparkline(b.months) || "<span></span>"}
              <span class="rs-mover-count">${num(b.recent)}</span>
              <span class="rs-mover-of" title="${num(b.recent)} of ${num(b.mentions)} mentions in the last 90 days"><span class="rs-of-long">of ${num(b.mentions)} mentions in the last 90 days</span><span class="rs-of-short">of ${num(b.mentions)} · 90d</span></span></li>`
          )
          .join("")}</ul>`
      : `<p class="rs-hint">${empty}</p>`;
  return `<div class="rs-movers-grid">
    <div class="rs-movers-card"><h3>${trendChip("rising")} Talked about more</h3>${list(rising, "Nobody is clearly rising.")}</div>
    <div class="rs-movers-card"><h3>${trendChip("falling")} Talked about less</h3>${list(falling, "Nobody is clearly cooling off.")}</div>
  </div>`;
}

function newOnOcsPanel(r) {
  const rows = r.newOnOcs || [];
  if (!rows.length) return "";
  return `<div class="rs-new">
    <h3>New on OCS <span class="rs-hint">listed in the last ${NEW_DAYS} days</span></h3>
    <ul class="rs-new-list">${rows
      .slice(0, 12)
      .map(
        (n) => `<li>
          <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(n.brand)}</strong> ${esc(n.title)}</a>
          <span class="rs-new-meta">${plantBadge(plantOf({ ocs: n }), n.plant)}
            ${n.thcMax != null ? `<span class="rs-fact-chip">THC ${esc(thcText(n))}</span>` : ""}
            ${typeof n.price === "number" ? `<span class="rs-fact-chip">${money(n.price)} / ${esc(n.size)}</span>` : ""}
            <span class="rs-hint">${esc(when(n.created))} · ${n.online ? "online" : "stores"} · ${n.mentions ? `brand mentioned ${num(n.mentions)}×` : "not discussed yet"}</span></span>
        </li>`
      )
      .join("")}</ul>
  </div>`;
}

function drawVolume() {
  const box = qs("#rs-volume");
  if (!box) return;
  const months = ui.report.mentions.months;
  const volume = ui.report.mentions.volume;
  const max = Math.max(1, ...volume);
  const W = Math.max(280, box.clientWidth || 640);
  const H = 170;
  const pad = { l: 28, r: 8, t: 14, b: 22 };
  const bw = (W - pad.l - pad.r) / months.length;
  const bar = Math.min(bw - 2, 44);
  const ticks = niceTicks(max, 3);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / ticks[ticks.length - 1]);
  const grid = ticks
    .map(
      (t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="rs-grid" />
        <text x="${pad.l - 6}" y="${y(t) + 4}" class="rs-axis" text-anchor="end">${t}</text>`
    )
    .join("");
  const bars = months
    .map((m, i) => {
      const x = pad.l + i * bw + (bw - bar) / 2;
      const top = y(volume[i]);
      const h = Math.max(0, H - pad.b - top);
      const label = `${monthLabel(m, "long")} ${m.slice(0, 4)}: ${volume[i]} posts`;
      return `<g class="rs-bar" tabindex="0" role="img" aria-label="${esc(label)}" data-tip="${esc(label)}">
        <rect class="rs-hit" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" />
        <path d="${roundedTop(x, top, bar, h, 4)}" class="rs-bar-fill" />
        <text x="${x + bar / 2}" y="${H - 6}" class="rs-axis" text-anchor="middle">${monthLabel(m)}</text>
      </g>`;
    })
    .join("");
  box.innerHTML = `<svg class="rs-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}${bars}</svg><div class="rs-tip" hidden></div>`;
}

function roundedTop(x, y, w, h, r) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function niceTicks(max, count) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let t = 0; t <= max + step * 0.999; t += step) ticks.push(Math.round(t * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function sparkline(values) {
  if (!values || values.length < 2) return "";
  const max = Math.max(1, ...values);
  const W = 84;
  const H = 22;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (W - 4) + 2},${H - 2 - (v / max) * (H - 4)}`);
  return `<svg class="rs-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts.join(" ")}" /><circle cx="${pts[pts.length - 1].split(",")[0]}" cy="${pts[pts.length - 1].split(",")[1]}" r="2.5" /></svg>`;
}

function toneMeter(value) {
  if (typeof value !== "number") return "";
  const pct = Math.round(Math.abs(value) * 50);
  const side = value >= 0 ? "pos" : "neg";
  const label = value > 0.25 ? "mostly positive" : value < -0.25 ? "mostly negative" : "mixed";
  return `<span class="rs-tone" title="Keyword tone ${value.toFixed(2)} (−1 to +1)">
    <span class="rs-tone-track"><span class="rs-tone-fill rs-tone-${side}" style="width:${pct}%"></span></span>
    <span class="rs-tone-text">${label}</span></span>`;
}

function sectionBrands(r, g) {
  if (!(g.brands || []).length) return "";
  return section(
    "brands",
    "Brand report cards",
    "Tier, notes and best pick are the guide's reading of the threads; mentions, the monthly line and tone are counted; products and prices come from OCS.",
    `<div class="rs-controls">
      <label class="rs-search"><span class="sr-only">Search brands</span>
        <svg class="icon" aria-hidden="true"><use href="#i-search" /></svg>
        <input type="search" id="rs-bq" placeholder="Find a brand…" value="${esc(ui.brandQuery)}" /></label>
      <label class="select"><span class="sr-only">Sort brands</span><select id="rs-bsort">
        ${[
          ["tier", "Best first"],
          ["mentions", "Most talked about"],
          ["trend", "Rising first"],
          ["price", "Cheapest on OCS"],
          ["name", "A–Z"],
        ]
          .map(([v, l]) => `<option value="${v}" ${ui.brandSort === v ? "selected" : ""}>${l}</option>`)
          .join("")}
      </select></label>
    </div>
    <div id="rs-brand-cards" class="rs-brand-cards"></div>`
  );
}

const TREND_RANK = { new: 0, rising: 1, steady: 2, falling: 3 };

function drawBrands() {
  const box = qs("#rs-brand-cards");
  if (!box) return;
  const q = ui.brandQuery.trim().toLowerCase();
  const sorts = {
    tier: (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (b._mention?.mentions || 0) - (a._mention?.mentions || 0),
    mentions: (a, b) => (b._mention?.mentions || 0) - (a._mention?.mentions || 0),
    trend: (a, b) => (TREND_RANK[a.trend] ?? 9) - (TREND_RANK[b.trend] ?? 9) || TIER_ORDER[a.tier] - TIER_ORDER[b.tier],
    price: (a, b) => (a._ocs.min ?? Infinity) - (b._ocs.min ?? Infinity),
    name: (a, b) => a.brand.localeCompare(b.brand),
  };
  const brands = (ui.report.guide.brands || [])
    .filter((b) => !q || `${b.brand} ${b.known_for || ""} ${b.summary || ""}`.toLowerCase().includes(q))
    .sort(sorts[ui.brandSort] || sorts.tier);
  box.innerHTML = brands.length
    ? brands.map(brandCard).join("")
    : `<p class="rs-empty">No brand matches “${esc(ui.brandQuery)}”.</p>`;
}

function brandCard(b) {
  const m = b._mention;
  const o = b._ocs;
  const priceRange =
    o.min == null ? "" : o.min === o.max ? money(o.min) : `${money(o.min)}–${money(o.max)}`;
  const split = (text) =>
    String(text || "")
      .split(/;\s+|\.\s+(?=[A-Z])/)
      .map((x) => x.trim().replace(/\.$/, ""))
      .filter(Boolean);
  const good = split(b.strengths);
  const bad = split(b.weaknesses);
  const best = b.best_pick ? b._products.find((p) => p.name === b.best_pick) || b._products[0] : null;
  return `<article class="card rs-brand-card" data-tier="${esc(b.tier)}">
    <header class="rs-brand-head">
      <div>
        <h3 class="rs-brand-title">${esc(b.brand)}</h3>
        ${b.known_for ? `<p class="rs-known">${esc(b.known_for)}</p>` : ""}
      </div>
      ${tierBadge(b.tier, { big: true })}
    </header>
    <div class="rs-brand-stats">
      ${trendChip(b.trend)}
      ${b.consistency && b.consistency !== "unknown" ? `<span class="rs-consistency rs-consistency-${esc(b.consistency)}">${esc(b.consistency)}</span>` : ""}
      ${m ? `<span class="rs-num">${num(m.mentions)} mentions <span class="rs-hint">· ${num(m.threads)} threads</span></span>${sparkline(m.months)}` : ""}
      ${m ? toneMeter(m.sentiment) : ""}
    </div>
    ${
      o.count
        ? `<p class="rs-brand-ocs"><strong>${num(o.count)}</strong> on OCS in this category · ${num(o.online)} online${
            priceRange ? ` · <span class="private">${esc(priceRange)}</span>` : ""
          }</p>`
        : ""
    }
    ${
      good.length || bad.length
        ? `<div class="rs-pc">
      <div class="rs-pros"><h4>Good</h4><ul>${good.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div class="rs-cons"><h4>Watch for</h4><ul>${bad.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>`
        : ""
    }
    ${b.summary ? `<p class="rs-brand-summary">${esc(b.summary)}</p>` : ""}
    ${b.price ? `<p class="rs-hint"><strong>Price:</strong> ${esc(b.price)}</p>` : ""}
    <div class="rs-actions">
      ${
        best
          ? `<button class="btn btn-secondary btn-small" type="button" data-jump="rs-p-${esc(best.id)}">Best pick: ${esc(b.best_pick || best.name)}</button>`
          : b.best_pick
            ? `<span class="rs-hint">Best pick: ${esc(b.best_pick)}</span>`
            : ""
      }
      ${b._products.length ? `<button class="btn btn-ghost btn-small" type="button" data-brand-filter="${esc(b.brand)}">See ${num(b._products.length)} ranked</button>` : ""}
    </div>
  </article>`;
}
