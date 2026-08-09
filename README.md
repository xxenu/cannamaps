# CannaMap

Netherlands coffeeshop finder. Static PWA — vanilla JS, HTML and CSS, with
Leaflet + OpenStreetMap for the map. No build step, no framework, no bundler.

## Status

The app runs against **real data for 644 shops nationwide** — 561 open, 83
marked permanently closed and kept in the data but off the map. 162 of the open
shops are in Amsterdam.

**Amsterdam has been verified by hand, shop by shop.** The rest of the country
comes straight from the sources below and has not been checked.

549 of the open shops have opening hours; 419 have menu photos.

Menus are displayed as **photos of each shop's own menu board**, not as a
normalized list. Boards differ too much between shops to flatten: tiered gram
pricing (1g / 3g / 5g columns), per-piece edibles, pre-roll sections, and
category systems that exist at one shop and nowhere else. The photo is the
source of truth; the `menu` array stays in the schema as an optional structured
extra for shops where a flat list genuinely fits.

### Where the data comes from

| Field | Source |
| --- | --- |
| Menu photos, logos | coffeeshopmenus.org — Amsterdam via `ams_index.html`, the rest of the country via `town_index.html` (73 towns). **419 of 561 open shops.** |
| Nationwide shop list | greenmeister.com (697 shops) plus 43 that only coffeeshopmenus lists; those carry `unverified: true` since nothing corroborates them. |
| `opening_hours` | coffeeshopdirect.com, with OpenStreetMap filling gaps — **549 of 561 open shops, 98%** |
| `website`, `instagram` | coffeeshopdirect.com. No phone numbers are collected. The sheet renders each link only when the shop has it, and hides the row entirely when it has neither. |
| `lat` / `lng` | coffeeshopdirect.com where available, else [PDOK Locatieserver](https://www.pdok.nl/). The two agree to a **median of 2 m** across 161 shops. |
| `rating`, `rating_count` | **Not imported from anywhere — always `null`.** Reserved for the app's own rating system. The sheet hides the badge until a number is present, so nothing needs changing when it lands. |

The two coordinate sources disagreed by more than 150 m on exactly two shops,
both PDOK street mismatches (Yo-Yo is on *2e* Jan van der Heijdenstraat; PDOK
matched *Eerste*). ACD wins those.

Menu photos and logos come from coffeeshopmenus.org, which permits reuse, so
they are committed and served with the site. The raw scrape working directory
(`coffeeshopmenus/`) stays out of version control — it is a local cache, and
everything the app serves has already been copied into `public/data/`.

## Running it

The app must be served over HTTP (`fetch` of `shops.json` and service-worker
registration both fail on `file://`):

```bash
node tools/serve.js
```

Then open http://localhost:8000. `cd public && python3 -m http.server 8000`
works equally well — `tools/serve.js` is just a zero-dependency equivalent with
the root and port pinned.

## Layout

```
public/
  index.html          markup + Leaflet CDN tags
  app.js              all app logic (single IIFE, no modules)
  style.css           all styling
  sw.js               service worker: shell + shops.json + tile caching
  manifest.json       PWA manifest
  data/shops.json     644 shops (generated — see tools/scrape)
  data/menus/         menu photos (598)
  data/products.json  OCR-derived product search index
  data/zones.json     Amsterdam blowverbod polygons
  data/logos/         shop logos (446)
  icons/              app icons (SVG source + 192/512 PNG)
coffeeshopmenus/      raw scrape working dir, gitignored
coffeeshopdata/       addresses as CSV + JSON (committed — facts only)
tools/serve.js        dev-only static server (not part of the app)
tools/scrape/         the data pipeline, run in numbered order
```

## Regenerating the data

```bash
node tools/scrape/1-crawl-menus.js        # find menu photo URLs
node tools/scrape/2-download-menus.js     # download them
node tools/scrape/3-shops-and-logos.js    # logos + addresses -> coffeeshopdata/
node tools/scrape/4-geocode.js            # addresses -> lat/lng via PDOK
node tools/scrape/5-build-shops-json.js   # assemble public/data/shops.json
# ... steps 6-17 enrich it (hours, nationwide shops, amenities, types) ...
node tools/scrape/19-apply-overrides.js   # DRY RUN — shows what it would fix
node tools/scrape/19-apply-overrides.js --apply
```

All steps are rate-limited and skip files already on disk, so re-running is
cheap and only picks up what's new.

### Step 19 is not optional

Rebuilding `shops.json` from the sources silently undoes every manual
correction — renames, address fixes, merges, deletions, brand logos. Those
corrections live in [`tools/scrape/overrides.json`](tools/scrape/overrides.json)
and step 19 replays them on top of the fresh data. **Always finish a re-scrape
with it**, or shops you deleted will come back and fixed addresses will revert.

The file is declarative, and every entry records *why*:

| Key | Does |
| --- | --- |
| `retype` | Corrects `shop_type` (e.g. a shop the source miscalls a smartshop). |
| `patch` | Sets specific fields — address, `lat`/`lng`, `opening_hours`. |
| `rename` | Renames a shop that rebranded. |
| `merge` | Folds a duplicate into the surviving record, then drops it. Fills only fields the survivor lacks, and skips menu images that aren't on disk. |
| `delete` | Removes a shop, by `id` or by a `match` on several fields. A matcher hitting more than one shop is refused rather than guessed at. |
| `brand_logos` | Stamps an owner-supplied logo onto every shop whose name contains a string. Applied last, so renamed shops are matched under their new name. |

It is idempotent: running it twice changes nothing the second time, so it is
safe to run after any step. It exits non-zero if any entry failed to match,
which is the signal that an override has gone stale and needs review.

## Data model

`shops.json` is `{ version, generated_at, source, shops: [...] }`. The loader
also accepts a bare array. Each shop:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable, unique. Used as the localStorage favorites key. |
| `name` | string | |
| `shop_type` | string | Loose string, **not** an enum. Every record is `"coffeeshop"` today; unknown values still render, with a generated colour. |
| `lat`, `lng` | number | WGS84. |
| `address` | string | Single-line. |
| `opening_hours` | object | Keys `monday`…`sunday`. Value is `"HH:MM-HH:MM"` (24h), or `null` for closed. A closing time earlier than the opening time means it runs past midnight (`"09:00-01:00"`). |
| `rating` | number | e.g. `4.6`. |
| `menu_images` | array | `{ file, label }` — photos of the shop's menu board, the primary menu display. |
| `logo` | string | Path under `data/logos/`, or `""`. Shown in the info sheet. |
| `status` | string | `"open"` or `"closed"`. Closed shops stay in the data but are not mapped; flip `SHOW_CLOSED` in `app.js` to map them. |
| `note` | string | Free text from the source, e.g. `"Later 7th Heaven"`. |
| `menu` | array | `{ name, price, description }`; `price` is a number in EUR. Optional — empty for shops whose board doesn't flatten into a list. |

Adding a new `shop_type` requires no code change. To give it a dedicated colour
and pin icon, add an entry to `TYPE_HINTS` in [`public/app.js`](public/app.js);
without one it falls back to a generated colour and a generic pin. Types listed
in `ALWAYS_ON_TYPES` (currently just `coffeeshop`) are shown by default; every
other type starts hidden, and `visibleTypes` is what the UI would drive if the
per-type filter chips are ever reinstated.

## Features

- Full-screen Leaflet map of the Netherlands on CARTO dark tiles, with pins
  culled to the viewport.
- **Search** over shop name, city, street *and menu product* — typing a strain
  lists the shops selling it, nearest first. See "Product search" below.
- Left navigation rail: saved shops, recently opened, and per-city shortcuts
  built from the data.
- Tapping a pin opens a bottom sheet: name, address, type, rating, open/closed
  right now, the full week of hours with today highlighted, and the menu.
- Per-shop favorite (★), persisted to `localStorage` under
  `cannamap.favorites.v1`; favorited pins get a star badge, and the Saved panel
  can filter the map down to them.
- **Amsterdam's blowverbod zones** drawn from the city's own WFS layer — the
  areas where smoking outdoors is prohibited.
- Your own location, GPS-style, via `watchPosition`.
- "Get Directions" opens
  `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}` — a plain
  link, no Maps SDK.
- Installable PWA; service worker caches the app shell, the data files
  (stale-while-revalidate) and map tiles (cache-first, capped at 400).

Bump `CACHE_VERSION` in [`public/sw.js`](public/sw.js) when shell files change.

## Product search

`public/data/products.json` is an inverted index of **18,093 product terms
across 445 shops**, built by OCR-ing every menu photo with Apple's Vision
framework and filtering the result down to things that look like products.

```bash
swiftc -O tools/ocr/ocr.swift -o tools/ocr/ocr    # build the OCR helper
ls public/data/menus/* | tools/ocr/ocr > tools/ocr/menu-ocr.jsonl
node tools/scrape/20-build-products.js            # -> public/data/products.json
```

It is a search aid, not a price list: names are machine-read from photos and
some are misread, prices are deliberately not captured, and a menu is only as
current as the photo it came from. Product matches sort below every
name/city/street match in the results list.

## Still missing

- **Verification outside Amsterdam** — 399 open shops have never been checked
  by hand.
- **Ratings** — the field exists and is always `null`; no source supplies one.
- **Marker clustering** — the Randstad gets dense at low zoom.
