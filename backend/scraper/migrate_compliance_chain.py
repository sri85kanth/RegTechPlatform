"""
Complete the compliance chain: CONTROL ↔ REQUIREMENT, EVIDENCE, ASSESSMENT.

    REGULATION → CLAUSE → OBLIGATION → REQUIREMENT → APPLICABILITY
              → CONTROL → EVIDENCE → ASSESSMENT → COMPLIANCE RESULT

Everything left of CONTROL already exists and is untouched by this script.
This adds the three links that were missing, and seeds them ONLY from
relationships that are already in the database.

WHAT THIS SCRIPT WILL NOT DO
----------------------------
- It does not create a second requirements store. `requirements` (34,746 rows)
  stays the single source; nothing is copied out of it.
- It does not invent evidence. Evidence rows are migrated from the
  `company_entities` rows that already carry domain='evidence', and from
  `company_documents`. Control links come from the `proves` edges that already
  exist in `entity_relationships` — four of them. If a control has no such
  edge, it gets no evidence, and the UI must say so.
- It does not make anything authoritative. Every derived row is written
  UNREVIEWED with its derivation recorded, because a derived link can never be
  more trustworthy than the link it came from.
- It does not touch REVIEW_REQUIRED applicability verdicts.

    python migrate_compliance_chain.py            # dry run: what would change
    python migrate_compliance_chain.py --apply
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone

from regulatory_ingestion.db import connect

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- schema
# `evidence` ALREADY EXISTS (id, name, evidence_type, owner_id, source_system,
# source_location, period_start, period_end, valid_from, valid_until,
# uploaded_at, content_hash, verification_status, reviewer, review_date,
# created_at) — empty, but its contract is in use. It is NOT recreated here;
# the few fields the compliance chain needs on top are added as columns.
EVIDENCE_COLUMNS = [
    ("description", "TEXT"),
    ("status", "TEXT"),
    ("last_verified_at", "TEXT"),
    ("source_entity_id", "TEXT"),
    ("source_document_id", "TEXT"),
    ("updated_at", "TEXT"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS control_evidence (
  id                  TEXT PRIMARY KEY,
  control_id          TEXT NOT NULL,
  evidence_id         TEXT NOT NULL,
  relationship_type   TEXT NOT NULL DEFAULT 'PROVES',
  verification_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  mapping_method      TEXT NOT NULL DEFAULT 'RULE',
  rationale           TEXT,
  verified_by         TEXT,
  verified_at         TEXT,
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ctl_evi ON control_evidence(control_id, evidence_id);

CREATE TABLE IF NOT EXISTS assessments (
  id                 TEXT PRIMARY KEY,
  cri_id             TEXT NOT NULL,
  requirement_id     TEXT NOT NULL,
  control_id         TEXT,
  result             TEXT NOT NULL,
  method             TEXT NOT NULL,
  confidence         REAL,
  rationale          TEXT NOT NULL,
  evidence_considered TEXT,
  review_status      TEXT NOT NULL DEFAULT 'UNREVIEWED',
  assessed_by        TEXT,
  assessed_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assess_cri ON assessments(cri_id);
CREATE INDEX IF NOT EXISTS idx_assess_req ON assessments(requirement_id);
"""

# control_requirements already exists; these columns bring it up to the
# contract the compliance chain needs. Additive only.
CR_COLUMNS = [
    ("relationship_type", "TEXT"),
    ("mapping_method", "TEXT"),
    ("confidence", "REAL"),
    ("reviewed_by", "TEXT"),
    ("reviewed_at", "TEXT"),
    ("updated_at", "TEXT"),
]


def migrate(con) -> dict:
    con.executescript(SCHEMA)
    added = {"control_requirements": [], "evidence": []}
    for table, cols in (("control_requirements", CR_COLUMNS), ("evidence", EVIDENCE_COLUMNS)):
        for col, typ in cols:
            try:
                con.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {typ}")
                added[table].append(col)
            except Exception:
                pass
    con.commit()
    return {"created_if_absent": ["control_evidence", "assessments"],
            "reused_existing": ["evidence", "control_requirements"],
            "columns_added": added}


# ---------------------------------------------------------------- evidence
def seed_evidence(con, apply: bool) -> dict:
    """
    Migrate the evidence records that already exist, with their real owners.

    Sources, both already in the database:
      company_entities WHERE domain='evidence'   — the register rows
      company_documents                          — uploaded files with a hash
    Owner comes from the existing `owns` edges in entity_relationships.
    Nothing is invented; a record with no owner keeps a null owner.
    """
    owners = {r["target_id"]: r["source_id"] for r in con.execute(
        "SELECT source_id, target_id FROM entity_relationships WHERE type='owns'").fetchall()}

    rows, skipped = [], []
    for e in con.execute(
            """SELECT id, name, description, type, attrs, source, verification
               FROM company_entities WHERE domain='evidence'""").fetchall():
        attrs = {}
        try:
            attrs = json.loads(e["attrs"] or "{}")
        except Exception:
            attrs = {}
        rows.append({
            "id": f"evd-{e['id']}",
            "name": e["name"],
            "description": e["description"],
            "evidence_type": e["type"] or attrs.get("kind"),
            "source": e["source"] or "company register",
            "owner_id": owners.get(e["id"]),
            # A register row states the artefact exists; it does not state a
            # validity window. Inventing dates here would be fabrication.
            "valid_from": None, "valid_until": None,
            "status": "NOT_AVAILABLE" if (e["verification"] or "") != "Verified" else "VERIFIED",
            "content_hash": None,
            "verification_status": "VERIFIED" if (e["verification"] or "") == "Verified" else "PENDING_REVIEW",
            "source_entity_id": e["id"], "source_document_id": None,
        })

    for d in con.execute(
            """SELECT id, name, document_type, status, content_hash, uploaded_at,
                      approved_by, approved_on, source, linked_entity_id
               FROM company_documents""").fetchall():
        rows.append({
            "id": f"evd-doc-{d['id']}",
            "name": d["name"],
            "description": None,
            "evidence_type": d["document_type"] or "document",
            "source": d["source"] or "upload",
            "owner_id": owners.get(d["linked_entity_id"]),
            "valid_from": d["approved_on"] or d["uploaded_at"],
            "valid_until": None,
            "status": "VERIFIED" if d["approved_by"] else "PENDING_REVIEW",
            "content_hash": d["content_hash"],
            "verification_status": "VERIFIED" if d["approved_by"] else "PENDING_REVIEW",
            "source_entity_id": d["linked_entity_id"], "source_document_id": d["id"],
        })

    if apply:
        for r in rows:
            con.execute(
                """INSERT INTO evidence (id,name,description,evidence_type,source_system,owner_id,
                       valid_from,valid_until,status,content_hash,verification_status,
                       source_entity_id,source_document_id,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (id) DO UPDATE SET
                     name=EXCLUDED.name, owner_id=EXCLUDED.owner_id,
                     content_hash=EXCLUDED.content_hash, updated_at=EXCLUDED.updated_at""",
                (r["id"], r["name"], r["description"], r["evidence_type"], r["source"],
                 r["owner_id"], r["valid_from"], r["valid_until"], r["status"],
                 r["content_hash"], r["verification_status"], r["source_entity_id"],
                 r["source_document_id"], _now(), _now()))
        con.commit()
    return {"evidence_rows": len(rows),
            "with_owner": sum(1 for r in rows if r["owner_id"]),
            "with_hash": sum(1 for r in rows if r["content_hash"]),
            "no_validity_window": sum(1 for r in rows if not r["valid_until"]),
            "skipped": skipped}


def seed_control_evidence(con, apply: bool) -> dict:
    """
    The control→evidence links that ALREADY exist as `proves` edges.

    entity_relationships stores them against the ENTITY id of the control
    (con-…), while `controls` keys on ctl-… and carries entity_id — so the
    join is exact, not fuzzy. A control with no `proves` edge gets nothing.
    """
    rows = con.execute(
        """SELECT er.source_id AS evidence_entity, er.target_id AS control_entity,
                  c.id AS control_id
           FROM entity_relationships er
           JOIN controls c ON c.entity_id = er.target_id
           WHERE er.type='proves'""").fetchall()
    made, unmapped = [], []
    for r in rows:
        eid = f"evd-{r['evidence_entity']}"
        if not con.execute("SELECT 1 FROM evidence WHERE id=?", (eid,)).fetchone() and apply:
            unmapped.append(r["evidence_entity"])
            continue
        made.append((r["control_id"], eid))
        if apply:
            con.execute(
                """INSERT INTO control_evidence (id,control_id,evidence_id,relationship_type,
                       verification_status,mapping_method,rationale,created_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT (control_id, evidence_id) DO NOTHING""",
                (f"ce-{hashlib.sha1(f'{r['control_id']}|{eid}'.encode()).hexdigest()[:16]}",
                 r["control_id"], eid, "PROVES", "PENDING_REVIEW", "EXISTING_GRAPH_EDGE",
                 "migrated from the entity_relationships 'proves' edge recorded in the company graph",
                 _now()))
    if apply:
        con.commit()
    # controls with no evidence at all — reported, never invented
    orphan_controls = [r[0] for r in con.execute(
        """SELECT c.id FROM controls c
           WHERE NOT EXISTS (SELECT 1 FROM entity_relationships er
                             WHERE er.type='proves' AND er.target_id=c.entity_id)""").fetchall()]
    return {"links": len(made), "evidence_missing_row": unmapped,
            "controls_without_any_evidence": orphan_controls}


# ---------------------------------------------------------------- assessment
def compute_assessments(con, apply: bool) -> dict:
    """
    An assessment is only computable where the whole chain exists in data:
    a requirement, its company instance, a control mapped to that requirement,
    and evidence proving that control.

    The result is a RULE-derived observation, written UNREVIEWED. It is never
    a compliance decision: a person confirms it. Where evidence carries no
    validity window (which is every register row today) the result is
    INSUFFICIENT_EVIDENCE — that is the honest answer, not PASSED.
    """
    rows = con.execute(
        """SELECT cri.id AS cri_id, cr.requirement_id, cr.control_id,
                  ar.verdict AS applicability,
                  COUNT(ce.evidence_id) AS n_evidence,
                  COUNT(e.valid_until)  AS n_dated
           FROM control_requirements cr
           JOIN company_requirement_instances cri ON cri.requirement_id = cr.requirement_id
           LEFT JOIN applicability_results ar ON ar.id = cri.applicability_result_id
           LEFT JOIN control_evidence ce ON ce.control_id = cr.control_id
           LEFT JOIN evidence e ON e.id = ce.evidence_id
           GROUP BY cri.id, cr.requirement_id, cr.control_id, ar.verdict""").fetchall()
    # An assessment whose control mapping no longer exists is meaningless —
    # control_requirements cascades on requirement_id, so a rebuild upstream
    # can strand rows here. Clear them before recomputing, or the compliance
    # screen would quote a verdict with nothing behind it.
    stale = con.execute(
        """SELECT COUNT(*) FROM assessments a WHERE NOT EXISTS
           (SELECT 1 FROM control_requirements cr
             WHERE cr.requirement_id = a.requirement_id AND cr.control_id = a.control_id)"""
    ).fetchone()[0]
    if apply and stale:
        con.execute(
            """DELETE FROM assessments a WHERE NOT EXISTS
               (SELECT 1 FROM control_requirements cr
                 WHERE cr.requirement_id = a.requirement_id AND cr.control_id = a.control_id)""")
        con.commit()

    made = []
    for r in rows:
        if r["n_evidence"] == 0:
            result, why = "NO_EVIDENCE", "a control is mapped but no evidence proves it operates"
        elif r["n_dated"] == 0:
            result, why = ("INSUFFICIENT_EVIDENCE",
                           f"{r['n_evidence']} evidence record(s) exist but none carries a validity "
                           "period, so operation cannot be asserted for any date")
        else:
            result, why = ("PASSED",
                           f"{r['n_evidence']} evidence record(s), {r['n_dated']} with a validity period")
        made.append(result)
        if apply:
            aid = f"asm-{hashlib.sha1(f'{r['cri_id']}|{r['control_id']}'.encode()).hexdigest()[:16]}"
            con.execute(
                """INSERT INTO assessments (id,cri_id,requirement_id,control_id,result,method,
                       confidence,rationale,evidence_considered,review_status,assessed_at,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (id) DO UPDATE SET result=EXCLUDED.result,
                       rationale=EXCLUDED.rationale, assessed_at=EXCLUDED.assessed_at""",
                (aid, r["cri_id"], r["requirement_id"], r["control_id"], result, "RULE",
                 None, why, str(r["n_evidence"]), "UNREVIEWED", _now(), _now()))
    if apply:
        con.commit()
    from collections import Counter
    return {"assessments": len(made), "by_result": dict(Counter(made)),
            "stale_removed": stale}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()
    out = {"migrate": migrate(con)}          # schema is always safe/idempotent
    out["evidence"] = seed_evidence(con, a.apply)
    out["control_evidence"] = seed_control_evidence(con, a.apply)
    out["assessments"] = compute_assessments(con, a.apply)
    out["applied"] = a.apply
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
