"""
Regulation-side validation: does the legal chain actually hold in the data?

    REGULATION → SOURCE DOCUMENT → VERSION → SECTION → CLAUSE → OBLIGATION
              → REQUIREMENT → CONDITION/EXCEPTION/THRESHOLD → TIME
              → REPORTING → RECORD KEEPING → PENALTY → CROSS REFERENCE
              → AMENDMENT → CHANGE → PROVENANCE

Every number is a COUNT executed at read time against the live database. There
are no stored totals and no constants: if the corpus grows mid-run, the next
call reports the larger corpus. A check that finds nothing returns 0 and stays
in the report — an absent check would read as a passing one.

Company-side state (applicability, controls, evidence, assessment) is
deliberately out of scope here; it has its own report.
"""
from __future__ import annotations

from .db import connect


# --------------------------------------------------------------- coverage
# (label, numerator SQL, denominator key). Denominator is always the live
# count of regulations that completed ingestion, never a literal.
COVERAGE = {
    "regulationsWithSections":
        "SELECT COUNT(DISTINCT regulation_id) FROM sections",
    "regulationsWithClauses":
        "SELECT COUNT(DISTINCT regulation_id) FROM clauses",
    "regulationsWithObligations":
        "SELECT COUNT(DISTINCT regulation_id) FROM obligations",
    "regulationsWithRequirements":
        "SELECT COUNT(DISTINCT regulation_id) FROM requirements",
    "regulationsWithDefinitions":
        "SELECT COUNT(DISTINCT regulation_id) FROM definitions",
    "regulationsWithPenalties":
        "SELECT COUNT(DISTINCT regulation_id) FROM penalty_provisions",
    "regulationsWithCrossReferences":
        "SELECT COUNT(DISTINCT source_regulation_id) FROM cross_references",
    "regulationsWithTables":
        "SELECT COUNT(DISTINCT regulation_id) FROM regulation_tables",
    "regulationsWithAmendments":
        "SELECT COUNT(DISTINCT regulation_id) FROM regulation_amendments",
    "regulationsWithChanges":
        "SELECT COUNT(DISTINCT regulation_id) FROM section_changes",
    "regulationsWithVersions":
        "SELECT COUNT(DISTINCT regulation_id) FROM document_versions",
    "regulationsWithProvenance":
        "SELECT COUNT(DISTINCT regulation_id) FROM verification_records",
}

# Lineage: can each derived object reach the legal text it claims to come from?
LINEAGE = {
    "obligationsWithSection": (
        "SELECT COUNT(*) FROM obligations WHERE section_id IS NOT NULL AND section_id <> ''",
        "SELECT COUNT(*) FROM obligations"),
    # obligations.clause_id is dead in this schema: the clause link is carried
    # by the provision an obligation was read from (obligation → legal_provision
    # → clause). Measuring the dead column would report 0% and hide the truth.
    "obligationsReachingAClause": (
        """SELECT COUNT(*) FROM obligations o JOIN legal_provisions lp ON lp.id = o.provision_id
            WHERE lp.clause_id IS NOT NULL""",
        "SELECT COUNT(*) FROM obligations"),
    "obligationsWithProvision": (
        "SELECT COUNT(*) FROM obligations WHERE provision_id IS NOT NULL",
        "SELECT COUNT(*) FROM obligations"),
    "provisionsLinkedToClause": (
        "SELECT COUNT(*) FROM legal_provisions WHERE clause_id IS NOT NULL",
        "SELECT COUNT(*) FROM legal_provisions"),
    "obligationsWithSourceExcerpt": (
        "SELECT COUNT(*) FROM obligations WHERE source_excerpt IS NOT NULL AND source_excerpt <> ''",
        "SELECT COUNT(*) FROM obligations"),
    "requirementsWithObligation": (
        """SELECT COUNT(*) FROM requirements rq WHERE rq.obligation_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM obligations o WHERE o.id = rq.obligation_id)""",
        "SELECT COUNT(*) FROM requirements"),
    "requirementsWithSourceClause": (
        "SELECT COUNT(*) FROM requirements WHERE source_clause IS NOT NULL AND source_clause <> ''",
        "SELECT COUNT(*) FROM requirements"),
    "requirementsWithSourceExcerpt": (
        "SELECT COUNT(*) FROM requirements WHERE source_excerpt IS NOT NULL AND source_excerpt <> ''",
        "SELECT COUNT(*) FROM requirements"),
    "definitionsWithSourceSection": (
        "SELECT COUNT(*) FROM definitions WHERE source_section_id IS NOT NULL",
        "SELECT COUNT(*) FROM definitions"),
    "penaltiesWithSourceText": (
        "SELECT COUNT(*) FROM penalty_provisions WHERE basis_text IS NOT NULL AND basis_text <> ''",
        "SELECT COUNT(*) FROM penalty_provisions"),
    "clausesWithText": (
        "SELECT COUNT(*) FROM clauses WHERE clause_text IS NOT NULL AND clause_text <> ''",
        "SELECT COUNT(*) FROM clauses"),
    "sectionsWithText": (
        "SELECT COUNT(*) FROM sections WHERE section_text IS NOT NULL AND section_text <> ''",
        "SELECT COUNT(*) FROM sections"),
    "crossReferencesResolved": (
        "SELECT COUNT(*) FROM cross_references WHERE resolved IS NOT NULL AND resolved::text NOT IN ('0','false')",
        "SELECT COUNT(*) FROM cross_references"),
}

# Defects. A non-zero count is a real gap in the regulatory record.
DEFECTS = {
    "orphanSections":
        """SELECT COUNT(*) FROM sections s WHERE NOT EXISTS
           (SELECT 1 FROM regulations r WHERE r.id = s.regulation_id)""",
    "orphanClauses":
        """SELECT COUNT(*) FROM clauses c WHERE c.section_id IS NOT NULL AND NOT EXISTS
           (SELECT 1 FROM sections s WHERE s.id = c.section_id)""",
    "orphanObligations":
        """SELECT COUNT(*) FROM obligations o WHERE NOT EXISTS
           (SELECT 1 FROM regulations r WHERE r.id = o.regulation_id)""",
    "orphanRequirements":
        """SELECT COUNT(*) FROM requirements rq WHERE NOT EXISTS
           (SELECT 1 FROM obligations o WHERE o.id = rq.obligation_id)""",
    "obligationsWithBrokenSectionRef":
        """SELECT COUNT(*) FROM obligations o WHERE o.section_id IS NOT NULL AND o.section_id <> ''
             AND NOT EXISTS (SELECT 1 FROM sections s WHERE s.id = o.section_id)""",
    "obligationsWithBrokenClauseRef":
        """SELECT COUNT(*) FROM obligations o WHERE o.clause_id IS NOT NULL AND o.clause_id <> ''
             AND NOT EXISTS (SELECT 1 FROM clauses c WHERE c.id = o.clause_id)""",
    "clausesWithBrokenParent":
        """SELECT COUNT(*) FROM clauses c WHERE c.parent_clause_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM clauses p WHERE p.id = c.parent_clause_id)""",
    "sectionsWithBrokenParent":
        """SELECT COUNT(*) FROM sections s WHERE s.parent_section_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM sections p WHERE p.id = s.parent_section_id)""",
    "sectionsWithoutText":
        "SELECT COUNT(*) FROM sections WHERE section_text IS NULL OR section_text = ''",
    "clausesWithoutText":
        "SELECT COUNT(*) FROM clauses WHERE clause_text IS NULL OR clause_text = ''",
    "duplicateClauseText":
        """SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM clauses
            WHERE clause_text IS NOT NULL AND LENGTH(clause_text) > 80
            GROUP BY regulation_id, clause_text HAVING COUNT(*) > 1) d""",
    "duplicateRequirements":
        """SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM requirements
            GROUP BY regulation_id, statement HAVING COUNT(*) > 1) d""",
    "duplicateRegulationSourceUrls":
        """SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) n FROM regulations
            WHERE official_document_url IS NOT NULL AND official_document_url <> ''
            GROUP BY official_document_url HAVING COUNT(*) > 1) d""",
    "regulationsWithoutSourceUrl":
        """SELECT COUNT(*) FROM regulations
            WHERE (official_document_url IS NULL OR official_document_url = '')
              AND ingestion_status = 'MAPPED'""",
    "documentsWithoutHash":
        "SELECT COUNT(*) FROM documents WHERE document_hash IS NULL OR document_hash = ''",
    "documentsWithoutRetrievalTime":
        "SELECT COUNT(*) FROM documents WHERE created_at IS NULL",
    "amendmentsWithoutReference":
        "SELECT COUNT(*) FROM regulation_amendments WHERE reference IS NULL OR reference = ''",
    "amendmentsWithoutDate":
        "SELECT COUNT(*) FROM regulation_amendments WHERE amended_on IS NULL OR amended_on = ''",
    "amendmentsWithBrokenRegulation":
        """SELECT COUNT(*) FROM regulation_amendments a WHERE NOT EXISTS
           (SELECT 1 FROM regulations r WHERE r.id = a.regulation_id)""",
    "unresolvedCrossReferences":
        "SELECT COUNT(*) FROM cross_references WHERE resolved IS NULL OR resolved::text IN ('0','false')",
    "definitionsWithoutTerm":
        "SELECT COUNT(*) FROM definitions WHERE term IS NULL OR term = ''",
    "penaltiesUnquantified":
        "SELECT COUNT(*) FROM penalty_provisions WHERE kind = 'UNQUANTIFIED'",
    "regulationsWithObligationsButNoProvisions":
        """SELECT COUNT(DISTINCT o.regulation_id) FROM obligations o WHERE NOT EXISTS
           (SELECT 1 FROM legal_provisions lp WHERE lp.regulation_id = o.regulation_id)""",
    "crossReferencesWithoutTarget":
        "SELECT COUNT(*) FROM cross_references WHERE target_regulation_id IS NULL",
    "sectionChangesWithoutRegulation":
        """SELECT COUNT(*) FROM section_changes sc WHERE NOT EXISTS
           (SELECT 1 FROM regulations r WHERE r.id = sc.regulation_id)""",
}

# Capabilities the schema declares but nothing populates. Reported explicitly
# so an empty tab is never mistaken for an empty corpus.
DECLARED_BUT_EMPTY = {
    "chapters": "no writer exists; sections.chapter_id is never set",
    "definition_usages": "defined terms are extracted but never resolved into later clauses",
    "regulation_versions": "superseded by document_versions, which is populated",
    "reporting_requirements": "superseded by obligations.obligation_type='REPORTING'",
    "disclosures": "superseded by obligations.obligation_type='DISCLOSURE'",
    "record_requirements": "superseded by obligations.obligation_type='DOCUMENTATION'",
    "validations": "this report replaces it; nothing writes the table",
}


SOURCE_COVERAGE = {
    "regulationsWithSourceUrl":
        """SELECT COUNT(*) FROM regulations
            WHERE official_document_url IS NOT NULL AND official_document_url <> ''""",
    "regulationsWithFetchedDocument":
        "SELECT COUNT(DISTINCT regulation_id) FROM documents",
    "documentsWithContentHash":
        "SELECT COUNT(*) FROM documents WHERE document_hash IS NOT NULL AND document_hash <> ''",
}


def _n(con, sql: str) -> int | None:
    try:
        return con.execute(sql).fetchone()[0]
    except Exception:
        return None


def report(con=None) -> dict:
    con = con or connect()
    mapped = _n(con, "SELECT COUNT(*) FROM regulations WHERE ingestion_status='MAPPED'") or 0
    total_regs = _n(con, "SELECT COUNT(*) FROM regulations") or 0
    pct = lambda x, d: (round(100.0 * x / d, 1) if d and x is not None else None)

    coverage = {}
    for name, sql in COVERAGE.items():
        v = _n(con, sql)
        coverage[name] = {"n": v, "of": mapped, "pct": pct(v, mapped)}

    source = {}
    for name, sql in SOURCE_COVERAGE.items():
        v = _n(con, sql)
        source[name] = {"n": v, "of": total_regs, "pct": pct(v, total_regs)}

    lineage = {}
    for name, (num_sql, den_sql) in LINEAGE.items():
        num, den = _n(con, num_sql), _n(con, den_sql)
        lineage[name] = {"n": num, "of": den, "pct": pct(num, den)}

    defects, findings = {}, 0
    for name, sql in DEFECTS.items():
        v = _n(con, sql)
        defects[name] = v
        findings += 1 if v else 0

    empty = {}
    for table, why in DECLARED_BUT_EMPTY.items():
        empty[table] = {"rows": _n(con, f"SELECT COUNT(*) FROM {table}"), "why": why}

    # semantic layers that DO carry the legal logic the empty tables imply
    semantics = {
        "conditions": _n(con, "SELECT COUNT(*) FROM provision_conditions"),
        "exceptions": _n(con, "SELECT COUNT(*) FROM provision_exceptions"),
        "thresholds": _n(con, "SELECT COUNT(*) FROM thresholds"),
        "timingRules": _n(con, "SELECT COUNT(*) FROM timing_rules"),
        "legalProvisions": _n(con, "SELECT COUNT(*) FROM legal_provisions"),
        "reportingObligations": _n(
            con, "SELECT COUNT(*) FROM obligations WHERE obligation_type='REPORTING'"),
        "disclosureObligations": _n(
            con, "SELECT COUNT(*) FROM obligations WHERE obligation_type='DISCLOSURE'"),
        "recordKeepingObligations": _n(
            con, "SELECT COUNT(*) FROM obligations WHERE obligation_type='DOCUMENTATION'"),
    }

    return {
        "corpus": {"regulations": total_regs, "mapped": mapped,
                   "sections": _n(con, "SELECT COUNT(*) FROM sections"),
                   "clauses": _n(con, "SELECT COUNT(*) FROM clauses"),
                   "obligations": _n(con, "SELECT COUNT(*) FROM obligations"),
                   "requirements": _n(con, "SELECT COUNT(*) FROM requirements"),
                   "amendments": _n(con, "SELECT COUNT(*) FROM regulation_amendments"),
                   "provenanceRecords": _n(con, "SELECT COUNT(*) FROM provenance")},
        "coverage": coverage,
        "sourceCoverage": source,
        "lineage": lineage,
        "defects": defects,
        "defectsWithFindings": findings,
        "declaredButEmpty": empty,
        "semanticLayers": semantics,
        "note": ("Every figure is a live COUNT. A zero in 'defects' means the check ran and "
                 "found nothing; a table in 'declaredButEmpty' is a capability the schema "
                 "declares that nothing populates — shown so an empty tab is never read as "
                 "an empty corpus."),
    }
