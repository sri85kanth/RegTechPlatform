"""
Look a company up in public records while its name is typed, and read what
those records say about it.

WHERE THE DATA COMES FROM
-------------------------
The Global LEI Index, published by GLEIF at https://api.gleif.org — free, no
key, released under CC0 (public domain). For an Indian company the LEI record
carries the Corporate Identification Number exactly as the Companies Register
of the Ministry of Corporate Affairs holds it (registration authority
RA000394), and most records state they were corroborated against that
register. Partnership firms carry their GSTIN instead (RA000754, GST portal).

It covers entities that hold an LEI — every listed company and most borrowers
above the RBI threshold, so most hospitals of any size — not every company in
India. When a company is not there the form says so and is filled by hand;
nothing is guessed to fill the gap.

WHAT IS DELIBERATELY NOT USED
-----------------------------
- MCA21 "View company master data": behind a login and a CAPTCHA. Automating
  either is not something this product does.
- The GST taxpayer search: CAPTCHA.
- data.gov.in's copy of the MCA master data: official and open, but it needs
  the customer's own API key and matches names only exactly. It can become a
  second source once a key is supplied.

THE CIN IS READ, NOT GUESSED
----------------------------
A CIN has a fixed published layout — listing (L/U), a five-digit industry
code, the state of registration, the year, the kind of company, a serial — so
listing status, state and year are read straight off it. The industry code is
shown but NOT turned into a sector: CINs carry NIC-2004 or NIC-2008 codes
depending on when they were issued, and the same digits name different
industries in the two editions (85110 is hospital activities in one and
pre-primary education in the other). A sector suggestion that is wrong half
the time is worse than none.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from .api_auth import require

GLEIF = "https://api.gleif.org/api/v1"
TIMEOUT = 8
SOURCE = {
    "name": "Global LEI Index (GLEIF)",
    "licence": "CC0 — public domain",
    "about": "https://www.gleif.org/en/lei-data/gleif-api",
}

# Registration authorities an Indian LEI record can name, and what the number is.
AUTHORITIES = {
    "RA000394": ("CIN", "Companies Register — Ministry of Corporate Affairs"),
    "RA000754": ("GSTIN", "GST Portal — Goods and Services Tax Network"),
}

CIN_RE = re.compile(r"^([LU])(\d{5})([A-Z]{2})(\d{4})([A-Z]{3})(\d{6})$")
LLPIN_RE = re.compile(r"^[A-Z]{3}-\d{4}$")
LEI_RE = re.compile(r"^[A-Z0-9]{18}[0-9]{2}$")

# State codes as they appear in a CIN and, after "IN-", in an ISO 3166-2
# region. Where a state has been written two ways over the years both are
# listed; no code here stands for two different places.
STATES = {
    "AN": "Andaman and Nicobar Islands", "AP": "Andhra Pradesh", "AR": "Arunachal Pradesh",
    "AS": "Assam", "BR": "Bihar", "CH": "Chandigarh", "CT": "Chhattisgarh", "CG": "Chhattisgarh",
    "DL": "Delhi", "DN": "Dadra and Nagar Haveli", "DD": "Daman and Diu",
    "DH": "Dadra and Nagar Haveli and Daman and Diu", "GA": "Goa", "GJ": "Gujarat",
    "HP": "Himachal Pradesh", "HR": "Haryana", "JH": "Jharkhand", "JK": "Jammu and Kashmir",
    "KA": "Karnataka", "KL": "Kerala", "LA": "Ladakh", "LD": "Lakshadweep", "MH": "Maharashtra",
    "ML": "Meghalaya", "MN": "Manipur", "MP": "Madhya Pradesh", "MZ": "Mizoram", "NL": "Nagaland",
    "OR": "Odisha", "OD": "Odisha", "PB": "Punjab", "PY": "Puducherry", "RJ": "Rajasthan",
    "SK": "Sikkim", "TN": "Tamil Nadu", "TG": "Telangana", "TS": "Telangana", "TR": "Tripura",
    "UP": "Uttar Pradesh", "UR": "Uttarakhand", "UT": "Uttarakhand", "UK": "Uttarakhand",
    "WB": "West Bengal",
}

# The kind of company a CIN states. Only the codes whose meaning is settled;
# any other code is shown as it is, with the legal form the register gives.
CIN_KIND = {
    "PTC": "Private limited company",
    "PLC": "Public limited company",
    "OPC": "One person company",
    "NPL": "Not-for-profit (Section 8) company",
    "GOI": "Company owned by the Government of India",
    "SGC": "Company owned by a State Government",
}


class LookupUnavailable(RuntimeError):
    """The public register could not be reached — the form is filled by hand."""


# ------------------------------------------------------------------ transport
_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def _get(path: str, params: dict | None = None, ttl: int = 600):
    """One GLEIF request, cached briefly: a name typed letter by letter repeats itself."""
    url = f"{GLEIF}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.api+json",
        "User-Agent": "CompanyBrain/1.0 (company onboarding lookup)",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            data = {"data": None}
        else:
            raise LookupUnavailable(f"The public LEI register answered {e.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise LookupUnavailable(f"The public LEI register could not be reached ({e}).") from None
    with _lock:
        if len(_cache) > 512:
            _cache.clear()
        _cache[url] = (now + ttl, data)
    return data


def _records(params: dict) -> list[dict]:
    return (_get("/lei-records", params) or {}).get("data") or []


# ------------------------------------------------------------------ reading
def decode_cin(value: str | None) -> dict | None:
    """What a CIN states by its published layout. None when it is not a CIN."""
    m = CIN_RE.match((value or "").strip().upper())
    if not m:
        return None
    listing, nic, state, year, kind, serial = m.groups()
    return {
        "listed": listing == "L",
        "industryCode": nic,
        "stateCode": state,
        "state": STATES.get(state),
        "year": int(year),
        "kindCode": kind,
        "kind": CIN_KIND.get(kind),
        "serial": serial,
    }


def ist_date(value: str | None) -> str | None:
    """
    The calendar date an Indian registry meant.

    GLEIF stores instants in UTC, and Indian LOUs often entered local midnight,
    so 20 Nov 1989 arrives as "1989-11-19T22:00:00Z" or "…T18:30:00Z". Read in
    India's time it is the date on the certificate again.
    """
    if not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value[:10] or None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (t.astimezone(timezone(timedelta(hours=5, minutes=30)))).date().isoformat()


def _region_state(region: str | None) -> str | None:
    if not region or not region.upper().startswith("IN-"):
        return None
    return STATES.get(region.upper()[3:])


def _address(a: dict | None) -> str | None:
    if not a:
        return None
    parts = [*(a.get("addressLines") or []), a.get("city")]
    tail = " ".join(p for p in (a.get("postalCode"),) if p)
    text = ", ".join(p.strip() for p in parts if p and p.strip())
    return f"{text} {tail}".strip() or None


def _legal_form_name(code: str | None) -> str | None:
    if not code or code == "8888":           # "not on the ELF list"
        return None
    try:
        rec = (_get(f"/entity-legal-forms/{code}", ttl=86400) or {}).get("data") or {}
    except LookupUnavailable:
        return None
    names = (rec.get("attributes") or {}).get("names") or []
    return next((n.get("localName") for n in names if n.get("localName")), None)


def _name(r: dict) -> str:
    return ((r.get("attributes") or {}).get("entity") or {}).get("legalName", {}).get("name") or ""


def _country(r: dict) -> str | None:
    return (((r.get("attributes") or {}).get("entity") or {}).get("legalAddress") or {}).get("country")


def _suggestion(r: dict) -> dict:
    e = r["attributes"]["entity"]
    reg = e.get("registeredAs")
    ra = (e.get("registeredAt") or {}).get("id")
    cin = decode_cin(reg)
    return {
        "lei": r["id"],
        "name": _name(r),
        "registrationNo": reg,
        "registrationKind": AUTHORITIES.get(ra, (None,))[0],
        "city": (e.get("legalAddress") or {}).get("city"),
        "state": (cin or {}).get("state") or _region_state((e.get("headquartersAddress") or {}).get("region"))
        or _region_state((e.get("legalAddress") or {}).get("region")),
        "status": e.get("status"),
    }


def search(q: str, limit: int = 8) -> list[dict]:
    """
    Indian entities whose name — or CIN, or LEI — matches what is typed.

    Three GLEIF searches are merged, because each misses what another finds:
    prefix search restricted to India finds "YASHODA…" but nothing for a
    two-word fragment; fuzzy completion finds "PREMIER HOSPITALS PVT. LTD."
    from "premier hosp" but searches the whole world; full-text completion
    catches words anywhere in the name. Only Indian entities are returned.
    """
    q = " ".join((q or "").split())[:120]
    if len(q) < 3:
        return []
    up = q.upper()
    if CIN_RE.match(up) or LLPIN_RE.match(up):
        recs = _records({"filter[entity.registeredAs]": up, "page[size]": 5})
    elif LEI_RE.match(up):
        recs = _records({"filter[lei]": up})
    else:
        # The three searches do not depend on each other, so they run at once:
        # one after another they took four seconds for a box people type into.
        def attempt(fn):
            try:
                return fn(), False
            except LookupUnavailable:
                return None, True

        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(attempt, lambda p=path, f=field: _get(p, {"field": f, "q": q}))
                    for path, field in (("/autocompletions", "fulltext"),
                                        ("/fuzzycompletions", "entity.legalName"))]
            jobs.append(pool.submit(attempt, lambda: _records({
                "filter[entity.legalName]": f"{q}*",
                "filter[entity.legalAddress.country]": "IN", "page[size]": 10})))
            (auto, auto_failed), (fuzzy, fuzzy_failed), (prefix, prefix_failed) = [j.result() for j in jobs]
        failures = sum((auto_failed, fuzzy_failed, prefix_failed))

        recs = list(prefix or [])
        have = {r.get("id") for r in recs}
        leis: list[str] = []
        for found in (auto, fuzzy):
            for x in (found or {}).get("data") or []:
                lei = (((x.get("relationships") or {}).get("lei-records") or {}).get("data") or {}).get("id")
                if lei and lei not in leis and lei not in have:
                    leis.append(lei)
        # Completions carry a name and an LEI but no country; the records are
        # fetched in one request to keep only the Indian ones.
        if leis:
            got, failed = attempt(lambda: _records({"filter[lei]": ",".join(leis[:40]), "page[size]": 40}))
            recs += got or []
            failures += failed
        if failures >= 3 and not recs:
            raise LookupUnavailable("The public LEI register could not be reached.")

    seen: set[str] = set()
    indian = []
    for r in recs:
        if r.get("id") in seen or _country(r) != "IN":
            continue
        seen.add(r["id"])
        indian.append(r)

    tokens = up.split()

    def rank(r: dict):
        name = _name(r).upper()
        s = 0
        if name.startswith(up):
            s += 100
        elif all(t in name for t in tokens):
            s += 50
        elif any(t in name for t in tokens):
            s += 10
        e = r["attributes"]["entity"]
        if e.get("status") == "ACTIVE":
            s += 5
        if (e.get("registeredAt") or {}).get("id") == "RA000394":
            s += 2
        return (-s, name)

    return [_suggestion(r) for r in sorted(indian, key=rank)[:limit]]


def details(lei: str) -> dict | None:
    """Everything the public record says about one entity, and where it says it."""
    lei = (lei or "").strip().upper()
    if not LEI_RE.match(lei):
        raise ValueError("not an LEI")
    rec = (_get(f"/lei-records/{lei}") or {}).get("data")
    if not rec:
        return None
    a = rec["attributes"]
    e = a["entity"]
    g = a.get("registration") or {}
    reg = e.get("registeredAs")
    ra = (e.get("registeredAt") or {}).get("id")
    kind, authority = AUTHORITIES.get(ra, (None, None))
    cin = decode_cin(reg) if kind in (None, "CIN") else None
    form_code = (e.get("legalForm") or {}).get("id")
    legal_form = _legal_form_name(form_code) or (e.get("legalForm") or {}).get("other") \
        or (cin or {}).get("kind")
    incorporated = ist_date(e.get("creationDate"))
    state = (cin or {}).get("state") \
        or _region_state((e.get("headquartersAddress") or {}).get("region")) \
        or _region_state((e.get("legalAddress") or {}).get("region"))
    registered = _address(e.get("legalAddress"))
    head = _address(e.get("headquartersAddress"))

    notes = []
    if cin and incorporated and int(incorporated[:4]) != cin["year"]:
        notes.append(f"The CIN gives {cin['year']} as the year of incorporation; the LEI record "
                     f"gives {incorporated}. Check the certificate of incorporation.")
    if e.get("status") and e.get("status") != "ACTIVE":
        notes.append(f"The register lists this entity as {e['status'].lower()}.")
    if g.get("status") and g.get("status") != "ISSUED":
        notes.append(f"Its LEI is {g['status'].lower().replace('_', ' ')} — the record may be out of date.")

    return {
        "lei": rec["id"],
        "legalName": e["legalName"]["name"],
        "otherNames": [n.get("name") for n in (e.get("otherNames") or []) if n.get("name")],
        "registrationNo": reg,
        "registrationKind": kind,
        "registrationAuthority": authority,
        "legalForm": legal_form,
        "status": e.get("status"),
        "incorporated": incorporated,
        "registeredAddress": registered,
        "headOfficeAddress": head if head and head != registered else None,
        "hqState": state,
        "listed": cin["listed"] if cin else None,
        "cin": cin,
        "notes": notes,
        "source": {
            **SOURCE,
            "record": f"https://search.gleif.org/#/record/{rec['id']}",
            "lastUpdated": (g.get("lastUpdateDate") or "")[:10] or None,
            "corroboration": g.get("corroborationLevel"),
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


# ------------------------------------------------------------------ API
router = APIRouter(prefix="/api/company/lookup", tags=["company"])
READ = Depends(require("read"))


@router.get("")
def lookup(q: str = "", user=READ):
    """Suggestions while the company name is being typed."""
    try:
        return {"results": search(q), "source": SOURCE}
    except LookupUnavailable as e:
        raise HTTPException(503, str(e)) from None


@router.get("/{lei}")
def lookup_details(lei: str, user=READ):
    """The public record of one entity, mapped onto the profile's fields."""
    try:
        d = details(lei)
    except ValueError:
        raise HTTPException(400, "That is not an LEI.") from None
    except LookupUnavailable as e:
        raise HTTPException(503, str(e)) from None
    if not d:
        raise HTTPException(404, "No public record with that LEI.")
    return d
