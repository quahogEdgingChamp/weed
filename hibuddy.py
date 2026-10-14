"""Find a product's own page on hibuddy.ca, the price comparison site, and
read what the stores near you charge for it.

hibuddy addresses products by an opaque id (/product/<32 hex>), so the link
cannot be built from a name. Its search page (/products/search?q=...) carries
every hit as {id, name, brand, category1}; this module asks it and picks the
hit that is really this product. The product page lists each nearby store's
price for every size, and store_prices turns that into the cheapest and
dearest store per size.

Both are ordinary pages, read the way a browser gets them. hibuddy's
robots.txt keeps automated clients out of /api/ (its search box's own
endpoint), and a client that asks too often gets "Product temporarily
unavailable" pages and empty searches for a while. So every request here
waits its turn (REQUEST_GAP), a page that can't be read raises Unavailable
rather than passing for "no such product", and once hibuddy has turned this
client away nothing asks again for REST_SECONDS.

The browser cannot do this itself: hibuddy sends no CORS headers.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator

PRODUCT_URL = "https://hibuddy.ca/product/{id}"
PRODUCT_PAGE = re.compile(r"https://hibuddy\.ca/product/([a-f0-9]{32})")
SEARCH_URL = "https://hibuddy.ca/products/search?{query}"
SAFE_ID = re.compile(r"[a-f0-9]{32}")
# A browser-like agent is what hibuddy's own pages see, so it is the least
# likely to be turned away.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) cloudline-weed-chart/1.0"

TIMEOUT_SECONDS = 10
MAX_PAGE_BYTES = 4_000_000
CACHE_SECONDS = 24 * 3600
# Seconds between two requests to hibuddy from this process. Faster than
# about two a second for a few minutes and hibuddy stops answering.
REQUEST_GAP = 2.5
# Once it has stopped answering, nothing here asks again for this long,
# whoever asks: a research run, a refresh, a click on a price link.
REST_SECONDS = 15 * 60
# The search page's hits come best first; past the first few dozen they are
# fuzzy matches of single words.
MAX_HITS = 60

# hibuddy's category1 for each of this tracker's types, plus the finer kinds a
# research guide knows from OCS (preroll, capsule). A hit from any other
# category is never the product: a cart is not the same strain's pre-roll.
CATEGORY_BY_TYPE = {
    "cart": {"vapes"},
    "disposable": {"vapes"},
    "concentrate": {"extracts"},
    "flower": {"flower", "pre-rolls"},
    "preroll": {"pre-rolls"},
    "edible": {"edibles"},
    # hibuddy files capsules, soft gels and drops under Extracts.
    "capsule": {"extracts", "edibles"},
    "tincture": {"extracts", "oils"},
    "topical": {"topicals"},
}

# Words that say what kind of thing it is rather than which product it is.
FILLER = frozenset("the a of and by with 510 thread cartridge cart vape pen live resin rosin g ml".split())
# ...except that between two of a brand's carts of one strain, these words are
# the difference: "Live Resin 510" and plain "510 Thread Cartridge" (distillate).
PROCESS_WORDS = frozenset({"live", "resin", "rosin", "hash", "solventless", "distillate", "diamonds"})
DISPOSABLE_WORDS = frozenset({"aio", "disposable"})
# A size says which pack, not which product, and hibuddy often leaves it out.
SIZE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:g|mg|ml)\b")

_cache: dict[tuple[str, str, str], tuple[float, str]] = {}
_prices_cache: dict[tuple[str, float, float], tuple[float, list[dict[str, Any]]]] = {}
_cache_lock = threading.Lock()
_turn_lock = threading.Lock()
_last_request = 0.0
_resting_until = 0.0


class Unavailable(Exception):
    """hibuddy did not answer, or answered with a page this module can't read."""


def turned_away(why: str) -> Unavailable:
    """hibuddy sent a page without its data: the "temporarily unavailable"
    page it shows a client that asks too often. Rest before asking again."""
    global _resting_until
    _resting_until = time.monotonic() + REST_SECONDS
    return Unavailable(why)


# ── Reading pages ──────────────────────────────────────────────────────────
#
# hibuddy's pages are Next.js: the data behind them is streamed as
# self.__next_f.push([1, "<json text>"]) scripts, which joined and unescaped
# hold plain JSON objects: the search hits, each store's offer.

FLIGHT_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')


def fetch_page(url: str) -> str:
    """The page at `url`, after waiting for this process's turn."""
    global _last_request
    if time.monotonic() < _resting_until:
        raise Unavailable("hibuddy turned us away a few minutes ago; not asking again yet")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with _turn_lock:
        time.sleep(max(0.0, _last_request + REQUEST_GAP - time.monotonic()))
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return response.read(MAX_PAGE_BYTES).decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise Unavailable(f"hibuddy did not answer ({error})") from error
        finally:
            _last_request = time.monotonic()


def page_data(page: str) -> str:
    """The page's streamed data, unescaped and joined. A chunk that is not
    plain JSON text is skipped rather than losing the whole page."""
    parts = []
    for chunk in FLIGHT_CHUNK.findall(page):
        try:
            parts.append(json.loads(f'"{chunk}"'))
        except ValueError:
            continue
    return "".join(parts)


def objects_at(data: str, start: str) -> Iterator[dict[str, Any]]:
    """Each JSON object in `data` whose text begins with `start`."""
    decoder = json.JSONDecoder()
    at = data.find(start)
    while at != -1:
        try:
            item, end = decoder.raw_decode(data, at)
        except ValueError:
            item, end = None, at + len(start)
        if isinstance(item, dict):
            yield item
        at = data.find(start, end)


# ── Finding the product ────────────────────────────────────────────────────

HITS = re.compile(r'"meiliHits"\s*:\s*')


def words(text: str) -> list[str]:
    # "Pavé" and hibuddy's "Pave" are the same word; "3.5g" keeps its decimal,
    # but Glenn's "No.23" is hibuddy's "No. 23".
    plain = unicodedata.normalize("NFKD", (text or "").lower()).encode("ascii", "ignore").decode()
    return re.findall(r"[a-z]+(?=\.\d)|[a-z0-9]+(?:\.[0-9]+)?", plain)


def same_word(ours: str, theirs: set[str]) -> bool:
    """`ours` is in `theirs`, allowing a plural either way ("Hitter", "Hitters",
    "Gummy", "Gummies")."""
    if ours in theirs or f"{ours}s" in theirs or (ours.endswith("s") and ours[:-1] in theirs):
        return True
    if ours.endswith("y"):
        return f"{ours[:-1]}ies" in theirs
    return ours.endswith("ies") and f"{ours[:-3]}y" in theirs


def search_url(name: str, brand: str = "") -> str:
    return SEARCH_URL.format(query=urllib.parse.urlencode({"q": " ".join(filter(None, [brand, name]))}))


def search(query: str) -> list[dict[str, Any]]:
    """hibuddy's hits for `query`, best first: [{id, name, brand, category1}]."""
    data = page_data(fetch_page(search_url(query)))
    found = HITS.search(data)
    if not found:  # even a search that finds nothing has "meiliHits":[]
        raise turned_away("hibuddy's search page came back without its results")
    try:
        hits, _ = json.JSONDecoder().raw_decode(data, found.end())
    except ValueError as error:
        raise Unavailable("hibuddy's search results could not be read") from error
    if not isinstance(hits, list):
        raise Unavailable("hibuddy's search results could not be read")
    return [h for h in hits if isinstance(h, dict) and SAFE_ID.fullmatch(str(h.get("id", "")))][:MAX_HITS]


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
    category = str(item.get("category1", "")).lower()
    if categories and category:
        if category not in categories:
            return 0
        result += 0.5
    # A cart and the same strain's all-in-one pen are different products.
    if kind in ("cart", "disposable") and category == "vapes":
        disposable = bool(theirs & DISPOSABLE_WORDS)
        if disposable != (kind == "disposable"):
            result -= 1
    # Among several fits, the one with the fewest words of its own is closest
    # ("Orangeade Live Resin 510" over "95+ Liquid Diamonds Orangeade 510").
    result -= 0.1 * len(theirs - set(all_ours) - FILLER)
    result += sum(0.1 if w in PROCESS_WORDS else 0.02 for w in theirs & set(all_ours) & FILLER)
    return max(result, 0)


def lookup(name: str, brand: str = "", kind: str = "") -> str | None:
    """The hibuddy product page for this product, or None if none fits.
    Raises Unavailable when hibuddy can't be asked; that is not cached."""
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
        for item in search(query):
            value = score(item, name, brand, kind)
            if value > best_score:
                best, best_score = item, value
        if best:
            break

    url = PRODUCT_URL.format(id=best["id"]) if best else ""
    with _cache_lock:
        _cache[key] = (time.monotonic(), url)
    return url or None


def find(name: str, brand: str = "", kind: str = "") -> str | None:
    """lookup, but None when hibuddy can't be asked: the link then falls
    back to a hibuddy search."""
    try:
        return lookup(name, brand, kind)
    except Unavailable:
        return None


# ── Store prices ───────────────────────────────────────────────────────────
#
# hibuddy keeps no price history on the product page, so a range is today's
# cheapest and dearest store, not an all-time low and high. The page lists at
# most 200 offers (every size together), nearest store first, whatever radius
# it is asked for: in a dense city they all come from the few km around the
# point. Downtown Toronto is hibuddy's own default; change NEAR to price
# somewhere else.

NEAR = {"name": "Toronto", "lat": 43.6532, "lon": -79.3832}
OFFER_START = '{"storeId":'
# On every product page, even one no store near the point stocks. A page
# without it is the "temporarily unavailable" one, or a layout this can't read.
OFFER_COUNT = '"offerCount":'
PIECES = re.compile(r"(?:(\d+)x)?(\d+(?:\.\d+)?)(?:pack|packs|pcs|pc|pieces|caps|capsules|softgels|count|ct)")
AMOUNT = re.compile(r"(?:(\d+)x)?(\d+(?:\.\d+)?)(g|mg|ml)")


def offers_in(data: str) -> list[dict[str, Any]]:
    """Every store offer in a product page's data: {store, size, price}."""
    offers: list[dict[str, Any]] = []
    seen: set[tuple[str, str, float]] = set()
    for item in objects_at(data, OFFER_START):
        store, size, price = item.get("storeId"), item.get("size"), item.get("price")
        if not (isinstance(store, str) and SAFE_ID.fullmatch(store) and isinstance(size, str) and size.strip()):
            continue
        if isinstance(price, bool) or not isinstance(price, (int, float)) or not 0 < price < 10_000:
            continue
        # hibuddy keeps prices as 32-bit floats: 27.989999771118164.
        offer = (store, size.strip(), round(float(price), 2))
        if offer not in seen:
            seen.add(offer)
            offers.append({"store": offer[0], "size": offer[1], "price": offer[2]})
    return offers


def size_key(label: str) -> str:
    """One spelling per size, to match OCS's against hibuddy's:
    "10x1 Pack", "10 Pcs" -> "10pcs"; "1g", "1 g" -> "1x1g"; "4 x 355 ml" -> "4x355ml"."""
    plain = re.sub(r"\s+", "", (label or "").lower())
    if match := PIECES.fullmatch(plain):
        return f"{int(match[1] or 1) * float(match[2]):g}pcs"
    if match := AMOUNT.fullmatch(plain):
        return f"{int(match[1] or 1)}x{float(match[2]):g}{match[3]}"
    return plain


def size_order(label: str) -> tuple[float, str]:
    """Sort key: "3.5g" before "28g", "2 Pcs" before "10 Pcs"; no number last."""
    numbers = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", label)]
    return (math.prod(numbers) if numbers else math.inf), label.lower()


def price_ranges(offers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """[{size, low, high, stores}]: each size's cheapest and dearest offer and
    how many stores list it, smallest size first."""
    by_size: dict[str, list[dict[str, Any]]] = {}
    for offer in offers:
        by_size.setdefault(offer["size"], []).append(offer)
    rows = [{
        "size": size,
        "low": min(o["price"] for o in group),
        "high": max(o["price"] for o in group),
        "stores": len({o["store"] for o in group}),
    } for size, group in by_size.items()]
    return sorted(rows, key=lambda row: size_order(row["size"]))


def matching_size(ranges: list[dict[str, Any]], size: str) -> str | None:
    """hibuddy's label for `size` (as OCS spells it) among `ranges`, or None
    when no store lists that size."""
    wanted = size_key(size) if size else ""
    return next((row["size"] for row in ranges if wanted and size_key(row["size"]) == wanted), None)


def store_prices(product_url: str, near: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Price ranges per size (price_ranges) at the stores near `near` (default
    NEAR) for a hibuddy product page; [] when none of them lists it. Raises
    Unavailable when the page can't be read."""
    near = near or NEAR
    match = PRODUCT_PAGE.fullmatch(product_url or "")
    if not match:
        raise ValueError(f"not a hibuddy product page: {product_url!r}")
    key = (match.group(1), near["lat"], near["lon"])
    with _cache_lock:
        hit = _prices_cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]

    data = page_data(fetch_page(f"{product_url}?{urllib.parse.urlencode({'lat': near['lat'], 'lon': near['lon']})}"))
    if OFFER_COUNT not in data:
        raise turned_away("hibuddy sent its product page without the store list")
    ranges = price_ranges(offers_in(data))
    with _cache_lock:
        _prices_cache[key] = (time.monotonic(), ranges)
    return ranges
