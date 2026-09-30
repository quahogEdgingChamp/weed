"""Run with: python3 -m unittest discover tests

hibuddy's search is replaced by fixed suggestions, so nothing goes online.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hibuddy  # noqa: E402


def item(brand, name, category, id_char):
    return {"id": id_char * 32, "brand": brand, "name": name, "category1": category}


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

    def find(self, suggestions, name, brand, kind):
        with mock.patch.object(hibuddy, "suggest", return_value=suggestions) as suggest:
            return hibuddy.find(name, brand, kind), suggest

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

    def test_accents_sizes_and_plurals_still_match(self) -> None:
        suggestions = [
            item("BLK MKT", "Blue Pave", "Flower", "7"),
            item("SAUCE ROSIN LABS", "Solventless Live Rosin Cart", "Vapes", "8"),
            item("WEST COAST GAS", "Heavy Hitters", "Flower", "9"),
        ]
        self.assertTrue(self.find(suggestions, "Blue Pavé", "BLK MKT", "flower")[0].endswith("7" * 32))
        self.assertTrue(self.find(suggestions, "Solventless Live Rosin Cart 0.5g", "Sauce Rosin Labs", "cart")[0].endswith("8" * 32))
        self.assertTrue(self.find(suggestions, "Heavy Hitter", "West Coast Gas", "flower")[0].endswith("9" * 32))

    def test_answers_are_cached(self) -> None:
        self.find(ORANGEADE, "Orangeade", "Purple Hills", "cart")
        url, suggest = self.find([], "Orangeade", "Purple Hills", "cart")
        self.assertTrue(url.endswith("3" * 32))
        suggest.assert_not_called()

    def test_search_url_is_the_fallback(self) -> None:
        self.assertEqual(hibuddy.search_url("G Mint", "Tribal"), "https://hibuddy.ca/products/search?q=Tribal+G+Mint")
