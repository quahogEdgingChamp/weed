"""Find a product's own page on hibuddy.ca, the price comparison site.

hibuddy addresses products by an opaque id (/product/<32 hex>), so the link
cannot be built from a name. Its search box asks /api/search-suggest?q=... and
gets back up to eight {id, name, brand, category1}; this module asks the same
question and picks the suggestion that is really this product.

The browser cannot do this itself: hibuddy sends no CORS headers.
"""

from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

SUGGEST_URL = "https://hibuddy.ca/api/search-suggest?{query}"
PRODUCT_URL = "https://hibuddy.ca/product/{id}"
# The search results page moved here; the old /search?q= never answers.
SEARCH_URL = "https://hibuddy.ca/products/search?{query}"
SAFE_ID = re.compile(r"[a-f0-9]{32}")
# hibuddy answers a bare urllib agent, but a browser-like one is what its own
# search box sends, so it is the least likely to be turned away later.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) cloudline-weed-chart/1.0"

TIMEOUT_SECONDS = 8
MAX_RESPONSE_BYTES = 500_000
CACHE_SECONDS = 24 * 3600

# hibuddy's category1 for each of this tracker's types.
CATEGORY_BY_TYPE = {
    "cart": {"vapes"},
    "disposable": {"vapes"},
    "concentrate": {"extracts"},
    "flower": {"flower", "pre-rolls"},
    "edible": {"edibles"},
    "tincture": {"extracts", "oils"},
}

# Words that say what kind of thing it is rather than which product it is.
FILLER = frozenset("the a of and by with 510 thread cartridge cart vape pen live resin rosin g ml".split())
DISPOSABLE_WORDS = frozenset({"aio", "disposable"})
# A size says which pack, not which product, and hibuddy often leaves it out.
SIZE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:g|mg|ml)\b")

_cache: dict[tuple[str, str, str], tuple[float, str]] = {}
_cache_lock = threading.Lock()


def words(text: str) -> list[str]:
    # "Pavé" and hibuddy's "Pave" are the same word.
    plain = unicodedata.normalize("NFKD", (text or "").lower()).encode("ascii", "ignore").decode()
    return re.findall(r"[a-z0-9]+(?:\.[0-9]+)?", plain)


def same_word(ours: str, theirs: set[str]) -> bool:
    """`ours` is in `theirs`, allowing a plural either way ("Hitter", "Hitters")."""
    return ours in theirs or f"{ours}s" in theirs or (ours.endswith("s") and ours[:-1] in theirs)


def search_url(name: str, brand: str = "") -> str:
    return SEARCH_URL.format(query=urllib.parse.urlencode({"q": " ".join(filter(None, [brand, name]))}))


def suggest(query: str) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        SUGGEST_URL.format(query=urllib.parse.urlencode({"q": query})),
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read(MAX_RESPONSE_BYTES)
        found = json.loads(body.decode("utf-8")).get("suggestions")
    except (urllib.error.URLError, TimeoutError, ValueError, AttributeError, OSError):
        return []
    return [s for s in found or [] if isinstance(s, dict) and SAFE_ID.fullmatch(str(s.get("id", "")))]


def score(item: dict[str, Any], name: str, brand: str, kind: str) -> float:
    """How sure we are that `item` is this product; 0 means "not it"."""
    all_ours = words(SIZE.sub(" ", (name or "").lower()))
    ours = [w for w in all_ours if w not in FILLER] or all_ours
    theirs = set(words(item.get("name", "")))
    if not ours:
        return 0
    covered = sum(same_word(w, theirs) for w in ours) / len(ours)
    their_brand = " ".join(words(item.get("brand", "")))
    our_brand = " ".join(words(brand))
    if our_brand and our_brand != their_brand and our_brand not in their_brand and their_brand not in our_brand:
        return 0
    # With a brand to lean on, hibuddy may drop a word ("Pure") from the name.
    if covered < (0.6 if our_brand else 1):
        return 0
    result = 2 * covered + (1 if our_brand else 0)
    categories = CATEGORY_BY_TYPE.get(kind)
    if categories and str(item.get("category1", "")).lower() in categories:
        result += 0.5
    # A cart and the same strain's all-in-one pen are different products.
    if kind in ("cart", "disposable") and str(item.get("category1", "")).lower() == "vapes":
        disposable = bool(theirs & DISPOSABLE_WORDS)
        if disposable != (kind == "disposable"):
            result -= 1
    # Among several fits, the one with the fewest words of its own is closest
    # ("Orangeade Live Resin 510" over "95+ Liquid Diamonds Orangeade 510").
    result -= 0.1 * len(theirs - set(all_ours) - FILLER)
    result += 0.02 * len(theirs & set(all_ours) & FILLER)
    return max(result, 0)


def find(name: str, brand: str = "", kind: str = "") -> str | None:
    """The hibuddy product page for this product, or None if none fits."""
    name, brand = name.strip(), brand.strip()
    if not name:
        return None
    key = (name.lower(), brand.lower(), kind)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1] or None

    best, best_score = None, 0.0
    # The brand narrows the search; the name alone rescues a brand hibuddy
    # spells differently.
    for query in dict.fromkeys(filter(None, [f"{brand} {name}".strip(), name])):
        for item in suggest(query):
            value = score(item, name, brand, kind)
            if value > best_score:
                best, best_score = item, value
        if best:
            break

    url = PRODUCT_URL.format(id=best["id"]) if best else ""
    with _cache_lock:
        _cache[key] = (time.monotonic(), url)
    return url or None
