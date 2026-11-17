"""
Regulatory Intelligence pipeline orchestrator (spec §1, §39, §41, §46).

  migrate  — seed the DB from the scraped catalog (existing data, never deleted)
  process  — run a regulation end-to-end: download → hash → extract → structure
             → obligations → applicability → Company Brain match → impact →
             provenance → export UI intel JSON
  export   — write /public/data/intel/*.json consumed by the frontend

Run:  ./.venv/bin/python -m regulatory_ingestion.pipeline --process reg-mdkyc
"""
import argparse
import time
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent))
from regulatory_ingestion.db import connect  # noqa: E402
from regulatory_ingestion.parsers import extract_obligations, extract_applicability  # noqa: E402
from regulatory_ingestion.matcher import load_brain, match_obligation, graph_mappings  # noqa: E402
from regulatory_ingestion.impact import score  # noqa: E402

HERE = Path(__file__).parent.parent
CATALOG = HERE / "output" / "regulations.json"
EXTRACTED = HERE / "output" / "extracted"
DOCS_DIR = HERE / "output" / "documents"
INTEL_DIR = HERE.parent / "company-brain-app" / "public" / "data" / "intel"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"}

# regulation entity ids in the app whose seed obligations feed the graph signal
SEED_OBLIGATIONS = {"reg-mdkyc": ["obl-kyc-periodic", "obl-cdd", "obl-coolingoff"]}
TRACKED_META = {
    "reg-mdkyc": {
        "title": "Master Direction – Know Your Customer (KYC) Direction, 2016",
        "regulator": "Reserve Bank of India", "regulator_short": "RBI",
        "regulation_type": "Master Direction", "reference_number": "RBI/DBR/2015-16/18",
        "sector": "Banking & Finance", "issued_on": "25 February 2016",
        "source_url": "https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=11566",
        "official_document_url": "https://www.rbi.org.in/commonman/Upload/English/Notification/PDFs/MD18KYCF6E92C82E1E1419D87323E3869BC9F13.pdf",
    },
}


def log(con, reg_id, step, status, detail=""):
    con.execute("INSERT INTO ingestion_jobs (regulation_id, step, status, detail) VALUES (?,?,?,?)",
                (reg_id, step, status, detail[:300]))
    con.commit()
    print(f"[{status}] {reg_id} · {step} {('· ' + detail[:80]) if detail else ''}")


def set_status(con, reg_id, status):
    con.execute("UPDATE regulations SET ingestion_status=?, updated_at=datetime('now') WHERE id=?", (status, reg_id))
    con.commit()


def migrate(con):
    """Seed regulations from the scraped catalog + tracked instruments (spec §39)."""
    cat = json.loads(CATALOG.read_text())
    n = 0
    for r in cat["regulations"]:
        con.execute("""INSERT INTO regulations (id,title,regulator,regulator_short,regulation_type,
            sector,ministry,issued_on,source_url,official_document_url,ingestion_status)
            VALUES (?,?,?,?,?,?,?,?,?,?, 'DISCOVERED')
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=datetime('now')""",
            (r["id"], r["title"], r["regulator"], r["regulatorShort"], r["kind"],
             r.get("sector"), r.get("ministry"), r.get("date"), r["detailUrl"], r.get("pdfUrl")))
        n += 1
    for rid, m in TRACKED_META.items():
        con.execute("""INSERT INTO regulations (id,title,regulator,regulator_short,regulation_type,
            reference_number,sector,issued_on,source_url,official_document_url,ingestion_status)
            VALUES (?,?,?,?,?,?,?,?,?,?, 'DISCOVERED')
            ON CONFLICT(id) DO NOTHING""",
            (rid, m["title"], m["regulator"], m["regulator_short"], m["regulation_type"],
             m["reference_number"], m["sector"], m["issued_on"], m["source_url"], m["official_document_url"]))
    # documents already text-extracted by stage 2 → mark EXTRACTED
    idx_f = EXTRACTED / "index.json"
    if idx_f.exists():
        for rid, meta in json.loads(idx_f.read_text()).items():
            if meta.get("ok"):
                con.execute("UPDATE regulations SET ingestion_status='EXTRACTED' WHERE id=? AND ingestion_status='DISCOVERED'", (rid,))
    con.commit()
    print(f"[migrate] {n} catalog regulations seeded (existing rows preserved)")


def process(con, reg_id):
    reg = con.execute("SELECT * FROM regulations WHERE id=?", (reg_id,)).fetchone()
    if not reg:
        raise SystemExit(f"unknown regulation {reg_id} — run --migrate first")
    pdf_url = reg["official_document_url"]
    if not pdf_url:
        set_status(con, reg_id, "FAILED")
        log(con, reg_id, "download", "FAILED", "no official document URL")
        return

    # 1-2. download + store + hash
    set_status(con, reg_id, "DOWNLOADING")
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    local = DOCS_DIR / f"{reg_id}.pdf"
    if not local.exists():
        resp = requests.get(pdf_url, headers=HEADERS, timeout=120)
        resp.raise_for_status()
        local.write_bytes(resp.content)
    blob = local.read_bytes()
    sha = hashlib.sha256(blob).hexdigest()
    log(con, reg_id, "download", "DOWNLOADED", f"{len(blob)//1024} KB sha256={sha[:16]}…")

    # 3. extract (reuse stage-2 extraction; run it if missing)
    ext_f = EXTRACTED / f"{reg_id}.json"
    if not ext_f.exists():
        set_status(con, reg_id, "EXTRACTING")
        import subprocess
        subprocess.run([sys.executable, str(HERE / "extract_pdf_text.py"), "--ids", reg_id], check=True)
    if not ext_f.exists():
        set_status(con, reg_id, "OCR_REQUIRED")
        log(con, reg_id, "extract", "OCR_REQUIRED", "no text layer — OCR stage not yet run")
        return
    doc = json.loads(ext_f.read_text())
    doc_id = f"doc-{reg_id}"
    con.execute("""INSERT INTO documents (id,regulation_id,file_name,file_type,file_size,
        storage_path,source_url,document_hash,page_count,extraction_method,extraction_status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'EXTRACTED')
        ON CONFLICT (id) DO UPDATE SET
          regulation_id=EXCLUDED.regulation_id, file_name=EXCLUDED.file_name,
          file_type=EXCLUDED.file_type, file_size=EXCLUDED.file_size,
          storage_path=EXCLUDED.storage_path, source_url=EXCLUDED.source_url,
          document_hash=EXCLUDED.document_hash, page_count=EXCLUDED.page_count,
          extraction_method=EXCLUDED.extraction_method,
          extraction_status=EXCLUDED.extraction_status""",
        (doc_id, reg_id, local.name, "pdf", len(blob), str(local), pdf_url, sha,
         doc["pages"], doc["method"]))
    con.execute("UPDATE regulations SET document_id=?, source_verified=1, verified_at=datetime('now') WHERE id=?", (doc_id, reg_id))
    log(con, reg_id, "extract", "EXTRACTED", f"{doc['pages']}p · {doc['chars']} chars · {len(doc['sections'])} sections")

    # 4. structure → sections
    set_status(con, reg_id, "PARSING")
    con.execute("DELETE FROM sections WHERE regulation_id=?", (reg_id,))
    sec_id_by_no = {}
    for i, s in enumerate(doc["sections"]):
        sid = f"{reg_id}-s{i:03d}"
        sec_id_by_no.setdefault(s["no"], sid)   # numbering restarts across chapters/annexures
        con.execute("INSERT INTO sections (id,regulation_id,section_number,section_title,section_text,chars) VALUES (?,?,?,?,?,?)",
                    (sid, reg_id, str(s["no"]), s["title"], s["text"], s["chars"]))
    # 5. obligations + applicability
    obls = extract_obligations(reg_id, doc["sections"])
    con.execute("DELETE FROM obligations WHERE regulation_id=?", (reg_id,))
    for o in obls:
        con.execute("""INSERT INTO obligations (id,regulation_id,section_id,title,description,obligation_type,
            mandatory_action,responsible_entity,frequency,evidence_required,source_reference,confidence,extraction_method)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (o["id"], reg_id, sec_id_by_no.get(o["section_no"]), o["title"], o["description"], o["obligation_type"],
             o["mandatory_action"], o["responsible_entity"], o["frequency"], o["evidence_required"],
             o["source_reference"], o["confidence"], o["extraction_method"]))
    apps = extract_applicability(doc["sections"])
    con.execute("DELETE FROM applicability_rules WHERE regulation_id=?", (reg_id,))
    for a in apps:
        # `role` is the whole point of the addressee test: applicability.evaluate()
        # counts a rule ONLY when its role starts with ADDRESSEE, so that an
        # unclassified rule is never trusted as a finding.
        #
        # This INSERT used to omit the column. extract_applicability() decided
        # the role and the write discarded it, so every rule the ingest pipeline
        # produced was stored with role NULL — and skipped. A regulation could
        # say "these rules apply to all hospitals" in its scope clause, be
        # extracted correctly as hospitals/Applies, and still come back
        # REVIEW_REQUIRED for ever, because the one field that made it count was
        # dropped between deciding it and saving it.
        con.execute("""INSERT INTO applicability_rules
            (regulation_id,entity_type,applicability,applicability_rule,source_clause,
             confidence,role,evidence,classified_at)
            VALUES (?,?,?,?,?,?,?,?,now())""",
            (reg_id, a["entity_type"], a["applicability"], a["applicability_rule"],
             a["source_clause"], a["confidence"], a.get("role"), a["applicability_rule"]))
    from regulatory_ingestion import penalties as _pen
    n_pen = _pen.extract_for(con, reg_id)
    set_status(con, reg_id, "STRUCTURED")
    log(con, reg_id, "structure", "STRUCTURED", f"{len(doc['sections'])} sections · {len(obls)} obligations · {len(apps)} applicability rules · {n_pen} penalty provisions")

    # 6-7. Company Brain matching + impact
    brain = load_brain()
    rels = graph_mappings(SEED_OBLIGATIONS.get(reg_id, []), brain)
    for o in obls:
        rels.extend(match_obligation(o, brain))
    # de-dup by (entity, obligation) keeping highest confidence
    best = {}
    for r in rels:
        k = (r["company_brain_entity_id"], r.get("obligation_id"))
        if k not in best or r["confidence"] > best[k]["confidence"]:
            best[k] = r
    rels = list(best.values())
    con.execute("DELETE FROM impact_relationships WHERE regulation_id=?", (reg_id,))
    for r in rels:
        # Deterministic id from the natural key. Omitting it let SQLite store
        # 206k rows with NULL primary keys — accepted silently there, rejected
        # outright by Postgres, and duplicate-prone either way.
        rel_id = "imp-" + hashlib.sha1(
            f"{reg_id}|{r.get('obligation_id') or ''}|{r['company_brain_entity_id']}".encode()
        ).hexdigest()[:20]
        con.execute("""INSERT INTO impact_relationships (id,regulation_id,obligation_id,company_brain_entity_id,entity_name,
            entity_domain,relationship_type,match_reason,match_signals,confidence,regulation_clause_id,source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rel_id, reg_id, r.get("obligation_id"), r["company_brain_entity_id"], r["entity_name"], r["entity_domain"],
             r["relationship_type"], r["match_reason"], r["match_signals"], r["confidence"], r.get("regulation_clause_id"), r["source"]))
    # score()'s third argument is the materialised applicability VERDICT
    # (see impact.py) — a fresh ingest has none yet, so None: score treats the
    # regulation as unclassified rather than excluded or boosted. Passing the
    # applicability-rules list here (the old signature) crashed on Postgres runs.
    verdict = reg["applicability"] or None
    # Residual-risk scoring (impact_v2): reads the impact_relationships + obligations
    # just written above, nets off existing controls, scales by severity/deadline,
    # and stores the residual as the headline score with the full breakdown (incl.
    # the v1 gross-exposure number) in factors. See impact_v2.py.
    from . import impact_v2 as _v2
    sc = _v2.compute(con, reg_id)
    _v2.store(con, reg_id, sc)

    # provenance (spec §31)
    con.execute("DELETE FROM verification_records WHERE regulation_id=?", (reg_id,))
    prov = [
        ("title", reg["title"], "official index page", None, None, "index scrape", 0.99, 1),
        ("issued_on", reg["issued_on"], "official index page", None, None, "index scrape", 0.95, 1),
        ("document_hash", sha, "downloaded original PDF", None, None, "sha-256", 1.0, 1),
        ("sections", str(len(doc["sections"])), "original PDF", "all", None, doc["method"], 0.95, 1),
        ("obligations", str(len(obls)), "original PDF", None, "per source_reference", "deterministic modal-verb rule", 0.85, 0),
        ("impact_mapping", f"{len(rels)} relationships", "matching engine", None, None, "exact/keyword/graph signals", 0.9, 0),
    ]
    for f, v, srcd, page, clause, method, confv, ver in prov:
        con.execute("""INSERT INTO verification_records (regulation_id,field,value,source_document,page,clause,extraction_method,confidence,verified)
            VALUES (?,?,?,?,?,?,?,?,?)""", (reg_id, f, str(v)[:200], srcd, page, clause, method, confv, ver))
    set_status(con, reg_id, "MAPPED")
    log(con, reg_id, "map", "MAPPED", f"{len(rels)} impact relationships · impact {sc['level']} ({sc['score']}/100)")
    con.commit()


def export(con):
    """Write frontend intel JSON (spec §37 read models, static form)."""
    INTEL_DIR.mkdir(parents=True, exist_ok=True)
    index = {}
    for reg in con.execute("SELECT * FROM regulations WHERE ingestion_status='MAPPED'").fetchall():
        rid = reg["id"]
        obls = [dict(r) for r in con.execute("SELECT * FROM obligations WHERE regulation_id=?", (rid,))]
        rels = [dict(r) for r in con.execute("SELECT * FROM impact_relationships WHERE regulation_id=?", (rid,))]
        apps = [dict(r) for r in con.execute("SELECT * FROM applicability_rules WHERE regulation_id=?", (rid,))]
        scr = con.execute("SELECT * FROM impact_scores WHERE regulation_id=?", (rid,)).fetchone()
        docr = con.execute("SELECT * FROM documents WHERE regulation_id=?", (rid,)).fetchone()
        ver = [dict(r) for r in con.execute("SELECT * FROM verification_records WHERE regulation_id=?", (rid,))]
        jobs = [dict(r) for r in con.execute("SELECT step,status,detail,at FROM ingestion_jobs WHERE regulation_id=? ORDER BY id", (rid,))]
        payload = {
            "regulation": dict(reg), "obligations": obls, "impactRelationships": rels,
            "applicability": apps, "impact": dict(scr) if scr else None,
            "document": dict(docr) if docr else None, "verification": ver, "jobs": jobs,
        }
        (INTEL_DIR / f"{rid}.json").write_text(json.dumps(payload, ensure_ascii=False))
        index[rid] = {"status": reg["ingestion_status"], "impact": reg["impact_level"], "score": reg["impact_score"],
                      "obligations": len(obls), "relationships": len(rels)}
    # entity-centric view: which regulations reference each Company Brain entity
    # (consumed by the Company Graph's regulatory-impact indicators)
    ent = {}
    for r in con.execute("""SELECT ir.company_brain_entity_id eid, ir.entity_name, ir.entity_domain, ir.regulation_id rid,
                                   reg.title, reg.regulator_short, reg.impact_level, MAX(ir.confidence) conf, COUNT(*) n
                            FROM impact_relationships ir JOIN regulations reg ON reg.id = ir.regulation_id
                            GROUP BY ir.company_brain_entity_id, ir.regulation_id"""):
        ent.setdefault(r["eid"], {"name": r["entity_name"], "domain": r["entity_domain"], "regulations": []})["regulations"].append(
            {"id": r["rid"], "title": r["title"], "regulator": r["regulator_short"], "impact": r["impact_level"],
             "confidence": r["conf"], "links": r["n"]})
    for v in ent.values():
        v["regulations"].sort(key=lambda x: (-(x["confidence"] or 0), x["title"]))
    (INTEL_DIR / "entities.json").write_text(json.dumps({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                                         "entities": ent}, ensure_ascii=False))
    # ingestion dashboard stats
    stats = {}
    for row in con.execute("SELECT regulator_short, ingestion_status, COUNT(*) n FROM regulations GROUP BY 1,2"):
        stats.setdefault(row["regulator_short"], {})[row["ingestion_status"]] = row["n"]
    totals = {r["ingestion_status"]: r["n"] for r in con.execute("SELECT ingestion_status, COUNT(*) n FROM regulations GROUP BY 1")}
    (INTEL_DIR / "index.json").write_text(json.dumps({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                                      "regulations": index}, ensure_ascii=False))
    (INTEL_DIR / "ingestion.json").write_text(json.dumps({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                                          "bySource": stats, "totals": totals}, ensure_ascii=False, indent=1))
    print(f"[export] {len(index)} mapped regulation(s) + ingestion stats → {INTEL_DIR}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--migrate", action="store_true")
    ap.add_argument("--process", nargs="*", default=[])
    ap.add_argument("--all-extracted", action="store_true",
                    help="process every regulation that has extracted text but is not yet in documents")
    ap.add_argument("--delay", type=float, default=1.5,
                    help="seconds between documents — these are government servers")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()
    con = connect()
    if args.migrate:
        migrate(con)
    todo = list(args.process)
    if args.all_extracted:
        # Everything with extracted text that never made it into `documents`.
        # This gap is why 607 successfully-extracted regulations were invisible
        # to the UI, retrieval and the impact engine.
        import json as _json
        idx_f = EXTRACTED / "index.json"
        idx = _json.loads(idx_f.read_text()) if idx_f.exists() else {}
        ok = {k for k, v in idx.items() if v.get("ok")}
        known = {r[0] for r in con.execute("SELECT id FROM regulations")}
        indb = {r[0] for r in con.execute("SELECT regulation_id FROM documents")}
        todo += sorted((ok & known) - indb)
    if args.limit:
        todo = todo[:args.limit]

    done = failed = 0
    for n, rid in enumerate(todo, 1):
        try:
            process(con, rid)
            done += 1
        except Exception as e:
            failed += 1
            # One bad document must not abort a 600-document run
            print(f"[FAIL] {rid}: {type(e).__name__}: {str(e)[:140]}")
            try:
                set_status(con, rid, "FAILED")
                log(con, rid, "process", "FAILED", str(e)[:280])
                con.commit()
            except Exception:
                pass
        if n % 25 == 0:
            print(f"  … {n}/{len(todo)} processed ({done} ok, {failed} failed)")
        if args.delay:
            time.sleep(args.delay)
    if todo:
        print(f"done: {done} processed, {failed} failed")

    # NOTE: export() writes build-time JSON into the frontend's public/data.
    # The frontend no longer reads those files — regIntel.ts and regulationsApi.ts
    # both go through the API now — so running it by default would recreate the
    # very static-JSON path that was deliberately removed. Opt-in only.
    if args.export:
        export(con)
