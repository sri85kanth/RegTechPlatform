"""
NABH Hospitals 6th Edition — rewrite every objective element as a clean
obligation + testable requirement, and judge it against the hospital's own
policies, SOPs, controls and forms. Not text matching: for each standard the
most relevant company passages are retrieved by meaning (bge embeddings over the
procedure / provision text), and the local LLM reads them and decides whether
the element is MET, PARTIAL, GAP or NOT_COVERED, citing the document codes.

    python nabh6_gap.py <hosp6.json> <company upload folder> <out.json> [--only AAC,HRM]

Results are cached per standard in <out.json>, so a re-run resumes.

Risk is a rule, not an LLM opinion — the NABH category decides how much an
unmet element costs at assessment:
    CORE        unmet -> Critical   (a CORE non-compliance blocks accreditation)
    COMMITMENT  unmet -> High
    ACHIEVEMENT unmet -> Medium
    EXCELLENCE  unmet -> Low
    PARTIAL is one band lower — except CORE, which stays Critical: every Core
    element must score at least 4 or the hospital is not accredited, so a
    partly met Core element is as much a fail risk as an unmet one. MET is None.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_company_documents as C                            # noqa: E402

LLM_BASE = os.environ.get("LOCAL_LLM_BASE_URL", "http://172.22.64.1:8081/v1")
LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "gpt-oss-120b")
BANDS = ["None", "Low", "Medium", "High", "Critical"]
BASE_RISK = {"CORE": "Critical", "COMMITMENT": "High", "ACHIEVEMENT": "Medium", "EXCELLENCE": "Low"}


def risk_for(category: str, status: str) -> str:
    base = BASE_RISK.get(category or "", "Medium")
    if status == "MET":
        return "None"
    if status == "PARTIAL" and category != "CORE":  # a Core element below 4 fails accreditation
        return BANDS[max(1, BANDS.index(base) - 1)]
    return base                                     # GAP / NOT_COVERED, or any unmet CORE


# --------------------------------------------------------------------------- #
# The hospital's documents, as passages                                        #
# --------------------------------------------------------------------------- #
def company_corpus(folder: Path) -> list[dict]:
    """
    One passage per provision / procedure step, not one per document: an
    element is usually answered by a single sentence deep inside a policy, and a
    whole-document passage truncated for the prompt never shows it.
    """
    files = {p.name: p for p in folder.rglob("*") if p.is_file()}
    docs: list[dict] = []

    def add(code, kind, title, text):
        text = (text or "").strip()
        if len(text) > 15:
            docs.append({"code": code, "kind": kind, "title": title, "text": text[:600]})

    for name, p in files.items():
        if name.endswith("Manual.docx"):
            ps = C.paragraphs(p)
            for code, title, body in C.blocks(ps, "POL"):
                add(code, "Policy", title, " ".join(C.section(body, "Purpose")))
                add(code, "Policy", title, " ".join(C.section(body, "Policy Statement")))
                for item in C.section(body, "Policy Provisions"):
                    add(code, "Policy", title, item)
                add(code, "Policy", title, "Monitoring: " + " ".join(C.section(body, "Monitoring")))
            for code, title, body in C.blocks(ps, "SOP"):
                add(code, "SOP", title, " ".join(C.section(body, "Purpose")))
                add(code, "SOP", title, "Responsibility: " + " ".join(C.section(body, "Responsibility")))
                for item in C.section(body, "Procedure"):
                    add(code, "SOP", title, item)
                add(code, "SOP", title, "Records/formats: " + " ".join(C.section(body, "Records")))
                for item in C.section(body, "Key Controls"):
                    add(code, "SOP", title, "Key control: " + item)
                add(code, "SOP", title, "Indicator: " + " ".join(C.section(body, "Performance Indicator")))
        elif name.endswith("Forms_Pack.docx"):
            for f in C.parse_forms(p):
                docs.append({"code": f["code"], "kind": "Form", "title": f["title"],
                             "text": f"Controlled form used in {', '.join(f['used_in'])}; retention {f['retention']}."})
    reg = next((p for n, p in files.items() if n.endswith(".xlsx")), None)
    if reg:
        _risks, ctrls = C.parse_register(reg)
        for c in ctrls:
            docs.append({"code": c["Control ID"], "kind": "Control", "title": c.get("Objective", ""),
                         "text": f"{c.get('Control Activity', '')} Frequency: {c.get('Frequency', '')}. "
                                 f"Owner: {c.get('Owner', '')}. Evidence: {c.get('Evidence', '')} "
                                 f"SOP: {c.get('SOP', '')}. Standards: {c.get('Standards', '')}. "
                                 f"Last test: {c.get('Test Result', '')}"})
    return docs


class Retriever:
    def __init__(self, docs: list[dict]):
        from sentence_transformers import SentenceTransformer
        import numpy as np
        self.np = np
        self.docs = docs
        self.model = SentenceTransformer("BAAI/bge-base-en-v1.5", device="cpu")
        self.emb = self.model.encode([f"{d['kind']} {d['code']} {d['title']}. {d['text'][:1500]}" for d in docs],
                                     normalize_embeddings=True, batch_size=32, show_progress_bar=False)

    def top(self, query: str, k: int = 8) -> list[tuple[dict, float]]:
        q = self.model.encode(["Represent this sentence for searching relevant passages: " + query],
                              normalize_embeddings=True)[0]
        sims = self.emb @ q
        idx = self.np.argsort(-sims)[:k]
        return [(self.docs[i], float(sims[i])) for i in idx]


# --------------------------------------------------------------------------- #
# LLM judgement, one standard per call                                         #
# --------------------------------------------------------------------------- #
PROMPT = """You are a NABH lead assessor doing a document-based gap assessment of a hospital
against the NABH Accreditation Standards for Hospitals, 6th Edition.

The hospital has so far provided ONLY these documents: Human Resources manual + forms,
Nursing Services manual + forms, Biomedical Engineering manual + forms, and a
risk/control/evidence register for HR, Nursing and Biomedical Engineering.
No documents were provided for laboratory, imaging, pharmacy, infection control,
quality, facility/fire safety, IT/medical records, or hospital governance.

STANDARD {code} ({chapter}): {statement}

OBJECTIVE ELEMENTS (category; * = NABH expects documented policy/procedure):
{elements}

INDEX OF EVERY POLICY AND SOP THE HOSPITAL HAS (code: title):
{index}

MOST RELEVANT PASSAGES FROM THE HOSPITAL'S DOCUMENTS, retrieved per element (code | type | title: text):
{passages}

If the index shows a policy/SOP whose title clearly addresses an element but its passage is not
shown above, treat the element as at least PARTIAL and cite that code — never call a topic missing
when the index shows a document for it."""

PROMPT += """

For EVERY objective element, decide from the passages only:
- MET: a policy/SOP/control/form clearly covers what the element requires.
- PARTIAL: something relevant exists but a specific part is missing (say exactly what).
- GAP: the topic is in an area the hospital documented, but the requirement is not addressed.
- NOT_COVERED: the element belongs to an area for which no document was provided.
Do not count a passage just because it shares words; it must actually satisfy the requirement.

Also rewrite each element:
- "ob": the obligation as one clear duty sentence starting "The hospital shall".
- "rq": the testable requirement an assessor checks: what must exist or be done, and the evidence.
- "who": the responsible role/department. "freq": how often (or "Ongoing" / "Per event").

Answer with JSON only:
{{"r":[{{"c":"<element code e.g. AAC.1.a>","ob":"...","rq":"...","who":"...","freq":"...",
"st":"MET|PARTIAL|GAP|NOT_COVERED","by":["<doc codes that satisfy it>"],
"gap":"<what is missing, empty if MET>","fix":"<recommended action, empty if MET>",
"why":"<one line: consequence for patients/accreditation if not met>"}}]}}
Keep every field short (under 30 words)."""


def judge(std: dict, passages: list[tuple[dict, float]], index: str) -> list[dict]:
    els = "\n".join(f"{e['code']} [{e['category']}{' *' if e['documentation_required'] else ''}] {e['text']}"
                    for e in std["elements"])
    # group the retrieved sentences under their document so the model sees each source once
    grouped: dict[str, list[str]] = {}
    heads: dict[str, str] = {}
    for d, _ in passages:
        heads[d["code"]] = f"{d['code']} | {d['kind']} | {d['title']}"
        grouped.setdefault(d["code"], []).append(d["text"][:400])
    ps = "\n".join(heads[c] + ":\n" + "\n".join(f"   - {t}" for t in ts) for c, ts in grouped.items())
    body = {"model": LLM_MODEL, "temperature": 0, "max_tokens": 6000,
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"reasoning_effort": "low"},
            "messages": [{"role": "user", "content": PROMPT.format(
                code=std["code"], chapter=std["chapter_name"], statement=std["statement"],
                elements=els, index=index, passages=ps)}]}
    last = None
    for _ in range(3):
        try:
            r = httpx.post(f"{LLM_BASE}/chat/completions", json=body, timeout=1200)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            data = json.loads(content[content.find("{"): content.rfind("}") + 1])
            got = {x.get("c", "").rstrip("."): x for x in data.get("r", [])}
            if all(e["code"].rstrip(".") in got for e in std["elements"]):
                return [got[e["code"].rstrip(".")] for e in std["elements"]]
            last = f"answer covered {len(got)}/{len(std['elements'])} elements"
        except Exception as ex:                                  # retry
            last = str(ex)
    raise RuntimeError(f"{std['code']}: {last}")


def main() -> None:
    src, folder, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    codes = None
    if "--codes" in sys.argv:
        codes = set(sys.argv[sys.argv.index("--codes") + 1].split(","))
    stds = [s for s in json.loads(src.read_text())["standards"]
            if (not only or s["chapter"] in only) and (not codes or s["code"] in codes)]
    docs = company_corpus(folder)
    print(f"company passages: {len(docs)} · standards to assess: {len(stds)}", flush=True)
    ret = Retriever(docs)

    cache = json.loads(out.read_text()) if out.exists() else {}
    todo = [s for s in stds if s["code"] not in cache]
    print(f"cached {len(stds) - len(todo)}, to assess {len(todo)}", flush=True)
    lock = threading.Lock()
    done = [0]

    index = "\n".join(dict.fromkeys(f"{d['code']}: {d['title']}" for d in docs if d["kind"] in ("Policy", "SOP")))

    def run(std: dict) -> None:
        # Retrieve per element, not per standard: one broad query lets the
        # dominant topic crowd out the passage that answers a narrower element.
        best: dict[int, tuple[dict, float]] = {}
        for e in std["elements"]:
            for d, s in ret.top(e["text"], 5):
                if id(d) not in best or s > best[id(d)][1]:
                    best[id(d)] = (d, s)
        passages = sorted(best.values(), key=lambda x: -x[1])[:28]
        try:
            ans = judge(std, passages, index)
        except Exception as ex:
            print(f"  FAILED {ex}", flush=True)
            return
        rows = []
        for e, a in zip(std["elements"], ans):
            st = (a.get("st") or "GAP").upper().replace(" ", "_")
            if st not in ("MET", "PARTIAL", "GAP", "NOT_COVERED"):
                st = "GAP"
            valid = {d["code"] for d in docs}
            rows.append(dict(e, obligation=a.get("ob", ""), requirement=a.get("rq", ""),
                             responsible=a.get("who", ""), frequency=a.get("freq", ""), status=st,
                             satisfied_by=[c for c in a.get("by", []) if c in valid],
                             gap=a.get("gap", "") if st != "MET" else "",
                             action=a.get("fix", "") if st != "MET" else "",
                             consequence=a.get("why", ""), risk=risk_for(e["category"], st)))
        with lock:
            cache[std["code"]] = {"standard": {k: std[k] for k in ("code", "chapter", "chapter_name", "statement")},
                                  "passages": [{"code": d["code"], "kind": d["kind"], "title": d["title"],
                                                "similarity": round(s, 3)} for d, s in passages],
                                  "elements": rows}
            out.write_text(json.dumps(cache, indent=1, ensure_ascii=False))
            done[0] += 1
            tally = {}
            for r in rows:
                tally[r["status"]] = tally.get(r["status"], 0) + 1
            print(f"  {done[0]}/{len(todo)} {std['code']} {tally}", flush=True)

    with ThreadPoolExecutor(max_workers=4) as pool:          # llama-server has 4 slots
        list(pool.map(run, todo))
    print("done", flush=True)


if __name__ == "__main__":
    main()
