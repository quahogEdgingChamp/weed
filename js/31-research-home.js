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
          <div id="rs-reports" aria-busy="true">${skeletonList()}</div>
        </section>
      </div>`;
  }
  if (!ui.overview) await loadOverview();
  if (reportParam()) return; /* the user moved on while this loaded */
  qs("#rs-reports")?.removeAttribute("aria-busy");
  renderLaunch();
  renderJob();
  renderQueue();
  renderPaused();
  renderReportList();
  ui.lastJobId = ui.overview?.job?.id || null;
  if (ui.overview?.job?.status === "running" || queueEntries().length) startPolling();
}

/* What the launcher shows depends on these; a poll redraws it only when one
   changed, so a form being filled in isn't redrawn every few seconds. */
function launchKey() {
  const o = ui.overview || {};
  const available = Object.entries(o.providers || {}).map(([p, v]) => `${p}:${Boolean(v?.available)}`);
  return [o.job?.status === "running", JSON.stringify(o.queue?.limited || {}), available.join(","), ui.overviewError].join("|");
}

const STEP = (n) => `<span class="rs-num" aria-hidden="true">${n}</span>`;

/* How far each depth goes, as short facts rather than a paragraph. */
function depthFacts(o, asking) {
  const deepMode = o.depths?.deep?.mode === "batches";
  if (asking) {
    return {
      quick: ["4 subreddits, the last 2 years", "the ~30 most relevant threads, in one pass"],
      standard: ["6 subreddits, the last 3 years", "~80 threads, in one pass"],
      deep: ["8 subreddits, the last 5 years", "~200 threads and a comment search, in parts"],
    }[ui.depth];
  }
  return {
    quick: [`the last ${o.depths.quick?.days || 120} days`, "the ~30 most relevant threads, in one pass"],
    standard: [`the last ${o.depths.standard?.days || 365} days`, "~90 threads, in one pass"],
    deep: deepMode
      ? ["the last year, plus a brand search across the subreddits", "every relevant thread and every comment, in parts"]
      : [`the last ${o.depths.deep?.days || 365} days`, "restart the server to get the new deep mode"],
  }[ui.depth];
}

function runMinutes() {
  return (ui.provider !== "none"
    ? { quick: "3–6 min", standard: "6–12 min", deep: "20–45 min" }
    : { quick: "1–3 min", standard: "2–5 min", deep: "5–15 min" })[ui.depth];
}

const WRITER_HINT = {
  claude: "Uses your Claude Code plan through the claude CLI.",
  codex: "Uses your ChatGPT / Codex plan through the codex CLI.",
  grok: "Uses your SuperGrok / X Premium+ plan through the grok CLI (Grok Build).",
  none: "No model: tiers come from mention counts and a keyword tone score. Rougher, but free and quicker.",
};

/* Placeholder rows the size of saved guides, so the page doesn't jump
   when the list arrives. */
function skeletonList() {
  return `<span class="sr-only">Loading saved guides…</span><ul class="rs-report-list" aria-hidden="true">${
    '<li class="card rs-skeleton"><span></span><span></span><span></span></li>'.repeat(3)
  }</ul>`;
}

function renderLaunch() {
  const box = qs("#rs-launch");
  if (!box) return;
  ui.launchKey = launchKey();
  if (ui.overviewError) {
    box.innerHTML = `<section class="card rs-launch"><p class="rs-error">${esc(ui.overviewError)}</p>
      <button class="btn btn-secondary" type="button" data-act="reload">Try again</button></section>`;
    return;
  }
  const o = ui.overview;
  const providers = o.providers || {};
  const asking = ui.mode === "question";
  if (asking && ui.provider === "none") ui.provider = WRITERS.find((p) => providers[p]?.available) || "claude";
  if (!o.topics.some((t) => t.key === ui.topic)) ui.topic = o.topics[0]?.key || "custom";
  const writing = ui.provider !== "none";
  const [covers, reads] = depthFacts(o, asking);
  const deepCost = writing && ui.depth === "deep"
    ? "Deep makes one model call per part (often 8–15) plus one to write: several times a quick run's usage. A lighter model keeps that down."
    : "";

  redrawKeepingFocus(box, () => {
    box.innerHTML = `
    <section class="card rs-launch" aria-labelledby="rs-new-heading">
      <div class="rs-launch-head">
        <h2 id="rs-new-heading" class="panel-title">New research</h2>
        <div class="segmented rs-modes" role="group" aria-label="What kind of research">
          <button type="button" data-mode="guide" aria-pressed="${!asking}">Product guide</button>
          <button type="button" data-mode="question" aria-pressed="${asking}">Ask a question</button>
        </div>
      </div>
      <div class="rs-field">
        ${asking ? `<label class="rs-option-label" for="rs-question">${STEP(1)}Your question</label>
        <div class="rs-ask">
          <span>The writer picks where on Reddit people talk about it, searches there, reads the threads and answers
          from what people actually report, with their words quoted.</span>
          <textarea id="rs-question" rows="3" maxlength="300" placeholder="How do live resin carts affect studying? · Is a dry herb vape worth it over joints? · What helps with cotton mouth?">${esc(ui.question)}</textarea>
        </div>` : `<fieldset class="rs-topics-set">
          <legend class="rs-option-label">${STEP(1)}What to research</legend>
          <div class="rs-topics">
          ${o.topics
            .map(
              (t) => `<label class="rs-topic">
                <input type="radio" name="rs-topic" value="${esc(t.key)}" ${ui.topic === t.key ? "checked" : ""} />
                <span class="rs-topic-label">${esc(t.label)}</span>
                <span class="rs-topic-blurb">${esc(t.blurb)}</span>
              </label>`
            )
            .join("")}
          </div>
        </fieldset>
        <label class="rs-query" ${ui.topic === "custom" ? "" : "hidden"}>
          <span>What should it look for? Every word has to appear in a post.</span>
          <input id="rs-query" type="text" maxlength="120" placeholder="e.g. cold cure rosin, blueberry cart, infused pre-roll" value="${esc(ui.query)}" />
        </label>`}
      </div>
      <div class="rs-options">
        <div>
          <p class="rs-option-label" id="rs-depth-label">${STEP(2)}How deep</p>
          <div class="segmented" role="group" aria-labelledby="rs-depth-label">
            ${["quick", "standard", "deep"]
              .map((d) => `<button type="button" data-depth="${d}" aria-pressed="${ui.depth === d}">${DEPTH_LABEL[d]}</button>`)
              .join("")}
          </div>
          <dl class="rs-depth-facts">
            <div><dt>Covers</dt><dd>${esc(covers)}</dd></div>
            <div><dt>Reads</dt><dd>${esc(reads)}</dd></div>
            <div><dt>Takes</dt><dd>about ${esc(runMinutes())} the first time, quicker after</dd></div>
          </dl>
          ${deepCost ? `<p class="rs-hint">${esc(deepCost)}</p>` : ""}
        </div>
        <div>
          <p class="rs-option-label" id="rs-writer-label">${STEP(3)}${asking ? "Who answers" : "Who writes the guide"}</p>
          <div class="segmented rs-writers${writing ? "" : " is-off"}" role="group" aria-labelledby="rs-writer-label">
            ${WRITERS.map((p) => {
              const available = providers[p]?.available;
              return `<button type="button" data-provider="${p}" aria-pressed="${ui.provider === p}" ${available ? "" : "disabled"}
                ${available ? "" : `title="The ${p} CLI isn't installed on the server"`}>${PROVIDER_LABEL[p]}</button>`;
            }).join("")}
          </div>
          <p class="rs-hint">${esc(WRITER_HINT[ui.provider] || "")}${writing ? " Every quote is checked against the real comment." : ""}</p>
          ${asking ? "" : `<label class="rs-check"><input type="checkbox" id="rs-counts" ${writing ? "" : "checked"} />
            Counts only: no model writes it</label>`}
          ${writing ? `<label class="rs-check"><input type="checkbox" id="rs-auto" ${ui.autoContinue ? "checked" : ""} />
            Automatically resume when the ${esc(PROVIDER_LABEL[ui.provider])} usage limit resets</label>` : ""}
        </div>
      </div>
      ${writing ? `<div class="rs-options rs-model-row" id="rs-model-row" role="group" aria-labelledby="rs-model-label">${modelControls()}</div>` : ""}
      <div class="rs-start-foot" id="rs-start-foot">${startFoot()}</div>
    </section>`;
  });
}

/* The footer: what will run, roughly how long, and the button. Redrawn on
   its own as the form changes, so typing never loses its place. */
function startFoot() {
  const o = ui.overview;
  const running = o.job && o.job.status === "running";
  const writing = ui.provider !== "none";
  const limitedUntil = writing ? o.queue?.limited?.[ui.provider] : null;
  const asking = ui.mode === "question";
  const problem = Core.researchStartProblem({ mode: ui.mode, topic: ui.topic, query: ui.query, question: ui.question, provider: ui.provider });
  const topic = asking
    ? "Question"
    : ui.topic === "custom"
      ? ui.query.trim() ? `“${ui.query.trim()}”` : "Custom search"
      : o.topics.find((t) => t.key === ui.topic)?.label || ui.topic;
  const parts = [topic, DEPTH_LABEL[ui.depth]];
  if (writing) {
    const c = ui.choice[ui.provider];
    const listed = (ui.models[ui.provider]?.models || []).find((m) => m.id === c.model);
    const model = c.model === "__custom" ? c.custom.trim() || "a typed model" : listed?.label || c.model || "default model";
    parts.push(`${PROVIDER_LABEL[ui.provider]} / ${model}`);
    if (c.effort) {
      const light = ui.lightReading && Core.lightReadingApplies({ mode: ui.mode, depth: ui.depth, provider: ui.provider, effort: c.effort });
      parts.push(`${c.effort[0].toUpperCase()}${c.effort.slice(1)} thinking${light ? " (reads at medium)" : ""}`);
    }
  } else {
    parts.push("Counts only");
  }
  const label = ui.starting ? "Starting…" : running ? "Add to queue" : limitedUntil ? `Queue for ${clock(limitedUntil)}` : "Start research";
  return `
    <div class="rs-summary">
      <p class="rs-summary-line">${esc(parts.join(" · "))}</p>
      <p class="rs-hint${problem ? " is-problem" : ""}" id="rs-start-why">${esc(
        problem ||
          (running
            ? "One run at a time: this one starts when the runs ahead of it finish."
            : limitedUntil
              ? `${PROVIDER_LABEL[ui.provider]}'s usage limit should reset about ${clock(limitedUntil)}; queued runs with it wait until then.`
              : `About ${runMinutes()} the first time.`)
      )}</p>
    </div>
    <div class="rs-start-row">
      ${limitedUntil && !running && !ui.starting
        ? `<button class="btn btn-secondary" type="button" data-act="start-now" ${problem ? "disabled" : ""}>Start now anyway</button>`
        : ""}
      <button id="rs-start" class="btn btn-primary rs-start" type="button" aria-describedby="rs-start-why"
        ${ui.starting || problem ? "disabled" : ""} ${ui.starting ? 'aria-busy="true"' : ""}>${esc(label)}</button>
    </div>
    ${ui.startError ? `<p class="rs-error rs-start-error" role="alert">${esc(ui.startError)}</p>` : ""}`;
}

function drawStartFoot() {
  const foot = qs("#rs-start-foot");
  if (foot) redrawKeepingFocus(foot, () => (foot.innerHTML = startFoot()));
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
  if (row) redrawKeepingFocus(row, () => (row.innerHTML = modelControls()));
  drawStartFoot();
}

function currentModel(provider = ui.provider) {
  const c = ui.choice[provider];
  return c.model === "__custom" ? c.custom.trim() : c.model;
}

/* Model and thinking for the picked writer. Each writer keeps its own
   choice, so switching writers never carries a model across; a model the
   CLI no longer lists falls back to its default (Core.settleModelChoice). */
function modelControls() {
  const provider = ui.provider;
  if (provider === "none") return "";
  const entry = ui.models[provider];
  if (!entry) {
    window.setTimeout(() => loadModels(provider), 0);
  }
  const models = entry?.models || [];
  const settled = Core.settleModelChoice(ui.choice[provider], entry, provider);
  if (JSON.stringify(settled.choice) !== JSON.stringify(ui.choice[provider])) {
    ui.choice[provider] = settled.choice;
    saveResearchPrefs();
  }
  if (settled.dropped) ui.droppedModel = { provider, model: settled.dropped };
  const c = ui.choice[provider];
  const { chosen, fallback, efforts } = settled;
  const dropped = ui.droppedModel?.provider === provider && !c.model ? ui.droppedModel.model : "";
  const defaultLabel = provider !== "claude" && fallback ? `CLI default (${fallback.label})` : "CLI default";
  const modelHint =
    entry?.state === "loading"
      ? "Asking the CLI which models it has…"
      : dropped
        ? `${dropped} isn't in ${PROVIDER_LABEL[provider]}'s model list any more, so the CLI default is used.`
        : chosen?.description || entry?.note || "";
  const heavy = ["high", "xhigh", "max", "ultra"].includes(c.effort);
  const applies = Core.lightReadingApplies({ mode: ui.mode, depth: ui.depth, provider, effort: c.effort });
  const lightHint = !applies
    ? `No effect on this run: a ${DEPTH_LABEL[ui.depth].toLowerCase()} guide is read in one pass, all at ${c.effort}. It matters for Deep, for Grok and for questions, which read the evidence in parts.`
    : ui.lightReading
      ? "Much faster and lighter on your plan; the guide still gets full thinking."
      : `Every part at ${c.effort}: slow (Grok took 7–20 min per part at xhigh), and heavy on your plan.`;
  return `
    <p class="rs-option-label rs-row-label" id="rs-model-label">${STEP(4)}Model and thinking</p>
    <div>
      <label class="rs-sub-label" for="rs-model">Model</label>
      <div class="rs-inline">
        <label class="select rs-grow"><select id="rs-model">
          <option value="" ${c.model === "" ? "selected" : ""}>${esc(defaultLabel)}</option>
          ${models.map((m) => `<option value="${esc(m.id)}" ${c.model === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
          <option value="__custom" ${c.model === "__custom" ? "selected" : ""}>Other (type a name)…</option>
        </select></label>
        <button class="btn btn-ghost btn-small rs-icon-btn" type="button" data-act="refresh-models" title="Ask the CLI for its models again"
          ${entry?.state === "loading" ? "disabled" : ""}>
          <svg class="icon" aria-hidden="true"><use href="#i-refresh" /></svg><span class="sr-only">Refresh the model list</span>
        </button>
      </div>
      ${c.model === "__custom" ? `<input id="rs-model-custom" type="text" maxlength="80" spellcheck="false" aria-label="Model name" placeholder="${{ codex: "gpt-6-sol", grok: "grok-4.7", claude: "claude-sonnet-5" }[provider] || ""}" value="${esc(c.custom)}" />` : ""}
      <p class="rs-hint">${esc(modelHint)}</p>
    </div>
    <div>
      <label class="rs-sub-label" for="rs-effort">Thinking</label>
      <label class="select"><select id="rs-effort" ${efforts.length ? "" : "disabled"} aria-describedby="rs-effort-hint">
        <option value="" ${c.effort === "" ? "selected" : ""}>Default</option>
        ${efforts.map((e) => `<option value="${esc(e)}" ${c.effort === e ? "selected" : ""}>${esc(e[0].toUpperCase() + e.slice(1))}</option>`).join("")}
      </select></label>
      <p class="rs-hint" id="rs-effort-hint">${esc(
        efforts.length ? "Higher thinks longer: better judgement, slower, more usage." : "This model has no thinking setting."
      )}</p>
      ${
        heavy
          ? `<div class="rs-sub${applies ? "" : " is-moot"}">
              <label class="rs-check"><input type="checkbox" id="rs-light" ${ui.lightReading ? "checked" : ""} ${applies ? "" : "disabled"}
                aria-describedby="rs-light-hint" />
                Read the evidence at medium thinking; use ${esc(c.effort)} only to write</label>
              <p class="rs-hint" id="rs-light-hint">${esc(lightHint)}</p>
            </div>`
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
  if (ui.resuming) return; /* a double click would ask twice */
  ui.resuming = true;
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
  } finally {
    ui.resuming = false;
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
const writerOf = Core.reportWriter;
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

const LIST_FACETS = [
  ["writer", "All writers", (v) => (v === "counts" ? "Counts only" : PROVIDER_LABEL[v] || v)],
  ["topic", "All types", (v) => (v === "question" ? "Questions" : v)],
  ["depth", "All depths", (v) => DEPTH_LABEL[v] || v],
];

function renderReportList() {
  const box = qs("#rs-reports");
  if (!box) return;
  if (!ui.overview) {
    if (ui.overviewError) box.innerHTML = `<p class="rs-empty">Saved guides couldn't be loaded.</p>`;
    return;
  }
  ui.reportsDrawn = ui.overview.reports;
  const reports = ui.overview.reports || [];
  if (!reports.length) {
    box.innerHTML = `<p class="rs-empty">No guides yet. Pick a topic above and start one: a quick run takes a few minutes.</p>`;
    return;
  }
  const archived = reports.filter((r) => r.archived);
  const active = reports.filter((r) => !r.archived);
  if (ui.listView === "archived" && !archived.length) ui.listView = "active";
  const pool = ui.listView === "archived" ? archived : active;
  /* A filter for each thing the guides here differ in; a picked value no
     longer present (archived, deleted) lets go by itself. */
  const facets = Core.reportFacets(pool);
  for (const [key] of LIST_FACETS) {
    if (ui.listFilter[key] && !facets[key].includes(ui.listFilter[key])) ui.listFilter[key] = "";
  }
  const filtering = LIST_FACETS.some(([key]) => ui.listFilter[key]);
  const shown = sortReports(Core.filterReports(pool, ui.listFilter));
  const filters = LIST_FACETS.filter(([key]) => facets[key].length > 1)
    .map(([key, all, label]) => `<label class="select rs-list-filter"><span class="sr-only">${esc(all.replace("All ", "Filter by "))}</span>
      <select id="rs-lf-${key}">
        <option value="">${esc(all)}</option>
        ${facets[key].map((v) => `<option value="${esc(v)}" ${ui.listFilter[key] === v ? "selected" : ""}>${esc(label(v))}</option>`).join("")}
      </select></label>`)
    .join("");

  redrawKeepingFocus(box, () => {
    box.innerHTML = `
    <div class="rs-list-bar">
      <div class="segmented rs-list-tabs" role="group" aria-label="Which guides">
        <button type="button" data-list="active" aria-pressed="${ui.listView === "active"}">Active <span class="tab-count">${active.length}</span></button>
        <button type="button" data-list="archived" aria-pressed="${ui.listView === "archived"}" ${archived.length ? "" : "disabled"}>Archived <span class="tab-count">${archived.length}</span></button>
      </div>
      <div class="rs-list-tools">
        ${filters}
        <label class="select rs-list-sort"><span class="sr-only">Sort guides</span>
          <select id="rs-list-sort">${LIST_SORTS.map(([v, l]) => `<option value="${v}" ${ui.listSort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
      </div>
    </div>
    ${filtering && shown.length ? `<p class="rs-hint rs-list-count">Showing ${shown.length} of ${pool.length}
      <button class="btn btn-ghost btn-small" type="button" data-act="clear-list-filters">Clear filters</button></p>` : ""}
    ${
      shown.length
        ? groupReports(shown).map(reportGroup).join("")
        : filtering
          ? `<div class="rs-empty"><p>No ${ui.listView} guides match these filters.</p>
              <button class="btn btn-secondary btn-small" type="button" data-act="clear-list-filters">Clear filters</button></div>`
          : `<p class="rs-empty">Every guide is archived. <button class="btn btn-ghost btn-small" type="button" data-list="archived">Show archived</button></p>`
    }`;
  });
}

function reportItem(r) {
  const s = r.stats || {};
  const title = esc(r.headline || r.name);
  const by = writtenBy(r.by, r.model, r.effort);
  return `<li class="card rs-report-item${r.archived ? " is-archived" : ""}" data-report="${esc(r.name)}">
    <button class="rs-report-open" type="button" data-open="${esc(r.name)}">
      <span class="rs-eyebrow">${r.kind === "question" ? "Question · " : ""}${esc(r.topic?.label || "Research")} · ${esc(when(r.createdAt))} · ${esc(r.depth)}${
        r.archived ? ` · archived${r.archivedAt ? ` ${esc(when(r.archivedAt))}` : ""}` : ""
      }</span>
      <span class="rs-report-title">${esc(r.headline || "Untitled guide")}</span>
      ${r.kind === "question" && r.question ? `<span class="rs-hint rs-asked">“${esc(r.question)}”</span>` : ""}
      <span class="rs-report-stats">${r.kind === "question" ? `${num(r.findings)} findings` : `${num(r.products)} products`} · ${num(s.postsScanned)} posts ${r.kind === "question" ? "found" : "scanned"} ·
        ${num(s.commentsRead)} comments ${s.threadsFetched != null ? "read" : "fetched"}</span>
      <span class="rs-report-by">${esc(by[0].toUpperCase() + by.slice(1))}${
        r.readers ? `; parts read by ${esc(Object.entries(r.readers).map(([who, n]) => `${who} ×${n}`).join(", "))}` : ""
      }</span>
      <svg class="icon rs-open-cue" aria-hidden="true"><use href="#i-chevron" /></svg>
    </button>
    <div class="rs-item-actions">
      <button class="btn btn-ghost btn-small" type="button" data-archive="${esc(r.name)}" data-to="${r.archived ? "false" : "true"}"
        title="${r.archived ? "Move back to active" : "Archive"}" aria-label="${r.archived ? "Unarchive" : "Archive"} ${title}">
        <svg class="icon" aria-hidden="true"><use href="#i-archive" /></svg><span class="rs-item-label">${r.archived ? "Unarchive" : "Archive"}</span>
      </button>
      <button class="btn btn-ghost btn-small rs-report-delete" type="button" data-delete="${esc(r.name)}" title="Delete" aria-label="Delete ${title}">
        <svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg>
      </button>
    </div>
  </li>`;
}

/* After a guide leaves the list, focus the row that took its place (or the
   list heading), so the keyboard doesn't drop back to the top of the page. */
function rowIndex(name) {
  return qsa(".rs-report-item").findIndex((li) => li.dataset.report === name);
}

function focusRow(index) {
  if (index < 0) return;
  const rows = qsa(".rs-report-open");
  const target = rows[Math.min(index, rows.length - 1)] || qs("#rs-saved-heading");
  if (!target) return;
  if (!target.matches("button")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

async function setArchived(name, archived) {
  const index = rowIndex(name);
  const hadFocus = qs("#rs-reports")?.contains(document.activeElement);
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
    if (hadFocus) focusRow(index);
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
  /* One request at a time: a second Enter or click while the first is on
     its way would otherwise start (or queue) the same run twice. */
  if (ui.starting) return;
  const problem = Core.researchStartProblem({ mode: topic === "question" ? "question" : "guide", topic, query, question: query, provider });
  if (problem) {
    ui.startError = problem;
    if (reportParam()) return goResearch(null); /* "Run again" on a guide: show why on the form */
    renderLaunch();
    qs(topic === "question" ? "#rs-question" : "#rs-query")?.focus();
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
        if (launchKey() !== ui.launchKey) renderLaunch();
        renderPaused();
        if (ui.reportsDrawn !== ui.overview.reports) renderReportList();
      }
    }
  };
  ui.pollTimer = window.setTimeout(tick, RESEARCH_POLL_MS);
}

function isVisible() {
  return researchRoot && !researchRoot.closest(".view").hidden;
}
