/* Run with: node --test tests/ */
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

const entry = (fields) => Core.normalizeEntry({ name: "Thing", updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", ...fields }).value;

test("migrates the bare-array and v1 shapes", () => {
  const bare = Core.migrateDoc([{ id: "a", name: "A", thc: "80" }]);
  assert.equal(bare.valid, true);
  assert.equal(bare.doc.products[0].thc, 80);
  assert.deepEqual(bare.doc.products[0].tags, []);

  const v1 = Core.migrateDoc({ version: 1, products: [{ id: "a", name: "A" }], wishlist: [{ id: "w", name: "W", terpenes: ["Limonene"] }] });
  assert.equal(v1.doc.wishlist[0].priority, "normal");
  assert.equal(v1.report.repaired, true);
});

test("normalizing twice changes nothing (no spurious sync conflicts)", () => {
  const once = Core.migrateDoc({ products: [{ name: "A" }], wishlist: [{ name: "W" }] }).doc;
  const twice = Core.migrateDoc(once);
  assert.equal(Core.stableStringify(twice.doc), Core.stableStringify(once));
  assert.equal(twice.report.repaired, false);
});

test("rejects unrecognised files and skips bad rows without losing good ones", () => {
  assert.equal(Core.migrateDoc("nope").valid, false);
  assert.equal(Core.migrateDoc({ foo: [] }).valid, false);

  const { doc, report } = Core.migrateDoc({
    products: [{ name: "Good", rating: 11, sourceUrl: "javascript:alert(1)" }, { name: "   " }, 42],
  });
  assert.equal(doc.products.length, 1);
  assert.equal(doc.products[0].rating, null);
  assert.equal(doc.products[0].sourceUrl, "");
  assert.equal(report.errors.length, 2);
  assert.ok(report.warnings.some((warning) => /Rating/.test(warning.message)));
});

test("drops unsafe image and link schemes on shopping items", () => {
  const { value } = Core.normalizeWishItem({ name: "X", image: "http://x/y.png", url: "data:text/html,hi" });
  assert.equal(value.image, "");
  assert.equal(value.url, "");
});

test("edibles default to milligrams and allow values over 100", () => {
  const edible = entry({ type: "edible", thc: 250 });
  assert.equal(edible.potencyUnit, "mg");
  assert.equal(edible.thc, 250);
  assert.equal(entry({ type: "flower", thc: 250 }).thc, null);
});

test("duplicate ids inside one file are made unique", () => {
  const { doc } = Core.migrateDoc({ products: [{ id: "x", name: "A" }, { id: "x", name: "B" }] });
  assert.notEqual(doc.products[0].id, doc.products[1].id);
});

test("merge keeps edits from both sides", () => {
  const base = { ...Core.emptyDoc(), products: [entry({ id: "a", name: "A" }), entry({ id: "b", name: "B" })] };
  const local = { ...base, products: [entry({ id: "a", name: "A local", updatedAt: "2026-02-01T00:00:00.000Z" }), base.products[1]] };
  const remote = { ...base, products: [base.products[0], entry({ id: "b", name: "B remote", updatedAt: "2026-02-01T00:00:00.000Z" }), entry({ id: "c", name: "C" })] };

  const { doc, conflicts } = Core.mergeDocs(base, local, remote);
  assert.equal(conflicts, 0);
  assert.deepEqual(doc.products.map((item) => item.name).sort(), ["A local", "B remote", "C"]);
});

test("merge: a deletion on one side wins over an untouched record", () => {
  const base = { ...Core.emptyDoc(), products: [entry({ id: "a" }), entry({ id: "b" })] };
  const local = { ...base, products: [base.products[0]] };
  const { doc } = Core.mergeDocs(base, local, base);
  assert.deepEqual(doc.products.map((item) => item.id), ["a"]);
});

test("merge: an edit survives a deletion elsewhere, and is counted", () => {
  const base = { ...Core.emptyDoc(), products: [entry({ id: "a", name: "A" })] };
  const local = { ...base, products: [] };
  const remote = { ...base, products: [entry({ id: "a", name: "A edited", updatedAt: "2026-03-01T00:00:00.000Z" })] };
  const { doc, conflicts } = Core.mergeDocs(base, local, remote);
  assert.equal(conflicts, 1);
  assert.equal(doc.products[0].name, "A edited");
});

test("merge: both edited the same record, newer updatedAt wins", () => {
  const base = { ...Core.emptyDoc(), products: [entry({ id: "a", name: "A" })] };
  const local = { ...base, products: [entry({ id: "a", name: "old", updatedAt: "2026-02-01T00:00:00.000Z" })] };
  const remote = { ...base, products: [entry({ id: "a", name: "new", updatedAt: "2026-03-01T00:00:00.000Z" })] };
  const { doc, conflicts } = Core.mergeDocs(base, local, remote);
  assert.equal(conflicts, 1);
  assert.equal(doc.products[0].name, "new");
});

test("merge: a restored record doesn't also stay in the trash", () => {
  const item = entry({ id: "a" });
  const tomb = { id: "a", kind: "product", item, deletedAt: "2026-01-02T00:00:00.000Z", position: 0 };
  const base = { ...Core.emptyDoc(), trash: [tomb] };
  const local = { ...Core.emptyDoc(), products: [item] };
  const { doc } = Core.mergeDocs(base, local, base);
  assert.equal(doc.products.length, 1);
  assert.equal(doc.trash.length, 0);
});

test("parses quantities and prices per gram", () => {
  assert.deepEqual(Core.parseQuantity("3.5g"), { value: 3.5, unit: "g" });
  assert.deepEqual(Core.parseQuantity("28 grams"), { value: 28, unit: "g" });
  assert.deepEqual(Core.parseQuantity("2 x 0.5g"), { value: 1, unit: "g" });
  assert.deepEqual(Core.parseQuantity("10-pack"), { value: 10, unit: "unit" });
  assert.equal(Core.parseQuantity("some"), null);
  assert.equal(Core.unitPrice(entry({ amount: "3.5g", price: 35 })).value, 10);
  assert.equal(Core.unitPrice(entry({ amount: "3.5g", price: null })), null);
});

test("product links compare by handle", () => {
  assert.equal(
    Core.productLinkKey("https://www.ocs.ca/products/blue-dream-pr?variant=123"),
    Core.productLinkKey("https://ocs.ca/collections/flower/products/Blue-Dream-PR")
  );
});

test("purchase history links via productKey or store link, never name alone", () => {
  const first = entry({ id: "1", name: "Same", sourceUrl: "https://ocs.ca/products/x" });
  const again = entry({ id: "2", name: "Same", productKey: "1" });
  const byLink = entry({ id: "3", name: "Other", sourceUrl: "https://ocs.ca/products/x?variant=9" });
  const sameName = entry({ id: "4", name: "Same" });
  const ids = Core.relatedPurchases([first, again, byLink, sameName], first).map((item) => item.id).sort();
  assert.deepEqual(ids, ["1", "2", "3"]);
});

test("filters and sorting put missing values last", () => {
  const list = [entry({ id: "a", rating: null }), entry({ id: "b", rating: 9 }), entry({ id: "c", rating: 5 })];
  assert.deepEqual(Core.sortEntries(list, "rating-desc").map((item) => item.id), ["b", "c", "a"]);
  const filters = { ...Core.defaultFilters(), minRating: 6 };
  assert.deepEqual(list.filter((item) => Core.matchesFilters(item, filters, "")).map((item) => item.id), ["b"]);
  const tagged = entry({ tags: ["Weekend", "citrus"] });
  assert.ok(Core.matchesFilters(tagged, { ...Core.defaultFilters(), tags: ["weekend"] }, ""));
  assert.ok(!Core.matchesFilters(tagged, { ...Core.defaultFilters(), tags: ["weekend", "harsh"] }, ""));
});

test("matching explains itself and needs real evidence", () => {
  const liked = entry({ id: "l", name: "Loved", rating: 9, terpenes: "Limonene, Myrcene", type: "flower" });
  const match = Core.matchScore({ name: "New", terpenes: ["limonene", "myrcene"], type: "flower" }, [liked]);
  assert.ok(match.score >= 3);
  assert.equal(match.basis.id, "l");
  assert.ok(match.reasons[0].includes("limonene"));
  assert.equal(Core.matchScore({ name: "New", type: "flower" }, [liked]).score, 0);
});

test("monthly spend reports what it left out", () => {
  const now = new Date(2026, 8, 15);
  const list = [
    entry({ purchaseDate: "2026-09-02", price: 40 }),
    entry({ purchaseDate: "2026-08-10", price: 25 }),
    entry({ purchaseDate: "", price: 10 }),
    entry({ purchaseDate: "2026-09-03", price: null }),
  ];
  const { buckets, undated, unpriced } = Core.monthlySpend(list, 12, now);
  assert.equal(buckets.at(-1).total, 40);
  assert.equal(buckets.at(-2).total, 25);
  assert.equal(undated, 1);
  assert.equal(unpriced, 1);
  assert.equal(Core.spendInMonth(list, now), 40);
});

test("trash keeps 30 days", () => {
  const now = Date.parse("2026-09-30T00:00:00Z");
  const kept = Core.purgeTrash(
    [
      { id: "a", deletedAt: "2026-09-20T00:00:00Z" },
      { id: "b", deletedAt: "2026-08-01T00:00:00Z" },
    ],
    now
  );
  assert.deepEqual(kept.map((item) => item.id), ["a"]);
});
