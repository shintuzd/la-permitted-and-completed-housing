# LA Housing Tracker

An interactive dashboard of housing permitted and completed in the City of Los Angeles by neighborhood and housing type derived from LADBS permitting data. It shows the data alongside interest rates, City, State, and federal administrations, and the events that shaped housing production.

**Live:** https://shintuzd.com/la-permitted-and-completed-housing/

## What it shows

- **Permitted vs. completed.** Permits are counted by issue date (2001 onward). Completions are counted by Certificate of Occupancy (CofO) date (2005 onward.
- **Housing types.** ADUs, single-family homes, duplex–fourplex, and apartments (5+).
- **New vs. net units.** Net subtracts units removed by demolitions and conversions.
- **Neighborhoods.** Every permit is geotagged to its neighborhood. The chart, totals, map, and pipeline views can all be filtered to one neighborhood, which also shows that neighborhood's events, such as transit openings.
- **Date range.** Presets (this year, last 12 months, last 5 years) or custom dates, shared by every view.
- **Interest rates.** The federal funds rate or the 30-year mortgage rate, from FRED.
- **Pipeline.** Where the units permitted each year stand today (completed, in progress, stalled), and the median time from submittal to issue and from issue to CofO.

The page's methodology section covers every definition in detail.

A Python pipeline runs weekly on GitHub Actions. It re-downloads every housing-related permit from the City's open data portal and rebuilds the static data files. GitHub Pages serves them to the page, which does all filtering and aggregation in the browser. Re-downloading everything each week, instead of only new rows, also picks up Certificates of Occupancy issued for older permits and any fixes LADBS makes to its records.

## Data cleaning

The raw permit data needs work before it can be summed reliably:

- **Types.** The portal stores unit counts as text, so the pipeline converts them to numbers.
- **Missing CofO dates.** Some completed permits have a blank CofO date in the permit data but a CofO in LADBS's separate Certificate of Occupancy dataset. The earliest CofO for the permit is used.
- **Double counting.** Supplemental permits that repeat the original permit's unit count are excluded. So are non-building permits (such as parking structures) and Addition or Alter/Repair permits that restate a new building's units at the same address.
- **Locations.** Permits without coordinates are located by parcel number, then by address using LA County parcel records and the U.S. Census geocoder. Parcels that have since been renumbered are placed at the center of their Assessor block.
- **Manual corrections.** Known errors, such as square footage entered as a unit count, are corrected by permit number. Projects missing from the LADBS data are added by hand. These live in a curated sheet that the pipeline reads on each run (copies are kept in [`manual/`](manual/)), so corrections survive every refresh.
- **Review lists.** Each run writes possible duplicates, unlocated permits, and other edge cases to [`review/`](review/) for checking.

## Repository layout

| Path | Contents |
|---|---|
| `index.html`, `app.js`, `style.css` | The dashboard (D3 for charts, MapLibre GL for the map) |
| `pipeline/build.py` | Data pipeline |
| `data/` | Generated data the page loads |
| `manual/` | Snapshots of the curated corrections, additions, events, and leaders |
| `review/` | Data-quality lists generated each run |
| `cache/` | Cached location lookups, so each address is only geocoded once |
| `.github/workflows/update-data.yml` | Weekly data refresh |

## Run it locally

```bash
pip install -r requirements.txt
python pipeline/build.py
python -m http.server 8000   # open http://localhost:8000
```

## Data sources

- LADBS building permits: [before 2010](https://data.lacity.org/d/e67z-kt2n), [2010–2019](https://data.lacity.org/d/dyxf-7hc4), [2020–present](https://data.lacity.org/d/pi9x-tg5x)
- LADBS [Certificates of Occupancy](https://data.lacity.org/d/3f9m-afei)
- [LA Times neighborhood boundaries](https://geohub.lacity.org/datasets/la-times-neighborhood-boundaries)
- [LA County parcels](https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0) and the [U.S. Census geocoder](https://geocoding.geo.census.gov/)
- FRED: [FEDFUNDS](https://fred.stlouisfed.org/series/FEDFUNDS), [MORTGAGE30US](https://fred.stlouisfed.org/series/MORTGAGE30US)
- Basemap: [OpenFreeMap](https://openfreemap.org/), © OpenStreetMap contributors
