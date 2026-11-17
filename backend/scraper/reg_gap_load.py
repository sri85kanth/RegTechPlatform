"""
Write the hospital regulatory gap assessment into the app (in place — the
requirements keep their ids, so traceability and the regulation pages hold).

    python reg_gap_load.py <regs_gap.json> <company upload folder> [--apply]

Per requirement:
  requirements.statement        rewritten testable requirement (original text kept in source_excerpt)
  requirements.expected_action  rewritten obligation ("The hospital shall ...")
  company_requirement_instances compliance_status + reason
                                MET->COMPLIANT PARTIAL->PARTIALLY_COMPLIANT GAP->NON_COMPLIANT
                                NOT_COVERED->EVIDENCE_MISSING NOT_APPLICABLE->NOT_APPLICABLE
  control_requirements          department controls behind the documents that cover it
  assessments                   verdict + rationale (asm-gap-*)
  findings                      OPEN finding per unmet requirement (fnd-gap-*), severity = risk
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                      # noqa: E402
from nabh6_load import doc_to_controls                            # noqa: E402

COMPANY = 1
STATUS = {"MET": "COMPLIANT", "PARTIAL": "PARTIALLY_COMPLIANT", "GAP": "NON_COMPLIANT",
          "NOT_COVERED": "EVIDENCE_MISSING", "NOT_APPLICABLE": "NOT_APPLICABLE"}
now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")   # noqa: E731
h = lambda s: hashlib.sha1(s.encode()).hexdigest()[:20]                   # noqa: E731


def main() -> None:
    data = json.loads(Path(sys.argv[1]).read_text())
    results: dict = data["results"]
    d2c = doc_to_controls(Path(sys.argv[2]))
    apply = "--apply" in sys.argv
    con = connect()
    known_controls = {r["id"] for r in con.execute("SELECT id FROM controls")}
    cri = {r["requirement_id"]: r["id"] for r in con.execute(
        "SELECT id, requirement_id FROM company_requirement_instances WHERE company_id=? AND requirement_id = ANY(?)",
        (COMPANY, list(results)))}
    orig = {r["id"]: (r["statement"], r["source_excerpt"]) for r in con.execute(
        "SELECT id, statement, source_excerpt FROM requirements WHERE id = ANY(?)", (list(results),))}
    ts = now()
    upd_req, upd_cri, ctl_req, asm, fnd = [], [], [], [], []
    no_cri = 0
    for rid, r in results.items():
        st = r["st"]
        covered = ", ".join(r["by"]) or "—"
        if st == "NOT_APPLICABLE":
            reason = "Not applicable: this provision does not place a duty on the hospital."
        else:
            reason = (f"[{r['rk']} risk] {st.replace('_', ' ')}" + (f": {r['gap']}" if r["gap"] else ": covered by the hospital's documents.")
                      + (f" Fix: {r['fix']}" if r["fix"] else "") + f" Covered by: {covered}.")
        if st != "NOT_APPLICABLE" and r["rq"] and rid in orig:
            o_stmt, o_exc = orig[rid]
            upd_req.append((r["rq"], r["ob"], r["who"], r["freq"], o_exc or o_stmt, "doc-gap-review/claude-1", rid))
        c = cri.get(rid)
        if not c:
            no_cri += 1
            continue
        upd_cri.append((STATUS[st], reason, ts, ts, c))
        ctls = sorted({x for code in r["by"] for x in d2c.get(code, set()) if x in known_controls})
        for x in ctls:
            ctl_req.append((x, rid, f"{st.replace('_', ' ').lower()} via {covered}", "reg_gap_review", "UNREVIEWED", ts, c,
                            "COMPANY_ASSESSMENT", "COVERS" if st == "MET" else "PARTIALLY_COVERS",
                            "semantic retrieval + Claude review", 0.8 if st == "MET" else 0.6))
        asm.append((f"asm-gap-{h(rid)}", c, rid, ctls[0] if ctls else None, st,
                    "Claude document review over semantically retrieved hospital documents", 0.75, reason,
                    json.dumps(r["by"]), "UNREVIEWED", "reg_gap_review", ts, ts))
        if st not in ("MET", "NOT_APPLICABLE"):
            fnd.append((f"fnd-gap-{h(rid)}", c, None, ctls[0] if ctls else None, r["rk"].upper(),
                        f"{st.replace('_', ' ')}: {r['gap'] or r['rq'] or r['ob']}"[:300],
                        f"Requirement: {r['rq']} | Missing: {r['gap']} | Consequence: {r['why']} | Fix: {r['fix']}",
                        r["why"], "reg_gap_review", ts, "OPEN", "COMPANY_ASSESSMENT"))
    print(f"requirements rewritten {len(upd_req)} · statuses {len(upd_cri)} (no CRI row: {no_cri}) · control links {len(ctl_req)} · "
          f"assessments {len(asm)} · findings {len(fnd)}")
    if not apply:
        print("dry run — nothing written. Re-run with --apply.")
        return
    con.executemany("""UPDATE requirements SET statement=?, expected_action=?, responsible_role=?, frequency=?,
                         source_excerpt=?, derivation_method=? WHERE id=?""", upd_req)
    con.executemany("""UPDATE company_requirement_instances SET compliance_status=?, compliance_reason=?,
                         compliance_computed_at=?, updated_at=? WHERE id=?""", upd_cri)
    con.execute("DELETE FROM control_requirements WHERE mapped_by='reg_gap_review'")
    con.executemany("""INSERT INTO control_requirements (control_id,requirement_id,rationale,mapped_by,review_status,created_at,
                         cri_id,fact_class,relationship_type,mapping_method,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT DO NOTHING""", ctl_req)
    con.execute("DELETE FROM assessments WHERE id LIKE 'asm-gap-%'")
    con.executemany("""INSERT INTO assessments (id,cri_id,requirement_id,control_id,result,method,confidence,rationale,
                         evidence_considered,review_status,assessed_by,assessed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", asm)
    con.execute("DELETE FROM findings WHERE id LIKE 'fnd-gap-%'")
    con.executemany("""INSERT INTO findings (id,cri_id,test_id,control_id,severity,title,description,root_cause,raised_by,
                         raised_at,status,fact_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", fnd)
    con.commit()
    print("applied.")


if __name__ == "__main__":
    main()
