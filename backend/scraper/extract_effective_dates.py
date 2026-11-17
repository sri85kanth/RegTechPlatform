#!/usr/bin/env python3
"""
Extract when each regulation actually starts binding.

WHY THIS EXISTS
---------------
`effective_from` was empty for all 1,759 regulations, which meant the product
could not answer "what bites, and when" — no deadline, no calendar, no advisory
question 11. It is the single field standing between this system and a real
compliance calendar.

THREE CASES, KEPT APART
-----------------------
Regulatory commencement language is not one thing, and collapsing it into one
column would manufacture certainty that the source text does not carry:

  STATED_DATE        "shall come into force on April 01, 2025"
                     The instrument names its own date. This is a fact.

  IMMEDIATE_ON_ISSUE "shall come into force with immediate effect", or
                     "on the day they are placed on the official website".
                     The instrument binds from issue. The DATE is therefore
                     derived from issued_on — it is a system inference, not a
                     quoted date, and is labelled as one.

  NOT_STATED         The document does not say. Left NULL. Silence is not a
                     date, and a guessed commencement is worse than none.

WHAT IS DELIBERATELY EXCLUDED
-----------------------------
"With effect from February 22, 2003, RBI authorized four PVBs…" is body text
describing a past event, not the instrument's own commencement. Only the
opening sections — where Short Title and Commencement live — are read, and only
when the sentence is about *these* Directions. Scanning the whole document for
"with effect from" would have harvested hundreds of historical references and
filed them as effective dates.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect  # noqa: E402

MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], 1)}
# Short month names appear in issued_on ("7-Jan-1846", "Apr 22, 2025"), so they
# must be in the table BEFORE the pattern is built from it.
MONTHS.update({m[:3]: i for m, i in list(MONTHS.items())})
MON_RE = "|".join(sorted(MONTHS, key=len, reverse=True))

# "April 01, 2025" · "1st April 2025" · "01.04.2025" · "01/04/2025"
_D1 = re.compile(rf"\b({MON_RE})[\s\-./]+(\d{{1,2}})\s*,?[\s\-./]*((?:19|20)\d{{2}})", re.I)
_D2 = re.compile(rf"\b(\d{{1,2}})\s*(?:st|nd|rd|th)?[\s\-./]+(?:day\s+of\s+)?({MON_RE})[\s\-./]*,?[\s\-./]*((?:19|20)\d{{2}})", re.I)
_D3 = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-]((?:18|19|20)\d{2})\b")

# The instrument talking about itself. "These Directions", "this Circular",
# "the Regulations" — not a sentence about what somebody did in 2003.
_SELF = r"(?:these|this|the)\s+(?:present\s+)?(?:directions?|regulations?|guidelines?|rules?|circular|notification|master\s+direction|instructions?|provisions?|scheme|order|policy)"

_COMMENCE = re.compile(
    rf"{_SELF}[^.]{{0,120}}?\b(?:shall\s+)?(?:come\s+into\s+(?:force|effect|operation)|"
    rf"be\s+effective|take\s+effect|be\s+deemed\s+to\s+have\s+come\s+into\s+force)\b", re.I)

_IMMEDIATE = re.compile(
    r"\b(?:with\s+immediate\s+effect|immediately\s+upon\s+(?:its\s+)?issuance|"
    r"on\s+the\s+day\s+(?:they|it)\s+(?:are|is)\s+placed\s+on\s+the\s+official\s+website|"
    r"from\s+the\s+date\s+of\s+(?:its\s+)?(?:issue|issuance|publication))\b", re.I)

_SPLIT = re.compile(r"(?<=[.;])\s+(?=[A-Z(\d])|\n+")

# Commencement lives at the front of an instrument. Reading further is how body
# text gets mistaken for it.
HEAD_SECTIONS = 6
HINT = ("commencement", "short title", "effective", "applicability", "introduction")


def _parse(txt: str) -> date | None:
    m = _D1.search(txt)
    if m:
        try:
            return date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)))
        except ValueError:
            return None
    m = _D2.search(txt)
    if m:
        try:
            return date(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1)))
        except ValueError:
            return None
    m = _D3.search(txt)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if mo > 12:            # dd/mm vs mm/dd — only accept the unambiguous read
            d, mo = mo, d
        try:
            return date(y, mo, d)
        except ValueError:
            return None
    return None


def normalise(raw: str | None) -> str | None:
    """
    issued_on is stored as free text in whatever shape the source used —
    "2026-01-01", "16-02-2018", "7-Jan-1846", "Apr 22, 2025". Deriving an
    effective date from it without normalising wrote dd-mm-yyyy strings into a
    column the calendar reads as ISO, which Postgres then refused to cast.
    """
    if not raw or not raw.strip():
        return None
    t = raw.strip()
    if re.match(r"^(19|20)\d{2}-\d{2}-\d{2}$", t):
        return t
    d = _parse(t)
    if d:
        return d.isoformat()
    m = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-]((?:18|19|20)\d{2})$", t)
    if m:                                     # dd-mm-yyyy, the Indian convention
        dd, mm, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if mm > 12:
            dd, mm = mm, dd
        try:
            return date(yy, mm, dd).isoformat()
        except ValueError:
            return None
    return None


def find(sections: list[dict], issued_on: str | None) -> tuple[str | None, str, str | None]:
    """→ (iso date | None, basis, evidence sentence | None)"""
    head = sections[:HEAD_SECTIONS]
    head += [s for s in sections[HEAD_SECTIONS:]
             if any(h in (s.get("section_title") or "").lower() for h in HINT)][:4]

    immediate_ev = None
    for sec in head:
        for seg in _SPLIT.split(sec.get("section_text") or ""):
            if not _COMMENCE.search(seg):
                continue
            d = _parse(seg)
            if d:
                return d.isoformat(), "STATED_DATE", re.sub(r"\s+", " ", seg).strip()[:300]
            if _IMMEDIATE.search(seg) and immediate_ev is None:
                immediate_ev = re.sub(r"\s+", " ", seg).strip()[:300]

    if immediate_ev:
        # Binds from issue. The date is only as good as issued_on, and when we
        # have no issue date we record the basis without inventing a day.
        return normalise(issued_on), "IMMEDIATE_ON_ISSUE", immediate_ev
    return None, "NOT_STATED", None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write; otherwise report only")
    a = ap.parse_args()

    con = connect()
    con.execute("ALTER TABLE regulations ADD COLUMN IF NOT EXISTS effective_basis TEXT")
    con.execute("ALTER TABLE regulations ADD COLUMN IF NOT EXISTS effective_evidence TEXT")
    con.commit()

    regs = [dict(r) for r in con.execute(
        "SELECT id, issued_on FROM regulations WHERE id IN "
        "(SELECT DISTINCT regulation_id FROM sections) ORDER BY id").fetchall()]
    print(f"[effective] {len(regs)} regulations with stored sections")

    tally, updates = Counter(), []
    for n, r in enumerate(regs, 1):
        secs = [dict(x) for x in con.execute(
            "SELECT section_title, section_text FROM sections "
            "WHERE regulation_id=? ORDER BY id", (r["id"],)).fetchall()]
        iso, basis, ev = find(secs, r["issued_on"])
        tally[basis] += 1
        if iso is None and basis == "IMMEDIATE_ON_ISSUE":
            tally["IMMEDIATE_but_no_issue_date"] += 1
        updates.append((iso, basis, ev, r["id"]))
        if n % 200 == 0:
            print(f"  … {n}/{len(regs)}")

    for k, v in tally.most_common():
        print(f"    {k:32} {v}")

    if a.apply:
        con.executemany(
            "UPDATE regulations SET effective_from=?, effective_basis=?, "
            "effective_evidence=? WHERE id=?", updates)
        con.commit()
        print(f"\nwritten: {len(updates)} rows")
    else:
        print("\n(report only — pass --apply to write)")


if __name__ == "__main__":
    main()
