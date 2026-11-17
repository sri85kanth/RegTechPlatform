"""
Build the data behind the Impact Cascade page: regulation -> obligation -> risk
-> policy -> control -> owner, from the gap-assessment results and the
hospital's own documents (policies, SOPs, forms, risk register, control matrix).

    python cascade_build.py <company upload folder> <template.html> <out.html> <gap.json>...

Each <gap.json> is a results file in nabh6_gap cache format, or the
reg_gap_merge output ({regulation: {...}}); every file becomes one or more
regulations in the page's picker.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_company_documents as C                           # noqa: E402

CODE = r"(?:HR|NUR|BME)"


def _sections(body, names):
    """[(heading, [paragraphs])] for the named Heading3 sections of a policy/SOP block."""
    return [(n, C.section(body, n)) for n in names if C.section(body, n)]


def company_graph(folder: Path) -> dict:
    files = {p.name: p for p in folder.rglob("*") if p.is_file()}
    docs: dict[str, dict] = {}
    sop_pol: dict[str, list[str]] = {}
    for name, p in files.items():
        if name.endswith("Manual.docx"):
            pols, sops = C.parse_manual(p)
            ps = C.paragraphs(p)
            pol_body = {code: body for code, _t, body in C.blocks(ps, "POL")}
            sop_body = {code: body for code, _t, body in C.blocks(ps, "SOP")}
            for x in pols:
                docs[x["code"]] = {"k": "Policy", "t": x["title"], "o": x["owner"], "sops": x["sops"], "f": name,
                                   "std": x["standards"],
                                   "x": _sections(pol_body.get(x["code"], []),
                                                  ["Purpose", "Policy Statement", "Policy Provisions", "Monitoring"])}
                for s in x["sops"]:
                    sop_pol.setdefault(s, []).append(x["code"])
            for x in sops:
                docs[x["code"]] = {"k": "SOP", "t": x["title"], "f": name,
                                   "x": _sections(sop_body.get(x["code"], []),
                                                  ["Purpose", "Scope", "Responsibility", "Procedure", "Records",
                                                   "Key Controls", "Performance Indicator"])}
        elif name.endswith("Forms_Pack.docx"):
            for f in C.parse_forms(p):
                docs[f["code"]] = {"k": "Form", "t": f["title"], "sops": f["used_in"], "f": name,
                                   "x": [("Form", [f"Used in: {', '.join(f['used_in'])}", f"Retention: {f['retention']}"])]}
    reg = next(p for n, p in files.items() if n.endswith(".xlsx"))
    risks_raw, ctrls = C.parse_register(reg)
    risks = {}
    for r in risks_raw:
        risks[r["Risk ID"]] = {"t": r.get("Risk", ""), "rating": r.get("Inherent Rating", ""),
                               "res": r.get("Residual Score", ""), "o": r.get("Risk Owner") or r.get("Owner") or "",
                               "ctrls": re.findall(rf"{CODE}-C-\d+", r.get("Control IDs", ""))}
    for c in ctrls:
        cid = c["Control ID"]
        docs[cid] = {"k": "Control", "t": c.get("Objective", ""), "o": c.get("Owner", ""),
                     "sops": re.findall(rf"{CODE}-SOP-\d+", c.get("SOP", "")),
                     "forms": re.findall(rf"{CODE}-F-\d+", c.get("Evidence", "") + " " + c.get("Control Activity", "")),
                     "freq": c.get("Frequency", ""), "test": c.get("Test Result", ""), "f": reg.name,
                     "risks": [rid for rid, r in risks.items() if cid in r["ctrls"]],
                     "x": [(h, [c.get(k, "")]) for h, k in (("Control activity", "Control Activity"), ("Type", "Type"),
                           ("Nature", "Nature"), ("Frequency", "Frequency"), ("Owner", "Owner"), ("Evidence", "Evidence"),
                           ("Test procedure", "Test Procedure"), ("Standards", "Standards"), ("Last test", "Test Result"))
                           if c.get(k)]}
    for s, ps in sop_pol.items():
        if s in docs:
            docs[s]["pol"] = ps
    return {"docs": docs, "risks": risks}


def from_nabh(path: Path) -> list[dict]:
    d = json.loads(path.read_text())
    units = []
    for code, s in d.items():
        st = s["standard"]
        units.append({"g": f"{st['chapter']} · {st['chapter_name']}", "u": code.rstrip("."), "ut": st["statement"],
                      "items": [{"c": e["code"].rstrip("."), "t": e["text"], "ob": e["obligation"], "rq": e["requirement"],
                                 "st": e["status"], "rk": e["risk"], "cat": e["category"], "gap": e["gap"],
                                 "fix": e["action"], "by": e["satisfied_by"], "who": e["responsible"],
                                 "why": e["consequence"], "subs": e.get("subs", []),
                                 "interp": (e.get("interpretation") or "")[:2500], "gbp": e.get("gb_page")}
                                for e in s["elements"]]})
    return [{"id": "nabh-hospital-6th-edition-2025", "title": "NABH Accreditation Standards for Hospitals, 6th Edition",
             "short": "NABH Hospitals 6th Ed.", "regulator": "NABH",
             "url": "https://nabh-portal-live.s3.ap-south-1.amazonaws.com/wp-content/uploads/2025/07/13111206/"
                    "NABH-Hospital-Accreditation-Standard-6th-Edition-January-2025.pdf", "units": units}]


def from_regs(path: Path) -> list[dict]:
    return json.loads(path.read_text())["regulations"]


def main() -> None:
    folder, tpl, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    regs = []
    for p in sys.argv[4:]:
        p = Path(p)
        data = json.loads(p.read_text())
        regs += from_regs(p) if "regulations" in data else from_nabh(p)
    # a regulation whose every provision is "not applicable" has nothing to trace; list it, don't chart it
    applicable = [r for r in regs if any(i["st"] != "NOT_APPLICABLE" for u in r["units"] for i in u["items"])]
    excluded = sorted(r.get("short") or r["title"] for r in regs if r not in applicable)
    for r in applicable:                                  # charted regulations keep only provisions that apply
        for u in r["units"]:
            u["items"] = [i for i in u["items"] if i["st"] != "NOT_APPLICABLE"]
        r["units"] = [u for u in r["units"] if u["items"]]
    regs = applicable
    g = company_graph(folder)
    payload = {"regs": regs, "docs": g["docs"], "risks": g["risks"], "company": "Premier Hospitals Pvt. Ltd.",
               "excluded": excluded}
    html = tpl.read_text(encoding="utf8").replace("__DATA__", json.dumps(payload, ensure_ascii=False).replace("</", "<\\/"))
    out.write_text(html, encoding="utf8")
    n = sum(len(u["items"]) for r in regs for u in r["units"])
    print(f"wrote {out} · regulations {len(regs)} · items {n} · company docs {len(g['docs'])} · risks {len(g['risks'])} · "
          f"{len(html) // 1024} KB")


if __name__ == "__main__":
    main()
