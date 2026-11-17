"""
High-fidelity extraction via docling (https://github.com/docling-project/docling).

WHY THIS EXISTS, alongside the pypdf path rather than replacing it
------------------------------------------------------------------
The pypdf + regex path is fast (~2s/doc) and handles the bulk fine. What it
cannot do — measured on the KYC Master Direction, 107 pages:

                          pypdf + regex        docling
    tables                     0                  17
    real headings          263 "sections" of    114 section_headers
                           which many are       (footnotes, page footers
                           paragraphs or        and list items labelled
                           shredded table rows  separately)
    amendment footnotes    93, only 1 with      101, each with the link
    with a link to the     a link               to the amending circular
    amending circular

That last row matters most here: the amendment footnote is the evidence behind
the whole change-tracking feature, and docling keeps the hyperlink to the
circular that made the change. The regex path throws it away.

COST: docling pulls torch + transformers (~1.3 GB) and takes ~122s on a
107-page document versus ~2s. So this is a SECOND pass for documents worth the
time, not the default. Import is lazy and the caller degrades gracefully.

    pip install docling

OCR NOTE: docling's default OCR engine is RapidOCR/PP-OCRv6, a CHINESE model.
On a scanned Indian Gazette it returns confident nonsense ("37124" f 可;").
This module forces tesseract instead, which on the same file produced readable
English — and, because docling only OCRs the regions that need it, did so in
20s versus 80s for running tesseract over every page.
"""
from __future__ import annotations

import re
from typing import Any

MIN_CHARS = 400


def available() -> tuple[bool, str]:
    try:
        import docling  # noqa: F401
    except ImportError:
        return False, "docling not installed (pip install docling)"
    return True, "docling present"


def _converter(force_ocr: bool):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions()
    opts.do_ocr = force_ocr
    opts.do_table_structure = True
    # never the default Chinese recogniser — see OCR NOTE above
    opts.ocr_options = TesseractCliOcrOptions(lang=["eng"])
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})


_AMEND = re.compile(r"Amended\s+vide\s+(?P<instrument>circular|notification)\s+(?P<ref>[A-Z0-9./\- ]+?)\s+dated\s+(?P<date>\d{1,2}\s+\w+,?\s+\d{4}|\w+\s+\d{1,2},\s*\d{4})", re.I)
_LINK = re.compile(r"\[(?P<text>[^\]]+)\]\((?P<url>https?://[^)]+)\)")


def extract(path_or_url: str, force_ocr: bool = False) -> dict[str, Any]:
    """
    Returns sections, tables and linked amendment footnotes.

    Raises RuntimeError rather than returning a thin document — a near-empty
    result that looks successful is worse than a visible failure.
    """
    ok, why = available()
    if not ok:
        raise RuntimeError(why)

    doc = _converter(force_ocr).convert(path_or_url).document
    md = doc.export_to_markdown()
    if len(md.strip()) < MIN_CHARS:
        raise RuntimeError(f"docling returned only {len(md.strip())} chars")

    texts = list(getattr(doc, "texts", []) or [])
    label = lambda t: str(getattr(t, "label", "")).lower().split(".")[-1]

    headings = [t for t in texts if label(t) in ("section_header", "title")]
    footnotes = [t for t in texts if label(t) == "footnote"]

    # sections: a heading plus everything up to the next heading, in reading order
    order = {id(t): i for i, t in enumerate(texts)}
    heads = sorted(headings, key=lambda t: order[id(t)])
    sections = []
    for i, h in enumerate(heads):
        start = order[id(h)]
        end = order[id(heads[i + 1])] if i + 1 < len(heads) else len(texts)
        body = " ".join((getattr(t, "text", "") or "") for t in texts[start + 1:end]
                        if label(t) not in ("page_footer", "page_header", "footnote"))
        title = (getattr(h, "text", "") or "").strip()
        m = re.match(r"^\s*(\d+(?:\.\d+)*)[\.\s)]+(.*)$", title)
        sections.append({
            "no": m.group(1) if m else "",
            "title": (m.group(2) if m else title)[:180],
            "text": body.strip(),
        })

    tables = []
    for t in list(getattr(doc, "tables", []) or []):
        try:
            df = t.export_to_dataframe(doc)      # doc arg required; omitting it is deprecated
            tables.append({"columns": [str(c) for c in df.columns],
                           "rows": df.astype(str).values.tolist()})
        except Exception:
            continue

    # amendment footnotes, WITH the link to the amending circular
    amendments = []
    for fn in footnotes:
        raw = (getattr(fn, "text", "") or "").strip()
        m = _AMEND.search(raw)
        if not m:
            continue
        amendments.append({
            "raw": raw,
            "instrument": m.group("instrument").title(),
            "reference": re.sub(r"\s+", "", m.group("ref")),
            "dated": m.group("date"),
            "url": None,
        })
    for lm in _LINK.finditer(md):                      # attach urls found in the markdown
        am = _AMEND.search(lm.group("text"))
        if not am:
            continue
        ref = re.sub(r"\s+", "", am.group("ref"))
        for a in amendments:
            if a["reference"] == ref and not a["url"]:
                a["url"] = lm.group("url")
                break

    return {
        "method": "docling" + (" + tesseract ocr" if force_ocr else ""),
        "ocrUsed": 1 if force_ocr else 0,
        "chars": len(md),
        "pages": len(getattr(doc, "pages", []) or []),
        "sections": [s for s in sections if s["text"]],
        "tables": tables,
        "amendments": amendments,
        "markdown": md,
    }
