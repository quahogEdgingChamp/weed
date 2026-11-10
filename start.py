"""How to start: the last section of a product guide.

How much to take the first time, how long to wait before taking more, how a
session unfolds, the mistakes that lead to too much, and what helps then.
It is written after the guide is saved, by the same writer, from two kinds
of evidence:

1. the guide's own threads (from research/cache/threads): only the comments
   that talk about starting out, dosing or taking too much. Buying threads
   say little about this, so
2. threads asking or answering how to start with this kind of product, in
   the subreddits where people talk about it (r/Carts for carts, r/edibles
   for edibles...), then every comment of the best ones. Posts come from
   each subreddit's newest posts (the guide's own subreddits: the whole
   year research.py keeps on file), matched here, and from the archive's
   full-text search when it answers, which it often doesn't

The writer may fill gaps with general harm-reduction basics, and says for
each step whether people in the threads say it or it is a general basic.
Quotes are checked word for word, as in the guide.

Nothing here may cost a guide: it is saved before this runs. A guide
without the section (an older one, or a run whose writer hit its limit
right after the guide) gets it with

    python3 research.py --how-to-start [REPORT ...]
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import llm
import research
from research import STR, STRS, SourceError, clean_text, obj

# ── What to look for, per topic ───────────────────────────────────────────
#
# `form` tells the writer what the product is and how it's taken. `subs` are
# subreddits about this form, where every post is on it; in `general` ones a
# post must also match `match` to count. `searches` are short, the way people
# title a post; a post matches one when it has every word.

VAPE = r"\b(carts?|cartridges?|510s?|vapes?|vaping|vape\s*pens?|pens?|disposables?|dispos?|aios?|oil\s*pens?)\b"
DAB = r"\b(dabs?|dabbing|rosin|live\s*resin|concentrates?|wax|shatter|badder|batter|sauce|diamonds?|e-?rigs?|puffco|rigs?)\b"
SMOKE = r"\b(joints?|pre-?rolls?|bowls?|blunts?|bongs?|pipes?|flower|smok\w*|hits?)\b"
EDIBLE = r"\b(edibles?|gumm(y|ies)|chocolates?|cookies?|brownies?|drinks?|beverages?|capsules?|mg)\b"

FORMS: dict[str, dict[str, Any]] = {
    "live-carts": {
        "form": "a vape cartridge (510 thread) of live resin or live rosin on a battery: inhaled, felt within minutes, "
                "easy to take a little more later",
        "subs": ("Carts",), "general": ("trees", "TheOCS", "CanadianCannabisLPs"),
        "searches": ("first cart", "how many hits", "greened out", "new to carts"), "match": VAPE,
    },
    "disposables": {
        "form": "a disposable or all-in-one vape pen: inhaled, felt within minutes, easy to take a little more later",
        "subs": ("Carts",), "general": ("trees", "TheOCS", "CanadianCannabisLPs"),
        "searches": ("first disposable", "how many hits", "greened out", "new to vaping"), "match": VAPE,
    },
    "rosin": {
        "form": "a dab of solventless rosin (on a rig, an e-rig or a dab pen): inhaled, very strong per hit, "
                "felt within minutes",
        "subs": ("Dabs", "Rosin"), "general": ("trees", "TheOCS"),
        "searches": ("first dab", "small dab", "dab size", "greened out"), "match": DAB,
    },
    "resin": {
        "form": "a dab of hydrocarbon live resin (on a rig, an e-rig or a dab pen): inhaled, very strong per hit, "
                "felt within minutes",
        "subs": ("Dabs",), "general": ("trees", "TheOCS"),
        "searches": ("first dab", "small dab", "dab size", "greened out"), "match": DAB,
    },
    "flower": {
        "form": "dried flower, smoked in a joint, pipe or bong, or vaporized: felt within minutes",
        "subs": ("trees",), "general": ("weed", "TheOCS"),
        "searches": ("first time smoking", "how many hits", "greened out", "too high"), "match": SMOKE,
    },
    "prerolls": {
        "form": "a pre-roll (a ready-made joint; infused ones are much stronger): smoked, felt within minutes",
        "subs": ("trees",), "general": ("weed", "TheOCS"),
        "searches": ("first joint", "infused preroll", "how many hits", "greened out"), "match": SMOKE,
    },
    "hash": {
        "form": "hash or kief, crumbled on a bowl or in a joint, or vaporized: stronger than flower, felt within minutes",
        "subs": ("hash",), "general": ("trees", "TheOCS"),
        "searches": ("first time hash", "how much hash", "hash too strong", "greened out"),
        "match": r"\b(hash|kief|bubble|temple\s*balls?|dry\s*sift|piatella)\b",
    },
    "edibles": {
        "form": "an edible, a drink or a capsule: eaten, so it takes 30 minutes to 2 hours to start and lasts many "
                "hours; what's eaten can't be taken back",
        "subs": ("edibles",), "general": ("trees", "TheOCS", "CanadianCannabisLPs"),
        "searches": ("first edible", "how many mg", "start low", "edible too high"), "match": EDIBLE,
    },
}

SEARCH_YEARS = 3
LISTING_PAGES = {"subs": 10, "general": 5}  # pages of 100 newest posts: r/trees gets ~100 a day, r/hash ~12
SEARCH_TRIES = 2  # the archive's search often answers 422 when busy; once more sometimes works
ARCHIVE_GIVE_UP = 3  # failed searches in a row before the archive is left alone
SEARCH_THREADS = 10  # threads found by the search whose comments are read
THREAD_COMMENTS = 30  # comments per searched thread, starting talk first
COMMENT_CHARS = 500
PACKET_CHARS = 110_000

# What starting talk looks like. Strong phrases are about dosing or taking
# too much; weak ones ("first time", "anxiety", "10mg") are often not. A
# comment counts when its weights add up to 2.
_N = r"(?:one|two|three|a\s+couple(?:\s+of)?|a\s+few|few|1|2|3|1-2|2-3|small|tiny|short|little|light|single)"
STRONG = re.compile(
    r"\b(?:start(?:ed|ing)?\s+(?:off\s+)?(?:low|small|slow|light|with\s+(?:a\s+|one\s+|1\s+|half|a\s+quarter|\d))"
    r"|low\s+(?:and|&)\s+slow|go(?:ing)?\s+slow|take\s+it\s+(?:slow|easy)|ease\s+(?:into|in)"
    r"|" + _N + r"\s+(?:puffs?|hits?|tokes?|draws?|pulls?|rips?|dabs?|bumps?)"
    r"|wait(?:ed|ing)?\s+(?:at\s+least\s+|like\s+|about\s+|for\s+)?(?:\d+|a\s+few|ten|fifteen|twenty|thirty|an?|half\s+an)"
    r"\s*(?:-\s*\d+\s*)?(?:min|mins|minutes|hours?|hrs?|h)\b"
    r"|beginners?|newbies?|new\s+to\s+(?:carts?|vap\w+|dabs?|dabbing|edibles?|weed|smoking|cannabis|concentrates?|hash)"
    r"|green(?:ed|ing)?[- ]?out|too\s+high|way\s+too\s+(?:much|high|stoned)|overdid|overdo(?:ne|ing)?"
    r"|low\s+tolerance|tolerance\s+break|t[- ]?break"
    r"|re-?dos(?:e|ed|ing)|double[- ]dos\w+|kick(?:s|ed)?\s+in|onset|micro-?dos\w*"
    r"|half\s+(?:a|the)\s+(?:gummy|chocolate|square|piece|joint|cookie|bar|dose)"
    r"|cbd\s+(?:helps?|to\s+(?:calm|counter|balance))|black\s+pepper(?:corns?)?|panic\s+attacks?)\b",
    re.IGNORECASE,
)
WEAK = re.compile(r"\b(?:first[- ]time(?:rs?)?|\d+(?:\.\d+)?\s?mg|paranoi\w+|anxious|anxiety|tolerance|dose|dosing)\b",
                  re.IGNORECASE)


def weight(text: str) -> int:
    """How much a comment is about starting out: 2 per distinct strong
    phrase, 1 per distinct weak one."""
    strong = {m.group(0).lower() for m in STRONG.finditer(text or "")}
    weak = {m.group(0).lower() for m in WEAK.finditer(text or "")}
    return 2 * len(strong) + len(weak)


def form_for(topic: dict[str, Any], subreddits: list[str]) -> dict[str, Any]:
    """The topic's entry in FORMS; a custom search gets one from its words."""
    if topic.get("key") in FORMS:
        return FORMS[topic["key"]]
    words = [w for w in re.findall(r"[a-z0-9]+", (topic.get("query") or topic.get("label") or "").lower())
             if len(w) >= 3][:3]
    if not words:
        words = ["cannabis"]
    return {
        "form": topic.get("label") or " ".join(words),
        "subs": (), "general": tuple(dict.fromkeys([*subreddits, "trees"])),
        "searches": (" ".join(words), f"first time {words[0]}", f"how much {words[0]}"),
        "match": "".join(rf"(?=[\s\S]*\b{re.escape(w)})" for w in words),
    }


# ── The evidence ──────────────────────────────────────────────────────────


def thread_row(post: dict[str, Any]) -> dict[str, Any]:
    """A post (or a guide state's thread meta) as a guide's `threads` keeps it."""
    return {
        "title": clean_text(post.get("title"), 200),
        "sub": post.get("subreddit") or "",
        "score": post.get("score"),
        "comments": post.get("num_comments"),
        "date": datetime.fromtimestamp(int(post.get("created_utc") or 0), timezone.utc).strftime("%Y-%m-%d"),
    }


def cached_comments(cache_dir: Path, tid: str) -> list[dict[str, Any]]:
    """A thread's comments as research.thread_comments saved them (a bare
    list in older caches); [] when the thread was never fetched."""
    try:
        data = json.loads((cache_dir / "threads" / f"{tid}.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = data.get("comments") if isinstance(data, dict) else data
    return [c for c in rows or [] if isinstance(c, dict) and c.get("id")]


def own_evidence(cache_dir: Path, threads: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """The guide's threads that talk about starting out, each with only those
    comments; most such talk first."""
    found = []
    for tid, row in threads.items():
        kept = [(weight(c.get("body") or ""), c) for c in cached_comments(cache_dir, tid) if research.usable(c)]
        kept = [(w, c) for w, c in kept if w >= 2]
        if kept:
            kept.sort(key=lambda wc: (wc[0], int(wc[1].get("score") or 0)), reverse=True)
            found.append({"id": tid, "row": row, "text": "", "comments": [c for _, c in kept],
                          "weight": sum(w for w, _ in kept)})
    found.sort(key=lambda t: t["weight"], reverse=True)
    return found


def listing(sub: str, after: int, pages: int, cache_dir: Path, cancel: threading.Event | None,
            log: Callable[[str], None]) -> list[dict[str, Any]]:
    """A subreddit's posts since `after`: the whole year research.py keeps on
    file for the guide's own subreddits, else its newest posts. [] when it
    can't be read."""
    import ask  # ask imports research, which imports this module lazily

    try:
        kept = json.loads((cache_dir / f"posts-{sub.lower()}.json").read_text(encoding="utf-8"))
        posts = kept.get("posts") if isinstance(kept, dict) else None
        if isinstance(posts, dict) and posts:
            return [{**p, "subreddit": p.get("subreddit") or sub} for p in posts.values()
                    if int(p.get("created_utc") or 0) >= after]
    except (OSError, json.JSONDecodeError):
        pass
    try:
        return [{**p, "subreddit": p.get("subreddit") or sub}
                for p in ask.recent_posts(sub, after, pages, cache_dir, cancel, lambda _m: None)]
    except SourceError as error:
        log(f"How to start: r/{sub} couldn't be read ({error})")
        return []


def archive_finds(form: dict[str, Any], subs: list[str], after: int, cache_dir: Path,
                  cancel: threading.Event | None, log: Callable[[str], None]) -> tuple[list[dict[str, Any]], int]:
    """Posts the archive's full-text search finds for each search in each
    subreddit, and how many searches it answered. Best effort: it gives up
    after a few failures in a row."""
    import ask

    found: list[dict[str, Any]] = []
    failed_in_a_row = answered = 0
    for words in form["searches"]:
        for sub in subs:
            if failed_in_a_row >= ARCHIVE_GIVE_UP:
                return found, answered
            rows = None
            for attempt in range(SEARCH_TRIES):
                try:
                    rows = ask.archive_search(sub, words, after, cache_dir, cancel)
                    break
                except SourceError:
                    if attempt + 1 < SEARCH_TRIES:
                        research.sleep(3, cancel)
            if rows is None:
                failed_in_a_row += 1
                if failed_in_a_row == ARCHIVE_GIVE_UP:
                    log("How to start: the archive's full-text search isn't answering; "
                        "going on with each subreddit's posts")
                continue
            failed_in_a_row = 0
            answered += 1
            found += [{**post, "subreddit": post.get("subreddit") or sub} for post in rows]
    return found, answered


def find_threads(form: dict[str, Any], skip: set[str], cache_dir: Path, cancel: threading.Event | None,
                 log: Callable[[str], None]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Threads asking or answering how to start with this form; every comment
    of the best ones, starting talk first. Returns (threads, where it looked)."""
    import ask

    after = int(time.time() - SEARCH_YEARS * 365 * 86400)
    dedicated = {s.lower() for s in form["subs"]}
    subs = [*form["subs"], *form["general"]]
    match = re.compile(form["match"], re.IGNORECASE)
    patterns = ask.search_patterns(list(form["searches"]))
    posts: dict[str, dict[str, Any]] = {}

    def consider(post: dict[str, Any], searched: bool) -> None:
        title = post.get("title") or ""
        text = f"{title}\n{post.get('selftext') or ''}"
        if not post.get("id") or post["id"] in skip:
            return
        if (post.get("subreddit") or "").lower() not in dedicated and not match.search(text):
            return
        # On topic when a search found it, a search's words are in it, the
        # title talks about starting out, or the text does, three ways.
        # Reviews often mention a "first time" or "tolerance" in passing.
        in_title = len({m.group(0).lower() for m in STRONG.finditer(title)})
        relevant = ask.relevance(post, patterns)
        if not (searched or relevant or in_title or len({m.group(0).lower() for m in STRONG.finditer(text)}) >= 3):
            return
        engagement = (math.log1p(max(int(post.get("num_comments") or 0), 0))
                      + 0.5 * math.log1p(max(int(post.get("score") or 0), 0)))
        rank = (6 * in_title + 2 * relevant + min(weight(text), 6) + (2 if searched else 0)) * (1 + engagement)
        if rank > posts.get(post["id"], {}).get("_rank", 0):
            posts[post["id"]] = {**post, "_rank": rank}

    for sub in subs:
        pages = LISTING_PAGES["subs" if sub.lower() in dedicated else "general"]
        for post in listing(sub, after, pages, cache_dir, cancel, log):
            consider(post, searched=False)
    finds, answered = archive_finds(form, subs, after, cache_dir, cancel, log)
    for post in finds:
        consider(post, searched=True)

    chosen = sorted((p for p in posts.values() if int(p.get("num_comments") or 0) >= 3),
                    key=lambda p: p["_rank"], reverse=True)[:SEARCH_THREADS]
    found = []
    for post in chosen:
        comments = [c for c in research.thread_comments(post, cache_dir, cancel, log) if research.usable(c)]
        if not comments:
            continue
        comments.sort(key=lambda c: (min(weight(c.get("body") or ""), 4), int(c.get("score") or 0)), reverse=True)
        body = clean_text(post.get("selftext"), 900)
        found.append({"id": post["id"], "row": thread_row(post),
                      "text": "" if body in ("[removed]", "[deleted]") else body,
                      "title": post.get("title") or "", "comments": comments[:THREAD_COMMENTS]})
    info = {"subreddits": subs, "searches": list(form["searches"]), "searchesAnswered": answered,
            "candidates": len(posts)}
    log(f"How to start: {len(found)} threads about starting out found in " + ", ".join(f"r/{s}" for s in subs)
        + f" ({len(posts)} candidates; the archive's search answered {answered} of "
          f"{len(form['searches']) * len(subs)})")
    return found, info


def thread_text(thread: dict[str, Any], budget: int) -> tuple[str, list[dict[str, Any]]]:
    """One thread as the writer sees it, within `budget` characters; returns
    (text, the comments that fit)."""
    row = thread["row"]
    stats = ", ".join(x for x in (row.get("date"), f"r/{row['sub']}" if row.get("sub") else "",
                                  f"{row['score']}↑" if row.get("score") is not None else "",
                                  f"{row['comments']} comments" if row.get("comments") is not None else "") if x)
    lines = [f"### [t:{thread['id']}] {row.get('title') or '(untitled)'} ({stats})"]
    if thread.get("text"):
        lines.append(thread["text"])
    size = sum(len(line) + 1 for line in lines)
    kept = []
    for c in thread["comments"]:
        line = f"- [c:{c['id']} {int(c.get('score') or 0)}↑] {clean_text(c.get('body'), COMMENT_CHARS)}"
        if size + len(line) + 1 > budget:
            break
        lines.append(line)
        size += len(line) + 1
        kept.append(c)
    return "\n".join(lines) + "\n", kept


def build_packet(own: list[dict[str, Any]], searched: list[dict[str, Any]], budget: int
                 ) -> tuple[str, dict[str, int], dict[str, str], dict[str, str], dict[str, str]]:
    """Section A (the guide's threads), then section B (the search), within
    `budget` characters. Returns (packet, counts, {comment id: text},
    {thread id: its own text}, {comment id: its thread id})."""
    own_budget = budget if not searched else int(budget * 0.4)
    counts = {"ownThreads": 0, "ownComments": 0, "searchedThreads": 0, "searchedComments": 0}
    corpus: dict[str, str] = {}
    texts: dict[str, str] = {}
    thread_of: dict[str, str] = {}
    out = []
    for heading, threads, room, key in (
            ("## A. This guide's threads: only the comments about starting out, dosing or taking too much\n",
             own, own_budget, "own"),
            ("## B. Threads found by searching for first-time advice on this kind of product\n", searched, None, "searched")):
        if not threads:
            continue
        used = len(heading)
        room = room if room is not None else budget - sum(len(x) for x in out)
        block = [heading]
        for thread in threads:
            if room - used < 600:
                break
            # No one thread may crowd out the rest.
            text, kept = thread_text(thread, min(room - used, max(room // 4, 6000)))
            if not kept and not thread.get("text"):
                continue
            block.append(text)
            used += len(text)
            counts[f"{key}Threads"] += 1
            counts[f"{key}Comments"] += len(kept)
            corpus.update({c["id"]: c.get("body") or "" for c in kept})
            thread_of.update({c["id"]: thread["id"] for c in kept})
            texts[thread["id"]] = f"{thread.get('title') or thread['row'].get('title') or ''}\n{thread.get('text') or ''}"
        if len(block) > 1:
            out.append("\n".join(block))
    return "\n".join(out), counts, corpus, texts, thread_of


# ── The writer ────────────────────────────────────────────────────────────

BASIS = {"type": "string", "enum": ["threads", "both", "general"]}

SCHEMA = obj({
    "summary": STR,
    "first_time": STR,
    "wait": STR,
    "timeline": obj({"onset": STR, "peak": STR, "lasts": STR}),
    "steps": {"type": "array", "items": obj({"title": STR, "body": STR, "basis": BASIS, "threads": STRS})},
    "with_tolerance": STR,
    "first_picks": {"type": "array", "items": obj({"product": STR, "why": STR})},
    "mistakes": {"type": "array", "items": obj({"title": STR, "body": STR, "threads": STRS})},
    "too_much": STRS,
    "quotes": {"type": "array", "items": obj({"text": STR, "thread": STR, "comment": STR})},
    "evidence": {"type": "string", "enum": ["strong", "moderate", "thin"]},
    "evidence_note": STR,
})

SYSTEM = """You write the "How to start" part of a cannabis buyer's guide for adults in Ontario, Canada. It tells \
someone new to this kind of product, or coming back to it after a break, how to take it the first time so they enjoy \
it and don't take too much. Your evidence is what people say in the Reddit threads the user gives you. You may add \
widely accepted harm-reduction basics (such as Canada's Lower-Risk Cannabis Use Guidelines) where the threads are \
silent, and you always say which is which. You write like a calm, experienced friend: specific, practical, never \
preachy. You never invent quotes."""

PROMPT = """Write the "How to start" section of the guide to {label} as JSON matching the schema.

The product: {form}.

The reader wants to know exactly how much to take the first time, how long to wait before taking more, how the \
session goes over time, how to avoid taking too much (a "green-out"), and what to do if they do.

Rules:
- Be concrete, in the unit that fits this product: puffs and how long each one is, minutes, milligrams, the size of \
a dab. Ranges are fine ("1–2 short puffs").
- summary: 1–2 sentences, the whole method in short. For a vape that might be "Take one or two short puffs, wait 10–15 \
minutes, and only then decide on more: you can always add, never take back." Fit it to this product.
- first_time: how much to take the first time, in one or two sentences.
- wait: how long to wait before more, and why, in one or two sentences.
- timeline: `onset` when it starts, `peak` when it's strongest, `lasts` how long it lasts; short phrases like \
"2–10 minutes".
- steps: 4–7 steps for a first session, in the order you'd do them: the setting (where, with whom, nowhere to drive), \
the first dose, waiting, adding more, knowing when to stop. `basis` is "threads" when people in the threads say it, \
"general" when it's a harm-reduction basic the threads don't cover, "both" when both. `threads` the ids of the \
threads behind a "threads" or "both" step.
- with_tolerance: one or two sentences for someone who already uses cannabis another way (a flower smoker trying \
this for the first time, say): what is different here.
- first_picks: 0–4 products from the guide's list below that people in the evidence or the guide describe as \
gentler, more forgiving or good for beginners. `product` is the id exactly as listed; `why` one short line. Leave it \
empty when nothing points to one, and never pick a product only because it is weak.
- mistakes: 3–5 things that lead people to take too much or have a bad time with this product, as people report \
them (a long first pull on a fresh cart, a second gummy after 45 minutes). `threads` the ids of the threads.
- too_much: 3–6 short, practical things that help when it's too much (it passes; somewhere safe to sit or lie \
down; water and a snack; CBD only if people mention it; no driving). Nothing is a cure: don't call it one.
- quotes: 2–6 short quotes that carry the best advice, copied VERBATIM from a comment (or the thread's own text) in \
the evidence, at most 280 characters. You may cut the start or end of a sentence but never change words inside it. \
`thread` is the thread's id, `comment` the comment's id ("" for the thread's own text). Quotes that aren't verbatim \
are deleted automatically.
- Ids are bare: "1v1n4ys", not "t:1v1n4ys".
- evidence: "strong" when many people in the threads give consistent first-time advice for this product, \
"moderate" when some do, "thin" when the section rests mostly on general basics. evidence_note says so in one line.
- Say "people report", not "it will". No medical claims. Canadian spelling.

{products}
The evidence follows. Section A is comments from this guide's own threads that talk about starting out, dosing or \
taking too much; section B is threads found by searching for first-time advice on this kind of product. \
t = thread id, c = comment id, ↑ = score.

"""


def product_list(guide: dict[str, Any]) -> str:
    products = [p for p in guide.get("products") or [] if isinstance(p, dict) and p.get("id")][:45]
    if not products:
        return "The guide ranks no products: leave first_picks empty.\n"
    lines = [f"## The guide's products ({len(products)}): first_picks may only use these ids",
             "id | brand | name | kind | strength | good for | tier | THC"]
    for p in products:
        ocs = p.get("ocs") or {}
        thc = ""
        if ocs.get("thcMax") is not None:
            unit = ocs.get("thcUnit") or "%"
            thc = (f"{ocs.get('thcMin')}–{ocs['thcMax']}{unit}" if ocs.get("thcMin") not in (None, ocs["thcMax"])
                   else f"{ocs['thcMax']}{unit}")
        lines.append(" | ".join(str(x or "") for x in (p["id"], p.get("brand"), p.get("name"), p.get("kind"),
                                                        p.get("strength"), ", ".join(p.get("good_for") or []),
                                                        p.get("tier"), thc)))
    return "\n".join(lines) + "\n"


ID_PREFIX = re.compile(r"^\[?\s*[tc]\s*:\s*|\s*\]$")


def bare(ref: Any) -> str:
    """A thread or comment id as the writer may give it ("t:abc", "[c:xyz]")
    without its label."""
    return ID_PREFIX.sub("", str(ref or "").strip())


def clean_refs(section: dict[str, Any]) -> None:
    """Ids without their t:/c: labels, before the quotes are checked."""
    for quote in section.get("quotes") or []:
        quote["thread"], quote["comment"] = bare(quote.get("thread")), bare(quote.get("comment"))
    for key in ("steps", "mistakes"):
        for item in section.get(key) or []:
            item["threads"] = [bare(t) for t in item.get("threads") or []]


def tidy(section: dict[str, Any], guide: dict[str, Any], known: set[str], thread_of: dict[str, str]) -> dict[str, Any]:
    """Drop what doesn't point anywhere: picks of products the guide lacks,
    thread ids that weren't in the evidence. A quote's thread is the one its
    comment is in."""
    for quote in section.get("quotes") or []:
        if quote.get("comment") in thread_of:
            quote["thread"] = thread_of[quote["comment"]]
    ids = {p.get("id") for p in guide.get("products") or [] if isinstance(p, dict)}
    picks, seen = [], set()
    for pick in section.get("first_picks") or []:
        if pick.get("product") in ids and pick["product"] not in seen:
            seen.add(pick["product"])
            picks.append(pick)
    section["first_picks"] = picks[:4]
    for key in ("steps", "mistakes"):
        for item in section.get(key) or []:
            item["threads"] = [t for t in dict.fromkeys(item.get("threads") or []) if t in known]
    section["too_much"] = [x for x in section.get("too_much") or [] if isinstance(x, str) and x.strip()]
    return section


def cited(section: dict[str, Any]) -> set[str]:
    ids = {q.get("thread") for q in section.get("quotes") or []}
    for key in ("steps", "mistakes"):
        ids |= {t for item in section.get(key) or [] for t in item.get("threads") or []}
    return {t for t in ids if t}


def add_start(out_dir: Path, name: str, *, provider: str, model: str = "", effort: str = "",
              log: Callable[[str], None] = print, cancel: threading.Event | None = None,
              threads: dict[str, dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """Write (or rewrite) the How to start section of a saved guide. Returns
    its `startMethod`, or None when there's no such guide, it is an answer to
    a question, or no evidence at all was found.

    `threads` are the guide's own threads as {id: row}; by default the ones
    the guide lists. Raises llm.LimitError, llm.ModelError and Cancelled for
    the caller to handle: nothing is written then.
    """
    document = research.read_report(out_dir, name)
    if document is None or document.get("kind") == "question" or not isinstance(document.get("guide"), dict):
        return None
    if provider not in llm.PROVIDERS:
        raise ValueError("How to start needs a writer: Claude, Codex or Grok.")
    started = time.time()
    topic = document.get("topic") or {}
    label = topic.get("label") or "this product"
    form = form_for(topic, document.get("subreddits") or list(research.DEFAULT_SUBREDDITS))
    cache_dir = out_dir / "cache"
    own_threads = threads if threads is not None else document.get("threads") or {}

    log(f"How to start: reading what people say about a first time with {label.lower()}")
    own = own_evidence(cache_dir, own_threads)
    searched, info = find_threads(form, set(own_threads), cache_dir, cancel, log)
    if not own and not searched:
        log("How to start: no first-time advice found in this guide's threads or by searching; not written")
        return None

    who = llm.LABELS.get(provider, provider)
    prompt = PROMPT.format(label=label.lower(), form=form["form"], products=product_list(document["guide"]))
    budget = PACKET_CHARS
    limit = llm.PROMPT_LIMITS.get(provider)
    if limit:
        # Grok counts bytes, and the system prompt and schema come with it.
        budget = min(budget, limit - research.nbytes(prompt) - research.nbytes(SYSTEM)
                     - len(json.dumps(SCHEMA)) - 6000)
    packet, counts, corpus, texts, thread_of = build_packet(own, searched, budget)
    log(f"How to start: {who} is writing it from {counts['ownComments'] + counts['searchedComments']} comments "
        f"({counts['ownComments']} in this guide's threads, {counts['searchedComments']} in "
        f"{counts['searchedThreads']} threads found by the search)")
    usage = {"calls": 0, "input": 0, "output": 0, "cost": 0.0, "costKnown": False}

    def spend(result: dict[str, Any]) -> None:
        usage["calls"] += 1
        usage["input"] += result["tokens"].get("input") or 0
        usage["output"] += result["tokens"].get("output") or 0
        if isinstance(result.get("cost"), (int, float)):
            usage["cost"] += result["cost"]
            usage["costKnown"] = True

    result = research.ask_checked(provider, prompt=prompt + packet, schema=SCHEMA, model=model, effort=effort,
                                  cancel=cancel, log=log, timeout=1200, label=f"{who} (how to start)", spend=spend,
                                  lock=threading.Lock(), system=SYSTEM,
                                  empty=lambda data: not data.get("summary") or not data.get("steps"))
    section = result["data"]
    clean_refs(section)
    kept, dropped = research.verify_quotes({"start": [section]}, corpus, texts)
    rows = {t["id"]: t["row"] for t in own + searched}
    tidy(section, document["guide"], set(rows), thread_of)
    method = {
        "by": provider, "provider": who, "model": result["model"], "effort": effort or None,
        "written": research.now_iso(),
        "own": {"threads": counts["ownThreads"], "comments": counts["ownComments"]},
        "searched": {"threads": counts["searchedThreads"], "comments": counts["searchedComments"], **info},
        "quotes": kept, "quotesDropped": len(dropped),
        "cost": round(usage["cost"], 2) if usage["costKnown"] else None,
        "tokens": {"input": usage["input"], "output": usage["output"]},
        "seconds": round(time.time() - started),
    }

    with research.REPORT_LOCK:
        # Read it again: it may have been archived or priced meanwhile.
        document = research.read_report(out_dir, name)
        if document is None:
            return None
        document["guide"]["start"] = section
        document["startMethod"] = method
        known = document.setdefault("threads", {})
        for tid in cited(section):
            if tid not in known and tid in rows:
                known[tid] = rows[tid]
        research.write_json(out_dir / "reports" / name, document, indent=1)
    log(f"How to start: written by {result['model']}; {kept} quotes verified, {len(dropped)} dropped")
    return method
