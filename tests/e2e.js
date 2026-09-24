/* End-to-end check in a real browser.

   Starts its own serve.py on a free port against a temporary data file, so
   it never touches weed_chart.json. Needs playwright-core and a Chromium:

       PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node tests/e2e.js

   Screenshots land in $E2E_SHOTS (default: a temp folder, printed at the end). */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const ROOT = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cloudline-e2e-"));
const DATA = path.join(WORK, "weed_chart.json");
const SHOTS = process.env.E2E_SHOTS || path.join(WORK, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let passes = 0;

function check(condition, message) {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

function step(title) {
  console.log(`\n${title}`);
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function readData() {
  return JSON.parse(fs.readFileSync(DATA, "utf8"));
}

function resetData() {
  fs.rmSync(DATA, { force: true });
  fs.rmSync(path.join(WORK, "backups"), { recursive: true, force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      /* keep polling */
    }
    await sleep(100);
  }
  return false;
}

async function newPage(browser, url, { width = 1440, height = 1000, storage = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  if (storage) {
    await context.addInitScript((items) => {
      if (!sessionStorage.getItem("seeded")) {
        for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
        sessionStorage.setItem("seeded", "1");
      }
    }, storage);
  }
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) page.errors.push(message.text());
  });
  await page.goto(url);
  await page.waitForSelector("#sync-label");
  return page;
}

async function synced(page) {
  return waitFor(async () => (await page.textContent("#sync-label")).trim() === "Saved");
}

async function addEntry(page, values) {
  await page.click("#add-entry-button");
  await page.fill("#name", values.name);
  if (values.type) await page.selectOption("#type", values.type);
  if (values.brand) await page.fill("#brand", values.brand);
  if (values.price !== undefined) await page.fill("#price", String(values.price));
  if (values.rating !== undefined) await page.fill("#rating", String(values.rating));
  if (values.amount || values.thc !== undefined || values.date || values.terpenes) {
    await page.click("#section-purchase summary");
    if (values.amount) await page.fill("#amount", values.amount);
    if (values.thc !== undefined) await page.fill("#thc", String(values.thc));
    if (values.date) await page.fill("#purchaseDate", values.date);
    if (values.terpenes) await page.fill("#terpenes", values.terpenes);
  }
  if (values.tags || values.notes) {
    await page.click("#section-experience summary");
    if (values.tags) await page.fill("#tags", values.tags);
    if (values.notes) await page.fill("#notes", values.notes);
  }
  await page.click("#form-submit");
  await page.waitForSelector("#drawer", { state: "hidden" });
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

(async () => {
  const port = await freePort();
  const server = spawn("python3", [path.join(ROOT, "serve.py"), "--port", String(port), "--data", DATA], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}/`;
  await waitFor(async () => (await fetch(url + "api/state")).ok, 10000);

  const browser = await chromium.launch();

  try {
    /* ── Everyday workflow ─────────────────────────────────────────────── */
    step("First use");
    let page = await newPage(browser, url);
    await synced(page);
    check(await page.isVisible("text=Start your collection"), "first-use empty state is shown");
    check((await page.textContent("#sync-label")).trim() === "Saved", "sync pill says Saved");

    step("Validation");
    await page.click("#add-entry-button");
    await page.fill("#name", "   ");
    await page.fill("#rating", "12");
    await page.click("#form-submit");
    check(await page.isVisible("#name-error"), "blank name is rejected inline");
    check(await page.isVisible("#rating-error"), "out-of-range rating is rejected inline");
    check(await page.evaluate(() => document.activeElement.id) === "name", "focus moves to the first invalid field");
    await page.fill("#name", "Blue Dream");
    await page.fill("#rating", "9");
    await page.click("#form-submit");
    await page.waitForSelector("#drawer", { state: "hidden" });
    await synced(page);
    check(readData().products[0].name === "Blue Dream", "entry reached the server file");

    await addEntry(page, { name: "Lemon Haze", type: "flower", brand: "Good Farms", price: 35, rating: 8, amount: "3.5g", thc: 22, date: "2026-09-01", terpenes: "Limonene, Myrcene", tags: "citrus, weekend", notes: "Bright.\nSecond line." });
    await addEntry(page, { name: "Gummy", type: "edible", price: 12, rating: 6, thc: 10, date: "2026-08-20", tags: "sleep" });
    await synced(page);
    const gummy = readData().products.find((entry) => entry.name === "Gummy");
    check(gummy.potencyUnit === "mg" && gummy.thc === 10, "edibles are recorded in mg");
    await page.screenshot({ path: path.join(SHOTS, "desktop-collection.png"), fullPage: true });

    step("Details panel");
    await page.click("button.name-link:has-text('Lemon Haze')");
    await page.waitForSelector("#detail-view:not([hidden])");
    check(await page.isVisible("#detail-view >> text=Second line."), "notes are readable without edit mode");
    check((await page.textContent("#detail-view")).includes("$10.00/g"), "price per gram is shown");
    check(page.url().includes("entry="), "details are in the URL");
    await page.click("#detail-view .favorite-toggle");
    await page.click("text=Record experience");
    await page.fill(".journal-form input[type=number]", "8.5");
    await page.fill(".journal-form textarea", "Great on a walk");
    await page.click(".journal-form button[type=submit]");
    check(await waitFor(() => page.isVisible(".timeline-item >> text=Great on a walk")), "journal entry is added to the timeline");
    await page.screenshot({ path: path.join(SHOTS, "desktop-detail.png") });

    step("Focus trap and Escape");
    for (let index = 0; index < 40; index += 1) await page.keyboard.press("Tab");
    check(await page.evaluate(() => document.getElementById("drawer").contains(document.activeElement)), "Tab stays inside the open panel");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#drawer", { state: "hidden" });
    check(await page.evaluate(() => document.activeElement?.textContent === "Lemon Haze"), "focus returns to the product name after closing");
    check(!page.url().includes("entry="), "closing the panel clears the URL");

    step("Back button closes details");
    await page.click("button.name-link:has-text('Gummy')");
    await page.waitForSelector("#detail-view:not([hidden])");
    await page.goBack();
    check(await waitFor(() => page.isHidden("#drawer")), "Back closes the panel");

    step("Favorites and filters");
    check((await page.textContent("#tab-count-favorites")).trim() === "1", "favorites count updates");
    await page.click(".tab[data-view=favorites]");
    check(await page.isVisible("button.name-link:has-text('Lemon Haze')"), "favorites view lists the favorite");
    check(page.url().includes("view=favorites"), "view is in the URL");
    await page.click(".tab[data-view=collection]");
    await page.click("#filter-toggle");
    await page.click("#filter-tags .check-chip:has-text('citrus')");
    check((await page.textContent("#result-count")).includes("Showing 1 of 3"), "tag filter narrows results with a count");
    check(await page.isVisible(".filter-chip:has-text('#citrus')"), "active filter shows as a removable chip");
    await page.fill("#search-input", "nothing-matches-this");
    check(await page.isVisible("text=Nothing matches"), "no-match empty state differs from first use");
    await page.click("text=Clear search and filters");
    check((await page.textContent("#result-count")).trim() === "3 entries", "clear all restores everything");
    await page.click("#filter-toggle");
    await page.keyboard.press("/");
    check(await page.evaluate(() => document.activeElement.id) === "search-input", "/ focuses search");
    await page.keyboard.press("Escape");

    step("Delete and undo");
    await page.click("tr:has-text('Gummy') button[aria-label^='Delete']");
    check(!(await page.isVisible("button.name-link:has-text('Gummy')")), "entry disappears");
    await page.click("#toast-action");
    check(await waitFor(() => page.isVisible("button.name-link:has-text('Gummy')")), "undo restores it");
    await synced(page);
    check(readData().products.some((entry) => entry.name === "Gummy") && readData().trash.length === 0, "server agrees after undo");

    step("Buy again and purchase history");
    await page.click("button.name-link:has-text('Lemon Haze')");
    await page.click("#detail-foot >> text=Buy again");
    check((await page.inputValue("#name")) === "Lemon Haze" && (await page.inputValue("#rating")) === "", "product facts copied, rating cleared");
    await page.fill("#price", "30");
    await page.click("#form-submit");
    await page.waitForSelector("#drawer", { state: "hidden" });
    await page.click("button.name-link:has-text('Lemon Haze') >> nth=0");
    check(await waitFor(() => page.isVisible("text=Purchase history · 2 purchases")), "both purchases are linked in the history");
    await page.keyboard.press("Escape");

    step("Unsaved changes");
    await page.click("#add-entry-button");
    await page.fill("#name", "Half typed");
    await sleep(700);
    await page.keyboard.press("Escape");
    check(await page.isVisible("text=Discard your changes?"), "closing a dirty form asks first");
    await page.click("#dialog .dialog-foot >> text=Keep editing");
    check((await page.inputValue("#name")) === "Half typed", "keep editing preserves the input");
    await page.reload();
    await page.waitForSelector("#sync-label");
    await page.click("#add-entry-button");
    check(await page.isVisible("#draft-notice"), "a draft survives a reload");
    await page.click("#draft-restore");
    check((await page.inputValue("#name")) === "Half typed", "draft restores");
    await page.keyboard.press("Escape");
    await page.click("#dialog .dialog-foot >> text=Discard");
    await page.waitForSelector("#drawer", { state: "hidden" });

    step("Shopping list");
    await page.click(".tab[data-view=shopping]");
    check(await page.isVisible("text=Your list is empty"), "shopping empty state");
    await page.click("#manual-details summary");
    await page.click("#manual-form button[type=submit]");
    check(await page.isVisible("#manual-name-error"), "manual add needs a name");
    await page.fill("#manual-name", "Pink Kush");
    await page.fill("#manual-brand", "North");
    await page.fill("#manual-price", "40");
    await page.selectOption("#manual-priority", "high");
    await page.fill("#manual-note", "Friend's pick");
    await page.click("#manual-form button[type=submit]");
    check(await page.isVisible(".wish >> text=High priority"), "priority is shown");
    check((await page.textContent("#wish-total")).includes("$40.00"), "basket estimate");
    await page.click(".wish >> text=Log purchase");
    check((await page.inputValue("#name")) === "Pink Kush", "log purchase prefills the form");
    await page.click("#drawer-cancel");
    await page.click("#dialog .dialog-foot >> text=Discard").catch(() => {});
    check(await page.isVisible(".wish >> text=Pink Kush"), "cancelling keeps the item on the list");
    await page.click(".wish >> text=Log purchase");
    await page.click("#form-submit");
    await page.waitForSelector("#drawer", { state: "hidden" });
    check(await page.isVisible("text=Your list is empty"), "saving takes it off the list");
    await synced(page);
    check(readData().products.some((entry) => entry.name === "Pink Kush" && entry.notes.includes("Friend's pick")), "the shopping note carried into the entry");

    step("Compare and bulk edit");
    await page.click(".tab[data-view=collection]");
    await page.check("tr:has-text('Blue Dream') .col-select input");
    await page.check("tr:has-text('Pink Kush') .col-select input");
    check((await page.textContent("#bulk-count")).startsWith("2 selected"), "bulk bar counts the selection");
    await page.click("#bulk-compare");
    check(await page.isVisible(".compare-table"), "compare opens");
    check((await page.textContent(".compare-table")).includes("Not recorded"), "missing values are labelled honestly");
    await page.screenshot({ path: path.join(SHOTS, "desktop-compare.png") });
    await page.click("#dialog .dialog-foot >> text=Done");
    await page.click("#bulk-edit");
    await page.fill("#dialog input[list=tag-options] >> nth=0", "tried");
    await page.click("#dialog .dialog-foot >> text=Apply changes");
    await synced(page);
    check(readData().products.filter((entry) => entry.tags.includes("tried")).length === 2, "bulk edit tagged both");

    step("Insights and budget");
    await page.click(".tab[data-view=insights]");
    await page.fill("#budget-input", "50");
    await page.click("#budget-form button");
    check(await waitFor(() => page.isVisible("#budget-summary >> text=of $50.00 spent this month")), "budget summary shows");
    check((await page.textContent("#value-list")).includes("Lemon Haze"), "value per gram lists gram-priced entries");
    await page.screenshot({ path: path.join(SHOTS, "desktop-insights.png"), fullPage: true });

    step("Privacy mode");
    await page.click(".tab[data-view=collection]");
    await page.click("#privacy-button");
    const priceColor = await page.$eval("#stat-spend", (element) => getComputedStyle(element).color);
    check(priceColor === "rgba(0, 0, 0, 0)", "spend is masked");
    check(await page.isVisible("#privacy-indicator"), "privacy is clearly indicated");
    await page.click("#privacy-button");

    step("Import preview");
    const importFile = path.join(WORK, "import.json");
    fs.writeFileSync(importFile, JSON.stringify({ products: [{ name: "Imported One", rating: 7 }, { name: "" }, { name: "Bad Link", sourceUrl: "javascript:alert(1)" }] }));
    await page.click("#menu-button");
    await page.setInputFiles("#import-input", importFile);
    check(await waitFor(() => page.isVisible("text=1 record will be skipped")), "preview reports the skipped row");
    await page.click("#dialog .dialog-foot >> text=Merge");
    await synced(page);
    const afterImport = readData();
    check(afterImport.products.some((entry) => entry.name === "Imported One"), "merge added the new entry");
    check(afterImport.products.find((entry) => entry.name === "Bad Link")?.sourceUrl === "", "unsafe link was dropped");
    check(fs.readdirSync(path.join(WORK, "backups")).some((name) => name.endsWith("-import.json")), "server kept a snapshot before the import");

    step("Backups and trash dialogs");
    await page.click("tr:has-text('Imported One') button[aria-label^='Delete']");
    await page.click("#menu-button");
    await page.click("#trash-button");
    check(await page.isVisible("#dialog >> text=Imported One"), "recently deleted lists the entry");
    await page.click("#dialog .backup-row >> text=Restore");
    await page.click("#dialog .dialog-foot >> text=Close");
    check(await page.isVisible("button.name-link:has-text('Imported One')"), "restored from recently deleted");
    await page.click("#menu-button");
    await page.click("#backups-button");
    check(await waitFor(() => page.isVisible("#dialog >> text=Before an import")), "snapshots are listed");
    await page.screenshot({ path: path.join(SHOTS, "desktop-backups.png") });
    await page.click("#dialog .dialog-foot >> text=Close");

    step("Dark theme");
    await page.click("#menu-button");
    await page.click("[data-theme-choice=dark]");
    check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "dark theme applies");
    await page.keyboard.press("Escape");
    await page.screenshot({ path: path.join(SHOTS, "desktop-dark.png"), fullPage: true });
    check(page.errors.length === 0, `no script errors (${page.errors.join(" | ")})`);
    await page.context().close();

    /* ── Two devices ───────────────────────────────────────────────────── */
    step("Two devices editing at once");
    const a = await newPage(browser, url);
    const b = await newPage(browser, url);
    await synced(a);
    await synced(b);
    await a.click("tr:has-text('Blue Dream') button[aria-label^='Edit']");
    await a.fill("#rating", "7.5");
    await a.click("#form-submit");
    await synced(a);
    /* B hasn't polled yet, so its next save is based on a stale revision. */
    await b.click("tr:has-text('Gummy') button[aria-label^='Edit']");
    await b.fill("#name", "Gummy (sour)");
    await b.click("#form-submit");
    check(await waitFor(async () => {
      const data = readData();
      return data.products.some((entry) => entry.name === "Gummy (sour)") && data.products.find((entry) => entry.name === "Blue Dream")?.rating === 7.5;
    }), "both edits survive on the server");
    check(await waitFor(async () => (await a.isVisible("button.name-link:has-text('Gummy (sour)')"))), "device A picks up device B's edit");

    step("Same record edited on both");
    await synced(a);
    await synced(b);
    await a.click("tr:has-text('Blue Dream') button[aria-label^='Edit']");
    await b.click("tr:has-text('Blue Dream') button[aria-label^='Edit']");
    await a.$eval("#section-experience", (section) => (section.open = true));
    await a.fill("#notes", "from A");
    await a.click("#form-submit");
    await synced(a);
    await sleep(50);
    await b.$eval("#section-experience", (section) => (section.open = true));
    await b.fill("#notes", "from B");
    await b.click("#form-submit");
    check(await waitFor(() => readData().products.find((entry) => entry.name === "Blue Dream")?.notes === "from B"), "the newer edit wins");
    check(await waitFor(() => b.isVisible("#toast >> text=edited in both places")), "the clash is reported");
    await a.context().close();
    await b.context().close();

    step("Offline edits are kept and sent later");
    const off = await newPage(browser, url);
    await synced(off);
    await off.context().setOffline(true);
    await off.click("tr:has-text('Gummy') button[aria-label^='Add'][aria-label*='favorites']");
    check(await waitFor(async () => /Offline|Not saved/.test(await off.textContent("#sync-label"))), "pill says the change is not saved yet");
    await off.context().setOffline(false);
    await off.evaluate(() => window.dispatchEvent(new Event("online")));
    check(await synced(off), "saved once back online");
    check(readData().products.find((entry) => entry.name === "Gummy (sour)")?.favorite === true, "the offline change reached the server");
    await off.context().close();

    step("A stale browser can't resurrect deleted data");
    const current = readData();
    const ghost = { id: "ghost-1", name: "Ghost", type: "other", updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" };
    const stale = await newPage(browser, url, {
      storage: { "cloudline-data-v2": JSON.stringify({ products: [...current.products, ghost], wishlist: [] }) },
    });
    check(await waitFor(() => stale.isVisible("text=Which copy should be kept?")), "an unknown browser with extra data is asked");
    await stale.click("#dialog .dialog-foot >> text=Use the server's copy");
    check(await waitFor(async () => !(await stale.isVisible("button.name-link:has-text('Ghost')"))), "choosing the server drops the ghost");
    await sleep(800);
    check(!readData().products.some((entry) => entry.id === "ghost-1"), "the ghost never reached the server");
    await stale.context().close();

    const cleared = await newPage(browser, url, {
      storage: {
        "cloudline-data-v2": JSON.stringify({ products: [...current.products, ghost], wishlist: [] }),
        "cloudline-sync-v2": JSON.stringify({ datasetId: current.datasetId, revision: "old", dirty: false, base: { products: [...current.products, ghost] } }),
      },
    });
    await synced(cleared);
    await sleep(500);
    check(!(await cleared.isVisible("button.name-link:has-text('Ghost')")), "a known browser follows a deliberate deletion silently");
    check(!readData().products.some((entry) => entry.id === "ghost-1"), "and doesn't write it back");
    await cleared.context().close();

    step("Clearing is explicit and recoverable");
    const clearer = await newPage(browser, url);
    await synced(clearer);
    await clearer.click("#menu-button");
    await clearer.click("#reset-button");
    check(await clearer.isVisible("text=every device that uses this server"), "the dialog explains the scope");
    await clearer.click("#dialog .dialog-foot >> text=Clear everything");
    await synced(clearer);
    check(readData().products.length === 0, "cleared on the server");
    check(fs.readdirSync(path.join(WORK, "backups")).some((name) => name.endsWith("-clear.json")), "snapshot kept before clearing");
    await clearer.click("#menu-button");
    await clearer.click("#backups-button");
    await clearer.waitForSelector("#dialog >> text=Before clearing");
    await clearer.click("#dialog .backup-row:has-text('Before clearing') >> text=Preview");
    await clearer.click("#dialog .dialog-foot >> text=Restore");
    await synced(clearer);
    check(readData().products.length > 0, "restore brings the data back");
    await clearer.context().close();

    /* ── Layout ────────────────────────────────────────────────────────── */
    step("Layouts");
    for (const [width, height] of [[360, 780], [390, 844], [768, 1024], [1440, 1000]]) {
      const small = await newPage(browser, url, { width, height });
      await synced(small);
      check(await noHorizontalScroll(small), `${width}px collection has no sideways scroll`);
      await small.screenshot({ path: path.join(SHOTS, `w${width}-collection.png`), fullPage: true });
      await small.click(".tab[data-view=shopping]");
      check(await noHorizontalScroll(small), `${width}px shopping has no sideways scroll`);
      await small.click(".tab[data-view=insights]");
      check(await noHorizontalScroll(small), `${width}px insights has no sideways scroll`);
      await small.screenshot({ path: path.join(SHOTS, `w${width}-insights.png`), fullPage: true });
      await small.click(".tab[data-view=collection]");
      await small.click("button.name-link >> nth=0");
      await small.waitForSelector("#detail-view:not([hidden])");
      await small.screenshot({ path: path.join(SHOTS, `w${width}-detail.png`) });
      await small.keyboard.press("Escape");
      await small.click("#add-entry-button");
      await small.screenshot({ path: path.join(SHOTS, `w${width}-form.png`) });
      check(small.errors.length === 0, `${width}px no script errors (${small.errors.join(" | ")})`);
      await small.context().close();
    }

    step("Opened as a file");
    const file = await newPage(browser, `file://${path.join(ROOT, "index.html")}`);
    check((await file.textContent("#sync-label")).trim() === "This browser only", "file:// says it's local-only");
    await addEntry(file, { name: "Offline entry" });
    check(await file.isVisible("button.name-link:has-text('Offline entry')"), "entries still work without the server");
    check(file.errors.length === 0, `file:// no script errors (${file.errors.join(" | ")})`);
    await file.context().close();
  } catch (error) {
    failures += 1;
    console.error("\nCrashed:", error);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${SHOTS}`);
  process.exit(failures ? 1 : 0);
})();
