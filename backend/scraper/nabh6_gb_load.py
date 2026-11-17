"""
Load the NABH Guidebook requirements as their own requirement rows under each
objective element's obligation. Run AFTER nabh6_load.py (which rebuilds the
element-level rows and would cascade-delete these).

    python nabh6_gb_load.py <hosp6_gap.json (with subs)> <company upload folder> [--apply]

Per guidebook requirement:
  requirements   id <element clause>-gb<n>; statement = the requirement; source_excerpt = guidebook words;
                 test_method = the evidence to ask for; page_number = guidebook page
  CRI            compliance_status + reason (same mapping as nabh6_load)
  control_requirements, assessments, findings (unmet only, severity = risk)
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                       # noqa: E402
from nabh6_load import doc_to_controls, REG, COMPANY, STATUS      # noqa: E402

now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")   # noqa: E731


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main() -> None:
    gap = json.loads(Path(sys.argv[1]).read_text())
    d2c = doc_to_controls(Path(sys.argv[2]))
    apply = "--apply" in sys.argv
    con = connect()
    known_controls = {r["id"] for r in con.execute("SELECT id FROM controls")}
    ar = con.execute("SELECT id, verdict, reason FROM applicability_results WHERE regulation_id=? AND company_id=? "
                     "AND scope_type='COMPANY'", (REG, COMPANY)).fetchone()
    company = con.execute("SELECT legal_name FROM company_profile WHERE id=?", (COMPANY,)).fetchone()
    ts = now()
    rq, cri, scopes, ctl, asm, fnd = [], [], [], [], [], []
    for scode, s in gap.items():
        sec_id = f"{REG}-sec-{slug(scode)}"
        for e in s["elements"]:
            code = e["code"].rstrip(".")
            ob_id = f"{REG}-obl-{slug(code)}"
            cl_id = f"{sec_id}-{e['letter']}"
            for x in e.get("subs", []):
                rid = f"{cl_id}-gb{x['n']}"
                cid = f"cri-{rid}-{COMPANY}"
                covered = ", ".join(x["by"]) or "—"
                reason = (f"[{x['risk']} risk · NABH {e['category']} · guidebook] {x['st'].replace('_', ' ')}"
                          + (f": {x['gap']}" if x["gap"] else ": covered by the hospital's documents.")
                          + (f" Fix: {x['fix']}" if x["fix"] else "") + f" Covered by: {covered}.")
                rq.append((rid, ob_id, REG, x["rq"], x["rq"], x["freq"], x["who"], f"Evidence: {x['ev']}",
                           code, x["src"], e.get("gb_page"), 0.8, "nabh6-guidebook/claude-1", "UNREVIEWED", ts))
                cri.append((cid, rid, COMPANY, ar["id"] if ar else None, "2025-01-01", STATUS[x["st"]], reason, ts,
                            ar["reason"] if ar else None, "COMPANY_ASSESSMENT", "UNREVIEWED", ts, ts))
                scopes.append((f"{cid}-s0", cid, "COMPANY", None, company["legal_name"] if company else None,
                               ar["verdict"] if ar else "REVIEW_REQUIRED", "NABH Hospitals guidebook requirement.",
                               0.8, "SYSTEM_DERIVATION", ts))
                ctls = sorted({c for d in x["by"] for c in d2c.get(d, set()) if c in known_controls})
                for c in ctls:
                    ctl.append((c, rid, f"NABH {code} guidebook #{x['n']}: {x['st'].replace('_', ' ').lower()} via {covered}",
                                "nabh6_gb", "UNREVIEWED", ts, cid, "COMPANY_ASSESSMENT",
                                "COVERS" if x["st"] == "MET" else "PARTIALLY_COVERS", "semantic retrieval + Claude review",
                                0.8 if x["st"] == "MET" else 0.6))
                asm.append((f"asm-nabh6gb-{slug(code)}-{x['n']}", cid, rid, ctls[0] if ctls else None, x["st"],
                            "Claude review of the NABH guidebook interpretation against retrieved hospital documents",
                            0.75, reason, json.dumps(x["by"]), "UNREVIEWED", "nabh6_gb", ts, ts))
                if x["st"] != "MET":
                    fnd.append((f"fnd-nabh6gb-{slug(code)}-{x['n']}", cid, None, ctls[0] if ctls else None, x["risk"].upper(),
                                f"{code} guidebook #{x['n']} {x['st'].replace('_', ' ')}: {x['gap'] or x['rq']}"[:300],
                                f"Requirement: {x['rq']} | Evidence: {x['ev']} | Missing: {x['gap']} | Fix: {x['fix']}",
                                x["gap"], "nabh6_gb", ts, "OPEN", "COMPANY_ASSESSMENT"))
    print(f"requirements {len(rq)} · statuses {len(cri)} · control links {len(ctl)} · assessments {len(asm)} · findings {len(fnd)}")
    if not apply:
        print("dry run — nothing written. Re-run with --apply.")
        return
    con.execute("DELETE FROM assessments WHERE id LIKE 'asm-nabh6gb-%'")
    con.execute("DELETE FROM requirements WHERE regulation_id=? AND derivation_method='nabh6-guidebook/claude-1'", (REG,))
    con.executemany("""INSERT INTO requirements (id,obligation_id,regulation_id,statement,expected_action,frequency,
                         responsible_role,test_method,source_clause,source_excerpt,page_number,confidence,derivation_method,
                         review_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rq)
    con.executemany("""INSERT INTO company_requirement_instances (id,requirement_id,company_id,applicability_result_id,
                         effective_from,compliance_status,compliance_reason,compliance_computed_at,applicability_reason,
                         fact_class,review_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", cri)
    con.executemany("""INSERT INTO company_requirement_scopes (id,cri_id,scope_type,scope_entity_id,scope_label,
                         applicability_status,reason,confidence,fact_class,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""", scopes)
    con.executemany("""INSERT INTO control_requirements (control_id,requirement_id,rationale,mapped_by,review_status,created_at,
                         cri_id,fact_class,relationship_type,mapping_method,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT DO NOTHING""", ctl)
    con.executemany("""INSERT INTO assessments (id,cri_id,requirement_id,control_id,result,method,confidence,rationale,
                         evidence_considered,review_status,assessed_by,assessed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", asm)
    con.executemany("""INSERT INTO findings (id,cri_id,test_id,control_id,severity,title,description,root_cause,raised_by,
                         raised_at,status,fact_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", fnd)
    con.commit()
    print("applied.")


if __name__ == "__main__":
    main()
