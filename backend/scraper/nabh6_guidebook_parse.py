"""
Attach the NABH Guidebook (6th Ed., scanned, OCR'd) interpretation of each
objective element to the parsed standard (hosp6.json).

    python nabh6_guidebook_parse.py <hosp6.json> <ocr.txt> <out guidebook.json>

The scan loses the white-on-dark standard code banners ("COP.10."), so elements
are found by TEXT, not by code: each element's wording from the standard is
searched for in the OCR text with spaces and punctuation stripped, which makes
OCR slips like "Theorganisation shallimplementa" match. Elements are searched
in book order, each after the previous match, so a phrase repeated in two
chapters lands on the right one. The interpretation is the text from
"Interpretation:" to the start of the next element.
"""
from __future__ import annotations

import difflib
import json
import re
import sys
from pathlib import Path


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def main() -> None:
    stds = json.loads(Path(sys.argv[1]).read_text())["standards"]
    raw = Path(sys.argv[2]).read_text(errors="ignore")
    out = Path(sys.argv[3])

    # normalised text + a map from each normalised char back to the raw offset
    keep = [(i, c.lower()) for i, c in enumerate(raw) if c.isalnum()]
    ntext = "".join(c for _, c in keep)
    back = [i for i, _ in keep]
    page_at = []                       # raw offset -> page number
    page = 0
    for m in re.finditer(r"<<<PAGE (\d+)>>>", raw):
        page_at.append((m.start(), int(m.group(1))))

    def page_of(off: int) -> int:
        p = 1
        for o, n in page_at:
            if o <= off:
                p = n
            else:
                break
        return p

    els = [(s, e) for s in stds for e in s["elements"]]
    # skip the front matter (summary tables, glossary): start at the first real element
    cursor = 0
    found: list[tuple[str, int, int]] = []          # (code, norm start, norm end of element text)
    misses = []
    for s, e in els:
        key = norm(e["text"])
        # long probe: sibling elements often share a long opening ("Narcotic drugs and
        # psychotropic substances … are"), and a short one lands on the wrong sibling
        probe = key[: min(140, len(key))]
        pos = ntext.find(probe, cursor)
        if pos < 0 or pos - cursor > 400_000:
            # fuzzy fallback: best window in the next 60k chars
            window = ntext[cursor: cursor + 60_000]
            sm = difflib.SequenceMatcher(None, window, probe, autojunk=False)
            m = sm.find_longest_match(0, len(window), 0, len(probe))
            if m.size >= max(18, int(len(probe) * 0.45)):
                pos = cursor + m.a - m.b
            else:
                misses.append(e["code"])
                continue
        found.append((e["code"], pos, pos + len(key)))
        cursor = pos + max(1, len(probe))

    # where each standard's statement sits, so the last element of a standard stops
    # before the next standard's heading rather than absorbing it
    std_of = {e["code"]: s["code"] for s, e in els}
    stmt_pos = {}
    for s in stds:
        k = norm(s["statement"])[:80]
        p = ntext.find(k, 0)
        while p >= 0 and k:
            stmt_pos.setdefault(s["code"], []).append(p)
            p = ntext.find(k, p + 1)

    by_code = {}
    for i, (code, a, b) in enumerate(found):
        nxt = found[i + 1][1] if i + 1 < len(found) else len(ntext)
        if i + 1 < len(found) and std_of[found[i + 1][0]] != std_of[code]:
            heads = [p for p in stmt_pos.get(std_of[found[i + 1][0]], []) if b < p < nxt]
            if heads:
                nxt = heads[0]
        ra = back[min(b, len(back) - 1)]
        rb = back[min(nxt, len(back) - 1)]
        chunk = raw[ra:rb]
        # interpretation runs from "Interpretation" to the next element; drop page furniture
        m = re.search(r"Interpre\w*\s*:?", chunk)
        body = chunk[m.end():] if m else ""
        body = re.sub(r"<<<PAGE \d+>>>", " ", body)
        body = re.sub(r"Guidebook to NABH Accreditation Standards for Hospitals", " ", body)
        body = re.sub(r"\b(NABH|CORE|Commitment|Achievement|Excellence|Standard|Objective Elements)\b\s*$", " ", body)
        body = re.sub(r"\n\s*\d{1,3}\s*\n", "\n", body)
        body = re.sub(r"\s+", " ", body).strip()
        # a chapter's reference list follows its last element; it is not interpretation
        body = re.split(r"\s(?:References|REFERENCES|Bibliography)\s*:?\s*1\s*[.,)]", body)[0]
        # …or, where the heading was lost in the scan, at the first numbered citation ("1. Smith AB, …")
        body = re.split(r"\s1\s*[.,]\s+[A-Z][A-Za-z'\-]+\s+[A-Z]{1,3}[,.]\s", body)[0]
        # trailing "Standard" banner word / next element's category tag left by the OCR
        body = re.sub(r"\s+(?:Standard|C[O0Q]RE|Commitment|Achievement|Excellence)(?:\s+[a-l]\.)?\s*$", "", body).strip()
        by_code[code] = {"interpretation": body[:6000], "page": page_of(back[min(a, len(back) - 1)])}

    stds_out = []
    for s in stds:
        els_out = []
        for e in s["elements"]:
            g = by_code.get(e["code"], {})
            els_out.append(dict(e, interpretation=g.get("interpretation", ""), gb_page=g.get("page")))
        stds_out.append(dict(s, elements=els_out))
    out.write_text(json.dumps({"standards": stds_out}, indent=1, ensure_ascii=False))
    have = sum(1 for v in by_code.values() if len(v["interpretation"]) > 40)
    print(f"elements {len(els)} · located {len(found)} · with interpretation {have} · missed {len(misses)} {misses[:15]}")
    lens = sorted(len(v["interpretation"]) for v in by_code.values())
    if lens:
        print(f"interpretation length: median {lens[len(lens)//2]} · max {lens[-1]} · shortest {lens[:5]}")


if __name__ == "__main__":
    main()
