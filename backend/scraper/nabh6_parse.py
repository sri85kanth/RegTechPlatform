"""
Parse the NABH Accreditation Standards for Hospitals, 6th Edition (Jan 2025)
into chapters -> standards -> objective elements, from `pdftotext -layout`.

    pdftotext -layout <pdf> hosp6.txt
    python nabh6_parse.py hosp6.txt out.json

Category per element comes from two places that are checked against each other:
the label printed beside the element in the body, and the per-chapter summary
grid ("Objective Element  AAC.1. AAC.2. ..."). The grid wins where the body
line lost its label to the two-column layout. Totals are checked against the
document's own summary (100 standards, 639 elements, 105 CORE).
"""
from __future__ import annotations

import json
import re
import sys

CHAPTERS = {
    "AAC": "Access, Assessment and Continuity of Care",
    "COP": "Care of Patients",
    "MOM": "Management of Medication",
    "PRE": "Patient Rights and Education",
    "IPC": "Infection Prevention and Control",
    "PSQ": "Patient Safety and Quality Improvement",
    "ROM": "Responsibilities of Management",
    "FMS": "Facility Management and Safety",
    "HRM": "Human Resource Management",
    "IMS": "Information Management System",
}
CH = "|".join(CHAPTERS)
CATS = {"CORE": "CORE", "Commitment": "COMMITMENT", "Achievement": "ACHIEVEMENT", "Excellence": "EXCELLENCE"}

# pdftotext drops the fi / fl ligature glyphs. Repair the words that occur.
LIGATURE = {
    "dene": "define", "dened": "defined", "denes": "defines", "dening": "defining", "denition": "definition",
    "qualied": "qualified", "qualication": "qualification", "qualications": "qualifications",
    "prociency": "proficiency", "modied": "modified", "modication": "modification",
    "identication": "identification", "identied": "identified", "identies": "identifies", "identify": "identify",
    "identifying": "identifying", "specic": "specific", "specically": "specifically", "specied": "specified",
    "certied": "certified", "certication": "certification", "notication": "notification",
    "notiable": "notifiable", "notied": "notified", "classication": "classification", "classied": "classified",
    "verication": "verification", "veried": "verified", "inuence": "influence", "conict": "conflict",
    "conicts": "conflicts", "reect": "reflect", "reects": "reflects", "conrm": "confirm", "conrmed": "confirmed",
    "conrmation": "confirmation", "signicant": "significant", "rst": "first", "eld": "field", "elds": "fields",
    "ow": "flow", "ows": "flows", "workow": "workflow", "uid": "fluid", "uids": "fluids", "ammable": "flammable",
    "re": "fire", "res": "fires", "ofce": "office", "ofcer": "officer", "ofcers": "officers", "ofcial": "official",
    "efcacy": "efficacy", "efcient": "efficient", "efciency": "efficiency", "sufcient": "sufficient",
    "deciency": "deficiency", "deciencies": "deficiencies", "benet": "benefit", "benets": "benefits",
    "prole": "profile", "proles": "profiles", "le": "file", "les": "files", "lled": "filled", "lling": "filling",
    "lter": "filter", "lters": "filters", "nal": "final", "nalised": "finalised", "nancial": "financial",
    "nance": "finance", "nding": "finding", "ndings": "findings", "xed": "fixed", "ve": "five", "uent": "fluent",
    "conguration": "configuration", "congured": "configured", "condentiality": "confidentiality",
    "condential": "confidential", "justied": "justified", "justication": "justification", "simplied": "simplified",
    "afliated": "affiliated", "scientic": "scientific", "magnication": "magnification", "dietician": "dietician",
    "rearms": "firearms", "rewall": "firewall", "air": "air", "rst-aid": "first-aid", "ight": "flight",
    "oor": "floor", "oors": "floors", "uorescent": "fluorescent", "inammable": "inflammable",
    "signage": "signage", "reghting": "firefighting", "re-ghting": "fire-fighting", "verify": "verify",
    "notifying": "notifying", "clarication": "clarification", "infrastructure": "infrastructure",
    "satisfaction": "satisfaction", "dissatisfaction": "dissatisfaction", "certicate": "certificate",
    "certicates": "certificates", "speciality": "speciality", "specialities": "specialities",
    "inltration": "infiltration", "prophylaxis": "prophylaxis", "self-sufcient": "self-sufficient",
}
# Two-letter stems are ambiguous ("re-assessment", "le", "ve"); leave them to review.
for _k in ("re", "res", "le", "les", "ve", "ow", "ows", "air", "eld"):
    LIGATURE.pop(_k, None)
LIGATURE = {k: v for k, v in LIGATURE.items() if k != v}
_LIG_RE = re.compile(r"(?<![\w-])(" + "|".join(sorted(map(re.escape, LIGATURE), key=len, reverse=True)) + r")(?![\w-])")


def fix(s: str) -> str:
    # The PDF's font maps the fi / fl ligatures to private-use code points.
    s = (s.replace("", "fi").replace("", "fl")
          .replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬀ", "ff")
          .replace("ﬃ", "ffi").replace("ﬄ", "ffl"))
    s = re.sub(r"[­​-‏⁠﻿\x00-\x08]", "", s)   # invisible / control chars
    s = re.sub(r"\s+", " ", s).strip()
    return _LIG_RE.sub(lambda m: LIGATURE[m.group(1)], s)


def dedupe_sentences(s: str) -> str:
    out: list[str] = []
    seen: set[str] = set()
    for sent in re.split(r"(?<=[.*])\s+", s):
        key = sent.replace("*", "").strip()
        if key and key not in seen:
            seen.add(key)
            out.append(sent)
    return " ".join(out)


NOISE = re.compile(r"^\s*(NABH Accreditation Standards for Hospitals|®|\d{1,3}|CORE\s+Commitment\s+Achievement\s+Excellence"
                   r"|Standards and Objective Elements|Objective Elements|Standard)\s*$")


def parse_grids(lines: list[str]) -> dict[str, str]:
    """Category of every element from the per-chapter summary grids."""
    cat: dict[str, str] = {}
    i = 0
    while i < len(lines):
        if re.match(r"^\s*Objective\s*$", lines[i]) and i + 1 < len(lines) and re.search(rf"\b({CH})\.1\.", lines[i + 1]):
            hdr = lines[i + 1]
            cols = [(m.start(), m.group(0)) for m in re.finditer(rf"\b(?:{CH})\.\d+\.", hdr)]
            j = i + 2
            while j < len(lines) and j < i + 40:
                m = re.match(r"^\s*([a-kI])\s{2,}(.*)$", lines[j])
                if m:
                    letter = m.group(1).lower()
                    for t in re.finditer(r"CORE|Commitment|Achievement|Excellence", lines[j]):
                        centre = t.start() + len(t.group(0)) / 2
                        code = min(cols, key=lambda c: abs((c[0] + len(c[1]) / 2) - centre))[1]
                        cat[f"{code}{letter}"] = CATS[t.group(0)]
                elif re.match(r"^\s*\d{1,3}\s*$", lines[j]):
                    break
                j += 1
            i = j
        i += 1
    return cat


def parse(path: str) -> dict:
    lines = open(path, encoding="utf8", errors="ignore").read().split("\n")
    grid = parse_grids(lines)
    start = next(i for i, l in enumerate(lines) if l.strip() == "Standards and Objective Elements")
    # "  AAC.7." alone (statement wraps around it) or "  AAC.10.   Statement..." on one line
    std_re = re.compile(rf"^\s{{1,8}}((?:{CH})\.\d+\.)(?:\s{{3,}}(\S.*))?\s*$")
    # The PDF prints element "i" as "I" in places; elements run up to "l".
    oe_re = re.compile(r"^\s{1,6}(CORE|Commitment|Achievement|Excellence)?\s{2,}([a-lI])\.\s+(.*)$")
    cont_re = re.compile(r"^\s{15,}(\S.*)$")

    standards: dict[str, dict] = {}
    cur_std = None
    pending_stmt: list[str] = []
    cur_oe = None
    mode = None
    for raw in lines[start:]:
        line = raw.rstrip()
        # Every chapter ends with its own References list; skip it until the
        # next "Standard" heading. The glossary after the last chapter ends it.
        if re.match(r"^\s*(References|REFERENCES)\s*$", line):
            mode, cur_oe = None, None
            continue
        if re.match(r"^\s*(Glossary|GLOSSARY|Annexure|ANNEXURE)\b", line) and "IMS.1." in standards:
            break
        m = std_re.match(line)
        if m and mode != "pre":
            # a chapter's own summary list of standards uses the same "COP.3.  text"
            # shape; only a code under a "Standard" heading opens a standard
            mode, cur_oe = None, None
            continue
        if m:
            code = m.group(1)
            cur_std = standards.setdefault(code, {"code": code, "chapter": code.split(".")[0],
                                                  "statement": [], "elements": []})
            cur_std["statement"] += pending_stmt
            if m.group(2):
                cur_std["statement"].append(m.group(2).strip())
            pending_stmt = []
            mode, cur_oe = "std", None
            continue
        if line.strip() == "Standard":
            mode, cur_oe, pending_stmt = "pre", None, []
            continue
        if line.strip() == "Objective Elements":
            mode, cur_oe = "oe", None
            continue
        if NOISE.match(line) or not line.strip():
            continue
        if mode == "pre":
            pending_stmt.append(line.strip())
            continue
        if mode == "std" and cur_std is not None:
            cur_std["statement"].append(line.strip())
            continue
        if mode == "oe" and cur_std is not None:
            m = oe_re.match(line)
            if m:
                cur_oe = {"letter": m.group(2).lower(), "label": CATS.get(m.group(1) or "", None), "text": [m.group(3)]}
                cur_std["elements"].append(cur_oe)
                continue
            m = cont_re.match(line)
            if m and cur_oe is not None:
                cur_oe["text"].append(m.group(1))

    out, mismatches = [], []
    for code, s in standards.items():
        seen = set()
        els = []
        for e in s["elements"]:
            if e["letter"] in seen:
                continue
            seen.add(e["letter"])
            text = fix(" ".join(e["text"]))
            doc = "*" in text
            text = text.replace("*", "").strip()
            # The label printed beside the element is authoritative; the grid's
            # columns do not align reliably, so it only fills a missing label.
            gcat = grid.get(f"{code}{e['letter']}")
            if e["label"] and gcat and e["label"] != gcat:
                mismatches.append((f"{code}{e['letter']}", e["label"], gcat))
            els.append({"code": f"{code}{e['letter']}", "letter": e["letter"], "category": e["label"] or gcat,
                        "documentation_required": doc, "text": text})
        out.append({"code": code, "chapter": s["chapter"], "chapter_name": CHAPTERS[s["chapter"]],
                    # the statement can be collected twice (wrapped round the code, and again
                    # from the chapter's one-line list); keep each line once
                    "statement": dedupe_sentences(fix(" ".join(s["statement"]))), "elements": els})
    out.sort(key=lambda s: (list(CHAPTERS).index(s["chapter"]), int(s["code"].split(".")[1])))
    return {"standards": out, "grid_size": len(grid), "label_vs_grid_mismatches": mismatches}


if __name__ == "__main__":
    res = parse(sys.argv[1])
    stds = res["standards"]
    els = [e for s in stds for e in s["elements"]]
    by_cat: dict = {}
    for e in els:
        by_cat[e["category"]] = by_cat.get(e["category"], 0) + 1
    by_ch: dict = {}
    for s in stds:
        c = by_ch.setdefault(s["chapter"], [0, 0])
        c[0] += 1
        c[1] += len(s["elements"])
    print(f"standards {len(stds)} (expect 100) · elements {len(els)} (expect 639)")
    print("by category", by_cat, "(expect CORE 105, COMMITMENT 457, ACHIEVEMENT 60, EXCELLENCE 17)")
    print("by chapter", by_ch)
    print("grid cells", res["grid_size"], "· label/grid mismatches", len(res["label_vs_grid_mismatches"]),
          res["label_vs_grid_mismatches"][:8])
    left = [w for e in els for w in re.findall(r"\b\w*(?:dene|qualied|cation|ied)\b", e["text"]) if w not in ("application", "communication", "indication", "education", "medication", "location", "allocation", "publication", "applied", "supplied", "complied", "implied", "accompanied", "varied", "carried", "studied", "occupied", "copied", "classified", "verified", "identified", "notified", "certified", "modified", "qualified", "specified", "justified", "simplified", "clarified")]
    print("possible unrepaired ligatures:", sorted(set(left))[:30])
    if len(sys.argv) > 2:
        json.dump(res, open(sys.argv[2], "w"), indent=1, ensure_ascii=False)
