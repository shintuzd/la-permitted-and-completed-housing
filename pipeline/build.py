"""
Build the data behind the LA Housing Tracker.

Pulls every housing-related permit from LADBS's three permit datasets, fills missing
Certificate of Occupancy (CofO) dates from the CofO dataset, locates permits with no
coordinates, applies manual corrections and additions, joins each permit to an
LA Times neighborhood, and writes compact JSON files the web page reads.

Run from the repo root:  python pipeline/build.py
"""

import csv
import io
import json
import os
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests
from shapely.geometry import Point, shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MANUAL = ROOT / "manual"
CACHE = ROOT / "cache"
REVIEW = ROOT / "review"
CONFIG = json.loads((ROOT / "config.json").read_text())

SOCRATA = "https://data.lacity.org/resource/{}.json"
PERMIT_DATASETS = {
    "e67z-kt2n": "Permits issued before 2010",
    "dyxf-7hc4": "Permits issued 2010-2019",
    "pi9x-tg5x": "Permits issued 2020-present",
}
COFO_DATASET = "3f9m-afei"
NEIGHBORHOODS_URL = ("https://services5.arcgis.com/7nsPwEMP38bSkCjy/arcgis/rest/services/"
                     "LA_Times_Neighborhoods/FeatureServer/0/query")
PARCELS_URL = ("https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/"
               "LACounty_Parcel/MapServer/0/query")
CENSUS_BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"

START_DATE = CONFIG["start_issue_date"]          # permits issued before this are ignored
STALLED_AFTER_YEARS = CONFIG["stalled_after_years"]

# Statuses for permits with no CofO date. Anything not listed falls into "other".
IN_PROGRESS = {"Issued", "CofO in Progress", "Re-Activate Permit", "CofO Reactivated",
               "Not Ready for Inspection", "Permit Extended"}
STALLED = {"Permit Expired", "Permit Closed", "Refund in Progress", "No Progress", "Intent to Revoke"}
FINALED = {"Permit Finaled", "CofO Corrected", "CofO Superseded", "TCO Issued"}

UNIT_FIELDS = ["du_changed", "adu_changed", "junior_adu"]
PERMIT_FIELDS = ["permit_nbr", "primary_address", "zip_code", "apn", "permit_type", "permit_sub_type",
                 "submitted_date", "issue_date", "cofo_date", "status_desc", "status_date",
                 "lat", "lon"] + UNIT_FIELDS

# Corrections may only touch these fields (plus "exclude" to drop a permit entirely)
CORRECTABLE = {"du_changed", "adu_changed", "junior_adu", "issue_date", "cofo_date",
               "submitted_date", "status_desc", "lat", "lon", "primary_address", "exclude"}

session = requests.Session()
if os.environ.get("SOCRATA_APP_TOKEN"):
    session.headers["X-App-Token"] = os.environ["SOCRATA_APP_TOKEN"]


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def get(url, **kwargs):
    """GET/POST with a few retries; the city portal and Census API occasionally time out."""
    method = kwargs.pop("method", "get")
    for attempt in range(4):
        try:
            r = session.request(method, url, timeout=180, **kwargs)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == 3:
                raise
            log(f"  retrying after error: {e}")
            time.sleep(5 * (attempt + 1))


def soql(dataset, select, where, order, page=50000):
    rows, offset = [], 0
    while True:
        batch = get(SOCRATA.format(dataset), params={
            "$select": select, "$where": where, "$order": order,
            "$limit": page, "$offset": offset}).json()
        rows += batch
        if len(batch) < page:
            return rows
        offset += page


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def day(value):
    """Socrata timestamps -> 'YYYY-MM-DD' (or None)."""
    return value[:10] if value else None


DATE_FORMATS = ["%Y-%m-%d", "%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%B %Y", "%b %Y", "%Y"]
DATE_COLUMNS = {"start_date", "end_date", "start", "end", "issue_date", "cofo_date", "submitted_date"}


def iso_date(value):
    """Accept dates typed in the Sheet as '2012-04-26', 'April 26, 2012', '4/26/2012', etc."""
    value = (value or "").strip()
    if not value:
        return ""
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(value, f).strftime("%Y-%m-%d")
        except ValueError:
            pass
    log(f"  WARNING: couldn't read date '{value}'")
    return value


def read_csv(path):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(f)]


def write_csv(path, rows, fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


# --- Manual inputs (Google Sheets, mirrored into manual/) --------------------------------------

def load_manual(name):
    """Read a manual table from its published Google Sheet if configured, else from manual/<name>.csv.
    A fresh copy of the sheet is saved to manual/ so every change is kept in git history."""
    url = CONFIG["sheets"].get(name)
    path = MANUAL / f"{name}.csv"
    if url:
        text = get(url).content.decode("utf-8-sig")
        path.write_text(text, encoding="utf-8")
    rows = [r for r in read_csv(path) if any(r.values())]
    for r in rows:
        for k in DATE_COLUMNS & r.keys():
            r[k] = iso_date(r[k])
        if name == "corrections" and r.get("field") in DATE_COLUMNS:
            r["value"] = iso_date(r.get("value"))
    return rows


# --- Steps ---------------------------------------------------------------------------------------

def fetch_permits():
    has_units = " OR ".join(f"{f}::number != 0" for f in UNIT_FIELDS)
    where = f"({has_units}) AND issue_date >= '{START_DATE}'"
    permits = {}
    for dataset, label in PERMIT_DATASETS.items():
        rows = soql(dataset, ",".join(PERMIT_FIELDS), where, "permit_nbr")
        log(f"{label}: {len(rows):,} housing permits")
        for r in rows:
            permits[r["permit_nbr"]] = r  # later datasets win if a permit appears twice
    return permits


def fill_cofo_dates(permits):
    """Some completed permits (e.g. 'CofO Corrected') have a blank cofo_date in the permit data
    but a real CofO in LADBS's CofO dataset. Use the earliest CofO issued for that permit."""
    earliest = {r["pcis_permit"]: day(r["d"]) for r in _cofo_rows() if r.get("d")}
    filled = 0
    for p in permits.values():
        if not p.get("cofo_date") and p["permit_nbr"] in earliest:
            p["cofo_date"] = earliest[p["permit_nbr"]]
            p["_cofo_source"] = "cofo_dataset"
            filled += 1
    log(f"Filled {filled:,} blank CofO dates from the CofO dataset")


def _cofo_rows():
    rows, offset, page = [], 0, 50000
    while True:
        batch = get(SOCRATA.format(COFO_DATASET), params={
            "$select": "pcis_permit, min(cofo_issue_date) as d", "$group": "pcis_permit",
            "$order": "pcis_permit", "$limit": page, "$offset": offset}).json()
        rows += batch
        if len(batch) < page:
            return rows
        offset += page


def clean_address(addr):
    addr = re.sub(r"\b(UNIT|BLDG|APT|STE|SPC|#)\s*\S+", "", addr or "", flags=re.I)
    return re.sub(r"\s+", " ", addr).strip()


def locate_missing(permits, manual_locations):
    """Fill coordinates for permits without lat/lon: manual sheet first, then cached lookups,
    then LA County parcel centroids by APN, then the Census address geocoder."""
    cache_path = CACHE / "locations.csv"
    cache = {r["permit_nbr"]: r for r in read_csv(cache_path)}
    manual = {r["permit_nbr"]: r for r in manual_locations if r.get("lat") and r.get("lon")}

    missing = [p for p in permits.values() if not (num(p.get("lat")) and num(p.get("lon")))]
    todo = []
    for p in missing:
        src = manual.get(p["permit_nbr"]) or cache.get(p["permit_nbr"])
        if src:
            p["lat"], p["lon"] = src["lat"], src["lon"]
            p["_loc"] = "manual" if p["permit_nbr"] in manual else src["source"]
        else:
            todo.append(p)
    log(f"{len(missing):,} permits without coordinates; {len(todo):,} need a new lookup")

    # 1) Parcel centroid by APN (AIN in county terms)
    by_apn = {}
    for p in todo:
        apn = re.sub(r"\D", "", p.get("apn") or "")
        if len(apn) == 10:
            by_apn.setdefault(apn, []).append(p)
    apns = list(by_apn)
    for i in range(0, len(apns), 200):
        chunk = apns[i:i + 200]
        res = get(PARCELS_URL, method="post", data={
            "where": "AIN IN ({})".format(",".join(f"'{a}'" for a in chunk)),
            "outFields": "AIN,CENTER_LAT,CENTER_LON", "returnGeometry": "false", "f": "json"}).json()
        for feat in res.get("features", []):
            a = feat["attributes"]
            if a.get("CENTER_LAT"):
                for p in by_apn.get(a["AIN"], []):
                    p["lat"], p["lon"], p["_loc"] = a["CENTER_LAT"], a["CENTER_LON"], "parcel"
                    cache[p["permit_nbr"]] = {"permit_nbr": p["permit_nbr"], "lat": round(a["CENTER_LAT"], 6),
                                              "lon": round(a["CENTER_LON"], 6), "source": "parcel"}
    found_apn = sum(1 for p in todo if p.get("_loc") == "parcel")
    log(f"  parcel numbers matched: {found_apn:,}")

    # 2) County parcel records by situs address (house number + street name)
    remaining = [p for p in todo if not p.get("_loc")]
    parsed = {}
    for p in remaining:
        m = re.match(r"^(\d+)\s+(?:[NSEW]\s+)?([A-Z0-9']+)", clean_address(p.get("primary_address")).upper())
        if m:
            parsed.setdefault((m[1], m[2]), []).append(p)
    keys = list(parsed)
    found_county = 0
    for i in range(0, len(keys), 25):
        chunk = keys[i:i + 25]
        where = " OR ".join(f"(SitusHouseNo='{h}' AND SitusStreet LIKE '{s.replace(chr(39), chr(39) * 2)} %')"
                            for h, s in chunk)
        res = get(PARCELS_URL, method="post", data={
            "where": f"SitusCity LIKE 'LOS ANGELES%' AND ({where})",
            "outFields": "SitusHouseNo,SitusStreet,CENTER_LAT,CENTER_LON", "returnGeometry": "false", "f": "json"}).json()
        hits = {}
        for feat in res.get("features", []):
            a = feat["attributes"]
            if a.get("CENTER_LAT"):
                key = (a["SitusHouseNo"].strip(), a["SitusStreet"].split(" ")[0])
                hits.setdefault(key, []).append((a["CENTER_LAT"], a["CENTER_LON"]))
        for key, coords in hits.items():
            lats, lons = [c[0] for c in coords], [c[1] for c in coords]
            if max(lats) - min(lats) > 0.005 or max(lons) - min(lons) > 0.005:
                continue  # same address on two different streets in the city: ambiguous, skip
            lat, lon = sum(lats) / len(lats), sum(lons) / len(lons)
            for p in parsed.get(key, []):
                p["lat"], p["lon"], p["_loc"] = lat, lon, "county_address"
                cache[p["permit_nbr"]] = {"permit_nbr": p["permit_nbr"], "lat": round(lat, 6),
                                          "lon": round(lon, 6), "source": "county_address"}
                found_county += 1
    log(f"  addresses matched in County parcel records: {found_county:,}")

    # 3) Census batch geocoder by address
    remaining = [p for p in todo if not p.get("_loc") and p.get("primary_address")]
    found_census = 0
    for i in range(0, len(remaining), 5000):
        chunk = remaining[i:i + 5000]
        buf = io.StringIO()
        w = csv.writer(buf)
        for p in chunk:
            w.writerow([p["permit_nbr"], clean_address(p["primary_address"]), "Los Angeles", "CA",
                        (p.get("zip_code") or "")[:5]])
        try:
            res = get(CENSUS_BATCH_URL, method="post", data={"benchmark": "Public_AR_Current"},
                      files={"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")})
        except requests.RequestException as e:
            log(f"  Census geocoder unavailable ({e}); will retry next run")
            break
        lookup = {p["permit_nbr"]: p for p in chunk}
        for row in csv.reader(io.StringIO(res.text)):
            if len(row) >= 6 and row[2] == "Match" and row[0] in lookup:
                lon, lat = (float(v) for v in row[5].split(","))
                p = lookup[row[0]]
                p["lat"], p["lon"], p["_loc"] = lat, lon, "census"
                cache[p["permit_nbr"]] = {"permit_nbr": p["permit_nbr"], "lat": round(lat, 6),
                                          "lon": round(lon, 6), "source": "census"}
                found_census += 1
    log(f"  addresses matched by Census geocoder: {found_census:,}")

    # 4) Retired parcel numbers (lots later subdivided or merged): use the center of the parcels
    #    that share the same Assessor map book/page/block (first 8 digits). Approximate location.
    remaining = [p for p in todo if not p.get("_loc") and len(re.sub(r"\D", "", p.get("apn") or "")) == 10]
    by_block = {}
    for p in remaining:
        by_block.setdefault(re.sub(r"\D", "", p["apn"])[:8], []).append(p)
    blocks = list(by_block)
    for i in range(0, len(blocks), 40):
        chunk = blocks[i:i + 40]
        res = get(PARCELS_URL, method="post", data={
            "where": " OR ".join(f"AIN LIKE '{b}%'" for b in chunk),
            "outFields": "AIN,CENTER_LAT,CENTER_LON", "returnGeometry": "false", "f": "json"}).json()
        pts = {}
        for feat in res.get("features", []):
            a = feat["attributes"]
            if a.get("CENTER_LAT"):
                pts.setdefault(a["AIN"][:8], []).append((a["CENTER_LAT"], a["CENTER_LON"]))
        for block, coords in pts.items():
            lat = sum(c[0] for c in coords) / len(coords)
            lon = sum(c[1] for c in coords) / len(coords)
            for p in by_block.get(block, []):
                p["lat"], p["lon"], p["_loc"] = lat, lon, "parcel_block"
                cache[p["permit_nbr"]] = {"permit_nbr": p["permit_nbr"], "lat": round(lat, 6),
                                          "lon": round(lon, 6), "source": "parcel_block"}
    log(f"  placed at Assessor block center (approximate): "
        f"{sum(1 for p in remaining if p.get('_loc') == 'parcel_block'):,}")

    write_csv(cache_path, sorted(cache.values(), key=lambda r: r["permit_nbr"]),
              ["permit_nbr", "lat", "lon", "source"])
    unmatched = sorted((p for p in todo if not p.get("_loc")),
                       key=lambda p: -sum(num(p.get(f)) for f in UNIT_FIELDS))
    write_csv(REVIEW / "unmatched_locations.csv",
              [{**p, "units": int(sum(num(p.get(f)) for f in UNIT_FIELDS))} for p in unmatched],
              ["permit_nbr", "primary_address", "zip_code", "apn", "issue_date", "units", "lat", "lon"])
    log(f"  still unlocated: {len(unmatched):,} (see review/unmatched_locations.csv)")


def apply_corrections(permits, corrections):
    issues = []
    for c in corrections:
        nbr, field, value = c.get("permit_nbr"), c.get("field"), c.get("value", "")
        if not nbr or not field:
            continue
        if field not in CORRECTABLE:
            issues.append({**c, "issue": f"field '{field}' can't be corrected"})
        elif nbr not in permits:
            issues.append({**c, "issue": "permit not found (outside date range, no units, or renumbered)"})
        elif field == "exclude":
            if value.lower() in ("true", "yes", "1", "x"):
                permits[nbr]["_exclude"] = True
        else:
            permits[nbr][field] = value or None
            permits[nbr]["_corrected"] = True
    write_csv(REVIEW / "correction_issues.csv", issues, ["permit_nbr", "field", "value", "note", "issue"])
    log(f"Applied {len(corrections) - len(issues):,} corrections ({len(issues)} issues)")


def add_projects(permits, additions):
    for i, a in enumerate(additions, 1):
        nbr = a.get("permit_nbr") or f"MANUAL-{i:04d}"
        permits[nbr] = {
            "permit_nbr": nbr, "primary_address": a.get("address"), "lat": a.get("lat"), "lon": a.get("lon"),
            "issue_date": a.get("issue_date") or None, "cofo_date": a.get("cofo_date") or None,
            "submitted_date": a.get("submitted_date") or None, "status_desc": a.get("status") or "Issued",
            "du_changed": a.get("du_changed"), "adu_changed": a.get("adu_changed"),
            "junior_adu": a.get("junior_adu"), "permit_type": "Manual entry", "_loc": "manual", "_manual": True,
        }
    log(f"Added {len(additions):,} manual projects")


def fetch_neighborhoods():
    path = DATA / "neighborhoods.geojson"
    if not path.exists():  # boundaries haven't changed since 2018; download once
        gj = get(NEIGHBORHOODS_URL, params={"where": "1=1", "outFields": "name", "f": "geojson",
                                            "geometryPrecision": 5}).json()
        gj["features"].sort(key=lambda f: f["properties"]["name"])
        for f in gj["features"]:
            f["properties"] = {"name": f["properties"]["name"]}
        path.write_text(json.dumps(gj, separators=(",", ":")))
    gj = json.loads(path.read_text())
    return [(f["properties"]["name"], shape(f["geometry"])) for f in gj["features"]]


def assign_neighborhoods(permits, hoods):
    prepared = [(name, prep(geom), geom.bounds, geom) for name, geom in hoods]
    unassigned = 0
    for p in permits.values():
        lat, lon = num(p.get("lat")), num(p.get("lon"))
        p["_nb"] = None
        if not (lat and lon):
            continue
        pt = Point(lon, lat)
        for name, pg, (x0, y0, x1, y1), _ in prepared:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and pg.contains(pt):
                p["_nb"] = name
                break
        else:
            # Points just outside a boundary (e.g. parcel centroids on an edge): snap if within ~150 m
            nearest = min(prepared, key=lambda h: h[3].distance(pt))
            if nearest[3].distance(pt) < 0.0015:
                p["_nb"] = nearest[0]
            else:
                unassigned += 1
    log(f"Neighborhood join done ({unassigned:,} located permits fall outside all 114 neighborhoods)")


def classify_status(p, today):
    if p.get("cofo_date"):
        return "C"  # completed
    status = p.get("status_desc") or ""
    if status in STALLED:
        return "S"
    if status in FINALED:
        return "F"  # finaled / corrected but no CofO date on record
    if status in IN_PROGRESS:
        issued = p.get("issue_date")
        if issued and (today - date.fromisoformat(issued[:10])).days > STALLED_AFTER_YEARS * 365.25:
            return "S"
        return "P"
    return "S" if status else "P"


PERMIT_NBR = re.compile(r"^(\d{5})-(\d)(\d{4})-(\d{5})$")


def drop_supplement_repeats(permits):
    """LADBS supplemental permits share the original's number with a higher middle segment
    (e.g. 01010-10000-00132 -> 01010-10001-00132). Many repeat the original's full unit count,
    which would count the same building twice. Exclude those; keep supplements that change the
    count (revisions), and list large ones for review."""
    families = {}
    for p in permits.values():
        m = PERMIT_NBR.match(p["permit_nbr"])
        if m:
            families.setdefault((m[1], m[2], m[4]), []).append(p)
    dropped, review = 0, []
    for members in families.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda p: p["permit_nbr"])
        seen = []
        for p in members:
            du = num(p.get("du_changed"))
            earlier = next((q for q in seen if du > 0 and num(q.get("du_changed")) == du), None)
            if earlier and not p.get("_corrected"):
                p["_exclude"] = True
                dropped += 1
                if p.get("cofo_date") and not earlier.get("cofo_date"):
                    earlier["cofo_date"] = p["cofo_date"]  # keep the completion on the original
            elif seen and du >= 10:
                review.append({"permit_nbr": p["permit_nbr"], "original_permit": members[0]["permit_nbr"],
                               "address": p.get("primary_address"), "units": int(du),
                               "original_units": int(num(members[0].get("du_changed"))),
                               "issue_date": day(p.get("issue_date")), "status_desc": p.get("status_desc")})
            seen.append(p)
    write_csv(REVIEW / "supplements_to_review.csv", review,
              ["permit_nbr", "original_permit", "address", "units", "original_units", "issue_date", "status_desc"])
    log(f"Excluded {dropped:,} supplemental permits that repeat the original's unit count; "
        f"{len(review):,} larger supplements listed for review")


def drop_restated_units(permits):
    """Some projects carry the same unit count on more than one permit type: a parking structure
    ('Nonbldg-New') or a later Addition / Alter-Repair permit restating the new building's units.
    Non-building permits never contain homes, so drop them; and at an address with a new-building
    permit, drop other permit types that repeat its exact unit count."""
    dropped = 0
    for p in permits.values():
        if (p.get("permit_type") or "").startswith("Nonbldg") and not p.get("_corrected"):
            p["_exclude"] = True
            dropped += 1
    groups = {}
    for p in permits.values():
        du = num(p.get("du_changed"))
        if du >= 5 and p.get("primary_address") and not p.get("_exclude"):
            groups.setdefault((clean_address(p["primary_address"]).upper(), du), []).append(p)
    for members in groups.values():
        new = [p for p in members if p.get("permit_type") == "Bldg-New"]
        if not new or len(members) < 2:
            continue
        keep = new[0]
        for p in members:
            if p.get("permit_type") != "Bldg-New" and not p.get("_corrected"):
                p["_exclude"] = True
                dropped += 1
                if p.get("cofo_date") and not keep.get("cofo_date"):
                    keep["cofo_date"] = p["cofo_date"]
    log(f"Excluded {dropped:,} non-building or restated permits that repeat a project's units")


def flag_duplicates(permits):
    """Report (not remove) permits that look like the same project entered twice."""
    groups = {}
    for p in permits.values():
        du = num(p.get("du_changed"))
        if du >= 5 and p.get("primary_address") and not p.get("_exclude"):
            key = (clean_address(p["primary_address"]).upper(), int(du))
            groups.setdefault(key, []).append(p)
    rows = []
    for (addr, du), ps in groups.items():
        if len(ps) > 1:
            for p in sorted(ps, key=lambda p: p.get("issue_date") or ""):
                rows.append({"address": addr, "units": du, "permit_nbr": p["permit_nbr"],
                             "permit_type": p.get("permit_type"), "issue_date": day(p.get("issue_date")),
                             "status_desc": p.get("status_desc"), "cofo_date": day(p.get("cofo_date"))})
    write_csv(REVIEW / "possible_duplicates.csv", rows,
              ["address", "units", "permit_nbr", "permit_type", "issue_date", "status_desc", "cofo_date"])
    log(f"Possible duplicate projects to review: {len({(r['address'], r['units']) for r in rows}):,}")


def write_permits(permits, hood_names):
    today = date.today()
    nb_index = {n: i for i, n in enumerate(hood_names)}
    loc_codes = {"parcel": "a", "county_address": "c", "census": "g", "parcel_block": "b", "manual": "m"}
    cols = {k: [] for k in ["id", "addr", "nb", "lat", "lon", "submit", "issue", "cofo",
                            "du", "adu", "jadu", "status", "new", "loc"]}
    status_counts = {}
    kept = [p for p in permits.values() if not p.get("_exclude") and p.get("issue_date")]
    kept.sort(key=lambda p: p["issue_date"])
    for p in kept:
        st = classify_status(p, today)
        status_counts[st] = status_counts.get(st, 0) + 1
        lat, lon = num(p.get("lat")), num(p.get("lon"))
        cols["id"].append(p["permit_nbr"])
        addr = (p.get("primary_address") or "").title()
        cols["addr"].append(re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m[1] + m[2].lower(), addr))  # 22Nd -> 22nd
        cols["nb"].append(nb_index.get(p.get("_nb"), -1))
        cols["lat"].append(round(lat, 5) if lat else None)
        cols["lon"].append(round(lon, 5) if lon else None)
        cols["submit"].append(day(p.get("submitted_date")))
        cols["issue"].append(day(p.get("issue_date")))
        cols["cofo"].append(day(p.get("cofo_date")))
        cols["du"].append(int(num(p.get("du_changed"))))
        cols["adu"].append(int(num(p.get("adu_changed"))))
        cols["jadu"].append(int(num(p.get("junior_adu"))))
        cols["status"].append(st)
        cols["new"].append(1 if p.get("permit_type") == "Bldg-New" else 0)
        cols["loc"].append(loc_codes.get(p.get("_loc"), ""))
    # One permit per line, so each weekly commit only touches the permits that changed
    names = list(cols)
    rows = (json.dumps([cols[k][i] for k in names], separators=(",", ":")) for i in range(len(kept)))
    header = json.dumps({"neighborhoods": hood_names, "columns": names}, separators=(",", ":"))
    (DATA / "permits.json").write_text(header[:-1] + ',"rows":[\n' + ",\n".join(rows) + "\n]}\n")
    log(f"Wrote {len(kept):,} permits to data/permits.json; status counts {status_counts}")
    return status_counts


def write_missing_cofo(permits):
    rows = [p for p in permits.values()
            if not p.get("cofo_date") and p.get("status_desc") in FINALED
            and (p.get("issue_date") or "") >= CONFIG["pipeline_start_issue_date"]
            and sum(max(num(p.get(f)), 0) for f in UNIT_FIELDS) > 0]  # demolitions never get a CofO
    write_csv(REVIEW / "finaled_without_cofo.csv",
              [{**p, "units": int(sum(num(p.get(f)) for f in UNIT_FIELDS)),
                "issue_date": day(p.get("issue_date")), "status_date": day(p.get("status_date"))} for p in rows],
              ["permit_nbr", "primary_address", "permit_type", "issue_date", "status_desc", "status_date", "units"])
    log(f"Finaled/corrected permits (issued 2005+) still without a CofO date: {len(rows):,}")


def fetch_rates():
    out = {}
    for series in ["FEDFUNDS", "MORTGAGE30US"]:
        rows = list(csv.DictReader(io.StringIO(get(FRED_URL.format(series)).text)))
        monthly = {}
        for r in rows:
            v = r.get(series)
            if v and v != ".":
                monthly.setdefault(r["observation_date"][:7], []).append(float(v))
        out[series] = [[m, round(sum(v) / len(v), 3)] for m, v in sorted(monthly.items()) if m >= START_DATE[:7]]
    (DATA / "rates.json").write_text(json.dumps(out, separators=(",", ":")))
    log("Wrote interest rates (FEDFUNDS, MORTGAGE30US)")


def write_events(hood_names):
    city = load_manual("events_city")
    hood = load_manual("events_neighborhood")
    leaders = load_manual("leaders")
    bad = [e for e in hood if e.get("neighborhood") not in hood_names]
    for e in bad:
        log(f"  WARNING: neighborhood event '{e.get('event')}' has unknown neighborhood '{e.get('neighborhood')}'")
    out = {"city": city, "neighborhood": [e for e in hood if e not in bad], "leaders": leaders}
    (DATA / "events.json").write_text(json.dumps(out, separators=(",", ":")))
    log(f"Wrote {len(city)} citywide events, {len(hood) - len(bad)} neighborhood events, {len(leaders)} leader terms")


def main():
    for d in (DATA, MANUAL, CACHE, REVIEW):
        d.mkdir(exist_ok=True)
    corrections = load_manual("corrections")
    additions = load_manual("additions")
    manual_locations = load_manual("locations")

    permits = fetch_permits()
    fill_cofo_dates(permits)
    apply_corrections(permits, corrections)
    drop_supplement_repeats(permits)
    drop_restated_units(permits)
    add_projects(permits, additions)
    locate_missing({k: p for k, p in permits.items() if not p.get("_exclude")}, manual_locations)
    hoods = fetch_neighborhoods()
    assign_neighborhoods(permits, hoods)
    flag_duplicates(permits)
    write_missing_cofo(permits)
    hood_names = [n for n, _ in hoods]
    status_counts = write_permits(permits, hood_names)
    fetch_rates()
    write_events(hood_names)

    meta = {"updated": datetime.now().strftime("%Y-%m-%d"), "start_issue_date": START_DATE,
            "cofo_start_date": CONFIG["cofo_start_date"], "pipeline_start_issue_date": CONFIG["pipeline_start_issue_date"],
            "stalled_after_years": STALLED_AFTER_YEARS, "status_counts": status_counts}
    (DATA / "meta.json").write_text(json.dumps(meta, indent=2))
    log("Done")


if __name__ == "__main__":
    sys.exit(main())
