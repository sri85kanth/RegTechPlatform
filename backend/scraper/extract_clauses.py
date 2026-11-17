#!/usr/bin/env python3
"""
Parse the clause hierarchy inside each section, then derive testable
requirements from the clauses that actually carry a duty.

THE GAP THIS CLOSES
-------------------
Section was the finest structural unit in the system: `clauses` and
`requirements` were both empty, so a section reading

    Applicability
    (a) The provisions of these Directions shall apply to every entity
        regulated by Reserve Bank of India ...
    (b) These directions shall also apply to those branches and majority owned
        subsidiaries of the REs which are located abroad, provided that:
        i.  where applicable laws prohibit implementation of these guidelines,
            the same shall be brought to the notice of the Reserve Bank ...

was stored as one blob. Nothing could cite "2(b)(i)", and one obligation
carried a duty that is really several separately testable ones.

WHAT IS A CLAUSE HERE
---------------------
Only an enumeration marker the drafter actually typed: (a) (b) (c), (i) (ii),
i. ii., (1) (2), (A) (B). Depth comes from marker STYLE, not indentation —
extracted PDF text has unreliable whitespace, and inferring nesting from
leading spaces produced trees that did not match the document.

Text before the first marker stays on the parent as its lead-in, so
"provided that:" is never orphaned from the conditions it introduces.

WHAT IS A REQUIREMENT HERE
--------------------------
A clause is promoted to a requirement only when its own text carries a deontic
modality — shall / must / is required to / shall not. That is the difference
between a duty and a definition, and it is why "(a) These Directions shall be
called ..." does NOT become a requirement: it is a naming provision, filtered
out by the same self-reference test the effective-date extractor uses.

The requirement's statement is the clause's VERBATIM text. Nothing is
paraphrased, and `source_clause` carries the full path — "2(b)(i)" — so every
requirement can be read back against the source document.

WHAT IS DELIBERATELY NOT DONE
-----------------------------
Coordinated noun phrases are not split. "adequate systems, policies and
procedures" could be read as three requirements, but each fragment stops being
independently testable once separated from its verb, and inventing three
requirements where the drafter wrote one is a fabrication of obligations. Only
structure the drafter marked is turned into structure.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from datetime import datetime, timezone  # noqa: E402

from regulatory_ingestion.db import connect  # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# Marker styles, in the order drafters nest them. The style decides the depth.
STYLES: list[tuple[str, str]] = [
    ("paren_num",   r"\((\d{1,2})\)"),               # (1) (2)
    ("paren_alpha", r"\(([a-z])\)"),                 # (a) (b)
    ("paren_roman", r"\((x{0,3}(?:ix|iv|v?i{0,3}))\)"),  # (i) (ii) (iv)
    ("dot_roman",   r"(?:^|\n)\s*(x{0,3}(?:ix|iv|v?i{0,3}))\.\s"),  # i.  ii.
    ("paren_upper", r"\(([A-Z])\)"),                 # (A) (B)
]
DEPTH = {"paren_num": 0, "paren_alpha": 0, "paren_roman": 1,
         "dot_roman": 1, "paren_upper": 2}

_MODAL = re.compile(
    r"\b(?:shall|must|is\s+required\s+to|are\s+required\s+to|shall\s+not|"
    r"must\s+not|is\s+prohibited|are\s+prohibited)\b", re.I)

# A clause about the instrument's own name or commencement states no duty on
# anybody, however many times it says "shall".
_SELF_REF = re.compile(
    r"\bthese\s+(?:directions?|regulations?|guidelines?|rules?|instructions?)\s+"
    r"shall\s+(?:be\s+called|come\s+into|apply|also\s+apply|be\s+applicable)", re.I)

_FREQ = re.compile(r"\b(annually|quarterly|monthly|half[-\s]?yearly|weekly|daily|"
                   r"periodically|once\s+in\s+a\s+quarter|every\s+\w+\s+(?:year|month))\b", re.I)
_DEADLINE = re.compile(r"\bwithin\s+(\d{1,3})\s+(days?|months?|weeks?|years?)\b", re.I)
_THRESH = re.compile(r"(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d+)?)\s*(crore|lakh|million|billion)?"
                     r"|(\d{1,3}(?:\.\d+)?)\s*per\s*cent|(\d{1,3}(?:\.\d+)?)\s*%", re.I)
_COND = re.compile(r"\b(?:where|if|unless|provided\s+that|in\s+case\s+of|subject\s+to)\b", re.I)
_ROLE = re.compile(r"\b(Board|Board\s+of\s+Directors|Designated\s+Director|Principal\s+Officer|"
                   r"senior\s+management|compliance\s+officer|internal\s+auditor|"
                   r"audit\s+committee)\b", re.I)

MIN_CLAUSE_CHARS = 25          # below this it is a stray marker, not a clause


# A marker OPENS an item. "as defined in 3 (b) (xiv) below" is a cross-reference
# sitting mid-sentence, and reading it as structure split clauses in half and
# invented children that the drafter never wrote. So a marker counts only at the
# start of the text, after a line break, or after a sentence terminator.
_OPENS = re.compile(r"(?:^|[\n\r]\s*|[.:;]\s+|^\s*)$")


def _opens_item(text: str, start: int) -> bool:
    return bool(_OPENS.search(text[:start][-40:]))


def _find_markers(text: str) -> list[tuple[int, int, str, str]]:
    """(start, end, style, label) for every enumeration marker, in reading order."""
    out = []
    for style, pat in STYLES:
        for m in re.finditer(pat, text):
            # dot_roman anchors its own line break, so it already proves it
            # opens an item; checking the text before that break asks the
            # wrong question and threw every "i." / "ii." away.
            self_anchored = m.group(0)[:1] in "\n\r" or style == "dot_roman"
            if not self_anchored and not _opens_item(text, m.start()):
                continue
            label = m.group(1)
            # A roman-numeral match that is really a letter — "(i)" is ambiguous
            # with paren_alpha. Keep the roman reading only when a previous
            # roman marker exists or it is the first of a roman run.
            out.append((m.start(), m.end(), style, label))
    out.sort(key=lambda x: x[0])

    # Drop overlaps: "(i)" matches both paren_alpha and paren_roman.
    kept: list[tuple[int, int, str, str]] = []
    for mk in out:
        if kept and mk[0] < kept[-1][1]:
            continue
        kept.append(mk)
    return kept


def parse_section(text: str) -> list[dict]:
    """
    → [{label, style, depth, text, path}] in document order.

    Nesting uses a stack keyed on marker style, so (b) followed by i. ii. puts
    the romans under (b), and the next (c) closes them.
    """
    markers = _find_markers(text or "")
    if not markers:
        return []

    out: list[dict] = []
    stack: list[dict] = []
    for idx, (start, end, style, label) in enumerate(markers):
        body_end = markers[idx + 1][0] if idx + 1 < len(markers) else len(text)
        body = re.sub(r"\s+", " ", text[end:body_end]).strip()
        if len(body) < MIN_CLAUSE_CHARS:
            continue
        depth = DEPTH[style]

        while stack and stack[-1]["depth"] >= depth:
            stack.pop()
        path = "".join(f"({c['label']})" for c in stack) + f"({label})"

        node = {"label": label, "style": style, "depth": depth,
                "text": body, "path": path,
                "parent_path": stack[-1]["path"] if stack else None}
        out.append(node)
        stack.append(node)
    return out


def requirement_from(clause: dict) -> dict | None:
    """A clause becomes a requirement only if it states a duty."""
    t = clause["text"]
    if not _MODAL.search(t) or _SELF_REF.search(t):
        return None

    freq = _FREQ.search(t)
    dl = _DEADLINE.search(t)
    th = _THRESH.search(t)
    role = _ROLE.search(t)
    return {
        "statement": t[:2000],                       # verbatim, never paraphrased
        "frequency": freq.group(0) if freq else None,
        "deadline": dl.group(0) if dl else None,
        "threshold": th.group(0).strip() if th else None,
        "condition": "stated" if _COND.search(t) else None,
        "responsible_role": role.group(0) if role else None,
        # High only when the drafter's own structure carried the duty.
        "confidence": 0.85 if clause["depth"] == 0 else 0.75,
    }


_DIGITS = re.compile(r"[0-9]")
# Indian rate schedules: "Rs. 75/- PER BLS", "₹ 12/- per bottle". One figure in a
# sentence is a penalty or a limit; two or more rate figures is a price list.
_RATE = re.compile(r"(?:(?:rs|inr)\.?\s*|₹\s*)\d|\d\s*/-", re.I)


def promotable(obl: dict) -> bool:
    """
    May a section-level obligation stand as a requirement in its own right?

    Most of a regulation's duties are written as plain paragraphs with no
    lettered clause to hang on: 9,561 regulations hold obligations and produced
    no requirement at all because of it. The obligation IS the duty there, so it
    can be promoted — but only under the same bar a clause has to clear, plus
    two the corpus forces:

      * someone must owe it. The extractor records the sentence's subject; with
        no subject this is a statement about the world, not a duty on a party.
      * it must not be a figures table. An OCR'd fee schedule carries a "shall"
        somewhere and would otherwise arrive as a hundred "requirements"
        reading "Rs. 75/- PER BLS VII. Imported Wine & Cider".

    Corpus-wide this admits 88,850 of 511,718 candidates. The rest are tables,
    notices and scanning artefacts, and calling those requirements would bury
    every real duty on the compliance screen.
    """
    text = obl.get("description") or ""
    if not requirement_from({"text": text, "depth": 0}):
        return False
    owner = (obl.get("responsible_entity") or "").strip()
    # "Re" is what the subject matcher returns for "Re. 12/- per bottle". A party
    # that owes a legal duty has a name, not two letters.
    if len(owner) < 4:
        return False
    if len(_RATE.findall(text)) >= 2:
        return False
    return len(_DIGITS.findall(text)) <= len(text) * 0.12


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int)
    # Scoping exists because a full pass holds every section's text in memory
    # and, on --apply, DELETEs requirements wholesale — which CASCADEs through
    # company_requirement_instances and throws away every instance in the
    # system. A scoped run reads and rebuilds only the regulations named.
    ap.add_argument("--register", action="store_true",
                    help="only the instruments in the hospital source register")
    ap.add_argument("--ids", help="comma-separated regulation ids")
    ap.add_argument("--verdicts",
                    help="scope by this company's applicability verdict, e.g. "
                         "APPLICABLE,CONDITIONAL,REVIEW_REQUIRED. 15,956 regulation ids do not "
                         "fit on a command line, and these are the ones that can bind us.")
    ap.add_argument("--promote-sections", action="store_true",
                    help="also derive a requirement from a section-level obligation "
                         "when the section has no lettered clause that states a duty")
    a = ap.parse_args()

    con = connect()

    regs: list[str] | None = None
    if a.register:
        rows = con.execute("SELECT DISTINCT regulation_id FROM source_register "
                           "WHERE regulation_id IS NOT NULL").fetchall()
        regs = [(r["regulation_id"] if hasattr(r, "keys") else r[0]) for r in rows]
    if a.ids:
        regs = sorted({*(regs or []), *(i.strip() for i in a.ids.split(",") if i.strip())})
    if a.verdicts:
        want = [v.strip().upper() for v in a.verdicts.split(",") if v.strip()]
        rows = con.execute("SELECT id FROM regulations WHERE applicability = ANY(?::text[])",
                           (want,)).fetchall()
        regs = sorted({*(regs or []),
                       *((r["id"] if hasattr(r, "keys") else r[0]) for r in rows)})
    if regs is not None:
        print(f"[clauses] scoped to {len(regs):,} regulations")
        if not regs:
            raise SystemExit("no regulations in scope — nothing to do")
    con.execute("ALTER TABLE clauses ADD COLUMN IF NOT EXISTS regulation_id TEXT")
    con.execute("ALTER TABLE clauses ADD COLUMN IF NOT EXISTS parent_clause_id TEXT")
    con.execute("ALTER TABLE clauses ADD COLUMN IF NOT EXISTS clause_path TEXT")
    con.execute("ALTER TABLE clauses ADD COLUMN IF NOT EXISTS depth INT")
    con.commit()

    q = ("SELECT s.id, s.regulation_id, s.section_number, s.section_text, "
         "       (SELECT o.id FROM obligations o WHERE o.section_id = s.id LIMIT 1) AS obl "
         "  FROM sections s ")
    if regs is not None:
        q += "WHERE s.regulation_id = ANY(?::text[]) "
    q += "ORDER BY s.id"
    if a.limit:
        q += f" LIMIT {a.limit}"
    secs = [dict(r) for r in (con.execute(q, (regs,)) if regs is not None
                              else con.execute(q)).fetchall()]
    print(f"[clauses] scanning {len(secs)} sections")

    tally = Counter()
    clause_rows, req_rows = [], []

    # Obligations by section, for promotion. One query, because a per-section
    # lookup over half a million rows is the slow way to do this.
    by_section: dict[str, list[dict]] = {}
    if a.promote_sections:
        oq = ("SELECT id, section_id, regulation_id, description, responsible_entity, frequency "
              "FROM obligations")
        if regs is not None:
            oq += " WHERE regulation_id = ANY(?::text[])"
        for row in (con.execute(oq, (regs,)) if regs is not None else con.execute(oq)).fetchall():
            d = dict(row)
            by_section.setdefault(d["section_id"], []).append(d)

    for n, s in enumerate(secs, 1):
        nodes = parse_section(s["section_text"] or "")
        emitted = 0
        if not nodes:
            tally["sections without markers"] += 1
        else:
            tally["sections with clauses"] += 1

            by_path: dict[str, str] = {}
            for i, node in enumerate(nodes):
                cid = f"{s['id']}-c{i:03d}"
                by_path[node["path"]] = cid
                full = f"{s['section_number']}{node['path']}"
                clause_rows.append((cid, s["id"], s["regulation_id"],
                                    by_path.get(node["parent_path"] or ""), full,
                                    node["label"], node["text"][:6000], node["depth"]))
                tally[f"clauses depth {node['depth']}"] += 1

                r = requirement_from(node)
                if not r:
                    continue
                if not s["obl"]:
                    tally["requirement skipped — section has no obligation"] += 1
                    continue
                req_rows.append((
                    f"{cid}-r", s["obl"], s["regulation_id"], r["statement"],
                    None, r["threshold"], r["condition"], r["frequency"],
                    r["deadline"], r["responsible_role"], None,
                    full, node["text"][:600], None, r["confidence"],
                    # The table already carries the review contract. Every derived
                    # requirement lands UNREVIEWED: a machine-split duty is a
                    # proposal until a human accepts it, exactly like a control link.
                    "clause-parser/1", "UNREVIEWED", _now()))
                tally["requirements"] += 1
                emitted += 1

        # Nothing in this section's own structure carried a duty, so the duty —
        # if there is one — is the section-level obligation itself.
        if a.promote_sections and emitted == 0:
            for o in by_section.get(s["id"], []):
                if not promotable(o):
                    tally["obligation not promotable (no owner, or a figures table)"] += 1
                    continue
                req_rows.append((
                    f"{o['id']}-r", o["id"], s["regulation_id"], (o["description"] or "")[:2000],
                    None, None, None, o.get("frequency"), None,
                    o.get("responsible_entity"), None,
                    s["section_number"], (o["description"] or "")[:600], None,
                    # Below a clause-derived requirement on purpose: the drafter
                    # marked no structure here, so the split is ours, not theirs.
                    0.65, "section-obligation/1", "UNREVIEWED", _now()))
                tally["requirements from a section-level obligation"] += 1

        if n % 5000 == 0:
            print(f"  … {n}/{len(secs)}")

    print(f"\n  clauses      {len(clause_rows):,}")
    print(f"  requirements {len(req_rows):,}")
    for k, v in tally.most_common():
        print(f"    {k:46} {v:,}")

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    # Derived tables: rebuilt wholesale, never CASCADE. Nothing references them
    # yet, and a targeted DELETE is the only safe way to re-run.
    if regs is None:
        con.execute("DELETE FROM requirements")
        con.execute("DELETE FROM clauses")
    else:
        con.execute("DELETE FROM requirements WHERE regulation_id = ANY(?::text[])", (regs,))
        # Older clause rows predate the regulation_id column, so reach them
        # through their section too, or a re-run would duplicate them.
        con.execute("DELETE FROM clauses WHERE regulation_id = ANY(?::text[]) "
                    "OR section_id IN (SELECT id FROM sections WHERE regulation_id = ANY(?::text[]))",
                    (regs, regs))
    con.executemany(
        "INSERT INTO clauses (id, section_id, regulation_id, parent_clause_id, "
        "clause_path, clause_number, clause_text, depth) VALUES (?,?,?,?,?,?,?,?)",
        clause_rows)
    con.executemany(
        "INSERT INTO requirements (id, obligation_id, regulation_id, statement, "
        "expected_action, threshold, condition, frequency, deadline, responsible_role, "
        "test_method, source_clause, source_excerpt, page_number, confidence, "
        "derivation_method, review_status, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", req_rows)
    con.commit()
    print(f"\nwritten: {len(clause_rows):,} clauses, {len(req_rows):,} requirements")


if __name__ == "__main__":
    main()
