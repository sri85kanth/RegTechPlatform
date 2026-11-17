"""
Explicit change status for a regulation — never inferred.

Five states, each with a precise meaning. The critical distinction the product
must not blur:

  AMENDMENT_MENTIONED  the PDF says "Amended vide circular ..."   ← a statement we READ
  CHANGE_DETECTED      two captured versions have different hashes ← a change we COMPUTED

A document may be AMENDMENT_MENTIONED and simultaneously have no computed
change; that is the normal case and must not be presented as detection.
"""
from typing import Literal

Status = Literal[
    "NOT_CHECKED",           # never downloaded, so nothing to compare
    "INSUFFICIENT_HISTORY",  # one version captured; a second crawl is required
    "CHECKED_UNCHANGED",     # re-downloaded, hash identical
    "CHANGE_DETECTED",       # two versions, hashes differ, sections compared
    "SOURCE_CHANGED_UNVERIFIED",  # bytes moved but the new copy could not be read
    "AMENDMENT_MENTIONED",   # the document states its own amendments
]

LABEL: dict[str, str] = {
    "NOT_CHECKED": "Not checked",
    "INSUFFICIENT_HISTORY": "Insufficient history",
    "CHECKED_UNCHANGED": "Checked — no change",
    "CHANGE_DETECTED": "Change detected",
    "SOURCE_CHANGED_UNVERIFIED": "Source changed — content unreadable",
    "AMENDMENT_MENTIONED": "Amendment mentioned in source",
}

EXPLANATION: dict[str, str] = {
    "NOT_CHECKED": "This document has not been downloaded, so no comparison is possible.",
    "INSUFFICIENT_HISTORY": "Only one version of this document has been captured. A future crawl is required before a document-to-document change can be calculated.",
    "CHECKED_UNCHANGED": "The document was downloaded again and its content hash was identical to the stored copy.",
    "CHANGE_DETECTED": "Two captured versions have different content hashes; the differing sections were compared word by word.",
    "SOURCE_CHANGED_UNVERIFIED": "The source file changed, but the new copy could not be read (a scan with no OCR available, or a failed extraction), so no section-level comparison was performed. What changed is not yet known.",
    "AMENDMENT_MENTIONED": "The document states its own amendment history in footnotes. This is a statement found in the source, not a change computed by comparing versions.",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  source_url TEXT,
  http_status INTEGER,
  content_hash TEXT,
  previous_hash TEXT,
  outcome TEXT,              -- UNCHANGED | CHANGED | CHANGED_UNVERIFIED
                             -- | BASELINE_CAPTURED | UNREACHABLE | NO_URL
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_sc_reg  ON source_checks(regulation_id);
CREATE INDEX IF NOT EXISTS idx_sc_when ON source_checks(checked_at);
"""


def init(con):
    con.executescript(SCHEMA)
    con.commit()
    return con


def classify(versions: int, changes: int, amendments: int,
             has_document: bool, last_outcome: str | None) -> str:
    """
    The ONE place the five states are decided. Precedence, most-evidenced first.
    Both status_for() and the list endpoint call this, so a row in a table and
    the same row on its detail page can never disagree.
    """
    if changes > 0:
        # a real section-level diff between two captured versions
        return "CHANGE_DETECTED"
    if last_outcome == "CHANGED_UNVERIFIED":
        # The bytes demonstrably moved. That is weaker than a computed diff but
        # stronger than a footnote, and it must not be swallowed into
        # INSUFFICIENT_HISTORY — an unreadable change is still a change.
        return "SOURCE_CHANGED_UNVERIFIED"
    if last_outcome == "UNCHANGED":
        # the source was re-fetched and the content hash was identical.
        # This is the ONLY route to CHECKED_UNCHANGED: it requires a recorded
        # re-check. Version count alone can never imply it, because after the
        # dedup fix a second version can only exist when the text DIFFERED.
        return "CHECKED_UNCHANGED"
    if amendments > 0:
        # the document's own footnotes state it was amended. That is the
        # regulator speaking, not a comparison this system performed.
        return "AMENDMENT_MENTIONED"
    if versions >= 1 or has_document:
        return "INSUFFICIENT_HISTORY"
    return "NOT_CHECKED"


def status_for(con, regulation_id: str) -> dict:
    """
    Compute the status from evidence in the database. No guessing, and the
    reason is returned alongside so the UI can show why.
    """
    init(con)
    versions = con.execute(
        "SELECT COUNT(*) FROM document_versions WHERE regulation_id=?", (regulation_id,)).fetchone()[0]
    changes = con.execute(
        "SELECT COUNT(*) FROM section_changes WHERE regulation_id=?", (regulation_id,)).fetchone()[0]
    wording = con.execute(
        "SELECT COUNT(*) FROM section_changes WHERE regulation_id=? AND change_class='WORDING'",
        (regulation_id,)).fetchone()[0]
    doc = con.execute(
        "SELECT document_hash, storage_path FROM documents WHERE regulation_id=?", (regulation_id,)).fetchone()
    amendments = con.execute(
        "SELECT COUNT(*) FROM regulation_amendments WHERE regulation_id=?", (regulation_id,)).fetchone()[0]
    last = con.execute(
        """SELECT checked_at, outcome, content_hash, previous_hash FROM source_checks
           WHERE regulation_id=? ORDER BY id DESC LIMIT 1""", (regulation_id,)).fetchone()

    status = classify(versions, changes, amendments, doc is not None, last["outcome"] if last else None)

    return {
        "status": status,
        "label": LABEL[status],
        "explanation": EXPLANATION[status],
        "versionsCaptured": versions,
        "computedChanges": changes,
        # Split out so the UI never presents forty renumbered cross-references
        # as forty amendments. Both numbers are shown; neither is hidden.
        "wordingChanges": wording,
        "numberingOnlyChanges": changes - wording,
        # kept deliberately separate: a mention is not a detection
        "amendmentsMentioned": amendments,
        "amendmentsMentionedInSource": amendments,
        "message": EXPLANATION[status],
        "canCompare": versions >= 2,
        "amendmentStatus": "AMENDMENT_MENTIONED" if amendments else None,
        "lastCheckedAt": last["checked_at"] if last else None,
        "lastOutcome": last["outcome"] if last else None,
        "currentHash": last["content_hash"] if last else (doc["document_hash"] if doc else None),
        "previousHash": last["previous_hash"] if last else None,
    }
