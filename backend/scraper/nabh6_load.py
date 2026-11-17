"""
Load the rebuilt NABH Hospitals 6th Edition (639 objective elements) and its gap
assessment into the app's own tables, replacing the 100 standard-level rows.

    python nabh6_load.py <hosp6.json> <hosp6_gap.json> <company upload folder>          # dry run
    python nabh6_load.py <hosp6.json> <hosp6_gap.json> <company upload folder> --apply

Where each piece lands (and where the UI shows it):
  sections                 one per standard                    regulation page
  clauses                  one per objective element (AAC.1.a)  regulation page
  obligations              rewritten duty, NABH text as excerpt Obligations
  requirements             testable requirement                 Requirements tab
  company_requirement_instances
                           compliance_status + reason           /compliance, Requirements tab
                             MET->COMPLIANT  PARTIAL->PARTIALLY_COMPLIANT
                             GAP->NON_COMPLIANT  NOT_COVERED->EVIDENCE_MISSING
  control_requirements     which department control covers it   control chips / traceability
  assessments              MET/PARTIAL/GAP verdict + rationale  Requirements tab pill + detail
  findings                 one OPEN finding per unmet element,  severity = risk band

Do not run materialise_cri.py or derive_compliance.py afterwards without
expecting them to reset these statuses — both rebuild compliance from the chain.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                      # noqa: E402
import classify_company_documents as C                           # noqa: E402

REG = "nabh-hospital-6th-edition-2025"
COMPANY = 1
STATUS = {"MET": "COMPLIANT", "PARTIAL": "PARTIALLY_COMPLIANT", "GAP": "NON_COMPLIANT",
          "NOT_COVERED": "EVIDENCE_MISSING"}
now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")   # noqa: E731


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def doc_to_controls(folder: Path) -> dict[str, set[str]]:
    """Map every document code (SOP, policy, form, control) to department control ids."""
    files = {p.name: p for p in folder.rglob("*") if p.is_file()}
    reg = next(p for n, p in files.items() if n.endswith(".xlsx"))
    _risks, ctrls = C.parse_register(reg)
    out: dict[str, set[str]] = {}
    sop_of: dict[str, set[str]] = {}
    for c in ctrls:
        cid = f"ctl-{slug(c['Control ID'])}"
        out.setdefault(c["Control ID"], set()).add(cid)
        for s in re.findall(r"(?:HR|NUR|BME)-SOP-\d+", c.get("SOP", "")):
            out.setdefault(s, set()).add(cid)
            sop_of.setdefault(cid, set()).add(s)
        for f in re.findall(r"(?:HR|NUR|BME)-F-\d+", c.get("Evidence", "") + " " + c.get("Control Activity", "")):
            out.setdefault(f, set()).add(cid)
    for name, p in files.items():
        if name.endswith("Manual.docx"):
            pols, _ = C.parse_manual(p)
            for pol in pols:
                for s in pol["sops"]:
                    out.setdefault(pol["code"], set()).update(out.get(s, set()))
    return out


def main() -> None:
    std_path, gap_path, folder = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    apply = "--apply" in sys.argv
    stds = json.loads(std_path.read_text())["standards"]
    gaps = json.loads(gap_path.read_text())
    missing = [s["code"] for s in stds if s["code"] not in gaps]
    if missing and "--partial" not in sys.argv:
        sys.exit(f"{len(missing)} standards not assessed yet (e.g. {missing[:5]}); "
                 f"finish nabh6_gap.py or pass --partial")
    d2c = doc_to_controls(folder)

    con = connect()
    known_controls = {r["id"] for r in con.execute("SELECT id FROM controls")}
    ar = con.execute("SELECT id, verdict, reason FROM applicability_results WHERE regulation_id=? AND company_id=? "
                     "AND scope_type='COMPANY'", (REG, COMPANY)).fetchone()
    company = con.execute("SELECT legal_name FROM company_profile WHERE id=?", (COMPANY,)).fetchone()
    ts = now()

    rows = {"sections": [], "clauses": [], "obligations": [], "requirements": [], "cri": [], "scopes": [],
            "ctl_req": [], "assessments": [], "findings": []}
    tally: dict = {}
    for s in stds:
        g = gaps.get(s["code"])
        sec_id = f"{REG}-sec-{slug(s['code'])}"
        num = s["code"].rstrip(".")
        rows["sections"].append((sec_id, REG, num, f"{s['chapter_name']} — {num}", s["statement"], len(s["statement"])))
        if not g:
            continue
        evidence_considered = json.dumps([p["code"] for p in g["passages"]])
        for e in g["elements"]:
            code = e["code"].rstrip(".")
            cl_id = f"{sec_id}-{e['letter']}"
            ob_id = f"{REG}-obl-{slug(code)}"
            rq_id = f"{cl_id}-r"
            cri_id = f"cri-{rq_id}-{COMPANY}"
            st = e["status"]
            tally[(st, e["risk"])] = tally.get((st, e["risk"]), 0) + 1
            covered_by = ", ".join(e["satisfied_by"]) or "—"
            reason = (f"[{e['risk']} risk · NABH {e['category']}] {st.replace('_', ' ')}"
                      + (f": {e['gap']}" if e["gap"] else ": covered by the hospital's documents.")
                      + (f" Fix: {e['action']}" if e["action"] else "")
                      + f" Covered by: {covered_by}.")
            rows["clauses"].append((cl_id, sec_id, code, e["text"], REG, code, 1))
            rows["obligations"].append((
                ob_id, REG, sec_id, cl_id, f"{code} {e['obligation']}"[:400], e["obligation"],
                "DOCUMENTATION" if e["documentation_required"] else "OPERATIONAL", "shall",
                e["responsible"] or "Hospital", e["frequency"], f"NABH {e['category']}",
                e["requirement"], f"Objective element {code} ({e['category']})", 0.9, "nabh6-layout-parser/2",
                e["category"], e["responsible"], e["text"], ts, "UNREVIEWED", "shall"))
            rows["requirements"].append((
                rq_id, ob_id, REG, e["requirement"] or e["obligation"], e["obligation"], e["frequency"],
                e["responsible"], "Document review: policies, SOPs, forms and control register", code,
                e["text"], 0.85, "nabh6-oe-rewrite/llm-1", "UNREVIEWED", ts))
            rows["cri"].append((cri_id, rq_id, COMPANY, ar["id"] if ar else None, "2025-01-01", STATUS[st], reason, ts,
                                ar["reason"] if ar else None, "COMPANY_ASSESSMENT", "UNREVIEWED", ts, ts))
            rows["scopes"].append((f"{cri_id}-s0", cri_id, "COMPANY", None, company["legal_name"] if company else None,
                                   ar["verdict"] if ar else "REVIEW_REQUIRED",
                                   "NABH Hospitals standard; the company is a hospital.", 0.8, "SYSTEM_DERIVATION", ts))
            ctls = sorted({c for d in e["satisfied_by"] for c in d2c.get(d, set()) if c in known_controls})
            for c in ctls:
                rows["ctl_req"].append((c, rq_id, f"NABH {code}: {st.replace('_', ' ').lower()} via {covered_by}",
                                        "nabh6_gap.py", "UNREVIEWED", ts, cri_id, "COMPANY_ASSESSMENT",
                                        "COVERS" if st == "MET" else "PARTIALLY_COVERS", "semantic retrieval + LLM review",
                                        0.8 if st == "MET" else 0.6))
            rows["assessments"].append((
                f"asm-nabh6-{slug(code)}", cri_id, rq_id, ctls[0] if ctls else None, st,
                "LLM document review (gpt-oss-120b) over semantically retrieved hospital documents", 0.75,
                reason, evidence_considered, "UNREVIEWED", "nabh6_gap.py", ts, ts))
            if st != "MET":
                rows["findings"].append((
                    f"fnd-nabh6-{slug(code)}", cri_id, None, ctls[0] if ctls else None, e["risk"].upper(),
                    f"{code} {st.replace('_', ' ')}: {e['gap'] or e['text']}"[:300],
                    f"NABH requires: {e['text']} | Missing: {e['gap']} | Consequence: {e['consequence']} | "
                    f"Fix: {e['action']}", e["consequence"], "nabh6_gap.py", ts, "OPEN", "COMPANY_ASSESSMENT"))

    print({k: len(v) for k, v in rows.items()})
    for (st, risk), n in sorted(tally.items()):
        print(f"  {st:<12} {risk:<9} {n}")
    if not apply:
        print("dry run — nothing written. Re-run with --apply.")
        return

    req_ids = [r[0] for r in con.execute("SELECT id FROM requirements WHERE regulation_id=?", (REG,))]
    con.execute("DELETE FROM assessments WHERE requirement_id = ANY(?)", (req_ids,))
    con.execute("DELETE FROM obligations WHERE regulation_id=?", (REG,))      # cascades requirements, CRI, ...
    con.execute("DELETE FROM clauses WHERE regulation_id=?", (REG,))
    con.execute("DELETE FROM sections WHERE regulation_id=?", (REG,))
    con.executemany("INSERT INTO sections (id,regulation_id,section_number,section_title,section_text,chars) "
                    "VALUES (?,?,?,?,?,?)", rows["sections"])
    con.executemany("INSERT INTO clauses (id,section_id,clause_number,clause_text,regulation_id,clause_path,depth) "
                    "VALUES (?,?,?,?,?,?,?)", rows["clauses"])
    con.executemany(
        """INSERT INTO obligations (id,regulation_id,section_id,clause_id,title,description,obligation_type,
             mandatory_action,responsible_entity,frequency,applicability,evidence_required,source_reference,
             confidence,extraction_method,kind,actor,source_excerpt,extracted_at,review_status,modality)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows["obligations"])
    con.executemany(
        """INSERT INTO requirements (id,obligation_id,regulation_id,statement,expected_action,frequency,
             responsible_role,test_method,source_clause,source_excerpt,confidence,derivation_method,
             review_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows["requirements"])
    con.executemany(
        """INSERT INTO company_requirement_instances (id,requirement_id,company_id,applicability_result_id,
             effective_from,compliance_status,compliance_reason,compliance_computed_at,applicability_reason,
             fact_class,review_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows["cri"])
    con.executemany(
        """INSERT INTO company_requirement_scopes (id,cri_id,scope_type,scope_entity_id,scope_label,
             applicability_status,reason,confidence,fact_class,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        rows["scopes"])
    con.executemany(
        """INSERT INTO control_requirements (control_id,requirement_id,rationale,mapped_by,review_status,
             created_at,cri_id,fact_class,relationship_type,mapping_method,confidence)
           VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING""", rows["ctl_req"])
    con.executemany(
        """INSERT INTO assessments (id,cri_id,requirement_id,control_id,result,method,confidence,rationale,
             evidence_considered,review_status,assessed_by,assessed_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows["assessments"])
    con.executemany(
        """INSERT INTO findings (id,cri_id,test_id,control_id,severity,title,description,root_cause,raised_by,
             raised_at,status,fact_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", rows["findings"])
    con.commit()
    print("applied.")


if __name__ == "__main__":
    main()
