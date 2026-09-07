"""Turn an ocs.ca product link into the fields this tracker stores.

ocs.ca runs on Shopify, so every product page has a machine-readable twin at
/products/<handle>.js. The cannabis specifics - potency ranges, dominant
terpenes, plant type, licensed producer - are published as namespaced tags
("thc_content_max--84.000000"), which is what this module unpacks.

The browser cannot do this itself: ocs.ca sends no CORS headers, so the fetch
has to happen here.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

PRODUCT_URL = "https://ocs.ca/products/{handle}.js"
ALLOWED_HOSTS = frozenset({"ocs.ca", "www.ocs.ca"})
HANDLE_IN_PATH = re.compile(r"/products/([^/?#]+)")
SAFE_HANDLE = re.compile(r"[a-z0-9][a-z0-9._-]{0,180}", re.IGNORECASE)
USER_AGENT = "cloudline-weed-chart/1.0 (personal product log)"

TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 4_000_000

# OCS keeps category/subcategory in English even on French product pages, so
# these two tags alone are enough to pick a type. Longest match wins.
TYPE_BY_CATEGORY: dict[tuple[str, str | None], str] = {
    ("vapes", "disposable pens"): "disposable",
    ("vapes", None): "cart",
    ("flower", "seeds"): "other",
    ("flower", None): "flower",
    ("extracts", "oils"): "tincture",
    ("extracts", "capsules"): "other",
    ("extracts", None): "concentrate",
    ("edibles", None): "edible",
    ("accessories", None): "other",
}

# Values OCS uses to say "we don't know", in both site languages.
NON_ANSWERS = (
    "may vary",
    "peuvent varier",
    "sans terpene",
    "sans terpène",
    "no terpene",
    "not applicable",
    "ne s'applique pas",
    "ne s’applique pas",
    "s.o.",
)


class LinkError(Exception):
    """A pasted link could not be turned into a product.

    `status` is the HTTP status the API should answer with.
    """

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def lookup(raw_url: str) -> dict[str, Any]:
    """Resolve an ocs.ca product link into this tracker's fields."""
    handle = handle_from_url(raw_url)
    return to_item(fetch_product(handle), f"https://ocs.ca/products/{handle}")


def handle_from_url(raw_url: str) -> str:
    """Pull the product handle out of any shape of ocs.ca link.

    Collection paths, tracking parameters and ?variant= are all fine; the
    handle is the only part that matters, and it is re-requested from a
    hardcoded host so nothing user-supplied reaches the network as a URL.
    """
    parsed = urllib.parse.urlparse(str(raw_url).strip())

    if parsed.scheme not in ("http", "https"):
        raise LinkError("Paste a full https://ocs.ca/... link.")

    if (parsed.hostname or "").lower() not in ALLOWED_HOSTS:
        raise LinkError("Only ocs.ca product links can be looked up.")

    found = HANDLE_IN_PATH.search(parsed.path)
    if not found:
        raise LinkError("That link is not an ocs.ca product page.")

    handle = urllib.parse.unquote(found.group(1))
    handle = re.sub(r"\.(js|json)$", "", handle)

    if not SAFE_HANDLE.fullmatch(handle):
        raise LinkError("That link is not an ocs.ca product page.")

    return handle


def fetch_product(handle: str) -> dict[str, Any]:
    request = urllib.request.Request(
        PRODUCT_URL.format(handle=handle),
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read(MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise LinkError("OCS has no product at that link.", 404) from error
        raise LinkError(f"OCS answered {error.code}.", 502) from error
    except urllib.error.URLError as error:
        raise LinkError(f"Could not reach ocs.ca: {error.reason}", 502) from error
    except TimeoutError as error:
        raise LinkError("ocs.ca took too long to answer.", 504) from error

    try:
        product = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LinkError("OCS sent something that isn't a product.", 502) from error

    if not isinstance(product, dict) or not product.get("title"):
        raise LinkError("OCS sent something that isn't a product.", 502)

    return product


def to_item(product: dict[str, Any], source_url: str) -> dict[str, Any]:
    """Map a Shopify product onto the fields the tracker knows about."""
    tags = group_tags(product.get("tags") or [])
    variant = pick_variant(product.get("variants") or [])

    category = first(tags, "category")
    subcategory = first(tags, "subcategory")
    thc_min, thc_max = potency_range(tags, "thc")
    cbd_min, cbd_max = potency_range(tags, "cbd")

    return {
        "name": clean(product.get("title")),
        "brand": clean(product.get("vendor")),
        "type": product_type(category, subcategory),
        "category": category,
        "subcategory": subcategory,
        "extraction": first(tags, "subsubcategory") or subcategory,
        "process": meaningful(first(tags, "extraction_process")),
        "strain": first(tags, "plant_type"),
        "genetics": first(tags, "street_name"),
        "producer": first(tags, "licensed_producer"),
        "province": first(tags, "growing_province"),
        "amount": clean(variant.get("title")) if variant else "",
        "sizes": [clean(item.get("title")) for item in product.get("variants") or []],
        "thc": midpoint(thc_min, thc_max),
        "thcMin": thc_min,
        "thcMax": thc_max,
        "cbd": midpoint(cbd_min, cbd_max),
        "cbdMin": cbd_min,
        "cbdMax": cbd_max,
        "potencyThc": first(tags, "potency_thc"),
        "terpenes": terpene_list(tags),
        "price": to_dollars(variant.get("price") if variant else product.get("price")),
        "currency": "CAD",
        "available": bool(variant.get("available")) if variant else bool(product.get("available")),
        "sku": clean(first(tags, "sku")).strip("_"),
        "image": thumbnail(product.get("featured_image")),
        "description": summarize(product.get("description")),
        "url": source_url,
    }


def group_tags(tags: list[Any]) -> dict[str, list[str]]:
    """Collect "key--value" tags by key; a key can repeat (terpenes do)."""
    grouped: dict[str, list[str]] = {}

    for tag in tags:
        key, separator, value = str(tag).partition("--")
        if separator and value:
            grouped.setdefault(key, []).append(value)

    return grouped


def first(tags: dict[str, list[str]], key: str) -> str:
    values = tags.get(key) or []
    return clean(values[0]) if values else ""


def product_type(category: str, subcategory: str) -> str:
    key = category.strip().lower()
    sub = subcategory.strip().lower()
    return TYPE_BY_CATEGORY.get((key, sub)) or TYPE_BY_CATEGORY.get((key, None)) or "other"


def potency_range(tags: dict[str, list[str]], prefix: str) -> tuple[float | None, float | None]:
    low = to_number(first(tags, f"{prefix}_content_min"))
    high = to_number(first(tags, f"{prefix}_content_max"))

    # Edibles are dosed in mg, so their percentage tags are a flat 0/0 rather
    # than a measurement. Reporting that as "0% THC" would be a lie.
    if not low and not high:
        return None, None

    return low, high


def midpoint(low: float | None, high: float | None) -> float | None:
    present = [value for value in (low, high) if value is not None]
    if not present:
        return None

    return round(sum(present) / len(present), 1)


def terpene_list(tags: dict[str, list[str]]) -> list[str]:
    seen: list[str] = []

    for value in tags.get("terpenes") or []:
        name = meaningful(clean(value))
        if name and name not in seen:
            seen.append(name)

    return seen


def pick_variant(variants: list[Any]) -> dict[str, Any]:
    """Prefer something buyable; fall back to the first listed size."""
    usable = [item for item in variants if isinstance(item, dict)]
    if not usable:
        return {}

    for item in usable:
        if item.get("available"):
            return item

    return usable[0]


def thumbnail(image: Any) -> str:
    url = clean(image)
    if not url:
        return ""

    if url.startswith("//"):
        url = f"https:{url}"

    if not url.startswith("https://"):
        return ""

    # Shopify resizes on demand; a card thumbnail does not need the full image.
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}width=320"


def summarize(description: Any) -> str:
    text = re.sub(r"<[^>]+>", " ", str(description or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return (text[:280].rstrip() + "…") if len(text) > 280 else text


def meaningful(value: str) -> str:
    """Drop OCS's placeholder answers so they never look like real data."""
    lowered = value.strip().lower()
    return "" if any(marker in lowered for marker in NON_ANSWERS) else value.strip()


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def to_number(value: str) -> float | None:
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None


def to_dollars(cents: Any) -> float | None:
    try:
        return round(int(cents) / 100, 2)
    except (TypeError, ValueError):
        return None
