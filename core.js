/* ---------------------------------------------------------------------------
   Cloudline core - the parts that touch data but not the page.

   Validation, schema migration, the three-way merge that keeps two devices
   from overwriting each other, filtering, sorting and the numbers behind the
   insights. Nothing here reads the DOM, so the same file runs in the browser
   (as window.CloudlineCore) and under `node --test` (as a CommonJS module).
--------------------------------------------------------------------------- */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CloudlineCore = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA_VERSION = 2;

  const TYPE_LABELS = {
    cart: "Cart",
    disposable: "Disposable",
    concentrate: "Concentrate",
    flower: "Flower",
    edible: "Edible",
    tincture: "Tincture",
    other: "Other",
  };

  const STATUS_LABELS = {
    unopened: "Unopened",
    open: "In use",
    finished: "Finished",
  };

  const PRIORITY_LABELS = {
    high: "High",
    normal: "Normal",
    low: "Low",
  };

  const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

  /* Types that are dosed in milligrams rather than by percentage. */
  const MG_TYPES = new Set(["edible", "tincture"]);

  const TRASH_RETENTION_DAYS = 30;
  const TRASH_LIMIT = 300;
  const MAX_ITEMS = 10000;
  const MAX_TAGS = 30;

  /* Longest string each text field may hold. Anything longer is cut, not
     rejected: a long note is not a reason to lose a whole record. */
  const ENTRY_TEXT = {
    name: 200,
    brand: 120,
    strain: 120,
    extraction: 120,
    amount: 60,
    vendor: 120,
    batch: 80,
    terpenes: 500,
    effects: 500,
    notes: 10000,
    remaining: 60,
    productKey: 100,
  };

  const WISH_TEXT = {
    name: 200,
    brand: 120,
    category: 120,
    subcategory: 120,
    extraction: 120,
    process: 120,
    strain: 120,
    genetics: 200,
    producer: 200,
    province: 60,
    amount: 60,
    potencyThc: 60,
    currency: 8,
    sku: 80,
    description: 1000,
    shoppingNote: 2000,
    preferredVendor: 120,
  };

  const EXPERIENCE_TEXT = {
    amount: 60,
    flavor: 300,
    notes: 5000,
  };

  /* ── Small helpers ──────────────────────────────────────────────────── */

  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function cleanText(value, max) {
    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value !== "string" && typeof value !== "number") {
      return "";
    }

    const text = String(value).replace(/\s+/g, (match) => (match.includes("\n") ? match : " ")).trim();
    return max && text.length > max ? text.slice(0, max) : text;
  }

  function toNumber(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }

    const raw = String(value ?? "").trim();
    if (!raw) {
      return null;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /* A number inside [min, max], or null. Reports what it had to clear. */
  function boundedNumber(value, min, max, label, warnings) {
    const number = toNumber(value);

    if (number === null) {
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        warnings.push(`${label} "${String(value).slice(0, 20)}" is not a number`);
      }
      return null;
    }

    if (number < min || number > max) {
      warnings.push(`${label} ${number} is outside ${min}–${max}`);
      return null;
    }

    return number;
  }

  function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function cleanDate(value, label, warnings) {
    if (value === null || value === undefined || value === "") {
      return "";
    }

    const text = String(value).trim().slice(0, 10);
    if (isValidDate(text)) {
      return text;
    }

    warnings.push(`${label} "${String(value).slice(0, 20)}" is not a date`);
    return "";
  }

  function cleanTimestamp(value, fallback) {
    if (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value))) {
      return value;
    }

    return fallback;
  }

  /* Only http(s) links survive: a javascript: or data: URL in an imported file
     must never reach an href or an img src. */
  function safeUrl(value, { httpsOnly = false } = {}) {
    if (typeof value !== "string" || !value.trim() || value.length > 2000) {
      return "";
    }

    try {
      const url = new URL(value.trim());
      const allowed = httpsOnly ? url.protocol === "https:" : url.protocol === "https:" || url.protocol === "http:";
      return allowed ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function cleanId(value) {
    const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    return text && text.length <= 100 ? text : "";
  }

  function tagKey(label) {
    return String(label || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /* Tags keep the spelling they were typed with but are unique regardless of
     case, so "Harsh" and "harsh " are one tag. */
  function normalizeTags(value) {
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    const seen = new Set();
    const tags = [];

    for (const raw of list) {
      const label = cleanText(raw, 40);
      const key = tagKey(label);
      if (label && !seen.has(key)) {
        seen.add(key);
        tags.push(label);
      }

      if (tags.length >= MAX_TAGS) {
        break;
      }
    }

    return tags;
  }

  function stringList(value, maxItems, maxLength) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => cleanText(item, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  /* Hand-added fields are kept as long as they are plain values, so editing the
     JSON by hand never silently loses information. */
  function copyExtras(raw, known, target) {
    for (const [key, value] of Object.entries(raw)) {
      if (known.has(key) || key.length > 60 || key === "__proto__") {
        continue;
      }

      if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        target[key] = value;
      } else if (typeof value === "string" && value.length <= 2000) {
        target[key] = value;
      }
    }

    return target;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) {
      return "[" + value.map(stableStringify).join(",") + "]";
    }

    if (isPlainObject(value)) {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .filter((key) => value[key] !== undefined)
          .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
          .join(",") +
        "}"
      );
    }

    return JSON.stringify(value === undefined ? null : value);
  }

  function today(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function normalizeAmount(value) {
    const trimmed = cleanText(value, ENTRY_TEXT.amount);
    if (!trimmed) {
      return "";
    }

    const compact = trimmed.replace(/\s+/g, "");
    if (/^\d+(\.\d+)?g?$/i.test(compact)) {
      return `${compact.replace(/g$/i, "")}g`;
    }

    return trimmed;
  }

  /* ── Records ────────────────────────────────────────────────────────── */

  const ENTRY_KNOWN = new Set([
    "id", "name", "type", "brand", "strain", "extraction", "amount", "vendor", "batch",
    "terpenes", "effects", "notes", "remaining", "productKey", "thc", "cbd",
    "terpenePercent", "price", "rating", "purchaseDate", "openedAt", "status",
    "potencyUnit", "favorite", "wouldRepurchase", "tags", "sourceUrl", "createdAt", "updatedAt",
  ]);

  /* Returns { value, errors, warnings }. An error means the record cannot be
     kept; a warning means one field was cleared or trimmed. */
  function normalizeEntry(raw, { now = new Date().toISOString() } = {}) {
    const errors = [];
    const warnings = [];

    if (!isPlainObject(raw)) {
      return { value: null, errors: ["not an object"], warnings };
    }

    const name = cleanText(raw.name, ENTRY_TEXT.name);
    if (!name) {
      return { value: null, errors: ["has no product name"], warnings };
    }

    const type = Object.prototype.hasOwnProperty.call(TYPE_LABELS, raw.type) ? raw.type : "other";
    const potencyUnit = raw.potencyUnit === "mg" || raw.potencyUnit === "%"
      ? raw.potencyUnit
      : MG_TYPES.has(type) ? "mg" : "%";
    const potencyMax = potencyUnit === "mg" ? 10000 : 100;

    const entry = {
      id: cleanId(raw.id) || uuid(),
      name,
      type,
      brand: cleanText(raw.brand, ENTRY_TEXT.brand),
      strain: cleanText(raw.strain, ENTRY_TEXT.strain),
      extraction: cleanText(raw.extraction, ENTRY_TEXT.extraction),
      amount: normalizeAmount(raw.amount),
      batch: cleanText(raw.batch, ENTRY_TEXT.batch),
      potencyUnit,
      thc: boundedNumber(raw.thc, 0, potencyMax, "THC", warnings),
      cbd: boundedNumber(raw.cbd, 0, potencyMax, "CBD", warnings),
      terpenePercent: boundedNumber(raw.terpenePercent, 0, 100, "Terpene %", warnings),
      terpenes: cleanText(Array.isArray(raw.terpenes) ? raw.terpenes.join(", ") : raw.terpenes, ENTRY_TEXT.terpenes),
      price: boundedNumber(raw.price, 0, 100000, "Price", warnings),
      purchaseDate: cleanDate(raw.purchaseDate, "Purchase date", warnings),
      vendor: cleanText(raw.vendor, ENTRY_TEXT.vendor),
      rating: boundedNumber(raw.rating, 0, 10, "Rating", warnings),
      wouldRepurchase: raw.wouldRepurchase === true || raw.wouldRepurchase === false ? raw.wouldRepurchase : null,
      effects: cleanText(raw.effects, ENTRY_TEXT.effects),
      notes: cleanText(raw.notes, ENTRY_TEXT.notes),
      tags: normalizeTags(raw.tags),
      favorite: Boolean(raw.favorite),
      status: Object.prototype.hasOwnProperty.call(STATUS_LABELS, raw.status) ? raw.status : "",
      openedAt: cleanDate(raw.openedAt, "Opened date", warnings),
      remaining: cleanText(raw.remaining, ENTRY_TEXT.remaining),
      productKey: cleanText(raw.productKey, ENTRY_TEXT.productKey),
      sourceUrl: safeUrl(raw.sourceUrl),
      createdAt: cleanTimestamp(raw.createdAt, now),
      updatedAt: cleanTimestamp(raw.updatedAt, now),
    };

    if (raw.sourceUrl && !entry.sourceUrl) {
      warnings.push("source link was not an http(s) URL");
    }

    return { value: copyExtras(raw, ENTRY_KNOWN, entry), errors, warnings };
  }

  const WISH_KNOWN = new Set([
    "id", ...Object.keys(WISH_TEXT), "type", "sizes", "thc", "thcMin", "thcMax", "cbd", "cbdMin",
    "cbdMax", "terpenes", "price", "targetPrice", "available", "image", "url", "addedAt",
    "lookedUpAt", "priority", "matchDismissed",
  ]);

  function normalizeWishItem(raw, { now = new Date().toISOString() } = {}) {
    const warnings = [];

    if (!isPlainObject(raw)) {
      return { value: null, errors: ["not an object"], warnings };
    }

    const name = cleanText(raw.name, WISH_TEXT.name);
    if (!name) {
      return { value: null, errors: ["has no product name"], warnings };
    }

    const item = { id: cleanId(raw.id) || uuid(), name };

    for (const [field, max] of Object.entries(WISH_TEXT)) {
      if (field !== "name") {
        item[field] = cleanText(raw[field], max);
      }
    }

    item.type = Object.prototype.hasOwnProperty.call(TYPE_LABELS, raw.type) ? raw.type : "";
    item.amount = normalizeAmount(raw.amount);
    item.sizes = stringList(raw.sizes, 20, 60);
    item.terpenes = Array.isArray(raw.terpenes)
      ? stringList(raw.terpenes, 20, 60)
      : cleanText(raw.terpenes, 500).split(",").map((part) => part.trim()).filter(Boolean).slice(0, 20);

    for (const field of ["thc", "thcMin", "thcMax", "cbd", "cbdMin", "cbdMax"]) {
      item[field] = boundedNumber(raw[field], 0, 10000, field, warnings);
    }

    item.price = boundedNumber(raw.price, 0, 100000, "Price", warnings);
    item.targetPrice = boundedNumber(raw.targetPrice, 0, 100000, "Target price", warnings);
    item.available = raw.available === true || raw.available === false ? raw.available : null;
    item.image = safeUrl(raw.image, { httpsOnly: true });
    item.url = safeUrl(raw.url);
    item.priority = Object.prototype.hasOwnProperty.call(PRIORITY_LABELS, raw.priority) ? raw.priority : "normal";
    item.matchDismissed = Boolean(raw.matchDismissed);
    item.addedAt = cleanTimestamp(raw.addedAt, now);
    item.lookedUpAt = cleanTimestamp(raw.lookedUpAt, "");
    item.updatedAt = cleanTimestamp(raw.updatedAt, item.addedAt);

    if (raw.url && !item.url) {
      warnings.push("product link was not an http(s) URL");
    }

    if (raw.image && !item.image) {
      warnings.push("image was not an https URL");
    }

    return { value: copyExtras(raw, new Set([...WISH_KNOWN, "updatedAt"]), item), errors: [], warnings };
  }

  function normalizeExperience(raw, { now = new Date().toISOString() } = {}) {
    const warnings = [];

    if (!isPlainObject(raw)) {
      return { value: null, errors: ["not an object"], warnings };
    }

    const productId = cleanId(raw.productId);
    if (!productId) {
      return { value: null, errors: ["is not linked to a product"], warnings };
    }

    const value = {
      id: cleanId(raw.id) || uuid(),
      productId,
      date: cleanDate(raw.date, "Date", warnings) || today(),
      amount: cleanText(raw.amount, EXPERIENCE_TEXT.amount),
      effects: normalizeTags(raw.effects),
      flavor: cleanText(raw.flavor, EXPERIENCE_TEXT.flavor),
      rating: boundedNumber(raw.rating, 0, 10, "Rating", warnings),
      notes: cleanText(raw.notes, EXPERIENCE_TEXT.notes),
      createdAt: cleanTimestamp(raw.createdAt, now),
      updatedAt: cleanTimestamp(raw.updatedAt, now),
    };

    return { value, errors: [], warnings };
  }

  const NORMALIZERS = {
    product: normalizeEntry,
    wishlist: normalizeWishItem,
    experience: normalizeExperience,
  };

  function normalizeTrashItem(raw, options) {
    if (!isPlainObject(raw) || !NORMALIZERS[raw.kind]) {
      return { value: null, errors: ["is not a deleted record"], warnings: [] };
    }

    const inner = NORMALIZERS[raw.kind](raw.item, options);
    if (!inner.value) {
      return inner;
    }

    return {
      value: {
        id: inner.value.id,
        kind: raw.kind,
        item: inner.value,
        deletedAt: cleanTimestamp(raw.deletedAt, options?.now || new Date().toISOString()),
        position: Number.isInteger(raw.position) && raw.position >= 0 ? raw.position : 0,
      },
      errors: [],
      warnings: inner.warnings,
    };
  }

  function normalizeSettings(raw) {
    const warnings = [];
    const source = isPlainObject(raw) ? raw : {};
    return {
      monthlyBudget: boundedNumber(source.monthlyBudget, 0, 1000000, "Monthly budget", warnings),
    };
  }

  /* ── Whole documents ────────────────────────────────────────────────── */

  function emptyDoc() {
    return { products: [], wishlist: [], experiences: [], trash: [], settings: { monthlyBudget: null } };
  }

  function normalizeList(list, normalizer, collection, report, options) {
    if (list === undefined || list === null) {
      return [];
    }

    if (!Array.isArray(list)) {
      report.errors.push({ collection, index: -1, message: `"${collection}" is not a list` });
      return [];
    }

    const seen = new Set();
    const values = [];

    list.slice(0, MAX_ITEMS).forEach((raw, index) => {
      const result = normalizer(raw, options);
      const label = isPlainObject(raw) && typeof raw.name === "string" ? raw.name.slice(0, 60) : "";

      if (!result.value) {
        report.errors.push({ collection, index, label, message: result.errors.join(", ") });
        return;
      }

      /* Two records with one id would make edits land on the wrong one. */
      if (seen.has(result.value.id)) {
        result.value.id = uuid();
      }
      seen.add(result.value.id);

      result.warnings.forEach((message) => report.warnings.push({ collection, index, label, message }));
      values.push(result.value);

      /* Stored differently from how it normalizes (an id or timestamp had to
         be made up, a field was added by a newer schema): worth writing back,
         so the made-up values stay the same on the next read. */
      if (!report.repaired && stableStringify(result.value) !== stableStringify(raw)) {
        report.repaired = true;
      }
    });

    if (list.length > MAX_ITEMS) {
      report.errors.push({ collection, index: MAX_ITEMS, message: `only the first ${MAX_ITEMS} records were read` });
    }

    return values;
  }

  /* Accepts every shape this app has ever written - a bare array (the first
     export), { products } (v1), and the current v2 document - and returns a
     v2 document plus a report of what could not be kept. */
  function migrateDoc(raw, options = {}) {
    const report = { errors: [], warnings: [], repaired: false };
    let source;

    if (Array.isArray(raw)) {
      source = { products: raw };
    } else if (isPlainObject(raw)) {
      source = raw;
    } else {
      report.errors.push({ collection: "file", index: -1, message: "expected a JSON object or array" });
      return { doc: emptyDoc(), report, valid: false };
    }

    if (!Array.isArray(source.products) && !Array.isArray(source.wishlist)) {
      report.errors.push({ collection: "file", index: -1, message: 'no "products" or "wishlist" list found' });
      return { doc: emptyDoc(), report, valid: false };
    }

    const doc = {
      products: normalizeList(source.products, normalizeEntry, "products", report, options),
      wishlist: normalizeList(source.wishlist, normalizeWishItem, "wishlist", report, options),
      experiences: normalizeList(source.experiences, normalizeExperience, "experiences", report, options),
      trash: normalizeList(source.trash, normalizeTrashItem, "trash", report, options),
      settings: normalizeSettings(source.settings),
    };

    return { doc, report, valid: true };
  }

  function docCounts(doc) {
    return {
      products: doc.products.length,
      wishlist: doc.wishlist.length,
      experiences: doc.experiences.length,
      trash: doc.trash.length,
    };
  }

  function isEmptyDoc(doc) {
    return !doc.products.length && !doc.wishlist.length && !doc.experiences.length;
  }

  function docsEqual(left, right) {
    return stableStringify(syncable(left)) === stableStringify(syncable(right));
  }

  function syncable(doc) {
    return {
      products: doc.products,
      wishlist: doc.wishlist,
      experiences: doc.experiences,
      trash: doc.trash,
      settings: doc.settings,
    };
  }

  function purgeTrash(trash, now = Date.now()) {
    const cutoff = now - TRASH_RETENTION_DAYS * 86400000;
    return trash
      .filter((item) => Date.parse(item.deletedAt) >= cutoff)
      .slice(0, TRASH_LIMIT);
  }

  /* ── Three-way merge ─────────────────────────────────────────────────────
     `base` is the last copy both sides agreed on. A record changed on only
     one side takes that side's version; changed on both, the newer updatedAt
     wins and the clash is counted. A record deleted on one side and left
     alone on the other stays deleted; deleted on one side but edited on the
     other, the edit survives, because losing work is worse than a record
     coming back.
  ------------------------------------------------------------------------ */

  function mergeCollection(base, local, remote, keyOf = (item) => item.id) {
    const index = (list) => new Map((list || []).map((item) => [keyOf(item), item]));
    const baseMap = index(base);
    const localMap = index(local);
    const remoteMap = index(remote);
    const keep = new Map();
    let conflicts = 0;

    const keys = new Set([...localMap.keys(), ...remoteMap.keys()]);

    for (const key of keys) {
      const inBase = baseMap.has(key);
      const localItem = localMap.get(key);
      const remoteItem = remoteMap.get(key);
      const baseText = inBase ? stableStringify(baseMap.get(key)) : null;

      if (localItem && remoteItem) {
        const localText = stableStringify(localItem);
        const remoteText = stableStringify(remoteItem);

        if (localText === remoteText) {
          keep.set(key, localItem);
        } else if (inBase && localText === baseText) {
          keep.set(key, remoteItem);
        } else if (inBase && remoteText === baseText) {
          keep.set(key, localItem);
        } else {
          conflicts += 1;
          keep.set(key, newer(localItem, remoteItem));
        }
      } else if (localItem) {
        if (!inBase) {
          keep.set(key, localItem);
        } else if (stableStringify(localItem) !== baseText) {
          conflicts += 1;
          keep.set(key, localItem);
        }
      } else if (remoteItem) {
        if (!inBase) {
          keep.set(key, remoteItem);
        } else if (stableStringify(remoteItem) !== baseText) {
          conflicts += 1;
          keep.set(key, remoteItem);
        }
      }
    }

    /* New remote records first (lists are newest-first), then local order. */
    const ordered = [];
    for (const item of remote || []) {
      const key = keyOf(item);
      if (keep.has(key) && !localMap.has(key)) {
        ordered.push(keep.get(key));
        keep.delete(key);
      }
    }

    for (const item of local || []) {
      const key = keyOf(item);
      if (keep.has(key)) {
        ordered.push(keep.get(key));
        keep.delete(key);
      }
    }

    ordered.push(...keep.values());
    return { items: ordered, conflicts };
  }

  function newer(localItem, remoteItem) {
    const stamp = (item) => Date.parse(item.updatedAt || item.deletedAt || item.addedAt || "") || 0;
    return stamp(remoteItem) > stamp(localItem) ? remoteItem : localItem;
  }

  function mergeDocs(base, local, remote) {
    const safeBase = base || emptyDoc();
    const products = mergeCollection(safeBase.products, local.products, remote.products);
    const wishlist = mergeCollection(safeBase.wishlist, local.wishlist, remote.wishlist);
    const experiences = mergeCollection(safeBase.experiences, local.experiences, remote.experiences);
    const trashKey = (item) => `${item.kind}:${item.id}`;
    const trash = mergeCollection(safeBase.trash, local.trash, remote.trash, trashKey);

    /* A record restored on one side while its tombstone survives on the other
       must not exist twice: the live copy wins over the tombstone. */
    const live = {
      product: new Set(products.items.map((item) => item.id)),
      wishlist: new Set(wishlist.items.map((item) => item.id)),
      experience: new Set(experiences.items.map((item) => item.id)),
    };
    const trashItems = trash.items.filter((item) => !live[item.kind]?.has(item.id));

    const settings = {};
    const keys = new Set([
      ...Object.keys(safeBase.settings || {}),
      ...Object.keys(local.settings || {}),
      ...Object.keys(remote.settings || {}),
    ]);
    for (const key of keys) {
      const baseValue = safeBase.settings?.[key] ?? null;
      const localValue = local.settings?.[key] ?? null;
      const remoteValue = remote.settings?.[key] ?? null;
      settings[key] = localValue !== baseValue ? localValue : remoteValue;
    }

    return {
      doc: {
        products: products.items,
        wishlist: wishlist.items,
        experiences: experiences.items,
        trash: trashItems,
        settings: normalizeSettings(settings),
      },
      conflicts: products.conflicts + wishlist.conflicts + experiences.conflicts + trash.conflicts,
    };
  }

  /* Import "Merge": everything from both, newer record wins on a shared id. */
  function combineDocs(current, incoming) {
    return mergeDocs(null, current, incoming).doc;
  }

  /* ── Units and identity ─────────────────────────────────────────────── */

  /* "3.5g", "1 g", "28 grams", "500mg", "10-pack" -> a quantity and unit. Only
     compatible units are ever compared. */
  function parseQuantity(amount) {
    const text = String(amount || "").toLowerCase().replace(/,/g, ".").trim();
    if (!text) {
      return null;
    }

    let match = text.match(/^(\d+(?:\.\d+)?)\s*(mg|g|grams?|gram|ml|oz)\b/);
    if (match) {
      const value = Number(match[1]);
      const unit = match[2];
      if (unit === "mg") return { value: value / 1000, unit: "g" };
      if (unit === "ml") return { value, unit: "ml" };
      if (unit === "oz") return { value: value * 28, unit: "g" };
      return { value, unit: "g" };
    }

    match = text.match(/^(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(g|mg|ml)\b/);
    if (match) {
      const count = Number(match[1]);
      const each = Number(match[2]);
      const unit = match[3];
      if (unit === "mg") return { value: (count * each) / 1000, unit: "g" };
      return { value: count * each, unit };
    }

    match = text.match(/^(\d+)\s*[- ]?\s*(pack|pk|pieces?|pcs|units?|count|ct)\b/);
    if (match) {
      return { value: Number(match[1]), unit: "unit" };
    }

    return null;
  }

  function unitPrice(entry) {
    const quantity = parseQuantity(entry.amount);
    if (!quantity || !quantity.value || typeof entry.price !== "number" || entry.price <= 0) {
      return null;
    }

    return { value: entry.price / quantity.value, unit: quantity.unit };
  }

  /* The product handle is the stable part of an ocs.ca link; tracking
     parameters, collection paths and ?variant= all vary. */
  function productLinkKey(url) {
    if (!url) {
      return "";
    }

    try {
      const parsed = new URL(url);
      const found = parsed.pathname.match(/\/products\/([^/?#]+)/);
      if (found) {
        return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}:${decodeURIComponent(found[1]).replace(/\.(js|json)$/, "").toLowerCase()}`;
      }

      return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/$/, "").toLowerCase()}`;
    } catch (error) {
      return "";
    }
  }

  function nameKey(record) {
    return `${tagKey(record.name)}|${tagKey(record.brand)}`;
  }

  /* Purchases of the same product: linked explicitly by "Buy again" through
     productKey, or by the same store link. Never by name alone. */
  function relatedPurchases(entries, entry) {
    const key = entry.productKey;
    const link = productLinkKey(entry.sourceUrl);

    return entries.filter((other) => {
      if (other.id === entry.id) {
        return true;
      }

      if (key && (other.productKey === key || other.id === key)) {
        return true;
      }

      if (!key && other.productKey && other.productKey === entry.id) {
        return true;
      }

      return Boolean(link) && productLinkKey(other.sourceUrl) === link;
    });
  }

  /* ── Filtering and sorting ──────────────────────────────────────────── */

  function defaultFilters() {
    return {
      types: [],
      brands: [],
      tags: [],
      statuses: [],
      minRating: null,
      minPrice: null,
      maxPrice: null,
      dateFrom: "",
      dateTo: "",
      repurchase: false,
    };
  }

  function searchText(entry) {
    return [
      entry.name,
      TYPE_LABELS[entry.type],
      entry.brand,
      entry.strain,
      entry.extraction,
      entry.vendor,
      entry.batch,
      entry.terpenes,
      entry.effects,
      entry.notes,
      (entry.tags || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
  }

  function matchesFilters(entry, filters, search) {
    const f = filters || defaultFilters();

    if (f.types.length && !f.types.includes(entry.type)) return false;
    if (f.brands.length && !f.brands.some((brand) => tagKey(brand) === tagKey(entry.brand))) return false;
    if (f.statuses.length && !f.statuses.includes(entry.status || "none")) return false;
    if (f.tags.length) {
      const own = new Set((entry.tags || []).map(tagKey));
      if (!f.tags.every((tag) => own.has(tagKey(tag)))) return false;
    }
    if (f.minRating !== null && !(typeof entry.rating === "number" && entry.rating >= f.minRating)) return false;
    if (f.minPrice !== null && !(typeof entry.price === "number" && entry.price >= f.minPrice)) return false;
    if (f.maxPrice !== null && !(typeof entry.price === "number" && entry.price <= f.maxPrice)) return false;
    if (f.dateFrom && !(entry.purchaseDate && entry.purchaseDate >= f.dateFrom)) return false;
    if (f.dateTo && !(entry.purchaseDate && entry.purchaseDate <= f.dateTo)) return false;
    if (f.repurchase && entry.wouldRepurchase !== true) return false;

    if (search) {
      const words = search.toLowerCase().split(/\s+/).filter(Boolean);
      const haystack = searchText(entry);
      if (!words.every((word) => haystack.includes(word))) return false;
    }

    return true;
  }

  function activeFilterCount(filters) {
    const f = filters || defaultFilters();
    return (
      f.types.length +
      f.brands.length +
      f.tags.length +
      f.statuses.length +
      (f.minRating !== null ? 1 : 0) +
      (f.minPrice !== null ? 1 : 0) +
      (f.maxPrice !== null ? 1 : 0) +
      (f.dateFrom ? 1 : 0) +
      (f.dateTo ? 1 : 0) +
      (f.repurchase ? 1 : 0)
    );
  }

  /* Missing values always sort last, whichever direction is chosen. */
  function compareMissingLast(left, right, direction) {
    const leftMissing = left === null || left === undefined || left === "";
    const rightMissing = right === null || right === undefined || right === "";
    if (leftMissing && rightMissing) return 0;
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    if (left < right) return -direction;
    if (left > right) return direction;
    return 0;
  }

  function compareNames(left, right) {
    return String(left.name || "").localeCompare(String(right.name || ""), undefined, { sensitivity: "base" });
  }

  const SORTS = {
    "purchaseDate-desc": (a, b) => compareMissingLast(a.purchaseDate, b.purchaseDate, -1),
    "purchaseDate-asc": (a, b) => compareMissingLast(a.purchaseDate, b.purchaseDate, 1),
    "rating-desc": (a, b) => compareMissingLast(a.rating, b.rating, -1),
    "thc-desc": (a, b) =>
      compareMissingLast(a.potencyUnit === "%" ? a.thc : null, b.potencyUnit === "%" ? b.thc : null, -1),
    "price-desc": (a, b) => compareMissingLast(a.price, b.price, -1),
    "price-asc": (a, b) => compareMissingLast(a.price, b.price, 1),
    "unitPrice-asc": (a, b) => compareMissingLast(unitPrice(a)?.value ?? null, unitPrice(b)?.value ?? null, 1),
    "name-asc": () => 0,
    "updated-desc": (a, b) => compareMissingLast(a.updatedAt, b.updatedAt, -1),
  };

  function sortEntries(entries, sortBy) {
    const compare = SORTS[sortBy] || SORTS["purchaseDate-desc"];
    return [...entries].sort((a, b) => compare(a, b) || compareNames(a, b));
  }

  const WISH_SORTS = {
    priority: (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
      compareMissingLast(a.addedAt, b.addedAt, -1),
    "added-desc": (a, b) => compareMissingLast(a.addedAt, b.addedAt, -1),
    "price-asc": (a, b) => compareMissingLast(a.price, b.price, 1),
    "price-desc": (a, b) => compareMissingLast(a.price, b.price, -1),
    "name-asc": () => 0,
  };

  function sortWishlist(items, sortBy, scores) {
    if (sortBy === "match" && scores) {
      return [...items].sort(
        (a, b) => (scores.get(b.id)?.score || 0) - (scores.get(a.id)?.score || 0) || compareNames(a, b)
      );
    }

    const compare = WISH_SORTS[sortBy] || WISH_SORTS.priority;
    return [...items].sort((a, b) => compare(a, b) || compareNames(a, b));
  }

  /* ── Insights ───────────────────────────────────────────────────────── */

  function monthKey(date) {
    return date.slice(0, 7);
  }

  function monthlySpend(entries, months = 12, now = new Date()) {
    const buckets = [];
    for (let offset = months - 1; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      buckets.push({ key: today(date).slice(0, 7), date, total: 0, count: 0 });
    }

    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    let undated = 0;
    let unpriced = 0;

    for (const entry of entries) {
      if (!entry.purchaseDate) {
        undated += 1;
        continue;
      }

      if (typeof entry.price !== "number") {
        unpriced += 1;
        continue;
      }

      const bucket = byKey.get(monthKey(entry.purchaseDate));
      if (bucket) {
        bucket.total += entry.price;
        bucket.count += 1;
      }
    }

    return { buckets, undated, unpriced };
  }

  function spendInMonth(entries, now = new Date()) {
    const key = today(now).slice(0, 7);
    return entries.reduce(
      (sum, entry) =>
        entry.purchaseDate && monthKey(entry.purchaseDate) === key && typeof entry.price === "number"
          ? sum + entry.price
          : sum,
      0
    );
  }

  function ratingDistribution(entries) {
    const buckets = Array.from({ length: 11 }, (_, score) => ({ score, count: 0 }));
    let unrated = 0;

    for (const entry of entries) {
      if (typeof entry.rating === "number") {
        buckets[Math.min(10, Math.floor(entry.rating))].count += 1;
      } else {
        unrated += 1;
      }
    }

    return { buckets, unrated };
  }

  function countBy(entries, keyOf) {
    const counts = new Map();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (key) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  function averageThcPercent(entries) {
    const values = entries.filter((entry) => entry.potencyUnit === "%" && typeof entry.thc === "number");
    return values.length ? values.reduce((sum, entry) => sum + entry.thc, 0) / values.length : null;
  }

  /* Liked = favorited, rated 8+, or explicitly worth buying again. */
  function isLiked(entry) {
    return entry.favorite || entry.wouldRepurchase === true || (typeof entry.rating === "number" && entry.rating >= 8);
  }

  function terpeneSet(value) {
    const list = Array.isArray(value) ? value : String(value || "").split(/[,;·]/);
    return new Set(list.map((item) => tagKey(item)).filter((item) => item && item.length > 2));
  }

  /* Explainable matching: every point of the score comes with the reason it
     was awarded, and only the user's own records count as evidence. */
  function matchScore(item, entries) {
    const liked = entries.filter(isLiked);
    if (!liked.length) {
      return { score: 0, reasons: [], basis: null };
    }

    let best = { score: 0, reasons: [], basis: null };
    const itemTerpenes = terpeneSet(item.terpenes);

    for (const entry of liked) {
      const reasons = [];
      let score = 0;

      const shared = [...terpeneSet(entry.terpenes)].filter((terpene) => itemTerpenes.has(terpene));
      if (shared.length) {
        score += shared.length * 2;
        reasons.push(`shares ${shared.slice(0, 3).join(", ")}`);
      }

      if (item.brand && tagKey(item.brand) === tagKey(entry.brand)) {
        score += 2;
        reasons.push("same brand");
      }

      if (item.type && item.type === entry.type) {
        score += 1;
        reasons.push(`also a ${TYPE_LABELS[item.type].toLowerCase()}`);
      }

      if (item.strain && tagKey(item.strain) === tagKey(entry.strain)) {
        score += 1;
        reasons.push(`same plant type`);
      }

      if (score > best.score) {
        best = { score, reasons, basis: entry };
      }
    }

    return best.score >= 3 ? best : { score: 0, reasons: [], basis: null };
  }

  /* Entries bought a while ago that still have no rating. */
  function awaitingRating(entries, now = new Date(), minimumDays = 2) {
    const cutoff = today(new Date(now.getTime() - minimumDays * 86400000));
    return entries.filter(
      (entry) =>
        typeof entry.rating !== "number" &&
        entry.purchaseDate &&
        entry.purchaseDate <= cutoff &&
        entry.status !== "unopened"
    );
  }

  return {
    SCHEMA_VERSION,
    TYPE_LABELS,
    STATUS_LABELS,
    PRIORITY_LABELS,
    MG_TYPES,
    TRASH_RETENTION_DAYS,
    uuid,
    cleanText,
    toNumber,
    isValidDate,
    safeUrl,
    tagKey,
    normalizeTags,
    stableStringify,
    today,
    normalizeAmount,
    normalizeEntry,
    normalizeWishItem,
    normalizeExperience,
    normalizeSettings,
    emptyDoc,
    migrateDoc,
    docCounts,
    isEmptyDoc,
    docsEqual,
    syncable,
    purgeTrash,
    mergeCollection,
    mergeDocs,
    combineDocs,
    parseQuantity,
    unitPrice,
    productLinkKey,
    nameKey,
    relatedPurchases,
    defaultFilters,
    matchesFilters,
    activeFilterCount,
    sortEntries,
    sortWishlist,
    monthlySpend,
    spendInMonth,
    ratingDistribution,
    countBy,
    averageThcPercent,
    isLiked,
    matchScore,
    awaitingRating,
  };
});
