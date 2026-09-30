"""Free questions: ask anything, get an answer from what people say on Reddit.

A question can be about any theme ("how do live resin carts affect
studying?", "does a grinder card beat a grinder?", "is it worth learning
Rust in 2026?"). Nothing is fixed in advance, so the model plans first:

1. plan     the writer picks the subreddits where people talk about this
            first-hand, short keyword searches, and what a good answer covers
2. search   each subreddit x search, from three sources in turn: the Arctic
            Shift archive's full-text search (fast, often overloaded), Reddit's
            own search feed, and always the newest posts of each subreddit
            matched against the searches here (slow to go back far, but it
            always works)
3. threads  every comment of the most relevant threads
4. parse    the evidence, cut to fit (one pass, or parts for deep)
5. write    research.write does the rest exactly as for a product guide:
            parts and notes, checkpoints, pausing on a usage limit, quotes
            checked word for word; this module supplies the prompts, the
            answer's schema and the saved document

When the question is about cannabis products, the ones people name are
lined up against the OCS catalog, so they link to OCS like a guide's do.
"""

from __future__ import annotations

import math
import re
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import llm
import research
from research import STR, STRS, SourceError, obj

STAGES = ("plan", "search", "threads", "parse", "write")
QUESTION_MAX = 300

# Per depth: how far back, how wide the plan may go, how deep the scan of
# each subreddit reaches (pages of 100 newest posts), how many threads are
# read and how. `chars`/`comments`/`comment_chars` as in research.DEPTHS.
DEPTHS: dict[str, dict[str, Any]] = {
    "quick": {"days": 730, "subs": 4, "searches": 5, "pages": 10, "threads": 30, "comments": 25, "reddit_budget": 240,
              "comment_chars": 450, "chars": 140_000, "mode": "single"},
    "standard": {"days": 1095, "subs": 6, "searches": 6, "pages": 25, "threads": 80, "comments": 40, "reddit_budget": 480,
                 "comment_chars": 450, "chars": 420_000, "mode": "single"},
    "deep": {"days": 1825, "subs": 8, "searches": 8, "pages": 60, "threads": 200, "comments": None, "reddit_budget": 900,
             "comment_chars": 900, "chars": 170_000, "mode": "batches", "comment_search": 4, "parallel": 3},
}
FINDINGS = {"quick": "5–9", "standard": "7–12", "deep": "9–16"}


# ── The plan ──────────────────────────────────────────────────────────────

PLAN_SCHEMA = obj({
    "title": STR,
    "restated": STR,
    "subreddits": {"type": "array", "items": obj({"name": STR, "why": STR})},
    "searches": STRS,
    "aspects": STRS,
    "cannabis_products": {"type": "boolean"},
})

PLAN_SYSTEM = """You plan research on Reddit. Given a question, you decide where on Reddit people discuss it \
first-hand and what to search for. The question can be about anything at all. You only plan; you don't answer."""

PLAN_PROMPT = """Plan a Reddit search that will answer this question well:

"{question}"

Return JSON matching the schema:
- title: a short name for this question, at most 60 characters, like a headline ("Live resin carts and studying").
- restated: the question restated precisely in one sentence, keeping every condition the asker gave.
- subreddits: {subs} existing subreddits, most useful first, where people talk about this from their own experience. \
Mix one or two big general communities with niche ones. Give the exact name without "r/", and a few words on why.
- searches: {searches} short keyword searches, 1–3 words each, the way people would word a post title or comment \
about it. A post must contain every word of a search, so keep them short. Use synonyms and slang \
("studying", "study high", "homework stoned", "focus sativa"). Plain words only: no quotes, operators or subreddit names.
- aspects: 3–6 sub-questions a complete answer should cover.
- cannabis_products: true only if the answer is likely to name specific cannabis products or brands someone \
could buy at the Ontario Cannabis Store.
"""

SUB_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_]{1,20}")


def clean_plan(data: dict[str, Any], question: str, settings: dict[str, Any]) -> dict[str, Any]:
    """The model's plan, checked: real-looking subreddit names, short plain
    searches, nothing duplicated. A plan with nowhere to look is a failure."""
    subs: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in data.get("subreddits") or []:
        name = re.sub(r"^/?r/", "", str((row or {}).get("name") or "").strip(), flags=re.IGNORECASE)
        if SUB_NAME.fullmatch(name) and name.lower() not in seen:
            seen.add(name.lower())
            subs.append({"name": name, "why": research.clean_text((row or {}).get("why"), 160)})
    if data.get("cannabis_products") and "theocs" not in seen:
        subs.append({"name": "TheOCS", "why": "Ontario buyers comparing OCS products"})
    searches: list[str] = []
    for raw in data.get("searches") or []:
        words = re.findall(r"[a-z0-9][a-z0-9'+-]*", str(raw).lower())[:4]
        text = " ".join(words)
        if words and len(text) <= 60 and text not in searches:
            searches.append(text)
    if not subs or not searches:
        raise llm.ModelError("the plan named no subreddits or no searches")
    return {
        "title": research.clean_text(data.get("title"), 70) or question[:70],
        "restated": research.clean_text(data.get("restated"), 400),
        "subreddits": subs[: settings["subs"] + 1],
        "searches": searches[: settings["searches"]],
        "aspects": [research.clean_text(a, 200) for a in (data.get("aspects") or [])[:6] if str(a).strip()],
        "cannabisProducts": bool(data.get("cannabis_products")),
    }


# ── Finding threads ───────────────────────────────────────────────────────

POST_FIELDS = research.POST_FIELDS
REDDIT_SEARCH_GAP = 4.0  # seconds between Reddit searches, on top of its 3 s throttle; it rate-limits search hard
GIVE_UP_AFTER = 3  # failures before a search source is left alone for the rest of the run


def word_pattern(word: str) -> str:
    """A search word as a regex. Short words match whole ("high" finds
    "highs", not "highway"); longer ones by their stem ("studying" also finds
    "study", "studied", "studies")."""
    if len(word) <= 4:
        return rf"\b{re.escape(word)}(?:s|es)?\b"
    stem = re.sub(r"(ying|ies|ied|ing|ers|er|es|ed|s|y)$", "", word)
    return rf"\b{re.escape(stem if len(stem) >= 4 else word)}\w*"


def search_patterns(searches: list[str]) -> list[list[re.Pattern[str]]]:
    return [[re.compile(word_pattern(w), re.IGNORECASE) for w in s.split()] for s in searches]


def relevance(post: dict[str, Any], patterns: list[list[re.Pattern[str]]]) -> float:
    """3 for each search whose words are all in the title, 1.5 for each whose
    words are all in the title and text together; at most 9."""
    title = post.get("title") or ""
    text = f"{title}\n{post.get('selftext') or ''}"
    score = 0.0
    for words in patterns:
        if all(w.search(title) for w in words):
            score += 3
        elif all(w.search(text) for w in words):
            score += 1.5
    return min(score, 9.0)


def archive_search(sub: str, words: str, after: int, cache_dir: Path, cancel: threading.Event | None) -> list[dict[str, Any]]:
    """The archive's full-text search of post titles and text. Raises
    SourceError when it is overloaded, which is often."""
    cache = cache_dir / "question-search" / f"arctic-{sub.lower()}-{research.slug(words)}-{after // 86400}.json"
    cached = research.read_cache(cache, research.THREAD_CACHE_AGE)
    if isinstance(cached, list):
        return cached
    query = urllib.parse.urlencode({"subreddit": sub, "query": words, "after": after, "limit": 100,
                                    "fields": POST_FIELDS})
    answer = research.fetch_json(f"{research.ARCTIC}/posts/search?{query}", cancel=cancel, timeout=60)
    if not isinstance(answer, dict) or answer.get("data") is None:
        raise SourceError(str((answer or {}).get("error") or "no data"))
    rows = [{k: p.get(k) for k in POST_FIELDS.split(",")} for p in answer["data"] if isinstance(p, dict) and p.get("id")]
    research.write_json(cache, rows)
    return rows


def reddit_search(sub: str, words: str, cache_dir: Path, cancel: threading.Event | None) -> list[dict[str, Any]]:
    """Reddit's own search inside one subreddit, from its public Atom feed:
    relevance-sorted, all time, no scores. Reddit rate-limits it hard."""
    cache = cache_dir / "question-search" / f"reddit-{sub.lower()}-{research.slug(words)}.json"
    cached = research.read_cache(cache, research.THREAD_CACHE_AGE)
    if isinstance(cached, list):
        return cached
    query = urllib.parse.urlencode({"q": words, "restrict_sr": 1, "sort": "relevance", "t": "all", "limit": 100})
    # Reddit answers 429 to most unauthenticated searches, but lets about
    # one a minute through: fetch backs off and tries again (5, 15, 45 s).
    # The run's time budget (prepare) decides how long that's worth it.
    research.sleep(REDDIT_SEARCH_GAP, cancel)
    body = research.fetch(f"{research.REDDIT}/r/{sub}/search.rss?{query}", cancel=cancel,
                          accept="application/atom+xml", agent=research.BROWSER_AGENT)
    rows = [{"id": e["id"][3:], "title": e["title"], "selftext": e["content"], "score": None, "num_comments": None,
             "created_utc": e["created"], "link_flair_text": None, "subreddit": sub, "author": e["author"]}
            for e in research.parse_atom(body) if e["id"].startswith("t3_")]
    research.write_json(cache, rows)
    return rows


def recent_posts(sub: str, after: int, pages: int, cache_dir: Path, cancel: threading.Event | None,
                 log: Callable[[str], None]) -> list[dict[str, Any]]:
    """The newest posts in `sub`, newest first, back to `after` or `pages`
    pages of 100, whichever comes first. A plain listing, which the archive
    serves even when its search is overloaded."""
    cache = cache_dir / "question-search" / f"recent-{sub.lower()}-{pages}-{after // 86400}.json"
    cached = research.read_cache(cache, 12 * 3600)
    if isinstance(cached, list):
        return cached
    posts: dict[str, dict[str, Any]] = {}
    before = 0
    for _ in range(pages):
        params = {"subreddit": sub, "after": after, "limit": 100, "sort": "desc", "fields": POST_FIELDS}
        if before:
            params["before"] = before
        batch = research.fetch_json(f"{research.ARCTIC}/posts/search?{urllib.parse.urlencode(params)}", cancel=cancel,
                                    retry_on=(*research.RETRY_STATUS, 422)).get("data") or []
        for post in batch:
            if isinstance(post, dict) and post.get("id"):
                posts[post["id"]] = {k: post.get(k) for k in POST_FIELDS.split(",")}
        if len(batch) < 100:
            break
        oldest = int(batch[-1].get("created_utc") or 0)
        before = oldest if not before or oldest < before else before - 1
    if posts:
        last = min(int(p.get("created_utc") or 0) for p in posts.values())
        log(f"r/{sub}: {len(posts)} newest posts read, back to {datetime.fromtimestamp(last, timezone.utc):%Y-%m-%d}")
    rows = list(posts.values())
    research.write_json(cache, rows)
    return rows


def comment_search(sub: str, words: str, after: int, cache_dir: Path,
                   cancel: threading.Event | None) -> list[dict[str, Any]]:
    """Comments in `sub` containing every word, anywhere (deep only)."""
    cache = cache_dir / "question-search" / f"comments-{sub.lower()}-{research.slug(words)}-{after // 86400}.json"
    cached = research.read_cache(cache, research.THREAD_CACHE_AGE)
    if isinstance(cached, list):
        return cached
    fields = research.COMMENT_FIELDS + ",link_id"
    query = urllib.parse.urlencode({"subreddit": sub, "body": words, "after": after, "limit": 100, "fields": fields})
    answer = research.fetch_json(f"{research.ARCTIC}/comments/search?{query}", cancel=cancel, timeout=60)
    if not isinstance(answer, dict) or answer.get("data") is None:
        raise SourceError(str((answer or {}).get("error") or "no data"))
    rows = [{k: c.get(k) for k in fields.split(",")} for c in answer["data"] if isinstance(c, dict) and c.get("body")]
    research.write_json(cache, rows)
    return rows


# ── The evidence ──────────────────────────────────────────────────────────


def build_head(state: dict[str, Any], rows: int | None = None) -> str:
    """What every prompt starts with: the question, what to cover, where the
    threads come from, and OCS products when the question is about them."""
    plan = state["plan"]
    lines = ["# The question", state["question"], ""]
    if plan.get("restated"):
        lines += [f"Precisely: {plan['restated']}", ""]
    if plan.get("aspects"):
        lines += ["## A complete answer covers"] + [f"- {a}" for a in plan["aspects"]] + [""]
    lines += ["## Where the threads come from",
              "Subreddits: " + ", ".join(f"r/{s['name']}" for s in plan["subreddits"]),
              "Searches: " + ", ".join(f"“{s}”" for s in plan["searches"]), ""]
    listed = state["topicRows"] if rows is None else state["topicRows"][:rows]
    if listed:
        lines += [f"## OCS catalog: products of the brands these threads name ({len(listed)})",
                  "ref | brand | product | type | price / size"]
        for row in listed:
            price = f"${row['price']:.2f} / {row['size']}" if row.get("price") is not None else "?"
            lines.append(f"{row['handle']} | {row['brand']} | {row['title']} | {row.get('subcategory') or row.get('category') or ''} | {price}")
        lines.append("")
    return "\n".join(lines) + "\n"


def prepare(state: dict[str, Any], *, provider: str, model: str, effort: str, out_dir: Path,
            report: Callable[..., None], logger: Callable[[str], Callable[[str], None]],
            cancel: threading.Event | None, spend: Callable[[dict[str, Any]], None], lock: threading.Lock) -> None:
    """Stages 1–4 for a question: plan, search, read threads, cut the evidence.
    Called by research.write with the checkpoint saved, so a limit or a stop
    here pauses the run like any other."""
    settings = DEPTHS.get(state["depth"]) or DEPTHS["quick"]
    cache_dir = out_dir / "cache"
    who = llm.LABELS.get(provider, provider)
    started = time.time()

    # 1. plan
    if not state.get("plan"):
        report("plan", f"{who} is planning where to look")
        result = research.ask_checked(
            provider, prompt=PLAN_PROMPT.format(question=state["question"], subs=f"{settings['subs'] - 1}–{settings['subs']}",
                                                searches=f"{settings['searches'] - 1}–{settings['searches']}"),
            schema=PLAN_SCHEMA, model=model, effort=effort, cancel=cancel, log=logger("plan"), timeout=600,
            label=f"{who} (plan)", spend=spend, lock=lock, system=PLAN_SYSTEM,
            empty=lambda data: not data.get("subreddits") or not data.get("searches"))
        state["plan"] = clean_plan(result["data"], state["question"], settings)
        state["topic"]["label"] = state["plan"]["title"]
    plan = state["plan"]
    report("plan", "Looking in " + ", ".join(f"r/{s['name']}" for s in plan["subreddits"])
           + " for " + ", ".join(f"“{s}”" for s in plan["searches"]))

    # 2. search
    after = int(state["started"] - settings["days"] * 86400)
    patterns = search_patterns(plan["searches"])
    found: dict[str, dict[str, Any]] = {}
    sources: set[str] = set()
    failures = {"archive": 0, "reddit": 0}
    subs = [s["name"] for s in plan["subreddits"]]
    total = len(subs) * (len(plan["searches"]) + 1)
    done = 0
    log = logger("search")

    def keep(post: dict[str, Any], searched: bool) -> None:
        if not post.get("id"):
            return
        rel = relevance(post, patterns)
        if rel == 0 and not searched:
            return
        old = found.get(post["id"])
        # Scores and comment counts come from the archive; a Reddit feed has none.
        merged = {**(old or {}), **{k: v for k, v in post.items() if v is not None}}
        # A search engine picked it: worth more than a word match alone, and
        # Reddit's feed has no comment counts to rank it by later.
        merged["_rel"] = max(rel + (2.0 if searched else 0.0), (old or {}).get("_rel", 0.0))
        found[post["id"]] = merged

    # Most important search first, across every subreddit, so a search
    # source that gives out part way has covered what matters most.
    reddit_spent = 0.0
    for words in plan["searches"]:
        for sub in subs:
            report("search", f"Searching r/{sub} for “{words}”", searches_done=done, searches_total=total)
            done += 1
            rows: list[dict[str, Any]] = []
            if failures["archive"] < GIVE_UP_AFTER:
                try:
                    rows = archive_search(sub, words, after, cache_dir, cancel)
                    sources.add("arctic-search")
                except SourceError as error:
                    failures["archive"] += 1
                    log(f"The archive's search didn't answer ({error})"
                        + ("; not asking it again this run" if failures["archive"] == GIVE_UP_AFTER else ""))
            if not rows and failures["reddit"] < GIVE_UP_AFTER and reddit_spent < settings["reddit_budget"]:
                asked = time.monotonic()
                try:
                    rows = reddit_search(sub, words, cache_dir, cancel)
                    sources.add("reddit-search")
                except SourceError as error:
                    failures["reddit"] += 1
                    log(f"Reddit's search didn't answer ({error})"
                        + ("; not asking it again this run" if failures["reddit"] == GIVE_UP_AFTER else ""))
                reddit_spent += time.monotonic() - asked
                if reddit_spent >= settings["reddit_budget"]:
                    log(f"Spent {round(reddit_spent / 60)} min waiting on Reddit's search; the rest comes from "
                        f"each subreddit's newest posts")
            for post in rows:
                keep({**post, "subreddit": post.get("subreddit") or sub}, searched=True)
    for sub in subs:
        report("search", f"Reading the newest posts in r/{sub}", searches_done=done, searches_total=total)
        done += 1
        try:
            for post in recent_posts(sub, after, settings["pages"], cache_dir, cancel, log):
                keep(post, searched=False)
            sources.add("arctic")
        except SourceError as error:
            log(f"r/{sub} couldn't be read ({error}); it may not exist")
    ranked = []
    for post in found.values():
        engagement = (math.log1p(max(int(post.get("num_comments") or 0), 0))
                      + 0.5 * math.log1p(max(int(post.get("score") or 0), 0)))
        ranked.append({**post, "_rank": post["_rel"] * (1 + engagement)})
    ranked.sort(key=lambda p: p["_rank"], reverse=True)
    report("search", f"{len(ranked)} threads look relevant", posts_relevant=len(ranked), posts_scanned=len(ranked))
    if not ranked:
        raise SourceError("no threads matched the plan's searches; try wording the question differently")

    # 3. threads
    chosen = ranked[: settings["threads"]]
    comments: dict[str, list[dict[str, Any]]] = {}
    for index, post in enumerate(chosen, 1):
        comments[post["id"]] = research.thread_comments(post, cache_dir, cancel, logger("threads"))
        if index % 5 == 0 or index == len(chosen):
            report("threads", f"Fetched {index} of {len(chosen)} threads", threads_fetched=index, threads_total=len(chosen),
                   comments_fetched=sum(len(v) for v in comments.values()))

    elsewhere: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    if settings.get("comment_search") and failures["archive"] < GIVE_UP_AFTER:
        chosen_ids = {p["id"] for p in chosen}
        grouped: dict[str, list[dict[str, Any]]] = {}
        seen: set[str] = set()
        for words in plan["searches"][: settings["comment_search"]]:
            for sub in subs:
                report("threads", f"Searching comments in r/{sub} for “{words}”")
                try:
                    rows = comment_search(sub, words, after, cache_dir, cancel)
                except SourceError as error:
                    log(f"Comment search in r/{sub} failed ({error}); skipped")
                    continue
                for c in rows:
                    tid = str(c.get("link_id") or "").removeprefix("t3_")
                    if tid and tid not in chosen_ids and c.get("id") not in seen and research.usable(c):
                        seen.add(c["id"])
                        grouped.setdefault(tid, []).append({**c, "subreddit": sub})
        for tid, rows in grouped.items():
            elsewhere.append(({"id": tid, "title": "(a thread found through a comment search)", "selftext": "",
                               "created_utc": min(int(c.get("created_utc") or 0) for c in rows),
                               "subreddit": rows[0]["subreddit"], "score": None, "num_comments": None}, rows))
        report("threads", f"Comment search found {len(seen)} more comments in {len(grouped)} other threads",
               brand_search_comments=len(seen))

    # 4. parse
    report("parse", "Cutting the evidence to size")
    all_comments = {**comments, **{post["id"]: rows for post, rows in elsewhere}}
    corpus = {c["id"]: c.get("body") or "" for rows in all_comments.values() for c in rows if c.get("id")}
    extra = [post for post, _ in elsewhere]
    if plan.get("cannabisProducts"):
        state["topicRows"] = ocs_rows(corpus, chosen, cache_dir, cancel, logger("parse"))
        state["counts"]["ocsTopicProducts"] = len(state["topicRows"])
    state["head"] = build_head(state)
    state.update(
        subreddits=subs, sources=sorted(sources), after=after, mode=settings["mode"],
        seconds=state.get("seconds", 0) + round(time.time() - started),
        threadMeta={p["id"]: {k: p.get(k) for k in ("title", "subreddit", "score", "num_comments", "created_utc")}
                    for p in chosen + extra},
        chosenTop=[p["id"] for p in chosen[:40]],
        corpus=corpus,
        threadTexts={p["id"]: f"{p.get('title') or ''}\n{p.get('selftext') or ''}" for p in chosen + extra},
    )
    state["counts"].update(postsScanned=len(found), postsRelevant=len(ranked), threadsFetched=len(chosen),
                           commentsFetched=sum(len(v) for v in comments.values()),
                           brandSearchComments=sum(len(rows) for _, rows in elsewhere), brandSearchThreads=len(elsewhere))
    heading = "(from a comment search; only the matching comments) "
    if settings["mode"] == "single":
        batch = research.batch_evidence(chosen, comments, [], settings["chars"] - len(state["head"]),
                                        settings["comment_chars"])
        first = batch[0] if batch else {"text": "", "threads": 0, "comments": 0}
        state["packet"] = (state["head"] + "\n## Threads (most relevant first). Quote only from these. "
                           "t = thread id, c = comment id, ↑ = score\n\n" + first["text"])
        state["single"] = {"threads": first["threads"], "comments": first["comments"]}
        report("parse", f"The model gets {first['threads']} of {len(chosen)} threads ({first['comments']} comments, "
                        f"{len(state['packet']) // 1000}k characters)")
    else:
        state["batches"] = research.batch_evidence(chosen, comments, elsewhere, settings["chars"],
                                                   settings["comment_chars"], elsewhere_heading=heading)
        report("parse", f"All {len(chosen)} threads and {sum(b['comments'] for b in state['batches'])} comments "
                        f"split into {len(state['batches'])} parts", parts=len(state["batches"]))


def ocs_rows(corpus: dict[str, str], threads: list[dict[str, Any]], cache_dir: Path, cancel: threading.Event | None,
             log: Callable[[str], None]) -> list[dict[str, Any]]:
    """OCS products of the brands people name, so the answer can link them.
    Best effort: without the catalog the answer simply has no OCS links."""
    try:
        catalog = research.load_catalog(cache_dir, cancel, log)
    except SourceError as error:
        log(f"The OCS catalog isn't available ({error}); products won't link to OCS")
        return []
    brands = research.build_brands(catalog)
    text = "\n".join(corpus.values()) + "\n".join(f"{t.get('title')} {t.get('selftext')}" for t in threads)
    named = {key for key, brand in brands.items() if key not in research.COMMON_WORDS and brand["regex"].search(text)}
    rows = [row for row in catalog if research.brand_key(row["brand"]) in named]
    rows.sort(key=lambda r: (not r.get("available"), r["brand"].lower(), r["title"].lower()))
    log(f"{len(named)} OCS brands are named in these threads ({len(rows)} products)")
    return rows[:200]


# ── Reading and writing ───────────────────────────────────────────────────

SYSTEM = """You are a careful researcher. You answer a question from what people say on Reddit, and only from that: \
the packet the user gives you holds the threads and comments (and, when relevant, an extract of the Ontario Cannabis \
Store catalog). The question can be about anything. You report what people say and how common each view is, keep \
first-hand experience apart from opinion and hearsay, and say where people disagree or the evidence is thin. You never \
invent facts, numbers, studies, products or quotes. When a question touches health, drugs, law, money or safety, you \
say plainly that these are anecdotes rather than evidence, and you name the risks people raise; you give no medical, \
dosing or legal advice. You write like a plain-spoken, well-read friend: specific, honest, no hype."""

QUOTE = obj({"text": STR, "thread": STR, "comment": STR})
QUOTES = {"type": "array", "items": QUOTE}
STANCE = {"type": "string", "enum": ["supports", "contradicts", "mixed", "context"]}

NOTES_SCHEMA = obj({
    "findings": {"type": "array", "items": obj({
        "claim": STR, "detail": STR, "people": {"type": "number"}, "stance": STANCE, "quotes": QUOTES, "threads": STRS})},
    "factors": {"type": "array", "items": obj({"factor": STR, "detail": STR, "threads": STRS})},
    "disagreements": {"type": "array", "items": obj({"title": STR, "sides": STRS, "threads": STRS})},
    "risks": {"type": "array", "items": obj({"title": STR, "detail": STR, "threads": STRS})},
    "products": {"type": "array", "items": obj({
        "brand": STR, "name": STR, "ref": STR, "kind": STR, "people": {"type": "number"}, "points": STRS,
        "quotes": QUOTES, "threads": STRS})},
    "tips": STRS,
    "questions": STRS,
})

NOTES_PROMPT = """You are reading part {part} of {parts} of the Reddit evidence for this question: "{question}"
Take careful notes as JSON matching the schema. Another pass will combine the notes from every part, so:

- findings: every distinct thing people report or claim that bears on the question, even briefly. `claim` is one \
line; `detail` what exactly people say, with specifics (conditions, amounts, how long, compared with what). `people` \
is roughly how many different commenters here said it. `stance` is whether it supports, contradicts or complicates \
the obvious answer, or is only context. Keep disagreement: "most say X; two say Y". Mark hearsay as hearsay.
- quotes: up to 3 per finding, copied VERBATIM from a comment (or the thread's own text), at most 280 characters. \
You may cut the start or end of a sentence but never change words inside it. `thread` is the t: id, `comment` \
the c: id ("" for the post itself). Quotes that aren't verbatim are deleted automatically.
- factors: what the answer depends on, per people here (the person, amount, timing, type, setting…).
- disagreements: where people here clearly split, each side in a few words.
- risks: dangers, downsides or warnings people raise.
- products: specific products, brands or tools people name in connection with the question, with what they say. \
`ref` is the OCS catalog ref when the catalog is included and you can match it confidently, else "".
- tips: practical advice people give. questions: related questions people ask here.
- Always give the t: ids that support each item. Don't invent anything that isn't in this part.

"""

TIGHT_NOTES = """- Keep it tight: at most 12 findings, 8 products, 2 quotes each.

"""

MERGE_PROMPT = """Below are notes that careful readers took on parts of the Reddit evidence for this question: "{question}"
Merge them into ONE set of notes as JSON matching the schema:
- Combine duplicates (the same finding or product from different parts) into one item; add up `people`; keep every thread id.
- Keep disagreements. Drop only weak, one-off items.
- At most 16 findings, 10 products, 2 quotes each. Quotes must stay exactly as written, with their t: and c: ids.
- Don't add anything that isn't in the notes.

"""

REDUCE_NOTE = """The evidence below is not the raw threads: it is notes another careful reader took on all {threads} threads \
({comments} comments) in {parts} parts. Quotes inside the notes were copied verbatim from comments; reuse them \
exactly as written, with their thread and comment ids. Weigh findings by how many parts and people report them.

"""

ANSWER_SCHEMA = obj({
    "headline": STR,
    "short_answer": STR,
    "confidence": {"type": "string", "enum": ["strong", "moderate", "weak", "none"]},
    "confidence_why": STR,
    "findings": {"type": "array", "items": obj({
        "title": STR, "detail": STR, "how_common": {"type": "string", "enum": ["most", "many", "some", "few"]},
        "people": {"type": "number"}, "stance": STANCE, "quotes": QUOTES, "threads": STRS})},
    "depends_on": {"type": "array", "items": obj({"factor": STR, "detail": STR, "threads": STRS})},
    "disagreements": {"type": "array", "items": obj({"title": STR, "sides": STRS, "threads": STRS})},
    "risks": {"type": "array", "items": obj({"title": STR, "detail": STR, "threads": STRS})},
    "tips": {"type": "array", "items": obj({"title": STR, "body": STR, "threads": STRS})},
    "products": {"type": "array", "items": obj({
        "id": STR, "ref": STR, "brand": STR, "name": STR, "kind": STR,
        "tone": {"type": "string", "enum": ["positive", "negative", "mixed"]}, "summary": STR,
        "quotes": QUOTES, "threads": STRS})},
    "caveats": STRS,
    "faq": {"type": "array", "items": obj({"q": STR, "a": STR})},
    "related": STRS,
})

ANSWER_PROMPT = """Answer this question from the evidence, as JSON matching the schema:

"{question}"

Rules:
- Base every claim on the packet. Say how common each view is; where people disagree or evidence is thin, say so.
- short_answer: 2–4 sentences that actually answer the question, with the most important "it depends".
- headline: one line. confidence: how well the evidence answers it (strong: many consistent first-hand reports; \
none: the threads don't really answer it), and confidence_why in one sentence.
- findings: the {findings} most useful things people report, most common first. `detail` 2–4 sentences with \
specifics. `how_common` among the people who spoke to it (most, many, some, few), `people` roughly how many. \
`stance`: supports, contradicts or complicates (mixed) the short answer, or context. 1–3 quotes each.
- depends_on: 2–6 factors the answer depends on, per the evidence.
- disagreements: 0–5 real splits, each side in a few words.
- risks: dangers, downsides or warnings people raise (empty if none).
- tips: 2–6 practical tips people give.
- products: only if people name specific products, brands or tools in connection with the question (else empty). \
`ref` is the OCS catalog ref (first column of the catalog table) when you can match it confidently, else "". \
`summary` one or two sentences on what people say. `id` a short kebab-case slug.
- caveats: 2–4 things this evidence can't tell (self-selection, anecdotes, missing groups, old threads…).
- faq: 3–6 follow-up questions people ask in these threads, answered from the evidence. related: 3–6 related \
questions worth asking next.
- quotes: copied VERBATIM from a comment (or the thread's own text) in the packet, at most 280 characters; you may \
cut the start or end of a sentence but never change words inside it. `thread` is the t: id, `comment` the c: id \
("" when quoting the post). Quotes that are not verbatim are deleted automatically.
- threads: the t: ids that support each item.
- Canadian spelling.

The packet follows.

"""


def notes_text(index: int, notes: dict[str, Any], compact: bool = False) -> str:
    """One part's notes, compact, for the final pass. "~N people" on the
    lines that carry it lets research.trim_notes keep the most-reported."""
    quotes_cap, threads_cap = (2, 4) if compact else (None, 8)
    lines = [f"## Notes from part {index}"]

    def refs(item: dict[str, Any]) -> str:
        return ", ".join((item.get("threads") or [])[:threads_cap])

    for item in notes.get("findings", []):
        lines.append(f"- FINDING (~{item.get('people')} people, {item.get('stance')}) {item.get('claim')}: "
                     f"{research.clean_text(item.get('detail'), 300) if compact else item.get('detail')} [{refs(item)}]")
        lines += [f"    “{q.get('text')}” [t:{q.get('thread')} c:{q.get('comment')}]" for q in item.get("quotes", [])[:quotes_cap]]
    for item in notes.get("factors", []):
        lines.append(f"- FACTOR {item.get('factor')}: {item.get('detail')} [{refs(item)}]")
    for item in notes.get("disagreements", []):
        lines.append(f"- DISAGREEMENT {item.get('title')}: " + " | ".join(item.get("sides") or []) + f" [{refs(item)}]")
    for item in notes.get("risks", []):
        lines.append(f"- RISK {item.get('title')}: {item.get('detail')} [{refs(item)}]")
    for item in notes.get("products", []):
        lines.append(f"- PRODUCT {item.get('brand')} | {item.get('name')} | ref {item.get('ref') or '-'} | "
                     f"{item.get('kind')} | ~{item.get('people')} people | threads {refs(item)}")
        lines += [f"    · {p}" for p in (item.get("points") or [])[: 3 if compact else None]]
        lines += [f"    “{q.get('text')}” [t:{q.get('thread')} c:{q.get('comment')}]" for q in item.get("quotes", [])[:quotes_cap]]
    if notes.get("tips"):
        lines.append("- TIPS: " + " | ".join(notes["tips"]))
    if notes.get("questions"):
        lines.append("- QUESTIONS: " + " | ".join(notes["questions"]))
    return "\n".join(lines) + "\n"


def notes_empty(data: dict[str, Any]) -> bool:
    return not any(data.get(key) for key in ("findings", "factors", "disagreements", "risks", "products", "tips"))


def document(state: dict[str, Any], answer: dict[str, Any], writer: dict[str, Any], read: dict[str, Any], *,
             seconds: int) -> dict[str, Any]:
    """The saved answer: the same outline as a guide's file, so the list,
    archiving and deleting treat both alike, plus the question and plan."""
    if state["topicRows"]:
        research.attach_catalog(answer, state["topicRows"], state["topicRows"])
    else:
        for n, product in enumerate(answer.get("products", []), 1):
            product["id"] = research.slug(product.get("id") or product.get("name") or f"item-{n}") or f"item-{n}"
            product["ocs"] = None
    used: set[str] = set()
    for value in answer.values():
        for item in value if isinstance(value, list) else []:
            if isinstance(item, dict):
                used |= set(item.get("threads") or [])
                used |= {q.get("thread") for q in item.get("quotes") or [] if q.get("thread")}
    meta, counts = state["threadMeta"], state["counts"]
    return {
        "format": 2,
        "kind": "question",
        "question": state["question"],
        "plan": state["plan"],
        "topic": {"key": "question", "label": state["topic"]["label"], "blurb": state["question"],
                  "query": state["question"]},
        "createdAt": research.now_iso(),
        "depth": state["depth"],
        "window": {"from": datetime.fromtimestamp(state["after"], timezone.utc).strftime("%Y-%m-%d"),
                   "to": datetime.fromtimestamp(state["started"], timezone.utc).strftime("%Y-%m-%d"),
                   "days": state["days"]},
        "subreddits": state["subreddits"],
        "sources": state["sources"],
        "stats": {
            "postsScanned": counts["postsScanned"], "postsRelevant": counts["postsRelevant"],
            "threadsFetched": counts["threadsFetched"], "commentsFetched": counts["commentsFetched"],
            "threadsRead": read["threads"], "commentsRead": read["comments"],
            "brandSearchComments": counts["brandSearchComments"], "brandSearchThreads": counts["brandSearchThreads"],
            "parts": read["parts"], "ocsProducts": counts["ocsProducts"], "ocsTopicProducts": counts["ocsTopicProducts"],
            "seconds": seconds,
        },
        "writer": writer,
        "guide": answer,
        "threads": {
            tid: {
                "title": research.clean_text(meta[tid].get("title"), 200),
                "sub": meta[tid].get("subreddit") or "",
                "score": meta[tid].get("score"),
                "comments": meta[tid].get("num_comments"),
                "date": datetime.fromtimestamp(int(meta[tid].get("created_utc") or 0), timezone.utc).strftime("%Y-%m-%d"),
            }
            for tid in sorted(used | set(state["chosenTop"]))
            if tid in meta
        },
    }


WRITING = research.Writing(
    system=SYSTEM,
    depths=DEPTHS,
    notes_prompt=lambda part, parts, topic, tight: (NOTES_PROMPT.format(part=part, parts=parts, question=topic["query"])
                                                    + (TIGHT_NOTES if tight else "")),
    notes_schema=NOTES_SCHEMA,
    notes_text=notes_text,
    notes_empty=notes_empty,
    merge_prompt=lambda topic: MERGE_PROMPT.format(question=topic["query"]),
    reduce_note=REDUCE_NOTE,
    final_prompt=lambda state, packet: ANSWER_PROMPT.format(question=state["question"],
                                                           findings=FINDINGS.get(state["depth"], "5–9")) + packet,
    final_schema=ANSWER_SCHEMA,
    final_empty=lambda data: not data.get("findings") or not data.get("short_answer"),
    compact_head=lambda state, rows: build_head(state, rows),
    prepare=prepare,
    document=document,
)


# ── Starting one ──────────────────────────────────────────────────────────


def check_question(text: str) -> str:
    question = " ".join(str(text or "").split())
    if len(question) < 8:
        raise ValueError("Type a question, at least a few words.")
    if len(question) > QUESTION_MAX:
        raise ValueError(f"Keep the question under {QUESTION_MAX} characters.")
    return question


def new_state(question: str, depth: str) -> dict[str, Any]:
    """A question run before anything is fetched: `prepare` fills it in."""
    question = check_question(question)
    depth = depth if depth in DEPTHS else "quick"
    started = time.time()
    return {
        "version": 1, "kind": "question",
        "id": f"q-{research.slug(question)[:50].strip('-') or 'question'}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}",
        "question": question, "plan": None, "prepared": False,
        "topic": {"key": "question", "label": question[:80], "blurb": question, "focus": "", "query": question},
        "depth": depth, "mode": DEPTHS[depth]["mode"], "subreddits": [], "sources": [],
        "started": started, "after": int(started - DEPTHS[depth]["days"] * 86400), "days": DEPTHS[depth]["days"],
        "seconds": 0,
        "counts": {"postsScanned": 0, "postsRelevant": 0, "threadsFetched": 0, "commentsFetched": 0,
                   "brandSearchComments": 0, "brandSearchThreads": 0, "ocsProducts": 0, "ocsTopicProducts": 0},
        "analysis": {"months": [], "volume": [], "brands": []},
        "topicRows": [], "threadMeta": {}, "chosenTop": [], "corpus": {}, "threadTexts": {},
        "head": "", "packet": "", "single": {"threads": 0, "comments": 0}, "batches": [], "notes": {}, "skipped": [],
        "usage": {"calls": 0, "input": 0, "output": 0, "cost": 0.0, "costKnown": False},
    }


def run(question: str, *, depth: str = "quick", provider: str = "claude", model: str = "", effort: str = "",
        light_reading: bool = True, out_dir: Path, progress: Callable[..., None] | None = None,
        cancel: threading.Event | None = None) -> Path:
    return research.write(new_state(question, depth), provider=provider, model=model, effort=effort,
                          light_reading=light_reading, out_dir=out_dir, progress=progress, cancel=cancel)
