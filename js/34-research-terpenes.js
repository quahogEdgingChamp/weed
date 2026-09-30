"use strict";

function terpeneCounts(products) {
  const counts = new Map();
  for (const p of products) for (const key of p._terps || []) counts.set(key, (counts.get(key) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || terpName(a[0]).localeCompare(terpName(b[0])));
}

function terpChip(key) {
  const on = ui.filters.terp === key;
  return `<button type="button" class="rs-use rs-terp-chip${on ? " is-on" : ""}" data-terp-card="${esc(key)}" aria-haspopup="dialog" aria-expanded="false">${esc(terpName(key))}</button>`;
}

/* Tapping a terpene on a card opens the shared terpene card with what this
   guide knows about it, and ways to follow it into Rankings. */
function openTerpCard(anchor, key) {
  const products = ui.report.guide.products || [];
  const withIt = products.filter((p) => p._terps.includes(key)).sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score - a.score);
  const best = withIt[0];
  const on = ui.filters.terp === key;
  const actions = [
    on
      ? { label: "Show every product", run: () => filterTerpene(key, true) }
      : { label: `Show the ${num(withIt.length)} with it`, run: () => filterTerpene(key, false) },
    ...(qs("#rs-terpenes") ? [{ label: "Compare terpenes", run: () => { pickTerpene(key); jumpTo("rs-terpenes"); } }] : []),
  ];
  window.Cloudline?.showTerpene(anchor, key, {
    stats: [
      `In ${num(withIt.length)} of the ${num(products.length)} ranked products in this guide.`,
      best ? `Best rated with it here: ${best.brand} · ${best.name} (${Number(best.score).toFixed(1)}).` : "",
    ],
    actions,
  });
}

function sectionTerpenes(g) {
  const products = g.products || [];
  const counts = terpeneCounts(products);
  if (!counts.length) return "";
  if (!counts.some(([key]) => key === ui.terp)) ui.terp = counts[0][0];
  const top = counts[0][1];
  const listed = products.filter((p) => p._terps.length).length;
  return section(
    "terpenes",
    "Terpenes",
    `What OCS lists for the ${num(listed)} ranked products that have terpenes on file. Pick one to see what it smells like and which products carry it.
    The "linked with" notes are what people commonly say, not settled science; the whole plant matters more than any one terpene.`,
    `<div class="rs-terp-grid" role="group" aria-label="Terpenes">
      ${counts
        .map(
          ([key, n]) => `<button type="button" class="rs-terp" data-terp-pick="${esc(key)}" aria-pressed="${key === ui.terp}">
            <b>${esc(terpName(key))}</b>
            <small>${esc(TERPENES[key]?.aroma || "")}</small>
            <span class="rs-terp-bar" aria-hidden="true"><span style="width:${Math.max(6, Math.round((n / top) * 100))}%"></span></span>
            <small class="rs-terp-n">in ${num(n)} of ${num(products.length)}</small>
          </button>`
        )
        .join("")}
    </div>
    <div class="rs-terp-detail" id="rs-terp-detail" aria-live="polite">${terpDetail(ui.terp)}</div>`
  );
}

function terpDetail(key) {
  const t = TERPENES[key] || {};
  const withIt = (ui.report.guide.products || [])
    .filter((p) => p._terps.includes(key))
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score - a.score);
  const facts = [
    ["Smells like", t.aroma],
    [t.flavour ? "Note" : "Linked with", t.flavour ? "A flavour compound, not a terpene; often added for taste." : t.linked],
    ["Also found in", t.also],
  ].filter(([, v]) => v);
  return `<h3>${esc(terpName(key))}</h3>
    ${(t.effects || []).length ? `<div class="rs-uses"><span class="rs-hint">Main effects</span>${t.effects.map((e) => `<span class="terp-effect">${esc(e)}</span>`).join("")}</div>` : ""}
    ${facts.length ? `<dl class="rs-fe">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : `<p class="rs-hint">No notes on this one yet.</p>`}
    <p class="rs-hint">Best rated with ${esc(terpName(key))}:</p>
    <ol class="rs-terp-top">${withIt
      .slice(0, 5)
      .map(
        (p) => `<li><button type="button" class="rs-link" data-jump="rs-p-${esc(p.id)}">${tierBadge(p.tier)} ${esc(p.brand)} · ${esc(p.name)}</button>
          <span class="rs-hint">${Number(p.score).toFixed(1)}</span></li>`
      )
      .join("")}</ol>
    <button class="btn btn-secondary btn-small" type="button" data-terp="${esc(key)}" data-terp-all>Show all ${num(withIt.length)} in Rankings</button>`;
}

function pickTerpene(key) {
  ui.terp = key;
  for (const b of researchRoot.querySelectorAll("[data-terp-pick]")) b.setAttribute("aria-pressed", String(b.dataset.terpPick === key));
  const box = qs("#rs-terp-detail");
  if (box) box.innerHTML = terpDetail(key);
}

/* A terpene chip on a card toggles the Rankings filter; "Show all" sets it. */
function filterTerpene(key, toggle) {
  const off = toggle && ui.filters.terp === key;
  ui.filters = { ...ui.filters, terp: off ? "" : key };
  if (!off) pickTerpene(key);
  syncFilterInputs();
  drawCards();
  jumpTo("rs-rankings");
}

function sectionGlossary(g) {
  const terms = g.glossary || [];
  if (!terms.length) return "";
  return section(
    "glossary",
    "Glossary",
    "",
    `<dl class="rs-glossary">${terms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.definition)}</dd></div>`).join("")}</dl>`
  );
}

function sectionFaq(g) {
  const faq = g.faq || [];
  if (!faq.length) return "";
  return section(
    "faq",
    "FAQ",
    "",
    `<div class="rs-faq">${faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div>`
  );
}

function sectionMethod(r) {
  const s = r.stats || {};
  const subs = (r.subreddits || []).map((x) => `r/${esc(x)}`).join(" and ");
  const source = (r.sources || []).includes("reddit-rss")
    ? "Reddit's public feeds (the archive was unavailable, so this is newest and top posts only)"
    : "the Arctic Shift archive of Reddit";
  const threads = Object.entries(r.threads || {}).sort((a, b) => (b[1].date || "").localeCompare(a[1].date || ""));
  return section(
    "method",
    "How this was made",
    "",
    `<ol class="rs-method">
      <li>Read every post in ${subs} from ${esc(r.window?.from)} to ${esc(r.window?.to)} (${Number(s.postsScanned || 0).toLocaleString()} posts) from ${source}.</li>
      <li>Kept the ${Number(s.postsRelevant || 0).toLocaleString()} posts about ${esc(r.topic?.label?.toLowerCase())}, ranked by relevance and discussion, and fetched the comments of the top ${num(s.threadsFetched ?? s.threadsRead)} threads (${num(s.commentsFetched ?? s.commentsRead)} comments).${
        s.brandSearchComments ? ` A search for the category's main brands across the subreddits found ${num(s.brandSearchComments)} more comments in ${num(s.brandSearchThreads)} other threads.` : ""
      }</li>
      ${
        s.threadsFetched != null && r.writer?.by !== "counts"
          ? `<li>The model read ${num(s.threadsRead)} of those threads and ${num(s.commentsRead)} comments${
              s.parts ? `, in ${num(s.parts)} parts: it took notes on each part, then wrote this guide from all the notes` : " in one pass; the rest were counted but not read"
            }.</li>`
          : ""
      }
      <li>Matched brands against all ${Number(s.ocsProducts || 0).toLocaleString()} products on ocs.ca, ${s.ocsTopicProducts} of them in this category. Prices, sizes, potency and links come from OCS, never from the model.</li>
      <li>${esc(r.writer?.note || "")}${r.writer?.by && r.writer.by !== "counts" ? " Tiers are the community's consensus as the model read it, not lab results." : ""}</li>
      <li>Took ${Math.round((s.seconds || 0) / 60)} min${usageText(r.writer)}.</li>
    </ol>
    ${
      threads.length
        ? `<details class="rs-sources"><summary>Threads cited or read (${threads.length})</summary><ul>${threads
            .map(
              ([id, t]) => `<li><a href="${esc(threadUrl(r, id))}" target="_blank" rel="noopener noreferrer">${esc(t.title)}</a>
              <span class="rs-hint">r/${esc(t.sub)} · ${esc(t.date)}${t.comments != null ? ` · ${t.comments} comments` : ""}</span></li>`
            )
            .join("")}</ul></details>`
        : ""
    }`
  );
}

function threadLinks(r, ids) {
  const list = (ids || []).filter(Boolean).slice(0, 6);
  if (!list.length) return "";
  return `<p class="rs-threads"><span>Sources</span>${list
    .map(
      (id, i) => `<a href="${esc(threadUrl(r, id))}" target="_blank" rel="noopener noreferrer" title="${esc(r.threads[id]?.title || id)}"
        aria-label="Source ${i + 1}: ${esc(r.threads[id]?.title || "Reddit thread")}">${i + 1}</a>`
    )
    .join("")}</p>`;
}
