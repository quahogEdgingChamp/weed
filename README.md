# Cloudline

Personal tracker for carts, concentrates, flower, edibles and anything else
worth remembering, plus a shopping list that fills itself in from an
[ocs.ca](https://ocs.ca) product link.

Plain HTML, CSS and JavaScript with a small Python server. No build step, no
dependencies.

## Features

**Collection**

- Add, edit, favorite and delete entries
- Track type, brand, strain, extraction, amount, THC, CBD, terpene percentage
  and breakdown, price, rating, effects, vendor and notes
- Search, filter by type, and sort
- Totals, a count by type, and the strongest THC entries

**Shopping list**

- Paste an ocs.ca product link and the item is added with its name, brand,
  category, THC and CBD ranges, dominant terpenes, size, price and photo
- Anything can also be added by hand
- **Log it** moves an item into the collection with the fields prefilled, then
  takes it off the list

**Data**

- Auto-saves to the browser, and to `weed_chart.json` when served by `serve.py`
- Import and export the whole thing as JSON

## Run

```bash
python3 serve.py
```

Then open <http://127.0.0.1:3002>. Use `--port` and `--host` to change either.

Opening `index.html` directly still works, but without the server there is no
`weed_chart.json` sync and no link lookup: the browser cannot fetch ocs.ca
itself, because the site sends no CORS headers.

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
and CBD numbers written into an entry are its midpoint.

Edibles are dosed in milligrams, so their percentage tags are a flat zero —
those are left blank rather than recorded as "0% THC".

## Data file

- `weed_chart.json` holds `products` and `wishlist`, and stays hand-editable
- The server treats the file's mtime as a revision, so edits made directly to
  it show up in open browsers within a few seconds
- A file that fails to parse is reported as an error, never as "empty", so a
  typo can't cause an empty collection to be synced back over it

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `styles.css` | Dark theme and layout |
| `app.js` | Collection, shopping list, storage, sync |
| `ocs.py` | Turns an ocs.ca link into fields |
| `serve.py` | Static files, `/api/state`, `/api/lookup` |
