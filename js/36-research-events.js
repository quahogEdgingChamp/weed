"use strict";

/* ── Events (delegated, so re-rendering never loses a listener) ────────── */

function jumpTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  if (target.classList.contains("rs-card") && target.closest("#rs-cards") === null) return;
  if (!target.isConnected || target.offsetParent === null) {
    ui.filters = { ...ui.filters, q: "", tier: "", lean: "", plant: "", use: "", brand: "", terp: "", solo: false, online: false };
    drawCards();
  }
  const el = document.getElementById(id);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  if (el.classList.contains("rs-card")) {
    el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), 1600);
  }
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

async function onClick(event) {
  const t = event.target.closest("button, [data-jump], a");
  if (!t || !researchRoot.contains(t)) return;

  if (t.matches("[data-home]")) return goResearch(null);
  if (t.dataset.open) return goResearch(t.dataset.open);
  if (t.dataset.jump) {
    if (!document.getElementById(t.dataset.jump)) {
      ui.filters = { ...ui.filters, q: "", tier: "", lean: "", plant: "", use: "", brand: "", terp: "", solo: false, online: false };
      drawCards();
    }
    return jumpTo(t.dataset.jump);
  }
  if (t.dataset.mode) {
    ui.mode = t.dataset.mode;
    ui.startError = "";
    saveResearchPrefs();
    renderLaunch();
    if (ui.mode === "question") qs("#rs-question")?.focus();
    return undefined;
  }
  if (t.dataset.ask) return askAbout(t.dataset.ask);
  if (t.dataset.depth) {
    ui.depth = t.dataset.depth;
    saveResearchPrefs();
    return renderLaunch();
  }
  if (t.dataset.provider) {
    ui.provider = t.dataset.provider;
    saveResearchPrefs();
    renderJob();
    renderPaused();
    return renderLaunch();
  }
  if (t.dataset.sort) {
    ui.table = { key: t.dataset.sort, asc: ui.table.key === t.dataset.sort ? !ui.table.asc : ["brand", "name", "price", "ppg", "size", "where", "tier"].includes(t.dataset.sort) };
    return drawTable();
  }
  if (t.dataset.entry) return window.Cloudline?.openEntry(t.dataset.entry);
  if (t.dataset.add) return addToList(t, t.dataset.add);
  if (t.dataset.delete) return deleteReport(t.dataset.delete);
  if (t.dataset.archive) return setArchived(t.dataset.archive, t.dataset.to === "true");
  if (t.dataset.brandFilter) return showBrand(t.dataset.brandFilter);
  if (t.dataset.terpPick) return pickTerpene(t.dataset.terpPick);
  if (t.dataset.terpCard) return openTerpCard(t, t.dataset.terpCard);
  if (t.dataset.terp) return filterTerpene(t.dataset.terp, !("terpAll" in t.dataset));
  if (t.dataset.resume) return resumeRun(t.dataset.resume, t.dataset.providerTo, t.dataset.modelTo, t.dataset.effortTo);
  if (t.dataset.discard) return discardRun(t.dataset.discard);
  if (t.dataset.queueFirst) return queueAction(`${encodeURIComponent(t.dataset.queueFirst)}/first`, "POST");
  if (t.dataset.queueRemove) return queueAction(encodeURIComponent(t.dataset.queueRemove), "DELETE");
  if (t.dataset.list) {
    ui.listView = t.dataset.list;
    return renderReportList();
  }

  switch (t.dataset.act) {
    case "start":
      return startRun();
    case "start-now":
      return startRun({ now: true });
    case "archive-this":
      return setArchived(ui.reportName, !ui.report?.archived);
    case "refresh-models":
      return loadModels(ui.provider, { refresh: true });
    case "reload":
      ui.overview = null;
      return showHome();
    case "cancel":
      t.disabled = true;
      await api(`${API}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
      return undefined;
    case "rerun": {
      if (ui.report.kind === "question") {
        ui.mode = "question";
        ui.question = ui.report.question || "";
        ui.depth = ui.report.depth || "quick";
        return startRun({ topic: "question", query: ui.question, depth: ui.depth });
      }
      const topic = ui.report.topic;
      ui.topic = topic.key;
      ui.query = topic.query || "";
      ui.depth = ui.report.depth || "quick";
      return startRun({ topic: topic.key, query: topic.query || "", depth: ui.depth });
    }
    case "clear-filters":
      ui.filters = { ...ui.filters, q: "", tier: "", lean: "", plant: "", use: "", brand: "", terp: "", solo: false, online: false };
      drawCards();
      syncFilterInputs();
      return undefined;
    default:
      if (t.id === "rs-start") return startRun();
  }
  return undefined;
}

function syncFilterInputs() {
  const f = ui.filters;
  if (qs("#rs-q")) qs("#rs-q").value = f.q;
  if (qs("#rs-f-tier")) qs("#rs-f-tier").value = f.tier;
  if (qs("#rs-f-lean")) qs("#rs-f-lean").value = f.lean;
  if (qs("#rs-f-online")) qs("#rs-f-online").checked = f.online;
  if (qs("#rs-f-plant")) qs("#rs-f-plant").value = f.plant;
  if (qs("#rs-f-use")) qs("#rs-f-use").value = f.use;
  if (qs("#rs-f-brand")) qs("#rs-f-brand").value = f.brand;
  if (qs("#rs-f-terp")) qs("#rs-f-terp").value = f.terp;
  if (qs("#rs-f-solo")) qs("#rs-f-solo").checked = f.solo;
}

/* "See products" on a brand card, trend or mover: filter the rankings to
   that brand (or search for it if the guide ranked none of its products). */
function showBrand(name) {
  const ranked = (ui.report.guide.products || []).some((p) => p.brand === name);
  ui.filters = { ...ui.filters, q: ranked ? "" : name, tier: "", lean: "", plant: "", use: "", terp: "", solo: false, online: false,
    brand: ranked ? name : "" };
  syncFilterInputs();
  drawCards();
  jumpTo("rs-rankings");
}

async function addToList(button, id) {
  const p = (ui.report.guide.products || []).find((item) => item.id === id);
  if (!p || !window.Cloudline) return;
  button.disabled = true;
  const note = (ui.report.kind === "question"
    ? `From “${ui.report.question}”: ${p.summary || ""}`
    : `${ui.report.topic.label} guide: ${p.tier === "AVOID" ? "Avoid" : `${p.tier} tier`}, ${p.score.toFixed(1)}/10. ${p.verdict}`
  ).slice(0, 1900);
  try {
    await window.Cloudline.addResearchPick({
      url: p.ocs?.url || "",
      name: p.ocs?.title || p.name,
      brand: p.brand,
      price: p.ocs?.price ?? null,
      note,
    });
  } finally {
    button.disabled = false;
    refreshOwnership();
  }
}

async function deleteReport(name) {
  const entry = (ui.overview?.reports || []).find((r) => r.name === name);
  const label = entry?.headline || ui.report?.guide?.headline || "this guide";
  if (!window.confirm(`Delete “${label}”? The guide file is removed from the server.`)) return;
  try {
    await api(`${API}/reports/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadOverview();
    if (reportParam() === name) {
      goResearch(null);
    } else {
      renderReportList();
    }
    window.Cloudline?.toast("Guide deleted.");
  } catch (error) {
    window.Cloudline?.toast(error.message);
  }
}

function onInput(event) {
  const t = event.target;
  /* Text fields react as you type. Their "change" on blur would redraw the
     cards under a click that is already in progress. */
  if (event.type === "change" && ["rs-q", "rs-bq", "rs-query", "rs-question", "rs-model-custom"].includes(t.id)) return undefined;
  if (t.id === "rs-question") {
    ui.question = t.value;
    return;
  }
  if (t.name === "rs-topic") {
    ui.topic = t.value;
    ui.startError = "";
    const query = qs(".rs-query");
    if (query) query.hidden = ui.topic !== "custom";
    if (ui.topic === "custom") qs("#rs-query")?.focus();
    return;
  }
  if (t.id === "rs-query") {
    ui.query = t.value;
    return;
  }
  if (t.id === "rs-list-sort") {
    ui.listSort = t.value;
    saveResearchPrefs();
    return renderReportList();
  }
  if (t.id === "rs-model") {
    ui.choice[ui.provider].model = t.value;
    saveResearchPrefs();
    redrawModels();
    renderJob();
    renderPaused();
    if (t.value === "__custom") qs("#rs-model-custom")?.focus();
    return undefined;
  }
  if (t.id === "rs-model-custom") {
    ui.choice[ui.provider].custom = t.value;
    saveResearchPrefs();
    return undefined;
  }
  if (t.id === "rs-effort") {
    ui.choice[ui.provider].effort = t.value;
    saveResearchPrefs();
    return redrawModels();
  }
  if (t.id === "rs-light") {
    ui.lightReading = t.checked;
    saveResearchPrefs();
    return redrawModels();
  }
  if (t.id === "rs-auto") {
    ui.autoContinue = t.checked;
    saveResearchPrefs();
    return undefined;
  }
  if (t.id === "rs-bq" || t.id === "rs-bsort") {
    if (t.id === "rs-bq") ui.brandQuery = t.value;
    else ui.brandSort = t.value;
    return drawBrands();
  }
  const filters = { "rs-q": "q", "rs-f-tier": "tier", "rs-f-lean": "lean", "rs-sort": "sort", "rs-f-online": "online",
    "rs-f-plant": "plant", "rs-f-use": "use", "rs-f-brand": "brand", "rs-f-terp": "terp", "rs-f-solo": "solo" };
  if (filters[t.id]) {
    ui.filters[filters[t.id]] = t.type === "checkbox" ? t.checked : t.value;
    drawCards();
  }
  return undefined;
}

function onKey(event) {
  const t = event.target;
  if ((event.key === "Enter" || event.key === " ") && t.matches("tr[data-jump], g[data-jump]")) {
    event.preventDefault();
    jumpTo(t.dataset.jump);
  }
  if (event.key === "Enter" && t.id === "rs-query") startRun();
  /* Enter asks; Shift+Enter is a new line. */
  if (event.key === "Enter" && !event.shiftKey && t.id === "rs-question") {
    event.preventDefault();
    startRun();
  }
}

/* One tooltip per chart, following the hovered or focused mark. */
function showTip(event) {
  const mark = event.target.closest?.("[data-tip]");
  const wrap = mark && mark.closest(".rs-chart-wrap");
  if (!wrap) return;
  const tip = wrap.querySelector(".rs-tip");
  const box = wrap.getBoundingClientRect();
  const rect = mark.getBoundingClientRect();
  tip.textContent = mark.dataset.tip;
  tip.hidden = false;
  const left = Math.min(Math.max(rect.left + rect.width / 2 - box.left, 80), box.width - 80);
  tip.style.left = `${left}px`;
  tip.style.top = `${rect.top - box.top - 8}px`;
}

function hideTip(event) {
  const wrap = event.target.closest?.(".rs-chart-wrap");
  if (wrap && !wrap.contains(event.relatedTarget)) wrap.querySelector(".rs-tip").hidden = true;
}

if (researchRoot) {
  researchRoot.addEventListener("click", onClick);
  researchRoot.addEventListener("input", onInput);
  researchRoot.addEventListener("change", onInput);
  researchRoot.addEventListener("keydown", onKey);
  researchRoot.addEventListener("pointerover", showTip);
  researchRoot.addEventListener("focusin", showTip);
  researchRoot.addEventListener("pointerout", hideTip);
  researchRoot.addEventListener("focusout", hideTip);
  /* "toggle" doesn't bubble; capture it so the full log stays as the user left it. */
  researchRoot.addEventListener("toggle", (event) => {
    if (event.target.matches?.(".rs-full-log")) ui.logOpen = event.target.open;
  }, true);
  window.addEventListener("resize", () => {
    window.clearTimeout(ui.resizeTimer);
    ui.resizeTimer = window.setTimeout(() => {
      if (ui.report && isVisible()) {
        drawScatter();
        drawVolume();
      }
    }, 150);
  });
}

window.CloudlineResearch = { render: renderResearch };
renderResearch();
