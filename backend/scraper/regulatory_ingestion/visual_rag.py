"""
Visual retrieval with ColSmol (ColPali family, late interaction).

WHAT THIS IS AND IS NOT
-----------------------
ColSmol embeds a page IMAGE. It returns vectors, never text. So it can answer
"which page covers periodic KYC updation" without any OCR at all — but it can
never tell you what the page says.

That is why this is a SECOND ROUTE and not a replacement:

    text pipeline (pypdf/tesseract/docling)  -> obligations, amendment
                                                footnotes, change detection,
                                                clause text shown in the UI
    visual pipeline (this file)              -> retrieval only

Everything downstream of extraction still depends on the text path. Swapping it
out for ColPali would silently break obligation extraction and change
detection, which is the opposite of an improvement.

WHERE IT EARNS ITS KEEP
-----------------------
Scanned Gazette notifications, where tesseract returns garbled bilingual text.
Embedding that text retrieves badly; embedding the page picture does not care.

LATE INTERACTION
----------------
One page is 875 vectors of dim 128, not one vector. Scoring is MaxSim:

    score(q, page) = sum over query tokens t of  max over page patches p  (q_t . d_p)

pgvector has no native MaxSim, so retrieval is two-stage: ANN over patches to
find candidate pages, then exact MaxSim over just those candidates.
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile

MODEL_NAME = os.environ.get("COLSMOL_MODEL", "vidore/colSmol-500M")
DIMS = 128
DEVICE = os.environ.get("COLSMOL_DEVICE", "mps")
DPI = int(os.environ.get("COLSMOL_DPI", "120"))   # enough for layout; 300 would blow RAM

_m = _p = None


def model():
    """Loaded lazily and once — this machine has 8 GB and cannot hold two copies."""
    global _m, _p
    if _m is None:
        import torch
        from colpali_engine.models import ColIdefics3, ColIdefics3Processor
        _m = ColIdefics3.from_pretrained(
            MODEL_NAME, torch_dtype=torch.float32, device_map=DEVICE).eval()
        _p = ColIdefics3Processor.from_pretrained(MODEL_NAME)
    return _m, _p


def available() -> tuple[bool, str]:
    try:
        import colpali_engine  # noqa: F401
    except ImportError:
        return False, "colpali-engine not installed (pip install colpali-engine)"
    import shutil
    if not shutil.which("pdftoppm"):
        return False, "pdftoppm missing (brew install poppler)"
    return True, f"{MODEL_NAME} on {DEVICE}"


def page_images(pdf: pathlib.Path, first: int = 1, last: int = 0) -> list[pathlib.Path]:
    """Rasterise with poppler. Returns paths in a caller-managed temp dir."""
    out = pathlib.Path(tempfile.mkdtemp(prefix="colsmol-"))
    cmd = ["pdftoppm", "-png", "-r", str(DPI), "-f", str(first)]
    if last:
        cmd += ["-l", str(last)]
    cmd += [str(pdf), str(out / "pg")]
    subprocess.run(cmd, check=True, capture_output=True, timeout=900)
    return sorted(out.glob("pg*.png"))


def embed_pages(paths: list[pathlib.Path], batch: int = 1):
    """
    Yields (path, ndarray[patches, 128]) normalised.

    Batch size 1 by default: each page is ~875x128 activations plus the vision
    tower's working set, and on 8 GB a larger batch swaps rather than speeds up.
    """
    import numpy as np
    import torch
    from PIL import Image
    m, p = model()
    for i in range(0, len(paths), batch):
        chunk = paths[i:i + batch]
        imgs = [Image.open(x).convert("RGB") for x in chunk]
        b = p.process_images(imgs)
        b = {k: v.to(DEVICE) for k, v in b.items()}
        with torch.no_grad():
            e = m(**b).to(torch.float32).cpu().numpy()
        for path, vecs in zip(chunk, e):
            n = np.linalg.norm(vecs, axis=1, keepdims=True)
            yield path, (vecs / np.clip(n, 1e-9, None)).astype("float32")
        for im in imgs:
            im.close()


def embed_query(text: str):
    import numpy as np
    import torch
    m, p = model()
    b = p.process_queries([text])
    b = {k: v.to(DEVICE) for k, v in b.items()}
    with torch.no_grad():
        e = m(**b).to(torch.float32).cpu().numpy()[0]
    n = np.linalg.norm(e, axis=1, keepdims=True)
    return (e / np.clip(n, 1e-9, None)).astype("float32")


# ------------------------------------------------------------------ indexing
def _pg():
    from .rag import connect_pg
    return connect_pg()


def _docs(con, ids: list[str] | None, limit: int) -> list[dict]:
    import sqlite3
    q = """SELECT d.regulation_id, d.storage_path, d.page_count, r.title, r.source_url
           FROM documents d JOIN regulations r ON r.id = d.regulation_id"""
    p: list = []
    if ids:
        q += f" WHERE d.regulation_id IN ({','.join('?' * len(ids))})"
        p = ids
    q += " ORDER BY d.regulation_id"
    if limit:
        q += f" LIMIT {limit}"
    return [dict(r) for r in con.execute(q, p)]


def index_pdf(regulation_id: str, pdf: str | pathlib.Path, title: str = "",
              url: str | None = None, max_pages: int = 0, progress=print) -> dict:
    """
    Index one PDF by path, for documents the text pipeline never managed to
    store — which is exactly the population this route exists to serve.
    """
    import shutil
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    pcon = _pg()
    imgs = page_images(pathlib.Path(pdf), last=max_pages or 0)
    n = patches = 0
    try:
        for i, (path, vecs) in enumerate(embed_pages(imgs), start=1):
            pid = pcon.execute(
                """INSERT INTO visual_pages
                   (regulation_id, page_no, title, url, app_path, patch_count, model)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (regulation_id, page_no, model) DO UPDATE
                     SET patch_count=EXCLUDED.patch_count RETURNING id""",
                (regulation_id, i, title, url, f"/regulation/{regulation_id}",
                 len(vecs), MODEL_NAME)).fetchone()[0]
            pcon.execute("DELETE FROM visual_patches WHERE page_id=%s", (pid,))
            with pcon.cursor() as cur:
                cur.executemany(
                    "INSERT INTO visual_patches (page_id, idx, embedding) VALUES (%s,%s,%s)",
                    [(pid, j, v.tolist()) for j, v in enumerate(vecs)])
            pcon.commit()
            n += 1; patches += len(vecs)
            progress(f"    page {i}: {len(vecs)} patches")
    finally:
        shutil.rmtree(imgs[0].parent, ignore_errors=True) if imgs else None
    return {"pages": n, "patches": patches, "model": MODEL_NAME}


def index(ids: list[str] | None = None, limit: int = 0, max_pages_per_doc: int = 0,
          progress=print) -> dict:
    """
    Rasterise -> embed -> store. Skips pages already indexed for this model, so
    an interrupted run resumes instead of starting over.
    """
    import shutil
    from .rag import _sqlite
    ok, why = available()
    if not ok:
        raise RuntimeError(why)

    scon, pcon = _sqlite(), _pg()
    docs = _docs(scon, ids, limit)
    pages_done = patches = skipped_docs = 0
    progress(f"  {len(docs)} document(s) to consider")

    for n, d in enumerate(docs, 1):
        pdf = pathlib.Path(d["storage_path"] or "")
        if not pdf.exists():
            local = pathlib.Path(__file__).parent.parent / "output" / "documents" / f"{d['regulation_id']}.pdf"
            if not local.exists():
                skipped_docs += 1
                progress(f"  [{n}/{len(docs)}] {d['regulation_id']}: SKIP no local PDF")
                continue
            pdf = local

        have = {r[0] for r in pcon.execute(
            "SELECT page_no FROM visual_pages WHERE regulation_id=%s AND model=%s",
            (d["regulation_id"], MODEL_NAME)).fetchall()}
        total = d["page_count"] or 0
        want = min(total, max_pages_per_doc) if max_pages_per_doc else total
        if want and len(have) >= want:
            progress(f"  [{n}/{len(docs)}] {d['regulation_id']}: already indexed ({len(have)} pages)")
            continue

        try:
            imgs = page_images(pdf, last=max_pages_per_doc or 0)
        except Exception as e:
            skipped_docs += 1
            progress(f"  [{n}/{len(docs)}] {d['regulation_id']}: FAIL rasterise {e}")
            continue

        try:
            todo = [(i + 1, p) for i, p in enumerate(imgs) if (i + 1) not in have]
            for page_no, vecs in _embed_numbered(todo):
                pid = pcon.execute(
                    """INSERT INTO visual_pages
                       (regulation_id, page_no, title, url, app_path, patch_count, model)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (regulation_id, page_no, model) DO UPDATE
                         SET patch_count=EXCLUDED.patch_count RETURNING id""",
                    (d["regulation_id"], page_no, d["title"], d["source_url"],
                     f"/regulation/{d['regulation_id']}", len(vecs), MODEL_NAME)).fetchone()[0]
                pcon.execute("DELETE FROM visual_patches WHERE page_id=%s", (pid,))
                with pcon.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO visual_patches (page_id, idx, embedding) VALUES (%s,%s,%s)",
                        [(pid, i, v.tolist()) for i, v in enumerate(vecs)])
                pcon.commit()
                pages_done += 1
                patches += len(vecs)
                if pages_done % 10 == 0:
                    progress(f"    {pages_done} pages, {patches} patches")
        finally:
            shutil.rmtree(imgs[0].parent, ignore_errors=True) if imgs else None

        progress(f"  [{n}/{len(docs)}] {d['regulation_id']}: {pages_done} pages so far")

    return {"pages": pages_done, "patches": patches, "skippedDocs": skipped_docs,
            "model": MODEL_NAME}


def _embed_numbered(todo):
    if not todo:
        return
    nums = {p: n for n, p in todo}
    for path, vecs in embed_pages([p for _, p in todo]):
        yield nums[path], vecs


# ------------------------------------------------------------------ retrieval
def search(query: str, k: int = 5, candidates: int = 60,
           regulation_id: str | None = None) -> list[dict]:
    """
    Two-stage late interaction.

    1. ANN over patch vectors, per query token, to gather candidate PAGES.
       (pgvector indexes vectors, not documents — so the shortlist is built
        from whichever patches are near any query token.)
    2. Exact MaxSim over the candidates' full patch sets, which is the real
       ColBERT score and cannot be approximated by a single-vector search.
    """
    import numpy as np
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    pcon = _pg()
    if pcon.execute("SELECT COUNT(*) FROM visual_pages").fetchone()[0] == 0:
        return []

    q = embed_query(query)

    where, params = "", []
    if regulation_id:
        where = "WHERE p.regulation_id = %s"
        params = [regulation_id]

    seen: dict[int, float] = {}
    per_token = max(4, candidates // max(len(q), 1))
    for t in q:
        rows = pcon.execute(
            f"""SELECT vp.page_id FROM visual_patches vp
                JOIN visual_pages p ON p.id = vp.page_id {where}
                ORDER BY vp.embedding <#> %s::halfvec LIMIT {per_token}""",
            (*params, t.tolist())).fetchall()
        for (pid,) in rows:
            seen[pid] = seen.get(pid, 0) + 1
    if not seen:
        return []

    shortlist = [p for p, _ in sorted(seen.items(), key=lambda x: -x[1])[:candidates]]

    # stage 2 — exact MaxSim on the shortlist only
    rows = pcon.execute(
        "SELECT page_id, embedding FROM visual_patches WHERE page_id = ANY(%s) ORDER BY page_id, idx",
        (shortlist,)).fetchall()
    by_page: dict[int, list] = {}
    for pid, emb in rows:
        # pgvector hands back a HalfVector object, not a sequence
        v = emb.to_numpy() if hasattr(emb, "to_numpy") else np.asarray(emb, dtype="float32")
        by_page.setdefault(pid, []).append(v.astype("float32"))

    scored = []
    for pid, vecs in by_page.items():
        D = np.vstack(vecs)                    # (patches, 128)
        scored.append((float((q @ D.T).max(axis=1).sum()), pid))
    scored.sort(reverse=True)

    top = scored[:k]
    meta = {r[0]: r for r in pcon.execute(
        """SELECT id, regulation_id, page_no, title, url, app_path, patch_count
           FROM visual_pages WHERE id = ANY(%s)""", ([p for _, p in top],)).fetchall()}
    out = []
    for score, pid in top:
        m = meta.get(pid)
        if not m:
            continue
        out.append({
            "page_id": pid, "regulation_id": m[1], "page_no": m[2], "title": m[3],
            "url": m[4], "app_path": m[5], "patches": m[6],
            "maxsim": round(score, 3),
            "normalised": round(score / max(len(q), 1), 4),
            "matched_by": "visual (ColSmol late interaction)",
        })
    return out
