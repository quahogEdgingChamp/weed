"use strict";

/* ── Entry point (the page calls this whenever the tab renders) ────────── */

function renderResearch() {
  if (!researchRoot || researchRoot.closest(".view").hidden) return;
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
  if (ui.reportName !== null || !qs(".rs-home")) {
    ui.reportName = null;
    ui.report = null;
    researchRoot.innerHTML = `
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
        <div id="rs-queue"></div>
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
  renderQueue();
  renderPaused();
  renderReportList();
  ui.lastJobId = ui.overview?.job?.id || null;
  if (ui.overview?.job?.status === "running" || queueEntries().length) startPolling();
}

function renderLaunch() {
  const box = qs("#rs-launch");
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
  const asking = ui.mode === "question";
  if (asking && ui.provider === "none") ui.provider = WRITERS.find((p) => providers[p]?.available) || "claude";
  const depthNote = asking ? {
    quick: "4 subreddits, the last 2 years · the model reads the ~30 most relevant threads",
    standard: "6 subreddits, the last 3 years · ~80 threads in one pass",
    deep: "8 subreddits, the last 5 years · ~200 threads and a comment search, read in parts",
  }[ui.depth] : {
    quick: `last ${o.depths.quick?.days || 120} days · the model reads the ~30 most relevant threads`,
    standard: `last ${o.depths.standard?.days || 365} days · the model reads ~90 threads in one pass`,
    deep: deepMode
      ? "last year · every relevant thread and every comment, read in parts, plus a brand search across the subreddits"
      : `last ${o.depths.deep?.days || 365} days · restart the server to get the new deep mode`,
  }[ui.depth];
  const writing = ui.provider !== "none";
  const limitedUntil = writing ? o.queue?.limited?.[ui.provider] : null;
  const minutes = writing
    ? { quick: "3–6 min", standard: "6–12 min", deep: "20–45 min" }
    : { quick: "1–3 min", standard: "2–5 min", deep: "5–15 min" };
  const deepCost =
    writing && ui.depth === "deep"
      ? " Deep makes one model call per part (often 8–15) plus one to write, so it uses several times a quick run's plan usage; a lighter model keeps that down."
      : "";

  box.innerHTML = `
    <section class="card rs-launch" aria-labelledby="rs-new-heading">
      <div class="rs-launch-head">
        <h2 id="rs-new-heading" class="panel-title">New research</h2>
        <div class="segmented" role="group" aria-label="What kind of research">
          <button type="button" data-mode="guide" aria-pressed="${!asking}">Product guide</button>
          <button type="button" data-mode="question" aria-pressed="${asking}">Ask a question</button>
        </div>
      </div>
      ${asking ? `<label class="rs-ask">
        <span>Ask anything. The writer picks where on Reddit people talk about it, searches there, reads the threads
        and answers from what people actually report, with their words quoted.</span>
        <textarea id="rs-question" rows="3" maxlength="300" placeholder="How do live resin carts affect studying? · Is a dry herb vape worth it over joints? · What helps with cotton mouth?">${esc(ui.question)}</textarea>
      </label>` : ""}
      <fieldset class="rs-topics" ${asking ? "hidden" : ""}>
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
      <label class="rs-query" ${ui.topic === "custom" && !asking ? "" : "hidden"}>
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
                const available = p === "none" ? !asking : providers[p]?.available;
                return `<button type="button" data-provider="${p}" aria-pressed="${ui.provider === p}" ${available ? "" : "disabled"}
                  ${available ? "" : `title="${p === "none" ? "A question needs a model to plan the search and write the answer" : `The ${p} CLI isn't installed on the server`}"`}>${PROVIDER_LABEL[p]}</button>`;
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
      ${
        writing
          ? `<label class="rs-check"><input type="checkbox" id="rs-auto" ${ui.autoContinue ? "checked" : ""} />
              If ${esc(PROVIDER_LABEL[ui.provider])} hits its usage limit, continue by itself when the limit resets</label>`
          : ""
      }
      <div class="rs-start-row">
        <button id="rs-start" class="btn btn-primary rs-start" type="button" ${ui.starting ? "disabled" : ""}>
          ${ui.starting ? "Starting…" : running ? "Add to queue" : limitedUntil ? `Queue for ${esc(clock(limitedUntil))}` : "Start research"}
        </button>
        ${
          limitedUntil && !running
            ? `<button class="btn btn-secondary" type="button" data-act="start-now">Start now anyway</button>`
            : ""
        }
      </div>
      ${
        running
          ? `<p class="rs-hint">One run at a time: this one starts when the runs ahead of it finish.</p>`
          : limitedUntil
            ? `<p class="rs-hint">${esc(PROVIDER_LABEL[ui.provider])}'s usage limit should reset about ${esc(clock(limitedUntil))}; queued runs with it wait until then.</p>`
            : ""
      }
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
  const row = qs("#rs-model-row");
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
      ${
        ["high", "xhigh", "max", "ultra"].includes(c.effort)
          ? `<label class="rs-check rs-light"><input type="checkbox" id="rs-light" ${ui.lightReading ? "checked" : ""} />
              Read the evidence at medium thinking, and use ${esc(c.effort)} only for writing the guide</label>
            <p class="rs-hint">${ui.lightReading ? "Much faster and lighter on your plan; the guide still gets full thinking." : "Every part at " + esc(c.effort) + ": slow (Grok took 7–20 min per part at xhigh), and heavy on your plan."}</p>`
          : ""
      }
    </div>`;
}

function renderJob() {
  const box = qs("#rs-job");
  if (!box) return;
  const job = ui.overview && ui.overview.job;
  if (!job || (job.status !== "running" && job.id !== ui.watchedJob)) {
    box.innerHTML = "";
    return;
  }
  const stages = (job.stages || GUIDE_STAGES).map((key) => [key, STAGE_LABELS[key] || key]);
  const reached = stages.findIndex(([key]) => key === job.stage);
  const counts = job.counts || {};
  const facts = [
    ["posts_scanned", "posts scanned"],
    ["posts_relevant", job.kind === "question" ? "threads look relevant" : "on topic"],
    ["searches_done", "searches done"],
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
          ${
            job.status === "running"
              ? `<p class="rs-eta">${
                  job.estimate
                    ? `<strong>${esc(timeLeft(job.estimate.seconds))} left</strong> <span class="rs-hint">${esc(job.estimate.basis)}</span>`
                    : `<span class="rs-hint">Working out how long this will take…</span>`
                }</p>`
              : ""
          }
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
        ${stages.map(([key, label], i) => {
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
      ${fullLog(job)}
      ${
        job.status === "paused" && job.continuesAt
          ? `<p class="rs-paused-note">${esc(job.error || "Paused.")} Everything read so far is saved, and it
              continues by itself about <strong>${esc(clock(job.continuesAt))}</strong> (see Up next). To finish
              sooner, pick another writer or model under “Who writes the guide”.</p>`
          : job.status === "paused"
          ? `<p class="rs-paused-note">${esc(job.error || "Paused.")} Everything read so far is saved: ${
              /limit/i.test(job.error || "")
                ? "continue once the limit resets, or finish now with another writer or model"
                : "try again, or finish with another writer or model"
            } picked under “Who writes the guide”.</p>`
          : job.error
            ? `<p class="rs-error">${esc(job.error)}</p>`
            : ""
      }
    </section>`;
}

/* Everything the run has said so far, grouped by step, with repeated
   progress folded and problems marked (Core.foldLog). Stays open across
   the redraws while it runs. */
function fullLog(job) {
  const groups = Core.foldLog(job.log || []);
  if (!groups.length) return "";
  const warnings = groups.reduce((n, g) => n + g.warnings, 0);
  const lines = groups.reduce((n, g) => n + g.items.length, 0);
  const time = (iso) => {
    const at = new Date(iso || "");
    return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  };
  return `<details class="rs-full-log" ${ui.logOpen ? "open" : ""}>
    <summary>Full log · ${lines} ${lines === 1 ? "line" : "lines"}${
      warnings ? ` · <span class="rs-log-warn">${warnings} ${warnings === 1 ? "problem" : "problems"}</span>` : ""
    }</summary>
    ${groups
      .map(
        (g) => `<section class="rs-log-group">
          <h3>${esc(STAGE_LABELS[g.stage] || (g.stage === "paused" ? "Paused" : g.stage === "error" ? "Error" : g.stage || "Run"))}
            <span class="rs-hint">${esc(time(g.from))}</span></h3>
          <ol>${g.items
            .map(
              (item) => `<li class="${item.warning ? "is-warn" : ""}"><span class="rs-hint">${esc(time(item.at))}</span>
                ${item.warning ? `<strong>Problem:</strong> ` : ""}${esc(item.message)}${
                  item.count > 1 ? ` <span class="rs-hint">(×${item.count})</span>` : ""
                }</li>`
            )
            .join("")}</ol>
        </section>`
      )
      .join("")}
  </details>`;
}

/* Continue with the writer the run used, or with whatever is picked in the
   launcher below (another provider, or another model). */
function continueButtons(run) {
  const same = { provider: run.provider || "claude", model: run.model || "", effort: run.effort || "" };
  const picked = { provider: ui.provider, model: ui.provider === "none" ? "" : currentModel(), effort: ui.provider === "none" ? "" : ui.choice[ui.provider].effort };
  const describe = (w) => `${PROVIDER_LABEL[w.provider] || w.provider}${w.model ? ` (${w.model})` : ""}`;
  const differs = picked.provider !== "none" && (picked.provider !== same.provider || picked.model !== same.model);
  /* While another run is going, these queue the continue instead. */
  const busy = ui.overview?.job?.status === "running";
  const queued = queueEntries().some((e) => e.checkpoint === run.id);
  const verb = busy ? "Queue: " : "";
  return `<div class="rs-continue">
    ${
      queued
        ? ""
        : `<button class="btn btn-primary btn-small" type="button"
            data-resume="${esc(run.id)}" data-provider-to="${esc(same.provider)}" data-model-to="${esc(same.model)}" data-effort-to="${esc(same.effort)}">
            ${verb}${busy ? "continue" : "Continue"} with ${esc(describe(same))}</button>`
    }
    ${
      differs
        ? `<button class="btn btn-secondary btn-small" type="button"
            data-resume="${esc(run.id)}" data-provider-to="${esc(picked.provider)}" data-model-to="${esc(picked.model)}" data-effort-to="${esc(picked.effort)}">
            ${verb}${busy ? "finish" : "Finish"} with ${esc(describe(picked))}</button>`
        : ""
    }
    <button class="btn btn-ghost btn-small" type="button" data-discard="${esc(run.id)}">Discard</button>
  </div>`;
}

function queueEntries() {
  return ui.overview?.queue?.entries || [];
}

/* Runs waiting their turn. A run paused by a usage limit comes back here,
   at the front, and waits for that writer's limit to reset. */
function renderQueue() {
  const box = qs("#rs-queue");
  if (!box || !ui.overview) return;
  const entries = queueEntries();
  if (!entries.length) {
    box.innerHTML = "";
    return;
  }
  const busy = ui.overview.job?.status === "running";
  const checkpoints = new Map((ui.overview.checkpoints || []).map((c) => [c.id, c]));
  const firstReady = entries.findIndex((e) => !e.waitingUntil);
  const status = (e, i) => {
    const who = PROVIDER_LABEL[e.provider] || e.provider;
    if (e.waitingUntil) return `Waits for ${who}'s usage limit to reset, about ${clock(e.waitingUntil)}`;
    if (i === firstReady) return busy ? "Next, when the current run finishes" : "Starting…";
    return "Waiting its turn";
  };
  const what = (e) => {
    if (e.kind !== "resume") return "";
    const c = checkpoints.get(e.checkpoint);
    const read = c && c.parts ? `${num(c.partsDone)} of ${num(c.parts)} parts read` : "evidence gathered";
    return e.restarted ? ` · picks up after the server restarted (${read})` : ` · continues a paused run (${read})`;
  };
  box.innerHTML = `<section class="rs-saved" aria-labelledby="rs-queue-heading">
    <h2 id="rs-queue-heading" class="rs-h2">Up next <span class="rs-count">${entries.length}</span></h2>
    <ol class="rs-report-list rs-queue">${entries
      .map(
        (e, i) => `<li class="card rs-paused-item" data-waiting="${e.waitingUntil ? "limit" : ""}">
          <div class="rs-paused-text">
            <span class="rs-eyebrow">${esc(e.label || "Research")} · ${esc(e.depth)} · ${esc(
              e.provider === "none"
                ? "counts only"
                : `${PROVIDER_LABEL[e.provider] || e.provider}${e.model ? ` (${e.model}${e.effort ? `, ${e.effort}` : ""})` : ""}`
            )}${esc(what(e))}</span>
            <span class="rs-report-title">${esc(status(e, i))}</span>
          </div>
          <div class="rs-continue">
            ${i > 0 ? `<button class="btn btn-secondary btn-small" type="button" data-queue-first="${esc(e.id)}">Move to front</button>` : ""}
            <button class="btn btn-ghost btn-small" type="button" data-queue-remove="${esc(e.id)}">${
              e.auto || e.restarted ? "Don't continue by itself" : "Remove"
            }</button>
          </div>
        </li>`
      )
      .join("")}</ol>
  </section>`;
}

async function queueAction(path, method) {
  try {
    const { queue } = await api(`${API}/queue/${path}`, { method, body: method === "POST" ? "{}" : undefined });
    ui.overview.queue = queue;
  } catch (error) {
    window.Cloudline?.toast(error.message === "Not found" ? "That run already left the queue." : error.message);
    await loadOverview();
  }
  renderQueue();
  renderPaused();
  renderLaunch();
}

/* Runs saved at a checkpoint: paused by a usage limit, stopped, or cut off
   by a server restart. Hidden while that same run is going. */
function renderPaused() {
  const box = qs("#rs-paused");
  if (!box || !ui.overview) return;
  const job = ui.overview.job;
  const live = job && job.status === "running" ? job.checkpoint : null;
  const shownInPanel = job && job.id === ui.watchedJob && job.checkpoint;
  const queued = new Set(queueEntries().map((e) => e.checkpoint).filter(Boolean));
  const runs = (ui.overview.checkpoints || []).filter((c) => c.id !== live && c.id !== shownInPanel && !queued.has(c.id));
  if (!runs.length) {
    box.innerHTML = "";
    return;
  }
  const why = (c) =>
    c.status === "paused"
      ? `${PROVIDER_LABEL[c.provider] || "The writer"} hit its usage limit${c.resets ? `; resets ${c.resets}` : ""}`
      : c.status === "stopped"
        ? "Stopped by you"
        : c.status === "failed"
          ? c.reason || "The writer couldn't finish"
          : "Interrupted (the server restarted mid-run)";
  box.innerHTML = `<section class="rs-saved" aria-labelledby="rs-paused-heading">
    <h2 id="rs-paused-heading" class="rs-h2">Waiting to continue</h2>
    <ul class="rs-report-list">${runs
      .map(
        (c) => `<li class="card rs-paused-item">
          <div class="rs-paused-text">
            <span class="rs-eyebrow">${c.kind === "question" ? "Question · " : ""}${esc(c.topic?.label || "Research")} · ${esc(c.depth)} · started ${esc(when(c.createdAt))}</span>
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
  const queue = ui.overview?.job?.status === "running";
  try {
    const { job, queued, queue: waiting } = await api(`${API}/resume`, {
      method: "POST",
      body: JSON.stringify({ checkpoint, provider, model, effort, lightReading: ui.lightReading, autoContinue: ui.autoContinue, queue }),
    });
    if (waiting) ui.overview.queue = waiting;
    ui.overview.job = job;
    if (!queue) ui.watchedJob = job.id;
    ui.lastJobId = job?.id || null;
    renderJob();
    renderQueue();
    renderPaused();
    renderLaunch();
    startPolling();
    if (queued) {
      window.Cloudline?.toast("Queued: it continues when the runs ahead of it finish.");
      return;
    }
    window.requestAnimationFrame(() => qs("#rs-job")?.scrollIntoView({ behavior: "smooth", block: "start" }));
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
  renderQueue();
  renderPaused();
  window.Cloudline?.toast("Paused run discarded.");
}

const LIST_SORTS = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["writer", "Who wrote it"],
  ["depth", "Deepest first"],
  ["topic", "Topic A–Z"],
  ["read", "Most comments read"],
  ["products", "Most products"],
];
const DEPTH_RANK = { deep: 0, standard: 1, quick: 2 };
const DEPTH_LABEL = { deep: "Deep", standard: "Standard", quick: "Quick" };
const EFFORT_RANK = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal"];

/* The writer a guide is filed under: its provider, or "counts" when no
   model wrote it. Old guides may not say; they count as counts-only. */
const writerOf = (r) => (!r.by || r.by === "counts" ? "counts" : r.by);
// Same order as the launcher: Claude, Codex, Grok, anything else, counts last.
const writerRank = (r) => (writerOf(r) === "counts" ? WRITERS.length + 1 : WRITERS.includes(r.by) ? WRITERS.indexOf(r.by) : WRITERS.length);
const effortRank = (r) => (EFFORT_RANK.includes(r.effort) ? EFFORT_RANK.indexOf(r.effort) : EFFORT_RANK.length);
const depthRank = (r) => DEPTH_RANK[r.depth] ?? 3;
const writerGroup = (r) => `${writerOf(r)}|${writerOf(r) === "counts" ? "" : r.model || ""}`;

/* How a grouped sort labels its sections. The sort keeps each group's
   guides together, so a new heading goes wherever the key changes. */
const LIST_GROUPS = {
  writer: (r) => {
    const by = writerOf(r);
    if (by === "counts") return { id: writerGroup(r), label: "Counts only", detail: "no model" };
    return { id: writerGroup(r), label: PROVIDER_LABEL[by] || by, detail: r.model || "model not recorded" };
  },
  depth: (r) => ({ id: r.depth || "", label: DEPTH_LABEL[r.depth] || "Depth not recorded" }),
  topic: (r) => ({ id: r.topic?.label || "", label: r.topic?.label || "Research" }),
};

function sortReports(list) {
  const byDate = (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "");
  // Within a writer, the model used most recently comes first.
  const latest = new Map();
  for (const r of list) {
    const key = writerGroup(r);
    if ((r.createdAt || "") > (latest.get(key) || "")) latest.set(key, r.createdAt);
  }
  const sorts = {
    newest: byDate,
    oldest: (a, b) => -byDate(a, b),
    topic: (a, b) => (a.topic?.label || "").localeCompare(b.topic?.label || "") || byDate(a, b),
    writer: (a, b) =>
      writerRank(a) - writerRank(b) ||
      writerOf(a).localeCompare(writerOf(b)) ||
      (latest.get(writerGroup(b)) || "").localeCompare(latest.get(writerGroup(a)) || "") ||
      writerGroup(a).localeCompare(writerGroup(b)) ||
      depthRank(a) - depthRank(b) ||
      effortRank(a) - effortRank(b) ||
      byDate(a, b),
    // A deep guide a model read beats a deep one built from counts.
    depth: (a, b) =>
      depthRank(a) - depthRank(b) ||
      (writerOf(a) === "counts") - (writerOf(b) === "counts") ||
      (b.stats?.commentsRead || 0) - (a.stats?.commentsRead || 0) ||
      byDate(a, b),
    read: (a, b) => (b.stats?.commentsRead || 0) - (a.stats?.commentsRead || 0) || byDate(a, b),
    products: (a, b) => (b.products || 0) - (a.products || 0) || byDate(a, b),
  };
  return [...list].sort(sorts[ui.listSort] || byDate);
}

function groupReports(list) {
  const key = LIST_GROUPS[ui.listSort];
  if (!key) return [{ id: "", items: list }];
  const groups = [];
  for (const r of list) {
    const g = key(r);
    const last = groups[groups.length - 1];
    if (last && last.id === g.id) last.items.push(r);
    else groups.push({ ...g, items: [r] });
  }
  return groups;
}

function reportGroup(g) {
  const list = `<ul class="rs-report-list">${g.items.map(reportItem).join("")}</ul>`;
  if (!g.label) return list;
  return `<section class="rs-list-group">
    <h3 class="rs-list-group-title">${esc(g.label)}${g.detail ? ` <span class="rs-list-group-detail">${esc(g.detail)}</span>` : ""}
      <span class="tab-count">${g.items.length}</span></h3>
    ${list}
  </section>`;
}

function renderReportList() {
  const box = qs("#rs-reports");
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
        ? groupReports(shown).map(reportGroup).join("")
        : `<p class="rs-empty">Every guide is archived. <button class="btn btn-ghost btn-small" type="button" data-list="archived">Show archived</button></p>`
    }`;
}

function reportItem(r) {
  const s = r.stats || {};
  const title = esc(r.headline || r.name);
  return `<li class="card rs-report-item${r.archived ? " is-archived" : ""}">
    <button class="rs-report-open" type="button" data-open="${esc(r.name)}">
      <span class="rs-eyebrow">${r.kind === "question" ? "Question · " : ""}${esc(r.topic?.label || "Research")} · ${esc(when(r.createdAt))} · ${esc(r.depth)}${
        r.archived ? ` · archived${r.archivedAt ? ` ${esc(when(r.archivedAt))}` : ""}` : ""
      }</span>
      <span class="rs-report-title">${esc(r.headline || "Untitled guide")}</span>
      ${r.kind === "question" && r.question ? `<span class="rs-hint rs-asked">“${esc(r.question)}”</span>` : ""}
      <span class="rs-hint">${r.kind === "question" ? `${r.findings} findings` : `${r.products} products`} · ${num(s.postsScanned)} posts ${r.kind === "question" ? "found" : "scanned"} ·
        ${num(s.commentsRead)} comments ${s.threadsFetched != null ? "read" : "fetched"} · ${esc(writtenBy(r.by, r.model, r.effort))}${
          r.readers ? `; parts read by ${esc(Object.entries(r.readers).map(([who, n]) => `${who} ×${n}`).join(", "))}` : ""
        }</span>
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
    const button = qs("[data-act='archive-this']");
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

async function startRun({ topic = ui.mode === "question" ? "question" : ui.topic, query = ui.mode === "question" ? ui.question : ui.query,
  depth = ui.depth, provider = ui.provider, now = false } = {}) {
  if (topic === "question" && query.trim().split(/\s+/).length < 3) {
    ui.startError = "Type your question first: a few words at least.";
    renderLaunch();
    qs("#rs-question")?.focus();
    return;
  }
  if (topic === "custom" && !query.trim()) {
    ui.startError = "Type what to research first.";
    renderLaunch();
    qs("#rs-query")?.focus();
    return;
  }
  ui.starting = true;
  ui.startError = "";
  renderLaunch();
  /* Queue behind a running run, or behind this writer's usage limit;
     "Start now anyway" skips the limit wait. */
  const running = ui.overview?.job?.status === "running";
  const queue = running || (!now && provider !== "none" && Boolean(ui.overview?.queue?.limited?.[provider]));
  try {
    const { job, queued, queue: waiting } = await api(`${API}/jobs`, {
      method: "POST",
      body: JSON.stringify({
        topic,
        query,
        depth,
        provider,
        llm: provider !== "none",
        model: provider === "none" ? "" : currentModel(provider),
        effort: provider === "none" ? "" : ui.choice[provider].effort,
        lightReading: ui.lightReading,
        autoContinue: ui.autoContinue,
        queue,
      }),
    });
    if (waiting) ui.overview.queue = waiting;
    ui.overview.job = job;
    const startedNow = job && job.status === "running" && job.id !== ui.lastJobId;
    if (!queued || startedNow) ui.watchedJob = job.id;
    ui.lastJobId = job?.id || null;
    startPolling();
    if (queued && !startedNow) {
      window.Cloudline?.toast(`Queued: ${queued.label}.`);
      window.requestAnimationFrame(() => qs("#rs-queue")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.requestAnimationFrame(() => qs("#rs-job")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  } catch (error) {
    ui.startError = error.message;
    if (error.payload?.job) ui.overview.job = error.payload.job;
  } finally {
    ui.starting = false;
    if (reportParam()) {
      goResearch(null);
    } else {
      renderLaunch();
      renderJob();
      renderQueue();
      renderPaused();
    }
  }
}

/* Fast while a run goes; slowly while runs only wait in the queue (for a
   usage limit), so the page notices when one starts. */
function startPolling() {
  if (ui.pollTimer) return;
  const tick = async () => {
    ui.pollTimer = null;
    let fresh;
    try {
      fresh = await api(API);
    } catch (error) {
      ui.pollTimer = window.setTimeout(tick, RESEARCH_POLL_MS * 4);
      return;
    }
    const job = fresh.job;
    const before = ui.overview?.job;
    const wasRunning = before?.status === "running";
    const switched = Boolean(job && ui.lastJobId && job.id !== ui.lastJobId);
    ui.lastJobId = job?.id || null;
    ui.overview.job = job;
    ui.overview.queue = fresh.queue;
    const waiting = (fresh.queue?.entries || []).length > 0;
    if (job && job.status === "running") {
      ui.pollTimer = window.setTimeout(tick, RESEARCH_POLL_MS);
    } else if (waiting) {
      ui.pollTimer = window.setTimeout(tick, RESEARCH_POLL_MS * 10);
    }
    if (wasRunning && (job?.status !== "running" || switched)) {
      await loadOverview();
      /* The run the page was showing has ended; a queued one may already
         have taken its place, so read how it ended from "recent". */
      const ended = switched ? (fresh.queue?.recent || []).find((r) => r.id === before.id) : job;
      const nextStarted = switched && job?.status === "running";
      if (ended?.status === "done") {
        if (ended.id === ui.watchedJob && !nextStarted && !reportParam() && isVisible()) {
          window.Cloudline?.toast(`Your ${ended.label} guide is ready.`);
          goResearch(ended.report);
          return;
        }
        window.Cloudline?.toast(`Your ${ended.label} guide is ready${nextStarted ? `; ${job.label} is next` : ""}.`);
      } else if (ended?.status === "paused") {
        if (!nextStarted) ui.watchedJob = ended.id;
        window.Cloudline?.toast(
          ended.continuesAt
            ? `Paused: ${ended.label} continues by itself about ${clock(ended.continuesAt)}.`
            : `Paused: ${ended.error || "the writer hit its usage limit"}`
        );
      }
    } else if (switched) {
      await loadOverview(); /* a queued run started while nothing was going */
    }
    if (!reportParam()) {
      renderJob();
      renderQueue();
      if (!job || job.status !== "running" || switched) {
        renderLaunch();
        renderPaused();
        renderReportList();
      }
    }
  };
  ui.pollTimer = window.setTimeout(tick, RESEARCH_POLL_MS);
}

function isVisible() {
  return researchRoot && !researchRoot.closest(".view").hidden;
}
