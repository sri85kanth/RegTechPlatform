"""
Penalty provisions: what failing to comply actually costs, per regulation.

THE GAP THIS CLOSES
-------------------
The corpus held 150 sections titled "Penalties"/"Contravention" and 773
obligations mentioning penalties, and nothing read them. "How much do we pay
if we fail?" had no table, no extraction, no answer. This module extracts
penalty provisions DETERMINISTICALLY from the regulation's own text and stores
them with the exact sentence they came from.

HONESTY RULES
-------------
- Every row carries `basis_text` — the verbatim sentence the numbers came
  from. No sentence, no row.
- A penalty sentence whose amount cannot be parsed is stored as UNQUANTIFIED,
  never guessed.
- These are STATUTORY ceilings ("may extend to"), not predictions. Adjudicated
  amounts differ; enforcement.py records what regulators actually imposed.
- Amounts are rupees, stored as numbers only when the text states them.

Sentence grammar covered (real Indian drafting):
  "penalty which may extend to one lakh rupees"          -> FIXED max
  "not less than X ... may extend to Y"                  -> FIXED min..max
  "further penalty ... for every day during which"       -> PER_DAY
  "thrice the sum involved in such contravention"        -> MULTIPLIER
  "imprisonment for a term which may extend to N years"  -> IMPRISONMENT
  "cancel the certificate of registration"               -> SUSPENSION
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

METHOD = "deterministic-regex/1"

KINDS = ("FIXED_FINE", "PER_DAY", "MULTIPLIER_OF_SUM", "IMPRISONMENT",
         "SUSPENSION_CANCELLATION", "UNQUANTIFIED")

# ------------------------------------------------------------------ schema
def init(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS penalty_provisions (
      id TEXT PRIMARY KEY,
      regulation_id TEXT NOT NULL,
      section_id TEXT,
      section_number TEXT,
      kind TEXT NOT NULL,
      amount_min REAL,
      amount_max REAL,
      per_day_amount REAL,
      multiplier REAL,
      multiplier_basis TEXT,
      imprisonment_months INTEGER,
      basis_text TEXT NOT NULL,
      extraction_method TEXT NOT NULL,
      extracted_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_pen_reg ON penalty_provisions(regulation_id);
    """)
    return con


# ------------------------------------------------------------------ amounts
_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "fifteen": 15, "twenty": 20,
    "twenty-five": 25, "twenty five": 25, "fifty": 50, "hundred": 100,
    "thousand": 1_000, "lakh": 100_000, "lakhs": 100_000,
    "crore": 10_000_000, "crores": 10_000_000,
}
_UNIT = {"thousand": 1_000, "lakh": 100_000, "lakhs": 100_000,
         "crore": 10_000_000, "crores": 10_000_000}

_WORD_SEQ = r"(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty[- ]five|twenty|fifty|hundred|thousand|lakhs?|crores?)"
_NUM = r"[\d][\d,]*(?:\.\d+)?"

# numeric with optional unit: "₹5,000", "Rs. 5 lakh", "1 crore rupees", "5,00,000 rupees"
_A_NUMERIC = re.compile(
    rf"(?:₹|Rs\.?\s*|rupees\s+)?({_NUM})\s*(crores?|lakhs?|thousand)?(?:\s*(?:rupees|/-|\brs\b))?",
    re.I)
# spelled out: "one lakh rupees", "five thousand rupees", "one crore rupees"
_A_WORDS = re.compile(rf"((?:{_WORD_SEQ})(?:\s+{_WORD_SEQ}){{0,3}})\s+rupees", re.I)
_CURRENCYISH = re.compile(r"₹|rs\.?|rupees", re.I)


def _words_to_value(phrase: str) -> float | None:
    total, cur = 0.0, 0.0
    for w in re.split(r"[\s-]+", phrase.strip().lower()):
        if w not in _WORDS:
            return None
        v = _WORDS[w]
        if v >= 100:            # multiplier word scales what came before it
            cur = (cur or 1) * v
            total += cur
            cur = 0
        else:
            cur += v
    return (total + cur) or None


def amounts(text: str) -> list[tuple[float, str]]:
    """(rupee value, matched text) for every stated amount; never invented."""
    out: list[tuple[float, str]] = []
    for m in _A_WORDS.finditer(text):
        v = _words_to_value(m.group(1))
        if v:
            out.append((float(v), m.group(0)))
    for m in _A_NUMERIC.finditer(text):
        whole = m.group(0)
        # a bare number with no currency signal and no unit is not an amount
        if not m.group(2) and not _CURRENCYISH.search(whole):
            continue
        v = float(m.group(1).replace(",", ""))
        if m.group(2):
            v *= _UNIT[m.group(2).lower()]
        # skip if inside an already-captured worded amount
        if any(m.group(0) in t or t in m.group(0) for _, t in out):
            continue
        out.append((v, whole.strip()))
    return out


# ------------------------------------------------------------------ sentence classifier
# word-boundaried: "as deFINEd by" and "conFINEd" must not read as penalties
_PENALTYISH = re.compile(r"\b(?:penalt\w*|fine[sd]?|fine\b|punish\w*|contraven\w*|liable|imprison\w*|offence)", re.I)
_TOC_LINE = re.compile(r"\.{4,}|\u2026{2,}|(?:\u2026\s*){2,}")   # dotted-leader contents entries
_PER_DAY = re.compile(r"(?:every|each)\s+day\s+during\s+which|per\s+day", re.I)
_MULT = re.compile(r"\b(thrice|twice|three\s+times|two\s+times|([\d.]+)\s*times)\s+(?:of\s+)?the\s+"
                   r"((?:sum|amount)[^,;.]{0,60})", re.I)
_IMPR = re.compile(r"imprisonment[^.;]{0,80}?(?:extend\s+to|up\s+to)\s+(\w+(?:[- ]\w+)?)\s+(year|month)", re.I)
_CANCEL = re.compile(r"\b(cancel|suspend|revoke)[^.;]{0,80}(licence|license|registration|certificate|authori[sz]ation)", re.I)
_RANGE = re.compile(r"not\s+(?:be\s+)?less\s+than\s+(.{1,70}?)\s*(?:,|\bbut\b|\band\b)\s*.{0,60}?extend\s+to\s+(.{1,70}?)(?:[.;,]|$)", re.I | re.S)
_MAX = re.compile(r"(?:may\s+extend\s+to|up\s+to|maximum\s+of|not\s+exceed(?:ing)?)\s+(.{1,80}?)(?:[.;,]|\s+and\b|\s+or\b|$)", re.I | re.S)

_MULT_WORDS = {"thrice": 3.0, "three times": 3.0, "twice": 2.0, "two times": 2.0}


def _sentences(text: str) -> list[str]:
    # legal drafting runs long; split on sentence enders followed by space+capital/( — keep it coarse
    parts = re.split(r"(?<=[.;])\s+(?=[A-Z(₹])", re.sub(r"\s+", " ", text))
    return [p.strip() for p in parts if p.strip()]


def classify(sentence: str) -> list[dict]:
    """Provisions found in ONE sentence. Empty when it is not a penalty sentence."""
    if not _PENALTYISH.search(sentence) or _TOC_LINE.search(sentence):
        return []
    out: list[dict] = []
    s = sentence.strip()

    m = _MULT.search(s)
    if m:
        mult = _MULT_WORDS.get(re.sub(r"\s+", " ", m.group(1).lower()))
        if mult is None and m.group(2):
            mult = float(m.group(2))
        if mult:
            out.append({"kind": "MULTIPLIER_OF_SUM", "multiplier": mult,
                        "multiplier_basis": m.group(3).strip()[:120], "basis_text": s})

    m = _IMPR.search(s)
    if m:
        n = _WORDS.get(m.group(1).lower().replace("-", " ")) or (float(m.group(1)) if m.group(1).isdigit() else None)
        if n:
            months = int(n * 12) if m.group(2).lower().startswith("year") else int(n)
            out.append({"kind": "IMPRISONMENT", "imprisonment_months": months, "basis_text": s})

    if _PER_DAY.search(s):
        # the per-day amount is the one stated nearest the continuing clause
        amts = amounts(s)
        if amts:
            out.append({"kind": "PER_DAY", "per_day_amount": amts[-1][0], "basis_text": s})
        else:
            out.append({"kind": "PER_DAY", "basis_text": s})
        return out            # a continuing-penalty sentence is fully described

    r = _RANGE.search(s)
    if r:
        lo, hi = amounts(r.group(1)), amounts(r.group(2))
        if lo and hi:
            out.append({"kind": "FIXED_FINE", "amount_min": lo[0][0], "amount_max": hi[0][0], "basis_text": s})
            return out
    m = _MAX.search(s)
    if m:
        a = amounts(m.group(1))
        if a:
            out.append({"kind": "FIXED_FINE", "amount_max": a[0][0], "basis_text": s})
            return out
    if not out:
        a = amounts(s)
        if a and re.search(r"penalt|fine", s, re.I):
            out.append({"kind": "FIXED_FINE", "amount_min": a[0][0], "amount_max": a[0][0], "basis_text": s})
        elif _CANCEL.search(s):
            out.append({"kind": "SUSPENSION_CANCELLATION", "basis_text": s})
        elif re.search(r"penalt|punishable|liable", s, re.I):
            out.append({"kind": "UNQUANTIFIED", "basis_text": s})
    return out


# ------------------------------------------------------------------ extraction over the corpus
_TITLE = re.compile(r"penal|contraven|punish|offence|fine", re.I)
_STRONG = re.compile(r"penalty\s+which\s+may\s+extend|liable\s+to\s+(?:a\s+)?penalty|punishable\s+with|"
                     r"times\s+the\s+(?:sum|amount)|fine\s+which\s+may\s+extend|monetary\s+penalty", re.I)


def extract_for(con, rid: str) -> int:
    init(con)
    secs = con.execute(
        "SELECT id, section_number, section_title, section_text FROM sections WHERE regulation_id=?",
        (rid,)).fetchall()
    rows: list[tuple] = []
    for sec in secs:
        titled = bool(_TITLE.search(sec["section_title"] or ""))
        text = sec["section_text"] or ""
        if not titled and not _STRONG.search(text):
            continue
        for sent in _sentences(text):
            for p in classify(sent):
                if not titled and p["kind"] == "UNQUANTIFIED":
                    continue      # outside penalty sections, keep only concrete findings
                pid = "pen-" + hashlib.sha1(f"{rid}|{sec['id']}|{p['basis_text'][:200]}".encode()).hexdigest()[:16]
                rows.append((pid, rid, sec["id"], str(sec["section_number"] or ""),
                             p["kind"], p.get("amount_min"), p.get("amount_max"),
                             p.get("per_day_amount"), p.get("multiplier"),
                             p.get("multiplier_basis"), p.get("imprisonment_months"),
                             p["basis_text"][:600], METHOD, _now()))
    con.execute("DELETE FROM penalty_provisions WHERE regulation_id=?", (rid,))
    for r in rows:
        con.execute(
            """INSERT OR IGNORE INTO penalty_provisions
               (id, regulation_id, section_id, section_number, kind, amount_min, amount_max,
                per_day_amount, multiplier, multiplier_basis, imprisonment_months,
                basis_text, extraction_method, extracted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", r)
    con.commit()
    return len(rows)


def extract_all(con, limit: int = 0) -> dict:
    init(con)
    rids = [r[0] for r in con.execute(
        "SELECT DISTINCT regulation_id FROM sections ORDER BY 1").fetchall()]
    if limit:
        rids = rids[:limit]
    tally = {"regulations": len(rids), "with_provisions": 0, "provisions": 0}
    for rid in rids:
        n = extract_for(con, rid)
        if n:
            tally["with_provisions"] += 1
            tally["provisions"] += n
    return tally


# ------------------------------------------------------------------ exposure
def fmt_inr(v: float | None) -> str | None:
    if v is None:
        return None
    if v >= 10_000_000:
        return f"₹{v/10_000_000:g} crore"
    if v >= 100_000:
        return f"₹{v/100_000:g} lakh"
    return f"₹{v:,.0f}"


def exposure(con, rid: str) -> dict:
    """What the regulation's own text says failure can cost. Not a prediction."""
    init(con)
    rows = [dict(r) for r in con.execute(
        """SELECT section_number, kind, amount_min, amount_max, per_day_amount,
                  multiplier, multiplier_basis, imprisonment_months, basis_text
           FROM penalty_provisions WHERE regulation_id=?
           ORDER BY CASE kind WHEN 'FIXED_FINE' THEN 0 WHEN 'PER_DAY' THEN 1
                              WHEN 'MULTIPLIER_OF_SUM' THEN 2 WHEN 'IMPRISONMENT' THEN 3
                              WHEN 'SUSPENSION_CANCELLATION' THEN 4 ELSE 5 END,
                    amount_max DESC NULLS LAST""", (rid,)).fetchall()]
    verdict = (con.execute("SELECT applicability FROM regulations WHERE id=?", (rid,)).fetchone() or [None])[0]
    fixed = [r["amount_max"] for r in rows if r["kind"] == "FIXED_FINE" and r["amount_max"]]
    per_day = [r["per_day_amount"] for r in rows if r["kind"] == "PER_DAY" and r["per_day_amount"]]
    mults = [{"multiplier": r["multiplier"], "basis": r["multiplier_basis"]}
             for r in rows if r["kind"] == "MULTIPLIER_OF_SUM"]
    impr = [r["imprisonment_months"] for r in rows if r["kind"] == "IMPRISONMENT" and r["imprisonment_months"]]
    for r in rows:
        r["amount_min_fmt"] = fmt_inr(r["amount_min"])
        r["amount_max_fmt"] = fmt_inr(r["amount_max"])
        r["per_day_fmt"] = fmt_inr(r["per_day_amount"])
    return {
        "provisions": rows,
        "summary": {
            "maxFixed": max(fixed) if fixed else None,
            "maxFixedFmt": fmt_inr(max(fixed)) if fixed else None,
            "maxPerDay": max(per_day) if per_day else None,
            "maxPerDayFmt": fmt_inr(max(per_day)) if per_day else None,
            "multipliers": mults,
            "maxImprisonmentMonths": max(impr) if impr else None,
            "unquantified": sum(1 for r in rows if r["kind"] == "UNQUANTIFIED"),
            "suspension": any(r["kind"] == "SUSPENSION_CANCELLATION" for r in rows),
        },
        "applicability": verdict or "Not evaluated",
        "note": ("Statutory ceilings quoted verbatim from this regulation's text "
                 "(\"may extend to\" amounts). Adjudicated penalties are set case by case — "
                 "see enforcement actions for amounts actually imposed. Not legal advice."),
    } if rows else {
        "provisions": [], "summary": None, "applicability": verdict or "Not evaluated",
        "note": "No penalty provision extracted from this regulation's text.",
    }


# ------------------------------------------------------------------ selftest
CASES = [
    ("If any person contravenes these directions he shall be liable to a penalty which may extend to one lakh rupees.",
     {"kind": "FIXED_FINE", "amount_max": 100000.0}),
    ("Such contravention shall attract a penalty not less than five thousand rupees but which may extend to five lakh rupees.",
     {"kind": "FIXED_FINE", "amount_min": 5000.0, "amount_max": 500000.0}),
    ("A further penalty which may extend to five hundred rupees for every day during which the contravention continues.",
     {"kind": "PER_DAY", "per_day_amount": 500.0}),
    ("Where the amount is quantifiable, the penalty may extend to thrice the sum involved in such contravention.",
     {"kind": "MULTIPLIER_OF_SUM", "multiplier": 3.0}),
    ("Whoever fails shall be punishable with imprisonment for a term which may extend to three years and with fine.",
     {"kind": "IMPRISONMENT", "imprisonment_months": 36}),
    ("The Bank may impose a monetary penalty of ₹5,00,000 for such deficiency.",
     {"kind": "FIXED_FINE", "amount_max": 500000.0}),
    ("Penalty which may extend to Rs. 1 crore and a further fine.",
     {"kind": "FIXED_FINE", "amount_max": 10000000.0}),
    ("The authority may cancel the certificate of registration for repeated contraventions.",
     {"kind": "SUSPENSION_CANCELLATION"}),
    ("The defaulter shall be liable to penalty as may be prescribed by the Authority.",
     {"kind": "UNQUANTIFIED"}),
    ("Penalty may extend to twice the amount involved in the transaction.",
     {"kind": "MULTIPLIER_OF_SUM", "multiplier": 2.0}),
    ("These directions consolidate the instructions issued to NBFCs on customer service.",
     None),   # not a penalty sentence — must yield nothing
    ("The report shall be submitted within 30 days of the close of the quarter.",
     None),   # numbers without currency must not become amounts
    ("An NBFC shall be eligible to sponsor (sponsorship as defined by SEBI Regulations for Mutual Funds) with a minimum of ₹300 crore.",
     None),   # "as deFINEd by" is not a penalty; eligibility thresholds must not classify
    ("Penalties for ATM Cash-out…………………………………………………..7",
     None),   # a table-of-contents line is not a provision
]


def selftest(verbose: bool = True) -> tuple[int, int]:
    passed = failed = 0
    for text, want in CASES:
        got = classify(text)
        if want is None:
            ok = got == [] or all(g["kind"] == "UNQUANTIFIED" and not _PENALTYISH.search(text) for g in got)
            ok = got == []
        else:
            ok = any(all(g.get(k) == v for k, v in want.items()) for g in got)
        passed += ok
        failed += not ok
        if verbose:
            print(f"  {'PASS' if ok else 'FAIL'}  {text[:72]!r} -> {[(g['kind'], g.get('amount_min'), g.get('amount_max'), g.get('per_day_amount'), g.get('multiplier'), g.get('imprisonment_months')) for g in got]}")
    if verbose:
        print(f"  {passed} passed, {failed} failed of {len(CASES)}")
    return passed, failed


if __name__ == "__main__":
    selftest()
