"""
Break the uploaded company manuals, forms packs and the risk-control register
into the records they define, link them the way the documents themselves say,
and classify each department control against the platform's regulatory controls.

    python classify_company_documents.py <upload folder>            # dry run
    python classify_company_documents.py <upload folder> --apply

What becomes what (company_entities):
  XX-POL-nn  policy                -> domain policies,  type Policy
  XX-SOP-nn  standard op procedure -> domain processes, type SOP
  XX-F-nn    form / format         -> domain evidence,  type Form
  XX-R-nn    risk-register row     -> domain risks,     type Operational risk
  XX-C-nn    control-matrix row    -> domain controls,  type Internal control
                                      (+ a row in `controls`)

Edges (entity_relationships), all stated in the documents except the last:
  SOP      governed_by  Policy        policy's "Related SOPs"
  Control  implements   SOP           control matrix "SOP" column
  Control  mitigates    Risk          risk register "Control IDs" column
  Form     proves       Control       control matrix "Evidence" column
  Form     proves       SOP           forms-pack index "Used In" column
  Control  implements   ctr-ctl-*     LLM classification (confidence < 100)
  SOP      implements   ctr-ctl-*     derived: the SOP's controls' classification
  *        documented_in <file entity> provenance

Everything is written verification='Pending' so it shows up for review.
LLM answers are cached in <upload folder>/.classification.json, so a re-run
does not ask again.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import zipfile
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                      # noqa: E402
from regulatory_ingestion import company_db                      # noqa: E402

DEPTS = {  # code prefix -> (department entity, org node name, label)
    "HR":  ("peo-dept-human-resources", "Human Resources", "Human Resources"),
    "NUR": ("peo-dept-nursing", "Nursing", "Nursing"),
    "BME": ("peo-dept-biomedical-engineering", "Biomedical Engineering", "Biomedical Engineering"),
}
LLM_BASE = os.environ.get("LOCAL_LLM_BASE_URL", "http://172.22.64.1:8081/v1")
LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "gpt-oss-120b")
CODE = r"(?:HR|NUR|BME)"


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def rid(*parts: str) -> str:
    return "rel-" + hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# .docx                                                                        #
# --------------------------------------------------------------------------- #
def paragraphs(path: Path) -> list[tuple[str, str]]:
    x = zipfile.ZipFile(path).read("word/document.xml").decode("utf8", "ignore")
    out = []
    for p in re.findall(r"<w:p[ >].*?</w:p>", x, re.S):
        st = re.search(r'<w:pStyle w:val="([^"]+)"', p)
        t = html.unescape("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))).strip()
        if t:
            out.append((st.group(1) if st else "", t))
    return out


def blocks(ps, kind: str):
    """Yield (code, title, [(style, text)...]) for each Heading2 'n.n  CODE – Title'."""
    head = re.compile(rf"^\d+\.\d+\s+({CODE}-{kind}-\d+)\s*[–-]\s*(.+)$")
    cur = None
    for s, t in ps:
        if s.startswith("Heading1") or s.startswith("Heading2"):
            if cur:
                yield cur
                cur = None
            m = head.match(t) if s.startswith("Heading2") else None
            if m:
                cur = (m.group(1), m.group(2).strip(), [])
            continue
        if cur:
            cur[2].append((s, t))
    if cur:
        yield cur


def section(body, name: str) -> list[str]:
    out, on = [], False
    for s, t in body:
        if s.startswith("Heading3"):
            on = name.lower() in t.lower()
            continue
        if on:
            out.append(t)
    return out


def field(body, label: str) -> str:
    for i, (_, t) in enumerate(body):
        if t == label and i + 1 < len(body):
            return body[i + 1][1]
    return ""


def parse_manual(path: Path) -> tuple[list[dict], list[dict]]:
    ps = paragraphs(path)
    pols, sops = [], []
    for code, title, body in blocks(ps, "POL"):
        pols.append({
            "code": code, "title": title,
            "owner": field(body, "Policy Owner"),
            "standards": field(body, "Applicable Standards"),
            "purpose": " ".join(section(body, "Purpose"))[:600],
            "statement": " ".join(section(body, "Policy Statement"))[:1200],
            "provisions": " • ".join(section(body, "Policy Provisions"))[:3000],
            "monitoring": " ".join(section(body, "Monitoring"))[:600],
            "sops": sorted(set(re.findall(rf"{CODE}-SOP-\d+", " ".join(section(body, "Related SOPs"))))),
        })
    for code, title, body in blocks(ps, "SOP"):
        text = " ".join(t for _, t in body)
        sops.append({
            "code": code, "title": title,
            "purpose": " ".join(section(body, "Purpose"))[:600],
            "responsibility": " ".join(section(body, "Responsibility"))[:400],
            "forms": sorted(set(re.findall(rf"{CODE}-F-\d+", " ".join(section(body, "Records"))))),
            "controls": sorted(set(re.findall(rf"{CODE}-C-\d+", text))),
            "key_controls": " ".join(section(body, "Key Controls"))[:800],
            "procedure": " • ".join(section(body, "Procedure"))[:3000],
            "indicator": " ".join(section(body, "Performance Indicator"))[:300],
        })
    return pols, sops


def parse_forms(path: Path) -> list[dict]:
    ps = [t for _, t in paragraphs(path)]
    code_re = re.compile(rf"^{CODE}-F-\d+$")
    forms, seen = [], set()
    for i, t in enumerate(ps[:-3]):
        if code_re.match(t) and t not in seen and not code_re.match(ps[i + 1]):
            used = re.findall(rf"{CODE}-SOP-\d+", ps[i + 2])
            if not used:            # not the index row; the form body itself
                continue
            seen.add(t)
            forms.append({"code": t, "title": ps[i + 1], "used_in": used, "retention": ps[i + 3]})
    return forms


# --------------------------------------------------------------------------- #
# .xlsx register                                                               #
# --------------------------------------------------------------------------- #
def parse_register(path: Path) -> tuple[list[dict], list[dict]]:
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    risks, controls = [], []
    for ws in wb.worksheets:
        rows = [r for r in ws.iter_rows(values_only=True) if any(c is not None for c in r)]
        if not rows:
            continue
        hdr = [str(c or "").strip() for c in rows[0]]
        recs = [{hdr[i]: ("" if v is None else str(v).strip()) for i, v in enumerate(r) if i < len(hdr) and hdr[i]}
                for r in rows[1:]]
        if ws.title.endswith("Risk Register"):
            for r in recs:
                if re.match(rf"{CODE}-R-\d+", r.get("Risk ID", "")):
                    risks.append(r)
        elif ws.title.endswith("Control Matrix"):
            for r in recs:
                if re.match(rf"{CODE}-C-\d+", r.get("Control ID", "")):
                    controls.append(r)
    return risks, controls


# --------------------------------------------------------------------------- #
# LLM classification                                                           #
# --------------------------------------------------------------------------- #
PROMPT = """You map a hospital's internal controls to a fixed catalogue of regulatory control areas.

CATALOGUE (id: name):
{catalogue}

For each internal control below, pick the catalogue entries whose regulatory area the control
actually helps satisfy (0 to 3 entries; 0 if none fits). Judge by what the control does and the
standards/laws it cites, not by shared words. Confidence is 0-100.

INTERNAL CONTROLS:
{items}

Answer with JSON only, exactly this shape:
{{"results":[{{"id":"<internal control id>","matches":[{{"ctl":"<catalogue id>","confidence":<int>,"why":"<max 15 words>"}}]}}]}}"""


def classify(items: list[dict], catalogue: list[dict], cache: dict, cache_path: Path) -> dict:
    cat_txt = "\n".join(f"{c['id']}: {c['name']}" for c in catalogue)
    valid = {c["id"] for c in catalogue}
    todo = [i for i in items if i["id"] not in cache]
    print(f"  LLM: {len(items) - len(todo)} cached, {len(todo)} to classify")
    import threading
    from concurrent.futures import ThreadPoolExecutor
    lock = threading.Lock()
    done = [0]

    def run(n: int) -> None:
        batch = todo[n:n + 6]
        body = "\n\n".join(f"id: {i['id']}\n{i['text']}" for i in batch)
        for attempt in range(3):
            try:
                r = httpx.post(f"{LLM_BASE}/chat/completions", timeout=600, json={
                    "model": LLM_MODEL, "temperature": 0, "max_tokens": 4000,
                    "response_format": {"type": "json_object"},
                    "chat_template_kwargs": {"reasoning_effort": "low"},
                    "messages": [{"role": "user", "content": PROMPT.format(catalogue=cat_txt, items=body)}],
                })
                r.raise_for_status()
                content = r.json()["choices"][0]["message"]["content"]
                data = json.loads(content[content.find("{"): content.rfind("}") + 1])
                got = {x["id"]: [m for m in x.get("matches", []) if m.get("ctl") in valid]
                       for x in data.get("results", []) if x.get("id")}
                with lock:
                    for i in batch:
                        cache[i["id"]] = got.get(i["id"], [])
                    cache_path.write_text(json.dumps(cache, indent=1))
                    done[0] += len(batch)
                    print(f"    {done[0]}/{len(todo)} done", flush=True)
                return
            except Exception as e:                      # retry; a failed batch stays uncached
                print(f"    batch {n // 6 + 1} attempt {attempt + 1} failed: {e}", flush=True)

    # llama-server runs 4 slots; one request per slot.
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(run, range(0, len(todo), 6)))
    return cache


# --------------------------------------------------------------------------- #
def main() -> None:
    folder = Path(sys.argv[1])
    apply = "--apply" in sys.argv
    files = {p.name: p for p in folder.rglob("*") if p.is_file()}

    pols, sops, forms = [], [], []
    for name, p in files.items():
        if name.endswith("Manual.docx"):
            a, b = parse_manual(p)
            pols += [dict(x, file=name) for x in a]
            sops += [dict(x, file=name) for x in b]
        elif name.endswith("Forms_Pack.docx"):
            forms += [dict(x, file=name) for x in parse_forms(p)]
    reg = next((p for n, p in files.items() if n.endswith(".xlsx")), None)
    risks, ctrls = parse_register(reg) if reg else ([], [])
    print(f"parsed: {len(pols)} policies, {len(sops)} SOPs, {len(forms)} forms, "
          f"{len(risks)} risks, {len(ctrls)} controls")

    con = company_db.init(connect())
    file_ent = {r["name"]: r["id"] for r in con.execute(
        "SELECT id, attrs::json->>'file' AS name FROM company_entities WHERE attrs::json->>'file' IS NOT NULL")}
    file_ent = {Path(k).name: v for k, v in file_ent.items() if k}
    org = {r["name"]: r["id"] for r in con.execute("SELECT id, name FROM org_nodes WHERE kind='Department'")}
    # The platform's regulatory control areas. controls.entity_id holds the OWNING
    # department for these rows; the control's own graph node is 'ctr-' + id.
    catalogue = [dict(r) for r in con.execute(
        """SELECT c.id, c.name, e.id AS entity_id FROM controls c
           JOIN company_entities e ON e.id = 'ctr-' || c.id AND e.domain = 'controls'
           WHERE c.id LIKE 'ctl-%' ORDER BY c.id""")]
    if not catalogue:
        sys.exit("no regulatory controls found to classify against")
    cat_entity = {c["id"]: c["entity_id"] for c in catalogue}

    ents, edges = [], []

    def dept(code: str):
        return DEPTS[code.split("-")[0]]

    def ent(eid, domain, typ, name, desc, code, file, attrs):
        d_ent, d_org, d_label = dept(code)
        ents.append({"id": eid, "domain": domain, "type": typ, "name": name, "description": desc,
                     "ownerId": d_ent, "orgNodeId": org.get(d_org), "lifecycle": "Active",
                     "status": "Active", "verification": "Pending",
                     "attrs": dict(attrs, code=code, department=d_label, file=file),
                     "source": f"document:{file}", "source_reference": code})
        if file in file_ent:
            edges.append((eid, "documented_in", file_ent[file], 100))

    E = lambda kind, code: f"{kind}-{slug(code)}"          # noqa: E731
    for p in pols:
        ent(E("pol", p["code"]), "policies", "Policy", p["title"], p["purpose"] or p["statement"][:600],
            p["code"], p["file"], {"owner": p["owner"], "standards": p["standards"], "statement": p["statement"]})
        for s in p["sops"]:
            edges.append((E("prc", s), "governed_by", E("pol", p["code"]), 100))
    for s in sops:
        ent(E("prc", s["code"]), "processes", "SOP", s["title"], s["purpose"],
            s["code"], s["file"], {"responsibility": s["responsibility"], "forms": s["forms"],
                                    "keyControls": s["key_controls"]})
    for f in forms:
        ent(E("evi", f["code"]), "evidence", "Form", f["title"], f"Controlled form, used in {', '.join(f['used_in'])}",
            f["code"], f["file"], {"retention": f["retention"], "usedIn": f["used_in"]})
        for s in f["used_in"]:
            edges.append((E("evi", f["code"]), "proves", E("prc", s), 100))
    reg_name = reg.name if reg else ""
    for r in risks:
        code = r["Risk ID"]
        ent(E("rsk", code), "risks", "Operational risk", r.get("Risk", code), r.get("Cause", ""),
            code, reg_name, {"category": r.get("Category"), "impact": r.get("Impact"),
                             "inherentRating": r.get("Inherent Rating"), "inherentScore": r.get("Inherent Score"),
                             "residualScore": r.get("Residual Score"), "owner": r.get("Risk Owner") or r.get("Owner")})
        ents[-1]["criticality"] = {"Extreme": "Critical", "Critical": "Critical", "High": "High",
                                   "Medium": "Medium", "Low": "Low"}.get(r.get("Inherent Rating", ""), None)
        for c in re.findall(rf"{CODE}-C-\d+", r.get("Control IDs", "")):
            edges.append((E("ctr", c), "mitigates", E("rsk", code), 100))
    for c in ctrls:
        code = c["Control ID"]
        ent(E("ctr", code), "controls", "Internal control", c.get("Objective", code), c.get("Control Activity", ""),
            code, reg_name, {k: c.get(v) for k, v in (("controlType", "Type"), ("nature", "Nature"),
                             ("frequency", "Frequency"), ("owner", "Owner"), ("evidence", "Evidence"),
                             ("testProcedure", "Test Procedure"), ("standards", "Standards"),
                             ("testResult", "Test Result"))})
        for s in re.findall(rf"{CODE}-SOP-\d+", c.get("SOP", "")):
            edges.append((E("ctr", code), "implements", E("prc", s), 100))
        for f in set(re.findall(rf"{CODE}-F-\d+", c.get("Evidence", "") + " " + c.get("Control Activity", ""))):
            edges.append((E("evi", f), "proves", E("ctr", code), 100))

    # ---- LLM: department control -> regulatory control area ------------------ #
    cache_path = folder / ".classification.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    items = [{"id": c["Control ID"], "text": f"objective: {c.get('Objective')}\nactivity: {c.get('Control Activity')}\n"
              f"standards: {c.get('Standards')}\nSOP: {c.get('SOP')}"} for c in ctrls]
    cache = classify(items, catalogue, cache, cache_path)
    sop_ctl: dict[str, dict[str, int]] = {}
    for c in ctrls:
        code = c["Control ID"]
        for m in cache.get(code, []):
            conf = max(1, min(99, int(m.get("confidence", 50))))
            if conf < 50:
                continue
            edges.append((E("ctr", code), "implements", cat_entity[m["ctl"]], conf))
            for s in re.findall(rf"{CODE}-SOP-\d+", c.get("SOP", "")):
                d = sop_ctl.setdefault(E("prc", s), {})
                d[cat_entity[m["ctl"]]] = max(d.get(cat_entity[m["ctl"]], 0), conf)
    for s, targets in sop_ctl.items():
        for t, conf in targets.items():
            edges.append((s, "implements", t, conf))

    # ---- sanity: drop edges whose ends do not exist ------------------------ #
    known = {e["id"] for e in ents} | set(cat_entity.values()) | set(file_ent.values())
    dangling = [e for e in edges if e[0] not in known or e[2] not in known]
    edges = list({(a, t, b): (a, t, b, c) for a, t, b, c in edges if a in known and b in known}.values())

    by = {}
    for e in ents:
        by[e["domain"]] = by.get(e["domain"], 0) + 1
    et = {}
    for e in edges:
        et[e[1]] = et.get(e[1], 0) + 1
    classified = sum(1 for c in ctrls if any(int(m.get("confidence", 0)) >= 50 for m in cache.get(c["Control ID"], [])))
    print("entities:", by)
    print("edges:", et, f"(dropped {len(dangling)} pointing at codes not in the documents)")
    print(f"controls classified to a regulatory area: {classified}/{len(ctrls)}")
    if dangling[:5]:
        print("  e.g. dangling:", dangling[:5])
    if not apply:
        print("dry run — nothing written. Re-run with --apply.")
        return

    for e in ents:
        company_db.upsert_entity(con, e, actor="classify_company_documents")
    for c in ctrls:
        code = c["Control ID"]
        con.execute(
            """INSERT INTO controls (id,name,description,control_type,frequency,automated,entity_id,
                                     effectiveness,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
                 control_type=excluded.control_type, frequency=excluded.frequency,
                 entity_id=excluded.entity_id, updated_at=excluded.updated_at""",
            (f"ctl-{slug(code)}", f"{code} – {c.get('Objective', '')}"[:300], c.get("Control Activity", ""),
             (c.get("Type") or "").upper() or None, c.get("Frequency"),
             1 if "automated" in (c.get("Nature") or "").lower() else 0, E("ctr", code),
             c.get("Test Result") or "Not Tested", company_db.now(), company_db.now()))
    con.execute("DELETE FROM entity_relationships WHERE id IN (SELECT id FROM entity_relationships "
                "WHERE source_id = ANY(?))", ([e["id"] for e in ents],))
    for a, t, b, c in edges:
        company_db.add_relationship(con, {"id": rid(a, t, b), "sourceId": a, "type": t, "targetId": b,
                                          "confidence": c, "status": "Pending"})
    con.commit()
    print(f"applied: {len(ents)} entities, {len(ctrls)} controls, {len(edges)} edges")


if __name__ == "__main__":
    main()
