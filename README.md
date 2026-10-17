# LA Housing Tracker

Housing permitted and completed in the City of Los Angeles since 2001, by neighborhood and housing type, shown against interest rates, City/State/federal administrations, and major events.

**Live:** https://shintuzd.github.io/la-permitted-and-completed-housing/

## What it shows

- **Permitted vs. completed.** Permits are counted by issue date (2001 onward). Completions are counted by Certificate of Occupancy (CofO) date (2005 onward, since LADBS didn't record CofO dates before then).
- **Housing types.** ADU (including junior ADUs), single-family (1 unit), duplex–fourplex (2–4), and apartments (5+).
- **New vs. net units.** Net subtracts units removed by demolitions and conversions.
- **Neighborhood filter.** Uses the LA Times neighborhood boundaries. The chart, totals, map, and pipeline views all follow it, and neighborhood events appear when one is selected.
- **Interest rates.** The federal funds rate or the 30-year mortgage rate, from FRED.
- **Pipeline.** Where the units permitted each year stand today (completed, in progress, stalled), and the median time from submittal to issue and from issue to CofO.

The full methodology is at the bottom of the page.

## How it works

```
LADBS permits (3 datasets) ─┐
LADBS Certificates of Occupancy ─┤
LA County parcels + Census geocoder ─┤   pipeline/build.py   ┌─ data/permits.json
LA Times neighborhoods ─┼──────────────────────────▶├─ data/neighborhoods.geojson
FRED interest rates ─┤   (weekly GitHub Action) ├─ data/rates.json
Google Sheets (manual edits) ─┘                       └─ data/events.json, meta.json
                                                              │
                                              index.html + app.js (D3 + MapLibre)
```

Every Monday, [`.github/workflows/update-data.yml`](.github/workflows/update-data.yml) re-downloads every housing permit, rebuilds `data/`, and commits any changes. GitHub Pages then serves the new data. Re-downloading everything takes about 2 minutes. It also picks up new CofO dates on old permits and any fixes LADBS makes.

To run an update right away (for example, after editing the Google Sheet), go to **Actions → Update data → Run workflow**.

## Manual edits (Google Sheets)

Corrections, missing projects, events, and leaders live in Google Sheet tabs. Publish each tab as CSV (**File → Share → Publish to web → [tab] → CSV**) and paste the URLs into [`config.json`](config.json) under `sheets`. Each run saves a copy of every tab to [`manual/`](manual/), so all edits are kept in git history. Until a URL is set, the pipeline reads the CSV in `manual/` instead.

| Tab | Columns | Purpose |
|---|---|---|
| `corrections` | `permit_nbr, field, value, note` | Fix a field on a permit. Allowed fields: `du_changed`, `adu_changed`, `junior_adu`, `issue_date`, `cofo_date`, `submitted_date`, `status_desc`, `lat`, `lon`, `primary_address`. Use field `exclude` with value `TRUE` to drop a permit. |
| `additions` | `permit_nbr, address, lat, lon, submitted_date, issue_date, cofo_date, status, du_changed, adu_changed, junior_adu, note` | Projects missing from the LADBS data. `permit_nbr` is optional. |
| `locations` | `permit_nbr, lat, lon, note` | Coordinates for permits the pipeline couldn't locate (see `review/unmatched_locations.csv`). |
| `events_city` | `start_date, end_date, event, description, source` | Citywide events. Rows with an `end_date` are drawn as shaded eras. |
| `events_neighborhood` | `neighborhood, start_date, end_date, event, description, source` | Shown when that neighborhood is selected. `neighborhood` must exactly match an LA Times name. |
| `leaders` | `office, name, party, start, end` | Mayors, governors, and presidents. Leave `end` blank for whoever is in office. |

Dates can be typed as `2012-04-26`, `April 26, 2012`, or `4/26/2012`. Corrections are applied by permit number on every run, so they survive data refreshes. If a corrected permit disappears from the source, it's listed in `review/correction_issues.csv`.

## Review files

Each run writes these to [`review/`](review/) for hand checking:

| File | What to do |
|---|---|
| `unmatched_locations.csv` | Permits with no coordinates after every lookup, largest first. Add coordinates in the `locations` tab. |
| `possible_duplicates.csv` | Same address and unit count on more than one permit. Exclude real duplicates in `corrections`. |
| `supplements_to_review.csv` | Supplemental permits of 10+ units that changed the unit count. Most are revisions; some may restate a phase of the same building. |
| `finaled_without_cofo.csv` | Finaled permits issued since 2005 that have no CofO date, so they aren't counted as completed. |
| `correction_issues.csv` | Corrections that couldn't be applied. |

## Running locally

```bash
pip install -r requirements.txt
python pipeline/build.py
python -m http.server 8000   # then open http://localhost:8000
```

An optional free [Socrata app token](https://data.lacity.org/profile/edit/developer_settings) avoids rate limits. Set it as the `SOCRATA_APP_TOKEN` environment variable locally, or as a repository secret for the Action.

## Data sources

- LADBS building permits: [before 2010](https://data.lacity.org/d/e67z-kt2n), [2010–2019](https://data.lacity.org/d/dyxf-7hc4), [2020–present](https://data.lacity.org/d/pi9x-tg5x)
- LADBS [Certificates of Occupancy](https://data.lacity.org/d/3f9m-afei)
- [LA Times neighborhood boundaries](https://geohub.lacity.org/datasets/la-times-neighborhood-boundaries)
- [LA County parcels](https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0) and the [U.S. Census geocoder](https://geocoding.geo.census.gov/)
- FRED: [FEDFUNDS](https://fred.stlouisfed.org/series/FEDFUNDS), [MORTGAGE30US](https://fred.stlouisfed.org/series/MORTGAGE30US)
- Basemap: [OpenFreeMap](https://openfreemap.org/), © OpenStreetMap contributors
