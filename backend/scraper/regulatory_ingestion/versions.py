"""
Version capture — the prerequisite for showing real old → new text.

Today a re-crawl overwrites the extracted text, so the previous wording is gone
and no diff is possible. This stores a content-hashed snapshot of every section
on each ingest. When the same document is ingested again and a section's hash
has moved, the previous text is still there to diff against.

Nothing here fabricates a prior version. If only one snapshot exists, the honest
answer is "no comparison available yet", and the amendment footnote is the
evidence instead.
"""
import hashlib
import json
import re
from datetime import datetime, timezone

from .amendments import word_diff, diff_stats

# ---------------------------------------------------------------------------
# WHY A COMPARISON KEY AND NOT THE RAW TEXT
#
# Diffing two real archived copies of the RBI KYC Master Direction produced 73
# "changed" sections, of which 37 contained no changed words at all. Two causes,
# both artefacts of the pipeline rather than acts of the regulator:
#
#   1. pypdf splits words differently between extractions of the same PDF, so
#      "medium" comes out as "medi um" in one copy and "medium" in the other.
#   2. Inserting one footnote shifts every later marker, so "35Further" becomes
#      "36Further" throughout, and each footnote DEFINITION at the foot of the
#      page is renumbered with it. Footnote apparatus is not regulation text —
#      which circular made a change is already recorded in regulation_amendments
#      — so it decides nothing here. It is still SHOWN, because it is the best
#      evidence a reviewer has for who changed what.
#
# Hashing the raw text therefore reports the regulator as having amended
# sections nobody touched. The comparison key removes exactly those two
# artefacts and NOTHING else — digits that are not footnote markers survive, so
# a threshold moving from 50,000 to 1,00,000 is still a change. Suppressing a
# real numeric amendment would be far worse than the noise it removes.
# ---------------------------------------------------------------------------

# A footnote marker: 1-3 digits welded directly onto a word, no space. A money
# threshold or a dated reference is always separated by a space or punctuation,
# so this cannot swallow one.
_GLUED_MARKER = re.compile(r"(?<![0-9A-Za-z])(\d{1,3})(?=[A-Za-z]{2,})")

# A whole footnote definition: "113 Amended vide circular DOR.AML.REC.30/… dated
# June 12, 2025." The trailing "dated <Month> <D>, <YYYY>" is required, so this
# cannot run past the footnote and eat the regulation text after it.
_FOOTNOTE_DEF = re.compile(
    r"(?<![0-9A-Za-z])\d{1,3}\s*"
    r"(?:Amended|Inserted|Substituted|Omitted|Added|Deleted|Repealed|Modified)\s+vide\s+"
    r".*?dated\s+[A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4}\s*\.?",
    re.IGNORECASE | re.DOTALL)


def comparison_key(text: str) -> str:
    """What decides whether a section CHANGED. Not what is shown to a reviewer."""
    t = _FOOTNOTE_DEF.sub(" ", text or "")
    t = _GLUED_MARKER.sub("", t)
    # Dropping every space defeats intra-word split artefacts in one move.
    return re.sub(r"[^0-9A-Za-z]+", "", t).lower()


def display_text(text: str) -> str:
    """
    What a reviewer reads. Whitespace tidied and inline markers dropped; wording
    untouched. Footnote DEFINITIONS are deliberately kept — they name the
    circular behind the change, which is the single most useful line in a diff.
    """
    return re.sub(r"\s+", " ", _GLUED_MARKER.sub("", text or "")).strip()

SCHEMA = """
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,   -- SHA-256 of the extracted section text: the ONLY dedup key
  document_hash TEXT,           -- SHA-256 of the source PDF bytes: provenance metadata, never a dedup key
  page_count INTEGER,
  section_count INTEGER,
  source_url TEXT,
  retrieved_from TEXT,          -- REGULATOR | INTERNET_ARCHIVE
  retrieved_at TEXT             -- when WE fetched it; captured_at is when the copy is FROM
);
CREATE INDEX IF NOT EXISTS idx_dv_reg ON document_versions(regulation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dv_content ON document_versions(regulation_id, content_hash);

CREATE TABLE IF NOT EXISTS section_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  section_number TEXT,
  section_title TEXT,
  text_hash TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ss_ver  ON section_snapshots(version_id);
CREATE INDEX IF NOT EXISTS idx_ss_hash ON section_snapshots(text_hash);

CREATE TABLE IF NOT EXISTS section_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  from_version INTEGER REFERENCES document_versions(id) ON DELETE CASCADE,
  to_version   INTEGER REFERENCES document_versions(id) ON DELETE CASCADE,
  section_number TEXT,
  change_type TEXT,          -- added | removed | modified
  old_text TEXT,
  new_text TEXT,
  diff_runs TEXT,            -- JSON: [{type: equal|added|removed, text}]
  words_added INTEGER,
  words_removed INTEGER,
  change_class TEXT,         -- WORDING | NUMBERING_ONLY
  detected_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sc_reg ON section_changes(regulation_id);
"""

_h = lambda s: hashlib.sha256(s.strip().encode("utf-8")).hexdigest()
_key_h = lambda s: hashlib.sha256(comparison_key(s).encode("utf-8")).hexdigest()
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


def init(con):
    con.executescript(SCHEMA)
    # CREATE TABLE IF NOT EXISTS does nothing to an existing table, new columns
    # included, so the declaration above never reaches a live database.
    cols = {r[1] for r in con.execute("PRAGMA table_info(section_changes)")}
    if "change_class" not in cols:
        con.execute("ALTER TABLE section_changes ADD COLUMN change_class TEXT")
    vcols = {r[1] for r in con.execute("PRAGMA table_info(document_versions)")}
    for col in ("source_url", "retrieved_from", "retrieved_at"):
        if col not in vcols:
            con.execute(f"ALTER TABLE document_versions ADD COLUMN {col} TEXT")
    con.commit()
    return con


# Letters only. Two sections whose words are identical and whose numbers moved
# have been renumbered, not amended: inserting one footnote or paragraph shifts
# every marker after it. Real for provenance, noise for a compliance reviewer —
# so it is LABELLED rather than hidden. Suppressing it outright would also hide
# a genuine cross-reference change, and nothing here is allowed to hide a change.
_LETTERS = re.compile(r"[^a-z]")


def _collapse_artifacts(runs: list[dict]) -> list[dict]:
    """
    word_diff emits a replacement as an adjacent removed/added pair. When the two
    sides carry the SAME comparison key the regulator changed nothing — pypdf
    split a word differently ("medi um" / "medium"), or a footnote marker moved.
    Leaving those in makes a real amendment unreadable inside its own diff, and
    inflates the word counts a reviewer uses to judge how big a change is.
    """
    out: list[dict] = []
    i = 0
    while i < len(runs):
        a = runs[i]
        b = runs[i + 1] if i + 1 < len(runs) else None
        if (b and {a["type"], b["type"]} == {"removed", "added"}
                and comparison_key(a["text"]) == comparison_key(b["text"])):
            new_side = b if b["type"] == "added" else a
            out.append({"type": "equal", "text": new_side["text"]})
            i += 2
            continue
        out.append(a)
        i += 1
    return out


def change_class(old_text: str, new_text: str) -> str:
    if _LETTERS.sub("", comparison_key(old_text)) == _LETTERS.sub("", comparison_key(new_text)):
        return "NUMBERING_ONLY"
    return "WORDING"


def capture(con, regulation_id: str, sections: list[dict],
            document_hash: str | None = None, page_count: int | None = None,
            captured_at: str | None = None, source_url: str | None = None,
            retrieved_from: str = "REGULATOR") -> int | None:
    """
    Store a snapshot. Returns the new version id, or None when this exact
    content is already the latest capture (a re-crawl that changed nothing).

    `captured_at` is the date the copy IS FROM, not the date we fetched it. A
    version recovered from a web archive is evidence about May 2025 even though
    it was retrieved today, and ordering the history by retrieval date would
    diff the document backwards. `retrieved_from` records that the bytes came
    via an archive rather than from the regulator, because a reviewer acting on
    a change is entitled to know which copy is authoritative.
    """
    init(con)
    norm = [{
        "no": str(s.get("no") or s.get("section_number") or ""),
        "title": s.get("title") or s.get("section_title") or "",
        "text": (s.get("text") or s.get("section_text") or "").strip(),
    } for s in sections]
    norm = [s for s in norm if s["text"]]

    # Dedup ALWAYS on the comparison key of the extracted text, because that is
    # what compare() uses to decide a section moved. Keying on the caller-supplied
    # document_hash instead would let one crawl be stored twice under two hash
    # bases and masquerade as a second version.
    content_hash = _key_h("\n".join(s["text"] for s in norm))

    existing = con.execute(
        "SELECT id FROM document_versions WHERE regulation_id=? AND content_hash=?",
        (regulation_id, content_hash)).fetchone()
    if existing:
        return None

    cur = con.execute(
        """INSERT INTO document_versions
             (regulation_id,captured_at,content_hash,document_hash,page_count,
              section_count,source_url,retrieved_from,retrieved_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (regulation_id, captured_at or _now(), content_hash, document_hash, page_count,
         len(norm), source_url, retrieved_from, _now()))
    vid = cur.lastrowid
    con.executemany(
        "INSERT INTO section_snapshots (version_id,section_number,section_title,text_hash,text) VALUES (?,?,?,?,?)",
        [(vid, s["no"], s["title"], _key_h(s["text"]), s["text"]) for s in norm])
    con.commit()
    return vid


def versions(con, regulation_id: str) -> list[dict]:
    init(con)
    # Chronological, NOT by id. A version recovered from an archive is inserted
    # after versions we already hold but belongs before them in time; ordering by
    # id would hand compare() the pair backwards and report every insertion as a
    # deletion. captured_at is the date the copy is from, so it is the only
    # correct sort key here.
    return [dict(r) for r in con.execute(
        "SELECT * FROM document_versions WHERE regulation_id=? ORDER BY captured_at, id",
        (regulation_id,))]


def compare(con, regulation_id: str, from_version: int, to_version: int, persist: bool = True) -> list[dict]:
    """Diff two captured versions section by section, word level."""
    init(con)
    if from_version is None or to_version is None:
        raise ValueError("compare() needs two captured versions; capture() returns None when content is unchanged")
    load = lambda v: {r[0]: (r[1], r[2]) for r in con.execute(
        "SELECT section_number, text, text_hash FROM section_snapshots WHERE version_id=?", (v,))}
    old, new = load(from_version), load(to_version)

    changes: list[dict] = []
    for num in sorted(set(old) | set(new), key=lambda x: (len(x), x)):
        o_text, o_hash = old.get(num, ("", ""))
        n_text, n_hash = new.get(num, ("", ""))
        if o_hash == n_hash:
            continue
        kind = "added" if not o_text else "removed" if not n_text else "modified"
        runs = _collapse_artifacts(word_diff(display_text(o_text), display_text(n_text)))
        st = diff_stats(runs)
        changes.append({
            "section_number": num, "change_type": kind,
            "change_class": change_class(o_text, n_text),
            "old_text": o_text, "new_text": n_text, "diff_runs": runs,
            "words_added": st["added_words"], "words_removed": st["removed_words"],
        })

    if persist and changes:
        con.execute("DELETE FROM section_changes WHERE regulation_id=? AND from_version=? AND to_version=?",
                    (regulation_id, from_version, to_version))
        con.executemany(
            """INSERT INTO section_changes
               (regulation_id,from_version,to_version,section_number,change_type,
                old_text,new_text,diff_runs,words_added,words_removed,change_class,detected_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(regulation_id, from_version, to_version, c["section_number"], c["change_type"],
              c["old_text"], c["new_text"], json.dumps(c["diff_runs"]),
              c["words_added"], c["words_removed"], c["change_class"], _now()) for c in changes])
        con.commit()
    return changes
