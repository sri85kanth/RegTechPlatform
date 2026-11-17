"""
Pipeline + entity-link read models, served from PostgreSQL (company_brain).

These replace the build-time files public/data/intel/*.json. Every number below
is a COUNT over a real table; when a table is empty the response is empty too.
There is no seed, no sample and no fallback anywhere in this module.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from .api_auth import require

from .db import connect

router = APIRouter(prefix="/api/intel", tags=["intel"],
                   # every route here served company data to anyone —
                   # the login page gated the UI, not the API
                   dependencies=[Depends(require("read"))])

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


@router.get("/ingestion")
def ingestion_stats():
    """Pipeline status broken down by regulator, straight from regulations.ingestion_status."""
    con = connect()
    totals: dict[str, int] = {}
    for status, n in con.execute(
            "SELECT ingestion_status, COUNT(*) FROM regulations GROUP BY 1"):
        totals[status or "UNKNOWN"] = n

    by_source: dict[str, dict[str, int]] = {}
    for src, status, n in con.execute(
            """SELECT COALESCE(NULLIF(regulator_short,''), regulator, 'Unknown'),
                      ingestion_status, COUNT(*)
               FROM regulations GROUP BY 1, 2"""):
        by_source.setdefault(src, {})[status or "UNKNOWN"] = n

    return {
        "generatedAt": _now(),
        "totals": totals,
        "bySource": by_source,
        "provenance": {
            "database": "postgresql/company_brain",
            "query": "SELECT ingestion_status, COUNT(*) FROM regulations GROUP BY regulator_short, ingestion_status",
        },
    }


@router.get("/entities")
def intel_entities():
    """
    Which regulations reference each Company Brain entity.

    Built from company_mappings — the matching engine's output. Rows are
    proposals awaiting human approval, so `status` travels with every link and
    the UI can show that distinction rather than implying an approved mapping.
    """
    con = connect()
    entities: dict[str, dict] = {}
    rows = con.execute(
        """SELECT m.target_id, m.target_domain, m.status, m.confidence,
                  ce.name       AS entity_name,
                  r.id          AS reg_id,
                  r.title       AS reg_title,
                  r.regulator_short,
                  r.impact_level
           FROM company_mappings m
           JOIN obligations  o ON o.id = m.obligation_id
           JOIN regulations  r ON r.id = o.regulation_id
           LEFT JOIN company_entities ce ON ce.id = m.target_id""").fetchall()

    for m in rows:
        e = entities.setdefault(m["target_id"], {
            "name": m["entity_name"] or m["target_id"],
            "domain": m["target_domain"],
            "regulations": {},
        })
        reg = e["regulations"].setdefault(m["reg_id"], {
            "id": m["reg_id"],
            "title": m["reg_title"],
            "regulator": m["regulator_short"],
            "impact": m["impact_level"],
            "confidence": 0,
            "links": 0,
            "status": m["status"],
        })
        reg["links"] += 1
        reg["confidence"] = max(reg["confidence"], m["confidence"] or 0)

    for e in entities.values():
        e["regulations"] = sorted(e["regulations"].values(), key=lambda r: -r["links"])

    return {
        "generatedAt": _now(),
        "entities": entities,
        "provenance": {"database": "postgresql/company_brain", "table": "company_mappings", "rows": len(rows)},
    }
