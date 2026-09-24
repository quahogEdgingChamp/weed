/* Research tab.

   Start a run (research.py does the work on the server), watch its progress,
   and read the guides it writes: quick picks, trends, brand report cards,
   filterable rankings with Reddit quotes, a comparison table and a
   score-versus-price chart. Products link back to OCS and can go straight
   onto the shopping list through the bridge app.js exposes as
   window.Cloudline. */

(function () {
  "use strict";

  const API = "/api/research";
  const POLL_MS = 1500;
  const root = document.getElementById("research-root");

  const TIERS = ["S", "A", "B", "C", "AVOID"];
  const TIER_ORDER = { S: 0, A: 1, B: 2, C: 3, AVOID: 4 };
  const TIER_TEXT = {
    S: "Best in class: broad agreement, few complaints",
    A: "Excellent, with minor caveats",
    B: "Good for the right use or price",
    C: "Mixed: some love it, many complain",
    AVOID: "The community says skip it",
  };
  const STAGES = [
    ["catalog", "OCS catalog"],
    ["reddit", "Scan Reddit"],
    ["threads", "Read threads"],
    ["parse", "Parse"],
    ["write", "Write guide"],
  ];
  const TREND = {
    rising: ["↑", "Rising"],
    falling: ["↓", "Cooling"],
    new: ["★", "New"],
    steady: ["→", "Steady"],
    warning: ["!", "Warning"],
  };

  const ui = {
    overview: null,
    overviewError: "",
    topic: "live-carts",
    query: "",
    depth: "quick",
    provider: "claude",
    choice: {
      claude: { model: "", effort: "", custom: "" },
      codex: { model: "", effort: "", custom: "" },
      grok: { model: "", effort: "", custom: "" },
    },
    models: {},
    startError: "",
    starting: false,
    pollTimer: null,
    watchedJob: null,
    reportName: null,
    report: null,
    reportError: "",
    filters: { q: "", tier: "", lean: "", plant: "", use: "", brand: "", solo: false, sort: "score", online: false },
    brandQuery: "",
    brandSort: "tier",
    table: { key: "score", asc: false },
    resizeTimer: null,
    listView: "active",
    listSort: "newest",
  };

  const PREFS_KEY = "cloudline-research-v1";
  const WRITERS = ["claude", "codex", "grok"];
  const PROVIDER_LABEL = { claude: "Claude", codex: "Codex", grok: "Grok", none: "Counts only" };

  /* The last provider, model, thinking level and depth, per browser. */
  function loadPrefs() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "null");
      if (saved && typeof saved === "object") {
        if ([...WRITERS, "none"].includes(saved.provider)) ui.provider = saved.provider;
        if (["quick", "standard", "deep"].includes(saved.depth)) ui.depth = saved.depth;
        if (typeof saved.listSort === "string") ui.listSort = saved.listSort;
        for (const p of WRITERS) {
          const c = saved.choice && saved.choice[p];
          if (c && typeof c === "object") {
            ui.choice[p] = { model: String(c.model || ""), effort: String(c.effort || ""), custom: String(c.custom || "") };
          }
        }
      }
    } catch (error) {
      /* No storage (private window): start from the defaults. */
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ provider: ui.provider, depth: ui.depth, choice: ui.choice, listSort: ui.listSort }));
    } catch (error) {
      /* Not remembered; nothing else depends on it. */
    }
  }

  loadPrefs();

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ESC[c]);
  const $ = (selector, scope = root) => scope.querySelector(selector);
  const $$ = (selector, scope = root) => Array.from(scope.querySelectorAll(selector));

  function money(value) {
    return typeof value === "number" ? `$${value.toFixed(2)}` : "—";
  }

  function grams(size) {
    const match = /([\d.]+)\s*g\b/i.exec(size || "");
    const value = match ? parseFloat(match[1]) : NaN;
    return value > 0 ? value : null;
  }

  function perGram(ocs) {
    if (!ocs || typeof ocs.price !== "number") return null;
    const g = grams(ocs.size);
    return g ? ocs.price / g : null;
  }

  function thcText(ocs) {
    if (!ocs || ocs.thcMin == null || ocs.thcMax == null) return "—";
    return ocs.thcMin === ocs.thcMax ? `${ocs.thcMax}%` : `${ocs.thcMin}–${ocs.thcMax}%`;
  }

  function when(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function monthLabel(key, style = "short") {
    const [year, month] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString(undefined, { month: style, timeZone: "UTC" });
  }

  function elapsed(fromIso, toIso) {
    const seconds = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
  }

  function brandKey(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/\s+(cannabis( co\.?| company)?|co\.?|vapes|infused|hash|labs|extracts|solventless|farms)$/, "")
      .trim();
  }

  function threadUrl(report, thread, comment) {
    const sub = (report.threads[thread] && report.threads[thread].sub) || "TheOCS";
    return `https://www.reddit.com/r/${encodeURIComponent(sub)}/comments/${encodeURIComponent(thread)}/${
      comment ? `_/${encodeURIComponent(comment)}/` : ""
    }`;
  }

  function num(n) {
    return Number(n || 0).toLocaleString();
  }

  function writtenBy(by, model, effort) {
    if (!by || by === "counts") return "built from counts, without a model";
    const name = PROVIDER_LABEL[by] || by;
    const detail = [model, effort].filter(Boolean).join(", ");
    return `written by ${name}${detail ? ` (${detail})` : ""}`;
  }

  /* Newer reports say what was fetched and what the model read; older ones
     only counted what was fetched, and said "read". */
  function readStats(s) {
    if (s.threadsFetched == null) {
      return [
        [s.threadsRead, "threads fetched"],
        [s.commentsRead, "comments fetched"],
      ];
    }
    return [
      [s.threadsRead, `threads read (of ${num(s.threadsFetched + (s.brandSearchThreads || 0))})`],
      [s.commentsRead, `comments read (of ${num(s.commentsFetched + (s.brandSearchComments || 0))})`],
    ];
  }

  function usageText(writer) {
    if (!writer || writer.by === "counts") return "";
    const calls = writer.calls > 1 ? `${writer.calls} model calls` : "one model call";
    if (typeof writer.cost === "number") return `; ${calls}, worth about $${writer.cost.toFixed(2)} of usage at API prices`;
    const t = writer.tokens || {};
    if (t.input || t.output) return `; ${calls}, ${num(t.input)} tokens in and ${num(t.output)} out`;
    return "";
  }

  function tierBadge(tier, { big = false } = {}) {
    const t = TIERS.includes(tier) ? tier : "B";
    return `<span class="rs-tier rs-tier-${t}${big ? " rs-tier-big" : ""}" title="${esc(TIER_TEXT[t])}">${t === "AVOID" ? "Avoid" : t}</span>`;
  }

  function trendChip(direction) {
    const [icon, label] = TREND[direction] || TREND.steady;
    return `<span class="rs-trend rs-trend-${esc(direction)}"><span aria-hidden="true">${icon}</span> ${label}</span>`;
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        cache: "no-store",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        ...options,
      });
    } catch (error) {
      throw new Error("Could not reach the server. Research needs python3 serve.py running.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `The server answered ${response.status}.`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function reportParam() {
    return new URLSearchParams(window.location.search).get("report");
  }

  function go(reportName) {
    const params = new URLSearchParams({ view: "research" });
    if (reportName) params.set("report", reportName);
    window.history.pushState({ view: "research", entry: null }, "", `${window.location.pathname}?${params}`);
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  /* ── Entry point (app.js calls this whenever the tab renders) ──────────── */

  function render() {
    if (!root || root.closest(".view").hidden) return;
    const name = reportParam();
    if (name) {
      showReport(name);
    } else {
      showHome();
    }
  }

  /* ── Home: launcher, live run, saved reports ───────────────────────────── */

  async function loadOverview() {
    try {
      ui.overview = await api(API);
      ui.overviewError = "";
      /* A server from before providers existed only knows about Claude. */
      if (!ui.overview.providers) {
        ui.overview.providers = {
          claude: { available: Boolean(ui.overview.llm?.available), label: "Claude" },
          codex: { available: false, label: "Codex" },
          grok: { available: false, label: "Grok" },
          legacy: true,
        };
      }
      if (ui.provider !== "none" && !ui.overview.providers[ui.provider]?.available) {
        ui.provider = WRITERS.find((p) => ui.overview.providers[p]?.available) || "none";
      }
    } catch (error) {
      ui.overviewError = error.message;
    }
    return ui.overview;
  }

  async function showHome() {
    if (ui.reportName !== null || !$(".rs-home")) {
      ui.reportName = null;
      ui.report = null;
      root.innerHTML = `
        <div class="rs-home">
          <div class="page-head">
            <div>
              <h1 id="research-heading">Research</h1>
              <p class="page-desc">Pick a product type. Cloudline reads what r/TheOCS and r/CanadianCannabisLPs have
              been saying, lines it up against every product on ocs.ca, and writes a guide you can filter, compare
              and shop from.</p>
            </div>
          </div>
          <div id="rs-job"></div>
          <div id="rs-paused"></div>
          <div id="rs-launch"></div>
          <section class="rs-saved" aria-labelledby="rs-saved-heading">
            <h2 id="rs-saved-heading" class="rs-h2">Saved guides</h2>
            <div id="rs-reports"><p class="muted">Loading…</p></div>
          </section>
        </div>`;
    }
    if (!ui.overview) await loadOverview();
    if (reportParam()) return; /* the user moved on while this loaded */
    renderLaunch();
    renderJob();
    renderPaused();
    renderReportList();
    if (ui.overview?.job?.status === "running") startPolling();
  }

  function renderLaunch() {
    const box = $("#rs-launch");
    if (!box) return;
    if (ui.overviewError) {
      box.innerHTML = `<section class="card rs-launch"><p class="rs-error">${esc(ui.overviewError)}</p>
        <button class="btn btn-secondary" type="button" data-act="reload">Try again</button></section>`;
      return;
    }
    const o = ui.overview;
    const running = o.job && o.job.status === "running";
    const providers = o.providers || {};
    const deepMode = o.depths?.deep?.mode === "batches";
    const depthNote = {
      quick: `last ${o.depths.quick?.days || 120} days · the model reads the ~30 most relevant threads`,
      standard: `last ${o.depths.standard?.days || 365} days · the model reads ~90 threads in one pass`,
      deep: deepMode
        ? "last year · every relevant thread and every comment, read in parts, plus a brand search across the subreddits"
        : `last ${o.depths.deep?.days || 365} days · restart the server to get the new deep mode`,
    }[ui.depth];
    const writing = ui.provider !== "none";
    const minutes = writing
      ? { quick: "3–6 min", standard: "6–12 min", deep: "20–45 min" }
      : { quick: "1–3 min", standard: "2–5 min", deep: "5–15 min" };
    const deepCost =
      writing && ui.depth === "deep"
        ? " Deep makes one model call per part (often 8–15) plus one to write, so it uses several times a quick run's plan usage; a lighter model keeps that down."
        : "";

    box.innerHTML = `
      <section class="card rs-launch" aria-labelledby="rs-new-heading">
        <h2 id="rs-new-heading" class="panel-title">New research</h2>
        <fieldset class="rs-topics">
          <legend class="sr-only">What to research</legend>
          ${o.topics
            .map(
              (t) => `<label class="rs-topic">
                <input type="radio" name="rs-topic" value="${esc(t.key)}" ${ui.topic === t.key ? "checked" : ""} />
                <span class="rs-topic-label">${esc(t.label)}</span>
                <span class="rs-topic-blurb">${esc(t.blurb)}</span>
              </label>`
            )
            .join("")}
        </fieldset>
        <label class="rs-query" ${ui.topic === "custom" ? "" : "hidden"}>
          <span>What should it look for? Every word has to appear in a post.</span>
          <input id="rs-query" type="text" maxlength="120" placeholder="cold cure rosin, blueberry cart, infused pre-roll…" value="${esc(ui.query)}" />
        </label>
        <div class="rs-options">
          <div>
            <p class="rs-option-label" id="rs-depth-label">How deep</p>
            <div class="segmented" role="group" aria-labelledby="rs-depth-label">
              ${["quick", "standard", "deep"]
                .map(
                  (d) => `<button type="button" data-depth="${d}" aria-pressed="${ui.depth === d}">${d[0].toUpperCase()}${d.slice(1)}</button>`
                )
                .join("")}
            </div>
            <p class="rs-hint">${esc(depthNote)} · about ${minutes[ui.depth]} the first time, quicker after.${esc(deepCost)}</p>
          </div>
          <div>
            <p class="rs-option-label" id="rs-writer-label">Who writes the guide</p>
            <div class="segmented rs-writers" role="group" aria-labelledby="rs-writer-label">
              ${[...WRITERS, "none"]
                .map((p) => {
                  const available = p === "none" || providers[p]?.available;
                  return `<button type="button" data-provider="${p}" aria-pressed="${ui.provider === p}" ${available ? "" : "disabled"}
                    ${available ? "" : `title="The ${p} CLI isn't installed on the server"`}>${PROVIDER_LABEL[p]}</button>`;
                })
                .join("")}
            </div>
            <p class="rs-hint">${esc(
              ui.provider === "claude"
                ? "Uses your Claude Code plan through the claude CLI."
                : ui.provider === "codex"
                  ? "Uses your ChatGPT / Codex plan through the codex CLI."
                  : ui.provider === "grok"
                    ? "Uses your SuperGrok / X Premium+ plan through the grok CLI (Grok Build)."
                    : "Tiers come from mention counts and a keyword tone score. Rougher, but free and quicker."
            )}${writing ? " Every quote is checked against the real comment." : ""}</p>
          </div>
        </div>
        ${writing ? `<div class="rs-options rs-model-row" id="rs-model-row">${modelControls()}</div>` : ""}
        <div class="rs-start-row">
          <button id="rs-start" class="btn btn-primary rs-start" type="button" ${running || ui.starting ? "disabled" : ""}>
            ${running ? "A run is going…" : ui.starting ? "Starting…" : "Start research"}
          </button>
        </div>
        ${ui.startError ? `<p class="rs-error" role="alert">${esc(ui.startError)}</p>` : ""}
      </section>`;
  }

  /* The model list comes from the CLI itself, through the server. */
  async function loadModels(provider, { refresh = false } = {}) {
    const entry = ui.models[provider];
    if (entry && (entry.state === "loading" || (entry.state === "ready" && !refresh))) return;
    ui.models[provider] = { state: "loading", models: entry?.models || [], note: "" };
    redrawModels();
    try {
      const data = await api(`${API}/models?provider=${provider}${refresh ? "&refresh=1" : ""}`);
      ui.models[provider] = { state: "ready", models: data.models || [], note: data.note || "" };
    } catch (error) {
      /* An older server has no model list: a typed model name still works there. */
      ui.models[provider] = { state: "error", models: [], note: "Couldn't load the model list; type a model name or use the default." };
    }
    redrawModels();
  }

  function redrawModels() {
    const row = $("#rs-model-row");
    if (row) row.innerHTML = modelControls();
  }

  function currentModel(provider = ui.provider) {
    const c = ui.choice[provider];
    return c.model === "__custom" ? c.custom.trim() : c.model;
  }

  function modelControls() {
    const provider = ui.provider;
    if (provider === "none") return "";
    const entry = ui.models[provider];
    if (!entry) {
      window.setTimeout(() => loadModels(provider), 0);
    }
    const models = entry?.models || [];
    const c = ui.choice[provider];
    const known = models.some((m) => m.id === c.model);
    if (c.model && c.model !== "__custom" && !known && entry?.state === "ready") {
      c.custom = c.model;
      c.model = "__custom";
    }
    const chosen = models.find((m) => m.id === c.model);
    const fallback = provider === "claude" ? models[0] : models.find((m) => m.default) || models[0];
    const efforts = chosen
      ? chosen.efforts || []
      : c.model === "__custom" || !models.length
        ? ["low", "medium", "high", "xhigh", "max"]
        : (fallback && fallback.efforts) || [];
    if (c.effort && !efforts.includes(c.effort)) c.effort = "";
    const defaultLabel =
      provider !== "claude" && fallback ? `CLI default (${fallback.label})` : "CLI default";
    const describe = chosen?.description || (c.model === "" && fallback ? "" : "");
    return `
      <div>
        <label class="rs-option-label" for="rs-model">Model</label>
        <div class="rs-inline">
          <label class="select rs-grow"><select id="rs-model">
            <option value="" ${c.model === "" ? "selected" : ""}>${esc(defaultLabel)}</option>
            ${models.map((m) => `<option value="${esc(m.id)}" ${c.model === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
            <option value="__custom" ${c.model === "__custom" ? "selected" : ""}>Other (type a name)…</option>
          </select></label>
          <button class="btn btn-ghost btn-small" type="button" data-act="refresh-models" title="Ask the CLI for its models again"
            ${entry?.state === "loading" ? "disabled" : ""}>
            <svg class="icon" aria-hidden="true"><use href="#i-refresh" /></svg><span class="sr-only">Refresh the model list</span>
          </button>
        </div>
        ${c.model === "__custom" ? `<input id="rs-model-custom" type="text" maxlength="80" spellcheck="false" placeholder="${{ codex: "gpt-6-sol", grok: "grok-4.7", claude: "claude-sonnet-5" }[provider] || ""}" value="${esc(c.custom)}" />` : ""}
        <p class="rs-hint">${esc(
          entry?.state === "loading" ? "Asking the CLI which models it has…" : describe || entry?.note || ""
        )}</p>
      </div>
      <div>
        <label class="rs-option-label" for="rs-effort">Thinking</label>
        <label class="select"><select id="rs-effort" ${efforts.length ? "" : "disabled"}>
          <option value="" ${c.effort === "" ? "selected" : ""}>Default</option>
          ${efforts.map((e) => `<option value="${esc(e)}" ${c.effort === e ? "selected" : ""}>${esc(e[0].toUpperCase() + e.slice(1))}</option>`).join("")}
        </select></label>
        <p class="rs-hint">${esc(
          efforts.length
            ? "Higher thinks longer: better judgement, slower, more usage."
            : "This model has no thinking setting."
        )}</p>
      </div>`;
  }

  function renderJob() {
    const box = $("#rs-job");
    if (!box) return;
    const job = ui.overview && ui.overview.job;
    if (!job || (job.status !== "running" && job.id !== ui.watchedJob)) {
      box.innerHTML = "";
      return;
    }
    const reached = STAGES.findIndex(([key]) => key === job.stage);
    const counts = job.counts || {};
    const facts = [
      ["posts_scanned", "posts scanned"],
      ["posts_relevant", "on topic"],
      ["threads_fetched", "threads fetched"],
      ["threads_read", "threads fetched"],
      ["comments_fetched", "comments fetched"],
      ["comments_read", "comments fetched"],
      ["brand_search_comments", "found by brand search"],
      ["parts", "parts to read"],
      ["parts_done", "parts read"],
      ["ocs_topic", "OCS products"],
    ].filter(([key]) => counts[key] != null);
    const log = (job.log || []).slice(-7).reverse();
    const title =
      job.status === "running"
        ? `Researching ${esc(job.label)}`
        : job.status === "done"
          ? `Finished: ${esc(job.label)}`
          : job.status === "paused"
            ? `Paused: ${esc(job.label)}`
            : job.status === "cancelled"
              ? `Stopped: ${esc(job.label)}`
              : `Failed: ${esc(job.label)}`;
    const canContinue = job.checkpoint && (job.status === "paused" || job.status === "cancelled");

    box.innerHTML = `
      <section class="card rs-job" aria-labelledby="rs-job-heading" data-status="${esc(job.status)}">
        <div class="rs-job-head">
          <div>
            <h2 id="rs-job-heading" class="panel-title">${title}</h2>
            <p class="rs-hint">${esc(job.depth)} · ${esc(
              job.llm
                ? `${PROVIDER_LABEL[job.provider || "claude"] || "Claude"} writes the guide${job.model ? ` (${job.model}${job.effort ? `, ${job.effort}` : ""})` : ""}`
                : "counts only"
            )} · ${elapsed(job.startedAt, job.finishedAt)}</p>
          </div>
          ${
            job.status === "running"
              ? `<button class="btn btn-secondary btn-small" type="button" data-act="cancel">Stop</button>`
              : job.status === "done"
                ? `<button class="btn btn-primary btn-small" type="button" data-open="${esc(job.report)}">Open guide</button>`
                : canContinue
                  ? continueButtons({ id: job.checkpoint, provider: job.provider, model: job.model, effort: job.effort })
                  : ""
          }
        </div>
        <ol class="rs-steps">
          ${STAGES.map(([key, label], i) => {
            let status = i < reached || job.status === "done" ? "done" : i === reached ? "current" : "todo";
            if (i === reached && job.status !== "running" && job.status !== "done") status = "stopped";
            return `<li class="rs-step" data-status="${status}"><span class="rs-step-dot" aria-hidden="true"></span>${label}<span class="sr-only"> (${status})</span></li>`;
          }).join("")}
        </ol>
        ${
          facts.length
            ? `<dl class="rs-counts">${facts
                .map(([key, label]) => `<div><dt>${label}</dt><dd>${Number(counts[key]).toLocaleString()}</dd></div>`)
                .join("")}</dl>`
            : ""
        }
        <ul class="rs-log" aria-live="polite">${log.map((line) => `<li>${esc(line.message)}</li>`).join("")}</ul>
        ${
          job.status === "paused"
            ? `<p class="rs-paused-note">${esc(job.error || "Paused.")} Everything read so far is saved: continue
                once the limit resets, or finish now with another writer or model picked under “Who writes the guide”.</p>`
            : job.error
              ? `<p class="rs-error">${esc(job.error)}</p>`
              : ""
        }
      </section>`;
  }

  /* Continue with the writer the run used, or with whatever is picked in the
     launcher below (another provider, or another model). */
  function continueButtons(run) {
    const same = { provider: run.provider || "claude", model: run.model || "", effort: run.effort || "" };
    const picked = { provider: ui.provider, model: ui.provider === "none" ? "" : currentModel(), effort: ui.provider === "none" ? "" : ui.choice[ui.provider].effort };
    const describe = (w) => `${PROVIDER_LABEL[w.provider] || w.provider}${w.model ? ` (${w.model})` : ""}`;
    const differs = picked.provider !== "none" && (picked.provider !== same.provider || picked.model !== same.model);
    const busy = ui.overview?.job?.status === "running";
    return `<div class="rs-continue">
      <button class="btn btn-primary btn-small" type="button" ${busy ? "disabled" : ""}
        data-resume="${esc(run.id)}" data-provider-to="${esc(same.provider)}" data-model-to="${esc(same.model)}" data-effort-to="${esc(same.effort)}">
        Continue with ${esc(describe(same))}</button>
      ${
        differs
          ? `<button class="btn btn-secondary btn-small" type="button" ${busy ? "disabled" : ""}
              data-resume="${esc(run.id)}" data-provider-to="${esc(picked.provider)}" data-model-to="${esc(picked.model)}" data-effort-to="${esc(picked.effort)}">
              Finish with ${esc(describe(picked))}</button>`
          : ""
      }
      <button class="btn btn-ghost btn-small" type="button" data-discard="${esc(run.id)}">Discard</button>
    </div>`;
  }

  /* Runs saved at a checkpoint: paused by a usage limit, stopped, or cut off
     by a server restart. Hidden while that same run is going. */
  function renderPaused() {
    const box = $("#rs-paused");
    if (!box || !ui.overview) return;
    const job = ui.overview.job;
    const live = job && job.status === "running" ? job.checkpoint : null;
    const shownInPanel = job && job.id === ui.watchedJob && job.checkpoint;
    const runs = (ui.overview.checkpoints || []).filter((c) => c.id !== live && c.id !== shownInPanel);
    if (!runs.length) {
      box.innerHTML = "";
      return;
    }
    const why = (c) =>
      c.status === "paused"
        ? `${PROVIDER_LABEL[c.provider] || "The writer"} hit its usage limit${c.resets ? `; resets ${c.resets}` : ""}`
        : c.status === "stopped"
          ? "Stopped by you"
          : "Interrupted (the server restarted mid-run)";
    box.innerHTML = `<section class="rs-saved" aria-labelledby="rs-paused-heading">
      <h2 id="rs-paused-heading" class="rs-h2">Waiting to continue</h2>
      <ul class="rs-report-list">${runs
        .map(
          (c) => `<li class="card rs-paused-item">
            <div class="rs-paused-text">
              <span class="rs-eyebrow">${esc(c.topic?.label || "Research")} · ${esc(c.depth)} · started ${esc(when(c.createdAt))}</span>
              <span class="rs-report-title">${esc(why(c))}</span>
              <span class="rs-hint">${c.parts ? `${num(c.partsDone)} of ${num(c.parts)} parts read and saved` : "Evidence gathered and saved; the guide isn't written yet"} ·
                was using ${esc(PROVIDER_LABEL[c.provider] || c.provider || "?")}${c.model ? ` (${esc(c.model)})` : ""}</span>
            </div>
            ${continueButtons(c)}
          </li>`
        )
        .join("")}</ul>
    </section>`;
  }

  async function resumeRun(checkpoint, provider, model, effort) {
    ui.startError = "";
    try {
      const { job } = await api(`${API}/resume`, {
        method: "POST",
        body: JSON.stringify({ checkpoint, provider, model, effort }),
      });
      ui.overview.job = job;
      ui.watchedJob = job.id;
      renderJob();
      renderPaused();
      renderLaunch();
      startPolling();
      window.requestAnimationFrame(() => $("#rs-job")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      window.Cloudline?.toast(
        error.message === "Not found" ? "Continuing needs the server restarted (sudo systemctl restart weed)." : error.message
      );
    }
  }

  async function discardRun(checkpoint) {
    if (!window.confirm("Discard this paused run? What it has read so far is deleted; the Reddit and OCS downloads stay cached.")) return;
    try {
      await api(`${API}/checkpoints/${encodeURIComponent(checkpoint)}`, { method: "DELETE" });
    } catch (error) {
      window.Cloudline?.toast(error.message);
      return;
    }
    await loadOverview();
    if (ui.overview?.job?.checkpoint === checkpoint) ui.watchedJob = null;
    renderJob();
    renderPaused();
    window.Cloudline?.toast("Paused run discarded.");
  }

  const LIST_SORTS = [
    ["newest", "Newest first"],
    ["oldest", "Oldest first"],
    ["topic", "Topic A–Z"],
    ["depth", "Deepest first"],
    ["read", "Most comments read"],
    ["products", "Most products"],
  ];
  const DEPTH_RANK = { deep: 0, standard: 1, quick: 2 };

  function sortReports(list) {
    const byDate = (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "");
    const sorts = {
      newest: byDate,
      oldest: (a, b) => -byDate(a, b),
      topic: (a, b) => (a.topic?.label || "").localeCompare(b.topic?.label || "") || byDate(a, b),
      depth: (a, b) => (DEPTH_RANK[a.depth] ?? 3) - (DEPTH_RANK[b.depth] ?? 3) || byDate(a, b),
      read: (a, b) => (b.stats?.commentsRead || 0) - (a.stats?.commentsRead || 0) || byDate(a, b),
      products: (a, b) => (b.products || 0) - (a.products || 0) || byDate(a, b),
    };
    return [...list].sort(sorts[ui.listSort] || byDate);
  }

  function renderReportList() {
    const box = $("#rs-reports");
    if (!box || !ui.overview) return;
    const reports = ui.overview.reports || [];
    if (!reports.length) {
      box.innerHTML = `<p class="rs-empty">No guides yet. Pick a topic above and start one: a quick run takes a few minutes.</p>`;
      return;
    }
    const archived = reports.filter((r) => r.archived);
    const active = reports.filter((r) => !r.archived);
    if (ui.listView === "archived" && !archived.length) ui.listView = "active";
    const shown = sortReports(ui.listView === "archived" ? archived : active);

    box.innerHTML = `
      <div class="rs-list-bar">
        <div class="segmented rs-list-tabs" role="group" aria-label="Which guides">
          <button type="button" data-list="active" aria-pressed="${ui.listView === "active"}">Active <span class="tab-count">${active.length}</span></button>
          <button type="button" data-list="archived" aria-pressed="${ui.listView === "archived"}" ${archived.length ? "" : "disabled"}>Archived <span class="tab-count">${archived.length}</span></button>
        </div>
        <label class="select rs-list-sort"><span class="sr-only">Sort guides</span>
          <select id="rs-list-sort">${LIST_SORTS.map(([v, l]) => `<option value="${v}" ${ui.listSort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
      </div>
      ${
        shown.length
          ? `<ul class="rs-report-list">${shown.map(reportItem).join("")}</ul>`
          : `<p class="rs-empty">Every guide is archived. <button class="btn btn-ghost btn-small" type="button" data-list="archived">Show archived</button></p>`
      }`;
  }

  function reportItem(r) {
    const s = r.stats || {};
    const title = esc(r.headline || r.name);
    return `<li class="card rs-report-item${r.archived ? " is-archived" : ""}">
      <button class="rs-report-open" type="button" data-open="${esc(r.name)}">
        <span class="rs-eyebrow">${esc(r.topic?.label || "Research")} · ${esc(when(r.createdAt))} · ${esc(r.depth)}${
          r.archived ? ` · archived${r.archivedAt ? ` ${esc(when(r.archivedAt))}` : ""}` : ""
        }</span>
        <span class="rs-report-title">${esc(r.headline || "Untitled guide")}</span>
        <span class="rs-hint">${r.products} products · ${num(s.postsScanned)} posts scanned ·
          ${num(s.commentsRead)} comments ${s.threadsFetched != null ? "read" : "fetched"} · ${esc(writtenBy(r.by, r.model))}</span>
      </button>
      <div class="rs-item-actions">
        <button class="btn btn-ghost btn-small" type="button" data-archive="${esc(r.name)}" data-to="${r.archived ? "false" : "true"}"
          title="${r.archived ? "Move back to active" : "Archive"}" aria-label="${r.archived ? "Unarchive" : "Archive"} ${title}">
          <svg class="icon" aria-hidden="true"><use href="#i-archive" /></svg><span class="rs-item-label">${r.archived ? "Unarchive" : "Archive"}</span>
        </button>
        <button class="btn btn-ghost btn-small rs-report-delete" type="button" data-delete="${esc(r.name)}" aria-label="Delete ${title}">
          <svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg>
        </button>
      </div>
    </li>`;
  }

  async function setArchived(name, archived) {
    try {
      await api(`${API}/reports/${encodeURIComponent(name)}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived }),
      });
    } catch (error) {
      window.Cloudline?.toast(
        error.message.includes("404") || error.message === "Not found"
          ? "Archiving needs the server restarted (sudo systemctl restart weed)."
          : error.message
      );
      return;
    }
    await loadOverview();
    if (ui.report && ui.reportName === name) {
      ui.report.archived = archived;
      const button = $("[data-act='archive-this']");
      if (button) button.outerHTML = archiveThisButton();
    } else {
      renderReportList();
    }
    window.Cloudline?.toast(archived ? "Guide archived." : "Guide moved back to active.");
  }

  function archiveThisButton() {
    const archived = Boolean(ui.report?.archived);
    return `<button class="btn btn-secondary btn-small" type="button" data-act="archive-this">
      <svg class="icon" aria-hidden="true"><use href="#i-archive" /></svg> ${archived ? "Unarchive" : "Archive"}
    </button>`;
  }

  async function startRun({ topic = ui.topic, query = ui.query, depth = ui.depth, provider = ui.provider } = {}) {
    if (topic === "custom" && !query.trim()) {
      ui.startError = "Type what to research first.";
      renderLaunch();
      $("#rs-query")?.focus();
      return;
    }
    ui.starting = true;
    ui.startError = "";
    renderLaunch();
    try {
      const { job } = await api(`${API}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          topic,
          query,
          depth,
          provider,
          llm: provider !== "none",
          model: provider === "none" ? "" : currentModel(provider),
          effort: provider === "none" ? "" : ui.choice[provider].effort,
        }),
      });
      ui.overview.job = job;
      ui.watchedJob = job.id;
      startPolling();
      window.requestAnimationFrame(() => $("#rs-job")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      ui.startError = error.message;
      if (error.payload?.job) ui.overview.job = error.payload.job;
    } finally {
      ui.starting = false;
      if (reportParam()) {
        go(null);
      } else {
        renderLaunch();
        renderJob();
      }
    }
  }

  function startPolling() {
    if (ui.pollTimer) return;
    const tick = async () => {
      ui.pollTimer = null;
      let job;
      try {
        job = (await api(API)).job;
      } catch (error) {
        ui.pollTimer = window.setTimeout(tick, POLL_MS * 4);
        return;
      }
      const wasRunning = ui.overview?.job?.status === "running";
      ui.overview.job = job;
      if (job && job.status === "running") {
        ui.pollTimer = window.setTimeout(tick, POLL_MS);
      } else if (wasRunning) {
        await loadOverview();
        if (job && job.status === "done" && job.id === ui.watchedJob && !reportParam() && isVisible()) {
          window.Cloudline?.toast(`Your ${job.label} guide is ready.`);
          go(job.report);
          return;
        }
        if (job && job.status === "paused") {
          ui.watchedJob = job.id;
          window.Cloudline?.toast(`Paused: ${job.error || "the writer hit its usage limit"}`);
        }
      }
      if (!reportParam()) {
        renderJob();
        if (!job || job.status !== "running") {
          renderLaunch();
          renderPaused();
          renderReportList();
        }
      }
    };
    ui.pollTimer = window.setTimeout(tick, POLL_MS);
  }

  function isVisible() {
    return root && !root.closest(".view").hidden;
  }

  /* ── Report ────────────────────────────────────────────────────────────── */

  async function showReport(name) {
    if (ui.reportName === name && ui.report) {
      refreshOwnership();
      return;
    }
    ui.reportName = name;
    ui.report = null;
    ui.reportError = "";
    ui.filters = { q: "", tier: "", lean: "", plant: "", use: "", brand: "", solo: false, sort: "score", online: false };
    ui.brandQuery = "";
    root.innerHTML = `<div class="rs-loading"><span class="spinner" aria-hidden="true"></span> Loading guide…</div>`;
    try {
      const { report } = await api(`${API}/reports/${encodeURIComponent(name)}`);
      if (ui.reportName !== name) return;
      ui.report = prepare(report);
      drawReport();
    } catch (error) {
      if (ui.reportName !== name) return;
      root.innerHTML = `<div class="rs-home"><button class="btn btn-ghost rs-back" type="button" data-home>← All research</button>
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
      p._haystack = [p.brand, p.name, p.kind, p.flavour, p.effects, p.high, p.verdict, p.hardware, p.ocs?.genetics,
        ...(p.ocs?.terpenes || []), ...(p.pros || []), ...(p.cons || []), ...(p.good_for || []).map((t) => GOOD_FOR[t])]
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
      ["chart", "Price vs score", (g.products || []).some((p) => p._ppg)],
      ["compare", "Compare", (g.products || []).length],
      ["avoid", "Skip these", (g.avoid || []).length],
      ["tips", "Tips", (g.tips || []).length],
      ["glossary", "Glossary", (g.glossary || []).length],
      ["faq", "FAQ", (g.faq || []).length],
      ["method", "Method", true],
    ].filter(([, , present]) => present);

    root.innerHTML = `
      <article class="rs-report" aria-labelledby="research-heading">
        <div class="rs-report-top">
          <button class="btn btn-ghost btn-small rs-back" type="button" data-home>← All research</button>
          <div class="rs-report-actions">
            ${archiveThisButton()}
            <button class="btn btn-secondary btn-small" type="button" data-act="rerun">
              <svg class="icon" aria-hidden="true"><use href="#i-refresh" /></svg> Run again
            </button>
            <button class="btn btn-ghost btn-small" type="button" data-delete="${esc(ui.reportName)}">
              <svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg><span class="sr-only">Delete this guide</span>
            </button>
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
  }

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
              (b) => `<li><button type="button" class="rs-mover-name" data-brand-filter="${esc(b.brand)}">${esc(b.brand)}</button>
                ${sparkline(b.months)}
                <span class="rs-num">${num(b.recent)} <span class="rs-hint">of ${num(b.mentions)} mentions in the last 90 days</span></span></li>`
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
    const box = $("#rs-volume");
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
    const box = $("#rs-brand-cards");
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

  function sectionRankings(g) {
    const products = g.products || [];
    if (!products.length) return "";
    const f = ui.filters;
    const plants = [...new Set(products.map((p) => p._plant).filter(Boolean))];
    const uses = Object.keys(GOOD_FOR).filter((tag) => products.some((p) => (p.good_for || []).includes(tag)));
    const brands = [...new Set(products.map((p) => p.brand))].sort((a, b) => a.localeCompare(b));
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
    const box = $("#rs-cards");
    if (!box) return;
    const all = ui.report.guide.products || [];
    const list = filteredProducts();
    $("#rs-count").textContent = list.length === all.length ? `(${all.length})` : `(${list.length} of ${all.length})`;
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
      ["Terpenes", o?.terpenes?.length ? esc(o.terpenes.join(", ")) : ""],
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
        <a class="btn btn-ghost btn-small" href="https://hibuddy.ca/search?q=${search}" target="_blank" rel="noopener noreferrer">Store prices <svg class="icon" aria-hidden="true"><use href="#i-external" /></svg></a>
        <a class="btn btn-ghost btn-small" href="https://www.reddit.com/r/TheOCS/search/?q=${search}&restrict_sr=1&sort=new" target="_blank" rel="noopener noreferrer">Latest posts <svg class="icon" aria-hidden="true"><use href="#i-external" /></svg></a>
      </div>
    </article>`;
  }

  function refreshOwnership() {
    const bridge = window.Cloudline;
    if (!bridge || !ui.report) return;
    const byId = new Map((ui.report.guide.products || []).map((p) => [p.id, p]));
    for (const slot of $$("[data-owned]")) {
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
    const box = $("#rs-scatter");
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
    const table = $(".rs-compare");
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

  /* ── Events (delegated, so re-rendering never loses a listener) ────────── */

  function jumpTo(id) {
    const target = document.getElementById(id);
    if (!target) return;
    if (target.classList.contains("rs-card") && target.closest("#rs-cards") === null) return;
    if (!target.isConnected || target.offsetParent === null) {
      ui.filters = { ...ui.filters, q: "", tier: "", lean: "", plant: "", use: "", brand: "", solo: false, online: false };
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
    if (!t || !root.contains(t)) return;

    if (t.matches("[data-home]")) return go(null);
    if (t.dataset.open) return go(t.dataset.open);
    if (t.dataset.jump) {
      if (!document.getElementById(t.dataset.jump)) {
        ui.filters = { ...ui.filters, q: "", tier: "", lean: "", plant: "", use: "", brand: "", solo: false, online: false };
        drawCards();
      }
      return jumpTo(t.dataset.jump);
    }
    if (t.dataset.depth) {
      ui.depth = t.dataset.depth;
      savePrefs();
      return renderLaunch();
    }
    if (t.dataset.provider) {
      ui.provider = t.dataset.provider;
      savePrefs();
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
    if (t.dataset.resume) return resumeRun(t.dataset.resume, t.dataset.providerTo, t.dataset.modelTo, t.dataset.effortTo);
    if (t.dataset.discard) return discardRun(t.dataset.discard);
    if (t.dataset.list) {
      ui.listView = t.dataset.list;
      return renderReportList();
    }

    switch (t.dataset.act) {
      case "start":
        return startRun();
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
        const topic = ui.report.topic;
        ui.topic = topic.key;
        ui.query = topic.query || "";
        ui.depth = ui.report.depth || "quick";
        return startRun({ topic: topic.key, query: topic.query || "", depth: ui.depth });
      }
      case "clear-filters":
        ui.filters = { ...ui.filters, q: "", tier: "", lean: "", plant: "", use: "", brand: "", solo: false, online: false };
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
    if ($("#rs-q")) $("#rs-q").value = f.q;
    if ($("#rs-f-tier")) $("#rs-f-tier").value = f.tier;
    if ($("#rs-f-lean")) $("#rs-f-lean").value = f.lean;
    if ($("#rs-f-online")) $("#rs-f-online").checked = f.online;
    if ($("#rs-f-plant")) $("#rs-f-plant").value = f.plant;
    if ($("#rs-f-use")) $("#rs-f-use").value = f.use;
    if ($("#rs-f-brand")) $("#rs-f-brand").value = f.brand;
    if ($("#rs-f-solo")) $("#rs-f-solo").checked = f.solo;
  }

  /* "See products" on a brand card, trend or mover: filter the rankings to
     that brand (or search for it if the guide ranked none of its products). */
  function showBrand(name) {
    const ranked = (ui.report.guide.products || []).some((p) => p.brand === name);
    ui.filters = { ...ui.filters, q: ranked ? "" : name, tier: "", lean: "", plant: "", use: "", solo: false, online: false,
      brand: ranked ? name : "" };
    syncFilterInputs();
    drawCards();
    jumpTo("rs-rankings");
  }

  async function addToList(button, id) {
    const p = (ui.report.guide.products || []).find((item) => item.id === id);
    if (!p || !window.Cloudline) return;
    button.disabled = true;
    const note = `${ui.report.topic.label} guide: ${p.tier === "AVOID" ? "Avoid" : `${p.tier} tier`}, ${p.score.toFixed(1)}/10. ${p.verdict}`.slice(0, 1900);
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
        go(null);
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
    if (event.type === "change" && ["rs-q", "rs-bq", "rs-query", "rs-model-custom"].includes(t.id)) return undefined;
    if (t.name === "rs-topic") {
      ui.topic = t.value;
      ui.startError = "";
      const query = $(".rs-query");
      if (query) query.hidden = ui.topic !== "custom";
      if (ui.topic === "custom") $("#rs-query")?.focus();
      return;
    }
    if (t.id === "rs-query") {
      ui.query = t.value;
      return;
    }
    if (t.id === "rs-list-sort") {
      ui.listSort = t.value;
      savePrefs();
      return renderReportList();
    }
    if (t.id === "rs-model") {
      ui.choice[ui.provider].model = t.value;
      savePrefs();
      redrawModels();
      renderJob();
      renderPaused();
      if (t.value === "__custom") $("#rs-model-custom")?.focus();
      return undefined;
    }
    if (t.id === "rs-model-custom") {
      ui.choice[ui.provider].custom = t.value;
      savePrefs();
      return undefined;
    }
    if (t.id === "rs-effort") {
      ui.choice[ui.provider].effort = t.value;
      savePrefs();
      return undefined;
    }
    if (t.id === "rs-bq" || t.id === "rs-bsort") {
      if (t.id === "rs-bq") ui.brandQuery = t.value;
      else ui.brandSort = t.value;
      return drawBrands();
    }
    const filters = { "rs-q": "q", "rs-f-tier": "tier", "rs-f-lean": "lean", "rs-sort": "sort", "rs-f-online": "online",
      "rs-f-plant": "plant", "rs-f-use": "use", "rs-f-brand": "brand", "rs-f-solo": "solo" };
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

  if (root) {
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
    root.addEventListener("keydown", onKey);
    root.addEventListener("pointerover", showTip);
    root.addEventListener("focusin", showTip);
    root.addEventListener("pointerout", hideTip);
    root.addEventListener("focusout", hideTip);
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

  window.CloudlineResearch = { render };
  render();
})();
