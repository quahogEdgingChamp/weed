/* Research tab.

   Start a run (research.py does the work on the server), watch its progress,
   and read the guides it writes: quick picks, trends, brand report cards,
   filterable rankings with Reddit quotes, a comparison table and a
   score-versus-price chart. Products link back to OCS and can go straight
   onto the shopping list through the bridge js/20-start.js exposes as
   window.Cloudline. */


"use strict";

const API = "/api/research";
const RESEARCH_POLL_MS = 1500;
const researchRoot = document.getElementById("research-root");

const TIERS = ["S", "A", "B", "C", "AVOID"];
const TIER_ORDER = { S: 0, A: 1, B: 2, C: 3, AVOID: 4 };
const TIER_TEXT = {
  S: "Best in class: broad agreement, few complaints",
  A: "Excellent, with minor caveats",
  B: "Good for the right use or price",
  C: "Mixed: some love it, many complain",
  AVOID: "The community says skip it",
};
/* A run's steps, as the server lists them in job.stages: a guide's, or a
   question's (plan, search, …). */
const STAGE_LABELS = {
  catalog: "OCS catalog",
  reddit: "Scan Reddit",
  plan: "Plan",
  search: "Search Reddit",
  threads: "Read threads",
  parse: "Parse",
  write: "Write",
};
const GUIDE_STAGES = ["catalog", "reddit", "threads", "parse", "write"];
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
  mode: "guide",
  topic: "live-carts",
  query: "",
  question: "",
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
  filters: { q: "", tier: "", lean: "", plant: "", use: "", brand: "", terp: "", solo: false, sort: "score", online: false },
  brandQuery: "",
  terp: "",
  brandSort: "tier",
  table: { key: "score", asc: false },
  resizeTimer: null,
  lightReading: true,
  autoContinue: true,
  lastJobId: null,
  listView: "active",
  listSort: "newest",
};

const RESEARCH_PREFS_KEY = "cloudline-research-v1";
const WRITERS = ["claude", "codex", "grok"];
const PROVIDER_LABEL = { claude: "Claude", codex: "Codex", grok: "Grok", none: "Counts only" };

/* The last provider, model, thinking level and depth, per browser. */
function loadResearchPrefs() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RESEARCH_PREFS_KEY) || "null");
    if (saved && typeof saved === "object") {
      if ([...WRITERS, "none"].includes(saved.provider)) ui.provider = saved.provider;
      if (["quick", "standard", "deep"].includes(saved.depth)) ui.depth = saved.depth;
      if (typeof saved.listSort === "string") ui.listSort = saved.listSort;
      if (typeof saved.lightReading === "boolean") ui.lightReading = saved.lightReading;
      if (typeof saved.autoContinue === "boolean") ui.autoContinue = saved.autoContinue;
      if (["guide", "question"].includes(saved.mode)) ui.mode = saved.mode;
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

function saveResearchPrefs() {
  try {
    window.localStorage.setItem(RESEARCH_PREFS_KEY, JSON.stringify({ provider: ui.provider, depth: ui.depth, choice: ui.choice, listSort: ui.listSort, lightReading: ui.lightReading, autoContinue: ui.autoContinue, mode: ui.mode }));
  } catch (error) {
    /* Not remembered; nothing else depends on it. */
  }
}

loadResearchPrefs();

/* ── Helpers ─────────────────────────────────────────────────────────── */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ESC[c]);
const qs = (selector, scope = researchRoot) => scope.querySelector(selector);
const qsa = (selector, scope = researchRoot) => Array.from(scope.querySelectorAll(selector));

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

/* "3:02 pm" today, "Thu 3:02 pm" within a week, else a date and time. */
function clock(iso) {
  const date = new Date(iso || "");
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (date - new Date(new Date().toDateString())) / 86400000;
  if (days >= 0 && days < 1) return time;
  if (days >= -1 && days < 6) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
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

function timeLeft(seconds) {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ""}`;
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

function goResearch(reportName) {
  const params = new URLSearchParams({ view: "research" });
  if (reportName) params.set("report", reportName);
  window.history.pushState({ view: "research", entry: null }, "", `${window.location.pathname}?${params}`);
  renderResearch();
  window.scrollTo({ top: 0, behavior: "instant" });
}
