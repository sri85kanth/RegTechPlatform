"""
Amendment extraction — what actually changed, from the document itself.

Indian regulators publish consolidated Master Directions carrying inline
footnotes that record every amendment: which clause changed, by which circular,
on what date. That is authoritative change history sitting in the text, and it
does not require a second version to diff against.

Also provides a word-level diff for when two versions of the same document do
exist, so a re-crawl can show exactly which words moved.
"""
import difflib
import re
from datetime import datetime

# "Amended vide circular DOR.AML.REC.111/14.01.001/2023-24 dated April 28, 2023."
MARKER = re.compile(
    r"\b(?P<action>Amended|Inserted|Substituted|Omitted|Added|Deleted|Modified)\s+"
    r"vide\s+(?P<instrument>circular|notification|direction)?\s*"
    r"(?P<ref>[A-Z][A-Za-z.\s]*[\d./\-]{6,40})\s*"
    r"dated\s+(?P<date>[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})",
    re.I,
)

ACTION_MEANING = {
    "amended": "Existing text was changed",
    "substituted": "Text was replaced wholesale",
    "inserted": "New requirement added",
    "added": "New requirement added",
    "omitted": "Requirement removed",
    "deleted": "Requirement removed",
    "modified": "Existing text was changed",
}


def _norm_date(s: str) -> str:
    s = s.replace(",", "").strip()
    for fmt in ("%B %d %Y", "%b %d %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return s


def extract(sections: list[dict]) -> list[dict]:
    """One record per amendment marker, tied to the section it appears in."""
    out: list[dict] = []
    for sec in sections:
        text = sec.get("text") or sec.get("section_text") or ""
        num = str(sec.get("no") or sec.get("section_number") or "")
        title = sec.get("title") or sec.get("section_title") or ""
        for m in MARKER.finditer(text):
            action = m.group("action").lower()
            # regulators print the same circular as "REC. 46/…" and "REC.46/…";
            # strip internal whitespace so both fold to one instrument
            ref = re.sub(r"\s+", "", m.group("ref")).strip(" .")
            # the sentence the marker sits in gives the reader context
            start = max(0, m.start() - 220)
            context = re.sub(r"\s+", " ", text[start:m.start()]).strip()
            out.append({
                "section_number": num,
                "section_title": title[:160],
                "action": action.title(),
                "meaning": ACTION_MEANING.get(action, "Changed"),
                "instrument": (m.group("instrument") or "circular").title(),
                "reference": ref,
                "amended_on": _norm_date(m.group("date")),
                "context": context[-200:],
                "raw": re.sub(r"\s+", " ", m.group(0)).strip(),
            })
    return out


def timeline(amendments: list[dict]) -> list[dict]:
    """Group by circular — one row per amending instrument, newest first."""
    by_ref: dict[str, dict] = {}
    for a in amendments:
        key = a["reference"]
        e = by_ref.setdefault(key, {
            "reference": key, "amended_on": a["amended_on"],
            "instrument": a["instrument"], "sections": [], "actions": set(),
        })
        if a["section_number"] and a["section_number"] not in e["sections"]:
            e["sections"].append(a["section_number"])
        e["actions"].add(a["action"])
    rows = []
    for e in by_ref.values():
        e["actions"] = sorted(e["actions"])
        e["section_count"] = len(e["sections"])
        rows.append(e)
    return sorted(rows, key=lambda r: r["amended_on"], reverse=True)


def word_diff(old: str, new: str) -> list[dict]:
    """
    Word-level diff between two versions of the same clause.
    Returns runs tagged equal / removed / added, so the UI can strike the old
    text and underline the new without guessing.
    """
    a, b = old.split(), new.split()
    runs: list[dict] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            runs.append({"type": "equal", "text": " ".join(a[i1:i2])})
        elif tag == "delete":
            runs.append({"type": "removed", "text": " ".join(a[i1:i2])})
        elif tag == "insert":
            runs.append({"type": "added", "text": " ".join(b[j1:j2])})
        else:  # replace
            runs.append({"type": "removed", "text": " ".join(a[i1:i2])})
            runs.append({"type": "added", "text": " ".join(b[j1:j2])})
    return [r for r in runs if r["text"].strip()]


def diff_stats(runs: list[dict]) -> dict:
    return {
        "added_words": sum(len(r["text"].split()) for r in runs if r["type"] == "added"),
        "removed_words": sum(len(r["text"].split()) for r in runs if r["type"] == "removed"),
        "unchanged_words": sum(len(r["text"].split()) for r in runs if r["type"] == "equal"),
    }
