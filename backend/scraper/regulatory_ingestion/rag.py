"""
Retrieval over Company Brain + Regulatory knowledge.

WHERE THIS SITS
---------------
    Government -> scraper -> PostgreSQL (company_brain) (SQLite, SOURCE OF TRUTH)
                                  |
                                  +--> FastAPI -> UI          (unchanged)
                                  |
                                  +--> rag.index() -> Postgres/pgvector
                                                     (DERIVED INDEX)

Postgres holds embeddings and a copy of the chunk text, nothing else. It is
rebuildable at any time from SQLite and no business record originates there, so
the single-source-of-truth rule still holds. Dropping the RAG database costs
compute, not data.

WHY HYBRID, NOT PURE VECTOR
---------------------------
Compliance questions are full of exact tokens — 'DOR.AML.REC.111/14.01.001/2023-24',
'Section 5A', 'Rule 9(1A)'. Embeddings are notoriously weak at those: two
different circular numbers look nearly identical in vector space. So retrieval
runs a trigram/lexical match alongside the vector search and fuses the two.

CITATIONS ARE MANDATORY
-----------------------
Every chunk carries the table and primary key it came from, plus the official
URL and an in-app path. A retrieved passage that cannot be traced back to a
record in PostgreSQL (company_brain) is a bug, not a result.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from typing import Any, Iterable

MODEL_NAME = os.environ.get("RAG_MODEL", "BAAI/bge-base-en-v1.5")
DIMS = 768
DSN = os.environ.get("RAG_DSN", "postgresql:///company_brain_rag")

# bge models expect this prefix on the QUERY side only; omitting it measurably
# hurts recall, and adding it to documents hurts as well.
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

MAX_CHARS = 1800          # ~450 tokens: fits the model's 512 window with room
OVERLAP = 200             # keeps a sentence that straddles a boundary findable

_model = None


def model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME)
    return _model


# MEASURED OFF. On the 150-case golden set, weighting by impact level cost
# 1.3 points of recall@10 and 0.4 of nDCG: it promotes chunks from important
# regulations over chunks that actually answer the question. Kept behind a flag
# because it may earn its place once applicability returns real verdicts, but
# it does not today. Set RAG_IMPACT_BOOST=1 to re-enable.
IMPACT_BOOST = os.environ.get("RAG_IMPACT_BOOST", "0") not in ("0", "false", "no")
# Deliberately mild. Relevance still decides; risk only breaks ties among
# passages the text scored about equally.
IMPACT_WEIGHT = {"Critical": 1.30, "High": 1.18, "Medium": 1.08, "Low": 1.0, "None": 1.0}
DEDUPE_PARAPHRASE = os.environ.get("RAG_DEDUPE", "1") not in ("0", "false", "no")
# Obligations shorter than this get their section's opening stem prepended.
# 20,138 of 44,203 fall under 200 characters; the longer ones already carry
# their own context, and leaving them alone keeps their fingerprints stable.
SHORT_OBLIGATION = int(os.environ.get("RAG_SHORT_OBLIGATION", "200"))
# Append "Abbreviations: CIC = Core Investment Company" to chunks that use an
# abbreviation, so a query in full words can reach a clause written in initials.
EXPAND_ABBR = os.environ.get("RAG_EXPAND_ABBR", "1") not in ("0", "false", "no")
GLOBAL_ABBR_COVERAGE = float(os.environ.get("RAG_ABBR_COVERAGE", "0.25"))
MMR_LAMBDA = float(os.environ.get("RAG_MMR_LAMBDA", "0.7"))
# At 2 this measurably displaced correct chunks. Note the golden set has a
# single correct parent per query, so it under-rewards diversity by
# construction — 3 is a compromise that kept the recall gain from reranking.
MAX_PER_PARENT = int(os.environ.get("RAG_MAX_PER_PARENT", "3"))

RERANK = os.environ.get("RAG_RERANK", "1") not in ("0", "false", "no")
# bge-reranker-base is BERT-base sized: 40 pairs at 512 tokens saturates four
# vCPU for the better part of a minute per query, which is unusable. The
# MiniLM cross-encoder is six layers and roughly an order of magnitude faster
# at very close quality on this kind of text. Point RAG_RERANK_MODEL back at
# bge-reranker-base if you ever put a GPU under this.
RERANK_MODEL = os.environ.get("RAG_RERANK_MODEL",
                              "cross-encoder/ms-marco-MiniLM-L-6-v2")
# Measured on the 150-case golden set (recall@10 / ms per query):
#   pool 12 -> 0.293 / 814     pool 24 -> 0.333 / 1212
#   pool 16 -> 0.300 / 1207    pool 32 -> 0.347 / 1538
# Still climbing at 32; this is the quality/latency dial.
RERANK_POOL = int(os.environ.get("RAG_RERANK_POOL", "32"))
# 256 scored identically to 384 and ran 230 ms faster: a regulatory clause
# states its duty early, so the tail of a chunk rarely decides relevance.
RERANK_MAXLEN = int(os.environ.get("RAG_RERANK_MAXLEN", "256"))
_reranker = None


def reranker():
    """
    Cross-encoder, loaded lazily like the embedder.

    A bi-encoder squeezes a whole passage into one vector before it ever sees
    the query, so "customer due diligence" and "correspondent bank due
    diligence" sit close together. A cross-encoder reads the pair jointly and
    can separate them — which is most of the difference on regulatory text.
    """
    global _reranker
    if _reranker is None:
        from sentence_transformers import CrossEncoder
        try:                       # keep BLAS from oversubscribing the cores
            import torch
            torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        except Exception:
            pass
        _reranker = CrossEncoder(RERANK_MODEL, max_length=RERANK_MAXLEN)
    return _reranker


def _impact_levels(pcon, chunk_ids) -> dict:
    """
    impact_scores lives in company_brain, the chunks in company_brain_rag, so
    this cannot be one join. Read the levels once per query from the app DB and
    map them onto chunks by regulation_id.
    """
    if not chunk_ids:
        return {}
    rows = pcon.execute(
        "SELECT id, regulation_id FROM chunks WHERE id = ANY(%s) AND regulation_id IS NOT NULL",
        (list(chunk_ids),)).fetchall()
    if not rows:
        return {}
    return {cid: lv for cid, rid in rows
            if (lv := _levels_cached().get(rid)) is not None}


_LEVELS: dict | None = None
_LEVELS_AT = 0.0
_LEVELS_TTL = 300          # impact scores change on a rebuild, not per query


_OBLIG: dict | None = None
_OBLIG_AT = 0.0


def _obligation_of_cached() -> dict:
    """
    (source_table, row id) -> the obligation a derived chunk restates.

    requirements, thresholds and timing_rules are all derived FROM obligations,
    so a hit on one is a hit on the same duty. Roughly 21k pairs, re-read on the
    same schedule as the impact levels.
    """
    global _OBLIG, _OBLIG_AT
    import time as _t
    if _OBLIG is None or _t.time() - _OBLIG_AT > _LEVELS_TTL:
        m = {}
        try:
            from .db import connect as _app
            acon = _app()
            for table in ("requirements", "thresholds", "timing_rules"):
                for rid, oid in acon.execute(
                        f"SELECT id, obligation_id FROM {table} "
                        f"WHERE obligation_id IS NOT NULL").fetchall():
                    m[(table, str(rid))] = oid
        except Exception:
            pass
        _OBLIG, _OBLIG_AT = m, _t.time()
    return _OBLIG


def _obligation_key(row: dict) -> str | None:
    """The obligation a row is about, whether it is the clause or a restatement."""
    sid = str(row.get("source_id", ""))
    table = row.get("source_table")
    if table == "obligations":
        return sid.split("#", 1)[0]
    if table in ("requirements", "thresholds", "timing_rules"):
        return _obligation_of_cached().get((table, sid.split("#", 1)[0]))
    return None


_NORM = re.compile(r"[^a-z0-9]+")


def _text_key(row: dict) -> str:
    """
    Fingerprint a passage by its letters alone.

    RBI reissues the same provision across a Master Direction per entity type,
    so one clause can occupy four slots of a top-10. Extraction also varies the
    spacing ("trust" vs "t rust"), which is why every non-alphanumeric character
    is stripped before comparison — the same normalisation versions.py uses to
    tell a real amendment from a re-typeset one.
    """
    body = (row.get("content") or "")
    body = body.split("\n", 1)[-1]          # drop the heading we prepended
    return _NORM.sub("", body.lower())[:400]


def _collapse_paraphrases(rows: list[dict]) -> list[dict]:
    """
    One duty, one slot.

    Indexing the derived tables put a plain-language restatement of every
    obligation next to the obligation itself, so a top-10 could spend three
    slots saying the same thing. Keep the best-ranked member of each obligation
    and note how many others said it — measured to cost `definition` recall
    otherwise, because the duplicates crowd everything else out.
    """
    kept, seen, by_text = [], {}, {}
    for r in rows:
        # identical text under different ids: same clause, several directions
        tk = _text_key(r)
        if len(tk) > 80:
            twin = by_text.get(tk)
            if twin is not None:
                twin.setdefault("also_in", [])
                rid = r.get("regulation_id")
                if rid and rid not in twin["also_in"] and rid != twin.get("regulation_id"):
                    twin["also_in"].append(rid)
                continue
            by_text[tk] = r

        key = _obligation_key(r)
        if key is None:
            kept.append(r)
            continue
        first = seen.get(key)
        if first is None:
            seen[key] = r
            r["restatements"] = 0
            kept.append(r)
        else:
            first["restatements"] = first.get("restatements", 0) + 1
            # keep the citable clause visible even when a paraphrase outranked it
            if first.get("source_table") != "obligations" and r.get("source_table") == "obligations":
                first["clause_source_id"] = r.get("source_id")
    return kept


def _levels_cached() -> dict:
    """
    410 rows, re-read every five minutes rather than on every search. Opening a
    second connection to company_brain per query was measurably worse than the
    boost was worth.
    """
    global _LEVELS, _LEVELS_AT
    import time as _t
    if _LEVELS is None or _t.time() - _LEVELS_AT > _LEVELS_TTL:
        try:
            from .db import connect as _app
            _LEVELS = {r[0]: r[1] for r in _app().execute(
                "SELECT regulation_id, level FROM impact_scores").fetchall()}
        except Exception:
            _LEVELS = {}
        _LEVELS_AT = _t.time()
    return _LEVELS


def connect_pg():
    import psycopg
    from pgvector.psycopg import register_vector
    con = psycopg.connect(DSN)
    register_vector(con)
    return con


def _h(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def split(text: str, max_chars: int = MAX_CHARS, overlap: int = OVERLAP) -> list[str]:
    """
    Sentence-aware split. A regulatory clause cut mid-sentence retrieves badly
    and reads worse when shown as a citation, so break on sentence ends and
    only fall back to a hard cut when a single sentence exceeds the window.
    """
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    sentences = re.split(r"(?<=[.;:])\s+", text)
    out, cur = [], ""
    for s in sentences:
        while len(s) > max_chars:                 # pathological single sentence
            out.append(s[:max_chars])
            s = s[max_chars - overlap:]
        if len(cur) + len(s) + 1 <= max_chars:
            cur = f"{cur} {s}".strip()
        else:
            if cur:
                out.append(cur)
            cur = (out[-1][-overlap:] + " " + s).strip() if out else s
    if cur:
        out.append(cur)
    return out


# ------------------------------------------------------------------ sources
def _source():
    """
    Connection to the source of truth (PostgreSQL).

    The reader-blocks-writer problem that motivated a read-only SQLite handle no
    longer exists: Postgres readers never block writers, so a long index run
    cannot stall the pipeline, the watcher or the API.
    """
    from .db import connect
    return connect()


# kept as an alias so existing call sites need no change
_sqlite = _source


_ENUM = re.compile(r"\s\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})\)\s")


_ABBR_PAT = re.compile(
    r"((?:[A-Z][A-Za-z-]+ ?(?:(?:of|and|the|for|in|on|to|a|an) )?){1,8})"
    r"\(\s*([A-Z]{2,6}(?:\s*-\s*[A-Z]{2,6})?)\s*\)")
_ABBR_STOP = {"of", "and", "the", "for", "in", "on", "to", "a", "an"}
_LEX_CACHE: tuple | None = None


def _spell(exp: str, abbr: str) -> str | None:
    """
    The shortest trailing span of `exp` whose word-initials spell `abbr`,
    returned with its original words (stopwords kept, so "Securities and
    Exchange Board of India", not "Securities Exchange Board India").
    Rejects the false pairings a bare regex produces — MFI is not "Uniform
    Credit Reporting Format".
    """
    toks = re.findall(r"[A-Za-z][A-Za-z-]*", exp)
    for i in range(len(toks)):
        if toks[i].lower() in _ABBR_STOP:      # a span never starts on "of"
            continue
        letters = "".join(t[0].upper() for t in toks[i:] if t.lower() not in _ABBR_STOP)
        if letters == abbr:
            return " ".join(toks[i:])
    return None


def _abbreviation_lexicon(con) -> tuple[dict, dict]:
    """
    Built from the corpus, never typed in: every "Full Words (ABBR)" the
    regulations themselves contain, initials-checked.

    Returns (per_regulation, global_unambiguous). The split matters: CIC is
    "Credit Information Company" in one direction and "Core Investment Company"
    in another, so an abbreviation is only used across regulations when every
    regulation that defines it agrees. Hyphenated compounds are paired part by
    part — "NBFC-Core Investment Company (NBFC -CIC)" is how the CIC directions
    actually define it, and a plain pattern misses it.
    """
    global _LEX_CACHE
    if _LEX_CACHE is not None:
        return _LEX_CACHE
    per: dict[str, dict[str, str]] = {}
    for rid, txt in con.execute(
            "SELECT regulation_id, section_text FROM sections WHERE section_text IS NOT NULL"):
        t = re.sub(r"\s+", " ", txt or "")
        for exp, abbr in _ABBR_PAT.findall(t):
            abbr = re.sub(r"\s*-\s*", "-", abbr)
            exp = exp.strip(" -")
            slot = per.setdefault(rid, {})
            if "-" in abbr:
                a_parts, e_parts = abbr.split("-"), exp.split("-")
                if len(a_parts) == len(e_parts):
                    for a, e in zip(a_parts, e_parts):
                        e = e.strip()
                        if a == e:
                            continue
                        sp = _spell(e, a)
                        if sp:
                            slot.setdefault(a, sp)
                sp = _spell(exp.replace("-", " "), abbr.replace("-", ""))
                if sp:
                    slot.setdefault(abbr, sp)
                continue
            sp = _spell(exp, abbr)
            if sp:
                slot.setdefault(abbr, sp)

    def _norm(e: str) -> str:
        # Surface variants of one expansion must compare equal, or a real
        # abbreviation looks ambiguous and is lost from the global set:
        # "Securities and Exchange Board of India" vs "Securities & Exchange
        # Board of India". Strip stopwords and plurals before comparing.
        words = [w for w in re.findall(r"[a-z]+", e.lower()) if w not in _ABBR_STOP]
        words = [re.sub(r"ies$", "y", w) for w in words]
        return " ".join(re.sub(r"s$", "", w) for w in words)

    forms: dict[str, set] = {}
    for d in per.values():
        for a, e in d.items():
            forms.setdefault(a, set()).add(_norm(e))
    # Which regulations actually USE each abbreviation in their obligations.
    users: dict[str, set] = {}
    for rid, desc in con.execute(
            "SELECT regulation_id, description FROM obligations WHERE description IS NOT NULL"):
        for a in set(_TOKEN_PAT.findall(desc or "")):
            users.setdefault(a, set()).add(rid)

    glob: dict[str, str] = {}
    for a, variants in forms.items():
        spellings = [d[a] for d in per.values() if a in d]
        definers = len(spellings)
        coverage = definers / max(len(users.get(a, ())), 1)
        # One expansion is not the same as one meaning. LTV is spelled out only
        # in two visa-related texts as "Long-Term Visa" — every lending
        # direction that uses it assumes loan-to-value and never expands it.
        # So a term earns a corpus-wide meaning only when the regulations that
        # DEFINE it are a real share of the regulations that USE it:
        #   SEBI 47 of 70 -> global    LTV 2 of 23 -> stays per-regulation
        #   NBFC 1 of 82 -> the corpus simply lacks the evidence; left alone
        if len(variants) == 1 and definers >= 2 and coverage >= GLOBAL_ABBR_COVERAGE:
            glob[a] = max(set(spellings), key=spellings.count)
    _LEX_CACHE = (per, glob)
    return _LEX_CACHE


_TOKEN_PAT = re.compile(r"\b[A-Z]{2,6}(?:-[A-Z]{2,6})?\b")


def _abbr_line(text: str, rid: str | None, lex: tuple[dict, dict], cap: int = 8) -> str:
    """
    The appendix for one chunk; regulation-specific meanings win over global.

    Pull the chunk's own uppercase tokens once and look them up — not one regex
    per lexicon entry per chunk, which was ~40M searches across the corpus and
    made indexing crawl.
    """
    per, glob = lex
    local = per.get(rid or "", {})
    present = set(_TOKEN_PAT.findall(text))
    found = sorted(a for a in present if a in local or a in glob)
    if not found:
        return ""
    return " ‖ Abbreviations: " + "; ".join(
        f"{a} = {local.get(a) or glob[a]}" for a in found[:cap])


def _section_stem(text: str, cap: int = 320) -> str:
    """
    The sentence a list of sub-clauses hangs from.

    The obligation extractor splits "…shall comply with the following while
    lending against listed shares: (1) maintain an LTV of 50 per cent (2) …"
    into one obligation per item, and item (1) comes out as "LTV ratio of 50
    per cent is required to be maintained at all times" — findable by nothing a
    person would type. The stem is the text before the first enumerator, or the
    first sentence when there is no list.
    """
    t = re.sub(r"\s+", " ", text or "").strip()
    if not t:
        return ""
    m = _ENUM.search(t, 1)
    stem = t[:m.start()] if m else t
    if len(stem) > cap:
        first = re.split(r"(?<=[.;:])\s", stem, 1)[0]
        stem = first if len(first) <= cap else stem[:cap]
    return stem.strip(" :;,—-")


def regulatory_chunks(con, match: str = "") -> Iterable[dict]:
    """
    Sections, obligations and amendment footnotes — each citable to its row.

    `match` is an optional SQL LIKE pattern on regulation_id. Filtering here
    rather than in the caller is the difference between reading 28 regulations
    and reading the whole corpus: an export scoped after generation still split
    and chunked every section before discarding it.
    """
    _w = " WHERE regulation_id LIKE ?" if match else ""
    _p = (match,) if match else ()
    regs = {r["id"]: r for r in con.execute(
        "SELECT id, title, regulator_short, source_url FROM regulations"
        + (" WHERE id LIKE ?" if match else ""), _p)}

    for s in con.execute(
            """SELECT id, regulation_id, section_number, section_title, section_text
                 FROM sections
                WHERE section_text IS NOT NULL AND length(section_text) > 80"""
            + (" AND regulation_id LIKE ?" if match else ""), _p):
        r = regs.get(s["regulation_id"])
        if not r:
            continue
        head = f"{r['title']} — Section {s['section_number']}: {s['section_title'] or ''}".strip()
        for i, piece in enumerate(split(s["section_text"])):
            yield {
                "corpus": "regulatory", "source_table": "sections",
                "source_id": f"{s['id']}#{i}", "regulation_id": s["regulation_id"],
                "domain": r["regulator_short"],
                "title": head, "section_number": s["section_number"],
                # the heading travels with the body: a bare clause retrieves poorly
                # because it never repeats which regulation it belongs to.
                "content": f"{head}\n{piece}",
                "url": r["source_url"], "app_path": f"/regulation/{s['regulation_id']}",
            }

    for o in con.execute(
            """SELECT o.id, o.regulation_id, o.title, o.description, o.obligation_type,
                      o.mandatory_action, o.responsible_entity, o.frequency,
                      s.section_text, s.section_title
                 FROM obligations o
                 LEFT JOIN sections s ON s.id = o.section_id"""
            + (" WHERE o.regulation_id LIKE ?" if match else ""), _p):
        r = regs.get(o["regulation_id"])
        core = " ".join(filter(None, [o["description"], o["mandatory_action"]]))
        body = " ".join(filter(None, [
            core,
            f"Responsible: {o['responsible_entity']}" if o["responsible_entity"] else None,
            f"Frequency: {o['frequency']}" if o["frequency"] else None]))
        if len(body.strip()) < 40:
            continue
        # A short sub-clause is meaningless without the sentence it hangs from.
        if len(core) < SHORT_OBLIGATION:
            stem = _section_stem(o["section_text"]) or (o["section_title"] or "")
            if stem and stem.lower()[:60] not in core.lower():
                body = f"{stem} — {body}"
        if EXPAND_ABBR:
            body += _abbr_line(core, o["regulation_id"], _abbreviation_lexicon(con))
        head = f"Obligation — {o['title']}" + (f" ({r['title']})" if r else "")
        for i, piece in enumerate(split(body)):
            yield {
                "corpus": "regulatory", "source_table": "obligations",
                "source_id": f"{o['id']}#{i}", "regulation_id": o["regulation_id"],
                "domain": r["regulator_short"] if r else None,
                "title": head, "section_number": None,
                "content": f"{head}\n{piece}",
                "url": r["source_url"] if r else None,
                "app_path": f"/regulation/{o['regulation_id']}",
            }

    for a in con.execute(
            """SELECT id, regulation_id, reference, amended_on, raw, context, url
               FROM regulation_amendments"""
            + (" WHERE regulation_id LIKE ?" if match else ""), _p):
        r = regs.get(a["regulation_id"])
        body = " ".join(filter(None, [a["raw"], a["context"]]))
        if len(body.strip()) < 30:
            continue
        head = f"Amendment {a['reference']} dated {a['amended_on']}" + (f" — {r['title']}" if r else "")
        yield {
            "corpus": "regulatory", "source_table": "regulation_amendments",
            "source_id": str(a["id"]), "regulation_id": a["regulation_id"],
            "domain": r["regulator_short"] if r else None,
            "title": head, "section_number": None,
            "content": f"{head}\n{body}",
            "url": a["url"] or (r["source_url"] if r else None),
            "app_path": f"/regulation/{a['regulation_id']}",
        }


def company_chunks(con) -> Iterable[dict]:
    """Company Brain entities — the other half of any 'does this apply to us' question."""
    for e in con.execute(
            """SELECT id, domain, name, type, description, criticality, status, attrs,
                      source, source_reference
               FROM company_entities"""):
        attrs = {}
        try:
            attrs = json.loads(e["attrs"] or "{}")
        except Exception:
            pass
        body = " ".join(filter(None, [
            e["description"],
            *(f"{k}: {v}" for k, v in attrs.items() if isinstance(v, (str, int, float))),
            f"Criticality: {e['criticality']}" if e["criticality"] else None,
        ]))
        head = f"{e['name']} ({e['type'] or e['domain']})"
        content = f"{head}\n{body}".strip()
        if len(content) < 25:
            continue
        for i, piece in enumerate(split(content)):
            yield {
                "corpus": "company", "source_table": "company_entities",
                "source_id": f"{e['id']}#{i}", "entity_id": e["id"],
                "domain": e["domain"], "title": head, "section_number": None,
                "content": piece, "url": None, "app_path": f"/entity/{e['id']}",
            }


def derived_chunks(con) -> Iterable[dict]:
    """
    The tables the pipeline derives and then never made searchable.

    These are the highest-signal rows in the database for the questions people
    actually ask — a definition, a limit, a due date — and every one of them is
    already tied back to its clause, so a hit here cites like any other.
    """
    regs = {r["id"]: r for r in con.execute(
        "SELECT id, title, regulator_short, source_url FROM regulations")}

    def _reg(rid):
        return regs.get(rid) or {"title": rid or "", "regulator_short": None,
                                 "source_url": None}

    # "as defined in" is the single most common phrase in regulatory text, and
    # definitions were entirely unretrievable.
    for d in con.execute(
            """SELECT id, regulation_id, term, definition_text, source_section_id
                 FROM definitions
                WHERE term IS NOT NULL AND definition_text IS NOT NULL"""):
        r = _reg(d["regulation_id"])
        head = f"Definition — \"{d['term']}\" ({r['title']})"
        for i, piece in enumerate(split(f"{head}\n{d['definition_text']}")):
            yield {"corpus": "regulatory", "source_table": "definitions",
                   "source_id": f"{d['id']}#{i}", "regulation_id": d["regulation_id"],
                   "domain": r["regulator_short"], "title": head,
                   "section_number": None, "content": piece,
                   "url": r["source_url"],
                   "app_path": f"/regulation/{d['regulation_id']}"}

    # every "what happens if we fail" question — penalty ceilings, verbatim
    try:
        pens = list(con.execute(
            """SELECT id, regulation_id, section_number, kind, amount_min, amount_max,
                      per_day_amount, multiplier, multiplier_basis, imprisonment_months, basis_text
                 FROM penalty_provisions"""))
    except Exception:
        pens = []          # table appears with the first penalties.init()
    for t in pens:
        r = _reg(t["regulation_id"])
        bits = []
        if t["amount_max"]:
            bits.append(f"up to ₹{t['amount_max']:,.0f}" + (f" (min ₹{t['amount_min']:,.0f})" if t["amount_min"] and t["amount_min"] != t["amount_max"] else ""))
        if t["per_day_amount"]:
            bits.append(f"₹{t['per_day_amount']:,.0f} per day of continuing contravention")
        if t["multiplier"]:
            bits.append(f"{t['multiplier']:g}× {t['multiplier_basis'] or 'the sum involved'}")
        if t["imprisonment_months"]:
            bits.append(f"imprisonment up to {t['imprisonment_months']} months")
        head = f"Penalty — {r['title']}" + (f" §{t['section_number']}" if t["section_number"] else "")
        body = (("; ".join(bits) + ". ") if bits else "") + (t["basis_text"] or "")
        for i, piece in enumerate(split(f"{head}\n{body}")):
            yield {"corpus": "regulatory", "source_table": "penalty_provisions",
                   "source_id": f"{t['id']}#{i}", "regulation_id": t["regulation_id"],
                   "domain": r["regulator_short"], "title": head,
                   "section_number": t["section_number"], "content": piece,
                   "url": r["source_url"],
                   "app_path": f"/regulation/{t['regulation_id']}"}

    # every "what is the limit" question
    for t in con.execute(
            """SELECT id, obligation_id, metric, operator, value, unit, currency,
                      condition, source_text FROM thresholds"""):
        body = " ".join(str(x) for x in [
            t["operator"], t["value"], t["currency"] or t["unit"],
            t["condition"], t["source_text"]] if x)
        if len(body.strip()) < 12:
            continue
        head = f"Threshold — {t['metric']}"
        for i, piece in enumerate(split(f"{head}\n{body}")):
            yield {"corpus": "regulatory", "source_table": "thresholds",
                   "source_id": f"{t['id']}#{i}", "regulation_id": None,
                   "domain": None, "title": head, "section_number": None,
                   "content": piece, "url": None, "app_path": None}

    # every "when is this due" question
    for t in con.execute(
            """SELECT id, obligation_id, rule_type, expression, value, unit,
                      trigger_event, source_text FROM timing_rules"""):
        body = " ".join(str(x) for x in [
            t["expression"], t["value"], t["unit"],
            t["trigger_event"], t["source_text"]] if x)
        if len(body.strip()) < 12:
            continue
        head = f"Timing — {t['rule_type'] or 'rule'}"
        for i, piece in enumerate(split(f"{head}\n{body}")):
            yield {"corpus": "regulatory", "source_table": "timing_rules",
                   "source_id": f"{t['id']}#{i}", "regulation_id": None,
                   "domain": None, "title": head, "section_number": None,
                   "content": piece, "url": None, "app_path": None}

    # the derived plain-language statement of a duty — closer to how a person
    # phrases a question than the clause it came from
    for q in con.execute(
            """SELECT id, obligation_id, regulation_id, statement, expected_action,
                      condition, frequency, deadline, responsible_role
                 FROM requirements WHERE statement IS NOT NULL"""):
        r = _reg(q["regulation_id"])
        body = " ".join(str(x) for x in [
            q["statement"], q["expected_action"], q["condition"],
            f"Frequency: {q['frequency']}" if q["frequency"] else None,
            f"Deadline: {q['deadline']}" if q["deadline"] else None,
            f"Role: {q['responsible_role']}" if q["responsible_role"] else None] if x)
        if len(body.strip()) < 40:
            continue
        if EXPAND_ABBR:
            body += _abbr_line(q["statement"] or "", q["regulation_id"], _abbreviation_lexicon(con))
        head = f"Requirement — {r['title']}"
        for i, piece in enumerate(split(f"{head}\n{body}")):
            yield {"corpus": "regulatory", "source_table": "requirements",
                   "source_id": f"{q['id']}#{i}", "regulation_id": q["regulation_id"],
                   "domain": r["regulator_short"], "title": head,
                   "section_number": None, "content": piece,
                   "url": r["source_url"],
                   "app_path": f"/regulation/{q['regulation_id']}"}

    # "read with regulation X" — the graph that makes an answer complete
    for c in con.execute(
            """SELECT id, source_regulation_id, source_reference, relation,
                      target_regulation_id, target_reference, source_text
                 FROM cross_references"""):
        body = " ".join(str(x) for x in [
            c["source_reference"], c["relation"], c["target_reference"],
            c["source_text"]] if x)
        if len(body.strip()) < 15:
            continue
        r = _reg(c["source_regulation_id"])
        head = f"Cross-reference — {r['title']}"
        for i, piece in enumerate(split(f"{head}\n{body}")):
            yield {"corpus": "regulatory", "source_table": "cross_references",
                   "source_id": f"{c['id']}#{i}",
                   "regulation_id": c["source_regulation_id"],
                   "domain": r["regulator_short"], "title": head,
                   "section_number": None, "content": piece,
                   "url": r["source_url"],
                   "app_path": f"/regulation/{c['source_regulation_id']}"}

    # rates and slabs live in tables, and tables were invisible to search
    # There is no flat text column: a table is stored as JSON columns and rows,
    # so it has to be flattened into something a sentence embedder can read.
    for t in con.execute(
            """SELECT id, regulation_id, caption, columns_json, rows_json, table_kind
                 FROM regulation_tables WHERE rows_json IS NOT NULL"""):
        try:
            cols = json.loads(t["columns_json"] or "[]")
            body_rows = json.loads(t["rows_json"] or "[]")
        except Exception:
            continue
        # Most of these 600 "tables" are the PDF's own contents page: a heading
        # and a page number, harvested by the table extractor. Indexing them
        # buries real rate and slab tables under navigation furniture, so they
        # are dropped rather than embedded.
        pairs = [r for r in body_rows if isinstance(r, list) and len(r) == 2]
        if body_rows and len(pairs) / len(body_rows) >= 0.6:
            def _page_ref(cell):
                c = re.sub(r"[.\s]", "", str(cell))
                return c.isdigit() and len(c) <= 4
            if sum(1 for r in pairs if _page_ref(r[1])) / max(len(pairs), 1) >= 0.6:
                continue

        lines = []
        if any(str(c).strip() and not str(c).isdigit() for c in cols):
            lines.append(" | ".join(str(c) for c in cols))
        for row in body_rows[:60]:              # a long slab retrieves as noise
            cells = [str(c).strip() for c in (row or []) if str(c).strip()]
            # PDF contents pages come through as dotted leaders; they are not data
            cells = [re.sub(r"\.{4,}", " ", c) for c in cells]
            if cells:
                lines.append(" | ".join(cells))
        table_text = "\n".join(lines).strip()
        if len(table_text) < 30:
            continue
        r = _reg(t["regulation_id"])
        head = f"Table — {t['caption'] or t['table_kind'] or 'data'} ({r['title']})".strip()
        for i, piece in enumerate(split(f"{head}\n{table_text}")):
            yield {"corpus": "regulatory", "source_table": "regulation_tables",
                   "source_id": f"{t['id']}#{i}", "regulation_id": t["regulation_id"],
                   "domain": r["regulator_short"], "title": head,
                   "section_number": None, "content": piece,
                   "url": r["source_url"],
                   "app_path": f"/regulation/{t['regulation_id']}"}


# ------------------------------------------------------------------ indexing
def prune(pcon=None, vacuum: bool = True) -> dict:
    """
    Finish a re-index: drop superseded rows and reclaim them.

    Content-hash keying means a chunk whose text changed is INSERTED under a new
    hash while the old row stays — so every re-index leaves one stale row per
    changed chunk. Keep the newest per (source_table, source_id).

    Then VACUUM. pgvector's HNSW keeps deleted tuples in the graph until vacuum
    runs, and they still consume ef_search candidates: an eval run seconds
    after a 20,854-row delete scored recall@10 at 0.533 on cases that measured
    0.700 once autovacuum had caught up. Measuring before vacuuming measures the
    garbage, not the index.
    """
    import psycopg
    pcon = pcon or connect_pg()
    deleted = pcon.execute("""
        DELETE FROM chunks c USING (
          SELECT id, row_number() OVER (PARTITION BY source_table, source_id
                                        ORDER BY indexed_at DESC, id DESC) AS rn
            FROM chunks) d
         WHERE c.id = d.id AND d.rn > 1""").rowcount
    pcon.commit()
    if vacuum:
        # VACUUM cannot run inside a transaction block
        with psycopg.connect(DSN, autocommit=True) as v:
            v.execute("VACUUM ANALYZE chunks")
    live, dead = pcon.execute(
        "SELECT n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE relname='chunks'"
    ).fetchone()
    return {"deleted_superseded": deleted, "live": live, "dead_after": dead}


def index(corpora: tuple[str, ...] = ("regulatory", "company", "derived"),
          batch: int = 64, limit: int = 0, progress=print) -> dict:
    """
    Embed and upsert. Content-hash keyed, so a re-run only embeds what changed.
    """
    scon, pcon = _sqlite(), connect_pg()
    m = model()
    totals = {}

    for corpus in corpora:
        gen = {"regulatory": regulatory_chunks,
               "company": company_chunks,
               "derived": derived_chunks}[corpus](scon)
        run = pcon.execute(
            "INSERT INTO index_runs (corpus, model, dims) VALUES (%s,%s,%s) RETURNING id",
            (corpus, MODEL_NAME, DIMS)).fetchone()[0]
        pcon.commit()

        seen = written = skipped = 0
        buf: list[dict] = []

        def flush(buf):
            nonlocal written, skipped
            if not buf:
                return
            # skip anything whose exact text is already embedded
            keys = [(c["source_table"], c["source_id"], _h(c["content"])) for c in buf]
            # psycopg3 has no tuple-IN; unnest two arrays instead of building SQL by hand
            have = {(r[0], r[1], r[2]) for r in pcon.execute(
                """SELECT source_table, source_id, content_hash FROM chunks
                   WHERE (source_table, source_id) IN (
                     SELECT * FROM unnest(%s::text[], %s::text[]))""",
                ([k[0] for k in keys], [k[1] for k in keys])).fetchall()}
            todo = [c for c, k in zip(buf, keys) if k not in have]
            skipped += len(buf) - len(todo)
            if not todo:
                return
            vecs = m.encode([c["content"] for c in todo],
                            normalize_embeddings=True, show_progress_bar=False)
            with pcon.cursor() as cur:
                for c, v in zip(todo, vecs):
                    cur.execute(
                        """INSERT INTO chunks
                           (corpus, source_table, source_id, regulation_id, entity_id, domain,
                            title, section_number, content, token_estimate, url, app_path,
                            content_hash, embedding)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (source_table, source_id, content_hash) DO NOTHING""",
                        (c["corpus"], c["source_table"], c["source_id"], c.get("regulation_id"),
                         c.get("entity_id"), c.get("domain"), c.get("title"),
                         c.get("section_number"), c["content"], len(c["content"]) // 4,
                         c.get("url"), c.get("app_path"), _h(c["content"]), v))
            pcon.commit()
            written += len(todo)

        for c in gen:
            seen += 1
            buf.append(c)
            if len(buf) >= batch:
                flush(buf); buf = []
                progress(f"    {corpus}: {seen} seen, {written} embedded, {skipped} unchanged")
            if limit and seen >= limit:
                break
        flush(buf)

        pcon.execute(
            """UPDATE index_runs SET finished_at=now(), chunks_seen=%s, chunks_written=%s,
               chunks_skipped=%s WHERE id=%s""", (seen, written, skipped, run))
        pcon.commit()
        totals[corpus] = {"seen": seen, "written": written, "skipped": skipped}
        progress(f"  {corpus}: {seen} seen, {written} embedded, {skipped} unchanged")

    totals["prune"] = prune(pcon)
    return totals


# ------------------------------------------------------------------ retrieval
# Measured 2026-09-06 (tag qexp-on): +0.2 nDCG, +0.6 MRR — but −1.3 recall
# and 2× latency. Off by default, like the impact boost before it; flip the
# env to re-test after the corpus or the abbreviation lexicon changes.
_QEXP = os.environ.get("RAG_QUERY_EXPAND", "0") not in ("0", "false", "no")
_ABBR_MAP: dict | None = None


def _abbr_map() -> dict:
    global _ABBR_MAP
    if _ABBR_MAP is None:
        try:
            import json as _json
            from pathlib import Path as _P
            d = _json.loads((_P(__file__).parent.parent / "output" / "abbreviations.json").read_text())
            fwd = {k.upper(): v for k, v in d.get("global", {}).items()}
            # per-regulation entries join the query map only when EVERY
            # regulation that defines the abbreviation agrees on its expansion
            # — CIC (unanimous) gets in, LTV (visa vs loan-to-value) stays out
            per: dict[str, set] = {}
            for entries in d.get("per_regulation", {}).values():
                for k, v in entries.items():
                    per.setdefault(k.upper(), set()).add(v.strip().lower())
            for k, forms in per.items():
                if k not in fwd and len(forms) == 1:
                    fwd[k] = next(iter(forms)).title()
            rev = {v.lower(): k for k, v in fwd.items()}
            _ABBR_MAP = {"fwd": fwd, "rev": rev}
        except Exception:
            _ABBR_MAP = {"fwd": {}, "rev": {}}
    return _ABBR_MAP


# Compounds whose HEAD word is common in this corpus, mapped to the word that
# actually distinguishes them.
#
# Measured failures, both from the same shape: "what records must a BLOOD BANK
# keep" returned "the bank shall also maintain such registers" — a financial
# bank, out of 845 banking Acts; "hospital INFECTION PREVENTION AND CONTROL
# committee duties" returned the Prevention of Cruelty to Animals Act. The
# embedding sees bank/records/maintain and prevention/control and is satisfied.
#
# The qualifier is the distinguishing WORD, not the phrase: a document about
# blood banks may say "blood centre", and "blood" separates both from finance.
AMBIGUOUS_COMPOUNDS = {
    "blood bank": "blood", "blood banks": "blood",
    "blood centre": "blood", "blood center": "blood", "blood storage": "blood",
    "infection control": "infection", "infection prevention": "infection",
    "prevention and control of infection": "infection",
    "clinical establishment": "clinical", "genetic clinic": "genetic",
    "medical device": "device", "drug licence": "drug", "drug license": "drug",
    "biomedical waste": "waste", "bio-medical waste": "waste",
    "fire safety": "fire", "radiation safety": "radiation",
}


def _required_terms(query: str) -> list[str]:
    """Words a candidate must contain, because the query names such a compound."""
    ql = (query or "").lower()
    return sorted({q for phrase, q in AMBIGUOUS_COMPOUNDS.items() if phrase in ql})


def _demote_decoys(out: list[dict], query: str) -> list[dict]:
    """
    Push candidates that match only the ambiguous head below those that carry
    the qualifier.

    DEMOTE, never drop. A decoy ranked below the real answers costs nothing,
    whereas dropping it could empty a result set on a corpus that genuinely has
    no better match — and returning nothing is a worse answer than returning
    something imperfect with its evidence attached. Python's sort is stable, so
    the reranker's ordering survives inside each group.
    """
    req = _required_terms(query)
    if not req or len(out) < 2:
        return out

    def carries(r: dict) -> bool:
        hay = f"{r.get('title') or ''} {r.get('content') or ''}".lower()
        return any(t in hay for t in req)

    return sorted(out, key=lambda r: 0 if carries(r) else 1)


def _expand_query(query: str, cap: int = 3) -> str:
    """
    Mirror the index-time abbreviation expansion at query time, for the
    LEXICAL arm only: "CIC exposure" also matches "Core Investment Company";
    "core investment company" also matches "CIC". The embedding arm keeps the
    user's own words. Measured before adoption, like everything here.
    """
    if not _QEXP:
        return query
    m = _abbr_map()
    extra: list[str] = []
    for tok in re.findall(r"\b[A-Z][A-Z0-9]{1,7}\b", query):
        full = m["fwd"].get(tok.upper())
        if full and full.lower() not in query.lower():
            extra.append(full)
    ql = query.lower()
    for full, abbr in m["rev"].items():
        if len(extra) >= cap:
            break
        if full in ql and abbr.lower() not in ql:
            extra.append(abbr)
    return query + (" " + " ".join(dict.fromkeys(extra[:cap])) if extra else "")


def search(query: str, k: int = 8, corpus: str | None = None,
           regulation_id: str | None = None) -> list[dict]:
    """
    Hybrid retrieval: cosine similarity fused with a trigram/lexical score.

    Fusion is Reciprocal Rank Fusion — it needs no score normalisation between
    two scales that are not comparable, and it is robust when one arm returns
    nothing useful (a plain-English question, or an exact circular number).
    """
    if not (query or "").strip():
        return []
    pcon = connect_pg()
    lex_query = _expand_query(query)
    qv = model().encode([QUERY_PREFIX + query], normalize_embeddings=True)[0]

    where, params = [], []
    if corpus:
        where.append("corpus = %s"); params.append(corpus)
    if regulation_id:
        where.append("regulation_id = %s"); params.append(regulation_id)
    w = ("WHERE " + " AND ".join(where)) if where else ""

    pool = max(k * 5, RERANK_POOL if RERANK else 40)
    # HNSW explores ef_search candidates per query. The default is 40 — exactly
    # the size of our pool, so the index was discarding good neighbours before
    # fusion ever saw them. 200 costs a few ms at 90k vectors.
    pcon.execute(f"SET LOCAL hnsw.ef_search = {max(pool * 4, 200)}")
    vec = pcon.execute(
        f"""SELECT id, 1 - (embedding <=> %s::vector) AS score
            FROM chunks {w} ORDER BY embedding <=> %s::vector LIMIT {pool}""",
        (qv, *params, qv) if params else (qv, qv)).fetchall()
    # websearch_to_tsquery tolerates natural phrasing and quoted exact terms,
    # and unlike trigram similarity it actually fires on short queries.
    lex_sql = f"""SELECT id, ts_rank(tsv, websearch_to_tsquery('english', %s)) AS score
                  FROM chunks {w + (' AND ' if w else 'WHERE ')}
                       tsv @@ websearch_to_tsquery('english', %s)
                  ORDER BY score DESC LIMIT {pool}"""
    try:
        lex = pcon.execute(lex_sql, (lex_query, *params, lex_query)).fetchall()
    except Exception:
        pcon.rollback()
        lex = []

    # Third arm: identifier substring match.
    #
    # Postgres tokenises 'DOR.AML.REC.111/14.01.001/2023-24' as two tokens
    # ('dor.aml.rec' + '111/14.01.001/2023-24'), while the query
    # 'DOR.AML.REC.111' becomes the phrase 'dor.aml.rec' <-> '111'. Those never
    # match, so a PARTIAL circular reference — which is exactly how a person
    # types one — is invisible to full-text search. A substring match on
    # identifier-shaped tokens closes that hole; the trigram index serves it.
    ids = [t for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9./\-]{5,}", query)
           if any(ch.isdigit() for ch in t) and any(ch in "./-" for ch in t)]
    sub = []
    if ids:
        pat = "%" + max(ids, key=len).lower() + "%"
        try:
            sub = pcon.execute(
                f"""SELECT id, 1.0 AS score FROM chunks
                    {w + (' AND ' if w else 'WHERE ')} lower(content) LIKE %s
                    LIMIT {pool}""", (*params, pat)).fetchall()
        except Exception:
            pcon.rollback()
            sub = []

    K = 60
    fused: dict[int, float] = {}
    for rank, (cid, _) in enumerate(vec):
        fused[cid] = fused.get(cid, 0) + 1 / (K + rank + 1)
    for rank, (cid, _) in enumerate(lex):
        fused[cid] = fused.get(cid, 0) + 1 / (K + rank + 1)
    for rank, (cid, _) in enumerate(sub):
        # an exact identifier hit is strong evidence — weight it above the others
        fused[cid] = fused.get(cid, 0) + 2 / (K + rank + 1)
    if not fused:
        return []

    # Fetch the whole fused pool, not just k: the reranker can only promote a
    # chunk it is shown, and the gold answer is often ranked 11-40 by RRF.
    ranked = sorted(fused.items(), key=lambda x: -x[1])
    # Step 6 — rank by risk as well as by text. A hit inside a Critical-impact
    # Master Direction and the same hit inside an unfetched circular were
    # scoring identically. regulation_id is already on the chunk; impact_scores
    # is one join away and was never consulted at query time.
    if IMPACT_BOOST and fused:
        for cid, level in _impact_levels(pcon, list(fused)).items():
            fused[cid] *= IMPACT_WEIGHT.get(level, 1.0)
        ranked = sorted(fused.items(), key=lambda x: -x[1])

    top = ranked[:min(pool, RERANK_POOL)] if RERANK else ranked[:k]
    vs = dict(vec)
    rows = pcon.execute(
        """SELECT id, corpus, source_table, source_id, regulation_id, entity_id, domain,
                  title, section_number, content, url, app_path
           FROM chunks WHERE id = ANY(%s)""", ([c for c, _ in top],)).fetchall()
    cols = ["id", "corpus", "source_table", "source_id", "regulation_id", "entity_id",
            "domain", "title", "section_number", "content", "url", "app_path"]
    by_id = {r[0]: dict(zip(cols, r)) for r in rows}

    out = []
    for cid, fscore in top:
        r = by_id.get(cid)
        if not r:
            continue
        r["score"] = round(fscore, 5)
        r["similarity"] = round(float(vs.get(cid, 0)), 4)
        lex_ids, sub_ids = dict(lex), dict(sub)
        arms = [n for n, d in (("vector", vs), ("keyword", lex_ids), ("reference", sub_ids))
                if cid in d]
        r["matched_by"] = "+".join(arms) or "unknown"
        out.append(r)

    if RERANK and len(out) > 1:
        try:
            scores = reranker().predict(
                [(query, (r.get("content") or "")[:1200]) for r in out],
                batch_size=16, show_progress_bar=False)
            for r, sc in zip(out, scores):
                r["rerank"] = round(float(sc), 5)
            out.sort(key=lambda r: -r["rerank"])
        except Exception:
            pass          # a missing reranker must not take retrieval down

    # Outside the rerank block on purpose: the collision it corrects is in the
    # EMBEDDING, so it happens whether or not a reranker is configured — and if
    # the reranker fails, that is exactly when the ordering needs the guard.
    out = _demote_decoys(out, query)

    if DEDUPE_PARAPHRASE:
        out = _collapse_paraphrases(out)
    out = _diversify(out, k)[:k]
    _attach_parents(pcon, out)      # k parents, not the whole pool
    return out


def _parent_of(source_id: str) -> str:
    """Chunks are keyed '<row id>#<n>'. The parent is everything before the #."""
    return (source_id or "").split("#", 1)[0]


def _diversify(rows: list[dict], k: int) -> list[dict]:
    """
    Step 5 — MMR, in the form this corpus actually needs.

    Sections average 1.3 chunks with 200 characters of overlap, so neighbouring
    chunks are near-duplicates and a top-8 can be the same clause eight times.
    Rather than a full pairwise MMR over embeddings we cap how many chunks any
    one parent row may contribute, keeping the best-ranked of each. That is the
    diversity that was missing, at no extra model cost. Anything left over is
    appended, so we never return fewer results than we found.
    """
    kept, seen, overflow = [], {}, []
    for r in rows:
        pid = _parent_of(r.get("source_id", ""))
        n = seen.get(pid, 0)
        if n < MAX_PER_PARENT:
            seen[pid] = n + 1
            kept.append(r)
        else:
            overflow.append(r)
        if len(kept) >= k:
            break
    return (kept + overflow)[:max(k, len(kept))]


def _attach_parents(pcon, rows: list[dict]) -> None:
    """
    Step 5 — retrieve on the chunk, read the parent.

    A 1800-character window retrieves well and cites badly: the proviso that
    changes a clause's meaning is often in the next chunk. Every sibling chunk
    of the matched row is stitched back together and returned as `parent`, so
    the UI can show the whole clause while ranking stayed chunk-level.
    """
    if not rows:
        return
    parents = sorted({_parent_of(r.get("source_id", "")) for r in rows if r.get("source_id")})
    if not parents:
        return
    try:
        sib = pcon.execute(
            """SELECT split_part(source_id, '#', 1) AS parent,
                      string_agg(content, ' ' ORDER BY
                        (split_part(source_id, '#', 2))::int) AS full_text
                 FROM chunks
                WHERE split_part(source_id, '#', 1) = ANY(%s)
                GROUP BY 1""", (parents,)).fetchall()
    except Exception:
        return
    by_parent = {r[0]: r[1] for r in sib}
    for r in rows:
        full = by_parent.get(_parent_of(r.get("source_id", "")))
        if full and full != r.get("content"):
            r["parent"] = full
