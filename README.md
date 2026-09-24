# Cloudline

A personal collection journal and purchase planner for carts, concentrates,
flower, edibles and anything else worth remembering, a shopping list that
fills itself in from an [ocs.ca](https://ocs.ca) product link, and a
**Research** tab that reads what Reddit says about a product type and turns
it into an interactive buyer's guide.

Plain HTML, CSS and JavaScript with a small Python server. No build step, no
dependencies.

## Features

**Collection**

- Quick add (only the name is required), with Potency & purchase, Experience
  and Inventory sections to fill in now or later
- A details panel for reading an entry without editing it: facts, price per
  gram, tags, terpenes, notes, purchase history and an experience journal
- Favorites view, search (`/` to focus), and filters for type, status, brand,
  tags, rating, price and purchase date, shown as removable chips with a
  result count; save a set of filters as a named view
- Buy again: a new purchase with the product facts copied and the rating and
  notes left blank; purchases of one product are linked into a history
- Custom tags (rename, merge, remove from the menu), batch/lot, potency in % or
  mg, inventory status, "would you buy it again?"
- Select several entries to compare (2–4), bulk-tag, re-categorise, export or
  delete
- Deleting goes to **Recently deleted** for 30 days, with an Undo right away
- Unsaved form drafts survive a closed tab; closing a changed form asks first

**Shopping list**

- Paste an ocs.ca link and the item is added with its name, brand, category,
  THC and CBD ranges, terpenes, size, price and photo; add by hand otherwise
- Priority, target price, preferred store and a note on each item; sort by
  priority, price, date or best match
- Warns when a link is already on the list or already bought
- "Matches your taste" explains itself: shared terpenes, brand or type with a
  specific entry you rated highly
- **Log purchase** opens the form prefilled; saving moves the item into the
  collection, cancelling leaves it on the list

**Insights**

- Monthly spend with an optional budget, rating distribution, favorites by
  brand, inventory counts, a "worth buying again" list and value per gram
- Every chart says what it left out (undated or unpriced entries)

**Research**

- Pick a type (live resin / rosin carts, rosin, live resin concentrates,
  flower, pre-rolls, disposables, hash, edibles) or type your own search, and
  a depth:
  - **Quick**: 120 days, the model reads the ~30 most relevant threads in one pass
  - **Standard**: a year, ~90 threads in one pass
  - **Deep**: a year, every relevant thread (up to 400) and every comment,
    plus a search for comments naming the category's brands in other threads;
    the model reads it all in parts, takes notes on each, then writes the
    guide from the notes
- Pick who writes it: **Claude** (the `claude` CLI, your Claude Code plan),
  **Codex** (the `codex` CLI, your ChatGPT plan), **Grok** (the `grok` CLI,
  Grok Build, your SuperGrok / X Premium+ plan) or counts only; pick the
  model from the list the CLI itself reports, or type one, and a thinking
  level from the ones that model supports. The choices are remembered
- The server reads every post in r/TheOCS and r/CanadianCannabisLPs for that
  window, picks the relevant threads, reads their comments, and lines brands
  up against the full OCS catalog; a progress panel shows each stage
- The model writes the guide: quick picks (best overall, value, daytime,
  night & sleep, flavour, strongest, solo sessions, beginners, skip), trends, brand report cards, tiered rankings with pros,
  cons and verdicts, things to skip, tips, glossary and FAQ. Every quote is
  checked word for word against the real comment and dropped if it isn't there
- Without a model, a plainer guide is built from mention counts and tone
- Every guide says how much was fetched and how much the model actually read
- Product cards show indica / sativa / hybrid (from OCS), strength, best
  time, what it's good for, what the high is like, hardware, value, all
  terpenes and every size's price; filter by plant type, use, brand or solo
  fit. Brand cards show OCS counts and prices, trend, tone and best pick.
  "What's changing" adds counted risers and fallers and what's new on OCS.
  Privacy mode hides everything to do with solo sessions
- If the writer hits its plan's usage limit, the run **pauses** instead of
  failing: everything gathered and every part already read is saved, and
  the tab offers **Continue** (same writer, once the limit resets — the
  reset time is shown), **Finish with** another writer or model, or
  **Discard**. A Stop or a server restart mid-run is saved the same way
- The guide page: filterable, sortable product cards with Reddit quotes and
  links, a compare table, a price-per-gram vs score chart, monthly talk
  volume, brand mention sparklines; each card links to OCS, store prices and
  the latest posts, and adds straight to the shopping list (and says if it's
  already in your collection, with your rating)
- Guides are saved and can be reopened, re-run, archived or deleted; the
  list sorts by date, topic, depth, comments read or product count, with
  separate Active and Archived views

**Everywhere**

- Light (cream) and dark (midnight green) themes, following the OS or picked in the menu; a deep-green header and page heroes with a leaf mark, lime and purple accents, colour-coded product types
- Privacy mode hides prices and notes for screen sharing
- Keyboard: dialogs trap focus and return it on close, Escape closes,
  Back closes the details panel
- Installable, and the page itself opens offline

## Run

```bash
python3 serve.py
```

Then open <http://127.0.0.1:3002>. Options:

| Flag | Default |
|---|---|
| `--port`, `--host` | `3002`, `127.0.0.1` |
| `--data` | `weed_chart.json` next to `serve.py` |
| `--backups` | `backups/` next to the data file |
| `--research` | `research/` next to the data file |

Opening `index.html` directly still works, but only this browser keeps the
data and there is no link lookup: ocs.ca sends no CORS headers, so the
browser cannot fetch it itself.

## Saving and sync

- Every change is written to this browser first, then sent to the server.
  The sync pill says **Saved** only once the server has confirmed it.
- Each save names the revision it was based on. If another device saved in
  between, the server answers 409 with its copy; the page merges the two
  record by record against the last copy both agreed on and saves again.
  A record edited on both sides keeps the newer edit, and you are told.
- Offline or failed saves stay queued in the browser (across reloads) and
  retry with backoff; select the pill to retry now.
- A browser that has never synced with this server and holds records the
  server lacks is asked which copy to keep, so data deleted elsewhere can't
  quietly come back.

## Backups

- Before an import, a restore or a clear, and at most every 15 minutes while
  you edit, the server copies `weed_chart.json` into `backups/`. The newest
  100 are kept.
- **Menu → Backups & recovery** lists them; preview one to see what would
  come back or go, then restore. Restoring snapshots the current state first.
- **Export JSON** downloads everything, including the journal and Recently
  deleted.
- `backups/` holds personal data and is gitignored.

## How the OCS lookup works

ocs.ca is a Shopify storefront, so every product page has a machine-readable
twin at `/products/<handle>.js`. OCS publishes the cannabis specifics as
namespaced tags on the product:

```
category--Vapes            thc_content_min--70.000000    terpenes--Limonene
subcategory--510 Thread…   thc_content_max--76.000000    plant_type--Sativa Dominant
```

`ocs.py` pulls the handle out of whatever link you paste, re-requests it from a
hardcoded `https://ocs.ca` address, and maps those tags onto the fields this
tracker stores. Potency comes back as the range OCS publishes; the single THC
and CBD numbers written into an entry are its midpoint, and the range is kept
in the notes as a store estimate.

Edibles are dosed in milligrams, so their percentage tags are a flat zero —
those are left blank rather than recorded as "0% THC".

## How research works

`research.py` does the work; `serve.py` runs it in a background thread (one at
a time) and `research.js` shows it. It also runs from the shell:

```bash
python3 research.py live-carts --depth quick                     # Claude, CLI default model
python3 research.py custom --query "cold cure" --no-llm
python3 research.py flower --model sonnet --effort low
python3 research.py hash --depth deep --provider codex --model gpt-6-sol --effort medium
python3 research.py rosin --provider grok --model grok-4.7 --effort high
python3 research.py --resume hash-20260924T182347Z --provider claude   # continue a paused run
```

| Stage | Source | Notes |
|---|---|---|
| Catalog | `ocs.ca/products.json` (Shopify, ~4,700 products, 19 pages) | cached 12 h |
| Reddit | [Arctic Shift](https://arctic-shift.photon-reddit.com) archive API, every post in the window | cached; reruns fetch only new posts. Falls back to Reddit's public RSS feeds |
| Threads | every comment of the top 45 / 100 / all (≤400) threads, paging past the archive's 100-per-request limit | cached a day (a month for old threads) |
| Brand search (deep) | the archive's full-text comment search, for the category's 12 most-discussed brands | best effort; busy names can time out |
| Parse | brand mentions (from OCS vendor names), month counts, keyword tone | |
| Write | `claude -p --json-schema`, `codex exec --output-schema` or `grok --json-schema`, no tools (`llm.py`) | quick 1–5 min; deep 20–45 min |

Prices, sizes, potency and links on the guide always come from the OCS
catalog; the model only supplies a catalog reference. Reddit's own JSON API
refuses unauthenticated scripts, and PullPush asks not to be scraped, so
neither is used. Requests are throttled (1/s to the archive, 1 per 3 s to
Reddit).

Everything lands in `research/` next to the data file: `reports/` holds the
guides (JSON), `cache/` the downloads, `checkpoints/` runs waiting to
continue (a few MB each; removed once their guide is written). It's gitignored. Starting a run is
refused for cross-site requests, since it spends Claude usage.

## Data file

- `weed_chart.json` holds `products`, `wishlist`, `experiences`, `trash` and
  `settings`, and stays hand-editable. A file in the old v1 shape (or a bare
  array) is upgraded on first read, after a snapshot.
- Its revision is a hash of its contents, so edits made directly to the file
  show up in open browsers within a few seconds.
- A file that fails to parse is reported as an error, never as "empty", so a
  typo can't cause an empty collection to be synced back over it.
- The server validates every save (types, lengths, http(s)-only links, unique
  ids) and rejects bad data with a 400 rather than writing it.
- Only the page's own files are served: never the data file, backups, `.git`
  or the Python sources.

## Tests

```bash
python3 -m unittest discover tests      # server: revisions, validation, snapshots, routing
node --test tests/core.test.js          # merge, migration, filters, units
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node tests/e2e.js
```

All three run against temporary data, never `weed_chart.json`. The browser
test starts its own server on a free port.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `styles.css` | Themes and layout |
| `core.js` | Validation, migration, merge, filters, insights (no DOM) |
| `app.js` | The page: rendering, forms, dialogs, sync |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline shell and install |
| `research.js` | The Research tab: launcher, progress, guide page, charts |
| `fonts/` | Bricolage Grotesque (headings), self-hosted, SIL OFL |
| `ocs.py` | Turns an ocs.ca link into fields |
| `research.py` | Reddit + OCS research runs and the guide writer |
| `llm.py` | Claude / Codex / Grok CLI calls with a JSON schema, and their model lists |
| `serve.py` | Static files, `/api/state`, `/api/snapshots`, `/api/lookup`, `/api/research…` |
| `tests/` | Server, core and browser tests |
