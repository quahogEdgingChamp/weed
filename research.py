#!/usr/bin/env python3
"""Research what the community thinks of a product type, and write a guide.

One run goes through five stages:

    1. catalog   every product ocs.ca lists (cached for 12 hours), filtered
                 down to the chosen topic: live resin carts, flower, hash...
    2. reddit    every post in the chosen subreddits over the time window,
                 from the Arctic Shift archive (Reddit RSS if that is down),
                 scored for relevance to the topic
    3. threads   every comment on the most relevant threads (all of them, and
                 every relevant thread, in deep mode, which also searches the
                 subreddits for comments naming the category's brands)
    4. parse     brand mentions, month-by-month volume, a rough sentiment,
                 and the evidence: threads + comments + catalog rows
    5. write     Claude, Codex or Grok (their CLIs, your existing logins; see
                 llm.py) writes the guide as JSON against a schema. Quick and
                 standard hand over what fits in one prompt. Deep has the
                 model read everything in parts and take notes, then write
                 the guide from the notes. Every quote is checked against
                 the comments; one that isn't there is dropped. Without a
                 model, a plainer guide is built from the counts alone.

The report records both how much was fetched and how much the model
actually read, so it never claims more than it saw.

Prices, potency, sizes and links always come from the OCS catalog, never
from the model. The finished report lands in research/reports/ as JSON and
the Research tab renders it.

Run from the shell too:

    python3 research.py live-carts --depth quick
    python3 research.py custom --query "cold cure rosin" --no-llm
    python3 research.py flower --depth deep --provider codex --model gpt-6-sol --effort high
    python3 research.py --resume flower-20260924T182347Z --provider claude --model sonnet
"""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from concurrent.futures import CancelledError as CancelledFuture
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import llm
import ocs

USER_AGENT = "cloudline-research/1.0 (personal buying notes; low volume)"
BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

ARCTIC = "https://arctic-shift.photon-reddit.com/api"
REDDIT = "https://www.reddit.com"
OCS_CATALOG = "https://ocs.ca/products.json?limit=250&page={page}"

CATALOG_MAX_AGE = 12 * 3600
THREAD_CACHE_AGE = 24 * 3600
REPORT_NAME = re.compile(r"[a-z0-9-]{1,80}-\d{8}T\d{6}Z\.json")

DEFAULT_SUBREDDITS = ("TheOCS", "CanadianCannabisLPs")

# How far back to read, how many threads to open, and how much the model is
# handed. Quick and standard are one pass: whatever fits in `chars` is read,
# the rest is only counted. Deep reads everything: every relevant thread and
# every comment, in batches the model takes notes on, then writes the guide
# from all the notes. It also searches the subreddits for comments naming the
# category's brands in threads the topic search didn't pick up.
DEPTHS: dict[str, dict[str, Any]] = {
    "quick": {"days": 120, "threads": 45, "comments": 25, "comment_chars": 450, "chars": 140_000, "mode": "single"},
    "standard": {"days": 365, "threads": 100, "comments": 45, "comment_chars": 450, "chars": 420_000, "mode": "single"},
    "deep": {"days": 365, "threads": 400, "comments": None, "comment_chars": 900, "chars": 170_000, "mode": "batches",
             "brand_search": 12, "parallel": 3},
}

STAGES = ("catalog", "reddit", "threads", "parse", "write")

Cancelled = llm.Cancelled  # one class, so a stop inside a model call is a stop


# ── Topics ────────────────────────────────────────────────────────────────


def _has(product: dict[str, Any], *words: str) -> bool:
    hay = f"{product['title']} {product['subsub']} {product['subcategory']}".lower()
    return any(word in hay for word in words)


TOPICS: dict[str, dict[str, Any]] = {
    "live-carts": {
        "label": "Live resin & live rosin carts",
        "blurb": "510 cartridges filled with live resin or live rosin, and how they compare with cured resin and distillate.",
        "pattern": r"\b(live\s*(resin|rosin)|rosin|resin|liquid\s*diamonds?)\b[^.\n]{0,60}\b(carts?|cartridges?|510s?|vapes?|pens?)\b"
        r"|\b(carts?|cartridges?|510s?)\b[^.\n]{0,60}\b(live|rosin|resin)\b",
        "loose": r"\b(carts?|cartridges?|510s?)\b",
        "ocs": lambda p: p["subcategory"] == "510 Thread Cartridges"
        and (p["subsub"] in ("Live Cartridges", "Resin Cartridges") or _has(p, "live", "rosin", "resin")),
        "focus": "hardware (ceramic vs cotton, clogging, leaking, airflow), oil quality, true-to-strain flavour, "
        "live vs cured vs 'liquid diamond' blends, and the right voltage",
    },
    "rosin": {
        "label": "Live rosin & hash rosin (dabs)",
        "blurb": "Solventless rosin for dabbing: live rosin, hash rosin, cold cure, jam and badder.",
        "pattern": r"\b(live\s*rosin|hash\s*rosin|rosin|cold\s*cure|solventless|jam|badder|73u|90u|120u)\b",
        "ocs": lambda p: p["category"] == "Extracts" and (p["subcategory"] == "Rosin" or _has(p, "rosin")),
        "focus": "micron grade, cure style (cold cure, jam, fresh press), consistency, flavour, price per gram, "
        "freshness and storage",
    },
    "resin": {
        "label": "Live resin concentrates",
        "blurb": "Hydrocarbon live resin to dab: sauce, diamonds, badder, sugar and shatter.",
        "pattern": r"\b(live\s*resin|sauce|diamonds?|badder|batter|sugar|shatter|hte|thca)\b",
        "ocs": lambda p: p["category"] == "Extracts"
        and p["subcategory"] in ("Resin", "Shatter", "Wax"),
        "focus": "terp content, texture (sauce, diamonds, badder), flavour, harshness, price per gram",
    },
    "flower": {
        "label": "Dried flower",
        "blurb": "Bud: which growers and strains are actually good right now, and which bags to skip.",
        "pattern": r"\b(flower|buds?|nugs?|eighth|3\.5\s*g|quarter|7\s*g|ounce|28\s*g|strain|smoke|jar|bag)\b",
        "ocs": lambda p: p["subcategory"] == "Dried Flower",
        "focus": "freshness and package dates, moisture, trim, smell, burn and ash, value per gram, "
        "which growers are consistent",
    },
    "prerolls": {
        "label": "Pre-rolls & infused pre-rolls",
        "blurb": "Joints in a tube: single-strain, blended and infused.",
        "pattern": r"\b(pre-?rolls?|prerolls?|joints?|infused|blunts?|dogwalkers?)\b",
        "ocs": lambda p: p["subcategory"] == "Pre-Rolls",
        "focus": "burn quality, canoeing, fill quality (flower vs shake), infusion, value, dryness",
    },
    "disposables": {
        "label": "Disposable & all-in-one vapes",
        "blurb": "Rechargeable disposables and AIO pens, from distillate to live resin.",
        "pattern": r"\b(disposables?|dispos|aios?|all[- ]in[- ]one|vape\s*pens?)\b",
        "ocs": lambda p: p["subcategory"] == "Disposable Pens",
        "focus": "battery and charging, clogging, flavour, oil type (distillate vs live), value, reliability",
    },
    "hash": {
        "label": "Hash & kief",
        "blurb": "Pressed hash, bubble hash, temple balls and kief.",
        "pattern": r"\b(hash|bubble|temple\s*balls?|kief|piatella|dry\s*sift|pressed)\b",
        "ocs": lambda p: p["subcategory"] == "Hash and Kief",
        "focus": "melt quality, texture, flavour, how people use it (bowl topping, joints, dabs), value",
    },
    "edibles": {
        "label": "Edibles, gummies & drinks",
        "blurb": "Gummies, chocolates, drinks and capsules.",
        "pattern": r"\b(edibles?|gumm(y|ies)|chews?|chocolates?|beverages?|drinks?|seltzers?|capsules?|mg)\b",
        "ocs": lambda p: p["category"] == "Edibles" or p["subcategory"] in ("Capsules", "Beverages"),
        "focus": "whether they actually hit at the 10 mg cap, taste, onset, live rosin gummies vs distillate, value",
    },
}

CUSTOM = {
    "label": "Custom search",
    "blurb": "Your own search words.",
    "focus": "whatever the community discusses most about this topic",
}


def topic_list() -> list[dict[str, str]]:
    return [{"key": key, "label": t["label"], "blurb": t["blurb"]} for key, t in TOPICS.items()] + [
        {"key": "custom", "label": CUSTOM["label"], "blurb": CUSTOM["blurb"]}
    ]


def resolve_topic(key: str, query: str) -> dict[str, Any]:
    if key in TOPICS:
        topic = dict(TOPICS[key])
        topic["key"] = key
        topic["regex"] = re.compile(topic["pattern"], re.IGNORECASE)
        topic["loose_regex"] = re.compile(topic["loose"], re.IGNORECASE) if topic.get("loose") else None
        return topic

    words = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) >= 2][:8]
    if key != "custom" or not words:
        raise ValueError("Pick a topic, or type what to research.")

    # Every word has to appear, in any order: "live rosin" should not match
    # every post that says "live".
    lookahead = "".join(rf"(?=[\s\S]*\b{re.escape(w)})" for w in words)
    return {
        "key": "custom",
        "label": query.strip()[:80],
        "blurb": f"Custom search: {query.strip()[:80]}",
        "focus": CUSTOM["focus"],
        "regex": re.compile(lookahead, re.IGNORECASE),
        "loose_regex": None,
        "words": words,
        "ocs": lambda p: all(w in p["haystack"] for w in words),
    }


# ── Plumbing ──────────────────────────────────────────────────────────────


class SourceError(Exception):
    pass


class Throttle:
    """At most one request per `interval` seconds to each host."""

    def __init__(self) -> None:
        self.last: dict[str, float] = {}
        self.lock = threading.Lock()

    def wait(self, host: str, interval: float, cancel: threading.Event | None) -> None:
        with self.lock:
            delay = self.last.get(host, 0) + interval - time.monotonic()
            self.last[host] = max(time.monotonic(), self.last.get(host, 0) + interval)
        if delay > 0:
            sleep(delay, cancel)


THROTTLE = Throttle()
INTERVALS = {"arctic-shift.photon-reddit.com": 1.0, "www.reddit.com": 3.0, "ocs.ca": 0.5}


def sleep(seconds: float, cancel: threading.Event | None) -> None:
    if cancel is None:
        time.sleep(seconds)
    elif cancel.wait(seconds):
        raise Cancelled()


RETRY_STATUS = (429, 500, 502, 503, 504)


def fetch(url: str, *, cancel: threading.Event | None = None, accept: str = "application/json",
          agent: str = USER_AGENT, timeout: int = 45, max_bytes: int = 12_000_000,
          retry_on: tuple[int, ...] = RETRY_STATUS) -> bytes:
    """GET with a per-host throttle and a few patient retries on 429/5xx.

    The archive answers 422 "Timeout. Maybe slow down a bit" when it's busy;
    listing calls pass that in `retry_on` too.
    """
    host = urllib.parse.urlparse(url).hostname or ""
    for attempt in range(4):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        THROTTLE.wait(host, INTERVALS.get(host, 1.0), cancel)
        request = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": accept})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(max_bytes)
        except urllib.error.HTTPError as error:
            if error.code in retry_on and attempt < 3:
                retry_after = error.headers.get("Retry-After", "")
                sleep(float(retry_after) if retry_after.isdigit() else 5 * 3**attempt, cancel)
                continue
            raise SourceError(f"{host} answered {error.code}") from error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt < 3:
                sleep(3 * (attempt + 1), cancel)
                continue
            raise SourceError(f"could not reach {host}: {getattr(error, 'reason', error)}") from error
    raise SourceError(f"{host} kept failing")


def fetch_json(url: str, **kwargs: Any) -> Any:
    try:
        return json.loads(fetch(url, **kwargs).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SourceError(f"{urllib.parse.urlparse(url).hostname} sent something that isn't JSON") from error


def read_cache(path: Path, max_age: float) -> Any:
    try:
        if time.time() - path.stat().st_mtime <= max_age:
            return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    return None


def write_json(path: Path, value: Any, *, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=indent), encoding="utf-8")
    temporary.replace(path)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean_text(value: Any, limit: int | None = None) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))
    text = re.sub(r"\[([^\]]{1,200})\]\((https?://[^)]+)\)", r"\1", text)  # markdown links
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    if limit and len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0] + "…"
    return text


def slug(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:60] or "item"


# ── 1. OCS catalog ────────────────────────────────────────────────────────


def load_catalog(cache_dir: Path, cancel: threading.Event | None, log: Callable[[str], None]) -> list[dict[str, Any]]:
    cache = cache_dir / "ocs-catalog.json"
    cached = read_cache(cache, CATALOG_MAX_AGE)
    if cached:
        log(f"OCS catalog from cache ({len(cached)} products, under 12 h old)")
        return cached

    products: dict[str, dict[str, Any]] = {}
    for page in range(1, 60):
        batch = fetch_json(OCS_CATALOG.format(page=page), cancel=cancel).get("products") or []
        before = len(products)
        for item in batch:
            if isinstance(item, dict) and item.get("handle"):
                products[item["handle"]] = summarize_product(item)
        log(f"OCS catalog page {page}: {len(products)} products so far")
        # Past the end Shopify repeats the last page rather than going empty.
        if len(batch) < 250 or len(products) == before:
            break

    rows = list(products.values())
    if rows:
        write_json(cache, rows)
    return rows


def summarize_product(product: dict[str, Any]) -> dict[str, Any]:
    """The catalog row we keep: what a buyer compares, nothing more."""
    tags = ocs.group_tags(product.get("tags") or [])
    variants = [v for v in product.get("variants") or [] if isinstance(v, dict)]
    variant = ocs.pick_variant(variants)
    thc_min, thc_max = ocs.potency_range(tags, "thc")
    cbd_min, cbd_max = ocs.potency_range(tags, "cbd")
    image = ""
    images = product.get("images") or []
    if images and isinstance(images[0], dict):
        image = ocs.thumbnail(images[0].get("src"))

    row = {
        "handle": product["handle"],
        "title": ocs.clean(product.get("title")),
        "brand": ocs.clean(product.get("vendor")),
        "category": ocs.first(tags, "category"),
        "subcategory": ocs.first(tags, "subcategory"),
        "subsub": ocs.first(tags, "subsubcategory"),
        "process": ocs.meaningful(ocs.first(tags, "extraction_process")),
        "plant": ocs.first(tags, "plant_type"),
        "genetics": ocs.first(tags, "street_name"),
        "producer": ocs.first(tags, "licensed_producer"),
        "province": ocs.first(tags, "growing_province"),
        "thcMin": thc_min,
        "thcMax": thc_max,
        "cbdMin": cbd_min,
        "cbdMax": cbd_max,
        "terpenes": ocs.terpene_list(tags),
        "price": dollars(variant.get("price")) if variant else None,
        "size": ocs.clean(variant.get("title")) if variant else "",
        "sizes": [
            {"size": ocs.clean(v.get("title")), "price": dollars(v.get("price")), "available": bool(v.get("available"))}
            for v in variants
        ],
        "online": "online" in (tags.get("availability") or []),
        "available": any(v.get("available") for v in variants),
        "image": image,
        "url": f"https://ocs.ca/products/{product['handle']}",
        "created": str(product.get("published_at") or product.get("created_at") or "")[:10],
    }
    row["haystack"] = " ".join(
        [row["title"], row["brand"], row["subcategory"], row["subsub"], row["process"], row["genetics"]]
    ).lower()
    return row


def dollars(value: Any) -> float | None:
    """products.json gives "39.95"; the single-product .js endpoint gives cents."""
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


# ── Brands ────────────────────────────────────────────────────────────────

BRAND_SUFFIXES = re.compile(
    r"\s+(cannabis( co\.?| company| supply co\.?| inc\.?)?|co\.?|vapes|infused|hash|labs|extracts|"
    r"solventless|farms|craft cannabis|by .+|c/o .+|/ .+)$",
    re.IGNORECASE,
)

# Brand names that are also everyday words: only counted when capitalised.
COMMON_WORDS = {
    "grass", "status", "legacy", "platinum", "summit", "portal", "orbit", "vibe", "fern", "yard", "lunch", "blunt",
    "pepe", "irony", "mod", "feather", "soar", "strings", "teapot", "balcony", "abide", "encore", "faded", "divvy",
    "blast", "bold", "cubes", "seeker", "thrifty", "ripped", "wink", "potluck", "overtime", "versus", "legacy",
    "the cut", "the kitchen", "top leaf", "high key", "dime bag", "impromptu", "standard issue", "slaps", "piff",
    "fruit drops", "status", "the republic", "happy & stoned", "juicy hoots", "adults only", "super toast",
    "always toasted", "pure weed", "the florist", "common ground", "far out crops", "hotbox", "shred", "coterie",
    "senorita", "summit", "wild west", "the goo!", "blips", "palmetto", "natural history", "back forty", "tenzo",
    "sesh", "embody", "nobrand", "orbit", "payless", "roilty", "riptides", "twiddles", "unlicensed producer",
    "community", "big", "grow", "legend", "classic", "original", "premium", "select", "reserve",
}

# Reddit shorthand for producers whose brands share one oil.
EXTRA_ALIASES = {"atlanticann": "FOUR54", "iris": "IRIS Labs", "boxhot": "BOXHOT", "4:54": "FOUR54"}


def brand_key(vendor: str) -> str:
    name = BRAND_SUFFIXES.sub("", vendor.strip())
    return re.sub(r"\s+", " ", name).strip().lower()


def build_brands(catalog: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Canonical brand -> display name and the regex that finds it in text."""
    brands: dict[str, dict[str, Any]] = {}
    for row in catalog:
        key = brand_key(row["brand"])
        if len(key) < 3:
            continue
        entry = brands.setdefault(key, {"name": row["brand"], "aliases": {key}})
        entry["aliases"].add(row["brand"].lower())

    for alias, target in EXTRA_ALIASES.items():
        key = brand_key(target)
        if key in brands:
            brands[key]["aliases"].add(alias)

    for key, entry in brands.items():
        loose = [a for a in entry["aliases"] if a not in COMMON_WORDS]
        strict = [a for a in entry["aliases"] if a in COMMON_WORDS]
        parts = []
        if loose:
            parts.append(r"(?i:" + "|".join(sorted((re.escape(a) for a in loose), key=len, reverse=True)) + ")")
        if strict:
            parts.append("|".join(re.escape(a[:1].upper() + a[1:]) for a in strict))
        entry["regex"] = re.compile(r"(?<![\w])(?:" + "|".join(parts) + r")(?![\w])")
    return brands


# ── 2–3. Reddit ───────────────────────────────────────────────────────────

POST_FIELDS = "id,title,selftext,score,num_comments,created_utc,link_flair_text,subreddit,author"


def scan_subreddit(sub: str, after: int, cache_dir: Path, cancel: threading.Event | None,
                   log: Callable[[str], None]) -> tuple[list[dict[str, Any]], str]:
    """Every post in `sub` since `after`, cached so reruns only fetch what's new."""
    cache = cache_dir / f"posts-{sub.lower()}.json"
    cached = read_cache(cache, 365 * 86400) or {}
    posts: dict[str, dict[str, Any]] = cached.get("posts", {}) if isinstance(cached, dict) else {}
    covered_from = int(cached.get("from", 0)) if isinstance(cached, dict) else 0

    # Re-read the last three days: scores and comment counts are still moving.
    newest = max((p["created_utc"] for p in posts.values()), default=0)
    start = after if not posts or covered_from > after else max(after, newest - 3 * 86400)

    try:
        cursor = start
        pages = 0
        while True:
            query = urllib.parse.urlencode(
                {"subreddit": sub, "after": cursor, "limit": 100, "sort": "asc", "fields": POST_FIELDS}
            )
            batch = fetch_json(f"{ARCTIC}/posts/search?{query}", cancel=cancel,
                               retry_on=(*RETRY_STATUS, 422)).get("data") or []
            fresh = 0
            for post in batch:
                if isinstance(post, dict) and post.get("id"):
                    fresh += post["id"] not in posts
                    posts[post["id"]] = {k: post.get(k) for k in POST_FIELDS.split(",")}
            pages += 1
            if batch:
                last = datetime.fromtimestamp(int(batch[-1]["created_utc"]), timezone.utc).date()
                log(f"r/{sub}: {len(posts)} posts on file, reading up to {last}")
            if len(batch) < 100 or pages > 400:
                break
            next_cursor = int(batch[-1]["created_utc"])
            cursor = next_cursor if next_cursor > cursor else cursor + 1
            # Filling in older months before a cached stretch: once the gap is
            # closed, skip ahead to the last three days rather than re-reading
            # what's already on file.
            if covered_from and after < covered_from <= cursor < newest - 3 * 86400:
                cursor = newest - 3 * 86400
        write_json(cache, {"from": min(covered_from or after, after), "posts": posts})
        source = "arctic"
    except SourceError as error:
        log(f"Archive unavailable for r/{sub} ({error}); falling back to Reddit's own feeds")
        if posts:
            source = "arctic-cache"
        else:
            posts = {p["id"]: p for p in rss_posts(sub, cancel, log)}
            source = "reddit-rss"

    in_window = [p for p in posts.values() if int(p.get("created_utc") or 0) >= after]
    return in_window, source


def rss_posts(sub: str, cancel: threading.Event | None, log: Callable[[str], None]) -> list[dict[str, Any]]:
    """Fallback: Reddit's public Atom feeds. Newest and top-of-year only, no scores."""
    found: dict[str, dict[str, Any]] = {}
    for path in (f"/r/{sub}/new/.rss?limit=100", f"/r/{sub}/top/.rss?t=year&limit=100", f"/r/{sub}/top/.rss?t=month&limit=100"):
        try:
            entries = parse_atom(fetch(REDDIT + path, cancel=cancel, accept="application/atom+xml", agent=BROWSER_AGENT))
        except SourceError as error:
            log(f"Reddit feed {path} failed: {error}")
            continue
        for entry in entries:
            if entry["id"].startswith("t3_"):
                found[entry["id"][3:]] = {
                    "id": entry["id"][3:],
                    "title": entry["title"],
                    "selftext": entry["content"],
                    "score": None,
                    "num_comments": None,
                    "created_utc": entry["created"],
                    "link_flair_text": None,
                    "subreddit": sub,
                    "author": entry["author"],
                }
    log(f"r/{sub}: {len(found)} posts from Reddit feeds")
    return list(found.values())


def parse_atom(body: bytes) -> list[dict[str, Any]]:
    ns = {"a": "http://www.w3.org/2005/Atom"}
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise SourceError("Reddit sent a feed that doesn't parse") from error
    entries = []
    for entry in root.findall("a:entry", ns):
        stamp = entry.findtext("a:updated", "", ns) or entry.findtext("a:published", "", ns)
        try:
            created = int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())
        except ValueError:
            created = 0
        entries.append({
            "id": entry.findtext("a:id", "", ns),
            "title": clean_text(entry.findtext("a:title", "", ns)),
            "content": clean_text(entry.findtext("a:content", "", ns)),
            "author": (entry.findtext("a:author/a:name", "", ns) or "").removeprefix("/u/"),
            "created": created,
        })
    return entries


COMMENT_FIELDS = "id,body,score,author,created_utc,parent_id"
MAX_THREAD_COMMENTS = 3000


def thread_comments(post: dict[str, Any], cache_dir: Path, cancel: threading.Event | None,
                    log: Callable[[str], None]) -> list[dict[str, Any]]:
    """Every comment on a thread, paging past the archive's 100-per-request limit."""
    pid = post["id"]
    cache = cache_dir / "threads" / f"{pid}.json"
    age_limit = THREAD_CACHE_AGE if time.time() - int(post.get("created_utc") or 0) < 30 * 86400 else 30 * 86400
    cached = read_cache(cache, age_limit)
    # Older caches were a bare list capped at 100; anything under the cap was complete.
    if isinstance(cached, list) and len(cached) < 100:
        return cached
    if isinstance(cached, dict) and cached.get("complete"):
        return cached.get("comments") or []

    comments: dict[str, dict[str, Any]] = {}
    complete = False
    try:
        cursor = 0
        while len(comments) < MAX_THREAD_COMMENTS:
            # The archive rejects after=0 with a 400, so the first page has no cursor.
            params = {"link_id": pid, "limit": 100, "sort": "asc", "fields": COMMENT_FIELDS}
            if cursor:
                params["after"] = cursor
            query = urllib.parse.urlencode(params)
            batch = fetch_json(f"{ARCTIC}/comments/search?{query}", cancel=cancel,
                               retry_on=(*RETRY_STATUS, 422)).get("data") or []
            before = len(comments)
            for c in batch:
                if isinstance(c, dict) and c.get("body") and c.get("id"):
                    comments[c["id"]] = {k: c.get(k) for k in COMMENT_FIELDS.split(",")}
            if len(batch) < 100 or len(comments) == before:
                complete = True
                break
            newest = int(batch[-1].get("created_utc") or 0)
            cursor = newest if newest > cursor else cursor + 1
    except SourceError as error:
        log(f"Archive comments for {pid} failed ({error}); using Reddit's feed instead (no scores)")
        comments.clear()
        try:
            body = fetch(f"{REDDIT}/r/{post.get('subreddit') or 'TheOCS'}/comments/{pid}/.rss?limit=100",
                         cancel=cancel, accept="application/atom+xml", agent=BROWSER_AGENT)
            for entry in parse_atom(body):
                if entry["id"].startswith("t1_"):
                    comments[entry["id"][3:]] = {"id": entry["id"][3:], "body": entry["content"], "score": None,
                                                 "author": entry["author"], "created_utc": entry["created"],
                                                 "parent_id": None}
        except SourceError as error:
            log(f"Comments for {pid} unavailable: {error}")
            return []

    rows = list(comments.values())
    write_json(cache, {"complete": complete, "comments": rows})
    return rows


def search_brand_comments(sub: str, brand: str, after: int, cache_dir: Path, cancel: threading.Event | None,
                          log: Callable[[str], None]) -> list[dict[str, Any]]:
    """Comments anywhere in `sub` that name `brand`. Best effort: the archive's
    full-text search times out on busy names, so a failed year is retried as
    two halves, and a half that still fails is skipped."""
    cache = cache_dir / "brand-search" / f"{sub.lower()}-{slug(brand)}-{after // 86400}.json"
    cached = read_cache(cache, THREAD_CACHE_AGE)
    if isinstance(cached, list):
        return cached

    now = int(time.time())
    windows = [(after, now)]
    found: dict[str, dict[str, Any]] = {}
    tried_split = False
    while windows:
        start, end = windows.pop(0)
        query = urllib.parse.urlencode({"subreddit": sub, "body": brand, "after": start, "before": end, "limit": 100,
                                        "fields": COMMENT_FIELDS + ",link_id"})
        try:
            for c in fetch_json(f"{ARCTIC}/comments/search?{query}", cancel=cancel, timeout=60).get("data") or []:
                if isinstance(c, dict) and c.get("id") and c.get("body"):
                    found[c["id"]] = {k: c.get(k) for k in (*COMMENT_FIELDS.split(","), "link_id")}
        except SourceError:
            if not tried_split and end - start > 60 * 86400:
                tried_split = True
                middle = (start + end) // 2
                windows += [(start, middle), (middle, end)]
            else:
                log(f"Search for “{brand}” in r/{sub} timed out for part of the year; skipped")
    rows = list(found.values())
    write_json(cache, rows)
    return rows


# ── 4. Parse ──────────────────────────────────────────────────────────────

POSITIVE = re.compile(
    r"\b(fire|best|love[ds]?|amazing|favou?rites?|goat|smooth|tast(y|es great)|loud|terpy|great|excellent|solid|"
    r"recommend(ed)?|banger|delicious|10/10|top[- ]tier|underrated|incredible|chef'?s kiss|consistent|flavou?rful|"
    r"potent|hits? (hard|great|nice)|worth (it|the)|fantastic|impressed|gem|stellar|go-?to)\b",
    re.IGNORECASE,
)
NEGATIVE = re.compile(
    r"\b(harsh|burnt|burning taste|clog(s|ged|ging)?|leak(s|ed|ing|y)?|trash|garbage|mid|bad|worst|disappoint(ed|ing)?|"
    r"avoid|overpriced|dry|flavou?rless|headaches?|weak|gross|meh|dud|scam|bunk|chemical|skip|terrible|awful|"
    r"stale|hay|tastes? like (nothing|plastic|chemicals)|waste|regret|broke|broken|dead on arrival)\b",
    re.IGNORECASE,
)

BOT_AUTHORS = {"AutoModerator", "[deleted]", "OCS-Bot"}


def relevance(post: dict[str, Any], topic: dict[str, Any], brand_rx: re.Pattern[str] | None) -> float:
    title = post.get("title") or ""
    body = post.get("selftext") or ""
    rx = topic["regex"]
    score = 0.0
    if rx.search(title):
        score += 3
    if rx.search(body):
        score += 1.5
    loose = topic.get("loose_regex")
    if loose is not None and score == 0 and loose.search(title) and brand_rx is not None and brand_rx.search(f"{title} {body}"):
        score += 1.5
    if score and brand_rx is not None and brand_rx.search(f"{title} {body}"):
        score += 1
    if score and (post.get("link_flair_text") or "").lower() == "review":
        score += 0.5
    return score


def rank_threads(posts: list[dict[str, Any]], topic: dict[str, Any], brand_rx: re.Pattern[str] | None) -> list[dict[str, Any]]:
    ranked = []
    for post in posts:
        rel = relevance(post, topic, brand_rx)
        if rel <= 0:
            continue
        engagement = math.log1p(max(int(post.get("num_comments") or 0), 0)) + 0.5 * math.log1p(max(int(post.get("score") or 0), 0))
        ranked.append({**post, "_rel": rel, "_rank": rel * (1 + engagement)})
    ranked.sort(key=lambda p: p["_rank"], reverse=True)
    return ranked


def sentiment(text: str) -> tuple[int, int]:
    return len(POSITIVE.findall(text)), len(NEGATIVE.findall(text))


def month_of(stamp: Any) -> str:
    try:
        return datetime.fromtimestamp(int(stamp), timezone.utc).strftime("%Y-%m")
    except (TypeError, ValueError, OSError):
        return ""


def analyse(threads: list[dict[str, Any]], comments: dict[str, list[dict[str, Any]]], brands: dict[str, dict[str, Any]],
            topic_brands: set[str], window_start: int, relevant: list[dict[str, Any]]) -> dict[str, Any]:
    """Count who is talked about, when, and in what tone."""
    stats: dict[str, dict[str, Any]] = {}
    volume: Counter[str] = Counter()
    recent_cut = time.time() - 90 * 86400

    def texts():
        for post in threads:
            yield post["id"], None, f"{post.get('title', '')}\n{post.get('selftext', '')}", post.get("created_utc"), post.get("score")
            for c in comments.get(post["id"], []):
                yield post["id"], c.get("id"), c.get("body", ""), c.get("created_utc"), c.get("score")

    for post in relevant:
        volume[month_of(post.get("created_utc"))] += 1

    any_brand = re.compile("|".join(f"(?:{b['regex'].pattern})" for b in brands.values())) if brands else None
    for thread_id, comment_id, text, stamp, score in texts():
        if not text or any_brand is None or not any_brand.search(text):
            continue
        month = month_of(stamp)
        pos, neg = sentiment(text)
        for key, brand in brands.items():
            if not brand["regex"].search(text):
                continue
            s = stats.setdefault(key, {"brand": brand["name"], "mentions": 0, "threads": set(), "pos": 0, "neg": 0,
                                       "recent": 0, "months": Counter(), "best": []})
            s["mentions"] += 1
            s["threads"].add(thread_id)
            s["pos"] += min(pos, 3)
            s["neg"] += min(neg, 3)
            s["months"][month] += 1
            if int(stamp or 0) >= recent_cut:
                s["recent"] += 1
            if comment_id and 40 <= len(text) <= 600:
                s["best"].append({"text": clean_text(text, 400), "thread": thread_id, "comment": comment_id,
                                  "score": int(score or 0), "tone": pos - neg})

    months = sorted(m for m in volume if m)
    window_days = max((time.time() - window_start) / 86400, 1)
    rows = []
    for key, s in stats.items():
        older_days = max(window_days - 90, 1)
        recent_rate = s["recent"] / 90
        older_rate = (s["mentions"] - s["recent"]) / older_days
        if s["mentions"] - s["recent"] <= 1 and s["recent"] >= 3:
            trend = "new"
        elif recent_rate > older_rate * 1.4 and s["recent"] >= 3:
            trend = "rising"
        elif recent_rate < older_rate * 0.6 and s["mentions"] >= 4:
            trend = "falling"
        else:
            trend = "steady"
        total = s["pos"] + s["neg"]
        s["best"].sort(key=lambda q: (q["score"], abs(q["tone"])), reverse=True)
        rows.append({
            "key": key,
            "brand": s["brand"],
            "mentions": s["mentions"],
            "threads": len(s["threads"]),
            "recent": s["recent"],
            "sentiment": round((s["pos"] - s["neg"]) / total, 2) if total else 0.0,
            "trend": trend,
            "months": [s["months"].get(m, 0) for m in months],
            "inTopic": key in topic_brands,
            "quotes": s["best"][:6],
        })
    rows.sort(key=lambda r: (r["inTopic"], r["mentions"]), reverse=True)
    return {"months": months, "volume": [volume[m] for m in months], "brands": rows}


def catalog_block(topic: dict[str, Any], catalog_rows: list[dict[str, Any]], analysis: dict[str, Any]) -> str:
    """The OCS rows and the brand counts: the head of every prompt."""
    # Big categories (flower has ~900 rows) are cut down to the brands people
    # actually talk about, then whatever is buyable.
    talked = {row["key"]: row["mentions"] for row in analysis["brands"]}
    listed = sorted(catalog_rows, key=lambda r: (-talked.get(brand_key(r["brand"]), 0), not r["available"], r["brand"].lower()))[:260]
    listed.sort(key=lambda r: (r["brand"].lower(), r["title"].lower()))
    lines = [f"# Topic: {topic['label']}", "",
             f"## OCS catalog rows for this topic ({len(listed)} of {len(catalog_rows)}, most-discussed brands first)",
             "ref | brand | product | type | THC % | price / size | where"]
    for row in listed:
        thc = f"{row['thcMin']:g}–{row['thcMax']:g}" if row["thcMin"] is not None and row["thcMax"] is not None else "?"
        price = f"${row['price']:.2f} / {row['size']}" if row["price"] is not None else "?"
        where = "online+stores" if row["online"] else "stores only"
        lines.append(f"{row['handle']} | {row['brand']} | {row['title']} | {row['subsub'] or row['subcategory']} | {thc} | {price} | {where}")

    lines += ["", "## Brand mentions in these threads (mentions, threads, last-90-days, rough tone -1..1)"]
    for row in analysis["brands"][:40]:
        lines.append(f"{row['brand']}: {row['mentions']} mentions, {row['threads']} threads, {row['recent']} recent, tone {row['sentiment']:+.2f}")
    return "\n".join(lines) + "\n"


def usable(comment: dict[str, Any]) -> bool:
    body = (comment.get("body") or "").strip()
    return comment.get("author") not in BOT_AUTHORS and len(body) >= 25 and body not in ("[removed]", "[deleted]")


def thread_block(post: dict[str, Any], comments: list[dict[str, Any]], per_thread: int | None, comment_chars: int,
                 budget: int | None = None, heading: str = "") -> tuple[str, int]:
    """One thread as the model sees it; returns (text, comments included).

    Comments go best-scored first. With a budget, comments stop where it runs out.
    """
    date = datetime.fromtimestamp(int(post.get("created_utc") or 0), timezone.utc).strftime("%Y-%m-%d")
    head = (f"### [t:{post['id']}] {heading}{clean_text(post.get('title'), 200)} "
            f"({date}, r/{post.get('subreddit') or '?'}, {post.get('score') or 0}↑, {post.get('num_comments') or 0} comments"
            f"{', ' + post['link_flair_text'] if post.get('link_flair_text') else ''})")
    block = [head]
    body = clean_text(post.get("selftext"), 900)
    if body and body not in ("[removed]", "[deleted]"):
        block.append(body)
    size = sum(len(line) + 1 for line in block)
    kept = sorted((c for c in comments if usable(c)), key=lambda c: int(c.get("score") or 0), reverse=True)
    count = 0
    for c in kept[:per_thread] if per_thread else kept:
        line = f"- [c:{c['id']} {int(c.get('score') or 0)}↑] {clean_text(c.get('body'), comment_chars)}"
        if budget is not None and size + len(line) + 1 > budget:
            break
        block.append(line)
        size += len(line) + 1
        count += 1
    return "\n".join(block) + "\n", count


def build_packet(topic: dict[str, Any], threads: list[dict[str, Any]], comments: dict[str, list[dict[str, Any]]],
                 catalog_rows: list[dict[str, Any]], analysis: dict[str, Any], budget: int, per_thread: int,
                 comment_chars: int = 450) -> tuple[str, int, int]:
    """One-pass evidence: catalog, counts, then threads until the budget runs out.

    Returns (packet, threads included, comments included), so the report can
    say how much the model actually read rather than how much was fetched.
    """
    lines = [catalog_block(topic, catalog_rows, analysis),
             "## Threads (most relevant first). Quote only from these. t = thread id, c = comment id, ↑ = score\n"]
    used = sum(len(line) + 1 for line in lines)
    threads_in = comments_in = 0
    for post in threads:
        text, count = thread_block(post, comments.get(post["id"], []), per_thread, comment_chars)
        if used + len(text) > budget:
            break
        lines.append(text)
        used += len(text)
        threads_in += 1
        comments_in += count
    return "\n".join(lines), threads_in, comments_in


def batch_evidence(threads: list[dict[str, Any]], comments: dict[str, list[dict[str, Any]]],
                   elsewhere: list[tuple[dict[str, Any], list[dict[str, Any]]]], size: int,
                   comment_chars: int) -> list[dict[str, Any]]:
    """Cut every thread (and the brand-search finds) into batches of about `size` characters."""
    blocks = []
    for post in threads:
        text, count = thread_block(post, comments.get(post["id"], []), None, comment_chars, budget=size)
        blocks.append((text, count, post["id"]))
    for post, found in elsewhere:
        text, count = thread_block(post, found, None, comment_chars, budget=size // 4,
                                   heading="(from a brand search; only the comments naming a brand) ")
        blocks.append((text, count, post["id"]))

    batches: list[dict[str, Any]] = []
    current: dict[str, Any] = {"text": [], "chars": 0, "threads": 0, "comments": 0}
    for text, count, _tid in blocks:
        if current["text"] and current["chars"] + len(text) > size:
            batches.append(current)
            current = {"text": [], "chars": 0, "threads": 0, "comments": 0}
        current["text"].append(text)
        current["chars"] += len(text)
        current["threads"] += 1
        current["comments"] += count
    if current["text"]:
        batches.append(current)
    for batch in batches:
        batch["text"] = "\n".join(batch["text"])
    return batches


# ── 5. Write ──────────────────────────────────────────────────────────────

TIER = {"type": "string", "enum": ["S", "A", "B", "C", "AVOID"]}
STR = {"type": "string"}
STRS = {"type": "array", "items": STR}


def obj(props: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


GOOD_FOR = ["daytime", "night", "sleep", "focus", "creative", "social", "relax", "body", "solo", "beginners", "heavy"]

REPORT_SCHEMA = obj({
    "headline": STR,
    "lede": STR,
    "quick_picks": {"type": "array", "items": obj({"label": STR, "pick": STR, "product": STR, "why": STR})},
    "trends": {"type": "array", "items": obj({
        "title": STR, "direction": {"type": "string", "enum": ["rising", "falling", "new", "steady", "warning"]},
        "detail": STR, "means": STR, "when": STR, "brands": STRS, "threads": STRS})},
    "brands": {"type": "array", "items": obj({
        "brand": STR, "tier": TIER, "trend": {"type": "string", "enum": ["rising", "falling", "steady", "new"]},
        "known_for": STR, "best_pick": STR,
        "consistency": {"type": "string", "enum": ["consistent", "mixed", "inconsistent", "unknown"]},
        "strengths": STR, "weaknesses": STR, "price": STR, "summary": STR})},
    "products": {"type": "array", "items": obj({
        "id": STR, "ref": STR, "brand": STR, "name": STR, "kind": STR, "tier": TIER,
        "score": {"type": "number"}, "lean": {"type": "string", "enum": ["indica", "sativa", "hybrid", "balanced", "unknown"]},
        "strength": {"type": "string", "enum": ["mild", "medium", "strong", "very strong", "unknown"]},
        "best_time": {"type": "string", "enum": ["day", "evening", "night", "any", "unknown"]},
        "good_for": {"type": "array", "items": {"type": "string", "enum": GOOD_FOR}},
        "high": STR, "flavour": STR, "effects": STR, "hardware": STR, "value": STR,
        "solo": obj({"fit": {"type": "string", "enum": ["great", "good", "mixed", "poor", "unknown"]}, "why": STR}),
        "verdict": STR, "pros": STRS, "cons": STRS,
        "quotes": {"type": "array", "items": obj({"text": STR, "thread": STR, "comment": STR})},
        "threads": STRS})},
    "avoid": {"type": "array", "items": obj({"name": STR, "reason": STR, "threads": STRS})},
    "tips": {"type": "array", "items": obj({"title": STR, "body": STR})},
    "glossary": {"type": "array", "items": obj({"term": STR, "definition": STR})},
    "faq": {"type": "array", "items": obj({"q": STR, "a": STR})},
})

# What "solo" means, for the model. The page itself only ever says
# "Solo sessions" and uses neutral wording.
SOLO_GUIDE = """how well it suits long solo sessions of self-pleasure. Good signs in what people report: a warm, \
tingly body high, heightened physical sensation or touch, a lift in mood or libido, staying present and clear \
rather than sleepy, and effects that last. Bad signs: anxiety, racing or paranoid thoughts, heavy couch-lock or \
sleepiness, a short or flat high. People rarely say this outright: infer it from reported effects, and say "unknown" \
when the threads give no signal. Write `why` in one discreet, neutral line (e.g. "strong body buzz and heightened \
sensation while staying clear-headed"), never explicit"""

SYSTEM_PROMPT = """You are a meticulous cannabis market analyst writing a buyer's guide for adults in Ontario, Canada, \
who buy from the Ontario Cannabis Store (OCS) and licensed retailers. Your only evidence is the packet the user gives you: \
an OCS catalog extract and Reddit threads with comments. You write like an experienced, plain-spoken friend: specific, \
honest about trade-offs, never hype. You never invent products, prices, lab numbers or quotes."""

INSTRUCTIONS = """Write the guide for the topic "{label}" as JSON matching the schema.

What the reader cares about most here: {focus}.

Rules:
- Base every claim on the packet. Where the community disagrees, say so. Where evidence is thin, say that too.
- products: the {n_products} products (or product lines) the threads discuss most usefully, best first. Only include a \
product if at least one thread discusses it specifically. For each: `high` is one or two sentences on what the high is \
like (head vs body, energy, onset and how long it lasts) as people describe it; `strength` how hard it hits; \
`best_time` when people use it; `good_for` the uses the evidence supports (from: daytime, night, sleep, focus, \
creative, social, relax, body, solo, beginners, heavy); `hardware` a short note on the cartridge/device for vapes, else \
""; `value` one short line on price vs quality. `solo` is {solo}. Include "solo" in `good_for` only for \
fit "great" or "good". `ref` is the OCS catalog ref (the handle in the first column) \
when you can match it confidently, else "". `id` is a short kebab-case slug. `kind` is a short type label such as \
"live resin cart" or "hash rosin". `score` is 0–10 and must agree with `tier` (S ≥ 9, A 8–8.9, B 6.5–7.9, C 5–6.4, \
AVOID < 5). `verdict` is 2–3 sentences. 2–5 pros and 1–5 cons, each short. `lean` only from what people report.
- quotes: 1–4 per product, copied VERBATIM from a comment (or the thread's own text) in the packet, at most 280 characters; \
you may cut the start or end of a sentence but never change words inside it. `thread` is the t: id, `comment` the c: id \
("" when quoting the post itself). Quotes that are not verbatim are deleted automatically, so copy exactly.
- threads: t: ids that support the item.
- brands: 5–14 brand report cards for the brands that matter in this category, strongest first. `known_for` is one \
line on what the brand is known for; `best_pick` its best product in this category (name as in products); \
`consistency` how consistent batches/units are reported to be.
- trends: 5–10 things that changed or are changing (new launches, hardware changes, price moves, quality drops, \
shortages, what is being hyped, what is falling out of favour). `detail` 2–3 sentences with specifics; `means` one \
line on what it means for a buyer; `when` roughly when it started ("since spring 2026", "last 2 months"); `brands` \
the brands involved. Use `warning` for recurring quality or safety complaints.
- quick_picks: 8–10 "if you want X, buy Y" answers, using these labels where the evidence supports one: "Best \
overall", "Best value", "Best for daytime", "Best for night & sleep", "Best flavour", "Strongest", "Solo sessions", \
"Best for beginners", and "Skip" (what to avoid). `product` is the product `id` it points to, or "". For "Solo \
sessions" pick the product with the best `solo` fit and keep `why` discreet.
- avoid: products or practices the community warns about, with the reason.
- tips: 3–6 practical tips (how to use, store, choose, what to check on the package).
- glossary: 4–10 terms a newcomer to this category would trip on.
- faq: 4–8 questions people keep asking in these threads, answered from the evidence.
- headline: one line. lede: 2–3 sentences, the short answer.
- No medical claims or dosing advice. Canadian spelling.

The packet follows.

"""


# Deep mode: the model first reads the threads batch by batch and takes these
# notes, then writes the guide from all of them.
NOTES_SCHEMA = obj({
    "products": {"type": "array", "items": obj({
        "brand": STR, "name": STR, "ref": STR, "kind": STR,
        "tone": {"type": "string", "enum": ["positive", "negative", "mixed"]},
        "people": {"type": "number"},
        "effects": STR, "solo_signals": STR,
        "points": STRS,
        "quotes": {"type": "array", "items": obj({"text": STR, "thread": STR, "comment": STR})},
        "threads": STRS})},
    "brands": {"type": "array", "items": obj({"brand": STR, "points": STRS, "threads": STRS})},
    "trends": {"type": "array", "items": obj({"title": STR, "detail": STR, "threads": STRS})},
    "warnings": {"type": "array", "items": obj({"title": STR, "detail": STR, "threads": STRS})},
    "questions": STRS,
    "tips": STRS,
})

NOTES_INSTRUCTIONS = """You are reading part {part} of {parts} of the Reddit evidence for a buyer's guide on "{label}".
Take careful notes as JSON matching the schema. Another pass will combine the notes from every part, so:

- products: every specific product or product line these threads discuss with any substance, even briefly. \
`ref` is the OCS catalog ref (first column of the catalog table) when you can match it confidently, else "". \
`people` is roughly how many different commenters here weighed in on it. `effects` is what people say the high is \
like (head/body, energy, sleepiness, anxiety, onset and duration), "" if nobody says. `solo_signals` notes anything \
that bears on {solo} — "" if nothing. `points` are short, specific claims \
people make (flavour, effect, hardware, clogging, price, batch problems, comparisons), each under 200 characters, \
written as what people report, not as fact. Keep disagreement: "most say X; two say Y".
- quotes: up to 4 per product, copied VERBATIM from a comment (or the thread's own text), at most 280 characters. \
You may cut the start or end of a sentence but never change words inside it. `thread` is the t: id, `comment` \
the c: id ("" for the post itself). Quotes that aren't verbatim are deleted automatically.
- brands: what people say about a brand as a whole (hardware, consistency, customer service, pricing).
- trends: anything changing or new in this part (launches, hardware changes, price moves, shortages, hype).
- warnings: recurring quality or safety complaints.
- questions: questions people ask here, as they'd phrase them.
- tips: practical advice people give.
- Always give the t: ids that support each item. Don't invent anything that isn't in this part.

"""

INSTRUCTIONS = INSTRUCTIONS.replace("{solo}", SOLO_GUIDE)

REDUCE_NOTE = """The evidence below is not the raw threads: it is notes another careful reader took on all {threads} threads \
({comments} comments) in {parts} parts. Quotes inside the notes were copied verbatim from comments; reuse them \
exactly as written, with their thread and comment ids. Weigh products by how many parts and people mention them.

"""


def notes_text(index: int, notes: dict[str, Any], compact: bool = False) -> str:
    """Notes from one batch, in a compact form for the final pass.

    `compact` caps what each product carries, for writers with a small
    prompt limit (Grok): 3 points, 2 quotes, 4 thread ids.
    """
    points_cap, quotes_cap, threads_cap = (3, 2, 4) if compact else (None, None, 8)
    lines = [f"## Notes from part {index}"]
    for item in notes.get("products", []):
        lines.append(f"- PRODUCT {item.get('brand')} | {item.get('name')} | ref {item.get('ref') or '-'} | "
                     f"{item.get('kind')} | tone {item.get('tone')} | ~{item.get('people')} people | "
                     f"threads {', '.join(item.get('threads', [])[:threads_cap])}")
        if item.get("effects"):
            lines.append(f"    effects: {clean_text(item['effects'], 220) if compact else item['effects']}")
        if item.get("solo_signals"):
            lines.append(f"    solo: {clean_text(item['solo_signals'], 160) if compact else item['solo_signals']}")
        lines += [f"    · {clean_text(point, 180) if compact else point}" for point in item.get("points", [])[:points_cap]]
        lines += [f"    “{q.get('text')}” [t:{q.get('thread')} c:{q.get('comment')}]"
                  for q in item.get("quotes", [])[:quotes_cap]]
    for item in notes.get("brands", []):
        lines.append(f"- BRAND {item.get('brand')}: " + " · ".join(item.get("points", [])) + f" [{', '.join(item.get('threads', [])[:6])}]")
    for key, tag in (("trends", "TREND"), ("warnings", "WARNING")):
        for item in notes.get(key, []):
            lines.append(f"- {tag} {item.get('title')}: {item.get('detail')} [{', '.join(item.get('threads', [])[:6])}]")
    if notes.get("questions"):
        lines.append("- QUESTIONS: " + " | ".join(notes["questions"]))
    if notes.get("tips"):
        lines.append("- TIPS: " + " | ".join(notes["tips"]))
    return "\n".join(lines) + "\n"


def llm_status() -> dict[str, Any]:
    """Kept for older callers: is any writer available?"""
    providers = llm.status()
    return {"available": any(p["available"] for p in providers.values()), "providers": providers,
            "detail": "Claude, Codex or Grok writes the guide with your existing login."}


def normalise_quote(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"[^a-z0-9']+", " ", text).strip()


def verify_quotes(report: dict[str, Any], corpus: dict[str, str], thread_texts: dict[str, str]) -> tuple[int, list[dict[str, str]]]:
    """Keep a quote only if its words appear, in order, in the comment it cites.

    Compared against the same cleaned text the packet showed Claude (links
    collapsed, entities decoded), with case and punctuation ignored.
    """
    cleaned = {cid: normalise_quote(clean_text(text)) for cid, text in corpus.items()}
    threads = {tid: normalise_quote(clean_text(text)) for tid, text in thread_texts.items()}
    kept, dropped = 0, []
    for product in report.get("products", []):
        good = []
        for quote in product.get("quotes", []):
            fragments = [normalise_quote(f) for f in re.split(r"\.\.\.|…|\[\.\.\.\]", quote.get("text") or "")]
            fragments = [f for f in fragments if len(f) >= 8]
            haystack = cleaned.get(quote.get("comment") or "") or threads.get(quote.get("thread") or "", "")
            if fragments and haystack and all(f in haystack for f in fragments):
                good.append(quote)
                kept += 1
                continue
            # The model sometimes cites the wrong comment in the right thread.
            match = next((cid for cid, text in cleaned.items() if fragments and all(f in text for f in fragments)), None)
            if match:
                quote["comment"] = match
                good.append(quote)
                kept += 1
            else:
                dropped.append({"product": product.get("name", ""), "text": (quote.get("text") or "")[:300]})
        product["quotes"] = good
    return kept, dropped


def tier_for(score: float) -> str:
    return "S" if score >= 9 else "A" if score >= 8 else "B" if score >= 6.5 else "C" if score >= 5 else "AVOID"


def heuristic_report(topic: dict[str, Any], analysis: dict[str, Any], catalog_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """A plainer guide from counts alone, for when Claude is off or failed."""
    by_brand: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in catalog_rows:
        by_brand[brand_key(row["brand"])].append(row)

    brands, products = [], []
    for row in [r for r in analysis["brands"] if r["inTopic"] and r["mentions"] >= 2][:14]:
        confidence = min(row["mentions"] / 12, 1)
        score = round(max(0, min(10, 6.5 + 3 * row["sentiment"] * confidence)), 1)
        tier = tier_for(score)
        tone = "mostly positive" if row["sentiment"] > 0.25 else "mostly negative" if row["sentiment"] < -0.25 else "mixed"
        summary = f"Mentioned {row['mentions']} times across {row['threads']} threads; tone {tone}."
        brands.append({"brand": row["brand"], "tier": tier, "trend": row["trend"], "known_for": "", "best_pick": "",
                       "consistency": "unknown", "strengths": "", "weaknesses": "", "price": "", "summary": summary})
        options = sorted(by_brand.get(row["key"], []), key=lambda r: (not r["online"], r["price"] or 999))
        ref = options[0] if options else None
        products.append({
            "id": slug(row["brand"]),
            "ref": ref["handle"] if ref else "",
            "brand": row["brand"],
            "name": ref["title"] if ref else f"{row['brand']} ({topic['label'].lower()})",
            "kind": topic["label"],
            "tier": tier,
            "score": score,
            "lean": "unknown",
            "strength": "unknown",
            "best_time": "unknown",
            "good_for": [],
            "high": "",
            "hardware": "",
            "value": "",
            "solo": {"fit": "unknown", "why": ""},
            "flavour": "",
            "effects": "",
            "verdict": f"{summary} Counted automatically; read the quotes before trusting the tier.",
            "pros": [], "cons": [],
            "quotes": [{"text": q["text"], "thread": q["thread"], "comment": q["comment"]} for q in row["quotes"][:3]],
            "threads": sorted({q["thread"] for q in row["quotes"]})[:8],
        })

    rising = [r["brand"] for r in analysis["brands"] if r["inTopic"] and r["trend"] in ("rising", "new")][:5]
    falling = [r["brand"] for r in analysis["brands"] if r["inTopic"] and r["trend"] == "falling"][:5]
    trends = []
    if rising:
        trends.append({"title": "Talked about more lately", "direction": "rising", "means": "", "when": "last 90 days",
                       "detail": ", ".join(rising) + " got more mentions in the last 90 days than before.",
                       "brands": rising, "threads": []})
    if falling:
        trends.append({"title": "Talked about less", "direction": "falling", "means": "", "when": "last 90 days",
                       "detail": ", ".join(falling) + " came up less in the last 90 days.",
                       "brands": falling, "threads": []})

    top = products[0]["name"] if products else "nothing yet"
    return {
        "headline": f"{topic['label']}: what the community is talking about",
        "lede": f"Built from mention counts and a rough tone score, without Claude. Most discussed: {top}. "
                "Tiers here are a signal, not a verdict.",
        "quick_picks": [{"label": "Most discussed, best tone", "pick": p["name"], "product": p["id"], "why": p["verdict"]}
                        for p in sorted(products, key=lambda p: p["score"], reverse=True)[:3]],
        "trends": trends, "brands": brands, "products": products, "avoid": [], "tips": [], "glossary": [], "faq": [],
    }


def attach_catalog(report: dict[str, Any], catalog: list[dict[str, Any]], topic_rows: list[dict[str, Any]]) -> None:
    """Put OCS facts on each product. The model supplies the ref, never the numbers."""
    by_handle = {row["handle"]: row for row in catalog}
    seen_ids: set[str] = set()
    for product in report.get("products", []):
        base = slug(product.get("id") or product.get("name") or "item")
        pid, n = base, 2
        while pid in seen_ids:
            pid, n = f"{base}-{n}", n + 1
        seen_ids.add(pid)
        product["id"] = pid

        row = by_handle.get(product.get("ref") or "")
        if row is None:
            row = guess_row(product, topic_rows)
        product["ocs"] = public_row(row) if row else None
        product["score"] = round(max(0.0, min(10.0, float(product.get("score") or 0))), 1)

    ids = {p["id"] for p in report.get("products", [])}
    for pick in report.get("quick_picks", []):
        if pick.get("product") not in ids:
            match = next((p["id"] for p in report.get("products", []) if pick.get("product") and slug(pick["product"]) == p["id"]), "")
            pick["product"] = match


def guess_row(product: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    brand = brand_key(product.get("brand") or "")
    words = set(re.findall(r"[a-z0-9]{3,}", (product.get("name") or "").lower())) - {"live", "resin", "rosin", "cart", "510", "thread", "cartridge"}
    best, best_score = None, 0
    for row in rows:
        if brand and brand_key(row["brand"]) != brand:
            continue
        overlap = len(words & set(re.findall(r"[a-z0-9]{3,}", row["title"].lower())))
        if overlap > best_score:
            best, best_score = row, overlap
    return best if best_score >= 1 else None


def public_row(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k != "haystack"}


# ── The run ───────────────────────────────────────────────────────────────


class Paused(Exception):
    """A writer hit its plan's usage limit. The run is saved as a checkpoint
    and can continue later, with the same writer or another."""

    def __init__(self, checkpoint: str, message: str, resets: str = ""):
        super().__init__(message)
        self.checkpoint = checkpoint
        self.resets = resets


CHECKPOINT_NAME = re.compile(r"[a-z0-9-]{1,80}-\d{8}T\d{6}Z")


def reporter(progress: Callable[..., None] | None) -> tuple[Callable[..., None], Callable[[str], Callable[[str], None]]]:
    def report(stage: str, message: str, **counts: Any) -> None:
        if progress:
            progress(stage, message, **counts)
        else:
            print(f"[{stage}] {message}", flush=True)

    def logger(stage: str) -> Callable[[str], None]:
        return lambda message: report(stage, message)

    return report, logger


def run(topic_key: str, query: str = "", *, depth: str = "quick", provider: str = "claude", model: str = "",
        effort: str = "", use_llm: bool | None = None, subreddits: tuple[str, ...] = DEFAULT_SUBREDDITS,
        out_dir: Path, progress: Callable[..., None] | None = None, cancel: threading.Event | None = None) -> Path:
    """Do the whole thing; return the path of the saved report.

    `provider` is "claude", "codex", "grok" or "none" (counts only). Raises
    Paused if the writer runs out of plan usage; the run can then be resumed.
    """
    if use_llm is False:
        provider = "none"
    state = gather(topic_key, query, depth=depth, subreddits=subreddits, out_dir=out_dir, progress=progress,
                   cancel=cancel)
    return write(state, provider=provider, model=model, effort=effort, out_dir=out_dir, progress=progress,
                 cancel=cancel)


def resume(checkpoint: str, *, provider: str, model: str = "", effort: str = "", out_dir: Path,
           progress: Callable[..., None] | None = None, cancel: threading.Event | None = None) -> Path:
    """Carry on a saved run: parts already read are kept, the rest are read now."""
    state = read_checkpoint(out_dir, checkpoint)
    if state is None:
        raise ValueError("That paused run is gone.")
    report, _ = reporter(progress)
    done = len(state.get("notes") or {})
    total = len(state.get("batches") or [])
    report("write", f"Continuing “{state['topic']['label']}”" + (f": {done} of {total} parts already read" if total else ""))
    return write(state, provider=provider, model=model, effort=effort, out_dir=out_dir, progress=progress,
                 cancel=cancel)


def gather(topic_key: str, query: str = "", *, depth: str = "quick", subreddits: tuple[str, ...] = DEFAULT_SUBREDDITS,
           out_dir: Path, progress: Callable[..., None] | None = None,
           cancel: threading.Event | None = None) -> dict[str, Any]:
    """Stages 1–4: everything that costs no model usage. Returns a plain,
    JSON-safe state that `write` turns into a guide (now or after a pause)."""
    settings = DEPTHS.get(depth) or DEPTHS["quick"]
    depth = depth if depth in DEPTHS else "quick"
    topic = resolve_topic(topic_key, query)
    cache_dir = out_dir / "cache"
    started = time.time()
    report, logger = reporter(progress)

    # 1. catalog
    report("catalog", "Reading the OCS catalog")
    catalog = load_catalog(cache_dir, cancel, logger("catalog"))
    topic_rows = [row for row in catalog if topic["ocs"](row)]
    topic_rows.sort(key=lambda r: (r["brand"].lower(), r["title"].lower()))
    report("catalog", f"{len(topic_rows)} of {len(catalog)} OCS products are {topic['label'].lower()}",
           ocs_total=len(catalog), ocs_topic=len(topic_rows))

    brands = build_brands(catalog)
    topic_brands = {brand_key(row["brand"]) for row in topic_rows}
    topic_brand_rx = None
    if topic_brands:
        parts = [brands[k]["regex"].pattern for k in topic_brands if k in brands]
        topic_brand_rx = re.compile("|".join(parts)) if parts else None

    # 2. reddit
    after = int(started - settings["days"] * 86400)
    posts: list[dict[str, Any]] = []
    sources: set[str] = set()
    for sub in subreddits:
        report("reddit", f"Scanning r/{sub}, last {settings['days']} days")
        found, source = scan_subreddit(sub, after, cache_dir, cancel, logger("reddit"))
        sources.add(source)
        posts.extend(found)
    ranked = rank_threads(posts, topic, topic_brand_rx)
    report("reddit", f"{len(ranked)} of {len(posts)} posts are about {topic['label'].lower()}",
           posts_scanned=len(posts), posts_relevant=len(ranked))

    # 3. threads: most relevant first, and keep the recent ones in so trends show.
    chosen = ranked[: settings["threads"]]
    chosen_ids = {p["id"] for p in chosen}
    recent = [p for p in ranked if p["id"] not in chosen_ids and int(p.get("created_utc") or 0) > started - 45 * 86400]
    chosen += recent[: max(5, settings["threads"] // 5)]
    comments: dict[str, list[dict[str, Any]]] = {}
    for index, post in enumerate(chosen, 1):
        comments[post["id"]] = thread_comments(post, cache_dir, cancel, logger("threads"))
        if index % 5 == 0 or index == len(chosen):
            report("threads", f"Fetched {index} of {len(chosen)} threads", threads_fetched=index,
                   comments_fetched=sum(len(v) for v in comments.values()))

    # Deep: comments elsewhere that name this category's most-discussed brands.
    elsewhere: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    if settings.get("brand_search"):
        first_pass = analyse(chosen, comments, brands, topic_brands, after, ranked)
        names = [row["brand"] for row in first_pass["brands"]
                 if row["inTopic"] and row["key"] not in COMMON_WORDS and len(row["key"]) >= 4][: settings["brand_search"]]
        post_index = {p["id"]: p for p in posts}
        chosen_ids = {p["id"] for p in chosen}
        loose = topic.get("loose_regex")
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        seen: set[str] = set()
        for n, name in enumerate(names, 1):
            for sub in subreddits:
                report("threads", f"Searching r/{sub} for comments naming {name} ({n} of {len(names)})")
                for c in search_brand_comments(sub, name, after, cache_dir, cancel, logger("threads")):
                    tid = str(c.get("link_id") or "").removeprefix("t3_")
                    body = c.get("body") or ""
                    if not tid or tid in chosen_ids or c["id"] in seen or not usable(c):
                        continue
                    if not (topic["regex"].search(body) or (loose is not None and loose.search(body))):
                        continue
                    seen.add(c["id"])
                    grouped[tid].append(c)
        for tid, found in grouped.items():
            post = post_index.get(tid) or {"id": tid, "title": "(a thread outside the scanned window)", "selftext": "",
                                           "created_utc": min(int(c.get("created_utc") or 0) for c in found),
                                           "subreddit": subreddits[0], "score": None, "num_comments": None}
            elsewhere.append((post, found))
        report("threads", f"Brand search found {len(seen)} more comments in {len(grouped)} other threads",
               brand_search_comments=len(seen))

    # 4. parse
    report("parse", "Counting brands, months and tone")
    extra_posts = [post for post, _ in elsewhere]
    all_comments = {**comments, **{post["id"]: found for post, found in elsewhere}}
    analysis = analyse(chosen + extra_posts, all_comments, brands, topic_brands, after, ranked)
    by_rank = sorted(chosen, key=lambda p: p["_rank"], reverse=True)
    head = catalog_block(topic, topic_rows, analysis)
    fetched_comments = sum(len(v) for v in comments.values())

    state: dict[str, Any] = {
        "version": 1,
        "id": f"{slug(topic['key'] if topic['key'] != 'custom' else 'custom-' + topic['label'])[:60]}-"
              f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "topic": {"key": topic["key"], "label": topic["label"], "blurb": topic["blurb"], "focus": topic["focus"],
                  "query": query.strip()[:120]},
        "depth": depth,
        "mode": settings["mode"],
        "subreddits": list(subreddits),
        "sources": sorted(sources),
        "started": started,
        "after": after,
        "days": settings["days"],
        "seconds": round(time.time() - started),
        "counts": {
            "postsScanned": len(posts), "postsRelevant": len(ranked), "threadsFetched": len(chosen),
            "commentsFetched": fetched_comments, "brandSearchComments": sum(len(found) for _, found in elsewhere),
            "brandSearchThreads": len(elsewhere), "ocsProducts": len(catalog), "ocsTopicProducts": len(topic_rows),
        },
        "analysis": analysis,
        "topicRows": topic_rows,
        "threadMeta": {p["id"]: {k: p.get(k) for k in ("title", "subreddit", "score", "num_comments", "created_utc")}
                       for p in chosen + extra_posts},
        "chosenTop": [p["id"] for p in chosen[:40]],
        "corpus": {c["id"]: c.get("body") or "" for cs in all_comments.values() for c in cs if c.get("id")},
        "threadTexts": {p["id"]: f"{p.get('title') or ''}\n{p.get('selftext') or ''}" for p in chosen + extra_posts},
        "head": head,
        "packet": "",
        "single": {"threads": 0, "comments": 0},
        "batches": [],
        "notes": {},
        "skipped": [],
        "usage": {"calls": 0, "input": 0, "output": 0, "cost": 0.0, "costKnown": False},
    }
    if settings["mode"] == "single":
        state["packet"], state["single"]["threads"], state["single"]["comments"] = build_packet(
            topic, by_rank, comments, topic_rows, analysis, settings["chars"], settings["comments"], settings["comment_chars"])
        report("parse", f"{len(analysis['brands'])} brands mentioned; the model gets {state['single']['threads']} of "
                        f"{len(chosen)} threads ({state['single']['comments']} comments, {len(state['packet']) // 1000}k characters)",
               brands_found=len(analysis["brands"]))
    else:
        state["batches"] = batch_evidence(by_rank, comments, elsewhere, settings["chars"], settings["comment_chars"])
        report("parse", f"{len(analysis['brands'])} brands mentioned; all {len(chosen)} threads and "
                        f"{sum(b['comments'] for b in state['batches'])} comments split into {len(state['batches'])} parts",
               brands_found=len(analysis["brands"]), parts=len(state["batches"]))
    return state


NOTES_INSTRUCTIONS = NOTES_INSTRUCTIONS.replace("{solo}", SOLO_GUIDE)

TIGHT_NOTES = """- Keep it tight: at most 15 products, 3 points and 2 quotes each.

"""

MERGE_INSTRUCTIONS = """Below are notes that careful readers took on parts of the Reddit evidence for a buyer's guide on "{label}".
Merge them into ONE set of notes as JSON matching the schema:
- Combine duplicates (the same product or brand from different parts) into one item; add up `people`; keep every thread id.
- Keep disagreements ("most say X; a few say Y"). Drop only weak, one-off items.
- At most 20 products, 3 points and 2 quotes each. Quotes must stay exactly as written, with their t: and c: ids.
- Don't add anything that isn't in the notes.

"""


def nbytes(text: str) -> int:
    return len(text.encode("utf-8"))


def compact_head(state: dict[str, Any], rows: int) -> str:
    """The catalog header cut down for a small-prompt writer: the most-discussed
    brands' products, ref | brand | product | price, and the brand counts."""
    analysis = state["analysis"]
    talked = {row["key"]: row["mentions"] for row in analysis["brands"]}
    listed = sorted(state["topicRows"], key=lambda r: (-talked.get(brand_key(r["brand"]), 0), not r["available"]))[:rows]
    listed.sort(key=lambda r: (r["brand"].lower(), r["title"].lower()))
    lines = [f"# Topic: {state['topic']['label']}", "",
             f"## OCS catalog, most-discussed brands ({len(listed)} of {len(state['topicRows'])})",
             "ref | brand | product | price / size"]
    for row in listed:
        price = f"${row['price']:.2f} / {row['size']}" if row.get("price") is not None else "?"
        lines.append(f"{row['handle']} | {row['brand']} | {row['title']} | {price}")
    lines += ["", "## Brand mentions (mentions, threads, last-90-days, tone -1..1)"]
    for row in analysis["brands"][:25]:
        lines.append(f"{row['brand']}: {row['mentions']}, {row['threads']}, {row['recent']}, {row['sentiment']:+.2f}")
    return "\n".join(lines) + "\n"


def split_blocks(text: str) -> list[str]:
    """Thread blocks back out of a packet or a part ("### [t:…" each)."""
    return [block for block in re.split(r"(?m)^(?=### \[t:)", text) if block.startswith("### [t:")]


def cut_blocks(blocks: list[str], budget: int) -> list[dict[str, Any]]:
    """Pack thread blocks into parts of at most `budget` bytes. A block that is
    too big alone keeps its head and best comments (they're sorted by score)."""
    parts: list[dict[str, Any]] = []
    current: dict[str, Any] = {"text": [], "chars": 0, "threads": 0, "comments": 0}
    for block in blocks:
        if nbytes(block) > budget:
            kept, size = [], 0
            for line in block.splitlines(keepends=True):
                if size + nbytes(line) > budget:
                    break
                kept.append(line)
                size += nbytes(line)
            block = "".join(kept)
        size = nbytes(block)
        if current["text"] and current["chars"] + size > budget:
            parts.append(current)
            current = {"text": [], "chars": 0, "threads": 0, "comments": 0}
        current["text"].append(block)
        current["chars"] += size
        current["threads"] += 1
        current["comments"] += sum(1 for line in block.splitlines() if line.startswith("- [c:"))
    if current["text"]:
        parts.append(current)
    for part in parts:
        part["text"] = "".join(part["text"])
    return parts


def fit_for_limit(state: dict[str, Any], limit: int, report: Callable[..., None], who: str) -> None:
    """Re-cut the evidence so every prompt fits a writer with a prompt limit.

    One-pass runs become parts; parts that are too big (cut for another
    writer, or by an older version) are re-cut. Parts already read are kept.
    """
    state["slimHead"] = compact_head(state, rows=80)
    budget = limit - nbytes(NOTES_INSTRUCTIONS) - nbytes(TIGHT_NOTES) - nbytes(state["slimHead"]) - 3000
    if state["mode"] == "single":
        blocks = split_blocks(state["packet"])
        state["batches"] = cut_blocks(blocks, budget)
        state["mode"] = "batches"
        report("write", f"{who} can only read about {limit // 1000} KB at once, so the {len(blocks)} threads "
                        f"are split into {len(state['batches'])} parts", parts=len(state["batches"]), parts_done=0)
        return
    notes, batches = state["notes"], state["batches"]
    unread = [b for i, b in enumerate(batches, 1) if str(i) not in notes]
    if all(nbytes(b["text"]) <= budget for b in unread):
        return
    read = sorted((int(i) for i in notes), key=int)
    kept = [batches[i - 1] for i in read]
    recut = cut_blocks([block for b in unread for block in split_blocks(b["text"])], budget)
    state["batches"] = kept + recut
    state["notes"] = {str(k): notes[str(old)] for k, old in enumerate(read, 1)}
    state["skipped"] = []
    report("write", f"Re-cut the unread evidence into {len(recut)} smaller parts for {who}",
           parts=len(state["batches"]), parts_done=len(state["notes"]))


RETRY_NOTE = """

IMPORTANT: everything you need is in this message; nothing more is coming and there is nothing to look up.
Your previous answer was empty or a placeholder. Answer now, in full, from the evidence above."""


def notes_empty(data: dict[str, Any]) -> bool:
    return not any(data.get(key) for key in ("products", "brands", "trends", "warnings", "questions", "tips"))


def ask_checked(provider: str, *, prompt: str, schema: dict[str, Any], model: str, effort: str,
                cancel: threading.Event | None, log: Callable[[str], None], timeout: int, label: str,
                spend: Callable[[dict[str, Any]], None], lock: threading.Lock,
                empty: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
    """One model call, retried once if the answer is empty or a placeholder.

    An empty answer twice is a failure (ModelError), never a result: a guide
    with no products or notes with nothing in them must not pass as done.
    """
    for attempt in (1, 2):
        result = llm.ask(provider, system=SYSTEM_PROMPT, prompt=prompt + (RETRY_NOTE if attempt == 2 else ""),
                         schema=schema, model=model, effort=effort, cancel=cancel, log=log, timeout=timeout,
                         label=label)
        with lock:
            spend(result)
        if not empty(result["data"]):
            return result
        log(f"{label} answered with nothing in it" + ("; asking once more" if attempt == 1 else ""))
    raise llm.ModelError(f"{label} gave an empty answer twice")


def merge_notes(texts: list[str], *, limit: int, budget: int, provider: str, model: str, effort: str,
                topic: dict[str, Any], part_head: str, cancel: threading.Event | None,
                logger: Callable[[str], Callable[[str], None]], report: Callable[..., None],
                spend: Callable[[dict[str, Any]], None], lock: threading.Lock, who: str,
                parallel: int) -> list[str]:
    """Condense notes in rounds until they fit one prompt of `budget` bytes."""
    group_budget = limit - nbytes(MERGE_INSTRUCTIONS) - nbytes(part_head) - 3000
    for round_no in range(1, 5):
        if sum(nbytes(t) for t in texts) <= budget:
            return texts
        # Pack notes into groups; one set of notes too big alone is shortened.
        groups: list[list[str]] = [[]]
        for text in texts:
            if nbytes(text) > group_budget:
                text = text.encode("utf-8")[:group_budget].decode("utf-8", "ignore")
            if groups[-1] and sum(nbytes(t) for t in groups[-1]) + nbytes(text) > group_budget:
                groups.append([])
            groups[-1].append(text)
        report("write", f"The notes are too long for one {who} prompt; condensing them "
                        f"(round {round_no}: {len(texts)} → {len(groups)})")

        def merge(index: int, group: list[str]) -> str:
            prompt = MERGE_INSTRUCTIONS.format(label=topic["label"]) + part_head + "\n" + "\n".join(group)
            result = ask_checked(provider, prompt=prompt, schema=NOTES_SCHEMA, model=model, effort=effort,
                                 cancel=cancel, log=logger("write"), timeout=1500,
                                 label=f"{who} (condensing {index})", spend=spend, lock=lock, empty=notes_empty)
            return notes_text(index, result["data"], compact=True)

        with ThreadPoolExecutor(max_workers=parallel) as pool:
            texts = list(pool.map(lambda pair: merge(*pair), enumerate(groups, 1)))
    if sum(nbytes(t) for t in texts) > budget:
        raise llm.ModelError("the notes stayed too long to fit one prompt after 4 rounds of condensing")
    return texts


def new_on_ocs(state: dict[str, Any], days: int = 90) -> list[dict[str, Any]]:
    """Products OCS started listing in the last `days`, newest first, with
    whether people are talking about the brand yet."""
    cutoff = datetime.fromtimestamp(state["started"] - days * 86400, timezone.utc).strftime("%Y-%m-%d")
    talked = {row["key"]: row["mentions"] for row in state["analysis"]["brands"]}
    rows = [row for row in state["topicRows"] if (row.get("created") or "") >= cutoff]
    rows.sort(key=lambda r: r.get("created") or "", reverse=True)
    return [{"handle": r["handle"], "title": r["title"], "brand": r["brand"], "created": r.get("created"),
             "price": r.get("price"), "size": r.get("size"), "plant": r.get("plant"), "thcMin": r.get("thcMin"),
             "thcMax": r.get("thcMax"), "online": r.get("online"), "url": r.get("url"),
             "mentions": talked.get(brand_key(r["brand"]), 0)} for r in rows[:24]]


def write(state: dict[str, Any], *, provider: str, model: str = "", effort: str = "", out_dir: Path,
          progress: Callable[..., None] | None = None, cancel: threading.Event | None = None) -> Path:
    """Stage 5: the model calls, then the saved guide.

    With a model, the state is saved as a checkpoint before the first call and
    after every part, so a usage limit (Paused), a Stop, or a server restart
    loses nothing already read. The checkpoint is removed once the guide is saved.
    """
    report, logger = reporter(progress)
    settings = DEPTHS.get(state["depth"]) or DEPTHS["quick"]
    topic = state["topic"]
    writing_started = time.time()
    who = llm.LABELS.get(provider, "")
    limit = llm.PROMPT_LIMITS.get(provider)
    if limit:
        fit_for_limit(state, limit, report, who)
    part_head = state["slimHead"] if limit else state["head"]
    batches = state["batches"]
    notes: dict[str, Any] = state["notes"]
    usage = state["usage"]
    guide = None
    note = ""
    lock = threading.Lock()

    def spend(result: dict[str, Any]) -> None:
        usage["calls"] += 1
        usage["input"] += result["tokens"].get("input") or 0
        usage["output"] += result["tokens"].get("output") or 0
        if isinstance(result.get("cost"), (int, float)):
            usage["cost"] += result["cost"]
            usage["costKnown"] = True

    def save(status: str, **fields: Any) -> None:
        state.update(status=status, provider=provider, model=model, effort=effort, updatedAt=now_iso(), **fields)
        save_checkpoint(out_dir, state)

    if provider in llm.PROVIDERS:
        save("running", reason="", resets="")
        report("write", f"Saved a checkpoint ({state['id']}), so this run can continue if it's interrupted",
               checkpoint=state["id"])
        try:
            if batches:
                todo = [i for i in range(1, len(batches) + 1) if str(i) not in notes]
                report("write", f"{len(batches)} parts in all", parts=len(batches), parts_done=len(notes))
                if len(todo) < len(batches):
                    report("write", f"{len(batches) - len(todo)} of {len(batches)} parts were already read; "
                                    f"reading the other {len(todo)}")

                def read_part(index: int) -> None:
                    prompt = (NOTES_INSTRUCTIONS.format(part=index, parts=len(batches), label=topic["label"])
                              + (TIGHT_NOTES if limit else "") + part_head
                              + "\n## Threads in this part\n\n" + batches[index - 1]["text"])
                    result = ask_checked(provider, prompt=prompt, schema=NOTES_SCHEMA, model=model, effort=effort,
                                         cancel=cancel, log=logger("write"), timeout=1500,
                                         label=f"{who} (part {index})", spend=spend, lock=lock,
                                         empty=lambda data: batches[index - 1]["comments"] >= 5 and notes_empty(data))
                    with lock:
                        notes[str(index)] = {"data": result["data"], "by": f"{who} ({result['model']})"}
                        save("running")
                        report("write", f"{who} finished reading part {index} of {len(batches)} "
                                        f"({len(notes)} done)", parts_done=len(notes))

                if todo:
                    report("write", f"{who} is reading {len(todo)} parts, {settings.get('parallel', 3)} at a time")
                stop: BaseException | None = None
                with ThreadPoolExecutor(max_workers=settings.get("parallel", 3)) as pool:
                    futures = [pool.submit(read_part, i) for i in todo]
                    for index, future in zip(todo, futures):
                        try:
                            future.result()
                        except (llm.LimitError, Cancelled) as error:
                            # Parts already running are allowed to finish (and are
                            # kept); parts not started yet are dropped.
                            stop = stop or error
                            for other in futures:
                                other.cancel()
                        except CancelledFuture:
                            pass
                        except llm.ModelError as error:
                            state["skipped"].append(index)
                            report("write", f"Part {index} failed and is left out: {error}")
                if stop is not None:
                    raise stop
                if not notes:
                    raise llm.ModelError("every part failed")
                ordered = sorted(notes.items(), key=lambda item: int(item[0]))
                threads_read = min(state["counts"]["threadsFetched"],
                                   sum(batches[int(i) - 1]["threads"] for i, _ in ordered))
                comments_read = sum(batches[int(i) - 1]["comments"] for i, _ in ordered)
                texts = [notes_text(int(i), n["data"], compact=bool(limit)) for i, n in ordered]
                final_head = state["head"]
                if limit:
                    final_head = compact_head(state, rows=150)
                    texts = merge_notes(texts, limit=limit, budget=limit - nbytes(INSTRUCTIONS) - nbytes(REDUCE_NOTE)
                                        - nbytes(final_head) - 3000, provider=provider, model=model, effort=effort,
                                        topic=topic, part_head=part_head, cancel=cancel, logger=logger, report=report,
                                        spend=spend, lock=lock, who=who, parallel=settings.get("parallel", 3))
                packet = (REDUCE_NOTE.format(threads=threads_read, comments=comments_read, parts=len(ordered))
                          + final_head + "\n" + "\n".join(texts))
                report("write", f"{who} is writing the guide from {len(ordered)} parts of notes "
                                f"({len(packet) // 1000}k characters)")
            else:
                packet = state["packet"]
                report("write", f"{who} is reading the threads and writing the guide (a few minutes)")

            result = ask_checked(provider,
                                 prompt=INSTRUCTIONS.format(label=topic["label"], focus=topic["focus"],
                                                            n_products={"quick": "12–20", "standard": "18–30",
                                                                        "deep": "25–45"}[state["depth"]]) + packet,
                                 schema=REPORT_SCHEMA, model=model, effort=effort, cancel=cancel, log=logger("write"),
                                 timeout=1800, label=who, spend=spend, lock=lock,
                                 empty=lambda data: not data.get("products"))
            guide = result["data"]
            final_model = result["model"]
        except llm.LimitError as error:
            resets = error.resets
            done = f" after {len(notes)} of {len(batches)} parts" if batches else ""
            message = f"{who} hit its plan's usage limit{done}" + (f"; it resets {resets}" if resets else "") + "."
            save("paused", reason=str(error)[:500], resets=resets, seconds=state["seconds"] + round(time.time() - writing_started))
            report("paused", message + " Saved: continue later, or finish with another writer.", checkpoint=state["id"])
            raise Paused(state["id"], message, resets) from error
        except Cancelled:
            save("stopped", reason="Stopped by you.", resets="", seconds=state["seconds"] + round(time.time() - writing_started))
            raise
        except (llm.ModelError, SourceError, OSError) as error:
            note = f"{who} failed ({error}); this report was built from counts instead."
            report("write", note)

    # The guide, from the model or from the counts.
    writer: dict[str, Any] = {"by": "counts", "provider": None, "model": None, "effort": effort or None,
                              "cost": round(usage["cost"], 2) if usage["costKnown"] else None,
                              "tokens": {"input": usage["input"], "output": usage["output"]}, "calls": usage["calls"],
                              "quotesDropped": 0, "note": note}
    if guide is not None:
        kept, dropped = verify_quotes(guide, state["corpus"], state["threadTexts"])
        writer.update(by=provider, provider=who, model=final_model, quotesDropped=len(dropped), dropped=dropped,
                      note=f"{kept} quotes checked word for word against the source comments; "
                           f"{len(dropped)} that didn't match were removed.")
        readers = Counter(n["by"] for n in notes.values())
        if len(readers) > 1:
            writer["note"] += " Parts were read by " + ", ".join(f"{name} ×{n}" for name, n in readers.items()) + "."
            writer["readers"] = dict(readers)
        report("write", f"Guide written by {final_model}; {kept} quotes verified, {len(dropped)} dropped")
        if batches:
            ordered = [batches[int(i) - 1] for i in notes]
            read = {"threads": min(state["counts"]["threadsFetched"], sum(b["threads"] for b in ordered)),
                    "comments": sum(b["comments"] for b in ordered), "parts": len(ordered)}
        else:
            read = {"threads": state["single"]["threads"], "comments": state["single"]["comments"], "parts": 0}
    else:
        guide = heuristic_report(topic, state["analysis"], state["topicRows"])
        if not writer["note"]:
            writer["note"] = "Built from mention counts and a keyword tone score, without a model."
        read = {"threads": state["counts"]["threadsFetched"], "comments": state["counts"]["commentsFetched"], "parts": 0}

    attach_catalog(guide, state["topicRows"], state["topicRows"])

    used_threads = {t for p in guide.get("products", []) for t in p.get("threads", [])}
    used_threads |= {q["thread"] for p in guide.get("products", []) for q in p.get("quotes", [])}
    for section in ("trends", "avoid"):
        used_threads |= {t for item in guide.get(section, []) for t in item.get("threads", [])}
    meta = state["threadMeta"]
    counts = state["counts"]

    document = {
        "format": 2,
        "topic": {k: topic[k] for k in ("key", "label", "blurb", "query")},
        "createdAt": now_iso(),
        "depth": state["depth"],
        "window": {"from": datetime.fromtimestamp(state["after"], timezone.utc).strftime("%Y-%m-%d"),
                   "to": datetime.fromtimestamp(state["started"], timezone.utc).strftime("%Y-%m-%d"),
                   "days": state["days"]},
        "subreddits": state["subreddits"],
        "sources": state["sources"],
        "stats": {
            "postsScanned": counts["postsScanned"],
            "postsRelevant": counts["postsRelevant"],
            "threadsFetched": counts["threadsFetched"],
            "commentsFetched": counts["commentsFetched"],
            "threadsRead": read["threads"],
            "commentsRead": read["comments"],
            "brandSearchComments": counts["brandSearchComments"],
            "brandSearchThreads": counts["brandSearchThreads"],
            "parts": read["parts"],
            "ocsProducts": counts["ocsProducts"],
            "ocsTopicProducts": counts["ocsTopicProducts"],
            "seconds": state["seconds"] + round(time.time() - writing_started),
        },
        "writer": writer,
        "guide": guide,
        "mentions": {
            "months": state["analysis"]["months"],
            "volume": state["analysis"]["volume"],
            "brands": [{k: v for k, v in row.items() if k != "quotes"} for row in state["analysis"]["brands"][:30]],
        },
        "catalog": [public_row(row) for row in state["topicRows"]],
        "newOnOcs": new_on_ocs(state),
        "threads": {
            tid: {
                "title": clean_text(meta[tid].get("title"), 200),
                "sub": meta[tid].get("subreddit") or "",
                "score": meta[tid].get("score"),
                "comments": meta[tid].get("num_comments"),
                "date": datetime.fromtimestamp(int(meta[tid].get("created_utc") or 0), timezone.utc).strftime("%Y-%m-%d"),
            }
            for tid in sorted(used_threads | set(state["chosenTop"]))
            if tid in meta
        },
    }

    path = out_dir / "reports" / f"{state['id']}.json"
    write_json(path, document, indent=1)
    delete_checkpoint(out_dir, state["id"])
    report("write", f"Saved {path.name}", report=path.name)
    return path


# ── Checkpoints (runs waiting to continue) ────────────────────────────────


def checkpoint_paths(out_dir: Path, name: str) -> tuple[Path, Path]:
    folder = out_dir / "checkpoints"
    return folder / f"{name}.json", folder / f"{name}.meta.json"


def save_checkpoint(out_dir: Path, state: dict[str, Any]) -> None:
    full, meta = checkpoint_paths(out_dir, state["id"])
    write_json(full, state)
    write_json(meta, {
        "id": state["id"], "topic": {k: state["topic"][k] for k in ("key", "label", "query")}, "depth": state["depth"],
        "status": state.get("status"), "reason": state.get("reason", ""), "resets": state.get("resets", ""),
        "provider": state.get("provider"), "model": state.get("model"), "effort": state.get("effort"),
        "partsDone": len(state.get("notes") or {}), "parts": len(state.get("batches") or []),
        "createdAt": datetime.fromtimestamp(state["started"], timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "updatedAt": state.get("updatedAt"),
    })


def read_checkpoint(out_dir: Path, name: str) -> dict[str, Any] | None:
    if not CHECKPOINT_NAME.fullmatch(name or ""):
        return None
    try:
        state = json.loads(checkpoint_paths(out_dir, name)[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return state if isinstance(state, dict) and state.get("version") == 1 else None


def list_checkpoints(out_dir: Path) -> list[dict[str, Any]]:
    folder = out_dir / "checkpoints"
    rows = []
    for path in sorted(folder.glob("*.meta.json")) if folder.is_dir() else []:
        try:
            rows.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    rows.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
    return rows


def delete_checkpoint(out_dir: Path, name: str) -> bool:
    if not CHECKPOINT_NAME.fullmatch(name or ""):
        return False
    found = False
    for path in checkpoint_paths(out_dir, name):
        if path.exists():
            path.unlink()
            found = True
    return found


# ── Reports on disk ───────────────────────────────────────────────────────


def list_reports(out_dir: Path) -> list[dict[str, Any]]:
    folder = out_dir / "reports"
    if not folder.is_dir():
        return []
    rows = []
    for path in sorted(folder.iterdir(), reverse=True):
        if not REPORT_NAME.fullmatch(path.name):
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        guide = doc.get("guide") or {}
        rows.append({
            "name": path.name,
            "topic": doc.get("topic"),
            "createdAt": doc.get("createdAt"),
            "depth": doc.get("depth"),
            "headline": guide.get("headline"),
            "products": len(guide.get("products") or []),
            "by": (doc.get("writer") or {}).get("by"),
            "model": (doc.get("writer") or {}).get("model"),
            "archived": bool(doc.get("archived")),
            "archivedAt": doc.get("archivedAt"),
            "stats": doc.get("stats"),
        })
    rows.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
    return rows


# ── Background jobs (used by serve.py) ────────────────────────────────────


class Jobs:
    """One research run at a time, in a thread, with a progress log to poll."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self.lock = threading.Lock()
        self.job: dict[str, Any] | None = None
        self.cancel = threading.Event()

    def snapshot(self) -> dict[str, Any] | None:
        with self.lock:
            if self.job is None:
                return None
            return {**self.job, "log": list(self.job["log"][-80:]), "counts": dict(self.job["counts"])}

    def busy(self) -> bool:
        return bool(self.job and self.job["status"] == "running")

    def start(self, topic_key: str, query: str, depth: str, provider: str, model: str = "",
              effort: str = "") -> dict[str, Any]:
        resolve_topic(topic_key, query)  # raises ValueError on a bad request
        if depth not in DEPTHS:
            raise ValueError("Unknown depth.")
        model, effort = self._check(provider, model, effort)
        label = TOPICS[topic_key]["label"] if topic_key in TOPICS else query.strip()[:80]
        return self._launch(
            dict(topic=topic_key, label=label, query=query, depth=depth, provider=provider, model=model, effort=effort),
            lambda cancel: run(topic_key, query, depth=depth, provider=provider, model=model, effort=effort,
                               out_dir=self.out_dir, progress=self._progress, cancel=cancel))

    def resume(self, checkpoint: str, provider: str, model: str = "", effort: str = "") -> dict[str, Any]:
        """Continue a paused/stopped/interrupted run, with any writer."""
        meta = next((m for m in list_checkpoints(self.out_dir) if m.get("id") == checkpoint), None)
        if meta is None:
            raise ValueError("That paused run is gone.")
        if provider == "none":
            raise ValueError("Pick Claude, Codex or Grok to continue with.")
        model, effort = self._check(provider, model, effort)
        with self.lock:
            if self.job and self.job["status"] == "running" and self.job.get("checkpoint") == checkpoint:
                raise RuntimeError("That run is already going.")
        return self._launch(
            dict(topic=meta["topic"]["key"], label=meta["topic"]["label"], query=meta["topic"].get("query") or "",
                 depth=meta["depth"], provider=provider, model=model, effort=effort, checkpoint=checkpoint,
                 resumed=True),
            lambda cancel: resume(checkpoint, provider=provider, model=model, effort=effort, out_dir=self.out_dir,
                                  progress=self._progress, cancel=cancel))

    @staticmethod
    def _check(provider: str, model: str, effort: str) -> tuple[str, str]:
        if provider == "none":
            return "", ""
        model, effort = llm.check_choice(provider, model, effort)
        if llm.binary(provider) is None:
            raise ValueError(f"The {provider} CLI isn't installed here.")
        return model, effort

    def _launch(self, fields: dict[str, Any], work: Callable[[threading.Event], Path]) -> dict[str, Any]:
        with self.lock:
            if self.job and self.job["status"] == "running":
                raise RuntimeError("A research run is already going.")
            self.cancel = threading.Event()
            self.job = {
                "id": f"{int(time.time())}", "llm": fields["provider"] != "none", "status": "running",
                "stage": "write" if fields.get("resumed") else "catalog", "stages": list(STAGES),
                "startedAt": now_iso(), "finishedAt": None, "report": None, "error": None, "resets": "",
                "checkpoint": fields.get("checkpoint"), "log": [], "counts": {}, **fields,
            }
            cancel = self.cancel
        threading.Thread(target=self._run, args=(work, cancel), name="research", daemon=True).start()
        return self.snapshot() or {}

    def stop(self) -> None:
        self.cancel.set()

    def _progress(self, stage: str, message: str, **counts: Any) -> None:
        with self.lock:
            if self.job is None:
                return
            # Two keys are about the run, not numbers to show.
            if "checkpoint" in counts:
                self.job["checkpoint"] = counts.pop("checkpoint")
            counts.pop("report", None)
            if stage not in ("paused",):
                self.job["stage"] = stage
            self.job["counts"].update(counts)
            self.job["log"].append({"at": now_iso(), "stage": stage, "message": message})
            del self.job["log"][:-300]

    def _finish(self, **fields: Any) -> None:
        with self.lock:
            if self.job is not None:
                self.job.update(fields, finishedAt=now_iso())

    def _run(self, work: Callable[[threading.Event], Path], cancel: threading.Event) -> None:
        try:
            path = work(cancel)
            self._finish(status="done", stage="done", report=path.name, checkpoint=None)
        except Paused as pause:
            self._finish(status="paused", error=str(pause), resets=pause.resets, checkpoint=pause.checkpoint)
        except Cancelled:
            self._progress("cancelled", "Stopped." + (" What was already read is saved; you can continue it."
                                                      if self.job and self.job.get("checkpoint") else ""))
            self._finish(status="cancelled")
        except (SourceError, ValueError, OSError, llm.ModelError) as error:
            self._progress("error", str(error))
            self._finish(status="error", error=str(error))
        except Exception as error:  # a bug: say so rather than leave the job "running" forever
            self._progress("error", f"Unexpected error: {error!r}")
            self._finish(status="error", error=f"Unexpected error: {error!r}")


def read_report(out_dir: Path, name: str) -> dict[str, Any] | None:
    if not REPORT_NAME.fullmatch(name):
        return None
    try:
        return json.loads((out_dir / "reports" / name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def set_archived(out_dir: Path, name: str, archived: bool) -> bool:
    """Flag a guide as archived (or not) inside its own file, so every device agrees."""
    document = read_report(out_dir, name)
    if document is None:
        return False
    document["archived"] = archived
    document["archivedAt"] = now_iso() if archived else None
    write_json(out_dir / "reports" / name, document, indent=1)
    return True


def delete_report(out_dir: Path, name: str) -> bool:
    if not REPORT_NAME.fullmatch(name):
        return False
    path = out_dir / "reports" / name
    if not path.exists():
        return False
    path.unlink()
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Research a product type on Reddit and OCS, and write a guide.")
    parser.add_argument("topic", nargs="?", choices=[*TOPICS, "custom"])
    parser.add_argument("--resume", metavar="CHECKPOINT", help="continue a paused run (see research/checkpoints/)")
    parser.add_argument("--query", default="", help="search words, for the custom topic")
    parser.add_argument("--depth", choices=list(DEPTHS), default="quick")
    parser.add_argument("--provider", choices=[*llm.PROVIDERS, "none"], default="claude",
                        help="who writes the guide; none = counts only")
    parser.add_argument("--no-llm", action="store_true", help="same as --provider none")
    parser.add_argument("--model", default=os.environ.get("RESEARCH_MODEL", ""), help="e.g. opus, sonnet, gpt-6-sol")
    parser.add_argument("--effort", default="", help="thinking level, e.g. low, medium, high, xhigh, max")
    parser.add_argument("--subreddit", action="append", help=f"repeatable (default: {', '.join(DEFAULT_SUBREDDITS)})")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "research")
    args = parser.parse_args()

    provider = "none" if args.no_llm else args.provider
    model, effort = llm.check_choice(provider, args.model, args.effort) if provider != "none" else ("", "")
    try:
        if args.resume:
            path = resume(args.resume, provider=provider, model=model, effort=effort, out_dir=args.out.resolve())
        elif args.topic:
            path = run(args.topic, args.query, depth=args.depth, provider=provider, model=model, effort=effort,
                       subreddits=tuple(args.subreddit or DEFAULT_SUBREDDITS), out_dir=args.out.resolve())
        else:
            parser.error("give a topic, or --resume CHECKPOINT")
    except Paused as pause:
        print(f"{pause} Continue with: python3 research.py --resume {pause.checkpoint} [--provider …]")
        raise SystemExit(2)
    print(path)


if __name__ == "__main__":
    main()
