"""
Regulatory API — the only source the production UI may read.

Every record here comes from the database, which is populated exclusively by
the scraper. There is no fallback, no seed and no demo path: if the database is
empty the endpoints return empty arrays, never invented content.

Change status is deliberately explicit. "A footnote in the PDF says this clause
was amended" and "we compared two captures and the text moved" are different
claims, and the API never lets the first masquerade as the second.
"""
import json
from enum import Enum

from . import change_status as _status

from fastapi import APIRouter, Depends, HTTPException, Query
from .api_auth import require

from .db import connect

router = APIRouter(prefix="/api/regulations", tags=["regulations"],
                   # every route here served company data to anyone —
                   # the login page gated the UI, not the API
                   dependencies=[Depends(require("read"))])


class ChangeStatus(str, Enum):
    NOT_CHECKED = "NOT_CHECKED"                  # never fetched a second time
    INSUFFICIENT_HISTORY = "INSUFFICIENT_HISTORY"  # one capture only
    CHECKED_UNCHANGED = "CHECKED_UNCHANGED"      # re-fetched, hash identical
    CHANGE_DETECTED = "CHANGE_DETECTED"          # two captures, text moved
    AMENDMENT_MENTIONED = "AMENDMENT_MENTIONED"  # the document says so itself


STATUS_MESSAGE = {
    ChangeStatus.NOT_CHECKED:
        "This document has not been re-checked since it was first retrieved.",
    ChangeStatus.INSUFFICIENT_HISTORY:
        "This document has only one captured version. A change comparison will be "
        "available after a subsequent crawl.",
    ChangeStatus.CHECKED_UNCHANGED:
        "No document change detected — the source was re-fetched and its content hash was identical.",
    ChangeStatus.CHANGE_DETECTED:
        "The source document changed between two captures.",
    ChangeStatus.AMENDMENT_MENTIONED:
        "The document itself records amendments in its footnotes. This is the regulator's "
        "own statement, not a comparison performed by this system.",
}


def _con():
    con = connect()
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _rows(con, q, *p):
    return [dict(r) for r in con.execute(q, p).fetchall()]


# Search inside the documents: which regulations carry a term somewhere in
# their 1 GB of clause text or their obligations. One lookup per term, cached,
# because the list and each of the ten facet counts used to repeat the scan for
# every keystroke — a three-word search pinned every core for minutes. Filler
# words still match titles, they just do not trawl the clause text, where
# "for" or "the" hits every regulation and narrows nothing.
_STOP = {"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
         "it", "of", "on", "or", "the", "to", "with", "under", "its", "this", "that"}
_TERM_CACHE: dict[str, tuple[float, list[str]]] = {}
_TERM_TTL = 600


def _text_hits(term: str) -> list[str] | None:
    """Regulation ids whose clauses or obligations contain `term`; None = skip."""
    import time
    if term in _STOP or len(term) < 3:
        return None
    hit = _TERM_CACHE.get(term)
    if hit and time.time() - hit[0] < _TERM_TTL:
        return hit[1]
    like = f"%{term}%"
    con = connect()
    try:
        ids = [r[0] for r in con.execute(
            """SELECT regulation_id FROM sections WHERE lower(section_text) LIKE ?
               UNION
               SELECT regulation_id FROM obligations WHERE lower(COALESCE(title,'')) LIKE ?""",
            (like, like)).fetchall()]
    finally:
        con.close()
    if len(_TERM_CACHE) > 256:
        _TERM_CACHE.clear()
    _TERM_CACHE[term] = (time.time(), ids)
    return ids


def _provenance(con, rid: str) -> dict:
    """Where this regulation came from — never inferred, only what was recorded."""
    r = con.execute(
        """SELECT r.regulator AS source_name, r.source_url, r.official_document_url AS document_url,
                  r.created_at AS retrieved_at, r.updated_at AS last_checked_at, r.source_verified,
                  d.id AS document_id, d.document_hash, d.file_size, d.page_count, d.storage_path
           FROM regulations r LEFT JOIN documents d ON d.regulation_id = r.id
           WHERE r.id = ?""", (rid,)).fetchone()
    if not r:
        return {}
    p = dict(r)
    p["document_downloaded"] = bool(p.pop("storage_path", None))
    return p


def change_status(con, rid: str) -> dict:
    """
    Which of the five states this regulation is in, with the evidence behind it.

    Delegates to regulatory_ingestion.change_status, which is the single
    implementation. This module deliberately keeps no rules of its own — two
    copies of the precedence drifted apart once already.
    """
    return _status.status_for(con, rid)



# ---------------------------------------------------------------- filtering
# One builder, used by both the list and the facet counts. Two copies of this
# precedence drifted apart once already in change_status; the counts beside a
# filter option and the rows it returns must come from the same clause or the
# UI lies about how many results a click will produce.

def _multi(raw: str | None) -> list[str]:
    """A filter takes several values: ?sector=NBFC,Banking."""
    return [v.strip() for v in (raw or "").split(",") if v.strip()]


def _in(col: str, vals: list[str], params: list) -> str:
    params.extend(vals)
    return f"{col} IN ({','.join('?' * len(vals))})"


def _filters(f: dict) -> tuple[str, list]:
    """Every filter maps to stored metadata. None of them is cosmetic."""
    where = ["r.source_url IS NOT NULL AND r.source_url != ''"]
    params: list = []

    if v := _multi(f.get("regulator")):
        where.append(_in("r.regulator_short", v, params))
    if v := _multi(f.get("regulation_type")):
        sub_params: list = []
        clause = _in("rt.type", v, sub_params)
        where.append(f"EXISTS (SELECT 1 FROM regulation_types rt "
                     f"WHERE rt.regulation_id = r.id AND {clause})")
        params.extend(sub_params)
    if v := _multi(f.get("collection_status")):
        where.append(_in("r.ingestion_status", v, params))
    if v := _multi(f.get("importance")):
        where.append(_in("r.impact_level", v, params))
    if v := _multi(f.get("applicability")):
        where.append(_in("r.applicability", v, params))

    # Only what the impact engine has actually scored. Sorting by score already
    # existed, but with 29,000 unscored rows sharing the same NULL the sort put
    # them wherever the tiebreak fell; this takes them out of the question.
    if str(f.get("has_impact") or "").strip() in ("1", "true", "yes"):
        where.append("EXISTS (SELECT 1 FROM impact_scores si WHERE si.regulation_id = r.id)")

    if sv := (f.get("source_verification") or "").strip():
        if sv == "Verified":
            where.append("r.source_verified = 1")
        elif sv == "Not Verified":
            where.append("COALESCE(r.source_verified, 0) = 0")

    # SECTOR — many-to-many. "Unclassified" is a real answer: 695 records carry
    # no evidence of a sector, and hiding them would misreport the library size.
    sectors = _multi(f.get("sector"))
    if sectors:
        named = [s for s in sectors if s != "Unclassified"]
        parts = []
        if named:
            sub_params: list = []
            clause = _in("rs.sector", named, sub_params)
            parts.append(f"EXISTS (SELECT 1 FROM regulation_sectors rs "
                         f"WHERE rs.regulation_id = r.id AND {clause})")
            params.extend(sub_params)
        if "Unclassified" in sectors:
            parts.append("NOT EXISTS (SELECT 1 FROM regulation_sectors rs "
                         "WHERE rs.regulation_id = r.id)")
        where.append("(" + " OR ".join(parts) + ")")

    # STATE / UT — APPLICABILITY, not issuer. An all-India instrument matches
    # every region selected, which is why an RBI Master Direction is returned
    # for Telangana. This is the rule the whole filter exists to get right.
    regions = _multi(f.get("state_ut"))
    if regions:
        sub_params: list = []
        clause = _in("rr.state_ut", regions, sub_params)
        where.append("EXISTS (SELECT 1 FROM regulation_regions rr "
                     f"WHERE rr.regulation_id = r.id "
                     f"AND (rr.coverage = 'ALL_INDIA' OR {clause}))")
        params.extend(sub_params)

    # JURISDICTION — the KIND of instrument, since every record is 'India'.
    j = (f.get("jurisdiction") or "").strip()
    if j == "India":
        where.append("EXISTS (SELECT 1 FROM regulation_regions rr "
                     "WHERE rr.regulation_id = r.id AND rr.coverage = 'ALL_INDIA')")
    elif j in ("State", "Union Territory"):
        kind = "STATE" if j == "State" else "UT"
        where.append("EXISTS (SELECT 1 FROM regulation_regions rr "
                     "WHERE rr.regulation_id = r.id AND rr.coverage = 'STATE_SPECIFIC' "
                     "AND rr.region_kind = ?)")
        params.append(kind)

    # DATES — issued_on, because effective_from is empty on every record.
    if d := (f.get("issued_from") or "").strip():
        where.append("r.issued_on >= ?"); params.append(d)
    if d := (f.get("issued_to") or "").strip():
        where.append("r.issued_on <= ?"); params.append(d)

    # SEARCH — every term must appear somewhere, not the phrase as typed.
    # The KYC instrument is titled "Master Direction - Know Your Customer (KYC)
    # Direction, 2016", so a phrase match on "KYC Master Direction" finds
    # nothing while every word of it is plainly present. Terms are ANDed and
    # each may land in the title, the reference, the regulator, a clause, or an
    # obligation — which is what makes searching inside the document work.
    if q := (f.get("q") or "").strip():
        for term in [t for t in q.lower().split() if t][:8]:
            like = f"%{term}%"
            ids = _text_hits(term)
            where.append(f"""(
                lower(r.title) LIKE ?
             OR lower(COALESCE(r.reference_number,'')) LIKE ?
             OR lower(COALESCE(r.regulator,'')) LIKE ?
             OR lower(COALESCE(r.regulator_short,'')) LIKE ?
             OR lower(COALESCE(r.sector,'')) LIKE ?
             {"OR r.id = ANY(?)" if ids is not None else ""}
            )""")
            params.extend([like] * 5)
            if ids is not None:
                params.append(ids)

    return "WHERE " + " AND ".join(where), params


@router.get("")
def list_regulations(
    page: int = 1,
    size: int = Query(50, le=200),
    q: str | None = None,
    jurisdiction: str | None = None,
    state_ut: str | None = None,
    sector: str | None = None,
    regulator: str | None = None,
    regulation_type: str | None = None,
    collection_status: str | None = None,
    importance: str | None = None,
    applicability: str | None = None,
    has_impact: str | None = None,
    source_verification: str | None = None,
    issued_from: str | None = None,
    issued_to: str | None = None,
    sort: str = "changed",
    status: str | None = None,          # kept: older callers pass ingestion status here
    analysed_only: bool = False,
):
    """
    The regulation library. Only records that carry a real source URL are
    returned — a row without provenance is not a production regulation.
    """
    con = _con()
    f = {"q": q, "jurisdiction": jurisdiction, "state_ut": state_ut, "sector": sector,
         "regulator": regulator, "regulation_type": regulation_type,
         "collection_status": collection_status or status, "importance": importance,
         "applicability": applicability, "has_impact": has_impact,
         "source_verification": source_verification,
         "issued_from": issued_from, "issued_to": issued_to}
    if analysed_only:
        f["collection_status"] = "MAPPED"
    w, params = _filters(f)
    # Default: what moved comes first. A library where a reworded Master
    # Direction sits on page 14 behind 300 unchanged colonial Acts buries the
    # only thing a compliance officer needs to see today. Renumbering does not
    # count — it would float documents whose wording nobody touched.
    changed_first = """(SELECT COUNT(*) FROM section_changes sc
                         WHERE sc.regulation_id = r.id
                           AND sc.change_class = 'WORDING') DESC, r.created_at, r.id"""
    order = {"changed": changed_first,
             # The control is labelled "Recently added", so newest first. Ascending order
            # put August rows above today's and made the option useless.
            "created": "r.created_at DESC NULLS LAST, r.id",
             "title": "r.title",
             "issued": "r.issued_on DESC NULLS LAST, r.id",
             "impact": "s.score DESC NULLS LAST, r.id"}.get(sort, changed_first)
    # A search, or a regulator picked, is a request for a specific instrument, so
    # relevance leads and the chosen sort only breaks ties: a title hit beats a
    # hit buried in a clause, what applies to us beats what does not, and the
    # instrument this company has actually been assessed against beats its
    # unassessed siblings — "NABH" must open on the 6th Edition standard, not on
    # a pollution compendium that mentions NABH once. Terms are inlined (no
    # placeholders) because ORDER BY sits after the WHERE parameters.
    if q or regulator:
        terms = [t.replace("'", "''").replace("?", "").replace("%", "")
                 for t in (q or "").lower().split()][:8]
        terms = [t for t in terms if t]
        title_hits = " + ".join(
            f"(CASE WHEN position('{t}' in lower(r.title || ' ' || COALESCE(r.regulator_short,''))) > 0 THEN 1 ELSE 0 END)"
            for t in terms)
        phrase = " ".join(terms)
        text_rank = (f"""(CASE WHEN position('{phrase}' in lower(r.title)) > 0 THEN 0 ELSE 1 END),
            ({title_hits}) DESC,""" if terms else "")
        # The depth of the assessment is the tiebreak: of a dozen NABH standards
        # the one with 639 assessed elements is the one this hospital runs on.
        order = f"""{text_rank}
            (CASE WHEN r.applicability IN ('APPLICABLE','CONDITIONAL') THEN 0 ELSE 1 END),
            (SELECT COUNT(*) FROM gap_assessments g WHERE g.regulation_id = r.id) DESC,
            s.score DESC NULLS LAST, {order}"""

    total = con.execute(
        f"SELECT COUNT(*) FROM regulations r {w}", params).fetchone()[0]
    items = _rows(con, f"""
        SELECT r.id, r.title, r.regulator, r.regulator_short, r.regulation_type, r.sector,
               -- when this row first appeared HERE, which is not r.issued_on (when the
               -- regulator published it). The library needs both: how old the law is,
               -- and how long we have known about it.
               r.created_at AS added_on,
               r.ministry, r.issued_on, r.status, r.ingestion_status, r.impact_level,
               -- this company's verdict, so a row can show it without the reader
               -- having to open the regulation. Written by materialise_applicability
               -- from the same evaluate() the detail page calls.
               r.applicability,
               r.source_url, r.official_document_url, r.reference_number, r.created_at,
               s.score AS impact_score, d.page_count, d.document_hash,
               (SELECT COUNT(*) FROM obligations o WHERE o.regulation_id = r.id) AS obligations,
               (SELECT COUNT(*) FROM regulation_amendments a WHERE a.regulation_id = r.id) AS amendments,
               (SELECT COUNT(*) FROM sections sec WHERE sec.regulation_id = r.id) AS sections,
               (SELECT COUNT(*) FROM company_mappings m
                  JOIN obligations o2 ON o2.id = m.obligation_id
                 WHERE o2.regulation_id = r.id) AS company_links,
               (SELECT COUNT(*) FROM document_versions v WHERE v.regulation_id = r.id) AS versions,
               (SELECT COUNT(*) FROM section_changes c WHERE c.regulation_id = r.id) AS computed_changes,
               (SELECT COUNT(*) FROM section_changes c WHERE c.regulation_id = r.id
                 AND c.change_class = 'WORDING') AS wording_changes,
               (SELECT MAX(c.detected_at) FROM section_changes c
                 WHERE c.regulation_id = r.id AND c.change_class = 'WORDING') AS changed_at,
               (SELECT sc.outcome FROM source_checks sc
                 WHERE sc.regulation_id = r.id ORDER BY sc.id DESC LIMIT 1) AS last_outcome
        FROM regulations r
        LEFT JOIN impact_scores s ON s.regulation_id = r.id
        LEFT JOIN documents     d ON d.regulation_id = r.id
        {w} ORDER BY {order} LIMIT ? OFFSET ?""", *params, size, (page - 1) * size)

    # Same classifier as the detail endpoint — a row and its detail page can never disagree.
    for it in items:
        it["change_status"] = _status.classify(
            it["versions"], it["computed_changes"], it["amendments"],
            it["document_hash"] is not None, it.pop("last_outcome"))

    return {"page": page, "size": size, "total": total, "items": items}


@router.get("/facets")
def facets(
    q: str | None = None,
    jurisdiction: str | None = None,
    state_ut: str | None = None,
    sector: str | None = None,
    regulator: str | None = None,
    regulation_type: str | None = None,
    collection_status: str | None = None,
    importance: str | None = None,
    applicability: str | None = None,
    has_impact: str | None = None,
    source_verification: str | None = None,
    issued_from: str | None = None,
    issued_to: str | None = None,
):
    """
    Option counts for the filter bar, computed under the CURRENT selection.

    Each dimension is counted with its own filter lifted, which is what makes
    the numbers useful: with Sector=NBFC applied, the Regulator counts show how
    many NBFC records each regulator has, so a user can see that picking SEBI
    would return nothing before clicking it. Counting every dimension under the
    full selection instead would make every unselected option read zero.

    Every count is a COUNT(*) over the same clause the list endpoint uses. No
    option is listed from a constant.
    """
    con = _con()
    sel = {"q": q, "jurisdiction": jurisdiction, "state_ut": state_ut, "sector": sector,
           "regulator": regulator, "regulation_type": regulation_type,
           "collection_status": collection_status, "importance": importance,
           "applicability": applicability, "has_impact": has_impact,
           "source_verification": source_verification,
           "issued_from": issued_from, "issued_to": issued_to}

    def counts(dimension: str, sql: str) -> list[dict]:
        w, params = _filters({**sel, dimension: None})
        return _rows(con, sql.replace("{W}", w), *params)

    def total_for(dimension: str | None = None) -> int:
        w, params = _filters(sel if dimension is None else {**sel, dimension: None})
        return con.execute(f"SELECT COUNT(*) FROM regulations r {w}", params).fetchone()[0]

    out = {
        "regulators": counts("regulator", """
            SELECT r.regulator_short AS value, COUNT(*) AS count
              FROM regulations r {W} AND r.regulator_short <> ''
             GROUP BY 1 ORDER BY count DESC"""),
        "regulationTypes": counts("regulation_type", """
            SELECT rt.type AS value, COUNT(*) AS count
              FROM regulations r JOIN regulation_types rt ON rt.regulation_id = r.id
             {W} GROUP BY 1 ORDER BY count DESC"""),
        "sectors": counts("sector", """
            SELECT rs.sector AS value, COUNT(DISTINCT r.id) AS count
              FROM regulations r JOIN regulation_sectors rs ON rs.regulation_id = r.id
             {W} GROUP BY 1 ORDER BY count DESC"""),
        "collectionStatuses": counts("collection_status", """
            SELECT r.ingestion_status AS value, COUNT(*) AS count
              FROM regulations r {W} GROUP BY 1 ORDER BY count DESC"""),
        "importance": counts("importance", """
            SELECT r.impact_level AS value, COUNT(*) AS count
              FROM regulations r {W} AND r.impact_level IS NOT NULL AND r.impact_level <> ''
             GROUP BY 1 ORDER BY count DESC"""),
        "applicability": counts("applicability", """
            SELECT r.applicability AS value, COUNT(*) AS count
              FROM regulations r {W} AND r.applicability IS NOT NULL AND r.applicability <> ''
             GROUP BY 1 ORDER BY count DESC"""),
        "regions": counts("state_ut", """
            SELECT rr.state_ut AS value, rr.region_kind AS kind, COUNT(DISTINCT r.id) AS count
              FROM regulations r JOIN regulation_regions rr ON rr.regulation_id = r.id
             {W} AND rr.coverage = 'STATE_SPECIFIC'
             GROUP BY 1, 2 ORDER BY count DESC"""),
    }

    # "Unclassified" is a genuine bucket, not an absence — 695 records carry no
    # evidence of any sector, and omitting them would understate the library.
    w, params = _filters({**sel, "sector": None})
    out["sectors"].append({
        "value": "Unclassified",
        "count": con.execute(
            f"""SELECT COUNT(*) FROM regulations r {w}
                 AND NOT EXISTS (SELECT 1 FROM regulation_sectors rs
                                  WHERE rs.regulation_id = r.id)""", params).fetchone()[0],
    })

    # How many of the current selection the impact engine has scored.
    w, params = _filters({**sel, "has_impact": None})
    out["scoredForImpact"] = con.execute(
        f"""SELECT COUNT(*) FROM regulations r {w}
             AND EXISTS (SELECT 1 FROM impact_scores si WHERE si.regulation_id = r.id)""",
        params).fetchone()[0]

    # How many records an all-India instrument contributes to ANY region choice.
    w, params = _filters({**sel, "state_ut": None})
    out["allIndiaCount"] = con.execute(
        f"""SELECT COUNT(*) FROM regulations r {w}
             AND EXISTS (SELECT 1 FROM regulation_regions rr
                          WHERE rr.regulation_id = r.id AND rr.coverage = 'ALL_INDIA')""",
        params).fetchone()[0]

    # Retained under its original name: WorkflowStrip counts ingestion states
    # from this key, and renaming a field other screens read is not a filter fix.
    out["statuses"] = out["collectionStatuses"]

    out["matched"] = total_for()
    out["total"] = con.execute(
        "SELECT COUNT(*) FROM regulations WHERE source_url IS NOT NULL AND source_url != ''"
    ).fetchone()[0]

    # Section 6 of the spec: a record discovered is not a regulation verified.
    # These are reported separately so the header can never call 1,759 raw
    # discoveries "1,759 regulations".
    out["library"] = {
        "discovered": con.execute("SELECT COUNT(*) FROM regulations").fetchone()[0],
        "withSourceUrl": out["total"],
        "documentsExtracted": con.execute(
            "SELECT COUNT(*) FROM documents WHERE extraction_status = 'EXTRACTED'").fetchone()[0],
        "structured": con.execute(
            "SELECT COUNT(DISTINCT regulation_id) FROM sections").fetchone()[0],
        "mapped": con.execute(
            "SELECT COUNT(*) FROM regulations WHERE ingestion_status = 'MAPPED'").fetchone()[0],
    }

    # Which filters the data can actually answer. The UI marks the rest
    # unavailable rather than presenting a control that silently returns nothing.
    from . import facets as _facets
    out["availability"] = _facets.availability(con)
    out["vocabulary"] = {
        "states": _facets.STATES,
        "unionTerritories": _facets.UNION_TERRITORIES,
        "sectors": _facets.SECTORS,
    }
    return out


@router.get("/{rid}")
def get_regulation(rid: str):
    con = _con()
    r = con.execute("SELECT * FROM regulations WHERE id=?", (rid,)).fetchone()
    if not r:
        raise HTTPException(404, "regulation not found in the database")
    out = dict(r)
    out["provenance"] = _provenance(con, rid)
    out["changeStatus"] = change_status(con, rid)
    out["counts"] = {
        "sections": con.execute("SELECT COUNT(*) FROM sections WHERE regulation_id=?", (rid,)).fetchone()[0],
        "obligations": con.execute("SELECT COUNT(*) FROM obligations WHERE regulation_id=?", (rid,)).fetchone()[0],
        "amendments": con.execute("SELECT COUNT(*) FROM regulation_amendments WHERE regulation_id=?", (rid,)).fetchone()[0],
    }
    return out


@router.get("/{rid}/documents")
def documents(rid: str):
    return {"items": _rows(_con(), "SELECT * FROM documents WHERE regulation_id=?", rid)}


@router.get("/{rid}/sections")
def sections(rid: str, limit: int = Query(500, le=2000)):
    return {"items": _rows(_con(), """SELECT id, section_number, section_title, section_text, chars
                                      FROM sections WHERE regulation_id=? ORDER BY rowid LIMIT ?""", rid, limit)}


# Sentences a modal-verb extractor picks up that are not compliance duties: the
# short title, the commencement clause, the definitions. Flagging them is not
# cosmetic — presenting "these Directions shall be called…" as an obligation
# with a control status invites a compliance officer to act on nothing.
_SCOPE_MARKERS = (
    "shall be called", "shall come into force", "shall come into effect",
    "these directions shall apply", "these regulations shall apply",
    "shall extend to the whole", "unless the context otherwise requires",
)


def _duty_kind(title: str) -> str:
    """'duty' | 'scope' — is this an actionable obligation or boilerplate?"""
    t = (title or "").lower()
    if any(m in t for m in _SCOPE_MARKERS):
        return "scope"
    return "duty"


@router.get("/{rid}/obligations")
def obligations(rid: str):
    """
    Every extracted obligation, with the compliance chain attached.

    Control coverage is joined here rather than fetched per row, so the UI can
    show obligation → control → evidence inline without N further requests. What
    it cannot show is a requirement layer: none exists in the schema.
    """
    con = _con()
    items = _rows(con, f"""
        WITH co AS ({_OBL_CTL})
        SELECT o.id, o.title, o.description, o.obligation_type, o.mandatory_action,
               o.responsible_entity, o.frequency, o.evidence_required,
               o.source_reference, o.confidence, o.extraction_method, o.verified,
               COUNT(DISTINCT co.control_id) AS controls_mapped,
               MIN(c.name)                   AS control_name,
               MIN(c.effectiveness)          AS control_effectiveness,
               MIN(owner.name)               AS control_owner
        FROM obligations o
        LEFT JOIN co                     ON co.obligation_id = o.id
        LEFT JOIN controls c             ON c.id = co.control_id
        LEFT JOIN company_entities owner ON owner.id = c.owner_id
        WHERE o.regulation_id = ?
        GROUP BY o.id, o.title, o.description, o.obligation_type, o.mandatory_action,
                 o.responsible_entity, o.frequency, o.evidence_required,
                 o.source_reference, o.confidence, o.extraction_method, o.verified
        -- ordered by id, not rowid: ids are zero-padded and sort in source order,
        -- and `rowid` is a SQLite-ism the shim only rewrites when unqualified.
        ORDER BY o.id""", rid, rid, rid)

    for it in items:
        it["kind"] = _duty_kind(it.get("title", ""))
        it["controlStatus"] = "MAPPED" if (it.get("controls_mapped") or 0) > 0 else "NOT_MAPPED"
        # The regulator's own words about what proof is expected. Present on a
        # minority of rows; absent is "not stated", never "none required".
        it["evidenceStatus"] = "STATED" if it.get("evidence_required") else "NOT_STATED"

    duties = [i for i in items if i["kind"] == "duty"]
    return {
        "items": items,
        "counts": {
            "total": len(items),
            "duties": len(duties),
            "scope": len(items) - len(duties),
            "withControl": len([i for i in duties if i["controlStatus"] == "MAPPED"]),
            "withoutControl": len([i for i in duties if i["controlStatus"] == "NOT_MAPPED"]),
            "evidenceStated": len([i for i in duties if i["evidenceStatus"] == "STATED"]),
            "verified": len([i for i in items if i.get("verified")]),
        },
        # Said plainly so the UI can repeat it: how these were produced, and that
        # no human has confirmed them. Read from the rows, not assumed — a
        # regulation rewritten by a model must not be labelled "no model was used".
        "extraction": _extraction_note(items),
    }


def _extraction_note(items: list[dict]) -> dict:
    methods: dict[str, int] = {}
    for i in items:
        m = i.get("extraction_method") or "deterministic modal-verb rule"
        methods[m] = methods.get(m, 0) + 1
    method = max(methods, key=methods.get) if methods else "deterministic modal-verb rule"
    verified = len([i for i in items if i.get("verified")])
    if method == "deterministic modal-verb rule":
        note = ("Extracted by matching modal verbs (shall, must). No model was used and no "
                "human has reviewed these. Treat them as candidates, not findings.")
    elif "llm" in method or "upload" in method:
        note = ("Extracted and rewritten by the local language model from the uploaded document. "
                "No human has reviewed these yet; check them against the source text.")
    else:
        note = ("Parsed from the standard's own structure (one duty per objective element), then "
                "rewritten as testable requirements and checked against the hospital's documents. "
                "Not yet reviewed by a human.")
    return {"method": method, "methods": methods, "humanVerified": verified, "note": note}


# One obligation -> control relation for every screen. The older control_obligations
# table is joined with the links the gap assessment wrote (control_requirements,
# reached through each requirement's obligation), so the regulation page counts
# the same coverage the Requirements and Controls pages show. Parameters: the
# regulation id, twice.
_OBL_CTL = """
    SELECT co.obligation_id, co.control_id FROM control_obligations co
      JOIN obligations ob ON ob.id = co.obligation_id WHERE ob.regulation_id = ?
    UNION
    SELECT rq.obligation_id, cr.control_id FROM control_requirements cr
      JOIN requirements rq ON rq.id = cr.requirement_id WHERE rq.regulation_id = ?"""


@router.get("/{rid}/amendments")
def amendments(rid: str):
    """
    Amendments the DOCUMENT ITSELF records. Labelled explicitly so the UI cannot
    present these as a detected change.
    """
    con = _con()
    items = _rows(con, """SELECT section_number, section_title, action, meaning, instrument,
                                 reference, amended_on, context, raw, url, extraction_method
                          FROM regulation_amendments WHERE regulation_id=?
                          ORDER BY amended_on DESC""", rid)
    timeline: dict[str, dict] = {}
    for a in items:
        t = timeline.setdefault(a["reference"], {
            "reference": a["reference"], "amendedOn": a["amended_on"],
            "instrument": a["instrument"], "actions": set(), "sections": [],
            # link to the amending circular, recovered by the docling pass
            "url": a.get("url")})
        if a.get("url") and not t.get("url"):
            t["url"] = a["url"]
        t["actions"].add(a["action"])
        if a["section_number"] and a["section_number"] not in t["sections"]:
            t["sections"].append(a["section_number"])
    tl = sorted(({**t, "actions": sorted(t["actions"]), "sectionCount": len(t["sections"])}
                 for t in timeline.values()), key=lambda x: x["amendedOn"], reverse=True)
    return {
        "evidenceType": "AMENDMENT_MENTIONED_IN_SOURCE",
        "note": "Extracted from the document's own footnotes. This is the regulator's statement, "
                "not a comparison performed by this system.",
        "total": len(items), "circulars": len(tl), "timeline": tl, "items": items,
    }


@router.get("/{rid}/impact")
def impact_graph(rid: str, min_confidence: float = Query(0.0, ge=0, le=1),
                 limit: int = Query(400, ge=10, le=2000)):
    """
    The impact propagation graph for one regulation: which company entities it
    reaches, how, and on what evidence.

    Built entirely from impact_relationships and company_entities — every node is
    a real record with a real id, and every edge names the obligation and the
    reason it was matched. Nothing here is generated for display.
    """
    con = _con()
    reg = con.execute(
        """SELECT r.id, r.title, r.regulator, r.regulator_short, r.regulation_type,
                  r.issued_on, r.status, r.source_url, r.impact_level, r.impact_score,
                  d.document_hash, d.page_count
           FROM regulations r LEFT JOIN documents d ON d.regulation_id = r.id
           WHERE r.id = ?""", (rid,)).fetchone()
    if not reg:
        raise HTTPException(404, "no such regulation")

    rows = _rows(con,
        """SELECT ir.company_brain_entity_id AS entity_id, ir.entity_name, ir.entity_domain,
                  ir.relationship_type, ir.match_reason, ir.confidence, ir.obligation_id,
                  o.title AS obligation_title, o.obligation_type,
                  ce.type AS entity_type, ce.criticality, ce.owner_id,
                  own.name AS owner_name
           FROM impact_relationships ir
           LEFT JOIN obligations o      ON o.id  = ir.obligation_id
           LEFT JOIN company_entities ce ON ce.id = ir.company_brain_entity_id
           LEFT JOIN company_entities own ON own.id = ce.owner_id
           WHERE ir.regulation_id = ? AND COALESCE(ir.confidence,0) >= ?
           ORDER BY ir.confidence DESC
           LIMIT ?""", rid, min_confidence, limit)

    # collapse to one node per entity, keeping its strongest evidence
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    for r in rows:
        eid = r["entity_id"]
        if not eid:
            continue
        n = nodes.get(eid)
        if not n:
            n = nodes[eid] = {
                "id": eid, "entityId": eid,
                "name": r["entity_name"] or eid,
                "domain": r["entity_domain"] or "processes",
                "type": r["entity_type"],
                "criticality": r["criticality"],
                "owner": r["owner_name"],
                "ownerId": r["owner_id"],
                "confidence": r["confidence"] or 0,
                "obligations": [],
                "reason": r["match_reason"],
            }
        n["confidence"] = max(n["confidence"], r["confidence"] or 0)
        if r["obligation_id"] and r["obligation_id"] not in [o["id"] for o in n["obligations"]]:
            n["obligations"].append({"id": r["obligation_id"],
                                     "title": r["obligation_title"],
                                     "type": r["obligation_type"]})
        edges.append({
            "source": r["obligation_id"] or rid,
            "target": eid,
            "relationship": r["relationship_type"] or "affects",
            "kind": "obligation",
            "confidence": r["confidence"] or 0,
            "reason": r["match_reason"],
        })

    # A high-confidence match is Direct; weaker evidence is Indirect, then
    # Potential. Stated as a rule rather than an opinion so the graph's colours
    # mean something a reviewer can check.
    for n in nodes.values():
        c = n["confidence"]
        n["impactType"] = "Direct" if c >= 0.85 else ("Indirect" if c >= 0.6 else "Potential")
        n["impactLevel"] = (n.get("criticality")
                            or ("High" if c >= 0.85 else "Medium" if c >= 0.6 else "Low"))

    # ---- propagation edges -------------------------------------------------
    # The regulation does not touch every entity directly: it lands on a process,
    # which uses a system, which stores data governed by a policy. Those
    # entity-to-entity edges ARE the impact hierarchy — without them the graph is
    # a star and says nothing about how an obligation actually travels.
    ids = list(nodes)
    if ids:
        for r in _rows(con,
                """SELECT er.source_id, er.target_id, er.type,
                          s.domain AS source_domain, t.domain AS target_domain
                   FROM entity_relationships er
                   JOIN company_entities s ON s.id = er.source_id
                   JOIN company_entities t ON t.id = er.target_id
                   WHERE er.source_id = ANY(%s::text[])
                     AND er.target_id = ANY(%s::text[])
                     AND er.type NOT IN ('owns','heads','delegate_for','approves')""",
                ids, ids):
            src, tgt = nodes.get(r["source_id"]), nodes.get(r["target_id"])
            if not src or not tgt:
                continue
            # an edge is only as strong as its weaker end
            conf = min(src["confidence"], tgt["confidence"])
            edges.append({
                "source": r["source_id"], "target": r["target_id"],
                "relationship": r["type"], "kind": "propagation",
                "confidence": conf,
                "impactType": "Direct" if conf >= 0.85 else ("Indirect" if conf >= 0.6 else "Potential"),
                "reason": f"{src['name']} {r['type'].replace('_', ' ')} {tgt['name']}",
            })

    # downstream count — how much rides on this node
    downstream: dict[str, int] = {}
    for e in edges:
        if e.get("kind") == "propagation":
            downstream[e["source"]] = downstream.get(e["source"], 0) + 1
    for nid, n in nodes.items():
        n["downstream"] = downstream.get(nid, 0)

    by_domain: dict[str, int] = {}
    for n in nodes.values():
        by_domain[n["domain"]] = by_domain.get(n["domain"], 0) + 1

    # WORDING first: a renumbered cross-reference must never push a real
    # amendment past the LIMIT and out of the payload.
    changes = _rows(con,
        """SELECT section_number, change_type, change_class, old_text, new_text,
                  words_added, words_removed
           FROM section_changes WHERE regulation_id = ?
           ORDER BY (change_class = 'WORDING') DESC, words_added + words_removed DESC
           LIMIT 50""", rid)
    amendments = _rows(con,
        """SELECT reference, amended_on, raw, url FROM regulation_amendments
           WHERE regulation_id = ? ORDER BY amended_on DESC LIMIT 20""", rid)

    return {
        "regulation": dict(reg),
        "changeStatus": change_status(con, rid),
        "nodes": list(nodes.values()),
        "edges": edges,
        "byDomain": by_domain,
        "totals": {"entities": len(nodes),
                   "edges": len(edges),
                   "propagation": sum(1 for e in edges if e.get("kind") == "propagation"),
                   "direct": sum(1 for n in nodes.values() if n["impactType"] == "Direct"),
                   "indirect": sum(1 for n in nodes.values() if n["impactType"] == "Indirect"),
                   "potential": sum(1 for n in nodes.values() if n["impactType"] == "Potential")},
        "computedChanges": changes,
        "amendments": amendments,
        "score": _score_breakdown(con, rid),
        "penalties": __import__("regulatory_ingestion.penalties", fromlist=["exposure"]).exposure(con, rid),
        "note": "Nodes are real Company Brain entities matched to this regulation's "
                "obligations. Impact type is derived from match confidence, not asserted.",
    }


def _score_breakdown(con, rid: str) -> dict | None:
    """
    The score, taken apart into the terms that produced it.

    impact.py stores every factor alongside the number precisely so the result
    can be defended. A band on its own ("Critical") is an assertion; the same
    band with `processes 10 × 5 = 50` beside it is a calculation someone can
    check, disagree with, and act on.
    """
    r = con.execute("SELECT score, level, factors, computed_at FROM impact_scores "
                    "WHERE regulation_id=?", (rid,)).fetchone()
    if not r:
        return None
    try:
        f = json.loads(r["factors"] or "{}")
    except Exception:
        f = {}

    weights = f.get("weights") or {}
    by_domain = f.get("affected_by_domain") or {}
    terms = []
    for domain, count in sorted(by_domain.items(), key=lambda kv: -kv[1]):
        w = weights.get(domain, 2)
        # min(count, 5) is the cap the scorer applies: touching fifty processes
        # is not ten times worse than touching five.
        capped = min(count, 5)
        terms.append({"kind": "domain", "label": domain, "count": count,
                      "counted": capped, "weight": w, "points": w * capped,
                      "capped": count > capped})

    obligations = f.get("obligations", 0)
    terms.append({"kind": "obligations", "label": "obligations",
                  "count": obligations, "counted": min(obligations, 15),
                  "weight": 2, "points": 2 * min(obligations, 15),
                  "capped": obligations > 15})

    crit = f.get("max_entity_criticality")
    bonus = {"Critical": 12, "High": 8, "Medium": 4, "Low": 1}.get(crit, 0)
    terms.append({"kind": "criticality", "label": f"most critical entity is {crit}",
                  "count": None, "counted": None, "weight": None,
                  "points": bonus, "capped": False})

    subtotal = sum(t["points"] for t in terms)
    applies = f.get("applicability") == "Applies"
    return {
        "score": r["score"], "level": r["level"], "computedAt": r["computed_at"],
        "terms": terms,
        "subtotal": subtotal,
        "applicabilityMultiplier": 1.15 if applies else 1.0,
        "cappedAt100": subtotal * (1.15 if applies else 1.0) > 100,
        "formula": f.get("formula"),
        "bands": [{"level": "Critical", "from": 80}, {"level": "High", "from": 55},
                  {"level": "Medium", "from": 30}, {"level": "Low", "from": 0}],
    }


@router.get("/{rid}/tables")
def tables(rid: str):
    """
    Tables lifted out of the document with their rows intact.

    Only populated for regulations that have been through the docling pass —
    the fast pypdf pass cannot produce these, so an empty list here means
    "not extracted yet", not "this document has no tables".
    """
    con = _con()
    rows = _rows(con, """SELECT table_index, caption, columns_json, rows_json,
                                row_count, col_count, extraction_method
                         FROM regulation_tables WHERE regulation_id=? ORDER BY table_index""", rid)
    for r in rows:
        r["columns"] = json.loads(r.pop("columns_json"))
        r["rows"] = json.loads(r.pop("rows_json"))
    run = con.execute(
        "SELECT method FROM extraction_runs WHERE regulation_id=? AND method LIKE 'docling%'",
        (rid,)).fetchone()
    return {"items": rows, "total": len(rows),
            "extracted": run is not None,
            "note": None if run else "This regulation has not been through the high-fidelity "
                                     "extraction pass, so no tables have been lifted from it yet."}


@router.get("/{rid}/extraction")
def extraction(rid: str):
    """Which extractor produced what is on screen, so the UI can say so."""
    return {"runs": _rows(
        _con(), "SELECT * FROM extraction_runs WHERE regulation_id=? ORDER BY ran_at DESC", rid)}


@router.get("/{rid}/changes")
def changes(rid: str):
    """
    Computed changes only — the result of comparing two captured versions.
    Returns an empty list when no comparison has been performed. It never
    borrows the amendment footnotes to look populated.
    """
    con = _con()
    st = change_status(con, rid)
    # Chronological, matching versions.versions(): a copy recovered from an
    # archive is inserted after the versions we already hold but is FROM an
    # earlier date, so id order would present the history backwards.
    versions = _rows(con, """SELECT id, captured_at, document_hash, page_count, section_count,
                                    source_url, retrieved_from, retrieved_at
                             FROM document_versions WHERE regulation_id=?
                             ORDER BY captured_at, id""", rid)
    items = _rows(con, """SELECT c.section_number, c.change_type, c.change_class,
                                 c.old_text, c.new_text, c.diff_runs,
                                 c.words_added, c.words_removed, c.detected_at,
                                 c.from_version, c.to_version,
                                 -- the dates a reviewer actually needs: WHICH two
                                 -- copies differ, when each is from, and when we
                                 -- fetched them. Version ids alone cannot answer
                                 -- "changed between when and when".
                                 fv.captured_at    AS from_captured_at,
                                 fv.retrieved_at   AS from_retrieved_at,
                                 fv.retrieved_from AS from_retrieved_from,
                                 fv.document_hash  AS from_hash,
                                 tv.captured_at    AS to_captured_at,
                                 tv.retrieved_at   AS to_retrieved_at,
                                 tv.retrieved_from AS to_retrieved_from,
                                 tv.document_hash  AS to_hash,
                                 COALESCE(tv.source_url, fv.source_url) AS source_url
                          FROM section_changes c
                          LEFT JOIN document_versions fv ON fv.id = c.from_version
                          LEFT JOIN document_versions tv ON tv.id = c.to_version
                          WHERE c.regulation_id=?
                          ORDER BY (c.change_class = 'WORDING') DESC,
                                   c.words_added + c.words_removed DESC, c.id""", rid)

    # State the comparison ONCE rather than repeating it on every row: which two
    # copies, where each came from, and when we fetched them.
    comparison = None
    if items:
        f = items[0]
        comparison = {
            "from": {"capturedAt": f.get("from_captured_at"),
                     "retrievedAt": f.get("from_retrieved_at"),
                     "retrievedFrom": f.get("from_retrieved_from"),
                     "documentHash": f.get("from_hash")},
            "to":   {"capturedAt": f.get("to_captured_at"),
                     "retrievedAt": f.get("to_retrieved_at"),
                     "retrievedFrom": f.get("to_retrieved_from"),
                     "documentHash": f.get("to_hash")},
            "sourceUrl": f.get("source_url"),
            "detectedAt": f.get("detected_at"),
            "sectionsChanged": len(items),
        }

    doc = con.execute(
        """SELECT source_url, document_hash, page_count, file_size, storage_path, created_at
           FROM documents WHERE regulation_id=?""", (rid,)).fetchone()

    return {**st, "versions": versions, "items": items,
            "comparison": comparison,
            "document": dict(doc) if doc else None}


@router.get("/{rid}/applicability")
def applicability(rid: str):
    """
    Who this regulation covers, and whether it reaches this company.

    Returns the extracted rules as stated by the source alongside a deterministic
    verdict with its full reasoning. Every check reports what was compared and
    what was found, so the answer can be defended rather than merely displayed.
    """
    from . import applicability as A
    con = _con()
    reg = con.execute("SELECT * FROM regulations WHERE id=?", (rid,)).fetchone()
    if not reg:
        raise HTTPException(404, "no such regulation")

    rules = [dict(r) for r in con.execute(
        """SELECT id, entity_type, applicability, applicability_rule, source_clause, confidence, role, evidence
           FROM applicability_rules WHERE regulation_id=? ORDER BY entity_type""", (rid,))]

    facts = A.company_facts(con)
    evaluation = A.evaluate(con, dict(reg), rules, facts) if facts else {
        "verdict": "REVIEW_REQUIRED",
        "why": "No company profile has been completed, so applicability cannot be assessed.",
        "checks": [], "company": {}, "matched": 0, "contradicted": 0, "unknown": 0,
        "method": "not evaluated", "limits": [],
    }

    return {
        "regulationId": rid,
        # Grouped so the UI can say "covers these entity types" in one line
        # rather than repeating a near-identical row per extracted excerpt.
        "entityTypes": sorted({(r["entity_type"] or "").strip()
                               for r in rules if (r["entity_type"] or "").strip()}),
        "rules": rules,
        "evaluation": evaluation,
    }


@router.get("/{rid}/controls")
def regulation_controls(rid: str):
    """
    Controls that already cover this regulation's obligations.

    Reached through real links only (control_obligations, and the control links
    the gap assessment wrote per requirement), never because a name looked relevant.
    """
    con = _con()
    rows = _rows(con, f"""
        WITH co AS ({_OBL_CTL})
        SELECT c.id, c.name, c.description, c.control_type, c.frequency, c.automated,
               c.effectiveness, c.last_tested, c.next_test_due,
               owner.name AS owner_name, ent.name AS entity_name,
               COUNT(DISTINCT co.obligation_id) AS obligations_covered
        FROM co
        JOIN controls c    ON c.id = co.control_id
        LEFT JOIN company_entities owner ON owner.id = c.owner_id
        LEFT JOIN company_entities ent   ON ent.id   = c.entity_id
        GROUP BY c.id, c.name, c.description, c.control_type, c.frequency, c.automated,
                 c.effectiveness, c.last_tested, c.next_test_due, owner.name, ent.name
        ORDER BY obligations_covered DESC""", rid, rid)
    total_obl = con.execute(
        "SELECT COUNT(*) FROM obligations WHERE regulation_id=?", (rid,)).fetchone()[0]
    covered = con.execute(f"WITH co AS ({_OBL_CTL}) SELECT COUNT(DISTINCT obligation_id) FROM co",
                          (rid, rid)).fetchone()[0]
    return {
        "items": rows,
        "obligationsTotal": total_obl,
        "obligationsCovered": covered,
        # The honest headline: how much of this regulation nothing covers.
        "obligationsUncovered": max(0, total_obl - covered),
    }


@router.get("/{rid}/metrics")
def metrics(rid: str):
    """
    The canonical numbers. Every screen reads these and nothing computes its own.

    Counts come from the relationships themselves, so "covered" always means a
    row exists in control_requirements, and a figure can never disagree with the
    list it summarises. Layers that hold no rows report zero with the reason
    rather than being omitted, because an absent number reads as an oversight
    while a zero with a cause reads as a gap.
    """
    con = _con()
    one = lambda q, *p: con.execute(q, p).fetchone()[0]

    total_extracted = one("SELECT COUNT(*) FROM obligations WHERE regulation_id=?", rid)
    by_kind = {r["kind"] or "UNCLASSIFIED": r["n"] for r in con.execute(
        "SELECT kind, COUNT(*) AS n FROM obligations WHERE regulation_id=? GROUP BY kind", (rid,))}
    obligations = by_kind.get("OBLIGATION", 0)

    needs_review = one(
        "SELECT COUNT(*) FROM obligations WHERE regulation_id=? AND review_status='NEEDS_REVIEW'", rid)
    accepted = one(
        "SELECT COUNT(*) FROM obligations WHERE regulation_id=? AND review_status='ACCEPTED'", rid)

    # Only the modal-verb rule mixes duties with definitions and scope text, and
    # marks the duties kind='OBLIGATION'. Rows from a structured parser or the
    # upload pipeline are duties by construction (their kind holds the NABH
    # category or 'DUTY'), so they all count.
    is_duty = "(o.kind='OBLIGATION' OR coalesce(o.extraction_method,'') NOT IN ('', 'deterministic modal-verb rule'))"
    obligations = one(f"SELECT COUNT(*) FROM obligations o WHERE o.regulation_id=? AND {is_duty}", rid)
    requirements = one("SELECT COUNT(*) FROM requirements WHERE regulation_id=?", rid)
    obl_with_req = one(f"""SELECT COUNT(DISTINCT o.id) FROM obligations o
        JOIN requirements rq ON rq.obligation_id=o.id
        WHERE o.regulation_id=? AND {is_duty}""", rid)
    req_with_control = one("""SELECT COUNT(DISTINCT rq.id) FROM requirements rq
        JOIN control_requirements cr ON cr.requirement_id=rq.id WHERE rq.regulation_id=?""", rid)
    controls = one("""SELECT COUNT(DISTINCT cr.control_id) FROM control_requirements cr
        JOIN requirements rq ON rq.id=cr.requirement_id WHERE rq.regulation_id=?""", rid)
    ev_linked = one("""SELECT COUNT(DISTINCT el.evidence_id) FROM evidence_links el
        JOIN requirements rq ON rq.id=el.requirement_id WHERE rq.regulation_id=?""", rid)

    # Legacy bulk mapping, reported separately and never mixed into coverage.
    legacy_links = one("""SELECT COUNT(*) FROM control_obligations co
        JOIN obligations o ON o.id=co.obligation_id WHERE o.regulation_id=?""", rid)

    versions = one("SELECT COUNT(*) FROM document_versions WHERE regulation_id=?", rid)
    changes = one("SELECT COUNT(*) FROM section_changes WHERE regulation_id=?", rid)

    def pct(part, whole):
        return round(100 * part / whole) if whole else 0

    return {
        "regulationId": rid,
        "extraction": {
            "sentencesExtracted": total_extracted,
            "byKind": by_kind,
            "note": "Only rows classified OBLIGATION are compliance duties. The rest are "
                    "applicability, definitions, permissions, scope or explanatory text and are "
                    "excluded from every coverage figure below.",
        },
        "pipeline": {
            "obligations": obligations,
            "requirements": requirements,
            "controls": controls,
            "evidence": ev_linked,
        },
        "coverage": {
            "obligationsWithRequirement": obl_with_req,
            "obligationsWithoutRequirement": max(0, obligations - obl_with_req),
            "requirementCoveragePct": pct(obl_with_req, obligations),
            "requirementsWithControl": req_with_control,
            "requirementsWithoutControl": max(0, requirements - req_with_control),
            "controlCoveragePct": pct(req_with_control, requirements),
            "evidenceLinked": ev_linked,
            "evidenceCoveragePct": pct(ev_linked, req_with_control),
        },
        "review": {
            "needsReview": needs_review,
            "accepted": accepted,
            "unreviewed": max(0, total_extracted - needs_review - accepted),
        },
        "change": {"versionsCaptured": versions, "clauseChanges": changes,
                   "comparable": versions >= 2},
        "legacy": {
            "controlObligationLinks": legacy_links,
            "note": "Historic bulk mapping of controls straight to obligations. Kept for "
                    "reference and deliberately excluded from coverage, which counts only "
                    "explicit requirement-to-control mappings.",
        },
        "gaps": [g for g in [
            "No requirements have been derived for this regulation."
            if requirements == 0 else None,
            "No controls are mapped to any requirement." if controls == 0 else None,
            "No evidence is linked to any requirement." if ev_linked == 0 else None,
            "Only one version has been captured, so no comparison is possible."
            if versions < 2 else None,
            f"{needs_review} extracted items could not be classified confidently."
            if needs_review else None,
        ] if g],
    }
