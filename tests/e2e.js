/* End-to-end check in a real browser.

   Starts its own serve.py on a free port against a temporary data file, so
   it never touches weed_chart.json. Needs playwright-core and a Chromium:

       PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node tests/e2e.js

   Screenshots land in $E2E_SHOTS (default: a temp folder, printed at the end). */

const { spawn, execFileSync } = require("node:child_process");
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

/* A queue the server finds at start: Claude is held by a usage limit, a
   paused run waits to continue once it resets, and a new run waits behind
   it. Nothing here can start, so the test never reaches Reddit or a model. */
function plantResearchQueue() {
  const research = path.join(WORK, "research");
  fs.mkdirSync(path.join(research, "checkpoints"), { recursive: true });
  const id = "hash-20260101T000000Z";
  fs.writeFileSync(path.join(research, "checkpoints", `${id}.meta.json`), JSON.stringify({
    id, topic: { key: "hash", label: "Hash & kief", query: "" }, depth: "deep", status: "paused",
    reason: "usage limit", resets: "in 3 hours", provider: "claude", model: "", effort: "",
    partsDone: 4, parts: 11, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  }));
  const entry = (extra) => ({ query: "", depth: "quick", provider: "claude", model: "", effort: "", lightReading: true,
                               autoContinue: true, tries: 0, addedAt: "2026-01-01T00:00:00Z", ...extra });
  fs.writeFileSync(path.join(research, "queue.json"), JSON.stringify({
    queue: [
      entry({ id: "q-hash", kind: "resume", topic: "hash", label: "Hash & kief", depth: "deep", checkpoint: id, auto: true }),
      entry({ id: "q-flower", kind: "new", topic: "flower", label: "Dried flower" }),
    ],
    limited: { claude: Date.now() / 1000 + 3 * 3600 },
    current: null,
  }));
}

(async () => {
  plantResearchQueue();
  const [guide, answer] = execFileSync("python3", [path.join(ROOT, "tests", "make_guide.py"), path.join(WORK, "research")], { encoding: "utf8" }).trim().split("\n");
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

    step("Duel");
    check(await page.isVisible("#duel-list >> text=No duels yet"), "no ranking before any duel");
    await page.click("#duel-button");
    await page.waitForSelector(".duel-card");
    const winner = (await page.textContent(".duel-card[data-side='0'] .duel-name")).trim();
    await page.keyboard.press("ArrowLeft");
    await page.waitForSelector(".duel-count >> text=1 pick this time");
    await page.click(".duel-card[data-side='1']");
    await page.click(".duel-tools >> text=Undo");
    await page.waitForSelector(".duel-count >> text=1 pick this time");
    await page.screenshot({ path: path.join(SHOTS, "desktop-duel.png") });
    await page.click("#dialog .dialog-foot >> text=Done");
    check(await waitFor(() => page.isVisible("text=1 pick saved to your ranking.")), "the picks are saved");
    const ranked = await page.$$eval("#duel-list tbody tr", (rows) => rows.map((row) => row.cells[1].textContent.trim()));
    check(ranked.length === 2 && ranked[0] === winner, `the winner of the one kept pick ranks first (${ranked.join(", ")})`);
    await synced(page);
    const stored = readData().products.filter((entry) => entry.duelGames);
    check(stored.length >= 2 && stored.every((entry) => typeof entry.duelRating === "number"), "scores sync to the server");
    await page.click(".tab[data-view=collection]");
    await page.selectOption("#sort-by", "duel-desc");
    check((await page.textContent("button.name-link >> nth=0")).trim() === winner, "the collection sorts by duel rank");
    await page.selectOption("#sort-by", "purchaseDate-desc");

    step("Privacy mode");
    await page.click(".tab[data-view=collection]");
    await page.click("#privacy-button");
    const priceColor = await page.$eval("#stat-spend", (element) => getComputedStyle(element).color);
    check(priceColor === "rgba(0, 0, 0, 0)", "spend is masked");
    check(await page.isVisible("#privacy-indicator"), "privacy is clearly indicated");
    await page.click("#privacy-button");

    step("Discretion");
    await page.click("body", { position: { x: 5, y: 300 } });
    await page.keyboard.press("`");
    check(await page.isVisible("#cover"), "` covers the page");
    check((await page.title()) === "Notes", "with a plain tab title");
    check(await page.$eval("#main", (element) => element.inert), "and nothing behind it can be reached");
    await page.dblclick("#cover");
    check(await page.isHidden("#cover") && (await page.title()) === "Cloudline", "a double tap brings the page back");
    await page.click("#menu-button");
    await page.check("#plain-title-toggle");
    check((await page.title()) === "Notes", "Plain tab title keeps the title plain");
    check((await page.getAttribute('link[rel="icon"]', "href")).startsWith("data:image/svg"), "and the icon");
    await page.uncheck("#plain-title-toggle");
    await page.check("#blank-away-toggle");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    check(await page.isVisible("#cover"), "switching away blanks the page");
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    check(await page.isHidden("#cover"), "and coming back shows it again");
    await page.click("#menu-button");
    await page.uncheck("#blank-away-toggle");
    await page.keyboard.press("Escape");

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

    step("Research queue");
    const rs = await newPage(browser, `${url}?view=research`);
    await rs.waitForSelector("#rs-queue-heading");
    const titles = () => rs.$$eval("#rs-queue li .rs-eyebrow", (items) => items.map((i) => i.textContent));
    let order = await titles();
    check(order.length === 2 && /Hash/.test(order[0]) && /continues a paused run \(4 of 11 parts read\)/.test(order[0]),
      "the paused run waits first in Up next, saying how far it got");
    check(await rs.isVisible("#rs-queue >> text=/Waits for Claude's usage limit to reset, about/"), "says it waits for the limit");
    check(!(await rs.isVisible("#rs-paused-heading")), "a queued paused run isn't listed twice");
    await rs.click("#rs-queue li:nth-child(2) >> text=Move to front");
    check(await waitFor(async () => /flower/i.test((await titles())[0])), "Move to front reorders the queue");
    await rs.screenshot({ path: path.join(SHOTS, "research-queue.png"), fullPage: true });
    await rs.click("#rs-queue li:has-text('Hash') >> text=Don't continue by itself");
    await rs.waitForSelector("#rs-paused-heading");
    order = await titles();
    check(order.length === 1 && /flower/i.test(order[0]), "taking the paused run out leaves the other");
    check(await rs.isVisible("#rs-paused >> text=Hash & kief"), "and puts it back under Waiting to continue");
    check(JSON.parse(fs.readFileSync(path.join(WORK, "research", "queue.json"), "utf8")).queue.length === 1,
      "the change is saved for restarts");
    check(await noHorizontalScroll(rs), "no sideways scrolling");
    /* The panel of a running job, drawn from a made-up job: the page's
       scripts share one scope, so the test can hand it one. */
    await rs.evaluate(() => {
      const at = new Date().toISOString();
      ui.overview.job = { id: "fake", status: "running", label: "Hash", depth: "deep", llm: true, provider: "claude",
        stage: "threads", stages: ["catalog", "reddit", "threads", "parse", "write"], startedAt: at, counts: {},
        log: [5, 10, 15, 20].map((n) => ({ stage: "threads", at, message: `Fetched ${n} of 20 threads` }))
          .concat([{ stage: "threads", at, message: "Search for “Tribal” in r/TheOCS timed out for part of the year; skipped" }]) };
      renderJob();
    });
    await rs.click(".rs-full-log summary");
    check(/2 lines · 1 problem/.test(await rs.textContent(".rs-full-log summary")), "the full log folds progress and counts problems");
    check(await rs.isVisible(".rs-full-log li.is-warn >> text=timed out"), "and marks the problem");
    await waitFor(() => rs.evaluate(() => ui.logOpen)); /* "toggle" arrives a moment after the click */
    await rs.evaluate(() => renderJob());
    check(await rs.isVisible(".rs-full-log li.is-warn"), "it stays open while the panel redraws");
    await rs.evaluate(() => { ui.overview.job = null; renderJob(); });
    check(rs.errors.length === 0, `research no script errors (${rs.errors.join(" | ")})`);
    await rs.context().close();
    const phone = await newPage(browser, `${url}?view=research`, { width: 390, height: 844 });
    await phone.waitForSelector("#rs-queue-heading");
    await phone.screenshot({ path: path.join(SHOTS, "w390-research-queue.png"), fullPage: true });
    check(await noHorizontalScroll(phone), "390px research: no sideways scrolling");
    await phone.context().close();

    step("Research guide");
    const gp = await newPage(browser, `${url}?view=research&report=${encodeURIComponent(guide)}`);
    await gp.waitForSelector("#rs-rankings");
    check(await gp.isVisible(".rs-toc"), "the guide shows its section menu");
    check((await gp.$$(".rs-card")).length === 1, "the guide shows its product card");
    await gp.click("[data-act=deck]");
    await gp.waitForSelector(".rs-deck .rs-deck-card");
    const box = await gp.$eval(".rs-deck-card", (card) => { const r = card.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; });
    await gp.mouse.move(box.x, box.y);
    await gp.mouse.down();
    await gp.mouse.move(box.x + box.w * 0.2, box.y, { steps: 4 });
    await gp.mouse.move(box.x + box.w * 0.45, box.y, { steps: 4 });
    await gp.mouse.up();
    await gp.waitForSelector(".rs-deck-end");
    check(await gp.isVisible(".rs-deck-end >> text=1 added to your shopping list"), "dragging a card right puts it on the list");
    await gp.keyboard.press("u");
    await gp.waitForSelector(".rs-deck-card:not(.rs-deck-end)");
    check(await gp.evaluate(() => state.data.wishlist.length === 0), "Undo takes it back off the list");
    await gp.screenshot({ path: path.join(SHOTS, "research-deck-card.png") });
    await gp.keyboard.press("ArrowUp");
    await gp.waitForSelector(".rs-deck-end >> text=1 must-try");
    check(await gp.evaluate(() => state.data.wishlist[0]?.priority === "high"), "↑ adds it as a high-priority must-try");
    await gp.screenshot({ path: path.join(SHOTS, "research-deck.png") });
    await gp.keyboard.press("Escape");
    check(await waitFor(() => gp.isHidden(".rs-deck")), "Escape closes the deck");
    await gp.click("[data-act=deck]");
    check(await gp.isVisible(".rs-deck-end >> text=Nothing left to sort"), "a decided product doesn't come back");
    await gp.click(".rs-deck [data-deck-close]");
    await gp.evaluate(() => { commit((data) => { data.wishlist = []; }); });
    await gp.click("[data-home]");
    await gp.waitForSelector("#rs-saved-heading");
    check(await waitFor(() => gp.isVisible(`[data-open="${guide}"]`)), "Back lists it under Saved guides");
    check(gp.errors.length === 0, `guide no script errors (${gp.errors.join(" | ")})`);
    await gp.context().close();

    step("Research: ask a question");
    const qa = await newPage(browser, `${url}?view=research`);
    await qa.waitForSelector("#rs-launch [data-mode=question]");
    await qa.click("#rs-launch [data-mode=question]");
    await qa.waitForSelector("#rs-question");
    check(await qa.isHidden(".rs-topics"), "question mode hides the product topics");
    check(!(await qa.$("#rs-counts")), "counts only is off for questions");
    check(await qa.isDisabled("#rs-start"), "Start waits for a question");
    check(await qa.isVisible("#rs-start-why >> text=Type your question first"), "and says why");
    await qa.click(`[data-open="${answer}"]`);
    await qa.waitForSelector(".rs-answer #rs-findings");
    check(await qa.isVisible("text=How do live resin carts affect studying?"), "the answer shows the question");
    check(await qa.isVisible(".rs-confidence"), "and how strong the evidence is");
    check((await qa.$$(".rs-answer .rs-quote")).length === 1, "only the verified quote is shown");
    check(await qa.isVisible("#rs-risks"), "risks people raise have their own section");
    await qa.screenshot({ path: path.join(SHOTS, "research-answer.png"), fullPage: true });
    await qa.click("[data-ask='Does CBD help with focus?']");
    await qa.waitForSelector("#rs-question");
    check((await qa.inputValue("#rs-question")) === "Does CBD help with focus?", "Ask next fills in the launcher");
    check(qa.errors.length === 0, `question no script errors (${qa.errors.join(" | ")})`);
    await qa.context().close();
    const qphone = await newPage(browser, `${url}?view=research&report=${encodeURIComponent(answer)}`, { width: 390, height: 844 });
    await qphone.waitForSelector(".rs-answer #rs-findings");
    await qphone.screenshot({ path: path.join(SHOTS, "w390-research-answer.png"), fullPage: true });
    check(await noHorizontalScroll(qphone), "390px answer: no sideways scrolling");
    await qphone.context().close();

    step("Research launcher and saved guides");
    const rl = await newPage(browser, `${url}?view=research`);
    await rl.waitForSelector("#rs-start");
    check(await rl.$eval("#rs-job", (el) => getComputedStyle(el).display === "none"), "empty run boxes leave no gap under the heading");
    await rl.click(".rs-topic:has(input[value=custom])");
    check(await rl.evaluate(() => document.activeElement?.id === "rs-query"), "Custom search opens its field, focused");
    check(await rl.isDisabled("#rs-start"), "an empty custom search can't start");
    await rl.fill("#rs-query", "cold cure");
    check(await waitFor(async () => !(await rl.isDisabled("#rs-start"))), "typing what to search for allows it");
    check(/“cold cure”/.test(await rl.textContent(".rs-summary-line")), "the footer sums up what will run");
    await rl.focus("[data-depth=deep]");
    await rl.keyboard.press("Enter");
    check(await rl.evaluate(() => document.activeElement?.dataset.depth === "deep" && document.activeElement.getAttribute("aria-pressed") === "true"),
      "picking a depth by keyboard keeps focus on it");
    /* No run may really start: answer the request here, slowly, as a refusal. */
    let posts = 0;
    await rl.route("**/api/research/jobs", async (route) => {
      posts += 1;
      await sleep(400);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "A research run is already going." }) });
    });
    await rl.evaluate(() => {
      document.getElementById("rs-start").click();
      document.getElementById("rs-start").click();
      startRun();
    });
    check(await waitFor(() => rl.isVisible(".rs-start-error >> text=already going")), "a refused start says why");
    check(posts === 1, `clicking Start twice sends one request (${posts})`);
    check(!(await rl.isDisabled("#rs-start")), "and the button comes back after the failure");
    await rl.unroute("**/api/research/jobs");
    await rl.reload();
    await rl.waitForSelector("#rs-start");
    check((await rl.inputValue("#rs-query")) === "cold cure" && await rl.isChecked("input[name=rs-topic][value=custom]")
      && (await rl.getAttribute("[data-depth=deep]", "aria-pressed")) === "true", "a reload keeps the form as it was");

    const count = (which) => rl.$eval(`[data-list=${which}] .tab-count`, (el) => Number(el.textContent));
    await rl.waitForSelector(`[data-archive="${guide}"]`);
    const before = [await count("active"), await count("archived")];
    await rl.click(`[data-archive="${guide}"]`);
    check(await waitFor(async () => (await count("active")) === before[0] - 1 && (await count("archived")) === before[1] + 1),
      "archiving moves the count from Active to Archived at once");
    check(!/report=/.test(rl.url()), "the Archive button doesn't also open the guide");
    check(await rl.evaluate(() => document.activeElement?.matches(".rs-report-open")), "focus moves to the next guide");
    await rl.click("[data-list=archived]");
    await rl.click(`[data-archive="${guide}"]`);
    check(await waitFor(async () => (await count("archived")) === before[1]), "unarchiving moves it back");
    await rl.click("[data-list=active]");
    rl.once("dialog", (dialog) => dialog.dismiss());
    await rl.click(`[data-delete="${guide}"]`);
    check(await rl.isVisible(`[data-open="${guide}"]`) && !/report=/.test(rl.url()), "cancelling Delete keeps the guide, and doesn't open it");
    await rl.selectOption("#rs-lf-topic", "question");
    check((await rl.$$(".rs-report-item")).length === 1 && await rl.isVisible(".rs-list-count >> text=Showing 1 of"), "filtering by type narrows the list");
    await rl.click(".rs-list-count [data-act=clear-list-filters]");
    check((await rl.$$(".rs-report-item")).length === 2, "Clear filters shows them all again");
    check(rl.errors.length === 0, `launcher no script errors (${rl.errors.join(" | ")})`);
    await rl.context().close();

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
