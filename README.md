# Weed Chart

Static personal weed tracker for carts, concentrates, flower, edibles, and other products.

## Features

- Add, edit, and delete product entries
- Track product type, brand, strain, extraction style, amount, THC, CBD, terpene %, terpene breakdown, price, rating, effects, and notes
- Auto-save in browser local storage
- Import data from JSON
- Export data as `weed_chart.json`
- Filter, search, and sort your entries

## Run Locally

This app is plain HTML, CSS, and JavaScript. You can test it in either of these ways.

### Option 1

Open `index.html` directly in your browser.

### Option 2

Serve the folder locally:

```bash
cd /path/to/yartdb
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Data

- Entries are saved in your browser, not on a server
- Export a backup any time with **Export JSON**
- Import a previous backup with **Import JSON**
- The export file name is always `weed_chart.json`

## Files

- `index.html` - main page structure
- `styles.css` - dark theme and layout
- `app.js` - tracker logic, saving, import, and export
