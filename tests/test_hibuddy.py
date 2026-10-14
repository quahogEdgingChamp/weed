"""Run with: python3 -m unittest discover tests

hibuddy's pages are replaced by fixed ones, so nothing goes online.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hibuddy  # noqa: E402


def item(brand, name, category, id_char):
    return {"id": id_char * 32, "brand": brand, "name": name, "category1": category}


def next_page(data: str, parts: int = 3) -> str:
    """`data` the way hibuddy's pages carry it: cut into Next.js chunks, so
    objects straddle two of them."""
    step = len(data) // parts + 1
    chunks = [data[i:i + step] for i in range(0, len(data), step)]
    scripts = "".join(f"<script>self.__next_f.push([1,{json.dumps(chunk)}])</script>" for chunk in chunks)
    return f"<!DOCTYPE html><html><head><title>hibuddy</title></head><body>{scripts}</body></html>"


def offer(store_char, size, price):
    return {"storeId": store_char * 32, "storeName": f"Store {store_char}", "size": size, "price": price,
            "pricePerGram": 1.0, "lastUpdated": "2026-10-14 10:53:42", "distanceMeters": 437.6}


UNAVAILABLE = "<html><head><title>Product temporarily unavailable | hibuddy</title></head><body>Loading</body></html>"
PAGE_URL = "https://hibuddy.ca/product/" + "f" * 32

ORANGEADE = [
    item("PURPLE HILLS", "Orangeade Live Resin Gummies", "Edibles", "1"),
    item("PURPLE HILLS", "95+ Liquid Diamonds Orangeade 510", "Vapes", "2"),
    item("PURPLE HILLS", "Orangeade Live Resin 510 Thread Cartridge", "Vapes", "3"),
]
G_MINT = [
    item("TRIBAL", "G Mint Supernova Live Resin AIO", "Vapes", "4"),
    item("TRIBAL", "G Mint Live Resin 510 Thread Cartridge", "Vapes", "5"),
    item("TRIBAL", "Gelato Mint", "Flower", "6"),
]


class FindTest(unittest.TestCase):
    def setUp(self) -> None:
        hibuddy._cache.clear()

    def find(self, hits, name, brand, kind):
        with mock.patch.object(hibuddy, "search", return_value=hits) as search:
            return hibuddy.find(name, brand, kind), search

    def test_short_name_picks_the_plain_cart_of_the_right_type(self) -> None:
        url, _ = self.find(ORANGEADE, "Orangeade", "Purple Hills", "cart")
        self.assertEqual(url, "https://hibuddy.ca/product/" + "3" * 32)

    def test_cart_and_all_in_one_pen_are_told_apart(self) -> None:
        self.assertEqual(self.find(G_MINT, "G Mint", "Tribal", "cart")[0], "https://hibuddy.ca/product/" + "5" * 32)
        hibuddy._cache.clear()
        self.assertEqual(self.find(G_MINT, "G Mint", "Tribal", "disposable")[0], "https://hibuddy.ca/product/" + "4" * 32)

    def test_other_brand_or_missing_words_is_no_match(self) -> None:
        self.assertIsNone(self.find(G_MINT, "G Mint", "Purple Hills", "cart")[0])
        hibuddy._cache.clear()
        self.assertIsNone(self.find(G_MINT, "Zorgblat Haze", "Tribal", "cart")[0])

    def test_a_hit_from_another_category_is_never_the_product(self) -> None:
        hits = [item("BLEUH", "Original Balanced Wildberry Haze 0.5g", "Pre-Rolls", "7")]
        self.assertIsNone(self.find(hits, "Balanced Wildberry Haze", "Bleuh", "cart")[0])
        hibuddy._cache.clear()
        self.assertTrue(self.find(hits, "Balanced Wildberry Haze", "Bleuh", "preroll")[0].endswith("7" * 32))
        hibuddy._cache.clear()
        self.assertTrue(self.find(hits, "Balanced Wildberry Haze", "Bleuh", "")[0].endswith("7" * 32))

    def test_live_resin_cart_is_not_the_same_strains_distillate_cart(self) -> None:
        hits = [
            item("JONNY CHRONIC", "Acapulco Gold 510 Thread Cartridge", "Vapes", "8"),
            item("JONNY CHRONIC", "Acapulco Gold Live Resin 510", "Vapes", "9"),
        ]
        live = self.find(hits, "Acapulco Gold Live Resin 510 Thread Cartridge", "Jonny Chronic", "cart")[0]
        self.assertTrue(live.endswith("9" * 32))
        hibuddy._cache.clear()
        plain = self.find(hits, "Acapulco Gold 510 Thread Cartridge", "Jonny Chronic", "cart")[0]
        self.assertTrue(plain.endswith("8" * 32))

    def test_accents_sizes_and_plurals_still_match(self) -> None:
        hits = [
            item("BLK MKT", "Blue Pave", "Flower", "7"),
            item("SAUCE ROSIN LABS", "Solventless Live Rosin Cart", "Vapes", "8"),
            item("WEST COAST GAS", "Heavy Hitters", "Flower", "9"),
            item("HIGHXOTIC", "Tenten Sunny Drift Live Rosin Gummies", "Edibles", "a"),
        ]
        self.assertTrue(self.find(hits, "Blue Pavé", "BLK MKT", "flower")[0].endswith("7" * 32))
        self.assertTrue(self.find(hits, "Solventless Live Rosin Cart 0.5g", "Sauce Rosin Labs", "cart")[0].endswith("8" * 32))
        self.assertTrue(self.find(hits, "Heavy Hitter", "West Coast Gas", "flower")[0].endswith("9" * 32))
        self.assertTrue(self.find(hits, "TenTen Sunny Drift Live Rosin Gummy", "HighXotic", "edible")[0].endswith("a" * 32))
        glenns = [item("GLENN'S", "No. 23 Blue Raspberry Cotton Clouds", "Edibles", "b")]
        self.assertTrue(self.find(glenns, "No.23 True Hybrid Rosin - Blue Raspberry Cotton Clouds", "Glenn's", "edible")[0]
                        .endswith("b" * 32))
        self.assertEqual(hibuddy.words("Pink Kush 3.5g No.23 G13"), ["pink", "kush", "3.5", "g", "no", "23", "g13"])

    def test_answers_are_cached(self) -> None:
        self.find(ORANGEADE, "Orangeade", "Purple Hills", "cart")
        url, search = self.find([], "Orangeade", "Purple Hills", "cart")
        self.assertTrue(url.endswith("3" * 32))
        search.assert_not_called()

    def test_search_url_is_the_fallback(self) -> None:
        self.assertEqual(hibuddy.search_url("G Mint", "Tribal"), "https://hibuddy.ca/products/search?q=Tribal+G+Mint")


class SearchPageTest(unittest.TestCase):
    def setUp(self) -> None:
        hibuddy._cache.clear()
        hibuddy._resting_until = 0.0

    def tearDown(self) -> None:
        hibuddy._resting_until = 0.0

    def test_hits_are_read_from_the_search_page(self) -> None:
        data = json.dumps({"products": [], "totalCount": 3, "meiliHits": [*G_MINT, {"id": "not-an-id", "name": "x"}]})
        with mock.patch.object(hibuddy, "fetch_page", return_value=next_page(data)) as fetch:
            hits = hibuddy.search("Tribal G Mint")
        self.assertEqual([h["id"] for h in hits], [h["id"] for h in G_MINT])
        fetch.assert_called_once_with("https://hibuddy.ca/products/search?q=Tribal+G+Mint")

    def test_a_turned_away_search_is_not_taken_for_no_such_product(self) -> None:
        with mock.patch.object(hibuddy, "fetch_page", return_value=UNAVAILABLE):
            with self.assertRaises(hibuddy.Unavailable):
                hibuddy.lookup("G Mint", "Tribal", "cart")
            self.assertIsNone(hibuddy.find("G Mint", "Tribal", "cart"))
        # Not remembered as "no such product": once hibuddy answers, it is found.
        with mock.patch.object(hibuddy, "fetch_page", return_value=next_page(json.dumps({"meiliHits": G_MINT}))):
            self.assertTrue(hibuddy.lookup("G Mint", "Tribal", "cart").endswith("5" * 32))

    def test_requests_wait_their_turn(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"<html></html>"
        with mock.patch.object(hibuddy.urllib.request, "urlopen", return_value=response), \
                mock.patch.object(hibuddy.time, "sleep") as sleep:
            hibuddy.fetch_page("https://hibuddy.ca/")
            hibuddy.fetch_page("https://hibuddy.ca/")
        self.assertGreater(sleep.call_args_list[-1].args[0], hibuddy.REQUEST_GAP - 1)

    def test_once_turned_away_nothing_asks_again_for_a_while(self) -> None:
        with mock.patch.object(hibuddy.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = UNAVAILABLE.encode()
            with mock.patch.object(hibuddy.time, "sleep"):
                with self.assertRaises(hibuddy.Unavailable):
                    hibuddy.lookup("G Mint", "Tribal", "cart")
                self.assertEqual(urlopen.call_count, 1)
                self.assertIsNone(hibuddy.find("Orangeade", "Purple Hills", "cart"))
                with self.assertRaises(hibuddy.Unavailable):
                    hibuddy.store_prices(PAGE_URL)
                self.assertEqual(urlopen.call_count, 1)  # resting: not asked again
                hibuddy._resting_until = 0.0
                hibuddy.find("Orangeade", "Purple Hills", "cart")
                self.assertEqual(urlopen.call_count, 2)


class StorePricesTest(unittest.TestCase):
    def setUp(self) -> None:
        hibuddy._prices_cache.clear()
        hibuddy._resting_until = 0.0

    def tearDown(self) -> None:
        hibuddy._resting_until = 0.0

    def prices(self, page):
        with mock.patch.object(hibuddy, "fetch_page", return_value=page) as fetch:
            return hibuddy.store_prices(PAGE_URL), fetch

    def test_each_size_gets_its_cheapest_and_dearest_store(self) -> None:
        offers = [
            offer("a", "3.5g", 27.989999771118164), offer("b", "3.5g", 17.610000610351562), offer("c", "3.5g", 41.36),
            offer("a", "3.5g", 27.989999771118164),  # the same offer twice
            offer("a", "28g", 140.5), offer("d", "28g", 103.5),
            offer("e", "3.5g", 0), {"storeId": "nope", "size": "3.5g", "price": 1.0},  # junk
        ]
        data = json.dumps({"offerCount": len(offers), "offers": offers})
        ranges, fetch = self.prices(next_page(data, parts=5))
        self.assertEqual(ranges, [
            {"size": "3.5g", "low": 17.61, "high": 41.36, "stores": 3},
            {"size": "28g", "low": 103.5, "high": 140.5, "stores": 2},
        ])
        self.assertEqual(fetch.call_args.args[0], f"{PAGE_URL}?lat=43.6532&lon=-79.3832")

    def test_no_store_nearby_is_an_empty_list(self) -> None:
        self.assertEqual(self.prices(next_page(json.dumps({"offerCount": 0, "offers": []})))[0], [])

    def test_a_turned_away_page_is_unavailable_and_not_cached(self) -> None:
        with self.assertRaises(hibuddy.Unavailable):
            self.prices(UNAVAILABLE)
        data = json.dumps({"offerCount": 1, "offers": [offer("a", "1g", 39.99)]})
        self.assertEqual(self.prices(next_page(data))[0], [{"size": "1g", "low": 39.99, "high": 39.99, "stores": 1}])

    def test_answers_are_cached(self) -> None:
        self.prices(next_page(json.dumps({"offerCount": 1, "offers": [offer("a", "1g", 39.99)]})))
        ranges, fetch = self.prices(UNAVAILABLE)
        self.assertEqual(ranges[0]["low"], 39.99)
        fetch.assert_not_called()

    def test_sizes_match_however_ocs_and_hibuddy_spell_them(self) -> None:
        for ocs_size, theirs in [("1 Pack", "1 Pcs"), ("10x1 Pack", "10 Pcs"), ("50 caps", "50 Pcs"),
                                 ("3.5g", "3.5 g"), ("4x355ml", "4x355ml"), ("10x0.35g", "10x0.35g")]:
            self.assertEqual(hibuddy.size_key(ocs_size), hibuddy.size_key(theirs), (ocs_size, theirs))
        self.assertNotEqual(hibuddy.size_key("3.5g"), hibuddy.size_key("28g"))
        ranges = [{"size": "3.5g", "stores": 5}, {"size": "28g", "stores": 9}]
        self.assertEqual(hibuddy.matching_size(ranges, "3.5 g"), "3.5g")
        self.assertIsNone(hibuddy.matching_size(ranges, "7g"))
        self.assertIsNone(hibuddy.matching_size(ranges, ""))


if __name__ == "__main__":
    unittest.main()
