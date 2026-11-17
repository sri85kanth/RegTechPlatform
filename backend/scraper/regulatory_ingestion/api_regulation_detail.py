"""
The Regulation, returned in one shaped response.

Seven groups, matching how a compliance reviewer actually reads a regulation:

    Identity · Scope · Structure · Legal Content · Relationships · Versions · Provenance

Everything here is REGULATORY FACT — what the regulator actually said. Company
impact is deliberately absent: it belongs to a different layer and mixing them is
how "the AI thinks this applies" starts looking like "the regulation says this
applies".

Where the source does not state something, the field is null. A blank is a fact
about the regulation, not a gap to be filled.
"""
from fastapi import APIRouter, Depends, HTTPException, Query

from .api_auth import require

from .db import connect

router = APIRouter(prefix="/api/regulation", tags=["regulation"],
                   dependencies=[Depends(require("read"))])


def _rows(con, q, *p):
    return [dict(r) for r in con.execute(q, p)]


def _one(con, q, *p):
    r = con.execute(q, p).fetchone()
    return dict(r) if r else None


@router.get("/{rid}")
def regulation_detail(rid: str, sample: int = Query(50, ge=1, le=500)):
    con = connect()

    reg = _one(con, "SELECT * FROM regulations WHERE id=?", rid)
    if not reg:
        raise HTTPException(404, "no such regulation")

    doc = _one(con, """SELECT id, source_url, document_hash, page_count, file_size,
                              extraction_method, ocr_used, created_at
                       FROM documents WHERE regulation_id=?""", rid)

    # ---------------------------------------------------------------- identity
    identity = {
        "id": reg["id"],
        "title": reg["title"],
        "shortTitle": reg.get("short_title"),
        "regulator": reg["regulator"],
        "regulatorShort": reg.get("regulator_short"),
        "regulationType": reg.get("regulation_type"),
        "notificationNumber": reg.get("notification_number"),
        "circularNumber": reg.get("circular_number"),
        "referenceNumber": reg.get("reference_number"),
        "issuingDepartment": reg.get("issuing_department"),
        "issuingAuthority": reg.get("issuing_authority"),
        # kept separate on purpose — a document's printed date is not the date
        # the rule starts binding
        "issuedDate": reg.get("issued_on"),
        "publishedDate": reg.get("published_date"),
        "effectiveDate": reg.get("effective_from"),
        "status": reg.get("status"),
        "legalAuthority": reg.get("legal_authority"),
        "enablingAct": reg.get("enabling_act"),
        "enablingSection": reg.get("enabling_section"),
        "language": reg.get("language"),
    }

    # ---------------------------------------------------------------- scope
    rules = _rows(con, """SELECT entity_type, applicability, applicability_rule,
                                 source_clause, confidence, subject, jurisdiction,
                                 sector, licence_status, review_status
                          FROM applicability_rules WHERE regulation_id=?
                          ORDER BY confidence DESC NULLS LAST""", rid)
    scope = {
        "jurisdiction": reg.get("jurisdiction"),
        "country": reg.get("country"),
        "state": reg.get("state"),
        "sector": reg.get("sector"),
        "subSector": reg.get("sub_sector"),
        "regions": [r["region"] for r in _rows(con,
            "SELECT region FROM regulation_regions WHERE regulation_id=?", rid)]
            if _table_exists(con, "regulation_regions", "region") else [],
        "sectors": [r["sector"] for r in _rows(con,
            "SELECT sector FROM regulation_sectors WHERE regulation_id=?", rid)]
            if _table_exists(con, "regulation_sectors", "sector") else [],
        "entityTypes": sorted({r["entity_type"] for r in rules if r["entity_type"]}),
        # These are NOT extracted yet. Saying so is more useful than an empty
        # array that reads as "the regulation names none".
        "products": None, "services": None, "channels": None, "customerTypes": None,
        "applicabilityRules": rules,
        "notExtracted": ["products", "services", "channels", "customerTypes"],
    }

    # ---------------------------------------------------------------- structure
    structure = {
        "sections": _one(con, "SELECT COUNT(*) AS n FROM sections WHERE regulation_id=?", rid)["n"],
        "clauses": _one(con, """SELECT COUNT(*) AS n FROM clauses c
                                JOIN sections s ON s.id=c.section_id
                                WHERE s.regulation_id=?""", rid)["n"],
        "tables": _one(con, "SELECT COUNT(*) AS n FROM regulation_tables WHERE regulation_id=?", rid)["n"],
        "tree": _rows(con, f"""SELECT id, section_number, section_title, parent_section_id,
                                      length(section_text) AS chars
                               FROM sections WHERE regulation_id=?
                               ORDER BY id LIMIT {sample}""", rid),
    }

    # ---------------------------------------------------------------- legal content
    prov_counts = _one(con, """
        SELECT
          COUNT(*) FILTER (WHERE is_prohibition) AS prohibitions,
          COUNT(*) FILTER (WHERE is_permission)  AS permissions,
          COUNT(*)                               AS provisions
        FROM legal_provisions WHERE regulation_id=?""", rid) or {}

    legal = {
        "counts": {
            "provisions": prov_counts.get("provisions", 0),
            "prohibitions": prov_counts.get("prohibitions", 0),
            "permissions": prov_counts.get("permissions", 0),
            "obligations": _one(con, "SELECT COUNT(*) AS n FROM obligations WHERE regulation_id=?", rid)["n"],
            "requirements": _one(con, "SELECT COUNT(*) AS n FROM requirements WHERE regulation_id=?", rid)["n"],
            "definitions": _one(con, "SELECT COUNT(*) AS n FROM definitions WHERE regulation_id=?", rid)["n"],
            "conditions": _one(con, """SELECT COUNT(*) AS n FROM provision_conditions pc
                                       JOIN legal_provisions lp ON lp.id=pc.provision_id
                                       WHERE lp.regulation_id=?""", rid)["n"],
            "exceptions": _one(con, """SELECT COUNT(*) AS n FROM provision_exceptions pe
                                       JOIN legal_provisions lp ON lp.id=pe.provision_id
                                       WHERE lp.regulation_id=?""", rid)["n"],
            "thresholds": _one(con, """SELECT COUNT(*) AS n FROM thresholds t
                                       JOIN legal_provisions lp ON lp.id=t.provision_id
                                       WHERE lp.regulation_id=?""", rid)["n"],
            "timingRules": _one(con, """SELECT COUNT(*) AS n FROM timing_rules tr
                                        JOIN legal_provisions lp ON lp.id=tr.provision_id
                                        WHERE lp.regulation_id=?""", rid)["n"],
        },
        "modalityBreakdown": {r["modality"]: r["n"] for r in _rows(con,
            """SELECT modality, COUNT(*) AS n FROM legal_provisions
               WHERE regulation_id=? GROUP BY modality ORDER BY n DESC""", rid)},
        "definitions": _rows(con, f"""SELECT id, term, definition_text, source_section_id
                                      FROM definitions WHERE regulation_id=?
                                      ORDER BY term LIMIT {sample}""", rid),
        "provisions": _rows(con, f"""SELECT lp.id, lp.section_id, lp.actor, lp.modality,
                                            lp.action, lp.object, lp.is_prohibition,
                                            lp.is_permission, lp.source_text, lp.review_status,
                                            s.section_number, s.section_title
                                     FROM legal_provisions lp
                                     LEFT JOIN sections s ON s.id = lp.section_id
                                     WHERE lp.regulation_id=?
                                     ORDER BY lp.is_prohibition DESC, lp.id LIMIT {sample}""", rid),
        "conditions": _rows(con, f"""SELECT pc.provision_id, pc.condition_type, pc.expression
                                     FROM provision_conditions pc
                                     JOIN legal_provisions lp ON lp.id=pc.provision_id
                                     WHERE lp.regulation_id=? LIMIT {sample}""", rid),
        "exceptions": _rows(con, f"""SELECT pe.provision_id, pe.exception_type, pe.expression
                                     FROM provision_exceptions pe
                                     JOIN legal_provisions lp ON lp.id=pe.provision_id
                                     WHERE lp.regulation_id=? LIMIT {sample}""", rid),
        "thresholds": _rows(con, f"""SELECT t.provision_id, t.metric, t.operator, t.value,
                                            t.unit, t.currency, t.source_text
                                     FROM thresholds t
                                     JOIN legal_provisions lp ON lp.id=t.provision_id
                                     WHERE lp.regulation_id=? LIMIT {sample}""", rid),
        "timingRules": _rows(con, f"""SELECT tr.provision_id, tr.rule_type, tr.expression,
                                             tr.value, tr.unit, tr.source_text
                                      FROM timing_rules tr
                                      JOIN legal_provisions lp ON lp.id=tr.provision_id
                                      WHERE lp.regulation_id=? LIMIT {sample}""", rid),
        "reporting": _rows(con, f"""SELECT report_type, recipient, frequency, deadline, source_text
                                    FROM reporting_requirements WHERE regulation_id=? LIMIT {sample}""", rid),
        "records": _rows(con, f"""SELECT record_type, required_record, retention_period, source_text
                                  FROM record_requirements WHERE regulation_id=? LIMIT {sample}""", rid),
        "disclosures": _rows(con, f"""SELECT disclosure_type, audience, channel, timing, source_text
                                      FROM disclosures WHERE regulation_id=? LIMIT {sample}""", rid),
        # Regulatory fact: the duty as the drafter structured it. Verbatim
        # statement, clause path, and whatever the text itself named. Company
        # state (owner, compliance) is NOT here — it lives on the CRI.
        "requirements": _rows(con, f"""SELECT id, obligation_id, statement, source_clause,
                                              frequency, deadline, threshold, condition,
                                              responsible_role, confidence, review_status,
                                              derivation_method
                                       FROM requirements WHERE regulation_id=?
                                       ORDER BY source_clause LIMIT {sample}""", rid),
    }

    # ---------------------------------------------------------------- relationships
    relationships = {
        "crossReferences": _rows(con, f"""SELECT source_reference, relation, target_reference,
                                                 target_regulation_id, resolved, source_text
                                          FROM cross_references WHERE source_regulation_id=?
                                          ORDER BY relation LIMIT {sample}""", rid),
        "amendments": _rows(con, f"""SELECT reference, amended_on, operation, section_number,
                                            raw, url FROM regulation_amendments
                                     WHERE regulation_id=? ORDER BY amended_on DESC LIMIT {sample}""", rid),
        "supersedes": [], "supersededBy": [],
    }

    # ---------------------------------------------------------------- versions
    from .change_status import status_for
    versions = {
        "changeStatus": status_for(con, rid),
        "document": doc,
        "versions": _rows(con, """SELECT id, captured_at, retrieved_at, retrieved_from,
                                         document_hash, page_count, section_count, source_url
                                  FROM document_versions WHERE regulation_id=?
                                  ORDER BY captured_at, id""", rid),
        "changes": _one(con, "SELECT COUNT(*) AS n FROM section_changes WHERE regulation_id=?", rid)["n"],
    }

    # ---------------------------------------------------------------- provenance
    prov = _one(con, """SELECT COUNT(*) AS rows,
                               COUNT(DISTINCT extraction_method) AS methods,
                               AVG(extraction_confidence) AS avg_confidence
                        FROM provenance WHERE regulation_id=?""", rid) or {}
    provenance = {
        "sourceUrl": reg.get("source_url"),
        "officialDocumentUrl": reg.get("official_document_url"),
        "sourceAuthority": reg.get("regulator"),
        "sha256": doc["document_hash"] if doc else None,
        "pageCount": doc["page_count"] if doc else None,
        "extractionMethod": doc["extraction_method"] if doc else None,
        "ocrUsed": bool(doc["ocr_used"]) if doc else None,
        "retrievedAt": doc["created_at"] if doc else None,
        "sourceVerified": bool(reg.get("source_verified")),
        "lastVerifiedAt": reg.get("verified_at"),
        "facts": prov.get("rows", 0),
        "avgExtractionConfidence": round(prov["avg_confidence"], 3) if prov.get("avg_confidence") else None,
        "reviewStatus": _one(con, """SELECT review_status AS s, COUNT(*) AS n FROM provenance
                                     WHERE regulation_id=? GROUP BY review_status
                                     ORDER BY n DESC""", rid),
    }

    return {"identity": identity, "scope": scope, "structure": structure,
            "legal": legal, "relationships": relationships,
            "versions": versions, "provenance": provenance,
            "note": "Regulatory fact only. Company impact lives in a separate layer."}


def _table_exists(con, table: str, column: str) -> bool:
    try:
        return bool(con.execute(
            """SELECT 1 FROM information_schema.columns
               WHERE table_name=? AND column_name=?""", (table, column)).fetchone())
    except Exception:
        return False
