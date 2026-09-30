"use strict";

/* ── Answer: a free question's page (ask.py wrote it) ──────────────────────

   The short answer and how sure the evidence lets us be, then what people
   report (most common first, with their words), what it depends on, where
   they disagree, risks, tips, the products they name, and what this kind of
   evidence can't tell. Sections, quotes, sources and the method work like a
   guide's; tips, FAQ and the section menu reuse the guide's pieces. */

const HOW_COMMON = { most: "Most people", many: "Many people", some: "Some people", few: "A few people" };
const COMMON_RANK = { most: 0, many: 1, some: 2, few: 3 };
const STANCE = {
  supports: ["Backs the answer", "yes"],
  contradicts: ["Against it", "no"],
  mixed: ["Mixed", "mixed"],
  context: ["Context", "context"],
};
const CONFIDENCE = {
  strong: ["Strong evidence", "Many consistent, first-hand reports."],
  moderate: ["Moderate evidence", "A fair number of reports, not all agreeing."],
  weak: ["Thin evidence", "Only a few reports, or mostly opinion."],
  none: ["Not really answered", "The threads found don't answer this well."],
};
const TONE = { positive: "Liked", negative: "Disliked", mixed: "Mixed" };

function quoteBlocks(r, quotes) {
  return (quotes || [])
    .map(
      (q) => `<blockquote class="rs-quote"><p>“${esc(q.text)}”</p>
        <footer><a href="${esc(threadUrl(r, q.thread, q.comment))}" target="_blank" rel="noopener noreferrer">${esc(
          r.threads[q.thread]?.title || `thread ${q.thread}`
        )}</a>${r.threads[q.thread] ? ` · r/${esc(r.threads[q.thread].sub)} · ${esc(r.threads[q.thread].date)}` : ""}</footer></blockquote>`
    )
    .join("");
}

function drawAnswer() {
  const r = ui.report;
  const g = r.guide || {};
  const s = r.stats || {};
  const findings = [...(g.findings || [])].sort(
    (a, b) => (COMMON_RANK[a.how_common] ?? 4) - (COMMON_RANK[b.how_common] ?? 4) || (b.people || 0) - (a.people || 0)
  );
  const quotes = findings.reduce((n, f) => n + (f.quotes || []).length, 0) + (g.products || []).reduce((n, p) => n + (p.quotes || []).length, 0);
  const [confLabel, confNote] = CONFIDENCE[g.confidence] || CONFIDENCE.weak;
  const sections = [
    ["findings", "What people report", findings.length],
    ["depends", "It depends on", (g.depends_on || []).length],
    ["disagree", "Disagreements", (g.disagreements || []).length],
    ["risks", "Risks", (g.risks || []).length],
    ["tips", "Tips", (g.tips || []).length],
    ["products", "Products named", (g.products || []).length],
    ["faq", "FAQ", (g.faq || []).length],
    ["caveats", "Caveats", (g.caveats || []).length],
    ["method", "Method", true],
  ].filter(([, , present]) => present);

  researchRoot.innerHTML = `
    <article class="rs-report rs-answer" aria-labelledby="research-heading">
      <div class="rs-report-top">
        <button class="btn btn-ghost btn-small rs-back" type="button" data-home>← All research</button>
        <div class="rs-report-actions">
          ${archiveThisButton()}
          <button class="btn btn-secondary btn-small" type="button" data-act="rerun">
            <svg class="icon" aria-hidden="true"><use href="#i-refresh" /></svg> Ask again
          </button>
          <button class="btn btn-ghost btn-small" type="button" data-delete="${esc(ui.reportName)}">
            <svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg><span class="sr-only">Delete this answer</span>
          </button>
        </div>
      </div>

      <header class="rs-hero">
        <p class="rs-eyebrow">Question · ${esc(r.depth)} · ${esc(when(r.createdAt))}</p>
        <p class="rs-asked-big">“${esc(r.question)}”</p>
        <h1 id="research-heading">${esc(g.headline || r.topic?.label)}</h1>
        ${g.short_answer ? `<p class="rs-lede">${esc(g.short_answer)}</p>` : ""}
        <p class="rs-confidence" data-level="${esc(g.confidence || "weak")}"><strong>${esc(confLabel)}.</strong>
          ${esc(g.confidence_why || confNote)}</p>
        <p class="rs-hint">Reddit ${esc(r.window?.from)} to ${esc(r.window?.to)} ·
          ${(r.subreddits || []).map((x) => `r/${esc(x)}`).join(", ")} · ${esc(writtenBy(r.writer?.by, r.writer?.model, r.writer?.effort))}</p>
        <dl class="rs-stats">
          ${[
            [s.postsRelevant, "relevant threads found"],
            ...readStats(s),
            [quotes, "verified quotes"],
          ]
            .map(([n, label]) => `<div><dd>${Number(n || 0).toLocaleString()}</dd><dt>${label}</dt></div>`)
            .join("")}
        </dl>
      </header>

      <nav class="rs-toc" aria-label="Answer sections">
        ${sections.map(([id, label]) => `<button type="button" data-jump="rs-${id}">${label}</button>`).join("")}
      </nav>

      ${findings.length ? section("findings", "What people report", "Most common first. Each says how many of the people who spoke to it said so.",
        `<div class="rs-findings">${findings.map((f) => findingCard(r, f)).join("")}</div>`) : ""}
      ${(g.depends_on || []).length ? section("depends", "It depends on", "",
        `<ul class="rs-factors">${g.depends_on.map((d) => `<li class="card"><h3>${esc(d.factor)}</h3><p>${esc(d.detail)}</p>${threadLinks(r, d.threads)}</li>`).join("")}</ul>`) : ""}
      ${(g.disagreements || []).length ? section("disagree", "Where people disagree", "",
        `<ul class="rs-factors">${g.disagreements.map((d) => `<li class="card"><h3>${esc(d.title)}</h3>
          <ul class="rs-sides">${(d.sides || []).map((side) => `<li>${esc(side)}</li>`).join("")}</ul>${threadLinks(r, d.threads)}</li>`).join("")}</ul>`) : ""}
      ${(g.risks || []).length ? section("risks", "Risks people raise", "What people warn about. Anecdotes, not medical advice.",
        `<ul class="rs-factors rs-risks">${g.risks.map((d) => `<li class="card"><h3>${esc(d.title)}</h3><p>${esc(d.detail)}</p>${threadLinks(r, d.threads)}</li>`).join("")}</ul>`) : ""}
      ${sectionTips(g)}
      ${(g.products || []).length ? section("products", "Products people name", "",
        `<div class="rs-findings">${g.products.map((p) => answerProduct(r, p)).join("")}</div>`) : ""}
      ${sectionFaq(g)}
      ${(g.caveats || []).length ? section("caveats", "What this can't tell you", "",
        `<ul class="rs-caveats">${g.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`) : ""}
      ${(g.related || []).length ? `<section class="rs-section rs-related" aria-labelledby="rs-related-h">
        <h2 class="rs-h2" id="rs-related-h">Ask next</h2>
        <div class="rs-related-list">${g.related.map((q) => `<button type="button" class="chip" data-ask="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      </section>` : ""}
      ${answerMethod(r)}

      <p class="rs-foot">What people say in public Reddit threads, gathered and summarized by a model. Anecdotes, not
      evidence; not medical, legal or financial advice. Quotes belong to their authors.</p>
    </article>`;

  refreshOwnership();
  spySection();
}

function findingCard(r, f) {
  const [stanceLabel, stanceKey] = STANCE[f.stance] || STANCE.context;
  return `<article class="card rs-finding" data-stance="${esc(stanceKey)}">
    <div class="rs-finding-meta">
      <span class="rs-common" data-common="${esc(f.how_common || "some")}">${esc(HOW_COMMON[f.how_common] || "Some people")}${
        f.people ? ` <span class="rs-hint">(~${num(Math.round(f.people))})</span>` : ""
      }</span>
      <span class="rs-stance">${esc(stanceLabel)}</span>
    </div>
    <h3>${esc(f.title)}</h3>
    <p>${esc(f.detail)}</p>
    ${quoteBlocks(r, f.quotes)}
    ${threadLinks(r, f.threads)}
  </article>`;
}

function answerProduct(r, p) {
  const o = p.ocs;
  return `<article class="card rs-finding" id="rs-card-${esc(p.id)}">
    <div class="rs-finding-meta">
      ${p.kind ? `<span class="chip">${esc(p.kind)}</span>` : ""}
      ${p.tone ? `<span class="rs-stance" data-tone="${esc(p.tone)}">${esc(TONE[p.tone] || p.tone)}</span>` : ""}
    </div>
    <h3>${esc(p.brand ? `${p.brand} · ${p.name}` : p.name)}</h3>
    ${p.summary ? `<p>${esc(p.summary)}</p>` : ""}
    ${quoteBlocks(r, p.quotes)}
    <div class="rs-actions">
      ${o?.url ? `<a class="btn btn-secondary btn-small" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">On OCS${o.price != null ? ` · ${esc(money(o.price))}` : ""}</a>` : ""}
      ${o ? `<button class="btn btn-ghost btn-small" type="button" data-add="${esc(p.id)}">Add to shopping list</button>` : ""}
      <span class="rs-owned" data-owned="${esc(p.id)}"></span>
    </div>
    ${threadLinks(r, p.threads)}
  </article>`;
}

function answerMethod(r) {
  const s = r.stats || {};
  const plan = r.plan || {};
  const via = {
    "arctic-search": "the Arctic Shift archive's search",
    "reddit-search": "Reddit's own search",
    arctic: "each subreddit's newest posts",
  };
  const searched = ["arctic-search", "reddit-search"].filter((x) => (r.sources || []).includes(x)).map((x) => via[x]);
  const scanned = (r.sources || []).includes("arctic");
  const threads = Object.entries(r.threads || {}).sort((a, b) => (b[1].date || "").localeCompare(a[1].date || ""));
  return section(
    "method",
    "How this was made",
    "",
    `<ol class="rs-method">
      <li>${esc(writtenBy(r.writer?.by, r.writer?.model, r.writer?.effort).replace(/^written by /, ""))} planned where to look:
        ${(plan.subreddits || []).map((x) => `r/${esc(x.name)}${x.why ? ` <span class="rs-hint">(${esc(x.why)})</span>` : ""}`).join(", ")},
        searching for ${(plan.searches || []).map((x) => `“${esc(x)}”`).join(", ")}.</li>
      <li>${searched.length ? `Searched with ${esc(searched.join(" and "))}${scanned ? `, and read ${esc(via.arctic)}` : ""}` : `Read ${esc(via.arctic)} (the searches weren't answering)`},
        from ${esc(r.window?.from)} to ${esc(r.window?.to)},
        and kept the ${num(s.postsRelevant)} threads that matched, ranked by how well they match and how much they were discussed.</li>
      <li>Fetched the comments of the top ${num(s.threadsFetched)} threads (${num(s.commentsFetched)} comments)${
        s.brandSearchComments ? `, and ${num(s.brandSearchComments)} more comments from a comment search in ${num(s.brandSearchThreads)} other threads` : ""
      }.</li>
      <li>The model read ${num(s.threadsRead)} threads and ${num(s.commentsRead)} comments${
        s.parts ? `, in ${num(s.parts)} parts: it took notes on each part, then answered from all the notes` : " in one pass"
      }.${s.ocsTopicProducts ? ` Products were matched against ${num(s.ocsTopicProducts)} OCS listings of the brands people named; prices and links come from OCS.` : ""}</li>
      <li>${esc(r.writer?.note || "")}</li>
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

/* "Ask next": back to the launcher with the question filled in. */
function askAbout(question) {
  ui.mode = "question";
  ui.question = question;
  ui.startError = "";
  saveResearchPrefs();
  goResearch(null);
  window.requestAnimationFrame(() => {
    qs("#rs-launch")?.scrollIntoView({ behavior: "smooth", block: "start" });
    qs("#rs-question")?.focus();
  });
}
