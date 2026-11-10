"use strict";

/* ── Guide: How to start ─────────────────────────────────────────────────

   The guide's last section (start.py writes it, after the guide): the
   method in a sentence, how much the first time and how long to wait, how
   a session unfolds, the steps in order, the mistakes that lead to too
   much, what helps then, gentler first picks from the guide's own
   products, and the quotes it rests on. Each step says whether people in
   the threads say it or it's a general harm-reduction basic. */

const START_BASIS = {
  threads: ["From the threads", "threads"],
  both: ["Threads + general advice", "both"],
  general: ["General advice", "general"],
};
const START_EVIDENCE = {
  strong: "Strong evidence",
  moderate: "Some evidence",
  thin: "Thin evidence",
};

function sectionStart(r, g) {
  const s = g.start;
  if (!s || !s.summary) return "";
  const byId = new Map((g.products || []).map((p) => [p.id, p]));
  const picks = (s.first_picks || []).filter((x) => byId.has(x.product));
  const t = s.timeline || {};
  const facts = [
    ["First time", s.first_time],
    ["Then wait", s.wait],
  ].filter(([, v]) => v);
  const timeline = [
    ["Kicks in", t.onset],
    ["Peaks", t.peak],
    ["Lasts", t.lasts],
  ].filter(([, v]) => v);
  const steps = s.steps || [];
  const mistakes = s.mistakes || [];
  const tooMuch = s.too_much || [];
  return section(
    "start",
    "How to start",
    "For your first time with this kind of product, or after a break. From what people in the threads say, with general harm-reduction basics where marked. Not medical advice.",
    `<div class="card rs-start-lead">
      <p class="rs-start-summary">${esc(s.summary)}</p>
      ${facts.length ? `<dl class="rs-start-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      ${
        timeline.length
          ? `<ol class="rs-start-timeline" aria-label="How a session goes">${timeline
              .map(([k, v]) => `<li><span class="rs-start-when">${k}</span><span>${esc(v)}</span></li>`)
              .join("")}</ol>`
          : ""
      }
    </div>
    ${
      steps.length
        ? `<ol class="rs-start-steps">${steps
            .map((step) => {
              const [label, key] = START_BASIS[step.basis] || START_BASIS.general;
              return `<li>
                <div class="rs-start-step-head"><h3>${esc(step.title)}</h3><span class="rs-start-basis" data-basis="${key}">${label}</span></div>
                <p>${esc(step.body)}</p>
                ${threadLinks(r, step.threads)}
              </li>`;
            })
            .join("")}</ol>`
        : ""
    }
    ${s.with_tolerance ? `<p class="rs-start-tolerance"><strong>Already use cannabis another way?</strong> ${esc(s.with_tolerance)}</p>` : ""}
    ${
      mistakes.length || tooMuch.length
        ? `<div class="rs-start-grid">
        ${
          mistakes.length
            ? `<div class="card rs-start-mistakes"><h3>How people overdo it</h3><ul>${mistakes
                .map((m) => `<li><strong>${esc(m.title)}</strong> ${esc(m.body)}${threadLinks(r, m.threads)}</li>`)
                .join("")}</ul></div>`
            : ""
        }
        ${
          tooMuch.length
            ? `<div class="card rs-start-help"><h3>If it's too much</h3><ul>${tooMuch.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
            : ""
        }
      </div>`
        : ""
    }
    ${
      picks.length
        ? `<div class="rs-start-picks"><h3>Gentler first picks from this guide</h3><ul>${picks
            .map((x) => {
              const p = byId.get(x.product);
              return `<li><button type="button" class="rs-pick-name" data-jump="rs-p-${esc(p.id)}">${esc(p.brand)} ${esc(p.name)}</button>
                <span class="rs-hint">${esc(x.why)}</span></li>`;
            })
            .join("")}</ul></div>`
        : ""
    }
    ${
      (s.quotes || []).length
        ? `<details class="rs-said rs-start-said"><summary>What people say (${num(s.quotes.length)})</summary>${quoteBlocks(r, s.quotes)}</details>`
        : ""
    }
    ${startMethod(r, s)}`
  );
}

function startMethod(r, s) {
  const m = r.startMethod;
  const level = START_EVIDENCE[s.evidence];
  const parts = [];
  if (m) {
    const own = m.own || {};
    const found = m.searched || {};
    const subs = (found.subreddits || []).map((x) => `r/${esc(x)}`).join(", ");
    parts.push(
      `${esc(writtenBy(m.by, m.model, m.effort)).replace(/^w/, "W")} on ${esc(when(m.written))}, from ${num(own.comments)} comments in this guide's threads${
        found.threads ? ` and ${num(found.comments)} in ${num(found.threads)} threads about starting out from ${subs}` : ""
      }.`
    );
    parts.push(`${num(m.quotes)} quotes checked word for word${m.quotesDropped ? `; ${num(m.quotesDropped)} that didn't match were removed` : ""}.`);
  }
  if (!level && !parts.length) return "";
  return `<p class="rs-start-method">${level ? `<span class="rs-start-evidence" data-level="${esc(s.evidence)}">${level}</span>` : ""}
    ${s.evidence_note ? esc(s.evidence_note) : ""} ${parts.join(" ")}</p>`;
}
